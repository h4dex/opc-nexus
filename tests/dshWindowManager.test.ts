import { vi } from 'vitest';

const electronState = vi.hoisted(() => ({
  windows: [] as any[],
  openedExternal: vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined),
  failNextLoad: false
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
    loadURL = vi.fn(async (_url: string) => undefined);
    setWindowOpenHandler(handler: any) { this.windowOpenHandler = handler; }
  }

  class FakeBrowserWindow extends EventEmitter {
    options: any;
    webContents = new FakeWebContents();
    destroyed = false;
    visible = false;
    minimized = false;
    loadURL = vi.fn(async (_url: string) => {
      if (electronState.failNextLoad) {
        electronState.failNextLoad = false;
        throw new Error('load failed');
      }
    });
    show = vi.fn(() => { this.visible = true; });
    focus = vi.fn();
    restore = vi.fn(() => { this.minimized = false; });

    constructor(options: any) {
      super();
      this.options = options;
      electronState.windows.push(this);
    }

    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    close() {
      this.destroyed = true;
      this.visible = false;
      this.emit('closed');
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.visible = false;
      this.emit('closed');
    }
  }

  return {
    BrowserWindow: FakeBrowserWindow,
    shell: { openExternal: electronState.openedExternal }
  };
});

import {
  DSH_WORKBENCH_PARTITION,
  DshWindowManager,
  isAllowedDshDownloadUrl,
  type DshWindowGateway
} from '../src/main/services/dshWindowManager.js';

function fakeEvent() {
  return { preventDefault: vi.fn() };
}

function gatewayFixture() {
  const origin = 'http://127.0.0.1:45678';
  const gateway: DshWindowGateway = {
    createDesktopSession: vi.fn(() => ({
      id: 'desktop-session-1',
      url: `${origin}/?__opc_dsh_bootstrap=secret`,
      expiresAt: Date.now() + 60_000
    })),
    revokeDesktopSession: vi.fn(() => true),
    isGatewayUrl: vi.fn((value: string) => {
      try { return new URL(value).origin === origin; } catch { return false; }
    })
  };
  return { gateway, origin };
}

describe('DshWindowManager', () => {
  beforeEach(() => {
    electronState.windows.length = 0;
    electronState.openedExternal.mockClear();
    electronState.failNextLoad = false;
  });

  it('creates a preload-free sandbox window in an independent persistent partition', async () => {
    const { gateway } = gatewayFixture();
    const manager = new DshWindowManager(gateway);
    const opened = await manager.open();

    expect(electronState.windows).toHaveLength(1);
    const window = electronState.windows[0];
    expect(window.options.webPreferences).toMatchObject({
      partition: DSH_WORKBENCH_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    });
    expect(window.options.webPreferences).not.toHaveProperty('preload');
    expect(window.loadURL).toHaveBeenCalledWith(expect.stringContaining('__opc_dsh_bootstrap='));
    expect(opened).toEqual({ open: true, visible: true, loading: false });
    expect(manager.getStatus()).toEqual({ open: true, visible: true, loading: false });

    window.minimized = true;
    await manager.open();
    expect(electronState.windows).toHaveLength(1);
    expect(gateway.createDesktopSession).toHaveBeenCalledTimes(1);
    expect(window.restore).toHaveBeenCalledOnce();
  });

  it('allows only Gateway navigation/downloads and delegates safe external links to the OS', async () => {
    const { gateway, origin } = gatewayFixture();
    const manager = new DshWindowManager(gateway);
    await manager.open();
    const window = electronState.windows[0];
    const contents = window.webContents;

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

    const externalFrame = { ...fakeEvent(), url: 'https://embed.invalid/', isMainFrame: false };
    contents.emit('will-frame-navigate', externalFrame);
    expect(externalFrame.preventDefault).toHaveBeenCalledOnce();
    expect(electronState.openedExternal).toHaveBeenCalledTimes(1);

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
    expect(isAllowedDshDownloadUrl('data:text/plain,bad', gateway)).toBe(false);

    const permission = vi.fn();
    contents.session.permissionHandler(contents, 'media', permission);
    expect(permission).toHaveBeenCalledWith(false);
  });

  it('revokes only the desktop session when closed and leaves the Gateway/runtime alive', async () => {
    const { gateway } = gatewayFixture();
    const manager = new DshWindowManager(gateway);
    await manager.open();
    const window = electronState.windows[0];
    const electronSession = window.webContents.session;

    manager.close();

    expect(gateway.revokeDesktopSession).toHaveBeenCalledWith('desktop-session-1');
    expect(manager.getStatus()).toEqual({ open: false, visible: false, loading: false });
    expect(electronSession.listenerCount('will-download')).toBe(0);
    expect(electronSession.permissionHandler).toBeNull();
    expect(gateway).not.toHaveProperty('stop');
  });

  it('destroys the isolated window and revokes its session when initial loading fails', async () => {
    const { gateway } = gatewayFixture();
    electronState.failNextLoad = true;
    const manager = new DshWindowManager(gateway);

    await expect(manager.open()).rejects.toThrow('load failed');

    expect(electronState.windows[0].isDestroyed()).toBe(true);
    expect(gateway.revokeDesktopSession).toHaveBeenCalledWith('desktop-session-1');
    expect(manager.getStatus()).toEqual({ open: false, visible: false, loading: false });
  });

  it('rejects a non-persistent partition configuration', () => {
    const { gateway } = gatewayFixture();
    expect(() => new DshWindowManager(gateway, { partition: 'temporary' })).toThrow('persistent');
  });
});
