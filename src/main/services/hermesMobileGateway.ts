import { randomUUID } from 'node:crypto';
import type {
  HermesMobileAccessStatus,
  HermesMobileLanConfigInput,
  HermesMobileRoute,
  HermesUiLease
} from '../../shared/types.js';
import type { Database } from './database.js';
import {
  SecureLanGateway,
  type SecureLanRouteContext,
  type SecureLanRoutePolicy,
  type SecureLanTlsIdentity
} from './secureLanGateway.js';
import {
  SecureLanTlsIdentityStore,
  SecureLanTlsHostMismatchError,
  normalizeSecureLanGatewayConfig,
  type SecureLanGatewayConfig
} from './secureLanGatewayConfig.js';
import type { HermesServiceManager } from './hermesServiceManager.js';

const STATIC_ASSET = /\.(?:css|js|mjs|map|json|ico|png|jpe?g|gif|webp|svg|woff2?|ttf|txt|webmanifest)$/i;
export const HERMES_MOBILE_CONFIG_KEY = 'hermes:mobile:gateway';
export const HERMES_MOBILE_TLS_CERTIFICATE_KEY = 'hermes:mobile:tls:certificate';
export const HERMES_MOBILE_TLS_PRIVATE_KEY_REF = 'secret:hermes:mobile:tls:privateKey';
const PROJECT_OPERATIONS = Object.freeze({
  'chat-history': { roles: ['operator'] as const, rateLimitBucket: 'control' as const },
  'create-conversation': { roles: ['operator'] as const, rateLimitBucket: 'control' as const },
  'chat-turn': { roles: ['operator'] as const, rateLimitBucket: 'control' as const },
  'enqueue-chat-turn': { roles: ['operator'] as const, rateLimitBucket: 'control' as const },
  'retry-chat-message': { roles: ['operator'] as const, rateLimitBucket: 'control' as const },
  'cancel-chat-message': { roles: ['operator'] as const, rateLimitBucket: 'control' as const },
  'answer-clarify': { roles: ['operator'] as const, rateLimitBucket: 'control' as const },
  'approve-plan': { roles: ['operator'] as const, rateLimitBucket: 'control' as const },
  'dispatch-plan': { roles: ['operator'] as const, rateLimitBucket: 'control' as const }
});

function hasOnlyQuery(search: string, allowed: readonly string[]): boolean {
  const params = new URLSearchParams(search);
  const keys = [...params.keys()];
  if (keys.some((key) => !allowed.includes(key))) return false;
  return params.getAll('token').length === 0;
}

/** Version-pinned mobile route contract for the Hermes v0.19.0 dashboard. */
export function hermesMobileRoutePolicy(
  runtimeId: string,
  context: SecureLanRouteContext
): SecureLanRoutePolicy | null {
  if (context.runtimeId !== runtimeId || context.pathname.includes('..')) return null;
  const method = context.method.toUpperCase();
  if (context.websocket) {
    if (method !== 'GET') return null;
    if (context.pathname === '/__opc_nexus/project/events' && !context.search) {
      return {
        kind: 'websocket', runtimeId, roles: ['operator'],
        rateLimitBucket: 'stream', allowedSubprotocols: []
      };
    }
    return null;
  }
  if (context.pathname === '/__opc_nexus/project/state'
    && (method === 'GET' || method === 'HEAD')
    && !context.search) {
    return { kind: 'web', runtimeId, methods: ['GET', 'HEAD'], roles: ['operator'], rateLimitBucket: 'read' };
  }
  if (context.pathname === '/__opc_nexus/project/conversations'
    && (method === 'GET' || method === 'HEAD')
    && !context.search) {
    return { kind: 'web', runtimeId, methods: ['GET', 'HEAD'], roles: ['operator'], rateLimitBucket: 'read' };
  }
  if (context.pathname === '/__opc_nexus/project/chat-history'
    && (method === 'GET' || method === 'HEAD')
    && !context.search) {
    return { kind: 'web', runtimeId, methods: ['GET', 'HEAD'], roles: ['operator'], rateLimitBucket: 'read' };
  }
  if (context.pathname === '/__opc_nexus/project/chat-queue'
    && (method === 'GET' || method === 'HEAD')
    && !context.search) {
    return { kind: 'web', runtimeId, methods: ['GET', 'HEAD'], roles: ['operator'], rateLimitBucket: 'read' };
  }
  if (/^\/__opc_nexus\/project\/attachments\/[A-Za-z0-9-]+$/.test(context.pathname)
    && (method === 'GET' || method === 'HEAD') && !context.search) {
    return { kind: 'artifact', runtimeId, methods: ['GET', 'HEAD'], roles: ['operator'], rateLimitBucket: 'artifact' };
  }
  if (context.pathname === '/__opc_nexus/project/upload-attachment'
    && method === 'POST' && !context.search) {
    return { kind: 'artifact', runtimeId, methods: ['POST'], roles: ['operator'], rateLimitBucket: 'artifact', maxBodyBytes: 32 * 1024 * 1024 };
  }
  const projectOperation = context.pathname.startsWith('/__opc_nexus/project/')
    ? context.pathname.slice('/__opc_nexus/project/'.length)
    : '';
  if (method === 'POST' && Object.prototype.hasOwnProperty.call(PROJECT_OPERATIONS, projectOperation) && !context.search) {
    return {
      kind: 'rpc', runtimeId, methods: ['POST'], roles: ['operator'], rateLimitBucket: 'control',
      maxBodyBytes: 64 * 1024,
      rpc: { extractMethods: () => [projectOperation], methods: PROJECT_OPERATIONS }
    };
  }
  if (method !== 'GET' && method !== 'HEAD') return null;
  // NexusChatPage only needs the harmless upstream health projection. All
  // project data and mutations use the Main-owned /__opc_nexus/project/*
  // contract above; native Hermes files, memory, logs, sessions and sockets
  // stay unreachable from a paired phone.
  if (context.pathname === '/api/status') {
    return hasOnlyQuery(context.search, [])
      ? { kind: 'web', runtimeId, methods: ['GET', 'HEAD'], roles: ['operator'], rateLimitBucket: 'read' }
      : null;
  }
  if (context.pathname === '/chat' || context.pathname.startsWith('/chat/')) {
    return hasOnlyQuery(context.search, [])
      ? { kind: 'web', runtimeId, methods: ['GET', 'HEAD'], roles: ['operator'], rateLimitBucket: 'read' }
      : null;
  }
  const web = STATIC_ASSET.test(context.pathname);
  return web && hasOnlyQuery(context.search, [])
    ? { kind: 'web', runtimeId, methods: ['GET', 'HEAD'], roles: ['operator'], rateLimitBucket: 'read' }
    : null;
}

interface MobileGatewayEntry {
  projectId: string;
  runtimeId: string;
  gateway: SecureLanGateway;
  lease: HermesUiLease | null;
  leaseCookie: string | null;
  proxyUrl: string | null;
}

/** Translate generic transport failures into the project conversation vocabulary. */
function hermesMobileError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw
    .replace(/Secure LAN Gateway/gi, 'Hermes 手机网关')
    .replace(/Secure LAN/gi, 'Hermes 手机连接');
  return new Error(message || 'Hermes 手机连接失败');
}

export async function ensureHermesMobileTlsIdentity(
  identities: Pick<SecureLanTlsIdentityStore, 'ensure' | 'reset'>,
  config: SecureLanGatewayConfig
): Promise<SecureLanTlsIdentity> {
  try {
    return await identities.ensure(config);
  } catch (error) {
    if (!(error instanceof SecureLanTlsHostMismatchError)) throw error;
    identities.reset();
    return identities.ensure(config);
  }
}

export interface HermesMobileGatewayOptions {
  resolveTls?: (config: SecureLanGatewayConfig) => Promise<SecureLanTlsIdentity>;
  now?: () => number;
  trace?: (projectId: string, event: { phase: string; method?: string; pathname?: string; detail?: string }) => void;
}

/** Project-scoped Hermes Chat LAN edge. It never receives the Hermes service token. */
export class HermesMobileGatewayService {
  private readonly entries = new Map<string, MobileGatewayEntry>();
  private readonly resolveTls: (config: SecureLanGatewayConfig) => Promise<SecureLanTlsIdentity>;
  private readonly now: () => number;
  private readonly traceSink?: HermesMobileGatewayOptions['trace'];
  private configured: SecureLanGatewayConfig | null;

  constructor(
    private readonly db: Database,
    private readonly services: HermesServiceManager,
    options: HermesMobileGatewayOptions = {}
  ) {
    const identities = new SecureLanTlsIdentityStore(db, undefined, undefined, {
      certificateKey: HERMES_MOBILE_TLS_CERTIFICATE_KEY,
      privateKeyRef: HERMES_MOBILE_TLS_PRIVATE_KEY_REF,
      auditPrefix: 'hermes.mobile.tls',
      commonName: 'OPC-Nexus Hermes Mobile Gateway'
    });
    this.resolveTls = options.resolveTls ?? ((config) => ensureHermesMobileTlsIdentity(identities, config));
    this.now = options.now ?? Date.now;
    this.traceSink = options.trace;
    this.configured = this.loadConfigured();
  }

  getProjectStatus(projectId: string): HermesMobileAccessStatus {
    const activeRoutes = [...this.entries.values()]
      .filter((entry) => entry.projectId === projectId
        && entry.gateway.getStatus().running
        && this.services.isUiAvailable(entry.projectId))
      .map((entry) => {
        const status = entry.gateway.getStatus();
        return {
          runtimeId: entry.runtimeId,
          origin: status.origin ?? ''
        };
      })
      .filter((route) => route.origin.length > 0);
    const lastError = [...this.entries.values()]
      .filter((entry) => entry.projectId === projectId)
      .map((entry) => entry.gateway.getStatus().lastError)
      .map((value) => value ? hermesMobileError(value).message : null)
      .find((value): value is string => typeof value === 'string' && value.length > 0) ?? null;
    return {
      projectId,
      configured: this.configured ? { ...this.configured } : null,
      running: activeRoutes.length > 0,
      activeRoutes,
      lastError
    };
  }

  async createPairing(
    projectId: string,
    input?: HermesMobileLanConfigInput
  ): Promise<HermesMobileRoute> {
    const status = this.services.getStatus(projectId);
    if (status.state !== 'healthy' || !status.uiUrl) {
      throw new Error('Hermes project service must be healthy before creating mobile pairing');
    }
    if (input) {
      let next: SecureLanGatewayConfig;
      try { next = normalizeSecureLanGatewayConfig(input); }
      catch (error) { throw hermesMobileError(error); }
      if (!this.sameConfig(this.configured, next)) await this.stopAll();
      this.configured = next;
      this.db.setSetting(HERMES_MOBILE_CONFIG_KEY, next);
    }
    const config = this.configured;
    if (!config) throw new Error('请先在 Quest 手机 Web 面板选择局域网地址');
    const otherProjects = new Set(
      [...this.entries.values()]
        .filter((entry) => entry.projectId !== projectId)
        .map((entry) => entry.projectId)
    );
    await Promise.all([...otherProjects].map((otherProjectId) => this.stopProject(otherProjectId)));
    const key = projectId;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = this.createEntry(projectId);
      this.entries.set(key, entry);
      try {
        const tls = await this.resolveTls(config);
        await entry.gateway.start({
          bindHost: config.bindHost,
          port: config.port,
          publicHost: config.publicHost,
          publicPort: config.publicPort,
          tls
        });
      } catch (error) {
        this.entries.delete(key);
        await entry.gateway.stop().catch(() => undefined);
        const code = error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code ?? '')
          : '';
        if (code === 'EADDRNOTAVAIL') {
          throw new Error(`局域网地址 ${config.bindHost} 已失效，请重新检测并选择当前网卡地址`);
        }
        throw hermesMobileError(error);
      }
    }
    this.refreshUpstream(entry);
    const offer = entry.gateway.createPairingOffer('operator');
    const pairingId = `hermes-mobile-${randomUUID()}`;
    this.audit('hermes.mobile.pairing.create', projectId, `chat:${pairingId}`);
    return {
      projectId,
      pairingId,
      runtimeId: offer.runtimeId,
      origin: offer.origin,
      pairingUrl: offer.pairingUrl,
      code: offer.code,
      expiresAt: offer.expiresAt,
      certificateFingerprint: offer.certificateFingerprint
    };
  }

  async stopProject(projectId: string): Promise<void> {
    const matching = [...this.entries.entries()].filter(([, entry]) => entry.projectId === projectId);
    for (const [key, entry] of matching) {
      this.entries.delete(key);
      if (entry.lease) this.services.revokeUiLease(projectId, entry.lease.leaseId);
      await entry.gateway.stop();
    }
    if (matching.length > 0) this.audit('hermes.mobile.stop', projectId, 'revoked');
  }

  async shutdown(): Promise<void> {
    await this.stopAll();
  }

  private loadConfigured(): SecureLanGatewayConfig | null {
    const stored = this.db.getSetting<unknown>(HERMES_MOBILE_CONFIG_KEY, null);
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      try { return normalizeSecureLanGatewayConfig(stored as HermesMobileLanConfigInput); } catch { return null; }
    }
    // Hermes mobile access has its own project-scoped configuration and never
    // inherits a generic or historical pairing state.
    return null;
  }

  private sameConfig(left: SecureLanGatewayConfig | null, right: SecureLanGatewayConfig): boolean {
    return left !== null
      && left.bindHost === right.bindHost
      && left.port === right.port
      && left.publicHost === right.publicHost
      && left.publicPort === right.publicPort;
  }

  private async stopAll(): Promise<void> {
    const projects = new Set([...this.entries.values()].map((entry) => entry.projectId));
    await Promise.all([...projects].map((projectId) => this.stopProject(projectId)));
  }

  private createEntry(projectId: string): MobileGatewayEntry {
    const runtimeId = `hermes-project:${projectId}:chat`;
    const entry: MobileGatewayEntry = {
      projectId, runtimeId, lease: null, leaseCookie: null, proxyUrl: null,
      gateway: null as unknown as SecureLanGateway
    };
    entry.gateway = new SecureLanGateway({
      runtimeId,
      pairingRedirectPath: '/chat',
      // Hermes mobile sessions use a dedicated cookie namespace even though
      // the audited LAN transport is shared infrastructure.
      sessionCookieName: '__Host-opc_hermes_mobile',
      csrfCookieName: '__Host-opc_hermes_csrf',
      resolveUpstream: () => this.refreshUpstream(entry),
      resolveUpstreamHeaders: () => {
        const upstream = this.refreshUpstream(entry);
        return upstream && entry.leaseCookie
          ? { cookie: entry.leaseCookie, origin: upstream, referer: `${upstream}/` }
          : null;
      },
      resolvePolicy: (context) => hermesMobileRoutePolicy(runtimeId, context),
      limits: { maxBodyBytes: 32 * 1024 * 1024 },
      trace: (event) => {
        try { this.traceSink?.(projectId, event); } catch { /* diagnostics must not affect transport */ }
      },
      audit: (event) => this.audit(
        `hermes.mobile.${event.action}`,
        projectId,
        `${event.result}:${event.role ?? 'anonymous'}:${event.pathname ?? ''}`
      )
    });
    return entry;
  }

  private refreshUpstream(entry: MobileGatewayEntry): string | null {
    const status = this.services.getStatus(entry.projectId);
    if (status.state !== 'healthy' || !status.uiUrl || !this.services.isUiAvailable(entry.projectId)) return null;
    const leaseStale = !entry.lease
      || entry.lease.expiresAt <= this.now() + 60_000
      || entry.proxyUrl !== status.uiUrl;
    if (leaseStale) {
      if (entry.lease) this.services.revokeUiLease(entry.projectId, entry.lease.leaseId);
      const lease = this.services.createMobileLease(entry.projectId, 'operator');
      const cookie = this.services.cookieForLease(entry.projectId, lease);
      entry.lease = lease;
      entry.leaseCookie = `${cookie.name}=${encodeURIComponent(cookie.value)}`;
      entry.proxyUrl = status.uiUrl;
    }
    return entry.proxyUrl;
  }

  private audit(action: string, target: string, result: string): void {
    try {
      this.db.audit({ id: randomUUID(), actor: 'admin', action, target, result, source: 'hermes-mobile' });
    } catch {
      // Revocation and route denial must not depend on observability storage.
    }
  }
}
