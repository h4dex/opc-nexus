import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http';
import type { Socket } from 'node:net';
import {
  normalizeProviderBaseUrl,
  providerResourceUrl
} from './providerEndpoint.js';

export const PROVIDER_CREDENTIAL_PROXY_HOST = '127.0.0.1';

const TOKEN_PREFIX = 'dshp_';
const TOKEN_PATTERN = /^dshp_[A-Za-z0-9_-]{40,64}$/;
const DEFAULT_MAX_GRANT_TTL_MS = 15 * 60_000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 5 * 60_000;
export const PROVIDER_CREDENTIAL_PROXY_MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;
const MAX_GRANT_REQUESTS = 10_000;
const MAX_GRANT_CONCURRENCY = 32;
const MAX_IDENTIFIER_LENGTH = 256;
const RATE_WINDOW_MS = 60_000;
const GRANT_RETENTION_MS = 60 * 60_000;
const FORBIDDEN_BODY_FIELDS = new Set([
  'api_key', 'apiKey', 'base_url', 'baseUrl', 'provider', 'providerId',
  'authorization', 'headers', 'endpoint', 'url'
]);

export interface ProviderCredentialBinding {
  organizationId: string;
  runtimeId: string;
  agentId: string;
  providerId: string;
  model: string;
}

export interface ProviderCredentialResolution {
  organizationId?: string;
  providerId: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

export type ProviderCredentialResolver = (
  binding: Readonly<ProviderCredentialBinding>
) => ProviderCredentialResolution | null | Promise<ProviderCredentialResolution | null>;

export interface ProviderCredentialGrantRequest extends ProviderCredentialBinding {
  ttlMs: number;
  maxRequests: number;
  maxConcurrentRequests: number;
  maxRequestBytes: number;
  maxResponseBytes?: number;
  maxRequestsPerMinute?: number;
}

export interface IssuedProviderCredentialGrant {
  grantId: string;
  token: string;
  baseUrl: string;
  model: string;
  expiresAt: number;
}

export interface RenewedProviderCredentialGrant {
  expiresAt: number;
}

export interface ProviderCredentialGrantSnapshot extends ProviderCredentialBinding {
  grantId: string;
  tokenHash: string;
  issuedAt: number;
  expiresAt: number;
  revokedAt: number | null;
  requestCount: number;
  activeRequests: number;
  maxRequests: number;
  maxConcurrentRequests: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxRequestsPerMinute: number;
}

export interface ProviderCredentialProxyStatus {
  running: boolean;
  host: typeof PROVIDER_CREDENTIAL_PROXY_HOST;
  port: number | null;
  activeGrants: number;
  activeRequests: number;
}

export interface ProviderCredentialAuditEvent {
  timestamp: number;
  action: 'grant.issue' | 'grant.renew' | 'grant.revoke' | 'grant.model.authorize' | 'request.models' | 'request.chat' | 'request.deny' | 'proxy.error';
  result: string;
  grantId?: string;
  organizationId?: string;
  runtimeId?: string;
  agentId?: string;
  providerId?: string;
  model?: string;
  reason?: string;
  upstreamStatus?: number;
}

export interface ProviderCredentialProxyOptions {
  resolveProvider: ProviderCredentialResolver;
  audit?: (event: ProviderCredentialAuditEvent) => void;
  fetch?: typeof fetch;
  now?: () => number;
  maxGrantTtlMs?: number;
  upstreamTimeoutMs?: number;
}

interface GrantRecord extends ProviderCredentialBinding {
  grantId: string;
  tokenHash: string;
  upstreamBaseUrl: string;
  issuedAt: number;
  expiresAt: number;
  revokedAt: number | null;
  requestCount: number;
  activeRequests: number;
  maxRequests: number;
  maxConcurrentRequests: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxRequestsPerMinute: number;
  /** Models explicitly admitted by Main for sessions in this runtime. */
  allowedModels: Set<string>;
  recentRequestStarts: number[];
  activeControllers: Set<AbortController>;
}

type AdmissionFailure = 'expired' | 'revoked' | 'budget' | 'concurrency' | 'rate';

class RequestBodyTooLargeError extends Error {}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function safeAuditText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_IDENTIFIER_LENGTH);
}

function requiredIdentity(value: string, label: string): string {
  if (typeof value !== 'string' || value !== value.trim() || value.length === 0
    || value.length > MAX_IDENTIFIER_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function positiveInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function headerCount(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count;
}

function isLoopbackPeer(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer && 'unref' in timer) timer.unref();
}

function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin'
  });
  response.end(body);
}

function errorPayload(message: string, code: string, type = 'invalid_request_error'): unknown {
  return { error: { message, type, code } };
}

function parsePath(request: IncomingMessage): string | null {
  const raw = request.url ?? '';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('#') || /[\r\n\\]/.test(raw)) return null;
  try {
    return new URL(raw, 'http://localhost').pathname;
  } catch {
    return null;
  }
}

/**
 * Main-process credential boundary for managed DSH runtimes.
 *
 * Grant records contain only a SHA-256 token digest and non-secret scope. The
 * long-lived Provider key is resolved for one request and is never retained on
 * the service instance, returned to a runtime, or included in audit events.
 */
export class ProviderCredentialProxy {
  private readonly resolveProvider: ProviderCredentialResolver;
  private readonly auditSink?: (event: ProviderCredentialAuditEvent) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly maxGrantTtlMs: number;
  private readonly upstreamTimeoutMs: number;
  private readonly grantsById = new Map<string, GrantRecord>();
  private readonly grantsByHash = new Map<string, GrantRecord>();
  private readonly sockets = new Set<Socket>();
  private server: Server | null = null;
  private port: number | null = null;
  private startPromise: Promise<ProviderCredentialProxyStatus> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(options: ProviderCredentialProxyOptions) {
    if (typeof options.resolveProvider !== 'function') throw new Error('Provider resolver is required');
    this.resolveProvider = options.resolveProvider;
    this.auditSink = options.audit;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.maxGrantTtlMs = positiveInteger(
      options.maxGrantTtlMs ?? DEFAULT_MAX_GRANT_TTL_MS,
      24 * 60 * 60_000,
      'maximum Provider grant TTL'
    );
    this.upstreamTimeoutMs = positiveInteger(
      options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
      60 * 60_000,
      'Provider upstream timeout'
    );
  }

  getStatus(): ProviderCredentialProxyStatus {
    const now = this.now();
    this.pruneGrants(now);
    let activeGrants = 0;
    let activeRequests = 0;
    for (const grant of this.grantsById.values()) {
      if (grant.revokedAt === null && grant.expiresAt > now) activeGrants += 1;
      activeRequests += grant.activeRequests;
    }
    return {
      running: this.server?.listening === true,
      host: PROVIDER_CREDENTIAL_PROXY_HOST,
      port: this.server?.listening ? this.port : null,
      activeGrants,
      activeRequests
    };
  }

  async start(port = 0): Promise<ProviderCredentialProxyStatus> {
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Invalid Provider proxy port');
    if (this.server?.listening) return this.getStatus();
    if (this.startPromise) return this.startPromise;
    if (this.stopPromise) await this.stopPromise;

    const candidate = createServer((request, response) => {
      void this.handleRequest(request, response).catch(() => {
        this.audit({ action: 'proxy.error', result: 'fail-closed', reason: 'request_handler_error' });
        writeJson(response, 503, errorPayload(
          'Provider proxy temporarily unavailable',
          'provider_proxy_unavailable',
          'service_unavailable'
        ));
      });
    });
    candidate.maxHeadersCount = 32;
    candidate.headersTimeout = 15_000;
    candidate.requestTimeout = 30_000;
    candidate.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    candidate.on('clientError', (_error, socket) => {
      this.audit({ action: 'request.deny', result: 'denied', reason: 'invalid_http_request' });
      socket.destroy();
    });

    this.server = candidate;
    this.startPromise = new Promise<ProviderCredentialProxyStatus>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (this.server === candidate) this.server = null;
        this.port = null;
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      candidate.once('error', fail);
      candidate.once('listening', () => {
        if (settled) return;
        if (this.server !== candidate) {
          settled = true;
          try { candidate.close(); } catch { /* stop() already owns cleanup */ }
          reject(new Error('Provider proxy start cancelled'));
          return;
        }
        const address = candidate.address();
        if (!address || typeof address === 'string') {
          fail(new Error('Provider proxy did not expose a TCP address'));
          return;
        }
        settled = true;
        candidate.removeListener('error', fail);
        candidate.on('error', () => {
          this.audit({ action: 'proxy.error', result: 'fail-closed', reason: 'server_error' });
        });
        this.port = address.port;
        resolve(this.getStatus());
      });
      try {
        candidate.listen(port, PROVIDER_CREDENTIAL_PROXY_HOST);
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Provider proxy failed to listen'));
      }
    }).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    for (const grant of this.grantsById.values()) this.revokeRecord(grant, 'proxy_stop');
    const candidate = this.server;
    this.server = null;
    this.port = null;
    if (!candidate) return;

    this.stopPromise = new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        resolve();
      };
      candidate.once('close', finish);
      try {
        candidate.close(finish);
        candidate.closeAllConnections();
        for (const socket of this.sockets) socket.destroy();
      } catch {
        finish();
      }
    }).finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  async issueGrant(request: ProviderCredentialGrantRequest): Promise<IssuedProviderCredentialGrant> {
    const server = this.server;
    const port = this.port;
    if (!server?.listening || port === null) throw new Error('Provider proxy is not running');
    this.pruneGrants(this.now());
    const binding = this.validateBinding(request);
    const ttlMs = positiveInteger(request.ttlMs, this.maxGrantTtlMs, 'Provider grant TTL');
    const maxRequests = positiveInteger(request.maxRequests, MAX_GRANT_REQUESTS, 'Provider grant request budget');
    const maxConcurrentRequests = positiveInteger(
      request.maxConcurrentRequests,
      MAX_GRANT_CONCURRENCY,
      'Provider grant concurrency'
    );
    const maxRequestBytes = positiveInteger(
      request.maxRequestBytes,
      PROVIDER_CREDENTIAL_PROXY_MAX_REQUEST_BYTES,
      'Provider request size'
    );
    const maxResponseBytes = positiveInteger(
      request.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      MAX_RESPONSE_BYTES,
      'Provider response size'
    );
    const maxRequestsPerMinute = positiveInteger(
      request.maxRequestsPerMinute ?? maxRequests,
      Math.min(maxRequests, MAX_GRANT_REQUESTS),
      'Provider grant rate budget'
    );

    let resolution: ProviderCredentialResolution | null;
    try {
      resolution = await this.resolveProvider(Object.freeze({ ...binding }));
    } catch {
      this.auditBinding(binding, { action: 'grant.issue', result: 'denied', reason: 'provider_unavailable' });
      throw new Error('Provider credential is unavailable');
    }
    if (this.server !== server || !server.listening || this.port !== port) {
      this.auditBinding(binding, { action: 'grant.issue', result: 'denied', reason: 'proxy_stopped' });
      throw new Error('Provider proxy is not running');
    }
    const upstreamBaseUrl = this.validateResolution(binding, resolution);
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const digest = tokenHash(token);
    const now = this.now();
    const grant: GrantRecord = {
      ...binding,
      grantId: randomUUID(),
      tokenHash: digest,
      upstreamBaseUrl,
      issuedAt: now,
      expiresAt: now + ttlMs,
      revokedAt: null,
      requestCount: 0,
      activeRequests: 0,
      maxRequests,
      maxConcurrentRequests,
      maxRequestBytes,
      maxResponseBytes,
      maxRequestsPerMinute,
      allowedModels: new Set([binding.model]),
      recentRequestStarts: [],
      activeControllers: new Set()
    };
    this.grantsById.set(grant.grantId, grant);
    this.grantsByHash.set(grant.tokenHash, grant);
    if (!this.auditGrant(grant, { action: 'grant.issue', result: 'ok' })) {
      this.revokeRecord(grant, 'audit_unavailable');
      throw new Error('Provider credential grant unavailable');
    }
    return {
      grantId: grant.grantId,
      token,
      baseUrl: `http://${PROVIDER_CREDENTIAL_PROXY_HOST}:${port}/v1`,
      model: grant.model,
      expiresAt: grant.expiresAt
    };
  }

  /** Extend an active capability without replacing the token already held by DSH. */
  async renewGrant(grantId: string, ttlMs: number): Promise<RenewedProviderCredentialGrant> {
    const server = this.server;
    const port = this.port;
    if (!server?.listening || port === null) throw new Error('Provider proxy is not running');
    const normalizedGrantId = requiredIdentity(grantId, 'Provider grant id');
    const validatedTtlMs = positiveInteger(ttlMs, this.maxGrantTtlMs, 'Provider grant TTL');
    const grant = this.grantsById.get(normalizedGrantId);
    if (!grant || grant.revokedAt !== null || grant.expiresAt <= this.now()) {
      if (grant) this.auditGrant(grant, { action: 'grant.renew', result: 'denied', reason: 'inactive_grant' });
      throw new Error('Provider credential grant is not active');
    }

    const resolvedRoutes = new Map<string, string>();
    try {
      for (const model of grant.allowedModels) {
        const binding = this.bindingForModel(grant, model);
        const resolution = await this.resolveProvider(Object.freeze(binding));
        resolvedRoutes.set(model, this.validateResolution(binding, resolution, 'grant.renew'));
      }
    } catch {
      this.auditGrant(grant, { action: 'grant.renew', result: 'denied', reason: 'provider_unavailable' });
      throw new Error('Provider credential is unavailable');
    }

    if (this.server !== server || !server.listening || this.port !== port) {
      this.auditGrant(grant, { action: 'grant.renew', result: 'denied', reason: 'proxy_stopped' });
      throw new Error('Provider proxy is not running');
    }
    const now = this.now();
    if (grant.revokedAt !== null || grant.expiresAt <= now) {
      this.auditGrant(grant, { action: 'grant.renew', result: 'denied', reason: 'inactive_grant' });
      throw new Error('Provider credential grant is not active');
    }

    if ([...resolvedRoutes.values()].some((baseUrl) => baseUrl !== grant.upstreamBaseUrl)) {
      this.auditGrant(grant, { action: 'grant.renew', result: 'denied', reason: 'provider_route_changed' });
      this.revokeRecord(grant, 'provider_route_changed');
      throw new Error('Provider credential route changed');
    }

    grant.expiresAt = now + validatedTtlMs;
    if (!this.auditGrant(grant, { action: 'grant.renew', result: 'ok' })) {
      this.revokeRecord(grant, 'audit_unavailable');
      throw new Error('Provider credential grant unavailable');
    }
    return { expiresAt: grant.expiresAt };
  }

  /**
   * Admit one additional model for a live runtime grant. The runtime cannot
   * widen its own scope: only Main holds the grant id and this method verifies
   * the same Provider identity, credential domain and organization first.
   */
  async authorizeGrantModel(grantId: string, model: string): Promise<void> {
    const server = this.server;
    const port = this.port;
    if (!server?.listening || port === null) throw new Error('Provider proxy is not running');
    const normalizedGrantId = requiredIdentity(grantId, 'Provider grant id');
    const normalizedModel = requiredIdentity(model, 'model');
    const grant = this.grantsById.get(normalizedGrantId);
    if (!grant || grant.revokedAt !== null || grant.expiresAt <= this.now()) {
      if (grant) this.auditGrant(grant, { action: 'grant.model.authorize', result: 'denied', reason: 'inactive_grant' });
      throw new Error('Provider credential grant is not active');
    }
    if (grant.allowedModels.has(normalizedModel)) return;

    const binding = this.bindingForModel(grant, normalizedModel);
    let resolution: ProviderCredentialResolution | null;
    try {
      resolution = await this.resolveProvider(Object.freeze(binding));
    } catch {
      this.auditBinding(binding, { action: 'grant.model.authorize', result: 'denied', reason: 'provider_unavailable' });
      throw new Error('Provider model is unavailable');
    }
    if (this.server !== server || !server.listening || this.port !== port) {
      this.auditBinding(binding, { action: 'grant.model.authorize', result: 'denied', reason: 'proxy_stopped' });
      throw new Error('Provider proxy is not running');
    }
    if (grant.revokedAt !== null || grant.expiresAt <= this.now()) {
      this.auditBinding(binding, { action: 'grant.model.authorize', result: 'denied', reason: 'inactive_grant' });
      throw new Error('Provider credential grant is not active');
    }
    if (grant.allowedModels.has(normalizedModel)) return;
    const upstreamBaseUrl = this.validateResolution(binding, resolution, 'grant.model.authorize');
    if (upstreamBaseUrl !== grant.upstreamBaseUrl) {
      this.auditBinding(binding, { action: 'grant.model.authorize', result: 'denied', reason: 'provider_route_changed' });
      throw new Error('Provider model route changed');
    }
    if (!this.audit({
      action: 'grant.model.authorize', result: 'ok', grantId: grant.grantId,
      organizationId: grant.organizationId, runtimeId: grant.runtimeId,
      agentId: grant.agentId, providerId: grant.providerId, model: normalizedModel
    })) {
      throw new Error('Provider model authorization unavailable');
    }
    grant.allowedModels.add(normalizedModel);
  }

  inspectGrant(grantId: string): ProviderCredentialGrantSnapshot | null {
    const grant = this.grantsById.get(grantId);
    if (!grant) return null;
    return {
      grantId: grant.grantId,
      tokenHash: grant.tokenHash,
      organizationId: grant.organizationId,
      runtimeId: grant.runtimeId,
      agentId: grant.agentId,
      providerId: grant.providerId,
      model: grant.model,
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      revokedAt: grant.revokedAt,
      requestCount: grant.requestCount,
      activeRequests: grant.activeRequests,
      maxRequests: grant.maxRequests,
      maxConcurrentRequests: grant.maxConcurrentRequests,
      maxRequestBytes: grant.maxRequestBytes,
      maxResponseBytes: grant.maxResponseBytes,
      maxRequestsPerMinute: grant.maxRequestsPerMinute
    };
  }

  revokeGrant(grantId: string, reason = 'manual'): boolean {
    const grant = this.grantsById.get(grantId);
    if (!grant || grant.revokedAt !== null) return false;
    this.revokeRecord(grant, safeAuditText(reason) || 'manual');
    return true;
  }

  revokeRuntime(runtimeId: string, reason = 'runtime_stop'): number {
    const normalizedRuntimeId = requiredIdentity(runtimeId, 'runtime id');
    let revoked = 0;
    for (const grant of this.grantsById.values()) {
      if (grant.runtimeId !== normalizedRuntimeId || grant.revokedAt !== null) continue;
      this.revokeRecord(grant, safeAuditText(reason) || 'runtime_stop');
      revoked += 1;
    }
    return revoked;
  }

  /** Revoke all grants bound to one Provider after rotation or removal. */
  revokeProvider(providerId: string, reason = 'provider_change'): number {
    const normalizedProviderId = requiredIdentity(providerId, 'provider id');
    let revoked = 0;
    for (const grant of this.grantsById.values()) {
      if (grant.providerId !== normalizedProviderId || grant.revokedAt !== null) continue;
      this.revokeRecord(grant, safeAuditText(reason) || 'provider_change');
      revoked += 1;
    }
    return revoked;
  }

  /** Emergency/default-route revocation for every active runtime grant. */
  revokeAll(reason = 'proxy_revoke_all'): number {
    let revoked = 0;
    for (const grant of this.grantsById.values()) {
      if (grant.revokedAt !== null) continue;
      this.revokeRecord(grant, safeAuditText(reason) || 'proxy_revoke_all');
      revoked += 1;
    }
    return revoked;
  }

  private validateBinding(input: ProviderCredentialBinding): ProviderCredentialBinding {
    return {
      organizationId: requiredIdentity(input.organizationId, 'organization id'),
      runtimeId: requiredIdentity(input.runtimeId, 'runtime id'),
      agentId: requiredIdentity(input.agentId, 'agent id'),
      providerId: requiredIdentity(input.providerId, 'provider id'),
      model: requiredIdentity(input.model, 'model')
    };
  }

  private validateResolution(
    binding: ProviderCredentialBinding,
    resolution: ProviderCredentialResolution | null,
    action: 'grant.issue' | 'grant.renew' | 'grant.model.authorize' = 'grant.issue'
  ): string {
    try {
      if (!resolution || resolution.providerId !== binding.providerId || resolution.model !== binding.model
        || (resolution.organizationId !== undefined && resolution.organizationId !== binding.organizationId)
        || typeof resolution.apiKey !== 'string' || resolution.apiKey.length === 0
        || resolution.apiKey.length > 64 * 1024) {
        throw new Error('scope mismatch');
      }
      return normalizeProviderBaseUrl(resolution.baseUrl);
    } catch {
      this.auditBinding(binding, { action, result: 'denied', reason: 'provider_scope_mismatch' });
      throw new Error('Provider credential is unavailable');
    }
  }

  private bindingForModel(grant: GrantRecord, model: string): ProviderCredentialBinding {
    return {
      organizationId: grant.organizationId,
      runtimeId: grant.runtimeId,
      agentId: grant.agentId,
      providerId: grant.providerId,
      model
    };
  }

  private async resolveGrantCredential(grant: GrantRecord, model = grant.model): Promise<ProviderCredentialResolution> {
    if (!grant.allowedModels.has(model)) throw new Error('Provider credential is unavailable');
    const binding = this.bindingForModel(grant, model);
    let resolution: ProviderCredentialResolution | null;
    try {
      resolution = await this.resolveProvider(Object.freeze(binding));
      if (!resolution || resolution.providerId !== grant.providerId || resolution.model !== model
        || (resolution.organizationId !== undefined && resolution.organizationId !== grant.organizationId)
        || typeof resolution.apiKey !== 'string' || resolution.apiKey.length === 0
        || normalizeProviderBaseUrl(resolution.baseUrl) !== grant.upstreamBaseUrl) {
        throw new Error('scope mismatch');
      }
      return resolution;
    } catch {
      throw new Error('Provider credential is unavailable');
    }
  }

  private revokeRecord(grant: GrantRecord, reason: string): void {
    if (grant.revokedAt !== null) return;
    grant.revokedAt = this.now();
    this.grantsByHash.delete(grant.tokenHash);
    for (const controller of grant.activeControllers) controller.abort();
    this.auditGrant(grant, { action: 'grant.revoke', result: 'ok', reason });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('cross-origin-resource-policy', 'same-origin');

    if (!isLoopbackPeer(request.socket.remoteAddress)) {
      this.deny(response, 403, 'loopback_required', 'Loopback access required');
      return;
    }
    const expectedHost = `${PROVIDER_CREDENTIAL_PROXY_HOST}:${this.port}`;
    if (headerCount(request, 'host') !== 1 || request.headers.host?.toLowerCase() !== expectedHost) {
      this.deny(response, 403, 'invalid_host', 'Invalid Host header');
      return;
    }
    if (request.headers.origin !== undefined || request.headers['access-control-request-method'] !== undefined
      || request.headers['access-control-request-headers'] !== undefined
      || request.headers['sec-fetch-site'] !== undefined || request.headers['sec-fetch-mode'] !== undefined) {
      this.deny(response, 403, 'browser_origin_denied', 'Browser-origin requests are not allowed');
      return;
    }
    const pathname = parsePath(request);
    if (pathname === null) {
      this.deny(response, 400, 'invalid_request_target', 'Invalid request target');
      return;
    }
    const grant = this.authenticate(request);
    if (!grant) {
      this.deny(response, 401, 'invalid_capability', 'Invalid or expired capability token');
      return;
    }

    if (pathname === '/v1/models' && request.method === 'GET') {
      const contentLength = request.headers['content-length'];
      if (headerCount(request, 'content-length') > 1
        || (contentLength !== undefined && contentLength !== '0')
        || request.headers['transfer-encoding'] !== undefined) {
        this.denyGrant(grant, response, 400, 'unexpected_body', 'GET requests cannot include a body');
        return;
      }
      const admission = this.admit(grant);
      if (admission) {
        this.denyAdmission(grant, response, admission);
        return;
      }
      try {
        await this.resolveGrantCredential(grant);
        if (!this.grantUsable(grant)) {
          this.denyGrant(grant, response, 401, 'invalid_capability', 'Invalid or expired capability token');
          return;
        }
        writeJson(response, 200, {
          object: 'list',
          data: [...grant.allowedModels].map((model) => ({
            id: model,
            object: 'model',
            created: Math.floor(grant.issuedAt / 1000),
            owned_by: grant.providerId
          }))
        });
        this.auditGrant(grant, { action: 'request.models', result: 'ok' });
      } catch {
        writeJson(response, 503, errorPayload(
          'Provider credential is unavailable',
          'provider_unavailable',
          'service_unavailable'
        ));
        this.auditGrant(grant, {
          action: 'request.models', result: 'denied', reason: 'provider_unavailable'
        });
      } finally {
        this.release(grant);
      }
      return;
    }

    if (pathname === '/v1/chat/completions' && request.method === 'POST') {
      const admission = this.admit(grant);
      if (admission) {
        this.denyAdmission(grant, response, admission);
        return;
      }
      try {
        await this.proxyChat(grant, request, response);
      } finally {
        this.release(grant);
      }
      return;
    }

    this.denyGrant(grant, response, 404, 'route_not_allowed', 'Route not allowed');
  }

  private authenticate(request: IncomingMessage): GrantRecord | null {
    this.pruneGrants(this.now());
    if (headerCount(request, 'authorization') !== 1) return null;
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || authorization.length > 128) return null;
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    if (!match || !TOKEN_PATTERN.test(match[1]!)) return null;
    const grant = this.grantsByHash.get(tokenHash(match[1]!));
    if (!grant || grant.revokedAt !== null || grant.expiresAt <= this.now()) return null;
    return grant;
  }

  private admit(grant: GrantRecord): AdmissionFailure | null {
    const now = this.now();
    if (grant.revokedAt !== null) return 'revoked';
    if (grant.expiresAt <= now) return 'expired';
    if (grant.activeRequests >= grant.maxConcurrentRequests) return 'concurrency';
    if (grant.requestCount >= grant.maxRequests) return 'budget';
    grant.recentRequestStarts = grant.recentRequestStarts.filter((startedAt) => startedAt > now - RATE_WINDOW_MS);
    if (grant.recentRequestStarts.length >= grant.maxRequestsPerMinute) return 'rate';
    grant.requestCount += 1;
    grant.activeRequests += 1;
    grant.recentRequestStarts.push(now);
    return null;
  }

  private release(grant: GrantRecord): void {
    grant.activeRequests = Math.max(0, grant.activeRequests - 1);
  }

  private grantUsable(grant: GrantRecord): boolean {
    return grant.revokedAt === null && grant.expiresAt > this.now();
  }

  private pruneGrants(now: number): void {
    for (const grant of this.grantsById.values()) {
      const terminalAt = grant.revokedAt ?? grant.expiresAt;
      if (grant.activeRequests === 0 && now - terminalAt > GRANT_RETENTION_MS) {
        this.grantsById.delete(grant.grantId);
        this.grantsByHash.delete(grant.tokenHash);
      }
    }
  }

  private denyAdmission(grant: GrantRecord, response: ServerResponse, failure: AdmissionFailure): void {
    if (failure === 'expired' || failure === 'revoked') {
      this.denyGrant(grant, response, 401, 'invalid_capability', 'Invalid or expired capability token', failure);
      return;
    }
    const code = failure === 'budget'
      ? 'request_budget_exhausted'
      : failure === 'rate'
        ? 'rate_limit_exceeded'
        : 'concurrency_limit_exceeded';
    this.denyGrant(grant, response, 429, code, 'Capability request limit exceeded', failure);
  }

  private async proxyChat(
    grant: GrantRecord,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const contentType = request.headers['content-type'] ?? '';
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
      this.denyGrant(grant, response, 415, 'unsupported_content_type', 'Content-Type must be application/json');
      return;
    }
    if (request.headers['content-encoding'] !== undefined) {
      this.denyGrant(grant, response, 415, 'content_encoding_not_allowed', 'Compressed request bodies are not allowed');
      return;
    }
    if (request.headers['content-length'] !== undefined && request.headers['transfer-encoding'] !== undefined) {
      this.denyGrant(grant, response, 400, 'ambiguous_body_length', 'Ambiguous request body length');
      return;
    }
    if (headerCount(request, 'content-length') > 1) {
      this.denyGrant(grant, response, 400, 'ambiguous_body_length', 'Ambiguous request body length');
      return;
    }
    const declaredLength = request.headers['content-length'];
    if (declaredLength !== undefined) {
      if (!/^\d+$/.test(declaredLength) || Number(declaredLength) > grant.maxRequestBytes) {
        this.denyGrant(grant, response, 413, 'request_too_large', 'Request body too large');
        request.resume();
        return;
      }
    }

    let bodyBuffer: Buffer;
    try {
      bodyBuffer = await this.readBody(request, grant.maxRequestBytes);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        this.denyGrant(grant, response, 413, 'request_too_large', 'Request body too large');
        request.resume();
        response.once('finish', () => request.destroy());
        return;
      }
      throw error;
    }
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(bodyBuffer.toString('utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      body = parsed as Record<string, unknown>;
    } catch {
      this.denyGrant(grant, response, 400, 'invalid_json', 'Invalid JSON body');
      return;
    }
    if (typeof body.model !== 'string' || !grant.allowedModels.has(body.model)) {
      this.denyGrant(grant, response, 403, 'model_scope_violation', 'Model is outside this capability scope');
      return;
    }
    if ([...FORBIDDEN_BODY_FIELDS].some((field) => Object.prototype.hasOwnProperty.call(body, field))) {
      this.denyGrant(grant, response, 403, 'provider_scope_violation', 'Provider routing fields are not allowed');
      return;
    }

    let credential: ProviderCredentialResolution;
    try {
      credential = await this.resolveGrantCredential(grant, body.model);
    } catch {
      writeJson(response, 503, errorPayload(
        'Provider credential is unavailable',
        'provider_unavailable',
        'service_unavailable'
      ));
      this.auditGrant(grant, { action: 'request.chat', result: 'denied', reason: 'provider_unavailable' });
      return;
    }
    if (!this.grantUsable(grant)) {
      this.denyGrant(grant, response, 401, 'invalid_capability', 'Invalid or expired capability token');
      return;
    }

    const controller = new AbortController();
    grant.activeControllers.add(controller);
    const remainingTtl = Math.max(1, grant.expiresAt - this.now());
    const timeout = setTimeout(() => controller.abort(), Math.min(remainingTtl, this.upstreamTimeoutMs));
    unrefTimer(timeout);
    const abortForClient = () => {
      if (!response.writableEnded) controller.abort();
    };
    request.once('aborted', abortForClient);
    response.once('close', abortForClient);

    let upstreamStatus: number | undefined;
    try {
      const upstream = await this.fetchImpl(
        providerResourceUrl(grant.upstreamBaseUrl, 'chat/completions'),
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${credential.apiKey}`,
            'content-type': 'application/json',
            accept: body.stream === true ? 'text/event-stream' : 'application/json'
          },
          body: bodyBuffer as unknown as BodyInit,
          redirect: 'error',
          signal: controller.signal
        }
      );
      upstreamStatus = upstream.status;
      if (response.destroyed || response.writableEnded) return;
      const headers: Record<string, string> = {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cross-origin-resource-policy': 'same-origin'
      };
      for (const name of ['content-type', 'retry-after', 'x-request-id']) {
        const value = upstream.headers.get(name);
        if (value) headers[name] = value;
      }
      response.writeHead(upstream.status, headers);
      await this.pipeResponse(upstream, response, grant.maxResponseBytes, controller);
      this.auditGrant(grant, {
        action: 'request.chat', result: 'ok', upstreamStatus: upstream.status
      });
    } catch {
      this.auditGrant(grant, {
        action: 'request.chat',
        result: 'failed',
        reason: controller.signal.aborted ? 'request_aborted' : 'upstream_unavailable',
        ...(upstreamStatus === undefined ? {} : { upstreamStatus })
      });
      if (response.headersSent) {
        if (!response.writableEnded) response.destroy();
      } else {
        writeJson(response, 502, errorPayload(
          'Provider request failed',
          'upstream_unavailable',
          'upstream_error'
        ));
      }
    } finally {
      clearTimeout(timeout);
      request.removeListener('aborted', abortForClient);
      response.removeListener('close', abortForClient);
      grant.activeControllers.delete(controller);
    }
  }

  private async readBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      if (bytes > maximum) throw new RequestBodyTooLargeError();
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, bytes);
  }

  private async pipeResponse(
    upstream: Response,
    response: ServerResponse,
    maximum: number,
    controller: AbortController
  ): Promise<void> {
    if (!upstream.body) {
      response.end();
      return;
    }
    const reader = upstream.body.getReader();
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > maximum) {
          controller.abort();
          throw new Error('Provider response exceeded capability limit');
        }
        if (!response.write(Buffer.from(next.value))) {
          await Promise.race([once(response, 'drain'), once(response, 'close')]);
          if (response.destroyed) throw new Error('Client connection closed');
        }
      }
      response.end();
    } finally {
      reader.releaseLock();
    }
  }

  private deny(
    response: ServerResponse,
    status: number,
    reason: string,
    message: string
  ): void {
    this.audit({ action: 'request.deny', result: 'denied', reason });
    writeJson(response, status, errorPayload(message, reason));
  }

  private denyGrant(
    grant: GrantRecord,
    response: ServerResponse,
    status: number,
    code: string,
    message: string,
    reason = code
  ): void {
    this.auditGrant(grant, { action: 'request.deny', result: 'denied', reason });
    writeJson(response, status, errorPayload(message, code));
  }

  private auditBinding(
    binding: ProviderCredentialBinding,
    event: Pick<ProviderCredentialAuditEvent, 'action' | 'result' | 'reason'>
  ): boolean {
    return this.audit({
      ...event,
      organizationId: binding.organizationId,
      runtimeId: binding.runtimeId,
      agentId: binding.agentId,
      providerId: binding.providerId,
      model: binding.model
    });
  }

  private auditGrant(
    grant: GrantRecord,
    event: Pick<ProviderCredentialAuditEvent, 'action' | 'result' | 'reason' | 'upstreamStatus'>
  ): boolean {
    return this.audit({
      ...event,
      grantId: grant.grantId,
      organizationId: grant.organizationId,
      runtimeId: grant.runtimeId,
      agentId: grant.agentId,
      providerId: grant.providerId,
      model: grant.model
    });
  }

  private audit(event: Omit<ProviderCredentialAuditEvent, 'timestamp'>): boolean {
    if (!this.auditSink) return true;
    try {
      const sanitized = Object.fromEntries(
        Object.entries(event).map(([key, value]) => [
          key,
          typeof value === 'string' ? safeAuditText(value) : value
        ])
      ) as Omit<ProviderCredentialAuditEvent, 'timestamp'>;
      this.auditSink({ timestamp: this.now(), ...sanitized });
      return true;
    } catch {
      // Audit persistence cannot expose a credential or break revocation.
      return false;
    }
  }
}
