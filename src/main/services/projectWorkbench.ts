import { randomUUID } from 'node:crypto';
import type {
  DeliverableSummary,
  PermissionMode,
  Project,
  ProjectWorkbenchView,
  ProjectDeliveryBoardView,
  ProjectDeliveryBoardItem,
  ProjectDeliveryStage,
  ProjectUsageStatsView,
  QuestMode,
  QuestOrchestrator,
  QuestSandbox,
  QuestSettings
} from '../../shared/types.js';
import type { Database } from './database.js';
import { ProjectManager } from './projectManager.js';
import type { HermesDeliveryGateResult } from './hermesDeliveryGate.js';

type Row = Record<string, unknown>;

interface ProjectTaskFact {
  id: string;
  agentId: string;
  status: string;
  title: string;
  progress: number;
  createdAt: number;
  updatedAt: number;
  quality: string | null;
}

const DEFAULT_SETTINGS: QuestSettings = {
  mode: 'quest',
  orchestrator: 'hermes',
  sandbox: 'workspace',
  permissionMode: 'autonomous',
  model: null,
  workerAgentIds: [],
  pluginIds: [],
  maxParallel: 3,
  autoApproveLowRisk: true
};

const QUEST_POLICY_VERSION = 5;

const PERMISSIONS = new Set<PermissionMode>(['readonly', 'standard', 'trusted', 'autonomous']);
const SANDBOXES = new Set<QuestSandbox>(['strict', 'workspace', 'host']);
const MAX_IDS = 64;
const QUEST_SETTING_KEYS = new Set<keyof QuestSettings>([
  'mode', 'orchestrator', 'sandbox', 'permissionMode', 'model', 'workerAgentIds', 'pluginIds', 'maxParallel', 'autoApproveLowRisk'
]);
const QUEST_ORCHESTRATORS = new Set<QuestOrchestrator>(['hermes']);

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : text(value);
}

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(value ?? fallback) || fallback;
}

function boundedText(value: unknown, max: number): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error('Quest 设置包含无效文本');
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error('Quest 设置文本超出限制');
  return normalized || null;
}

/**
 * Workspace paths are host-only values. They are persisted so a project can
 * be opened before its first task exists, but never included in the
 * renderer-facing workbench projection or executor context.
 */
function boundedWorkspacePath(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error('项目工作目录无效');
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 4_096 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('项目工作目录超出限制');
  }
  return normalized;
}

function boundedIds(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IDS) throw new Error(`${label} 超出数量限制`);
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item !== item.trim() || item.length < 1 || item.length > 160 || /[\u0000-\u001f\u007f]/.test(item)) {
      throw new Error(`${label} 包含无效 ID`);
    }
    if (!result.includes(item)) result.push(item);
  }
  return result;
}

function isHermesProjectPluginId(value: string): boolean {
  return /^(?:mcp|skill):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function boundedHermesProjectPluginIds(value: unknown): string[] {
  const ids = boundedIds(value, 'pluginIds');
  if (ids.some((id) => !isHermesProjectPluginId(id))) {
    throw new Error('Quest 项目能力仅支持已接入 Hermes 的 MCP 与技能');
  }
  return ids;
}

function defaultSettings(): QuestSettings {
  return { ...DEFAULT_SETTINGS, workerAgentIds: [], pluginIds: [] };
}

function normalizeQuestMode(value: unknown): QuestMode {
  // `direct` existed in v1 preferences and early v2 clients. It remains an
  // input-only migration alias and must never be persisted or returned.
  if (value === 'quest' || value === 'direct') return 'quest';
  throw new Error('Quest 模式无效');
}

export interface ProjectWorkbenchOptions {
  now?: () => number;
  listDeliverables?: () => DeliverableSummary[];
  /** Main-owned Hermes acceptance gate; plan tasks stay in 验收中 until PASS. */
  getDeliveryGate?: (taskId: string) => HermesDeliveryGateResult;
}

/**
 * Project-centric projection over Nexus project, task, usage and delivery facts.
 *
 * It deliberately does not mutate TaskStatus or executor event state. The only
 * mutable part is the user's non-secret Quest preference and explicit project
 * workspace, both stored through the database settings API.
 */
export class ProjectWorkbenchService {
  private readonly now: () => number;
  private readonly listDeliverables?: () => DeliverableSummary[];
  private readonly getDeliveryGate?: (taskId: string) => HermesDeliveryGateResult;
  private readonly projects: ProjectManager;

  constructor(private readonly db: Database, options: ProjectWorkbenchOptions = {}) {
    this.now = options.now ?? Date.now;
    this.listDeliverables = options.listDeliverables;
    this.getDeliveryGate = options.getDeliveryGate;
    this.projects = new ProjectManager(db);
  }

  get(projectId: string): ProjectWorkbenchView {
    const project = this.requireProject(projectId);
    const preference = this.readPreference(project.id);
    // Quest is a Hermes product surface. Historical executor sessions remain
    // available to Main for recovery, but never participate in this view.
    const tasks = this.readProjectTasks(project.id);
    const allDeliverables = this.listDeliverables?.() ?? [];
    const deliverables = allDeliverables.filter((item) => item.projectId === project.id);
    const risks = this.projects.operations(allDeliverables).projects.find((item) => item.project.id === project.id)?.risks ?? [];
    return {
      generatedAt: this.now(),
      project,
      deliverables,
      risks,
      settings: preference.settings,
      deliveryBoard: this.buildDeliveryBoard(project.id, tasks, deliverables),
      usage: this.buildUsageStats(project.id, tasks)
    };
  }

  saveSettings(projectId: string, patch: Partial<QuestSettings>): QuestSettings {
    this.requireProject(projectId);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Quest 设置无效');
    for (const key of Object.keys(patch)) {
      if (!QUEST_SETTING_KEYS.has(key as keyof QuestSettings)) throw new Error(`Quest 设置包含未知字段：${key}`);
    }
    const current = this.readPreference(projectId).settings;
    const mode = patch.mode === undefined ? current.mode : normalizeQuestMode(patch.mode);
    const orchestrator = patch.orchestrator === undefined ? current.orchestrator : patch.orchestrator;
    if (!QUEST_ORCHESTRATORS.has(orchestrator as QuestOrchestrator)) throw new Error('Quest 只支持 Hermes 调度');
    const sandbox = patch.sandbox === undefined ? current.sandbox : patch.sandbox;
    const permissionMode = patch.permissionMode === undefined ? current.permissionMode : patch.permissionMode;
    if (!SANDBOXES.has(sandbox as QuestSandbox)) throw new Error('Quest 沙箱模式无效');
    if (!PERMISSIONS.has(permissionMode as PermissionMode)) throw new Error('Quest 权限模式无效');
    if (patch.autoApproveLowRisk !== undefined && typeof patch.autoApproveLowRisk !== 'boolean') throw new Error('Quest 自动审批设置无效');
    const maxParallel = patch.maxParallel === undefined ? current.maxParallel : Math.trunc(Number(patch.maxParallel));
    if (!Number.isSafeInteger(maxParallel) || maxParallel < 1 || maxParallel > 16) throw new Error('Quest 并发数必须在 1-16 之间');
    const workerAgentIds = patch.workerAgentIds === undefined
      ? current.workerAgentIds
      : boundedIds(patch.workerAgentIds, 'workerAgentIds');
    if (patch.workerAgentIds !== undefined) {
      const project = this.db.raw.prepare(
        'SELECT organization_id FROM projects WHERE id = ?'
      ).get(projectId) as Row | undefined;
      const organizationId = text(project?.organization_id);
      for (const workerId of workerAgentIds) {
        const worker = this.db.raw.prepare(`
          SELECT id FROM agents
          WHERE id = ? AND organization_id = ? AND archived = 0
        `).get(workerId, organizationId) as Row | undefined;
        if (!worker) throw new Error(`固定员工 ${workerId} 不存在、不属于当前组织或已归档`);
      }
    }
    const settings: QuestSettings = {
      mode,
      orchestrator,
      sandbox,
      permissionMode,
      model: patch.model === undefined ? current.model : boundedText(patch.model, 160),
      workerAgentIds,
      pluginIds: patch.pluginIds === undefined ? current.pluginIds : boundedHermesProjectPluginIds(patch.pluginIds),
      maxParallel,
      autoApproveLowRisk: permissionMode === 'autonomous'
        ? true
        : patch.autoApproveLowRisk === undefined ? current.autoApproveLowRisk : patch.autoApproveLowRisk === true
    };
    const currentPreference = this.readPreference(projectId);
    this.writePreference(projectId, settings, currentPreference.workspacePath);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'quest.settings.update', target: projectId, result: 'ok' });
    return settings;
  }

  /**
   * An empty pool deliberately means dynamic staffing. A non-empty pool is a
   * project policy ceiling; the actual employee is still selected per
   * conversation, plan node or run.
   */
  getWorkerSelection(projectId: string): { mode: 'dynamic' | 'restricted'; workerAgentIds: string[] } {
    const project = this.db.raw.prepare(
      'SELECT organization_id FROM projects WHERE id = ?'
    ).get(projectId) as Row | undefined;
    if (!project) throw new Error('项目不存在');
    const organizationId = text(project.organization_id);
    const workerAgentIds = this.readPreference(projectId).settings.workerAgentIds.filter((workerId) => {
      const worker = this.db.raw.prepare(`
        SELECT id FROM agents
        WHERE id = ? AND organization_id = ? AND archived = 0
      `).get(workerId, organizationId) as Row | undefined;
      return Boolean(worker);
    });
    return {
      mode: workerAgentIds.length > 0 ? 'restricted' : 'dynamic',
      workerAgentIds
    };
  }

  getSettings(projectId: string): QuestSettings {
    this.requireProject(projectId);
    return structuredClone(this.readPreference(projectId).settings);
  }

  /** Persist an explicit project directory selected by the user in Main. */
  setWorkspacePath(projectId: string, workspacePath: string): void {
    this.requireProject(projectId);
    const normalized = boundedWorkspacePath(workspacePath);
    if (!normalized) throw new Error('项目工作目录无效');
    const preference = this.readPreference(projectId);
    this.writePreference(projectId, preference.settings, normalized);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'project.workspace.bind', target: projectId, result: 'ok' });
  }

  /** Return only the directory explicitly approved through Main's picker. */
  getExplicitWorkspacePath(projectId: string): string | null {
    this.requireProject(projectId);
    return this.readPreference(projectId).workspacePath;
  }

  /**
   * Resolve the project's user-selected working directory without exposing
   * it to the renderer. The compatibility fallback only considers a real task
   * already associated with this project; historical executor sessions are
   * never allowed to select a Quest workspace.
   */
  getWorkspacePath(projectId: string): string | null {
    const project = this.requireProject(projectId);
    const preference = this.readPreference(project.id);
    if (preference.workspacePath) return preference.workspacePath;
    const task = this.db.raw.prepare(`
      SELECT COALESCE(NULLIF(t.workspace_override, ''), NULLIF(a.workspace, '')) AS workspace
      FROM tasks t JOIN agents a ON a.id = t.agent_id
      WHERE t.project_id = ? AND t.deleted_at IS NULL
      ORDER BY COALESCE(t.ended_at, t.started_at, t.created_at) DESC, t.id DESC
      LIMIT 1
    `).get(project.id) as Row | undefined;
    const taskWorkspace = text(task?.workspace).trim();
    return taskWorkspace || null;
  }

  private requireProject(projectId: string): Project {
    const row = this.db.raw.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Row | undefined;
    if (!row) throw new Error('项目不存在');
    return {
      id: text(row.id), name: text(row.name), objective: text(row.objective), description: text(row.description),
      clientName: text(row.client_name), status: text(row.status) as Project['status'], color: text(row.color, '#4d6bfe'),
      dueAt: row.due_at === null || row.due_at === undefined ? null : number(row.due_at),
      createdAt: number(row.created_at), updatedAt: number(row.updated_at)
    };
  }

  private preferenceKey(projectId: string): string { return `project:workbench:${projectId}`; }

  private readPreference(projectId: string): { settings: QuestSettings; workspacePath: string | null } {
    const raw = this.db.getSetting<Record<string, unknown>>(this.preferenceKey(projectId), {});
    const settings = defaultSettings();
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      let legacyDshScheduler = false;
      let removedLegacyProjectPlugins = false;
      if (raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)) {
        const candidate = raw.settings as Record<string, unknown>;
        legacyDshScheduler = candidate.orchestrator === 'dsh';
        if (candidate.mode === 'quest' || candidate.mode === 'direct') settings.mode = normalizeQuestMode(candidate.mode);
        if (QUEST_ORCHESTRATORS.has(candidate.orchestrator as QuestOrchestrator)) {
          settings.orchestrator = candidate.orchestrator as QuestOrchestrator;
        }
        if (SANDBOXES.has(candidate.sandbox as QuestSandbox)) settings.sandbox = candidate.sandbox as QuestSandbox;
        if (PERMISSIONS.has(candidate.permissionMode as PermissionMode)) settings.permissionMode = candidate.permissionMode as PermissionMode;
        try { settings.model = boundedText(candidate.model, 160); } catch { /* ignore corrupt preference */ }
        if (Array.isArray(candidate.workerAgentIds)) {
          try { settings.workerAgentIds = boundedIds(candidate.workerAgentIds, 'workerAgentIds'); } catch { /* ignore corrupt preference */ }
        }
        if (Array.isArray(candidate.pluginIds)) {
          try {
            const parsed = boundedIds(candidate.pluginIds, 'pluginIds');
            settings.pluginIds = parsed.filter(isHermesProjectPluginId);
            removedLegacyProjectPlugins = settings.pluginIds.length !== parsed.length;
          } catch { /* ignore corrupt preference */ }
        }
        if (Number.isSafeInteger(candidate.maxParallel) && Number(candidate.maxParallel) >= 1 && Number(candidate.maxParallel) <= 16) settings.maxParallel = Number(candidate.maxParallel);
        settings.autoApproveLowRisk = candidate.autoApproveLowRisk === true;
        if (settings.permissionMode === 'autonomous') settings.autoApproveLowRisk = true;
      }
      let workspacePath: string | null = null;
      try { workspacePath = boundedWorkspacePath(raw.workspacePath); } catch { /* ignore corrupt host-only preference */ }
      const storedPolicyVersion = Number.isSafeInteger(raw.policyVersion) ? Number(raw.policyVersion) : 0;
      const migrations: string[] = [];
      if (storedPolicyVersion < 2 && settings.permissionMode === 'standard') {
        settings.permissionMode = 'autonomous';
        settings.autoApproveLowRisk = true;
        migrations.push('standard-to-project-autonomous');
      }
      if (legacyDshScheduler) {
        settings.orchestrator = 'hermes';
        migrations.push('dsh-scheduler-to-hermes');
      }
      if (typeof raw.rootSessionId === 'string') migrations.push('legacy-root-session-binding-removed');
      if (removedLegacyProjectPlugins) migrations.push('legacy-project-plugins-removed');
      if (storedPolicyVersion < QUEST_POLICY_VERSION || migrations.length > 0) {
        this.writePreference(projectId, settings, workspacePath);
        this.db.audit({
          id: randomUUID(), actor: 'system', action: 'quest.policy.migrate', target: projectId,
          result: migrations.length > 0 ? migrations.join(',') : `policy-v${QUEST_POLICY_VERSION}`
        });
      }
      return {
        settings,
        workspacePath
      };
    }
    return { settings, workspacePath: null };
  }

  private writePreference(projectId: string, settings: QuestSettings, workspacePath: string | null): void {
    this.db.setSetting(this.preferenceKey(projectId), {
      settings, workspacePath, policyVersion: QUEST_POLICY_VERSION
    });
  }

  private readProjectTasks(projectId: string): ProjectTaskFact[] {
    const tasks = this.db.raw.prepare('SELECT id, agent_id, status, title, progress, created_at, COALESCE(ended_at, started_at, created_at) AS updated_at, quality FROM tasks WHERE project_id = ? AND deleted_at IS NULL').all(projectId) as Row[];
    return tasks.map((row) => ({
      id: text(row.id), agentId: text(row.agent_id), status: text(row.status), title: text(row.title, '未命名任务'),
      progress: Math.max(0, Math.min(100, Math.trunc(number(row.progress)))), createdAt: number(row.created_at),
      updatedAt: number(row.updated_at), quality: nullableText(row.quality)
    }));
  }

  private buildDeliveryBoard(
    projectId: string,
    tasks: ProjectTaskFact[],
    deliverables: DeliverableSummary[]
  ): ProjectDeliveryBoardView {
    const columns: Record<ProjectDeliveryStage, ProjectDeliveryBoardItem[]> = {
      new: [], planned: [], executing: [], accepting: [], completed: []
    };
    const agentNames = new Map<string, string>();
    if (tasks.length) {
      const ids = [...new Set(tasks.map((item) => item.agentId).filter(Boolean))];
      const placeholders = ids.map(() => '?').join(',');
      for (const row of this.db.raw.prepare(`SELECT id, name FROM agents WHERE id IN (${placeholders})`).all(...ids) as Row[]) agentNames.set(text(row.id), text(row.name));
    }
    const stageForTask = (task: typeof tasks[number]): ProjectDeliveryStage => {
      const status = task.status.toUpperCase();
      if (status === 'COMPLETED') {
        try {
          const gate = this.getDeliveryGate?.(task.id);
          if (gate?.required && !gate.allowed) return 'accepting';
        } catch {
          // A missing gate is a delivery risk, not evidence of acceptance.
          if (this.getDeliveryGate) return 'accepting';
        }
        return 'completed';
      }
      if (task.quality === 'accepted') return 'completed';
      if (status === 'WAITING_APPROVAL' || task.quality === 'rework' || /验收|accept|review/i.test(task.title)) return 'accepting';
      if (['RUNNING', 'PAUSED', 'INTERRUPTED'].includes(status)) return 'executing';
      if (status === 'QUEUED') return 'planned';
      return 'new';
    };
    for (const task of tasks.slice(0, 300)) {
      const stage = stageForTask(task);
      columns[stage].push({
        id: task.id, source: 'task', title: task.title, stage, status: task.status,
        ownerId: task.agentId || null, ownerName: agentNames.get(task.agentId) ?? null,
        progress: stage === 'completed' ? 100 : task.progress, updatedAt: task.updatedAt,
        href: { kind: 'task', id: task.id }
      });
    }
    for (const item of deliverables.slice(0, 300)) {
      const stage: ProjectDeliveryStage = item.reviewStatus === 'accepted' ? 'completed'
        : item.reviewStatus === 'unmarked' ? 'accepting' : item.reviewStatus === 'rework' ? 'executing' : 'new';
      columns[stage].push({
        id: item.id, source: 'deliverable', title: item.title, stage, status: item.reviewStatus,
        ownerId: item.ownerId || null, ownerName: item.ownerName || null,
        progress: stage === 'completed' ? 100 : stage === 'accepting' ? 90 : 60,
        updatedAt: item.updatedAt, href: { kind: 'deliverable', id: item.id }
      });
    }
    const labels: Record<ProjectDeliveryStage, string> = {
      new: '新需求', planned: '计划中', executing: '执行中', accepting: '验收中', completed: '已完成'
    };
    const ordered: ProjectDeliveryStage[] = ['new', 'planned', 'executing', 'accepting', 'completed'];
    const total = ordered.reduce((sum, stage) => sum + columns[stage].length, 0);
    const completed = columns.completed.length;
    return {
      columns: ordered.map((stage) => ({ stage, label: labels[stage], items: columns[stage].sort((a, b) => b.updatedAt - a.updatedAt) })),
      total, completed, completionRate: total ? Math.round((completed / total) * 100) : 0
    };
  }

  private buildUsageStats(
    projectId: string,
    tasks: ProjectTaskFact[]
  ): ProjectUsageStatsView {
    const periodDays = 30;
    const since = this.now() - periodDays * 86_400_000;
    const usageRows = this.db.raw.prepare(`
      SELECT u.agent_id, u.input_tokens, u.output_tokens, u.total_tokens, u.created_at
      FROM usage_records u JOIN tasks t ON t.id = u.task_id
      WHERE t.project_id = ? AND u.created_at >= ?
    `).all(projectId, since) as Row[];
    const days = new Map<string, { taskCount: number; completedTaskCount: number; usageCount: number; totalTokens: number }>();
    const dayKey = (at: number) => new Date(at).toISOString().slice(0, 10);
    for (let index = periodDays - 1; index >= 0; index -= 1) {
      const date = new Date(this.now() - index * 86_400_000).toISOString().slice(0, 10);
      days.set(date, { taskCount: 0, completedTaskCount: 0, usageCount: 0, totalTokens: 0 });
    }
    for (const task of tasks) {
      if (task.createdAt < since) continue;
      const day = days.get(dayKey(task.createdAt));
      if (day) { day.taskCount += 1; if (task.status === 'COMPLETED') day.completedTaskCount += 1; }
    }
    const usageAgents = new Set<string>();
    let totalTokens = 0;
    for (const row of usageRows) {
      const day = days.get(dayKey(number(row.created_at)));
      const tokens = Math.max(0, Math.trunc(number(row.total_tokens, number(row.input_tokens) + number(row.output_tokens))));
      if (day) { day.usageCount += 1; day.totalTokens += tokens; }
      totalTokens += tokens;
      if (text(row.agent_id)) usageAgents.add(text(row.agent_id));
    }
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter((task) => task.status === 'COMPLETED').length;
    const activeTasks = tasks.filter((task) => ['QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'PAUSED'].includes(task.status)).length;
    return {
      periodDays, totalTasks, completedTasks, activeTasks, usageCount: usageRows.length, totalTokens,
      uniqueAgents: new Set(tasks.map((task) => task.agentId).filter(Boolean)).size,
      uniqueWorkers: new Set([...tasks.map((task) => task.agentId).filter(Boolean), ...usageAgents]).size,
      averageTasksPerDay: Math.round((totalTasks / periodDays) * 10) / 10,
      days: [...days.entries()].map(([date, value]) => ({ date, ...value }))
    };
  }
}
