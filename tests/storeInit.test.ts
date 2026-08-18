import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('renderer store initialization', () => {
  it('opens the regular management console by default', async () => {
    const { useApp } = await import('../src/renderer/src/store.js');
    expect(useApp.getState().route).toBe('dashboard');
  });

  it('carries the selected project into Quest navigation', async () => {
    const { useApp } = await import('../src/renderer/src/store.js');

    useApp.getState().openQuest('project-1');
    expect(useApp.getState()).toMatchObject({
      route: 'quest', questProjectId: 'project-1', navigationTarget: null
    });
  });

  it('carries a one-shot secretary session target across route navigation', async () => {
    const { useApp } = await import('../src/renderer/src/store.js');

    useApp.getState().openSecretarySession('planning-session-1');
    expect(useApp.getState()).toMatchObject({
      route: 'secretary', secretarySessionId: 'planning-session-1', navigationTarget: null
    });

    useApp.getState().clearSecretarySession();
    expect(useApp.getState().secretarySessionId).toBeNull();
  });

  it('coalesces concurrent initialization and owns one listener pair', async () => {
    const offSnapshot = vi.fn();
    const offResources = vi.fn();
    const api = {
      getSetting: vi.fn().mockResolvedValue('dark'),
      getSystemInfo: vi.fn().mockResolvedValue({ hostname: 'test' }),
      getAppVersion: vi.fn().mockResolvedValue('1.0.0'),
      getSnapshot: vi.fn().mockResolvedValue({ version: 1 }),
      getResourceHistory: vi.fn().mockResolvedValue({
        history: [],
        health: { runtime: 'healthy', gateway: 'healthy', database: 'healthy' }
      }),
      getActionCenter: vi.fn().mockResolvedValue(null),
      onSnapshot: vi.fn().mockReturnValue(offSnapshot),
      onResources: vi.fn().mockReturnValue(offResources)
    };
    vi.stubGlobal('window', { aibox: api });
    vi.stubGlobal('document', { documentElement: { dataset: {} } });

    const { disposeAppSubscriptions, useApp } = await import('../src/renderer/src/store.js');
    await Promise.all([useApp.getState().init(), useApp.getState().init()]);

    expect(api.getSnapshot).toHaveBeenCalledTimes(1);
    expect(api.onSnapshot).toHaveBeenCalledTimes(1);
    expect(api.onResources).toHaveBeenCalledTimes(1);

    disposeAppSubscriptions();
    expect(offSnapshot).toHaveBeenCalledTimes(1);
    expect(offResources).toHaveBeenCalledTimes(1);
  });
});
