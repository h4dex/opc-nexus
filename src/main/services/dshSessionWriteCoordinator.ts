import type { DshControlSurface } from '../../shared/types.js';
import {
  DshCommandConflictError,
  DshLeaseHeldError,
  DshRevisionConflictError,
  DshSessionService,
  type DshLeaseGrant,
  type DshSessionRecord
} from './dshSessionService.js';

const BROWSER_LEASE_TTL_MS = 5 * 60_000;
const BROWSER_LEASE_RENEW_INTERVAL_MS = Math.floor(BROWSER_LEASE_TTL_MS / 3);
const MAX_RPC_ID_LENGTH = 200;

/**
 * Mutating RPCs admitted by the desktop and LAN edges. Keeping the complete
 * set here prevents either transport from bypassing project-scoped policy.
 * Unscoped diagnostic sessions retain native DSH creation compatibility.
 */
export const DSH_BROWSER_SESSION_WRITE_METHODS = new Set<string>([
  'session.create',
  'session.selectModel',
  'session.rename',
  'session.fork',
  'session.prompt',
  'session.updateQueue',
  'session.cancel',
  'subagent.prompt',
  'subagent.interrupt',
  'agentPreset.select',
  'goal.create',
  'goal.edit',
  'goal.pause',
  'goal.resume',
  'goal.complete',
  'goal.clear',
  'workspace.create',
  'workspace.rename',
  'workspace.delete',
  'workspace.insertBefore',
  'workspace.insertSessionBefore',
  'workspace.archiveSession'
]);

const SCOPED_CREATION_METHODS = new Set([
  'session.create',
  'session.fork',
  'workspace.create'
]);

const SCOPED_GLOBAL_WORKSPACE_METHODS = new Set([
  'workspace.rename',
  'workspace.delete',
  'workspace.insertBefore'
]);

const METHODS_WITHOUT_EXISTING_SESSION = new Set([
  'session.create',
  'workspace.create',
  'workspace.rename',
  'workspace.delete',
  'workspace.insertBefore'
]);

type JsonObject = Record<string, unknown>;

export interface DshBrowserRpcContext {
  /** Opaque authenticated gateway session id. It never enters the browser URL. */
  clientSessionId: string;
  agentId: string;
  method: string;
  payload: unknown;
  /** Main-only Quest boundary associated with the authenticated browser cookie. */
  scope?: DshBrowserSessionScope | null;
}

export interface DshBrowserSessionScope {
  /** Browser-visible DSH id of the project root selected by Main. */
  rootUpstreamSessionId: string;
}

export interface DshBrowserRpcClaim {
  /** False means the upstream session is standalone and has no Nexus projection. */
  projected: boolean;
  localSessionId: string | null;
  commandId: string | null;
}

export type DshBrowserReadScopeDecision = 'allowed' | 'unknown' | 'denied' | 'unavailable';

export interface DshBrowserReadScopeContext {
  agentId: string;
  scope: DshBrowserSessionScope;
  upstreamSessionId: string;
}

/** A gateway only needs these methods; it never receives a bearer token. */
export interface DshBrowserWriteGuard {
  /** Main-only read boundary. Unknown means the upstream id is not projected yet. */
  checkReadScope?(context: DshBrowserReadScopeContext): DshBrowserReadScopeDecision;
  claim(context: DshBrowserRpcContext): DshBrowserRpcClaim;
  completeClaim(claim: DshBrowserRpcClaim, result: Record<string, unknown>): void;
  failClaim(claim: DshBrowserRpcClaim, error: string): void;
  /** Main-only handoff for an IPC-approved desktop takeover. */
  adoptLease?(sessionId: string, grant: DshLeaseGrant): void;
  releaseClient(clientSessionId: string): void;
  releaseAll(): void;
}

interface HeldLease {
  clientSessionId: string;
  localSessionId: string;
  principal: string;
  token: string;
  revision: number;
  renewTimer: NodeJS.Timeout | null;
}

interface PendingAdoption {
  grant: DshLeaseGrant;
  expiresAt: number;
}

function record(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function rpcEnvelope(value: unknown, expectedMethod: string): { rpcId: string; payload: JsonObject } {
  const envelope = record(value);
  const body = record(envelope?.payload);
  if (envelope?.type !== 'client-request'
    || envelope.method !== expectedMethod
    || typeof envelope.rpcId !== 'string'
    || envelope.rpcId.length < 1
    || envelope.rpcId.length > MAX_RPC_ID_LENGTH
    || /[\u0000-\u001f\u007f]/.test(envelope.rpcId)
    || !body) {
    throw new Error('DSH browser write RPC envelope is invalid');
  }
  return { rpcId: envelope.rpcId, payload: body };
}

function addressedUpstreamSessions(method: string, payload: JsonObject): string[] {
  const fields = method.startsWith('subagent.')
    ? ['childSessionId', 'parentSessionId']
    : method === 'workspace.insertSessionBefore'
      ? ['sessionId', 'beforeSessionId']
      : ['sessionId'];
  const values: string[] = [];
  for (const field of fields) {
    const value = payload[field];
    if (value === undefined && field === 'beforeSessionId') continue;
    if (typeof value !== 'string' || value.length < 1 || value.length > 500) {
      throw new Error(`DSH browser write RPC ${field} is invalid`);
    }
    if (!values.includes(value)) values.push(value);
  }
  return values;
}

function browserScope(value: DshBrowserSessionScope | null | undefined): DshBrowserSessionScope | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.rootUpstreamSessionId !== 'string'
    || value.rootUpstreamSessionId.length < 1
    || value.rootUpstreamSessionId.length > 500
    || /[\u0000-\u001f\u007f]/.test(value.rootUpstreamSessionId)) {
    throw new Error('DSH browser write admission scope is invalid');
  }
  return { rootUpstreamSessionId: value.rootUpstreamSessionId };
}

/**
 * Main-process-only bridge between an unmodified DSH browser client and the
 * durable Nexus single-writer boundary. Browser payloads keep the official
 * rc.6 schema: the coordinator owns every lease token and uses rpcId as the
 * idempotency key instead of exposing Nexus credentials to JavaScript.
 */
export class DshSessionWriteCoordinator {
  private readonly leases = new Map<string, HeldLease>();
  private readonly pendingAdoptions = new Map<string, PendingAdoption>();

  constructor(
    private readonly sessions: DshSessionService,
    private readonly surface: Extract<DshControlSurface, 'LAN' | 'DESKTOP'>
  ) {}

  checkReadScope(context: DshBrowserReadScopeContext): DshBrowserReadScopeDecision {
    const scope = browserScope(context.scope);
    if (!scope) return 'unavailable';
    const root = this.sessions.findSessionByUpstream(context.agentId, scope.rootUpstreamSessionId);
    if (!root || root.parentSessionId !== null || root.delegationDepth !== 0) return 'unavailable';

    const candidate = this.sessions.findSessionByUpstream(context.agentId, context.upstreamSessionId);
    if (!candidate) return 'unknown';
    try {
      this.assertWithinRoot(candidate, root);
      return 'allowed';
    } catch {
      return 'denied';
    }
  }

  claim(context: DshBrowserRpcContext): DshBrowserRpcClaim {
    const envelope = rpcEnvelope(context.payload, context.method);
    const scope = browserScope(context.scope);
    if (scope && SCOPED_CREATION_METHODS.has(context.method)) {
      throw new Error(`DSH scoped browser write admission denies ${context.method}`);
    }
    if (scope && SCOPED_GLOBAL_WORKSPACE_METHODS.has(context.method)) {
      throw new Error(`DSH scoped browser write admission denies global ${context.method}`);
    }
    if (METHODS_WITHOUT_EXISTING_SESSION.has(context.method)) {
      return { projected: false, localSessionId: null, commandId: null };
    }

    const addressed = addressedUpstreamSessions(context.method, envelope.payload);
    const resolved: Array<DshSessionRecord | null> = [];
    for (const upstreamSessionId of addressed) {
      resolved.push(this.sessions.findSessionByUpstream(context.agentId, upstreamSessionId));
    }
    const projected = resolved.filter((candidate): candidate is DshSessionRecord => candidate !== null);
    if (scope) {
      const root = this.sessions.findSessionByUpstream(context.agentId, scope.rootUpstreamSessionId);
      if (!root || root.parentSessionId !== null || root.delegationDepth !== 0) {
        throw new Error('DSH scoped browser write admission root is unavailable');
      }
      if (projected.length !== resolved.length) {
        throw new Error('DSH scoped browser write admission requires projected sessions');
      }
      for (const candidate of projected) this.assertWithinRoot(candidate, root);
    } else if (projected.length === 0) {
      return { projected: false, localSessionId: null, commandId: null };
    }
    if (projected.length !== resolved.length) {
      throw new Error('DSH browser write admission cannot mix projected and standalone sessions');
    }
    const localSessionIds = new Set(projected.map((candidate) => candidate.sessionId));
    if (!scope && localSessionIds.size !== 1) {
      throw new Error('DSH browser write admission cannot span multiple projected sessions');
    }
    const target = projected[0]!;

    const lease = this.ensureLease(context.clientSessionId, target);
    const claimed = this.sessions.claimCommand({
      commandId: envelope.rpcId,
      sessionId: target.sessionId,
      commandType: context.method,
      principal: lease.principal,
      leaseToken: lease.token,
      expectedRevision: lease.revision,
      payload: envelope.payload
    });
    if (claimed.duplicate) {
      // The official client cannot consume a cached Nexus receipt as a native
      // DSH response. Never forward a retry that could repeat an upstream write.
      throw new DshCommandConflictError('DSH browser command was already admitted; reconciliation is required');
    }
    lease.revision = claimed.receipt.appliedRevision;
    return { projected: true, localSessionId: target.sessionId, commandId: envelope.rpcId };
  }

  private assertWithinRoot(candidate: DshSessionRecord, root: DshSessionRecord): void {
    if (candidate.agentId !== root.agentId || candidate.runtimeInstanceId !== root.runtimeInstanceId) {
      throw new Error('DSH scoped browser write admission crossed the project runtime boundary');
    }

    let current = candidate;
    const visited = new Set<string>();
    for (let depth = 0; depth <= 128; depth += 1) {
      if (current.sessionId === root.sessionId) return;
      if (!current.parentSessionId || visited.has(current.sessionId)) break;
      visited.add(current.sessionId);
      const parent = this.sessions.findSession(current.parentSessionId);
      if (!parent
        || parent.agentId !== root.agentId
        || parent.runtimeInstanceId !== root.runtimeInstanceId) break;
      current = parent;
    }
    throw new Error('DSH scoped browser write admission crossed the project root boundary');
  }

  /**
   * Keep an IPC-approved takeover grant inside Main until the isolated
   * Workbench emits a projected write.  Takeover may be requested before the
   * window is opened, so binding it to a browser cookie at request time would
   * introduce an ordering race.
   */
  adoptLease(sessionId: string, grant: DshLeaseGrant): void {
    if (this.surface !== 'DESKTOP') throw new Error('Only the desktop coordinator can adopt a takeover grant');
    if (!grant || typeof grant !== 'object' || typeof grant.token !== 'string' || grant.token.length < 1) {
      throw new Error('DSH takeover grant is invalid');
    }
    const status = grant.status;
    if (!status || status.sessionId !== sessionId || !status.lease
      || status.lease.controller !== 'HUMAN' || status.lease.surface !== 'DESKTOP'
      || status.lease.expiresAt <= Date.now()) {
      throw new Error('DSH takeover grant is not an active desktop lease');
    }
    // A newer takeover supersedes an older pending grant. The old bearer never
    // leaves Main, and its durable lease is already replaced by the service.
    this.pendingAdoptions.set(sessionId, { grant, expiresAt: status.lease.expiresAt });
  }

  /** Complete only a command admitted by this coordinator. */
  completeClaim(claim: DshBrowserRpcClaim, result: Record<string, unknown>): void {
    if (!claim.projected || !claim.commandId) return;
    try {
      this.sessions.completeCommand(claim.commandId, result);
    } catch (error) {
      // A duplicate/late upstream response must never turn a successful proxy
      // request into a renderer-visible crash. The durable receipt remains the
      // source of truth and can be reconciled by the managed executor.
      if (!(error instanceof DshCommandConflictError)) throw error;
    }
  }

  /** Mark a request rejected by the upstream while retaining idempotency. */
  failClaim(claim: DshBrowserRpcClaim, error: string): void {
    if (!claim.projected || !claim.commandId) return;
    try {
      this.sessions.failCommand(claim.commandId, error.slice(0, 4000));
    } catch (failure) {
      if (!(failure instanceof DshCommandConflictError)) throw failure;
    }
  }

  complete(clientSessionId: string, method: string, value: unknown): void {
    const envelope = rpcEnvelope(value, method);
    const lease = this.findLease(clientSessionId, envelope.payload);
    if (!lease) return;
    this.sessions.completeCommand(envelope.rpcId, { forwarded: true });
  }

  fail(clientSessionId: string, method: string, value: unknown, error: unknown): void {
    const envelope = rpcEnvelope(value, method);
    const lease = this.findLease(clientSessionId, envelope.payload);
    if (!lease) return;
    const message = error instanceof Error ? error.message : String(error);
    this.sessions.failCommand(envelope.rpcId, message.slice(0, 4000));
  }

  releaseClient(clientSessionId: string): void {
    for (const [key, held] of [...this.leases]) {
      if (held.clientSessionId !== clientSessionId) continue;
      this.leases.delete(key);
      if (held.renewTimer) clearInterval(held.renewTimer);
      held.renewTimer = null;
      try {
        const status = this.sessions.getControlStatus(held.localSessionId);
        if (status.lease?.principal !== held.principal
          || status.lease.controller !== 'HUMAN'
          || status.lease.surface !== this.surface) continue;
        this.sessions.releaseLease({
          sessionId: held.localSessionId,
          token: held.token,
          expectedRevision: status.revision
        });
      } catch {
        // Logout/revocation must remain best effort. An expired or superseded
        // lease is already closed durably and must not crash gateway teardown.
      }
    }
  }

  releaseAll(): void {
    for (const clientSessionId of new Set([...this.leases.values()].map((lease) => lease.clientSessionId))) {
      this.releaseClient(clientSessionId);
    }
    this.pendingAdoptions.clear();
  }

  private ensureLease(clientSessionId: string, session: DshSessionRecord): HeldLease {
    const principal = `dsh-${this.surface.toLowerCase()}:${clientSessionId}`;
    const key = `${clientSessionId}\u0000${session.sessionId}`;
    const pending = this.pendingAdoptions.get(session.sessionId);
    if (pending) {
      this.pendingAdoptions.delete(session.sessionId);
      if (pending.expiresAt > Date.now()) {
        const status = this.sessions.getControlStatus(session.sessionId);
        const leaseView = status.lease;
        // Re-check the durable projection at bind time. This closes the
        // window where the takeover could expire or be replaced before the
        // browser sends its first write.
        if (status.revision === pending.grant.status.revision
          && leaseView
          && leaseView.controller === 'HUMAN'
          && leaseView.surface === 'DESKTOP'
          && leaseView.principal === pending.grant.status.lease?.principal
          && leaseView.expiresAt > Date.now()) {
          const adopted: HeldLease = {
            clientSessionId,
            localSessionId: session.sessionId,
            principal: leaseView.principal,
            token: pending.grant.token,
            revision: status.revision,
            renewTimer: null
          };
          this.startRenewal(adopted);
          this.leases.set(key, adopted);
          return adopted;
        }
      }
    }
    const existing = this.leases.get(key);
    let status = this.sessions.getControlStatus(session.sessionId);
    if (existing) {
      if (status.lease?.principal === principal
        && status.lease.controller === 'HUMAN'
        && status.lease.surface === this.surface) {
        existing.revision = status.revision;
        this.startRenewal(existing);
        return existing;
      }
      this.leases.delete(key);
      if (existing.renewTimer) clearInterval(existing.renewTimer);
      existing.renewTimer = null;
    }

    if (status.lease) throw new DshLeaseHeldError(status.lease);
    try {
      const grant = this.sessions.acquireLease({
        sessionId: session.sessionId,
        controller: 'HUMAN',
        surface: this.surface,
        principal,
        expectedRevision: status.revision,
        ttlMs: BROWSER_LEASE_TTL_MS
      });
      const held: HeldLease = {
        clientSessionId,
        localSessionId: session.sessionId,
        principal,
        token: grant.token,
        revision: grant.status.revision,
        renewTimer: null
      };
      this.startRenewal(held);
      this.leases.set(key, held);
      return held;
    } catch (error) {
      if (error instanceof DshRevisionConflictError) status = this.sessions.getControlStatus(session.sessionId);
      throw error;
    }
  }

  private findLease(clientSessionId: string, payload: JsonObject): HeldLease | null {
    const ids = Object.values(payload).filter((value): value is string => typeof value === 'string');
    for (const lease of this.leases.values()) {
      if (lease.clientSessionId !== clientSessionId) continue;
      if (ids.includes(lease.localSessionId)) return lease;
      const projected = this.sessions.findSession(lease.localSessionId);
      if (projected && ids.includes(projected.upstreamSessionId)) return lease;
    }
    return null;
  }

  private startRenewal(held: HeldLease): void {
    if (held.renewTimer) return;
    held.renewTimer = setInterval(() => {
      try {
        const grant = this.sessions.renewLease({
          sessionId: held.localSessionId,
          token: held.token,
          expectedRevision: held.revision,
          ttlMs: BROWSER_LEASE_TTL_MS
        });
        held.revision = grant.status.revision;
      } catch {
        // A takeover, expiry, or database restart closes this browser
        // capability. Do not retry with a stale token or revision.
        if (held.renewTimer) clearInterval(held.renewTimer);
        held.renewTimer = null;
      }
    }, BROWSER_LEASE_RENEW_INTERVAL_MS);
    held.renewTimer.unref?.();
  }
}
