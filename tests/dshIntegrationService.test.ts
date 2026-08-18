import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/shared/types.js';
import { DshIntegrationService } from '../src/main/services/dshIntegrationService.js';
import { DSH_MANAGED_PROFILE_ID } from '../src/main/services/deepseekHarnessManagedRuntime.js';
import type { DshSupervisor, DshRuntimeStatus } from '../src/main/services/dshSupervisor.js';
import type { DshWebGateway } from '../src/main/services/dshWebGateway.js';
import type { DshWindowManager } from '../src/main/services/dshWindowManager.js';
import type { DshEmbeddedWorkbenchManager } from '../src/main/services/dshEmbeddedWorkbench.js';

function runtime(agentId: string, endpoint: string): DshRuntimeStatus {
  return {
    agentId,
    profileId: DSH_MANAGED_PROFILE_ID,
    generation: 1,
    processState: 'READY',
    endpoint,
    pid: 42,
    home: `C:/data/${agentId}`,
    profileDirectory: `C:/data/${agentId}/profiles/web`,
    workspace: `C:/workspace/${agentId}`,
    startedAt: 1,
    readyAt: 2,
    lastHealthAt: 3,
    nextRestartAt: null,
    restartCount: 0,
    crashCount: 0,
    consecutiveFailures: 0,
    lastExit: null,
    lastError: null,
    recentLogs: []
  };
}

function agent(id: string): Pick<Agent, 'id' | 'workspace'> {
  return { id, workspace: `C:/workspace/${id}` };
}

function harness() {
  const statuses = new Map<string, DshRuntimeStatus>();
  const supervisor = {
    start: vi.fn(async ({ agentId }: { agentId: string }) => {
      const value = runtime(agentId, `http://127.0.0.1:${agentId === 'alpha' ? 3101 : 3102}`);
      statuses.set(agentId, value);
      return value;
    }),
    stop: vi.fn(async (agentId: string) => { statuses.delete(agentId); }),
    getStatus: vi.fn((agentId: string) => statuses.get(agentId) ?? null),
    shutdownAll: vi.fn(async () => { statuses.clear(); })
  };
  let resolver: (() => string | URL | null) | null = null;
  let running = false;
  const gateway = {
    setUpstreamResolver: vi.fn((next: () => string | URL | null) => { resolver = next; }),
    start: vi.fn(async () => { running = true; return gateway.getStatus(); }),
    stop: vi.fn(async () => { running = false; }),
    getStatus: vi.fn(() => ({
      state: running ? 'running' : 'stopped', running, host: '127.0.0.1', port: running ? 4000 : null,
      authority: running ? '127.0.0.1:4000' : null, origin: running ? 'http://127.0.0.1:4000' : null,
      activeDesktopSessions: 0, lastError: null
    }))
  };
  const windows: Array<{ close: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn> }> = [];
  const embedded: Array<{
    close: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    setBounds: ReturnType<typeof vi.fn>;
    setVisible: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
  }> = [];
  const service = new DshIntegrationService(
    supervisor as unknown as DshSupervisor,
    gateway as unknown as DshWebGateway,
    {
      createWindowManager: () => {
        const window = {
          open: vi.fn(async () => ({ open: true, visible: true, loading: false })),
          close: vi.fn(),
          getStatus: vi.fn(() => ({ open: true, visible: true, loading: false }))
        };
        windows.push(window);
        return window as unknown as DshWindowManager;
      },
      createEmbeddedWorkbench: () => {
        const status = {
          open: true, attached: true, visible: true, loading: false,
          bounds: { x: 220, y: 80, width: 900, height: 700 }
        };
        const workbench = {
          open: vi.fn(async () => status),
          close: vi.fn(() => ({ ...status, open: false, attached: false, visible: false, bounds: null })),
          setBounds: vi.fn(() => status),
          setVisible: vi.fn(() => status),
          getStatus: vi.fn(() => status)
        };
        embedded.push(workbench);
        return workbench as unknown as DshEmbeddedWorkbenchManager;
      }
    }
  );
  return { service, supervisor, gateway, windows, embedded, endpoint: () => resolver?.() };
}

describe('DshIntegrationService', () => {
  it('returns only the renderer-safe runtime projection', async () => {
    const { service } = harness();
    await service.start(agent('alpha'));
    const status = service.getStatus('alpha');
    expect(status.runtime).toMatchObject({ agentId: 'alpha', processState: 'READY', pid: 42 });
    expect(status.runtime).not.toHaveProperty('home');
    expect(status.runtime).not.toHaveProperty('endpoint');
    expect(status.runtime).not.toHaveProperty('recentLogs');
  });

  it('revokes the old gateway before switching employee runtimes', async () => {
    const { service, gateway, windows, endpoint } = harness();
    await service.openWorkbench(agent('alpha'));
    expect(endpoint()).toBe('http://127.0.0.1:3101');

    await service.openWorkbench(agent('beta'));
    expect(windows[0]?.close).toHaveBeenCalledOnce();
    expect(gateway.stop).toHaveBeenCalledTimes(2);
    expect(gateway.start).toHaveBeenCalledTimes(2);
    expect(endpoint()).toBe('http://127.0.0.1:3102');
  });

  it('stopping one runtime also closes its active Workbench', async () => {
    const { service, supervisor, gateway, windows } = harness();
    await service.openWorkbench(agent('alpha'));
    const status = await service.stop('alpha');
    expect(windows[0]?.close).toHaveBeenCalledOnce();
    expect(gateway.stop).toHaveBeenCalledTimes(2);
    expect(supervisor.stop).toHaveBeenCalledWith('alpha', DSH_MANAGED_PROFILE_ID);
    expect(status.runtime).toBeNull();
  });

  it('hosts the embedded Workbench on the same per-agent gateway lifecycle', async () => {
    const { service, embedded, gateway } = harness();
    const host = {} as Electron.BrowserWindow;
    const bounds = { x: 220, y: 80, width: 900, height: 700 };

    await expect(service.openEmbeddedWorkbench(agent('alpha'), host, bounds, 'upstream-alpha'))
      .resolves.toMatchObject({ open: true, attached: true, bounds });
    expect(embedded[0]?.open).toHaveBeenCalledWith(host, bounds, 'upstream-alpha');
    expect(service.setEmbeddedWorkbenchVisible(false)).toMatchObject({ open: true });
    expect(service.setEmbeddedWorkbenchBounds(bounds)).toMatchObject({ bounds });

    await service.openEmbeddedWorkbench(agent('beta'), host, bounds, 'upstream-beta');
    expect(embedded[0]?.close).toHaveBeenCalledOnce();
    expect(gateway.stop).toHaveBeenCalledTimes(2);
    expect(embedded).toHaveLength(2);
  });
});
