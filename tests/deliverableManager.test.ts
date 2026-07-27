import { describe, expect, it } from 'vitest';
import type { Database } from '../src/main/services/database.js';
import { DeliverableManager } from '../src/main/services/deliverableManager.js';
import { createMockDb, seedAgent, seedProject, seedTeam, seedTeamRun } from './helpers/mockDb.js';

function seedCompletedTask(
  db: ReturnType<typeof createMockDb>,
  agentId: string,
  projectId: string | null,
  overrides: Partial<Record<string, unknown>> = {}
) {
  const id = (overrides.id as string) ?? 'task-deliverable';
  const now = Date.now() - 10_000;
  db.tables.tasks.set(id, {
    id, agent_id: agentId, project_id: projectId, title: '客户研究报告', source: 'manual', parent_id: null,
    status: 'COMPLETED', priority: 0, progress: 100, stage: '完成', error: null, session_id: null,
    workspace_override: null, created_at: now - 1_000, started_at: now - 500, ended_at: now,
    result: '# 调研结论\n\n首批客户更关注交付速度。', quality: null,
    ...overrides
  });
  return id;
}

function createFixture() {
  const db = createMockDb();
  const projectId = seedProject(db, { name: '新品验证项目', status: 'completed' });
  const agentId = seedAgent(db, { name: '市场研究员', role: '负责客户与市场研究' });
  const taskId = seedCompletedTask(db, agentId, projectId);
  const manager = new DeliverableManager(db as unknown as Database);
  return { db, manager, projectId, agentId, taskId };
}

describe('DeliverableManager 成果验收领域服务', () => {
  it('同步已完成任务与专家团终稿，并保留项目、来源和负责人追溯', () => {
    const { db, manager, projectId, agentId, taskId } = createFixture();
    const teamId = seedTeam(db, { id: 'team-expert', name: '增长专家团' });
    const runId = seedTeamRun(db, {
      team_id: teamId, project_id: projectId, phase: 'done',
      task_text: '制定增长方案', final_result: '## 增长方案\n\n先完成渠道验证。', ended_at: Date.now()
    });

    const list = manager.list();
    expect(list).toHaveLength(2);
    expect(list.find(item => item.sourceId === taskId)).toMatchObject({
      ownerType: 'agent', ownerId: agentId, ownerName: '市场研究员', projectName: '新品验证项目', latestVersion: 1
    });
    expect(list.find(item => item.sourceId === runId)).toMatchObject({
      ownerType: 'team', ownerId: teamId, ownerName: '增长专家团', latestVersion: 1
    });

    const detail = manager.get(list.find(item => item.sourceId === taskId)!.id)!;
    expect(detail.trace.project).toMatchObject({ id: projectId, status: 'completed' });
    expect(detail.trace.source).toMatchObject({ type: 'task', id: taskId, status: 'COMPLETED' });
    expect(detail.trace.owner).toMatchObject({ type: 'agent', id: agentId, name: '市场研究员' });
  });

  it('来源正文变化时创建下一版本，并重置既有验收状态和任务质量', () => {
    const { db, manager, taskId } = createFixture();
    const first = manager.list()[0];
    manager.review(first.id, { status: 'accepted', note: '符合验收标准' });
    expect(db.tables.tasks.get(taskId)?.quality).toBe('accepted');

    const task = db.tables.tasks.get(taskId)!;
    task.result = '# 调研结论 v2\n\n补充了客户访谈证据。';
    task.ended_at = Date.now();

    const updated = manager.get(first.id)!;
    expect(updated.latestVersion).toBe(2);
    expect(updated.versionCount).toBe(2);
    expect(updated.latestContent).toContain('访谈证据');
    expect(updated.reviewStatus).toBe('unmarked');
    expect(updated.reviewNote).toBe('');
    expect(updated.reviews[0]).toMatchObject({ status: 'unmarked', reviewer: 'system' });
    expect(updated.reviews[0].note).toContain('v2');
    expect(db.tables.tasks.get(taskId)?.quality).toBeNull();
    expect(manager.list()[0].versionCount).toBe(2);
  });

  it('支持采纳、驳回和返工说明校验，并将任务质量保持兼容', () => {
    const { db, manager, taskId } = createFixture();
    const deliverable = manager.list()[0];

    expect(() => manager.review(deliverable.id, { status: 'rejected', note: '' })).toThrow('验收说明');
    expect(() => manager.review(deliverable.id, { status: 'rework', note: ' ' })).toThrow('验收说明');

    expect(manager.review(deliverable.id, { status: 'accepted', note: '' })?.review.status).toBe('accepted');
    expect(db.tables.tasks.get(taskId)?.quality).toBe('accepted');
    expect(manager.review(deliverable.id, { status: 'rejected', note: '缺少数据来源' })?.review.note).toBe('缺少数据来源');
    expect(db.tables.tasks.get(taskId)?.quality).toBe('rejected');
    expect(manager.review(deliverable.id, { status: 'rework', note: '补充访谈样本' }, 'task-rework')?.review.reworkRef).toBe('task-rework');
    expect(db.tables.tasks.get(taskId)?.quality).toBe('rework');
  });

  it('人工新增版本后重新进入验收，并记录版本说明', () => {
    const { db, manager, taskId } = createFixture();
    const deliverable = manager.list()[0];
    manager.review(deliverable.id, { status: 'accepted', note: '通过' });

    const updated = manager.addVersion(deliverable.id, {
      content: '# 调研结论 v2\n\n人工补充竞品对照。', changeNote: '补充竞品对照', origin: 'manual'
    })!;
    expect(updated.latestVersion).toBe(2);
    expect(updated.versions[0]).toMatchObject({ origin: 'manual', changeNote: '补充竞品对照' });
    expect(updated.reviewStatus).toBe('unmarked');
    expect(updated.reviews[0]).toMatchObject({ status: 'unmarked', reviewer: 'admin' });
    expect(db.tables.tasks.get(taskId)?.quality).toBeNull();
  });

  it('更新类型和去重标签，并拒绝非法元数据', () => {
    const { manager } = createFixture();
    const deliverable = manager.list()[0];

    const updated = manager.updateMeta(deliverable.id, { type: 'report', tags: ['客户', ' 重点 ', '客户'] })!;
    expect(updated.type).toBe('report');
    expect(updated.tags).toEqual(['客户', '重点']);
    expect(() => manager.updateMeta(deliverable.id, { type: 'invalid' as never })).toThrow('成果类型无效');
    expect(() => manager.updateMeta(deliverable.id, { tags: Array.from({ length: 11 }, (_, index) => `标签${index}`) })).toThrow('最多 10 个');
  });

  it('为项目生成结构化、可审阅且可导出的成果包内容', () => {
    const { manager, projectId } = createFixture();
    const deliverable = manager.list()[0];
    manager.review(deliverable.id, { status: 'accepted', note: '可进入交付包' });

    const pkg = manager.packageForProject(projectId);
    expect(pkg.project).toMatchObject({ id: projectId, name: '新品验证项目', status: 'completed' });
    expect(pkg.summary).toEqual({ total: 1, accepted: 1, rejected: 0, rework: 0, unmarked: 0 });
    expect(pkg.deliverables[0].latestContent).toContain('首批客户');
    expect(manager.renderPackageReadme(pkg)).toContain('项目成果包');
    expect(manager.renderPackageReadme(pkg)).toContain('已采纳：1');
    expect(manager.renderMarkdown(manager.get(deliverable.id)!)).toContain('验收状态：已采纳');
  });
});
