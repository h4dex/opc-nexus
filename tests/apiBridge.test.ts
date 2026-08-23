/**
 * API Bridge 测试(本地 OpenAI 兼容代理)
 *
 * 这是第二个对外网络入口(供外部 CLI 工具直连),鉴权绕过等于泄露供应商密钥额度。
 * 此前零覆盖。用真实 HTTP 服务驱动,覆盖鉴权、路由、错误透传与流式转发。
 *
 * @author liyingjie <y@senke.com>
 */
// @ts-nocheck
/* eslint-disable */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const { safeStorage } = await import('electron');
const { ApiBridge, pathOf, anthropicToOpenAiRequest } = await import('../src/main/services/apiBridge.js');

function makeDb(settings: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...settings };
  return {
    raw: { prepare: () => ({ get: () => undefined, all: () => [], run: () => ({ changes: 1 }) }) },
    transaction: (fn: () => void) => fn(),
    audit: vi.fn(),
    getSetting: (k: string, fb: unknown) => (k in store ? store[k] : fb),
    setSetting: (k: string, v: unknown) => { store[k] = v; },
    _store: store
  } as never;
}

const providers = (list = [], resolved = null) => ({
  list: () => list,
  resolveByModel: () => resolved
}) as never;

function nextSocketMessage(socket: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      cleanup();
      try { resolve(JSON.parse(data.toString())); } catch (error) { reject(error); }
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => {
      socket.off('message', onMessage);
      socket.off('error', onError);
    };
    socket.once('message', onMessage);
    socket.once('error', onError);
  });
}

function openBusinessSocket(bridge: any, base: string, key = bridge.getBridgeKey()): WebSocket {
  const socket = new WebSocket(`${base.replace(/^http:/, 'ws:')}/v1/business/events`, {
    headers: { Authorization: `Bearer ${key}` }
  });
  return socket;
}

/** 启动 bridge 并返回操作系统分配的临时端口基址。 */
async function boot(db, prov) {
  const b = new ApiBridge(db, prov);
  db.setSetting('bridge_port', '0');
  await b.start();
  return { bridge: b, base: `http://127.0.0.1:${b.server.address().port}` };
}

let running: { stop: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(running.map((bridge) => bridge.stop()));
  running = [];
  vi.restoreAllMocks();
});

describe('pathOf：剥离 query 与 fragment', () => {
  it('无 query 时原样返回', () => {
    expect(pathOf('/v1/models')).toBe('/v1/models');
  });

  it('剥离 query —— 客户端常带 ?limit=1，此前会误判 404', () => {
    expect(pathOf('/v1/models?limit=1')).toBe('/v1/models');
    expect(pathOf('/v1/chat/completions?stream=true')).toBe('/v1/chat/completions');
  });

  it('剥离 fragment', () => {
    expect(pathOf('/health#anchor')).toBe('/health');
  });

  it('undefined 与空串安全处理', () => {
    expect(pathOf(undefined)).toBe('');
    expect(pathOf('')).toBe('');
  });
});

describe('鉴权', () => {
  it('健康检查免鉴权', async () => {
    const { bridge, base } = await boot(makeDb(), providers());
    running.push(bridge);
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe('ok');
  });

  it('无 Authorization 头访问 API → 401', async () => {
    const { bridge, base } = await boot(makeDb(), providers());
    running.push(bridge);
    const r = await fetch(`${base}/v1/models`);
    expect(r.status).toBe(401);
    expect((await r.json()).error.code).toBe('invalid_api_key');
  });

  it('错误的 bridge key → 401', async () => {
    const { bridge, base } = await boot(makeDb(), providers());
    running.push(bridge);
    const r = await fetch(`${base}/v1/models`, { headers: { Authorization: 'Bearer sk-wrong' } });
    expect(r.status).toBe(401);
  });

  it('正确的 bridge key 放行', async () => {
    const db = makeDb();
    const { bridge, base } = await boot(db, providers([]));
    running.push(bridge);
    const r = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${bridge.getBridgeKey()}` } });
    expect(r.status).toBe(200);
  });

  it('key 前缀正确但不完整仍被拒（防截断绕过）', async () => {
    const { bridge, base } = await boot(makeDb(), providers());
    running.push(bridge);
    const partial = bridge.getBridgeKey().slice(0, 20);
    const r = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${partial}` } });
    expect(r.status).toBe(401);
  });

  it('不放行任意 Origin（避免任意网页借浏览器打这个端口）', async () => {
    const { bridge, base } = await boot(makeDb(), providers());
    running.push(bridge);
    const r = await fetch(`${base}/health`);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('Bridge Key 管理', () => {
  it('首次获取自动生成并持久化', () => {
    const db = makeDb();
    const b = new ApiBridge(db, providers());
    const k = b.getBridgeKey();
    expect(k).toMatch(/^sk-bridge-[0-9a-f]{48}$/);
    expect(b.getBridgeKey()).toBe(k); // 幂等
  });

  it('重新生成后旧 key 失效', () => {
    const b = new ApiBridge(makeDb(), providers());
    const old = b.getBridgeKey();
    const fresh = b.regenerateKey();
    expect(fresh).not.toBe(old);
    expect(b.getBridgeKey()).toBe(fresh);
  });
});

describe('路由', () => {
  it('Anthropic Messages 请求转换为 OpenAI 工具消息', () => {
    const request = anthropicToOpenAiRequest({
      model: 'm',
      system: '你是工程师',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '继续' }, { type: 'tool_result', tool_use_id: 'call-1', content: '已写入' }] }
      ],
      tools: [{ name: 'write_file', description: 'write', input_schema: { type: 'object', properties: {} } }]
    });
    expect(request.messages).toEqual([
      { role: 'system', content: '你是工程师' },
      { role: 'tool', tool_call_id: 'call-1', content: '已写入' },
      { role: 'user', content: '继续' }
    ]);
    expect(request.tools[0].function.name).toBe('write_file');
  });

  it('/v1/models 列出已配置供应商的模型', async () => {
    const list = [{ id: 'p1', name: 'DeepSeek', model: 'deepseek-chat', createdAt: 1700000000000 }];
    const { bridge, base } = await boot(makeDb(), providers(list));
    running.push(bridge);
    const r = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${bridge.getBridgeKey()}` } });
    const j = await r.json();
    expect(j.data[0].id).toBe('deepseek-chat');
    expect(j.data[0].owned_by).toBe('DeepSeek');
  });

  it('/v1/models?limit=1 带 query 仍能命中（此前返回 404）', async () => {
    const { bridge, base } = await boot(makeDb(), providers([]));
    running.push(bridge);
    const r = await fetch(`${base}/v1/models?limit=1`, { headers: { Authorization: `Bearer ${bridge.getBridgeKey()}` } });
    expect(r.status).toBe(200);
  });

  it('未知路径返回 404 且带 OpenAI 风格错误体', async () => {
    const { bridge, base } = await boot(makeDb(), providers());
    running.push(bridge);
    const r = await fetch(`${base}/v1/embeddings`, { headers: { Authorization: `Bearer ${bridge.getBridgeKey()}` } });
    expect(r.status).toBe(404);
    expect((await r.json()).error.type).toBe('invalid_request_error');
  });

  it('OPTIONS 预检返回 204', async () => {
    const { bridge, base } = await boot(makeDb(), providers());
    running.push(bridge);
    expect((await fetch(`${base}/v1/models`, { method: 'OPTIONS' })).status).toBe(204);
  });
});

describe('chat/completions 代理', () => {
  const auth = (b) => ({ Authorization: `Bearer ${b.getBridgeKey()}`, 'Content-Type': 'application/json' });

  it('非法 JSON body → 400', async () => {
    const { bridge, base } = await boot(makeDb(), providers([], { baseUrl: 'https://x', model: 'm', key: 'k' }));
    running.push(bridge);
    const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: auth(bridge), body: '{broken' });
    expect(r.status).toBe(400);
  });

  it('无匹配供应商 → 503 且提示去配置', async () => {
    const { bridge, base } = await boot(makeDb(), providers([], null));
    running.push(bridge);
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: auth(bridge), body: JSON.stringify({ model: 'unknown-model' })
    });
    expect(r.status).toBe(503);
    expect((await r.json()).error.message).toContain('unknown-model');
  });

  it('上游不可达 → 502 而非静默挂起', async () => {
    const orig = globalThis.fetch;
    const { bridge, base } = await boot(makeDb(), providers([], { baseUrl: 'https://upstream.invalid', model: 'm', key: 'k' }));
    running.push(bridge);
    // 只拦截到上游的请求，保留对 bridge 自身的请求
    globalThis.fetch = ((url, init) => {
      if (String(url).includes('upstream.invalid')) return Promise.reject(new Error('ENOTFOUND'));
      return orig(url, init);
    }) as never;
    try {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST', headers: auth(bridge), body: JSON.stringify({ model: 'm' })
      });
      expect(r.status).toBe(502);
      expect((await r.json()).error.type).toBe('upstream_error');
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('上游状态码被透传（如 429 限流不被吞成 200）', async () => {
    const orig = globalThis.fetch;
    const { bridge, base } = await boot(makeDb(), providers([], { baseUrl: 'https://up.test', model: 'm', key: 'k' }));
    running.push(bridge);
    globalThis.fetch = ((url, init) => {
      if (String(url).includes('up.test')) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'rate limited' }), {
          status: 429, headers: { 'content-type': 'application/json' }
        }));
      }
      return orig(url, init);
    }) as never;
    try {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST', headers: auth(bridge), body: JSON.stringify({ model: 'm' })
      });
      expect(r.status).toBe(429);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('转发时用供应商密钥替换客户端 key（不泄露真实密钥给调用方）', async () => {
    const orig = globalThis.fetch;
    const { bridge, base } = await boot(makeDb(), providers([], { baseUrl: 'https://up.test', model: 'm', key: 'sk-real-provider' }));
    running.push(bridge);
    let sentAuth = null;
    globalThis.fetch = ((url, init) => {
      if (String(url).includes('up.test')) {
        sentAuth = init.headers.Authorization;
        return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return orig(url, init);
    }) as never;
    try {
      await fetch(`${base}/v1/chat/completions`, {
        method: 'POST', headers: auth(bridge), body: JSON.stringify({ model: 'm' })
      });
      expect(sentAuth).toBe('Bearer sk-real-provider');
      expect(sentAuth).not.toContain('sk-bridge');
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe('Anthropic Messages 协议适配', () => {
  const auth = (b) => ({ 'x-api-key': b.getBridgeKey(), 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' });

  it('将 /v1/messages 转换到上游 /chat/completions 并返回 Anthropic 响应', async () => {
    const orig = globalThis.fetch;
    const { bridge, base } = await boot(makeDb(), providers([], { baseUrl: 'https://up.test/v1', model: 'm', key: 'sk-real-provider' }));
    running.push(bridge);
    let forwarded: any = null;
    globalThis.fetch = ((url, init) => {
      if (String(url).includes('up.test')) {
        forwarded = JSON.parse(init.body);
        return Promise.resolve(new Response(JSON.stringify({
          id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: '已完成' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2 }
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return orig(url, init);
    }) as never;
    try {
      const response = await fetch(`${base}/v1/messages`, {
        method: 'POST', headers: auth(bridge),
        body: JSON.stringify({ model: 'm', max_tokens: 100, messages: [{ role: 'user', content: '你好' }] })
      });
      expect(response.status).toBe(200);
      expect((await response.json()).content).toEqual([{ type: 'text', text: '已完成' }]);
      expect(forwarded.messages).toEqual([{ role: 'user', content: '你好' }]);
    } finally { globalThis.fetch = orig; }
  });

  it('Anthropic 路由缺少 bridge key 时拒绝，不会触达上游', async () => {
    const { bridge, base } = await boot(makeDb(), providers([], { baseUrl: 'https://up.test/v1', model: 'm', key: 'k' }));
    running.push(bridge);
    const response = await fetch(`${base}/v1/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] })
    });
    expect(response.status).toBe(401);
  });
});

describe('OA/业务中台 WebSocket', () => {
  it('必须先订阅项目，且只接收已订阅项目的状态和产物事件', async () => {
    const db = makeDb({ bridge_port: '0' });
    const { bridge, base } = await boot(db, providers());
    running.push(bridge);
    const command = vi.fn(async (name, payload) => ({ name, projectId: payload.projectId }));
    bridge.setBusinessGatewayHandlers({ command });
    const socket = await openBusinessSocket(bridge, base);
    try {
      const ready = await nextSocketMessage(socket);
      expect(ready.type).toBe('business.events.ready');

      socket.send(JSON.stringify({ type: 'snapshot', requestId: 'before', projectId: 'p1' }));
      const beforeAck = await nextSocketMessage(socket);
      expect(beforeAck).toMatchObject({ type: 'ack', requestId: 'before', ok: false });
      expect(command).not.toHaveBeenCalled();

      socket.send(JSON.stringify({ type: 'subscribe', requestId: 'sub', projectId: 'p1' }));
      const subscribed = await nextSocketMessage(socket);
      expect(subscribed).toMatchObject({ type: 'subscribed', requestId: 'sub', projectId: 'p1' });
      socket.send(JSON.stringify({ type: 'snapshot', requestId: 'after', projectId: 'p1' }));
      const afterAck = await nextSocketMessage(socket);
      expect(afterAck).toMatchObject({ type: 'ack', requestId: 'after', ok: true, result: { projectId: 'p1' } });

      bridge.publishBusinessEvent({ type: 'task.finished', projectId: 'p2', taskId: 'hidden' });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(command).toHaveBeenCalledTimes(1);

      const visibleEvent = nextSocketMessage(socket);
      bridge.publishBusinessEvent({ type: 'task.finished', projectId: 'p1', taskId: 'visible' });
      const visible = await visibleEvent;
      expect(visible).toMatchObject({ projectId: 'p1', taskId: 'visible' });
    } finally {
      socket.close();
    }
  });

  it('错误的 Bridge key 在 WebSocket 握手阶段被拒绝', async () => {
    const { bridge, base } = await boot(makeDb({ bridge_port: '0' }), providers());
    running.push(bridge);
    const socket = new WebSocket(`${base.replace(/^http:/, 'ws:')}/v1/business/events`, {
      headers: { Authorization: 'Bearer sk-wrong' }
    });
    await expect(new Promise<void>((resolve, reject) => {
      socket.once('open', () => reject(new Error('socket unexpectedly opened')));
      socket.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve();
      });
      socket.once('error', () => resolve());
    })).resolves.toBeUndefined();
  });
});

describe('启停与状态', () => {
  it('getStatus 反映运行状态与启用开关', async () => {
    const db = makeDb();
    const b = new ApiBridge(db, providers());
    expect(b.getStatus().running).toBe(false);
    expect(b.getStatus().enabled).toBe(false);
    expect(b.getStatus().keyConfigured).toBe(true);
    expect(b.getStatus()).not.toHaveProperty('bridgeKey');

    db.setSetting('bridge_enabled', 'true');
    expect(b.getStatus().enabled).toBe(true);
  });

  it('启动完成前不报告 running，toggle 仅在监听成功后持久化 enabled', async () => {
    const db = makeDb({ bridge_port: '0' });
    const bridge = new ApiBridge(db, providers());
    const enabling = bridge.toggle(true);

    expect(bridge.getStatus()).toMatchObject({ running: false, enabled: false });
    await enabling;
    running.push(bridge);
    expect(bridge.getStatus()).toMatchObject({ running: true, enabled: true });
    expect(bridge.getStatus().port).toBeGreaterThan(0);
  });

  it('重复 start 不重复监听', async () => {
    const { bridge } = await boot(makeDb(), providers());
    running.push(bridge);
    const first = bridge.server;
    await bridge.start();
    expect(bridge.server).toBe(first);
  });

  it('stop 后 server 置空，可再次启动', async () => {
    const { bridge } = await boot(makeDb(), providers());
    await bridge.stop();
    expect(bridge.server).toBeNull();
  });

  it('端口占用时启动失败并保持 disabled/stopped', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', resolve);
    });
    const address = blocker.address();
    if (!address || typeof address === 'string') throw new Error('blocker did not listen');
    const db = makeDb({ bridge_port: String(address.port) });
    const bridge = new ApiBridge(db, providers());
    vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(bridge.toggle(true)).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(bridge.getStatus()).toMatchObject({ running: false, enabled: false });
      expect(bridge.server).toBeNull();
      expect(db.audit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'bridge.server', target: 'api-bridge', result: 'fail-closed'
      }));
    } finally {
      await bridge.stop();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('快速 stop/start 等待旧监听关闭，旧实例错误不清空新实例', async () => {
    const db = makeDb();
    const bridge = new ApiBridge(db, providers());
    db.setSetting('bridge_port', '0');

    const firstStart = bridge.start();
    const first = bridge.server;
    const firstRejected = expect(firstStart).rejects.toThrow(/cancelled/);
    const stopping = bridge.stop();
    const restarting = bridge.start();
    await firstRejected;
    await stopping;
    await restarting;
    running.push(bridge);

    const second = bridge.server;
    expect(second).not.toBe(first);
    expect(first.listening).toBe(false);
    expect(bridge.getStatus().running).toBe(true);
    first.emit('error', new Error('late error from old server'));
    expect(bridge.server).toBe(second);
    expect(bridge.getStatus().running).toBe(true);
  });

  it('多个 start 同时等待 stop 时只创建一个新监听实例', async () => {
    const db = makeDb();
    const { bridge } = await boot(db, providers());
    const stopping = bridge.stop();

    const restartA = bridge.start();
    const restartB = bridge.start();
    await stopping;
    await Promise.all([restartA, restartB]);
    running.push(bridge);

    expect(bridge.getStatus().running).toBe(true);
    expect(bridge.server?.listening).toBe(true);
  });

  it('运行中凭据不可解密时返回 fail-closed 503 并审计', async () => {
    const db = makeDb();
    const { bridge, base } = await boot(db, providers());
    running.push(bridge);
    const key = bridge.getBridgeKey();
    vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(false);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await fetch(`${base}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` }
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        message: 'API Bridge temporarily unavailable',
        type: 'service_unavailable',
        code: 'bridge_unavailable'
      }
    });
    expect(db.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'bridge.request', target: 'api-bridge', result: 'fail-closed'
    }));
  });
});
