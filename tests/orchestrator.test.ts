/**
 * Orchestrator 状态机核心测试
 * 覆盖：Agent 生命周期、Task 状态转换、派生状态、FIFO 调度、崩溃恢复
 */
// @ts-nocheck
/* eslint-disable */
import { createMockDb, seedAgent, seedEngine, seedProject } from './helpers/mockDb.js';

// Mock notifier（避免系统通知副作用）
vi.mock('../src/main/services/notifier.js', () => ({
  notify: vi.fn()
}));

import { Orchestrator, formatDuration } from '../src/main/services/orchestrator.js';
import type { ExecutorRegistry } from '../src/main/services/executor/index.js';
import type { ApprovalBroker } from '../src/main/services/approvalBroker.js';

function createMockExecutors(): ExecutorRegistry {
  return {
    dispatch: vi.fn(),
    abort: vi.fn(),
    isExecuting: vi.fn().mockReturnValue(false),
    activeTaskIdsForAgent: vi.fn().mockReturnValue([]),
    kindFor: vi.fn().mockReturnValue('simulated')
  } as unknown as ExecutorRegistry;
}

function createMockBroker(): ApprovalBroker {
  return {
    decide: vi.fn().mockReturnValue(false),
    abandonTask: vi.fn(),
    onChange: vi.fn()
  } as unknown as ApprovalBroker;
}

describe('formatDuration', () => {
  it('格式化秒级时长', () => {
    expect(formatDuration(5000)).toBe('0分 5秒');
    expect(formatDuration(65000)).toBe('1分 5秒');
  });

  it('格式化小时级时长', () => {
    expect(formatDuration(3600_000)).toBe('1小时 0分');
    expect(formatDuration(5400_000)).toBe('1小时 30分');
  });

  it('格式化天级时长', () => {
    expect(formatDuration(86400_000)).toBe('1天 0小时');
    expect(formatDuration(90000_000)).toBe('1天 1小时');
  });
});

describe('Orchestrator 状态机', () => {
  let db: ReturnType<typeof createMockDb>;
  let executors: ExecutorRegistry;
  let broker: ApprovalBroker;
  let orch: Orchestrator;

  beforeEach(() => {
    db = createMockDb();
    executors = createMockExecutors();
    broker = createMockBroker();
    orch = new Orchestrator(db as never, executors, broker);
    seedEngine(db);
  });

  describe('createAgent 验证', () => {
    it('名称过短应抛出异常', () => {
      expect(() => orch.createAgent({
        name: 'A',
        role: '这是一个超过二十个字的职责描述用于测试验证逻辑是否正常工作',
        systemPrompt: '',
        engineId: 'engine-sim',
        workspace: '',
        permissionMode: 'standard',
        concurrencyLimit: 1,
        channelIds: []
      })).toThrow('名称需为 2—30 字');
    });

    it('职责描述过短应抛出异常', () => {
      expect(() => orch.createAgent({
        name: '测试员工',
        role: '短',
        systemPrompt: '',
        engineId: 'engine-sim',
        workspace: '',
        permissionMode: 'standard',
        concurrencyLimit: 1,
        channelIds: []
      })).toThrow('职责描述需为 2—500 字');
    });

    it('引擎不存在应抛出异常', () => {
      expect(() => orch.createAgent({
        name: '测试员工',
        role: '这是一个超过二十个字的职责描述用于测试验证逻辑是否正常工作',
        systemPrompt: '',
        engineId: 'nonexistent',
        workspace: '',
        permissionMode: 'standard',
        concurrencyLimit: 1,
        channelIds: []
      })).toThrow();
    });

    it('合法输入应创建 READY 状态的 Agent', () => {
      const agent = orch.createAgent({
        name: '新员工',
        role: '这是一个超过二十个字的职责描述用于测试验证逻辑是否正常工作',
        systemPrompt: 'test',
        engineId: 'engine-sim',
        workspace: '/tmp',
        permissionMode: 'standard',
        concurrencyLimit: 1,
        channelIds: []
      });
      expect(agent.lifecycle).toBe('READY');
      expect(agent.name).toBe('新员工');
    });
  });

  describe('Task 状态转换', () => {
    it('READY 员工创建任务 → 立即 RUNNING', () => {
      const agentId = seedAgent(db);
      const task = orch.createTask(agentId, '测试任务');
      expect(task.status).toBe('RUNNING');
      expect(task.startedAt).not.toBeNull();
      expect(executors.dispatch).toHaveBeenCalled();
    });

    it('DISABLED 员工创建任务 → QUEUED', () => {
      const agentId = seedAgent(db, { lifecycle: 'DISABLED' });
      const task = orch.createTask(agentId, '排队任务');
      expect(task.status).toBe('QUEUED');
      expect(executors.dispatch).not.toHaveBeenCalled();
    });

    it('任务归属项目，追问任务继承原项目', () => {
      const agentId = seedAgent(db);
      const projectId = seedProject(db);
      const task = orch.createTask(agentId, '项目任务', 'desktop', { projectId });
      expect(task.projectId).toBe(projectId);

      const followUp = orch.createFollowUpTask(task.id, '继续完善项目任务');
      expect(followUp.projectId).toBe(projectId);
      expect(followUp.parentId).toBe(task.id);
    });

    it('拒绝关联不存在或已归档的项目', () => {
      const agentId = seedAgent(db);
      const archivedId = seedProject(db, { status: 'archived' });
      expect(() => orch.createTask(agentId, '无效项目任务', 'desktop', { projectId: 'missing' })).toThrow('项目不存在或已归档');
      expect(() => orch.createTask(agentId, '归档项目任务', 'desktop', { projectId: archivedId })).toThrow('项目不存在或已归档');
    });

    it('并发限制超出 → QUEUED', () => {
      const agentId = seedAgent(db, { concurrency_limit: 1 });
      // 第一个任务占满并发
      orch.createTask(agentId, '任务1');
      // 第二个任务应排队
      const task2 = orch.createTask(agentId, '任务2');
      expect(task2.status).toBe('QUEUED');
    });

    it('cancelTask → CANCELLED 并触发 FIFO 补位', () => {
      const agentId = seedAgent(db, { concurrency_limit: 1 });
      const t1 = orch.createTask(agentId, '任务1');
      const t2 = orch.createTask(agentId, '任务2');
      expect(t2.status).toBe('QUEUED');

      orch.cancelTask(t1.id);

      // t1 已取消
      const t1After = db.tables.tasks.get(t1.id);
      expect(t1After?.status).toBe('CANCELLED');

      // t2 应被 FIFO 调度为 RUNNING
      const t2After = db.tables.tasks.get(t2.id);
      expect(t2After?.status).toBe('RUNNING');
    });

    it('cancelTask waits for an ACP child to close before FIFO replacement', () => {
      const agentId = seedAgent(db, { concurrency_limit: 1 });
      vi.mocked(executors.kindFor).mockReturnValue('acp');
      const t1 = orch.createTask(agentId, 'ACP 任务1');
      const t2 = orch.createTask(agentId, 'ACP 任务2');
      const occupied = new Set([t1.id]);
      vi.mocked(executors.isExecuting).mockImplementation((taskId) => occupied.has(taskId));
      vi.mocked(executors.activeTaskIdsForAgent).mockImplementation((id) => id === agentId ? [...occupied] : []);

      orch.cancelTask(t1.id);

      expect(db.tables.tasks.get(t1.id)?.status).toBe('CANCELLED');
      expect(db.tables.tasks.get(t2.id)?.status).toBe('QUEUED');

      const firstDispatch = vi.mocked(executors.dispatch).mock.calls[0];
      occupied.delete(t1.id);
      firstDispatch[2].onReleased?.(t1.id);
      expect(db.tables.tasks.get(t2.id)?.status).toBe('RUNNING');
    });

    it('取消等待审批任务时同步关闭待审批记录', () => {
      const agentId = seedAgent(db);
      const task = orch.createTask(agentId, '等待审批任务');
      db.tables.tasks.get(task.id)!.status = 'WAITING_APPROVAL';
      db.tables.approvals.set('approval-cancel', {
        id: 'approval-cancel', task_id: task.id, agent_id: agentId, status: 'pending', created_at: Date.now(), decided_at: null
      });

      orch.cancelTask(task.id);
      expect(db.tables.tasks.get(task.id)?.status).toBe('CANCELLED');
      expect(db.tables.approvals.get('approval-cancel')).toMatchObject({ status: 'rejected', decided_at: expect.any(Number) });
    });

    it('已结束任务不可再次取消', () => {
      const agentId = seedAgent(db);
      const task = orch.createTask(agentId, '已完成任务');
      const row = db.tables.tasks.get(task.id)!;
      row.status = 'COMPLETED';
      row.ended_at = Date.now();

      expect(() => orch.cancelTask(task.id)).toThrow('任务已经结束');
      expect(row.status).toBe('COMPLETED');
    });

    it('任务产物按需读取时限制为 16,000 字符', () => {
      const agentId = seedAgent(db);
      const task = orch.createTask(agentId, '超长产物任务');
      db.tables.tasks.get(task.id)!.result = '中'.repeat(20_000);

      expect(orch.taskResult(task.id)).toHaveLength(16_000);
    });

    it('retryTask 保留员工、项目、工作区和父任务追溯', () => {
      const agentId = seedAgent(db);
      const projectId = seedProject(db);
      const task = orch.createTask(agentId, '重新生成周报', 'desktop', { projectId, workspaceOverride: 'D:/project-work' });
      const row = db.tables.tasks.get(task.id)!;
      row.status = 'FAILED';
      row.error = '模型超时';
      row.ended_at = Date.now();

      const retried = orch.retryTask(task.id);
      expect(retried).toMatchObject({ agentId, projectId, title: task.title, parentId: task.id, workspaceOverride: 'D:/project-work' });
      expect(retried.id).not.toBe(task.id);
      expect(db.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'task.retry', target: task.id, result: retried.id }));
    });

    it('deleteTask 仅软删除终态任务并从任务列表隐藏', () => {
      const agentId = seedAgent(db);
      const task = orch.createTask(agentId, '待删除任务');
      const row = db.tables.tasks.get(task.id)!;
      row.status = 'CANCELLED';
      row.ended_at = Date.now();

      orch.deleteTask(task.id);
      expect(row.deleted_at).toEqual(expect.any(Number));
      expect(db.tables.tasks.has(task.id)).toBe(true);
      expect(orch.listTasks().some((item) => item.id === task.id)).toBe(false);
      expect(db.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'task.delete', target: task.id, result: 'soft-deleted' }));
      expect(() => orch.deleteTask(task.id)).toThrow('任务不存在或已删除');
    });

    it('执行中的任务和仍有活跃后续任务的父任务不可删除', () => {
      const agentId = seedAgent(db, { concurrency_limit: 2 });
      const parent = orch.createTask(agentId, '父任务');
      expect(() => orch.deleteTask(parent.id)).toThrow('请先取消任务');
      db.tables.tasks.get(parent.id)!.status = 'FAILED';
      db.tables.tasks.get(parent.id)!.ended_at = Date.now();
      orch.createTask(agentId, '后续任务', 'desktop', { parentId: parent.id });
      expect(() => orch.deleteTask(parent.id)).toThrow('后续任务');
    });

    it('pauseTask → PAUSED（仅 RUNNING 可暂停）', () => {
      const agentId = seedAgent(db);
      const task = orch.createTask(agentId, '暂停测试');
      expect(task.status).toBe('RUNNING');

      orch.pauseTask(task.id);
      expect(db.tables.tasks.get(task.id)?.status).toBe('PAUSED');
      expect(executors.abort).toHaveBeenCalledWith(task.id);
    });

    it('resumeTask → RUNNING 并重新派发', () => {
      const agentId = seedAgent(db);
      const task = orch.createTask(agentId, '恢复测试');
      orch.pauseTask(task.id);
      expect(db.tables.tasks.get(task.id)?.status).toBe('PAUSED');

      vi.mocked(executors.dispatch).mockClear();
      orch.resumeTask(task.id);
      expect(db.tables.tasks.get(task.id)?.status).toBe('RUNNING');
      expect(executors.dispatch).toHaveBeenCalled();
    });

    it('pause 后立即 resume 要等旧 ACP child release 才重新派发', () => {
      const agentId = seedAgent(db);
      vi.mocked(executors.kindFor).mockReturnValue('acp');
      const task = orch.createTask(agentId, 'ACP 暂停恢复');
      const firstDispatch = vi.mocked(executors.dispatch).mock.calls[0];
      const occupied = new Set([task.id]);
      vi.mocked(executors.isExecuting).mockImplementation((taskId) => occupied.has(taskId));
      vi.mocked(executors.activeTaskIdsForAgent).mockImplementation((id) => id === agentId ? [...occupied] : []);

      orch.pauseTask(task.id);
      vi.mocked(executors.dispatch).mockClear();
      orch.resumeTask(task.id);

      expect(db.tables.tasks.get(task.id)?.status).toBe('PAUSED');
      expect(executors.dispatch).not.toHaveBeenCalled();

      occupied.delete(task.id);
      firstDispatch[2].onReleased?.(task.id);

      expect(db.tables.tasks.get(task.id)?.status).toBe('RUNNING');
      expect(executors.dispatch).toHaveBeenCalledOnce();
    });

    it('pauseTask 对 QUEUED 任务无效', () => {
      const agentId = seedAgent(db, { concurrency_limit: 1 });
      orch.createTask(agentId, '占位');
      const t2 = orch.createTask(agentId, '排队中');
      expect(t2.status).toBe('QUEUED');

      vi.mocked(executors.abort).mockClear();
      orch.pauseTask(t2.id);
      // QUEUED 不应变为 PAUSED
      expect(db.tables.tasks.get(t2.id)?.status).toBe('QUEUED');
      expect(executors.abort).not.toHaveBeenCalled();
    });
  });

  describe('Agent 生命周期', () => {
    it('startAgent → READY', () => {
      const agentId = seedAgent(db, { lifecycle: 'DISABLED' });
      orch.startAgent(agentId);
      expect(db.tables.agents.get(agentId)?.lifecycle).toBe('READY');
    });

    it('stopAgent → DISABLED 并取消活跃任务', () => {
      const agentId = seedAgent(db);
      const task = orch.createTask(agentId, '活跃任务');
      expect(task.status).toBe('RUNNING');

      orch.stopAgent(agentId);
      expect(db.tables.agents.get(agentId)?.lifecycle).toBe('DISABLED');
      expect(db.tables.tasks.get(task.id)?.status).toBe('CANCELLED');
      expect(executors.abort).toHaveBeenCalledWith(task.id);
    });

    it('stop/start 后创建任务仍等待旧 ACP child release', () => {
      const agentId = seedAgent(db, { concurrency_limit: 1 });
      vi.mocked(executors.kindFor).mockReturnValue('acp');
      const oldTask = orch.createTask(agentId, '停止前的 ACP 任务');
      const firstDispatch = vi.mocked(executors.dispatch).mock.calls[0];
      const occupied = new Set([oldTask.id]);
      vi.mocked(executors.isExecuting).mockImplementation((taskId) => occupied.has(taskId));
      vi.mocked(executors.activeTaskIdsForAgent).mockImplementation((id) => id === agentId ? [...occupied] : []);

      orch.stopAgent(agentId);
      orch.startAgent(agentId);
      const replacement = orch.createTask(agentId, '重启后的任务');

      expect(db.tables.tasks.get(oldTask.id)?.status).toBe('CANCELLED');
      expect(replacement.status).toBe('QUEUED');
      expect(executors.dispatch).toHaveBeenCalledOnce();

      occupied.delete(oldTask.id);
      firstDispatch[2].onReleased?.(oldTask.id);

      expect(db.tables.tasks.get(replacement.id)?.status).toBe('RUNNING');
      expect(executors.dispatch).toHaveBeenCalledTimes(2);
    });
  });

  describe('崩溃恢复', () => {
    it('recoverAfterRestart 将 RUNNING 标记为 INTERRUPTED', () => {
      const agentId = seedAgent(db);
      const task = orch.createTask(agentId, '崩溃任务');
      expect(task.status).toBe('RUNNING');

      orch.recoverAfterRestart();
      const after = db.tables.tasks.get(task.id);
      expect(after?.status).toBe('INTERRUPTED');
      expect(after?.error).toBe('客户端异常退出，任务中断');
    });

    it('recoverAfterRestart 将 WAITING_APPROVAL 标记为 INTERRUPTED', () => {
      const agentId = seedAgent(db);
      // 手动插入一个 WAITING_APPROVAL 任务
      const id = 'task-waiting';
      db.tables.tasks.set(id, {
        id, agent_id: agentId, title: '等待审批', source: 'desktop',
        parent_id: null, status: 'WAITING_APPROVAL', priority: 0,
        progress: 50, stage: '调用工具', error: null, session_id: null,
        created_at: Date.now(), started_at: Date.now(), ended_at: null, result: null
      });

      orch.recoverAfterRestart();
      expect(db.tables.tasks.get(id)?.status).toBe('INTERRUPTED');
    });

    it('无活跃任务时 recoverAfterRestart 无操作', () => {
      const agentId = seedAgent(db);
      orch.createTask(agentId, '已完成');
      // 手动完成
      const tasks = [...db.tables.tasks.values()];
      tasks[0].status = 'COMPLETED';

      // 不应抛出
      orch.recoverAfterRestart();
    });
  });

  describe('派生状态（deriveStatus via agentCards）', () => {
    it('ERROR 生命周期 → error', () => {
      seedAgent(db, { lifecycle: 'ERROR' });
      const cards = orch.agentCards();
      expect(cards[0].derivedStatus).toBe('error');
    });

    it('有 RUNNING 任务 → running', () => {
      const agentId = seedAgent(db);
      orch.createTask(agentId, '执行中');
      const cards = orch.agentCards();
      expect(cards[0].derivedStatus).toBe('running');
    });

    it('有 PAUSED 任务 → paused', () => {
      const agentId = seedAgent(db);
      const task = orch.createTask(agentId, '暂停中');
      orch.pauseTask(task.id);
      const cards = orch.agentCards();
      expect(cards[0].derivedStatus).toBe('paused');
    });

    it('STARTING 生命周期 → starting', () => {
      seedAgent(db, { lifecycle: 'STARTING' });
      const cards = orch.agentCards();
      expect(cards[0].derivedStatus).toBe('starting');
    });

    it('READY 无任务 → idle', () => {
      seedAgent(db);
      const cards = orch.agentCards();
      expect(cards[0].derivedStatus).toBe('idle');
    });

    it('互斥优先级：ERROR > RUNNING', () => {
      const agentId = seedAgent(db, { lifecycle: 'ERROR' });
      // 手动插入 RUNNING 任务
      db.tables.tasks.set('t-err', {
        id: 't-err', agent_id: agentId, title: 'test', source: 'desktop',
        parent_id: null, status: 'RUNNING', priority: 0, progress: 0,
        stage: '', error: null, session_id: null,
        created_at: Date.now(), started_at: Date.now(), ended_at: null, result: null
      });
      const cards = orch.agentCards();
      expect(cards[0].derivedStatus).toBe('error');
    });
  });

  describe('调度保护门禁', () => {
    it('dispatchGuard 阻止时任务进入 QUEUED', () => {
      orch.setDispatchGuard(() => 'CPU 过载保护');
      const agentId = seedAgent(db);
      const task = orch.createTask(agentId, '受保护任务');
      expect(task.status).toBe('QUEUED');
      expect(task.stage).toBe('CPU 过载保护');
      expect(executors.dispatch).not.toHaveBeenCalled();
    });

    it('dispatchGuard 解除后恢复正常派发', () => {
      orch.setDispatchGuard(() => '资源保护中');
      const agentId = seedAgent(db);
      const task = orch.createTask(agentId, '等待任务');
      expect(task.status).toBe('QUEUED');

      // 解除保护
      orch.setDispatchGuard(() => null);
      // 取消另一个任务触发 scheduleNext 不太方便，直接创建新任务验证
      const task2 = orch.createTask(agentId, '新任务');
      // 并发限制 1，第一个还在 QUEUED 不算活跃，所以 task2 应该 RUNNING
      expect(task2.status).toBe('RUNNING');
    });
  });
});
