/**
 * 本地 API Bridge（反向代理）：
 * 在 127.0.0.1:29998 启动 OpenAI 兼容 API 代理服务。
 * 外部工具（Claude Code / Codex / OpenCode）配置 base_url=http://127.0.0.1:29998/v1 + bridge key 即可使用。
 * 请求验证 bridge key 后转发到系统内配置的供应商（按 model 路由），支持 SSE 流式透传。
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { safeStorage } from 'electron';
import type { Database } from './database.js';
import type { ProviderManager } from './providerManager.js';
import type { ApiBridgeStatus } from '../../shared/types.js';

const DEFAULT_PORT = 29998;
export const BRIDGE_KEY_SECRET_REF = 'secret:bridge:key';
const LEGACY_BRIDGE_KEY_SETTING = 'bridge_key';
/** 请求体上限：chat/completions 的正常体量远低于此，超限即拒绝以免被单请求打满内存 */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * 取 URL 的 pathname。客户端常在 URL 上附加 query（如 `/v1/models?limit=1`），
 * 若直接与完整 url 精确比较会匹配失败并误返 404。
 */
export function pathOf(rawUrl: string | undefined): string {
  const u = rawUrl ?? '';
  const cut = u.search(/[?#]/);
  return cut >= 0 ? u.slice(0, cut) : u;
}

/** 定长比较，避免 bridge key 校验的时序侧信道 */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export class ApiBridge {
  private server: Server | null = null;
  private startAttempt: {
    server: Server;
    promise: Promise<void>;
    cancel: () => void;
  } | null = null;
  private stopAttempt: Promise<void> | null = null;
  private port = DEFAULT_PORT;

  constructor(private db: Database, private providers: ProviderManager) {}

  private closeServer(candidate: Server): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        candidate.removeListener('close', finish);
        resolve();
      };
      candidate.once('close', finish);
      try {
        candidate.close(finish);
        candidate.closeAllConnections();
      } catch {
        finish();
      }
    });
  }

  private trackServerClose(candidate: Server): Promise<void> {
    const closing = this.closeServer(candidate);
    this.stopAttempt = closing;
    void closing.then(() => {
      if (this.stopAttempt === closing) this.stopAttempt = null;
    });
    return closing;
  }

  private decryptBridgeKey(encrypted: unknown): string {
    if (typeof encrypted !== 'string' || !encrypted || !safeStorage.isEncryptionAvailable()) {
      throw new Error('系统密钥库不可用，无法读取 Bridge API Key');
    }
    try {
      const key = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      if (!key) throw new Error('empty key');
      return key;
    } catch {
      throw new Error('Bridge API Key 无法解密，请重新生成');
    }
  }

  private storeBridgeKey(key: string, action: string, actor: 'admin' | 'system'): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥库不可用，无法保存 Bridge API Key');
    const encrypted = safeStorage.encryptString(key).toString('base64');
    this.db.transaction(() => {
      this.db.setSetting(BRIDGE_KEY_SECRET_REF, encrypted);
      this.db.raw.prepare('DELETE FROM settings WHERE key = ?').run(LEGACY_BRIDGE_KEY_SETTING);
      this.db.audit({ id: randomUUID(), actor, action, target: BRIDGE_KEY_SECRET_REF, result: 'ok' });
    });
  }

  private readStoredBridgeKey(): string | null {
    const encrypted = this.db.getSetting<unknown>(BRIDGE_KEY_SECRET_REF, null);
    if (encrypted !== null) {
      const key = this.decryptBridgeKey(encrypted);
      if (this.db.getSetting<unknown>(LEGACY_BRIDGE_KEY_SETTING, null) !== null) {
        this.db.transaction(() => {
          this.db.raw.prepare('DELETE FROM settings WHERE key = ?').run(LEGACY_BRIDGE_KEY_SETTING);
          this.db.audit({
            id: randomUUID(), actor: 'system', action: 'bridge.key.legacy_cleanup',
            target: LEGACY_BRIDGE_KEY_SETTING, result: 'deleted'
          });
        });
      }
      return key;
    }

    const legacy = this.db.getSetting<unknown>(LEGACY_BRIDGE_KEY_SETTING, null);
    if (legacy === null) return null;
    if (typeof legacy !== 'string' || !legacy) throw new Error('旧版 Bridge API Key 无效，请重新生成');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥库不可用，无法迁移 Bridge API Key');
    const encryptedLegacy = safeStorage.encryptString(legacy).toString('base64');
    this.db.transaction(() => {
      this.db.setSetting(BRIDGE_KEY_SECRET_REF, encryptedLegacy);
      this.db.raw.prepare('DELETE FROM settings WHERE key = ?').run(LEGACY_BRIDGE_KEY_SETTING);
      this.db.audit({
        id: randomUUID(), actor: 'system', action: 'bridge.key.migrate',
        target: BRIDGE_KEY_SECRET_REF, result: 'ok'
      });
    });
    return legacy;
  }

  /** 获取当前 bridge key（不存在则安全生成） */
  getBridgeKey(): string {
    const existing = this.readStoredBridgeKey();
    if (existing) return existing;
    const key = `sk-bridge-${randomBytes(24).toString('hex')}`;
    this.storeBridgeKey(key, 'bridge.key.generate', 'system');
    return key;
  }

  /** 重新生成 bridge key */
  regenerateKey(): string {
    const key = `sk-bridge-${randomBytes(24).toString('hex')}`;
    this.storeBridgeKey(key, 'bridge.key.rotate', 'admin');
    return key;
  }

  /** Renderer-visible status never contains the bearer credential. */
  getStatus(): ApiBridgeStatus {
    let keyConfigured = false;
    try {
      keyConfigured = this.getBridgeKey().length > 0;
    } catch {
      // Keep status readable so the Renderer can offer credential rotation.
    }
    return {
      running: this.server?.listening === true,
      port: this.port,
      keyConfigured,
      enabled: this.db.getSetting<string>('bridge_enabled', 'false') === 'true'
    };
  }

  /** 启用/停用 */
  async toggle(enabled: boolean): Promise<void> {
    if (enabled) {
      try {
        await this.start();
        if (!this.server?.listening) throw new Error('API Bridge failed to reach listening state');
        this.db.setSetting('bridge_enabled', 'true');
      } catch (error) {
        this.db.setSetting('bridge_enabled', 'false');
        throw error;
      }
    } else {
      await this.stop();
      this.db.setSetting('bridge_enabled', 'false');
    }
  }

  async start(): Promise<void> {
    if (this.server?.listening) return;
    if (this.startAttempt) return this.startAttempt.promise;
    if (this.stopAttempt) {
      await this.stopAttempt;
      return this.start();
    }
    this.getBridgeKey();
    const configuredPort = Number(this.db.getSetting<string>('bridge_port', String(DEFAULT_PORT)));
    const port = Number.isInteger(configuredPort) && configuredPort >= 0 && configuredPort <= 65535
      ? configuredPort
      : DEFAULT_PORT;
    this.port = port;

    const candidate = createServer((req, res) => {
      void this.handleRequest(req, res).catch((error) => this.failRequest(res, error));
    });
    let settled = false;
    let resolveStart!: () => void;
    let rejectStart!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    const attempt = {
      server: candidate,
      promise,
      cancel: () => {
        if (settled) return;
        settled = true;
        rejectStart(new Error('API Bridge start cancelled'));
      }
    };

    this.server = candidate;
    this.startAttempt = attempt;

    candidate.once('listening', () => {
      if (settled) {
        void this.closeServer(candidate);
        return;
      }
      if (this.server !== candidate) {
        settled = true;
        void this.closeServer(candidate);
        rejectStart(new Error('API Bridge start superseded'));
        return;
      }
      const address = candidate.address();
      if (address && typeof address !== 'string') this.port = address.port;
      settled = true;
      if (this.startAttempt === attempt) this.startAttempt = null;
      console.log(`[ApiBridge] 本地 API 代理已启动: http://127.0.0.1:${this.port}/v1`);
      resolveStart();
    });

    const failStart = (error: Error) => {
      const active = this.server === candidate;
      if (active) {
        this.server = null;
        try { this.db.setSetting('bridge_enabled', 'false'); } catch { /* best-effort state repair */ }
        this.trackServerClose(candidate);
        try {
          this.db.audit({
            id: randomUUID(), actor: 'system', action: 'bridge.server',
            target: 'api-bridge', result: 'fail-closed'
          });
        } catch {
          /* Server errors remain controlled even if audit persistence fails. */
        }
      } else {
        void this.closeServer(candidate);
      }
      if (this.startAttempt === attempt) this.startAttempt = null;
      if (!settled) {
        settled = true;
        rejectStart(error);
      }
      if (active) console.error('[ApiBridge] 启动或运行失败');
    };
    candidate.on('error', failStart);

    try {
      candidate.listen(port, '127.0.0.1');
    } catch (error) {
      failStart(error instanceof Error ? error : new Error(String(error)));
    }

    return promise;
  }

  async stop(): Promise<void> {
    if (this.stopAttempt) return this.stopAttempt;
    const candidate = this.server;
    if (!candidate) return;
    if (this.server === candidate) this.server = null;
    if (this.startAttempt?.server === candidate) {
      const attempt = this.startAttempt;
      this.startAttempt = null;
      attempt.cancel();
    }
    await this.trackServerClose(candidate);
    console.log('[ApiBridge] 已停止');
  }

  private failRequest(res: ServerResponse, error: unknown): void {
    console.error('[ApiBridge] 请求处理失败，已按不可用状态拒绝请求');
    try {
      this.db.audit({
        id: randomUUID(), actor: 'system', action: 'bridge.request',
        target: 'api-bridge', result: 'fail-closed'
      });
    } catch {
      /* Audit failure must not turn a controlled request failure into an unhandled rejection. */
    }
    if (res.writableEnded || res.destroyed) return;
    try {
      if (!res.headersSent) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: 'API Bridge temporarily unavailable',
            type: 'service_unavailable',
            code: 'bridge_unavailable'
          }
        }));
      } else {
        res.destroy();
      }
    } catch {
      try { res.destroy(); } catch { /* socket already unusable */ }
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse) {
    // CORS：本代理仅监听回环，供本机 CLI 工具直连（非浏览器场景）。
    // 不放行任意 Origin —— 否则任意网页都能在用户浏览器里拿 bridge key 打这个端口。
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // 只取 pathname：客户端常带 query（如 ?limit=1），精确比较整个 url 会误判为 404
    const pathname = pathOf(req.url);

    // 健康检查
    if (pathname === '/health' || pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'aibox-api-bridge' }));
      return;
    }

    // 验证 bridge key（定长比较，避免时序侧信道）
    const auth = req.headers.authorization ?? '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (!safeEqual(token, this.getBridgeKey())) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid bridge key', type: 'authentication_error', code: 'invalid_api_key' } }));
      return;
    }

    // GET /v1/models
    if (pathname === '/v1/models' && req.method === 'GET') {
      const providers = this.providers.list();
      const models = providers.map((p) => ({
        id: p.model, object: 'model', created: Math.floor(p.createdAt / 1000), owned_by: p.name
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: models }));
      return;
    }

    // POST /v1/chat/completions
    if (pathname === '/v1/chat/completions' && req.method === 'POST') {
      await this.proxyChatCompletions(req, res);
      return;
    }

    // 其他请求返回 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Not found: ${req.method} ${pathname}`, type: 'invalid_request_error' } }));
  }

  private async proxyChatCompletions(req: IncomingMessage, res: ServerResponse) {
    // 读取请求 body（带上限：避免超大请求打满内存）
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Request body too large', type: 'invalid_request_error' } }));
        req.destroy();
        return;
      }
      chunks.push(buf);
    }
    const bodyStr = Buffer.concat(chunks).toString('utf8');

    let body: { model?: string; stream?: boolean; [k: string]: unknown };
    try { body = JSON.parse(bodyStr); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }));
      return;
    }

    // 按 model 路由到对应供应商
    const model = body.model ?? '';
    const resolved = this.providers.resolveByModel(model);
    if (!resolved) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `No provider configured for model "${model}". Please configure a provider in AI Box settings.`, type: 'invalid_request_error' } }));
      return;
    }

    const targetUrl = `${resolved.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const isStream = body.stream === true;

    try {
      const upstream = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(resolved.key ? { Authorization: `Bearer ${resolved.key}` } : {})
        },
        body: JSON.stringify(body),
        redirect: 'error'
      });

      // 透传状态码和 headers
      const resHeaders: Record<string, string> = {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json'
      };
      res.writeHead(upstream.status, resHeaders);

      if (isStream && upstream.body) {
        // SSE 流式透传；客户端提前断开时释放上游读取器，避免连接与内存泄漏
        const reader = upstream.body.getReader();
        let clientGone = false;
        const onClose = () => { clientGone = true; void reader.cancel().catch(() => { /* 已释放 */ }); };
        res.once('close', onClose);
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done || clientGone) break;
            // write 返回 false 表示缓冲已满，等排空再继续，防止内存堆积
            if (!res.write(value)) {
              await new Promise<void>((r) => res.once('drain', r));
            }
          }
        } finally {
          res.removeListener('close', onClose);
          if (!clientGone) res.end();
        }
      } else {
        // 非流式：直接转发响应
        const text = await upstream.text();
        res.end(text);
      }
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Upstream error: ${err instanceof Error ? err.message : String(err)}`, type: 'upstream_error' } }));
      }
    }
  }
}
