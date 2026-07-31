/**
 * TeamEngine 专家团引擎核心测试
 * 覆盖：主Agent决策解析、任务拆解解析、轮次报告格式化、执行干预控制流（取消/跳过/强制重试/注入指导）
 */
// @ts-nocheck
/* eslint-disable */
import { createMockDb, seedProject, seedTeamRun, seedTeam } from './helpers/mockDb.js';

// Mock electron（teamEngine 顶部 import app，测试路径虽不调用，显式 mock 以防意外）
vi.mock('electron', () => ({
  app: { getPath: (name: string) => `/tmp/test-${name}`, getVersion: () => '1.0.0' }
}));

// Mock node:fs（避免续跑测试产生真实文件读写副作用）
vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  readFileSync: vi.fn().mockReturnValue('')
}));

import { TeamEngine } from '../src/main/services/teamEngine.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 最小化 Orchestrator mock：控制流仅用到 cancelTask */
function createMockOrchestrator() {
  return {
    cancelTask: vi.fn(),
    listAgents: vi.fn().mockReturnValue([]),
    createTask: vi.fn(),
    waitForTask: vi.fn(),
    taskResult: vi.fn()
  };
}

/**  fake 成员（含 parseDecision/parseDecomposition 所需的 id/name/role） */
const members = [
  { id: 'a1', name: '架构师', role: '世界观构建' },
  { id: 'a2', name: '设计师', role: '角色设计' },
  { id: 'a3', name: '写手', role: '章节撰写' }
];

describe('TeamEngine 纯函数', () => {
  let db: ReturnType<typeof createMockDb>;
  let engine: TeamEngine;

  beforeEach(() => {
    db = createMockDb();
    engine = new TeamEngine(db as never, createMockOrchestrator() as never);
  });

  describe('parseDecision（主Agent决策解析）', () => {
    it('解析 finish 决策（含前后缀文字）', () => {
      const d = engine.parseDecision('分析完毕 {"action":"finish","conclusion":"最终结论"} 结束', members, [], 1);
      expect(d).toEqual({ action: 'finish', conclusion: '最终结论', newTasks: [] });
    });

    it('解析 continue 决策并按成员名映射 agentId', () => {
      const d = engine.parseDecision('{"action":"continue","newTasks":[{"agent":"写手","subtask":"重试章节撰写"}]}', members, [], 1);
      expect(d?.action).toBe('continue');
      expect(d?.newTasks).toHaveLength(1);
      expect(d?.newTasks[0].agentId).toBe('a3');
      expect(d?.newTasks[0].status).toBe('pending');
    });

    it('未知成员名回退到轮询分配', () => {
      const d = engine.parseDecision('{"action":"continue","newTasks":[{"agent":"不存在","subtask":"任务X"}]}', members, [], 1);
      expect(d?.newTasks[0].agentId).toBe('a1');
    });

    it('continue 决策识别对已失败子任务的重试（原地标回 pending，不新增）', () => {
      const subtasks = [{ agent: '写手', agentId: 'a3', subtask: '撰写章节', taskId: null, status: 'failed', retryCount: 0 }];
      const d = engine.parseDecision('{"action":"continue","newTasks":[{"agent":"写手","subtask":"重试：撰写章节"}]}', members, subtasks, 1);
      expect(d?.newTasks).toHaveLength(0);
      expect(subtasks[0].status).toBe('pending');
      expect(subtasks[0].retryCount).toBe(1);
    });

    it('超过最大重试次数的失败任务作为新任务而非原地重试', () => {
      const subtasks = [{ agent: '写手', agentId: 'a3', subtask: '撰写章节', taskId: null, status: 'failed', retryCount: 2 }];
      const d = engine.parseDecision('{"action":"continue","newTasks":[{"agent":"写手","subtask":"重试：撰写章节"}]}', members, subtasks, 1);
      expect(d?.newTasks).toHaveLength(1);
      expect(subtasks[0].status).toBe('failed'); // 原任务未被改动
    });

    it('畸形 JSON 返回 null', () => {
      expect(engine.parseDecision('{invalid json', members, [], 1)).toBeNull();
    });

    it('无 JSON 对象返回 null', () => {
      expect(engine.parseDecision('完全没有JSON内容', members, [], 1)).toBeNull();
    });
  });

  describe('parseDecomposition（任务拆解解析）', () => {
    it('解析有效 JSON 数组并映射成员', () => {
      const result = '拆解：[{"agent":"架构师","subtask":"构建世界观"},{"agent":"设计师","subtask":"设计角色"}]';
      const subtasks = engine.parseDecomposition(result, members);
      expect(subtasks).toHaveLength(2);
      expect(subtasks[0].agentId).toBe('a1');
      expect(subtasks[0].subtask).toBe('构建世界观');
      expect(subtasks[0].status).toBe('pending');
      expect(subtasks[1].agentId).toBe('a2');
    });

    it('未知成员名回退到轮询分配', () => {
      const subtasks = engine.parseDecomposition('[{"agent":"未知","subtask":"A"},{"agent":"也未知","subtask":"B"}]', members);
      expect(subtasks[0].agentId).toBe('a1');
      expect(subtasks[1].agentId).toBe('a2');
    });

    it('缺少 subtask 字段的项被跳过', () => {
      const subtasks = engine.parseDecomposition('[{"agent":"架构师"},{"agent":"设计师","subtask":"设计角色"}]', members);
      expect(subtasks).toHaveLength(1);
    });

    it('畸形 JSON 返回空数组', () => {
      expect(engine.parseDecomposition('[invalid', members)).toEqual([]);
    });

    it('无 JSON 数组返回空数组', () => {
      expect(engine.parseDecomposition('没有数组', members)).toEqual([]);
    });
  });

  describe('buildRoundReport（轮次状态报告）', () => {
    it('格式化各状态子任务', () => {
      const subtasks = [
        { agent: '架构师', agentId: 'a1', subtask: '构建世界观', taskId: null, status: 'done', output: '产出内容' },
        { agent: '写手', agentId: 'a3', subtask: '撰写章节', taskId: null, status: 'failed', output: '超时' },
        { agent: '设计师', agentId: 'a2', subtask: '设计角色', taskId: null, status: 'skipped' }
      ];
      const report = engine.buildRoundReport(subtasks);
      expect(report).toContain('✓完成');
      expect(report).toContain('✗失败');
      expect(report).toContain('⊘已跳过');
      expect(report).toContain('架构师');
    });

    it('显示重试次数', () => {
      const subtasks = [{ agent: '写手', agentId: 'a3', subtask: '撰写', taskId: null, status: 'failed', retryCount: 2 }];
      expect(engine.buildRoundReport(subtasks)).toContain('已重试2次');
    });
  });
});

describe('TeamEngine 执行干预控制流', () => {
  let db: ReturnType<typeof createMockDb>;
  let orch: ReturnType<typeof createMockOrchestrator>;
  let engine: TeamEngine;

  beforeEach(() => {
    db = createMockDb();
    orch = createMockOrchestrator();
    engine = new TeamEngine(db as never, orch as never);
  });

  describe('cancelRun', () => {
    it('不存在的 run 返回失败', () => {
      expect(engine.cancelRun('run-nonexistent').ok).toBe(false);
    });

    it('已结束的 run 拒绝取消', () => {
      const id = seedTeamRun(db, { phase: 'done' });
      expect(engine.cancelRun(id).ok).toBe(false);
    });

    it('活跃 run 可取消：置位 cancel 并仅中止 running 子任务', () => {
      const subtasks = [
        { agent: '架构师', agentId: 'a1', subtask: 't1', taskId: 'task-1', status: 'running' },
        { agent: '设计师', agentId: 'a2', subtask: 't2', taskId: 'task-2', status: 'pending' }
      ];
      const id = seedTeamRun(db, { phase: 'execute', subtasks_json: JSON.stringify(subtasks) });
      const r = engine.cancelRun(id);
      expect(r.ok).toBe(true);
      expect(engine.control(id).cancel).toBe(true);
      expect(orch.cancelTask).toHaveBeenCalledTimes(1);
      expect(orch.cancelTask).toHaveBeenCalledWith('task-1');
      const events = JSON.parse(db.tables.team_runs.get(id)?.events_json as string);
      expect(events).toContainEqual(expect.objectContaining({ type: 'intervention', action: 'cancel' }));
    });
  });

  describe('skipSubtask', () => {
    it('已完成的子任务不可跳过', () => {
      const id = seedTeamRun(db, { subtasks_json: JSON.stringify([{ agent: '架构师', agentId: 'a1', subtask: 't1', taskId: null, status: 'done' }]) });
      expect(engine.skipSubtask(id, 0).ok).toBe(false);
    });

    it('执行中的子任务可跳过：加入 skip 集并中止其任务', () => {
      const id = seedTeamRun(db, { subtasks_json: JSON.stringify([{ agent: '架构师', agentId: 'a1', subtask: 't1', taskId: 'task-1', status: 'running' }]) });
      const r = engine.skipSubtask(id, 0);
      expect(r.ok).toBe(true);
      expect(engine.control(id).skip.has(0)).toBe(true);
      expect(orch.cancelTask).toHaveBeenCalledWith('task-1');
    });

    it('不存在的子任务下标返回失败', () => {
      const id = seedTeamRun(db, { subtasks_json: '[]' });
      expect(engine.skipSubtask(id, 5).ok).toBe(false);
    });
  });

  describe('forceRetrySubtask', () => {
    it('非失败子任务不可强制重试', () => {
      const id = seedTeamRun(db, { subtasks_json: JSON.stringify([{ agent: '架构师', agentId: 'a1', subtask: 't1', taskId: null, status: 'done' }]) });
      expect(engine.forceRetrySubtask(id, 0).ok).toBe(false);
    });

    it('失败子任务可强制重试：加入 forceRetry 集', () => {
      const id = seedTeamRun(db, { subtasks_json: JSON.stringify([{ agent: '写手', agentId: 'a3', subtask: 't1', taskId: null, status: 'failed' }]) });
      const r = engine.forceRetrySubtask(id, 0);
      expect(r.ok).toBe(true);
      expect(engine.control(id).forceRetry.has(0)).toBe(true);
    });
  });

  describe('injectGuidance', () => {
    it('空指导被拒绝', () => {
      const id = seedTeamRun(db);
      expect(engine.injectGuidance(id, '   ').ok).toBe(false);
    });

    it('有效指导被注入控制态', () => {
      const id = seedTeamRun(db);
      const r = engine.injectGuidance(id, '别纠结X，先做Y');
      expect(r.ok).toBe(true);
      expect(engine.control(id).guidance).toContain('别纠结X，先做Y');
      const events = JSON.parse(db.tables.team_runs.get(id)?.events_json as string);
      expect(events).toContainEqual(expect.objectContaining({ type: 'intervention', action: 'guidance', message: '别纠结X，先做Y' }));
    });

    it('已结束 run 拒绝注入', () => {
      const id = seedTeamRun(db, { phase: 'done' });
      expect(engine.injectGuidance(id, '指导').ok).toBe(false);
    });
  });
});

describe('TeamEngine 项目知识注入', () => {
  it('绑定项目时生成共享知识文件并登记上下文使用', () => {
    const db = createMockDb();
    const projectId = seedProject(db, { id: 'project-knowledge', name: '知识复用项目' });
    const runId = seedTeamRun(db, { project_id: projectId });
    const knowledge = { buildProjectContext: vi.fn().mockReturnValue('# 项目知识上下文\n\n既有执行手册') };
    const engine = new TeamEngine(db as never, createMockOrchestrator() as never, knowledge as never);

    engine.prepareKnowledgeContext(runId, '/tmp/team-workspace', '制定执行方案');

    expect(knowledge.buildProjectContext).toHaveBeenCalledWith(projectId, '制定执行方案');
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining(join('_aibox', 'KNOWLEDGE.md')),
      '# 项目知识上下文\n\n既有执行手册',
      'utf8'
    );
  });

  it('未绑定项目时不读取或写入知识上下文', () => {
    const db = createMockDb();
    const runId = seedTeamRun(db, { project_id: null });
    const knowledge = { buildProjectContext: vi.fn() };
    const engine = new TeamEngine(db as never, createMockOrchestrator() as never, knowledge as never);

    engine.prepareKnowledgeContext(runId, '/tmp/team-workspace', '通用讨论');

    expect(knowledge.buildProjectContext).not.toHaveBeenCalled();
  });
});

describe('TeamEngine 协作总览与链路追溯', () => {
  it('聚合成员贡献、项目成果和主Agent决策', () => {
    const db = createMockDb();
    const projectId = seedProject(db, { name: 'Alpha 项目' });
    seedTeam(db, { id: 'team-test', coordinator_id: 'coord', member_ids: JSON.stringify(['a1', 'a2']) });
    const runId = seedTeamRun(db, {
      team_id: 'team-test', project_id: projectId, phase: 'done', created_at: 1000, ended_at: 7000,
      task_text: '完成 Alpha 项目评审', final_result: '评审结论',
      subtasks_json: JSON.stringify([
        { agent: '研究员', agentId: 'a1', subtask: '调研', taskId: 'task-a1', status: 'done', retryCount: 1 },
        { agent: '审查员', agentId: 'a2', subtask: '审查', taskId: 'task-a2', status: 'failed' }
      ]),
      events_json: JSON.stringify([
        { type: 'subtask_done', round: 1, agent: '研究员', agentId: 'a1', status: 'done', durationMs: 2000, ts: 3000 },
        { type: 'subtask_done', round: 1, agent: '审查员', agentId: 'a2', status: 'failed', durationMs: 3000, ts: 4000 },
        { type: 'intervention', action: 'guidance', message: '优先检查风险', ts: 4500 },
        { type: 'decision', round: 1, action: 'finish', summary: '完成评审', reasoning: '信息充分', ts: 5000 }
      ])
    });
    db.tables.deliverables.set('deliverable-alpha', {
      id: 'deliverable-alpha', source_type: 'team_run', source_id: runId, project_id: projectId,
      title: 'Alpha 项目评审', review_status: 'accepted', updated_at: 7000
    });
    const orchestrator = createMockOrchestrator();
    orchestrator.listAgents.mockReturnValue([
      { id: 'coord', name: '主理人', role: '统筹与验收' },
      { id: 'a1', name: '研究员', role: '市场研究' },
      { id: 'a2', name: '审查员', role: '风险审查' }
    ]);
    const engine = new TeamEngine(db as never, orchestrator as never);

    const overview = engine.getCollaborationOverview('team-test');
    expect(overview.metrics).toMatchObject({ totalRuns: 1, successRate: 100, projectCount: 1, deliverableCount: 1, acceptedDeliverables: 1, interventionCount: 1 });
    expect(overview.members.find((member) => member.agentId === 'coord')?.decisions).toBe(1);
    expect(overview.members.find((member) => member.agentId === 'a1')).toMatchObject({ assigned: 1, completed: 1, retries: 1, completionRate: 100, avgDurationMs: 2000 });
    expect(overview.projects[0]).toMatchObject({ projectName: 'Alpha 项目', runCount: 1, deliverableCount: 1, acceptedDeliverables: 1 });
    expect(overview.recentDecisions[0]).toMatchObject({ runId, action: 'finish', reasoning: '信息充分' });

    const trace = engine.listRuns('team-test')[0].trace;
    expect(trace.project).toEqual({ id: projectId, name: 'Alpha 项目' });
    expect(trace.tasks).toHaveLength(2);
    expect(trace.deliverable).toMatchObject({ id: 'deliverable-alpha', reviewStatus: 'accepted' });
  });
});

describe('TeamEngine 崩溃恢复续跑（可恢复状态机）', () => {
  let db: ReturnType<typeof createMockDb>;
  let orch: ReturnType<typeof createResumableOrchestrator>;
  let engine: TeamEngine;

  /** 可续跑的 Orchestrator mock：所有分派的任务立即完成 */
  function createResumableOrchestrator() {
    let counter = 0;
    return {
      listAgents: vi.fn().mockReturnValue([
        { id: 'coord', name: '主编', role: '协调' },
        { id: 'a1', name: '架构师', role: '世界观' },
        { id: 'a3', name: '写手', role: '章节' }
      ]),
      createTask: vi.fn(() => { counter++; return { id: `t-${counter}` }; }),
      waitForTask: vi.fn(async (taskId: string) => ({ id: taskId, status: 'COMPLETED' })),
      taskResult: vi.fn((taskId: string) => `产出 ${taskId}`),
      cancelTask: vi.fn()
    };
  }

  /** 轮询等待 run 进入终态 */
  async function waitForSettled(id: string, timeoutMs = 1500) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const row = db.tables.team_runs.get(id);
      if (row && ['done', 'failed', 'cancelled'].includes(row.phase as string)) return row;
      await new Promise((r) => setTimeout(r, 5));
    }
    return db.tables.team_runs.get(id);
  }

  beforeEach(() => {
    db = createMockDb();
    orch = createResumableOrchestrator();
    engine = new TeamEngine(db as never, orch as never);
    seedTeam(db, { id: 'team-test', coordinator_id: 'coord', member_ids: JSON.stringify(['a1', 'a3']) });
  });

  it('从 execute 阶段续跑：中断的 running 子任务重置并重新完成', async () => {
    const subtasks = [
      { agent: '架构师', agentId: 'a1', subtask: '构建世界观', taskId: 'old-t1', status: 'done', output: '已完成产出', round: 1 },
      { agent: '写手', agentId: 'a3', subtask: '撰写章节', taskId: 'old-t2', status: 'running', round: 1 }
    ];
    const runId = seedTeamRun(db, { team_id: 'team-test', phase: 'execute', current_step: 1, subtasks_json: JSON.stringify(subtasks) });

    engine.recoverOrResume();
    const settled = await waitForSettled(runId);

    expect(settled.phase).toBe('done');
    const finalSubtasks = JSON.parse(settled.subtasks_json as string);
    expect(finalSubtasks.find((s) => s.agentId === 'a3').status).toBe('done'); // 中断的写手续跑后完成
    expect(finalSubtasks.find((s) => s.agentId === 'a1').status).toBe('done'); // 已完成的保持不变
    const events = JSON.parse(settled.events_json as string);
    expect(events).toContainEqual(expect.objectContaining({ type: 'review', status: 'passed' }));
  });

  it('从 clarify 阶段中断：从头重启整个流水线并达成 done', async () => {
    const runId = seedTeamRun(db, { team_id: 'team-test', phase: 'clarify', current_step: 0, subtasks_json: '[]' });

    engine.recoverOrResume();
    const settled = await waitForSettled(runId);

    expect(settled.phase).toBe('done');
    const finalSubtasks = JSON.parse(settled.subtasks_json as string);
    expect(finalSubtasks.length).toBeGreaterThan(0); // 重启后重新拆解出子任务
  });

  it('项目归属写入团队运行，并由所有内部任务继承', async () => {
    const projectId = seedProject(db);
    const result = engine.trigger('team-test', '完成项目成果', projectId);

    expect(result.ok).toBe(true);
    expect(db.tables.team_runs.get(result.runId!)?.project_id).toBe(projectId);

    const settled = await waitForSettled(result.runId!);
    expect(settled.phase).toBe('done');
    expect(orch.createTask).toHaveBeenCalled();
    for (const call of orch.createTask.mock.calls) {
      expect(call[3]).toMatchObject({ projectId });
    }
  });

  it('团队已不存在时续跑标记为 failed', async () => {
    const runId = seedTeamRun(db, { team_id: 'team-deleted', phase: 'execute', subtasks_json: '[]' });

    engine.recoverOrResume();
    const settled = await waitForSettled(runId);

    expect(settled.phase).toBe('failed');
    expect(settled.error).toContain('团队已不存在');
  });

  it('无中断 run 时 recoverOrResume 不产生副作用', () => {
    seedTeamRun(db, { phase: 'done' }); // 已终态，非活跃
    engine.recoverOrResume();
    expect(orch.createTask).not.toHaveBeenCalled();
  });
});
