import { describe, expect, it } from 'vitest';
import type { Database } from '../src/main/services/database.js';
import { AutomationManager } from '../src/main/services/automationManager.js';
import { ProjectManager } from '../src/main/services/projectManager.js';
import type { DeliverableSummary } from '../src/shared/types.js';
import { createMockDb, seedAgent, seedProject } from './helpers/mockDb.js';

function deliverable(projectId: string, id: string, reviewStatus: DeliverableSummary['reviewStatus']): DeliverableSummary {
  const now = Date.now();
  return {
    id, sourceType: 'task', sourceId: `task-${id}`, projectId, projectName: '经营项目', ownerType: 'agent', ownerId: 'agent-owner',
    ownerName: '交付员工', ownerRole: '交付负责人', title: `成果 ${id}`, type: 'report', tags: [], reviewStatus, reviewNote: '',
    latestVersion: 1, versionCount: 1, preview: '成果正文', createdAt: now - 10_000, updatedAt: now - 5_000, sourceUpdatedAt: now - 5_000
  };
}

function task(db: ReturnType<typeof createMockDb>, input: { id: string; projectId: string; agentId: string; title: string; status?: string; quality?: string | null; createdAt?: number }) {
  const now = Date.now();
  db.tables.tasks.set(input.id, {
    id: input.id, project_id: input.projectId, agent_id: input.agentId, title: input.title, status: input.status ?? 'COMPLETED',
    quality: input.quality ?? null, created_at: input.createdAt ?? now - 20_000, started_at: now - 15_000, ended_at: now - 10_000,
    deleted_at: null, result: '完成', source: 'desktop', progress: 100
  });
}

function fixture(deliverables: DeliverableSummary[] = []) {
  const db = createMockDb();
  const projectId = seedProject(db, { name: '经营项目', objective: '完成客户交付', due_at: Date.now() + 86_400_000 });
  const projects = new ProjectManager(db as unknown as Database);
  const manager = new AutomationManager(db as unknown as Database, { projects, deliverables: { list: () => deliverables } });
  return { db, projectId, projects, manager };
}

describe('AutomationManager 经营自动化领域服务', () => {
  it('发现逾期、低质量与重复工作并按风险排序', () => {
    const db = createMockDb();
    const projectId = seedProject(db, { name: '风险项目', due_at: Date.now() - 2 * 86_400_000, status: 'active' });
    const agentId = seedAgent(db);
    task(db, { id: 'task-1', projectId, agentId, title: '整理客户访谈' });
    task(db, { id: 'task-2', projectId, agentId, title: '重新执行：整理客户访谈', quality: 'rework' });
    const projects = new ProjectManager(db as unknown as Database);
    const manager = new AutomationManager(db as unknown as Database, { projects, deliverables: { list: () => [deliverable(projectId, 'd-rejected', 'rejected')] } });

    const findings = manager.findings(projectId);
    expect(findings.map((item) => item.kind)).toEqual(expect.arrayContaining(['overdue', 'low_quality', 'duplicate_work']));
    expect(findings[0].severity).toBe('high');
    expect(findings.find((item) => item.kind === 'duplicate_work')?.count).toBe(1);
  });

  it('计算预算预警与超额状态', () => {
    const { db, projectId, manager } = fixture();
    const agentId = seedAgent(db);
    task(db, { id: 'task-budget', projectId, agentId, title: '预算任务' });
    db.tables.usage_records.set('usage-1', { id: 'usage-1', task_id: 'task-budget', model: 'llama3.1', total_tokens: 85, created_at: Date.now() });
    manager.setBudget(projectId, { tokenLimit: 100, costLimit: 0, warningPercent: 80 });
    expect(manager.budgets(projectId)[0]).toMatchObject({ spentTokens: 85, usagePercent: 85, status: 'warning' });

    db.tables.usage_records.set('usage-2', { id: 'usage-2', task_id: 'task-budget', model: 'llama3.1', total_tokens: 20, created_at: Date.now() });
    expect(manager.budgets(projectId)[0]).toMatchObject({ spentTokens: 105, usagePercent: 105, status: 'exceeded' });
    expect(manager.findings(projectId).some((item) => item.kind === 'budget' && item.severity === 'high')).toBe(true);
  });

  it('结合负载、项目经验和角色匹配排序执行人', () => {
    const { db, projectId, manager } = fixture();
    const experienced = seedAgent(db, { name: '客户研究员', role: '负责客户访谈与研究' });
    const busy = seedAgent(db, { name: '通用执行员', role: '处理日常任务' });
    task(db, { id: 'exp-1', projectId, agentId: experienced, title: '客户访谈复盘' });
    task(db, { id: 'exp-2', projectId, agentId: experienced, title: '需求研究' });
    task(db, { id: 'busy-1', projectId, agentId: busy, title: '进行中 A', status: 'RUNNING' });
    task(db, { id: 'busy-2', projectId, agentId: busy, title: '进行中 B', status: 'QUEUED' });

    const recommendations = manager.recommendAssignees(projectId, '完成客户访谈和需求研究');
    expect(recommendations[0]).toMatchObject({ agentId: experienced, activeTasks: 0, projectExperience: 2 });
    expect(recommendations.find((item) => item.agentId === busy)?.activeTasks).toBe(2);
    expect(recommendations[0].score).toBeGreaterThan(recommendations.find((item) => item.agentId === busy)!.score);
  });

  it('生成并持久化巡检与周期报告，统计周期内用量', () => {
    const { db, projectId, manager } = fixture();
    const agentId = seedAgent(db);
    task(db, { id: 'task-report', projectId, agentId, title: '完成周报数据' });
    db.tables.usage_records.set('usage-report', { id: 'usage-report', task_id: 'task-report', model: 'deepseek-chat', total_tokens: 2_000, created_at: Date.now() });

    const report = manager.run('weekly_report', projectId, 'scheduled', 'schedule-weekly');
    expect(report).toMatchObject({ projectId, kind: 'weekly_report', trigger: 'scheduled', scheduleId: 'schedule-weekly' });
    expect(report.metrics).toMatchObject({ taskTotal: 1, taskCompleted: 1, totalTokens: 2_000 });
    expect(report.content).toContain('经营摘要');
    expect(db.tables.automation_reports.has(report.id)).toBe(true);
    expect(db.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'automation.weekly_report', target: projectId, result: report.id }));
  });

  it('客户交付仅允许已采纳成果并按状态顺序推进', () => {
    const db = createMockDb();
    const projectId = seedProject(db, { name: '客户项目' });
    const accepted = deliverable(projectId, 'accepted-result', 'accepted');
    const rejected = deliverable(projectId, 'rejected-result', 'rejected');
    const projects = new ProjectManager(db as unknown as Database);
    const manager = new AutomationManager(db as unknown as Database, { projects, deliverables: { list: () => [accepted, rejected] } });

    expect(() => manager.createDelivery({ projectId, customerName: '客户 A', title: '首轮交付', deliverableIds: [rejected.id] })).toThrow('已采纳成果');
    const created = manager.createDelivery({ projectId, customerName: '客户 A', title: '首轮交付', deliverableIds: [accepted.id, rejected.id], note: '请确认' });
    expect(created).toMatchObject({ status: 'draft', deliverableIds: [accepted.id] });
    expect(() => manager.updateDeliveryStatus(created.id, 'accepted')).toThrow('顺序推进');
    expect(manager.updateDeliveryStatus(created.id, 'delivered').deliveredAt).toEqual(expect.any(Number));
    expect(manager.updateDeliveryStatus(created.id, 'accepted')).toMatchObject({ status: 'accepted', acceptedAt: expect.any(Number) });
    expect(() => manager.updateDeliveryStatus(created.id, 'draft')).toThrow('顺序推进');
  });
});
