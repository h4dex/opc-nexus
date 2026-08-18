// @ts-nocheck
/* eslint-disable */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const { BrowserWindow, clipboard, dialog, ipcMain, shell } = await import('electron');
const { registerIpc } = await import('../src/main/ipc.js');
const { SecretaryPlanningControlPlane } = await import('../src/main/services/secretaryPlanningControlPlane.js');
const { BRIDGE_KEY_SECRET_REF } = await import('../src/main/services/apiBridge.js');
const { WEB_TOKEN_SECRET_REF } = await import('../src/main/services/webServer.js');
const { DSH_MANAGED_ENGINE_ID } = await import('../src/shared/types.js');

function service(overrides: Record<string, unknown> = {}) {
  return new Proxy(overrides, {
    get(target, key) {
      if (key in target) return target[key as string];
      return vi.fn();
    }
  });
}

function register(
  webOverrides: Record<string, unknown> = {},
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
    webServer,
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
    audit, handlers, webServer, memory, memoryProposals, taskScheduleProposals,
    orchestrator, desktopControlPlane, engines, vision, ocr
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('IPC credential boundary', () => {
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

  it('keeps embedded DSH URLs in Main and validates project, sender, and native bounds', async () => {
    const mainFrame = {};
    const host = {
      isDestroyed: () => false,
      webContents: { mainFrame },
      getContentSize: () => [1400, 900]
    };
    const agent = {
      id: 'agent-dsh', archived: false, engineId: DSH_MANAGED_ENGINE_ID,
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
        rootSession: { sessionId: 'session-root', agentId: agent.id }
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

  it('prevents a late project binding from overwriting a newer embedded Quest request', async () => {
    const mainFrame = {};
    const host = {
      isDestroyed: () => false,
      webContents: { mainFrame },
      getContentSize: () => [1400, 900]
    };
    const agent = {
      id: 'agent-dsh', archived: false, engineId: DSH_MANAGED_ENGINE_ID,
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
        rootSession: { sessionId: 'session-root', agentId: agent.id }
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

  it('opens a project-scoped Quest shell and gives its trusted window exclusive native View ownership', async () => {
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
      id: 'agent-dsh', archived: false, engineId: DSH_MANAGED_ENGINE_ID,
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
      settings: { workerAgentIds: [agent.id] }
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
      .toThrow('另一个 Quest 窗口');

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

  it('preflights complex chat into planning and blocks direct Task creation', async () => {
    const planningSession = { id: 'planning-session-1' };
    const createSession = vi.spyOn(SecretaryPlanningControlPlane.prototype, 'createSession')
      .mockReturnValue(planningSession as never);
    try {
      const { handlers, audit, desktopControlPlane } = register();
      const preflight = handlers.get('aibox:preflightChatMessage');
      const chat = handlers.get('aibox:chatWithAgent');
      const complex = '请让多个团队分阶段完成系统迁移，先给计划，等我确认后再执行。';

      expect(preflight({}, '解释一下 TypeScript 的 unknown 类型')).toEqual({
        outcome: 'DIRECT_DISPATCH', planningSession: null
      });
      expect(preflight({}, complex)).toEqual({
        outcome: 'PLANNING_REQUIRED', planningSession
      });
      expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
        request: complex,
        signals: expect.objectContaining({
          hasCrossTeamDependencies: true,
          phasedExecution: true,
          confirmBeforeExecution: true
        })
      }));

      await expect(chat({}, 'agent-1', complex)).rejects.toThrow('QUEST_REQUIRED');
      expect(desktopControlPlane.dispatch).not.toHaveBeenCalled();
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'quest.chat.blocked', result: 'quest-required'
      }));
    } finally {
      createSession.mockRestore();
    }
  });

  it('accepts bounded planning text and creates the first proposal through the public IPC contract', () => {
    const created = { id: 'planning-1', revision: 1 };
    const answered = { id: 'planning-1', revision: 2 };
    const proposed = { id: 'planning-1', revision: 3, status: 'PROPOSED' };
    const createSession = vi.spyOn(SecretaryPlanningControlPlane.prototype, 'createSession').mockReturnValue(created as never);
    const answerQuestions = vi.spyOn(SecretaryPlanningControlPlane.prototype, 'answerQuestions').mockReturnValue(answered as never);
    const proposePlan = vi.spyOn(SecretaryPlanningControlPlane.prototype, 'proposePlan').mockReturnValue(proposed as never);
    try {
      const { handlers } = register();
      const planningInput = {
        request: '为新产品制定跨部门交付计划',
        signals: {
          departmentIds: ['product', 'engineering'], hasCrossTeamDependencies: true,
          ambiguousObjective: false, ambiguousScope: true, ambiguousAcceptance: true,
          estimatedDurationMinutes: 240, estimatedCost: 0, estimatedTokenCount: 20_000,
          requiresNewTeam: false, irreversibleOperations: ['write_files'],
          compareAlternatives: false, phasedExecution: true, confirmBeforeExecution: true,
          estimatedTaskCount: 4
        }
      };
      expect(handlers.get('aibox:createPlanningSession')({}, planningInput)).toBe(created);
      expect(createSession).toHaveBeenCalledWith(planningInput);

      const answerInput = {
        sessionId: 'planning-1', expectedRevision: 1, questionSetVersion: 1,
        answers: [{ questionId: 'scope', selectedOptionIds: ['mvp'], text: '只在项目目录内产出，验收时提供启动命令。' }]
      };
      expect(handlers.get('aibox:answerPlanningQuestions')({}, answerInput)).toBe(answered);
      expect(answerQuestions).toHaveBeenCalledWith(answerInput);

      const proposalInput = { sessionId: 'planning-1', expectedRevision: 2 };
      expect(handlers.get('aibox:proposePlanningPlan')({}, proposalInput)).toBe(proposed);
      expect(proposePlan).toHaveBeenCalledWith(proposalInput);
      expect(() => handlers.get('aibox:proposePlanningPlan')({}, {
        ...proposalInput, version: 1, hash: 'a'.repeat(64)
      })).toThrow(/未知字段/);
    } finally {
      createSession.mockRestore();
      answerQuestions.mockRestore();
      proposePlan.mockRestore();
    }
  });

  it('enforces the 4000-character planning answer boundary without rejecting short text', () => {
    const answerQuestions = vi.spyOn(SecretaryPlanningControlPlane.prototype, 'answerQuestions')
      .mockReturnValue({ id: 'planning-1' } as never);
    try {
      const { handlers } = register();
      const base = {
        sessionId: 'planning-1', expectedRevision: 1, questionSetVersion: 1,
        answers: [{ questionId: 'scope', selectedOptionIds: [], text: '' }]
      };
      expect(() => handlers.get('aibox:answerPlanningQuestions')({}, base)).not.toThrow();
      expect(() => handlers.get('aibox:answerPlanningQuestions')({}, {
        ...base, answers: [{ ...base.answers[0], text: '界'.repeat(4_000) }]
      })).not.toThrow();
      expect(() => handlers.get('aibox:answerPlanningQuestions')({}, {
        ...base, answers: [{ ...base.answers[0], text: '界'.repeat(4_001) }]
      })).toThrow(/0-4000/);
    } finally {
      answerQuestions.mockRestore();
    }
  });

  it('rejects payloads that omit a declared field instead of forwarding a malformed shape', () => {
    const proposePlan = vi.spyOn(SecretaryPlanningControlPlane.prototype, 'proposePlan')
      .mockReturnValue({ id: 'planning-1' } as never);
    const approvePlan = vi.spyOn(SecretaryPlanningControlPlane.prototype, 'approvePlan')
      .mockReturnValue({ id: 'planning-1' } as never);
    try {
      const { handlers } = register();
      expect(() => handlers.get('aibox:proposePlanningPlan')({}, { sessionId: 'planning-1' })).toThrow(/缺少必需字段/);
      expect(() => handlers.get('aibox:proposePlanningPlan')({}, { expectedRevision: 1 })).toThrow(/缺少必需字段/);
      expect(() => handlers.get('aibox:approvePlanningPlan')({}, {
        sessionId: 'planning-1', expectedRevision: 1, version: 1
      })).toThrow(/缺少必需字段/);
      expect(proposePlan).not.toHaveBeenCalled();
      expect(approvePlan).not.toHaveBeenCalled();
    } finally {
      proposePlan.mockRestore();
      approvePlan.mockRestore();
    }
  });

  it('rejects DSH Quest payloads that omit an identity field', () => {
    const { handlers } = register();
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

  it('routes DSH-bound Quest owner decisions through governance and enforces project identity', async () => {
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
    expect(handlers.get('aibox:answerPlanningQuestions')({}, {
      ...identity, dshQuestionSetId: 'questions-1', dshVersion: 1,
      answers: [{ questionId: 'scope', selectedOptionIds: ['all'], text: null }]
    })).toBe(view);
    expect(governance.answerQuestions).toHaveBeenCalledWith(expect.objectContaining({
      planningSessionId: 'quest-1', principalId: 'principal-1', dshQuestionSetId: 'questions-1'
    }));
    expect(handlers.get('aibox:approvePlanningPlan')({}, {
      ...identity, dshPlanId: 'plan-1', dshVersion: 1, hash
    })).toBe(view);
    expect(handlers.get('aibox:rejectDshQuestPlan')({}, {
      ...identity, dshPlanId: 'plan-1', dshVersion: 1, hash
    })).toBe(view);
    await expect(handlers.get('aibox:dispatchPlanningPlan')({}, {
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
    // An old Secretary-shaped payload cannot target a DSH binding and silently
    // fall through to the compatibility controller.
    expect(() => handlers.get('aibox:answerPlanningQuestions')({}, {
      sessionId: 'quest-1', expectedRevision: 1, questionSetVersion: 1, answers: []
    })).toThrow();
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
