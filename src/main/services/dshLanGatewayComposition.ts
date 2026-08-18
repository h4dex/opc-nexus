import type { Database } from './database.js';
import {
  DshLanGateway,
  type DshLanGatewayStatus,
  type DshLanPairingOffer,
  type DshLanRole,
  type DshLanRouteContext,
  type DshLanRoutePolicy,
  type DshLanRpcMethodPolicy,
  type DshLanRpcAuthorizationContext
} from './dshLanGateway.js';
import {
  DshLanGatewayController,
  dshLanAuthorityForConfig,
  type DshLanGatewayConfigInput,
  type DshLanGatewayControllerStatus
} from './dshLanGatewayController.js';
import { isDshManagedProfileId } from './deepseekHarnessManagedRuntime.js';
import {
  DshSupervisor,
  type DshRuntimeStatus
} from './dshSupervisor.js';
import { normalizeDshUpstreamEndpoint } from './dshWebGateway.js';
import { DshSessionService } from './dshSessionService.js';
import {
  DSH_BROWSER_SESSION_WRITE_METHODS,
  DshSessionWriteCoordinator
} from './dshSessionWriteCoordinator.js';

/** Stable scope used by the LAN edge. The bound Agent/profile is tracked separately. */
export const DSH_LAN_RUNTIME_ID = 'opc-nexus-dsh-managed-web';

const READ_METHODS = [
  'session.list',
  'session.search',
  'session.history',
  'session.models',
  'subagent.list',
  'subagent.history',
  'host.describe',
  'workspace.list',
  'skill.list',
  'agentPreset.list',
  'llm.providers',
  'llm.models'
] as const;

const OPERATOR_METHODS = [
  'session.create',
  'session.rename',
  'session.fork',
  'session.prompt',
  'session.attachment',
  'session.updateQueue',
  'session.cancel',
  'subagent.prompt',
  'subagent.interrupt',
  'workspace.create',
  'workspace.rename',
  'workspace.delete',
  'workspace.insertBefore',
  'workspace.insertSessionBefore',
  'workspace.archiveSession'
] as const;

/**
 * Methods that the fixed rc.6 browser client actually exposes. Mutating
 * settings, credentials, native file dialogs and model discovery are omitted
 * deliberately: the upstream package itself classifies those as loopback-only
 * and a LAN pairing is not a substitute for local operator approval.
 */
const REMOTE_METHOD_POLICIES: Readonly<Record<string, DshLanRpcMethodPolicy>> = Object.freeze(
  Object.fromEntries([
    ...READ_METHODS.map((method) => [method, {
      roles: ['viewer', 'operator'] as const,
      rateLimitBucket: 'read' as const
    }]),
    ...OPERATOR_METHODS.map((method) => [method, {
      roles: ['operator'] as const,
      rateLimitBucket: method === 'session.prompt' || method === 'subagent.prompt'
        ? 'prompt' as const
        : 'control' as const
    }])
  ])
) as Readonly<Record<string, DshLanRpcMethodPolicy>>;

const RESPOND_POLICY: Readonly<Record<string, DshLanRpcMethodPolicy>> = Object.freeze({
  respond: { roles: ['operator'], rateLimitBucket: 'control' }
});

const STATIC_ASSET = /\.(?:css|js|mjs|map|json|html|ico|png|jpe?g|gif|webp|svg|woff2?|ttf|txt|webmanifest)$/i;
const SPA_ROUTE = /^\/(?:session|sessions|settings|goals|workspace|workspaces|subagents|skills|agent-presets|about)(?:\/|$)/;

export interface DshLanBoundRuntime {
  agentId: string;
  profileId: string;
  endpoint: string;
}

export interface DshLanGatewayCompositionStatus extends DshLanGatewayControllerStatus {
  boundRuntime: DshLanBoundRuntime | null;
  eligibleRuntimeCount: number;
}

export interface DshLanGatewayCompositionOptions {
  runtimeId?: string;
  gateway?: DshLanGateway;
  controller?: DshLanGatewayController;
  sessions?: DshSessionService;
  /** Optional adapter extension, constrained by the fixed route contract. */
  resolvePolicy?: (context: DshLanRouteContext) => DshLanRoutePolicy | null;
}

function endpointFor(status: DshRuntimeStatus): string | null {
  if (!status.endpoint) return null;
  try {
    const endpoint = normalizeDshUpstreamEndpoint(status.endpoint);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1'
      || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) return null;
    return endpoint.origin;
  } catch {
    return null;
  }
}

function isSafeWebPath(pathname: string): boolean {
  if (!pathname || pathname.length > 2048 || pathname.includes('..') || /[\u0000-\u001f\u007f]/.test(pathname)) return false;
  // Every upstream API path must be admitted by the explicit RPC allowlist
  // below.  Do this before the asset suffix check so a future `/api/*.json`
  // endpoint cannot be exposed merely because it looks like a static file.
  if (pathname === '/api' || pathname.startsWith('/api/')) return false;
  if (pathname === '/' || pathname === '/favicon.ico' || pathname === '/manifest.webmanifest') return true;
  return STATIC_ASSET.test(pathname) || SPA_ROUTE.test(pathname);
}

function methodNameFromPath(pathname: string): string | null {
  if (!pathname.startsWith('/api/')) return null;
  const method = pathname.slice('/api/'.length);
  if (!method || method.includes('/') || !/^[A-Za-z0-9._~-]+$/.test(method)) return null;
  return method;
}

/**
 * Version-pinned route contract for the managed DSH Web UI.
 *
 * Exported as a pure policy helper so the allowlist can be regression-tested
 * without opening a listener or depending on a particular DSH process.
 */
export function fixedRoutePolicy(
  runtimeId: string,
  context: DshLanRouteContext
): DshLanRoutePolicy | null {
  if (context.runtimeId !== runtimeId) return null;
  if (context.websocket) {
    if (context.method !== 'GET') return null;
    if (context.pathname !== '/api/events.mux' && context.pathname !== '/api/events.host') return null;
    return {
      kind: 'websocket',
      runtimeId,
      roles: ['viewer', 'operator'],
      rateLimitBucket: 'stream',
      // DSH's event sockets are explicitly downlink-only in rc.6. Keeping
      // clientRpc undefined prevents a LAN browser from smuggling commands
      // over a channel intended only for event frames.
      allowedSubprotocols: []
    };
  }

  const method = context.method.toUpperCase();
  const rpcMethod = methodNameFromPath(context.pathname);
  if (rpcMethod === 'respond') {
    return {
      kind: 'rpc', runtimeId, methods: ['POST'], roles: ['operator'],
      rateLimitBucket: 'control', maxBodyBytes: 2 * 1024 * 1024,
      rpc: {
        methods: RESPOND_POLICY,
        // /api/respond carries a server-request envelope rather than the
        // regular client-request method field.
        extractMethods: () => ['respond']
      }
    };
  }
  if (rpcMethod && Object.prototype.hasOwnProperty.call(REMOTE_METHOD_POLICIES, rpcMethod)) {
    return {
      kind: 'rpc', runtimeId, methods: ['POST'], roles: ['viewer', 'operator'],
      rateLimitBucket: 'control', maxBodyBytes: 8 * 1024 * 1024,
      rpc: { methods: REMOTE_METHOD_POLICIES }
    };
  }
  if ((method === 'GET' || method === 'HEAD') && isSafeWebPath(context.pathname)) {
    return { kind: 'web', runtimeId, methods: ['GET', 'HEAD'], roles: ['viewer', 'operator'], rateLimitBucket: 'read' };
  }
  return null;
}

function auditDatabase(db: Database, event: { action: string; result: string; runtimeId: string; reason?: string; pathname?: string }): void {
  try {
    db.audit({
      id: `dsh-lan-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      actor: 'lan',
      action: event.action,
      target: event.pathname ?? event.runtimeId,
      result: event.reason ? `${event.result}:${event.reason}` : event.result,
      source: 'dsh-lan-gateway'
    });
  } catch {
    // Observability must never turn a deny or emergency stop into a crash.
  }
}

/**
 * Composes the persistent LAN controller with Supervisor health. It owns the
 * binding decision, while DshLanGateway remains a deliberately generic edge.
 */
export class DshLanGatewayComposition {
  readonly gateway: DshLanGateway;
  readonly controller: DshLanGatewayController;

  private readonly runtimeId: string;
  private readonly supervisor: DshSupervisor;
  private readonly db: Database;
  private readonly policyOverride?: DshLanGatewayCompositionOptions['resolvePolicy'];
  private unsubscribe: (() => void) | null = null;
  private binding: DshLanBoundRuntime | null = null;
  private preferredRuntime: Pick<DshLanBoundRuntime, 'agentId' | 'profileId'> | null = null;
  private lastError: string | null = null;
  private eligibleRuntimeCount = 0;
  private reconcilePromise: Promise<void> = Promise.resolve();
  private readonly writes: DshSessionWriteCoordinator;

  constructor(db: Database, supervisor: DshSupervisor, options: DshLanGatewayCompositionOptions = {}) {
    this.db = db;
    this.supervisor = supervisor;
    this.runtimeId = options.runtimeId ?? DSH_LAN_RUNTIME_ID;
    this.policyOverride = options.resolvePolicy;
    this.writes = new DshSessionWriteCoordinator(options.sessions ?? new DshSessionService(db), 'LAN');
    this.gateway = options.gateway ?? new DshLanGateway({
      runtimeId: this.runtimeId,
      resolveUpstream: (runtimeId) => this.resolveUpstream(runtimeId),
      resolvePolicy: (context) => this.resolvePolicy(context),
      audit: (event) => auditDatabase(db, event),
      onSessionRevoked: (sessionId) => this.writes.releaseClient(sessionId)
    });
    this.controller = options.controller ?? new DshLanGatewayController(db, this.gateway);
    this.unsubscribe = supervisor.subscribe(() => { void this.scheduleReconcile(); });
  }

  getStatus(): DshLanGatewayCompositionStatus {
    const controllerStatus = this.controller.getStatus();
    return {
      ...controllerStatus,
      // Keep binding/reconciliation failures visible even when the underlying
      // controller itself is healthy and has no lastError of its own.
      lastError: this.lastError ?? controllerStatus.lastError,
      boundRuntime: this.binding ? { ...this.binding } : null,
      eligibleRuntimeCount: this.eligibleRuntimeCount
    };
  }

  getTrustedAuthorities(): readonly string[] {
    return this.controller.getTrustedAuthorities();
  }

  async restoreOnStartup(): Promise<DshLanGatewayCompositionStatus> {
    await this.scheduleReconcile();
    return this.getStatus();
  }

  /** Persist intent even when no runtime is currently eligible. */
  async start(input: DshLanGatewayConfigInput): Promise<DshLanGatewayCompositionStatus> {
    this.controller.rememberEnabledIntent(input);
    this.lastError = null;
    await this.scheduleReconcile(true);
    return this.getStatus();
  }

  createPairingCode(role: DshLanRole = 'operator'): DshLanPairingOffer {
    if (!this.binding || !this.gateway.getStatus().running) throw new Error('DSH LAN Gateway is waiting for a healthy managed runtime');
    return this.controller.createPairingCode(role);
  }

  /** Select the project runtime exposed by the next Quest mobile pairing. */
  async selectRuntime(agentId: string, profileId: string): Promise<DshLanGatewayCompositionStatus> {
    if (!agentId || !isDshManagedProfileId(profileId)) throw new Error('DSH LAN runtime selection is invalid');
    this.preferredRuntime = { agentId, profileId };
    this.lastError = null;
    await this.scheduleReconcile();
    return this.getStatus();
  }

  async emergencyStop(): Promise<DshLanGatewayCompositionStatus> {
    await this.controller.emergencyStop();
    this.writes.releaseAll();
    this.binding = null;
    this.lastError = null;
    return this.getStatus();
  }

  async shutdown(): Promise<DshLanGatewayCompositionStatus> {
    await this.controller.shutdown();
    this.writes.releaseAll();
    this.binding = null;
    return this.getStatus();
  }

  async resetCertificate(): Promise<DshLanGatewayCompositionStatus> {
    await this.controller.resetCertificate();
    this.writes.releaseAll();
    this.binding = null;
    this.lastError = null;
    return this.getStatus();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private eligibleRuntimes(): DshRuntimeStatus[] {
    const values = this.supervisor.listStatuses().filter((status) =>
      isDshManagedProfileId(status.profileId)
      && status.processState === 'READY'
      && endpointFor(status) !== null
    );
    this.eligibleRuntimeCount = values.length;
    return values;
  }

  private resolveUpstream(runtimeId: string): string | null {
    if (runtimeId !== this.runtimeId || !this.binding) return null;
    const status = this.supervisor.getStatus(this.binding.agentId, this.binding.profileId);
    const endpoint = status ? endpointFor(status) : null;
    if (!status || status.processState !== 'READY' || endpoint !== this.binding.endpoint) return null;
    return endpoint;
  }

  private resolvePolicy(context: DshLanRouteContext): DshLanRoutePolicy | null {
    if (!this.binding || !this.resolveUpstream(context.runtimeId)) return null;
    const policy = this.policyOverride?.(context) ?? fixedRoutePolicy(this.runtimeId, context);
    return this.withSessionWriteGuard(policy);
  }

  private withSessionWriteGuard(policy: DshLanRoutePolicy | null): DshLanRoutePolicy | null {
    if (!policy || policy.kind !== 'rpc' || !policy.rpc || !this.binding) return policy;
    const methods = Object.fromEntries(Object.entries(policy.rpc.methods).map(([method, methodPolicy]) => {
      if (!DSH_BROWSER_SESSION_WRITE_METHODS.has(method)) return [method, methodPolicy];
      const existing = methodPolicy.authorize;
      return [method, {
        ...methodPolicy,
        authorize: async (context: DshLanRpcAuthorizationContext) => {
          if (existing && !await existing(context)) return false;
          const binding = this.binding;
          if (!binding || context.role !== 'operator') return false;
          try {
            this.writes.claim({
              clientSessionId: context.sessionId,
              agentId: binding.agentId,
              method,
              payload: context.payload
            });
            return true;
          } catch {
            return false;
          }
        },
        onForwarded: async (context: DshLanRpcAuthorizationContext) => {
          try {
            if ((context.statusCode ?? 502) >= 200 && (context.statusCode ?? 502) < 400) {
              this.writes.complete(context.sessionId, context.method, context.payload);
            } else {
              this.writes.fail(context.sessionId, context.method, context.payload, `DSH upstream returned HTTP ${context.statusCode ?? 502}`);
            }
          } catch { /* receipt may already be closed after an edge race */ }
        }
      }];
    }));
    return { ...policy, rpc: { ...policy.rpc, methods } };
  }

  private async scheduleReconcile(restartForTrustedAuthority = false): Promise<void> {
    const next = this.reconcilePromise.then(
      () => this.reconcile(restartForTrustedAuthority),
      () => this.reconcile(restartForTrustedAuthority)
    );
    this.reconcilePromise = next.catch(() => undefined);
    await next;
  }

  private async reconcile(restartForTrustedAuthority = false): Promise<void> {
    const eligible = this.eligibleRuntimes();
    const candidates = this.preferredRuntime
      ? eligible.filter((runtime) => runtime.agentId === this.preferredRuntime!.agentId
        && runtime.profileId === this.preferredRuntime!.profileId)
      : eligible;
    const current = this.controller.getStatus();
    const desired = current.desiredEnabled && current.configured !== null;
    if (candidates.length !== 1) {
      if (this.gateway.getStatus().running) await this.controller.shutdown();
      this.binding = null;
      this.lastError = desired
        ? candidates.length === 0
          ? 'DSH LAN Gateway is waiting for the managed runtime to become READY'
          : 'DSH LAN Gateway has multiple managed runtimes; select a Quest project'
        : null;
      return;
    }

    let candidate = candidates[0]!;
    let endpoint = endpointFor(candidate)!;
    let nextBinding: DshLanBoundRuntime = {
      agentId: candidate.agentId,
      profileId: candidate.profileId,
      endpoint
    };
    if (this.binding && (this.binding.agentId !== nextBinding.agentId
      || this.binding.profileId !== nextBinding.profileId
      || this.binding.endpoint !== nextBinding.endpoint)) {
      if (this.gateway.getStatus().running) await this.controller.shutdown();
      this.binding = null;
    }
    if (!desired) {
      if (this.gateway.getStatus().running) await this.controller.shutdown();
      this.binding = null;
      this.lastError = null;
      return;
    }

    const config = current.configured!;
    const authority = dshLanAuthorityForConfig(config);
    let trusted = false;
    try { trusted = this.supervisor.hasTrustedAuthority(candidate.agentId, candidate.profileId, authority); } catch { trusted = false; }
    if (!trusted && restartForTrustedAuthority) {
      if (this.gateway.getStatus().running) await this.controller.shutdown();
      this.binding = null;
      this.lastError = 'Restarting DSH runtime to apply the LAN trusted authority';
      auditDatabase(this.db, {
        action: 'runtime.trusted-authority.restart',
        result: 'requested',
        runtimeId: this.runtimeId
      });
      try {
        await this.supervisor.stop(candidate.agentId, candidate.profileId);
        candidate = await this.supervisor.start({
          agentId: candidate.agentId,
          profileId: candidate.profileId,
          workspace: candidate.workspace
        });
        endpoint = endpointFor(candidate) ?? '';
        trusted = candidate.processState === 'READY'
          && endpoint.length > 0
          && this.supervisor.hasTrustedAuthority(candidate.agentId, candidate.profileId, authority);
        if (trusted) {
          nextBinding = {
            agentId: candidate.agentId,
            profileId: candidate.profileId,
            endpoint
          };
          auditDatabase(this.db, {
            action: 'runtime.trusted-authority.restart',
            result: 'ok',
            runtimeId: this.runtimeId
          });
        }
      } catch {
        trusted = false;
        auditDatabase(this.db, {
          action: 'runtime.trusted-authority.restart',
          result: 'failed',
          runtimeId: this.runtimeId
        });
      }
    }
    if (!trusted) {
      if (this.gateway.getStatus().running) await this.controller.shutdown();
      this.binding = nextBinding;
      this.lastError = restartForTrustedAuthority
        ? 'DSH runtime could not apply the LAN trusted authority after restart'
        : 'DSH runtime must be restarted once to apply the LAN trusted authority';
      return;
    }

    const activeGateway = this.gateway.getStatus();
    if (activeGateway.running && (
      activeGateway.bindHost !== config.bindHost
      || activeGateway.port !== config.port
      || activeGateway.authority !== authority
    )) {
      // Configuration intent is persisted before reconciliation. Revoke the
      // old listener and its sessions before restoring the new endpoint so a
      // healthy runtime cannot leave the active edge on stale bind settings.
      await this.controller.shutdown();
    }

    this.binding = nextBinding;
    if (!this.gateway.getStatus().running) {
      try {
        await this.controller.restoreOnStartup();
        this.lastError = null;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : 'DSH LAN Gateway restore failed';
        this.binding = null;
      }
    }
  }
}
