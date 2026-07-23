/**
 * 本地 API Bridge（反向代理）：
 * 在 127.0.0.1:29998 启动 OpenAI 兼容 API 代理服务。
 * 外部工具（Claude Code / Codex / OpenCode）配置 base_url=http://127.0.0.1:29998/v1 + bridge key 即可使用。
 * 请求验证 bridge key 后转发到系统内配置的供应商（按 model 路由），支持 SSE 流式透传。
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Database } from './database.js';
import type { ProviderManager } from './providerManager.js';

const DEFAULT_PORT = 29998;

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
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = req.url ?? '';

    // 健康检查
    if (url === '/health' || url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'aibox-api-bridge' }));
      return;
    }

    // 验证 bridge key
    const auth = req.headers.authorization ?? '';
    const token = auth.replace(/^Bearer\s+/i, '');
    const bridgeKey = this.getBridgeKey();
    if (token !== bridgeKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid bridge key', type: 'authentication_error', code: 'invalid_api_key' } }));
      return;
    }

    // GET /v1/models
    if (url === '/v1/models' && req.method === 'GET') {
      const providers = this.providers.list();
      const models = providers.map((p) => ({
        id: p.model, object: 'model', created: Math.floor(p.createdAt / 1000), owned_by: p.name
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: models }));
      return;
    }

    // POST /v1/chat/completions
    if (url === '/v1/chat/completions' && req.method === 'POST') {
      await this.proxyChatCompletions(req, res);
      return;
    }

    // 其他请求返回 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Not found: ${req.method} ${url}`, type: 'invalid_request_error' } }));
  }

  private async proxyChatCompletions(req: IncomingMessage, res: ServerResponse) {
    // 读取请求 body
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
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
        // SSE 流式透传
        const reader = upstream.body.getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { res.end(); break; }
            res.write(value);
          }
        };
        await pump();
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
