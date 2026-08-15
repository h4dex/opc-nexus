// @ts-nocheck
/* eslint-disable */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const { clipboard, ipcMain } = await import('electron');
const { registerIpc } = await import('../src/main/ipc.js');
const { BRIDGE_KEY_SECRET_REF } = await import('../src/main/services/apiBridge.js');
const { WEB_TOKEN_SECRET_REF } = await import('../src/main/services/webServer.js');

function service(overrides: Record<string, unknown> = {}) {
  return new Proxy(overrides, {
    get(target, key) {
      if (key in target) return target[key as string];
      return vi.fn();
    }
  });
}

function register(webOverrides: Record<string, unknown> = {}, bridgeOverrides: Record<string, unknown> = {}) {
  const audit = vi.fn();
  const db = service({
    audit,
    raw: { prepare: vi.fn(() => service({ all: vi.fn(() => []), get: vi.fn(), run: vi.fn(() => ({ changes: 0 })) })) },
    getSetting: vi.fn((_key, fallback) => fallback),
    setSetting: vi.fn()
  });
  const apiBridge = service({
    getBridgeKey: vi.fn(() => 'sk-bridge-private'),
    getStatus: vi.fn(() => ({ running: false, port: 29998, keyConfigured: true, enabled: false })),
    regenerateKey: vi.fn(),
    start: vi.fn(),
    toggle: vi.fn(),
    ...bridgeOverrides
  });
  const webServer = service({
    getStatus: vi.fn(() => ({ port: 28889, tokenConfigured: true, weakToken: false })),
    regenerateToken: vi.fn(),
    start: vi.fn(async () => {}),
    ...webOverrides,
    get token() { return 'web-private-token'; }
  });
  const memory = service({
    list: vi.fn(() => []),
    recall: vi.fn(() => []),
    remember: vi.fn((input) => input),
    update: vi.fn((input) => input),
    forget: vi.fn((input) => input)
  });
  const memoryProposals = service({
    list: vi.fn(() => []),
    accept: vi.fn((input) => input),
    reject: vi.fn((input) => input)
  });
  const taskScheduleProposals = service({
    list: vi.fn(() => []),
    accept: vi.fn((input) => input),
    reject: vi.fn((input) => input)
  });
  const orchestrator = service({
    onChange: vi.fn(), onOutput: vi.fn(), todos: vi.fn(() => []), stats: vi.fn(() => ({})),
    agentCards: vi.fn(() => []), listTasks: vi.fn(() => []), listApprovals: vi.fn(() => []),
    createTask: vi.fn()
  });
  const desktopControlPlane = service({
    dispatch: vi.fn(async () => ({ conversationId: 'conversation-local', task: { id: 'task-control-plane' } }))
  });
  const deps = service({
    db,
    apiBridge,
    webServer,
    memory,
    memoryProposals,
    taskScheduleProposals,
    engines: service({ hasUsableExecutor: vi.fn(() => true), list: vi.fn(() => []) }),
    projects: service({ list: vi.fn(() => []) }),
    channels: service({ list: vi.fn(() => []) }),
    scheduler: service({ list: vi.fn(() => []) }),
    orchestrator,
    desktopControlPlane,
    broker: service({ onChange: vi.fn() }),
    weixin: service({ onStateChange: vi.fn() }),
    voice: service({ onTranscript: vi.fn(), onError: vi.fn() }),
    mobile: service({ onEvent: vi.fn() }),
    monitor: service({ onSample: vi.fn(), getAlerts: vi.fn(() => []) }),
    workflows: service({ onBroadcast: vi.fn() })
  });

  registerIpc(deps as never);
  const handlers = new Map(ipcMain.handle.mock.calls.map(([name, handler]) => [name, handler]));
  return {
    audit, handlers, webServer, memory, memoryProposals, taskScheduleProposals,
    orchestrator, desktopControlPlane
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('IPC credential boundary', () => {
  it('routes generic desktop tasks through the canonical control plane', async () => {
    const { handlers, orchestrator, desktopControlPlane } = register();

    await expect(handlers.get('aibox:createTask')(
      {}, 'agent-1', 'prepare the report', 'project-1', 'desktop-message-1'
    )).resolves.toEqual({ id: 'task-control-plane' });
    expect(desktopControlPlane.dispatch).toHaveBeenCalledWith({
      preferredAgentId: 'agent-1', message: 'prepare the report',
      projectId: 'project-1', messageKey: 'desktop-message-1'
    });
    expect(orchestrator.createTask).not.toHaveBeenCalled();
  });

  it('routes confirmed voice tasks through canonical ingress with a stable message key', async () => {
    const { handlers, audit, orchestrator, desktopControlPlane } = register();
    const dispatchVoiceTask = handlers.get('aibox:dispatchVoiceTask');

    await expect(dispatchVoiceTask(
      {}, 'agent-voice', 'summarize the meeting', 'voice-message-1'
    )).resolves.toEqual({ id: 'task-control-plane' });
    await expect(dispatchVoiceTask(
      {}, 'agent-voice', 'summarize the meeting', 'voice-message-1'
    )).resolves.toEqual({ id: 'task-control-plane' });
    expect(desktopControlPlane.dispatch).toHaveBeenCalledTimes(2);
    expect(desktopControlPlane.dispatch).toHaveBeenNthCalledWith(1, {
      preferredAgentId: 'agent-voice', message: 'summarize the meeting',
      source: 'voice', messageKey: 'voice-message-1'
    });
    expect(desktopControlPlane.dispatch).toHaveBeenNthCalledWith(2, {
      preferredAgentId: 'agent-voice', message: 'summarize the meeting',
      source: 'voice', messageKey: 'voice-message-1'
    });
    expect(orchestrator.createTask).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'voice.dispatch', target: 'task-control-plane', result: 'ok'
    }));
  });

  it('does not expose generic secret namespace handlers', () => {
    const { handlers } = register();
    expect(handlers.has('aibox:storeSecret')).toBe(false);
    expect(handlers.has('aibox:hasSecret')).toBe(false);
  });

  it('rejects internal settings through the registered handlers', () => {
    const { handlers } = register();
    expect(() => handlers.get('aibox:getSetting')({}, 'secret:provider:key')).toThrow(/not allowed/);
    expect(() => handlers.get('aibox:setSetting')({}, 'engine:health:harness', {})).toThrow(/not allowed/);
  });

  it('copies credentials inside Main and audits each clipboard operation', () => {
    const { audit, handlers } = register();

    expect(handlers.get('aibox:copyBridgeKey')()).toEqual({ ok: true });
    expect(clipboard.writeText).toHaveBeenCalledWith('sk-bridge-private');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'bridge.key.copy', target: BRIDGE_KEY_SECRET_REF, result: 'clipboard'
    }));

    expect(handlers.get('aibox:copyWebToken')()).toEqual({ ok: true });
    expect(clipboard.writeText).toHaveBeenCalledWith('web-private-token');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'webserver.token.copy', target: WEB_TOKEN_SECRET_REF, result: 'clipboard'
    }));
  });

  it('waits for WebServer restart and propagates startup failure after token rotation', async () => {
    let releaseStart!: () => void;
    const deferred = new Promise<void>((resolve) => { releaseStart = resolve; });
    const start = vi.fn(() => deferred);
    const getStatus = vi.fn(() => ({ port: 28889, tokenConfigured: true, weakToken: false }));
    const { handlers } = register({ start, getStatus });

    const pending = handlers.get('aibox:regenerateWebToken')();
    await Promise.resolve();
    expect(getStatus).not.toHaveBeenCalled();
    releaseStart();
    await expect(pending).resolves.toEqual({ port: 28889, tokenConfigured: true, weakToken: false });

    start.mockRejectedValueOnce(new Error('listen failed'));
    await expect(handlers.get('aibox:regenerateWebToken')()).rejects.toThrow('listen failed');
  });

  it('waits for API Bridge enable and propagates startup failure', async () => {
    let releaseToggle!: () => void;
    const deferred = new Promise<void>((resolve) => { releaseToggle = resolve; });
    const toggle = vi.fn(() => deferred);
    const { handlers } = register({}, { toggle });

    let settled = false;
    const pending = handlers.get('aibox:toggleBridge')({}, true).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseToggle();
    await pending;

    toggle.mockRejectedValueOnce(new Error('bridge enable failed'));
    await expect(handlers.get('aibox:toggleBridge')({}, true)).rejects.toThrow('bridge enable failed');
  });

  it('waits for API Bridge restart after key rotation and propagates failure', async () => {
    let releaseStart!: () => void;
    const deferred = new Promise<void>((resolve) => { releaseStart = resolve; });
    const start = vi.fn(() => deferred);
    const getStatus = vi.fn(() => ({ running: false, port: 29998, keyConfigured: true, enabled: true }));
    const { handlers } = register({}, { start, getStatus });

    const pending = handlers.get('aibox:regenerateBridgeKey')();
    await Promise.resolve();
    expect(getStatus).toHaveBeenCalledTimes(1);
    releaseStart();
    await pending;
    expect(getStatus).toHaveBeenCalledTimes(2);

    start.mockRejectedValueOnce(new Error('bridge restart failed'));
    await expect(handlers.get('aibox:regenerateBridgeKey')()).rejects.toThrow('bridge restart failed');
  });

  it('fixes memory tenant and actor inside Main instead of trusting Renderer input', () => {
    const { handlers, memory, memoryProposals, taskScheduleProposals } = register();

    handlers.get('aibox:rememberMemory')({}, {
      organizationId: 'org-attacker', actor: 'kernel', kind: 'fact', content: 'confirmed value', importance: 0.6
    });
    expect(memory.remember).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-local', actor: 'admin', source: 'desktop', kind: 'fact', content: 'confirmed value'
    }));

    handlers.get('aibox:updateMemory')({}, {
      organizationId: 'org-attacker', actor: 'kernel', memoryId: 'memory-1', expectedRevision: 2,
      content: 'corrected value'
    });
    expect(memory.update).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-local', actor: 'admin', memoryId: 'memory-1', expectedRevision: 2
    }));

    handlers.get('aibox:acceptMemoryProposal')({}, {
      organizationId: 'org-attacker', actor: 'hermes', proposalId: 'proposal-1'
    });
    expect(memoryProposals.accept).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-local', actor: 'admin', proposalId: 'proposal-1', source: 'desktop'
    }));

    handlers.get('aibox:acceptTaskScheduleProposal')({}, {
      organizationId: 'org-attacker', actor: 'hermes', proposalId: 'schedule-proposal-1'
    });
    expect(taskScheduleProposals.accept).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-local', actor: 'admin', proposalId: 'schedule-proposal-1', source: 'desktop'
    }));
  });
});
