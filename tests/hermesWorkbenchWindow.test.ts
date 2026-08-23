import { vi } from 'vitest';

const electronState = vi.hoisted(() => ({
  windows: [] as Array<{
    close: () => void;
    isDestroyed: () => boolean;
  }>
}));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');

  class FakeWebContents extends EventEmitter {
    destroyed = false;
    session = {
      cookies: {
        set: vi.fn(async () => undefined)
      }
    };
    setWindowOpenHandler = vi.fn();
    insertCSS = vi.fn(async () => 'css-key');
    executeJavaScript = vi.fn(async () => undefined);
    isDestroyed() { return this.destroyed; }
  }

  class FakeBrowserWindow extends EventEmitter {
    private readonly contents = new FakeWebContents();
    destroyed = false;
    visible = false;
    minimized = false;
    loadURL = vi.fn(async () => undefined);
    show = vi.fn(() => { this.visible = true; });
    focus = vi.fn();
    restore = vi.fn(() => { this.minimized = false; });

    constructor(public readonly options: unknown) {
      super();
      electronState.windows.push(this);
    }

    get webContents(): FakeWebContents {
      if (this.destroyed) throw new Error('Object has been destroyed');
      return this.contents;
    }

    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    close() {
      if (this.destroyed) return;
      this.contents.destroyed = true;
      this.destroyed = true;
      this.visible = false;
      this.emit('closed');
    }
  }

  return {
    BrowserWindow: FakeBrowserWindow,
    shell: { openExternal: vi.fn(async () => undefined) }
  };
});

import { HermesWorkbenchWindowManager } from '../src/main/services/hermesWorkbenchWindow.js';

function fixture() {
  const lease = {
    projectId: 'project-1',
    leaseId: 'lease-1',
    url: 'http://127.0.0.1:45123/',
    expiresAt: Date.now() + 60_000
  };
  const services = {
    start: vi.fn(async () => ({ state: 'healthy' })),
    getStatus: vi.fn(() => ({ state: 'healthy' })),
    createUiLease: vi.fn(() => lease),
    cookieForLease: vi.fn(() => ({ name: 'opc_hermes_session', value: 'lease-cookie' })),
    revokeUiLease: vi.fn(),
    stop: vi.fn(async () => undefined)
  };
  return { manager: new HermesWorkbenchWindowManager(services as never), services };
}

describe('HermesWorkbenchWindowManager', () => {
  beforeEach(() => {
    electronState.windows.length = 0;
  });

  it('closes a popped-out conversation without touching destroyed webContents', async () => {
    const { manager, services } = fixture();
    await manager.openConversation(
      'project-1',
      'hermes-conversation-12345678',
      'dark'
    );

    const window = electronState.windows[0];
    expect(() => window.close()).not.toThrow();
    expect(services.revokeUiLease).toHaveBeenCalledWith('project-1', 'lease-1');
  });

  it('closes the full Hermes Workbench without touching destroyed webContents', async () => {
    const { manager, services } = fixture();
    await manager.open('project-1');

    const window = electronState.windows[0];
    expect(() => window.close()).not.toThrow();
    expect(services.revokeUiLease).toHaveBeenCalledWith('project-1', 'lease-1');
    expect(manager.getStatus().open).toBe(false);
  });
});
