import { randomBytes } from 'node:crypto';
import {
  createServer,
  request as requestHttp,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse
} from 'node:http';
import type { Socket } from 'node:net';
import { Transform, type Duplex, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type {
  DshBrowserReadScopeDecision,
  DshBrowserRpcClaim,
  DshBrowserSessionScope,
  DshBrowserWriteGuard
} from './dshSessionWriteCoordinator.js';
import { DSH_BROWSER_SESSION_WRITE_METHODS } from './dshSessionWriteCoordinator.js';

const GATEWAY_HOST = '127.0.0.1' as const;
const SESSION_COOKIE = '__opc_dsh_desktop';
const BOOTSTRAP_QUERY = '__opc_dsh_bootstrap';
const STORAGE_BOOTSTRAP_QUERY = '__opc_dsh_storage_bootstrap';
const DEFAULT_BOOTSTRAP_TTL_MS = 60_000;
const DEFAULT_IDLE_TTL_MS = 30 * 60_000;
const DEFAULT_ABSOLUTE_TTL_MS = 8 * 60 * 60_000;
const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;
const MAX_RPC_ID_LENGTH = 200;
const MAX_RPC_BODY_BYTES = 8 * 1024 * 1024;
const MAX_SCOPED_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_SSE_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_SCOPED_WS_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_SCOPED_WS_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_SERVER_REQUESTS = 1_024;

const SCOPED_READ_RPC_METHODS = new Set([
  'session.list',
  'session.search',
  'session.history',
  'session.models',
  'session.attachment',
  'subagent.list',
  'subagent.history',
  'workspace.list'
]);

const SCOPED_SESSION_READ_FIELDS: Record<string, string[]> = {
  'session.history': ['sessionId'],
  'session.models': ['sessionId'],
  'session.attachment': ['sessionId'],
  'subagent.list': ['parentSessionId'],
  'subagent.history': ['parentSessionId', 'childSessionId']
};

const HTTP_HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

export type DshWebGatewayState = 'stopped' | 'starting' | 'running' | 'error';

export interface DshWebGatewayStatus {
  state: DshWebGatewayState;
  running: boolean;
  host: typeof GATEWAY_HOST;
  port: number | null;
  authority: string | null;
  origin: string | null;
  activeDesktopSessions: number;
  lastError: string | null;
}

export interface DshDesktopSession {
  id: string;
  url: string;
  expiresAt: number;
}

export type DshUpstreamResolver = () => string | URL | null;

/** Build the same-origin inert page used before the official DSH app loads. */
export function createDshStorageBootstrapUrl(desktopSessionUrl: string): string {
  const url = new URL(desktopSessionUrl);
  if (url.protocol !== 'http:' || url.pathname !== '/' || !url.searchParams.has(BOOTSTRAP_QUERY)) {
    throw new Error('DSH desktop bootstrap URL is invalid');
  }
  url.searchParams.set(STORAGE_BOOTSTRAP_QUERY, '1');
  return url.href;
}

export interface DshWebGatewayOptions {
  resolveUpstream?: DshUpstreamResolver;
  /** Agent owning the currently bound managed runtime. */
  resolveWriteAgentId?: () => string | null;
  /** Main-process admission gate for projected DSH session writes. */
  writeGuard?: DshBrowserWriteGuard;
  bootstrapTtlMs?: number;
  sessionIdleTtlMs?: number;
  sessionAbsoluteTtlMs?: number;
  now?: () => number;
}

interface DesktopSessionRecord {
  id: string;
  bootstrapToken: string | null;
  cookieToken: string;
  bootstrapExpiresAt: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  /** Main-only authorization boundary; never serialized into URL/cookie data. */
  scope: DshBrowserSessionScope | null;
  /** Trusted Main-side projection learned from scoped rc.6 responses. */
  allowedUpstreamSessionIds: Set<string>;
  parentByUpstreamSessionId: Map<string, string>;
  allowedWorkspaceIds: Set<string>;
  allowedResponseRpcIds: Set<string>;
}

interface RequestContext {
  path: string;
  session: DesktopSessionRecord;
}

type JsonObject = Record<string, unknown>;

interface ScopedReadRpc {
  method: string;
  rpcId: string;
  payload: JsonObject;
  agentId: string;
}

class ScopedReadError extends Error {
  constructor(readonly status: 400 | 403 | 503, message: string) {
    super(message);
  }
}

function jsonObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function safeWireId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 500
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function parseRpcRequest(value: unknown, expectedMethod: string): { rpcId: string; payload: JsonObject } {
  const envelope = jsonObject(value);
  const payload = jsonObject(envelope?.payload);
  if (envelope?.type !== 'client-request'
    || envelope.method !== expectedMethod
    || typeof envelope.rpcId !== 'string'
    || envelope.rpcId.length < 1
    || envelope.rpcId.length > MAX_RPC_ID_LENGTH
    || /[\u0000-\u001f\u007f]/.test(envelope.rpcId)
    || !payload) {
    throw new ScopedReadError(400, 'DSH scoped read RPC envelope is invalid');
  }
  return { rpcId: envelope.rpcId, payload };
}

function parseClientResponse(value: unknown): string {
  const envelope = jsonObject(value);
  const result = jsonObject(envelope?.result);
  if (envelope?.type !== 'client-response'
    || typeof envelope.rpcId !== 'string'
    || envelope.rpcId.length < 1
    || envelope.rpcId.length > MAX_RPC_ID_LENGTH
    || /[\u0000-\u001f\u007f]/.test(envelope.rpcId)
    || !result
    || typeof result.ok !== 'boolean') {
    throw new ScopedReadError(400, 'DSH scoped client response envelope is invalid');
  }
  return envelope.rpcId;
}

class ScopedSseTransform extends Transform {
  private readonly decoder = new StringDecoder('utf8');
  private buffered = '';

  constructor(private readonly filterFrame: (value: unknown) => JsonObject | null) {
    super();
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.buffered += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
      this.drainFrames();
      if (Buffer.byteLength(this.buffered, 'utf8') > MAX_SSE_FRAME_BYTES) {
        throw new Error('DSH SSE frame is too large');
      }
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.buffered += this.decoder.end();
      this.drainFrames();
      // A partial final frame is deliberately dropped; it was never a complete
      // rc.6 server-request and must not cross the scoped boundary.
      this.buffered = '';
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private drainFrames(): void {
    while (true) {
      const boundary = /\r?\n\r?\n/.exec(this.buffered);
      if (!boundary || boundary.index === undefined) return;
      const raw = this.buffered.slice(0, boundary.index);
      this.buffered = this.buffered.slice(boundary.index + boundary[0].length);
      if (Buffer.byteLength(raw, 'utf8') > MAX_SSE_FRAME_BYTES) {
        throw new Error('DSH SSE frame is too large');
      }
      const data = raw.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('');
      if (!data) continue;
      try {
        const filtered = this.filterFrame(JSON.parse(data) as unknown);
        if (filtered) this.push(`data: ${JSON.stringify(filtered)}\n\n`);
      } catch {
        // Malformed or unowned frames are isolated to this event. The rc.6
        // client already treats missing frames as a reconnect/refetch signal.
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isLoopbackSocketAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().split('%', 1)[0];
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  if (normalized.startsWith('::ffff:')) return normalized.slice(7).startsWith('127.');
  return normalized.startsWith('127.');
}

/** DSH Web is never allowed to escape its loopback runtime boundary. */
export function normalizeDshUpstreamEndpoint(value: string | URL): URL {
  const endpoint = value instanceof URL ? new URL(value.href) : new URL(value);
  if (endpoint.protocol !== 'http:' || endpoint.username || endpoint.password) {
    throw new Error('DSH Web endpoint must be unauthenticated loopback HTTP');
  }
  if (endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== '[::1]') {
    throw new Error('DSH Web endpoint must use a literal loopback address');
  }
  if (!endpoint.port || Number(endpoint.port) < 1 || Number(endpoint.port) > 65535) {
    throw new Error('DSH Web endpoint must include a valid port');
  }
  if (endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('DSH Web endpoint must use the origin root');
  }
  return endpoint;
}

function countRawHeader(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    if (request.rawHeaders[i]?.toLowerCase() === name) count += 1;
  }
  return count;
}

function readSingleCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  let value: string | null = null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    if (value !== null) return null;
    value = part.slice(separator + 1).trim();
  }
  return value;
}

function removeCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const retained = header.split(';').map((part) => part.trim()).filter((part) => {
    const separator = part.indexOf('=');
    return separator < 0 || part.slice(0, separator).trim() !== name;
  });
  return retained.length > 0 ? retained.join('; ') : undefined;
}

function proxyRequestHeaders(headers: IncomingHttpHeaders, websocket: boolean): OutgoingHttpHeaders {
  const output: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    const requiredForUpgrade = websocket && (lower === 'connection' || lower === 'upgrade');
    if ((HTTP_HOP_BY_HOP_HEADERS.has(lower) && !requiredForUpgrade) || lower.startsWith('x-forwarded-')) continue;
    if (lower === 'cookie') {
      const cookie = removeCookie(typeof value === 'string' ? value : undefined, SESSION_COOKIE);
      if (cookie) output[name] = cookie;
      continue;
    }
    if (value !== undefined) output[name] = value;
  }
  return output;
}

function scopedWebSocketRequestHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const output = proxyRequestHeaders(headers, false);
  for (const name of [
    'host',
    'sec-websocket-key',
    'sec-websocket-version',
    'sec-websocket-extensions',
    'sec-websocket-protocol'
  ]) delete output[name];
  return output;
}

function webSocketDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function responseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const output: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HTTP_HOP_BY_HOP_HEADERS.has(lower) || value === undefined) continue;
    if (lower === 'set-cookie') {
      const cookies = (Array.isArray(value) ? value : [value]).filter((cookie) => {
        const cookieName = cookie.slice(0, cookie.indexOf('=')).trim();
        return cookieName !== SESSION_COOKIE;
      });
      if (cookies.length > 0) output[name] = cookies;
      continue;
    }
    output[name] = value;
  }
  return output;
}

function rawUpgradeResponse(response: IncomingMessage): string {
  const statusMessage = (response.statusMessage || '').replace(/[\r\n]/g, ' ');
  const lines = [`HTTP/${response.httpVersion} ${response.statusCode ?? 502} ${statusMessage}`];
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    const name = response.rawHeaders[i];
    const value = response.rawHeaders[i + 1];
    if (!name || value === undefined) continue;
    if (name.toLowerCase() === 'set-cookie' && value.trimStart().startsWith(`${SESSION_COOKIE}=`)) continue;
    lines.push(`${name}: ${value}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => {
    try { server.close(() => resolve()); } catch { resolve(); }
  });
}

/**
 * Loopback-only reverse proxy for the official DSH Web UI.
 *
 * The public URL keeps DSH at `/`: the one-time query is consumed before any
 * upstream request, so static assets, RPC and WebSocket paths need no rewriting.
 */
export class DshWebGateway {
  private readonly now: () => number;
  private readonly bootstrapTtlMs: number;
  private readonly sessionIdleTtlMs: number;
  private readonly sessionAbsoluteTtlMs: number;
  private resolveUpstream: DshUpstreamResolver;
  private resolveWriteAgentId: () => string | null;
  private writeGuard: DshBrowserWriteGuard | null;
  private server: ReturnType<typeof createServer> | null = null;
  private startPromise: Promise<DshWebGatewayStatus> | null = null;
  private state: DshWebGatewayState = 'stopped';
  private port: number | null = null;
  private lastError: string | null = null;
  private sockets = new Set<Socket>();
  private readonly scopedWebSockets = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_SCOPED_WS_PAYLOAD_BYTES
  });
  private readonly upgradeSocketsBySession = new Map<string, Set<Duplex>>();
  private sessionsById = new Map<string, DesktopSessionRecord>();
  private bootstrapIndex = new Map<string, string>();
  private cookieIndex = new Map<string, string>();

  constructor(options: DshWebGatewayOptions = {}) {
    this.resolveUpstream = options.resolveUpstream ?? (() => null);
    this.resolveWriteAgentId = options.resolveWriteAgentId ?? (() => null);
    this.writeGuard = options.writeGuard ?? null;
    this.now = options.now ?? Date.now;
    this.bootstrapTtlMs = this.validTtl(options.bootstrapTtlMs, DEFAULT_BOOTSTRAP_TTL_MS);
    this.sessionIdleTtlMs = this.validTtl(options.sessionIdleTtlMs, DEFAULT_IDLE_TTL_MS);
    this.sessionAbsoluteTtlMs = this.validTtl(options.sessionAbsoluteTtlMs, DEFAULT_ABSOLUTE_TTL_MS);
  }

  private validTtl(value: number | undefined, fallback: number): number {
    return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value!) : fallback;
  }

  setUpstreamResolver(resolver: DshUpstreamResolver): void {
    this.resolveUpstream = resolver;
  }

  /** Bind/unbind the Main-side write policy when the active employee changes. */
  setWriteGuard(guard: DshBrowserWriteGuard | null, resolveAgentId?: () => string | null): void {
    this.writeGuard = guard;
    if (resolveAgentId) this.resolveWriteAgentId = resolveAgentId;
  }

  getStatus(): DshWebGatewayStatus {
    this.pruneExpiredSessions();
    const authority = this.port === null ? null : `${GATEWAY_HOST}:${this.port}`;
    return {
      state: this.state,
      running: this.state === 'running' && !!this.server?.listening,
      host: GATEWAY_HOST,
      port: this.port,
      authority,
      origin: authority ? `http://${authority}` : null,
      activeDesktopSessions: this.sessionsById.size,
      lastError: this.lastError
    };
  }

  async start(): Promise<DshWebGatewayStatus> {
    if (this.state === 'running' && this.server?.listening) return this.getStatus();
    if (this.startPromise) return this.startPromise;

    this.state = 'starting';
    this.lastError = null;
    const server = createServer((request, response) => {
      void this.handleHttpRequest(request, response).catch((error) => {
        this.lastError = errorMessage(error);
        if (!response.headersSent) this.reply(response, 502, 'DSH Web Gateway proxy failure');
        else response.destroy(error instanceof Error ? error : undefined);
      });
    });
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    server.on('upgrade', (request, socket, head) => {
      void this.handleUpgrade(request, socket, head).catch((error) => {
        this.lastError = errorMessage(error);
        this.rejectSocket(socket, 502, 'Bad Gateway');
      });
    });
    server.on('clientError', (_error, socket) => this.rejectSocket(socket, 400, 'Bad Request'));

    let startPromise!: Promise<DshWebGatewayStatus>;
    startPromise = new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(0, GATEWAY_HOST, () => {
        server.off('error', onError);
        resolve();
      });
    }).then(() => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('DSH Web Gateway did not receive a TCP port');
      this.server = server;
      this.port = address.port;
      this.state = 'running';
      server.on('error', (error) => this.failClosed(server, error));
      server.once('close', () => {
        if (this.server === server) this.failClosed(server, new Error('DSH Web Gateway listener closed unexpectedly'));
      });
      return this.getStatus();
    }).catch(async (error) => {
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      await closeServer(server);
      this.server = null;
      this.port = null;
      this.state = 'error';
      this.lastError = errorMessage(error);
      throw error;
    }).finally(() => {
      if (this.startPromise === startPromise) this.startPromise = null;
    });
    this.startPromise = startPromise;
    return startPromise;
  }

  async stop(): Promise<void> {
    const pending = this.startPromise;
    if (pending) {
      try { await pending; } catch { /* failed starts are already closed */ }
    }
    const server = this.server;
    this.server = null;
    this.port = null;
    this.state = 'stopped';
    for (const session of this.sessionsById.values()) this.revokeWriteLease(session.id);
    this.sessionsById.clear();
    this.bootstrapIndex.clear();
    this.cookieIndex.clear();
    for (const webSocket of this.scopedWebSockets.clients) webSocket.terminate();
    this.upgradeSocketsBySession.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await closeServer(server);
  }

  createDesktopSession(scope: DshBrowserSessionScope | null = null): DshDesktopSession {
    const status = this.getStatus();
    if (!status.running || !status.origin) throw new Error('DSH Web Gateway is not running');
    const safeScope = this.validateBrowserScope(scope);
    const now = this.now();
    const id = randomBytes(16).toString('base64url');
    const bootstrapToken = randomBytes(32).toString('base64url');
    const cookieToken = randomBytes(32).toString('base64url');
    const record: DesktopSessionRecord = {
      id,
      bootstrapToken,
      cookieToken,
      bootstrapExpiresAt: now + this.bootstrapTtlMs,
      idleExpiresAt: now + this.sessionIdleTtlMs,
      absoluteExpiresAt: now + this.sessionAbsoluteTtlMs,
      scope: safeScope,
      allowedUpstreamSessionIds: new Set(safeScope ? [safeScope.rootUpstreamSessionId] : []),
      parentByUpstreamSessionId: new Map(),
      allowedWorkspaceIds: new Set(),
      allowedResponseRpcIds: new Set()
    };
    this.sessionsById.set(id, record);
    this.bootstrapIndex.set(bootstrapToken, id);
    this.cookieIndex.set(cookieToken, id);
    const url = new URL('/', status.origin);
    url.searchParams.set(BOOTSTRAP_QUERY, bootstrapToken);
    return { id, url: url.href, expiresAt: record.bootstrapExpiresAt };
  }

  revokeDesktopSession(id: string): boolean {
    const record = this.sessionsById.get(id);
    if (!record) return false;
    this.removeSession(record);
    return true;
  }

  isGatewayUrl(value: string): boolean {
    const origin = this.getStatus().origin;
    if (!origin || !value || value !== value.trim()) return false;
    try {
      const url = new URL(value);
      return !url.username && !url.password && url.origin === origin;
    } catch {
      return false;
    }
  }

  private pruneExpiredSessions(): void {
    const now = this.now();
    for (const record of this.sessionsById.values()) {
      const bootstrapExpired = record.bootstrapToken !== null && record.bootstrapExpiresAt <= now;
      const sessionExpired = record.idleExpiresAt <= now || record.absoluteExpiresAt <= now;
      if (bootstrapExpired || sessionExpired) this.removeSession(record);
    }
  }

  private removeSession(record: DesktopSessionRecord): void {
    this.sessionsById.delete(record.id);
    if (record.bootstrapToken) this.bootstrapIndex.delete(record.bootstrapToken);
    this.cookieIndex.delete(record.cookieToken);
    const upgradeSockets = this.upgradeSocketsBySession.get(record.id);
    this.upgradeSocketsBySession.delete(record.id);
    for (const socket of upgradeSockets ?? []) socket.destroy();
    this.revokeWriteLease(record.id);
  }

  private requestPath(request: IncomingMessage): string | null {
    const origin = this.getStatus().origin;
    const raw = request.url;
    if (!origin || !raw || !raw.startsWith('/')) return null;
    try {
      const url = new URL(raw, origin);
      if (url.origin !== origin) return null;
      return `${url.pathname}${url.search}`;
    } catch {
      return null;
    }
  }

  private hasTrustedAuthority(request: IncomingMessage, requireOrigin: boolean): boolean {
    const status = this.getStatus();
    if (!status.authority || !status.origin || !isLoopbackSocketAddress(request.socket.remoteAddress)) return false;
    if (countRawHeader(request, 'host') !== 1 || request.headers.host !== status.authority) return false;
    const originCount = countRawHeader(request, 'origin');
    if (originCount > 1) return false;
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== status.origin) return false;
    return !requireOrigin || origin === status.origin;
  }

  private authorize(request: IncomingMessage, websocket: boolean): RequestContext | null {
    this.pruneExpiredSessions();
    const method = (request.method ?? 'GET').toUpperCase();
    if (!this.hasTrustedAuthority(request, websocket || (method !== 'GET' && method !== 'HEAD'))) return null;
    const path = this.requestPath(request);
    if (!path) return null;
    const token = readSingleCookie(request.headers.cookie, SESSION_COOKIE);
    if (!token) return null;
    const id = this.cookieIndex.get(token);
    const session = id ? this.sessionsById.get(id) : undefined;
    if (!session || session.cookieToken !== token) return null;
    const now = this.now();
    session.idleExpiresAt = Math.min(now + this.sessionIdleTtlMs, session.absoluteExpiresAt);
    return { path, session };
  }

  private consumeBootstrap(request: IncomingMessage, response: ServerResponse): boolean {
    if (!this.hasTrustedAuthority(request, false) || request.method !== 'GET') return false;
    const origin = this.getStatus().origin;
    if (!origin || !request.url) return false;
    let url: URL;
    try { url = new URL(request.url, origin); } catch { return false; }
    const tokens = url.searchParams.getAll(BOOTSTRAP_QUERY);
    const storageStages = url.searchParams.getAll(STORAGE_BOOTSTRAP_QUERY);
    if (url.origin !== origin || url.pathname !== '/' || tokens.length !== 1
      || storageStages.length > 1
      || (storageStages.length === 1 && storageStages[0] !== '1')) return false;
    const id = this.bootstrapIndex.get(tokens[0]!);
    const session = id ? this.sessionsById.get(id) : undefined;
    if (!session || session.bootstrapToken !== tokens[0] || session.bootstrapExpiresAt <= this.now()) return false;

    this.bootstrapIndex.delete(session.bootstrapToken);
    session.bootstrapToken = null;
    url.searchParams.delete(BOOTSTRAP_QUERY);
    const cookie = `${SESSION_COOKIE}=${session.cookieToken}; HttpOnly; SameSite=Strict; Path=/`;
    if (storageStages.length === 1) {
      const body = '<!doctype html><meta charset="utf-8"><title>DSH Workbench bootstrap</title>';
      response.writeHead(200, {
        'set-cookie': cookie,
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'",
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff'
      });
      response.end(body);
      return true;
    }
    response.writeHead(303, {
      location: `${url.pathname}${url.search}${url.hash}`,
      'set-cookie': cookie,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff'
    });
    response.end();
    return true;
  }

  private upstreamEndpoint(): URL {
    const endpoint = this.resolveUpstream();
    if (!endpoint) throw new Error('DSH runtime Web endpoint is unavailable');
    return normalizeDshUpstreamEndpoint(endpoint);
  }

  private upstreamTarget(path: string): URL {
    return new URL(path, this.upstreamEndpoint());
  }

  private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('cache-control', 'no-store');
    if (request.url?.includes(`${BOOTSTRAP_QUERY}=`)) {
      if (this.consumeBootstrap(request, response)) return;
      this.reply(response, 401, 'Invalid or expired DSH desktop session');
      return;
    }
    const context = this.authorize(request, false);
    if (!context) {
      this.reply(response, 401, 'A valid DSH desktop session is required');
      return;
    }
    const pathname = context.path.split('?', 1)[0]!;
    if (context.session.scope && pathname === '/api/session.export'
      && (request.method === 'GET' || request.method === 'HEAD')) {
      this.reply(response, 403, 'DSH scoped session export is unavailable');
      return;
    }
    const method = rpcMethodFromPath(context.path);
    const guarded = request.method === 'POST' && method !== null && DSH_BROWSER_SESSION_WRITE_METHODS.has(method);
    const scopedRead = request.method === 'POST' && context.session.scope !== null
      && method !== null && SCOPED_READ_RPC_METHODS.has(method);
    const scopedRespond = context.session.scope !== null && request.method === 'POST'
      && pathname === '/api/respond';
    const scopedEventStream = context.session.scope !== null && request.method === 'GET'
      && (pathname === '/api/events.mux' || pathname === '/api/events.host');
    let body: Buffer | undefined;
    let claim: DshBrowserRpcClaim | null = null;
    let readRpc: ScopedReadRpc | null = null;
    let responseRpcId: string | null = null;
    let eventAgentId: string | null = null;
    if (guarded || scopedRead || scopedRespond) {
      try {
        body = await this.readBody(request, MAX_RPC_BODY_BYTES);
      } catch {
        this.reply(response, 400, 'DSH RPC request body is invalid');
        return;
      }
    }
    if (guarded) {
      if (!this.writeGuard) {
        this.reply(response, 503, 'DSH write control is unavailable');
        return;
      }
      try {
        const payload = parseJsonBody(request, body!);
        const agentId = this.resolveWriteAgentId();
        if (!agentId) {
          this.reply(response, 503, 'DSH runtime binding is unavailable');
          return;
        }
        claim = this.writeGuard.claim({
          clientSessionId: context.session.id,
          agentId,
          method,
          payload,
          scope: context.session.scope
        });
      } catch (error) {
        this.reply(response, isWriteAdmissionError(error) ? 409 : 400, 'DSH write admission denied');
        return;
      }
    }
    if (scopedRead) {
      try {
        const agentId = this.scopedAgentId();
        const envelope = parseRpcRequest(parseJsonBody(request, body!), method!);
        readRpc = { method: method!, rpcId: envelope.rpcId, payload: envelope.payload, agentId };
        this.admitScopedRead(context.session, readRpc);
      } catch (error) {
        const status = error instanceof ScopedReadError ? error.status : 400;
        this.reply(response, status, status === 503
          ? 'DSH scoped read control is unavailable'
          : status === 403 ? 'DSH scoped read denied' : 'DSH scoped read request is invalid');
        return;
      }
    }
    if (scopedRespond) {
      try {
        const agentId = this.scopedAgentId();
        this.assertScopedRoot(context.session, agentId);
        responseRpcId = parseClientResponse(parseJsonBody(request, body!));
        if (!context.session.allowedResponseRpcIds.has(responseRpcId)) {
          throw new ScopedReadError(403, 'DSH scoped response does not belong to this project stream');
        }
      } catch (error) {
        const status = error instanceof ScopedReadError ? error.status : 400;
        this.reply(response, status, status === 503
          ? 'DSH scoped response control is unavailable'
          : status === 403 ? 'DSH scoped response denied' : 'DSH scoped response is invalid');
        return;
      }
    }
    if (scopedEventStream) {
      try {
        eventAgentId = this.scopedAgentId();
        this.assertScopedRoot(context.session, eventAgentId);
      } catch {
        this.reply(response, 503, 'DSH scoped event control is unavailable');
        return;
      }
    }
    const target = this.upstreamTarget(context.path);
    const headers = proxyRequestHeaders(request.headers, false);
    if (context.session.scope && (scopedRead || scopedEventStream)) {
      headers['accept-encoding'] = 'identity';
    }
    await new Promise<void>((resolve) => {
      const proxy = requestHttp(target, { method: request.method, headers }, (upstream) => {
        if (readRpc) {
          void this.forwardScopedReadResponse(context.session, readRpc, upstream, response)
            .catch((error) => {
              this.lastError = errorMessage(error);
              if (!response.headersSent) this.reply(response, 502, 'DSH scoped read response is invalid');
              else response.destroy(error instanceof Error ? error : undefined);
            })
            .finally(resolve);
          return;
        }
        if (scopedEventStream && eventAgentId) {
          void this.forwardScopedEventStream(
            context.session,
            eventAgentId,
            pathname as '/api/events.mux' | '/api/events.host',
            upstream,
            response
          ).catch((error) => {
            this.lastError = errorMessage(error);
            if (!response.headersSent) this.reply(response, 502, 'DSH scoped event stream is invalid');
            else response.destroy(error instanceof Error ? error : undefined);
          }).finally(resolve);
          return;
        }
        const headersOut = responseHeaders(upstream.headers);
        const location = upstream.headers.location;
        if (location) headersOut.location = this.rewriteLocation(location, target.origin);
        const statusCode = upstream.statusCode ?? 502;
        response.writeHead(statusCode, upstream.statusMessage, headersOut);
        upstream.pipe(response);
        upstream.once('end', () => {
          this.finishWriteClaim(claim, statusCode);
          if (responseRpcId && statusCode >= 200 && statusCode < 300) {
            context.session.allowedResponseRpcIds.delete(responseRpcId);
          }
          resolve();
        });
        upstream.once('error', (error) => {
          // The request may already have reached DSH. Keep the durable receipt
          // ACCEPTED until reconciliation proves an explicit outcome.
          response.destroy(error);
          resolve();
        });
      });
      this.guardUpstreamConnection(proxy, () => {
        // Connection/transport failures are ambiguous once a write has been
        // admitted. Never convert an unknown side effect into FAILED.
        if (!response.headersSent) this.reply(response, 502, 'DSH runtime is unavailable');
        else response.destroy();
        resolve();
      });
      request.once('aborted', () => proxy.destroy());
      if (body !== undefined) proxy.end(body);
      else request.pipe(proxy);
    });
  }

  private scopedAgentId(): string {
    if (!this.writeGuard?.checkReadScope) {
      throw new ScopedReadError(503, 'DSH scoped read guard is unavailable');
    }
    const agentId = this.resolveWriteAgentId();
    if (!agentId) throw new ScopedReadError(503, 'DSH runtime binding is unavailable');
    return agentId;
  }

  private readDecision(
    session: DesktopSessionRecord,
    agentId: string,
    upstreamSessionId: string
  ): DshBrowserReadScopeDecision {
    if (!session.scope || !this.writeGuard?.checkReadScope) return 'unavailable';
    return this.writeGuard.checkReadScope({ agentId, scope: session.scope, upstreamSessionId });
  }

  private assertScopedRoot(session: DesktopSessionRecord, agentId: string): void {
    const root = session.scope?.rootUpstreamSessionId;
    if (!root || this.readDecision(session, agentId, root) !== 'allowed') {
      throw new ScopedReadError(503, 'DSH scoped project root is unavailable');
    }
  }

  private assertScopedSession(session: DesktopSessionRecord, agentId: string, upstreamSessionId: unknown): string {
    if (!safeWireId(upstreamSessionId)) {
      throw new ScopedReadError(400, 'DSH scoped read session id is invalid');
    }
    this.assertScopedRoot(session, agentId);
    if (session.allowedUpstreamSessionIds.has(upstreamSessionId)) return upstreamSessionId;
    const decision = this.readDecision(session, agentId, upstreamSessionId);
    if (decision !== 'allowed') {
      throw new ScopedReadError(decision === 'unavailable' ? 503 : 403, 'DSH scoped read crossed the project boundary');
    }
    session.allowedUpstreamSessionIds.add(upstreamSessionId);
    return upstreamSessionId;
  }

  private admitScopedRead(session: DesktopSessionRecord, rpc: ScopedReadRpc): void {
    this.assertScopedRoot(session, rpc.agentId);
    for (const field of SCOPED_SESSION_READ_FIELDS[rpc.method] ?? []) {
      this.assertScopedSession(session, rpc.agentId, rpc.payload[field]);
    }
  }

  private async forwardScopedReadResponse(
    session: DesktopSessionRecord,
    rpc: ScopedReadRpc,
    upstream: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const encoding = upstream.headers['content-encoding'];
    if (encoding && String(encoding).toLowerCase() !== 'identity') {
      upstream.resume();
      throw new Error('encoded DSH scoped responses are not accepted');
    }
    const body = await this.readBody(upstream, MAX_SCOPED_RESPONSE_BYTES);
    const statusCode = upstream.statusCode ?? 502;
    let output = body;
    if (statusCode >= 200 && statusCode < 300) {
      const contentType = upstream.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
      if (contentType !== 'application/json' && !contentType?.endsWith('+json')) {
        throw new Error('DSH scoped response must be JSON');
      }
      let parsed: unknown;
      try { parsed = JSON.parse(body.toString('utf8')) as unknown; }
      catch { throw new Error('DSH scoped response JSON is invalid'); }
      output = Buffer.from(JSON.stringify(this.filterScopedRpcResponse(session, rpc, parsed)), 'utf8');
    }

    const headersOut = responseHeaders(upstream.headers);
    delete headersOut['content-length'];
    delete headersOut['content-encoding'];
    headersOut['content-length'] = output.length;
    const location = upstream.headers.location;
    if (location) headersOut.location = this.rewriteLocation(location, this.upstreamEndpoint().origin);
    response.writeHead(statusCode, upstream.statusMessage, headersOut);
    response.end(output);
  }

  private filterScopedRpcResponse(session: DesktopSessionRecord, rpc: ScopedReadRpc, value: unknown): JsonObject {
    const envelope = jsonObject(value);
    const result = jsonObject(envelope?.result);
    if (envelope?.type !== 'server-response' || envelope.rpcId !== rpc.rpcId
      || !result || typeof result.ok !== 'boolean') {
      throw new Error('DSH scoped response envelope is invalid');
    }
    if (result.ok === false) return envelope;
    const responseValue = jsonObject(result.value);
    if (!responseValue) throw new Error('DSH scoped response value is invalid');

    let filtered: JsonObject;
    switch (rpc.method) {
      case 'session.list':
        filtered = this.filterSessionList(session, rpc.agentId, responseValue);
        break;
      case 'session.search':
        filtered = this.filterSessionSearch(session, rpc.agentId, responseValue);
        break;
      case 'subagent.list':
        filtered = this.filterSubagentList(session, rpc, responseValue);
        break;
      case 'workspace.list':
        filtered = this.filterWorkspaceList(session, rpc.agentId, responseValue);
        break;
      default:
        filtered = responseValue;
    }
    return { ...envelope, result: { ...result, value: filtered } };
  }

  private filterSessionList(session: DesktopSessionRecord, agentId: string, value: JsonObject): JsonObject {
    if (!Array.isArray(value.items)) throw new Error('DSH session.list items are invalid');
    const rows = value.items.map((item) => {
      const row = jsonObject(item);
      if (!row || !safeWireId(row.sessionId)
        || (row.parentSessionId !== undefined && !safeWireId(row.parentSessionId))) {
        throw new Error('DSH session.list row is invalid');
      }
      return row;
    });
    const root = session.scope!.rootUpstreamSessionId;
    const candidates = new Map(rows.map((row) => [row.sessionId as string, row]));
    const allowed = new Set<string>();
    if (candidates.has(root)) allowed.add(root);

    for (let pass = 0; pass < rows.length && allowed.size < rows.length; pass += 1) {
      let changed = false;
      for (const row of rows) {
        const id = row.sessionId as string;
        const parent = row.parentSessionId;
        if (allowed.has(id) || !safeWireId(parent) || !allowed.has(parent)) continue;
        const decision = this.readDecision(session, agentId, id);
        if (decision === 'denied' || decision === 'unavailable') continue;
        allowed.add(id);
        session.parentByUpstreamSessionId.set(id, parent);
        changed = true;
      }
      if (!changed) break;
    }
    for (const id of allowed) session.allowedUpstreamSessionIds.add(id);
    return { ...value, items: rows.filter((row) => allowed.has(row.sessionId as string)) };
  }

  private responseSessionAllowed(session: DesktopSessionRecord, agentId: string, id: unknown): id is string {
    if (!safeWireId(id)) return false;
    if (session.allowedUpstreamSessionIds.has(id)) return true;
    if (this.readDecision(session, agentId, id) !== 'allowed') return false;
    session.allowedUpstreamSessionIds.add(id);
    return true;
  }

  private filterSessionSearch(session: DesktopSessionRecord, agentId: string, value: JsonObject): JsonObject {
    if (!Array.isArray(value.items)) throw new Error('DSH session.search items are invalid');
    const items = value.items.filter((item) => {
      const row = jsonObject(item);
      return !!row && this.responseSessionAllowed(session, agentId, row.sessionId);
    });
    return { ...value, items, hasMore: false };
  }

  private filterSubagentList(session: DesktopSessionRecord, rpc: ScopedReadRpc, value: JsonObject): JsonObject {
    if (!Array.isArray(value.entries)) throw new Error('DSH subagent.list entries are invalid');
    const parent = rpc.payload.parentSessionId;
    if (!safeWireId(parent)) throw new Error('DSH subagent.list parent is invalid');
    const entries = value.entries.filter((entry) => {
      const row = jsonObject(entry);
      if (!row || !safeWireId(row.id)) return false;
      const decision = this.readDecision(session, rpc.agentId, row.id);
      if (decision === 'denied' || decision === 'unavailable') return false;
      session.allowedUpstreamSessionIds.add(row.id);
      session.parentByUpstreamSessionId.set(row.id, parent);
      return true;
    });
    return { ...value, entries };
  }

  private filterWorkspaceList(session: DesktopSessionRecord, agentId: string, value: JsonObject): JsonObject {
    if (!Array.isArray(value.items) || !Array.isArray(value.archivedSessionIds)) {
      throw new Error('DSH workspace.list value is invalid');
    }
    const nextWorkspaceIds = new Set<string>();
    const items: JsonObject[] = [];
    for (const item of value.items) {
      const workspace = jsonObject(item);
      if (!workspace || !safeWireId(workspace.workspaceId) || !Array.isArray(workspace.sessionIds)) {
        throw new Error('DSH workspace.list row is invalid');
      }
      const sessionIds = workspace.sessionIds.filter((id) => this.responseSessionAllowed(session, agentId, id));
      if (sessionIds.length === 0) continue;
      nextWorkspaceIds.add(workspace.workspaceId);
      items.push({ ...workspace, sessionIds });
    }
    session.allowedWorkspaceIds = nextWorkspaceIds;
    const archivedSessionIds = value.archivedSessionIds.filter((id) => (
      this.responseSessionAllowed(session, agentId, id)
    ));
    return { ...value, items, archivedSessionIds };
  }

  private async forwardScopedEventStream(
    session: DesktopSessionRecord,
    agentId: string,
    path: '/api/events.mux' | '/api/events.host',
    upstream: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const statusCode = upstream.statusCode ?? 502;
    const encoding = upstream.headers['content-encoding'];
    const contentType = upstream.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    if (statusCode < 200 || statusCode >= 300 || (encoding && String(encoding).toLowerCase() !== 'identity')
      || contentType !== 'text/event-stream') {
      upstream.resume();
      throw new Error('DSH scoped event stream response is invalid');
    }
    const headersOut = responseHeaders(upstream.headers);
    delete headersOut['content-length'];
    delete headersOut['content-encoding'];
    headersOut['cache-control'] = 'no-store';
    response.writeHead(statusCode, upstream.statusMessage, headersOut);
    response.flushHeaders();
    response.write(': opc-scoped-stream\n\n');
    const filter = new ScopedSseTransform((value) => this.filterScopedEventEnvelope(session, agentId, path, value));
    await pipeline(upstream, filter, response);
  }

  private filterScopedEventEnvelope(
    session: DesktopSessionRecord,
    agentId: string,
    path: '/api/events.mux' | '/api/events.host',
    value: unknown
  ): JsonObject | null {
    const envelope = jsonObject(value);
    const payload = jsonObject(envelope?.payload);
    if (envelope?.type !== 'server-request'
      || typeof envelope.rpcId !== 'string'
      || envelope.rpcId.length < 1
      || envelope.rpcId.length > MAX_RPC_ID_LENGTH
      || /[\u0000-\u001f\u007f]/.test(envelope.rpcId)
      || !payload || typeof payload.type !== 'string' || envelope.method !== payload.type) return null;
    const filtered = path === '/api/events.mux'
      ? this.filterMuxFrame(session, agentId, payload)
      : this.filterHostFrame(session, agentId, payload);
    if (filtered && (filtered.type === 'approval/requested' || filtered.type === 'question/requested')) {
      this.rememberResponseRpcId(session, envelope.rpcId);
    }
    return filtered ? { ...envelope, payload: filtered } : null;
  }

  private rememberResponseRpcId(session: DesktopSessionRecord, rpcId: string): void {
    session.allowedResponseRpcIds.add(rpcId);
    while (session.allowedResponseRpcIds.size > MAX_PENDING_SERVER_REQUESTS) {
      const oldest = session.allowedResponseRpcIds.values().next().value as string | undefined;
      if (!oldest) break;
      session.allowedResponseRpcIds.delete(oldest);
    }
  }

  private filterMuxFrame(session: DesktopSessionRecord, agentId: string, frame: JsonObject): JsonObject | null {
    const allowedTypes = new Set([
      'session/event',
      'session/subscribed',
      'approval/requested',
      'approval/resolved',
      'question/requested',
      'question/resolved',
      'session/queue',
      'session/jobs',
      'session/projection'
    ]);
    if (typeof frame.type !== 'string' || !allowedTypes.has(frame.type)) return null;
    return this.responseSessionAllowed(session, agentId, frame.sessionId) ? frame : null;
  }

  private filterHostFrame(session: DesktopSessionRecord, agentId: string, frame: JsonObject): JsonObject | null {
    switch (frame.type) {
      case 'host/session-added': {
        if (!safeWireId(frame.sessionId)) return null;
        const parent = frame.parentSessionId;
        if (frame.sessionId === session.scope!.rootUpstreamSessionId) return frame;
        if (!safeWireId(parent) || !session.allowedUpstreamSessionIds.has(parent)) return null;
        const decision = this.readDecision(session, agentId, frame.sessionId);
        if (decision === 'denied' || decision === 'unavailable') return null;
        session.allowedUpstreamSessionIds.add(frame.sessionId);
        session.parentByUpstreamSessionId.set(frame.sessionId, parent);
        return frame;
      }
      case 'host/session-removed':
      case 'host/session-status':
      case 'host/agent-error':
        return this.responseSessionAllowed(session, agentId, frame.sessionId) ? frame : null;
      case 'host/workspace-changed': {
        const workspace = jsonObject(frame.workspace);
        if (!workspace || !safeWireId(workspace.workspaceId) || !Array.isArray(workspace.sessionIds)) return null;
        const sessionIds = workspace.sessionIds.filter((id) => this.responseSessionAllowed(session, agentId, id));
        if (sessionIds.length === 0) return null;
        session.allowedWorkspaceIds.add(workspace.workspaceId);
        return { ...frame, workspace: { ...workspace, sessionIds } };
      }
      case 'host/workspace-removed':
        if (!safeWireId(frame.workspaceId) || !session.allowedWorkspaceIds.has(frame.workspaceId)) return null;
        session.allowedWorkspaceIds.delete(frame.workspaceId);
        return frame;
      case 'host/workspace-order-changed': {
        if (!Array.isArray(frame.workspaceIds)) return null;
        const workspaceIds = frame.workspaceIds.filter((id) => safeWireId(id) && session.allowedWorkspaceIds.has(id));
        return { ...frame, workspaceIds };
      }
      case 'host/archived-sessions-changed': {
        if (!Array.isArray(frame.archivedSessionIds)) return null;
        const archivedSessionIds = frame.archivedSessionIds.filter((id) => (
          this.responseSessionAllowed(session, agentId, id)
        ));
        return { ...frame, archivedSessionIds };
      }
      default:
        // stream/error and host/remote-event have no auditable project owner.
        return null;
    }
  }

  private async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const context = this.authorize(request, true);
    if (!context || request.method !== 'GET') {
      this.rejectSocket(socket, 401, 'Unauthorized');
      return;
    }
    if (context.session.scope) {
      const pathname = context.path.split('?', 1)[0];
      if ((pathname !== '/api/events.mux' && pathname !== '/api/events.host')
        || request.headers['sec-websocket-protocol'] !== undefined) {
        this.rejectSocket(socket, 400, 'Unsupported Scoped WebSocket');
        return;
      }
      let agentId: string;
      try {
        agentId = this.scopedAgentId();
        this.assertScopedRoot(context.session, agentId);
      } catch {
        this.rejectSocket(socket, 503, 'Scoped Event Control Unavailable');
        return;
      }
      this.trackUpgradeSocket(context.session.id, socket);
      this.openScopedWebSocket(
        request,
        socket,
        head,
        context.session,
        agentId,
        pathname
      );
      return;
    }
    this.trackUpgradeSocket(context.session.id, socket);
    const target = this.upstreamTarget(context.path);
    const proxy = requestHttp(target, {
      method: 'GET',
      headers: proxyRequestHeaders(request.headers, true)
    });
    proxy.once('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      socket.write(rawUpgradeResponse(upstreamResponse));
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      socket.once('close', () => upstreamSocket.destroy());
      socket.once('error', () => upstreamSocket.destroy());
      upstreamSocket.once('close', () => socket.destroy());
      upstreamSocket.once('error', () => socket.destroy());
      socket.pipe(upstreamSocket);
      upstreamSocket.pipe(socket);
    });
    proxy.once('response', (upstreamResponse) => {
      upstreamResponse.resume();
      const status = upstreamResponse.statusCode && upstreamResponse.statusCode >= 400
        ? upstreamResponse.statusCode
        : 502;
      this.rejectSocket(socket, status, 'WebSocket Upgrade Rejected');
    });
    this.guardUpstreamConnection(proxy, () => this.rejectSocket(socket, 502, 'Bad Gateway'));
    proxy.end();
  }

  private openScopedWebSocket(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    session: DesktopSessionRecord,
    agentId: string,
    path: '/api/events.mux' | '/api/events.host'
  ): void {
    try {
      this.scopedWebSockets.handleUpgrade(request, socket, head, (client) => {
        this.scopedWebSockets.emit('connection', client, request);
        this.bridgeScopedWebSocket(client, session, agentId, path, request.headers);
      });
    } catch (error) {
      this.lastError = errorMessage(error);
      this.rejectSocket(socket, 400, 'WebSocket Upgrade Rejected');
    }
  }

  private bridgeScopedWebSocket(
    client: WebSocket,
    session: DesktopSessionRecord,
    agentId: string,
    path: '/api/events.mux' | '/api/events.host',
    requestHeaders: IncomingHttpHeaders
  ): void {
    const target = this.upstreamTarget(path);
    target.protocol = 'ws:';
    const upstream = new WebSocket(target, {
      headers: scopedWebSocketRequestHeaders(requestHeaders),
      perMessageDeflate: false,
      maxPayload: MAX_SCOPED_WS_PAYLOAD_BYTES,
      handshakeTimeout: UPSTREAM_CONNECT_TIMEOUT_MS
    });
    let closed = false;
    const expiryDelay = Math.max(
      1,
      Math.min(session.idleExpiresAt, session.absoluteExpiresAt) - this.now()
    );
    const expiryTimer = setTimeout(() => closePair(1008), expiryDelay);
    expiryTimer.unref?.();

    const closePair = (clientCode = 1011): void => {
      if (closed) return;
      closed = true;
      clearTimeout(expiryTimer);
      if (client.readyState === WebSocket.OPEN) client.close(clientCode, 'DSH event stream closed');
      else if (client.readyState === WebSocket.CONNECTING) client.terminate();
      if (upstream.readyState === WebSocket.OPEN) upstream.close(1000);
      else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
    };

    client.on('message', () => closePair(1008));
    client.once('close', () => closePair(1000));
    client.once('error', () => closePair());
    upstream.once('error', (error) => {
      this.lastError = errorMessage(error);
      closePair();
    });
    upstream.once('close', (code) => closePair(code === 1000 ? 1000 : 1011));
    upstream.on('message', (data, isBinary) => {
      if (closed || isBinary) return;
      const encoded = webSocketDataBuffer(data);
      if (encoded.length > MAX_SCOPED_WS_PAYLOAD_BYTES) {
        closePair(1009);
        return;
      }
      let value: unknown;
      try { value = JSON.parse(encoded.toString('utf8')) as unknown; }
      catch { return; }

      let filtered: JsonObject | null;
      try {
        this.assertScopedRoot(session, agentId);
        filtered = this.filterScopedEventEnvelope(session, agentId, path, value);
      } catch (error) {
        this.lastError = errorMessage(error);
        closePair();
        return;
      }
      if (!filtered || client.readyState !== WebSocket.OPEN) return;
      const output = JSON.stringify(filtered);
      if (Buffer.byteLength(output, 'utf8') > MAX_SCOPED_WS_PAYLOAD_BYTES
        || client.bufferedAmount > MAX_SCOPED_WS_BUFFERED_BYTES) {
        closePair(1009);
        return;
      }
      client.send(output, { binary: false }, (error) => {
        if (error) closePair();
      });
    });
  }

  private trackUpgradeSocket(sessionId: string, socket: Duplex): void {
    const sockets = this.upgradeSocketsBySession.get(sessionId) ?? new Set<Duplex>();
    sockets.add(socket);
    this.upgradeSocketsBySession.set(sessionId, sockets);
    socket.once('close', () => {
      sockets.delete(socket);
      if (sockets.size === 0) this.upgradeSocketsBySession.delete(sessionId);
    });
  }

  private guardUpstreamConnection(
    request: ReturnType<typeof requestHttp>,
    onFailure: (error: Error) => void
  ): void {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      this.lastError = error.message;
      onFailure(error);
    };
    request.once('socket', (socket) => {
      if (socket.connecting) {
        socket.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS, () => request.destroy(new Error('DSH runtime connection timed out')));
        socket.once('connect', () => socket.setTimeout(0));
      }
    });
    request.once('response', () => { settled = true; });
    request.once('upgrade', () => { settled = true; });
    request.once('error', fail);
  }

  private rewriteLocation(value: string, upstreamOrigin: string): string {
    const publicOrigin = this.getStatus().origin;
    if (!publicOrigin) return value;
    try {
      const location = new URL(value, upstreamOrigin);
      if (location.origin !== upstreamOrigin) return value;
      return `${publicOrigin}${location.pathname}${location.search}${location.hash}`;
    } catch {
      return value;
    }
  }

  private failClosed(server: ReturnType<typeof createServer>, error: Error): void {
    if (this.server !== server) return;
    this.server = null;
    this.port = null;
    this.state = 'error';
    this.lastError = error.message;
    for (const session of this.sessionsById.values()) this.revokeWriteLease(session.id);
    this.sessionsById.clear();
    this.bootstrapIndex.clear();
    this.cookieIndex.clear();
    for (const webSocket of this.scopedWebSockets.clients) webSocket.terminate();
    this.upgradeSocketsBySession.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    void closeServer(server);
  }

  private reply(response: ServerResponse, status: number, message: string): void {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    response.end(message);
  }

  private rejectSocket(socket: Duplex, status: number, message: string): void {
    if (socket.destroyed) return;
    try { socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
    catch { socket.destroy(); }
  }

  private finishWriteClaim(claim: DshBrowserRpcClaim | null, statusCode: number): void {
    if (!claim || !this.writeGuard) return;
    try {
      if (statusCode >= 200 && statusCode < 400) {
        this.writeGuard.completeClaim(claim, { forwarded: true, statusCode });
      } else {
        this.writeGuard.failClaim(claim, `DSH upstream returned HTTP ${statusCode}`);
      }
    } catch {
      // The durable receipt is deliberately fail-closed; a late completion
      // cannot be allowed to break the user's proxy response.
    }
  }

  private revokeWriteLease(sessionId: string): void {
    try { this.writeGuard?.releaseClient(sessionId); } catch { /* best effort */ }
  }

  private validateBrowserScope(scope: DshBrowserSessionScope | null): DshBrowserSessionScope | null {
    if (scope === null) return null;
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)
      || typeof scope.rootUpstreamSessionId !== 'string'
      || scope.rootUpstreamSessionId.length < 1
      || scope.rootUpstreamSessionId.length > 500
      || /[\u0000-\u001f\u007f]/.test(scope.rootUpstreamSessionId)) {
      throw new Error('DSH desktop session scope is invalid');
    }
    return { rootUpstreamSessionId: scope.rootUpstreamSessionId };
  }

  private readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
    const contentLength = request.headers['content-length'];
    if (contentLength !== undefined) {
      const parsed = Number(contentLength);
      if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('invalid content length');
      if (parsed > limit) {
        request.resume();
        throw new Error('request body too large');
      }
    }
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      request.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > limit) {
          settled = true;
          request.resume();
          reject(new Error('request body too large'));
          return;
        }
        chunks.push(buffer);
      });
      request.once('end', () => {
        if (!settled) { settled = true; resolve(Buffer.concat(chunks, bytes)); }
      });
      request.once('aborted', () => {
        if (!settled) { settled = true; reject(new Error('request aborted')); }
      });
      request.once('error', (error) => {
        if (!settled) { settled = true; reject(error); }
      });
    });
  }
}

function rpcMethodFromPath(path: string): string | null {
  const pathname = path.split('?', 1)[0];
  if (!pathname.startsWith('/api/')) return null;
  const method = pathname.slice('/api/'.length);
  return method && !method.includes('/') && /^[A-Za-z0-9._~-]+$/.test(method) ? method : null;
}

function parseJsonBody(request: IncomingMessage, body: Buffer): unknown {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json' && !contentType?.endsWith('+json')) throw new Error('JSON body required');
  try { return JSON.parse(body.toString('utf8')) as unknown; }
  catch { throw new Error('invalid JSON'); }
}

function isWriteAdmissionError(error: unknown): boolean {
  return error instanceof Error && /lease|revision|command|controlled|admission/i.test(error.message);
}
