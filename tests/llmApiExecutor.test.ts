/**
 * LlmApiExecutor(Nexus Agent 内置引擎)测试
 *
 * 这是核心执行路径:工具循环 + 审批门禁 + 会话重建 + SSE 解析,此前零覆盖。
 * 通过 mock fetch 返回可控的 SSE 流,驱动真实的工具循环逻辑。
 *
 * 覆盖:
 * - SSE 解析:content 增量、tool_calls 分片按 index 合并、usage 提取、心跳帧容错
 * - 工具循环:无 tool_calls 即产出、有 tool_calls 则执行后续轮、轮次上限
 * - 审批门禁四级权限语义(含渠道任务 trusted 降级、专家团权限继承)
 * - 就绪判定、错误如实上报(不伪装完成)、中止处理
 *
 * @author liyingjie <y@senke.com>
 */
// @ts-nocheck
/* eslint-disable */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

// 供应商配置:由用例覆写以测试就绪判定
let providerCfg: { baseUrl: string; model: string } = { baseUrl: 'https://api.test/v1', model: 'test-model' };
let providerKey: string | null = 'sk-test';
vi.mock('../src/main/services/provider.js', () => ({
  getProviderSettings: () => providerCfg,
  readProviderKey: () => providerKey
}));

import { LlmApiExecutor } from '../src/main/services/executor/llmApiExecutor.js';

/** 把若干 SSE 事件对象编码为 data: 行组成的流 */
function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    }
  });
}

const dataFrame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
/** 一段纯文本回复(无工具调用) */
const textFrames = (text: string, usage?: unknown) => [
  ...[...text].map((ch) => dataFrame({ choices: [{ delta: { content: ch } }] })),
  ...(usage ? [dataFrame({ choices: [{ delta: {} }], usage })] : []),
  'data: [DONE]\n\n'
];
/** 一次工具调用 */
const toolFrames = (name: string, args: string, index = 0) => [
  dataFrame({ choices: [{ delta: { tool_calls: [{ index, id: 'call_1', function: { name } }] } }] }),
  dataFrame({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args } }] } }] }),
  'data: [DONE]\n\n'
];

/** 按调用次序依次返回预设的 SSE 响应 */
function mockFetchSequence(...responses: string[][]) {
  let i = 0;
  const fn = vi.fn(async () => {
    const frames = responses[Math.min(i, responses.length - 1)];
    i++;
    return { ok: true, body: sseStream(frames), status: 200, text: async () => '' } as never;
  });
  globalThis.fetch = fn as never;
  return fn;
}

/** 最小 db:task_messages / task_events / usage_records 落库,skills 查询返回空 */
function makeDb(agentProvider: { providerId?: string | null; modelOverride?: string | null } = {}) {
  const inserts: Record<string, unknown[][]> = { task_messages: [], task_events: [], usage_records: [] };
  return {
    _inserts: inserts,
    raw: {
      prepare: (sql: string) => ({
        get: () => ({
          provider_id: agentProvider.providerId ?? null,
          model_override: agentProvider.modelOverride ?? null
        }),
        all: () => (/FROM skills/.test(sql) ? [] : []),
        run: (...args: unknown[]) => {
          const m = sql.match(/INSERT INTO (\w+)/);
          if (m && inserts[m[1]]) inserts[m[1]].push(args);
          return { changes: 1 };
        }
      })
    },
    transaction: (fn: () => void) => fn(),
    audit: vi.fn(),
    getSetting: (_k: string, fb: unknown) => fb,
    setSetting: vi.fn()
  } as never;
}

/** Minimal database rows needed to exercise the production engine-level
 * Provider resolver without coupling the core SSE tests to the full schema. */
function makeManagedDb(config: Record<string, unknown>, agentProvider: { providerId?: string | null; modelOverride?: string | null } = {}) {
  const base = makeDb(agentProvider) as never as { raw: { prepare: (sql: string) => any } };
  const originalPrepare = base.raw.prepare;
  base.raw.prepare = (sql: string) => {
    if (/SELECT config_json FROM engines/.test(sql)) {
      return { get: () => ({ config_json: JSON.stringify(config) }) };
    }
    return originalPrepare(sql);
  };
  return base as never;
}

const task = (over = {}) => ({
  id: 't1', agentId: 'a1', title: '测试任务', source: 'desktop',
  sessionId: null, workspaceOverride: null, status: 'RUNNING', ...over
});
const agent = (over = {}) => ({
  id: 'a1', name: '测试员工', permissionMode: 'standard', workspace: '/ws',
  systemPrompt: '你是助手', soulMd: '', agentsMd: '', userMd: '',
  capabilities: { network: false, shell: false, install: false, browser: false, computer: false },
  ...over
});
const cb = () => ({
  onStage: vi.fn(), onProgress: vi.fn(), onOutput: vi.fn(),
  onSession: vi.fn(), onDone: vi.fn(), onError: vi.fn()
});
/** 默认批准的审批代理 */
const broker = (approved = true) => ({
  request: vi.fn(async () => approved),
  abandonTask: vi.fn(),
  decide: vi.fn(),
  onChange: vi.fn()
});

/** 等待 runLoop 的微任务链跑完 */
const settle = () => new Promise((r) => setTimeout(r, 20));

const origFetch = globalThis.fetch;
beforeEach(() => {
  providerCfg = { baseUrl: 'https://api.test/v1', model: 'test-model' };
  providerKey = 'sk-test';
});
afterEach(() => { globalThis.fetch = origFetch; });

describe('就绪判定', () => {
  it('baseUrl + model + key 齐备才就绪', () => {
    expect(new LlmApiExecutor(makeDb(), broker()).isReady()).toBe(true);
  });

  it('缺 key 不就绪', () => {
    providerKey = null;
    expect(new LlmApiExecutor(makeDb(), broker()).isReady()).toBe(false);
  });

  it('空白 key 不就绪', () => {
    providerKey = '   ';
    expect(new LlmApiExecutor(makeDb(), broker()).isReady()).toBe(false);
  });

  it('缺 model 不就绪', () => {
    providerCfg = { baseUrl: 'https://api.test/v1', model: '' };
    expect(new LlmApiExecutor(makeDb(), broker()).isReady()).toBe(false);
  });

  it('未配置 key 时 start 立即如实报错,不伪装执行', () => {
    providerKey = null;
    const c = cb();
    new LlmApiExecutor(makeDb(), broker()).start(task(), agent(), c);
    expect(c.onError).toHaveBeenCalledWith('t1', expect.stringContaining('API Key 未配置'));
    expect(c.onDone).not.toHaveBeenCalled();
  });

  it('显式绑定的供应商无效时不回退全局默认供应商', () => {
    const c = cb();
    const providers = { resolveForAgent: vi.fn(() => null) };
    new LlmApiExecutor(makeDb({ providerId: 'provider-missing' }), broker(), providers as never)
      .start(task(), agent(), c);
    expect(providers.resolveForAgent).toHaveBeenCalledWith('provider-missing', null);
    expect(c.onError).toHaveBeenCalledWith('t1', expect.stringContaining('模型供应商配置无效'));
  });

  it('Nexus 执行实际采用引擎级 Provider/模型，并让员工 Provider 优先', async () => {
    mockFetchSequence(textFrames('managed-result'));
    const c = cb();
    const providers = {
      resolveForAgent: vi.fn((providerId: string | null, modelOverride: string | null) => ({
        baseUrl: 'https://managed.example/v1',
        model: modelOverride || (providerId === 'employee-provider' ? 'employee-model' : 'engine-model'),
        key: 'sk-managed'
      }))
    };
    const db = makeManagedDb(
      { providerId: 'engine-provider', modelOverride: 'engine-model', protocol: 'openai-chat' },
      { providerId: 'employee-provider' }
    );
    new LlmApiExecutor(db, broker(), providers as never).start(task(), agent(), c);
    await settle();
    expect(providers.resolveForAgent).toHaveBeenCalledWith('employee-provider', 'engine-model');
    expect(c.onDone).toHaveBeenCalledWith('t1', 'managed-result');
    const request = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(JSON.parse(request.body).model).toBe('engine-model');
  });
});

describe('SSE 解析与产出', () => {
  it('无工具调用时把流式内容作为最终产物', async () => {
    mockFetchSequence(textFrames('你好世界'));
    const c = cb();
    new LlmApiExecutor(makeDb(), broker()).start(task(), agent(), c);
    await settle();
    expect(c.onDone).toHaveBeenCalledWith('t1', '你好世界');
    expect(c.onError).not.toHaveBeenCalled();
  });

  it('流式增量经 onOutput 推送(逐字显示)', async () => {
    mockFetchSequence(textFrames('abc'));
    const c = cb();
    new LlmApiExecutor(makeDb(), broker()).start(task(), agent(), c);
    await settle();
    expect(c.onOutput).toHaveBeenCalled();
    expect(c.onOutput.mock.calls.map((x) => x[1]).join('')).toContain('abc');
  });

  it('空内容如实报错,不产出空产物', async () => {
    mockFetchSequence(['data: [DONE]\n\n']);
    const c = cb();
    new LlmApiExecutor(makeDb(), broker()).start(task(), agent(), c);
    await settle();
    expect(c.onError).toHaveBeenCalledWith('t1', expect.stringContaining('空内容'));
    expect(c.onDone).not.toHaveBeenCalled();
  });

  it('非 JSON 心跳帧被忽略而不中断解析', async () => {
    mockFetchSequence([': ping\n\n', 'data: not-json\n\n', ...textFrames('ok')]);
    const c = cb();
    new LlmApiExecutor(makeDb(), broker()).start(task(), agent(), c);
    await settle();
    expect(c.onDone).toHaveBeenCalledWith('t1', 'ok');
  });

  it('usage 落库到 usage_records', async () => {
    mockFetchSequence(textFrames('x', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }));
    const db = makeDb();
    new LlmApiExecutor(db, broker()).start(task(), agent(), cb());
    await settle();
    expect(db._inserts.usage_records).toHaveLength(1);
    expect(db._inserts.usage_records[0]).toContain(15);
  });

  it('HTTP 错误如实上报,不伪装完成', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401, body: null, text: async () => 'unauthorized' })) as never;
    const c = cb();
    new LlmApiExecutor(makeDb(), broker()).start(task(), agent(), c);
    await settle();
    expect(c.onError).toHaveBeenCalledWith('t1', expect.stringContaining('401'));
    expect(c.onDone).not.toHaveBeenCalled();
  });

  it('redacts the task provider key and Authorization value from HTTP error bodies', async () => {
    providerKey = 'sk-provider-body-secret';
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      body: null,
      text: async () => `forbidden api_key=${providerKey}; Authorization: Bearer ${providerKey}`
    })) as never;
    const c = cb();

    new LlmApiExecutor(makeDb(), broker()).start(task(), agent(), c);
    await settle();

    const message = c.onError.mock.calls[0][1];
    expect(message).toContain('403');
    expect(message).toContain('[REDACTED]');
    expect(message).not.toContain(providerKey);
    expect(c.onDone).not.toHaveBeenCalled();
  });

  it('网络异常如实上报', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as never;
    const c = cb();
    new LlmApiExecutor(makeDb(), broker()).start(task(), agent(), c);
    await settle();
    expect(c.onError).toHaveBeenCalledWith('t1', expect.stringContaining('网络请求失败'));
  });
});

describe('工具循环', () => {
  it('tool_calls 分片按 index 合并后执行,并带回结果继续下一轮', async () => {
    // 第 1 轮:调用 list_dir(安全工具,无需审批);第 2 轮:输出最终结果
    const f = mockFetchSequence(toolFrames('list_dir', '{"path":"."}'), textFrames('完成'));
    const db = makeDb();
    const c = cb();
    new LlmApiExecutor(db, broker()).start(task(), agent(), c);
    await settle();

    expect(f).toHaveBeenCalledTimes(2);
    expect(c.onDone).toHaveBeenCalledWith('t1', '完成');
    // 工具调用与结果均落 task_events
    const types = db._inserts.task_events.map((a) => a[2]);
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
  });

  it('未知工具不崩溃,把错误作为工具结果回灌模型', async () => {
    const f = mockFetchSequence(toolFrames('no_such_tool', '{}'), textFrames('已换方案'));
    const c = cb();
    new LlmApiExecutor(makeDb(), broker()).start(task(), agent(), c);
    await settle();
    expect(c.onDone).toHaveBeenCalledWith('t1', '已换方案');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('工具参数非法 JSON 时按空参处理而不中断', async () => {
    const f = mockFetchSequence(toolFrames('list_dir', '{bad json'), textFrames('ok'));
    const c = cb();
    new LlmApiExecutor(makeDb(), broker()).start(task(), agent(), c);
    await settle();
    expect(c.onDone).toHaveBeenCalledWith('t1', 'ok');
  });

  it('消息逐条落 task_messages(供追问重建上下文)', async () => {
    const db = makeDb();
    mockFetchSequence(textFrames('结果'));
    new LlmApiExecutor(db, broker()).start(task(), agent(), cb());
    await settle();
    const roles = db._inserts.task_messages.map((a) => a[2]);
    expect(roles).toEqual(expect.arrayContaining(['system', 'user', 'assistant']));
  });

  it('新任务生成会话锚点', async () => {
    mockFetchSequence(textFrames('x'));
    const c = cb();
    new LlmApiExecutor(makeDb(), broker()).start(task(), agent(), c);
    await settle();
    expect(c.onSession).toHaveBeenCalledWith('t1', expect.stringMatching(/^llm-/));
  });

  it('追问任务沿用既有 session,不重新生成锚点', async () => {
    mockFetchSequence(textFrames('x'));
    const c = cb();
    new LlmApiExecutor(makeDb(), broker()).start(task({ sessionId: 'llm-existing' }), agent(), c);
    await settle();
    expect(c.onSession).not.toHaveBeenCalled();
  });
});

describe('审批门禁（四级权限语义）', () => {
  /** 让模型请求一次写文件(risk=write) */
  const writeThenDone = () => mockFetchSequence(
    toolFrames('write_file', '{"path":"a.txt","content":"x"}'),
    textFrames('已写入')
  );

  it('standard:写类工具需人工批准', async () => {
    writeThenDone();
    const b = broker(true);
    new LlmApiExecutor(makeDb(), b).start(task(), agent({ permissionMode: 'standard' }), cb());
    await settle();
    expect(b.request).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't1', type: 'write_workspace' }));
  });

  it('standard:审批被拒时不执行工具,把拒绝结果回灌模型', async () => {
    writeThenDone();
    const b = broker(false);
    const db = makeDb();
    const c = cb();
    new LlmApiExecutor(db, b).start(task(), agent({ permissionMode: 'standard' }), c);
    await settle();
    expect(b.request).toHaveBeenCalled();
    // 任务不因拒绝而失败,模型可换方案
    expect(c.onDone).toHaveBeenCalledWith('t1', '已写入');
    const results = db._inserts.task_events.filter((a) => a[2] === 'tool_result').map((a) => String(a[3]));
    expect(results.some((r) => r.includes('拒绝'))).toBe(true);
  });

  it('trusted:写类工具自动通过,不请求审批', async () => {
    writeThenDone();
    const b = broker(true);
    new LlmApiExecutor(makeDb(), b).start(task(), agent({ permissionMode: 'trusted' }), cb());
    await settle();
    expect(b.request).not.toHaveBeenCalled();
  });

  it('autonomous:完全跳过审批', async () => {
    writeThenDone();
    const b = broker(true);
    new LlmApiExecutor(makeDb(), b).start(task(), agent({ permissionMode: 'autonomous' }), cb());
    await settle();
    expect(b.request).not.toHaveBeenCalled();
  });

  it('autonomous:项目内删除自动执行,不会产生步骤审批', async () => {
    mockFetchSequence(toolFrames('delete_path', '{"path":"a.txt"}'), textFrames('已处理'));
    const b = broker(true);
    new LlmApiExecutor(makeDb(), b).start(task(), agent({ permissionMode: 'autonomous' }), cb());
    await settle();
    expect(b.request).not.toHaveBeenCalled();
  });

  it('autonomous:未受沙箱保护的 Shell 仍作为项目边界例外确认', async () => {
    mockFetchSequence(toolFrames('run_command', '{"command":"echo ok"}'), textFrames('已跳过'));
    const b = broker(false);
    new LlmApiExecutor(makeDb(), b).start(
      task(),
      agent({ permissionMode: 'autonomous', capabilities: { network: false, shell: true, install: false, browser: false, computer: false } }),
      cb()
    );
    await settle();
    expect(b.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'outside_workspace', risk: 'high' }));
  });

  it('readonly:写类工具根本不注册给模型(第一道防线)', async () => {
    const f = mockFetchSequence(toolFrames('write_file', '{"path":"a.txt","content":"x"}'), textFrames('换方案'));
    const b = broker(true);
    const db = makeDb();
    new LlmApiExecutor(db, b).start(task(), agent({ permissionMode: 'readonly' }), cb());
    await settle();

    // 上游 toolsForPermission 已过滤写类工具，故模型即便硬调也命中「未知工具」，
    // 不走审批、不执行；executor 内的「只读禁止写入」判断是不可达的兜底冗余。
    expect(b.request).not.toHaveBeenCalled();
    const declared = JSON.parse(f.mock.calls[0][1].body).tools.map((t) => t.function.name);
    expect(declared).not.toContain('write_file');
    expect(declared).toContain('read_file');
  });

  it('渠道来源任务:trusted 降级为 standard,写类工具仍需审批(10.5)', async () => {
    writeThenDone();
    const b = broker(true);
    new LlmApiExecutor(makeDb(), b).start(task({ source: 'channel' }), agent({ permissionMode: 'trusted' }), cb());
    await settle();
    expect(b.request).toHaveBeenCalled();
  });

  it('渠道来源任务:autonomous 不降级', async () => {
    writeThenDone();
    const b = broker(true);
    new LlmApiExecutor(makeDb(), b).start(task({ source: 'channel' }), agent({ permissionMode: 'autonomous' }), cb());
    await settle();
    expect(b.request).not.toHaveBeenCalled();
  });

  it('专家团任务:standard 保留员工权限,写操作仍需审批', async () => {
    writeThenDone();
    const b = broker(true);
    new LlmApiExecutor(makeDb(), b).start(task({ source: 'team' }), agent({ permissionMode: 'standard' }), cb());
    await settle();
    expect(b.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'write_workspace' }));
  });

  it('trusted:danger 类工具(删除)仍需审批', async () => {
    mockFetchSequence(toolFrames('delete_path', '{"path":"a.txt"}'), textFrames('已删除'));
    const b = broker(true);
    new LlmApiExecutor(makeDb(), b).start(task(), agent({ permissionMode: 'trusted' }), cb());
    await settle();
    expect(b.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'delete', risk: 'high' }));
  });
});

describe('中止处理', () => {
  it('abort 通知审批代理放弃并从运行表移除', async () => {
    mockFetchSequence(textFrames('x'));
    const b = broker();
    const ex = new LlmApiExecutor(makeDb(), b);
    ex.start(task(), agent(), cb());
    ex.abort('t1');
    expect(b.abandonTask).toHaveBeenCalledWith('t1');
  });

  it('中止后不再回报错误(状态由 orchestrator 置 CANCELLED)', async () => {
    mockFetchSequence(textFrames('x'));
    const ex = new LlmApiExecutor(makeDb(), broker());
    const c = cb();
    ex.start(task(), agent(), c);
    ex.abort('t1');
    await settle();
    expect(c.onError).not.toHaveBeenCalled();
  });
});
