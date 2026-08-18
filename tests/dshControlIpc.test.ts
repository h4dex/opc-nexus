// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const { ipcMain } = await import('electron');
const { registerIpc } = await import('../src/main/ipc.js');
const { DshTakeoverConfirmationRequiredError } = await import('../src/main/services/dshSessionService.js');
const { DSH_MANAGED_ENGINE_ID } = await import('../src/shared/types.js');

function service(overrides = {}) {
  return new Proxy(overrides, {
    get(target, key) {
      if (key in target) return target[key];
      return vi.fn();
    }
  });
}

const status = {
  sessionId: 'session-1',
  agentId: 'agent-dsh',
  conversationId: null,
  controlMode: 'TAKEOVER',
  revision: 4,
  lastEventCursor: 12,
  lease: {
    sessionId: 'session-1', controller: 'HUMAN', surface: 'DESKTOP',
    principal: 'principal-local-admin', expiresAt: 50_000, revision: 4
  }
};

function register(sessionOverrides = {}, delegationOverrides = {}, dbOverrides = {}) {
  const dshSessions = service({
    getSession: vi.fn(() => ({ agentId: 'agent-dsh' })),
    getControlStatus: vi.fn(() => status),
    readEvents: vi.fn(() => ({ events: [], nextCursor: 12 })),
    takeoverLease: vi.fn(async () => ({ token: 'main-only-lease-token', status })),
    releaseLeaseForPrincipal: vi.fn(() => ({ ...status, revision: 5, lease: null })),
    ...sessionOverrides
  });
  const dsh = service({
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    adoptDesktopTakeover: vi.fn()
  });
  const dshLan = service({
    createPairingCode: vi.fn(() => ({
      code: '12345678',
      expiresAt: 60_000,
      origin: 'https://nexus.test:18766',
      pairingUrl: 'https://nexus.test:18766/pair',
      runtimeId: 'runtime-1',
      role: 'operator',
      certificateFingerprint: 'sha256/test',
      internalSecret: 'must-not-cross-ipc'
    }))
  });
  const dshDelegation = service(delegationOverrides);
  const dshCommunityPlugins = service({
    getCatalogAsync: vi.fn(async () => ({
      scannedAt: 1, profile: 'stopped', busy: false, activeOperationId: null, entries: [], warnings: []
    })),
    issueConfirmation: vi.fn(() => ({ pluginId: 'example-plugin', token: 'confirm-token', expiresAt: 2, summary: 'Example plugin' })),
    issueLifecycleConfirmation: vi.fn(async ({ pluginId, action }) => ({
      pluginId, action, token: 'confirm-token', expiresAt: 2, summary: 'Example plugin lifecycle'
    })),
    install: vi.fn(async () => ({
      ok: true, operationId: 'operation-1', status: 'restart-required', message: 'ok', plugin: null,
      profileStopped: false, profileResumed: false, requiresRestart: true
    })),
    applyLifecycle: vi.fn(async ({ action }) => ({
      ok: true, action, operationId: 'operation-2', status: 'restart-required', message: 'ok', plugin: null,
      profileStopped: false, profileResumed: false, requiresRestart: true
    }))
  });
  const orchestrator = service({
    onChange: vi.fn(), onOutput: vi.fn(), todos: vi.fn(() => []), stats: vi.fn(() => ({})),
    agentCards: vi.fn(() => []), listTasks: vi.fn(() => []), listApprovals: vi.fn(() => []),
    listAgents: vi.fn(() => [{
      id: 'agent-dsh', engineId: DSH_MANAGED_ENGINE_ID, archived: false, workspace: 'E:/workspace'
    }]),
    startAgent: vi.fn(), stopAgent: vi.fn(), archiveAgent: vi.fn()
  });
  const deps = service({
    db: service({
      audit: vi.fn(),
      raw: { prepare: vi.fn(() => service({ all: vi.fn(() => []), get: vi.fn(), run: vi.fn(() => ({ changes: 0 })) })) },
      getSetting: vi.fn((_key, fallback) => fallback),
      setSetting: vi.fn(),
      ...dbOverrides
    }),
    dshSessions,
    dsh,
    dshDelegation,
    dshCommunityPlugins,
    dshLan,
    orchestrator,
    projects: service({ list: vi.fn(() => []) }),
    channels: service({ list: vi.fn(() => []) }),
    scheduler: service({ list: vi.fn(() => []) }),
    engines: service({ list: vi.fn(() => []), hasUsableExecutor: vi.fn(() => true) }),
    broker: service({ onChange: vi.fn() }),
    weixin: service({ onStateChange: vi.fn() }),
    voice: service({ onTranscript: vi.fn(), onError: vi.fn() }),
    mobile: service({ onEvent: vi.fn() }),
    monitor: service({ onSample: vi.fn(), getAlerts: vi.fn(() => []) }),
    workflows: service({ onBroadcast: vi.fn() })
  });
  registerIpc(deps);
  return {
    dshSessions, dsh, dshLan, dshDelegation, dshCommunityPlugins, orchestrator,
    handlers: new Map(ipcMain.handle.mock.calls.map(([name, handler]) => [name, handler]))
  };
}

beforeEach(() => vi.clearAllMocks());

describe('DSH durable control IPC boundary', () => {
  it('uses the managed runtime lifecycle for both single and batch employee actions', async () => {
    const { dsh, orchestrator, handlers } = register();

    await handlers.get('aibox:startAgent')({}, 'agent-dsh');
    expect(dsh.start).toHaveBeenCalledWith(expect.objectContaining({ id: 'agent-dsh' }));
    expect(orchestrator.startAgent).toHaveBeenCalledWith('agent-dsh');
    expect(dsh.start.mock.invocationCallOrder[0]).toBeLessThan(orchestrator.startAgent.mock.invocationCallOrder[0]);

    await handlers.get('aibox:batchAgentAction')({}, ['agent-dsh', 'agent-dsh'], 'stop');
    expect(dsh.stop).toHaveBeenCalledTimes(1);
    expect(orchestrator.stopAgent).toHaveBeenCalledTimes(1);
    expect(dsh.stop.mock.invocationCallOrder[0]).toBeLessThan(orchestrator.stopAgent.mock.invocationCallOrder[0]);

    await handlers.get('aibox:batchAgentAction')({}, ['agent-dsh'], 'delete');
    expect(dsh.stop).toHaveBeenCalledTimes(2);
    expect(orchestrator.stopAgent).toHaveBeenCalledTimes(2);
    expect(orchestrator.archiveAgent).toHaveBeenCalledWith('agent-dsh');
  });

  it('registers only typed, renderer-safe status and event reads', () => {
    const { dshSessions, handlers } = register({
      readEvents: vi.fn(() => ({
        events: [{ sessionId: 'session-1', seq: 12, runId: null, type: 'tool.result', protocolVersion: '1', payload: { apiKey: '[REDACTED]' }, createdAt: 1 }],
        nextCursor: 12
      }))
    });
    expect(handlers.get('aibox:getDshControlStatus')({}, 'session-1')).toEqual(status);
    expect(handlers.get('aibox:readDshEvents')({}, { sessionId: 'session-1', afterCursor: 10, limit: 999 })).toEqual({
      events: [expect.objectContaining({ payload: { apiKey: '[REDACTED]' } })], nextCursor: 12
    });
    expect(dshSessions.readEvents).toHaveBeenCalledWith({ sessionId: 'session-1', afterCursor: 10, limit: 200 });
    expect(handlers.has('aibox:executeDshCommand')).toBe(false);
  });

  it('scopes community plugin lifecycle to a managed DSH employee and rejects extra fields', async () => {
    const { handlers, dshCommunityPlugins } = register();
    await expect(handlers.get('aibox:getDshCommunityPluginCatalog')({}, 'agent-dsh')).resolves.toMatchObject({ profile: 'stopped' });
    expect(dshCommunityPlugins.getCatalogAsync).toHaveBeenCalledWith('agent-dsh');

    const confirmation = handlers.get('aibox:prepareDshCommunityPluginInstall')({}, {
      agentId: 'agent-dsh', pluginId: 'example-plugin'
    });
    expect(confirmation.token).toBe('confirm-token');
    expect(dshCommunityPlugins.issueConfirmation).toHaveBeenCalledWith({ agentId: 'agent-dsh', pluginId: 'example-plugin' });

    await expect(handlers.get('aibox:installDshCommunityPlugin')({}, {
      agentId: 'agent-dsh', pluginId: 'example-plugin', confirmationToken: confirmation.token
    })).resolves.toMatchObject({ ok: true });
    expect(dshCommunityPlugins.install).toHaveBeenCalledWith({
      agentId: 'agent-dsh', pluginId: 'example-plugin', confirmationToken: 'confirm-token'
    });
    const lifecycleConfirmation = await handlers.get('aibox:prepareDshCommunityPluginLifecycle')({}, {
      agentId: 'agent-dsh', pluginId: 'example-plugin', action: 'uninstall'
    });
    expect(dshCommunityPlugins.issueLifecycleConfirmation).toHaveBeenCalledWith({
      agentId: 'agent-dsh', pluginId: 'example-plugin', action: 'uninstall'
    });
    await expect(handlers.get('aibox:applyDshCommunityPluginLifecycle')({}, {
      agentId: 'agent-dsh', pluginId: 'example-plugin', action: 'uninstall', confirmationToken: lifecycleConfirmation.token
    })).resolves.toMatchObject({ ok: true });
    expect(dshCommunityPlugins.applyLifecycle).toHaveBeenCalledWith({
      agentId: 'agent-dsh', pluginId: 'example-plugin', action: 'uninstall', confirmationToken: 'confirm-token'
    });
    expect(() => handlers.get('aibox:prepareDshCommunityPluginInstall')({}, {
      agentId: 'agent-dsh', pluginId: 'example-plugin', source: 'npm'
    })).toThrow('未知字段');
    await expect(handlers.get('aibox:prepareDshCommunityPluginLifecycle')({}, {
      agentId: 'agent-dsh', pluginId: 'example-plugin', action: 'remove'
    })).rejects.toThrow('action is invalid');
    await expect(handlers.get('aibox:getDshCommunityPluginCatalog')({}, 'unknown-agent')).rejects.toThrow('DSH');
  });

  it('projects the secret-free LAN pairing URL through the typed IPC boundary', () => {
    const { dshLan, handlers } = register();
    const result = handlers.get('aibox:createDshLanPairing')({}, 'operator');

    expect(dshLan.createPairingCode).toHaveBeenCalledWith('operator');
    expect(result).toEqual({
      code: '12345678',
      expiresAt: 60_000,
      origin: 'https://nexus.test:18766',
      pairingUrl: 'https://nexus.test:18766/pair',
      runtimeId: 'runtime-1',
      role: 'operator',
      certificateFingerprint: 'sha256/test'
    });
    expect(JSON.stringify(result)).not.toContain('must-not-cross-ipc');
    expect(result.pairingUrl).not.toContain(result.code);
  });

  it('fixes takeover identity in Main and never returns the bearer lease token', async () => {
    const { dshSessions, dsh, handlers } = register();
    const result = await handlers.get('aibox:requestDshTakeover')({}, {
      sessionId: 'session-1', expectedRevision: 3, reason: 'Need to inspect',
      controller: 'NEXUS', surface: 'LAN', principal: 'forged'
    });
    expect(dshSessions.takeoverLease).toHaveBeenCalledWith({
      sessionId: 'session-1', expectedRevision: 3, reason: 'Need to inspect',
      controller: 'HUMAN', surface: 'DESKTOP', principal: 'principal-local-admin'
    });
    expect(dsh.adoptDesktopTakeover).toHaveBeenCalledWith('session-1', {
      token: 'main-only-lease-token', status
    });
    expect(result).toEqual({ granted: true, status, reason: null });
    expect(JSON.stringify(result)).not.toContain('main-only-lease-token');
  });

  it('returns a pending takeover instead of silently replacing an active controller', async () => {
    const { handlers } = register({
      takeoverLease: vi.fn(async () => { throw new DshTakeoverConfirmationRequiredError(status); })
    });
    await expect(handlers.get('aibox:requestDshTakeover')({}, {
      sessionId: 'session-1', expectedRevision: 4
    })).resolves.toEqual({
      granted: false,
      status,
      reason: 'DSH takeover requires a trusted turn-boundary confirmation'
    });
  });

  it('releases only the fixed local-human lease and rejects stale revisions', () => {
    const { dshSessions, handlers } = register();
    expect(handlers.get('aibox:releaseDshControl')({}, {
      sessionId: 'session-1', expectedRevision: 4, principal: 'forged'
    })).toMatchObject({ revision: 5, lease: null });
    expect(dshSessions.releaseLeaseForPrincipal).toHaveBeenCalledWith({
      sessionId: 'session-1', expectedRevision: 4,
      controller: 'HUMAN', surface: 'DESKTOP', principal: 'principal-local-admin'
    });
    expect(() => handlers.get('aibox:releaseDshControl')({}, {
      sessionId: 'session-1', expectedRevision: -1
    })).toThrow('non-negative');
  });

  it('returns bounded delegation projections without host paths or lease material', () => {
    const tree = {
      rootSessionId: 'session-root', requestedSessionId: 'session-root', totalNodes: 2, returnedNodes: 2,
      truncated: false, orphanSessionIds: [], edges: [{ parentSessionId: 'session-root', childSessionId: 'session-child' }],
      sessions: [{
        session: {
          sessionId: 'session-root', upstreamSessionId: 'upstream-secret', runtimeInstanceId: 'runtime-secret',
          agentId: 'agent-dsh', conversationId: null, parentSessionId: null, delegationDepth: 0,
          workspace: 'C:/private/workspace', controlMode: 'NEXUS_MANAGED', revision: 3, lastEventCursor: 4,
          lease: { token: 'should-not-cross' }, createdAt: 1, updatedAt: 2
        },
        depthFromRoot: 0, childSessionIds: ['session-child'], latestRun: null, active: true, eventCount: 2,
        latestEvent: { seq: 4, type: 'turn/end', createdAt: 2 }
      }],
      nodes: []
    };
    tree.nodes = tree.sessions;
    const aggregate = {
      rootSessionId: 'session-root', requestedParentSessionId: 'session-root', totalChildren: 1,
      omittedChildren: 0, truncated: false, generatedAt: 3,
      results: [{
        sessionId: 'session-child', parentSessionId: 'session-root', depth: 1, runId: 'run-child', status: 'COMPLETED',
        summary: 'safe result', artifactRefs: ['artifact://one'], eventRefs: [{ seq: 1, type: 'result' }],
        truncated: false, updatedAt: 3
      }]
    };
    const rawPrepare = vi.fn((sql) => service({
      all: vi.fn(() => []),
      run: vi.fn(() => ({ changes: 0 })),
      get: vi.fn((...args) => {
        const text = String(sql);
        if (text.includes('SELECT organization_id FROM projects')) return { organization_id: 'org-local' };
        if (text.includes('SELECT organization_id FROM agents')) return { organization_id: 'org-local' };
        if (text.includes('FROM dsh_runs')) return { linked: 1 };
        return undefined;
      })
    }));
    const { handlers, dshDelegation } = register({}, {
      getSessionTree: vi.fn(() => tree),
      aggregateChildResults: vi.fn(() => aggregate)
    }, {
      raw: { prepare: rawPrepare },
      getSetting: vi.fn((_key, fallback) => ({ rootSessionId: 'session-root', ...fallback })),
    });

    const projectedTree = handlers.get('aibox:getDshDelegationTree')({}, {
      projectId: 'project-1', sessionId: 'session-root', maxNodes: 10, maxDepth: 4
    });
    expect(projectedTree.sessions[0]).not.toHaveProperty('workspace');
    expect(projectedTree.sessions[0]).not.toHaveProperty('upstreamSessionId');
    expect(JSON.stringify(projectedTree)).not.toContain('runtime-secret');
    expect(JSON.stringify(projectedTree)).not.toContain('should-not-cross');
    expect(projectedTree.edges).toEqual([{ parentSessionId: 'session-root', childSessionId: 'session-child' }]);

    const projectedResults = handlers.get('aibox:getDshChildResults')({}, {
      projectId: 'project-1', parentSessionId: 'session-root', maxResults: 4, maxBytes: 1024
    });
    expect(projectedResults.results[0]).toMatchObject({ sessionId: 'session-child', summary: 'safe result' });
    expect(dshDelegation.aggregateChildResults).toHaveBeenCalledWith('session-root', { maxResults: 4, maxBytes: 1024 });
  });

  it('rejects a delegation query whose session is outside the bound project root', () => {
    const tree = {
      rootSessionId: 'other-root', requestedSessionId: 'session-1', sessions: [], nodes: [], edges: [],
      totalNodes: 1, returnedNodes: 0, truncated: true, orphanSessionIds: []
    };
    const rawPrepare = vi.fn((sql) => service({
      all: vi.fn(() => []), run: vi.fn(() => ({ changes: 0 })),
      get: vi.fn((..._args) => String(sql).includes('FROM projects') || String(sql).includes('FROM agents')
        ? { organization_id: 'org-local' } : undefined)
    }));
    const { handlers } = register({}, { getSessionTree: vi.fn(() => tree) }, {
      raw: { prepare: rawPrepare },
      getSetting: vi.fn(() => ({ rootSessionId: 'project-root' }))
    });
    expect(() => handlers.get('aibox:getDshDelegationTree')({}, {
      projectId: 'project-1', sessionId: 'session-1'
    })).toThrow('不属于该项目根会话');
  });
});
