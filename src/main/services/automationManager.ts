/** 项目经营自动化：巡检与报告、异常发现、预算、执行人推荐和客户交付。 */
import { randomUUID } from 'node:crypto';
import type {
  AssigneeRecommendation, AutomationAuditItem, AutomationFinding, AutomationOverview,
  AutomationReport, AutomationReportKind, AutomationReportMetrics, CustomerDelivery,
  CustomerDeliveryInput, CustomerDeliveryStatus, DeliverableSummary, Project, ProjectBudget,
  ProjectBudgetInput
} from '../../shared/types.js';
import type { Database } from './database.js';

type Row = Record<string, unknown>;

interface AutomationDeps {
  projects: { list: () => Project[] };
  deliverables: { list: () => DeliverableSummary[] };
}

const MODEL_PRICING: Record<string, number> = {
  'deepseek-chat': 2, 'deepseek-reasoner': 4, 'gpt-4o-mini': 1.5, 'gpt-4o': 15,
  'qwen-plus': 4, 'qwen-turbo': 1, 'moonshot-v1-8k': 12, 'llama3.1': 0
};
const DEFAULT_PRICE = 2;
const ACTIVE_TASK_STATUSES = new Set(['RUNNING', 'QUEUED', 'WAITING_APPROVAL', 'PAUSED']);
const END_TASK_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED']);

export class AutomationManager {
  constructor(private db: Database, private deps: AutomationDeps) {}

  overview(projectId?: string): AutomationOverview {
    const findings = this.findings(projectId);
    const reports = this.reports(projectId);
    const budgets = this.budgets(projectId);
    const deliveries = this.deliveries(projectId);
    const scheduleRows = this.rows('SELECT * FROM schedules ORDER BY next_run_at')
      .filter((row) => this.number(row.enabled) === 1 && this.string(row.automation_kind) !== 'task'
        && (!projectId || this.string(row.project_id) === projectId));
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    return {
      generatedAt: Date.now(),
      summary: {
        activePlans: scheduleRows.length,
        highRiskFindings: findings.filter((item) => item.severity === 'high').length,
        reportsThisMonth: reports.filter((item) => item.createdAt >= monthStart.getTime()).length,
        overBudgetProjects: budgets.filter((item) => item.status === 'exceeded').length,
        pendingDeliveries: deliveries.filter((item) => item.status !== 'accepted').length
      },
      findings, reports, budgets, deliveries, auditLogs: this.auditLogs(projectId)
    };
  }

  findings(projectId?: string): AutomationFinding[] {
    const now = Date.now();
    const projects = this.deps.projects.list().filter((project) => !projectId || project.id === projectId);
    const projectIds = new Set(projects.map((project) => project.id));
    const projectNames = new Map(projects.map((project) => [project.id, project.name]));
    const tasks = this.taskRows().filter((row) => projectIds.has(this.string(row.project_id)));
    const deliverables = this.deps.deliverables.list().filter((item) => !!item.projectId && projectIds.has(item.projectId));
    const result: AutomationFinding[] = [];
    const add = (item: Omit<AutomationFinding, 'detectedAt'>) => result.push({ ...item, detectedAt: now });

    for (const project of projects) {
      if (project.dueAt !== null && project.dueAt < now && !['completed', 'archived'].includes(project.status)) {
        const days = Math.max(1, Math.floor((now - project.dueAt) / 86_400_000));
        add({ id: `overdue:${project.id}`, kind: 'overdue', projectId: project.id, projectName: project.name,
          severity: 'high', title: '项目已逾期', detail: `超过计划截止时间 ${days} 天`, count: days });
      }

      const scopedTasks = tasks.filter((row) => this.string(row.project_id) === project.id);
      const scopedDeliverables = deliverables.filter((item) => item.projectId === project.id);
      const lowQualityDeliverables = scopedDeliverables.filter((item) => ['rejected', 'rework'].includes(item.reviewStatus));
      const lowQualityTasks = scopedTasks.filter((row) => ['rejected', 'rework'].includes(this.string(row.quality)));
      const lowQuality = lowQualityDeliverables.length + lowQualityTasks.length;
      if (lowQuality > 0) add({
        id: `low_quality:${project.id}`, kind: 'low_quality', projectId: project.id, projectName: project.name,
        severity: lowQualityDeliverables.some((item) => item.reviewStatus === 'rejected') ? 'high' : 'medium',
        title: '存在低质量交付', detail: `${lowQualityDeliverables.length} 项成果、${lowQualityTasks.length} 项任务被驳回或要求返工`, count: lowQuality
      });

      const duplicateGroups = new Map<string, Row[]>();
      for (const task of scopedTasks.filter((row) => this.number(row.created_at) >= now - 30 * 86_400_000)) {
        const normalized = this.normalizeTitle(this.string(task.title));
        if (normalized.length < 4) continue;
        const group = duplicateGroups.get(normalized) ?? [];
        group.push(task); duplicateGroups.set(normalized, group);
      }
      const duplicates = [...duplicateGroups.values()].filter((group) => group.length > 1);
      if (duplicates.length > 0) {
        const count = duplicates.reduce((sum, group) => sum + group.length - 1, 0);
        const samples = duplicates.slice(0, 2).map((group) => this.string(group[0].title).replace(/^重新执行[：:]\s*/, '')).join('、');
        add({ id: `duplicate_work:${project.id}`, kind: 'duplicate_work', projectId: project.id, projectName: project.name,
          severity: count >= 5 ? 'high' : 'medium', title: '检测到重复工作', detail: `${count} 次疑似重复执行：${samples}`, count });
      }
    }

    for (const budget of this.budgets(projectId).filter((item) => ['warning', 'exceeded'].includes(item.status))) {
      add({
        id: `budget:${budget.projectId}`, kind: 'budget', projectId: budget.projectId, projectName: budget.projectName,
        severity: budget.status === 'exceeded' ? 'high' : 'medium', title: budget.status === 'exceeded' ? '项目预算已超额' : '项目预算接近上限',
        detail: `已使用 ${budget.usagePercent}% · ${budget.spentTokens.toLocaleString('zh-CN')} Token · 估算 ¥${budget.spentCost.toFixed(2)}`, count: budget.usagePercent
      });
    }

    const severityRank = { high: 0, medium: 1, low: 2 } as const;
    return result.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.count - a.count || (projectNames.get(a.projectId) ?? '').localeCompare(projectNames.get(b.projectId) ?? '', 'zh-CN'));
  }

  reports(projectId?: string): AutomationReport[] {
    const projects = new Map(this.deps.projects.list().map((project) => [project.id, project.name]));
    return this.rows('SELECT * FROM automation_reports ORDER BY created_at DESC LIMIT 100')
      .filter((row) => !projectId || this.string(row.project_id) === projectId)
      .map((row) => ({
        id: this.string(row.id), scheduleId: this.nullable(row.schedule_id), projectId: this.string(row.project_id),
        projectName: projects.get(this.string(row.project_id)) ?? '已归档项目', kind: this.string(row.kind) as AutomationReportKind,
        title: this.string(row.title), periodStart: this.number(row.period_start), periodEnd: this.number(row.period_end),
        metrics: this.json<AutomationReportMetrics>(row.metrics_json, this.emptyMetrics()),
        findings: this.json<AutomationFinding[]>(row.findings_json, []), content: this.string(row.content),
        trigger: this.string(row.trigger) === 'scheduled' ? 'scheduled' : 'manual', createdAt: this.number(row.created_at)
      }));
  }

  run(kind: AutomationReportKind, projectId: string, trigger: 'manual' | 'scheduled' = 'manual', scheduleId: string | null = null): AutomationReport {
    const project = this.deps.projects.list().find((item) => item.id === projectId);
    if (!project) throw new Error('项目不存在');
    const now = Date.now();
    const periodStart = kind === 'monthly_report' ? new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime()
      : now - (kind === 'weekly_report' ? 7 : 1) * 86_400_000;
    const findings = this.findings(projectId);
    const metrics = this.metrics(projectId, periodStart, now);
    const kindLabel = kind === 'project_inspection' ? '项目巡检' : kind === 'weekly_report' ? '项目周报' : '项目月报';
    const title = `${project.name} · ${kindLabel}`;
    const content = this.reportContent(project, kindLabel, metrics, findings, periodStart, now);
    const id = randomUUID();
    this.db.raw.prepare(`INSERT INTO automation_reports(
      id, schedule_id, project_id, kind, title, period_start, period_end, metrics_json, findings_json, content, trigger, created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, scheduleId, projectId, kind, title, periodStart, now, JSON.stringify(metrics), JSON.stringify(findings), content, trigger, now
    );
    this.db.audit({ id: randomUUID(), actor: trigger === 'scheduled' ? 'scheduler' : 'admin', action: `automation.${kind}`, target: projectId, result: id });
    return this.reports(projectId).find((item) => item.id === id)!;
  }

  budgets(projectId?: string): ProjectBudget[] {
    const projects = this.deps.projects.list().filter((project) => !projectId || project.id === projectId);
    const rows = new Map(this.rows('SELECT * FROM project_budgets').map((row) => [this.string(row.project_id), row]));
    const usage = this.usageByProject();
    return projects.map((project) => {
      const row = rows.get(project.id);
      const current = usage.get(project.id) ?? { tokens: 0, cost: 0, runtimeMs: 0 };
      const tokenLimit = this.number(row?.token_limit);
      const costLimit = this.number(row?.cost_limit);
      const warningPercent = Math.max(50, Math.min(100, this.number(row?.warning_percent) || 80));
      const percentages = [tokenLimit > 0 ? current.tokens / tokenLimit * 100 : 0, costLimit > 0 ? current.cost / costLimit * 100 : 0];
      const usagePercent = Math.round(Math.max(...percentages));
      const status: ProjectBudget['status'] = tokenLimit <= 0 && costLimit <= 0 ? 'unset'
        : usagePercent >= 100 ? 'exceeded' : usagePercent >= warningPercent ? 'warning' : 'normal';
      return {
        projectId: project.id, projectName: project.name, tokenLimit, costLimit, warningPercent,
        spentTokens: current.tokens, spentCost: current.cost, runtimeMs: current.runtimeMs, usagePercent, status,
        updatedAt: row ? this.number(row.updated_at) : null
      };
    }).sort((a, b) => this.budgetRank(a.status) - this.budgetRank(b.status) || b.usagePercent - a.usagePercent);
  }

  setBudget(projectId: string, input: ProjectBudgetInput): ProjectBudget {
    if (!this.deps.projects.list().some((project) => project.id === projectId)) throw new Error('项目不存在');
    if (!Number.isFinite(input.tokenLimit) || input.tokenLimit < 0 || input.tokenLimit > 10_000_000_000) throw new Error('Token 预算无效');
    if (!Number.isFinite(input.costLimit) || input.costLimit < 0 || input.costLimit > 100_000_000) throw new Error('费用预算无效');
    if (!Number.isFinite(input.warningPercent) || input.warningPercent < 50 || input.warningPercent > 100) throw new Error('预警阈值需为 50-100');
    this.db.raw.prepare(`INSERT INTO project_budgets(project_id, token_limit, cost_limit, warning_percent, updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET token_limit = excluded.token_limit, cost_limit = excluded.cost_limit,
      warning_percent = excluded.warning_percent, updated_at = excluded.updated_at`)
      .run(projectId, Math.round(input.tokenLimit), input.costLimit, Math.round(input.warningPercent), Date.now());
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'automation.budget.update', target: projectId, result: 'ok' });
    return this.budgets(projectId)[0];
  }

  recommendAssignees(projectId: string, brief: string): AssigneeRecommendation[] {
    const project = this.deps.projects.list().find((item) => item.id === projectId);
    if (!project) throw new Error('项目不存在');
    const tasks = this.taskRows();
    const terms = this.bigrams(`${project.name}${project.objective}${brief}`.toLocaleLowerCase('zh-CN'));
    return this.rows('SELECT * FROM agents WHERE archived = 0')
      .filter((row) => this.string(row.lifecycle) === 'READY')
      .map((row) => {
        const agentId = this.string(row.id);
        const agentTasks = tasks.filter((task) => this.string(task.agent_id) === agentId);
        const activeTasks = agentTasks.filter((task) => ACTIVE_TASK_STATUSES.has(this.string(task.status))).length;
        const ended = agentTasks.filter((task) => END_TASK_STATUSES.has(this.string(task.status)));
        const completedTasks = ended.filter((task) => this.string(task.status) === 'COMPLETED').length;
        const projectExperience = agentTasks.filter((task) => this.string(task.project_id) === projectId && this.string(task.status) === 'COMPLETED').length;
        const successRate = ended.length ? Math.round(completedTasks / ended.length * 100) : 100;
        const profile = `${this.string(row.name)}${this.string(row.role)}${this.string(row.tags_json)}`.toLocaleLowerCase('zh-CN');
        const roleMatch = [...terms].filter((term) => profile.includes(term)).length;
        const score = Math.max(0, Math.min(100, Math.round(62 - activeTasks * 18 + projectExperience * 6 + successRate * 0.18 + Math.min(roleMatch, 6) * 3)));
        const reasons = [activeTasks === 0 ? '当前空闲' : `${activeTasks} 项活跃任务`, projectExperience > 0 ? `${projectExperience} 次项目经验` : '可补充新视角', `成功率 ${successRate}%`];
        if (roleMatch > 0) reasons.push('职责匹配');
        return { agentId, agentName: this.string(row.name), role: this.string(row.role), score, activeTasks, completedTasks, projectExperience, successRate, reason: reasons.join(' · ') };
      })
      .sort((a, b) => b.score - a.score || a.activeTasks - b.activeTasks || a.agentName.localeCompare(b.agentName, 'zh-CN'))
      .slice(0, 8);
  }

  deliveries(projectId?: string): CustomerDelivery[] {
    const projects = new Map(this.deps.projects.list().map((project) => [project.id, project.name]));
    return this.rows('SELECT * FROM customer_deliveries ORDER BY updated_at DESC')
      .filter((row) => !projectId || this.string(row.project_id) === projectId)
      .map((row) => ({
        id: this.string(row.id), projectId: this.string(row.project_id), projectName: projects.get(this.string(row.project_id)) ?? '已归档项目',
        customerName: this.string(row.customer_name), title: this.string(row.title), status: this.string(row.status) as CustomerDeliveryStatus,
        deliverableIds: this.json<string[]>(row.deliverable_ids_json, []), note: this.string(row.note),
        deliveredAt: this.nullableNumber(row.delivered_at), acceptedAt: this.nullableNumber(row.accepted_at),
        createdAt: this.number(row.created_at), updatedAt: this.number(row.updated_at)
      }));
  }

  createDelivery(input: CustomerDeliveryInput): CustomerDelivery {
    const project = this.deps.projects.list().find((item) => item.id === input.projectId);
    if (!project) throw new Error('项目不存在');
    const title = input.title.trim();
    const customerName = input.customerName.trim();
    if (title.length < 2 || title.length > 160) throw new Error('交付标题需为 2-160 字');
    if (customerName.length < 2 || customerName.length > 100) throw new Error('客户名称需为 2-100 字');
    const validIds = new Set(this.deps.deliverables.list().filter((item) => item.projectId === input.projectId && item.reviewStatus === 'accepted').map((item) => item.id));
    const deliverableIds = [...new Set(input.deliverableIds)].filter((id) => validIds.has(id));
    if (deliverableIds.length === 0) throw new Error('至少选择一项已采纳成果');
    const id = randomUUID();
    const now = Date.now();
    this.db.raw.prepare(`INSERT INTO customer_deliveries(
      id, project_id, customer_name, title, status, deliverable_ids_json, note, delivered_at, accepted_at, created_at, updated_at
    ) VALUES(?,?,?,?, 'draft', ?, ?, NULL, NULL, ?, ?)`)
      .run(id, input.projectId, customerName, title, JSON.stringify(deliverableIds), (input.note ?? '').trim(), now, now);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'delivery.create', target: id, result: 'draft' });
    return this.deliveries(input.projectId).find((item) => item.id === id)!;
  }

  updateDeliveryStatus(id: string, status: CustomerDeliveryStatus): CustomerDelivery {
    const current = this.deliveries().find((item) => item.id === id);
    if (!current) throw new Error('交付记录不存在');
    const allowed: Record<CustomerDeliveryStatus, CustomerDeliveryStatus[]> = {
      draft: ['draft', 'delivered'], delivered: ['delivered', 'accepted'], accepted: ['accepted']
    };
    if (!allowed[current.status].includes(status)) throw new Error('客户交付状态只能按草稿、已交付、客户确认顺序推进');
    const now = Date.now();
    const deliveredAt = status === 'draft' ? null : current.deliveredAt ?? now;
    const acceptedAt = status === 'accepted' ? current.acceptedAt ?? now : null;
    this.db.raw.prepare('UPDATE customer_deliveries SET status = ?, delivered_at = ?, accepted_at = ?, updated_at = ? WHERE id = ?')
      .run(status, deliveredAt, acceptedAt, now, id);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'delivery.status', target: id, result: status });
    return this.deliveries(current.projectId).find((item) => item.id === id)!;
  }

  private auditLogs(projectId?: string): AutomationAuditItem[] {
    const rows = this.rows('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100');
    return rows.filter((row) => !projectId || this.string(row.target) === projectId || this.deliveryTargetsProject(this.string(row.target), projectId))
      .map((row) => ({
        id: this.string(row.id), actor: this.string(row.actor), action: this.string(row.action), target: this.string(row.target),
        result: this.string(row.result), source: this.string(row.source), createdAt: this.number(row.created_at)
      }));
  }

  private deliveryTargetsProject(target: string, projectId: string): boolean {
    return this.rows('SELECT * FROM customer_deliveries ORDER BY updated_at DESC')
      .some((row) => this.string(row.id) === target && this.string(row.project_id) === projectId);
  }

  private metrics(projectId: string, from: number, to: number): AutomationReportMetrics {
    const tasks = this.taskRows().filter((row) => this.string(row.project_id) === projectId && this.number(row.created_at) >= from && this.number(row.created_at) <= to);
    const deliveries = this.deps.deliverables.list().filter((item) => item.projectId === projectId && item.updatedAt >= from && item.updatedAt <= to);
    const usage = this.usageByProject(from, to).get(projectId) ?? { tokens: 0, cost: 0, runtimeMs: 0 };
    return {
      taskTotal: tasks.length, taskCompleted: tasks.filter((row) => this.string(row.status) === 'COMPLETED').length,
      deliverableTotal: deliveries.length, acceptedDeliverables: deliveries.filter((item) => item.reviewStatus === 'accepted').length,
      totalTokens: usage.tokens, estimatedCost: usage.cost, runtimeMs: usage.runtimeMs
    };
  }

  private reportContent(project: Project, kindLabel: string, metrics: AutomationReportMetrics, findings: AutomationFinding[], from: number, to: number): string {
    const findingLines = findings.length ? findings.map((item) => `- **${item.title}**：${item.detail}`).join('\n') : '- 当前未发现需要人工介入的经营异常。';
    return `# ${project.name} · ${kindLabel}\n\n` +
      `> 统计周期：${new Date(from).toLocaleDateString('zh-CN')} - ${new Date(to).toLocaleDateString('zh-CN')}\n\n` +
      `## 项目目标\n\n${project.objective || '未设置项目目标'}\n\n` +
      `## 经营摘要\n\n- 任务完成：${metrics.taskCompleted}/${metrics.taskTotal}\n- 成果验收：${metrics.acceptedDeliverables}/${metrics.deliverableTotal}\n` +
      `- Token 消耗：${metrics.totalTokens.toLocaleString('zh-CN')}\n- 估算费用：¥${metrics.estimatedCost.toFixed(2)}\n- 运行时长：${this.duration(metrics.runtimeMs)}\n\n` +
      `## 风险与异常\n\n${findingLines}\n\n## 下一步\n\n${findings.length ? '优先处理高风险事项，明确责任人和完成时限。' : '按当前计划继续推进，并在下一周期复核成果质量与预算使用。'}`;
  }

  private usageByProject(from = Number.NEGATIVE_INFINITY, to = Number.POSITIVE_INFINITY): Map<string, { tokens: number; cost: number; runtimeMs: number }> {
    const tasks = this.taskRows();
    const projectByTask = new Map(tasks.map((row) => [this.string(row.id), this.string(row.project_id)]));
    const result = new Map<string, { tokens: number; cost: number; runtimeMs: number }>();
    for (const task of tasks) {
      const projectId = this.string(task.project_id);
      if (!projectId) continue;
      const current = result.get(projectId) ?? { tokens: 0, cost: 0, runtimeMs: 0 };
      const startedAt = this.number(task.started_at); const endedAt = this.number(task.ended_at);
      if (startedAt && endedAt > startedAt && endedAt >= from && startedAt <= to) {
        current.runtimeMs += Math.max(0, Math.min(endedAt, to) - Math.max(startedAt, from));
      }
      result.set(projectId, current);
    }
    for (const row of this.rows('SELECT * FROM usage_records ORDER BY created_at DESC')) {
      const createdAt = this.number(row.created_at);
      if (createdAt < from || createdAt > to) continue;
      const projectId = projectByTask.get(this.string(row.task_id));
      if (!projectId) continue;
      const current = result.get(projectId) ?? { tokens: 0, cost: 0, runtimeMs: 0 };
      const tokens = this.number(row.total_tokens);
      current.tokens += tokens;
      current.cost += tokens / 1_000_000 * (MODEL_PRICING[this.string(row.model)] ?? DEFAULT_PRICE);
      result.set(projectId, current);
    }
    return result;
  }

  private taskRows(): Row[] {
    return this.rows('SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY created_at DESC');
  }

  private rows(sql: string): Row[] {
    return this.db.raw.prepare(sql).all() as unknown as Row[];
  }

  private normalizeTitle(value: string): string {
    return value.replace(/^重新执行[：:]\s*/, '').toLocaleLowerCase('zh-CN').replace(/\d+/g, '#').replace(/[^\p{L}\p{N}#]+/gu, '');
  }

  private bigrams(value: string): Set<string> {
    const normalized = value.replace(/\s+/g, '');
    const result = new Set<string>();
    for (let index = 0; index < normalized.length - 1; index++) result.add(normalized.slice(index, index + 2));
    return result;
  }

  private duration(milliseconds: number): string {
    if (milliseconds <= 0) return '0 分钟';
    const hours = Math.floor(milliseconds / 3_600_000);
    const minutes = Math.floor(milliseconds % 3_600_000 / 60_000);
    return hours > 0 ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
  }

  private budgetRank(value: ProjectBudget['status']): number {
    return value === 'exceeded' ? 0 : value === 'warning' ? 1 : value === 'normal' ? 2 : 3;
  }

  private emptyMetrics(): AutomationReportMetrics {
    return { taskTotal: 0, taskCompleted: 0, deliverableTotal: 0, acceptedDeliverables: 0, totalTokens: 0, estimatedCost: 0, runtimeMs: 0 };
  }

  private json<T>(value: unknown, fallback: T): T {
    try { return JSON.parse(this.string(value)) as T; } catch { return fallback; }
  }

  private string(value: unknown): string {
    return value === null || value === undefined ? '' : String(value);
  }

  private nullable(value: unknown): string | null {
    const normalized = this.string(value); return normalized || null;
  }

  private number(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0;
  }

  private nullableNumber(value: unknown): number | null {
    return value === null || value === undefined ? null : this.number(value);
  }
}
