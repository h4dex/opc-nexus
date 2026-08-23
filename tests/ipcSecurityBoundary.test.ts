// @ts-nocheck
/* eslint-disable */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const { BrowserWindow, clipboard, dialog, ipcMain, shell } = await import('electron');
const { registerIpc } = await import('../src/main/ipc.js');
const { BRIDGE_KEY_SECRET_REF } = await import('../src/main/services/apiBridge.js');
const RETIRED_ENGINE_ID = 'eng-deepseek-harness-managed';

function service(overrides: Record<string, unknown> = {}) {
  return new Proxy(overrides, {
    get(target, key) {
      if (key in target) return target[key as string];
      return vi.fn();
    }
  });
}

function register(
  _retiredWebOverrides: Record<string, unknown> = {},
  bridgeOverrides: Record<string, unknown> = {},
  dshQuestGovernance: Record<string, unknown> | undefined = undefined,
  projectWorkbench: Record<string, unknown> | undefined = undefined,
  dependencyOverrides: Record<string, unknown> = {}
) {
  const resolvedProjectWorkbench = service({
    getExplicitWorkspacePath: vi.fn(() => process.cwd()),
    getWorkspacePath: vi.fn(() => process.cwd()),
    setWorkspacePath: vi.fn(),
    ...(projectWorkbench ?? {})
  });
  const audit = vi.fn();
  const db = service({
    audit,
    transaction: vi.fn((operation: () => unknown) => operation()),
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
  const engines = service({
    hasUsableExecutor: vi.fn(() => true),
    list: vi.fn(() => []),
    saveConfig: vi.fn()
  });
  const attachmentBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const vision = service({
    readAttachment: vi.fn((value) => {
      if (!value || typeof value !== 'object' || 'path' in value) throw new Error('attachmentRef is invalid');
      return attachmentBytes;
    })
  });
  const ocr = service({
    recognizeBytes: vi.fn(async () => ({ ok: true, text: 'hello', boxes: [], elapsed: 1 }))
  });
  const deps = service({
    db,
    apiBridge,
    memory,
    memoryProposals,
    taskScheduleProposals,
    engines,
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
    workflows: service({ onBroadcast: vi.fn() }),
    vision,
    ocr,
    visionPluginHost: null,
    hermesEmbedded: null,
    hermesServices: null,
    debugLogs: null,
    dshLan: service({
      selectRuntime: vi.fn(async () => ({}))
    }),
    projectArtifacts: service({
      list: vi.fn(() => ({ projectId: 'project-1', workspaceConfigured: true, relativeDirectory: '', parentDirectory: null, entries: [], truncated: false })),
      preview: vi.fn(() => ({ entry: {}, uri: null, text: '', truncated: false })),
      resolveForReveal: vi.fn(() => process.cwd())
    }),
    ...(dshQuestGovernance ? { dshQuestGovernance } : {}),
    projectWorkbench: resolvedProjectWorkbench,
    ...(projectWorkbench ? { getMainWindow: vi.fn(() => ({})) } : {}),
    ...dependencyOverrides
  });

  registerIpc(deps as never);
  const handlers = new Map(ipcMain.handle.mock.calls.map(([name, handler]) => [name, handler]));
  return {
    audit, handlers, memory, memoryProposals, taskScheduleProposals,
    orchestrator, desktopControlPlane, engines, vision, ocr
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('IPC credential boundary', () => {
  it('assigns a real automatic workspace while creating a project', async () => {
    const setWorkspacePath = vi.fn();
    const projectWorkbench = service({
      getExplicitWorkspacePath: vi.fn(() => null),
      getWorkspacePath: vi.fn(() => null),
      setWorkspacePath
    });
    const projects = service({
      create: vi.fn((input) => ({ id: 'project-auto', name: input.name }))
    });
    const { handlers } = register({}, {}, undefined, projectWorkbench, { projects });

    await expect(handlers.get('aibox:createProject')({ sender: {} }, {
      name: '官网交付', workspaceMode: 'automatic'
    })).resolves.toMatchObject({ id: 'project-auto' });
    expect(setWorkspacePath).toHaveBeenCalledTimes(1);
    const workspace = setWorkspacePath.mock.calls[0][1] as string;
    expect(workspace).toContain('opc-nexus');
    expect(workspace).toContain('projects');
    expect(existsSync(workspace)).toBe(true);
    rmSync(workspace, { recursive: true, force: true });
  });

  it('uses the trusted directory picker for a custom project workspace', async () => {
    const workspace = process.cwd();
    const questWindow = { isDestroyed: () => false };
    const sender = {};
    const setWorkspacePath = vi.fn();
    const projectWorkbench = service({ setWorkspacePath });
    const projects = service({
      create: vi.fn((input) => ({ id: 'project-custom', name: input.name }))
    });
    BrowserWindow.fromWebContents.mockReturnValueOnce(questWindow);
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [workspace] });
    const { handlers } = register({}, {}, undefined, projectWorkbench, { projects });

    await expect(handlers.get('aibox:createProject')({ sender }, {
      name: '客户项目', workspaceMode: 'custom'
    })).resolves.toMatchObject({ id: 'project-custom' });
    expect(dialog.showOpenDialog).toHaveBeenCalledWith(questWindow, expect.objectContaining({
      title: '选择项目交付目录',
      properties: expect.arrayContaining(['openDirectory'])
    }));
    expect(setWorkspacePath).toHaveBeenCalledWith('project-custom', workspace);
  });

  it('asks for and persists a project directory before opening it', async () => {
    const workspace = process.cwd();
    const questWindow = { isDestroyed: () => false };
    const sender = {};
    const projectWorkbench = service({
      getExplicitWorkspacePath: vi.fn(() => null),
      getWorkspacePath: vi.fn(() => null),
      setWorkspacePath: vi.fn()
    });
    BrowserWindow.fromWebContents.mockReturnValueOnce(questWindow);
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [workspace] });
    shell.openPath.mockResolvedValueOnce('');

    const { handlers } = register({}, {}, undefined, projectWorkbench);

    await expect(handlers.get('aibox:openProjectWorkspace')({ sender }, 'project-1'))
      .resolves.toEqual({ ok: true, message: '', workspaceChanged: true });
    expect(BrowserWindow.fromWebContents).toHaveBeenCalledWith(sender);
    expect(dialog.showOpenDialog).toHaveBeenCalledWith(questWindow, expect.objectContaining({
      properties: expect.arrayContaining(['openDirectory'])
    }));
    expect(projectWorkbench.setWorkspacePath).toHaveBeenCalledWith('project-1', workspace);
    expect(shell.openPath).toHaveBeenCalledWith(workspace);
  });

  it('keeps project artifact listing, preview, and reveal behind bounded IPC methods', async () => {
    const projectArtifacts = service({
      list: vi.fn(() => ({ projectId: 'project-1', entries: [] })),
      preview: vi.fn(() => ({ entry: { relativePath: '交付/index.html' }, uri: 'aibox-project://preview/grant/index.html' })),
      resolveForReveal: vi.fn(() => process.cwd())
    });
    const { handlers } = register({}, {}, undefined, undefined, { projectArtifacts });

    expect(handlers.get('aibox:listProjectArtifacts')({}, 'project-1', '交付'))
      .toEqual({ projectId: 'project-1', entries: [] });
    expect(projectArtifacts.list).toHaveBeenCalledWith('project-1', '交付');
    expect(handlers.get('aibox:previewProjectArtifact')({}, 'project-1', '交付/index.html'))
      .toEqual(expect.objectContaining({ uri: expect.stringContaining('aibox-project://') }));
    expect(projectArtifacts.preview).toHaveBeenCalledWith('project-1', '交付/index.html');
    expect(handlers.get('aibox:revealProjectArtifact')({}, 'project-1', '交付/index.html')).toEqual({ ok: true });
    expect(shell.showItemInFolder).toHaveBeenCalledWith(process.cwd());
    expect(() => handlers.get('aibox:previewProjectArtifact')({}, 'project-1', 'C:\\Windows\\win.ini')).toThrow();
  });

  it('keeps the Hermes mobile listener alive while stopping only the project runtime', async () => {
    const order: string[] = [];
    const route = {
      projectId: 'project-1', pairingId: 'pairing-1',
      runtimeId: 'hermes-project:project-1:chat', origin: 'https://nexus.test:24443',
      pairingUrl: 'https://nexus.test:24443/pair', code: '12345678', expiresAt: Date.now() + 60_000,
      certificateFingerprint: 'sha256/test'
    };
    const hermesServices = service({
      getStatus: vi.fn(() => ({ projectId: 'project-1', state: 'healthy' })),
      stop: vi.fn(async () => { order.push('runtime'); return { projectId: 'project-1', state: 'stopped' }; })
    });
    const hermesMobile = service({
      createPairing: vi.fn(async () => route),
      stopProject: vi.fn(async () => { order.push('mobile'); }),
      getProjectStatus: vi.fn(() => ({
        projectId: 'project-1', configured: null, running: false, activeRoutes: [], lastError: null
      }))
    });
    const { handlers } = register({}, {}, undefined, undefined, { hermesServices, hermesMobile });

    await expect(handlers.get('aibox:createHermesMobilePairing')({}, 'project-1'))
      .resolves.toEqual(route);
    expect(hermesMobile.createPairing).toHaveBeenCalledWith('project-1');
    expect(() => handlers.get('aibox:createHermesMobilePairing')({}, 'project-1', 'viewer'))
      .toThrow();

    expect(handlers.get('aibox:getHermesMobileAccessStatus')({}, 'project-1'))
      .toMatchObject({ projectId: 'project-1', running: false });
    await handlers.get('aibox:stopHermesMobileAccess')({}, 'project-1');
    expect(hermesMobile.stopProject).toHaveBeenCalledWith('project-1');
    order.length = 0;

    await handlers.get('aibox:stopHermesProject')({}, 'project-1');
    expect(order).toEqual(['runtime']);
    expect(hermesMobile.stopProject).toHaveBeenCalledTimes(1);
  });

  it('rejects employee conversations outside a restricted project before creating a broken Tab', () => {
    const projectWorkbench = service({
      get: vi.fn(() => ({ project: { id: 'project-1', status: 'active' } })),
      getWorkerSelection: vi.fn(() => ({ mode: 'restricted', workerAgentIds: ['agent-allowed'] }))
    });
    const hermesGovernance = service({
      createConversation: vi.fn((_projectId, input) => ({
        conversationId: 'hermes-conversation-new', employee: { id: input.employeeId }
      }))
    });
    const { handlers } = register({}, {}, undefined, projectWorkbench, { hermesGovernance });
    const create = handlers.get('aibox:createHermesProjectConversation');

    expect(create({}, 'project-1', 'agent-allowed')).toEqual(expect.objectContaining({
      employee: { id: 'agent-allowed' }
    }));
    expect(() => create({}, 'project-1', 'agent-blocked'))
      .toThrow('不在该项目的固定员工池中');
    expect(hermesGovernance.createConversation).toHaveBeenCalledTimes(1);
  });

  it('does not tear down mobile access during restart, emergency stop, or Quest setting changes', async () => {
    const order: string[] = [];
    const projectWorkbench = service({
      getSettings: vi.fn(() => ({
        model: 'model-a', workerAgentIds: [], pluginIds: [], mode: 'quest'
      })),
      saveSettings: vi.fn((_id, patch) => ({
        model: patch.model ?? 'model-a', workerAgentIds: [], pluginIds: [], mode: 'quest'
      }))
    });
    const hermesServices = service({
      getStatus: vi.fn(() => ({ projectId: 'project-1', state: 'healthy' })),
      stop: vi.fn(async () => { order.push('stop'); return { projectId: 'project-1', state: 'stopped' }; }),
      restart: vi.fn(async () => { order.push('restart'); return { projectId: 'project-1', state: 'healthy' }; }),
      emergencyStop: vi.fn(async () => { order.push('emergency'); return { projectId: 'project-1', state: 'stopped' }; })
    });
    const hermesMobile = service({ stopProject: vi.fn(async () => { order.push('mobile'); }) });
    const { handlers } = register({}, {}, undefined, projectWorkbench, { hermesServices, hermesMobile });

    await handlers.get('aibox:restartHermesProject')({}, 'project-1');
    await handlers.get('aibox:emergencyStopHermesProject')({}, 'project-1');
    await handlers.get('aibox:saveQuestSettings')({}, 'project-1', { model: 'model-b' });

    expect(order).toEqual(['restart', 'emergency', 'stop']);
    expect(hermesMobile.stopProject).not.toHaveBeenCalled();
  });

  it('toggles fullscreen on the standalone Quest sender window', () => {
    let fullscreen = false;
    const questWindow = {
      isDestroyed: () => false,
      isFullScreen: vi.fn(() => fullscreen),
      setFullScreen: vi.fn((value: boolean) => { fullscreen = value; })
    };
    const sender = {};
    BrowserWindow.fromWebContents
      .mockReturnValueOnce(questWindow)
      .mockReturnValueOnce(questWindow);
    const { handlers } = register();
    const event = { sender };

    expect(handlers.get('aibox:toggleFullscreen')(event)).toBe(true);
    expect(questWindow.setFullScreen).toHaveBeenCalledWith(true);
    expect(handlers.get('aibox:isFullscreen')(event)).toBe(true);
  });

  it('does not register the retired embedded DSH Workbench surface', async () => {
    const retired = register().handlers;
    for (const channel of [
      'aibox:openEmbeddedDshWorkbench', 'aibox:setEmbeddedDshWorkbenchBounds',
      'aibox:setEmbeddedDshWorkbenchVisible', 'aibox:setEmbeddedDshWorkbenchTheme',
      'aibox:closeEmbeddedDshWorkbench', 'aibox:getEmbeddedDshWorkbenchStatus'
    ]) expect(retired.has(channel)).toBe(false);
    return;
    const mainFrame = {};
    const host = {
      isDestroyed: () => false,
      webContents: { mainFrame },
      getContentSize: () => [1400, 900]
    };
    const agent = {
      id: 'agent-retired', archived: false, engineId: RETIRED_ENGINE_ID,
      workspace: process.cwd()
    };
    const orchestrator = service({
      onChange: vi.fn(), onOutput: vi.fn(), todos: vi.fn(() => []), stats: vi.fn(() => ({})),
      agentCards: vi.fn(() => []), listTasks: vi.fn(() => []), listApprovals: vi.fn(() => []),
      listAgents: vi.fn(() => [agent])
    });
    const projectWorkbench = service({
      getExplicitWorkspacePath: vi.fn(() => process.cwd()),
      get: vi.fn(() => ({
        project: { id: 'project-1' },
        rootSession: { sessionId: 'session-root', agentId: agent.id },
        settings: { orchestrator: 'dsh', workerAgentIds: [agent.id] }
      }))
    });
    const embeddedStatus = {
      open: true, attached: true, visible: true, loading: false,
      bounds: { x: 216, y: 100, width: 880, height: 680 }
    };
    const dsh = service({
      openEmbeddedWorkbench: vi.fn(async () => embeddedStatus),
      setEmbeddedWorkbenchBounds: vi.fn(() => embeddedStatus),
      setEmbeddedWorkbenchVisible: vi.fn(() => embeddedStatus),
      closeEmbeddedWorkbench: vi.fn(() => ({ ...embeddedStatus, open: false, visible: false })),
      getEmbeddedWorkbenchStatus: vi.fn(() => embeddedStatus)
    });
    const dshQuestSessions = service({
      resolveOrCreate: vi.fn(async () => ({
        localSessionId: 'session-root',
        upstreamSessionId: 'upstream-main-only',
        profileId: 'opc-nexus-managed-web-v1-project-test',
        runtimeWorkspace: process.cwd()
      }))
    });
    const { handlers, audit } = register({}, {}, undefined, projectWorkbench, {
      orchestrator,
      dsh,
      dshQuestSessions,
      getMainWindow: vi.fn(() => host)
    });
    const event = { sender: host.webContents, senderFrame: mainFrame };
    const input = {
      projectId: 'project-1', agentId: agent.id, sessionId: 'session-root',
      bounds: embeddedStatus.bounds
    };

    const response = await handlers.get('aibox:openEmbeddedDshWorkbench')(event, input);
    expect(response).toBe(embeddedStatus);
    expect(dshQuestSessions.resolveOrCreate).toHaveBeenCalledWith({
      projectId: 'project-1',
      agent,
      requestedSessionId: 'session-root'
    });
    expect(dsh.openEmbeddedWorkbench).toHaveBeenCalledWith(
      agent,
      host,
      embeddedStatus.bounds,
      'upstream-main-only',
      { profileId: 'opc-nexus-managed-web-v1-project-test', workspace: process.cwd() }
    );
    expect(response).not.toHaveProperty('upstreamSessionId');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'dsh.workbench.embed.open', target: 'project-1:agent-dsh', result: 'ok'
    }));
    expect(handlers.get('aibox:setEmbeddedDshWorkbenchBounds')(event, embeddedStatus.bounds)).toBe(embeddedStatus);
    expect(handlers.get('aibox:setEmbeddedDshWorkbenchVisible')(event, false)).toBe(embeddedStatus);
    expect(handlers.get('aibox:getEmbeddedDshWorkbenchStatus')(event)).toBe(embeddedStatus);
    expect(dsh.closeEmbeddedWorkbench).not.toHaveBeenCalled();
    await handlers.get('aibox:closeEmbeddedDshWorkbench')(event);
    expect(dsh.closeEmbeddedWorkbench).toHaveBeenCalledOnce();

    expect(handlers.get('aibox:setEmbeddedDshWorkbenchBounds')(event, {
      x: 100, y: 100, width: 1400, height: 900
    })).toBe(embeddedStatus);
    expect(dsh.setEmbeddedWorkbenchBounds).toHaveBeenLastCalledWith({
      x: 100, y: 100, width: 1300, height: 800
    });

    await expect(handlers.get('aibox:openEmbeddedDshWorkbench')(
      { sender: {}, senderFrame: {} }, input
    )).rejects.toThrow('可信的主应用或 Quest 窗口');
    expect(() => handlers.get('aibox:setEmbeddedDshWorkbenchBounds')(event, {
      x: 1200, y: 100, width: 400, height: 400
    })).toThrow('超出应用窗口');
    await expect(handlers.get('aibox:openEmbeddedDshWorkbench')(event, {
      ...input, sessionId: 'session-other'
    })).rejects.toThrow('不属于当前项目');
  });

  it('has no DSH project-binding race because DSH is an employee CLI only', async () => {
    expect(register().handlers.has('aibox:openEmbeddedDshWorkbench')).toBe(false);
    return;
    const mainFrame = {};
    const host = {
      isDestroyed: () => false,
      webContents: { mainFrame },
      getContentSize: () => [1400, 900]
    };
    const agent = {
      id: 'agent-retired', archived: false, engineId: RETIRED_ENGINE_ID,
      workspace: process.cwd()
    };
    const orchestrator = service({
      onChange: vi.fn(), onOutput: vi.fn(), todos: vi.fn(() => []), stats: vi.fn(() => ({})),
      agentCards: vi.fn(() => []), listTasks: vi.fn(() => []), listApprovals: vi.fn(() => []),
      listAgents: vi.fn(() => [agent])
    });
    const projectWorkbench = service({
      getExplicitWorkspacePath: vi.fn(() => process.cwd()),
      get: vi.fn(() => ({
        project: { id: 'project-1' },
        rootSession: { sessionId: 'session-root', agentId: agent.id },
        settings: { orchestrator: 'dsh', workerAgentIds: [agent.id] }
      }))
    });
    const embeddedStatus = {
      open: true, attached: true, visible: true, loading: false,
      bounds: { x: 216, y: 100, width: 880, height: 680 }
    };
    const dsh = service({
      openEmbeddedWorkbench: vi.fn(async () => embeddedStatus),
      closeEmbeddedWorkbench: vi.fn(async () => ({ ...embeddedStatus, open: false, visible: false }))
    });
    let resolveOldBinding!: (value: { localSessionId: string; upstreamSessionId: string; profileId: string; runtimeWorkspace: string }) => void;
    const oldBinding = new Promise<{ localSessionId: string; upstreamSessionId: string; profileId: string; runtimeWorkspace: string }>((resolve) => {
      resolveOldBinding = resolve;
    });
    let bindingCall = 0;
    const dshQuestSessions = service({
      resolveOrCreate: vi.fn(() => {
        bindingCall += 1;
        return bindingCall === 1
          ? oldBinding
          : Promise.resolve({
            localSessionId: 'session-root', upstreamSessionId: 'upstream-new',
            profileId: 'opc-nexus-managed-web-v1-project-test', runtimeWorkspace: process.cwd()
          });
      })
    });
    const { handlers } = register({}, {}, undefined, projectWorkbench, {
      orchestrator,
      dsh,
      dshQuestSessions,
      getMainWindow: vi.fn(() => host)
    });
    const event = { sender: host.webContents, senderFrame: mainFrame };
    const input = {
      projectId: 'project-1', agentId: agent.id, sessionId: 'session-root',
      bounds: embeddedStatus.bounds
    };

    const oldOpen = handlers.get('aibox:openEmbeddedDshWorkbench')(event, input);
    await vi.waitFor(() => expect(dshQuestSessions.resolveOrCreate).toHaveBeenCalledTimes(1));
    await expect(handlers.get('aibox:openEmbeddedDshWorkbench')(event, {
      ...input,
      sessionId: 'session-from-another-project'
    })).rejects.toThrow('不属于当前项目');
    expect(dshQuestSessions.resolveOrCreate).toHaveBeenCalledTimes(1);
    await expect(handlers.get('aibox:openEmbeddedDshWorkbench')(event, input)).resolves.toBe(embeddedStatus);
    resolveOldBinding({
      localSessionId: 'session-root', upstreamSessionId: 'upstream-old',
      profileId: 'opc-nexus-managed-web-v1-project-test', runtimeWorkspace: process.cwd()
    });
    await expect(oldOpen).rejects.toThrow('superseded');

    expect(dsh.openEmbeddedWorkbench).toHaveBeenCalledTimes(1);
    expect(dsh.openEmbeddedWorkbench).toHaveBeenCalledWith(
      agent,
      host,
      embeddedStatus.bounds,
      'upstream-new',
      { profileId: 'opc-nexus-managed-web-v1-project-test', workspace: process.cwd() }
    );
    expect(dsh.closeEmbeddedWorkbench).not.toHaveBeenCalled();

    let resolvePendingOpen!: (value: typeof embeddedStatus) => void;
    const pendingStatus = new Promise<typeof embeddedStatus>((resolve) => { resolvePendingOpen = resolve; });
    dsh.openEmbeddedWorkbench.mockImplementationOnce(() => pendingStatus);
    const pendingOpen = handlers.get('aibox:openEmbeddedDshWorkbench')(event, input);
    await vi.waitFor(() => expect(dsh.openEmbeddedWorkbench).toHaveBeenCalledTimes(2));
    const closing = handlers.get('aibox:closeEmbeddedDshWorkbench')(event);
    resolvePendingOpen(embeddedStatus);

    await expect(pendingOpen).rejects.toThrow('superseded');
    await expect(closing).resolves.toMatchObject({ open: false });
    expect(dsh.closeEmbeddedWorkbench).toHaveBeenCalledTimes(2);
  });

  it('opens the trusted Quest shell before any DSH Provider or runtime setup', async () => {
    const projectWorkbench = service({
      get: vi.fn(() => ({
        project: { id: 'project-1', status: 'active' },
        rootSession: null,
        settings: { workerAgentIds: [] }
      }))
    });
    const dshQuestSessions = service({
      resolveOrCreate: vi.fn(async () => {
        throw new Error('DSH Provider is not configured');
      })
    });
    const questWindows = {
      open: vi.fn(async (projectId: string) => ({
        open: true, visible: true, loading: false, projectId
      }))
    };
    const { handlers, audit } = register({}, {}, undefined, projectWorkbench, {
      dshQuestSessions,
      questWindows
    });

    await expect(handlers.get('aibox:openQuestWindow')({}, { projectId: 'project-1' }))
      .resolves.toEqual({ open: true, visible: true, loading: false, projectId: 'project-1' });
    expect(questWindows.open).toHaveBeenCalledWith('project-1');
    expect(dshQuestSessions.resolveOrCreate).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'quest.window.open', target: 'project-1', result: 'ok'
    }));

    projectWorkbench.get.mockReturnValueOnce({
      project: { id: 'project-archived', status: 'archived' },
      rootSession: null,
      settings: { workerAgentIds: [] }
    });
    await expect(handlers.get('aibox:openQuestWindow')({}, { projectId: 'project-archived' }))
      .rejects.toThrow('已归档项目不能打开 Quest');
    expect(questWindows.open).toHaveBeenCalledTimes(1);
  });

  it('restores the main control center only from a trusted app main frame', async () => {
    const questFrame = {};
    const questContents = { mainFrame: questFrame };
    const openMainSurface = vi.fn();
    const questWindows = {
      ownsWebContents: vi.fn((contents) => contents === questContents)
    };
    const { handlers, audit } = register({}, {}, undefined, undefined, {
      questWindows,
      openMainSurface,
      getMainWindow: vi.fn(() => null)
    });

    await expect(handlers.get('aibox:openMainSurface')({
      sender: questContents,
      senderFrame: questFrame
    })).resolves.toEqual({ ok: true });
    expect(openMainSurface).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'desktop.main.open', target: 'quest-window', result: 'ok'
    }));

    await expect(handlers.get('aibox:openMainSurface')({
      sender: { mainFrame: {} },
      senderFrame: {}
    })).rejects.toThrow('可信的应用窗口');
    expect(openMainSurface).toHaveBeenCalledOnce();
  });

  it('does not let a Quest shell acquire a DSH native View', async () => {
    const retired = register().handlers;
    expect(retired.has('aibox:openEmbeddedDshWorkbench')).toBe(false);
    expect(retired.has('aibox:openDshWorkbench')).toBe(false);
    return;
    const mainFrame = {};
    const mainContents = { mainFrame, isDestroyed: () => false, send: vi.fn() };
    const mainHost = {
      isDestroyed: () => false,
      isVisible: () => true,
      webContents: mainContents,
      getContentSize: () => [1400, 900]
    };
    let questDestroyed = false;
    const questFrame = {};
    const questContents = { mainFrame: questFrame, isDestroyed: () => questDestroyed };
    const questHost = {
      isDestroyed: () => questDestroyed,
      isVisible: () => !questDestroyed,
      webContents: questContents,
      getContentSize: () => [1440, 900]
    };
    const agent = {
      id: 'agent-retired', archived: false, engineId: RETIRED_ENGINE_ID,
      workspace: process.cwd()
    };
    const orchestrator = service({
      onChange: vi.fn(), onOutput: vi.fn(), todos: vi.fn(() => []), stats: vi.fn(() => ({})),
      agentCards: vi.fn(() => []), listTasks: vi.fn(() => []), listApprovals: vi.fn(() => []),
      listAgents: vi.fn(() => [agent])
    });
    const projectView = {
      project: { id: 'project-1', status: 'active' },
      rootSession: null,
      settings: { orchestrator: 'dsh', workerAgentIds: [agent.id] }
    };
    const projectWorkbench = service({
      getExplicitWorkspacePath: vi.fn(() => process.cwd()),
      get: vi.fn(() => projectView)
    });
    const embeddedStatus = {
      open: true, attached: true, visible: true, loading: false,
      bounds: { x: 0, y: 44, width: 1440, height: 856 }
    };
    const dsh = service({
      openEmbeddedWorkbench: vi.fn(async () => embeddedStatus),
      setEmbeddedWorkbenchBounds: vi.fn(() => embeddedStatus),
      setEmbeddedWorkbenchVisible: vi.fn(() => embeddedStatus),
      closeEmbeddedWorkbench: vi.fn(async () => ({ ...embeddedStatus, open: false })),
      getEmbeddedWorkbenchStatus: vi.fn(() => embeddedStatus)
    });
    const dshQuestSessions = service({
      resolveOrCreate: vi.fn(async () => ({
        localSessionId: 'session-root', upstreamSessionId: 'upstream-root',
        profileId: 'opc-nexus-managed-web-v1-project-test', runtimeWorkspace: process.cwd()
      }))
    });
    const questWindows = {
      open: vi.fn(async (projectId: string) => ({
        open: true, visible: true, loading: false, projectId
      })),
      ownsWebContents: vi.fn((contents) => contents === questContents),
      getWindow: vi.fn(() => questHost),
      getProjectId: vi.fn(() => 'project-1')
    };
    const { handlers, audit } = register({}, {}, undefined, projectWorkbench, {
      orchestrator,
      dsh,
      dshQuestSessions,
      questWindows,
      getMainWindow: vi.fn(() => mainHost)
    });

    await expect(handlers.get('aibox:openQuestWindow')({}, { projectId: 'project-1' }))
      .resolves.toMatchObject({ open: true, projectId: 'project-1' });
    expect(dshQuestSessions.resolveOrCreate).not.toHaveBeenCalled();
    expect(questWindows.open).toHaveBeenCalledWith('project-1');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'quest.window.open', target: 'project-1', result: 'ok'
    }));

    const mainEvent = { sender: mainContents, senderFrame: mainFrame };
    const questEvent = { sender: questContents, senderFrame: questFrame };
    const mainInput = {
      projectId: 'project-1', agentId: agent.id, sessionId: null,
      bounds: { x: 220, y: 80, width: 900, height: 700 }
    };
    const questInput = {
      ...mainInput,
      bounds: { x: 0, y: 44, width: 1440, height: 856 }
    };
    await handlers.get('aibox:openEmbeddedDshWorkbench')(mainEvent, mainInput);
    let resolveStaleQuestBinding!: (value: { localSessionId: string; upstreamSessionId: string; profileId: string; runtimeWorkspace: string }) => void;
    const staleQuestBinding = new Promise<{ localSessionId: string; upstreamSessionId: string; profileId: string; runtimeWorkspace: string }>((resolve) => {
      resolveStaleQuestBinding = resolve;
    });
    dshQuestSessions.resolveOrCreate.mockImplementationOnce(() => staleQuestBinding);
    const staleQuestOpen = handlers.get('aibox:openEmbeddedDshWorkbench')(questEvent, questInput);
    await vi.waitFor(() => expect(dshQuestSessions.resolveOrCreate).toHaveBeenCalledTimes(2));
    await handlers.get('aibox:openEmbeddedDshWorkbench')(questEvent, questInput);
    resolveStaleQuestBinding({
      localSessionId: 'session-root', upstreamSessionId: 'upstream-stale',
      profileId: 'opc-nexus-managed-web-v1-project-test', runtimeWorkspace: process.cwd()
    });
    await expect(staleQuestOpen).rejects.toThrow('superseded');
    expect(dsh.openEmbeddedWorkbench).toHaveBeenLastCalledWith(
      agent, questHost, questInput.bounds, 'upstream-root',
      { profileId: 'opc-nexus-managed-web-v1-project-test', workspace: process.cwd() }
    );
    expect(() => handlers.get('aibox:setEmbeddedDshWorkbenchBounds')(mainEvent, mainInput.bounds))
      .toThrow('由另一个窗口控制');

    questDestroyed = true;
    await expect(handlers.get('aibox:openEmbeddedDshWorkbench')(mainEvent, mainInput))
      .resolves.toBe(embeddedStatus);
    expect(dsh.openEmbeddedWorkbench).toHaveBeenLastCalledWith(
      agent, mainHost, mainInput.bounds, 'upstream-root',
      { profileId: 'opc-nexus-managed-web-v1-project-test', workspace: process.cwd() }
    );

    questDestroyed = false;
    dsh.openEmbeddedWorkbench.mockRejectedValueOnce(new Error('quest view failed'));
    await expect(handlers.get('aibox:openEmbeddedDshWorkbench')(questEvent, questInput))
      .rejects.toThrow('quest view failed');
    await vi.waitFor(() => expect(mainContents.send)
      .toHaveBeenCalledWith('aibox:questWindowClosed', null));
  });

  it('routes OCR through the opaque vision attachment boundary', async () => {
    const { handlers, vision, ocr } = register();
    const attachmentRef = {
      id: `vision-${'a'.repeat(64)}`,
      sha256: 'a'.repeat(64),
      bytes: 8,
      mimeType: 'image/png',
      filename: 'capture.png',
      uri: `aibox-vision://attachment/vision-${'a'.repeat(64)}`
    };

    await expect(handlers.get('aibox:ocrRecognize')({}, attachmentRef)).resolves.toMatchObject({ ok: true, text: 'hello' });
    expect(vision.readAttachment).toHaveBeenCalledWith(attachmentRef);
    expect(ocr.recognizeBytes).toHaveBeenCalledWith(expect.any(Buffer));

    await expect(handlers.get('aibox:ocrRecognize')({}, { path: 'C:\\secret.png' })).rejects.toThrow('attachmentRef is invalid');
    expect(ocr.recognizeBytes).toHaveBeenCalledTimes(1);
  });

  it('pushes a fresh snapshot immediately after engine configuration is saved', () => {
    vi.useFakeTimers();
    const window = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    const windows = vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([window as never]);
    try {
      const { handlers, engines } = register();
      expect(handlers.get('aibox:saveEngineConfig')({}, 'eng-codex', {
        providerMode: 'native', env: {}
      })).toEqual({ ok: true });
      expect(engines.saveConfig).toHaveBeenCalledWith('eng-codex', {
        providerMode: 'native', env: {}
      });
      expect(window.webContents.send).toHaveBeenCalledWith('aibox:snapshot', expect.any(Object));
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
      windows.mockRestore();
    }
  });

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

  it('blocks every legacy direct chat and exposes no Secretary planning IPC surface', async () => {
    const { handlers, audit, desktopControlPlane } = register();
    const chat = handlers.get('aibox:chatWithAgent');
    const complex = '请让多个团队分阶段完成系统迁移，先给计划，等我确认后再执行。';

    for (const channel of [
      'aibox:listPlanningSessions', 'aibox:getPlanningSession', 'aibox:createPlanningSession',
      'aibox:answerPlanningQuestions', 'aibox:proposePlanningPlan', 'aibox:approvePlanningPlan',
      'aibox:rejectPlanningPlan', 'aibox:dispatchPlanningPlan', 'aibox:preflightChatMessage'
    ]) expect(handlers.has(channel)).toBe(false);

    await expect(chat({}, 'agent-1', complex)).rejects.toThrow('HERMES_PROJECT_REQUIRED');
    expect(desktopControlPlane.dispatch).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'hermes.entry.required', result: 'project-workbench-required'
    }));
  });

  it('does not register DSH Quest owner channels', () => {
    const { handlers } = register();
    for (const channel of [
      'aibox:answerDshQuestQuestions', 'aibox:approveDshQuestPlan',
      'aibox:rejectDshQuestPlan', 'aibox:dispatchDshQuestPlan'
    ]) expect(handlers.has(channel)).toBe(false);
    return;
    // The DSH Quest path guards required fields through parseDshQuestIdentity's
    // own hasOwnProperty loop rather than assertKeys' required list, so it
    // reports "missing <key>". Both mechanisms must keep failing closed: an
    // absent identity field cannot reach governance as undefined.
    const incomplete = {
      planningSessionId: 'planning-1', projectId: 'proj-1', dshSessionId: 'dsh-1', expectedRevision: 1
    };
    for (const channel of ['aibox:answerDshQuestQuestions', 'aibox:approveDshQuestPlan', 'aibox:rejectDshQuestPlan']) {
      expect(() => handlers.get(channel)({}, incomplete)).toThrow(/missing principalId/);
    }
    // dispatchDshQuestPlan is async, so the same guard surfaces as a rejection.
    return expect(handlers.get('aibox:dispatchDshQuestPlan')({}, incomplete)).rejects.toThrow(/missing principalId/);
  });

  it('routes no owner decision through retired DSH governance', async () => {
    const retiredHandlers = register().handlers;
    expect(retiredHandlers.has('aibox:answerDshQuestQuestions')).toBe(false);
    expect(retiredHandlers.has('aibox:approveDshQuestPlan')).toBe(false);
    expect(retiredHandlers.has('aibox:rejectDshQuestPlan')).toBe(false);
    expect(retiredHandlers.has('aibox:dispatchDshQuestPlan')).toBe(false);
    return;
    const view = { binding: { planningSessionId: 'quest-1', projectId: 'project-1', dshSessionId: 'dsh-root-1', principalId: 'principal-1' } };
    const binding = {
      planningSessionId: 'quest-1', projectId: 'project-1', dshSessionId: 'dsh-root-1',
      organizationId: 'org-local', principalId: 'principal-1', createdAt: 1, updatedAt: 1
    };
    const governance = {
      getBinding: vi.fn(() => binding),
      answerQuestions: vi.fn(() => view),
      approvePlan: vi.fn(() => view),
      rejectPlan: vi.fn(() => view),
      dispatchPlan: vi.fn(async () => view)
    };
    const { handlers } = register({}, {}, governance);
    const identity = {
      planningSessionId: 'quest-1', projectId: 'project-1', dshSessionId: 'dsh-root-1',
      principalId: 'principal-1', expectedRevision: 1
    };
    const hash = 'a'.repeat(64);
    expect(handlers.get('aibox:answerDshQuestQuestions')({}, {
      ...identity, dshQuestionSetId: 'questions-1', dshVersion: 1,
      answers: [{ questionId: 'scope', selectedOptionIds: ['all'], text: null }]
    })).toBe(view);
    expect(governance.answerQuestions).toHaveBeenCalledWith(expect.objectContaining({
      planningSessionId: 'quest-1', principalId: 'principal-1', dshQuestionSetId: 'questions-1'
    }));
    expect(handlers.get('aibox:approveDshQuestPlan')({}, {
      ...identity, dshPlanId: 'plan-1', dshVersion: 1, hash
    })).toBe(view);
    expect(handlers.get('aibox:rejectDshQuestPlan')({}, {
      ...identity, dshPlanId: 'plan-1', dshVersion: 1, hash
    })).toBe(view);
    await expect(handlers.get('aibox:dispatchDshQuestPlan')({}, {
      ...identity, dshPlanId: 'plan-1', dshVersion: 1, hash
    })).resolves.toBe(view);
    expect(governance.approvePlan).toHaveBeenCalledTimes(1);
    expect(governance.rejectPlan).toHaveBeenCalledTimes(1);
    expect(governance.dispatchPlan).toHaveBeenCalledTimes(1);
    expect(governance.approvePlan).toHaveBeenCalledWith({
      planningSessionId: 'quest-1', principalId: 'principal-1', expectedRevision: 1,
      dshPlanId: 'plan-1', dshVersion: 1, hash
    });
    expect(governance.dispatchPlan).toHaveBeenCalledWith({
      planningSessionId: 'quest-1', principalId: 'principal-1', expectedRevision: 1,
      dshPlanId: 'plan-1', dshVersion: 1, hash
    });

    expect(() => handlers.get('aibox:approveDshQuestPlan')({}, {
      ...identity, projectId: 'project-other', dshPlanId: 'plan-1', dshVersion: 1, hash
    })).toThrowError(expect.objectContaining({ code: 'PROJECT_BOUNDARY' }));
    expect(handlers.has('aibox:answerPlanningQuestions')).toBe(false);
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
