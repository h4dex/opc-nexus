import { vi } from 'vitest';

const electronState = vi.hoisted(() => ({
  views: [] as any[],
  openedExternal: vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined),
  failNextLoad: false,
  pendingLoad: null as Promise<void> | null,
  pendingStorageCommand: null as Promise<void> | null,
  operations: [] as string[]
}));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');

  class FakeSession extends EventEmitter {
    permissionHandler: any = undefined;
    setPermissionRequestHandler(handler: any) { this.permissionHandler = handler; }
  }

  class FakeWebContents extends EventEmitter {
    session = new FakeSession();
    windowOpenHandler: any = null;
    destroyed = false;
    loadURL = vi.fn(async (_url: string) => {
      electronState.operations.push('loadURL');
      if (electronState.failNextLoad) {
        electronState.failNextLoad = false;
        throw new Error('load failed');
      }
      if (electronState.pendingLoad) await electronState.pendingLoad;
    });
    executeJavaScript = vi.fn(async (_script: string) => {
      electronState.operations.push('executeJavaScript');
      if (electronState.pendingStorageCommand) await electronState.pendingStorageCommand;
    });
    setWindowOpenHandler(handler: any) { this.windowOpenHandler = handler; }
    isDestroyed() { return this.destroyed; }
    close() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('destroyed');
    }
  }

  class FakeWebContentsView {
    options: any;
    webContents = new FakeWebContents();
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    visible = true;
    setBounds = vi.fn((bounds: any) => { this.bounds = { ...bounds }; });
    getBounds = vi.fn(() => ({ ...this.bounds }));
    setVisible = vi.fn((visible: boolean) => { this.visible = visible; });
    getVisible = vi.fn(() => this.visible);

    constructor(options: any) {
      this.options = options;
      electronState.views.push(this);
    }
  }

  return {
    WebContentsView: FakeWebContentsView,
    shell: { openExternal: electronState.openedExternal }
  };
});

import { EventEmitter } from 'node:events';
import {
  DSH_EMBEDDED_WORKBENCH_MIN_HEIGHT,
  DSH_EMBEDDED_WORKBENCH_MIN_WIDTH,
  DSH_EMBEDDED_WORKBENCH_PARTITION,
  DshEmbeddedWorkbenchManager,
  isValidDshEmbeddedWorkbenchBounds,
  validateDshEmbeddedWorkbenchBounds
} from '../src/main/services/dshEmbeddedWorkbench.js';
import type { DshWindowGateway } from '../src/main/services/dshWindowManager.js';

class FakeContentView {
  children: any[] = [];
  addChildView = vi.fn((view: any) => {
    this.children = this.children.filter((child) => child !== view);
    this.children.push(view);
  });
  removeChildView = vi.fn((view: any) => {
    this.children = this.children.filter((child) => child !== view);
  });
}

class FakeHostWebContents extends EventEmitter {
  destroyed = false;
  isDestroyed() { return this.destroyed; }
  destroyRenderer() {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

class FakeHostWindow extends EventEmitter {
  contentView = new FakeContentView();
  webContents = new FakeHostWebContents();
  destroyed = false;
  visible = true;
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  hideHost() {
    this.visible = false;
    this.emit('hide');
  }
  showHost() {
    this.visible = true;
    this.emit('show');
  }
  destroyHost() {
    this.destroyed = true;
    this.emit('closed');
  }
}

function fakeEvent(extra: Record<string, unknown> = {}) {
  return { preventDefault: vi.fn(), ...extra };
}

function gatewayFixture() {
  const origin = 'http://127.0.0.1:45678';
  let nextSession = 0;
  const gateway: DshWindowGateway = {
    createDesktopSession: vi.fn(() => {
      nextSession += 1;
      return {
        id: `desktop-session-${nextSession}`,
        url: `${origin}/?__opc_dsh_bootstrap=secret-${nextSession}`,
        expiresAt: Date.now() + 60_000
      };
    }),
    revokeDesktopSession: vi.fn(() => true),
    isGatewayUrl: vi.fn((value: string) => {
      try { return new URL(value).origin === origin; } catch { return false; }
    })
  };
  return { gateway, origin };
}

const initialBounds = { x: 240, y: 72, width: 960, height: 680 };

describe('DshEmbeddedWorkbenchManager', () => {
  beforeEach(() => {
    electronState.views.length = 0;
    electronState.openedExternal.mockClear();
    electronState.failNextLoad = false;
    electronState.pendingLoad = null;
    electronState.pendingStorageCommand = null;
    electronState.operations.length = 0;
  });

  it('validates native view bounds before applying them', () => {
    expect(isValidDshEmbeddedWorkbenchBounds(initialBounds)).toBe(true);
    expect(validateDshEmbeddedWorkbenchBounds(initialBounds)).toEqual(initialBounds);
    expect(isValidDshEmbeddedWorkbenchBounds({ ...initialBounds, x: -1 })).toBe(false);
    expect(isValidDshEmbeddedWorkbenchBounds({ ...initialBounds, width: 319 })).toBe(false);
    expect(isValidDshEmbeddedWorkbenchBounds({ ...initialBounds, height: 239 })).toBe(false);
    expect(isValidDshEmbeddedWorkbenchBounds({ ...initialBounds, width: 960.5 })).toBe(false);
    expect(isValidDshEmbeddedWorkbenchBounds(null)).toBe(false);
    expect(() => validateDshEmbeddedWorkbenchBounds({
      x: 0,
      y: 0,
      width: DSH_EMBEDDED_WORKBENCH_MIN_WIDTH,
      height: DSH_EMBEDDED_WORKBENCH_MIN_HEIGHT - 1
    })).toThrow('at least');
  });

  it('loads the official UI in a preload-free sandbox view and attaches it to the host', async () => {
    const { gateway } = gatewayFixture();
    const host = new FakeHostWindow();
    const manager = new DshEmbeddedWorkbenchManager(gateway);

    const opened = await manager.open(host as any, initialBounds);

    expect(electronState.views).toHaveLength(1);
    const view = electronState.views[0];
    expect(view.options.webPreferences).toMatchObject({
      partition: DSH_EMBEDDED_WORKBENCH_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false
    });
    expect(view.options.webPreferences).not.toHaveProperty('preload');
    expect(host.contentView.addChildView).toHaveBeenCalledWith(view);
    expect(view.webContents.loadURL).toHaveBeenCalledWith(expect.stringContaining('__opc_dsh_bootstrap='));
    expect(view.webContents.executeJavaScript).toHaveBeenCalledWith(
      'localStorage.removeItem("dsh.sessions.current")',
      false
    );
    expect(view.setVisible).toHaveBeenCalledWith(false);
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
    expect(opened).toEqual({
      open: true,
      attached: true,
      visible: true,
      loading: false,
      bounds: initialBounds
    });

    const resized = { x: 252, y: 84, width: 1040, height: 720 };
    expect(manager.setBounds(resized).bounds).toEqual(resized);
    expect(manager.setVisible(false).visible).toBe(false);
    expect(manager.setVisible(true).visible).toBe(true);

    await manager.open(host as any, resized);
    expect(electronState.views).toHaveLength(1);
    expect(gateway.createDesktopSession).toHaveBeenCalledTimes(1);
  });

  it('injects the Main-approved upstream selection before the official runtime loads', async () => {
    const { gateway } = gatewayFixture();
    const host = new FakeHostWindow();
    const manager = new DshEmbeddedWorkbenchManager(gateway);

    await manager.open(host as any, initialBounds, 'upstream-project-root');

    const view = electronState.views[0];
    expect(gateway.createDesktopSession).toHaveBeenCalledWith({
      rootUpstreamSessionId: 'upstream-project-root'
    });
    expect(view.webContents.executeJavaScript).toHaveBeenCalledWith(
      'localStorage.setItem("dsh.sessions.current", "{\\"sessionId\\":\\"upstream-project-root\\"}")',
      false
    );
    const firstOfficialLoad = electronState.operations.lastIndexOf('loadURL');
    expect(electronState.operations.indexOf('executeJavaScript')).toBeLessThan(firstOfficialLoad);
  });

  it('clears a stale partition selection and recreates the view when project selection changes', async () => {
    const { gateway } = gatewayFixture();
    const host = new FakeHostWindow();
    const manager = new DshEmbeddedWorkbenchManager(gateway);
    await manager.open(host as any, initialBounds, 'upstream-first-project');

    await manager.open(host as any, initialBounds, null);

    expect(electronState.views).toHaveLength(2);
    expect(gateway.createDesktopSession).toHaveBeenLastCalledWith(null);
    expect(electronState.views[0].webContents.isDestroyed()).toBe(true);
    expect(electronState.views[1].webContents.executeJavaScript).toHaveBeenCalledWith(
      'localStorage.removeItem("dsh.sessions.current")',
      false
    );
    expect(gateway.revokeDesktopSession).toHaveBeenCalledWith('desktop-session-1');
  });

  it('moves one live view between hosts and destroys it with its desktop session', async () => {
    const { gateway } = gatewayFixture();
    const firstHost = new FakeHostWindow();
    const secondHost = new FakeHostWindow();
    const manager = new DshEmbeddedWorkbenchManager(gateway);
    await manager.open(firstHost as any, initialBounds);
    const view = electronState.views[0];
    const electronSession = view.webContents.session;

    manager.attach(secondHost as any);
    expect(firstHost.contentView.removeChildView).toHaveBeenCalledWith(view);
    expect(secondHost.contentView.addChildView).toHaveBeenCalledWith(view);
    expect(firstHost.listenerCount('closed')).toBe(0);
    expect(secondHost.listenerCount('closed')).toBe(1);

    const closed = manager.close();
    expect(secondHost.contentView.removeChildView).toHaveBeenCalledWith(view);
    expect(view.webContents.isDestroyed()).toBe(true);
    expect(gateway.revokeDesktopSession).toHaveBeenCalledWith('desktop-session-1');
    expect(electronSession.listenerCount('will-download')).toBe(0);
    expect(electronSession.permissionHandler).toBeNull();
    expect(view.webContents.listenerCount('will-navigate')).toBe(0);
    expect(view.webContents.listenerCount('will-redirect')).toBe(0);
    expect(view.webContents.listenerCount('will-frame-navigate')).toBe(0);
    expect(view.webContents.listenerCount('will-attach-webview')).toBe(0);
    expect(view.webContents.listenerCount('destroyed')).toBe(0);
    expect(secondHost.listenerCount('closed')).toBe(0);
    expect(secondHost.listenerCount('hide')).toBe(0);
    expect(secondHost.listenerCount('show')).toBe(0);
    expect(secondHost.webContents.listenerCount('did-start-navigation')).toBe(0);
    expect(secondHost.webContents.listenerCount('render-process-gone')).toBe(0);
    expect(secondHost.webContents.listenerCount('destroyed')).toBe(0);
    expect(closed).toEqual({ open: false, attached: false, visible: false, loading: false, bounds: null });
  });

  it('draws only when both the caller and host request visibility', async () => {
    const { gateway } = gatewayFixture();
    const host = new FakeHostWindow();
    host.hideHost();
    const manager = new DshEmbeddedWorkbenchManager(gateway);

    const opened = await manager.open(host as any, initialBounds);
    const view = electronState.views[0];
    expect(opened.visible).toBe(false);
    expect(view.getVisible()).toBe(false);

    host.showHost();
    expect(manager.getStatus().visible).toBe(true);
    host.hideHost();
    expect(manager.getStatus().visible).toBe(false);

    manager.setVisible(false);
    host.showHost();
    expect(manager.getStatus().visible).toBe(false);
    host.hideHost();
    manager.setVisible(true);
    expect(manager.getStatus().visible).toBe(false);
    host.showHost();
    expect(manager.getStatus().visible).toBe(true);
  });

  it('releases the view and session when its BrowserWindow host is destroyed', async () => {
    const { gateway } = gatewayFixture();
    const host = new FakeHostWindow();
    const manager = new DshEmbeddedWorkbenchManager(gateway);
    await manager.open(host as any, initialBounds);
    const view = electronState.views[0];

    host.destroyHost();

    expect(view.webContents.isDestroyed()).toBe(true);
    expect(gateway.revokeDesktopSession).toHaveBeenCalledWith('desktop-session-1');
    expect(manager.getStatus().open).toBe(false);
  });

  it('allows only Gateway navigation/downloads and delegates safe external URLs', async () => {
    const { gateway, origin } = gatewayFixture();
    const host = new FakeHostWindow();
    const manager = new DshEmbeddedWorkbenchManager(gateway);
    await manager.open(host as any, initialBounds);
    const contents = electronState.views[0].webContents;

    const internalNavigation = fakeEvent();
    contents.emit('will-navigate', internalNavigation, `${origin}/session/1`);
    expect(internalNavigation.preventDefault).not.toHaveBeenCalled();

    const externalNavigation = fakeEvent();
    contents.emit('will-navigate', externalNavigation, 'https://docs.deepseek.com/');
    expect(externalNavigation.preventDefault).toHaveBeenCalledOnce();
    expect(electronState.openedExternal).toHaveBeenCalledWith('https://docs.deepseek.com/');

    const unsafeNavigation = fakeEvent();
    contents.emit('will-redirect', unsafeNavigation, 'javascript:alert(1)');
    expect(unsafeNavigation.preventDefault).toHaveBeenCalledOnce();
    expect(electronState.openedExternal).toHaveBeenCalledTimes(1);

    const externalMainFrame = fakeEvent({ url: 'https://embed.invalid/', isMainFrame: true });
    contents.emit('will-frame-navigate', externalMainFrame);
    expect(externalMainFrame.preventDefault).toHaveBeenCalledOnce();
    const externalSubframe = fakeEvent({ url: 'https://embed.invalid/', isMainFrame: false });
    contents.emit('will-frame-navigate', externalSubframe);
    expect(externalSubframe.preventDefault).toHaveBeenCalledOnce();

    const webview = fakeEvent();
    contents.emit('will-attach-webview', webview);
    expect(webview.preventDefault).toHaveBeenCalledOnce();

    expect(contents.windowOpenHandler({ url: `${origin}/artifact/1` })).toEqual({ action: 'deny' });
    expect(contents.loadURL).toHaveBeenCalledWith(`${origin}/artifact/1`);
    expect(contents.windowOpenHandler({ url: 'mailto:owner@example.com' })).toEqual({ action: 'deny' });
    expect(electronState.openedExternal).toHaveBeenCalledWith('mailto:owner@example.com');

    const internalDownload = fakeEvent();
    contents.session.emit('will-download', internalDownload, { getURL: () => `${origin}/download/1` }, contents);
    expect(internalDownload.preventDefault).not.toHaveBeenCalled();
    const blobDownload = fakeEvent();
    contents.session.emit('will-download', blobDownload, { getURL: () => `blob:${origin}/asset-id` }, contents);
    expect(blobDownload.preventDefault).not.toHaveBeenCalled();
    const externalDownload = fakeEvent();
    contents.session.emit('will-download', externalDownload, { getURL: () => 'https://evil.invalid/file' }, contents);
    expect(externalDownload.preventDefault).toHaveBeenCalledOnce();

    const permission = vi.fn();
    contents.session.permissionHandler(contents, 'media', permission);
    expect(permission).toHaveBeenCalledWith(false);
  });

  it('deduplicates concurrent opens while loading', async () => {
    const { gateway } = gatewayFixture();
    const host = new FakeHostWindow();
    const manager = new DshEmbeddedWorkbenchManager(gateway);
    let resolveLoad!: () => void;
    electronState.pendingLoad = new Promise<void>((resolve) => { resolveLoad = resolve; });

    const first = manager.open(host as any, initialBounds);
    const second = manager.open(host as any, initialBounds);
    expect(manager.getStatus()).toMatchObject({ open: true, attached: true, visible: false, loading: true });
    expect(gateway.createDesktopSession).toHaveBeenCalledTimes(1);

    resolveLoad();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(electronState.views).toHaveLength(1);
  });

  it('never makes a stale pending load visible after close', async () => {
    const { gateway } = gatewayFixture();
    const host = new FakeHostWindow();
    const manager = new DshEmbeddedWorkbenchManager(gateway);
    let resolveLoad!: () => void;
    electronState.pendingLoad = new Promise<void>((resolve) => { resolveLoad = resolve; });

    const opening = manager.open(host as any, initialBounds);
    const view = electronState.views[0];
    expect(manager.getStatus().loading).toBe(true);

    manager.close();
    expect(manager.getStatus().open).toBe(false);
    resolveLoad();
    await expect(opening).rejects.toThrow('closed while loading');
    expect(view.setVisible).not.toHaveBeenCalledWith(true);
    expect(gateway.revokeDesktopSession).toHaveBeenCalledTimes(1);
  });

  it('fences close while the pre-load selection write is pending', async () => {
    const { gateway } = gatewayFixture();
    const host = new FakeHostWindow();
    const manager = new DshEmbeddedWorkbenchManager(gateway);
    let resolveStorage!: () => void;
    electronState.pendingStorageCommand = new Promise<void>((resolve) => { resolveStorage = resolve; });

    const opening = manager.open(host as any, initialBounds, 'upstream-pending');
    await vi.waitFor(() => {
      expect(electronState.operations).toContain('executeJavaScript');
    });
    const view = electronState.views[0];
    manager.close();
    resolveStorage();

    await expect(opening).rejects.toThrow('closed while loading');
    expect(view.webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(view.webContents.loadURL).toHaveBeenCalledWith(expect.stringContaining('__opc_dsh_storage_bootstrap=1'));
    expect(view.setVisible).not.toHaveBeenCalledWith(true);
    expect(gateway.revokeDesktopSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['main-frame navigation', (host: FakeHostWindow) => {
      host.webContents.emit('did-start-navigation', {
        isMainFrame: true,
        isSameDocument: false
      });
    }],
    ['renderer crash', (host: FakeHostWindow) => {
      host.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    }],
    ['renderer destruction', (host: FakeHostWindow) => {
      host.webContents.destroyRenderer();
    }]
  ])('closes and revokes on host %s', async (_label, terminateHost) => {
    const { gateway } = gatewayFixture();
    const host = new FakeHostWindow();
    const manager = new DshEmbeddedWorkbenchManager(gateway);
    await manager.open(host as any, initialBounds);
    const view = electronState.views[0];

    terminateHost(host);

    expect(view.webContents.isDestroyed()).toBe(true);
    expect(gateway.revokeDesktopSession).toHaveBeenCalledWith('desktop-session-1');
    expect(manager.getStatus().open).toBe(false);
    expect(host.listenerCount('hide')).toBe(0);
    expect(host.listenerCount('show')).toBe(0);
    expect(host.webContents.listenerCount('did-start-navigation')).toBe(0);
    expect(host.webContents.listenerCount('render-process-gone')).toBe(0);
    expect(host.webContents.listenerCount('destroyed')).toBe(0);
  });

  it('keeps the view on subframe and same-document host navigation', async () => {
    const { gateway } = gatewayFixture();
    const host = new FakeHostWindow();
    const manager = new DshEmbeddedWorkbenchManager(gateway);
    await manager.open(host as any, initialBounds);

    host.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    host.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });

    expect(manager.getStatus().open).toBe(true);
    expect(gateway.revokeDesktopSession).not.toHaveBeenCalled();
  });

  it('destroys the view and revokes the desktop session when loading fails', async () => {
    const { gateway } = gatewayFixture();
    const host = new FakeHostWindow();
    electronState.failNextLoad = true;
    const manager = new DshEmbeddedWorkbenchManager(gateway);

    await expect(manager.open(host as any, initialBounds)).rejects.toThrow('load failed');

    expect(electronState.views[0].webContents.isDestroyed()).toBe(true);
    expect(host.contentView.removeChildView).toHaveBeenCalledWith(electronState.views[0]);
    expect(gateway.revokeDesktopSession).toHaveBeenCalledWith('desktop-session-1');
    expect(manager.getStatus()).toEqual({
      open: false,
      attached: false,
      visible: false,
      loading: false,
      bounds: null
    });
  });

  it('rejects unsafe partitions, invalid bounds, and destroyed hosts', async () => {
    const { gateway } = gatewayFixture();
    expect(() => new DshEmbeddedWorkbenchManager(gateway, { partition: 'temporary' })).toThrow('persistent');

    const host = new FakeHostWindow();
    const manager = new DshEmbeddedWorkbenchManager(gateway);
    await expect(manager.open(host as any, { ...initialBounds, width: 1 })).rejects.toThrow('bounds');
    expect(gateway.createDesktopSession).not.toHaveBeenCalled();
    await expect(manager.open(host as any, initialBounds, 'bad\u0000session')).rejects.toThrow('selection');
    expect(gateway.createDesktopSession).not.toHaveBeenCalled();

    host.destroyHost();
    await expect(manager.open(host as any, initialBounds)).rejects.toThrow('destroyed window');
  });
});
