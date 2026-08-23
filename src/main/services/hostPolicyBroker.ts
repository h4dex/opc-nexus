import { randomUUID } from 'node:crypto';

export const HOST_POLICY_CAPABILITIES = [
  'fs.read',
  'fs.write',
  'process.exec',
  'network.fetch',
  'package.install',
  'secret.use',
  'destructive',
  'delegate',
  'external_message',
  'artifact.publish'
] as const;

export type HostPolicyCapability = typeof HOST_POLICY_CAPABILITIES[number];
export type HostPolicyEffect = 'allow' | 'deny' | 'require_approval';

export interface HostPolicyRuntimeScope {
  organizationId: string;
  runtimeId: string;
  agentId: string;
}

export interface HostPolicyRequest extends HostPolicyRuntimeScope {
  requestId: string;
  capability: HostPolicyCapability;
  target: string;
  operation?: string;
  sessionId?: string;
  taskId?: string;
  context?: Readonly<Record<string, unknown>>;
}

export type HostScopedPolicyRequest = Omit<HostPolicyRequest, keyof HostPolicyRuntimeScope>;

export interface HostPolicyResolution {
  effect: HostPolicyEffect;
  reasonCode: string;
  approvalId?: string;
}

export interface HostPolicyDecision extends HostPolicyResolution, HostPolicyRuntimeScope {
  decisionId: string;
  requestId: string;
  capability: HostPolicyCapability | null;
  decidedAt: number;
}

export interface HostPolicyAuditEvent extends HostPolicyRuntimeScope {
  timestamp: number;
  action: 'policy.decision';
  result: HostPolicyEffect;
  decisionId: string;
  requestId: string;
  capability: HostPolicyCapability | null;
  reasonCode: string;
  sessionId?: string;
  taskId?: string;
  approvalId?: string;
}

export type HostPolicyResolver = (
  request: Readonly<HostPolicyRequest>,
  signal: AbortSignal
) => HostPolicyResolution | null | Promise<HostPolicyResolution | null>;

export interface HostPolicyBrokerOptions {
  resolve?: HostPolicyResolver;
  audit?: (event: HostPolicyAuditEvent) => void;
  now?: () => number;
  decisionTimeoutMs?: number;
}

export interface HostScopedPolicyBroker {
  readonly scope: Readonly<HostPolicyRuntimeScope>;
  decide(request: HostScopedPolicyRequest): Promise<HostPolicyDecision>;
}

const CAPABILITY_SET = new Set<string>(HOST_POLICY_CAPABILITIES);
const MAX_ID_LENGTH = 256;
const MAX_TARGET_LENGTH = 16 * 1024;
const DEFAULT_DECISION_TIMEOUT_MS = 5_000;
const MAX_DECISION_TIMEOUT_MS = 60_000;
const REASON_CODE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()
    || value.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function optionalIdentity(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : identity(value, label);
}

function safeIdentity(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_ID_LENGTH) || 'unknown';
}

function safeProperty(value: unknown, key: string): unknown {
  try {
    return value !== null && value !== undefined && (typeof value === 'object' || typeof value === 'function')
      ? (value as Record<string, unknown>)[key]
      : undefined;
  } catch {
    return undefined;
  }
}

function decisionTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_DECISION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_DECISION_TIMEOUT_MS) {
    throw new Error('Invalid host policy decision timeout');
  }
  return timeout;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer && 'unref' in timer) timer.unref();
}

/**
 * Fail-closed decision boundary for host-governed runtime capabilities.
 *
 * The broker deliberately does not persist policy or mutate TaskStatus. A
 * trusted Nexus policy/ApprovalBroker adapter is injected as the resolver;
 * missing, failing, timing-out, or malformed resolvers always produce deny.
 */
export class HostPolicyBroker {
  private readonly resolver?: HostPolicyResolver;
  private readonly auditSink?: (event: HostPolicyAuditEvent) => void;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: HostPolicyBrokerOptions = {}) {
    this.resolver = options.resolve;
    this.auditSink = options.audit;
    this.now = options.now ?? Date.now;
    this.timeoutMs = decisionTimeout(options.decisionTimeoutMs);
  }

  scopeRuntime(scope: HostPolicyRuntimeScope): HostScopedPolicyBroker {
    const normalized = Object.freeze(this.validateScope(scope));
    return Object.freeze({
      scope: normalized,
      decide: (request: HostScopedPolicyRequest) => this.decide({ ...request, ...normalized })
    });
  }

  async decide(input: HostPolicyRequest): Promise<HostPolicyDecision> {
    const decidedAt = this.now();
    const decisionId = randomUUID();
    let request: Readonly<HostPolicyRequest>;
    try {
      request = this.validateRequest(input);
    } catch {
      return this.finishDenied(input, decisionId, decidedAt, 'invalid_request');
    }

    if (!this.resolver) {
      return this.finish(request, decisionId, decidedAt, {
        effect: 'deny', reasonCode: 'policy_resolver_unavailable'
      });
    }

    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve(null);
      }, this.timeoutMs);
      unrefTimer(timer);
    });

    let resolution: HostPolicyResolution | null = null;
    let resolverFailed = false;
    try {
      let resolverPromise: Promise<HostPolicyResolution | null>;
      try {
        resolverPromise = Promise.resolve(this.resolver(request, controller.signal));
      } catch {
        resolverFailed = true;
        resolverPromise = Promise.resolve(null);
      }
      resolution = await Promise.race([
        resolverPromise.catch(() => {
          resolverFailed = true;
          return null;
        }),
        timeout
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (timedOut) {
      return this.finish(request, decisionId, decidedAt, {
        effect: 'deny', reasonCode: 'policy_timeout'
      });
    }
    if (resolverFailed) {
      return this.finish(request, decisionId, decidedAt, {
        effect: 'deny', reasonCode: 'policy_resolver_error'
      });
    }
    const normalizedResolution = this.normalizeResolution(resolution);
    if (!normalizedResolution) {
      return this.finish(request, decisionId, decidedAt, {
        effect: 'deny', reasonCode: 'invalid_policy_decision'
      });
    }
    return this.finish(request, decisionId, decidedAt, normalizedResolution);
  }

  private validateScope(scope: HostPolicyRuntimeScope): HostPolicyRuntimeScope {
    return {
      organizationId: identity(scope.organizationId, 'organization id'),
      runtimeId: identity(scope.runtimeId, 'runtime id'),
      agentId: identity(scope.agentId, 'agent id')
    };
  }

  private validateRequest(input: HostPolicyRequest): Readonly<HostPolicyRequest> {
    const scope = this.validateScope(input);
    const requestId = identity(input.requestId, 'request id');
    if (typeof input.capability !== 'string' || !CAPABILITY_SET.has(input.capability)) {
      throw new Error('Invalid host capability');
    }
    if (typeof input.target !== 'string' || input.target.trim().length === 0
      || input.target.length > MAX_TARGET_LENGTH || input.target.includes('\u0000')) {
      throw new Error('Invalid host capability target');
    }
    if (input.context !== undefined
      && (!input.context || typeof input.context !== 'object' || Array.isArray(input.context))) {
      throw new Error('Invalid host capability context');
    }
    const context = input.context === undefined ? undefined : Object.freeze({ ...input.context });
    return Object.freeze({
      ...scope,
      requestId,
      capability: input.capability,
      target: input.target,
      ...(input.operation === undefined
        ? {}
        : { operation: identity(input.operation, 'operation') }),
      ...(input.sessionId === undefined
        ? {}
        : { sessionId: optionalIdentity(input.sessionId, 'session id') }),
      ...(input.taskId === undefined
        ? {}
        : { taskId: optionalIdentity(input.taskId, 'task id') }),
      ...(context === undefined ? {} : { context })
    });
  }

  private normalizeResolution(value: unknown): HostPolicyResolution | null {
    try {
      if (!value || typeof value !== 'object') return null;
      const candidate = value as Record<string, unknown>;
      const effect = candidate.effect;
      const reasonCode = candidate.reasonCode;
      if ((effect !== 'allow' && effect !== 'deny' && effect !== 'require_approval')
        || typeof reasonCode !== 'string' || !REASON_CODE.test(reasonCode)) {
        return null;
      }
      if (effect === 'require_approval') {
        const approvalId = identity(candidate.approvalId, 'approval id');
        return Object.freeze({ effect, reasonCode, approvalId });
      }
      if (candidate.approvalId !== undefined) return null;
      return Object.freeze({ effect, reasonCode });
    } catch {
      return null;
    }
  }

  private finishDenied(
    input: HostPolicyRequest,
    decisionId: string,
    decidedAt: number,
    reasonCode: string
  ): HostPolicyDecision {
    const rawCapability = safeProperty(input, 'capability');
    const capability = typeof rawCapability === 'string' && CAPABILITY_SET.has(rawCapability)
      ? rawCapability as HostPolicyCapability
      : null;
    const decision: HostPolicyDecision = {
      decisionId,
      requestId: safeIdentity(safeProperty(input, 'requestId')),
      organizationId: safeIdentity(safeProperty(input, 'organizationId')),
      runtimeId: safeIdentity(safeProperty(input, 'runtimeId')),
      agentId: safeIdentity(safeProperty(input, 'agentId')),
      capability,
      effect: 'deny',
      reasonCode,
      decidedAt
    };
    this.audit(decision, {
      ...(typeof safeProperty(input, 'sessionId') === 'string'
        ? { sessionId: safeIdentity(safeProperty(input, 'sessionId')) } : {}),
      ...(typeof safeProperty(input, 'taskId') === 'string'
        ? { taskId: safeIdentity(safeProperty(input, 'taskId')) } : {})
    });
    return Object.freeze(decision);
  }

  private finish(
    request: Readonly<HostPolicyRequest>,
    decisionId: string,
    decidedAt: number,
    resolution: HostPolicyResolution
  ): HostPolicyDecision {
    const decision: HostPolicyDecision = {
      decisionId,
      requestId: request.requestId,
      organizationId: request.organizationId,
      runtimeId: request.runtimeId,
      agentId: request.agentId,
      capability: request.capability,
      effect: resolution.effect,
      reasonCode: resolution.reasonCode,
      ...(resolution.approvalId === undefined ? {} : { approvalId: resolution.approvalId }),
      decidedAt
    };
    const audited = this.audit(decision, {
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      ...(request.taskId === undefined ? {} : { taskId: request.taskId })
    });
    if (!audited && resolution.effect !== 'deny') {
      const fallback: HostPolicyDecision = {
        decisionId,
        requestId: request.requestId,
        organizationId: request.organizationId,
        runtimeId: request.runtimeId,
        agentId: request.agentId,
        capability: request.capability,
        effect: 'deny',
        reasonCode: 'audit_unavailable',
        decidedAt
      };
      // A failed audit must never turn an unrecorded approval into authority.
      return Object.freeze(fallback);
    }
    return Object.freeze(decision);
  }

  private audit(
    decision: HostPolicyDecision,
    context: Pick<HostPolicyAuditEvent, 'sessionId' | 'taskId'>
  ): boolean {
    if (!this.auditSink) return true;
    try {
      this.auditSink({
        timestamp: decision.decidedAt,
        action: 'policy.decision',
        result: decision.effect,
        decisionId: decision.decisionId,
        requestId: decision.requestId,
        organizationId: decision.organizationId,
        runtimeId: decision.runtimeId,
        agentId: decision.agentId,
        capability: decision.capability,
        reasonCode: decision.reasonCode,
        ...context,
        ...(decision.approvalId === undefined ? {} : { approvalId: decision.approvalId })
      });
      return true;
    } catch {
      // Audit failure must not turn a denied capability into an exception.
      return false;
    }
  }
}
