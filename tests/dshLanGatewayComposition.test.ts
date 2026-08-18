// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { DshLanGatewayComposition, fixedRoutePolicy } = await import('../src/main/services/dshLanGatewayComposition.js');
const { DSH_MANAGED_PROFILE_ID } = await import('../src/main/services/deepseekHarnessManagedRuntime.js');

const ROUTE_RUNTIME = 'opc-nexus-dsh-managed-web';

function route(overrides = {}) {
  return {
    runtimeId: ROUTE_RUNTIME,
    method: 'GET',
    pathname: '/',
    search: '',
    websocket: false,
    ...overrides
  };
}

const CONFIG = {
  bindHost: '192.168.10.20',
  port: 18766,
  publicHost: 'nexus-box.local',
  publicPort: 18766
};

function runtime(overrides = {}) {
  return {
    agentId: 'agent-dsh',
    profileId: DSH_MANAGED_PROFILE_ID,
    generation: 1,
    processState: 'READY',
    endpoint: 'http://127.0.0.1:3080/',
    pid: 123,
    home: 'C:/dsh/home',
    profileDirectory: 'C:/dsh/profile',
    workspace: 'C:/workspace',
    startedAt: 1,
    readyAt: 2,
    lastHealthAt: 3,
    nextRestartAt: null,
    restartCount: 0,
    crashCount: 0,
    consecutiveFailures: 0,
    lastExit: null,
    lastError: null,
    recentLogs: [],
    ...overrides
  };
}

function harness({ statuses = [], trusted = true, trustedAfterRestart = trusted, sessions = undefined } = {}) {
  let listener;
  let currentStatuses = [...statuses];
  let currentTrust = trusted;
  const supervisor = {
    subscribe: vi.fn((next) => {
      listener = next;
      return () => { listener = undefined; };
    }),
    listStatuses: vi.fn(() => currentStatuses),
    getStatus: vi.fn((agentId, profileId) => currentStatuses.find((s) => s.agentId === agentId && s.profileId === profileId) ?? null),
    hasTrustedAuthority: vi.fn(() => currentTrust),
    stop: vi.fn(async (agentId, profileId) => {
      currentStatuses = currentStatuses.map((status) => status.agentId === agentId && status.profileId === profileId
        ? { ...status, processState: 'STOPPED', endpoint: null, pid: null }
        : status);
    }),
    start: vi.fn(async ({ agentId, profileId }) => {
      currentTrust = trustedAfterRestart;
      const previous = currentStatuses.find((status) => status.agentId === agentId && status.profileId === profileId)
        ?? runtime({ agentId, profileId });
      const restarted = runtime({
        ...previous,
        agentId,
        profileId,
        generation: previous.generation + 1,
        processState: 'READY',
        endpoint: 'http://127.0.0.1:3081/',
        pid: 456,
        restartCount: previous.restartCount + 1
      });
      currentStatuses = currentStatuses.filter((status) => status.agentId !== agentId || status.profileId !== profileId);
      currentStatuses.push(restarted);
      return restarted;
    }),
    setStatuses(next) {
      currentStatuses = [...next];
    },
    notify() {
      listener?.();
    }
  };

  const gatewayState = {
    state: 'stopped', enabled: false, running: false,
    bindHost: null, port: null, authority: null, origin: null,
    trustedAuthorities: [], runtimeId: 'opc-nexus-dsh-managed-web',
    activeSessions: 0, activeRequests: 0, activeWebSockets: 0,
    certificateFingerprint: null, lastError: null
  };
  const gateway = {
    getStatus: vi.fn(() => ({ ...gatewayState, trustedAuthorities: [...gatewayState.trustedAuthorities] })),
    start: vi.fn(async (options) => {
      gatewayState.state = 'running';
      gatewayState.enabled = true;
      gatewayState.running = true;
      gatewayState.bindHost = options.bindHost;
      gatewayState.port = options.port;
      gatewayState.authority = `${options.publicHost}:${options.publicPort}`;
      gatewayState.origin = `https://${gatewayState.authority}`;
      gatewayState.trustedAuthorities = [gatewayState.authority];
      gatewayState.certificateFingerprint = 'sha256/test';
      return gateway.getStatus();
    }),
    stop: vi.fn(async () => {
      gatewayState.state = 'stopped';
      gatewayState.enabled = false;
      gatewayState.running = false;
      gatewayState.bindHost = null;
      gatewayState.port = null;
      gatewayState.authority = null;
      gatewayState.origin = null;
      gatewayState.trustedAuthorities = [];
      gatewayState.certificateFingerprint = null;
    }),
    createPairingOffer: vi.fn(() => ({
      code: '12345678', expiresAt: Date.now() + 60_000,
      origin: 'https://nexus-box.local:18766', runtimeId: gatewayState.runtimeId,
      pairingUrl: 'https://nexus-box.local:18766/pair',
      role: 'operator', certificateFingerprint: 'sha256/test'
    }))
  };

  const controllerState = { desiredEnabled: false, configured: null, lastError: null };
  const controller = {
    getStatus: vi.fn(() => ({ ...controllerState, configured: controllerState.configured ? { ...controllerState.configured } : null, gateway: gateway.getStatus() })),
    getTrustedAuthorities: vi.fn(() => [...gatewayState.trustedAuthorities]),
    rememberEnabledIntent: vi.fn((input) => {
      controllerState.desiredEnabled = true;
      controllerState.configured = { ...CONFIG, ...input };
      controllerState.lastError = null;
      return controller.getStatus();
    }),
    restoreOnStartup: vi.fn(async () => {
      const config = controllerState.configured;
      if (config) await gateway.start({ ...config, tls: { key: 'key', cert: 'cert' } });
      return controller.getStatus();
    }),
    shutdown: vi.fn(async () => {
      await gateway.stop();
      return controller.getStatus();
    }),
    emergencyStop: vi.fn(async () => {
      controllerState.desiredEnabled = false;
      await gateway.stop();
      return controller.getStatus();
    }),
    resetCertificate: vi.fn(async () => {
      await gateway.stop();
      return controller.getStatus();
    }),
    createPairingCode: vi.fn((role) => gateway.createPairingOffer(role))
  };

  const db = { audit: vi.fn() };
  const composition = new DshLanGatewayComposition(db, supervisor, {
    gateway,
    controller,
    ...(sessions ? { sessions } : {})
  });
  return { composition, supervisor, gateway, controller };
}

describe('DshLanGatewayComposition', () => {
  it('keeps enabled intent without listening while no managed runtime is READY', async () => {
    const { composition, controller, gateway } = harness();
    const status = await composition.start(CONFIG);

    expect(controller.rememberEnabledIntent).toHaveBeenCalledWith(CONFIG);
    expect(status.desiredEnabled).toBe(true);
    expect(status.gateway.running).toBe(false);
    expect(status.lastError).toMatch(/waiting/i);
    expect(gateway.start).not.toHaveBeenCalled();
  });

  it('binds the only trusted READY runtime and starts the edge', async () => {
    const candidate = runtime();
    const { composition, gateway, supervisor } = harness({ statuses: [candidate] });
    const status = await composition.start(CONFIG);

    expect(supervisor.hasTrustedAuthority).toHaveBeenCalled();
    expect(gateway.start).toHaveBeenCalledTimes(1);
    expect(status.gateway.running).toBe(true);
    expect(status.boundRuntime).toMatchObject({ agentId: candidate.agentId, profileId: candidate.profileId, endpoint: 'http://127.0.0.1:3080' });
    expect(status.lastError).toBeNull();
  });

  it('restarts a healthy listener when persisted bind settings drift, but stays stable when unchanged', async () => {
    const candidate = runtime();
    const { composition, controller, gateway } = harness({ statuses: [candidate] });
    await composition.start(CONFIG);

    await composition.restoreOnStartup();
    expect(controller.shutdown).not.toHaveBeenCalled();
    expect(gateway.start).toHaveBeenCalledTimes(1);

    const changed = await composition.start({
      ...CONFIG,
      bindHost: '192.168.10.21',
      port: 18767
    });
    expect(controller.shutdown).toHaveBeenCalledTimes(1);
    expect(gateway.start).toHaveBeenCalledTimes(2);
    expect(changed.gateway).toMatchObject({
      running: true,
      bindHost: '192.168.10.21',
      port: 18767,
      // publicPort is unchanged, so this specifically exercises listener
      // drift under the same externally trusted authority.
      authority: `${CONFIG.publicHost}:${CONFIG.publicPort}`
    });

    await composition.restoreOnStartup();
    expect(controller.shutdown).toHaveBeenCalledTimes(1);
    expect(gateway.start).toHaveBeenCalledTimes(2);
  });

  it('stops and revokes the edge when runtime candidates become ambiguous or unhealthy', async () => {
    const candidate = runtime();
    const { composition, supervisor, controller, gateway } = harness({ statuses: [candidate] });
    await composition.start(CONFIG);
    expect(gateway.getStatus().running).toBe(true);

    supervisor.setStatuses([candidate, runtime({ agentId: 'agent-dsh-2', endpoint: 'http://127.0.0.1:3081/' })]);
    const multiple = await composition.restoreOnStartup();
    expect(controller.shutdown).toHaveBeenCalled();
    expect(multiple.gateway.running).toBe(false);
    expect(multiple.boundRuntime).toBeNull();
    expect(multiple.lastError).toMatch(/multiple/i);

    supervisor.setStatuses([runtime({ processState: 'UNHEALTHY' })]);
    const unhealthy = await composition.restoreOnStartup();
    expect(unhealthy.gateway.running).toBe(false);
    expect(unhealthy.lastError).toMatch(/waiting/i);
  });

  it('rejects an untrusted runtime without opening a listener', async () => {
    const { composition, gateway } = harness({ statuses: [runtime()], trusted: false });
    const status = await composition.start(CONFIG);

    expect(gateway.start).not.toHaveBeenCalled();
    expect(status.gateway.running).toBe(false);
    expect(status.lastError).toMatch(/trusted authority/i);
  });

  it('restarts the managed runtime once and opens the listener after the LAN authority is applied', async () => {
    const { composition, gateway, supervisor } = harness({
      statuses: [runtime()],
      trusted: false,
      trustedAfterRestart: true
    });

    const status = await composition.start(CONFIG);

    expect(supervisor.stop).toHaveBeenCalledTimes(1);
    expect(supervisor.start).toHaveBeenCalledWith({
      agentId: 'agent-dsh',
      profileId: DSH_MANAGED_PROFILE_ID,
      workspace: 'C:/workspace'
    });
    expect(gateway.start).toHaveBeenCalledTimes(1);
    expect(status.gateway.running).toBe(true);
    expect(status.boundRuntime?.endpoint).toBe('http://127.0.0.1:3081');
    expect(status.lastError).toBeNull();
  });

  it('rejects non-loopback upstream endpoints before binding', async () => {
    const { composition, gateway } = harness({ statuses: [runtime({ endpoint: 'http://192.168.1.9:3080/' })] });
    const status = await composition.start(CONFIG);

    expect(gateway.start).not.toHaveBeenCalled();
    expect(status.eligibleRuntimeCount).toBe(0);
    expect(status.gateway.running).toBe(false);
  });

  it('leaves an admitted LAN write unresolved when the upstream transport fails', async () => {
    let revision = 4;
    let lease = null;
    const sessions = {
      findSessionByUpstream: vi.fn(() => ({
        sessionId: 'local-1', agentId: 'agent-dsh', conversationId: null,
        controlMode: 'NEXUS_MANAGED', revision: 4, lastEventCursor: -1, lease: null,
        upstreamSessionId: 'upstream-1', runtimeInstanceId: 'runtime-1',
        parentSessionId: null, delegationDepth: 0, workspace: '', createdAt: 1, updatedAt: 1
      })),
      findSession: vi.fn(() => ({
        sessionId: 'local-1', upstreamSessionId: 'upstream-1'
      })),
      getControlStatus: vi.fn(() => ({
        sessionId: 'local-1', agentId: 'agent-dsh', conversationId: null,
        controlMode: 'NEXUS_MANAGED', revision, lastEventCursor: -1, lease
      })),
      acquireLease: vi.fn(({ principal }) => {
        revision += 1;
        lease = {
          sessionId: 'local-1', controller: 'HUMAN', surface: 'LAN', principal,
          expiresAt: Date.now() + 60_000, revision
        };
        return { token: 'main-only-lan-token', status: sessions.getControlStatus() };
      }),
      claimCommand: vi.fn(() => {
        revision += 1;
        if (lease) lease.revision = revision;
        return { duplicate: false, receipt: { appliedRevision: revision } };
      }),
      completeCommand: vi.fn(),
      failCommand: vi.fn(),
      renewLease: vi.fn(),
      releaseLease: vi.fn()
    };
    const { composition } = harness({ statuses: [runtime()], sessions });
    await composition.start(CONFIG);
    const policy = composition.resolvePolicy(route({
      pathname: '/api/session.prompt', method: 'POST'
    }));
    const methodPolicy = policy.rpc.methods['session.prompt'];
    const payload = {
      type: 'client-request', rpcId: 'rpc-ambiguous', method: 'session.prompt',
      payload: { sessionId: 'upstream-1', mode: 'queue', content: [] }
    };
    const context = {
      runtimeId: ROUTE_RUNTIME, sessionId: 'lan-browser-1', role: 'operator',
      method: 'session.prompt', payload
    };
    expect(await methodPolicy.authorize(context)).toBe(true);
    await methodPolicy.onForwardFailed?.(context, new Error('connection reset'));
    expect(sessions.claimCommand).toHaveBeenCalledOnce();
    expect(sessions.failCommand).not.toHaveBeenCalled();
    await methodPolicy.onForwarded?.({ ...context, statusCode: 503 });
    expect(sessions.failCommand).toHaveBeenCalledWith('rpc-ambiguous', 'DSH upstream returned HTTP 503');
    await composition.shutdown();
  });
});

describe('managed DSH fixed route contract', () => {
  it('does not mistake unknown API files for static web assets', () => {
    expect(fixedRoutePolicy(ROUTE_RUNTIME, route({ pathname: '/api/unknown.json' }))).toBeNull();
    expect(fixedRoutePolicy(ROUTE_RUNTIME, route({ pathname: '/api/credentials.json' }))).toBeNull();
    expect(fixedRoutePolicy(ROUTE_RUNTIME, route({ pathname: '/api' }))).toBeNull();
  });

  it('allows only the pinned web shell paths over GET and HEAD', () => {
    expect(fixedRoutePolicy(ROUTE_RUNTIME, route({ pathname: '/', method: 'GET' }))).toMatchObject({
      kind: 'web', methods: ['GET', 'HEAD'], roles: ['viewer', 'operator']
    });
    expect(fixedRoutePolicy(ROUTE_RUNTIME, route({ pathname: '/assets/index.js', method: 'HEAD' }))).toMatchObject({
      kind: 'web'
    });
    expect(fixedRoutePolicy(ROUTE_RUNTIME, route({ pathname: '/sessions/abc', method: 'GET' }))).toMatchObject({
      kind: 'web'
    });
    expect(fixedRoutePolicy(ROUTE_RUNTIME, route({ pathname: '/session/../settings' }))).toBeNull();
    expect(fixedRoutePolicy(ROUTE_RUNTIME, route({ pathname: '/settings', method: 'POST' }))).toBeNull();
  });

  it('enforces the RPC method and role allowlist, including the server respond envelope', () => {
    const read = fixedRoutePolicy(ROUTE_RUNTIME, route({ pathname: '/api/session.list', method: 'POST' }));
    expect(read).toMatchObject({ kind: 'rpc', methods: ['POST'], roles: ['viewer', 'operator'] });
    expect(read?.kind === 'rpc' ? read.rpc?.methods['session.list'] : undefined).toMatchObject({
      roles: ['viewer', 'operator'], rateLimitBucket: 'read'
    });

    const prompt = fixedRoutePolicy(ROUTE_RUNTIME, route({ pathname: '/api/session.prompt', method: 'POST' }));
    expect(prompt?.kind === 'rpc' ? prompt.rpc?.methods['session.prompt'] : undefined).toMatchObject({
      roles: ['operator'], rateLimitBucket: 'prompt'
    });
    // The resolver returns the RPC contract first; DshLanGateway enforces the
    // route's POST-only method list at request time.
    expect(fixedRoutePolicy(ROUTE_RUNTIME, route({ pathname: '/api/session.prompt', method: 'GET' }))).toMatchObject({
      kind: 'rpc', methods: ['POST']
    });

    const respond = fixedRoutePolicy(ROUTE_RUNTIME, route({ pathname: '/api/respond', method: 'POST' }));
    expect(respond).toMatchObject({ kind: 'rpc', methods: ['POST'], roles: ['operator'] });
    expect(respond?.kind === 'rpc' ? respond.rpc?.extractMethods?.({ anything: true }) : undefined).toEqual(['respond']);

    // The Provider proxy issues a one-model grant. LAN clients cannot mutate a
    // session onto a model outside that scope and leave it in a failed state.
    expect(fixedRoutePolicy(ROUTE_RUNTIME, route({ pathname: '/api/session.selectModel', method: 'POST' }))).toBeNull();

    for (const pathname of ['/api/settings.update', '/api/credentials.get', '/api/file.pick', '/api/model.discover', '/api/plugin.install']) {
      expect(fixedRoutePolicy(ROUTE_RUNTIME, route({ pathname, method: 'POST' }))).toBeNull();
    }
  });

  it('keeps event WebSockets downlink-only and scoped to the managed runtime', () => {
    const events = fixedRoutePolicy(ROUTE_RUNTIME, route({
      pathname: '/api/events.mux', method: 'GET', websocket: true
    }));
    expect(events).toMatchObject({
      kind: 'websocket', roles: ['viewer', 'operator'], allowedSubprotocols: []
    });
    expect(events?.kind === 'websocket' ? events.clientRpc : undefined).toBeUndefined();
    expect(fixedRoutePolicy(ROUTE_RUNTIME, route({ pathname: '/api/events.host', method: 'GET', websocket: true }))).toMatchObject({ kind: 'websocket' });
    expect(fixedRoutePolicy(ROUTE_RUNTIME, route({ pathname: '/api/events.mux', method: 'POST', websocket: true }))).toBeNull();
    expect(fixedRoutePolicy(ROUTE_RUNTIME, route({ pathname: '/api/other', method: 'GET', websocket: true }))).toBeNull();
    expect(fixedRoutePolicy('other-runtime', route({ pathname: '/api/events.mux', method: 'GET', websocket: true }))).toBeNull();
  });
});
