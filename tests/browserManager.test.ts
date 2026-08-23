import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const localContexts: Array<ReturnType<typeof makeContext>> = [];
  const externalBrowsers: Array<ReturnType<typeof makeBrowser>> = [];

  function makeContext() {
    const page = {
      goto: vi.fn(), title: vi.fn(), click: vi.fn(), fill: vi.fn(),
      $: vi.fn(), screenshot: vi.fn(), evaluate: vi.fn(), innerText: vi.fn(),
      waitForSelector: vi.fn()
    };
    return { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined), page };
  }

  function makeBrowser(contexts: Array<ReturnType<typeof makeContext>>) {
    const disconnectedListeners = new Set<() => void>();
    const isConnected = vi.fn(() => true);
    return {
      newContext: vi.fn(async () => {
        const context = makeContext();
        contexts.push(context);
        return context;
      }),
      close: vi.fn(async () => undefined),
      isConnected,
      once: vi.fn((event: string, listener: () => void) => {
        if (event === 'disconnected') disconnectedListeners.add(listener);
      }),
      emitDisconnected: () => {
        isConnected.mockReturnValue(false);
        const listeners = [...disconnectedListeners];
        disconnectedListeners.clear();
        listeners.forEach((listener) => listener());
      },
      resetConnection: () => {
        disconnectedListeners.clear();
        isConnected.mockReturnValue(true);
      }
    };
  }

  const localBrowser = makeBrowser(localContexts);
  const launch = vi.fn(async () => localBrowser);
  const connectOverCDP = vi.fn(async () => {
    const browser = makeBrowser([]);
    externalBrowsers.push(browser);
    return browser;
  });

  return { localBrowser, localContexts, externalBrowsers, launch, connectOverCDP };
});

vi.mock('electron', async () => await import('./__mocks__/electron.js'));
const { BrowserManager, resolveBrowserExecutable } = await import('../src/main/services/browserManager.js');

const managers: InstanceType<typeof BrowserManager>[] = [];

function createManager(): InstanceType<typeof BrowserManager> {
  const manager = new BrowserManager(async () => ({
    chromium: { launch: mocks.launch, connectOverCDP: mocks.connectOverCDP }
  }) as never);
  managers.push(manager);
  return manager;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.localContexts.length = 0;
  mocks.externalBrowsers.length = 0;
  mocks.localBrowser.resetConnection();
  mocks.localBrowser.newContext.mockImplementation(async () => {
    const page = {
      goto: vi.fn(), title: vi.fn(), click: vi.fn(), fill: vi.fn(),
      $: vi.fn(), screenshot: vi.fn(), evaluate: vi.fn(), innerText: vi.fn(),
      waitForSelector: vi.fn()
    };
    const context = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined), page };
    mocks.localContexts.push(context);
    return context;
  });
});

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.dispose()));
  vi.useRealTimers();
});

describe('BrowserManager shared Chromium lifecycle', () => {
  it('finds an installed system browser without requiring a Playwright download', () => {
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const chrome = 'C:\\Users\\owner\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
    expect(resolveBrowserExecutable('win32', {
      'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\owner\\AppData\\Local'
    }, (path) => path === edge || path === chrome)).toBe(edge);
    expect(resolveBrowserExecutable('linux', {}, (path) => path === '/usr/bin/chromium')).toBe('/usr/bin/chromium');
    expect(resolveBrowserExecutable('linux', {}, () => false)).toBeNull();
  });

  it('shares one local Chromium while keeping one context per agent', async () => {
    const manager = createManager();

    const [first, second] = await Promise.all([
      manager.getSession('agent-a'),
      manager.getSession('agent-b')
    ]);

    expect(mocks.launch).toHaveBeenCalledTimes(1);
    expect(mocks.localBrowser.newContext).toHaveBeenCalledTimes(2);
    expect(first.browser).toBe(second.browser);
    expect(first.context).not.toBe(second.context);

    await manager.closeSession('agent-a');
    expect(first.context.close).toHaveBeenCalledTimes(1);
    expect(mocks.localBrowser.close).not.toHaveBeenCalled();

    await manager.closeSession('agent-b');
    expect(second.context.close).toHaveBeenCalledTimes(1);
    expect(mocks.localBrowser.close).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent creation requests for the same agent', async () => {
    const manager = createManager();

    const [first, second] = await Promise.all([
      manager.getSession('agent-a'),
      manager.getSession('agent-a')
    ]);

    expect(first).toBe(second);
    expect(mocks.launch).toHaveBeenCalledTimes(1);
    expect(mocks.localBrowser.newContext).toHaveBeenCalledTimes(1);
  });

  it('waits for an in-flight session before closing it', async () => {
    const manager = createManager();
    let finishLaunch!: (browser: typeof mocks.localBrowser) => void;
    mocks.launch.mockImplementationOnce(() => new Promise((resolve) => { finishLaunch = resolve; }));

    const creating = manager.getSession('agent-a');
    const closing = manager.closeSession('agent-a');
    await vi.waitFor(() => expect(mocks.launch).toHaveBeenCalledTimes(1));
    finishLaunch(mocks.localBrowser);

    const session = await creating;
    await closing;
    expect(session.context.close).toHaveBeenCalledTimes(1);
    expect(mocks.localBrowser.close).toHaveBeenCalledTimes(1);
  });

  it('does not close Chromium before an overlapping context close finishes', async () => {
    const manager = createManager();
    const session = await manager.getSession('agent-a');
    let finishContextClose!: () => void;
    session.context.close = vi.fn(() => new Promise<void>((resolve) => { finishContextClose = resolve; }));

    const firstClose = manager.closeSession('agent-a');
    const overlappingClose = manager.closeSession('agent-a');
    await Promise.resolve();
    expect(mocks.localBrowser.close).not.toHaveBeenCalled();

    finishContextClose();
    await Promise.all([firstClose, overlappingClose]);
    expect(mocks.localBrowser.close).toHaveBeenCalledTimes(1);
  });

  it('waits for an overlapping session release during dispose', async () => {
    const manager = createManager();
    const session = await manager.getSession('agent-a');
    let finishContextClose!: () => void;
    session.context.close = vi.fn(() => new Promise<void>((resolve) => { finishContextClose = resolve; }));

    const closing = manager.closeSession('agent-a');
    const disposing = manager.dispose();
    let disposed = false;
    void disposing.then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);

    finishContextClose();
    await Promise.all([closing, disposing]);
    expect(disposed).toBe(true);
    expect(mocks.localBrowser.close).toHaveBeenCalledTimes(1);
  });

  it('closes the shared browser when context creation fails', async () => {
    const manager = createManager();
    mocks.localBrowser.newContext.mockRejectedValueOnce(new Error('context failed'));

    await expect(manager.getSession('agent-a')).rejects.toThrow('context failed');

    expect(mocks.localBrowser.close).toHaveBeenCalledTimes(1);
    await manager.getSession('agent-b');
    expect(mocks.launch).toHaveBeenCalledTimes(2);
  });

  it('drops local sessions and their contexts when shared Chromium disconnects', async () => {
    const manager = createManager();
    const session = await manager.getSession('agent-a');

    mocks.localBrowser.emitDisconnected();
    await vi.waitFor(() => expect(session.context.close).toHaveBeenCalledTimes(1));

    mocks.localBrowser.resetConnection();
    const replacement = await manager.getSession('agent-a');
    expect(replacement).not.toBe(session);
    expect(mocks.launch).toHaveBeenCalledTimes(2);
  });

  it('closes only the owned context and disconnects from an external CDP browser', async () => {
    const manager = createManager();
    const session = await manager.getSession('agent-cdp', 'http://127.0.0.1:9222');
    const externalBrowser = mocks.externalBrowsers[0]!;

    await manager.closeSession('agent-cdp');

    expect(mocks.launch).not.toHaveBeenCalled();
    expect(session.context.close).toHaveBeenCalledTimes(1);
    // Playwright defines close() on a connectOverCDP Browser as disconnect-only;
    // it does not terminate the externally owned Chrome process.
    expect(externalBrowser.close).toHaveBeenCalledTimes(1);
  });

  it('drops a CDP session when its external connection disappears', async () => {
    const manager = createManager();
    const session = await manager.getSession('agent-cdp', 'http://127.0.0.1:9222');
    const externalBrowser = mocks.externalBrowsers[0]!;

    externalBrowser.emitDisconnected();
    await vi.waitFor(() => expect(session.context.close).toHaveBeenCalledTimes(1));

    const replacement = await manager.getSession('agent-cdp', 'http://127.0.0.1:9222');
    expect(replacement).not.toBe(session);
    expect(mocks.connectOverCDP).toHaveBeenCalledTimes(2);
  });

  it('releases the shared browser after every local session becomes idle', async () => {
    vi.useFakeTimers();
    const manager = createManager();
    const first = await manager.getSession('agent-a');
    const second = await manager.getSession('agent-b');

    await vi.advanceTimersByTimeAsync(6 * 60_000);

    expect(first.context.close).toHaveBeenCalledTimes(1);
    expect(second.context.close).toHaveBeenCalledTimes(1);
    expect(mocks.localBrowser.close).toHaveBeenCalledTimes(1);
  });
});
