import { describe, expect, it } from 'vitest';
import type { Database } from '../src/main/services/database.js';
import { ProjectManager } from '../src/main/services/projectManager.js';
import type { DeliverableSummary } from '../src/shared/types.js';
import { createMockDb, seedAgent, seedProject } from './helpers/mockDb.js';

function seedProjectTask(
  db: ReturnType<typeof createMockDb>,
  projectId: string,
  agentId: string,
  id: string,
  status: string,
  progress: number
) {
  const now = Date.now();
  db.tables.tasks.set(id, {
    id, project_id: projectId, agent_id: agentId, title: `项目任务 ${id}`, source: 'desktop', parent_id: null,
    status, priority: 0, progress, stage: status, error: status === 'FAILED' ? '执行失败' : null,
    result: status === 'COMPLETED' ? '项目成果' : null, quality: null, session_id: null, workspace_override: null,
    created_at: now - 20_000, started_at: now - 10_000, ended_at: ['COMPLETED', 'FAILED'].includes(status) ? now : null
  });
}

function deliverable(projectId: string, status: DeliverableSummary['reviewStatus']): DeliverableSummary {
  return {
    id: `deliverable-${status}`, sourceType: 'task', sourceId: `task-${status}`, projectId, projectName: '运营项目',
    ownerType: 'agent', ownerId: 'agent-ops', ownerName: '运营员工', ownerRole: '项目执行', title: `${status} 成果`,
    type: 'report', tags: [], reviewStatus: status, reviewNote: '', latestVersion: 1, versionCount: 1,
    preview: '成果正文', createdAt: Date.now() - 10_000, updatedAt: Date.now(), sourceUpdatedAt: Date.now()
  };
}

describe('ProjectManager 项目领域服务', () => {
  it('创建、更新和归档项目时保留完整经营信息', () => {
    const db = createMockDb();
    const manager = new ProjectManager(db as unknown as Database);
    const dueAt = Date.now() + 86_400_000;

    const project = manager.create({
      name: '新品发布', objective: '完成首批客户验证', description: '覆盖发布前准备',
      clientName: '内部业务方', color: '#22C1A3', dueAt
    });

    expect(project.name).toBe('新品发布');
    expect(project.color).toBe('#22c1a3');
    expect(project.status).toBe('active');
    expect(manager.list()).toHaveLength(1);

    const updated = manager.update(project.id, { status: 'completed', objective: '已完成首批验证' });
    expect(updated?.status).toBe('completed');
    expect(updated?.objective).toBe('已完成首批验证');

    expect(manager.archive(project.id)?.status).toBe('archived');
  });

  it('拒绝过短项目名称和非法截止时间', () => {
    const db = createMockDb();
    const manager = new ProjectManager(db as unknown as Database);

    expect(() => manager.create({ name: 'A' })).toThrow('项目名称');
    expect(() => manager.create({ name: '合法项目', dueAt: -1 })).toThrow('截止时间');
  });

  it('聚合项目进度、验收率、员工负载和高风险事项', () => {
    const db = createMockDb();
    const projectId = seedProject(db, { name: '运营项目', due_at: Date.now() - 86_400_000 });
    const agentId = seedAgent(db, { name: '运营员工', role: '负责项目执行' });
    seedProjectTask(db, projectId, agentId, 'task-completed', 'COMPLETED', 100);
    seedProjectTask(db, projectId, agentId, 'task-failed', 'FAILED', 40);
    seedProjectTask(db, projectId, agentId, 'task-running', 'RUNNING', 50);
    const manager = new ProjectManager(db as unknown as Database);

    const overview = manager.operations([deliverable(projectId, 'accepted'), deliverable(projectId, 'rejected')]);
    const item = overview.projects[0];
    expect(item.health).toBe('at_risk');
    expect(item.progress).toBe(63);
    expect(item.acceptanceRate).toBe(50);
    expect(item.tasks).toMatchObject({ total: 3, completed: 1, active: 1, failed: 1 });
    expect(item.deliverables).toMatchObject({ total: 2, accepted: 1, rejected: 1 });
    expect(item.owners[0]).toMatchObject({ name: '运营员工', totalTasks: 3, completedTasks: 1, activeTasks: 1, failedTasks: 1 });
    expect(item.risks.map((risk) => risk.kind)).toEqual(expect.arrayContaining(['overdue', 'failed_task', 'rejected_deliverable']));
    expect(overview.summary).toMatchObject({ totalProjects: 1, openProjects: 1, atRiskProjects: 1, overdueProjects: 1, taskCompletionRate: 33 });
  });

  it('识别空计划和已完成项目的待验收风险', () => {
    const db = createMockDb();
    const activeId = seedProject(db, { name: '空计划项目', status: 'active' });
    const completedId = seedProject(db, { name: '待验收项目', status: 'completed' });
    const agentId = seedAgent(db);
    seedProjectTask(db, completedId, agentId, 'task-done', 'COMPLETED', 100);
    const manager = new ProjectManager(db as unknown as Database);

    const overview = manager.operations([deliverable(completedId, 'unmarked')]);
    expect(overview.projects.find((item) => item.project.id === activeId)?.risks[0].kind).toBe('empty_plan');
    const completed = overview.projects.find((item) => item.project.id === completedId)!;
    expect(completed.health).toBe('attention');
    expect(completed.risks[0].kind).toBe('pending_acceptance');
    expect(overview.summary.pendingAcceptance).toBe(1);
  });
});
