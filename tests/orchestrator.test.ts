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
    dispatch: vi.fn((task, agent, _callbacks, onResolved) => {
      const requestedEngineId = task.engineOverride || agent.engineId;
      onResolved?.({
        requestedEngineId,
        resolvedEngineId: null,
        executorKind: 'simulated',
        usedFallback: true
      });
      return 'simulated';
    }),
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

  function createPlanApproval(agentId: string, title = '待批准计划') {
    const task = orch.createTask(agentId, title, 'channel', {
      content: `${title}的完整执行内容`,
      initialApprovalRequest: `批准执行：${title}`
    });
    const approval = [...db.tables.approvals.values()].find((row) => row.task_id === task.id)!;
    return { task, approval, approvalId: approval.id as string };
  }

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

    it('完整任务正文与 canonical 输入消息独立于短标题保存', () => {
      const agentId = seedAgent(db);
      const content = `完整正文-${'x'.repeat(500)}`;
      const task = orch.createTask(agentId, '短标题', 'channel', {
        content,
        conversationId: 'conversation-1',
        inputMessageId: 'message-1'
      });
      expect(task.title).toBe('短标题');
      expect(task.content).toBe(content);
      expect(task.conversationId).toBe('conversation-1');
      expect(task.inputMessageId).toBe('message-1');
      expect(executors.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ content }), expect.anything(), expect.anything(), expect.anything()
      );
    });

    it('控制核计划只能经 applyDispatchPlan 提交且支持提交前审批', () => {
      const agentId = seedAgent(db);
      const request = {
        requestId: 'kernel:message-1', organizationId: 'org-local', principalId: 'principal-1',
        channelId: 'ch-test', conversationId: 'conversation-1', inputMessageId: 'message-1',
        message: '完整用户请求', preferredAgentId: agentId, projectId: null,
        workers: [{ agentId, name: '测试员工', role: '测试', engineId: 'engine-sim', capabilities: [] }],
        memories: []
      };
      const plan = {
        schemaVersion: 1, requestId: request.requestId, conversationId: request.conversationId,
        leaderKernel: 'hermes', workerAgentId: agentId, workerEngineId: 'engine-sim',
        title: '计划标题', objective: '未经截断的完整计划目标', rationale: '员工职责匹配',
        priority: 2, expectedOutputs: ['报告'], requiresHumanApproval: true,
        memoryProposals: [], taskScheduleProposals: [], advisorAdvice: [], advisorReviews: []
      };
      const state = {
        findPlan: vi.fn(() => null),
        savePlan: vi.fn(() => ({ status: 'planned', taskId: null, plan })),
        markCommitted: vi.fn(() => ({ status: 'committed', taskId: 'unused', plan }))
      };

      const task = orch.applyDispatchPlan(request, plan, state as never);
      expect(task).toMatchObject({
        status: 'WAITING_APPROVAL', content: plan.objective, priority: 2,
        conversationId: 'conversation-1', inputMessageId: 'message-1'
      });
      expect(executors.dispatch).not.toHaveBeenCalled();
      expect(state.savePlan).toHaveBeenCalledWith(request, plan);
      expect(state.markCommitted).toHaveBeenCalledWith(request.requestId, task.id);
      expect([...db.tables.approvals.values()]).toHaveLength(1);

      const approvalId = [...db.tables.approvals.keys()][0];
      expect(db.tables.approvals.get(approvalId)?.type).toBe('dispatch_plan');
      expect(orch.listApprovals()[0]).toMatchObject({ scope: 'dispatch_plan', type: 'dispatch_plan' });
      orch.decideApproval(approvalId, true);
      expect(db.tables.tasks.get(task.id)?.status).toBe('RUNNING');
      expect(executors.dispatch).toHaveBeenCalledOnce();
      const decision = [...db.tables.task_events.values()].find((event) => event.task_id === task.id && event.event_type === 'approval_decided');
      expect(JSON.parse(decision?.payload as string)).toMatchObject({
        approvalId, scope: 'dispatch_plan', approved: true
      });
    });

    it('控制核计划在 Worker 启动前完成 durable commit', () => {
      const agentId = seedAgent(db);
      const order: string[] = [];
      const request = {
        requestId: 'kernel:message-atomic', organizationId: 'org-local', principalId: 'principal-1',
        channelId: 'ch-test', conversationId: 'conversation-atomic', inputMessageId: 'message-atomic',
        message: '执行已规划任务', preferredAgentId: agentId, projectId: null,
        workers: [{ agentId, name: '测试员工', role: '测试', engineId: 'engine-sim', capabilities: [] }],
        memories: []
      };
      const plan = {
        schemaVersion: 1, requestId: request.requestId, conversationId: request.conversationId,
        leaderKernel: 'hermes', workerAgentId: agentId, workerEngineId: 'engine-sim',
        title: '原子提交任务', objective: '任务正文', rationale: '职责匹配', priority: 0,
        expectedOutputs: ['结果'], requiresHumanApproval: false, memoryProposals: [], taskScheduleProposals: [],
        advisorAdvice: [], advisorReviews: []
      };
      const state = {
        findPlan: vi.fn(() => null),
        savePlan: vi.fn(() => ({ status: 'planned', taskId: null, plan })),
        markCommitted: vi.fn(() => {
          order.push('committed');
          return { status: 'committed', taskId: 'task-atomic', plan };
        })
      };
      executors.dispatch.mockImplementationOnce(() => {
        order.push('dispatched');
        return 'simulated';
      });

      orch.applyDispatchPlan(request, plan, state as never);

      expect(order).toEqual(['committed', 'dispatched']);
      expect(state.markCommitted).toHaveBeenCalledOnce();
    });

    it('计划审批通过时重新检查员工生命周期，不满足则进入 QUEUED', () => {
      const agentId = seedAgent(db);
      const { task, approvalId } = createPlanApproval(agentId);
      db.tables.agents.get(agentId)!.lifecycle = 'DISABLED';

      orch.decideApproval(approvalId, true);

      expect(db.tables.approvals.get(approvalId)?.status).toBe('approved');
      expect(db.tables.tasks.get(task.id)).toMatchObject({ status: 'QUEUED', stage: '员工未就绪（DISABLED）' });
      expect(executors.dispatch).not.toHaveBeenCalled();

      db.tables.agents.get(agentId)!.lifecycle = 'READY';
      orch.wakeAgentQueue(agentId);
      expect(db.tables.tasks.get(task.id)?.status).toBe('RUNNING');
      expect(executors.dispatch).toHaveBeenCalledOnce();
    });

    it('计划审批通过时重新检查并发额度，待批计划本身不占执行槽', () => {
      const agentId = seedAgent(db, { concurrency_limit: 1 });
      const { task, approvalId } = createPlanApproval(agentId);
      const running = orch.createTask(agentId, '占用并发槽的任务');
      expect(running.status).toBe('RUNNING');
      vi.mocked(executors.dispatch).mockClear();

      orch.decideApproval(approvalId, true);

      expect(db.tables.tasks.get(running.id)?.status).toBe('RUNNING');
      expect(db.tables.tasks.get(task.id)).toMatchObject({ status: 'QUEUED', stage: '排队中' });
      expect(executors.dispatch).not.toHaveBeenCalled();
    });

    it('计划审批通过时重新检查资源保护门禁', () => {
      const agentId = seedAgent(db);
      const { task, approvalId } = createPlanApproval(agentId);
      orch.setDispatchGuard(() => '系统资源保护中');

      orch.decideApproval(approvalId, true);

      expect(db.tables.tasks.get(task.id)).toMatchObject({ status: 'QUEUED', stage: '系统资源保护中' });
      expect(executors.dispatch).not.toHaveBeenCalled();
    });

    it('计划审批通过时重新检查手机设备门禁', () => {
      seedEngine(db, 'eng-hermes-cli');
      let ready = true;
      orch.setMobileDispatchPolicy({
        canDispatch: () => ({ bound: true, ready, reason: ready ? '设备在线' : '设备离线' })
      });
      const agentId = seedAgent(db, {
        agent_kind: 'android_operator', engine_id: 'eng-hermes-cli', concurrency_limit: 1
      });
      const { task, approvalId } = createPlanApproval(agentId);
      ready = false;

      orch.decideApproval(approvalId, true);

      expect(db.tables.tasks.get(task.id)).toMatchObject({ status: 'QUEUED', stage: '设备离线' });
      expect(executors.dispatch).not.toHaveBeenCalled();
    });

    it('手机离线时显示等待连接并在设备上线后唤醒队列', () => {
      seedEngine(db, 'eng-hermes-cli');
      let ready = false;
      orch.setMobileDispatchPolicy({
        canDispatch: () => ({ bound: true, ready, reason: ready ? '' : '手机离线，等待连接' })
      });
      const agentId = seedAgent(db, {
        agent_kind: 'android_operator', engine_id: 'eng-hermes-cli', concurrency_limit: 1
      });

      const task = orch.createTask(agentId, '操作手机');
      expect(task).toMatchObject({ status: 'QUEUED', stage: '手机离线，等待连接' });
      expect(executors.dispatch).not.toHaveBeenCalled();

      ready = true;
      orch.wakeAgentQueue(agentId);
      expect(db.tables.tasks.get(task.id)?.status).toBe('RUNNING');
      expect(executors.dispatch).toHaveBeenCalledOnce();
    });

    it('旧数据库中的 Android 操作员若错误绑定 DSH 则拒绝创建任务', () => {
      const agentId = seedAgent(db, {
        agent_kind: 'android_operator', engine_id: 'eng-deepseek-harness', concurrency_limit: 1
      });
      orch.setMobileDispatchPolicy({ canDispatch: () => ({ bound: true, ready: true, reason: '' }) });

      expect(() => orch.createTask(agentId, '操作手机')).toThrow('DeepSeek Harness 和其他执行引擎目前没有 Android 工具桥接');
      expect(executors.dispatch).not.toHaveBeenCalled();
    });

    it('拒绝计划审批会终止任务并记录决策事件', () => {
      const agentId = seedAgent(db);
      const { task, approvalId } = createPlanApproval(agentId);

      orch.decideApproval(approvalId, false);

      expect(db.tables.approvals.get(approvalId)?.status).toBe('rejected');
      expect(db.tables.tasks.get(task.id)).toMatchObject({ status: 'FAILED', error: '审批被拒绝' });
      const decision = [...db.tables.task_events.values()].find((event) => event.task_id === task.id && event.event_type === 'approval_decided');
      expect(JSON.parse(decision?.payload as string)).toMatchObject({ scope: 'dispatch_plan', approved: false });
    });

    it('recovers an already committed plan before revalidating current worker eligibility', () => {
      const agentId = seedAgent(db);
      const existing = orch.createTask(agentId, '已提交任务', 'channel', { sourceKey: 'kernel:committed' });
      executors.dispatch.mockClear();
      const request = {
        requestId: 'kernel:message-replayed', organizationId: 'org-local', principalId: 'principal-1',
        channelId: 'ch-test', conversationId: 'conversation-1', inputMessageId: 'message-replayed',
        message: '重投消息', preferredAgentId: agentId, projectId: null, workers: [], memories: []
      };
      const plan = {
        schemaVersion: 1, requestId: request.requestId, conversationId: request.conversationId,
        leaderKernel: 'hermes', workerAgentId: agentId, workerEngineId: 'engine-sim',
        title: '已提交任务', objective: '完整任务内容', rationale: '职责匹配', priority: 0,
        expectedOutputs: ['报告'], requiresHumanApproval: false, memoryProposals: [], taskScheduleProposals: [],
        advisorAdvice: [], advisorReviews: []
      };
      const committed = { status: 'committed', taskId: existing.id, plan };
      const state = {
        findPlan: vi.fn(() => committed),
        savePlan: vi.fn(() => committed),
        markCommitted: vi.fn()
      };

      const replay = orch.applyDispatchPlan(request, plan, state as never);

      expect(replay).toMatchObject({ id: existing.id, deduplicated: true });
      expect(executors.dispatch).not.toHaveBeenCalled();
      expect(state.savePlan).toHaveBeenCalledWith(request, plan);
      expect(state.markCommitted).not.toHaveBeenCalled();
    });

    it('相同来源幂等键只创建并派发一次', () => {
      const agentId = seedAgent(db);
      const first = orch.createTask(agentId, '第一份内容', 'channel', { sourceKey: 'weixin:message:101' });
      const replay = orch.createTask(agentId, '重投内容', 'channel', { sourceKey: 'weixin:message:101' });

      expect(replay.id).toBe(first.id);
      expect(replay.deduplicated).toBe(true);
      expect(db.tables.tasks.size).toBe(1);
      expect(db.tables.task_events.size).toBe(1);
      expect(executors.dispatch).toHaveBeenCalledTimes(1);
    });

    it('fallback 鉴权失败只标记实际执行引擎并持久化运行归因', () => {
      const requestedEngineId = 'engine-primary';
      const resolvedEngineId = 'engine-fallback';
      seedEngine(db, requestedEngineId);
      seedEngine(db, resolvedEngineId);
      const agentId = seedAgent(db, { engine_id: requestedEngineId });
      vi.mocked(executors.dispatch).mockImplementation((task, _agent, callbacks, onResolved) => {
        onResolved?.({
          requestedEngineId,
          resolvedEngineId,
          executorKind: 'generic-cli',
          usedFallback: true
        });
        callbacks.onError(task.id, 'HTTP 401: Missing Authentication header');
        return 'generic-cli';
      });

      const task = orch.createTask(agentId, '验证真实引擎归因');

      expect(db.tables.tasks.get(task.id)?.status).toBe('FAILED');
      expect(db.tables.engines.get(requestedEngineId)?.status).toBe('HEALTHY');
      expect(db.tables.engines.get(resolvedEngineId)).toMatchObject({
        status: 'AUTH_REQUIRED', auth_status: 'required'
      });
      expect([...db.tables.agent_runs.values()].find((run) => run.task_id === task.id)).toMatchObject({
        requested_engine_id: requestedEngineId,
        resolved_engine_id: resolvedEngineId,
        executor_kind: 'generic-cli',
        status: 'FAILED'
      });
      expect(db.audit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'task.executorResolved',
        target: task.id,
        result: expect.stringContaining(`\"resolvedEngineId\":\"${resolvedEngineId}\"`)
      }));
    });

    it('recognizes an explicit provider HTTP 403 as an authentication failure', () => {
      const engineId = 'engine-provider-403';
      seedEngine(db, engineId);
      const agentId = seedAgent(db, { engine_id: engineId });
      vi.mocked(executors.dispatch).mockImplementation((task, _agent, callbacks, onResolved) => {
        onResolved?.({ requestedEngineId: engineId, resolvedEngineId: engineId, executorKind: 'hermes-cli', usedFallback: false });
        callbacks.onError(task.id, 'Hermes \u6267\u884c\u5931\u8d25\uff1aHTTP 403: Forbidden');
        return 'hermes-cli';
      });

      orch.createTask(agentId, 'provider auth failure');

      expect(db.tables.engines.get(engineId)).toMatchObject({ status: 'AUTH_REQUIRED', auth_status: 'required' });
    });

    it.each([
      'Task failed while editing auth and login documentation',
      'Website fetch failed: HTTP 403 Forbidden for https://example.com',
      'Compilation failed in src/auth/login.ts'
    ])('does not demote an engine for incidental task text: %s', (error) => {
      const engineId = 'engine-non-auth-error';
      seedEngine(db, engineId);
      const agentId = seedAgent(db, { engine_id: engineId });
      vi.mocked(executors.dispatch).mockImplementation((task, _agent, callbacks, onResolved) => {
        onResolved?.({ requestedEngineId: engineId, resolvedEngineId: engineId, executorKind: 'generic-cli', usedFallback: false });
        callbacks.onError(task.id, error);
        return 'generic-cli';
      });

      const task = orch.createTask(agentId, 'ordinary executor failure');

      expect(db.tables.tasks.get(task.id)?.status).toBe('FAILED');
      expect(db.tables.engines.get(engineId)).toMatchObject({ status: 'HEALTHY', auth_status: 'authed' });
    });

    it('不同来源可复用相同幂等键，空键不去重', () => {
      const agentId = seedAgent(db, { concurrency_limit: 4 });
      const channel = orch.createTask(agentId, '渠道任务', 'channel', { sourceKey: 'event-1' });
      const schedule = orch.createTask(agentId, '定时任务', 'schedule', { sourceKey: 'event-1' });
      const withoutKeyA = orch.createTask(agentId, '无键 A', 'desktop');
      const withoutKeyB = orch.createTask(agentId, '无键 B', 'desktop');

      expect(new Set([channel.id, schedule.id, withoutKeyA.id, withoutKeyB.id])).toHaveProperty('size', 4);
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

    it('allows parent and project associations inside one organization', () => {
      const agentId = seedAgent(db, { organization_id: 'org-a' });
      const projectId = seedProject(db, { organization_id: 'org-a' });
      const parent = orch.createTask(agentId, 'parent', 'desktop', { projectId });

      const child = orch.createTask(agentId, 'child', 'desktop', { parentId: parent.id });

      expect(child).toMatchObject({ parentId: parent.id, projectId });
    });

    it('rejects a foreign project without task, run, event, or dispatch side effects', () => {
      const agentId = seedAgent(db, { organization_id: 'org-a' });
      const projectId = seedProject(db, { organization_id: 'org-b' });

      expect(() => orch.createTask(agentId, 'foreign project', 'desktop', { projectId }))
        .toThrow('\u9879\u76ee\u4e0d\u5b58\u5728\u6216\u5df2\u5f52\u6863');
      expect(db.tables.tasks.size).toBe(0);
      expect(db.tables.agent_runs.size).toBe(0);
      expect(db.tables.task_events.size).toBe(0);
      expect(executors.dispatch).not.toHaveBeenCalled();
    });

    it('rejects a foreign parent and does not inherit its project', () => {
      const parentAgentId = seedAgent(db, { organization_id: 'org-a' });
      const childAgentId = seedAgent(db, { organization_id: 'org-b' });
      const projectId = seedProject(db, { organization_id: 'org-a' });
      const parent = orch.createTask(parentAgentId, 'foreign parent', 'desktop', { projectId });
      const counts = {
        tasks: db.tables.tasks.size,
        runs: db.tables.agent_runs.size,
        events: db.tables.task_events.size,
        dispatches: vi.mocked(executors.dispatch).mock.calls.length
      };

      expect(() => orch.createTask(childAgentId, 'cross tenant child', 'desktop', { parentId: parent.id }))
        .toThrow('\u7236\u4efb\u52a1\u4e0d\u5b58\u5728\u6216\u4e0d\u53ef\u5173\u8054');
      expect(db.tables.tasks.size).toBe(counts.tasks);
      expect(db.tables.agent_runs.size).toBe(counts.runs);
      expect(db.tables.task_events.size).toBe(counts.events);
      expect(vi.mocked(executors.dispatch).mock.calls.length).toBe(counts.dispatches);
    });

    it('rejects a missing parent without creating a task', () => {
      const agentId = seedAgent(db, { organization_id: 'org-a' });

      expect(() => orch.createTask(agentId, 'missing parent', 'desktop', { parentId: 'missing' }))
        .toThrow('\u7236\u4efb\u52a1\u4e0d\u5b58\u5728\u6216\u4e0d\u53ef\u5173\u8054');
      expect(db.tables.tasks.size).toBe(0);
      expect(db.tables.agent_runs.size).toBe(0);
      expect(db.tables.task_events.size).toBe(0);
      expect(executors.dispatch).not.toHaveBeenCalled();
    });

    it('rechecks project ownership inside the write transaction', () => {
      const agentId = seedAgent(db, { organization_id: 'org-a' });
      const projectId = seedProject(db, { organization_id: 'org-a' });
      const transaction = db.transaction;
      let moved = false;
      db.transaction = (fn) => {
        if (!moved) {
          moved = true;
          db.tables.projects.get(projectId)!.organization_id = 'org-b';
        }
        return transaction(fn);
      };

      expect(() => orch.createTask(agentId, 'project moved during create', 'desktop', { projectId }))
        .toThrow('\u9879\u76ee\u4e0d\u5b58\u5728\u6216\u5df2\u5f52\u6863');
      expect(db.tables.tasks.size).toBe(0);
      expect(db.tables.agent_runs.size).toBe(0);
      expect(db.tables.task_events.size).toBe(0);
      expect(executors.dispatch).not.toHaveBeenCalled();
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
      const finished = vi.fn();
      orch.onTaskFinished(finished);
      const t1 = orch.createTask(agentId, '任务1');
      const t2 = orch.createTask(agentId, '任务2');
      expect(t2.status).toBe('QUEUED');

      orch.cancelTask(t1.id);

      // t1 已取消
      const t1After = db.tables.tasks.get(t1.id);
      expect(t1After?.status).toBe('CANCELLED');
      expect(finished).toHaveBeenCalledWith(expect.objectContaining({ taskId: t1.id, status: 'CANCELLED' }));

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

    it('retryTask 保留员工、项目、工作区、父任务追溯和批准的执行引擎', () => {
      const agentId = seedAgent(db);
      const projectId = seedProject(db);
      const task = orch.createTask(agentId, '重新生成周报', 'desktop', {
        projectId,
        workspaceOverride: 'D:/project-work',
        inputMessageId: 'message-original',
        engineOverride: 'engine-approved'
      });
      const row = db.tables.tasks.get(task.id)!;
      row.status = 'FAILED';
      row.error = '模型超时';
      row.ended_at = Date.now();

      const retried = orch.retryTask(task.id);
      expect(retried).toMatchObject({
        agentId, projectId, title: task.title, parentId: task.id,
        workspaceOverride: 'D:/project-work', engineOverride: 'engine-approved', inputMessageId: null
      });
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
      const finished = vi.fn();
      orch.onTaskFinished(finished);
      const task = orch.createTask(agentId, '崩溃任务');
      expect(task.status).toBe('RUNNING');

      orch.recoverAfterRestart();
      const after = db.tables.tasks.get(task.id);
      expect(after?.status).toBe('INTERRUPTED');
      expect(after?.error).toBe('客户端异常退出，任务中断');
      expect(finished).toHaveBeenCalledWith(expect.objectContaining({ taskId: task.id, status: 'INTERRUPTED' }));
    });

    it('recoverAfterRestart 取消父任务中断后残留的 QUEUED 委派', () => {
      const parentAgentId = seedAgent(db, { name: '父员工' });
      const childAgentId = seedAgent(db, { name: '子员工', concurrency_limit: 1 });
      const parent = orch.createTask(parentAgentId, '崩溃前父任务');
      orch.createTask(childAgentId, '占用子员工槽位');
      const child = orch.toolHost().createDelegatedTask(childAgentId, '排队中的委派', parent.id);
      const finished = vi.fn();
      orch.onTaskFinished(finished);
      expect(child.status).toBe('QUEUED');

      orch.recoverAfterRestart();

      expect(db.tables.tasks.get(parent.id)?.status).toBe('INTERRUPTED');
      expect(db.tables.tasks.get(child.id)?.status).toBe('CANCELLED');
      expect(finished).toHaveBeenCalledWith(expect.objectContaining({ taskId: child.id, status: 'CANCELLED' }));
      expect([...db.tables.task_events.values()]).toContainEqual(expect.objectContaining({
        task_id: child.id,
        event_type: 'cancelled'
      }));
    });

    it('recoverAfterRestart 在同一恢复事务中取消 RUNNING delegated 后代', () => {
      const parentAgentId = seedAgent(db, { name: '恢复父员工' });
      const childAgentId = seedAgent(db, { name: '恢复子员工' });
      const leafAgentId = seedAgent(db, { name: '恢复末端员工' });
      const parent = orch.createTask(parentAgentId, '崩溃前父任务');
      const child = orch.toolHost().createDelegatedTask(childAgentId, '运行中的委派', parent.id);
      const grandchild = orch.toolHost().createDelegatedTask(leafAgentId, '运行中的孙委派', child.id);
      const finished = vi.fn();
      orch.onTaskFinished(finished);

      orch.recoverAfterRestart();

      expect(db.tables.tasks.get(parent.id)?.status).toBe('INTERRUPTED');
      expect(db.tables.tasks.get(child.id)?.status).toBe('CANCELLED');
      expect(db.tables.tasks.get(grandchild.id)?.status).toBe('CANCELLED');
      expect(finished).toHaveBeenCalledWith(expect.objectContaining({ taskId: child.id, status: 'CANCELLED' }));
      expect(finished).toHaveBeenCalledWith(expect.objectContaining({ taskId: grandchild.id, status: 'CANCELLED' }));
    });

    it('recoverAfterRestart 关闭中断任务的手机租约但保留历史租约', () => {
      const agentId = seedAgent(db);
      const task = orch.createTask(agentId, '带手机租约的崩溃任务');
      const terminalTask = orch.createTask(agentId, '已结束的历史手机任务');
      db.tables.tasks.get(terminalTask.id)!.status = 'COMPLETED';

      const leases = new Map([
        ['stale-lease', { task_id: task.id, status: 'active', ended_at: null }],
        ['history-lease', { task_id: terminalTask.id, status: 'completed', ended_at: 123 }]
      ]);
      const originalPrepare = db.raw.prepare;
      db.raw.prepare = (sql: string) => {
        if (/UPDATE mobile_control_sessions SET status = 'disconnected'/.test(sql)) {
          return {
            get: () => undefined,
            all: () => [],
            run: (endedAt: number, taskId: string) => {
              let changes = 0;
              for (const lease of leases.values()) {
                if (lease.task_id === taskId && lease.status === 'active') {
                  lease.status = 'disconnected';
                  lease.ended_at = endedAt;
                  changes++;
                }
              }
              return { changes };
            }
          };
        }
        return originalPrepare(sql);
      };

      orch.recoverAfterRestart();

      expect(leases.get('stale-lease')).toMatchObject({ status: 'disconnected', ended_at: expect.any(Number) });
      expect(leases.get('history-lease')).toEqual({ task_id: terminalTask.id, status: 'completed', ended_at: 123 });
    });

    it('recoverAfterRestart 保留计划审批，重启后批准仍可派发', () => {
      const agentId = seedAgent(db);
      const { task, approvalId } = createPlanApproval(agentId);
      const restarted = new Orchestrator(db as never, executors, createMockBroker());

      restarted.recoverAfterRestart();

      expect(db.tables.tasks.get(task.id)?.status).toBe('WAITING_APPROVAL');
      expect(db.tables.approvals.get(approvalId)?.status).toBe('pending');
      restarted.decideApproval(approvalId, true);
      expect(db.tables.tasks.get(task.id)?.status).toBe('RUNNING');
      expect(executors.dispatch).toHaveBeenCalledOnce();
    });

    it('recoverAfterRestart 中断运行时工具审批并自动拒绝审批记录', () => {
      const agentId = seedAgent(db);
      const task = orch.createTask(agentId, '运行时工具审批');
      db.tables.tasks.get(task.id)!.status = 'WAITING_APPROVAL';
      db.tables.approvals.set('approval-runtime', {
        id: 'approval-runtime', task_id: task.id, agent_id: agentId,
        type: 'write_workspace', request: '写入工作区', risk: 'medium',
        status: 'pending', created_at: Date.now(), decided_at: null
      });

      orch.recoverAfterRestart();

      expect(db.tables.tasks.get(task.id)?.status).toBe('INTERRUPTED');
      expect(db.tables.approvals.get('approval-runtime')).toMatchObject({
        status: 'rejected', decided_at: expect.any(Number)
      });
      const decision = [...db.tables.task_events.values()].find((event) => event.task_id === task.id && event.event_type === 'approval_decided');
      expect(JSON.parse(decision?.payload as string)).toMatchObject({
        approvalId: 'approval-runtime', scope: 'runtime_tool', approved: false,
        reason: 'runtime_interrupted_on_restart'
      });
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
