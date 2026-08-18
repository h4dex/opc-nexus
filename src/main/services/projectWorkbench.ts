import { randomUUID } from 'node:crypto';
import type {
  DeliverableSummary,
  PermissionMode,
  Project,
  ProjectWorkbenchEventView,
  ProjectWorkbenchRunView,
  ProjectWorkbenchSessionKind,
  ProjectWorkbenchSessionTreeNodeView,
  ProjectWorkbenchSessionView,
  ProjectWorkbenchTeamMemberView,
  ProjectWorkbenchView,
  ProjectDeliveryBoardView,
  ProjectDeliveryBoardItem,
  ProjectDeliveryStage,
  ProjectUsageStatsView,
  QuestMode,
  QuestSandbox,
  QuestSettings
} from '../../shared/types.js';
import type { Database } from './database.js';
import { ProjectManager } from './projectManager.js';

type Row = Record<string, unknown>;

const DEFAULT_SETTINGS: QuestSettings = {
  mode: 'quest',
  sandbox: 'workspace',
  permissionMode: 'autonomous',
  model: null,
  workerAgentIds: [],
  pluginIds: [],
  maxParallel: 3,
  autoApproveLowRisk: true
};

const QUEST_POLICY_VERSION = 2;

const PERMISSIONS = new Set<PermissionMode>(['readonly', 'standard', 'trusted', 'autonomous']);
const SANDBOXES = new Set<QuestSandbox>(['strict', 'workspace', 'host']);
const MAX_IDS = 64;
const MAX_SESSION_NODES = 500;
const MAX_SESSION_DEPTH = 32;
const QUEST_SETTING_KEYS = new Set<keyof QuestSettings>([
  'mode', 'sandbox', 'permissionMode', 'model', 'workerAgentIds', 'pluginIds', 'maxParallel', 'autoApproveLowRisk'
]);

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
 * be opened before its first DSH session exists, but never included in the
 * renderer-facing workbench projection or Cordis execution context.
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

function rowJson(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function safeSummary(value: unknown): string {
  const raw = typeof value === 'string'
    ? value
    : value && typeof value === 'object' ? JSON.stringify(value) : '';
  return raw
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1[REDACTED]')
    .slice(0, 320);
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
}

/**
 * Main-process-only context handed to Cordis for one project task.
 * It intentionally excludes credentials, provider endpoints and host paths.
 */
export interface DshProjectExecutionContext {
  schemaVersion: 1;
  project: {
    id: string;
    name: string;
    objective: string;
  };
  agentPreset: 'cordis';
  quest: QuestSettings;
  enforcement: {
    policyOwner: 'opc-nexus-governance';
    capabilityBrokerRequired: true;
    credentialMode: 'opaque-proxy';
    runtimeToolCeiling: 'managed-workspace-write';
  };
}

/**
 * Project-centric projection over the durable DSH and Nexus facts.
 *
 * It deliberately does not mutate TaskStatus or DSH event state. The only
 * mutable part is the user's non-secret Quest preference and an explicit
 * root-session binding, both stored through the database settings API.
 */
export class ProjectWorkbenchService {
  private readonly now: () => number;
  private readonly listDeliverables?: () => DeliverableSummary[];
  private readonly projects: ProjectManager;

  constructor(private readonly db: Database, options: ProjectWorkbenchOptions = {}) {
    this.now = options.now ?? Date.now;
    this.listDeliverables = options.listDeliverables;
    this.projects = new ProjectManager(db);
  }

  get(projectId: string): ProjectWorkbenchView {
    const project = this.requireProject(projectId);
    const preference = this.readPreference(project.id);
    const scoped = this.readScopedFacts(project.id, preference.rootSessionId);
    const sessions = scoped.sessions;
    const configuredRootId = preference.rootSessionId;
    const root = (configuredRootId ? sessions.find((item) => item.sessionId === configuredRootId) : undefined)
      ?? sessions.find((item) => item.parentSessionId === null && item.kind === 'root')
      ?? sessions.find((item) => item.parentSessionId === null)
      ?? null;
    // `root` is a control-plane role, not a replacement for the worker kind.
    // An external/A2A root can be the newest root session; keep it external so
    // the team projection does not silently classify it as a fixed employee.
    const normalizedSessions = sessions.map((item) => ({
      ...item,
      kind: item.sessionId === root?.sessionId && item.kind === 'fixed-worker' ? 'root' as const : item.kind
    }));
    const normalizedRoot = root
      ? normalizedSessions.find((item) => item.sessionId === root.sessionId) ?? null
      : null;
    const fixed = new Map<string, ProjectWorkbenchTeamMemberView>();
    const elastic = new Map<string, ProjectWorkbenchTeamMemberView>();
    const external = new Map<string, ProjectWorkbenchTeamMemberView>();
    const addMember = (session: ProjectWorkbenchSessionView, kind: 'fixed' | 'elastic' | 'external') => {
      const map = kind === 'fixed' ? fixed : kind === 'elastic' ? elastic : external;
      const current = map.get(session.agentId) ?? {
        agentId: session.agentId, name: session.agentName, role: '', engineId: session.engineId,
        kind, activeRuns: 0, totalRuns: 0
      };
      current.totalRuns += scoped.runs.filter((run) => run.sessionId === session.sessionId).length;
      current.activeRuns += scoped.runs.filter((run) => run.sessionId === session.sessionId && !this.isTerminal(run.state)).length;
      map.set(session.agentId, current);
    };
    for (const session of normalizedSessions) {
      const memberKind = session.kind === 'elastic-worker' ? 'elastic'
        : session.kind === 'external' ? 'external' : 'fixed';
      addMember(session, memberKind);
    }
    for (const task of scoped.tasks) {
      if (!task.agentId || fixed.has(task.agentId) || elastic.has(task.agentId) || external.has(task.agentId)) continue;
      const agent = scoped.agents.get(task.agentId);
      const member: ProjectWorkbenchTeamMemberView = {
        agentId: task.agentId, name: text(agent?.name, '固定数字员工'), role: text(agent?.role),
        engineId: text(agent?.engine_id), kind: 'fixed', activeRuns: ['RUNNING', 'QUEUED', 'WAITING_APPROVAL', 'PAUSED'].includes(task.status) ? 1 : 0, totalRuns: 1
      };
      fixed.set(task.agentId, member);
    }
    const allDeliverables = this.listDeliverables?.() ?? [];
    const deliverables = allDeliverables.filter((item) => item.projectId === project.id);
    const risks = this.projects.operations(allDeliverables).projects.find((item) => item.project.id === project.id)?.risks ?? [];
    return {
      generatedAt: this.now(),
      project,
      rootSession: normalizedRoot,
      sessionTree: this.buildSessionTree(normalizedSessions),
      sessions: normalizedSessions,
      team: {
        fixed: [...fixed.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
        elastic: [...elastic.values()].sort((a, b) => b.activeRuns - a.activeRuns || a.name.localeCompare(b.name, 'zh-CN')),
        external: [...external.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      },
      runs: scoped.runs,
      activeRuns: scoped.runs.filter((run) => !this.isTerminal(run.state)),
      deliverables,
      recentEvents: scoped.events,
      risks,
      settings: preference.settings,
      deliveryBoard: this.buildDeliveryBoard(project.id, scoped.tasks, deliverables),
      usage: this.buildUsageStats(project.id, scoped.tasks, scoped.sessions)
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
    const sandbox = patch.sandbox === undefined ? current.sandbox : patch.sandbox;
    const permissionMode = patch.permissionMode === undefined ? current.permissionMode : patch.permissionMode;
    if (!SANDBOXES.has(sandbox as QuestSandbox)) throw new Error('Quest 沙箱模式无效');
    if (!PERMISSIONS.has(permissionMode as PermissionMode)) throw new Error('Quest 权限模式无效');
    if (patch.autoApproveLowRisk !== undefined && typeof patch.autoApproveLowRisk !== 'boolean') throw new Error('Quest 自动审批设置无效');
    const maxParallel = patch.maxParallel === undefined ? current.maxParallel : Math.trunc(Number(patch.maxParallel));
    if (!Number.isSafeInteger(maxParallel) || maxParallel < 1 || maxParallel > 16) throw new Error('Quest 并发数必须在 1-16 之间');
    const settings: QuestSettings = {
      mode,
      sandbox,
      permissionMode,
      model: patch.model === undefined ? current.model : boundedText(patch.model, 160),
      workerAgentIds: patch.workerAgentIds === undefined ? current.workerAgentIds : boundedIds(patch.workerAgentIds, 'workerAgentIds'),
      pluginIds: patch.pluginIds === undefined ? current.pluginIds : boundedIds(patch.pluginIds, 'pluginIds'),
      maxParallel,
      autoApproveLowRisk: permissionMode === 'autonomous'
        ? true
        : patch.autoApproveLowRisk === undefined ? current.autoApproveLowRisk : patch.autoApproveLowRisk === true
    };
    const currentPreference = this.readPreference(projectId);
    this.writePreference(projectId, settings, currentPreference.rootSessionId, currentPreference.workspacePath);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'quest.settings.update', target: projectId, result: 'ok' });
    return settings;
  }

  /**
   * Resolve a bounded project policy for the managed DSH executor.
   * Stale or cross-organization worker selections are omitted; they never
   * become delegation authority merely because an id was persisted earlier.
   */
  resolveExecutionContext(
    projectId: string,
    executionAgentId: string,
    sessionId?: string | null
  ): DshProjectExecutionContext {
    const project = this.db.raw.prepare(`
      SELECT id, organization_id, name, objective, status FROM projects WHERE id = ?
    `).get(projectId) as Row | undefined;
    if (!project) throw new Error('项目不存在');
    if (text(project.status) === 'archived') throw new Error('已归档项目不能启动 Quest');
    const agent = this.db.raw.prepare(`
      SELECT id, organization_id, archived FROM agents WHERE id = ?
    `).get(executionAgentId) as Row | undefined;
    if (!agent || number(agent.archived) === 1) throw new Error('DSH 执行员工不存在或已归档');
    const organizationId = text(project.organization_id);
    if (!organizationId || text(agent.organization_id) !== organizationId) {
      throw new Error('DSH 执行员工与项目不属于同一组织');
    }
    if (sessionId) {
      const existingSession = this.db.raw.prepare(`
        SELECT s.id, a.organization_id FROM dsh_sessions s
        JOIN agents a ON a.id = s.agent_id WHERE s.id = ?
      `).get(sessionId) as Row | undefined;
      if (existingSession) {
        if (text(existingSession.organization_id) !== organizationId) {
          throw new Error('DSH 会话与项目不属于同一组织');
        }
        const sessionIds = this.expandSessionScope(organizationId, [sessionId], projectId);
        this.assertSessionProjectOwnership(projectId, sessionIds, false);
        const rootIds = sessionIds.filter((id) => {
          const row = this.db.raw.prepare('SELECT parent_session_id FROM dsh_sessions WHERE id = ?').get(id) as Row | undefined;
          return row && (row.parent_session_id === null || row.parent_session_id === undefined);
        });
        this.assertRootsNotBoundElsewhere(projectId, rootIds);
      }
    }

    const persisted = this.readPreference(projectId).settings;
    const workerAgentIds = persisted.workerAgentIds.filter((workerId) => {
      const worker = this.db.raw.prepare(`
        SELECT id FROM agents WHERE id = ? AND organization_id = ? AND archived = 0
      `).get(workerId, organizationId) as Row | undefined;
      return Boolean(worker);
    });
    const quest: QuestSettings = {
      ...persisted,
      workerAgentIds,
      pluginIds: [...persisted.pluginIds]
    };
    return {
      schemaVersion: 1,
      project: {
        id: text(project.id),
        name: text(project.name),
        objective: text(project.objective)
      },
      agentPreset: 'cordis',
      quest,
      enforcement: {
        policyOwner: 'opc-nexus-governance',
        capabilityBrokerRequired: true,
        credentialMode: 'opaque-proxy',
        runtimeToolCeiling: 'managed-workspace-write'
      }
    };
  }

  /** Explicitly associate a DSH root session with a project after creation. */
  bindRootSession(projectId: string, sessionId: string): void {
    const project = this.db.raw.prepare('SELECT id, organization_id, status FROM projects WHERE id = ?').get(projectId) as Row | undefined;
    if (!project) throw new Error('项目不存在');
    if (text(project.status) === 'archived') throw new Error('已归档项目不能绑定 DSH 根会话');
    const row = this.db.raw.prepare(`
      SELECT s.id, s.parent_session_id, a.organization_id
      FROM dsh_sessions s JOIN agents a ON a.id = s.agent_id
      WHERE s.id = ?
    `).get(sessionId) as Row | undefined;
    if (!row || row.parent_session_id !== null && row.parent_session_id !== undefined) throw new Error('只能绑定 DSH 根会话');
    if (text(row.organization_id) !== text(project.organization_id)) throw new Error('DSH 根会话不属于该项目组织');
    const sessionIds = this.expandSessionScope(text(project.organization_id), [sessionId], projectId);
    // A Quest root is explicitly bound before its first approved DAG node
    // creates a project Task. Existing task links must still agree, but an
    // otherwise unlinked root is a valid start of the project execution tree.
    this.assertSessionProjectOwnership(projectId, sessionIds, false);
    this.assertRootsNotBoundElsewhere(projectId, [sessionId]);
    const preference = this.readPreference(projectId);
    if (preference.rootSessionId === sessionId) return;
    this.writePreference(projectId, preference.settings, sessionId, preference.workspacePath);
    this.db.audit({ id: randomUUID(), actor: 'system', action: 'quest.root.bind', target: projectId, result: sessionId });
  }

  /** Persist an explicit project directory selected by the user in Main. */
  setWorkspacePath(projectId: string, workspacePath: string): void {
    this.requireProject(projectId);
    const normalized = boundedWorkspacePath(workspacePath);
    if (!normalized) throw new Error('项目工作目录无效');
    const preference = this.readPreference(projectId);
    this.writePreference(projectId, preference.settings, preference.rootSessionId, normalized);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'project.workspace.bind', target: projectId, result: 'ok' });
  }

  /** Return only the directory explicitly approved through Main's picker. */
  getExplicitWorkspacePath(projectId: string): string | null {
    this.requireProject(projectId);
    return this.readPreference(projectId).workspacePath;
  }

  /**
   * Resolve the project's user-selected working directory without exposing
   * it to the renderer. The IPC layer uses this value only for shell.openPath.
   * Prefer the explicitly bound DSH root, then the newest task/agent workspace.
   */
  getWorkspacePath(projectId: string): string | null {
    const project = this.requireProject(projectId);
    const preference = this.readPreference(project.id);
    if (preference.workspacePath) return preference.workspacePath;
    if (preference.rootSessionId) {
      const root = this.db.raw.prepare('SELECT workspace FROM dsh_sessions WHERE id = ? AND parent_session_id IS NULL').get(preference.rootSessionId) as Row | undefined;
      const rootWorkspace = text(root?.workspace).trim();
      if (rootWorkspace) return rootWorkspace;
    }
    const discoveredRoot = this.db.raw.prepare(`
      SELECT s.workspace
      FROM dsh_sessions s
      JOIN dsh_runs r ON r.session_id = s.id
      JOIN tasks t ON t.id = r.nexus_task_id
      WHERE t.project_id = ? AND s.parent_session_id IS NULL AND t.deleted_at IS NULL
      ORDER BY s.updated_at DESC, s.id DESC
      LIMIT 1
    `).get(project.id) as Row | undefined;
    const discoveredWorkspace = text(discoveredRoot?.workspace).trim();
    if (discoveredWorkspace) return discoveredWorkspace;
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

  private readPreference(projectId: string): { settings: QuestSettings; rootSessionId: string | null; workspacePath: string | null } {
    const raw = this.db.getSetting<Record<string, unknown>>(this.preferenceKey(projectId), {});
    const settings = defaultSettings();
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      if (raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)) {
        const candidate = raw.settings as Record<string, unknown>;
        if (candidate.mode === 'quest' || candidate.mode === 'direct') settings.mode = normalizeQuestMode(candidate.mode);
        if (SANDBOXES.has(candidate.sandbox as QuestSandbox)) settings.sandbox = candidate.sandbox as QuestSandbox;
        if (PERMISSIONS.has(candidate.permissionMode as PermissionMode)) settings.permissionMode = candidate.permissionMode as PermissionMode;
        try { settings.model = boundedText(candidate.model, 160); } catch { /* ignore corrupt preference */ }
        if (Array.isArray(candidate.workerAgentIds)) {
          try { settings.workerAgentIds = boundedIds(candidate.workerAgentIds, 'workerAgentIds'); } catch { /* ignore corrupt preference */ }
        }
        if (Array.isArray(candidate.pluginIds)) {
          try { settings.pluginIds = boundedIds(candidate.pluginIds, 'pluginIds'); } catch { /* ignore corrupt preference */ }
        }
        if (Number.isSafeInteger(candidate.maxParallel) && Number(candidate.maxParallel) >= 1 && Number(candidate.maxParallel) <= 16) settings.maxParallel = Number(candidate.maxParallel);
        settings.autoApproveLowRisk = candidate.autoApproveLowRisk === true;
        if (settings.permissionMode === 'autonomous') settings.autoApproveLowRisk = true;
      }
      let workspacePath: string | null = null;
      try { workspacePath = boundedWorkspacePath(raw.workspacePath); } catch { /* ignore corrupt host-only preference */ }
      const rootSessionId = typeof raw.rootSessionId === 'string' ? raw.rootSessionId : null;
      const storedPolicyVersion = Number.isSafeInteger(raw.policyVersion) ? Number(raw.policyVersion) : 0;
      if (storedPolicyVersion < QUEST_POLICY_VERSION && settings.permissionMode === 'standard') {
        settings.permissionMode = 'autonomous';
        settings.autoApproveLowRisk = true;
        this.writePreference(projectId, settings, rootSessionId, workspacePath);
        this.db.audit({
          id: randomUUID(), actor: 'system', action: 'quest.policy.migrate', target: projectId,
          result: 'standard-to-project-autonomous'
        });
      }
      return {
        settings,
        rootSessionId,
        workspacePath
      };
    }
    return { settings, rootSessionId: null, workspacePath: null };
  }

  private writePreference(projectId: string, settings: QuestSettings, rootSessionId: string | null, workspacePath: string | null): void {
    this.db.setSetting(this.preferenceKey(projectId), {
      settings, rootSessionId, workspacePath, policyVersion: QUEST_POLICY_VERSION
    });
  }

  private readScopedFacts(projectId: string, configuredRootId: string | null): {
    sessions: ProjectWorkbenchSessionView[];
    runs: ProjectWorkbenchRunView[];
    events: ProjectWorkbenchEventView[];
    tasks: Array<{ id: string; agentId: string; status: string; title: string; progress: number; createdAt: number; updatedAt: number; quality: string | null }>;
    agents: Map<string, Row>;
  } {
    const project = this.db.raw.prepare('SELECT organization_id FROM projects WHERE id = ?').get(projectId) as Row | undefined;
    if (!project) throw new Error('项目不存在');
    const organizationId = text(project.organization_id);
    const tasks = this.db.raw.prepare('SELECT id, agent_id, status, title, progress, created_at, COALESCE(ended_at, started_at, created_at) AS updated_at, quality FROM tasks WHERE project_id = ? AND deleted_at IS NULL').all(projectId) as Row[];
    const taskIds = this.db.raw.prepare('SELECT id FROM tasks WHERE project_id = ? AND deleted_at IS NULL').all(projectId) as Row[];
    const teamIds = this.db.raw.prepare('SELECT id FROM team_runs WHERE project_id = ?').all(projectId) as Row[];
    const taskPlaceholders = taskIds.length ? taskIds.map(() => '?').join(',') : "''";
    const teamPlaceholders = teamIds.length ? teamIds.map(() => '?').join(',') : "''";
    const scopeParams = [...taskIds.map((row) => text(row.id)), ...teamIds.map((row) => text(row.id))];
    const linkedRunRows = this.db.raw.prepare(`
      SELECT r.* FROM dsh_runs r
      WHERE r.nexus_task_id IN (${taskPlaceholders}) OR r.team_run_id IN (${teamPlaceholders})
      ORDER BY r.updated_at DESC, r.id DESC LIMIT 500
    `).all(...scopeParams) as Row[];
    const seedSessionIds = [...new Set([
      ...linkedRunRows.map((row) => text(row.session_id)).filter(Boolean),
      ...(configuredRootId ? [configuredRootId] : [])
    ])];
    const sessionIds = this.expandSessionScope(organizationId, seedSessionIds, projectId);
    if (configuredRootId && !sessionIds.includes(configuredRootId)) throw new Error('项目绑定的 DSH 根会话无效');
    this.assertSessionProjectOwnership(projectId, sessionIds, false);
    const sessionPlaceholders = sessionIds.length ? sessionIds.map(() => '?').join(',') : "''";
    const runsRows = this.db.raw.prepare(`
      SELECT r.* FROM dsh_runs r
      WHERE r.session_id IN (${sessionPlaceholders})
      ORDER BY r.updated_at DESC, r.id DESC LIMIT 501
    `).all(...sessionIds) as Row[];
    if (runsRows.length > 500) throw new Error('项目 DSH 运行数量超出工作台上限');
    const sessionRows = this.db.raw.prepare(`
      SELECT s.*, a.name AS agent_name, a.role AS agent_role, a.engine_id,
        (SELECT r2.upstream_state FROM dsh_runs r2 WHERE r2.session_id = s.id ORDER BY r2.updated_at DESC, r2.id DESC LIMIT 1) AS latest_run_state
      FROM dsh_sessions s JOIN agents a ON a.id = s.agent_id
      WHERE s.id IN (${sessionPlaceholders})
      ORDER BY s.delegation_depth ASC, s.updated_at DESC
    `).all(...sessionIds) as Row[];
    const sessionRowMap = new Map(sessionRows.map((row) => [text(row.id), row]));
    const rootIds = new Set(sessionRows.filter((row) => row.parent_session_id === null || row.parent_session_id === undefined).map((row) => text(row.id)));
    const sessions = sessionRows.map((row): ProjectWorkbenchSessionView => {
      const engineId = text(row.engine_id);
      const depth = number(row.delegation_depth);
      let kind: ProjectWorkbenchSessionKind = rootIds.has(text(row.id)) ? 'fixed-worker' : 'elastic-worker';
      if (rootIds.has(text(row.id)) && engineId.includes('a2a')) kind = 'external';
      return {
        sessionId: text(row.id), agentId: text(row.agent_id), agentName: text(row.agent_name, '数字员工'), engineId,
        parentSessionId: nullableText(row.parent_session_id), depth, kind,
        controlMode: text(row.control_mode, 'STANDALONE') as ProjectWorkbenchSessionView['controlMode'],
        revision: number(row.revision), lastEventCursor: number(row.last_event_cursor, -1),
        latestRunState: nullableText(row.latest_run_state), updatedAt: number(row.updated_at)
      };
    });
    const runs = runsRows.map((row): ProjectWorkbenchRunView => ({
      runId: text(row.id), sessionId: text(row.session_id), taskId: nullableText(row.nexus_task_id), teamRunId: nullableText(row.team_run_id),
      state: text(row.upstream_state, 'UNKNOWN'), checkpointRef: nullableText(row.checkpoint_ref),
      createdAt: number(row.created_at), updatedAt: number(row.updated_at)
    }));
    const events: ProjectWorkbenchEventView[] = [];
    if (sessionIds.length) {
      const eventRows = this.db.raw.prepare(`SELECT session_id, run_id, type, payload_json, created_at FROM dsh_events WHERE session_id IN (${sessionPlaceholders}) ORDER BY created_at DESC, seq DESC LIMIT 80`).all(...sessionIds) as Row[];
      for (const row of eventRows) {
        const payload = rowJson(row.payload_json);
        events.push({ sessionId: text(row.session_id), runId: nullableText(row.run_id), type: text(row.type), summary: safeSummary(payload.summary ?? payload.message ?? payload.result ?? ''), createdAt: number(row.created_at) });
      }
    }
    const agentIds = [...new Set([...tasks.map((row) => text(row.agent_id)), ...sessionRows.map((row) => text(row.agent_id))].filter(Boolean))];
    const agents = new Map<string, Row>();
    if (agentIds.length) {
      const placeholders = agentIds.map(() => '?').join(',');
      for (const row of this.db.raw.prepare(`SELECT id, name, role, engine_id FROM agents WHERE id IN (${placeholders})`).all(...agentIds) as Row[]) agents.set(text(row.id), row);
    }
    // Avoid keeping an unused map alive when a corrupt run points at a missing session.
    for (const run of runs) if (!sessionRowMap.has(run.sessionId)) run.state = 'ORPHANED';
    return {
      sessions,
      runs,
      events: events.slice(0, 50),
      tasks: tasks.map((row) => ({
        id: text(row.id), agentId: text(row.agent_id), status: text(row.status), title: text(row.title, '未命名任务'),
        progress: Math.max(0, Math.min(100, Math.trunc(number(row.progress)))), createdAt: number(row.created_at),
        updatedAt: number(row.updated_at), quality: nullableText(row.quality)
      })),
      agents
    };
  }

  private expandSessionScope(organizationId: string, seeds: string[], projectId: string): string[] {
    if (seeds.length === 0) return [];
    if (seeds.length > MAX_SESSION_NODES) throw new Error('项目 DSH 会话数量超出工作台上限');
    const parents = new Map<string, string | null>();
    let frontier = [...new Set(seeds)];
    let depth = 0;
    while (frontier.length) {
      if (depth++ > MAX_SESSION_DEPTH) throw new Error('项目 DSH 会话树深度超出上限');
      const placeholders = frontier.map(() => '?').join(',');
      const rows = this.db.raw.prepare(`
        SELECT s.id, s.parent_session_id
        FROM dsh_sessions s JOIN agents a ON a.id = s.agent_id
        WHERE s.id IN (${placeholders}) AND a.organization_id = ?
      `).all(...frontier, organizationId) as Row[];
      const found = new Set(rows.map((row) => text(row.id)));
      const missing = frontier.filter((id) => !found.has(id));
      if (missing.length) throw new Error('项目 DSH 会话树包含缺失或跨组织会话');
      const next: string[] = [];
      for (const row of rows) {
        const id = text(row.id);
        const parentId = nullableText(row.parent_session_id);
        parents.set(id, parentId);
        if (parentId && !parents.has(parentId) && !next.includes(parentId)) next.push(parentId);
      }
      if (parents.size > MAX_SESSION_NODES) throw new Error('项目 DSH 会话数量超出工作台上限');
      frontier = next;
    }

    for (const [id, parentId] of parents) {
      if (parentId && !parents.has(parentId)) throw new Error(`项目 DSH 会话树存在孤儿节点：${id}`);
      const visited = new Set<string>();
      let cursor: string | null = id;
      while (cursor) {
        if (visited.has(cursor)) throw new Error('项目 DSH 会话树存在循环');
        visited.add(cursor);
        cursor = parents.get(cursor) ?? null;
      }
    }

    const roots = [...parents].filter(([, parentId]) => parentId === null).map(([id]) => id);
    this.assertRootsNotBoundElsewhere(projectId, roots);
    frontier = roots;
    depth = 0;
    const expandedParents = new Set<string>();
    while (frontier.length) {
      if (depth++ > MAX_SESSION_DEPTH) throw new Error('项目 DSH 会话树深度超出上限');
      for (const id of frontier) expandedParents.add(id);
      const placeholders = frontier.map(() => '?').join(',');
      const rows = this.db.raw.prepare(`
        SELECT s.id, s.parent_session_id
        FROM dsh_sessions s JOIN agents a ON a.id = s.agent_id
        WHERE s.parent_session_id IN (${placeholders}) AND a.organization_id = ?
        ORDER BY s.updated_at DESC, s.id DESC
      `).all(...frontier, organizationId) as Row[];
      const next: string[] = [];
      for (const row of rows) {
        const id = text(row.id);
        if (!parents.has(id)) parents.set(id, nullableText(row.parent_session_id));
        if (!expandedParents.has(id) && !next.includes(id)) next.push(id);
      }
      if (parents.size > MAX_SESSION_NODES) throw new Error('项目 DSH 会话数量超出工作台上限');
      frontier = next;
    }
    return [...parents.keys()];
  }

  private assertSessionProjectOwnership(projectId: string, sessionIds: string[], requireLinkedProject: boolean): void {
    if (sessionIds.length === 0) {
      if (requireLinkedProject) throw new Error('DSH 根会话尚未关联到该项目');
      return;
    }
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = this.db.raw.prepare(`
      SELECT DISTINCT COALESCE(t.project_id, tr.project_id) AS project_id
      FROM dsh_runs r
      LEFT JOIN tasks t ON t.id = r.nexus_task_id AND t.deleted_at IS NULL
      LEFT JOIN team_runs tr ON tr.id = r.team_run_id
      WHERE r.session_id IN (${placeholders}) AND COALESCE(t.project_id, tr.project_id) IS NOT NULL
    `).all(...sessionIds) as Row[];
    const linkedProjects = new Set(rows.map((row) => text(row.project_id)).filter(Boolean));
    if ([...linkedProjects].some((id) => id !== projectId)) throw new Error('DSH 会话树已关联到其他项目');
    if (requireLinkedProject && !linkedProjects.has(projectId)) throw new Error('DSH 根会话尚未关联到该项目');
  }

  private assertRootsNotBoundElsewhere(projectId: string, rootIds: string[]): void {
    if (rootIds.length === 0) return;
    const roots = new Set(rootIds);
    const rows = this.db.raw.prepare("SELECT key, value_json FROM settings WHERE key LIKE 'project:workbench:%'").all() as Row[];
    for (const row of rows) {
      const key = text(row.key);
      const boundProjectId = key.slice('project:workbench:'.length);
      if (projectId && boundProjectId === projectId) continue;
      const value = rowJson(row.value_json);
      if (typeof value.rootSessionId === 'string' && roots.has(value.rootSessionId)) {
        throw new Error('DSH 根会话已绑定到其他项目');
      }
    }
  }

  private buildSessionTree(sessions: ProjectWorkbenchSessionView[]): ProjectWorkbenchSessionTreeNodeView[] {
    const nodes = new Map<string, ProjectWorkbenchSessionTreeNodeView>();
    for (const session of sessions) nodes.set(session.sessionId, { session, children: [] });
    const roots: ProjectWorkbenchSessionTreeNodeView[] = [];
    for (const node of nodes.values()) {
      const parent = node.session.parentSessionId ? nodes.get(node.session.parentSessionId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    const sort = (items: ProjectWorkbenchSessionTreeNodeView[]) => {
      items.sort((a, b) => b.session.updatedAt - a.session.updatedAt || a.session.sessionId.localeCompare(b.session.sessionId));
      for (const item of items) sort(item.children);
    };
    sort(roots);
    return roots;
  }

  private buildDeliveryBoard(
    projectId: string,
    tasks: Array<{ id: string; agentId: string; status: string; title: string; progress: number; createdAt: number; updatedAt: number; quality: string | null }>,
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
      if (status === 'COMPLETED' || task.quality === 'accepted') return 'completed';
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
    tasks: Array<{ id: string; agentId: string; status: string; title: string; progress: number; createdAt: number; updatedAt: number; quality: string | null }>,
    sessions: ProjectWorkbenchSessionView[]
  ): ProjectUsageStatsView {
    const periodDays = 30;
    const since = this.now() - periodDays * 86_400_000;
    const usageRows = this.db.raw.prepare(`
      SELECT u.agent_id, u.model, u.input_tokens, u.output_tokens, u.total_tokens, u.created_at
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
    const models = new Set<string>();
    const usageAgents = new Set<string>();
    let totalTokens = 0;
    for (const row of usageRows) {
      const day = days.get(dayKey(number(row.created_at)));
      const tokens = Math.max(0, Math.trunc(number(row.total_tokens, number(row.input_tokens) + number(row.output_tokens))));
      if (day) { day.usageCount += 1; day.totalTokens += tokens; }
      totalTokens += tokens;
      if (text(row.model)) models.add(text(row.model));
      if (text(row.agent_id)) usageAgents.add(text(row.agent_id));
    }
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter((task) => task.status === 'COMPLETED').length;
    const activeTasks = tasks.filter((task) => ['QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'PAUSED'].includes(task.status)).length;
    return {
      periodDays, totalTasks, completedTasks, activeTasks, usageCount: usageRows.length, totalTokens,
      uniqueAgents: new Set(tasks.map((task) => task.agentId).filter(Boolean)).size,
      uniqueWorkers: new Set([...sessions.map((session) => session.agentId), ...usageAgents, ...models]).size,
      averageTasksPerDay: Math.round((totalTasks / periodDays) * 10) / 10,
      days: [...days.entries()].map(([date, value]) => ({ date, ...value }))
    };
  }

  private isTerminal(state: string): boolean {
    return ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'DONE', 'FAILED', 'CANCELLED'].includes(state.toUpperCase());
  }
}
