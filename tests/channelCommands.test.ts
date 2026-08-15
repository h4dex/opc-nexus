/**
 * 渠道对话指令(tryChannelCommand)与看门狗测试
 * 指令是防长任务卡死/死循环的人工干预入口(P4)
 */
// @ts-nocheck
/* eslint-disable */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createMockDb, seedAgent, seedEngine } from './helpers/mockDb.js';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));
vi.mock('../src/main/services/notifier.js', () => ({ notify: vi.fn() }));

const userCfg = {
  wecom: { botId: '', secret: '', webhookUrl: '' },
  engine: { fallbackEngineId: 'eng-opencode', executionMode: 'demo' },
  task: { maxRunMinutes: 30 }
};
vi.mock('../src/main/services/userConfig.js', () => ({
  loadUserConfig: () => userCfg
}));

import { dispatchChannelTask, tryChannelApproval, tryChannelCommand } from '../src/main/services/channels/common.js';
import { buildChannelMessageDedupeKey, ChannelIngressService } from '../src/main/services/channelIngressService.js';
import { Orchestrator } from '../src/main/services/orchestrator.js';

function createMockExecutors() {
  return {
    dispatch: vi.fn(),
    abort: vi.fn(),
    isExecuting: vi.fn().mockReturnValue(false),
    activeTaskIdsForAgent: vi.fn().mockReturnValue([]),
    kindFor: vi.fn().mockReturnValue('simulated')
  };
}

function createMockBroker() {
  return { decide: vi.fn().mockReturnValue(false), abandonTask: vi.fn(), onChange: vi.fn() };
}

function setup() {
  const db = createMockDb();
  seedEngine(db);
  const agentId = seedAgent(db, { organization_id: 'org-local' });
  const executors = createMockExecutors();
  const orch = new Orchestrator(db, executors, createMockBroker());
  // 绑定渠道路由
  db.tables.channels.set('ch-test', { id: 'ch-test', organization_id: 'org-local' });
  db.tables.channel_routes.set('route-1', { id: 'route-1', channel_id: 'ch-test', conversation_key: '*', agent_id: agentId, policy: '{}' });
  const ingress = new ChannelIngressService(db).ingest({
    channelId: 'ch-test', agentId, externalIdentity: 'control-user',
    conversationKey: 'control-conversation', messageKey: 'control-seed', text: 'seed'
  });
  const controlScope = { agentId, conversationId: ingress.conversationId };
  return { db, orch, agentId, executors, controlScope };
}

function taskPlannerFor(orch: Orchestrator) {
  return {
    dispatch: ({ ingress, message, preferredAgentId }) => Promise.resolve(orch.createTask(
      preferredAgentId,
      message.slice(0, 200),
      'channel',
      {
        sourceKey: ingress.dedupeKey,
        sessionId: `conv-${ingress.conversationId}`,
        conversationId: ingress.conversationId,
        inputMessageId: ingress.messageId,
        content: message
      }
    ))
  };
}

function failFirstControlReceiptCompletion(db: ReturnType<typeof createMockDb>): void {
  const prepare = db.raw.prepare;
  let failed = false;
  db.raw.prepare = (sql: string) => {
    const statement = prepare(sql);
    if (!/UPDATE messages SET content = \?, metadata_json = \?/.test(sql)) return statement;
    return {
      ...statement,
      run: (...args: unknown[]) => {
        if (!failed) {
          failed = true;
          throw new Error('simulated crash before control receipt completion');
        }
        return statement.run(...args);
      }
    };
  };
}

function onlyControlReceipt(db: ReturnType<typeof createMockDb>): Record<string, unknown> {
  const rows = [...db.tables.messages.values()].filter((row) => String(row.external_message_key).startsWith('control:'));
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe('tryChannelCommand', () => {
  it('非指令文本不拦截', () => {
    const { db, orch, controlScope } = setup();
    const ack = vi.fn();
    expect(tryChannelCommand(db, orch, controlScope, '帮我写一份周报', ack)).toBe(false);
    expect(ack).not.toHaveBeenCalled();
  });

  it('/帮助 返回指令说明', () => {
    const { db, orch, controlScope } = setup();
    const ack = vi.fn();
    expect(tryChannelCommand(db, orch, controlScope, '/帮助', ack)).toBe(true);
    expect(ack).toHaveBeenCalledWith(expect.stringContaining('/取消'));
  });

  it('/状态 无任务时提示空闲', () => {
    const { db, orch, controlScope } = setup();
    const ack = vi.fn();
    expect(tryChannelCommand(db, orch, controlScope, '/状态', ack)).toBe(true);
    expect(ack).toHaveBeenCalledWith('当前没有执行中的任务。');
  });

  it('/状态 列出执行中任务与进度', () => {
    const { db, orch, agentId, controlScope } = setup();
    orch.createTask(agentId, '生成月度报表', 'channel', { conversationId: controlScope.conversationId });
    const ack = vi.fn();
    tryChannelCommand(db, orch, controlScope, '/状态', ack);
    expect(ack).toHaveBeenCalledWith(expect.stringContaining('生成月度报表'));
    expect(ack).toHaveBeenCalledWith(expect.stringContaining('执行中'));
  });

  it('/取消 终止当前任务(防死循环干预)', () => {
    const { db, orch, agentId, executors, controlScope } = setup();
    const task = orch.createTask(agentId, '疑似死循环任务', 'channel', { conversationId: controlScope.conversationId });
    const ack = vi.fn();
    tryChannelCommand(db, orch, controlScope, '/取消', ack);
    expect(executors.abort).toHaveBeenCalledWith(task.id);
    expect(db.tables.tasks.get(task.id).status).toBe('CANCELLED');
    expect(ack).toHaveBeenCalledWith(expect.stringContaining('已终止'));
  });

  it('/取消 全部 终止全部活跃任务', () => {
    const { db, orch, agentId, controlScope } = setup();
    const t1 = orch.createTask(agentId, '任务一', 'channel', { conversationId: controlScope.conversationId });
    const t2 = orch.createTask(agentId, '任务二', 'channel', { conversationId: controlScope.conversationId }); // 并发 1 → t2 QUEUED
    const ack = vi.fn();
    tryChannelCommand(db, orch, controlScope, '/取消 全部', ack);
    expect(db.tables.tasks.get(t1.id).status).toBe('CANCELLED');
    expect(db.tables.tasks.get(t2.id).status).toBe('CANCELLED');
  });

  it('/暂停 与 /继续 往返', () => {
    const { db, orch, agentId, controlScope } = setup();
    const task = orch.createTask(agentId, '可暂停任务', 'channel', { conversationId: controlScope.conversationId });
    const ack = vi.fn();
    tryChannelCommand(db, orch, controlScope, '/暂停', ack);
    expect(db.tables.tasks.get(task.id).status).toBe('PAUSED');
    tryChannelCommand(db, orch, controlScope, '/继续', ack);
    expect(db.tables.tasks.get(task.id).status).toBe('RUNNING');
  });

  it('控制指令只能影响当前 canonical conversation 的渠道任务', () => {
    const { db, orch, agentId, controlScope } = setup();
    const otherIngress = new ChannelIngressService(db).ingest({
      channelId: 'ch-test', agentId, externalIdentity: 'other-user',
      conversationKey: 'control-conversation', messageKey: 'other-seed', text: 'seed'
    });
    const own = orch.createTask(agentId, '当前用户任务', 'channel', { conversationId: controlScope.conversationId });
    const other = orch.createTask(agentId, '其他用户任务', 'channel', { conversationId: otherIngress.conversationId });

    tryChannelCommand(db, orch, controlScope, '/取消 全部', vi.fn());

    expect(db.tables.tasks.get(own.id).status).toBe('CANCELLED');
    expect(db.tables.tasks.get(other.id).status).not.toBe('CANCELLED');
  });

  it('未知指令回复帮助', () => {
    const { db, orch, controlScope } = setup();
    const ack = vi.fn();
    expect(tryChannelCommand(db, orch, controlScope, '/乱写', ack)).toBe(true);
    expect(ack).toHaveBeenCalledWith(expect.stringContaining('未识别的指令'));
  });
});

describe('tryChannelApproval', () => {
  it('routes channel decisions through Orchestrator so task state and audit stay consistent', () => {
    const { db, orch, agentId, controlScope } = setup();
    const task = orch.createTask(agentId, '等待渠道审批', 'channel', { conversationId: controlScope.conversationId });
    const taskRow = db.tables.tasks.get(task.id)!;
    taskRow.status = 'WAITING_APPROVAL';
    db.tables.approvals.set('approval-channel', {
      id: 'approval-channel', task_id: task.id, agent_id: agentId, type: 'write',
      request: '写入项目文件', risk: 'medium', status: 'pending', created_at: Date.now(), decided_at: null
    });
    const decide = vi.spyOn(orch, 'decideApproval');
    const ack = vi.fn();

    expect(tryChannelApproval(db, orch, controlScope, '批准', ack)).toBe(true);

    expect(decide).toHaveBeenCalledWith('approval-channel', true);
    expect(db.tables.approvals.get('approval-channel')).toMatchObject({ status: 'approved', decided_at: expect.any(Number) });
    expect(taskRow.status).toBe('RUNNING');
    expect(ack).toHaveBeenCalledWith(expect.stringContaining('已批准'));
  });
});

describe('dispatchChannelTask 幂等', () => {
  it('控制消息先持久化身份，并以 durable receipt 防止重复执行', async () => {
    const { db, orch, agentId, controlScope } = setup();
    const task = orch.createTask(agentId, '仅取消一次', 'channel', { conversationId: controlScope.conversationId });
    const cancel = vi.spyOn(orch, 'cancelTask');
    const taskPlanner = { dispatch: vi.fn() };
    const ack = vi.fn();
    const input = {
      db,
      orchestrator: orch,
      taskPlanner,
      channelId: 'ch-test',
      text: '/取消',
      externalIdentity: 'control-user',
      conversationKey: 'control-conversation',
      sourceKey: 'control-cancel-1',
      ack,
      final: vi.fn()
    };

    await dispatchChannelTask(input);
    await dispatchChannelTask(input);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(task.id);
    expect(taskPlanner.dispatch).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(2);
    expect(ack.mock.calls[1][0]).toBe(ack.mock.calls[0][0]);
    expect([...db.tables.messages.values()].filter((row) => row.external_message_key?.startsWith('control:'))).toHaveLength(1);
  });

  it('审批副作用后回执完成失败时，重投只协调原审批而不选择更新审批', async () => {
    const { db, orch, agentId, controlScope } = setup();
    const taskA = orch.createTask(agentId, '审批 A', 'channel', { conversationId: controlScope.conversationId });
    db.tables.tasks.get(taskA.id).status = 'WAITING_APPROVAL';
    db.tables.approvals.set('approval-a', {
      id: 'approval-a', task_id: taskA.id, agent_id: agentId, type: 'write', request: '写入 A', risk: 'medium',
      status: 'pending', created_at: 100, decided_at: null
    });
    const decide = vi.spyOn(orch, 'decideApproval');
    failFirstControlReceiptCompletion(db);
    const ack = vi.fn();
    const input = {
      db,
      orchestrator: orch,
      taskPlanner: { dispatch: vi.fn() },
      channelId: 'ch-test',
      text: '批准',
      externalIdentity: 'control-user',
      conversationKey: 'control-conversation',
      sourceKey: 'approval-replay-1',
      ack,
      final: vi.fn()
    };

    expect(await dispatchChannelTask(input)).toBe(false);
    expect(db.tables.approvals.get('approval-a').status).toBe('approved');
    expect(JSON.parse(String(onlyControlReceipt(db).metadata_json))).toMatchObject({
      status: 'CLAIMED',
      action: { kind: 'approval', approvalId: 'approval-a', approve: true }
    });

    const taskB = orch.createTask(agentId, '审批 B', 'channel', { conversationId: controlScope.conversationId });
    db.tables.tasks.get(taskB.id).status = 'WAITING_APPROVAL';
    db.tables.approvals.set('approval-b', {
      id: 'approval-b', task_id: taskB.id, agent_id: agentId, type: 'write', request: '写入 B', risk: 'medium',
      status: 'pending', created_at: 200, decided_at: null
    });

    expect(await dispatchChannelTask(input)).toBe(true);
    expect(await dispatchChannelTask(input)).toBe(true);

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith('approval-a', true);
    expect(db.tables.approvals.get('approval-b').status).toBe('pending');
    expect(JSON.parse(String(onlyControlReceipt(db).metadata_json))).toMatchObject({ status: 'COMPLETED' });
    expect(ack.mock.calls[2][0]).toBe(ack.mock.calls[1][0]);
  });

  it('取消副作用后回执完成失败时，重投只协调原任务而不取消更新任务', async () => {
    const { db, orch, agentId, controlScope } = setup();
    const taskA = orch.createTask(agentId, '取消目标 A', 'channel', { conversationId: controlScope.conversationId });
    const cancel = vi.spyOn(orch, 'cancelTask');
    failFirstControlReceiptCompletion(db);
    const ack = vi.fn();
    const input = {
      db,
      orchestrator: orch,
      taskPlanner: { dispatch: vi.fn() },
      channelId: 'ch-test',
      text: '/取消',
      externalIdentity: 'control-user',
      conversationKey: 'control-conversation',
      sourceKey: 'cancel-replay-1',
      ack,
      final: vi.fn()
    };

    expect(await dispatchChannelTask(input)).toBe(false);
    expect(db.tables.tasks.get(taskA.id).status).toBe('CANCELLED');
    expect(JSON.parse(String(onlyControlReceipt(db).metadata_json))).toMatchObject({
      status: 'CLAIMED',
      action: { kind: 'cancel', taskIds: [taskA.id] }
    });

    const taskB = orch.createTask(agentId, '后来的活跃任务 B', 'channel', { conversationId: controlScope.conversationId });
    expect(db.tables.tasks.get(taskB.id).status).toBe('RUNNING');

    expect(await dispatchChannelTask(input)).toBe(true);
    expect(await dispatchChannelTask(input)).toBe(true);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(taskA.id);
    expect(db.tables.tasks.get(taskB.id).status).toBe('RUNNING');
    expect(JSON.parse(String(onlyControlReceipt(db).metadata_json))).toMatchObject({ status: 'COMPLETED' });
    expect(ack.mock.calls[2][0]).toBe(ack.mock.calls[1][0]);
  });

  it('相同渠道消息只派发和轮询一次', async () => {
    vi.useFakeTimers();
    try {
      const { db, orch, executors } = setup();
      const ack = vi.fn();
      const final = vi.fn();
      const message = {
        db,
        orchestrator: orch,
        taskPlanner: taskPlannerFor(orch),
        channelId: 'ch-test',
        text: '整理客户反馈',
        sourceKey: 'message:101',
        ack,
        final
      };

      await dispatchChannelTask(message);
      await dispatchChannelTask(message);

      expect(db.tables.tasks.size).toBe(1);
      expect([...db.tables.tasks.values()][0].source_key).toBe(buildChannelMessageDedupeKey({
        organizationKey: 'local',
        channelId: 'ch-test',
        externalIdentity: 'anonymous:ch-test',
        conversationKey: '*',
        direction: 'inbound',
        messageKey: 'message:101'
      }));
      expect(executors.dispatch).toHaveBeenCalledTimes(1);
      expect(ack).toHaveBeenCalledTimes(2);
      expect(final).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('进程重启后的重投会补发已有任务终态而不重复执行', async () => {
    const { db, orch, agentId, executors } = setup();
    const existing = orch.createTask(agentId, '整理客户反馈', 'channel', { sourceKey: 'ch-test:message:replayed' });
    const row = db.tables.tasks.get(existing.id);
    Object.assign(row, { status: 'COMPLETED', result: '已整理 12 条反馈' });
    executors.dispatch.mockClear();
    const ack = vi.fn();
    const final = vi.fn();

    await dispatchChannelTask({
      db,
      orchestrator: orch,
      taskPlanner: taskPlannerFor(orch),
      channelId: 'ch-test',
      text: '整理客户反馈',
      sourceKey: 'message:replayed',
      ack,
      final
    });

    expect(db.tables.tasks.size).toBe(1);
    expect(executors.dispatch).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(final).toHaveBeenCalledWith(expect.stringContaining('已整理 12 条反馈'));
  });

  it('精确会话路由优先于渠道默认路由', async () => {
    vi.useFakeTimers();
    try {
      const { db, orch, executors } = setup();
      const exactAgentId = seedAgent(db, { name: '精确会话员工', organization_id: 'org-local' });
      db.tables.channel_routes.set('route-exact', {
        id: 'route-exact', channel_id: 'ch-test', conversation_key: 'group:vip',
        agent_id: exactAgentId, policy: '{}'
      });

      await dispatchChannelTask({
        db,
        orchestrator: orch,
        taskPlanner: taskPlannerFor(orch),
        channelId: 'ch-test',
        text: '处理 VIP 群任务',
        externalIdentity: 'user-1',
        conversationKey: 'group:vip',
        sourceKey: 'message:exact-route',
        ack: vi.fn(),
        final: vi.fn()
      });

      expect([...db.tables.tasks.values()][0].agent_id).toBe(exactAgentId);
      expect(executors.dispatch).toHaveBeenCalledTimes(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe('看门狗 watchdogSweep', () => {
  beforeEach(() => {
    vi.useRealTimers();
    userCfg.task.maxRunMinutes = 30;
  });

  it('超时 RUNNING 任务被强制 INTERRUPTED 并 abort 执行器', () => {
    const { db, orch, agentId, executors } = setup();
    const task = orch.createTask(agentId, '卡死的长任务');
    // 手动把 started_at 拨回 31 分钟前
    db.tables.tasks.get(task.id).started_at = Date.now() - 31 * 60_000;
    orch['watchdogSweep']();
    const row = db.tables.tasks.get(task.id);
    expect(row.status).toBe('INTERRUPTED');
    expect(row.error).toContain('看门狗超时');
    expect(executors.abort).toHaveBeenCalledWith(task.id);
  });

  it('watchdog 中断 ACP 后，FIFO replacement 等 child close 才运行', () => {
    const { db, orch, agentId, executors } = setup();
    executors.kindFor.mockReturnValue('acp');
    const task = orch.createTask(agentId, '超时 ACP 任务');
    const replacement = orch.createTask(agentId, '等待补位任务');
    const firstDispatch = executors.dispatch.mock.calls[0];
    const occupied = new Set([task.id]);
    executors.isExecuting.mockImplementation((taskId) => occupied.has(taskId));
    executors.activeTaskIdsForAgent.mockImplementation((id) => id === agentId ? [...occupied] : []);
    db.tables.tasks.get(task.id).started_at = Date.now() - 31 * 60_000;

    orch['watchdogSweep']();

    expect(db.tables.tasks.get(task.id).status).toBe('INTERRUPTED');
    expect(db.tables.tasks.get(replacement.id).status).toBe('QUEUED');

    occupied.delete(task.id);
    firstDispatch[2].onReleased?.(task.id);

    expect(db.tables.tasks.get(replacement.id).status).toBe('RUNNING');
  });

  it('未超时任务不受影响', () => {
    const { db, orch, agentId } = setup();
    const task = orch.createTask(agentId, '正常任务');
    orch['watchdogSweep']();
    expect(db.tables.tasks.get(task.id).status).toBe('RUNNING');
  });

  it('maxRunMinutes = 0 不启用看门狗', () => {
    userCfg.task.maxRunMinutes = 0;
    const { db, orch, agentId } = setup();
    const task = orch.createTask(agentId, '不限时任务');
    db.tables.tasks.get(task.id).started_at = Date.now() - 24 * 60 * 60_000;
    orch['watchdogSweep']();
    expect(db.tables.tasks.get(task.id).status).toBe('RUNNING');
  });

  it('看门狗中断触发 onTaskFinished(INTERRUPTED)', () => {
    const { db, orch, agentId } = setup();
    const finished = vi.fn();
    orch.onTaskFinished(finished);
    const task = orch.createTask(agentId, '超时任务');
    db.tables.tasks.get(task.id).started_at = Date.now() - 60 * 60_000;
    orch['watchdogSweep']();
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ taskId: task.id, status: 'INTERRUPTED' }));
  });

  it('暂停等待期不计入看门狗:长时间暂停后恢复不被误杀', () => {
    const { db, orch, agentId } = setup();
    const task = orch.createTask(agentId, '暂停后恢复的任务');
    orch.pauseTask(task.id);
    // 暂停期间 started_at 已是 2 小时前
    db.tables.tasks.get(task.id).started_at = Date.now() - 2 * 60 * 60_000;
    orch.resumeTask(task.id);
    orch['watchdogSweep']();
    // resumeTask 重置了 started_at,看门狗不应中断
    expect(db.tables.tasks.get(task.id).status).toBe('RUNNING');
  });

  it('审批等待期不计入看门狗:批准后 started_at 被重置', () => {
    const { db, orch, agentId } = setup();
    const task = orch.createTask(agentId, '等待审批的任务');
    const row = db.tables.tasks.get(task.id);
    row.status = 'WAITING_APPROVAL';
    row.started_at = Date.now() - 2 * 60 * 60_000; // 审批等了 2 小时
    db.tables.approvals.set('ap-1', { id: 'ap-1', task_id: task.id, agent_id: agentId, type: 'write', request: '写文件', risk: 'low', status: 'pending', created_at: Date.now(), decided_at: null });
    orch.decideApproval('ap-1', true);
    expect(row.status).toBe('RUNNING');
    orch['watchdogSweep']();
    expect(row.status).toBe('RUNNING'); // started_at 已重置,不被误杀
  });
});
