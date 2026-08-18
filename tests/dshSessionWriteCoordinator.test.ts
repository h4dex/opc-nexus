import { describe, expect, it, vi } from 'vitest';
import { DshCommandConflictError, type DshLeaseGrant } from '../src/main/services/dshSessionService.js';
import type { DshControlStatusView } from '../src/shared/types.js';
import {
  DSH_BROWSER_SESSION_WRITE_METHODS,
  DshSessionWriteCoordinator
} from '../src/main/services/dshSessionWriteCoordinator.js';

function projectedSession(surface: 'LAN' | 'DESKTOP' = 'LAN') {
  return {
    sessionId: 'local-1', agentId: 'agent-1', conversationId: null,
    controlMode: 'NEXUS_MANAGED', revision: 4, lastEventCursor: -1, lease: null,
    upstreamSessionId: 'upstream-1', runtimeInstanceId: 'runtime-1',
    parentSessionId: null, delegationDepth: 0, workspace: '', createdAt: 1, updatedAt: 1
  } as never;
}

function fixture(surface: 'LAN' | 'DESKTOP' = 'LAN') {
  let revision = 4;
  let lease: { principal: string; controller: 'HUMAN'; surface: 'LAN' | 'DESKTOP'; token: string; revision: number; expiresAt?: number } | null = null;
  const sessions = {
    findSessionByUpstream: vi.fn(() => projectedSession(surface)),
    findSession: vi.fn(() => projectedSession(surface)),
    getControlStatus: vi.fn(() => ({ sessionId: 'local-1', agentId: 'agent-1', conversationId: null,
      controlMode: 'NEXUS_MANAGED', revision, lastEventCursor: -1, lease })),
    acquireLease: vi.fn(({ principal, expectedRevision }: { principal: string; expectedRevision: number }) => {
      expect(expectedRevision).toBe(revision);
      revision += 1;
      lease = { principal, controller: 'HUMAN', surface, token: 'main-only-token', revision, expiresAt: Date.now() + 60_000 };
      return { token: lease.token, status: { ...sessions.getControlStatus(), revision, lease } };
    }),
    claimCommand: vi.fn(({ expectedRevision }: { expectedRevision: number }) => {
      expect(expectedRevision).toBe(revision);
      revision += 1;
      if (sessions.claimCommand.mock.calls.length > 1) throw new DshCommandConflictError('duplicate');
      if (lease) lease.revision = revision;
      return { duplicate: false, receipt: { appliedRevision: revision } };
    }),
    completeCommand: vi.fn(),
    failCommand: vi.fn(),
    releaseLease: vi.fn()
  } as never;
  return { sessions, coordinator: new DshSessionWriteCoordinator(sessions, surface) };
}

const payload = (rpcId = 'rpc-1') => ({
  type: 'client-request', rpcId, method: 'session.prompt',
  payload: { sessionId: 'upstream-1', mode: 'queue', content: [{ type: 'text', text: 'hello' }] }
});

const rpc = (method: string, body: Record<string, unknown>, rpcId = `rpc-${method}`) => ({
  type: 'client-request', rpcId, method, payload: body
});

const questScope = { rootUpstreamSessionId: 'upstream-root' };

describe('DshSessionWriteCoordinator', () => {
  it('classifies scoped reads from the durable root lineage', () => {
    const { sessions, coordinator } = fixture('DESKTOP');
    const root = { ...projectedSession('DESKTOP'), sessionId: 'local-root', upstreamSessionId: 'upstream-root' };
    const child = {
      ...projectedSession('DESKTOP'), sessionId: 'local-child', upstreamSessionId: 'upstream-child',
      parentSessionId: root.sessionId, delegationDepth: 1
    };
    const grandchild = {
      ...projectedSession('DESKTOP'), sessionId: 'local-grandchild', upstreamSessionId: 'upstream-grandchild',
      parentSessionId: child.sessionId, delegationDepth: 2
    };
    const otherRoot = {
      ...projectedSession('DESKTOP'), sessionId: 'local-other', upstreamSessionId: 'upstream-other'
    };
    const wrongRuntime = {
      ...child, sessionId: 'local-wrong-runtime', upstreamSessionId: 'upstream-wrong-runtime',
      runtimeInstanceId: 'runtime-2'
    };
    const byUpstream = new Map([
      [root.upstreamSessionId, root], [child.upstreamSessionId, child],
      [grandchild.upstreamSessionId, grandchild], [otherRoot.upstreamSessionId, otherRoot],
      [wrongRuntime.upstreamSessionId, wrongRuntime]
    ]);
    const byLocal = new Map([
      [root.sessionId, root], [child.sessionId, child], [grandchild.sessionId, grandchild],
      [otherRoot.sessionId, otherRoot], [wrongRuntime.sessionId, wrongRuntime]
    ]);
    sessions.findSessionByUpstream.mockImplementation((_agentId: string, id: string) => byUpstream.get(id) ?? null);
    sessions.findSession.mockImplementation((id: string) => byLocal.get(id) ?? null);

    const decide = (upstreamSessionId: string) => coordinator.checkReadScope({
      agentId: 'agent-1', scope: questScope, upstreamSessionId
    });
    expect(decide(root.upstreamSessionId)).toBe('allowed');
    expect(decide(child.upstreamSessionId)).toBe('allowed');
    expect(decide(grandchild.upstreamSessionId)).toBe('allowed');
    expect(decide(otherRoot.upstreamSessionId)).toBe('denied');
    expect(decide(wrongRuntime.upstreamSessionId)).toBe('denied');
    expect(decide('upstream-unknown')).toBe('unknown');
    byUpstream.delete(root.upstreamSessionId);
    expect(decide(child.upstreamSessionId)).toBe('unavailable');
  });

  it('treats session.attachment as a scoped read rather than a leased write', () => {
    expect(DSH_BROWSER_SESSION_WRITE_METHODS.has('session.attachment')).toBe(false);
  });

  it('claims an official rc.6 prompt with a main-only lease and completes its receipt', () => {
    const { sessions, coordinator } = fixture();
    expect(coordinator.claim({ clientSessionId: 'browser-1', agentId: 'agent-1', method: 'session.prompt', payload: payload() }))
      .toMatchObject({ projected: true, localSessionId: 'local-1', commandId: 'rpc-1' });
    expect(sessions.acquireLease).toHaveBeenCalledWith(expect.objectContaining({ controller: 'HUMAN', surface: 'LAN' }));
    coordinator.complete('browser-1', 'session.prompt', payload());
    expect(sessions.completeCommand).toHaveBeenCalledWith('rpc-1', { forwarded: true });
    expect(JSON.stringify(sessions.acquireLease.mock.calls)).not.toContain('main-only-token');
  });

  it('fails closed on a repeated rpcId instead of forwarding a second write', () => {
    const { coordinator } = fixture();
    coordinator.claim({ clientSessionId: 'browser-1', agentId: 'agent-1', method: 'session.prompt', payload: payload() });
    expect(() => coordinator.claim({ clientSessionId: 'browser-1', agentId: 'agent-1', method: 'session.prompt', payload: payload() }))
      .toThrow(DshCommandConflictError);
  });

  it('does not impose a Nexus lease on a standalone/unprojected upstream session', () => {
    const { sessions, coordinator } = fixture();
    sessions.findSessionByUpstream.mockReturnValue(null);
    expect(coordinator.claim({ clientSessionId: 'browser-1', agentId: 'agent-1', method: 'session.prompt', payload: payload() }))
      .toEqual({ projected: false, localSessionId: null, commandId: null });
    expect(sessions.acquireLease).not.toHaveBeenCalled();
  });

  it('admits only the selected project root and its descendants for a scoped Quest', () => {
    const { sessions, coordinator } = fixture('DESKTOP');
    const root = {
      ...projectedSession('DESKTOP'),
      sessionId: 'local-root',
      upstreamSessionId: 'upstream-root'
    };
    const child = {
      ...projectedSession('DESKTOP'),
      sessionId: 'local-child',
      upstreamSessionId: 'upstream-child',
      parentSessionId: root.sessionId,
      delegationDepth: 1
    };
    sessions.findSessionByUpstream.mockImplementation((_agentId: string, upstreamSessionId: string) => (
      upstreamSessionId === root.upstreamSessionId
        ? root
        : upstreamSessionId === child.upstreamSessionId
          ? child
          : null
    ));
    sessions.findSession.mockImplementation((sessionId: string) => sessionId === root.sessionId ? root : null);

    expect(coordinator.claim({
      clientSessionId: 'desktop-quest', agentId: 'agent-1', method: 'subagent.prompt',
      scope: questScope,
      payload: rpc('subagent.prompt', {
        childSessionId: child.upstreamSessionId,
        parentSessionId: root.upstreamSessionId,
        mode: 'continuable',
        content: [{ type: 'text', text: 'continue' }]
      })
    })).toMatchObject({ projected: true, localSessionId: child.sessionId });
    expect(sessions.claimCommand).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: child.sessionId,
      commandType: 'subagent.prompt'
    }));
  });

  it('rejects another project root and an unprojected session from a scoped Quest', () => {
    const { sessions, coordinator } = fixture('DESKTOP');
    const root = {
      ...projectedSession('DESKTOP'),
      sessionId: 'local-root', upstreamSessionId: 'upstream-root'
    };
    const otherRoot = {
      ...projectedSession('DESKTOP'),
      sessionId: 'local-other-root', upstreamSessionId: 'upstream-other-root'
    };
    sessions.findSessionByUpstream.mockImplementation((_agentId: string, upstreamSessionId: string) => {
      if (upstreamSessionId === root.upstreamSessionId) return root;
      if (upstreamSessionId === otherRoot.upstreamSessionId) return otherRoot;
      return null;
    });

    expect(() => coordinator.claim({
      clientSessionId: 'desktop-quest', agentId: 'agent-1', method: 'session.prompt',
      scope: questScope,
      payload: rpc('session.prompt', { sessionId: otherRoot.upstreamSessionId, mode: 'queue', content: [] })
    })).toThrow(/project root boundary/);
    expect(() => coordinator.claim({
      clientSessionId: 'desktop-quest', agentId: 'agent-1', method: 'session.prompt',
      scope: questScope,
      payload: rpc('session.prompt', { sessionId: 'standalone-upstream', mode: 'queue', content: [] }, 'rpc-standalone')
    })).toThrow(/requires projected sessions/);
    expect(sessions.acquireLease).not.toHaveBeenCalled();
    expect(sessions.claimCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['session.create', { workspaceId: 'workspace-1' }],
    ['session.fork', { sessionId: 'upstream-root', atSeq: 10 }],
    ['workspace.create', { path: 'E:\\Projects\\Other' }],
    ['workspace.rename', { workspaceId: 'workspace-1', title: 'Other' }],
    ['workspace.delete', { workspaceId: 'workspace-1' }],
    ['workspace.insertBefore', { workspaceId: 'workspace-1' }]
  ])('denies scoped Quest escape through %s', (method, body) => {
    const { sessions, coordinator } = fixture('DESKTOP');
    expect(DSH_BROWSER_SESSION_WRITE_METHODS.has(method)).toBe(true);
    expect(() => coordinator.claim({
      clientSessionId: 'desktop-quest', agentId: 'agent-1', method,
      scope: questScope,
      payload: rpc(method, body)
    })).toThrow(/scoped browser write admission denies/);
    expect(sessions.findSessionByUpstream).not.toHaveBeenCalled();
  });

  it.each(['session.selectModel', 'goal.create', 'goal.pause', 'agentPreset.select'])(
    'keeps project-root capability %s available inside a scoped Quest',
    (method) => {
      const { sessions, coordinator } = fixture('DESKTOP');
      const root = {
        ...projectedSession('DESKTOP'),
        sessionId: 'local-root', upstreamSessionId: 'upstream-root'
      };
      sessions.findSessionByUpstream.mockReturnValue(root);
      expect(DSH_BROWSER_SESSION_WRITE_METHODS.has(method)).toBe(true);
      expect(coordinator.claim({
        clientSessionId: `desktop-${method}`, agentId: 'agent-1', method,
        scope: questScope,
        payload: rpc(method, { sessionId: root.upstreamSessionId })
      })).toMatchObject({ projected: true, localSessionId: root.sessionId });
    }
  );

  it('preserves unscoped diagnostic compatibility for browser-created sessions', () => {
    const { sessions, coordinator } = fixture('DESKTOP');
    expect(coordinator.claim({
      clientSessionId: 'desktop-diagnostic', agentId: 'agent-1', method: 'session.create',
      payload: rpc('session.create', { workspaceId: 'workspace-1' })
    })).toEqual({ projected: false, localSessionId: null, commandId: null });
    expect(sessions.findSessionByUpstream).not.toHaveBeenCalled();
    expect(sessions.acquireLease).not.toHaveBeenCalled();
  });

  it('adopts an IPC takeover grant without exposing or reacquiring its bearer token', () => {
    const { sessions, coordinator } = fixture('DESKTOP');
    const grant: DshLeaseGrant = {
      token: 'main-only-takeover-token',
      status: {
        sessionId: 'local-1', agentId: 'agent-1', conversationId: null,
        controlMode: 'TAKEOVER', revision: 5, lastEventCursor: -1,
        lease: {
          sessionId: 'local-1', controller: 'HUMAN', surface: 'DESKTOP',
          principal: 'principal-local-admin', expiresAt: Date.now() + 60_000, revision: 5
        }
      } as DshControlStatusView
    };
    // The service reports the durable takeover lease and its revision after
    // the Main IPC handoff.  The coordinator must use the token only in its
    // subsequent Main-side claim.
    sessions.getControlStatus
      .mockImplementationOnce(() => ({ ...grant.status }))
      .mockImplementation(() => ({ ...grant.status, revision: 6, lease: grant.status.lease ? { ...grant.status.lease, revision: 6 } : null }));
    sessions.claimCommand.mockImplementationOnce(({ expectedRevision, leaseToken, principal }: { expectedRevision: number; leaseToken: string; principal: string }) => {
      expect(expectedRevision).toBe(5);
      expect(leaseToken).toBe(grant.token);
      expect(principal).toBe('principal-local-admin');
      return { duplicate: false, receipt: { appliedRevision: 6 } };
    });
    coordinator.adoptLease('local-1', grant);
    expect(coordinator.claim({ clientSessionId: 'desktop-1', agentId: 'agent-1', method: 'session.prompt', payload: payload('takeover-rpc') }))
      .toMatchObject({ projected: true, localSessionId: 'local-1', commandId: 'takeover-rpc' });
    expect(sessions.acquireLease).not.toHaveBeenCalled();
  });

  it('fails closed when one RPC spans two projected sessions', () => {
    const { sessions, coordinator } = fixture('DESKTOP');
    sessions.findSessionByUpstream.mockImplementation((_agentId: string, upstreamSessionId: string) => ({
      ...projectedSession('DESKTOP'),
      sessionId: upstreamSessionId === 'child-1' ? 'local-child' : 'local-parent',
      upstreamSessionId
    }));
    expect(() => coordinator.claim({
      clientSessionId: 'desktop-1',
      agentId: 'agent-1',
      method: 'subagent.prompt',
      payload: {
        type: 'client-request', rpcId: 'cross-session', method: 'subagent.prompt',
        payload: { childSessionId: 'child-1', parentSessionId: 'parent-1', mode: 'continuable', content: [] }
      }
    })).toThrow(/multiple projected sessions/);
    expect(sessions.acquireLease).not.toHaveBeenCalled();
    expect(sessions.claimCommand).not.toHaveBeenCalled();
  });

  it('fails closed when one RPC mixes projected and standalone sessions', () => {
    const { sessions, coordinator } = fixture('DESKTOP');
    sessions.findSessionByUpstream.mockImplementation((_agentId: string, upstreamSessionId: string) => (
      upstreamSessionId === 'parent-1' ? projectedSession('DESKTOP') : null
    ));
    expect(() => coordinator.claim({
      clientSessionId: 'desktop-1',
      agentId: 'agent-1',
      method: 'subagent.interrupt',
      payload: {
        type: 'client-request', rpcId: 'mixed-session', method: 'subagent.interrupt',
        payload: { childSessionId: 'standalone-child', parentSessionId: 'parent-1', mode: 'continuable' }
      }
    })).toThrow(/projected and standalone/);
    expect(sessions.acquireLease).not.toHaveBeenCalled();
    expect(sessions.claimCommand).not.toHaveBeenCalled();
  });
});
