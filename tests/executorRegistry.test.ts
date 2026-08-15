/**
 * 执行器注册表主辅引擎策略测试(P1)
 * 覆盖:主引擎就绪直用、主引擎不可用回退辅助引擎、
 * production 模式禁用模拟回退(任务 FAILED)、demo 模式保留演示回退
 */
// @ts-nocheck
/* eslint-disable */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

// 可变的用户配置 mock(每个用例覆写)
const userCfg = {
  wecom: { botId: '', secret: '', webhookUrl: '' },
  engine: { fallbackEngineId: 'eng-opencode', executionMode: 'demo' },
  task: { maxRunMinutes: 30 }
};
vi.mock('../src/main/services/userConfig.js', () => ({
  loadUserConfig: () => userCfg
}));

import { ExecutorRegistry } from '../src/main/services/executor/index.js';

/** 最小 db mock:engines 表 type/status/config 查询 */
function makeDb(engines: Record<string, { type: string; status: string; config_json?: string }>) {
  return {
    raw: {
      prepare: (sql: string) => ({
        get: (id: string) => {
          const e = engines[id];
          if (!e) return undefined;
          if (/SELECT type FROM engines/.test(sql)) return { type: e.type };
          if (/SELECT status FROM engines/.test(sql)) return { status: e.status };
          if (/SELECT path FROM engines/.test(sql)) return { path: null };
          if (/SELECT .*config_json.* FROM engines/.test(sql)) return { config_json: e.config_json, path: null };
          return undefined;
        },
        all: () => [],
        run: () => ({ changes: 0 })
      })
    },
    transaction: (fn: () => void) => fn(),
    audit: vi.fn(),
    getSetting: (_k: string, fb: unknown) => fb,
    setSetting: vi.fn()
  };
}

const broker = { decide: vi.fn(), abandonTask: vi.fn(), onChange: vi.fn() };

describe('ExecutorRegistry 主辅引擎策略', () => {
  beforeEach(() => {
    userCfg.engine = { fallbackEngineId: 'eng-opencode', executionMode: 'demo' };
  });

  it('主引擎(CLI)健康时直接使用主引擎', () => {
    const db = makeDb({
      'eng-codex': { type: 'codex', status: 'HEALTHY' },
      'eng-opencode': { type: 'opencode', status: 'HEALTHY' }
    });
    const reg = new ExecutorRegistry(db as never, broker as never);
    expect(reg.kindFor('eng-codex')).toBe('codex-cli');
  });

  it('主引擎不可用时回退辅助引擎(OpenCode)', () => {
    const db = makeDb({
      'eng-codex': { type: 'codex', status: 'NOT_INSTALLED' },
      'eng-opencode': { type: 'opencode', status: 'HEALTHY' }
    });
    const reg = new ExecutorRegistry(db as never, broker as never);
    expect(reg.kindFor('eng-codex')).toBe('generic-cli');
  });

  it('demo 模式主辅均不可用回退演示执行器', () => {
    const db = makeDb({
      'eng-codex': { type: 'codex', status: 'NOT_INSTALLED' },
      'eng-opencode': { type: 'opencode', status: 'NOT_INSTALLED' }
    });
    const reg = new ExecutorRegistry(db as never, broker as never);
    expect(reg.kindFor('eng-codex')).toBe('simulated');
  });

  it('production 模式主辅均不可用 → dispatch 直接 onError,任务不伪装完成', () => {
    userCfg.engine.executionMode = 'production';
    const db = makeDb({
      'eng-codex': { type: 'codex', status: 'NOT_INSTALLED' },
      'eng-opencode': { type: 'opencode', status: 'NOT_INSTALLED' }
    });
    const reg = new ExecutorRegistry(db as never, broker as never);
    const onError = vi.fn();
    const onDone = vi.fn();
    reg.dispatch(
      { id: 't1', agentId: 'a1', title: '测试任务' } as never,
      { id: 'a1', engineId: 'eng-codex' } as never,
      { onStage: vi.fn(), onProgress: vi.fn(), onOutput: vi.fn(), onDone, onError } as never
    );
    expect(onError).toHaveBeenCalledWith('t1', expect.stringContaining('无可用执行引擎'));
    expect(onDone).not.toHaveBeenCalled();
    expect(reg.isExecuting('t1')).toBe(false);
  });

  it('辅助引擎与主引擎相同时不重复探测(仍走 demo 回退)', () => {
    userCfg.engine.fallbackEngineId = 'eng-codex';
    const db = makeDb({
      'eng-codex': { type: 'codex', status: 'NOT_INSTALLED' }
    });
    const reg = new ExecutorRegistry(db as never, broker as never);
    expect(reg.kindFor('eng-codex')).toBe('simulated');
  });

  it('Hermes Agent CLI(hermes-cli 类型)健康时按泛化 CLI 执行', () => {
    const db = makeDb({
      'eng-hermes-cli': { type: 'hermes-cli', status: 'HEALTHY' }
    });
    const reg = new ExecutorRegistry(db as never, broker as never);
    expect(reg.kindFor('eng-hermes-cli')).toBe('generic-cli');
  });

  it('Pi Agent uses its dedicated JSONL executor when healthy', () => {
    const db = makeDb({
      'eng-pi': { type: 'pi', status: 'HEALTHY' }
    });
    const reg = new ExecutorRegistry(db as never, broker as never);
    expect(reg.kindFor('eng-pi')).toBe('pi-cli');
  });

  it('Claude Code uses the dedicated Claude CLI mode when healthy', () => {
    const db = makeDb({
      'eng-claude': { type: 'claude', status: 'HEALTHY' }
    });
    const reg = new ExecutorRegistry(db as never, broker as never);
    expect(reg.kindFor('eng-claude')).toBe('claude-cli');
  });

  it('engineOverride 解析为外部 ACP 时把覆盖后的引擎 ID 传给执行器', () => {
    userCfg.engine.executionMode = 'production';
    userCfg.engine.fallbackEngineId = null;
    const db = makeDb({
      'eng-codex': { type: 'codex', status: 'HEALTHY' },
      'eng-harness': {
        type: 'external',
        status: 'HEALTHY',
        config_json: JSON.stringify({ acpCommand: ['dsh', 'acp'] })
      }
    });
    const reg = new ExecutorRegistry(db as never, broker as never);
    const start = vi.spyOn(reg['acp'], 'start').mockImplementation(() => undefined);
    const employee = { id: 'a1', engineId: 'eng-codex' } as never;

    expect(reg.dispatch(
      { id: 't-override', agentId: 'a1', title: '测试', engineOverride: 'eng-harness' } as never,
      employee,
      { onStage: vi.fn(), onProgress: vi.fn(), onOutput: vi.fn(), onDone: vi.fn(), onError: vi.fn() } as never
    )).toBe('acp');

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-override' }),
      expect.objectContaining({ id: 'a1', engineId: 'eng-harness' }),
      expect.any(Object)
    );
    expect(employee.engineId).toBe('eng-codex');
  });

  it('主引擎不可用而回退外部 ACP 时把 fallback ID 传给执行器', () => {
    userCfg.engine.executionMode = 'production';
    userCfg.engine.fallbackEngineId = 'eng-harness';
    const db = makeDb({
      'eng-codex': { type: 'codex', status: 'NOT_INSTALLED' },
      'eng-harness': {
        type: 'external',
        status: 'HEALTHY',
        config_json: JSON.stringify({ acpCommand: ['dsh', 'acp'] })
      }
    });
    const reg = new ExecutorRegistry(db as never, broker as never);
    const start = vi.spyOn(reg['acp'], 'start').mockImplementation(() => undefined);
    const onResolved = vi.fn();

    expect(reg.dispatch(
      { id: 't-fallback', agentId: 'a1', title: '测试' } as never,
      { id: 'a1', engineId: 'eng-codex' } as never,
      { onStage: vi.fn(), onProgress: vi.fn(), onOutput: vi.fn(), onDone: vi.fn(), onError: vi.fn() } as never,
      onResolved
    )).toBe('acp');

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-fallback' }),
      expect.objectContaining({ engineId: 'eng-harness' }),
      expect.any(Object)
    );
    expect(onResolved).toHaveBeenCalledOnce();
    expect(onResolved).toHaveBeenCalledWith({
      requestedEngineId: 'eng-codex',
      resolvedEngineId: 'eng-harness',
      executorKind: 'acp',
      usedFallback: true
    });
  });

  it('canonical DispatchPlan 精确绑定的引擎不可用时禁止静默 fallback', () => {
    userCfg.engine.executionMode = 'demo';
    userCfg.engine.fallbackEngineId = 'eng-harness';
    const db = makeDb({
      'eng-codex': { type: 'codex', status: 'NOT_INSTALLED' },
      'eng-harness': {
        type: 'external', status: 'HEALTHY',
        config_json: JSON.stringify({ acpCommand: ['dsh', 'acp'] })
      }
    });
    const reg = new ExecutorRegistry(db as never, broker as never);
    const start = vi.spyOn(reg['acp'], 'start').mockImplementation(() => undefined);
    const onError = vi.fn();
    const onResolved = vi.fn();

    expect(reg.dispatch(
      {
        id: 't-plan', agentId: 'a1', title: '受控任务', inputMessageId: 'message-1'
      } as never,
      { id: 'a1', engineId: 'eng-codex' } as never,
      { onStage: vi.fn(), onProgress: vi.fn(), onOutput: vi.fn(), onDone: vi.fn(), onError } as never,
      onResolved
    )).toBe('unavailable');

    expect(start).not.toHaveBeenCalled();
    expect(onResolved).toHaveBeenCalledWith({
      requestedEngineId: 'eng-codex', resolvedEngineId: null,
      executorKind: 'unavailable', usedFallback: false
    });
    expect(onError).toHaveBeenCalledWith('t-plan', expect.stringContaining('禁止静默切换'));
  });

  it('显式 engineOverride 在重试或编码委派中也禁止静默 fallback', () => {
    userCfg.engine.executionMode = 'demo';
    userCfg.engine.fallbackEngineId = 'eng-harness';
    const db = makeDb({
      'eng-codex': { type: 'codex', status: 'NOT_INSTALLED' },
      'eng-harness': {
        type: 'external', status: 'HEALTHY',
        config_json: JSON.stringify({ acpCommand: ['dsh', 'acp'] })
      }
    });
    const reg = new ExecutorRegistry(db as never, broker as never);
    const fallback = vi.spyOn(reg['acp'], 'start').mockImplementation(() => undefined);
    const onError = vi.fn();

    expect(reg.dispatch(
      { id: 't-retry', agentId: 'a1', title: '重试', engineOverride: 'eng-codex', inputMessageId: null } as never,
      { id: 'a1', engineId: 'eng-harness' } as never,
      { onStage: vi.fn(), onProgress: vi.fn(), onOutput: vi.fn(), onDone: vi.fn(), onError } as never
    )).toBe('unavailable');

    expect(fallback).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('t-retry', expect.stringContaining('禁止静默切换'));
  });

  it('无可用引擎时也在同步错误回调前报告 unavailable binding', () => {
    userCfg.engine.executionMode = 'production';
    userCfg.engine.fallbackEngineId = null;
    const db = makeDb({ 'eng-codex': { type: 'codex', status: 'NOT_INSTALLED' } });
    const reg = new ExecutorRegistry(db as never, broker as never);
    const order: string[] = [];

    expect(reg.dispatch(
      { id: 't-unavailable', agentId: 'a1', title: '测试' } as never,
      { id: 'a1', engineId: 'eng-codex' } as never,
      {
        onStage: vi.fn(), onProgress: vi.fn(), onOutput: vi.fn(), onDone: vi.fn(),
        onError: () => order.push('error')
      } as never,
      (binding) => {
        order.push('resolved');
        expect(binding).toEqual({
          requestedEngineId: 'eng-codex', resolvedEngineId: null,
          executorKind: 'unavailable', usedFallback: false
        });
      }
    )).toBe('unavailable');
    expect(order).toEqual(['resolved', 'error']);
  });

  it('ACP abort 后保持占用，直到执行器报告 child close release', () => {
    userCfg.engine.executionMode = 'production';
    userCfg.engine.fallbackEngineId = null;
    const db = makeDb({
      'eng-harness': {
        type: 'external',
        status: 'HEALTHY',
        config_json: JSON.stringify({ acpCommand: ['dsh', 'acp'] })
      }
    });
    const reg = new ExecutorRegistry(db as never, broker as never);
    let innerCallbacks: Record<string, (...args: unknown[]) => void> | undefined;
    vi.spyOn(reg['acp'], 'start').mockImplementation((_task, _agent, callbacks) => {
      innerCallbacks = callbacks as unknown as typeof innerCallbacks;
    });
    const onReleased = vi.fn();

    expect(reg.dispatch(
      { id: 't-acp-release', agentId: 'a1', title: '等待子进程退出' } as never,
      { id: 'a1', engineId: 'eng-harness' } as never,
      {
        onStage: vi.fn(), onProgress: vi.fn(), onOutput: vi.fn(),
        onReleased, onDone: vi.fn(), onError: vi.fn()
      } as never
    )).toBe('acp');

    reg.abort('t-acp-release');
    expect(reg.isExecuting('t-acp-release')).toBe(true);
    expect(reg.activeTaskIdsForAgent('a1')).toEqual(['t-acp-release']);

    innerCallbacks?.onReleased('t-acp-release');

    expect(reg.isExecuting('t-acp-release')).toBe(false);
    expect(reg.activeTaskIdsForAgent('a1')).toEqual([]);
    expect(onReleased).toHaveBeenCalledOnce();
    expect(onReleased).toHaveBeenCalledWith('t-acp-release');
  });
});
