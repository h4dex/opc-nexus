/**
 * 任务终态守卫测试（数据层最后防线）
 *
 * 背景:执行器的迟到回调曾能覆盖已落定的终态 —— 看门狗把任务标 INTERRUPTED 后
 * 子进程才退出并回调 onDone,任务就被改写成 COMPLETED,用户看到「成功」但实际被中断。
 * 执行器侧已用 abortedTasks 拦截,此处验证编排器自身也不接受迟到回调。
 *
 * 覆盖:
 * - COMPLETED / FAILED / INTERRUPTED 三种迟到回调均不覆盖既有终态
 * - 被拦下的回调不重复推送终态订阅(webhook 不重复发)
 * - 正常首次回调仍按预期落库并通知
 *
 * @author liyingjie <y@senke.com>
 */
// @ts-nocheck
/* eslint-disable */
import { createMockDb, seedAgent, seedEngine } from './helpers/mockDb.js';

vi.mock('../src/main/services/notifier.js', () => ({ notify: vi.fn() }));

import { Orchestrator } from '../src/main/services/orchestrator.js';

function setup() {
  const db = createMockDb();
  seedEngine(db, 'eng-1');
  const agentId = seedAgent(db, { name: '测试员工', engine_id: 'eng-1' });
  const executors = {
    dispatch: vi.fn(),
    abort: vi.fn(),
    isExecuting: vi.fn().mockReturnValue(false),
    kindFor: vi.fn().mockReturnValue('generic-cli')
  };
  const broker = { decide: vi.fn().mockReturnValue(false), abandonTask: vi.fn(), onChange: vi.fn() };
  const orch = new Orchestrator(db, executors as never, broker as never);
  return { db, orch, agentId, executors };
}

/** 派发一个任务并取回执行器拿到的回调对象 */
function dispatchAndGetCallbacks(orch, executors, agentId) {
  const task = orch.createTask(agentId, '测试任务');
  orch.startAgent(agentId);
  const call = executors.dispatch.mock.calls.at(-1);
  return { task, cb: call?.[2] };
}

describe('终态守卫：迟到回调不覆盖既有终态', () => {
  it('看门狗中断后的 onDone 不把任务改写为 COMPLETED', () => {
    const { db, orch, agentId, executors } = setup();
    const { task, cb } = dispatchAndGetCallbacks(orch, executors, agentId);
    expect(cb).toBeTruthy();

    // 模拟看门狗:任务已落 INTERRUPTED
    db.tables.tasks.get(task.id).status = 'INTERRUPTED';
    db.tables.tasks.get(task.id).error = '看门狗超时';

    cb.onDone(task.id, '子进程迟到产出的结果');

    const row = db.tables.tasks.get(task.id);
    expect(row.status).toBe('INTERRUPTED');
    expect(row.error).toBe('看门狗超时');
    expect(row.result ?? null).toBeNull();
  });

  it('用户取消后的 onDone 不把任务改写为 COMPLETED', () => {
    const { db, orch, agentId, executors } = setup();
    const { task, cb } = dispatchAndGetCallbacks(orch, executors, agentId);

    orch.cancelTask(task.id);
    expect(db.tables.tasks.get(task.id).status).toBe('CANCELLED');

    cb.onDone(task.id, '迟到结果');
    expect(db.tables.tasks.get(task.id).status).toBe('CANCELLED');
  });

  it('已 COMPLETED 的任务不被迟到的 onError 改写为 FAILED', () => {
    const { db, orch, agentId, executors } = setup();
    const { task, cb } = dispatchAndGetCallbacks(orch, executors, agentId);

    cb.onDone(task.id, '正常完成');
    expect(db.tables.tasks.get(task.id).status).toBe('COMPLETED');

    cb.onError(task.id, '迟到的错误');
    const row = db.tables.tasks.get(task.id);
    expect(row.status).toBe('COMPLETED');
    expect(row.error ?? null).toBeNull();
  });

  it('双重回调（onDone 后再 onDone）只生效一次', () => {
    const { db, orch, agentId, executors } = setup();
    const { task, cb } = dispatchAndGetCallbacks(orch, executors, agentId);

    cb.onDone(task.id, '第一次');
    const firstEnded = db.tables.tasks.get(task.id).ended_at;

    cb.onDone(task.id, '第二次');
    const row = db.tables.tasks.get(task.id);
    expect(row.result).toBe('第一次');
    expect(row.ended_at).toBe(firstEnded);
  });
});

describe('终态守卫：迟到回调不重复推送终态订阅', () => {
  it('被拦下的回调不触发 finishListeners（webhook 不重复发）', () => {
    const { db, orch, agentId, executors } = setup();
    const seen: string[] = [];
    orch.onTaskFinished((info) => seen.push(info.status));
    const { task, cb } = dispatchAndGetCallbacks(orch, executors, agentId);

    cb.onDone(task.id, '正常完成');
    expect(seen).toEqual(['COMPLETED']);

    cb.onError(task.id, '迟到错误');
    cb.onDone(task.id, '再一次');
    expect(seen).toEqual(['COMPLETED']); // 仍只有一次
  });

  it('首次正常终态照常推送订阅', () => {
    const { orch, agentId, executors } = setup();
    const seen: unknown[] = [];
    orch.onTaskFinished((info) => seen.push(info));
    const { task, cb } = dispatchAndGetCallbacks(orch, executors, agentId);

    cb.onError(task.id, '真实失败');
    expect(seen).toHaveLength(1);
    expect(seen[0].status).toBe('FAILED');
    expect(seen[0].error).toBe('真实失败');
  });
});
