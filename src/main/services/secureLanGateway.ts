import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
  X509Certificate
} from 'node:crypto';
import {
  request as requestHttp,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse
} from 'node:http';
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
  type ServerOptions as HttpsServerOptions
} from 'node:https';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

export function normalizeSecureLanUpstreamEndpoint(value: string | URL): URL {
  const endpoint = value instanceof URL ? new URL(value.href) : new URL(value);
  if (endpoint.protocol !== 'http:' || endpoint.username || endpoint.password) {
    throw new Error('Upstream endpoint must be unauthenticated loopback HTTP');
  }
  if (endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== '[::1]') {
    throw new Error('Upstream endpoint must use a literal loopback address');
  }
  if (!endpoint.port || Number(endpoint.port) < 1 || Number(endpoint.port) > 65535) {
    throw new Error('Upstream endpoint must include a valid port');
  }
  if (endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('Upstream endpoint must use the origin root');
  }
  return endpoint;
}

const DEFAULT_SESSION_COOKIE = '__Host-opc_secure_lan';
const DEFAULT_CSRF_COOKIE = '__Host-opc_secure_csrf';
const CSRF_HEADER = 'x-opc-csrf';
const PAIRING_PAGE_PATH = '/pair';
const PAIR_PATH = '/api/v1/auth/pair';
const LOGOUT_PATH = '/api/v1/auth/logout';
const DEFAULT_PAIRING_TTL_MS = 5 * 60_000;
const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60_000;
const DEFAULT_SESSION_ABSOLUTE_TTL_MS = 8 * 60 * 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_WEBSOCKET_PAYLOAD_BYTES = 1024 * 1024;

// RFC 6455 reserves 1004-1006 for endpoint internals. A peer reports 1006
// when the connection died without a close frame; forwarding that value into
// ws.close() throws in the Main process and can crash Electron.
function isWireCloseCode(code: number): boolean {
  return Number.isInteger(code)
    && code >= 1000
    && code <= 4999
    && code !== 1004
    && code !== 1005
    && code !== 1006;
}

function closeWebSocketSafely(socket: WebSocket, code: number, reason: string | Buffer): void {
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

const HOP_BY_HOP_HEADERS = new Set([
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

const WEBSOCKET_HANDSHAKE_HEADERS = new Set([
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version'
]);

const SENSITIVE_QUERY_NAMES = new Set([
  'access_token',
  'api_key',
  'apikey',
  'authorization',
  'code',
  'csrf',
  'key',
  'pairing_code',
  'secret',
  'token'
]);

export type SecureLanGatewayState = 'stopped' | 'starting' | 'running' | 'error';
export type SecureLanRole = 'viewer' | 'operator';
export type SecureLanRateBucket = 'read' | 'control' | 'prompt' | 'artifact' | 'stream';

export interface SecureLanTlsIdentity {
  key: HttpsServerOptions['key'];
  cert: HttpsServerOptions['cert'];
}

export interface SecureLanGatewayStartOptions {
  bindHost: string;
  port?: number;
  publicHost?: string;
  publicPort?: number;
  tls: SecureLanTlsIdentity;
}

export interface SecureLanPairingOffer {
  code: string;
  expiresAt: number;
  origin: string;
  pairingUrl: string;
  runtimeId: string;
  role: SecureLanRole;
  certificateFingerprint: string;
}

export interface SecureLanGatewayStatus {
  state: SecureLanGatewayState;
  enabled: boolean;
  running: boolean;
  bindHost: string | null;
  port: number | null;
  authority: string | null;
  origin: string | null;
  trustedAuthorities: readonly string[];
  runtimeId: string;
  activeSessions: number;
  activeRequests: number;
  activeWebSockets: number;
  certificateFingerprint: string | null;
  lastError: string | null;
}

export interface SecureLanRpcAuthorizationContext {
  runtimeId: string;
  sessionId: string;
  role: SecureLanRole;
  method: string;
  payload: unknown;
  /** Present for post-proxy callbacks; omitted during admission. */
  statusCode?: number;
}

export interface SecureLanRpcMethodPolicy {
  roles?: readonly SecureLanRole[];
  rateLimitBucket?: SecureLanRateBucket;
  authorize?: (context: SecureLanRpcAuthorizationContext) => boolean | Promise<boolean>;
  /** Called only after the upstream response body has fully arrived. */
  onForwarded?: (context: SecureLanRpcAuthorizationContext) => void | Promise<void>;
  /** Called when no upstream response was received, before the request is denied. */
  onForwardFailed?: (context: SecureLanRpcAuthorizationContext, error: unknown) => void | Promise<void>;
}

export interface SecureLanRpcPolicy {
  methods: Readonly<Record<string, SecureLanRpcMethodPolicy>>;
  extractMethods?: (payload: unknown) => readonly string[] | null;
}

export interface SecureLanHttpRoutePolicy {
  kind: 'web' | 'rpc' | 'artifact' | 'stream';
  runtimeId: string;
  methods: readonly string[];
  roles?: readonly SecureLanRole[];
  rateLimitBucket?: SecureLanRateBucket;
  maxBodyBytes?: number;
  rpc?: SecureLanRpcPolicy;
}

export interface SecureLanWebSocketRoutePolicy {
  kind: 'websocket';
  runtimeId: string;
  roles?: readonly SecureLanRole[];
  rateLimitBucket?: SecureLanRateBucket;
  allowedSubprotocols?: readonly string[];
  /** Omit to make the socket a server-to-browser downlink only. */
  clientRpc?: SecureLanRpcPolicy;
  /** Explicit operator terminal stream. Never enable this for viewer routes. */
  allowOpaqueClientMessages?: boolean;
}

export type SecureLanRoutePolicy = SecureLanHttpRoutePolicy | SecureLanWebSocketRoutePolicy;

export interface SecureLanRouteContext {
  runtimeId: string;
  method: string;
  pathname: string;
  search: string;
  websocket: boolean;
}

export type SecureLanPolicyResolver = (context: SecureLanRouteContext) => SecureLanRoutePolicy | null;
export type SecureLanUpstreamResolver = (runtimeId: string) => string | URL | null;
export type SecureLanUpstreamHeadersResolver = (
  runtimeId: string,
  websocket: boolean
) => Readonly<Record<string, string>> | null;

export interface SecureLanAuditEvent {
  timestamp: number;
  action:
    | 'gateway.start'
    | 'gateway.stop'
    | 'pairing.create'
    | 'auth.pair'
    | 'auth.logout'
    | 'proxy.http'
    | 'proxy.websocket'
    | 'proxy.rpc'
    | 'request.denied'
    | 'proxy.error';
  result: 'ok' | 'denied' | 'error';
  runtimeId: string;
  remoteAddress?: string;
  pairingId?: string;
  sessionId?: string;
  role?: SecureLanRole;
  method?: string;
  pathname?: string;
  rpcMethod?: string;
  reason?: string;
}

export interface SecureLanWindowLimit {
  max: number;
  windowMs: number;
}

export interface SecureLanGatewayLimits {
  pair: SecureLanWindowLimit;
  read: SecureLanWindowLimit;
  control: SecureLanWindowLimit;
  prompt: SecureLanWindowLimit;
  artifact: SecureLanWindowLimit;
  stream: SecureLanWindowLimit;
  maxSessions: number;
  maxPairingOffers: number;
  maxConcurrentRequests: number;
  maxConcurrentRequestsPerSession: number;
  maxWebSockets: number;
  maxWebSocketsPerSession: number;
  maxBodyBytes: number;
  maxWebSocketPayloadBytes: number;
}

export interface SecureLanGatewayOptions {
  runtimeId: string;
  resolveUpstream: SecureLanUpstreamResolver;
  resolvePolicy: SecureLanPolicyResolver;
  /** Main-only credentials added after all browser-controlled headers are sanitized. */
  resolveUpstreamHeaders?: SecureLanUpstreamHeadersResolver;
  /** Narrow exception for non-secret compatibility tokens required by a pinned upstream UI. */
  allowedSensitiveQueryNames?: readonly string[];
  audit?: (event: SecureLanAuditEvent) => void;
  /** Optional Main-owned trace sink. It must redact secrets before persisting. */
  trace?: (event: { phase: string; method?: string; pathname?: string; detail?: string }) => void;
  /** Main-process cleanup hook for capabilities associated with a paired browser. */
  onSessionRevoked?: (sessionId: string) => void;
  /** Browser destination after pairing. Defaults to the upstream root. */
  pairingRedirectPath?: string;
  /**
   * Cookie names are configurable so independent products sharing this audited
   * transport cannot accidentally reuse each other's browser authority.
   */
  sessionCookieName?: string;
  csrfCookieName?: string;
  now?: () => number;
  pairingTtlMs?: number;
  sessionIdleTtlMs?: number;
  sessionAbsoluteTtlMs?: number;
  connectTimeoutMs?: number;
  limits?: Partial<SecureLanGatewayLimits>;
}

interface PairingRecord {
  id: string;
  salt: Buffer;
  digest: Buffer;
  role: SecureLanRole;
  expiresAt: number;
}

interface SessionRecord {
  id: string;
  cookieDigest: string;
  csrfDigest: string;
  runtimeId: string;
  role: SecureLanRole;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  activeRequests: number;
  webSockets: Set<WebSocket>;
}

interface AuthorizedRequest {
  session: SessionRecord;
  url: URL;
  remoteAddress: string;
}

interface RateRecord {
  timestamps: number[];
  touchedAt: number;
}

class GatewayHttpError extends Error {
  constructor(readonly status: number, readonly reason: string, message = reason) {
    super(message);
  }
}

class RequestBodyTooLargeError extends GatewayHttpError {
  constructor() {
    super(413, 'body_too_large', 'Request body exceeds the configured limit');
  }
}

const DEFAULT_LIMITS: SecureLanGatewayLimits = {
  pair: { max: 5, windowMs: 60_000 },
  read: { max: 240, windowMs: 60_000 },
  control: { max: 60, windowMs: 60_000 },
  prompt: { max: 20, windowMs: 60_000 },
  artifact: { max: 60, windowMs: 60_000 },
  stream: { max: 10, windowMs: 60_000 },
  maxSessions: 64,
  maxPairingOffers: 16,
  maxConcurrentRequests: 32,
  maxConcurrentRequestsPerSession: 8,
  maxWebSockets: 32,
  maxWebSocketsPerSession: 4,
  maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
  maxWebSocketPayloadBytes: DEFAULT_MAX_WEBSOCKET_PAYLOAD_BYTES
};

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

function positiveTtl(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

function mergeLimits(value: Partial<SecureLanGatewayLimits> | undefined): SecureLanGatewayLimits {
  const windowLimit = (input: SecureLanWindowLimit | undefined, fallback: SecureLanWindowLimit): SecureLanWindowLimit => ({
    max: positiveInteger(input?.max, fallback.max),
    windowMs: positiveTtl(input?.windowMs, fallback.windowMs)
  });
  return {
    pair: windowLimit(value?.pair, DEFAULT_LIMITS.pair),
    read: windowLimit(value?.read, DEFAULT_LIMITS.read),
    control: windowLimit(value?.control, DEFAULT_LIMITS.control),
    prompt: windowLimit(value?.prompt, DEFAULT_LIMITS.prompt),
    artifact: windowLimit(value?.artifact, DEFAULT_LIMITS.artifact),
    stream: windowLimit(value?.stream, DEFAULT_LIMITS.stream),
    maxSessions: positiveInteger(value?.maxSessions, DEFAULT_LIMITS.maxSessions),
    maxPairingOffers: positiveInteger(value?.maxPairingOffers, DEFAULT_LIMITS.maxPairingOffers),
    maxConcurrentRequests: positiveInteger(value?.maxConcurrentRequests, DEFAULT_LIMITS.maxConcurrentRequests),
    maxConcurrentRequestsPerSession: positiveInteger(
      value?.maxConcurrentRequestsPerSession,
      DEFAULT_LIMITS.maxConcurrentRequestsPerSession
    ),
    maxWebSockets: positiveInteger(value?.maxWebSockets, DEFAULT_LIMITS.maxWebSockets),
    maxWebSocketsPerSession: positiveInteger(value?.maxWebSocketsPerSession, DEFAULT_LIMITS.maxWebSocketsPerSession),
    maxBodyBytes: positiveInteger(value?.maxBodyBytes, DEFAULT_LIMITS.maxBodyBytes),
    maxWebSocketPayloadBytes: positiveInteger(
      value?.maxWebSocketPayloadBytes,
      DEFAULT_LIMITS.maxWebSocketPayloadBytes
    )
  };
}

function secretDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function pairingDigest(salt: Buffer, code: string): Buffer {
  return createHash('sha256').update(salt).update(code, 'utf8').digest();
}

function safeBufferEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function countRawHeader(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count;
}

function readSingleCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  let found: string | null = null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    if (found !== null) return null;
    found = part.slice(separator + 1).trim();
  }
  return found;
}

function removeCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const retained = header.split(';').map((part) => part.trim()).filter((part) => {
    const separator = part.indexOf('=');
    return separator < 0 || part.slice(0, separator).trim() !== name;
  });
  return retained.length > 0 ? retained.join('; ') : undefined;
}

function cookieName(value: string, label: string): string {
  if (!/^__Host-[A-Za-z0-9_-]{1,96}$/.test(value)) {
    throw new Error(`Invalid LAN gateway ${label}`);
  }
  return value;
}

function normalizeRemoteAddress(value: string | undefined): string {
  if (!value) return '';
  const withoutZone = value.toLowerCase().split('%', 1)[0]!;
  return withoutZone.startsWith('::ffff:') ? withoutZone.slice(7) : withoutZone;
}

/** LAN listeners and clients are restricted to literal private or loopback addresses. */
export function isPrivateSecureLanAddress(value: string): boolean {
  const address = normalizeRemoteAddress(value);
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 127
      || a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168);
  }
  if (isIP(address) === 6) {
    if (address === '::1' || address === '0:0:0:0:0:0:0:1') return true;
    const first = Number.parseInt(address.split(':', 1)[0] ?? '', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

function publicEndpoint(host: string, port: number): { authority: string; origin: string } {
  if (!host || host !== host.trim() || /[\s/@?#]/.test(host)) throw new Error('Invalid Secure LAN public host');
  const hostPart = isIP(host) === 6 ? `[${host}]` : host;
  const url = new URL(`https://${hostPart}:${port}/`);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Invalid Secure LAN public authority');
  }
  return { authority: url.host, origin: url.origin };
}

function proxyRequestHeaders(
  headers: IncomingHttpHeaders,
  websocket: boolean,
  sessionCookieName: string,
  csrfCookieName: string
): OutgoingHttpHeaders {
  const output: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)
      || lower === 'authorization'
      || lower === 'forwarded'
      || lower === 'x-real-ip'
      || lower.startsWith('x-forwarded-')
      || lower.startsWith('x-opc-')) continue;
    if (websocket && WEBSOCKET_HANDSHAKE_HEADERS.has(lower)) continue;
    if (lower === 'cookie') {
      const withoutSession = removeCookie(typeof value === 'string' ? value : undefined, sessionCookieName);
      const cookie = removeCookie(withoutSession, csrfCookieName);
      if (cookie) output[name] = cookie;
      continue;
    }
    if (lower === 'content-length') continue;
    if (value !== undefined) output[name] = value;
  }
  return output;
}

function proxyResponseHeaders(
  headers: IncomingHttpHeaders,
  sessionCookieName: string,
  csrfCookieName: string
): OutgoingHttpHeaders {
  const output: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || value === undefined) continue;
    if (lower === 'set-cookie') {
      const cookies = (Array.isArray(value) ? value : [value]).filter((cookie) => {
        const separator = cookie.indexOf('=');
        const name = separator < 0 ? '' : cookie.slice(0, separator).trim();
        return name !== sessionCookieName && name !== csrfCookieName;
      });
      if (cookies.length > 0) output[name] = cookies;
      continue;
    }
    output[name] = value;
  }
  output['x-content-type-options'] = 'nosniff';
  output['referrer-policy'] = 'no-referrer';
  return output;
}

function defaultExtractRpcMethods(payload: unknown): readonly string[] | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const method = (payload as Record<string, unknown>).method;
  return typeof method === 'string' && method.length > 0 ? [method] : null;
}

function closeServer(server: HttpsServer): Promise<void> {
  return new Promise((resolve) => {
    try { server.close(() => resolve()); } catch { resolve(); }
  });
}

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

/**
 * Authenticated TLS edge for one project runtime.
 *
 * The class intentionally has no default route policy and never starts itself.
 * Its caller must declare every HTTP/RPC/WebSocket contract explicitly.
 */
export class SecureLanGateway {
  private readonly runtimeId: string;
  private readonly resolveUpstream: SecureLanUpstreamResolver;
  private readonly resolvePolicy: SecureLanPolicyResolver;
  private readonly resolveUpstreamHeaders?: SecureLanUpstreamHeadersResolver;
  private readonly allowedSensitiveQueryNames: ReadonlySet<string>;
  private readonly auditSink?: (event: SecureLanAuditEvent) => void;
  private readonly traceSink?: SecureLanGatewayOptions['trace'];
  private readonly onSessionRevoked?: (sessionId: string) => void;
  private readonly pairingRedirectPath: string;
  private readonly sessionCookieName: string;
  private readonly csrfCookieName: string;
  private readonly now: () => number;
  private readonly pairingTtlMs: number;
  private readonly sessionIdleTtlMs: number;
  private readonly sessionAbsoluteTtlMs: number;
  private readonly connectTimeoutMs: number;
  private readonly limits: SecureLanGatewayLimits;
  private state: SecureLanGatewayState = 'stopped';
  private enabled = false;
  private server: HttpsServer | null = null;
  private webSocketServer: WebSocketServer | null = null;
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private bindHost: string | null = null;
  private port: number | null = null;
  private authority: string | null = null;
  private origin: string | null = null;
  private certificateFingerprint: string | null = null;
  private lastError: string | null = null;
  private pairings = new Map<string, PairingRecord>();
  private sessions = new Map<string, SessionRecord>();
  private sockets = new Set<Duplex>();
  private upstreamWebSockets = new Set<WebSocket>();
  private rateRecords = new Map<string, RateRecord>();
  private activeRequests = 0;

  constructor(options: SecureLanGatewayOptions) {
    if (!options.runtimeId || options.runtimeId !== options.runtimeId.trim()) {
      throw new Error('Secure LAN Gateway requires a stable runtime id');
    }
    this.runtimeId = options.runtimeId;
    this.resolveUpstream = options.resolveUpstream;
    this.resolvePolicy = options.resolvePolicy;
    this.resolveUpstreamHeaders = options.resolveUpstreamHeaders;
    this.allowedSensitiveQueryNames = new Set((options.allowedSensitiveQueryNames ?? []).map((name) => {
      const normalized = name.trim().toLowerCase();
      if (!SENSITIVE_QUERY_NAMES.has(normalized)) throw new Error('Invalid Secure LAN sensitive query exception');
      return normalized;
    }));
    this.auditSink = options.audit;
    this.traceSink = options.trace;
    this.onSessionRevoked = options.onSessionRevoked;
    const pairingRedirectPath = options.pairingRedirectPath ?? '/';
    if (!/^\/(?:[A-Za-z0-9._~-]+\/?)*$/.test(pairingRedirectPath)) {
      throw new Error('Invalid LAN pairing redirect path');
    }
    this.pairingRedirectPath = pairingRedirectPath;
    this.sessionCookieName = cookieName(options.sessionCookieName ?? DEFAULT_SESSION_COOKIE, 'sessionCookieName');
    this.csrfCookieName = cookieName(options.csrfCookieName ?? DEFAULT_CSRF_COOKIE, 'csrfCookieName');
    if (this.sessionCookieName === this.csrfCookieName) throw new Error('LAN gateway cookie names must be different');
    this.now = options.now ?? Date.now;
    this.pairingTtlMs = positiveTtl(options.pairingTtlMs, DEFAULT_PAIRING_TTL_MS);
    this.sessionIdleTtlMs = positiveTtl(options.sessionIdleTtlMs, DEFAULT_SESSION_IDLE_TTL_MS);
    this.sessionAbsoluteTtlMs = positiveTtl(options.sessionAbsoluteTtlMs, DEFAULT_SESSION_ABSOLUTE_TTL_MS);
    this.connectTimeoutMs = positiveTtl(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    this.limits = mergeLimits(options.limits);
  }

  getStatus(): SecureLanGatewayStatus {
    this.pruneEphemeral();
    return {
      state: this.state,
      enabled: this.enabled,
      running: this.state === 'running' && !!this.server?.listening,
      bindHost: this.bindHost,
      port: this.port,
      authority: this.authority,
      origin: this.origin,
      trustedAuthorities: this.authority ? [this.authority] : [],
      runtimeId: this.runtimeId,
      activeSessions: this.sessions.size,
      activeRequests: this.activeRequests,
      activeWebSockets: this.webSocketCount(),
      certificateFingerprint: this.certificateFingerprint,
      lastError: this.lastError
    };
  }

  async start(options: SecureLanGatewayStartOptions): Promise<SecureLanGatewayStatus> {
    if (this.getStatus().running) return this.getStatus();
    if (this.state === 'starting') throw new Error('Secure LAN Gateway is already starting');
    if (!isPrivateSecureLanAddress(options.bindHost)) {
      throw new Error('Secure LAN Gateway must bind to a literal private or loopback address');
    }
    const requestedPort = options.port ?? 0;
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
      throw new Error('Invalid Secure LAN Gateway port');
    }
    if (options.publicPort !== undefined
      && (!Number.isInteger(options.publicPort) || options.publicPort < 1 || options.publicPort > 65535)) {
      throw new Error('Invalid Secure LAN public port');
    }

    this.state = 'starting';
    this.enabled = true;
    this.lastError = null;
    let server: HttpsServer | null = null;
    let webSocketServer: WebSocketServer | null = null;
    try {
      const certPem = this.certificatePem(options.tls.cert);
      this.certificateFingerprint = this.spkiFingerprint(certPem);
      server = createHttpsServer(
        { key: options.tls.key, cert: options.tls.cert, minVersion: 'TLSv1.2' },
        (request, response) => {
          void this.handleHttpRequest(request, response).catch((error) => this.handleHttpFailure(request, response, error));
        }
      );
      webSocketServer = new WebSocketServer({
        noServer: true,
        maxPayload: this.limits.maxWebSocketPayloadBytes,
        handleProtocols: (protocols) => protocols.values().next().value ?? false
      });
      server.on('connection', (socket) => {
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
        // A mobile browser routinely resets a keep-alive TLS socket while
        // navigating or cancelling a request. Consume the socket error here;
        // it is not a gateway failure and must never escape Electron Main.
        socket.on('error', (error) => {
          if (!isBenignTransportError(error)) this.audit({ action: 'proxy.error', result: 'error', reason: 'client_socket_error' });
        });
      });
      server.on('upgrade', (request, socket, head) => {
        void this.handleUpgrade(request, socket, head).catch((error) => {
          this.recordProxyError(request, error);
          this.rejectUpgrade(socket, error instanceof GatewayHttpError ? error.status : 502);
        });
      });
      server.on('clientError', (error, socket) => {
        if (isBenignTransportError(error)) {
          if (!socket.destroyed) socket.destroy();
          return;
        }
        this.rejectUpgrade(socket, 400);
      });
      server.on('tlsClientError', (error, socket) => {
        if (!isBenignTransportError(error)) {
          this.audit({ action: 'proxy.error', result: 'error', reason: 'tls_client_error' });
        }
        if (!socket.destroyed) socket.destroy();
      });

      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server!.once('error', onError);
        server!.listen(requestedPort, options.bindHost, () => {
          server!.off('error', onError);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Secure LAN Gateway did not receive a TCP port');
      const advertisedHost = options.publicHost ?? options.bindHost;
      const endpoint = publicEndpoint(advertisedHost, options.publicPort ?? address.port);
      this.validateCertificateHost(certPem, advertisedHost);
      this.server = server;
      this.webSocketServer = webSocketServer;
      this.bindHost = options.bindHost;
      this.port = address.port;
      this.authority = endpoint.authority;
      this.origin = endpoint.origin;
      this.state = 'running';
      server.on('error', (error) => this.failClosed(error));
      server.once('close', () => {
        if (this.server === server) this.failClosed(new Error('Secure LAN Gateway listener closed unexpectedly'));
      });
      this.maintenanceTimer = setInterval(() => this.pruneEphemeral(), 30_000);
      this.maintenanceTimer.unref?.();
      this.audit({ action: 'gateway.start', result: 'ok' });
      return this.getStatus();
    } catch (error) {
      webSocketServer?.close();
      if (server) await closeServer(server);
      this.state = 'error';
      this.enabled = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.certificateFingerprint = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.webSocketServer?.close();
    this.webSocketServer = null;
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    this.revokeEverySession();
    this.pairings.clear();
    this.rateRecords.clear();
    for (const webSocket of this.upstreamWebSockets) webSocket.terminate();
    this.upstreamWebSockets.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.activeRequests = 0;
    this.state = 'stopped';
    this.enabled = false;
    this.bindHost = null;
    this.port = null;
    this.authority = null;
    this.origin = null;
    this.certificateFingerprint = null;
    this.lastError = null;
    if (server) await closeServer(server);
    this.audit({ action: 'gateway.stop', result: 'ok' });
  }

  createPairingOffer(role: SecureLanRole = 'operator'): SecureLanPairingOffer {
    const status = this.getStatus();
    if (!status.running || !status.origin || !status.certificateFingerprint) {
      throw new Error('Start Secure LAN Gateway before creating a pairing code');
    }
    if (role !== 'operator' && role !== 'viewer') throw new Error('Invalid Secure LAN role');
    this.pruneEphemeral();
    if (this.pairings.size >= this.limits.maxPairingOffers) throw new Error('Too many active Secure LAN pairing codes');
    const code = randomInt(10_000_000, 100_000_000).toString();
    const salt = randomBytes(16);
    const id = randomBytes(12).toString('base64url');
    const expiresAt = this.now() + this.pairingTtlMs;
    this.pairings.set(id, { id, salt, digest: pairingDigest(salt, code), role, expiresAt });
    this.audit({ action: 'pairing.create', result: 'ok', pairingId: id, role });
    return {
      code,
      expiresAt,
      origin: status.origin,
      pairingUrl: `${status.origin}${PAIRING_PAGE_PATH}`,
      runtimeId: this.runtimeId,
      role,
      certificateFingerprint: status.certificateFingerprint
    };
  }

  revokeSession(sessionId: string): boolean {
    const session = [...this.sessions.values()].find((candidate) => candidate.id === sessionId);
    if (!session) return false;
    this.removeSession(session);
    return true;
  }

  private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.setSecurityHeaders(response);
    const remoteAddress = this.validateAuthority(request);
    const url = this.parseRequestUrl(request);
    this.trace({ phase: 'http.enter', method: request.method, pathname: url.pathname });
    if (url.pathname === PAIRING_PAGE_PATH) {
      this.handlePairingPage(request, response, url);
      return;
    }
    if (url.pathname === PAIR_PATH) {
      await this.handlePair(request, response, url, remoteAddress);
      return;
    }

    const authorized = this.authorize(request, url, remoteAddress);
    this.trace({ phase: 'http.authorized', method: request.method, pathname: url.pathname, detail: `role=${authorized.session.role};active=${this.activeRequests};sessionActive=${authorized.session.activeRequests}` });
    if (url.pathname === LOGOUT_PATH) {
      await this.handleLogout(request, response, authorized);
      return;
    }
    const policy = this.policyFor(request, url, false);
    if (policy.kind === 'websocket') throw new GatewayHttpError(404, 'route_not_available_over_http');
    this.assertHttpPolicy(request, authorized, policy);
    this.acquireRequest(authorized.session);
    try {
      if (this.isMutating(request.method)) this.validateCsrf(request, authorized.session);
      const maxBodyBytes = Math.min(policy.maxBodyBytes ?? this.limits.maxBodyBytes, this.limits.maxBodyBytes);
      const body = await this.readBody(request, maxBodyBytes);
      this.trace({ phase: 'http.body.read', method: request.method, pathname: url.pathname, detail: `bytes=${body.length}` });
      let rpcMethods: readonly string[] = [];
      let rpcPayload: unknown;
      let bucket = policy.rateLimitBucket ?? this.defaultBucket(policy.kind);
      if (policy.kind === 'rpc') {
        if (!policy.rpc) throw new GatewayHttpError(403, 'rpc_contract_missing');
        rpcPayload = this.parseJsonBody(request, body);
        rpcMethods = this.inspectRpc(policy.rpc, rpcPayload, authorized.session);
        bucket = this.rpcBucket(policy.rpc, rpcMethods, bucket);
      }
      // Rate admission must happen before any method authorizer.  Authorizers
      // may claim a durable lease/receipt, which must never be left ACCEPTED
      // for a request that the edge later rejects as rate-limited.
      this.requireRate(bucket, authorized.session.id);
      if (policy.kind === 'rpc') {
        await this.authorizeRpc(policy.rpc!, rpcPayload, authorized.session, rpcMethods);
      }
      try {
        this.trace({ phase: 'http.proxy.start', method: request.method, pathname: url.pathname, detail: `active=${this.activeRequests};sessionActive=${authorized.session.activeRequests}` });
        const statusCode = await this.proxyHttp(request, response, authorized, body);
        this.trace({ phase: 'http.proxy.end', method: request.method, pathname: url.pathname, detail: `status=${statusCode}` });
        for (const rpcMethod of rpcMethods) {
          const methodPolicy = policy.rpc?.methods[rpcMethod];
          await methodPolicy?.onForwarded?.({
            runtimeId: this.runtimeId,
            sessionId: authorized.session.id,
            role: authorized.session.role,
            method: rpcMethod,
            payload: rpcPayload,
            statusCode
          });
        }
      } catch (error) {
        for (const rpcMethod of rpcMethods) {
          const methodPolicy = policy.rpc?.methods[rpcMethod];
          try {
            await methodPolicy?.onForwardFailed?.({
              runtimeId: this.runtimeId,
              sessionId: authorized.session.id,
              role: authorized.session.role,
              method: rpcMethod,
              payload: rpcPayload
            }, error);
          } catch { /* failure accounting must not mask the transport error */ }
        }
        throw error;
      }
      if (rpcMethods.length > 0) {
        for (const rpcMethod of rpcMethods) {
          this.audit({
            action: 'proxy.rpc', result: 'ok', remoteAddress, sessionId: authorized.session.id,
            role: authorized.session.role, method: request.method, pathname: url.pathname, rpcMethod
          });
        }
      } else {
        this.audit({
          action: 'proxy.http', result: 'ok', remoteAddress, sessionId: authorized.session.id,
          role: authorized.session.role, method: request.method, pathname: url.pathname
        });
      }
    } finally {
      this.releaseRequest(authorized.session);
      this.trace({ phase: 'http.release', method: request.method, pathname: url.pathname, detail: `active=${this.activeRequests};sessionActive=${authorized.session.activeRequests}` });
    }
  }

  private handlePairingPage(request: IncomingMessage, response: ServerResponse, url: URL): void {
    if ((request.method !== 'GET' && request.method !== 'HEAD') || url.search) {
      throw new GatewayHttpError(404, 'pairing_page_not_found');
    }
    const style = `:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: Canvas; color: CanvasText; }
main { width: min(28rem, calc(100% - 2rem)); }
h1 { margin: 0 0 .5rem; font-size: 1.5rem; }
p { margin: 0 0 1.25rem; color: GrayText; line-height: 1.5; }
label { display: grid; gap: .5rem; font-weight: 600; }
input, button { box-sizing: border-box; width: 100%; min-height: 2.75rem; padding: .65rem .8rem; font: inherit; }
input { border: 1px solid GrayText; border-radius: .35rem; background: Field; color: FieldText; }
button { margin-top: .75rem; border: 0; border-radius: .35rem; background: #1769aa; color: white; font-weight: 700; cursor: pointer; }`;
    const styleHash = createHash('sha256').update(style, 'utf8').digest('base64');
    const body = Buffer.from(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="same-origin">
  <title>连接 Hermes 对话</title>
  <style>${style}</style>
</head>
<body>
  <main>
    <h1>连接 Hermes 对话</h1>
    <p>输入电脑端当前项目显示的一次性验证码。</p>
    <form method="post" action="${PAIR_PATH}" enctype="application/x-www-form-urlencoded" autocomplete="off">
      <label>一次性验证码
        <input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{8}" minlength="8" maxlength="8" required autofocus>
      </label>
      <button type="submit">打开 Hermes 对话</button>
    </form>
  </main>
</body>
</html>`, 'utf8');
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': body.length,
      'content-security-policy': `default-src 'none'; script-src 'none'; style-src 'sha256-${styleHash}'; connect-src 'none'; img-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`,
      'cross-origin-opener-policy': 'same-origin',
      'referrer-policy': 'same-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      'x-frame-options': 'DENY'
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  }

  private async handlePair(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    remoteAddress: string
  ): Promise<void> {
    if (request.method !== 'POST' || url.search) throw new GatewayHttpError(404, 'pair_route_not_found');
    const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    const isBrowserForm = contentType === 'application/x-www-form-urlencoded';
    if (isBrowserForm) this.validatePairingFormOrigin(request);
    else this.validateSameOriginMutation(request);
    this.requireRate('pair', remoteAddress);
    const body = await this.readBody(request, 2048);
    let code: unknown = null;
    if (isBrowserForm) {
      const form = new URLSearchParams(body.toString('utf8'));
      const values = form.getAll('code');
      if (values.length === 1 && [...form.keys()].every((key) => key === 'code')) code = values[0];
    } else {
      const payload = this.parseJsonBody(request, body);
      code = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).code
        : null;
    }
    if (typeof code !== 'string' || !/^\d{8}$/.test(code)) {
      this.audit({ action: 'auth.pair', result: 'denied', remoteAddress, reason: 'invalid_pairing_code' });
      throw new GatewayHttpError(401, 'invalid_pairing_code');
    }
    const pairing = this.consumePairing(code);
    if (!pairing || this.sessions.size >= this.limits.maxSessions) {
      this.audit({
        action: 'auth.pair', result: 'denied', remoteAddress,
        reason: pairing ? 'session_limit' : 'invalid_pairing_code'
      });
      throw new GatewayHttpError(pairing ? 429 : 401, pairing ? 'session_limit' : 'invalid_pairing_code');
    }
    const now = this.now();
    const cookieToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const session: SessionRecord = {
      id: randomBytes(16).toString('base64url'),
      cookieDigest: secretDigest(cookieToken),
      csrfDigest: secretDigest(csrfToken),
      runtimeId: this.runtimeId,
      role: pairing.role,
      idleExpiresAt: now + this.sessionIdleTtlMs,
      absoluteExpiresAt: now + this.sessionAbsoluteTtlMs,
      activeRequests: 0,
      webSockets: new Set()
    };
    this.sessions.set(session.cookieDigest, session);
    const maxAge = Math.floor(this.sessionAbsoluteTtlMs / 1000);
    const cookies = [
      `${this.sessionCookieName}=${cookieToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`,
      `${this.csrfCookieName}=${csrfToken}; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`
    ];
    if (isBrowserForm) {
      response.writeHead(303, {
        location: this.pairingRedirectPath,
        'cache-control': 'no-store',
        'set-cookie': cookies
      });
      response.end();
    } else {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': cookies
      });
      response.end(JSON.stringify({
        csrfToken,
        expiresAt: session.absoluteExpiresAt,
        runtimeId: this.runtimeId,
        role: session.role
      }));
    }
    this.audit({
      action: 'auth.pair', result: 'ok', remoteAddress, pairingId: pairing.id,
      sessionId: session.id, role: session.role
    });
  }

  private async handleLogout(
    request: IncomingMessage,
    response: ServerResponse,
    authorized: AuthorizedRequest
  ): Promise<void> {
    if (request.method !== 'POST' || authorized.url.search) throw new GatewayHttpError(404, 'logout_route_not_found');
    this.validateCsrf(request, authorized.session);
    this.removeSession(authorized.session);
    response.writeHead(204, {
      'cache-control': 'no-store',
      'set-cookie': [
        `${this.sessionCookieName}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
        `${this.csrfCookieName}=; Secure; SameSite=Strict; Path=/; Max-Age=0`
      ]
    });
    response.end();
    this.audit({
      action: 'auth.logout', result: 'ok', remoteAddress: authorized.remoteAddress,
      sessionId: authorized.session.id, role: authorized.session.role
    });
  }

  private async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const remoteAddress = this.validateAuthority(request);
    const url = this.parseRequestUrl(request);
    const authorized = this.authorize(request, url, remoteAddress);
    if (request.method !== 'GET') throw new GatewayHttpError(405, 'websocket_method_denied');
    this.validateWebSocketOrigin(request);
    const policy = this.policyFor(request, url, true);
    if (policy.kind !== 'websocket') throw new GatewayHttpError(404, 'websocket_route_not_allowed');
    this.assertRole(authorized.session, policy.roles);
    if (this.webSocketCount() >= this.limits.maxWebSockets
      || authorized.session.webSockets.size >= this.limits.maxWebSocketsPerSession) {
      throw new GatewayHttpError(429, 'websocket_concurrency_limit');
    }
    this.requireRate(policy.rateLimitBucket ?? 'stream', authorized.session.id);
    const protocols = this.webSocketProtocols(request);
    const allowedProtocols = new Set(policy.allowedSubprotocols ?? []);
    if (protocols.some((protocol) => !allowedProtocols.has(protocol))) {
      throw new GatewayHttpError(403, 'websocket_subprotocol_denied');
    }
    const target = this.upstreamTarget(url);
    target.protocol = 'ws:';
    const webSocketServer = this.webSocketServer;
    if (!webSocketServer) throw new GatewayHttpError(503, 'gateway_not_running');

    await new Promise<void>((resolve) => {
      webSocketServer.handleUpgrade(request, socket, head, (downstream) => {
        authorized.session.webSockets.add(downstream);
        const headers = proxyRequestHeaders(request.headers, true, this.sessionCookieName, this.csrfCookieName);
        Object.assign(headers, this.upstreamHeaders(true));
        const upstream = new WebSocket(target, protocols, {
          headers,
          maxPayload: this.limits.maxWebSocketPayloadBytes,
          handshakeTimeout: this.connectTimeoutMs
        });
        this.upstreamWebSockets.add(upstream);
        let upstreamOpen = false;
        const cleanup = () => {
          authorized.session.webSockets.delete(downstream);
          this.upstreamWebSockets.delete(upstream);
        };
        const fail = (error: Error) => {
          cleanup();
          if (downstream.readyState === WebSocket.OPEN) downstream.close(1011, 'Upstream unavailable');
          else downstream.terminate();
          this.lastError = 'Secure LAN WebSocket upstream unavailable';
          this.audit({
            action: 'proxy.error', result: 'error', remoteAddress, sessionId: authorized.session.id,
            role: authorized.session.role, method: 'GET', pathname: url.pathname,
            reason: upstreamOpen ? 'websocket_upstream_error' : 'websocket_upstream_unavailable'
          });
        };
        upstream.once('open', () => {
          upstreamOpen = true;
          this.audit({
            action: 'proxy.websocket', result: 'ok', remoteAddress, sessionId: authorized.session.id,
            role: authorized.session.role, method: 'GET', pathname: url.pathname
          });
        });
        upstream.on('message', (data, isBinary) => {
          if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary: isBinary });
        });
        downstream.on('message', (data, isBinary) => {
          void this.forwardClientWebSocketMessage(
            data,
            isBinary,
            upstream,
            policy,
            authorized,
            url.pathname
          );
        });
        downstream.once('close', (code, reason) => {
          cleanup();
          closeWebSocketSafely(upstream, code, reason);
        });
        downstream.once('error', () => upstream.terminate());
        upstream.once('close', (code, reason) => {
          cleanup();
          closeWebSocketSafely(downstream, code, reason);
        });
        upstream.once('error', fail);
        resolve();
      });
    });
  }

  private async forwardClientWebSocketMessage(
    data: RawData,
    isBinary: boolean,
    upstream: WebSocket,
    policy: SecureLanWebSocketRoutePolicy,
    authorized: AuthorizedRequest,
    pathname: string
  ): Promise<void> {
    try {
      if (!this.sessions.has(authorized.session.cookieDigest)) {
        throw new GatewayHttpError(403, 'websocket_client_message_denied');
      }
      if (policy.allowOpaqueClientMessages) {
        if (authorized.session.role !== 'operator') throw new GatewayHttpError(403, 'websocket_client_message_denied');
        if (upstream.readyState !== WebSocket.OPEN) throw new GatewayHttpError(502, 'upstream_not_ready');
        upstream.send(data, { binary: isBinary });
        return;
      }
      if (isBinary || !policy.clientRpc) throw new GatewayHttpError(403, 'websocket_client_message_denied');
      const payload = JSON.parse(data.toString()) as unknown;
      const methods = this.inspectRpc(policy.clientRpc, payload, authorized.session);
      const bucket = this.rpcBucket(policy.clientRpc, methods, policy.rateLimitBucket ?? 'control');
      this.requireRate(bucket, authorized.session.id);
      await this.authorizeRpc(policy.clientRpc, payload, authorized.session, methods);
      if (upstream.readyState !== WebSocket.OPEN) throw new GatewayHttpError(502, 'upstream_not_ready');
      upstream.send(data, { binary: false });
      for (const rpcMethod of methods) {
        this.audit({
          action: 'proxy.rpc', result: 'ok', remoteAddress: authorized.remoteAddress,
          sessionId: authorized.session.id, role: authorized.session.role,
          method: 'WEBSOCKET', pathname, rpcMethod
        });
      }
    } catch (error) {
      this.audit({
        action: 'request.denied', result: 'denied', remoteAddress: authorized.remoteAddress,
        sessionId: authorized.session.id, role: authorized.session.role,
        method: 'WEBSOCKET', pathname,
        reason: error instanceof GatewayHttpError ? error.reason : 'invalid_websocket_rpc'
      });
      for (const webSocket of authorized.session.webSockets) webSocket.close(1008, 'Policy violation');
      upstream.close(1008, 'Policy violation');
    }
  }

  private validateAuthority(request: IncomingMessage): string {
    const remoteAddress = normalizeRemoteAddress(request.socket.remoteAddress);
    if (!isPrivateSecureLanAddress(remoteAddress)) throw new GatewayHttpError(403, 'client_address_denied');
    if (!this.authority || !this.origin || this.state !== 'running') {
      throw new GatewayHttpError(503, 'gateway_not_running');
    }
    if (countRawHeader(request, 'host') !== 1 || request.headers.host !== this.authority) {
      throw new GatewayHttpError(421, 'untrusted_host');
    }
    return remoteAddress;
  }

  private parseRequestUrl(request: IncomingMessage): URL {
    if (!this.origin || !request.url || !request.url.startsWith('/')) {
      throw new GatewayHttpError(400, 'invalid_request_target');
    }
    let url: URL;
    try { url = new URL(request.url, this.origin); } catch { throw new GatewayHttpError(400, 'invalid_request_target'); }
    if (url.origin !== this.origin) throw new GatewayHttpError(421, 'untrusted_request_target');
    for (const name of url.searchParams.keys()) {
      const normalized = name.toLowerCase();
      if (SENSITIVE_QUERY_NAMES.has(normalized) && !this.allowedSensitiveQueryNames.has(normalized)) {
        throw new GatewayHttpError(400, 'secret_in_url_denied');
      }
    }
    return url;
  }

  private authorize(request: IncomingMessage, url: URL, remoteAddress: string): AuthorizedRequest {
    this.pruneEphemeral();
    if (countRawHeader(request, 'cookie') > 1) throw new GatewayHttpError(401, 'invalid_session');
    const cookie = readSingleCookie(request.headers.cookie, this.sessionCookieName);
    const session = cookie ? this.sessions.get(secretDigest(cookie)) : undefined;
    if (!session || session.runtimeId !== this.runtimeId) throw new GatewayHttpError(401, 'invalid_session');
    const now = this.now();
    if (session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) {
      this.removeSession(session);
      throw new GatewayHttpError(401, 'expired_session');
    }
    session.idleExpiresAt = Math.min(now + this.sessionIdleTtlMs, session.absoluteExpiresAt);
    return { session, url, remoteAddress };
  }

  private policyFor(request: IncomingMessage, url: URL, websocket: boolean): SecureLanRoutePolicy {
    let policy: SecureLanRoutePolicy | null = null;
    try {
      policy = this.resolvePolicy({
        runtimeId: this.runtimeId,
        method: (request.method ?? 'GET').toUpperCase(),
        pathname: url.pathname,
        search: url.search,
        websocket
      });
    } catch {
      throw new GatewayHttpError(403, 'route_policy_error');
    }
    if (!policy || policy.runtimeId !== this.runtimeId) throw new GatewayHttpError(403, 'route_not_allowed');
    return policy;
  }

  private assertHttpPolicy(
    request: IncomingMessage,
    authorized: AuthorizedRequest,
    policy: SecureLanHttpRoutePolicy
  ): void {
    const method = (request.method ?? 'GET').toUpperCase();
    if (!policy.methods.map((item) => item.toUpperCase()).includes(method)) {
      throw new GatewayHttpError(405, 'method_not_allowed');
    }
    this.assertRole(authorized.session, policy.roles);
  }

  private assertRole(session: SessionRecord, roles: readonly SecureLanRole[] | undefined): void {
    if (roles && !roles.includes(session.role)) throw new GatewayHttpError(403, 'role_denied');
  }

  private validateSameOriginMutation(request: IncomingMessage): void {
    this.validateOriginAndFetchMetadata(request);
  }

  /**
   * Some mobile QR browsers omit Fetch Metadata on a top-level HTML form
   * submission. Pairing remains one-time and authority-bound, so accept only
   * an exact same-origin Origin, or an exact same-origin Referer when Origin
   * is absent. Any metadata that is present must still say same-origin.
   */
  private validatePairingFormOrigin(request: IncomingMessage): void {
    if (!this.origin) throw new GatewayHttpError(403, 'origin_denied');
    const originCount = countRawHeader(request, 'origin');
    if (originCount > 1) throw new GatewayHttpError(403, 'origin_denied');
    const suppliedOrigin = originCount === 1 ? request.headers.origin : undefined;
    if (suppliedOrigin !== undefined) {
      if (suppliedOrigin !== this.origin) throw new GatewayHttpError(403, 'origin_denied');
    } else {
      if (countRawHeader(request, 'referer') !== 1) throw new GatewayHttpError(403, 'origin_denied');
      const referer = request.headers.referer;
      try {
        if (typeof referer !== 'string' || new URL(referer).origin !== this.origin) {
          throw new GatewayHttpError(403, 'origin_denied');
        }
      } catch (error) {
        if (error instanceof GatewayHttpError) throw error;
        throw new GatewayHttpError(403, 'origin_denied');
      }
    }
    const fetchSiteCount = countRawHeader(request, 'sec-fetch-site');
    if (fetchSiteCount > 1
      || (fetchSiteCount === 1 && request.headers['sec-fetch-site'] !== 'same-origin')) {
      throw new GatewayHttpError(403, 'fetch_metadata_denied');
    }
  }

  private validateOriginAndFetchMetadata(request: IncomingMessage): void {
    if (!this.origin
      || countRawHeader(request, 'origin') !== 1
      || request.headers.origin !== this.origin) {
      throw new GatewayHttpError(403, 'origin_denied');
    }
    if (countRawHeader(request, 'sec-fetch-site') !== 1
      || request.headers['sec-fetch-site'] !== 'same-origin') {
      throw new GatewayHttpError(403, 'fetch_metadata_denied');
    }
  }

  private validateCsrf(request: IncomingMessage, session: SessionRecord): void {
    this.validateSameOriginMutation(request);
    const headerCount = countRawHeader(request, CSRF_HEADER);
    if (headerCount > 1) throw new GatewayHttpError(403, 'csrf_denied');
    const token = headerCount === 1
      ? request.headers[CSRF_HEADER]
      : readSingleCookie(request.headers.cookie, this.csrfCookieName);
    const digest = typeof token === 'string' ? Buffer.from(secretDigest(token)) : Buffer.alloc(0);
    const expected = Buffer.from(session.csrfDigest);
    if (!safeBufferEqual(digest, expected)) {
      throw new GatewayHttpError(403, 'csrf_denied');
    }
  }

  private inspectRpc(
    policy: SecureLanRpcPolicy,
    payload: unknown,
    session: SessionRecord
  ): readonly string[] {
    const methods = (policy.extractMethods ?? defaultExtractRpcMethods)(payload);
    if (!methods || methods.length < 1 || methods.some((method) => typeof method !== 'string' || !method)) {
      throw new GatewayHttpError(400, 'invalid_rpc_payload');
    }
    for (const method of methods) {
      if (!Object.prototype.hasOwnProperty.call(policy.methods, method)) {
        throw new GatewayHttpError(403, 'rpc_method_denied');
      }
      const methodPolicy = policy.methods[method]!;
      this.assertRole(session, methodPolicy.roles);
    }
    return methods;
  }

  private async authorizeRpc(
    policy: SecureLanRpcPolicy,
    payload: unknown,
    session: SessionRecord,
    methods: readonly string[]
  ): Promise<void> {
    for (const method of methods) {
      const methodPolicy = policy.methods[method]!;
      if (methodPolicy.authorize && !await methodPolicy.authorize({
        runtimeId: this.runtimeId,
        sessionId: session.id,
        role: session.role,
        method,
        payload
      })) {
        throw new GatewayHttpError(403, 'rpc_authorization_denied');
      }
    }
  }

  private rpcBucket(
    policy: SecureLanRpcPolicy,
    methods: readonly string[],
    fallback: SecureLanRateBucket
  ): SecureLanRateBucket {
    const buckets = methods.map((method) => policy.methods[method]?.rateLimitBucket ?? fallback);
    const priority: readonly SecureLanRateBucket[] = ['prompt', 'artifact', 'stream', 'control', 'read'];
    return priority.find((bucket) => buckets.includes(bucket)) ?? fallback;
  }

  private defaultBucket(kind: SecureLanHttpRoutePolicy['kind']): SecureLanRateBucket {
    if (kind === 'artifact') return 'artifact';
    if (kind === 'stream') return 'stream';
    if (kind === 'rpc') return 'control';
    return 'read';
  }

  private isMutating(method: string | undefined): boolean {
    const normalized = (method ?? 'GET').toUpperCase();
    return normalized !== 'GET' && normalized !== 'HEAD' && normalized !== 'OPTIONS';
  }

  private parseJsonBody(request: IncomingMessage, body: Buffer): unknown {
    const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json' && !contentType?.endsWith('+json')) {
      throw new GatewayHttpError(415, 'json_content_type_required');
    }
    try { return JSON.parse(body.toString('utf8')) as unknown; }
    catch { throw new GatewayHttpError(400, 'invalid_json'); }
  }

  private readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
    const contentLength = request.headers['content-length'];
    if (contentLength !== undefined) {
      const parsed = Number(contentLength);
      if (!Number.isSafeInteger(parsed) || parsed < 0) throw new GatewayHttpError(400, 'invalid_content_length');
      if (parsed > limit) {
        request.resume();
        return Promise.reject(new RequestBodyTooLargeError());
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
          chunks.length = 0;
          request.resume();
          reject(new RequestBodyTooLargeError());
          return;
        }
        chunks.push(buffer);
      });
      request.once('end', () => {
        if (!settled) {
          settled = true;
          resolve(Buffer.concat(chunks, bytes));
        }
      });
      request.once('aborted', () => {
        if (!settled) {
          settled = true;
          reject(new GatewayHttpError(400, 'request_aborted'));
        }
      });
      request.once('error', (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    });
  }

  private async proxyHttp(
    request: IncomingMessage,
    response: ServerResponse,
    authorized: AuthorizedRequest,
    body: Buffer
  ): Promise<number> {
    const target = this.upstreamTarget(authorized.url);
    this.trace({ phase: 'proxy.upstream.start', method: request.method, pathname: authorized.url.pathname, detail: target.href });
    const headers = proxyRequestHeaders(request.headers, false, this.sessionCookieName, this.csrfCookieName);
    Object.assign(headers, this.upstreamHeaders(false));
    headers['content-length'] = body.length;
    return new Promise<number>((resolve, reject) => {
      let settled = false;
      const proxy = requestHttp(target, { method: request.method, headers }, (upstream) => {
        if (settled) {
          upstream.resume();
          return;
        }
        const responseHeaders = proxyResponseHeaders(upstream.headers, this.sessionCookieName, this.csrfCookieName);
        const location = upstream.headers.location;
        if (location) responseHeaders.location = this.rewriteLocation(location, target.origin);
        const statusCode = upstream.statusCode ?? 502;
        this.trace({ phase: 'proxy.upstream.response', method: request.method, pathname: authorized.url.pathname, detail: `status=${statusCode}` });
        response.writeHead(statusCode, upstream.statusMessage, responseHeaders);
        upstream.pipe(response);
        upstream.once('end', () => {
          if (settled) return;
          settled = true;
          cleanup();
          this.trace({ phase: 'proxy.upstream.end', method: request.method, pathname: authorized.url.pathname, detail: `status=${statusCode}` });
          resolve(statusCode);
        });
        upstream.once('close', () => {
          if (settled || upstream.complete) return;
          settled = true;
          cleanup();
          this.trace({ phase: 'proxy.upstream.close', method: request.method, pathname: authorized.url.pathname, detail: 'incomplete' });
          reject(new Error('Secure LAN upstream response closed before completion'));
        });
        upstream.once('error', fail);
      });
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.trace({ phase: 'proxy.upstream.error', method: request.method, pathname: authorized.url.pathname, detail: error.message });
        reject(error);
      };
      const onResponseClose = () => {
        if (settled) return;
        settled = true;
        proxy.destroy();
        cleanup();
        reject(new Error('Upstream client response closed before completion'));
      };
      const onRequestAborted = () => {
        if (settled) return;
        settled = true;
        proxy.destroy();
        cleanup();
        reject(new Error('Upstream client request aborted'));
      };
      const cleanup = () => {
        request.off('aborted', onRequestAborted);
        response.off('close', onResponseClose);
      };
      this.guardUpstream(proxy, fail);
      request.once('aborted', onRequestAborted);
      response.once('close', onResponseClose);
      proxy.end(body);
    });
  }

  private upstreamTarget(url: URL): URL {
    const resolved = this.resolveUpstream(this.runtimeId);
    if (!resolved) throw new GatewayHttpError(503, 'runtime_unavailable');
    const endpoint = normalizeSecureLanUpstreamEndpoint(resolved);
    return new URL(`${url.pathname}${url.search}`, endpoint);
  }

  /** Chromium WebSocket upgrades always carry Origin but do not reliably
   * carry Fetch Metadata. Keep the exact origin mandatory and reject any
   * supplied non-same-origin metadata without requiring that optional header. */
  private validateWebSocketOrigin(request: IncomingMessage): void {
    if (!this.origin
      || countRawHeader(request, 'origin') !== 1
      || request.headers.origin !== this.origin) {
      throw new GatewayHttpError(403, 'origin_denied');
    }
    const fetchSiteCount = countRawHeader(request, 'sec-fetch-site');
    if (fetchSiteCount > 1
      || (fetchSiteCount === 1 && request.headers['sec-fetch-site'] !== 'same-origin')) {
      throw new GatewayHttpError(403, 'fetch_metadata_denied');
    }
  }

  private upstreamHeaders(websocket: boolean): OutgoingHttpHeaders {
    const resolved = this.resolveUpstreamHeaders?.(this.runtimeId, websocket);
    if (!resolved) return {};
    const output: OutgoingHttpHeaders = {};
    for (const [rawName, value] of Object.entries(resolved)) {
      const name = rawName.trim().toLowerCase();
      if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(name)
        || HOP_BY_HOP_HEADERS.has(name)
        || name === 'host'
        || name === 'content-length'
        || (websocket && WEBSOCKET_HANDSHAKE_HEADERS.has(name))
        || typeof value !== 'string'
        || value.length > 8_192
        || /[\r\n\u0000]/.test(value)) {
        throw new GatewayHttpError(503, 'invalid_upstream_credentials');
      }
      output[name] = value;
    }
    return output;
  }

  private guardUpstream(request: ClientRequest, reject: (error: Error) => void): void {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.once('socket', (socket) => {
      if (!socket.connecting) return;
      socket.setTimeout(this.connectTimeoutMs, () => request.destroy(new Error('Secure LAN upstream connection timed out')));
      socket.once('connect', () => socket.setTimeout(0));
    });
    request.once('response', () => { settled = true; });
    request.once('error', fail);
  }

  private rewriteLocation(value: string, upstreamOrigin: string): string {
    if (!this.origin) return value;
    try {
      const location = new URL(value, upstreamOrigin);
      return location.origin === upstreamOrigin
        ? `${this.origin}${location.pathname}${location.search}${location.hash}`
        : value;
    } catch {
      return value;
    }
  }

  private webSocketProtocols(request: IncomingMessage): string[] {
    const header = request.headers['sec-websocket-protocol'];
    if (header === undefined) return [];
    if (typeof header !== 'string') throw new GatewayHttpError(400, 'invalid_websocket_protocol');
    const protocols = header.split(',').map((item) => item.trim());
    if (protocols.some((item) => !item || !/^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/.test(item))) {
      throw new GatewayHttpError(400, 'invalid_websocket_protocol');
    }
    return protocols;
  }

  private acquireRequest(session: SessionRecord): void {
    if (this.activeRequests >= this.limits.maxConcurrentRequests
      || session.activeRequests >= this.limits.maxConcurrentRequestsPerSession) {
      throw new GatewayHttpError(429, 'request_concurrency_limit');
    }
    this.activeRequests += 1;
    session.activeRequests += 1;
  }

  private releaseRequest(session: SessionRecord): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    session.activeRequests = Math.max(0, session.activeRequests - 1);
  }

  private requireRate(bucket: SecureLanRateBucket | 'pair', scope: string): void {
    const limit = bucket === 'pair' ? this.limits.pair : this.limits[bucket];
    const now = this.now();
    const key = `${bucket}:${scope}`;
    const record = this.rateRecords.get(key) ?? { timestamps: [], touchedAt: now };
    record.timestamps = record.timestamps.filter((timestamp) => timestamp > now - limit.windowMs);
    record.touchedAt = now;
    if (record.timestamps.length >= limit.max) {
      this.rateRecords.set(key, record);
      throw new GatewayHttpError(429, `${bucket}_rate_limit`);
    }
    record.timestamps.push(now);
    this.rateRecords.set(key, record);
  }

  private consumePairing(code: string): PairingRecord | null {
    const now = this.now();
    for (const pairing of this.pairings.values()) {
      if (pairing.expiresAt <= now) continue;
      if (!safeBufferEqual(pairing.digest, pairingDigest(pairing.salt, code))) continue;
      this.pairings.delete(pairing.id);
      pairing.salt.fill(0);
      pairing.digest.fill(0);
      return pairing;
    }
    return null;
  }

  private pruneEphemeral(): void {
    const now = this.now();
    for (const pairing of this.pairings.values()) {
      if (pairing.expiresAt > now) continue;
      pairing.salt.fill(0);
      pairing.digest.fill(0);
      this.pairings.delete(pairing.id);
    }
    for (const session of this.sessions.values()) {
      if (session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) this.removeSession(session);
    }
    for (const [key, record] of this.rateRecords) {
      if (record.touchedAt <= now - 10 * 60_000) this.rateRecords.delete(key);
    }
  }

  private removeSession(session: SessionRecord): void {
    this.sessions.delete(session.cookieDigest);
    for (const webSocket of session.webSockets) webSocket.terminate();
    session.webSockets.clear();
    session.csrfDigest = '';
    session.cookieDigest = '';
    try { this.onSessionRevoked?.(session.id); } catch { /* revocation must keep closing the edge */ }
  }

  private revokeEverySession(): void {
    for (const session of [...this.sessions.values()]) this.removeSession(session);
    this.sessions.clear();
  }

  private webSocketCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) count += session.webSockets.size;
    return count;
  }

  private certificatePem(value: SecureLanTlsIdentity['cert']): string | Buffer {
    if (typeof value === 'string' || Buffer.isBuffer(value)) return value;
    if (Array.isArray(value)) {
      const first = value[0];
      if (typeof first === 'string' || Buffer.isBuffer(first)) return first;
    }
    throw new Error('Secure LAN Gateway requires a parseable X.509 certificate');
  }

  private spkiFingerprint(certPem: string | Buffer): string {
    const certificate = new X509Certificate(certPem);
    const der = certificate.publicKey.export({ format: 'der', type: 'spki' });
    return `sha256/${createHash('sha256').update(der).digest('base64')}`;
  }

  private validateCertificateHost(certPem: string | Buffer, host: string): void {
    const normalized = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    const certificate = new X509Certificate(certPem);
    const match = isIP(normalized) ? certificate.checkIP(normalized) : certificate.checkHost(normalized);
    if (!match) throw new Error('Secure LAN TLS certificate does not cover the public host');
  }

  private setSecurityHeaders(response: ServerResponse): void {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('cross-origin-resource-policy', 'same-origin');
  }

  private handleHttpFailure(request: IncomingMessage, response: ServerResponse, error: unknown): void {
    const gatewayError = error instanceof GatewayHttpError
      ? error
      : new GatewayHttpError(502, 'proxy_failure', 'Secure LAN proxy failure');
    if (!(error instanceof GatewayHttpError) && !isBenignTransportError(error)) this.lastError = 'Secure LAN proxy failure';
    const remoteAddress = normalizeRemoteAddress(request.socket.remoteAddress);
    let pathname: string | undefined;
    try { pathname = this.origin ? new URL(request.url ?? '/', this.origin).pathname : undefined; } catch { /* ignored */ }
    this.audit({
      action: error instanceof GatewayHttpError ? 'request.denied' : 'proxy.error',
      result: error instanceof GatewayHttpError ? 'denied' : 'error',
      remoteAddress,
      method: request.method,
      pathname,
      reason: gatewayError.reason
    });
    if (isBenignTransportError(error) || request.aborted || response.destroyed || response.writableEnded) return;
    this.replyJson(response, gatewayError.status, gatewayError.reason);
  }

  private recordProxyError(request: IncomingMessage, error: unknown): void {
    const gatewayError = error instanceof GatewayHttpError ? error : null;
    if (!gatewayError) this.lastError = 'Secure LAN WebSocket proxy failure';
    this.audit({
      action: gatewayError ? 'request.denied' : 'proxy.error',
      result: gatewayError ? 'denied' : 'error',
      remoteAddress: normalizeRemoteAddress(request.socket.remoteAddress),
      method: request.method,
      reason: gatewayError?.reason ?? 'websocket_proxy_failure'
    });
  }

  private replyJson(response: ServerResponse, status: number, reason: string): void {
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    response.end(JSON.stringify({ error: reason }));
  }

  private rejectUpgrade(socket: Duplex, status: number): void {
    if (socket.destroyed) return;
    const reason = status === 401 ? 'Unauthorized'
      : status === 403 ? 'Forbidden'
        : status === 421 ? 'Misdirected Request'
          : status === 429 ? 'Too Many Requests'
            : status === 503 ? 'Service Unavailable'
              : 'Bad Gateway';
    try { socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
    catch { socket.destroy(); }
  }

  private failClosed(error: Error): void {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.webSocketServer?.close();
    this.webSocketServer = null;
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    this.revokeEverySession();
    this.pairings.clear();
    this.rateRecords.clear();
    for (const webSocket of this.upstreamWebSockets) webSocket.terminate();
    this.upstreamWebSockets.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.state = 'error';
    this.enabled = false;
    this.bindHost = null;
    this.port = null;
    this.authority = null;
    this.origin = null;
    this.certificateFingerprint = null;
    this.lastError = error.message;
    void closeServer(server);
  }

  private audit(event: Omit<SecureLanAuditEvent, 'timestamp' | 'runtimeId'>): void {
    if (!this.auditSink) return;
    try {
      this.auditSink({ timestamp: this.now(), runtimeId: this.runtimeId, ...event });
    } catch {
      // Audit persistence failure must not disclose credentials or break cleanup.
    }
  }

  private trace(event: { phase: string; method?: string; pathname?: string; detail?: string }): void {
    try { this.traceSink?.(event); } catch { /* diagnostics must never affect transport */ }
  }
}
