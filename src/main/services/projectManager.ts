/** 项目领域服务：经营目标与任务/成果之间的稳定归属层。 */
import { randomUUID } from 'node:crypto';
import type {
  DeliverableSummary, Project, ProjectHealth, ProjectInput, ProjectOperationsOverview,
  ProjectPatch, ProjectRiskItem, ProjectRiskKind, ProjectStatus
} from '../../shared/types.js';
import type { Database } from './database.js';

interface ProjectRow {
  id: string;
  name: string;
  objective: string;
  description: string;
  client_name: string;
  status: string;
  color: string;
  due_at: number | null;
  created_at: number;
  updated_at: number;
}

interface TaskOperationsRow {
  id: string;
  project_id: string | null;
  agent_id: string;
  title: string;
  status: string;
  progress: number;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

interface AgentOperationsRow {
  id: string;
  name: string;
  role: string;
}

const STATUSES: ProjectStatus[] = ['planning', 'active', 'paused', 'completed', 'archived'];
const DEFAULT_COLOR = '#4d6bfe';

export class ProjectManager {
  constructor(private db: Database) {}

  list(): Project[] {
    return (this.db.raw.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as unknown as ProjectRow[])
      .map(this.mapRow);
  }

  get(id: string): Project | null {
    const row = this.db.raw.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as ProjectRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  create(input: ProjectInput): Project {
    const name = this.requiredText(input.name, '项目名称', 2, 60);
    const objective = this.text(input.objective, '项目目标', 500);
    const description = this.text(input.description, '项目说明', 2000);
    const clientName = this.text(input.clientName, '客户名称', 100);
    const status = this.status(input.status ?? 'active', false);
    const color = this.color(input.color);
    const dueAt = this.dueAt(input.dueAt);
    const now = Date.now();
    const id = `project-${randomUUID().slice(0, 8)}`;

    this.db.raw.prepare(
      'INSERT INTO projects(id, name, objective, description, client_name, status, color, due_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
    ).run(id, name, objective, description, clientName, status, color, dueAt, now, now);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'project.create', target: id, result: 'ok' });
    return this.get(id)!;
  }

  update(id: string, patch: ProjectPatch): Project | null {
    if (!this.get(id)) return null;
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    const add = (field: string, value: string | number | null) => { fields.push(`${field} = ?`); values.push(value); };

    if (patch.name !== undefined) add('name', this.requiredText(patch.name, '项目名称', 2, 60));
    if (patch.objective !== undefined) add('objective', this.text(patch.objective, '项目目标', 500));
    if (patch.description !== undefined) add('description', this.text(patch.description, '项目说明', 2000));
    if (patch.clientName !== undefined) add('client_name', this.text(patch.clientName, '客户名称', 100));
    if (patch.status !== undefined) add('status', this.status(patch.status, true));
    if (patch.color !== undefined) add('color', this.color(patch.color));
    if (patch.dueAt !== undefined) add('due_at', this.dueAt(patch.dueAt));
    if (fields.length === 0) return this.get(id);

    add('updated_at', Date.now());
    values.push(id);
    this.db.raw.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'project.update', target: id, result: 'ok' });
    return this.get(id);
  }

  archive(id: string): Project | null {
    const project = this.update(id, { status: 'archived' });
    if (project) this.db.audit({ id: randomUUID(), actor: 'admin', action: 'project.archive', target: id, result: 'ok' });
    return project;
  }

  operations(deliverables: DeliverableSummary[]): ProjectOperationsOverview {
    const now = Date.now();
    const projects = this.list();
    const projectIds = new Set(projects.map((project) => project.id));
    const tasks = this.db.raw.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY created_at DESC').all() as unknown as TaskOperationsRow[];
    const agents = new Map(
      (this.db.raw.prepare('SELECT * FROM agents').all() as unknown as AgentOperationsRow[])
        .map((agent) => [agent.id, agent])
    );
    const openStatuses: ProjectStatus[] = ['planning', 'active', 'paused'];
    const activeTaskStatuses = ['RUNNING', 'QUEUED', 'WAITING_APPROVAL', 'PAUSED'];
    const failedTaskStatuses = ['FAILED', 'INTERRUPTED'];
    const severityRank = { high: 0, medium: 1, low: 2 } as const;

    const items = projects.map((project) => {
      const scopedTasks = tasks.filter((task) => task.project_id === project.id);
      const scopedDeliverables = deliverables.filter((item) => item.projectId === project.id);
      const completed = scopedTasks.filter((task) => task.status === 'COMPLETED').length;
      const active = scopedTasks.filter((task) => activeTaskStatuses.includes(task.status)).length;
      const failed = scopedTasks.filter((task) => failedTaskStatuses.includes(task.status)).length;
      const waitingApproval = scopedTasks.filter((task) => task.status === 'WAITING_APPROVAL').length;
      const paused = scopedTasks.filter((task) => task.status === 'PAUSED').length;
      const accepted = scopedDeliverables.filter((item) => item.reviewStatus === 'accepted').length;
      const rejected = scopedDeliverables.filter((item) => item.reviewStatus === 'rejected').length;
      const rework = scopedDeliverables.filter((item) => item.reviewStatus === 'rework').length;
      const unmarked = scopedDeliverables.filter((item) => item.reviewStatus === 'unmarked').length;
      const progress = scopedTasks.length
        ? Math.round(scopedTasks.reduce((sum, task) => sum + (task.status === 'COMPLETED' ? 100 : Math.max(0, Math.min(100, Number(task.progress) || 0))), 0) / scopedTasks.length)
        : 0;
      const acceptanceRate = scopedDeliverables.length ? Math.round((accepted / scopedDeliverables.length) * 100) : 0;
      const risks: ProjectRiskItem[] = [];
      const addRisk = (kind: ProjectRiskKind, severity: ProjectRiskItem['severity'], title: string, detail: string, count = 1) => {
        risks.push({ id: `${project.id}:${kind}`, projectId: project.id, projectName: project.name, kind, severity, title, detail, count });
      };
      const isOpen = openStatuses.includes(project.status);
      const overdue = isOpen && project.dueAt !== null && project.dueAt < now;
      const dueSoon = isOpen && project.dueAt !== null && project.dueAt >= now && project.dueAt - now <= 3 * 86_400_000 && progress < 80;
      if (overdue) addRisk('overdue', 'high', '项目已逾期', `截止日期 ${new Date(project.dueAt!).toLocaleDateString('zh-CN')}，当前进度 ${progress}%`);
      if (dueSoon) addRisk('due_soon', 'medium', '临近截止日期', `3 天内到期，当前进度 ${progress}%`);
      if (project.status === 'active' && scopedTasks.length === 0) addRisk('empty_plan', 'medium', '尚未拆解任务', '进行中的项目还没有关联任务');
      if (project.status === 'paused') addRisk('paused_project', 'medium', '项目处于暂停状态', '需要确认恢复时间或调整项目计划');
      if (failed > 0) addRisk('failed_task', 'high', `${failed} 项任务执行失败`, scopedTasks.filter((task) => failedTaskStatuses.includes(task.status)).slice(0, 2).map((task) => task.title).join('、'), failed);
      if (waitingApproval > 0) addRisk('waiting_approval', 'medium', `${waitingApproval} 项任务等待审批`, '审批未完成会阻塞后续交付', waitingApproval);
      if (paused > 0) addRisk('paused_task', 'medium', `${paused} 项任务已暂停`, '需要明确继续执行或终止', paused);
      if (rejected > 0) addRisk('rejected_deliverable', 'high', `${rejected} 项成果被驳回`, '需重新确认范围与验收标准', rejected);
      if (rework > 0) addRisk('rework_deliverable', 'medium', `${rework} 项成果等待返工`, '返工完成后需要重新验收', rework);
      if (project.status === 'completed' && (unmarked > 0 || rework > 0)) {
        addRisk('pending_acceptance', 'medium', '项目已完成但验收未闭环', `${unmarked + rework} 项成果仍待最终确认`, unmarked + rework);
      }

      let health: ProjectHealth = 'on_track';
      if (project.status === 'archived') health = 'inactive';
      else if (risks.some((risk) => risk.severity === 'high')) health = 'at_risk';
      else if (risks.length > 0) health = 'attention';
      else if (project.status === 'completed') health = 'completed';

      const ownerStats = new Map<string, { total: number; completed: number; active: number; failed: number }>();
      for (const task of scopedTasks) {
        const value = ownerStats.get(task.agent_id) ?? { total: 0, completed: 0, active: 0, failed: 0 };
        value.total += 1;
        if (task.status === 'COMPLETED') value.completed += 1;
        if (activeTaskStatuses.includes(task.status)) value.active += 1;
        if (failedTaskStatuses.includes(task.status)) value.failed += 1;
        ownerStats.set(task.agent_id, value);
      }
      const owners = [...ownerStats.entries()].map(([agentId, value]) => {
        const agent = agents.get(agentId);
        return {
          agentId, name: agent?.name ?? '已归档数字员工', role: agent?.role ?? '', totalTasks: value.total,
          completedTasks: value.completed, activeTasks: value.active, failedTasks: value.failed
        };
      }).sort((a, b) => b.activeTasks - a.activeTasks || b.totalTasks - a.totalTasks || a.name.localeCompare(b.name, 'zh-CN'));
      const recentActivityAt = Math.max(
        project.updatedAt,
        ...scopedTasks.map((task) => task.ended_at ?? task.started_at ?? task.created_at),
        ...scopedDeliverables.map((item) => item.updatedAt)
      );

      return {
        project, health, progress, acceptanceRate, recentActivityAt,
        tasks: { total: scopedTasks.length, completed, active, failed, waitingApproval, paused },
        deliverables: { total: scopedDeliverables.length, accepted, rejected, rework, unmarked },
        owners, risks: risks.sort((a, b) => severityRank[a.severity] - severityRank[b.severity])
      };
    });

    const projectTasks = tasks.filter((task) => task.project_id !== null && projectIds.has(task.project_id));
    const completedTasks = projectTasks.filter((task) => task.status === 'COMPLETED').length;
    const allRisks = items.flatMap((item) => item.risks)
      .sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || a.projectName.localeCompare(b.projectName, 'zh-CN'));
    const statusDistribution: ProjectOperationsOverview['statusDistribution'] = {
      planning: 0, active: 0, paused: 0, completed: 0, archived: 0
    };
    for (const project of projects) statusDistribution[project.status] += 1;

    return {
      generatedAt: now,
      summary: {
        totalProjects: projects.length,
        openProjects: projects.filter((project) => openStatuses.includes(project.status)).length,
        atRiskProjects: items.filter((item) => item.health === 'at_risk' || item.health === 'attention').length,
        overdueProjects: items.filter((item) => item.risks.some((risk) => risk.kind === 'overdue')).length,
        taskCompletionRate: projectTasks.length ? Math.round((completedTasks / projectTasks.length) * 100) : 0,
        acceptedDeliverables: deliverables.filter((item) => item.projectId !== null && projectIds.has(item.projectId) && item.reviewStatus === 'accepted').length,
        pendingAcceptance: deliverables.filter((item) => item.projectId !== null && projectIds.has(item.projectId) && ['unmarked', 'rework'].includes(item.reviewStatus)).length
      },
      statusDistribution,
      projects: items.sort((a, b) => {
        const healthRank: Record<ProjectHealth, number> = { at_risk: 0, attention: 1, on_track: 2, completed: 3, inactive: 4 };
        return healthRank[a.health] - healthRank[b.health] || b.recentActivityAt - a.recentActivityAt;
      }),
      risks: allRisks
    };
  }

  private mapRow = (row: ProjectRow): Project => ({
    id: row.id,
    name: row.name,
    objective: row.objective ?? '',
    description: row.description ?? '',
    clientName: row.client_name ?? '',
    status: row.status as ProjectStatus,
    color: row.color || DEFAULT_COLOR,
    dueAt: row.due_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });

  private requiredText(value: unknown, label: string, min: number, max: number): string {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length < min || text.length > max) throw new Error(`${label}需为 ${min}-${max} 个字符`);
    return text;
  }

  private text(value: unknown, label: string, max: number): string {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length > max) throw new Error(`${label}不能超过 ${max} 个字符`);
    return text;
  }

  private status(value: unknown, allowArchived: boolean): ProjectStatus {
    if (!STATUSES.includes(value as ProjectStatus) || (!allowArchived && value === 'archived')) throw new Error('项目状态无效');
    return value as ProjectStatus;
  }

  private color(value: unknown): string {
    const color = typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : DEFAULT_COLOR;
    return color.toLowerCase();
  }

  private dueAt(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error('项目截止时间无效');
    return Math.floor(value);
  }
}
