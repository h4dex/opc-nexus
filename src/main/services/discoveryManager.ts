/** 跨实体检索与行动中心：统一发现入口，并从当前业务状态派生待处理事项。 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  ActionCenterItem, ActionCenterKind, ActionCenterOverview, DeliverableSummary, GlobalSearchResult,
  KnowledgeSummary, ProjectOperationsOverview, SearchEntityType, SearchRoute, TeamRun
} from '../../shared/types.js';
import type { AutomationFinding } from '../../shared/types.js';
import type { Database } from './database.js';

type Row = Record<string, unknown>;

interface DiscoveryDeps {
  projects: { operations: (deliverables: DeliverableSummary[]) => ProjectOperationsOverview };
  deliverables: { list: () => DeliverableSummary[] };
  knowledge: { list: (query?: { status?: 'active' | 'archived' | 'all' }) => KnowledgeSummary[] };
  teams: { listAttentionRuns: (limit?: number) => (TeamRun & { teamName: string })[] };
  automation?: { findings: (projectId?: string) => AutomationFinding[] };
}

interface Candidate extends GlobalSearchResult {
  haystack: string;
}

interface DismissalRow {
  action_key: string;
  fingerprint: string;
}

const ENTITY_ROUTE: Record<SearchEntityType, SearchRoute> = {
  project: 'projects', agent: 'agents', task: 'tasks', team: 'teams', deliverable: 'deliverables', knowledge: 'knowledge'
};

export class DiscoveryManager {
  constructor(private db: Database, private deps: DiscoveryDeps) {}

  search(input: string, limit = 36): GlobalSearchResult[] {
    const query = input.trim().toLocaleLowerCase('zh-CN');
    const projects = this.rows('SELECT * FROM projects ORDER BY updated_at DESC');
    const agents = this.rows('SELECT * FROM agents WHERE archived = 0');
    const tasks = this.rows('SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 200');
    const teams = this.rows('SELECT * FROM teams ORDER BY created_at DESC');
    const deliverables = this.rows('SELECT * FROM deliverables ORDER BY updated_at DESC');
    const projectNames = new Map(projects.map((row) => [this.string(row.id), this.string(row.name)]));
    const agentNames = new Map(agents.map((row) => [this.string(row.id), this.string(row.name)]));
    const candidates: Candidate[] = [];
    const add = (entityType: SearchEntityType, entityId: string, title: string, subtitle: string,
      status: string, projectId: string | null, updatedAt: number, extra = '') => {
      candidates.push({
        key: `${entityType}:${entityId}`, entityType, entityId, route: ENTITY_ROUTE[entityType], title,
        subtitle, status, projectId, updatedAt, haystack: `${title}\n${subtitle}\n${status}\n${extra}`.toLocaleLowerCase('zh-CN')
      });
    };

    for (const row of projects) add('project', this.string(row.id), this.string(row.name),
      this.string(row.objective) || this.string(row.client_name) || '项目', this.string(row.status), this.string(row.id), this.number(row.updated_at), this.string(row.description));
    for (const row of agents) add('agent', this.string(row.id), this.string(row.name), this.string(row.role) || '数字员工',
      this.string(row.lifecycle), null, this.number(row.updated_at), this.string(row.tags_json));
    for (const row of tasks) {
      const projectId = this.nullable(row.project_id);
      add('task', this.string(row.id), this.string(row.title), `${agentNames.get(this.string(row.agent_id)) ?? '数字员工'} · ${projectId ? projectNames.get(projectId) ?? '已归档项目' : '未归项目'}`,
        this.string(row.status), projectId, this.number(row.ended_at) || this.number(row.created_at), this.string(row.result));
    }
    for (const row of teams) add('team', this.string(row.id), this.string(row.name),
      this.string(row.mode) === 'roundtable' ? '专家圆桌' : '主专家协调', 'active', null, this.number(row.created_at));
    for (const row of deliverables) {
      const projectId = this.nullable(row.project_id);
      add('deliverable', this.string(row.id), this.string(row.title), `${this.string(row.owner_name)} · ${projectId ? projectNames.get(projectId) ?? '已归档项目' : '未归项目'}`,
        this.string(row.review_status), projectId, this.number(row.updated_at), this.string(row.tags_json));
    }
    for (const item of this.deps.knowledge.list({ status: 'active' })) add('knowledge', item.id, item.title,
      `${item.projectName} · ${item.sourceType === 'deliverable' ? '验收成果' : '手动记录'}`, item.status,
      item.projectId, item.updatedAt, `${item.tags.join(' ')} ${item.preview}`);

    return candidates
      .map((candidate) => ({ candidate, score: this.searchScore(candidate, query) }))
      .filter(({ score }) => !query || score > 0)
      .sort((a, b) => b.score - a.score || b.candidate.updatedAt - a.candidate.updatedAt)
      .slice(0, Math.max(1, Math.min(limit, 80)))
      .map(({ candidate: { haystack: _haystack, ...candidate } }) => candidate);
  }

  actions(): ActionCenterOverview {
    const deliverables = this.deps.deliverables.list();
    const operations = this.deps.projects.operations(deliverables);
    const dismissals = new Map(
      (this.db.raw.prepare('SELECT * FROM action_dismissals ORDER BY dismissed_at DESC').all() as unknown as DismissalRow[])
        .map((row) => [row.action_key, row.fingerprint])
    );
    const agents = new Map(this.rows('SELECT * FROM agents').map((row) => [this.string(row.id), this.string(row.name)]));
    const items: ActionCenterItem[] = [];
    const add = (item: Omit<ActionCenterItem, 'fingerprint'>, signature: string) => {
      const fingerprint = this.fingerprint(signature);
      if (dismissals.get(item.key) === fingerprint) return;
      items.push({ ...item, fingerprint });
    };

    for (const row of this.rows("SELECT * FROM approvals WHERE status = 'pending'")) {
      const id = this.string(row.id);
      const request = this.string(row.request);
      const risk = this.string(row.risk);
      add({
        key: `approval:${id}`, kind: 'approval', title: request.slice(0, 100), owner: agents.get(this.string(row.agent_id)) ?? '数字员工',
        reason: `待审批操作 · ${risk === 'high' ? '高风险' : risk === 'medium' ? '中风险' : '低风险'}`,
        suggestion: '核对操作目标和影响范围后处理。', severity: risk === 'high' ? 'danger' : risk === 'medium' ? 'warn' : 'info',
        createdAt: this.number(row.created_at), target: { route: 'tasks', entityType: 'task', entityId: this.string(row.task_id) }, approvalId: id
      }, `${this.string(row.status)}:${request}:${risk}`);
    }

    for (const row of this.rows('SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 200').filter((item) => ['FAILED', 'INTERRUPTED'].includes(this.string(item.status)))) {
      const id = this.string(row.id);
      const status = this.string(row.status);
      add({
        key: `failed_task:${id}`, kind: 'failed_task', title: this.string(row.title), owner: agents.get(this.string(row.agent_id)) ?? '数字员工',
        reason: this.string(row.error) || (status === 'INTERRUPTED' ? '任务因客户端中断而停止。' : '任务执行失败。'),
        suggestion: '查看执行详情，修正原因后重试。', severity: 'danger', createdAt: this.number(row.ended_at) || this.number(row.created_at),
        target: { route: 'tasks', entityType: 'task', entityId: id }, approvalId: null
      }, `${status}:${this.string(row.error)}:${this.number(row.ended_at)}`);
    }

    for (const deliverable of deliverables.filter((item) => ['unmarked', 'rework'].includes(item.reviewStatus))) {
      add({
        key: `deliverable:${deliverable.id}`, kind: 'deliverable', title: deliverable.title, owner: deliverable.ownerName,
        reason: deliverable.reviewStatus === 'rework' ? `成果需要返工：${deliverable.reviewNote || '等待补充内容'}` : '成果已生成，等待人工验收。',
        suggestion: deliverable.reviewStatus === 'rework' ? '检查返工版本并重新验收。' : '预览正文并选择采纳、返工或驳回。',
        severity: deliverable.reviewStatus === 'rework' ? 'warn' : 'info', createdAt: deliverable.updatedAt,
        target: { route: 'deliverables', entityType: 'deliverable', entityId: deliverable.id }, approvalId: null
      }, `${deliverable.reviewStatus}:${deliverable.latestVersion}:${deliverable.updatedAt}`);
    }

    const duplicateRiskKinds = new Set(['failed_task', 'pending_acceptance', 'rework_deliverable', 'rejected_deliverable']);
    for (const risk of operations.risks.filter((item) => !duplicateRiskKinds.has(item.kind))) {
      add({
        key: `project_risk:${risk.id}`, kind: 'project_risk', title: risk.title, owner: risk.projectName,
        reason: risk.detail, suggestion: '打开项目经营看板处理风险来源。',
        severity: risk.severity === 'high' ? 'danger' : risk.severity === 'medium' ? 'warn' : 'info', createdAt: operations.generatedAt,
        target: { route: 'projects', entityType: 'project', entityId: risk.projectId }, approvalId: null
      }, `${risk.kind}:${risk.severity}:${risk.detail}:${risk.count}`);
    }

    for (const run of this.deps.teams.listAttentionRuns(50)) {
      add({
        key: `team_run:${run.id}`, kind: 'team_run', title: `${run.teamName} · ${run.taskText}`, owner: run.teamName,
        reason: run.error || (run.phase === 'cancelled' ? '专家团运行已取消。' : '专家团运行需要人工检查。'),
        suggestion: '查看执行时间线和失败子任务。', severity: 'warn', createdAt: run.endedAt ?? run.createdAt,
        target: { route: 'teams', entityType: 'team', entityId: run.teamId }, approvalId: null
      }, `${run.phase}:${run.error}:${run.endedAt}`);
    }

    for (const finding of (this.deps.automation?.findings() ?? []).filter((item) => ['duplicate_work', 'budget'].includes(item.kind))) {
      add({
        key: `automation_risk:${finding.id}`, kind: 'project_risk', title: finding.title, owner: finding.projectName,
        reason: finding.detail, suggestion: '打开经营自动化工作台查看异常并安排处理。',
        severity: finding.severity === 'high' ? 'danger' : finding.severity === 'medium' ? 'warn' : 'info', createdAt: finding.detectedAt,
        target: { route: 'projects', entityType: 'project', entityId: finding.projectId }, approvalId: null
      }, `${finding.kind}:${finding.severity}:${finding.detail}:${finding.count}`);
    }

    const severityRank = { danger: 0, warn: 1, info: 2 } as const;
    items.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.createdAt - a.createdAt);
    const counts: Record<ActionCenterKind, number> = { approval: 0, failed_task: 0, team_run: 0, deliverable: 0, project_risk: 0 };
    for (const item of items) counts[item.kind]++;
    return { generatedAt: Date.now(), total: items.length, counts, items: items.slice(0, 200) };
  }

  dismiss(actionKey: string, fingerprint: string): void {
    this.db.raw.prepare(`INSERT INTO action_dismissals(action_key, fingerprint, dismissed_at) VALUES(?,?,?)
      ON CONFLICT(action_key) DO UPDATE SET fingerprint = excluded.fingerprint, dismissed_at = excluded.dismissed_at`)
      .run(actionKey, fingerprint, Date.now());
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'action.dismiss', target: actionKey, result: 'ok' });
  }

  private rows(sql: string): Row[] {
    return this.db.raw.prepare(sql).all() as unknown as Row[];
  }

  private searchScore(candidate: Candidate, query: string): number {
    if (!query) return candidate.updatedAt / 1_000_000_000;
    const title = candidate.title.toLocaleLowerCase('zh-CN');
    const terms = query.split(/\s+/).filter(Boolean);
    if (!terms.every((term) => candidate.haystack.includes(term))) return 0;
    return terms.reduce((score, term) => score + (title === term ? 120 : title.startsWith(term) ? 80 : title.includes(term) ? 50 : 15), 0);
  }

  private fingerprint(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 20);
  }

  private string(value: unknown): string {
    return value === null || value === undefined ? '' : String(value);
  }

  private nullable(value: unknown): string | null {
    const normalized = this.string(value);
    return normalized || null;
  }

  private number(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0;
  }
}
