import { describe, expect, it, vi } from 'vitest';
import {
  HOST_POLICY_CAPABILITIES,
  HostPolicyBroker,
  type HostPolicyAuditEvent,
  type HostPolicyRequest
} from '../src/main/services/hostPolicyBroker.js';

const baseRequest: HostPolicyRequest = {
  requestId: 'request-1',
  organizationId: 'org-local',
  runtimeId: 'runtime-1',
  agentId: 'agent-1',
  sessionId: 'session-1',
  taskId: 'task-1',
  capability: 'fs.read',
  target: 'workspace/docs/plan.md'
};

describe('HostPolicyBroker', () => {
  it('recognizes the complete host capability vocabulary', async () => {
    const resolver = vi.fn(async () => ({ effect: 'allow' as const, reasonCode: 'profile_allowed' }));
    const broker = new HostPolicyBroker({ resolve: resolver, now: () => 123 });
    for (const capability of HOST_POLICY_CAPABILITIES) {
      const decision = await broker.decide({
        ...baseRequest,
        requestId: `request-${capability}`,
        capability
      });
      expect(decision).toMatchObject({ effect: 'allow', capability, reasonCode: 'profile_allowed' });
    }
    expect(resolver).toHaveBeenCalledTimes(HOST_POLICY_CAPABILITIES.length);
  });

  it('fails closed when no resolver is configured', async () => {
    const decision = await new HostPolicyBroker().decide(baseRequest);
    expect(decision).toMatchObject({
      effect: 'deny', reasonCode: 'policy_resolver_unavailable', capability: 'fs.read'
    });
  });

  it('fails closed on resolver errors, timeouts and malformed decisions', async () => {
    const errored = new HostPolicyBroker({ resolve: async () => { throw new Error('secret in error'); } });
    expect(await errored.decide(baseRequest)).toMatchObject({
      effect: 'deny', reasonCode: 'policy_resolver_error'
    });

    const syncErrored = new HostPolicyBroker({ resolve: () => { throw new Error('sync resolver error'); } });
    expect(await syncErrored.decide(baseRequest)).toMatchObject({
      effect: 'deny', reasonCode: 'policy_resolver_error'
    });

    const corruptRequest = {} as HostPolicyRequest;
    Object.defineProperty(corruptRequest, 'organizationId', {
      get: () => { throw new Error('corrupt request getter'); }
    });
    expect(await new HostPolicyBroker().decide(corruptRequest)).toMatchObject({
      effect: 'deny', reasonCode: 'invalid_request'
    });

    const timedOut = new HostPolicyBroker({
      decisionTimeoutMs: 5,
      resolve: () => new Promise(() => {})
    });
    expect(await timedOut.decide(baseRequest)).toMatchObject({
      effect: 'deny', reasonCode: 'policy_timeout'
    });

    const malformed = new HostPolicyBroker({
      resolve: async () => ({ effect: 'allow', reasonCode: 'contains secret plaintext and spaces' })
    });
    expect(await malformed.decide(baseRequest)).toMatchObject({
      effect: 'deny', reasonCode: 'invalid_policy_decision'
    });
  });

  it('treats unknown capabilities and malformed targets as denied input', async () => {
    const resolver = vi.fn(async () => ({ effect: 'allow' as const, reasonCode: 'allow' }));
    const broker = new HostPolicyBroker({ resolve: resolver });
    const unknown = await broker.decide({ ...baseRequest, capability: 'shell.root' } as never);
    const emptyTarget = await broker.decide({ ...baseRequest, target: '  ' });
    expect(unknown).toMatchObject({ effect: 'deny', reasonCode: 'invalid_request', capability: null });
    expect(emptyTarget).toMatchObject({ effect: 'deny', reasonCode: 'invalid_request' });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('requires a stable approval id for require_approval decisions', async () => {
    const approved = new HostPolicyBroker({
      resolve: async () => ({
        effect: 'require_approval', reasonCode: 'owner_confirmation', approvalId: 'approval-1'
      })
    });
    expect(await approved.decide({ ...baseRequest, capability: 'destructive' })).toMatchObject({
      effect: 'require_approval', reasonCode: 'owner_confirmation', approvalId: 'approval-1'
    });

    const missingId = new HostPolicyBroker({
      resolve: async () => ({ effect: 'require_approval', reasonCode: 'owner_confirmation' })
    });
    expect(await missingId.decide(baseRequest)).toMatchObject({
      effect: 'deny', reasonCode: 'invalid_policy_decision'
    });
  });

  it('binds scoped decisions to the trusted runtime instead of caller-supplied identity', async () => {
    let resolved: Readonly<HostPolicyRequest> | null = null;
    const broker = new HostPolicyBroker({
      resolve: async (request) => {
        resolved = request;
        return { effect: 'deny', reasonCode: 'profile_denied' };
      }
    });
    const scoped = broker.scopeRuntime({
      organizationId: 'org-trusted', runtimeId: 'runtime-trusted', agentId: 'agent-trusted'
    });
    const decision = await scoped.decide({
      requestId: 'request-scoped',
      capability: 'process.exec',
      target: 'npm test',
      runtimeId: 'runtime-attacker',
      agentId: 'agent-attacker'
    } as never);
    expect(resolved).toMatchObject({
      organizationId: 'org-trusted', runtimeId: 'runtime-trusted', agentId: 'agent-trusted'
    });
    expect(decision).toMatchObject({
      organizationId: 'org-trusted', runtimeId: 'runtime-trusted', agentId: 'agent-trusted'
    });
    expect(Object.isFrozen(scoped.scope)).toBe(true);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it('does not put sensitive target or context fields in audit events', async () => {
    const audits: HostPolicyAuditEvent[] = [];
    const secret = 'sk-sensitive-policy-context';
    let observedContext: Readonly<Record<string, unknown>> | undefined;
    const broker = new HostPolicyBroker({
      audit: (event) => audits.push(event),
      resolve: async (request) => {
        observedContext = request.context;
        return { effect: 'deny', reasonCode: 'secret_use_denied' };
      }
    });
    const decision = await broker.decide({
      ...baseRequest,
      capability: 'secret.use',
      target: `provider-ref:${secret}`,
      context: { suppliedCredential: secret }
    });
    expect(decision.effect).toBe('deny');
    expect(observedContext).toEqual({ suppliedCredential: secret });
    expect(Object.isFrozen(observedContext)).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(secret);
    expect(audits[0]).toMatchObject({
      action: 'policy.decision', result: 'deny', capability: 'secret.use',
      runtimeId: 'runtime-1', reasonCode: 'secret_use_denied'
    });
    expect(audits[0]).not.toHaveProperty('target');
    expect(audits[0]).not.toHaveProperty('context');
  });

  it('keeps fail-closed decisions effective when audit persistence fails', async () => {
    const broker = new HostPolicyBroker({
      audit: () => { throw new Error('audit unavailable'); },
      resolve: async () => ({ effect: 'deny', reasonCode: 'profile_denied' })
    });
    await expect(broker.decide(baseRequest)).resolves.toMatchObject({
      effect: 'deny', reasonCode: 'profile_denied'
    });

    const allowBroker = new HostPolicyBroker({
      audit: () => { throw new Error('audit unavailable'); },
      resolve: async () => ({ effect: 'allow', reasonCode: 'profile_allowed' })
    });
    await expect(allowBroker.decide(baseRequest)).resolves.toMatchObject({
      effect: 'deny', reasonCode: 'audit_unavailable'
    });
  });
});
