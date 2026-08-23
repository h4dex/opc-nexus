/**
 * ACP 执行器接入回归测试。
 *
 * 锁定外部引擎的两个配置边界：启动命令以 engines.config_json 为运行时真源，
 * 子进程环境由宿主进程环境与主进程安全解析的引擎环境合并而成。
 */
// @ts-nocheck
/* eslint-disable */
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));
vi.mock('node:fs', () => ({ mkdirSync: vi.fn() }));

const appCfg: { engines: Record<string, { acpCommand?: string[] }> } = { engines: {} };
vi.mock('../src/main/services/config.js', () => ({ loadConfig: () => appCfg }));

let resolvedEnv: Record<string, string> = {};
const resolveEngineEnv = vi.fn((_db: unknown, _engineId: string) => resolvedEnv);
vi.mock('../src/main/services/engineEnv.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/main/services/engineEnv.js')>(),
  resolveEngineEnv
}));

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(() => true),
    end: vi.fn()
  });
  killed = false;
  kill() { this.killed = true; return true; }
}

let child: FakeChild;
let lastSpawn: { command: string; args: string[]; options: Record<string, unknown> } | null;
const spawn = vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
  lastSpawn = { command, args, options };
  child = new FakeChild();
  return child;
});
vi.mock('node:child_process', () => ({ spawn }));

const {
  AcpExecutor,
  MAX_ACP_APPROVAL_REQUEST_CHARS,
  MAX_ACP_ERROR_CHARS,
  MAX_ACP_FRAME_BYTES,
  MAX_ACP_INBOUND_REQUESTS_GLOBAL,
  MAX_ACP_INBOUND_REQUESTS_PER_TASK,
  MAX_ACP_INBOUND_REQUESTS_PER_TASK_TOTAL,
  MAX_ACP_TOOL_TITLE_CHARS,
  MAX_ACP_TOOL_EVENTS,
  MAX_ACP_UPDATE_EVENTS,
  acpCommandFor,
  probeAcpEngine,
  probeAcpTask
} = await import('../src/main/services/executor/acpExecutor.js');

function makeDb(configById: Record<string, Record<string, unknown>>) {
  return {
    raw: {
      prepare: (sql: string) => ({
        get: (id: string) => {
          const row = configById[id];
          const { __path, ...config } = row ?? {};
          if (/SELECT .*config_json.* FROM engines/.test(sql)) {
            return row ? { config_json: JSON.stringify(config), path: __path ?? null } : undefined;
          }
          if (/SELECT path FROM engines/.test(sql)) return row ? { path: __path ?? null } : undefined;
          if (/SELECT status FROM engines/.test(sql)) return { status: 'HEALTHY' };
          return undefined;
        },
        run: vi.fn(() => ({ changes: 1 })),
        all: () => []
      })
    },
    getSetting: (_key: string, fallback: unknown) => fallback,
    audit: vi.fn()
  };
}

const task = { id: 't1', title: '运行 ACP Worker', source: 'desktop', workspaceOverride: null };
const agent = {
  id: 'a1',
  name: 'Runtime',
  engineId: 'eng-acp-worker',
  workspace: 'C:\\workspace',
  systemPrompt: '',
  permissionMode: 'standard'
};
const callbacks = () => ({
  onStage: vi.fn(),
  onProgress: vi.fn(),
  onOutput: vi.fn(),
  onSession: vi.fn(),
  onReleased: vi.fn(),
  onDone: vi.fn(),
  onError: vi.fn()
});

const permissionRequestLine = (id: number) => JSON.stringify({
  jsonrpc: '2.0',
  id,
  method: 'session/request_permission',
  params: {
    toolCall: { title: 'write file' },
    options: [
      { optionId: 'allow', kind: 'allow_once' },
      { optionId: 'reject', kind: 'reject_once' }
    ]
  }
});

beforeEach(() => {
  appCfg.engines = {};
  resolvedEnv = {};
  resolveEngineEnv.mockClear();
  spawn.mockClear();
  lastSpawn = null;
});

describe('ACP 启动命令解析', () => {
  it('优先读取数据库 config_json 中的 acpCommand', () => {
    const db = makeDb({ 'eng-acp-worker': { acpCommand: ['acp-worker', 'acp', '--profile', 'opc'] } });
    appCfg.engines['eng-acp-worker'] = { acpCommand: ['legacy-acp-worker', 'acp'] };

    expect(acpCommandFor(db as never, 'eng-acp-worker')).toEqual(['acp-worker', 'acp', '--profile', 'opc']);
  });

  it('数据库没有命令时兼容配置文件中的已有 ACP 引擎', () => {
    const db = makeDb({ 'eng-acp-worker': {} });
    appCfg.engines['eng-acp-worker'] = { acpCommand: ['legacy-acp-worker', 'acp'] };

    expect(acpCommandFor(db as never, 'eng-acp-worker')).toEqual(['legacy-acp-worker', 'acp']);
  });

  it('兼容旧版自定义引擎的 path + runArgs 数据', () => {
    const db = makeDb({
      'eng-legacy': { __path: 'legacy-acp-worker', runArgs: ['acp', '--profile', 'old-user'] }
    });

    expect(acpCommandFor(db as never, 'eng-legacy')).toEqual([
      'legacy-acp-worker', 'acp', '--profile', 'old-user'
    ]);
  });

  it('数据库命令会被实际用于 spawn', () => {
    const db = makeDb({ 'eng-acp-worker': { acpCommand: ['acp-worker', 'acp', '--profile', 'opc'] } });
    const executor = new AcpExecutor(db as never, { request: vi.fn(), abandonTask: vi.fn() } as never);

    executor.start(task as never, agent as never, callbacks() as never);

    expect(lastSpawn).toMatchObject({ command: 'acp-worker', args: ['acp', '--profile', 'opc'] });
    executor.abort(task.id);
  });

  it('任务工作目录覆写会传给进程和 ACP session/new', async () => {
    const db = makeDb({ 'eng-acp-worker': { acpCommand: ['acp-worker', 'acp'] } });
    const executor = new AcpExecutor(db as never, { request: vi.fn(), abandonTask: vi.fn() } as never);

    executor.start({ ...task, workspaceOverride: 'D:\\task-workspace' } as never, agent as never, callbacks() as never);
    expect(lastSpawn?.options.cwd).toBe('D:\\task-workspace');

    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'));
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledTimes(2));
    const sessionRequest = JSON.parse(child.stdin.write.mock.calls[1][0]);
    expect(sessionRequest).toMatchObject({ method: 'session/new', params: { cwd: 'D:\\task-workspace', mcpServers: [] } });
    executor.abort(task.id);
  });

  it('initialize 响应前取消不会因迟到响应创建 session', async () => {
    const db = makeDb({ 'eng-acp-worker': { acpCommand: ['acp-worker', 'acp'] } });
    const broker = { request: vi.fn(), abandonTask: vi.fn() };
    const executor = new AcpExecutor(db as never, broker as never);
    const cb = callbacks();

    executor.start(task as never, agent as never, cb as never);
    expect(child.stdin.write).toHaveBeenCalledOnce();
    expect(JSON.parse(child.stdin.write.mock.calls[0][0])).toMatchObject({ method: 'initialize' });

    executor.abort(task.id);
    expect(broker.abandonTask).toHaveBeenCalledOnce();
    expect(broker.abandonTask).toHaveBeenCalledWith(task.id);
    expect(child.stdin.end).toHaveBeenCalledOnce();

    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'));
    child.stdout.emit('data', Buffer.from(
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"late"}}}}\n'
    ));
    await Promise.resolve();
    await Promise.resolve();

    expect(child.stdin.write).toHaveBeenCalledOnce();
    expect(cb.onOutput).not.toHaveBeenCalled();
    expect(cb.onDone).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
    child.emit('close', 0);
    expect(cb.onReleased).toHaveBeenCalledOnce();
  });

  it('真实任务完成后关闭 stdin，不把 fresh ACP session 持久化为可恢复会话', async () => {
    const db = makeDb({ 'eng-acp-worker': { acpCommand: ['acp-worker', 'acp'] } });
    const executor = new AcpExecutor(db as never, { request: vi.fn(), abandonTask: vi.fn() } as never);
    const cb = callbacks();

    executor.start(task as never, agent as never, cb as never);
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'));
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledTimes(2));
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"sessionId":"fresh-only"}}\n'));
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledTimes(3));
    child.stdout.emit('data', Buffer.from(
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"done"}}}}\n'
    ));
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}\n'));

    await vi.waitFor(() => expect(cb.onDone).toHaveBeenCalledWith(task.id, 'done'));
    expect(cb.onSession).not.toHaveBeenCalled();
    expect(child.stdin.end).toHaveBeenCalledOnce();
    expect(child.killed).toBe(false);
    expect(cb.onReleased).not.toHaveBeenCalled();
    child.emit('close', 0);
    expect(cb.onError).not.toHaveBeenCalled();
    expect(cb.onReleased).toHaveBeenCalledOnce();
    expect(cb.onReleased).toHaveBeenCalledWith(task.id);
  });

  it('stdout 协议损坏会立即失败且只回调一次', async () => {
    const db = makeDb({ 'eng-acp-worker': { acpCommand: ['acp-worker', 'acp'] } });
    const executor = new AcpExecutor(db as never, { request: vi.fn(), abandonTask: vi.fn() } as never);
    const cb = callbacks();

    executor.start(task as never, agent as never, cb as never);
    child.stdout.emit('data', Buffer.from('unexpected log on stdout\n'));
    await vi.waitFor(() => expect(cb.onError).toHaveBeenCalledOnce());
    expect(cb.onError.mock.calls[0][1]).toContain('ACP 协议错误');
    child.emit('close', 1);
    expect(cb.onError).toHaveBeenCalledOnce();
  });

  it('max_turn_requests 不会被当作已完成任务', async () => {
    const db = makeDb({ 'eng-acp-worker': { acpCommand: ['acp-worker', 'acp'] } });
    const executor = new AcpExecutor(db as never, { request: vi.fn(), abandonTask: vi.fn() } as never);
    const cb = callbacks();

    executor.start(task as never, agent as never, cb as never);
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'));
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledTimes(2));
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"sessionId":"limited"}}\n'));
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledTimes(3));
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":3,"result":{"stopReason":"max_turn_requests"}}\n'));

    await vi.waitFor(() => expect(cb.onError).toHaveBeenCalledOnce());
    expect(cb.onDone).not.toHaveBeenCalled();
    expect(cb.onError.mock.calls[0][1]).toContain('最大轮次限制');
  });

  it('sidecar 主动取消会回报中断而不是让任务停留在 RUNNING', async () => {
    const db = makeDb({ 'eng-acp-worker': { acpCommand: ['acp-worker', 'acp'] } });
    const executor = new AcpExecutor(db as never, { request: vi.fn(), abandonTask: vi.fn() } as never);
    const cb = callbacks();

    executor.start(task as never, agent as never, cb as never);
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'));
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledTimes(2));
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"sessionId":"cancelled"}}\n'));
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledTimes(3));
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":3,"result":{"stopReason":"cancelled"}}\n'));

    await vi.waitFor(() => expect(cb.onError).toHaveBeenCalledOnce());
    expect(cb.onError.mock.calls[0][1]).toContain('取消或中断');
    expect(cb.onDone).not.toHaveBeenCalled();
    expect(child.stdin.end).toHaveBeenCalledOnce();
  });
});

describe('ACP 子进程环境', () => {
  it('只保留宿主启动变量并合并当前 effective engine 的安全环境', () => {
    const db = makeDb({ 'eng-acp-worker': { acpCommand: ['acp-worker', 'acp'] } });
    resolvedEnv = { AIBOX_RUNTIME_TEST: 'from-engine' };
    const previousHost = process.env.AIBOX_HOST_TEST;
    const previousRuntime = process.env.AIBOX_RUNTIME_TEST;
    process.env.AIBOX_HOST_TEST = 'from-host';
    process.env.AIBOX_RUNTIME_TEST = 'from-host-but-overridden';
    const executor = new AcpExecutor(db as never, { request: vi.fn(), abandonTask: vi.fn() } as never);

    try {
      executor.start(task as never, agent as never, callbacks() as never);

      expect(resolveEngineEnv).toHaveBeenCalledWith(db, 'eng-acp-worker', agent);
      expect(lastSpawn?.options.env).toMatchObject({ AIBOX_RUNTIME_TEST: 'from-engine' });
      expect(lastSpawn?.options.env.AIBOX_HOST_TEST).toBeUndefined();
      expect(lastSpawn?.options.env.PATH).toBe(process.env.PATH);
    } finally {
      executor.abort(task.id);
      if (previousHost === undefined) delete process.env.AIBOX_HOST_TEST;
      else process.env.AIBOX_HOST_TEST = previousHost;
      if (previousRuntime === undefined) delete process.env.AIBOX_RUNTIME_TEST;
      else process.env.AIBOX_RUNTIME_TEST = previousRuntime;
    }
  });

  it('握手探测也合并调用方传入的引擎环境', async () => {
    const probe = probeAcpEngine(['acp-worker', 'acp'], { AIBOX_PROBE_TOKEN: 'probe-secret' });

    expect(lastSpawn).toMatchObject({ command: 'acp-worker', args: ['acp'] });
    expect(lastSpawn?.options.env).toMatchObject({ AIBOX_PROBE_TOKEN: 'probe-secret' });
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'));

    await expect(probe).resolves.toEqual({ ok: true, message: 'ok' });
  });

  it('自定义 ACP 即使设置 ELECTRON_RUN_AS_NODE，探测错误仍会脱敏', async () => {
    const env = { ELECTRON_RUN_AS_NODE: '1', OPENAI_API_KEY: 'external-secret' };
    const probe = probeAcpEngine(['acp-worker', 'acp'], env);

    expect(lastSpawn?.options.env).toMatchObject(env);
    child.stdout.emit('data', Buffer.from(
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"external-secret denied"}}\n'
    ));

    const result = await probe;
    expect(result).toMatchObject({ ok: false, message: '[REDACTED] denied' });
    expect(result.message).not.toContain('external-secret');
    expect(child.killed).toBe(true);
  });

  it('最小任务探测必须创建会话、发送 prompt 并收到模型文本', async () => {
    const probe = probeAcpTask(
      ['acp-worker', 'acp'],
      { AIBOX_PROBE_TOKEN: 'probe-secret' },
      'D:\\probe-workspace',
      2_000
    );

    expect(lastSpawn).toMatchObject({
      command: 'acp-worker',
      args: ['acp'],
      options: { cwd: 'D:\\probe-workspace' }
    });
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'));
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledTimes(2));
    expect(JSON.parse(child.stdin.write.mock.calls[1][0])).toMatchObject({
      method: 'session/new',
      params: { cwd: 'D:\\probe-workspace', mcpServers: [] }
    });

    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"sessionId":"probe-session"}}\n'));
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledTimes(3));
    expect(JSON.parse(child.stdin.write.mock.calls[2][0])).toMatchObject({
      method: 'session/prompt',
      params: {
        sessionId: 'probe-session',
        prompt: [{ type: 'text', text: 'Reply with exactly OPC_ACP_OK. Do not call tools.' }]
      }
    });

    child.stdout.emit('data', Buffer.from(
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"OPC_ACP_OK"}}}}\n'
    ));
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}\n'));

    child.emit('close', 0);
    await expect(probe).resolves.toMatchObject({
      ok: true,
      initialized: true,
      sessionCreated: true,
      output: 'OPC_ACP_OK'
    });
  });

  it('最小任务只有握手成功但没有模型文本时不会判定健康', async () => {
    const probe = probeAcpTask(['acp-worker', 'acp'], {}, 'D:\\probe-workspace', 2_000);
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'));
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledTimes(2));
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"sessionId":"probe-session"}}\n'));
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledTimes(3));
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}\n'));

    await expect(probe).resolves.toMatchObject({
      ok: false,
      initialized: true,
      sessionCreated: true,
      output: ''
    });
  });
});

describe('ACP 协议防护', () => {
  it('自主模式拒绝未知 ACP 的越界权限请求且不打扰用户审批', async () => {
    const db = makeDb({ 'eng-acp-worker': { acpCommand: ['acp-worker', 'acp'] } });
    const broker = { request: vi.fn(), abandonTask: vi.fn() };
    const executor = new AcpExecutor(db as never, broker as never);

    executor.start(task as never, { ...agent, permissionMode: 'autonomous' } as never, callbacks() as never);
    child.stdout.emit('data', Buffer.from(`${permissionRequestLine(77)}\n`));

    await vi.waitFor(() => {
      const messages = child.stdin.write.mock.calls.map(([line]) => JSON.parse(line));
      expect(messages).toContainEqual(expect.objectContaining({
        id: 77,
        result: { outcome: { outcome: 'selected', optionId: 'reject' } }
      }));
    });
    expect(broker.request).not.toHaveBeenCalled();
    executor.abort(task.id);
    child.emit('close', 0);
  });

  it('同一任务只允许一个 permission 请求进入审批代理', async () => {
    const db = makeDb({ 'eng-acp-worker': { acpCommand: ['acp-worker', 'acp'] } });
    let settleApproval!: (approved: boolean) => void;
    const broker = {
      request: vi.fn(() => new Promise<boolean>((resolve) => { settleApproval = resolve; })),
      abandonTask: vi.fn()
    };
    const executor = new AcpExecutor(db as never, broker as never);

    executor.start(task as never, agent as never, callbacks() as never);
    child.stdout.emit('data', Buffer.from(`${permissionRequestLine(101)}\n${permissionRequestLine(102)}\n`));

    expect(broker.request).toHaveBeenCalledOnce();
    const immediate = child.stdin.write.mock.calls.map(([line]) => JSON.parse(line));
    expect(immediate).toContainEqual(expect.objectContaining({
      id: 102,
      error: { code: -32000, message: 'Permission request already pending' }
    }));
    expect(immediate.some((message) => message.id === 101)).toBe(false);

    settleApproval(false);
    await vi.waitFor(() => {
      const messages = child.stdin.write.mock.calls.map(([line]) => JSON.parse(line));
      expect(messages).toContainEqual(expect.objectContaining({ id: 101, result: expect.any(Object) }));
    });
    executor.abort(task.id);
    child.emit('close', 0);
  });

  it('限制单任务同步涌入的客户端请求数量', () => {
    const db = makeDb({ 'eng-acp-worker': { acpCommand: ['acp-worker', 'acp'] } });
    const broker = { request: vi.fn(), abandonTask: vi.fn() };
    const executor = new AcpExecutor(db as never, broker as never);

    executor.start(task as never, agent as never, callbacks() as never);
    const requests = Array.from({ length: MAX_ACP_INBOUND_REQUESTS_PER_TASK + 1 }, (_, index) => JSON.stringify({
      jsonrpc: '2.0', id: 200 + index, method: `unsupported/${index}`, params: {}
    })).join('\n');
    child.stdout.emit('data', Buffer.from(`${requests}\n`));

    const messages = child.stdin.write.mock.calls.map(([line]) => JSON.parse(line));
    expect(messages).toContainEqual(expect.objectContaining({
      id: 200 + MAX_ACP_INBOUND_REQUESTS_PER_TASK,
      error: expect.objectContaining({ code: -32000, message: expect.stringContaining('concurrency limit') })
    }));
    expect(broker.request).not.toHaveBeenCalled();
    executor.abort(task.id);
    child.emit('close', 0);
  });

  it('累计客户端请求超限会终止进程并清理已有审批', async () => {
    vi.useFakeTimers();
    const db = makeDb({ 'eng-acp-worker': { acpCommand: ['acp-worker', 'acp'] } });
    let settleApproval!: (approved: boolean) => void;
    const broker = {
      request: vi.fn(() => new Promise<boolean>((resolve) => { settleApproval = resolve; })),
      abandonTask: vi.fn(() => settleApproval?.(false))
    };
    const executor = new AcpExecutor(db as never, broker as never);
    const cb = callbacks();

    try {
      executor.start(task as never, agent as never, cb as never);
      child.stdout.emit('data', Buffer.from(`${permissionRequestLine(7999)}\n`));
      expect(broker.request).toHaveBeenCalledOnce();

      for (let index = 0; index < MAX_ACP_INBOUND_REQUESTS_PER_TASK_TOTAL; index += 1) {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({
          jsonrpc: '2.0', id: 8000 + index, method: 'unsupported/sequential', params: {}
        })}\n`));
        await Promise.resolve();
      }

      expect(cb.onError).toHaveBeenCalledOnce();
      expect(cb.onError.mock.calls[0][1]).toBe(`ACP client request event limit exceeded (${MAX_ACP_INBOUND_REQUESTS_PER_TASK_TOTAL})`);
      expect(broker.abandonTask).toHaveBeenCalledWith(task.id);
      expect(child.stdin.end).toHaveBeenCalledOnce();
      expect(child.killed).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(child.killed).toBe(true);
      child.emit('close', 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['cancel', 'close', 'timeout'] as const)(
    '%s 会在审批 Promise 未 settle 时立即归还全局请求配额',
    async (exitKind) => {
      if (exitKind === 'timeout') vi.useFakeTimers();
      const db = makeDb({ 'eng-acp-worker': { acpCommand: ['acp-worker', 'acp'] } });
      const broker = {
        request: vi.fn(() => new Promise<boolean>(() => {})),
        abandonTask: vi.fn()
      };
      const executor = new AcpExecutor(db as never, broker as never);
      const cb = callbacks();

      try {
        executor.start(task as never, agent as never, cb as never);
        child.stdout.emit('data', Buffer.from(`${permissionRequestLine(9000)}\n`));
        expect((executor as any).inboundRequestsInFlight).toBe(1);

        if (exitKind === 'cancel') executor.abort(task.id);
        else if (exitKind === 'close') child.emit('close', 1);
        else await vi.advanceTimersByTimeAsync(15 * 60_000);

        expect((executor as any).inboundRequestsInFlight).toBe(0);
        expect(broker.abandonTask).toHaveBeenCalledWith(task.id);

        if (exitKind !== 'close') child.emit('close', exitKind === 'timeout' ? 1 : 0);
      } finally {
        if (exitKind === 'timeout') vi.useRealTimers();
      }
    }
  );

  it('限制执行器全局未决客户端请求且超限请求不进入审批代理', async () => {
    const db = makeDb({ 'eng-acp-worker': { acpCommand: ['acp-worker', 'acp'] } });
    const approvalResolvers = new Map<string, (approved: boolean) => void>();
    const broker = {
      request: vi.fn((request: { taskId: string }) => new Promise<boolean>((resolve) => {
        approvalResolvers.set(request.taskId, resolve);
      })),
      abandonTask: vi.fn((taskId: string) => {
        approvalResolvers.get(taskId)?.(false);
        approvalResolvers.delete(taskId);
      })
    };
    const executor = new AcpExecutor(db as never, broker as never);
    const children: FakeChild[] = [];
    const tasks = Array.from({ length: MAX_ACP_INBOUND_REQUESTS_GLOBAL + 1 }, (_, index) => ({
      ...task,
      id: `global-limit-${index}`
    }));

    for (const [index, currentTask] of tasks.entries()) {
      executor.start(currentTask as never, agent as never, callbacks() as never);
      children.push(child);
      child.stdout.emit('data', Buffer.from(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 500 + index,
        method: 'session/request_permission',
        params: {
          toolCall: { title: 'write file' },
          options: [{ optionId: 'reject', kind: 'reject_once' }]
        }
      })}\n`));
    }

    expect(broker.request).toHaveBeenCalledTimes(MAX_ACP_INBOUND_REQUESTS_GLOBAL);
    const rejectedMessages = children.at(-1)!.stdin.write.mock.calls.map(([line]) => JSON.parse(line));
    expect(rejectedMessages).toContainEqual(expect.objectContaining({
      id: 500 + MAX_ACP_INBOUND_REQUESTS_GLOBAL,
      error: expect.objectContaining({ code: -32000, message: expect.stringContaining('concurrency limit') })
    }));

    tasks.forEach((currentTask, index) => {
      executor.abort(currentTask.id);
      children[index].emit('close', 0);
    });
    await vi.waitFor(() => expect(approvalResolvers.size).toBe(0));
  });

  it('普通 external ACP 会按实际进程环境脱敏输出、结果、工具事件和审批文本', async () => {
    resolvedEnv = { OPENAI_API_KEY: 'external-secret' };
    const db = makeDb({ 'eng-acp-worker': { acpCommand: ['acp-worker', 'acp'] } });
    const inserts: unknown[][] = [];
    const originalPrepare = db.raw.prepare;
    db.raw.prepare = (sql: string) => {
      const statement = originalPrepare(sql);
      return {
        ...statement,
        run: (...args: unknown[]) => {
          if (/INSERT INTO task_events/.test(sql)) inserts.push(args);
          return { changes: 1 };
        }
      };
    };
    const broker = { request: vi.fn(() => Promise.resolve(false)), abandonTask: vi.fn() };
    const executor = new AcpExecutor(db as never, broker as never);
    const cb = callbacks();

    executor.start(task as never, agent as never, cb as never);
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'));
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledTimes(2));
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"sessionId":"external"}}\n'));
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledTimes(3));
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { sessionUpdate: 'tool_call', title: 'Bearer external-secret denied' } }
    })}\n`));
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      method: 'session/request_permission',
      params: {
        toolCall: { title: 'use external-secret to write' },
        options: [
          { optionId: 'allow', kind: 'allow_once' },
          { optionId: 'reject', kind: 'reject_once' }
        ]
      }
    })}\n`));
    await vi.waitFor(() => expect(broker.request).toHaveBeenCalledOnce());
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'external-' } } }
    })}\n`));
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'secret response' } } }
    })}\n`));
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}\n'));

    await vi.waitFor(() => expect(cb.onDone).toHaveBeenCalledOnce());
    const streamed = cb.onOutput.mock.calls.map((call) => call[1]).join('');
    expect(streamed).toContain('[REDACTED]');
    expect(streamed).not.toContain('external-secret');
    expect(cb.onDone.mock.calls[0][1]).not.toContain('external-secret');
    expect(String(inserts[0][3])).toContain('[REDACTED]');
    expect(String(inserts[0][3])).not.toContain('external-secret');
    expect(broker.request.mock.calls[0][0].request).toContain('[REDACTED]');
    expect(broker.request.mock.calls[0][0].request).not.toContain('external-secret');
    child.emit('close', 0);
  });

  it('普通 external ACP 会脱敏 RPC 与 stderr 错误', async () => {
    resolvedEnv = { ENGINE_TOKEN: 'external-error-secret' };
    const db = makeDb({ 'eng-acp-worker': { acpCommand: ['acp-worker', 'acp'] } });
    const executor = new AcpExecutor(db as never, { request: vi.fn(), abandonTask: vi.fn() } as never);
    const rpcCallbacks = callbacks();

    executor.start(task as never, agent as never, rpcCallbacks as never);
    child.stdout.emit('data', Buffer.from(
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"external-error-secret rejected"}}\n'
    ));
    await vi.waitFor(() => expect(rpcCallbacks.onError).toHaveBeenCalledOnce());
    expect(rpcCallbacks.onError.mock.calls[0][1]).toContain('[REDACTED]');
    expect(rpcCallbacks.onError.mock.calls[0][1]).not.toContain('external-error-secret');
    child.emit('close', 1);

    const stderrCallbacks = callbacks();
    executor.start({ ...task, id: 't-stderr' } as never, agent as never, stderrCallbacks as never);
    child.stderr.emit('data', Buffer.from('provider rejected external-error-secret'));
    child.emit('close', 1);
    expect(stderrCallbacks.onError).toHaveBeenCalledOnce();
    expect(stderrCallbacks.onError.mock.calls[0][1]).toContain('[REDACTED]');
    expect(stderrCallbacks.onError.mock.calls[0][1]).not.toContain('external-error-secret');
  });

  it('ACP 任务的 JSON-RPC 错误不会把 API Key 交给终止回调', async () => {
    resolvedEnv = { OPENAI_API_KEY: 'worker-secret' };
    const db = makeDb({ 'eng-acp-worker': { acpCommand: ['acp-worker'] } });
    const executor = new AcpExecutor(db as never, { request: vi.fn(), abandonTask: vi.fn() } as never);
    const cb = callbacks();

    executor.start(task as never, agent as never, cb as never);
    child.stdout.emit('data', Buffer.from(
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"Bearer worker-secret rejected"}}\n'
    ));
    await vi.waitFor(() => expect(child.stdin.end).toHaveBeenCalledOnce());
    expect(cb.onError).toHaveBeenCalledOnce();
    expect(cb.onError.mock.calls[0][1]).toContain('[REDACTED]');
    expect(cb.onError.mock.calls[0][1]).not.toContain('worker-secret');

    child.emit('close', 1);
    expect(cb.onError).toHaveBeenCalledOnce();
  });

  it('ACP 任务的 stderr 退出错误不会泄露 API Key', () => {
    resolvedEnv = { OPENAI_API_KEY: 'worker-secret' };
    const db = makeDb({ 'eng-acp-worker': { acpCommand: ['acp-worker'] } });
    const executor = new AcpExecutor(db as never, { request: vi.fn(), abandonTask: vi.fn() } as never);
    const cb = callbacks();

    executor.start(task as never, agent as never, cb as never);
    child.stderr.emit('data', Buffer.from('provider rejected worker-secret'));
    child.emit('close', 1);

    expect(cb.onError).toHaveBeenCalledOnce();
    expect(cb.onError.mock.calls[0][1]).toContain('[REDACTED]');
    expect(cb.onError.mock.calls[0][1]).not.toContain('worker-secret');
  });

  it('ACP 任务会脱敏跨 chunk 模型输出、最终结果和工具事件', async () => {
    resolvedEnv = { OPENAI_API_KEY: 'worker-secret' };
    const db = makeDb({ 'eng-acp-worker': { acpCommand: ['acp-worker'] } });
    const inserts: unknown[][] = [];
    const originalPrepare = db.raw.prepare;
    db.raw.prepare = (sql: string) => {
      const statement = originalPrepare(sql);
      return {
        ...statement,
        run: (...args: unknown[]) => {
          if (/INSERT INTO task_events/.test(sql)) inserts.push(args);
          return { changes: 1 };
        }
      };
    };
    const executor = new AcpExecutor(db as never, { request: vi.fn(), abandonTask: vi.fn() } as never);
    const cb = callbacks();

    executor.start(task as never, agent as never, cb as never);
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'));
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledTimes(2));
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"sessionId":"managed"}}\n'));
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledTimes(3));
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { sessionUpdate: 'tool_call', title: 'Bearer worker-secret rejected' } }
    })}\n`));
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Bearer worker-' } } }
    })}\n`));
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'secret rejected' } } }
    })}\n`));
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}\n'));
    await vi.waitFor(() => expect(child.stdin.end).toHaveBeenCalledOnce());
    child.emit('close', 0);

    const streamed = cb.onOutput.mock.calls.map((call) => call[1]).join('');
    expect(streamed).toContain('[REDACTED]');
    expect(streamed).not.toContain('worker-secret');
    expect(cb.onDone).toHaveBeenCalledOnce();
    expect(cb.onDone.mock.calls[0][1]).not.toContain('worker-secret');
    expect(String(inserts[0][3])).toContain('[REDACTED] rejected');
    expect(String(inserts[0][3])).not.toContain('worker-secret');
  });

  it('限制 sidecar 错误、工具标题和审批请求的文本长度', async () => {
    const db = makeDb({ 'eng-acp-worker': { acpCommand: ['acp-worker', 'acp'] } });
    const broker = { request: vi.fn(() => Promise.resolve(false)), abandonTask: vi.fn() };
    const executor = new AcpExecutor(db as never, broker as never);
    const cb = callbacks();
    const inserts: unknown[][] = [];
    db.raw.prepare = (sql: string) => ({
      get: (id: string) => {
        if (/SELECT .*config_json.* FROM engines/.test(sql)) {
          return { config_json: JSON.stringify({ acpCommand: ['acp-worker', 'acp'] }), path: null };
        }
        if (/SELECT status FROM engines/.test(sql)) return { status: 'HEALTHY' };
        return undefined;
      },
      run: (...args: unknown[]) => {
        if (/INSERT INTO task_events/.test(sql)) inserts.push(args);
        return { changes: 1 };
      },
      all: () => []
    });

    executor.start(task as never, agent as never, cb as never);
    const longTitle = 'T'.repeat(MAX_ACP_TOOL_TITLE_CHARS + 500);
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { sessionUpdate: 'tool_call', title: longTitle } }
    })}\n`));
    const toolPayload = JSON.parse(String(inserts[0][3]));
    expect(toolPayload.name.length).toBeLessThanOrEqual(MAX_ACP_TOOL_TITLE_CHARS);

    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      method: 'session/request_permission',
      params: {
        toolCall: { title: longTitle },
        options: [
          { optionId: 'allow', kind: 'allow_once' },
          { optionId: 'reject', kind: 'reject_once' }
        ]
      }
    })}\n`));
    await vi.waitFor(() => expect(broker.request).toHaveBeenCalledOnce());
    expect(broker.request.mock.calls[0][0].request.length).toBeLessThanOrEqual(MAX_ACP_APPROVAL_REQUEST_CHARS);

    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32000, message: 'E'.repeat(MAX_ACP_ERROR_CHARS + 500) }
    })}\n`));
    await vi.waitFor(() => expect(cb.onError).toHaveBeenCalledOnce());
    expect(cb.onError.mock.calls[0][1].length).toBeLessThanOrEqual(MAX_ACP_ERROR_CHARS);
  });

  it('握手和最小任务探测都会脱敏 RPC 错误', async () => {
    const env = { ELECTRON_RUN_AS_NODE: '1', OPENAI_API_KEY: 'probe-secret' };
    const engineProbe = probeAcpEngine(['electron', 'entry.mjs'], env);
    child.stdout.emit('data', Buffer.from(
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"Bearer probe-secret denied"}}\n'
    ));
    child.emit('close', 1);
    const engineResult = await engineProbe;
    expect(engineResult.message).toContain('[REDACTED]');
    expect(engineResult.message).not.toContain('probe-secret');

    const taskProbe = probeAcpTask(
      ['electron', 'entry.mjs'],
      env,
      'D:\\probe',
      2_000
    );
    child.stdout.emit('data', Buffer.from(
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"probe-secret denied"}}\n'
    ));
    child.emit('close', 1);
    const taskResult = await taskProbe;
    expect(taskResult.message).toContain('[REDACTED]');
    expect(taskResult.message).not.toContain('probe-secret');
  });

  it('普通 external ACP 的最小任务探测也会脱敏模型输出', async () => {
    const env = { EXTERNAL_API_TOKEN: 'external-probe-secret' };
    const probe = probeAcpTask(['acp-worker', 'acp'], env, 'D:\\probe', 2_000);
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'));
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledTimes(2));
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"sessionId":"probe"}}\n'));
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledTimes(3));
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'external-probe-' }
        }
      }
    })}\n`));
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'secret echoed' }
        }
      }
    })}\n`));
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}\n'));

    const result = await probe;
    expect(result.ok).toBe(true);
    expect(result.output).toContain('[REDACTED]');
    expect(result.output).not.toContain('external-probe-secret');
  });

  it('最小任务探测不会把模型回显的 API Key 写入健康详情', async () => {
    const env = { ELECTRON_RUN_AS_NODE: '1', OPENAI_API_KEY: 'probe-secret' };
    const probe = probeAcpTask(
      ['electron', 'entry.mjs'],
      env,
      'D:\\probe',
      2_000
    );
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'));
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledTimes(2));
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"sessionId":"probe"}}\n'));
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledTimes(3));
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Bearer probe-' } } }
    })}\n`));
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'secret denied' } } }
    })}\n`));
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}\n'));
    child.emit('close', 0);

    const result = await probe;
    expect(result.output).toContain('[REDACTED]');
    expect(result.output).not.toContain('probe-secret');
  });

  it('拒绝没有换行且超过上限的 ACP 帧，并等待 close 后释放', async () => {
    const db = makeDb({ 'eng-acp-worker': { acpCommand: ['acp-worker', 'acp'] } });
    const executor = new AcpExecutor(db as never, { request: vi.fn(), abandonTask: vi.fn() } as never);
    const cb = callbacks();

    executor.start(task as never, agent as never, cb as never);
    child.stdout.emit('data', Buffer.alloc(MAX_ACP_FRAME_BYTES + 1, 0x78));

    await vi.waitFor(() => expect(cb.onError).toHaveBeenCalledOnce());
    expect(cb.onError.mock.calls[0][1]).toContain('frame exceeds maximum size');
    expect(cb.onReleased).not.toHaveBeenCalled();
    child.emit('close', 1);
    expect(cb.onReleased).toHaveBeenCalledOnce();
  });

  it('限制 session/update 总数', async () => {
    const db = makeDb({ 'eng-acp-worker': { acpCommand: ['acp-worker', 'acp'] } });
    const executor = new AcpExecutor(db as never, { request: vi.fn(), abandonTask: vi.fn() } as never);
    const cb = callbacks();
    const update = '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_thought_chunk"}}}\n';

    executor.start(task as never, agent as never, cb as never);
    child.stdout.emit('data', Buffer.from(update.repeat(MAX_ACP_UPDATE_EVENTS + 1)));

    await vi.waitFor(() => expect(cb.onError).toHaveBeenCalledOnce());
    expect(cb.onError.mock.calls[0][1]).toContain('update event limit exceeded');
    expect(cb.onError).toHaveBeenCalledOnce();
  });

  it('限制 tool_call 与 tool_call_update 总数', async () => {
    const db = makeDb({ 'eng-acp-worker': { acpCommand: ['acp-worker', 'acp'] } });
    const executor = new AcpExecutor(db as never, { request: vi.fn(), abandonTask: vi.fn() } as never);
    const cb = callbacks();
    const update = '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","status":"pending"}}}\n';

    executor.start(task as never, agent as never, cb as never);
    child.stdout.emit('data', Buffer.from(update.repeat(MAX_ACP_TOOL_EVENTS + 1)));

    await vi.waitFor(() => expect(cb.onError).toHaveBeenCalledOnce());
    expect(cb.onError.mock.calls[0][1]).toContain('tool event limit exceeded');
    expect(cb.onError).toHaveBeenCalledOnce();
  });

  it('握手和最小任务探测同样拒绝超大无换行帧', async () => {
    const engineProbe = probeAcpEngine(['acp-worker', 'acp']);
    child.stdout.emit('data', Buffer.alloc(MAX_ACP_FRAME_BYTES + 1, 0x78));
    await expect(engineProbe).resolves.toMatchObject({ ok: false, message: expect.stringContaining('frame exceeds maximum size') });

    const taskProbe = probeAcpTask(['acp-worker', 'acp'], {}, 'D:\\probe', 2_000);
    child.stdout.emit('data', Buffer.alloc(MAX_ACP_FRAME_BYTES + 1, 0x78));
    await expect(taskProbe).resolves.toMatchObject({ ok: false, message: expect.stringContaining('frame exceeds maximum size') });
  });
});
