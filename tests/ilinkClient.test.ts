import { describe, expect, it, vi } from 'vitest';
import {
  ILinkClient,
  ILinkHttpError,
  ILinkProtocolError,
  ILINK_NOTIFY_STOP_TIMEOUT_MS,
  ILINK_QUIT_CLEANUP_BUDGET_MS,
  extractIlinkText,
  ilinkMessageKey,
  sanitizeIlinkBaseUrl
} from '../src/main/services/channels/ilinkClient.js';

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function mockFetchJson(payload: unknown, status = 200): {
  fetchImpl: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

function requestHeaders(request: CapturedRequest): Record<string, string> {
  return request.init.headers as Record<string, string>;
}

function requestBody(request: CapturedRequest): Record<string, unknown> {
  return JSON.parse(String(request.init.body)) as Record<string, unknown>;
}

describe('sanitizeIlinkBaseUrl', () => {
  it('accepts only HTTPS hosts in the weixin.qq.com DNS boundary', () => {
    expect(sanitizeIlinkBaseUrl('https://ilinkai.weixin.qq.com/')).toBe('https://ilinkai.weixin.qq.com');
    expect(sanitizeIlinkBaseUrl(' https://weixin.qq.com/api/?ignored=1#fragment ')).toBe('https://weixin.qq.com/api');

    for (const unsafe of [
      'http://ilinkai.weixin.qq.com',
      'https://127.0.0.1',
      'https://localhost',
      'https://weixin.qq.com.evil.example',
      'https://evilweixin.qq.com',
      'file:///etc/passwd',
      'not-a-url'
    ]) {
      expect(sanitizeIlinkBaseUrl(unsafe), unsafe).toBeNull();
    }
  });
});

describe('ILinkClient requests', () => {
  it('keeps the app quit budget just above the notifystop request timeout', () => {
    expect(ILINK_NOTIFY_STOP_TIMEOUT_MS).toBe(1_500);
    expect(ILINK_QUIT_CLEANUP_BUDGET_MS).toBe(1_750);
    expect(ILINK_QUIT_CLEANUP_BUDGET_MS).toBeGreaterThan(ILINK_NOTIFY_STOP_TIMEOUT_MS);
  });

  it('creates a QR code with the unauthenticated POST shape and caps local tokens', async () => {
    const { fetchImpl, requests } = mockFetchJson({ qrcode: 'qr-id', qrcode_img_content: 'qr-image' });
    const client = new ILinkClient('https://ilinkai.weixin.qq.com', undefined, fetchImpl);
    const localTokens = Array.from({ length: 12 }, (_, index) => `token-${index}`);

    await expect(client.createQrCode(localTokens)).resolves.toEqual({
      qrcode: 'qr-id',
      qrcode_img_content: 'qr-image'
    });

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request.url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3');
    expect(request.init.method).toBe('POST');
    expect(request.init.redirect).toBe('manual');
    expect(requestBody(request)).toEqual({ local_token_list: localTokens.slice(0, 10) });
    expect(requestHeaders(request)).toMatchObject({
      'Content-Type': 'application/json',
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': '132102',
      AuthorizationType: 'ilink_bot_token'
    });
    expect(requestHeaders(request)).not.toHaveProperty('Authorization');
    expect(Buffer.from(requestHeaders(request)['X-WECHAT-UIN'], 'base64').toString('utf8')).toMatch(/^\d+$/);
  });

  it('does not follow redirects that could forward local bot tokens', async () => {
    const requests: CapturedRequest[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} });
      return new Response('', {
        status: 307,
        headers: { location: 'https://attacker.example/collect' }
      });
    }) as unknown as typeof fetch;
    const client = new ILinkClient('https://ilinkai.weixin.qq.com', undefined, fetchImpl);

    await expect(client.createQrCode(['local-secret-token'])).rejects.toMatchObject({
      name: 'ILinkHttpError',
      status: 307
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain('weixin.qq.com');
    expect(requests[0].init.redirect).toBe('manual');
  });

  it('sends authenticated getupdates headers and cursor body', async () => {
    const { fetchImpl, requests } = mockFetchJson({ ret: 0, msgs: [], get_updates_buf: 'next-cursor' });
    const client = new ILinkClient('https://ilinkai.weixin.qq.com', '  bot-token  ', fetchImpl);

    await expect(client.getUpdates('cursor-1', 35_000)).resolves.toMatchObject({
      ret: 0,
      get_updates_buf: 'next-cursor'
    });

    const request = requests[0];
    expect(request.url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/getupdates');
    expect(request.init.method).toBe('POST');
    expect(requestBody(request)).toEqual({
      get_updates_buf: 'cursor-1',
      base_info: { channel_version: '1.7.1', bot_agent: 'OPC-Nexus/1.7.1' }
    });
    const headers = requestHeaders(request);
    expect(headers).toMatchObject({
      AuthorizationType: 'ilink_bot_token',
      Authorization: 'Bearer bot-token',
      'Content-Type': 'application/json',
      'iLink-App-Id': 'bot'
    });
    expect(Buffer.from(headers['X-WECHAT-UIN'], 'base64').toString('utf8')).toMatch(/^\d+$/);
  });

  it('distinguishes a normal long-poll timeout from a connection-probe timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort, { once: true });
      })) as unknown as typeof fetch;
      const client = new ILinkClient('https://ilinkai.weixin.qq.com', 'bot-token', fetchImpl);

      const longPoll = client.getUpdates('cursor', 1_000);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(longPoll).resolves.toEqual({ ret: 0, msgs: [], get_updates_buf: 'cursor' });

      const probe = client.getUpdates('cursor', 1_000, undefined, { timeoutAsEmpty: false });
      const rejected = expect(probe).rejects.toMatchObject({ name: 'AbortError', message: '微信 iLink 请求超时' });
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('sends text with the target and inbound context token', async () => {
    const { fetchImpl, requests } = mockFetchJson({ ret: 0 });
    const client = new ILinkClient('https://ilinkai.weixin.qq.com', 'bot-token', fetchImpl);

    await expect(client.sendText('wx-user-42', '任务已完成', 'context-from-update')).resolves.toBeUndefined();

    const request = requests[0];
    expect(request.url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/sendmessage');
    expect(request.init.method).toBe('POST');
    expect(requestBody(request)).toEqual({
      msg: {
        from_user_id: '',
        to_user_id: 'wx-user-42',
        client_id: expect.stringMatching(/^opc-nexus-[0-9a-f-]{36}$/),
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text: '任务已完成' } }],
        context_token: 'context-from-update'
      },
      base_info: { channel_version: '1.7.1', bot_agent: 'OPC-Nexus/1.7.1' }
    });
  });

  it('keeps an explicit outbox clientId stable across retries', async () => {
    const { fetchImpl, requests } = mockFetchJson({ ret: 0 });
    const client = new ILinkClient('https://ilinkai.weixin.qq.com', 'bot-token', fetchImpl);
    const outboxId = '6d84637b-fc4e-49e8-b288-07650eef4af5';

    await client.sendText('wx-user-42', '重试消息', 'context-token', undefined, outboxId);
    await client.sendText('wx-user-42', '重试消息', 'context-token', undefined, outboxId);

    const wireIds = requests.map((request) => (requestBody(request).msg as { client_id: string }).client_id);
    expect(wireIds).toEqual([
      `opc-nexus-${outboxId}`,
      `opc-nexus-${outboxId}`
    ]);
  });

  it('keeps default sendText calls random and rejects unsafe explicit clientIds', async () => {
    const { fetchImpl, requests } = mockFetchJson({ ret: 0 });
    const client = new ILinkClient('https://ilinkai.weixin.qq.com', 'bot-token', fetchImpl);

    await client.sendText('wx-user-42', '消息一', 'context-token');
    await client.sendText('wx-user-42', '消息二', 'context-token');
    const wireIds = requests.map((request) => (requestBody(request).msg as { client_id: string }).client_id);
    expect(wireIds[0]).toMatch(/^opc-nexus-[0-9a-f-]{36}$/);
    expect(wireIds[1]).toMatch(/^opc-nexus-[0-9a-f-]{36}$/);
    expect(wireIds[0]).not.toBe(wireIds[1]);

    await expect(client.sendText('wx-user-42', '消息', 'context-token', undefined, 'bad client/id')).rejects.toThrow('clientId');
    await expect(client.sendText('wx-user-42', '消息', 'context-token', undefined, 'x'.repeat(119))).rejects.toThrow('不能超过 118 个字符');
    expect(requests).toHaveLength(2);
  });

  it('throws a structured -14 protocol error when either response code reports cooldown', async () => {
    const { fetchImpl } = mockFetchJson({ ret: -14, errcode: 0, errmsg: 'session cooldown' });
    const client = new ILinkClient('https://ilinkai.weixin.qq.com', 'bot-token', fetchImpl);

    const request = client.sendText('wx-user-42', '消息', 'context-token');
    await expect(request).rejects.toBeInstanceOf(ILinkProtocolError);
    await expect(request).rejects.toMatchObject({
      name: 'ILinkProtocolError',
      code: -14,
      message: '微信消息发送失败：session cooldown'
    });
  });

  it('prioritizes -14 over another nonzero code and structures ordinary protocol errors', async () => {
    const cooldown = mockFetchJson({ ret: 7, errcode: -14 });
    const cooldownClient = new ILinkClient('https://ilinkai.weixin.qq.com', 'bot-token', cooldown.fetchImpl);
    await expect(cooldownClient.sendText('wx-user-42', '消息', 'context-token')).rejects.toMatchObject({
      name: 'ILinkProtocolError',
      code: -14
    });

    const ordinary = mockFetchJson({ ret: 0, errcode: 42 });
    const ordinaryClient = new ILinkClient('https://ilinkai.weixin.qq.com', 'bot-token', ordinary.fetchImpl);
    await expect(ordinaryClient.sendText('wx-user-42', '消息', 'context-token')).rejects.toMatchObject({
      name: 'ILinkProtocolError',
      code: 42,
      message: '微信消息发送失败：ret=42'
    });
  });

  it('aborts notifystop after the short shutdown timeout', async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          };
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener('abort', abort, { once: true });
        });
      }) as unknown as typeof fetch;
      const client = new ILinkClient('https://ilinkai.weixin.qq.com', 'bot-token', fetchImpl);

      const stop = client.notifyStop();
      const rejected = expect(stop).rejects.toMatchObject({
        name: 'AbortError',
        message: '微信 iLink 请求超时'
      });
      expect(fetchImpl).toHaveBeenCalledWith(
        new URL('https://ilinkai.weixin.qq.com/ilink/bot/msg/notifystop'),
        expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) })
      );
      expect(requestSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(ILINK_NOTIFY_STOP_TIMEOUT_MS - 1);
      expect(requestSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('surfaces HTTP authentication failures as ILinkHttpError', async () => {
    const { fetchImpl } = mockFetchJson({ errmsg: 'unauthorized' }, 401);
    const client = new ILinkClient('https://ilinkai.weixin.qq.com', 'invalid-token', fetchImpl);

    const request = client.getUpdates('cursor-1', 1_000);
    await expect(request).rejects.toBeInstanceOf(ILinkHttpError);
    await expect(request).rejects.toMatchObject({
      name: 'ILinkHttpError',
      status: 401,
      message: '微信 iLink 请求失败（HTTP 401）'
    });
  });
});

describe('iLink message helpers', () => {
  it('extracts trimmed text and voice transcripts', () => {
    expect(extractIlinkText({ item_list: [{ type: 1, text_item: { text: '  文本消息  ' } }] })).toBe('文本消息');
    expect(extractIlinkText({ item_list: [{ type: 3, voice_item: { text: '  语音转写  ' } }] })).toBe('语音转写');
    expect(extractIlinkText({ item_list: [{ type: 2 }] })).toBe('');
  });

  it('builds stable dedupe keys in message, client, then sequence priority', () => {
    expect(ilinkMessageKey({ message_id: 0, client_id: 'client-1', seq: 9 })).toBe('message:0');
    expect(ilinkMessageKey({ client_id: 'client-1', seq: 9 })).toBe('client:client-1');
    expect(ilinkMessageKey({ seq: 0 })).toBe('seq:0');
    expect(ilinkMessageKey({})).toBeNull();
  });
});
