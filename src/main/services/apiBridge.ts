/**
 * 本地 API Bridge（反向代理）：
 * 在 127.0.0.1:29998 启动 OpenAI 兼容 API 代理服务。
 * 外部工具（Claude Code / Codex / OpenCode）配置 base_url=http://127.0.0.1:29998/v1 + bridge key 即可使用。
 * 请求验证 bridge key 后转发到系统内配置的供应商（按 model 路由），支持 SSE 流式透传。
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { safeStorage } from 'electron';
import { WebSocket, WebSocketServer } from 'ws';
import type { Database } from './database.js';
import type { ProviderManager } from './providerManager.js';
import type { ApiBridgeStatus } from '../../shared/types.js';

const DEFAULT_PORT = 29998;
export const BRIDGE_KEY_SECRET_REF = 'secret:bridge:key';
const LEGACY_BRIDGE_KEY_SETTING = 'bridge_key';
/** Main-only fact: the port actually bound by the current listener. This is
 * distinct from bridge_port because port 0 asks the OS for an ephemeral port. */
export const BRIDGE_RUNTIME_PORT_SETTING = 'bridge_runtime_port';
/** 请求体上限：chat/completions 的正常体量远低于此，超限即拒绝以免被单请求打满内存 */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface BusinessGatewayHandlers {
  command: (command: string, payload: JsonRecord) => Promise<unknown>;
}

type JsonRecord = Record<string, unknown>;

function anthropicContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.map((block) => {
    if (!block || typeof block !== 'object') return '';
    const item = block as JsonRecord;
    if (item.type === 'text' && typeof item.text === 'string') return item.text;
    return '';
  }).filter(Boolean).join('');
}

/** Translate the Anthropic Messages request used by Claude Code into the
 * OpenAI Chat Completions shape accepted by most local gateways. Tool results
 * remain individual tool messages so the model can continue a real tool loop. */
export function anthropicToOpenAiRequest(input: JsonRecord): JsonRecord {
  const messages: JsonRecord[] = [];
  if (typeof input.system === 'string' && input.system.trim()) {
    messages.push({ role: 'system', content: input.system });
  } else if (Array.isArray(input.system)) {
    const systemText = anthropicContentText(input.system);
    if (systemText) messages.push({ role: 'system', content: systemText });
  }
  for (const raw of Array.isArray(input.messages) ? input.messages : []) {
    if (!raw || typeof raw !== 'object') continue;
    const message = raw as JsonRecord;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content = Array.isArray(message.content) ? message.content : [];
    const toolUses = content.filter((block): block is JsonRecord => Boolean(block && typeof block === 'object' && (block as JsonRecord).type === 'tool_use'));
    const toolResults = content.filter((block): block is JsonRecord => Boolean(block && typeof block === 'object' && (block as JsonRecord).type === 'tool_result'));
    if (toolResults.length > 0) {
      for (const result of toolResults) {
        const toolCallId = typeof result.tool_use_id === 'string' ? result.tool_use_id : `tool-${randomUUID()}`;
        messages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: anthropicContentText(result.content) || (result.is_error ? 'tool_error' : '')
        });
      }
      const text = anthropicContentText(Array.isArray(message.content) ? content : message.content).trim();
      if (text) messages.push({ role, content: text });
      continue;
    }
    const text = anthropicContentText(Array.isArray(message.content) ? content : message.content);
    const toolCalls = toolUses.map((use) => ({
      id: typeof use.id === 'string' ? use.id : `tool-${randomUUID()}`,
      type: 'function',
      function: {
        name: typeof use.name === 'string' ? use.name : 'unknown_tool',
        arguments: JSON.stringify(use.input && typeof use.input === 'object' ? use.input : {})
      }
    }));
    messages.push({
      role,
      content: text || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
    });
  }
  const tools = Array.isArray(input.tools)
    ? input.tools.filter((tool): tool is JsonRecord => Boolean(tool && typeof tool === 'object')).map((tool) => ({
      type: 'function',
      function: {
        name: String(tool.name ?? 'tool'),
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: tool.input_schema && typeof tool.input_schema === 'object' ? tool.input_schema : { type: 'object', properties: {} }
      }
    }))
    : [];
  return {
    model: typeof input.model === 'string' ? input.model : '',
    messages,
    ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    stream: input.stream === true,
    ...(typeof input.max_tokens === 'number' ? { max_tokens: input.max_tokens } : {}),
    ...(typeof input.temperature === 'number' ? { temperature: input.temperature } : {})
  };
}

function anthropicResponseFromOpenAi(input: JsonRecord, model: string): JsonRecord {
  const choice = Array.isArray(input.choices) && input.choices[0] && typeof input.choices[0] === 'object'
    ? input.choices[0] as JsonRecord : {};
  const message = choice.message && typeof choice.message === 'object' ? choice.message as JsonRecord : {};
  const content: JsonRecord[] = [];
  if (typeof message.content === 'string' && message.content) content.push({ type: 'text', text: message.content });
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const raw of toolCalls) {
    if (!raw || typeof raw !== 'object') continue;
    const call = raw as JsonRecord;
    const fn = call.function && typeof call.function === 'object' ? call.function as JsonRecord : {};
    let inputValue: unknown = {};
    try { inputValue = JSON.parse(typeof fn.arguments === 'string' ? fn.arguments : '{}'); } catch { inputValue = {}; }
    content.push({ type: 'tool_use', id: String(call.id ?? `tool-${randomUUID()}`), name: String(fn.name ?? 'unknown_tool'), input: inputValue });
  }
  const usage = input.usage && typeof input.usage === 'object' ? input.usage as JsonRecord : {};
  const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';
  return {
    id: `msg_${randomBytes(12).toString('hex')}`,
    type: 'message', role: 'assistant', model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens ?? 0),
      output_tokens: Number(usage.completion_tokens ?? 0)
    }
  };
}

function anthropicSseEvent(event: string, data: JsonRecord): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Convert an OpenAI SSE body to the Anthropic event stream consumed by the
 * Claude SDK. The adapter preserves text and fragmented tool input deltas. */
export async function openAiSseToAnthropicSse(body: ReadableStream<Uint8Array>, model: string, write: (chunk: string) => Promise<void> | void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let blockIndex = 0;
  let textBlock = false;
  const toolBlocks = new Set<number>();
  let stopReason: 'end_turn' | 'tool_use' = 'end_turn';
  let outputTokens = 0;
  await write(anthropicSseEvent('message_start', {
    type: 'message_start',
    message: { id: `msg_${randomBytes(12).toString('hex')}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
  }));
  const closeText = async () => {
    if (!textBlock) return;
    await write(anthropicSseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex }));
    textBlock = false;
  };
  const process = async (data: string) => {
    if (data === '[DONE]') return;
    let frame: JsonRecord;
    try { frame = JSON.parse(data) as JsonRecord; } catch { return; }
    const choice = Array.isArray(frame.choices) && frame.choices[0] && typeof frame.choices[0] === 'object'
      ? frame.choices[0] as JsonRecord : {};
    const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta as JsonRecord : {};
    const reason = typeof choice.finish_reason === 'string' ? choice.finish_reason : '';
    if (reason === 'tool_calls' || Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) stopReason = 'tool_use';
    if (typeof delta.content === 'string' && delta.content) {
      if (!textBlock) {
        await write(anthropicSseEvent('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } }));
        textBlock = true;
      }
      await write(anthropicSseEvent('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: delta.content } }));
    }
    for (const rawCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      if (!rawCall || typeof rawCall !== 'object') continue;
      const call = rawCall as JsonRecord;
      const index = Number(call.index ?? 0);
      const fn = call.function && typeof call.function === 'object' ? call.function as JsonRecord : {};
      await closeText();
      if (!toolBlocks.has(index)) {
        toolBlocks.add(index);
        blockIndex = Math.max(blockIndex, index + 1);
        await write(anthropicSseEvent('content_block_start', {
          type: 'content_block_start', index,
          content_block: { type: 'tool_use', id: String(call.id ?? `tool-${randomUUID()}`), name: String(fn.name ?? 'unknown_tool'), input: {} }
        }));
      }
      if (typeof fn.arguments === 'string' && fn.arguments) {
        await write(anthropicSseEvent('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: fn.arguments } }));
      }
    }
    const usage = frame.usage && typeof frame.usage === 'object' ? frame.usage as JsonRecord : null;
    if (usage) outputTokens = Number(usage.completion_tokens ?? outputTokens);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith('data:')) await process(line.slice(5).trim());
    }
  }
  await closeText();
  for (const index of [...toolBlocks].sort((a, b) => a - b)) {
    await write(anthropicSseEvent('content_block_stop', { type: 'content_block_stop', index }));
  }
  await write(anthropicSseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } }));
  await write(anthropicSseEvent('message_stop', { type: 'message_stop' }));
}

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
  private websocketServer: WebSocketServer | null = null;
  private readonly businessClients = new Map<WebSocket, Set<string>>();
  private businessHandlers: BusinessGatewayHandlers | null = null;
  private startAttempt: {
    server: Server;
    promise: Promise<void>;
    cancel: () => void;
  } | null = null;
  private stopAttempt: Promise<void> | null = null;
  private port = DEFAULT_PORT;

  constructor(private db: Database, private providers: ProviderManager) {}

  setBusinessGatewayHandlers(handlers: BusinessGatewayHandlers | null): void {
    this.businessHandlers = handlers;
  }

  /** Broadcast a project-scoped event to authenticated OA/business clients. */
  publishBusinessEvent(event: JsonRecord): void {
    const projectId = typeof event.projectId === 'string' ? event.projectId : null;
    let encoded: string;
    try { encoded = JSON.stringify(event); } catch { return; }
    for (const [client, projects] of this.businessClients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      // A business client is deny-by-default. It must explicitly subscribe to
      // a project before receiving any project-scoped event; otherwise one
      // valid Bridge key would expose every project's progress and artifacts.
      if (projectId && !projects.has(projectId)) continue;
      try { client.send(encoded); } catch { client.terminate(); }
    }
  }

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
    const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });
    candidate.on('upgrade', (request, socket, head) => {
      let url: URL;
      try { url = new URL(request.url ?? '/', 'http://127.0.0.1'); }
      catch { socket.destroy(); return; }
      if (url.pathname !== '/v1/business/events' || url.search) { socket.destroy(); return; }
      try {
        if (!this.authorizeRequest(request)) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      } catch {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
      }
      websocketServer.handleUpgrade(request, socket, head, (client) => this.attachBusinessClient(client));
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
    this.websocketServer = websocketServer;
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
      try { this.db.setSetting(BRIDGE_RUNTIME_PORT_SETTING, String(this.port)); } catch { /* best effort */ }
      settled = true;
      if (this.startAttempt === attempt) this.startAttempt = null;
      console.log(`[ApiBridge] 本地 API 代理已启动: http://127.0.0.1:${this.port}/v1`);
      resolveStart();
    });

    const failStart = (error: Error) => {
      const active = this.server === candidate;
      if (active) {
        this.server = null;
        try { this.db.raw.prepare('DELETE FROM settings WHERE key = ?').run(BRIDGE_RUNTIME_PORT_SETTING); } catch { /* best effort */ }
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
    try { this.db.raw.prepare('DELETE FROM settings WHERE key = ?').run(BRIDGE_RUNTIME_PORT_SETTING); } catch { /* best effort */ }
    this.websocketServer?.clients.forEach((client) => client.terminate());
    this.businessClients.clear();
    this.websocketServer?.close();
    this.websocketServer = null;
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
    let authorized = false;
    try { authorized = this.authorizeRequest(req); }
    catch (error) { this.failRequest(res, error); return; }
    if (!authorized) {
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

    // Claude Code uses the Anthropic Messages protocol. The bridge adapts it
    // to the configured OpenAI-compatible Provider instead of forwarding
    // /v1/messages to an upstream that explicitly rejects that route.
    if (pathname === '/v1/messages' && req.method === 'POST') {
      await this.proxyAnthropicMessages(req, res);
      return;
    }

    // 其他请求返回 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Not found: ${req.method} ${pathname}`, type: 'invalid_request_error' } }));
  }

  private authorizeRequest(req: IncomingMessage): boolean {
    const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const apiKeyHeader = req.headers['x-api-key'] ?? req.headers['api-key'] ?? '';
    const headerKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
    const token = auth.replace(/^Bearer\s+/i, '') || (typeof headerKey === 'string' ? headerKey : '');
    return safeEqual(token, this.getBridgeKey());
  }

  private attachBusinessClient(client: WebSocket): void {
    const projects = new Set<string>();
    this.businessClients.set(client, projects);
    client.send(JSON.stringify({ type: 'business.events.ready', protocol: 1 }));
    client.on('message', (data, binary) => {
      if (binary || !this.businessHandlers) return;
      let message: JsonRecord;
      try { message = JSON.parse(data.toString()) as JsonRecord; }
      catch { client.send(JSON.stringify({ type: 'error', error: 'Invalid JSON message' })); return; }
      const type = typeof message.type === 'string' ? message.type : '';
      const requestId = typeof message.requestId === 'string' ? message.requestId : null;
      if (type === 'subscribe') {
        const projectId = typeof message.projectId === 'string' ? message.projectId.trim() : '';
        if (!projectId || projectId.length > 128) {
          client.send(JSON.stringify({ type: 'error', requestId, error: 'projectId is required' }));
          return;
        }
        projects.add(projectId);
        client.send(JSON.stringify({ type: 'subscribed', requestId, projectId }));
        return;
      }
      const command = type.replace(/^business\./, '');
      if (!/^(submit|cancel|snapshot)$/.test(command)) {
        client.send(JSON.stringify({ type: 'error', requestId, error: 'Unsupported business gateway command' }));
        return;
      }
      const projectId = typeof message.projectId === 'string' ? message.projectId.trim() : '';
      if (!projectId || !projects.has(projectId)) {
        client.send(JSON.stringify({
          type: 'ack', requestId, command, ok: false,
          error: 'Subscribe to the project before issuing business commands'
        }));
        return;
      }
      void this.businessHandlers.command(command, message).then((result) => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'ack', requestId, command, ok: true, result }));
      }).catch((error: unknown) => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'ack', requestId, command, ok: false, error: error instanceof Error ? error.message : String(error) }));
      });
    });
    const cleanup = () => this.businessClients.delete(client);
    client.once('close', cleanup);
    client.once('error', cleanup);
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

  private async proxyAnthropicMessages(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Request body too large' } }));
        req.destroy();
        return;
      }
      chunks.push(buf);
    }
    let input: JsonRecord;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRecord; }
    catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON body' } }));
      return;
    }
    const model = typeof input.model === 'string' ? input.model : '';
    const resolved = this.providers.resolveByModel(model);
    if (!resolved) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `No provider configured for model "${model}"` } }));
      return;
    }
    const openAiBody = anthropicToOpenAiRequest(input);
    const targetUrl = `${resolved.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    try {
      const upstream = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(resolved.key ? { Authorization: `Bearer ${resolved.key}` } : {}) },
        body: JSON.stringify(openAiBody),
        redirect: 'error'
      });
      const isStream = input.stream === true;
      if (!upstream.ok || !upstream.body) {
        const body = await upstream.text().catch(() => '');
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: upstream.status >= 500 ? 'api_error' : 'invalid_request_error', message: body.slice(0, 4_000) || `Provider returned HTTP ${upstream.status}` } }));
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      if (isStream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        let clientGone = false;
        const onClose = () => { clientGone = true; };
        res.once('close', onClose);
        try {
          await openAiSseToAnthropicSse(upstream.body, model, (chunk) => {
            if (!clientGone && !res.destroyed) res.write(chunk);
          });
        } finally {
          res.removeListener('close', onClose);
          if (!clientGone && !res.writableEnded) res.end();
        }
      } else {
        const body = await upstream.json() as JsonRecord;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(anthropicResponseFromOpenAi(body, model)));
      }
      try {
        this.db.audit({ id: randomUUID(), actor: 'system', action: 'bridge.anthropic.adapter', target: model, result: 'openai-chat', source: 'api-bridge' });
      } catch { /* adapter audit is best effort */ }
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `Upstream error: ${error instanceof Error ? error.message : String(error)}` } }));
    }
  }
}
