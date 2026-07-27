import { describe, expect, it } from 'vitest';
import type { Database } from '../src/main/services/database.js';
import { DiscoveryManager } from '../src/main/services/discoveryManager.js';
import type {
  DeliverableSummary, KnowledgeSummary, ProjectOperationsOverview, TeamRun
} from '../src/shared/types.js';
import { createMockDb, seedAgent, seedProject, seedTeam } from './helpers/mockDb.js';

function createFixture() {
  const db = createMockDb();
  const now = Date.now();
  const projectId = seedProject(db, { id: 'project-growth', name: '客户增长计划', objective: '验证重点客户渠道', updated_at: now });
  const agentId = seedAgent(db, { id: 'agent-research', name: '客户研究员', role: '负责客户研究', tags_json: '["研究"]', updated_at: now });
  db.tables.tasks.set('task-interview', {
    id: 'task-interview', project_id: projectId, agent_id: agentId, title: '客户访谈分析', status: 'COMPLETED',
    result: '整理十位客户访谈结论', error: null, created_at: now - 4_000, ended_at: now - 3_000
  });
  seedTeam(db, { id: 'team-advisory', name: '增长专家团', mode: 'roundtable', created_at: now - 2_000 });
  db.tables.deliverables.set('deliverable-report', {
    id: 'deliverable-report', project_id: projectId, owner_name: '客户研究员', title: '客户访谈报告',
    review_status: 'accepted', tags_json: '["客户"]', updated_at: now - 1_000
  });

  const knowledge: KnowledgeSummary = {
    id: 'knowledge-playbook', projectId, projectName: '客户增长计划', sourceType: 'manual', sourceId: null,
    title: '客户访谈执行手册', category: 'playbook', tags: ['客户', '访谈'], status: 'active', pinned: true,
    latestVersion: 1, versionCount: 1, preview: '访谈前确认客户分层与问题清单', usageCount: 0, lastUsedAt: null,
    createdAt: now - 2_000, updatedAt: now
  };
  let deliverables: DeliverableSummary[] = [];
  let teamRuns: Array<TeamRun & { teamName: string }> = [];
  let operations: ProjectOperationsOverview = {
    generatedAt: now,
    summary: { totalProjects: 1, openProjects: 1, completedProjects: 0, atRiskProjects: 0, overdueProjects: 0, totalTasks: 1, completedTasks: 1, activeTasks: 0, failedTasks: 0, taskCompletionRate: 100, totalDeliverables: 0, acceptedDeliverables: 0, pendingAcceptance: 0 },
    statusDistribution: { planning: 0, active: 1, paused: 0, completed: 0, archived: 0 },
    projects: [], risks: []
  };
  const manager = new DiscoveryManager(db as unknown as Database, {
    projects: { operations: () => operations },
    deliverables: { list: () => deliverables },
    knowledge: { list: () => [knowledge] },
    teams: { listAttentionRuns: () => teamRuns }
  });
  return {
    db, manager, projectId, agentId,
    setDeliverables: (value: DeliverableSummary[]) => { deliverables = value; },
    setTeamRuns: (value: Array<TeamRun & { teamName: string }>) => { teamRuns = value; },
    setOperations: (value: ProjectOperationsOverview) => { operations = value; }
  };
}

describe('DiscoveryManager 统一检索与行动中心', () => {
  it('检索项目、员工、任务、专家团、成果和知识并返回精准路由', () => {
    const { manager } = createFixture();
    const all = manager.search('');
    expect(new Set(all.map((item) => item.entityType))).toEqual(new Set(['project', 'agent', 'task', 'team', 'deliverable', 'knowledge']));

    const exact = manager.search('客户访谈执行手册');
    expect(exact[0]).toMatchObject({ entityType: 'knowledge', entityId: 'knowledge-playbook', route: 'knowledge' });
    expect(manager.search('增长 专家团')[0]).toMatchObject({ entityType: 'team', entityId: 'team-advisory', route: 'teams' });
  });

  it('标题精确命中优先于正文和附属信息命中', () => {
    const { manager } = createFixture();
    const results = manager.search('客户访谈报告');
    expect(results[0]).toMatchObject({ entityType: 'deliverable', entityId: 'deliverable-report' });
  });

  it('聚合五类行动并按风险优先排序', () => {
    const fixture = createFixture();
    const now = Date.now();
    fixture.db.tables.approvals.set('approval-network', {
      id: 'approval-network', task_id: 'task-interview', agent_id: fixture.agentId, request: '访问客户系统', risk: 'high', status: 'pending', created_at: now
    });
    fixture.db.tables.tasks.set('task-failed', {
      id: 'task-failed', project_id: fixture.projectId, agent_id: fixture.agentId, title: '生成投放方案', status: 'FAILED', error: '模型超时', created_at: now - 2_000, ended_at: now - 1_000
    });
    fixture.setDeliverables([{
      id: 'deliverable-pending', sourceType: 'task', sourceId: 'task-interview', projectId: fixture.projectId, projectName: '客户增长计划',
      ownerType: 'agent', ownerId: fixture.agentId, ownerName: '客户研究员', ownerRole: '负责客户研究', title: '渠道研究报告',
      type: 'report', tags: [], reviewStatus: 'unmarked', reviewNote: '', latestVersion: 1, versionCount: 1, preview: '报告正文',
      createdAt: now - 3_000, updatedAt: now - 2_000, sourceUpdatedAt: now - 2_000
    }]);
    fixture.setTeamRuns([{
      id: 'run-failed', teamId: 'team-advisory', projectId: fixture.projectId, taskText: '评审增长策略', phase: 'failed', currentStep: 2,
      totalSteps: 3, subtasks: [], events: [], finalResult: null, error: '专家任务失败', createdAt: now - 5_000, endedAt: now - 4_000,
      teamName: '增长专家团'
    }]);
    fixture.setOperations({
      generatedAt: now,
      summary: { totalProjects: 1, openProjects: 1, completedProjects: 0, atRiskProjects: 1, overdueProjects: 0, totalTasks: 2, completedTasks: 1, activeTasks: 0, failedTasks: 1, taskCompletionRate: 50, totalDeliverables: 1, acceptedDeliverables: 0, pendingAcceptance: 1 },
      statusDistribution: { planning: 0, active: 1, paused: 0, completed: 0, archived: 0 }, projects: [],
      risks: [{ id: 'risk-empty', projectId: fixture.projectId, projectName: '客户增长计划', kind: 'empty_plan', severity: 'medium', title: '缺少下一步计划', detail: '当前没有活跃任务', count: 1 }]
    });

    const overview = fixture.manager.actions();
    expect(overview.counts).toEqual({ approval: 1, failed_task: 1, team_run: 1, deliverable: 1, project_risk: 1 });
    expect(overview.total).toBe(5);
    expect(overview.items[0].severity).toBe('danger');
  });

  it('忽略相同指纹，来源状态变化后重新出现', () => {
    const { db, manager, projectId, agentId } = createFixture();
    db.tables.tasks.set('task-failed', {
      id: 'task-failed', project_id: projectId, agent_id: agentId, title: '生成周报', status: 'FAILED', error: '第一次超时', created_at: 100, ended_at: 200
    });
    const item = manager.actions().items.find((candidate) => candidate.key === 'failed_task:task-failed')!;
    manager.dismiss(item.key, item.fingerprint);
    expect(manager.actions().items.some((candidate) => candidate.key === item.key)).toBe(false);

    db.tables.tasks.get('task-failed')!.error = '重试后权限不足';
    expect(manager.actions().items.some((candidate) => candidate.key === item.key)).toBe(true);
    expect(db.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'action.dismiss', target: item.key }));
  });
});
