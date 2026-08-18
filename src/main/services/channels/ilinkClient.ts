/**
 * 微信 iLink Bot HTTP 协议客户端。
 * 协议基线：Tencent/openclaw-weixin v2.4.6（MIT）。
 */
import { randomBytes, randomUUID } from 'node:crypto';

export const ILINK_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const ILINK_NOTIFY_STOP_TIMEOUT_MS = 1_500;
export const ILINK_QUIT_CLEANUP_BUDGET_MS = ILINK_NOTIFY_STOP_TIMEOUT_MS + 250;
const ILINK_APP_ID = 'bot';
// Tencent/openclaw-weixin v2.4.6: major << 16 | minor << 8 | patch.
const ILINK_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6);
const CHANNEL_VERSION = '1.8.1';
const WIRE_CLIENT_ID_PREFIX = 'opc-nexus-';
const MAX_WIRE_CLIENT_ID_LENGTH = 128;

export type ILinkQrStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect';

export interface ILinkQrCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export interface ILinkQrStatusResponse {
  status: ILinkQrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
}

export interface ILinkMessageItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string };
}

export interface ILinkMessage {
  seq?: number;
  message_id?: number;
  client_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: ILinkMessageItem[];
  context_token?: string;
}

export interface ILinkUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: ILinkMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

interface GetUpdatesOptions {
  /** Set false only when the caller requires a response rather than an empty timed-out poll. */
  timeoutAsEmpty?: boolean;
}

export class ILinkHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ILinkHttpError';
  }
}

export class ILinkProtocolError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = 'ILinkProtocolError';
  }
}

export class ILinkTimeoutError extends Error {
  constructor() {
    super('微信 iLink 请求超时');
    // Preserve the established AbortError contract while retaining a reliable
    // class identity so unrelated transport aborts are never accepted as polls.
    this.name = 'AbortError';
  }
}

type FetchLike = typeof fetch;

function randomWechatUin(): string {
  const value = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function commonHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': ILINK_CLIENT_VERSION
  };
}

function protocolErrorCode(response: { ret?: number; errcode?: number }): number | null {
  const codes = [response.ret, response.errcode].filter((code): code is number => code != null && code !== 0);
  if (codes.includes(-14)) return -14;
  return codes[0] ?? null;
}

function combineAbortSignals(timeoutMs: number, external?: AbortSignal): {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timeout = false;
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort();
  }, timeoutMs);
  const abort = () => controller.abort();
  if (external?.aborted) controller.abort();
  else external?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', abort);
    }
  };
}

/** 仅接受微信 iLink 的 HTTPS 主机，防止服务端返回值被用于 SSRF。 */
export function sanitizeIlinkBaseUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || (host !== 'weixin.qq.com' && !host.endsWith('.weixin.qq.com'))) return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/** 扫码重定向字段是裸主机名，不接受 scheme、端口、路径或 userinfo。 */
export function sanitizeIlinkRedirectHost(value: string | undefined): string | null {
  const host = value?.trim().toLowerCase();
  if (!host || !/^[a-z0-9.-]+$/.test(host)) return null;
  if (host !== 'weixin.qq.com' && !host.endsWith('.weixin.qq.com')) return null;
  return `https://${host}`;
}

export function ilinkMessageKey(message: ILinkMessage): string | null {
  if (message.message_id != null) return `message:${message.message_id}`;
  if (message.client_id) return `client:${message.client_id}`;
  if (message.seq != null) return `seq:${message.seq}`;
  return null;
}

export function extractIlinkText(message: ILinkMessage): string {
  for (const item of message.item_list ?? []) {
    if (item.type === 1 && item.text_item?.text != null) return String(item.text_item.text).trim();
    if (item.type === 3 && item.voice_item?.text) return item.voice_item.text.trim();
  }
  return '';
}

function wireClientId(clientId?: string): string {
  const suffix = clientId?.trim();
  if (!suffix) return `${WIRE_CLIENT_ID_PREFIX}${randomUUID()}`;
  if (!/^[A-Za-z0-9._-]+$/.test(suffix)) throw new Error('微信消息 clientId 仅允许字母、数字、点、下划线和短横线');
  const wireId = `${WIRE_CLIENT_ID_PREFIX}${suffix}`;
  if (wireId.length > MAX_WIRE_CLIENT_ID_LENGTH) throw new Error(`微信消息 clientId 不能超过 ${MAX_WIRE_CLIENT_ID_LENGTH - WIRE_CLIENT_ID_PREFIX.length} 个字符`);
  return wireId;
}

export class ILinkClient {
  private baseUrl: string;

  constructor(
    baseUrl = ILINK_DEFAULT_BASE_URL,
    private token?: string,
    private readonly fetchImpl: FetchLike = fetch
  ) {
    const safe = sanitizeIlinkBaseUrl(baseUrl);
    if (!safe) throw new Error('微信 iLink API 地址无效');
    this.baseUrl = safe;
  }

  setBaseUrl(value: string) {
    const safe = sanitizeIlinkBaseUrl(value);
    if (!safe) throw new Error('微信 iLink API 地址无效');
    this.baseUrl = safe;
  }

  setToken(token: string) {
    this.token = token;
  }

  async createQrCode(localTokens: string[] = [], signal?: AbortSignal): Promise<ILinkQrCodeResponse> {
    return this.requestJson<ILinkQrCodeResponse>({
      method: 'POST',
      endpoint: 'ilink/bot/get_bot_qrcode?bot_type=3',
      body: { local_token_list: localTokens.slice(0, 10) },
      timeoutMs: 30_000,
      signal,
      authenticated: false
    });
  }

  async pollQrCode(qrcode: string, verifyCode?: string, signal?: AbortSignal): Promise<ILinkQrStatusResponse> {
    const query = new URLSearchParams({ qrcode });
    if (verifyCode) query.set('verify_code', verifyCode);
    try {
      return await this.requestJson<ILinkQrStatusResponse>({
        method: 'GET',
        endpoint: `ilink/bot/get_qrcode_status?${query.toString()}`,
        timeoutMs: 40_000,
        signal,
        authenticated: false
      });
    } catch (error) {
      // Tencent's reference client treats QR polling as an eventually-consistent
      // wait operation: gateway timeouts, transient HTTP errors and malformed
      // intermediary responses must not tear down the user's scan session.
      if (!signal?.aborted) return { status: 'wait' };
      throw error;
    }
  }

  async getUpdates(
    cursor: string,
    timeoutMs: number,
    signal?: AbortSignal,
    options: GetUpdatesOptions = {}
  ): Promise<ILinkUpdatesResponse> {
    try {
      return await this.requestJson<ILinkUpdatesResponse>({
        method: 'POST',
        endpoint: 'ilink/bot/getupdates',
        body: { get_updates_buf: cursor, base_info: this.baseInfo() },
        timeoutMs: Math.max(timeoutMs + 5_000, 10_000),
        signal,
        authenticated: true
      });
    } catch (error) {
      if (options.timeoutAsEmpty !== false && error instanceof ILinkTimeoutError && !signal?.aborted) {
        return { ret: 0, msgs: [], get_updates_buf: cursor };
      }
      throw error;
    }
  }

  async sendText(toUserId: string, text: string, contextToken: string, signal?: AbortSignal, clientId?: string): Promise<void> {
    const response = await this.requestJson<{ ret?: number; errcode?: number; errmsg?: string }>({
      method: 'POST',
      endpoint: 'ilink/bot/sendmessage',
      body: {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: wireClientId(clientId),
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text } }],
          context_token: contextToken
        },
        base_info: this.baseInfo()
      },
      timeoutMs: 15_000,
      signal,
      authenticated: true
    });
    const code = protocolErrorCode(response);
    if (code !== null) {
      throw new ILinkProtocolError(code, `微信消息发送失败：${response.errmsg ?? `ret=${code}`}`);
    }
  }

  async notifyStart(signal?: AbortSignal): Promise<void> {
    await this.notifyLifecycle('ilink/bot/msg/notifystart', 10_000, signal);
  }

  async notifyStop(signal?: AbortSignal): Promise<void> {
    await this.notifyLifecycle('ilink/bot/msg/notifystop', ILINK_NOTIFY_STOP_TIMEOUT_MS, signal);
  }

  private baseInfo() {
    return { channel_version: CHANNEL_VERSION, bot_agent: 'OPC-Nexus/1.8.1' };
  }

  private async notifyLifecycle(endpoint: string, timeoutMs: number, signal?: AbortSignal) {
    const response = await this.requestJson<{ ret?: number; errcode?: number; errmsg?: string }>({
      method: 'POST',
      endpoint,
      body: { base_info: this.baseInfo() },
      timeoutMs,
      signal,
      authenticated: true
    });
    const code = protocolErrorCode(response);
    if (code !== null) throw new ILinkProtocolError(code, response.errmsg ?? `ret=${code}`);
  }

  private async requestJson<T>(opts: {
    method: 'GET' | 'POST';
    endpoint: string;
    body?: unknown;
    timeoutMs: number;
    signal?: AbortSignal;
    authenticated: boolean;
  }): Promise<T> {
    const url = new URL(opts.endpoint, `${this.baseUrl}/`);
    const headers: Record<string, string> = commonHeaders();
    let body: string | undefined;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
      headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = randomWechatUin();
    }
    if (opts.authenticated) {
      if (!this.token?.trim()) throw new Error('微信 iLink Bot Token 未配置');
      headers.Authorization = `Bearer ${this.token.trim()}`;
    }

    const combined = combineAbortSignals(opts.timeoutMs, opts.signal);
    try {
      const response = await this.fetchImpl(url, {
        method: opts.method,
        headers,
        body,
        signal: combined.signal,
        // Never forward QR bodies containing local bot tokens to a redirect target.
        redirect: 'manual'
      });
      const raw = await response.text();
      if (!response.ok) throw new ILinkHttpError(response.status, `微信 iLink 请求失败（HTTP ${response.status}）`);
      try {
        return JSON.parse(raw) as T;
      } catch {
        throw new Error('微信 iLink 返回了无效 JSON');
      }
    } catch (error) {
      if (combined.timedOut()) {
        throw new ILinkTimeoutError();
      }
      throw error;
    } finally {
      combined.cleanup();
    }
  }
}
