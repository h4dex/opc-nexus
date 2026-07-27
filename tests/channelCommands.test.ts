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

import { tryChannelCommand } from '../src/main/services/channels/common.js';
import { Orchestrator } from '../src/main/services/orchestrator.js';

function createMockExecutors() {
  return {
    dispatch: vi.fn(),
    abort: vi.fn(),
    isExecuting: vi.fn().mockReturnValue(false),
    kindFor: vi.fn().mockReturnValue('simulated')
  };
}

function createMockBroker() {
  return { decide: vi.fn().mockReturnValue(false), abandonTask: vi.fn(), onChange: vi.fn() };
}

function setup() {
  const db = createMockDb();
  seedEngine(db);
  const agentId = seedAgent(db);
  const executors = createMockExecutors();
  const orch = new Orchestrator(db, executors, createMockBroker());
  // 绑定渠道路由
  db.tables.channel_routes.set('route-1', { id: 'route-1', channel_id: 'ch-test', conversation_key: '*', agent_id: agentId, policy: '{}' });
  return { db, orch, agentId, executors };
}

describe('tryChannelCommand', () => {
  it('非指令文本不拦截', () => {
    const { db, orch } = setup();
    const ack = vi.fn();
    expect(tryChannelCommand(db, orch, 'ch-test', '帮我写一份周报', ack)).toBe(false);
    expect(ack).not.toHaveBeenCalled();
  });

  it('/帮助 返回指令说明', () => {
    const { db, orch } = setup();
    const ack = vi.fn();
    expect(tryChannelCommand(db, orch, 'ch-test', '/帮助', ack)).toBe(true);
    expect(ack).toHaveBeenCalledWith(expect.stringContaining('/取消'));
  });

  it('/状态 无任务时提示空闲', () => {
    const { db, orch } = setup();
    const ack = vi.fn();
    expect(tryChannelCommand(db, orch, 'ch-test', '/状态', ack)).toBe(true);
    expect(ack).toHaveBeenCalledWith('当前没有执行中的任务。');
  });

  it('/状态 列出执行中任务与进度', () => {
    const { db, orch, agentId } = setup();
    orch.createTask(agentId, '生成月度报表');
    const ack = vi.fn();
    tryChannelCommand(db, orch, 'ch-test', '/状态', ack);
    expect(ack).toHaveBeenCalledWith(expect.stringContaining('生成月度报表'));
    expect(ack).toHaveBeenCalledWith(expect.stringContaining('执行中'));
  });

  it('/取消 终止当前任务(防死循环干预)', () => {
    const { db, orch, agentId, executors } = setup();
    const task = orch.createTask(agentId, '疑似死循环任务');
    const ack = vi.fn();
    tryChannelCommand(db, orch, 'ch-test', '/取消', ack);
    expect(executors.abort).toHaveBeenCalledWith(task.id);
    expect(db.tables.tasks.get(task.id).status).toBe('CANCELLED');
    expect(ack).toHaveBeenCalledWith(expect.stringContaining('已终止'));
  });

  it('/取消 全部 终止全部活跃任务', () => {
    const { db, orch, agentId } = setup();
    const t1 = orch.createTask(agentId, '任务一');
    const t2 = orch.createTask(agentId, '任务二'); // 并发 1 → t2 QUEUED
    const ack = vi.fn();
    tryChannelCommand(db, orch, 'ch-test', '/取消 全部', ack);
    expect(db.tables.tasks.get(t1.id).status).toBe('CANCELLED');
    expect(db.tables.tasks.get(t2.id).status).toBe('CANCELLED');
  });

  it('/暂停 与 /继续 往返', () => {
    const { db, orch, agentId } = setup();
    const task = orch.createTask(agentId, '可暂停任务');
    const ack = vi.fn();
    tryChannelCommand(db, orch, 'ch-test', '/暂停', ack);
    expect(db.tables.tasks.get(task.id).status).toBe('PAUSED');
    tryChannelCommand(db, orch, 'ch-test', '/继续', ack);
    expect(db.tables.tasks.get(task.id).status).toBe('RUNNING');
  });

  it('未知指令回复帮助', () => {
    const { db, orch } = setup();
    const ack = vi.fn();
    expect(tryChannelCommand(db, orch, 'ch-test', '/乱写', ack)).toBe(true);
    expect(ack).toHaveBeenCalledWith(expect.stringContaining('未识别的指令'));
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
});
