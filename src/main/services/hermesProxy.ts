import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { HermesUiLease } from '../../shared/types.js';

const HOST = '127.0.0.1' as const;
const COOKIE = '__opc_hermes_workbench';
const DEFAULT_LEASE_TTL_MS = 8 * 60 * 60_000;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const HERMES_PROXY_BROWSER_TOKEN = 'opc-nexus-main-proxy';

function isBenignTransportError(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const message = error instanceof Error ? error.message : String(error);
  return code === 'ECONNRESET'
    || code === 'EPIPE'
    || code === 'ERR_STREAM_PREMATURE_CLOSE'
    || /(?:ECONNRESET|EPIPE|premature close|socket hang up)/i.test(message);
}

function isWireCloseCode(code: number): boolean {
  return Number.isInteger(code)
    && code >= 1000
    && code <= 4999
    && code !== 1004
    && code !== 1005
    && code !== 1006;
}

function closeWebSocketSafely(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.terminate();
    return;
  }
  if (socket.readyState !== WebSocket.OPEN) return;
  if (!isWireCloseCode(code)) {
    socket.terminate();
    return;
  }
  try { socket.close(code, reason); } catch { socket.terminate(); }
}

export type HermesUiAudience = 'desktop' | 'mobile-operator';

export interface HermesProxyStatus {
  running: boolean;
  port: number | null;
  origin: string | null;
  activeLeases: number;
  lastError: string | null;
}

export interface HermesProxyOptions {
  projectId: string;
  resolveUpstream: () => string | null;
  resolveServiceToken: () => string | null;
  hostToken?: string;
  onHostRequest?: (operation: string, payload: unknown) => Promise<unknown>;
  onProjectRequest?: (
    operation: string,
    payload: unknown,
    audience: HermesUiAudience
  ) => Promise<unknown>;
  audit?: (event: { method: string; path: string; status: number; projectId: string; detail?: string }) => void;
  trace?: (event: { phase: string; method?: string; pathname?: string; detail?: string }) => void;
  onUpstreamMessage?: (message: unknown) => void;
  onClientMessage?: (message: unknown) => Promise<{ handled: boolean; result?: unknown }>;
  now?: () => number;
}

interface LeaseRecord {
  id: string;
  expiresAt: number;
  audience: HermesUiAudience;
}

const BLOCKED_PROJECT_PAGES = /^\/(?:analytics|channels|config|cron|env|mcp|models|pairing|plugins|profiles|system|webhooks)(?:\/|$)/;
const BLOCKED_PROJECT_API_PREFIXES = [
  '/api/actions',
  '/api/auth',
  '/api/config',
  '/api/credentials',
  '/api/cron',
  '/api/egress',
  '/api/env',
  '/api/hermes/update',
  '/api/mcp',
  '/api/messaging',
  '/api/ops',
  '/api/pairing',
  '/api/profiles',
  '/api/providers',
  '/api/ssh',
  '/api/webhooks',
  '/api/dashboard/agent-plugins',
  '/api/dashboard/plugin-providers'
] as const;
const PROJECT_ATTACHMENT_PATH = /^\/__opc_nexus\/project\/attachments\/([A-Za-z0-9-]+)$/;
const PROJECT_UPLOAD_MAX_BYTES = 32 * 1024 * 1024;

function cookieValue(request: IncomingMessage, name: string): string | null {
  const raw = request.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Project-scoped reverse proxy. Hermes upstream ports are never exposed to Renderer code. */
export class HermesProxy {
  private readonly now: () => number;
  private server: Server | null = null;
  private websocketServer: WebSocketServer | null = null;
  private port: number | null = null;
  private lastError: string | null = null;
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly projectEventClients = new Set<WebSocket>();

  constructor(private readonly options: HermesProxyOptions) {
    this.now = options.now ?? Date.now;
  }

  getStatus(): HermesProxyStatus {
    this.pruneLeases();
    return {
      running: this.server?.listening === true,
      port: this.port,
      origin: this.port === null ? null : `http://${HOST}:${this.port}`,
      activeLeases: this.leases.size,
      lastError: this.lastError
    };
  }

  async start(): Promise<HermesProxyStatus> {
    if (this.server?.listening) return this.getStatus();
    const server = createServer((request, response) => {
      void this.forwardHttp(request, response).catch((error) => {
        if (isBenignTransportError(error) || request.aborted || response.destroyed || response.writableEnded) return;
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        if (!response.writableEnded) response.end('Hermes proxy request failed.');
        this.lastError = error instanceof Error ? error.message : String(error);
      });
    });
    const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_REQUEST_BYTES });
    server.on('upgrade', (request, socket, head) => {
      const lease = this.authorized(request);
      if (!lease) return this.rejectUpgrade(socket, 401, 'Unauthorized');
      let localUrl: URL;
      try { localUrl = new URL(request.url ?? '/', `http://${HOST}`); }
      catch { return this.rejectUpgrade(socket, 400, 'Bad request'); }
      if (localUrl.pathname === '/__opc_nexus/project/events') {
        if ((request.method ?? 'GET').toUpperCase() !== 'GET'
          || localUrl.search) {
          return this.rejectUpgrade(socket, 403, 'Project event stream rejected');
        }
        websocketServer.handleUpgrade(request, socket, head, (client) => this.attachProjectEvents(client));
        return;
      }
      if (!this.allowedProjectRequest(request, lease, true)) return this.rejectUpgrade(socket, 403, 'Project scope rejected');
      websocketServer.handleUpgrade(request, socket, head, (client) => this.forwardWebSocket(request, client));
    });
    server.on('error', (error) => { this.lastError = error.message; });
    server.on('connection', (socket) => {
      socket.on('error', (error) => {
        if (!isBenignTransportError(error)) this.lastError = error instanceof Error ? error.message : String(error);
      });
    });
    server.on('clientError', (error, socket) => {
      if (!socket.destroyed) {
        if (isBenignTransportError(error)) socket.destroy();
        else {
          try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); }
          catch { socket.destroy(); }
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(0, HOST, () => {
        server.off('error', onError);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Hermes proxy did not bind a loopback port');
    }
    this.server = server;
    this.websocketServer = websocketServer;
    this.port = address.port;
    this.lastError = null;
    return this.getStatus();
  }

  createLease(ttlMs = DEFAULT_LEASE_TTL_MS, audience: HermesUiAudience = 'desktop'): HermesUiLease {
    const status = this.getStatus();
    if (!status.running || !status.origin) throw new Error('Hermes proxy is not running');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > DEFAULT_LEASE_TTL_MS) {
      throw new Error('Hermes UI lease duration is invalid');
    }
    const id = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + ttlMs;
    this.leases.set(id, { id, expiresAt, audience });
    return { leaseId: id, projectId: this.options.projectId, url: `${status.origin}/`, expiresAt };
  }

  cookieForLease(lease: HermesUiLease): { name: string; value: string; url: string } {
    if (lease.projectId !== this.options.projectId || !this.leases.has(lease.leaseId)) {
      throw new Error('Hermes UI lease is invalid');
    }
    return { name: COOKIE, value: lease.leaseId, url: lease.url };
  }

  revokeLease(leaseId: string): void {
    this.leases.delete(leaseId);
  }

  publishProjectEvent(event: unknown): void {
    let encoded: string;
    try { encoded = JSON.stringify(event); }
    catch { return; }
    if (Buffer.byteLength(encoded, 'utf8') > 512 * 1024) return;
    for (const client of this.projectEventClients) {
      if (client.readyState === WebSocket.OPEN) client.send(encoded);
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    this.leases.clear();
    this.websocketServer?.clients.forEach((client) => client.terminate());
    this.projectEventClients.clear();
    this.websocketServer?.close();
    this.websocketServer = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        resolve();
      };
      const timeout = setTimeout(finish, 2_000);
      timeout.unref();
      server.once('close', finish);
      try {
        server.close(finish);
        server.closeIdleConnections();
        server.closeAllConnections();
      } catch {
        finish();
      }
    });
  }

  async requestGateway(method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> {
    const upstream = this.options.resolveUpstream();
    const serviceToken = this.options.resolveServiceToken();
    if (!upstream || !serviceToken) throw new Error('Hermes project service is offline');
    if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(method)) throw new Error('Hermes gateway method is invalid');
    const target = new URL('/api/ws', upstream);
    target.protocol = 'ws:';
    target.searchParams.set('token', serviceToken);
    const id = `opc-${randomBytes(12).toString('hex')}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(target.href, {
        headers: { 'x-opc-nexus-project': this.options.projectId },
        maxPayload: MAX_REQUEST_BYTES,
        handshakeTimeout: Math.min(timeoutMs, 10_000)
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.terminate();
        reject(new Error(`Hermes gateway request timed out: ${method}`));
      }, timeoutMs);
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { operation(); } finally { socket.close(); }
      };
      socket.once('open', () => socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })));
      socket.on('message', (data, binary) => {
        if (binary) return;
        let frame: Record<string, unknown>;
        try { frame = JSON.parse(data.toString()) as Record<string, unknown>; } catch { return; }
        if (frame.id !== id) return;
        if (frame.error) {
          const error = frame.error as Record<string, unknown>;
          finish(() => reject(new Error(typeof error.message === 'string' ? error.message : `Hermes gateway request failed: ${method}`)));
          return;
        }
        finish(() => resolve(frame.result));
      });
      socket.once('error', (error) => finish(() => reject(error)));
      socket.once('close', () => {
        finish(() => reject(new Error(`Hermes gateway closed before responding: ${method}`)));
      });
    });
  }

  private authorized(request: IncomingMessage): LeaseRecord | null {
    this.pruneLeases();
    const supplied = cookieValue(request, COOKIE);
    if (!supplied) return null;
    for (const lease of this.leases.values()) {
      if (equalSecret(supplied, lease.id)) return lease;
    }
    return null;
  }

  private async forwardHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let localUrl: URL;
    try { localUrl = new URL(request.url ?? '/', `http://${HOST}`); }
    catch { response.writeHead(400).end('Bad request'); return; }
    this.trace({ phase: 'http.enter', method: request.method, pathname: localUrl.pathname });
    if (localUrl.pathname.startsWith('/__opc_nexus/host/')) {
      await this.handleHostRequest(request, response, localUrl);
      return;
    }
    const lease = this.authorized(request);
    if (!lease) {
      response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('Hermes Workbench session expired. Reopen it from OPC-Nexus.');
      return;
    }
    if (!this.allowedProjectRequest(request, lease, false)) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('This Hermes machine-level route is unavailable in the project Workbench.');
      return;
    }
    const attachmentMatch = localUrl.pathname.match(PROJECT_ATTACHMENT_PATH);
    if (attachmentMatch && (request.method ?? 'GET').toUpperCase() === 'GET' && !localUrl.search) {
      await this.handleProjectAttachmentRequest(request, response, attachmentMatch[1]!, lease);
      return;
    }
    if (localUrl.pathname.startsWith('/__opc_nexus/project/')) {
      this.trace({ phase: 'project.route', method: request.method, pathname: localUrl.pathname });
      await this.handleProjectRequest(request, response, localUrl, lease);
      return;
    }
    const upstream = this.options.resolveUpstream();
    const serviceToken = this.options.resolveServiceToken();
    if (!upstream || !serviceToken) {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('Hermes project service is offline.');
      return;
    }
    let target: URL;
    try { target = new URL(request.url ?? '/', upstream); }
    catch { response.writeHead(400).end('Bad request'); return; }
    if (target.hostname !== HOST) {
      response.writeHead(403).end('Project scope rejected');
      return;
    }
    const headers = { ...request.headers };
    delete headers.cookie;
    delete headers.host;
    delete headers.connection;
    delete headers['accept-encoding'];
    delete headers['x-hermes-session-token'];
    delete headers.authorization;
    headers['x-opc-nexus-project'] = this.options.projectId;
    headers['x-hermes-session-token'] = serviceToken;
    if (request.headers.origin) headers.origin = target.origin;
    if (request.headers.referer) headers.referer = `${target.origin}/`;
    if (target.pathname === '/api/files/download' && target.searchParams.has('token')) {
      target.searchParams.set('token', serviceToken);
    }
    const forwarded = httpRequest({
      protocol: 'http:',
      hostname: HOST,
      port: Number(target.port),
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers
    }, (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers };
      delete responseHeaders['set-cookie'];
      responseHeaders['x-frame-options'] = 'DENY';
            responseHeaders['content-security-policy'] = "default-src 'self' blob: data:; connect-src 'self' ws:; img-src 'self' blob: data: https: aibox-artifact: aibox-mobile:; media-src 'self' blob: data: https: aibox-artifact: aibox-mobile:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'";
      const contentType = String(upstreamResponse.headers['content-type'] ?? '');
      if (contentType.includes('text/html')) {
        const chunks: Buffer[] = [];
        let bytes = 0;
        upstreamResponse.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes <= MAX_REQUEST_BYTES) chunks.push(chunk);
        });
        upstreamResponse.on('end', () => {
          if (bytes > MAX_REQUEST_BYTES) {
            response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
            response.end('Hermes upstream HTML exceeded the proxy limit.');
            return;
          }
          const html = Buffer.concat(chunks).toString('utf8')
            .replace(/window\.__HERMES_SESSION_TOKEN__\s*=\s*"(?:\\.|[^"\\])*"/g,
              `window.__HERMES_SESSION_TOKEN__="${HERMES_PROXY_BROWSER_TOKEN}"`)
            .replace('</head>', `<script>window.__OPC_NEXUS_PROJECT_MODE__="${lease.audience}";try{localStorage.setItem("hermes-locale","zh")}catch{}</script></head>`);
          delete responseHeaders['content-length'];
          delete responseHeaders['content-encoding'];
          responseHeaders['cache-control'] = 'no-store';
          response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
          response.end(html);
        });
      } else {
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        upstreamResponse.pipe(response);
      }
      this.options.audit?.({
        method: request.method ?? 'GET',
        path: target.pathname,
        status: upstreamResponse.statusCode ?? 502,
        projectId: this.options.projectId
      });
    });
    forwarded.on('error', (error) => {
      if (isBenignTransportError(error) || request.aborted || response.destroyed || response.writableEnded) return;
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      if (!response.writableEnded) response.end(`Hermes upstream unavailable: ${error.message}`);
    });
    response.once('close', () => {
      if (!response.writableFinished) forwarded.destroy();
    });
    request.once('aborted', () => forwarded.destroy());
    request.pipe(forwarded);
  }

  private async handleHostRequest(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const operation = url.pathname.slice('/__opc_nexus/host/'.length);
    const supplied = request.headers['x-opc-nexus-host-token'];
    const token = Array.isArray(supplied) ? supplied[0] : supplied;
    if (!this.options.hostToken || typeof token !== 'string' || !equalSecret(token, this.options.hostToken)) {
      response.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: 'Host contract authentication failed' }));
      return;
    }
    if (request.method !== 'POST' || !/^[a-z][a-z0-9_-]{0,63}$/.test(operation) || !this.options.onHostRequest) {
      response.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: 'Host contract operation is unavailable' }));
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 1024 * 1024) throw new Error('Host contract payload exceeds 1 MiB');
        chunks.push(buffer);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      const result = await this.options.onHostRequest(operation, payload);
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      });
      response.end(JSON.stringify({ ok: true, result }));
      this.options.audit?.({ method: 'HOST', path: operation, status: 200, projectId: this.options.projectId });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Host contract request failed';
      response.writeHead(422, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ok: false, error: message.slice(0, 4_000) }));
      this.options.audit?.({
        method: 'HOST', path: operation, status: 422, projectId: this.options.projectId,
        detail: message.slice(0, 1_000)
      });
    }
  }

  private async handleProjectRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    lease: LeaseRecord
  ): Promise<void> {
    const operation = url.pathname.slice('/__opc_nexus/project/'.length);
    this.trace({ phase: 'project.enter', method: request.method, pathname: url.pathname, detail: `operation=${operation};audience=${lease.audience}` });
    const readOnly = ['state', 'chat-history', 'chat-queue', 'conversations'].includes(operation) && request.method === 'GET';
    if (!this.options.onProjectRequest
      || (!readOnly && request.method !== 'POST')
      || !/^[a-z][a-z0-9-]{0,63}$/.test(operation)
      || url.search) {
      response.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ok: false, error: 'Project operation is unavailable' }));
      return;
    }
    try {
      let payload: unknown = null;
      if (!readOnly && operation === 'upload-attachment') {
        const bytes = await this.readRequestBody(request, PROJECT_UPLOAD_MAX_BYTES);
        const name = this.attachmentFilename(request);
        const mediaType = String(request.headers['content-type'] ?? 'application/octet-stream').split(';', 1)[0]!.trim();
        const conversationHeader = request.headers['x-conversation-id'];
        const conversationId = Array.isArray(conversationHeader) ? conversationHeader[0] : conversationHeader;
        payload = { name, mediaType, bytes, ...(conversationId ? { conversationId } : {}) };
      } else if (!readOnly) {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > 64 * 1024) throw new Error('Project operation payload exceeds 64 KiB');
          chunks.push(buffer);
        }
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
      }
      this.trace({ phase: 'project.callback.start', method: request.method, pathname: url.pathname, detail: `operation=${operation}` });
      const result = await this.options.onProjectRequest(operation, payload, lease.audience);
      this.trace({ phase: 'project.callback.end', method: request.method, pathname: url.pathname, detail: `operation=${operation}` });
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      });
      response.end(JSON.stringify({ ok: true, result }));
      this.options.audit?.({ method: readOnly ? 'PROJECT_GET' : 'PROJECT_POST', path: operation, status: 200, projectId: this.options.projectId });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Project operation failed';
      this.trace({ phase: 'project.callback.error', method: request.method, pathname: url.pathname, detail: message });
      response.writeHead(422, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ok: false, error: message.slice(0, 4_000) }));
      this.options.audit?.({
        method: 'PROJECT', path: operation, status: 422, projectId: this.options.projectId,
        detail: message.slice(0, 1_000)
      });
    }
  }

  private trace(event: { phase: string; method?: string; pathname?: string; detail?: string }): void {
    try { this.options.trace?.(event); } catch { /* diagnostics must never affect transport */ }
  }

  private async handleProjectAttachmentRequest(
    request: IncomingMessage,
    response: ServerResponse,
    attachmentId: string,
    lease: LeaseRecord
  ): Promise<void> {
    if (!this.options.onProjectRequest) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('Attachment access is unavailable for this session.');
      return;
    }
    try {
      const result = await this.options.onProjectRequest('read-attachment', { attachmentId }, lease.audience);
      if (!result || typeof result !== 'object' || !Buffer.isBuffer((result as { bytes?: unknown }).bytes)) {
        throw new Error('Invalid attachment response');
      }
      const value = result as { bytes: Buffer; contentType?: unknown; disposition?: unknown; attachment?: { name?: unknown } };
      const contentType = typeof value.contentType === 'string' ? value.contentType : 'application/octet-stream';
      const disposition = value.disposition === 'inline' ? 'inline' : 'attachment';
      const filename = typeof value.attachment?.name === 'string' ? value.attachment.name.replace(/[\r\n"\\]/g, '_') : 'attachment';
      response.writeHead(200, {
        'content-type': contentType,
        'content-length': value.bytes.length,
        'content-disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'cache-control': 'private, max-age=300',
        'x-content-type-options': 'nosniff'
      });
      response.end(request.method === 'HEAD' ? undefined : value.bytes);
    } catch (error) {
      if (request.aborted || response.destroyed || response.writableEnded) return;
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end(error instanceof Error ? error.message : 'Attachment unavailable');
    }
  }

  private attachmentFilename(request: IncomingMessage): string {
    const header = request.headers['content-disposition'];
    const value = Array.isArray(header) ? header[0] : header;
    const encoded = value?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    if (encoded) {
      try { return decodeURIComponent(encoded); } catch { /* fall through */ }
    }
    const plain = value?.match(/filename="([^"]+)"|filename=([^;]+)/i);
    return (plain?.[1] ?? plain?.[2] ?? 'attachment').trim();
  }

  private readRequestBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        request.resume();
        reject(error);
      };
      request.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maximum) {
          fail(new Error(`Attachment exceeds ${maximum} bytes`));
          return;
        }
        chunks.push(buffer);
      });
      request.once('end', () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks));
      });
      request.once('aborted', () => fail(new Error('Attachment upload aborted')));
      request.once('error', fail);
    });
  }

  private attachProjectEvents(client: WebSocket): void {
    this.projectEventClients.add(client);
    client.send(JSON.stringify({
      type: 'project.events.ready',
      projectId: this.options.projectId,
      timestamp: this.now()
    }));
    client.on('close', () => this.projectEventClients.delete(client));
    client.on('error', () => this.projectEventClients.delete(client));
  }

  private forwardWebSocket(request: IncomingMessage, client: WebSocket): void {
    const upstream = this.options.resolveUpstream();
    const serviceToken = this.options.resolveServiceToken();
    if (!upstream || !serviceToken) {
      client.close(1013, 'Hermes project service is offline');
      return;
    }
    const target = new URL(request.url ?? '/api/ws', upstream);
    const upstreamOrigin = target.origin;
    target.protocol = 'ws:';
    if (target.searchParams.has('token')) target.searchParams.set('token', serviceToken);
    const remote = new WebSocket(target.href, {
      headers: {
        origin: upstreamOrigin,
        'x-opc-nexus-project': this.options.projectId,
        'x-hermes-session-token': serviceToken
      },
      maxPayload: MAX_REQUEST_BYTES
    });
    const pending: Array<{ data: Buffer; binary: boolean }> = [];
    let pendingBytes = 0;
    const sendRemote = (data: Buffer, binary: boolean): void => {
      if (remote.readyState === WebSocket.OPEN) {
        remote.send(data, { binary });
        return;
      }
      if (remote.readyState !== WebSocket.CONNECTING || pendingBytes + data.length > MAX_REQUEST_BYTES) {
        closeBoth(1009, 'Hermes WebSocket request queue exceeded');
        return;
      }
      pending.push({ data, binary });
      pendingBytes += data.length;
    };
    client.on('message', (data, binary) => {
        const buffered = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        if (binary || !this.options.onClientMessage) {
          sendRemote(buffered, binary);
          return;
        }
        let parsed: unknown;
        try { parsed = JSON.parse(data.toString()); }
        catch {
          if (remote.readyState === WebSocket.OPEN) remote.send(data, { binary: false });
          return;
        }
        void this.options.onClientMessage(parsed).then((decision) => {
          if (!decision.handled) {
            sendRemote(buffered, false);
            return;
          }
          const frame = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown> : null;
          if (frame?.id !== undefined && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: decision.result ?? null }));
          }
        }).catch((error: unknown) => {
          const frame = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown> : null;
          if (frame?.id !== undefined && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              jsonrpc: '2.0',
              id: frame.id,
              error: { code: -32_000, message: error instanceof Error ? error.message : 'OPC-Nexus governance rejected the request' }
            }));
          }
        });
    });
    remote.on('message', (data, binary) => {
        if (!binary) {
          try {
            const parsed: unknown = JSON.parse(data.toString());
            this.options.onUpstreamMessage?.(parsed);
          } catch {
            // Hermes may send terminal/text frames. Only structured control
            // events are observed by the Nexus governance bridge; the UI still receives all.
          }
        }
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
    });
    remote.on('open', () => {
      for (const item of pending.splice(0)) remote.send(item.data, { binary: item.binary });
      pendingBytes = 0;
    });
    const closeBoth = (code = 1011, reason = 'Hermes WebSocket closed') => {
      closeWebSocketSafely(client, code, reason);
      closeWebSocketSafely(remote, code, reason);
    };
    client.on('close', () => closeBoth(1000, 'Client closed'));
    client.on('error', () => closeBoth());
    remote.on('close', () => closeBoth(1012, 'Hermes service closed'));
    remote.on('error', () => closeBoth());
  }

  private rejectUpgrade(socket: Duplex, status: number, message: string): void {
    socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  }

  private allowedProjectRequest(request: IncomingMessage, lease: LeaseRecord, websocket: boolean): boolean {
    let url: URL;
    try { url = new URL(request.url ?? '/', `http://${HOST}`); } catch { return false; }
    if (url.pathname.startsWith('/__opc_nexus/project/')) return !websocket;
    if (url.searchParams.has('profile')) return false;
    if (BLOCKED_PROJECT_PAGES.test(url.pathname)) return false;
    if (BLOCKED_PROJECT_API_PREFIXES.some((prefix) =>
      url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) return false;
    if (url.pathname.startsWith('/api/model/') && !['GET', 'HEAD'].includes((request.method ?? 'GET').toUpperCase())) {
      return false;
    }
    if (lease.audience === 'mobile-operator') {
      const allowedPage = /^\/chat(?:\/|$)/.test(url.pathname)
        || /\.(?:css|js|mjs|map|json|ico|png|jpe?g|gif|webp|svg|woff2?|ttf|txt|webmanifest)$/i.test(url.pathname);
      const allowedApi = url.pathname === '/api/status'
        && !url.search
        && !websocket
        && ['GET', 'HEAD'].includes((request.method ?? 'GET').toUpperCase());
      if (!allowedApi && !websocket && !allowedPage) return false;
      if (websocket) return false;
    }
    return true;
  }

  private pruneLeases(): void {
    const now = this.now();
    for (const [id, lease] of this.leases) if (lease.expiresAt <= now) this.leases.delete(id);
  }
}
