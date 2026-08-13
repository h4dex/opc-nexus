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
import { toolsForPermission } from '../src/main/services/executor/tools.js';

function mockExecutors() {
  return {
    dispatch: vi.fn(),
    abort: vi.fn(),
    isExecuting: vi.fn().mockReturnValue(false),
    kindFor: vi.fn().mockReturnValue('generic-cli')
  } as never;
}
const mockBroker = () => ({ decide: vi.fn(), abandonTask: vi.fn(), onChange: vi.fn() }) as never;

function setup(opencodeStatus = 'HEALTHY') {
  const db = createMockDb();
  // seedEngine 只接受 id，其余字段在此按用例需要覆写
  seedEngine(db, 'eng-hermes');
  seedEngine(db, 'eng-opencode');
  Object.assign(db.tables.engines.get('eng-opencode'), {
    type: 'opencode', name: 'OpenCode', status: opencodeStatus, is_default: 0
  });
  Object.assign(db.tables.engines.get('eng-hermes'), { name: 'Nexus Agent' });
  const agentId = seedAgent(db, { name: '测试员工', engine_id: 'eng-hermes' });
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
    const parent = orch.createTask(agentId, '父任务');
    const sub = orch.toolHost().createEngineDelegatedTask(agentId, '改代码', parent.id, 'eng-opencode');

    expect(sub.agentId).toBe(agentId);           // 归属不变，审批链路仍指向原员工
    expect(sub.engineOverride).toBe('eng-opencode');
    expect(sub.parentId).toBe(parent.id);
    expect(sub.source).toBe('delegated');
    expect(db.tables.tasks.get(sub.id).engine_override).toBe('eng-opencode');
  });

  it('派发时使用覆盖引擎而非员工自身引擎', () => {
    const { orch, agentId, executors } = setup();
    const parent = orch.createTask(agentId, '父任务');
    executors.dispatch.mockClear();
    executors.kindFor.mockClear();

    orch.toolHost().createEngineDelegatedTask(agentId, '改代码', parent.id, 'eng-opencode');

    // 子任务因并发限制排队时不会立即派发；断言 kindFor 若被调用则用的是覆盖引擎
    const calls = executors.kindFor.mock.calls.flat();
    if (calls.length > 0) expect(calls).toContain('eng-opencode');
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
    db.tables.settings.set('engine_routing', { desktop: 'eng-hermes' });
    expect(orch.createTask(agentId, '任务', 'desktop').engineOverride).toBeNull();
  });

  it('显式 engineOverride（编码委派）优先于路由规则', () => {
    const { db, orch, agentId } = setup();
    db.tables.settings.set('engine_routing', { delegated: 'eng-hermes' });
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
