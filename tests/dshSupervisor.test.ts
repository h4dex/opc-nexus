// @ts-nocheck
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const {
  DSH_LOOPBACK_HOST,
  DSH_MANAGED_ENTRY,
  DSH_MANAGED_POLICY_PATCH,
  DshSupervisor
} = await import('../src/main/services/dshSupervisor.js');

class ManualClock {
  current = 10_000;
  nextId = 1;
  timers = new Map<number, { at: number; callback: () => void }>();

  now = () => this.current;

  setTimeout = (callback: () => void, delayMs: number) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + delayMs, callback });
    return id;
  };

  clearTimeout = (id: unknown) => {
    this.timers.delete(id as number);
  };

  async advance(ms: number) {
    const target = this.current + ms;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.current = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await settle();
    }
    this.current = target;
    await settle();
  }
}

let nextPid = 3000;
class FakeChild extends EventEmitter {
  pid = nextPid++;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((_signal?: NodeJS.Signals) => true);

  close(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.emit('end');
    this.stderr.emit('end');
    this.emit('close', code, signal);
  }
}

interface Harness {
  root: string;
  dataRoot: string;
  runtimeRoot: string;
  entry: string;
  clock: ManualClock;
  supervisor: InstanceType<typeof DshSupervisor>;
  children: FakeChild[];
  spawn: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  ports: number[];
}

const roots: string[] = [];

async function settle(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

function harness(overrides: Record<string, unknown> = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'opc-dsh-supervisor-'));
  roots.push(root);
  const dataRoot = join(root, 'data');
  const runtimeRoot = join(root, 'runtime');
  const entry = join(runtimeRoot, ...DSH_MANAGED_ENTRY.split('/'));
  mkdirSync(join(entry, '..'), { recursive: true });
  writeFileSync(entry, '// test managed runtime', 'utf8');
  const policyPatch = join(runtimeRoot, ...DSH_MANAGED_POLICY_PATCH.split('/'));
  mkdirSync(join(policyPatch, '..'), { recursive: true });
  writeFileSync(policyPatch, '- id: agent-presets\n', 'utf8');
  const clock = new ManualClock();
  const children: FakeChild[] = [];
  const spawn = vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    return child as never;
  });
  const fetch = vi.fn(async () => ({ status: 200 }));
  const ports: number[] = [];
  let nextPort = 41_000;
  const allocatePort = vi.fn(async (host: string) => {
    expect(host).toBe(DSH_LOOPBACK_HOST);
    const port = nextPort++;
    ports.push(port);
    return port;
  });
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const supervisor = new DshSupervisor({
    dataRoot,
    runtimeRoot,
    clock,
    spawn,
    fetch,
    allocatePort,
    logger,
    startupTimeoutMs: 500,
    startupPollMs: 25,
    probeTimeoutMs: 10,
    healthIntervalMs: 100,
    unhealthyThreshold: 2,
    restartBaseDelayMs: 100,
    restartMaxDelayMs: 800,
    maxRestartAttempts: 3,
    stableRuntimeMs: 10_000,
    stopTimeoutMs: 50,
    forceKillWaitMs: 20,
    resolveEnvironment: () => ({
      AIBOX_DSH_MODEL: 'deepseek-chat'
    }),
    ...overrides
  });
  return { root, dataRoot, runtimeRoot, entry, clock, supervisor, children, spawn, fetch, ports };
}

async function started(h: Harness, request = { agentId: 'agent-1', profileId: 'managed' }) {
  const result = h.supervisor.start(request);
  await settle();
  return await result;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('DshSupervisor startup and isolation', () => {
  it('deduplicates concurrent starts and uses an argv-only loopback launch', async () => {
    const previousAmbient = process.env.UNRELATED_PROVIDER_API_KEY;
    process.env.UNRELATED_PROVIDER_API_KEY = 'ambient-must-not-leak';
    try {
      const h = harness();
      const request = { agentId: 'agent-1', profileId: 'managed' };
      const first = h.supervisor.start(request);
      const second = h.supervisor.start(request);
      expect(second).toBe(first);

      await settle();
      const status = await first;
      expect(h.spawn).toHaveBeenCalledOnce();
      const [executable, args, options] = h.spawn.mock.calls[0];
      expect(executable).toBe(process.execPath);
      expect(args).toEqual([
        h.entry,
        '--profile', 'web',
        '--patch', join(h.runtimeRoot, ...DSH_MANAGED_POLICY_PATCH.split('/')),
        '--host', '127.0.0.1',
        '--port', '41000'
      ]);
      expect(options).toMatchObject({
        shell: false,
        windowsHide: true,
        detached: false,
        cwd: status.workspace
      });
      expect(options.env.DSH_HOME).toBe(status.home);
      expect(options.env.DEEPSEEK_API_KEY).toBeUndefined();
      expect(options.env.UNRELATED_PROVIDER_API_KEY).toBeUndefined();
      expect(status).toMatchObject({
        processState: 'READY',
        endpoint: 'http://127.0.0.1:41000',
        restartCount: 0,
        pid: h.children[0].pid
      });
      expect(status.home).toContain(h.dataRoot);
      expect(status.profileDirectory).toBe(join(status.home, 'profiles', 'web'));
    } finally {
      if (previousAmbient === undefined) delete process.env.UNRELATED_PROVIDER_API_KEY;
      else process.env.UNRELATED_PROVIDER_API_KEY = previousAmbient;
    }
  });

  it('keeps Agent/profile homes and dynamically allocated ports isolated', async () => {
    const h = harness();
    const first = await started(h, { agentId: 'agent-1', profileId: 'managed-a' });
    const second = await started(h, { agentId: 'agent-1', profileId: 'managed-b' });

    expect(first.home).not.toBe(second.home);
    expect(first.endpoint).toBe('http://127.0.0.1:41000');
    expect(second.endpoint).toBe('http://127.0.0.1:41001');
    expect(new Set(h.ports).size).toBe(2);
  });

  it('passes reviewed proxy authorities to DSH at spawn time and exposes a read-only trust check', async () => {
    const h = harness({
      resolveTrustedAuthorities: () => ['NEXUS.TEST:18766', 'nexus.test:18766']
    });
    await started(h);
    const args = h.spawn.mock.calls[0][1];
    expect(args.slice(-2)).toEqual(['--trusted-host', 'nexus.test:18766']);
    expect(h.supervisor.getTrustedAuthorities('agent-1', 'managed')).toEqual(['nexus.test:18766']);
    expect(h.supervisor.hasTrustedAuthority('agent-1', 'managed', 'NEXUS.TEST:18766')).toBe(true);
    expect(h.supervisor.hasTrustedAuthority('agent-1', 'managed', 'other.test:18766')).toBe(false);
  });

  it('fails closed before spawn when a trusted authority is malformed', async () => {
    const h = harness({ resolveTrustedAuthorities: () => ['good.test:18766\r\n--host 0.0.0.0'] });
    await expect(h.supervisor.start({ agentId: 'agent-1', profileId: 'managed' }))
      .rejects.toThrow('trusted authority resolution failed');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('rejects traversal ids, a workspace mutation and shell command shims', async () => {
    const h = harness();
    expect(() => h.supervisor.start({ agentId: '../escape', profileId: 'managed' })).toThrow('Invalid DSH Agent id');
    await started(h);
    const otherWorkspace = join(h.root, 'other-workspace');
    mkdirSync(otherWorkspace);
    await expect(h.supervisor.start({
      agentId: 'agent-1', profileId: 'managed', workspace: otherWorkspace
    })).rejects.toThrow('cannot change workspace');

    expect(() => harness({ nodeExecutable: 'C:\\tools\\dsh.cmd' })).toThrow(/absolute path|shell command shim/);
  });

  it('does not treat a Workbench lifetime as a runtime lease', async () => {
    const h = harness();
    await started(h);
    await h.clock.advance(100);

    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.children[0].kill).not.toHaveBeenCalled();
    expect(h.supervisor.getStatus('agent-1', 'managed')?.processState).toBe('READY');
  });

  it('fails closed instead of forwarding a long-lived Provider credential', async () => {
    const h = harness({
      maxRestartAttempts: 0,
      resolveEnvironment: () => ({ DEEPSEEK_API_KEY: 'provider-secret-123456' })
    });
    const activation = h.supervisor.start({ agentId: 'agent-1', profileId: 'managed' });
    await expect(activation).rejects.toThrow('must not contain long-lived credentials');
    expect(h.spawn).not.toHaveBeenCalled();
    expect(JSON.stringify(h.supervisor.getStatus('agent-1', 'managed'))).not.toContain('provider-secret-123456');
  });

  it('renews an opaque Provider capability before expiry without restarting', async () => {
    const renew = vi.fn(async () => 30_000);
    const revoke = vi.fn();
    const h = harness({
      requireCredentialLease: true,
      resolveCredentialLease: () => ({
        token: `dshp_${'a'.repeat(43)}`,
        baseUrl: 'http://127.0.0.1:41234/v1',
        model: 'deepseek-chat',
        providerId: 'provider-a',
        expiresAt: 20_000,
        renew,
        revoke
      })
    });
    await started(h);

    await h.clock.advance(7_999);
    expect(renew).not.toHaveBeenCalled();
    await h.clock.advance(1);

    expect(renew).toHaveBeenCalledOnce();
    expect(h.supervisor.getStatus('agent-1', 'managed')?.processState).toBe('READY');
    expect(h.spawn).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();
  });

  it('takes a runtime out of READY when Provider capability renewal fails', async () => {
    const h = harness({
      requireCredentialLease: true,
      resolveCredentialLease: () => ({
        token: `dshp_${'b'.repeat(43)}`,
        baseUrl: 'http://127.0.0.1:41234/v1',
        model: 'deepseek-chat',
        expiresAt: 20_000,
        renew: async () => { throw new Error('secret must not escape'); },
        revoke: vi.fn()
      })
    });
    await started(h);

    await h.clock.advance(8_000);

    expect(h.supervisor.getStatus('agent-1', 'managed')).toMatchObject({
      processState: 'UNHEALTHY',
      lastError: 'Managed DSH Provider capability renewal failed'
    });
    expect(h.children[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(JSON.stringify(h.supervisor.getStatus('agent-1', 'managed'))).not.toContain('secret must not escape');
  });

  it('authorizes an additional model through the live Main-only credential lease', async () => {
    const authorizeModel = vi.fn(async () => undefined);
    const h = harness({
      requireCredentialLease: true,
      resolveCredentialLease: () => ({
        token: `dshp_${'c'.repeat(43)}`,
        baseUrl: 'http://127.0.0.1:41234/v1',
        model: 'deepseek-chat',
        providerId: 'provider-a',
        expiresAt: 20_000,
        renew: async () => 30_000,
        authorizeModel,
        revoke: vi.fn()
      })
    });
    await started(h);

    await expect(h.supervisor.authorizeModel('agent-1', 'managed', 'deepseek-reasoner')).resolves.toBeUndefined();
    expect(authorizeModel).toHaveBeenCalledOnce();
    expect(authorizeModel).toHaveBeenCalledWith('deepseek-reasoner');
    expect(JSON.stringify(h.supervisor.getStatus('agent-1', 'managed'))).not.toContain('authorizeModel');
  });

  it('fails closed when a live grant cannot authorize a non-default model', async () => {
    const h = harness({
      requireCredentialLease: true,
      resolveCredentialLease: () => ({
        token: `dshp_${'d'.repeat(43)}`,
        baseUrl: 'http://127.0.0.1:41234/v1',
        model: 'deepseek-chat',
        expiresAt: 20_000,
        renew: async () => 30_000,
        revoke: vi.fn()
      })
    });
    await started(h);

    await expect(h.supervisor.authorizeModel('agent-1', 'managed', 'deepseek-reasoner'))
      .rejects.toThrow('authorization is unavailable');
    await expect(h.supervisor.authorizeModel('agent-1', 'managed', 'deepseek-chat')).resolves.toBeUndefined();
  });
});

describe('DshSupervisor health and recovery', () => {
  it('restarts crashes with exponential backoff and resets only after stability', async () => {
    const h = harness();
    await started(h);
    h.children[0].close(1);

    let status = h.supervisor.getStatus('agent-1', 'managed')!;
    expect(status).toMatchObject({
      processState: 'BACKOFF',
      nextRestartAt: h.clock.current + 100,
      crashCount: 1,
      consecutiveFailures: 1
    });
    await h.clock.advance(99);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    await h.clock.advance(1);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(h.supervisor.getStatus('agent-1', 'managed')).toMatchObject({
      processState: 'READY', restartCount: 1
    });

    h.children[1].close(2);
    status = h.supervisor.getStatus('agent-1', 'managed')!;
    expect(status.nextRestartAt).toBe(h.clock.current + 200);
    expect(status.consecutiveFailures).toBe(2);
  });

  it('opens crash-loop protection after the retry budget', async () => {
    const h = harness({ maxRestartAttempts: 2 });
    await started(h);

    h.children[0].close(1);
    await h.clock.advance(100);
    h.children[1].close(1);
    await h.clock.advance(200);
    h.children[2].close(1);

    expect(h.supervisor.getStatus('agent-1', 'managed')).toMatchObject({
      processState: 'CRASH_LOOP',
      crashCount: 3,
      consecutiveFailures: 3,
      nextRestartAt: null
    });
    await h.clock.advance(5_000);
    expect(h.spawn).toHaveBeenCalledTimes(3);

    await expect(h.supervisor.start({ agentId: 'agent-1', profileId: 'managed' }))
      .rejects.toThrow('crash-loop protection must be reset');
    expect(h.spawn).toHaveBeenCalledTimes(3);

    await h.supervisor.stop('agent-1', 'managed');
    await started(h);
    expect(h.spawn).toHaveBeenCalledTimes(4);
  });

  it('terminates an unresponsive runtime after consecutive health failures', async () => {
    const health = [200, 503, 503];
    const h = harness({ fetch: vi.fn(async () => ({ status: health.shift() ?? 503 })) });
    await started(h);

    await h.clock.advance(100);
    expect(h.children[0].kill).not.toHaveBeenCalled();
    await h.clock.advance(100);
    expect(h.supervisor.getStatus('agent-1', 'managed')?.processState).toBe('UNHEALTHY');
    expect(h.children[0].kill).toHaveBeenCalledWith('SIGTERM');

    h.children[0].close(null, 'SIGTERM');
    expect(h.supervisor.getStatus('agent-1', 'managed')?.processState).toBe('BACKOFF');
  });

  it('rejects readiness after timeout and immediate crash-loop fencing', async () => {
    const h = harness({
      fetch: vi.fn(async () => ({ status: 503 })),
      maxRestartAttempts: 0,
      startupTimeoutMs: 50,
      startupPollMs: 25
    });
    const activation = h.supervisor.start({ agentId: 'agent-1', profileId: 'managed' });
    await settle();
    await h.clock.advance(50);
    expect(h.children[0].kill).toHaveBeenCalledWith('SIGTERM');
    h.children[0].close(1);

    await expect(activation).rejects.toThrow('readiness probe timed out');
    expect(h.supervisor.getStatus('agent-1', 'managed')?.processState).toBe('CRASH_LOOP');
  });
});

describe('DshSupervisor logs and shutdown', () => {
  it('materializes a profile without spawning or acquiring runtime credentials', async () => {
    const credentialResolver = vi.fn(async () => null);
    const h = harness({ resolveCredentialLease: credentialResolver });

    const status = h.supervisor.ensureProfile({ agentId: 'agent-1', profileId: 'managed' });
    expect(status).toMatchObject({
      agentId: 'agent-1',
      profileId: 'managed',
      processState: 'STOPPED',
      endpoint: null,
      pid: null
    });
    expect(h.spawn).not.toHaveBeenCalled();
    expect(credentialResolver).not.toHaveBeenCalled();
    expect(status.home).toContain('agents');
    expect(status.profileDirectory).toContain('profiles');

    const again = h.supervisor.ensureProfile({ agentId: 'agent-1', profileId: 'managed' });
    expect(again.home).toBe(status.home);
    expect(again.profileDirectory).toBe(status.profileDirectory);
    expect(h.supervisor.getStatus('agent-1', 'managed')).toMatchObject({ processState: 'STOPPED' });
  });

  it('rejects changing the workspace of an already materialized profile', () => {
    const h = harness();
    expect(() => h.supervisor.ensureProfile({ agentId: 'agent-1', profileId: 'managed' }))
      .not.toThrow();
    expect(() => h.supervisor.ensureProfile({
      agentId: 'agent-1',
      profileId: 'managed',
      workspace: join(h.root, 'other-workspace')
    })).toThrow('cannot change workspace');
  });

  it('keeps a bounded, redacted log tail and never serializes Provider secrets', async () => {
    const h = harness({ maxLogEntries: 2, maxLogLineChars: 48 });
    await started(h);
    const child = h.children[0];
    child.stdout.emit('data', Buffer.from('api_key=provider-sec'));
    child.stdout.emit('data', Buffer.from('ret-123456\nordinary line\n'));
    child.stderr.emit('data', Buffer.from('Bearer abcdefghijklmnop\n'));
    child.stdout.emit('end');
    child.stderr.emit('end');

    const status = h.supervisor.getStatus('agent-1', 'managed')!;
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('provider-secret-123456');
    expect(serialized).not.toContain('abcdefghijklmnop');
    expect(status.recentLogs).toHaveLength(2);
    expect(status.recentLogs[0].message).toBe('ordinary line');
    expect(status.recentLogs[1].message).toBe('Bearer [REDACTED]');
    expect(status.recentLogs.every((entry) => entry.message.length <= 48)).toBe(true);
  });

  it('stops explicitly, preserves the home, and can start the same profile again', async () => {
    const h = harness();
    const initial = await started(h);
    const stopping = h.supervisor.stop('agent-1', 'managed');
    expect(h.children[0].kill).toHaveBeenCalledWith('SIGTERM');
    h.children[0].close(0, 'SIGTERM');
    await stopping;
    expect(h.supervisor.getStatus('agent-1', 'managed')).toMatchObject({
      processState: 'STOPPED', endpoint: null, pid: null
    });

    const restarted = h.supervisor.start({ agentId: 'agent-1', profileId: 'managed' });
    await settle();
    expect((await restarted).home).toBe(initial.home);
    expect(h.spawn).toHaveBeenCalledTimes(2);
  });

  it('does not turn a rejected start during stop into an unintended restart', async () => {
    const h = harness();
    await started(h);

    const stopping = h.supervisor.stop('agent-1', 'managed');
    await expect(h.supervisor.start({ agentId: 'agent-1', profileId: 'managed' }))
      .rejects.toThrow('cannot start while stopping');
    h.children[0].close(0, 'SIGTERM');

    await stopping;
    await h.clock.advance(5_000);
    expect(h.supervisor.getStatus('agent-1', 'managed')).toMatchObject({
      processState: 'STOPPED', endpoint: null, pid: null
    });
    expect(h.spawn).toHaveBeenCalledOnce();
  });

  it('waits for every process during shutdownAll and then rejects new starts', async () => {
    const h = harness();
    await started(h, { agentId: 'agent-1', profileId: 'managed' });
    await started(h, { agentId: 'agent-2', profileId: 'managed' });

    const shutdown = h.supervisor.shutdownAll();
    const duplicateShutdown = h.supervisor.shutdownAll();
    expect(h.children[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(h.children[1].kill).toHaveBeenCalledWith('SIGTERM');
    h.children[0].close(0, 'SIGTERM');
    h.children[1].close(0, 'SIGTERM');
    await Promise.all([shutdown, duplicateShutdown]);
    await expect(h.supervisor.start({ agentId: 'agent-3', profileId: 'managed' }))
      .rejects.toThrow('shut down');
  });

  it('reports an unverifiable stop instead of spawning a duplicate process', async () => {
    const h = harness();
    await started(h);
    const stopping = h.supervisor.stop('agent-1', 'managed');
    await h.clock.advance(50);
    expect(h.children[0].kill).toHaveBeenLastCalledWith('SIGKILL');
    await h.clock.advance(20);

    await expect(stopping).rejects.toThrow('did not exit after force kill');
    expect(h.supervisor.getStatus('agent-1', 'managed')?.processState).toBe('STOP_FAILED');
    expect(h.spawn).toHaveBeenCalledOnce();
  });

  it('rejects restart instead of hanging when a force-killed live runtime never closes', async () => {
    const health = [200, 503, 503];
    const h = harness({ fetch: vi.fn(async () => ({ status: health.shift() ?? 503 })) });
    await started(h);
    await h.clock.advance(200);
    await h.clock.advance(50);
    await h.clock.advance(20);

    expect(h.supervisor.getStatus('agent-1', 'managed')?.processState).toBe('CRASH_LOOP');
    await expect(h.supervisor.start({ agentId: 'agent-1', profileId: 'managed' }))
      .rejects.toThrow('death could not be verified');
    expect(h.spawn).toHaveBeenCalledOnce();
  });
});
