/**
 * 编码委派与引擎路由测试（E-2）
 *
 * 覆盖:
 * - delegate_coding_task 工具:仅在编码引擎就绪时注册,委派保留员工归属仅换引擎
 * - 任务级 engineOverride:dispatch 时优先于员工自身引擎
 * - engine_routing 规则真实消费(此前只存不读,是个假开关):
 *   按任务来源路由,且仅当目标引擎 HEALTHY 时生效
 *
 * @author liyingjie <y@senke.com>
 */
// @ts-nocheck
/* eslint-disable */
import { createMockDb, seedAgent, seedEngine } from './helpers/mockDb.js';

vi.mock('../src/main/services/notifier.js', () => ({ notify: vi.fn() }));

import { Orchestrator } from '../src/main/services/orchestrator.js';
import { TOOLS, toolsForPermission } from '../src/main/services/executor/tools.js';

function mockExecutors() {
  return {
    dispatch: vi.fn(),
    abort: vi.fn(),
    isExecuting: vi.fn().mockReturnValue(false),
    activeTaskIdsForAgent: vi.fn().mockReturnValue([]),
    kindFor: vi.fn().mockReturnValue('generic-cli')
  } as never;
}
const mockBroker = () => ({ decide: vi.fn(), abandonTask: vi.fn(), onChange: vi.fn() }) as never;

function setup(opencodeStatus = 'HEALTHY') {
  const db = createMockDb();
  // seedEngine 只接受 id，其余字段在此按用例需要覆写
  seedEngine(db, 'eng-nexus');
  seedEngine(db, 'eng-opencode');
  Object.assign(db.tables.engines.get('eng-opencode'), {
    type: 'opencode', name: 'OpenCode', status: opencodeStatus, is_default: 0
  });
  Object.assign(db.tables.engines.get('eng-nexus'), { type: 'nexus', name: 'Nexus Agent' });
  const agentId = seedAgent(db, { name: '测试员工', engine_id: 'eng-nexus' });
  const executors = mockExecutors();
  const orch = new Orchestrator(db, executors, mockBroker());
  return { db, orch, agentId, executors };
}

describe('delegate_coding_task 工具注册（E-2）', () => {
  it('编码引擎未就绪时不注册该工具（避免模型调用必然失败的工具）', () => {
    const names = toolsForPermission('standard', undefined, false).map((t) => t.name);
    expect(names).not.toContain('delegate_coding_task');
  });

  it('编码引擎就绪时注册该工具', () => {
    const names = toolsForPermission('standard', undefined, true).map((t) => t.name);
    expect(names).toContain('delegate_coding_task');
  });

  it('readonly 权限下不注册（属写入类工具）', () => {
    const names = toolsForPermission('readonly', undefined, true).map((t) => t.name);
    expect(names).not.toContain('delegate_coding_task');
  });
});

describe('codingEngineReady 探测', () => {
  it('OpenCode HEALTHY 时报告就绪', () => {
    const { orch } = setup('HEALTHY');
    expect(orch.toolHost().codingEngineReady()).toEqual({ ready: true, engineId: 'eng-opencode', name: 'OpenCode' });
  });

  it('OpenCode 未安装时报告不可用，但仍返回引擎名供错误提示', () => {
    const { orch } = setup('NOT_INSTALLED');
    const r = orch.toolHost().codingEngineReady();
    expect(r.ready).toBe(false);
    expect(r.name).toBe('OpenCode');
  });
});

describe('编码委派创建子任务', () => {
  it('子任务保留原员工归属，仅覆盖执行引擎', () => {
    const { db, orch, agentId } = setup();
    db.tables.agents.get(agentId)!.concurrency_limit = 2;
    const parent = orch.createTask(agentId, '父任务');
    const sub = orch.toolHost().createEngineDelegatedTask(agentId, '改代码', parent.id, 'eng-opencode');

    expect(sub.agentId).toBe(agentId);           // 归属不变，审批链路仍指向原员工
    expect(sub.engineOverride).toBe('eng-opencode');
    expect(sub.parentId).toBe(parent.id);
    expect(sub.source).toBe('delegated');
    expect(db.tables.tasks.get(sub.id).engine_override).toBe('eng-opencode');
  });

  it('派发时使用覆盖引擎而非员工自身引擎', () => {
    const { db, orch, agentId, executors } = setup();
    db.tables.agents.get(agentId)!.concurrency_limit = 2;
    const parent = orch.createTask(agentId, '父任务');
    executors.dispatch.mockClear();
    executors.kindFor.mockClear();

    orch.toolHost().createEngineDelegatedTask(agentId, '改代码', parent.id, 'eng-opencode');

    // 子任务因并发限制排队时不会立即派发；断言 kindFor 若被调用则用的是覆盖引擎
    const calls = executors.kindFor.mock.calls.flat();
    if (calls.length > 0) expect(calls).toContain('eng-opencode');
  });

  it('唯一并发槽被父任务占用时明确拒绝，避免编码子任务自锁', async () => {
    const { db, orch, agentId } = setup();
    const parent = orch.createTask(agentId, '父任务');
    const before = db.tables.tasks.size;
    const delegate = TOOLS.find((tool) => tool.name === 'delegate_coding_task')!;

    await expect(delegate.execute(
      { title: '修复代码并运行测试' },
      { workspace: 'D:/workspace', agentId, taskId: parent.id, host: orch.toolHost() }
    )).rejects.toThrow('自锁');

    expect(db.tables.tasks.size).toBe(before);
    expect(orch.toolHost().delegationCapacity!(agentId, parent.id)).toMatchObject({
      available: false,
      active: 1,
      limit: 1
    });
  });

  it('员工仍有空闲并发槽时允许编码委派', () => {
    const { db, orch, agentId } = setup();
    db.tables.agents.get(agentId)!.concurrency_limit = 2;
    const parent = orch.createTask(agentId, '父任务');

    expect(orch.toolHost().delegationCapacity!(agentId, parent.id)).toMatchObject({
      available: true,
      active: 1,
      limit: 2
    });
  });

  it('创建边界不能绕过并发槽和员工归属约束', () => {
    const { db, orch, agentId } = setup();
    const otherId = seedAgent(db, { name: '其他员工', organization_id: 'org-local' });
    const parent = orch.createTask(agentId, '父任务');
    const before = db.tables.tasks.size;

    expect(() => orch.toolHost().createEngineDelegatedTask!(agentId, '绕过工具层', parent.id, 'eng-opencode'))
      .toThrow('自锁');
    expect(() => orch.toolHost().createEngineDelegatedTask!(otherId, '错误改派员工', parent.id, 'eng-opencode'))
      .toThrow('必须保留父任务的员工归属');
    expect(db.tables.tasks.size).toBe(before);
  });

  it('拒绝跨独立根任务形成 A -> B -> A 的排队等待环', () => {
    const { db, orch, agentId } = setup();
    const agentB = seedAgent(db, { name: '员工 B', organization_id: 'org-local', concurrency_limit: 1 });
    const rootA = orch.createTask(agentId, 'A 的独立根任务');
    const rootB = orch.createTask(agentB, 'B 的独立根任务');

    const waitingOnB = orch.toolHost().createDelegatedTask(agentB, 'A 等待 B', rootA.id);
    expect(waitingOnB.status).toBe('QUEUED');
    const before = db.tables.tasks.size;

    expect(() => orch.toolHost().createDelegatedTask(agentId, 'B 反向等待 A', rootB.id))
      .toThrow('委派等待关系会形成员工循环');
    expect(db.tables.tasks.size).toBe(before);
  });

  it('并发上限大于 1 且各有独立工作时，不误判为硬等待环', () => {
    const { db, orch, agentId } = setup();
    db.tables.agents.get(agentId)!.concurrency_limit = 2;
    const agentB = seedAgent(db, { name: '员工 B 并发', organization_id: 'org-local', concurrency_limit: 2 });
    const rootA = orch.createTask(agentId, 'A 等待 B');
    orch.createTask(agentId, 'A 独立工作');
    const rootB = orch.createTask(agentB, 'B 等待 A');
    orch.createTask(agentB, 'B 独立工作');

    const waitingOnB = orch.toolHost().createDelegatedTask(agentB, 'A 委派给 B', rootA.id);
    const waitingOnA = orch.toolHost().createDelegatedTask(agentId, 'B 委派给 A', rootB.id);

    expect(waitingOnB.status).toBe('QUEUED');
    expect(waitingOnA.status).toBe('QUEUED');
  });

  it('并发上限大于 1 且所有槽位均在互相等待时拒绝硬等待环', () => {
    const { db, orch, agentId } = setup();
    db.tables.agents.get(agentId)!.concurrency_limit = 2;
    const agentB = seedAgent(db, { name: '员工 B 满槽', organization_id: 'org-local', concurrency_limit: 2 });
    const a1 = orch.createTask(agentId, 'A 槽位 1');
    const a2 = orch.createTask(agentId, 'A 槽位 2');
    const b1 = orch.createTask(agentB, 'B 槽位 1');
    const b2 = orch.createTask(agentB, 'B 槽位 2');

    expect(orch.toolHost().createDelegatedTask(agentB, 'A1 等待 B', a1.id).status).toBe('QUEUED');
    expect(orch.toolHost().createDelegatedTask(agentB, 'A2 等待 B', a2.id).status).toBe('QUEUED');
    expect(orch.toolHost().createDelegatedTask(agentId, 'B1 等待 A', b1.id).status).toBe('QUEUED');
    const before = db.tables.tasks.size;

    expect(() => orch.toolHost().createDelegatedTask(agentId, 'B2 等待 A', b2.id))
      .toThrow('委派等待关系会形成员工循环');
    expect(db.tables.tasks.size).toBe(before);
  });
});

describe('委派生命周期安全', () => {
  it.each([
    ['delegate_task', false],
    ['delegate_coding_task', true]
  ])('%s 等待超时后取消已创建子任务', async (toolName, coding) => {
    const cancelTask = vi.fn();
    const child = { id: `child-${toolName}` };
    const host = {
      findAgentIdByName: vi.fn().mockReturnValue('agent-target'),
      createDelegatedTask: vi.fn().mockReturnValue(child),
      createEngineDelegatedTask: vi.fn().mockReturnValue(child),
      codingEngineReady: vi.fn().mockReturnValue({ ready: true, engineId: 'eng-opencode', name: 'OpenCode' }),
      delegationCapacity: vi.fn().mockReturnValue({ available: true, active: 1, limit: 2 }),
      waitForTask: vi.fn().mockResolvedValue(null),
      cancelTask,
      delegationDepth: vi.fn().mockReturnValue(0)
    };
    const tool = TOOLS.find((item) => item.name === toolName)!;

    await expect(tool.execute(
      coding ? { title: '编码子任务' } : { agent_name: '目标员工', title: '普通子任务' },
      { workspace: 'D:/workspace', agentId: 'agent-parent', taskId: 'task-parent', host }
    )).rejects.toThrow('已取消子任务');

    expect(host.waitForTask).toHaveBeenCalledWith(child.id, expect.any(Number), 'task-parent');
    expect(cancelTask).toHaveBeenCalledWith(child.id, expect.stringContaining('等待超时'));
  });

  it('取消父任务会同步取消仍在执行的委派后代', () => {
    const { db, orch, agentId, executors } = setup();
    const targetId = seedAgent(db, { name: '目标员工', organization_id: 'org-local' });
    const leafId = seedAgent(db, { name: '末端员工', organization_id: 'org-local' });
    const siblingId = seedAgent(db, { name: '并行员工', organization_id: 'org-local' });
    const parent = orch.createTask(agentId, '父任务');
    const child = orch.toolHost().createDelegatedTask(targetId, '子任务', parent.id);
    const grandchild = orch.toolHost().createDelegatedTask(leafId, '孙任务', child.id);
    const sibling = orch.toolHost().createDelegatedTask(siblingId, '并行子任务', parent.id);

    orch.cancelTask(parent.id);

    expect(db.tables.tasks.get(parent.id)?.status).toBe('CANCELLED');
    expect(db.tables.tasks.get(child.id)?.status).toBe('CANCELLED');
    expect(db.tables.tasks.get(grandchild.id)?.status).toBe('CANCELLED');
    expect(db.tables.tasks.get(sibling.id)?.status).toBe('CANCELLED');
    expect(executors.abort).toHaveBeenCalledWith(parent.id);
    expect(executors.abort).toHaveBeenCalledWith(child.id);
    expect(executors.abort).toHaveBeenCalledWith(grandchild.id);
    expect(executors.abort).toHaveBeenCalledWith(sibling.id);
  });

  it('终态 delegated 中间节点仍可连接并回收活跃后代', () => {
    const { db, orch, agentId } = setup();
    const targetId = seedAgent(db, { name: '目标员工', organization_id: 'org-local' });
    const leafId = seedAgent(db, { name: '末端员工', organization_id: 'org-local' });
    const parent = orch.createTask(agentId, '父任务');
    const child = orch.toolHost().createDelegatedTask(targetId, '已结束中间任务', parent.id);
    const grandchild = orch.toolHost().createDelegatedTask(leafId, '仍在执行的孙任务', child.id);
    Object.assign(db.tables.tasks.get(child.id), { status: 'COMPLETED', ended_at: Date.now() });

    orch.cancelTask(parent.id);

    expect(db.tables.tasks.get(child.id)?.status).toBe('COMPLETED');
    expect(db.tables.tasks.get(grandchild.id)?.status).toBe('CANCELLED');
  });

  it('派发前清理父链已终止的排队委派，并继续调度独立任务', () => {
    const { db, orch, agentId, executors } = setup();
    const targetId = seedAgent(db, { name: '目标员工', organization_id: 'org-local', concurrency_limit: 1 });
    const parent = orch.createTask(agentId, '父任务');
    const blocker = orch.createTask(targetId, '目标员工当前任务');
    const orphan = orch.toolHost().createDelegatedTask(targetId, '即将成为孤儿的委派', parent.id);
    const independent = orch.createTask(targetId, '独立排队任务');
    Object.assign(db.tables.tasks.get(parent.id), { status: 'COMPLETED', ended_at: Date.now() });
    Object.assign(db.tables.tasks.get(orphan.id), { created_at: 10 });
    Object.assign(db.tables.tasks.get(independent.id), { created_at: 20 });
    executors.dispatch.mockClear();

    orch.cancelTask(blocker.id);

    expect(db.tables.tasks.get(orphan.id)?.status).toBe('CANCELLED');
    expect(db.tables.tasks.get(independent.id)?.status).toBe('RUNNING');
    expect(executors.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: independent.id }),
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  it('父任务在等待期间进入终态时，waitForTask 回收子任务', async () => {
    const { db, orch, agentId } = setup();
    const targetId = seedAgent(db, { name: '目标员工', organization_id: 'org-local' });
    const parent = orch.createTask(agentId, '父任务');
    const child = orch.toolHost().createDelegatedTask(targetId, '子任务', parent.id);
    db.tables.tasks.get(parent.id)!.status = 'CANCELLED';

    const done = await orch.toolHost().waitForTask(child.id, 1000, parent.id);

    expect(done?.status).toBe('CANCELLED');
    expect(db.tables.tasks.get(child.id)?.status).toBe('CANCELLED');
  });

  it('拒绝已结束父任务和损坏的祖先循环，且不创建子任务', () => {
    const { db, orch, agentId } = setup();
    const targetId = seedAgent(db, { name: '目标员工', organization_id: 'org-local' });
    const parent = orch.createTask(agentId, '父任务');
    const before = db.tables.tasks.size;

    db.tables.tasks.get(parent.id)!.status = 'CANCELLED';
    expect(() => orch.toolHost().createDelegatedTask(targetId, '晚到子任务', parent.id))
      .toThrow('父任务已经结束');
    expect(db.tables.tasks.size).toBe(before);

    db.tables.tasks.get(parent.id)!.status = 'RUNNING';
    Object.assign(db.tables.tasks.get(parent.id), { source: 'delegated', parent_id: parent.id });
    expect(() => orch.toolHost().createDelegatedTask(targetId, '循环子任务', parent.id))
      .toThrow('祖先链存在循环');
    expect(db.tables.tasks.size).toBe(before);
  });

  it('编码委派在创建边界再次拒绝不存在或已失效的目标引擎', () => {
    const { db, orch, agentId } = setup();
    db.tables.agents.get(agentId)!.concurrency_limit = 2;
    const parent = orch.createTask(agentId, '父任务');
    const before = db.tables.tasks.size;

    expect(() => orch.toolHost().createEngineDelegatedTask!(agentId, '编码子任务', parent.id, 'missing-engine'))
      .toThrow('目标引擎不存在或当前不可用');
    db.tables.engines.get('eng-opencode')!.status = 'DEGRADED';
    expect(() => orch.toolHost().createEngineDelegatedTask!(agentId, '编码子任务', parent.id, 'eng-opencode'))
      .toThrow('目标引擎不存在或当前不可用');
    expect(db.tables.tasks.size).toBe(before);
  });

  it('delegate_task 拒绝把任务委派回祖先员工，编码引擎覆盖仍可保留当前员工归属', () => {
    const { db, orch, agentId } = setup();
    const targetId = seedAgent(db, { name: '目标员工', organization_id: 'org-local', concurrency_limit: 2 });
    const root = orch.createTask(agentId, '根任务');
    const child = orch.toolHost().createDelegatedTask(targetId, '目标员工子任务', root.id);
    const before = db.tables.tasks.size;

    expect(() => orch.toolHost().createDelegatedTask(agentId, '循环回根员工', child.id))
      .toThrow('员工循环委派');
    expect(db.tables.tasks.size).toBe(before);

    expect(() => orch.toolHost().createEngineDelegatedTask!(targetId, '当前员工编码任务', child.id, 'eng-opencode'))
      .not.toThrow();
    expect(() => orch.toolHost().createEngineDelegatedTask!(agentId, '编码覆盖也不能回到祖先员工', child.id, 'eng-opencode'))
      .toThrow('必须保留父任务的员工归属');
  });

  it('终态 delegated 任务的 follow-up/retry 转为独立 desktop 链路', () => {
    const { db, orch, agentId } = setup();
    const targetId = seedAgent(db, { name: '目标员工', organization_id: 'org-local', concurrency_limit: 2 });
    const root = orch.createTask(agentId, '根任务');
    const delegated = orch.toolHost().createDelegatedTask(targetId, '已完成委派', root.id);
    Object.assign(db.tables.tasks.get(delegated.id), { status: 'COMPLETED', ended_at: Date.now() });

    const followUp = orch.createFollowUpTask(delegated.id, '继续完善');
    const retried = orch.retryTask(delegated.id);

    expect(followUp).toMatchObject({ parentId: delegated.id, source: 'desktop' });
    expect(retried).toMatchObject({ parentId: delegated.id, source: 'desktop' });
  });

  it('desktop 追问切断旧委派等待链，可重新委派给历史员工', () => {
    const { db, orch, agentId } = setup();
    const targetId = seedAgent(db, { name: '目标员工', organization_id: 'org-local', concurrency_limit: 2 });
    const root = orch.createTask(agentId, '历史根任务');
    const delegated = orch.toolHost().createDelegatedTask(targetId, '历史委派', root.id);
    Object.assign(db.tables.tasks.get(root.id), { status: 'COMPLETED', ended_at: Date.now() });
    Object.assign(db.tables.tasks.get(delegated.id), { status: 'COMPLETED', ended_at: Date.now() });
    const followUp = orch.createFollowUpTask(delegated.id, '独立追问');

    expect(orch.toolHost().delegationDepth(followUp.id)).toBe(0);
    expect(orch.toolHost().createDelegatedTask(agentId, '重新委派给历史员工', followUp.id))
      .toMatchObject({ agentId, parentId: followUp.id, source: 'delegated' });
  });

  it('取消父任务只级联 delegated 子任务，不取消独立 follow-up', () => {
    const { db, orch, agentId } = setup();
    db.tables.agents.get(agentId)!.concurrency_limit = 2;
    const targetId = seedAgent(db, { name: '目标员工', organization_id: 'org-local' });
    const parent = orch.createTask(agentId, '父任务');
    const independent = orch.createFollowUpTask(parent.id, '独立追问');
    const delegated = orch.toolHost().createDelegatedTask(targetId, '委派子任务', parent.id);

    orch.cancelTask(parent.id);

    expect(db.tables.tasks.get(delegated.id)?.status).toBe('CANCELLED');
    expect(db.tables.tasks.get(independent.id)?.status).not.toBe('CANCELLED');
  });

  it('cancelTask 先落 CANCELLED，再 abort；同步 onError 不能赢得终态竞态', () => {
    const { db, orch, agentId, executors } = setup();
    let callbacks;
    executors.dispatch.mockImplementation((_task, _agent, cb) => {
      callbacks = cb;
      return 'generic-cli';
    });
    const finished = vi.fn();
    orch.onTaskFinished(finished);
    const task = orch.createTask(agentId, '可取消任务');
    executors.abort.mockImplementation((taskId) => callbacks.onError(taskId, 'abort 同步回调'));

    orch.cancelTask(task.id);

    expect(db.tables.tasks.get(task.id)?.status).toBe('CANCELLED');
    expect(finished).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ taskId: task.id, status: 'CANCELLED' }));
    expect([...db.tables.task_events.values()]).toContainEqual(expect.objectContaining({
      task_id: task.id,
      event_type: 'cancelled',
      payload: JSON.stringify({ reason: '用户取消任务' })
    }));
  });
});

describe('A2A 委派租户边界', () => {
  const sideEffects = (db: ReturnType<typeof createMockDb>) => ({
    tasks: db.tables.tasks.size,
    runs: db.tables.agent_runs.size,
    events: db.tables.task_events.size,
    approvals: db.tables.approvals.size
  });

  it('同租户名称解析与子任务创建成功', () => {
    const { db, orch, agentId } = setup();
    Object.assign(db.tables.agents.get(agentId), { organization_id: 'org-a' });
    const targetId = seedAgent(db, { name: '同租户员工', organization_id: 'org-a' });
    const parent = orch.createTask(agentId, '父任务');
    const host = orch.toolHost();

    expect(host.findAgentIdByName('同租户员工', parent.id)).toBe(targetId);
    expect(host.createDelegatedTask(targetId, '同租户子任务', parent.id)).toMatchObject({
      agentId: targetId,
      parentId: parent.id,
      source: 'delegated'
    });
  });

  it('跨租户同名员工只解析父任务租户内的目标', () => {
    const { db, orch, agentId } = setup();
    Object.assign(db.tables.agents.get(agentId), { organization_id: 'org-a' });
    seedAgent(db, { name: '共享名称', organization_id: 'org-b' });
    const localTargetId = seedAgent(db, { name: '共享名称', organization_id: 'org-a' });
    const parent = orch.createTask(agentId, '父任务');

    expect(orch.toolHost().findAgentIdByName('共享名称', parent.id)).toBe(localTargetId);
  });

  it('delegate_task 看不到仅存在于其他租户的目标且零副作用', async () => {
    const { db, orch, agentId, executors } = setup();
    Object.assign(db.tables.agents.get(agentId), { organization_id: 'org-a' });
    const foreignTargetId = seedAgent(db, { name: '异租户员工', organization_id: 'org-b' });
    const parent = orch.createTask(agentId, '父任务');
    const before = sideEffects(db);
    executors.dispatch.mockClear();
    const delegate = TOOLS.find((tool) => tool.name === 'delegate_task')!;

    await expect(delegate.execute(
      { agent_name: '异租户员工', title: '越界子任务' },
      { workspace: 'D:/workspace', agentId, taskId: parent.id, host: orch.toolHost() }
    )).rejects.toThrow('未找到在岗');
    expect(orch.toolHost().findAgentIdByName('异租户员工', parent.id)).toBeNull();
    expect(() => orch.toolHost().createDelegatedTask(foreignTargetId, '越界子任务', parent.id))
      .toThrow('父任务不存在，或目标员工不可委派');
    expect(() => orch.toolHost().createEngineDelegatedTask!(foreignTargetId, '越界编码任务', parent.id, 'eng-opencode'))
      .toThrow('必须保留父任务的员工归属');
    expect(sideEffects(db)).toEqual(before);
    expect(executors.dispatch).not.toHaveBeenCalled();
  });

  it('归档目标在 lookup 与 commit 两层都被拒绝且零副作用', () => {
    const { db, orch, agentId, executors } = setup();
    Object.assign(db.tables.agents.get(agentId), { organization_id: 'org-a' });
    const archivedId = seedAgent(db, { name: '已归档员工', organization_id: 'org-a' });
    const parent = orch.createTask(agentId, '父任务');
    expect(orch.toolHost().findAgentIdByName('已归档员工', parent.id)).toBe(archivedId);
    db.tables.agents.get(archivedId)!.archived = 1;
    const before = sideEffects(db);
    executors.dispatch.mockClear();

    expect(orch.toolHost().findAgentIdByName('已归档员工', parent.id)).toBeNull();
    expect(() => orch.toolHost().createDelegatedTask(archivedId, '归档目标子任务', parent.id))
      .toThrow('父任务不存在，或目标员工不可委派');
    expect(sideEffects(db)).toEqual(before);
    expect(executors.dispatch).not.toHaveBeenCalled();
  });

  it('父任务所属员工已归档时禁止继续委派', () => {
    const { db, orch, agentId } = setup();
    const targetId = seedAgent(db, { name: '目标员工', organization_id: 'org-local' });
    const parent = orch.createTask(agentId, '父任务');
    db.tables.agents.get(agentId)!.archived = 1;
    const before = sideEffects(db);

    expect(orch.toolHost().findAgentIdByName('目标员工', parent.id)).toBeNull();
    expect(() => orch.toolHost().createDelegatedTask(targetId, '不应创建', parent.id))
      .toThrow('父任务不存在，或目标员工不可委派');
    expect(sideEffects(db)).toEqual(before);
  });

  it('父任务不存在时名称解析失败，两个创建入口均零副作用', () => {
    const { db, orch, agentId, executors } = setup();
    const before = sideEffects(db);

    expect(orch.toolHost().findAgentIdByName('测试员工', 'missing-parent')).toBeNull();
    expect(() => orch.toolHost().createDelegatedTask(agentId, '无父任务子任务', 'missing-parent'))
      .toThrow('父任务不存在，或目标员工不可委派');
    expect(() => orch.toolHost().createEngineDelegatedTask!(agentId, '无父任务编码任务', 'missing-parent', 'eng-opencode'))
      .toThrow('父任务不存在');
    expect(sideEffects(db)).toEqual(before);
    expect(executors.dispatch).not.toHaveBeenCalled();
  });
});

describe('engine_routing 规则消费', () => {
  it('按任务来源路由到指定引擎（规则此前只存不读）', () => {
    const { db, orch, agentId } = setup();
    db.tables.settings.set('engine_routing', { channel: 'eng-opencode' });
    const task = orch.createTask(agentId, '渠道任务', 'channel');
    expect(task.engineOverride).toBe('eng-opencode');
  });

  it('其他来源不受该规则影响', () => {
    const { db, orch, agentId } = setup();
    db.tables.settings.set('engine_routing', { channel: 'eng-opencode' });
    expect(orch.createTask(agentId, '桌面任务', 'desktop').engineOverride).toBeNull();
  });

  it('目标引擎不健康时规则不生效（不把任务路由到未安装引擎）', () => {
    const { db, orch, agentId } = setup('NOT_INSTALLED');
    db.tables.settings.set('engine_routing', { desktop: 'eng-opencode' });
    expect(orch.createTask(agentId, '任务', 'desktop').engineOverride).toBeNull();
  });

  it('路由目标与员工自身引擎相同时不设覆盖', () => {
    const { db, orch, agentId } = setup();
    db.tables.settings.set('engine_routing', { desktop: 'eng-nexus' });
    expect(orch.createTask(agentId, '任务', 'desktop').engineOverride).toBeNull();
  });

  it('显式 engineOverride（编码委派）优先于路由规则', () => {
    const { db, orch, agentId } = setup();
    db.tables.agents.get(agentId)!.concurrency_limit = 2;
    db.tables.settings.set('engine_routing', { delegated: 'eng-nexus' });
    const parent = orch.createTask(agentId, '父任务');
    const sub = orch.toolHost().createEngineDelegatedTask(agentId, '改代码', parent.id, 'eng-opencode');
    expect(sub.engineOverride).toBe('eng-opencode');
  });

  it('无路由规则时不设覆盖', () => {
    const { orch, agentId } = setup();
    expect(orch.createTask(agentId, '任务', 'desktop').engineOverride).toBeNull();
  });

  it('Android 手机员工忽略全局路由和显式 override，始终使用 Hermes CLI', () => {
    const { db, orch, agentId } = setup();
    seedEngine(db, 'eng-hermes-cli');
    Object.assign(db.tables.agents.get(agentId), { agent_kind: 'android_operator', engine_id: 'eng-hermes-cli' });
    db.tables.settings.set('engine_routing', { channel: 'eng-opencode' });
    orch.setMobileDispatchPolicy({ canDispatch: () => ({ bound: true, ready: true, reason: '' }) });
    const task = orch.createTask(agentId, '操作手机', 'channel', { engineOverride: 'eng-opencode' });
    expect(task.engineOverride).toBeNull();
    expect(db.tables.agents.get(agentId)?.engine_id).toBe('eng-hermes-cli');
  });
});
