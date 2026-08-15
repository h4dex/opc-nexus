// @ts-nocheck
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${Buffer.from(value, 'utf8').toString('base64')}`),
    decryptString: (value: Buffer) => {
      const encoded = value.toString('utf8');
      if (!encoded.startsWith('sealed:')) throw new Error('invalid ciphertext');
      return Buffer.from(encoded.slice('sealed:'.length), 'base64').toString('utf8');
    }
  }
}));

vi.mock('../src/main/services/notifier.js', () => ({ notify: vi.fn() }));

import {
  WEIXIN_OUTBOX_REF,
  WEIXIN_PENDING_SESSION_REF,
  WEIXIN_POLL_STATE_REF,
  WEIXIN_SESSION_REF,
  WeixinChannel
} from '../src/main/services/channels/wechatChannel.js';

interface StoredTask {
  id: string;
  status: string;
  result: string | null;
  error: string | null;
}

class FakeDb {
  readonly settings = new Map<string, unknown>();
  readonly tasks = new Map<string, StoredTask>();
  readonly audits: Array<Record<string, unknown>> = [];
  readonly statusHistory: string[] = [];
  channel = { status: 'UNCONFIGURED', accountName: '', lastConnectedAt: null as number | null };
  routeAgentId: string | null = 'agent-1';

  readonly audit = vi.fn((entry: Record<string, unknown>) => this.audits.push(entry));
  readonly flush = vi.fn();

  getSetting<T>(key: string, fallback: T): T {
    return this.settings.has(key) ? this.settings.get(key) as T : fallback;
  }

  setSetting(key: string, value: unknown): void {
    this.settings.set(key, value);
  }

  transaction(fn: () => void): void {
    fn();
  }

  readonly raw = {
    prepare: (sql: string) => ({
      get: (...args: unknown[]) => {
        if (/SELECT agent_id FROM channel_routes/.test(sql)) {
          return this.routeAgentId ? { agent_id: this.routeAgentId } : undefined;
        }
        if (/SELECT status, result, error FROM tasks WHERE id = \?/.test(sql)) {
          return this.tasks.get(String(args[0]));
        }
        if (/SELECT id, request FROM approvals/.test(sql)) return undefined;
        return undefined;
      },
      all: () => [],
      run: (...args: unknown[]) => {
        if (/UPDATE channels SET account_name = \?/.test(sql)) {
          this.channel.accountName = String(args[0]);
          return { changes: 1 };
        }
        if (/UPDATE channels SET status = \?, last_connected_at = \?/.test(sql)) {
          this.channel.status = String(args[0]);
          this.channel.lastConnectedAt = Number(args[1]);
          this.statusHistory.push(this.channel.status);
          return { changes: 1 };
        }
        if (/UPDATE channels SET status = \?/.test(sql)) {
          this.channel.status = String(args[0]);
          this.statusHistory.push(this.channel.status);
          return { changes: 1 };
        }
        if (/DELETE FROM settings WHERE key IN/.test(sql)) {
          let changes = 0;
          for (const key of args) changes += this.settings.delete(String(key)) ? 1 : 0;
          return { changes };
        }
        if (/DELETE FROM settings WHERE key = \?/.test(sql)) {
          return { changes: this.settings.delete(String(args[0])) ? 1 : 0 };
        }
        throw new Error(`Unexpected SQL run: ${sql}`);
      }
    })
  };
}

interface CapturedRequest {
  url: URL;
  init: RequestInit;
}

interface ScriptedHttpResponse {
  httpStatus: number;
  body: unknown;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeIlinkServer {
  readonly requests: CapturedRequest[] = [];
  readonly pendingSignals: AbortSignal[] = [];
  readonly qrStatuses: unknown[] = [];
  readonly qrResponses: unknown[] = [];
  readonly updates: unknown[] = [];
  readonly sends: unknown[] = [];
  qrResponse = { qrcode: 'qr-id', qrcode_img_content: 'qr-content' };
  abortedPolls = 0;

  readonly fetch = vi.fn((input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    this.requests.push({ url, init });

    if (url.pathname.endsWith('/get_bot_qrcode')) return this.respond(this.qrResponses.shift() ?? this.qrResponse);
    if (url.pathname.endsWith('/get_qrcode_status')) return this.respond(this.qrStatuses.shift() ?? { status: 'wait' });
    if (url.pathname.endsWith('/sendmessage')) return this.respond(this.sends.shift() ?? { ret: 0 });
    if (url.pathname.endsWith('/notifystart') || url.pathname.endsWith('/notifystop')) return this.json({ ret: 0 });
    if (url.pathname.endsWith('/getupdates')) {
      if (this.updates.length > 0) return this.respond(this.updates.shift());
      return this.untilAborted(init.signal as AbortSignal);
    }
    return this.json({ error: 'not found' }, 404);
  }) as unknown as typeof fetch;

  requestsFor(endpoint: string): CapturedRequest[] {
    return this.requests.filter((request) => request.url.pathname.endsWith(endpoint));
  }

  private json(value: unknown, status = 200): Promise<Response> {
    return Promise.resolve(new Response(JSON.stringify(value), { status }));
  }

  private respond(value: unknown): Promise<Response> {
    if (value && typeof value === 'object' && 'httpStatus' in value) {
      const scripted = value as ScriptedHttpResponse;
      return this.json(scripted.body, scripted.httpStatus);
    }
    if (value instanceof Error) return Promise.reject(value);
    if (value && typeof (value as Promise<Response>).then === 'function') return value as Promise<Response>;
    return this.json(value);
  }

  private untilAborted(signal: AbortSignal): Promise<Response> {
    this.pendingSignals.push(signal);
    return new Promise((_resolve, reject) => {
      const abort = () => {
        this.abortedPolls++;
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }
}

function seal(value: unknown): string {
  const json = JSON.stringify(value);
  const cipher = `sealed:${Buffer.from(json, 'utf8').toString('base64')}`;
  return Buffer.from(cipher, 'utf8').toString('base64');
}

function unseal<T>(value: unknown): T {
  const cipher = Buffer.from(String(value), 'base64').toString('utf8');
  const json = Buffer.from(cipher.slice('sealed:'.length), 'base64').toString('utf8');
  return JSON.parse(json) as T;
}

function controlledSleep() {
  const waits: Array<{ ms: number; resolve: () => void; signal?: AbortSignal }> = [];
  const sleep = vi.fn((ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      reject(new Error('aborted'));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    waits.push({
      ms,
      signal,
      resolve: () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        resolve();
      }
    });
  }));
  return { sleep, waits };
}

function seedSession(db: FakeDb): void {
  db.settings.set(WEIXIN_SESSION_REF, seal({
    token: 'stored-bot-token',
    accountId: 'bot-account',
    ownerUserId: 'owner-user',
    baseUrl: 'https://ilinkai.weixin.qq.com'
  }));
}

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    message_id: 101,
    message_type: 1,
    from_user_id: 'owner-user',
    context_token: 'context-101',
    item_list: [{ type: 1, text_item: { text: '整理今天的客户反馈' } }],
    ...overrides
  };
}

function makeHarness(server = new FakeIlinkServer(), options: {
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  qrToDataUrl?: (content: string) => Promise<string>;
  ingressService?: Record<string, unknown>;
  taskPlanner?: { dispatch: (...args: any[]) => Promise<{ id: string; deduplicated?: boolean }> };
} = {}) {
  const db = new FakeDb();
  let taskIndex = 0;
  const linkedTasks = new Map<string, string>();
  const defaultIngressService = {
    ingest: vi.fn((input: Record<string, unknown>) => {
      const messageKey = String(input.messageKey);
      return {
        organizationId: 'org-local',
        organizationKey: 'local',
        principalId: 'principal-owner',
        channelId: String(input.channelId),
        channelIdentityId: 'identity-owner',
        externalIdentity: String(input.externalIdentity),
        conversationId: 'conversation-weixin-owner',
        conversationKey: String(input.conversationKey),
        messageId: `message-${messageKey}`,
        messageKey,
        dedupeKey: `channel-message:${messageKey}`,
        taskId: linkedTasks.get(messageKey) ?? null,
        deduplicated: linkedTasks.has(messageKey)
      };
    }),
    linkTask: vi.fn((context: { messageKey: string }, taskId: string) => {
      linkedTasks.set(context.messageKey, taskId);
    }),
    recordOutbound: vi.fn(() => 'outbound-message')
  };
  const ingressService = { ...defaultIngressService, ...options.ingressService };
  const orchestrator = {
    createTask: vi.fn((_agentId: string, _title: string, _source: string) => {
      const id = `task-${++taskIndex}`;
      db.tasks.set(id, { id, status: 'COMPLETED', result: 'done', error: null });
      return { id };
    }),
    decideApproval: vi.fn()
  };
  const taskPlanner = options.taskPlanner ?? {
    dispatch: vi.fn(async ({ ingress, message, preferredAgentId }) => orchestrator.createTask(
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
  const channel = new WeixinChannel(db as never, orchestrator as never, {
    fetchImpl: server.fetch,
    qrToDataUrl: options.qrToDataUrl ?? (async (content: string) => `data:image/png;base64,${content}`),
    sleep: options.sleep ?? (async (_ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error('aborted');
      await Promise.resolve();
    }),
    now: options.now,
    ingressService,
    taskPlanner
  });
  return { db, orchestrator, channel, server, ingressService, taskPlanner };
}

async function flushUntil(predicate: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function jsonBody(request: CapturedRequest): Record<string, any> {
  return JSON.parse(String(request.init.body)) as Record<string, any>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('WeixinChannel iLink integration', () => {
  it('keeps CONNECTING until the first authenticated getupdates probe succeeds', async () => {
    const server = new FakeIlinkServer();
    const probe = deferred<Response>();
    server.updates.push(probe.promise);
    const { channel, db } = makeHarness(server);
    seedSession(db);

    let settled = false;
    const connecting = channel.connect().finally(() => { settled = true; });
    await flushUntil(() => server.requestsFor('/getupdates').length === 1, 'first authenticated probe');

    expect(settled).toBe(false);
    expect(db.channel.status).toBe('CONNECTING');
    expect(db.statusHistory).not.toContain('ONLINE');

    probe.resolve(new Response(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'probe-cursor' }), { status: 200 }));
    await expect(connecting).resolves.toEqual({ ok: true, message: '微信 iLink Bot 已连接' });
    expect(db.channel.status).toBe('ONLINE');
    expect(channel.getLoginState()).toMatchObject({ phase: 'CONNECTED', message: expect.stringContaining('已连接') });

    await channel.dispose();
  });

  it('rejects a non-zero ret even when the activation probe errcode is zero', async () => {
    const server = new FakeIlinkServer();
    server.qrStatuses.push({
      status: 'confirmed',
      bot_token: 'probe-error-token',
      ilink_bot_id: 'probe-error-bot',
      ilink_user_id: 'probe-error-owner',
      baseurl: 'https://ilinkai.weixin.qq.com'
    });
    server.updates.push({ ret: 23, errcode: 0, errmsg: 'probe rejected', msgs: [] });
    const { channel, db } = makeHarness(server);

    await channel.startLogin();
    await flushUntil(() => channel.getLoginState().phase === 'ERROR', 'activation protocol error');

    expect(channel.getLoginState().message).toContain('probe rejected');
    expect(db.channel.status).toBe('ERROR');
    expect(db.settings.has(WEIXIN_SESSION_REF)).toBe(false);
    expect(db.settings.has(WEIXIN_PENDING_SESSION_REF)).toBe(true);
  });

  it('stores a confirmed QR session encrypted and exposes a token-free login state', async () => {
    const server = new FakeIlinkServer();
    server.qrStatuses.push({
      status: 'confirmed',
      bot_token: 'fresh-secret-token',
      ilink_bot_id: 'bot-account-7',
      ilink_user_id: 'owner-user-7',
      baseurl: 'https://ilinkai.weixin.qq.com'
    });
    server.updates.push({ ret: 0, msgs: [], get_updates_buf: 'cursor-after-login' });
    const { channel, db } = makeHarness(server);

    const activated = vi.fn();
    const initial = await channel.startLogin(activated);
    expect(initial).toMatchObject({
      phase: 'WAITING_SCAN',
      qrDataUrl: 'data:image/png;base64,qr-content'
    });
    await flushUntil(() => channel.getLoginState().phase === 'CONNECTED', 'confirmed login');
    await flushUntil(() => db.channel.status === 'ONLINE', 'authenticated iLink probe');

    const encryptedSession = db.settings.get(WEIXIN_SESSION_REF);
    expect(typeof encryptedSession).toBe('string');
    expect(encryptedSession).not.toContain('fresh-secret-token');
    expect(db.settings.get(WEIXIN_POLL_STATE_REF)).not.toBeUndefined();
    expect(db.channel).toMatchObject({ status: 'ONLINE', accountName: '微信 iLink Bot' });
    expect(db.channel.lastConnectedAt).toEqual(expect.any(Number));
    expect(activated).toHaveBeenCalledTimes(1);
    expect(db.audit).toHaveBeenCalledWith(expect.objectContaining({
      actor: 'admin',
      action: 'channel.weixin.ilink.login',
      target: 'bot-account-7',
      result: 'ok'
    }));

    const publicState = channel.getLoginState();
    expect(publicState).toMatchObject({
      phase: 'CONNECTED',
      qrDataUrl: null,
      message: expect.stringContaining('已连接')
    });
    expect(JSON.stringify(publicState)).not.toContain('fresh-secret-token');
    expect(publicState).not.toHaveProperty('token');

    await channel.disconnect();
  });

  it('cancels VERIFYING before credentials and routing are committed', async () => {
    const server = new FakeIlinkServer();
    const probe = deferred<Response>();
    server.qrStatuses.push({
      status: 'confirmed',
      bot_token: 'cancelled-token',
      ilink_bot_id: 'cancelled-bot',
      ilink_user_id: 'cancelled-owner',
      baseurl: 'https://ilinkai.weixin.qq.com'
    });
    server.updates.push(probe.promise);
    const { channel, db } = makeHarness(server);
    const activated = vi.fn();

    await channel.startLogin(activated);
    await flushUntil(() => channel.getLoginState().phase === 'VERIFYING', 'session verification');
    await flushUntil(() => server.requestsFor('/getupdates').length === 1, 'verification probe');
    const verificationSignal = server.requestsFor('/getupdates')[0].init.signal as AbortSignal;
    channel.cancelLogin();
    expect(verificationSignal.aborted).toBe(true);

    expect(channel.getLoginState()).toMatchObject({ phase: 'IDLE', qrDataUrl: null });
    expect(db.channel.status).toBe('UNCONFIGURED');
    expect(db.settings.has(WEIXIN_SESSION_REF)).toBe(false);
    expect(db.settings.has(WEIXIN_POLL_STATE_REF)).toBe(false);
    expect(db.settings.has(WEIXIN_PENDING_SESSION_REF)).toBe(true);
    expect(db.settings.get(WEIXIN_PENDING_SESSION_REF)).not.toContain('cancelled-token');
    expect(db.flush).toHaveBeenCalled();
    expect(activated).not.toHaveBeenCalled();
    expect(db.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'channel.weixin.ilink.login' }));
  });

  it('recovers encrypted confirmed credentials after cancellation through binded_redirect', async () => {
    const server = new FakeIlinkServer();
    const firstProbe = deferred<Response>();
    server.qrStatuses.push({
      status: 'confirmed',
      bot_token: 'recoverable-token',
      ilink_bot_id: 'recoverable-bot',
      ilink_user_id: 'recoverable-owner',
      baseurl: 'https://ilinkai.weixin.qq.com'
    });
    server.updates.push(firstProbe.promise);
    const { channel, db } = makeHarness(server);

    await channel.startLogin();
    await flushUntil(() => channel.getLoginState().phase === 'VERIFYING', 'first session verification');
    channel.cancelLogin();
    expect(db.settings.has(WEIXIN_PENDING_SESSION_REF)).toBe(true);
    expect(db.settings.has(WEIXIN_SESSION_REF)).toBe(false);

    server.qrStatuses.push({ status: 'binded_redirect' });
    server.updates.push({ ret: 0, errcode: 0, msgs: [], get_updates_buf: 'recovered-cursor' });
    await channel.startLogin();
    await flushUntil(() => channel.getLoginState().phase === 'CONNECTED', 'pending session recovery');

    expect(db.settings.has(WEIXIN_PENDING_SESSION_REF)).toBe(false);
    expect(unseal<{ token: string }>(db.settings.get(WEIXIN_SESSION_REF))).toMatchObject({ token: 'recoverable-token' });
    expect(db.channel.status).toBe('ONLINE');
    await channel.disconnect();
  });

  it('does not publish a refreshed QR that resolves after login cancellation', async () => {
    const server = new FakeIlinkServer();
    const refreshedQr = deferred<Response>();
    server.qrResponses.push(server.qrResponse, refreshedQr.promise);
    server.qrStatuses.push({ status: 'expired' });
    const { channel } = makeHarness(server);

    await channel.startLogin();
    await flushUntil(() => server.requestsFor('/get_bot_qrcode').length === 2, 'refreshed QR request');
    channel.cancelLogin();
    refreshedQr.resolve(new Response(JSON.stringify({ qrcode: 'stale-id', qrcode_img_content: 'stale-content' }), { status: 200 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(channel.getLoginState()).toMatchObject({ phase: 'IDLE', qrDataUrl: null });
  });

  it('does not publish a refreshed QR whose encoding resolves after login cancellation', async () => {
    const server = new FakeIlinkServer();
    server.qrResponses.push(
      { qrcode: 'initial-id', qrcode_img_content: 'initial-content' },
      { qrcode: 'refreshed-id', qrcode_img_content: 'refreshed-content' }
    );
    server.qrStatuses.push({ status: 'expired' });
    const encodedRefresh = deferred<string>();
    const qrToDataUrl = vi.fn((content: string) => content === 'refreshed-content'
      ? encodedRefresh.promise
      : Promise.resolve(`data:image/png;base64,${content}`));
    const { channel } = makeHarness(server, {
      qrToDataUrl
    });

    await channel.startLogin();
    await flushUntil(() => qrToDataUrl.mock.calls.some(([content]) => content === 'refreshed-content'), 'refreshed QR encoding');
    channel.cancelLogin();
    encodedRefresh.resolve('data:image/png;base64,stale-content');
    await Promise.resolve();
    await Promise.resolve();

    expect(channel.getLoginState()).toMatchObject({ phase: 'IDLE', qrDataUrl: null });
  });

  it('retries QR status HTTP 503 and network errors within the same login session', async () => {
    const server = new FakeIlinkServer();
    server.qrStatuses.push(
      { httpStatus: 503, body: { errmsg: 'temporarily unavailable' } },
      new Error('ECONNRESET'),
      {
        status: 'confirmed',
        bot_token: 'retry-token',
        ilink_bot_id: 'retry-bot',
        ilink_user_id: 'retry-owner',
        baseurl: 'https://ilinkai.weixin.qq.com'
      }
    );
    server.updates.push({ ret: 0, msgs: [], get_updates_buf: 'retry-cursor' });
    const sleep = vi.fn(async (_ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error('aborted');
    });
    const { channel, db } = makeHarness(server, { sleep });

    await channel.startLogin();
    await flushUntil(() => db.channel.status === 'ONLINE', 'login after transient QR error');

    expect(server.requestsFor('/get_qrcode_status')).toHaveLength(3);
    expect(server.requestsFor('/get_bot_qrcode')).toHaveLength(1);
    expect(sleep).toHaveBeenCalledWith(expect.any(Number), expect.any(AbortSignal));
    expect(db.statusHistory).not.toContain('ERROR');
    expect(channel.getLoginState().phase).toBe('CONNECTED');

    await channel.dispose();
  });

  it('expires an unconfirmed QR session at the eight-minute wall-clock TTL', async () => {
    let now = 1_000;
    const sleeper = controlledSleep();
    const server = new FakeIlinkServer();
    const { channel, db } = makeHarness(server, { now: () => now, sleep: sleeper.sleep });

    await channel.startLogin();
    await flushUntil(() => sleeper.waits.length === 1, 'first QR polling delay');
    expect(channel.getLoginState().phase).toBe('WAITING_SCAN');

    now += 8 * 60_000 - 1;
    sleeper.waits[0].resolve();
    await flushUntil(() => sleeper.waits.length === 2, 'last QR polling delay before TTL');
    expect(channel.getLoginState()).toMatchObject({ phase: 'WAITING_SCAN', qrDataUrl: expect.any(String) });

    now += 1;
    sleeper.waits[1].resolve();
    await flushUntil(() => channel.getLoginState().phase === 'EXPIRED', 'QR session TTL');

    expect(channel.getLoginState()).toMatchObject({ phase: 'EXPIRED', qrDataUrl: null, message: expect.stringContaining('超时') });
    expect(db.channel.status).toBe('UNCONFIGURED');
    const requestCount = server.requestsFor('/get_qrcode_status').length;
    await Promise.resolve();
    expect(server.requestsFor('/get_qrcode_status')).toHaveLength(requestCount);
  });

  it('dispatches an owner direct-text task once and acknowledges with its context token', async () => {
    vi.useFakeTimers();
    const server = new FakeIlinkServer();
    const direct = makeMessage();
    server.updates.push({ ret: 0, msgs: [direct, { ...direct }], get_updates_buf: 'cursor-2' });
    const { channel, db, orchestrator, ingressService } = makeHarness(server);
    seedSession(db);

    await channel.connect();
    await flushUntil(() => orchestrator.createTask.mock.calls.length === 1, 'channel task dispatch');
    await flushUntil(() => server.requestsFor('/sendmessage').length === 2, 'planning and task acknowledgements');

    expect(orchestrator.createTask).toHaveBeenCalledWith(
      'agent-1',
      '整理今天的客户反馈',
      'channel',
      {
        sourceKey: 'channel-message:bot-account:message:101',
        sessionId: 'conv-conversation-weixin-owner',
        conversationId: 'conversation-weixin-owner',
        inputMessageId: 'message-bot-account:message:101',
        content: '整理今天的客户反馈'
      }
    );
    expect(ingressService.ingest).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'ch-weixin',
      externalIdentity: 'bot-account:owner-user',
      conversationKey: 'direct:owner-user',
      messageKey: 'bot-account:message:101',
      text: '整理今天的客户反馈'
    }));
    const planningAck = jsonBody(server.requestsFor('/sendmessage')[0]);
    expect(planningAck.msg).toMatchObject({
      to_user_id: 'owner-user',
      context_token: 'context-101',
      item_list: [{ type: 1, text_item: { text: expect.stringContaining('控制核') } }]
    });
    const ack = jsonBody(server.requestsFor('/sendmessage')[1]);
    expect(ack.msg).toMatchObject({
      to_user_id: 'owner-user',
      context_token: 'context-101',
      item_list: [{ type: 1, text_item: { text: expect.stringContaining('规划完成') } }]
    });

    await channel.disconnect();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(orchestrator.createTask).toHaveBeenCalledTimes(1);
    expect(server.requestsFor('/sendmessage')).toHaveLength(2);
    expect(db.settings.has(WEIXIN_OUTBOX_REF)).toBe(false);
  });

  it('does not advance cursor or seenIds when canonical planning fails', async () => {
    const server = new FakeIlinkServer();
    server.updates.push(
      { ret: 0, msgs: [], get_updates_buf: 'cursor-before' },
      {
        ret: 0,
        msgs: [makeMessage({ message_id: 501, context_token: 'context-501' })],
        get_updates_buf: 'cursor-after-planner-failure'
      }
    );
    const taskPlanner = { dispatch: vi.fn().mockRejectedValue(new Error('planner unavailable')) };
    const sleep = vi.fn(async (_ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error('aborted');
    });
    const { channel, db } = makeHarness(server, { taskPlanner, sleep });
    seedSession(db);
    db.settings.set(WEIXIN_POLL_STATE_REF, seal({ cursor: 'cursor-initial', contextTokens: {}, seenIds: [] }));

    await channel.connect();
    await flushUntil(() => taskPlanner.dispatch.mock.calls.length === 1, 'failed canonical dispatch');
    await flushUntil(() => sleep.mock.calls.some(([ms]) => ms === 2_000), 'dispatch retry backoff');
    await flushUntil(() => server.pendingSignals.length === 1, 'retry poll after planning failure');

    expect(unseal<{ cursor: string; seenIds: string[] }>(db.settings.get(WEIXIN_POLL_STATE_REF))).toMatchObject({
      cursor: 'cursor-before',
      seenIds: []
    });
    expect(server.requestsFor('/sendmessage')).toHaveLength(0);
    expect(db.settings.has(WEIXIN_OUTBOX_REF)).toBe(false);
    expect(db.channel.status).toBe('RECONNECTING');
    expect(channel.getLoginState().message).not.toContain('冷却');
    await channel.disconnect();
  });

  it('does not advance cursor or seenIds when linking the canonical task fails', async () => {
    const server = new FakeIlinkServer();
    server.updates.push(
      { ret: 0, msgs: [], get_updates_buf: 'cursor-before' },
      {
        ret: 0,
        msgs: [makeMessage({ message_id: 502, context_token: 'context-502' })],
        get_updates_buf: 'cursor-after-link-failure'
      }
    );
    const linkTask = vi.fn(() => { throw new Error('link persistence failed'); });
    const { channel, db, orchestrator } = makeHarness(server, { ingressService: { linkTask } });
    seedSession(db);
    db.settings.set(WEIXIN_POLL_STATE_REF, seal({ cursor: 'cursor-initial', contextTokens: {}, seenIds: [] }));

    await channel.connect();
    await flushUntil(() => linkTask.mock.calls.length === 1, 'failed task link');
    await flushUntil(() => server.pendingSignals.length === 1, 'retry poll after link failure');

    expect(orchestrator.createTask).toHaveBeenCalledTimes(1);
    expect(unseal<{ cursor: string; seenIds: string[] }>(db.settings.get(WEIXIN_POLL_STATE_REF))).toMatchObject({
      cursor: 'cursor-before',
      seenIds: []
    });
    await channel.disconnect();
  });

  it('waits for dispatch and durable linking before advancing cursor and seenIds once', async () => {
    vi.useFakeTimers();
    try {
      const server = new FakeIlinkServer();
      server.updates.push({
        ret: 0,
        msgs: [makeMessage({ message_id: 503, context_token: 'context-503' })],
        get_updates_buf: 'cursor-after-linked-task'
      });
      const planned = deferred<{ id: string }>();
      const taskPlanner = { dispatch: vi.fn(() => planned.promise) };
      const { channel, db, ingressService } = makeHarness(server, { taskPlanner });
      seedSession(db);
      db.settings.set(WEIXIN_POLL_STATE_REF, seal({ cursor: 'cursor-before', contextTokens: {}, seenIds: [] }));

      const connecting = channel.connect();
      await flushUntil(() => taskPlanner.dispatch.mock.calls.length === 1, 'pending canonical dispatch');
      expect(unseal<{ cursor: string; seenIds: string[] }>(db.settings.get(WEIXIN_POLL_STATE_REF))).toMatchObject({
        cursor: 'cursor-before',
        seenIds: []
      });

      db.tasks.set('task-awaited-link', { id: 'task-awaited-link', status: 'COMPLETED', result: 'done', error: null });
      planned.resolve({ id: 'task-awaited-link' });
      await connecting;
      await flushUntil(() => server.pendingSignals.length === 1, 'poll after durable link');

      expect(ingressService.linkTask).toHaveBeenCalledTimes(1);
      expect(unseal<{ cursor: string; seenIds: string[] }>(db.settings.get(WEIXIN_POLL_STATE_REF))).toMatchObject({
        cursor: 'cursor-after-linked-task',
        seenIds: ['message:503']
      });
      await channel.disconnect();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('persists replies encrypted before sending and deletes them after success', async () => {
    vi.useFakeTimers();
    const server = new FakeIlinkServer();
    const send = deferred<Response>();
    const direct = makeMessage({ message_id: 301, context_token: 'secret-context-301' });
    server.updates.push({ ret: 0, msgs: [direct], get_updates_buf: 'cursor-outbox' });
    server.sends.push(send.promise);
    const { channel, db } = makeHarness(server);
    seedSession(db);

    await channel.connect();
    await flushUntil(() => server.requestsFor('/sendmessage').length === 1, 'blocked outbox send');

    const encrypted = String(db.settings.get(WEIXIN_OUTBOX_REF));
    expect(encrypted).not.toContain('已接收任务');
    expect(encrypted).not.toContain('secret-context-301');
    const stored = unseal<Array<{ id: string; content: string }>>(encrypted);
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({ id: expect.any(String), content: expect.stringContaining('控制核') });
    expect(stored[1]).toMatchObject({ id: expect.any(String), content: expect.stringContaining('规划完成') });
    expect(db.flush).toHaveBeenCalled();

    send.resolve(new Response(JSON.stringify({ ret: 0 }), { status: 200 }));
    await flushUntil(() => !db.settings.has(WEIXIN_OUTBOX_REF), 'successful outbox deletion');
    await channel.disconnect();
  });

  it('recovers an encrypted outbox after restart and preserves FIFO order', async () => {
    const firstServer = new FakeIlinkServer();
    const blocked = deferred<Response>();
    firstServer.updates.push({
      ret: 0,
      msgs: [
        makeMessage({ message_id: 401, context_token: 'context-401' }),
        makeMessage({ message_id: 402, context_token: 'context-402' })
      ],
      get_updates_buf: 'cursor-before-restart'
    });
    firstServer.sends.push(blocked.promise);
    const first = makeHarness(firstServer);
    seedSession(first.db);

    await first.channel.connect();
    await flushUntil(() => unseal<unknown[]>(first.db.settings.get(WEIXIN_OUTBOX_REF)).length === 4, 'four persisted replies');
    await first.channel.dispose();
    expect(first.db.settings.has(WEIXIN_OUTBOX_REF)).toBe(true);

    const secondServer = new FakeIlinkServer();
    secondServer.updates.push({ ret: 0, msgs: [], get_updates_buf: 'cursor-after-restart' });
    const second = makeHarness(secondServer);
    second.db.settings.set(WEIXIN_SESSION_REF, first.db.settings.get(WEIXIN_SESSION_REF));
    second.db.settings.set(WEIXIN_POLL_STATE_REF, first.db.settings.get(WEIXIN_POLL_STATE_REF));
    second.db.settings.set(WEIXIN_OUTBOX_REF, first.db.settings.get(WEIXIN_OUTBOX_REF));

    await second.channel.connect();
    await flushUntil(() => secondServer.requestsFor('/sendmessage').length === 4, 'restarted outbox drain');
    await flushUntil(() => !second.db.settings.has(WEIXIN_OUTBOX_REF), 'restarted outbox deletion');

    const sentContexts = secondServer.requestsFor('/sendmessage').map((request) => jsonBody(request).msg.context_token);
    expect(sentContexts).toEqual(['context-401', 'context-401', 'context-402', 'context-402']);
    await second.channel.disconnect();
  });

  it('drops a permanently rejected outbox head and sends the following reply', async () => {
    const server = new FakeIlinkServer();
    server.updates.push({ ret: 0, msgs: [], get_updates_buf: 'cursor-permanent-error' });
    server.sends.push(
      { ret: 40003, errmsg: 'invalid context token' },
      { ret: 0 }
    );
    const { channel, db } = makeHarness(server);
    seedSession(db);
    db.settings.set(WEIXIN_OUTBOX_REF, seal([
      {
        id: 'permanent-failure', generation: 1, accountId: 'bot-account', to: 'owner-user',
        contextToken: 'expired-context', content: 'cannot be delivered', createdAt: 1
      },
      {
        id: 'following-reply', generation: 1, accountId: 'bot-account', to: 'owner-user',
        contextToken: 'valid-context', content: 'must still be delivered', createdAt: 2
      }
    ]));

    await channel.connect();
    await flushUntil(() => server.requestsFor('/sendmessage').length === 2, 'reply after permanent outbox failure');
    await flushUntil(() => !db.settings.has(WEIXIN_OUTBOX_REF), 'permanent failure cleanup');

    expect(server.requestsFor('/sendmessage').map((request) => jsonBody(request).msg.context_token)).toEqual([
      'expired-context',
      'valid-context'
    ]);
    await channel.disconnect();
  });

  it('preserves the outbox and expires the channel when sending is unauthorized', async () => {
    const server = new FakeIlinkServer();
    server.updates.push({ ret: 0, msgs: [], get_updates_buf: 'cursor-send-auth' });
    server.sends.push({ httpStatus: 401, body: { error: 'expired token' } });
    const { channel, db } = makeHarness(server);
    seedSession(db);
    db.settings.set(WEIXIN_OUTBOX_REF, seal([{
      id: 'auth-failure-reply', generation: 1, accountId: 'bot-account', to: 'owner-user',
      contextToken: 'auth-context', content: 'keep until reauthorized', createdAt: 1
    }]));

    await channel.connect();
    await flushUntil(() => db.channel.status === 'AUTH_EXPIRED', 'send-side auth expiry');

    expect(channel.isActive()).toBe(false);
    expect(unseal<unknown[]>(db.settings.get(WEIXIN_OUTBOX_REF))).toHaveLength(1);
    expect(server.requestsFor('/sendmessage')).toHaveLength(1);
    expect(channel.getLoginState()).toMatchObject({ phase: 'ERROR' });
    await channel.dispose();
  });

  it('persists transient outbox retry state before sleeping', async () => {
    const now = 10_000;
    const sleeper = controlledSleep();
    const server = new FakeIlinkServer();
    server.updates.push({ ret: 0, msgs: [], get_updates_buf: 'cursor-transient-error' });
    server.sends.push(new Error('network unavailable'));
    const { channel, db } = makeHarness(server, { now: () => now, sleep: sleeper.sleep });
    seedSession(db);
    db.settings.set(WEIXIN_OUTBOX_REF, seal([{
      id: 'transient-failure', generation: 1, accountId: 'bot-account', to: 'owner-user',
      contextToken: 'retry-context', content: 'retry me', createdAt: 1
    }]));

    await channel.connect();
    await flushUntil(() => sleeper.waits.length === 1, 'transient outbox retry delay');

    const stored = unseal<Array<{ attempts: number; nextAttemptAt: number }>>(db.settings.get(WEIXIN_OUTBOX_REF));
    expect(stored[0]).toMatchObject({ attempts: 1, nextAttemptAt: now + 2_000 });
    expect(sleeper.waits[0].ms).toBe(2_000);
    expect(sleeper.waits[0].signal).toBeInstanceOf(AbortSignal);
    await channel.dispose();
  });

  it('drops a transiently failing outbox head at the retry cap and releases the next reply', async () => {
    const server = new FakeIlinkServer();
    server.updates.push({ ret: 0, msgs: [], get_updates_buf: 'cursor-retry-cap' });
    server.sends.push(
      new Error('network still unavailable'),
      { ret: 0 }
    );
    const { channel, db } = makeHarness(server);
    seedSession(db);
    db.settings.set(WEIXIN_OUTBOX_REF, seal([
      {
        id: 'retry-cap-failure', generation: 1, accountId: 'bot-account', to: 'owner-user',
        contextToken: 'retry-cap-context', content: 'discard after this attempt', createdAt: 1,
        attempts: 5, nextAttemptAt: 0
      },
      {
        id: 'reply-after-retry-cap', generation: 1, accountId: 'bot-account', to: 'owner-user',
        contextToken: 'released-context', content: 'send after retry cap', createdAt: 2,
        attempts: 0, nextAttemptAt: 0
      }
    ]));

    await channel.connect();
    await flushUntil(() => server.requestsFor('/sendmessage').length === 2, 'reply after transient retry cap');
    await flushUntil(() => !db.settings.has(WEIXIN_OUTBOX_REF), 'retry cap cleanup');

    expect(server.requestsFor('/sendmessage').map((request) => jsonBody(request).msg.context_token)).toEqual([
      'retry-cap-context',
      'released-context'
    ]);
    await channel.disconnect();
  });

  it('preserves the outbox head and stores cooldown when send returns -14', async () => {
    const now = 20_000;
    const sleeper = controlledSleep();
    const server = new FakeIlinkServer();
    server.updates.push({ ret: 0, msgs: [], get_updates_buf: 'cursor-send-cooldown' });
    server.sends.push({ ret: -14, errmsg: 'session paused' });
    const { channel, db } = makeHarness(server, { now: () => now, sleep: sleeper.sleep });
    seedSession(db);
    db.settings.set(WEIXIN_OUTBOX_REF, seal([{
      id: 'cooldown-reply', generation: 1, accountId: 'bot-account', to: 'owner-user',
      contextToken: 'cooldown-context', content: 'keep during cooldown', createdAt: 1
    }]));

    await channel.connect();
    await flushUntil(() => sleeper.waits.length === 1, 'send protocol cooldown delay');

    expect(unseal<unknown[]>(db.settings.get(WEIXIN_OUTBOX_REF))).toHaveLength(1);
    expect(unseal<{ cooldownUntil?: number }>(db.settings.get(WEIXIN_POLL_STATE_REF))).toMatchObject({
      cooldownUntil: now + 60 * 60_000
    });
    expect(db.channel.status).toBe('RECONNECTING');
    expect(sleeper.waits[0].ms).toBe(60 * 60_000);
    expect(sleeper.waits[0].signal).toBeInstanceOf(AbortSignal);
    await channel.dispose();
  });

  it('does not let a concurrent successful poll erase a send-side cooldown', async () => {
    const now = 30_000;
    const sleeper = controlledSleep();
    const monitorResponse = deferred<Response>();
    const server = new FakeIlinkServer();
    server.updates.push(
      { ret: 0, msgs: [], get_updates_buf: 'cursor-probe-before-race' },
      monitorResponse.promise
    );
    server.sends.push({ ret: -14, errmsg: 'session paused' });
    const { channel, db } = makeHarness(server, { now: () => now, sleep: sleeper.sleep });
    seedSession(db);
    db.settings.set(WEIXIN_OUTBOX_REF, seal([{
      id: 'raced-cooldown-reply', generation: 1, accountId: 'bot-account', to: 'owner-user',
      contextToken: 'raced-cooldown-context', content: 'keep during concurrent poll', createdAt: 1
    }]));

    await channel.connect();
    await flushUntil(() => sleeper.waits.length === 1, 'send-side cooldown before poll response');
    await flushUntil(() => server.requestsFor('/getupdates').length === 2, 'concurrent monitor poll');
    monitorResponse.resolve(new Response(JSON.stringify({
      ret: 0,
      msgs: [],
      get_updates_buf: 'cursor-after-raced-poll'
    }), { status: 200 }));
    await flushUntil(() => sleeper.waits.length === 2, 'monitor honoring send-side cooldown');

    expect(unseal<{ cursor: string; cooldownUntil?: number }>(db.settings.get(WEIXIN_POLL_STATE_REF))).toMatchObject({
      cursor: 'cursor-after-raced-poll',
      cooldownUntil: now + 60 * 60_000
    });
    expect(db.channel.status).toBe('RECONNECTING');
    expect(db.statusHistory.at(-1)).toBe('RECONNECTING');
    expect(unseal<unknown[]>(db.settings.get(WEIXIN_OUTBOX_REF))).toHaveLength(1);
    await channel.dispose();
  });

  it('waits for session cooldown before draining a persisted reply', async () => {
    let now = 10_000;
    const sleeper = controlledSleep();
    const server = new FakeIlinkServer();
    server.updates.push({ ret: 0, msgs: [], get_updates_buf: 'cursor-probe' });
    const { channel, db } = makeHarness(server, { now: () => now, sleep: sleeper.sleep });
    seedSession(db);
    db.settings.set(WEIXIN_POLL_STATE_REF, seal({
      cursor: 'cursor-before', contextTokens: {}, seenIds: [], cooldownUntil: now + 60_000
    }));
    db.settings.set(WEIXIN_OUTBOX_REF, seal([{
      id: 'stable-reply-id', generation: 1, accountId: 'bot-account', to: 'owner-user', contextToken: 'context-cooldown', content: 'queued during cooldown', createdAt: now
    }]));

    await expect(channel.connect()).resolves.toMatchObject({ ok: true, message: expect.stringContaining('冷却') });
    await flushUntil(() => sleeper.waits.length >= 2, 'monitor and outbox cooldown waits');
    expect(server.requestsFor('/sendmessage')).toHaveLength(0);

    now += 60_000;
    for (const wait of [...sleeper.waits]) wait.resolve();
    await flushUntil(() => server.requestsFor('/sendmessage').length === 1, 'post-cooldown outbox send');
    await flushUntil(() => !db.settings.has(WEIXIN_OUTBOX_REF), 'post-cooldown outbox deletion');
    expect(jsonBody(server.requestsFor('/sendmessage')[0]).msg.item_list[0].text_item.text).toBe('queued during cooldown');
    await channel.disconnect();
  });

  it('does not send an outbox entry through a different active account', async () => {
    const server = new FakeIlinkServer();
    server.updates.push({ ret: 0, msgs: [], get_updates_buf: 'new-account-cursor' });
    const { channel, db } = makeHarness(server);
    seedSession(db);
    db.settings.set(WEIXIN_OUTBOX_REF, seal([{
      id: 'old-account-reply',
      generation: 1,
      accountId: 'old-bot-account',
      to: 'old-owner',
      contextToken: 'old-context',
      content: 'must not cross accounts',
      createdAt: 1
    }]));

    await channel.connect();
    await flushUntil(() => !db.settings.has(WEIXIN_OUTBOX_REF), 'stale account outbox cleanup');

    expect(server.requestsFor('/sendmessage')).toHaveLength(0);
    await channel.disconnect();
  });

  it('ignores a duplicate message already persisted in the poll state', async () => {
    vi.useFakeTimers();
    const server = new FakeIlinkServer();
    server.updates.push({ ret: 0, msgs: [makeMessage()], get_updates_buf: 'cursor-next' });
    const { channel, db, orchestrator } = makeHarness(server);
    seedSession(db);
    db.settings.set(WEIXIN_POLL_STATE_REF, seal({
      cursor: 'cursor-before',
      contextTokens: {},
      seenIds: ['message:101']
    }));

    await channel.connect();
    await flushUntil(() => server.pendingSignals.length === 1, 'next long poll');

    expect(orchestrator.createTask).not.toHaveBeenCalled();
    expect(server.requestsFor('/sendmessage')).toHaveLength(0);
    await channel.disconnect();
  });

  it('ignores foreign senders and group messages', async () => {
    const server = new FakeIlinkServer();
    server.updates.push({
      ret: 0,
      msgs: [
        makeMessage({ message_id: 201, from_user_id: 'foreign-user' }),
        makeMessage({ message_id: 202, group_id: 'group-1' })
      ],
      get_updates_buf: 'cursor-next'
    });
    const { channel, db, orchestrator } = makeHarness(server);
    seedSession(db);

    await channel.connect();
    await flushUntil(() => server.pendingSignals.length === 1, 'next long poll');

    expect(orchestrator.createTask).not.toHaveBeenCalled();
    expect(server.requestsFor('/sendmessage')).toHaveLength(0);
    await channel.disconnect();
  });

  it('ignores owner messages that do not carry a stable upstream ID', async () => {
    const server = new FakeIlinkServer();
    server.updates.push({
      ret: 0,
      msgs: [makeMessage({ message_id: undefined, client_id: undefined, seq: undefined })],
      get_updates_buf: 'cursor-after-unstable-message'
    });
    const { channel, db, orchestrator } = makeHarness(server);
    seedSession(db);

    await channel.connect();
    await flushUntil(() => server.pendingSignals.length === 1, 'next long poll after unstable message');

    expect(orchestrator.createTask).not.toHaveBeenCalled();
    expect(server.requestsFor('/sendmessage')).toHaveLength(0);
    expect(unseal<{ cursor: string; seenIds: string[] }>(db.settings.get(WEIXIN_POLL_STATE_REF))).toMatchObject({
      cursor: 'cursor-after-unstable-message',
      seenIds: []
    });
    await channel.disconnect();
  });

  it('cools down for one hour on protocol error -14 without expiring credentials', async () => {
    const server = new FakeIlinkServer();
    server.updates.push({ ret: -14, errmsg: 'token expired', msgs: [] });
    const { channel, db } = makeHarness(server);
    seedSession(db);

    const result = await channel.connect();
    await flushUntil(() => db.channel.status === 'RECONNECTING', 'session cooldown state');

    expect(result).toMatchObject({ ok: true, message: expect.stringContaining('冷却') });
    expect(channel.isActive()).toBe(true);
    expect(channel.getLoginState()).toMatchObject({
      phase: 'CONNECTED',
      message: expect.stringContaining('一小时后自动恢复')
    });
    expect(db.statusHistory).not.toContain('AUTH_EXPIRED');
    expect(db.settings.get(WEIXIN_SESSION_REF)).toBeDefined();
    await channel.disconnect();
  });

  it('honors monitor ret -14 even when errcode is zero', async () => {
    const sleeper = controlledSleep();
    const server = new FakeIlinkServer();
    server.updates.push(
      { ret: 0, errcode: 0, msgs: [], get_updates_buf: 'probe-ok' },
      { ret: -14, errcode: 0, errmsg: 'mixed cooldown', msgs: [] }
    );
    const { channel, db } = makeHarness(server, { sleep: sleeper.sleep });
    seedSession(db);

    await expect(channel.connect()).resolves.toMatchObject({ ok: true });
    await flushUntil(() => db.channel.status === 'RECONNECTING', 'mixed-code monitor cooldown');

    const pollState = unseal<{ cooldownUntil?: number }>(db.settings.get(WEIXIN_POLL_STATE_REF));
    expect(pollState.cooldownUntil).toEqual(expect.any(Number));
    expect(channel.getLoginState().message).toContain('一小时后自动恢复');
    await channel.disconnect();
  });

  it('resumes polling when the one-hour -14 cooldown expires', async () => {
    let now = 50_000;
    const sleeper = controlledSleep();
    const server = new FakeIlinkServer();
    server.updates.push(
      { ret: -14, errmsg: 'session paused', msgs: [] },
      { ret: 0, msgs: [], get_updates_buf: 'cursor-after-cooldown' }
    );
    const { channel, db } = makeHarness(server, { now: () => now, sleep: sleeper.sleep });
    seedSession(db);

    await expect(channel.connect()).resolves.toMatchObject({ ok: true, message: expect.stringContaining('冷却') });
    await flushUntil(() => sleeper.waits.length === 1, 'one-hour cooldown sleep');
    expect(sleeper.waits[0].ms).toBe(60 * 60_000);
    expect(server.requestsFor('/getupdates')).toHaveLength(1);

    now += 60 * 60_000;
    sleeper.waits[0].resolve();
    await flushUntil(() => db.channel.status === 'ONLINE', 'polling recovery after cooldown');

    expect(server.requestsFor('/getupdates')).toHaveLength(3);
    expect(unseal<{ cooldownUntil?: number; cursor: string }>(db.settings.get(WEIXIN_POLL_STATE_REF))).toMatchObject({
      cursor: 'cursor-after-cooldown'
    });
    expect(unseal<{ cooldownUntil?: number }>(db.settings.get(WEIXIN_POLL_STATE_REF))).not.toHaveProperty('cooldownUntil');

    await channel.dispose();
    await channel.dispose();
  });

  it('dispose aborts workers while preserving authorization and persistent channel status', async () => {
    const server = new FakeIlinkServer();
    server.updates.push({ ret: 0, msgs: [], get_updates_buf: 'dispose-cursor' });
    const { channel, db } = makeHarness(server);
    seedSession(db);
    db.settings.set(WEIXIN_POLL_STATE_REF, seal({ cursor: 'before-dispose', contextTokens: {}, seenIds: [] }));

    await channel.connect();
    await flushUntil(() => server.pendingSignals.length === 1, 'worker before dispose');
    const sessionBefore = db.settings.get(WEIXIN_SESSION_REF);
    const pollBefore = db.settings.get(WEIXIN_POLL_STATE_REF);

    await channel.dispose();
    await flushUntil(() => server.abortedPolls === 1, 'worker abort during dispose');

    expect(channel.isActive()).toBe(false);
    expect(db.settings.get(WEIXIN_SESSION_REF)).toBe(sessionBefore);
    expect(db.settings.get(WEIXIN_POLL_STATE_REF)).toBe(pollBefore);
    expect(db.channel.status).toBe('ONLINE');
    expect(db.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'channel.weixin.ilink.logout' }));
    expect(server.requestsFor('/notifystop')).toHaveLength(1);
  });

  it('user disconnect aborts workers and clears encrypted authorization state', async () => {
    const server = new FakeIlinkServer();
    server.updates.push({ ret: 0, msgs: [], get_updates_buf: 'logout-cursor' });
    const { channel, db } = makeHarness(server);
    seedSession(db);
    db.settings.set(WEIXIN_POLL_STATE_REF, seal({ cursor: '', contextTokens: {}, seenIds: [] }));

    await channel.connect();
    await flushUntil(() => server.pendingSignals.length === 1, 'worker before logout');
    await channel.disconnect();

    expect(db.settings.has(WEIXIN_SESSION_REF)).toBe(false);
    expect(db.settings.has(WEIXIN_POLL_STATE_REF)).toBe(false);
    expect(db.channel.status).toBe('DISABLED');
    expect(channel.getLoginState()).toMatchObject({ phase: 'IDLE', qrDataUrl: null });
    expect(db.audit).toHaveBeenCalledWith(expect.objectContaining({
      actor: 'admin',
      action: 'channel.weixin.ilink.logout',
      result: 'ok'
    }));
    expect(server.requestsFor('/notifystop')).toHaveLength(1);
  });

  it('aborts an in-flight long poll when disconnected', async () => {
    const { channel, db, server } = makeHarness();
    seedSession(db);
    server.updates.push({ ret: 0, msgs: [], get_updates_buf: 'cursor-probed' });

    await channel.connect();
    await flushUntil(() => server.pendingSignals.length === 1, 'in-flight long poll');
    const pollingSignal = server.pendingSignals[0];
    expect(pollingSignal.aborted).toBe(false);

    await channel.disconnect();
    await flushUntil(() => server.abortedPolls === 1, 'long poll abort');

    expect(pollingSignal.aborted).toBe(true);
    expect(channel.isActive()).toBe(false);
    expect(db.channel.status).toBe('DISABLED');
    expect(channel.getLoginState()).toMatchObject({ phase: 'IDLE', qrDataUrl: null });
  });
});
