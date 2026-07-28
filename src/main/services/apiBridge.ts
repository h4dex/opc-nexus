/**
 * 本地 API Bridge（反向代理）：
 * 在 127.0.0.1:29998 启动 OpenAI 兼容 API 代理服务。
 * 外部工具（Claude Code / Codex / OpenCode）配置 base_url=http://127.0.0.1:29998/v1 + bridge key 即可使用。
 * 请求验证 bridge key 后转发到系统内配置的供应商（按 model 路由），支持 SSE 流式透传。
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database } from './database.js';
import type { ProviderManager } from './providerManager.js';

const DEFAULT_PORT = 29998;
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
  private port = DEFAULT_PORT;

  constructor(private db: Database, private providers: ProviderManager) {}

  /** 获取当前 bridge key（不存在则自动生成） */
  getBridgeKey(): string {
    let key = this.db.getSetting<string | null>('bridge_key', null);
    if (!key) {
      key = `sk-bridge-${randomBytes(24).toString('hex')}`;
      this.db.setSetting('bridge_key', key);
    }
    return key;
  }

  /** 重新生成 bridge key */
  regenerateKey(): string {
    const key = `sk-bridge-${randomBytes(24).toString('hex')}`;
    this.db.setSetting('bridge_key', key);
    return key;
  }

  /** 获取状态 */
  getStatus(): { running: boolean; port: number; bridgeKey: string; enabled: boolean } {
    return {
      running: this.server !== null,
      port: this.port,
      bridgeKey: this.getBridgeKey(),
      enabled: this.db.getSetting<string>('bridge_enabled', 'false') === 'true'
    };
  }

  /** 启用/停用 */
  toggle(enabled: boolean) {
    this.db.setSetting('bridge_enabled', enabled ? 'true' : 'false');
    if (enabled) this.start();
    else this.stop();
  }

  start() {
    if (this.server) return;
    const port = Number(this.db.getSetting<string>('bridge_port', String(DEFAULT_PORT))) || DEFAULT_PORT;
    this.port = port;

    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    this.server.listen(port, '127.0.0.1', () => {
      console.log(`[ApiBridge] 本地 API 代理已启动: http://127.0.0.1:${port}/v1`);
    });
    this.server.on('error', (err) => {
      console.error(`[ApiBridge] 启动失败:`, err.message);
      this.server = null;
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
      console.log('[ApiBridge] 已停止');
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
        body: JSON.stringify(body)
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
