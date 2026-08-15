// @ts-nocheck
/* eslint-disable */
import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const { WebServer, webRendererDirectory } = await import('../src/main/services/webServer.js');

function makeDb(settings: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { webPort: 0, ...settings };
  return {
    raw: {
      prepare: (sql: string) => ({
        get: () => undefined,
        all: () => [],
        run: (...args: unknown[]) => {
          if (/DELETE FROM settings WHERE key = \?/i.test(sql)) delete store[String(args[0])];
          return { changes: 1 };
        }
      })
    },
    transaction: (fn: () => void) => fn(),
    audit: vi.fn(),
    getSetting: (key: string, fallback: unknown) => key in store ? store[key] : fallback,
    setSetting: (key: string, value: unknown) => { store[key] = value; },
    store
  } as never;
}

function idleService(overrides: Record<string, unknown> = {}) {
  return new Proxy(overrides, { get: (target, key) => key in target ? target[key as string] : vi.fn() });
}

function makeServer(db: ReturnType<typeof makeDb>, overrides: Record<string, unknown> = {}) {
  return new WebServer({
    db,
    orchestrator: idleService({ listAgents: () => [], agentCards: () => [], listTasks: () => [], listApprovals: () => [] }),
    engines: idleService(),
    channels: idleService(),
    providers: idleService(),
    mcp: idleService(),
    skills: idleService(),
    teams: idleService(),
    desktopControlPlane: idleService({
      dispatch: async () => ({ conversationId: 'conversation-web', task: { id: 'task-web' } })
    }),
    ...overrides
  } as never);
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Port probe did not start');
  await closeServer(probe);
  return address.port;
}

describe('Web settings HTTP boundary', () => {
  it('resolves renderer assets from an ESM main-module URL', () => {
    const mainEntry = join(process.cwd(), 'out', 'main', 'index.js');
    expect(webRendererDirectory(pathToFileURL(mainEntry).href)).toBe(
      join(process.cwd(), 'out', 'renderer')
    );
  });

  it('routes Web task creation through canonical ingress and forwards Idempotency-Key', async () => {
    const db = makeDb();
    const orchestrator = idleService({
      listAgents: () => [], agentCards: () => [], listTasks: () => [], listApprovals: () => [],
      createTask: vi.fn()
    });
    const desktopControlPlane = idleService({
      dispatch: vi.fn(async () => ({ conversationId: 'conversation-web', task: { id: 'task-web' } }))
    });
    const server = makeServer(db, { orchestrator, desktopControlPlane });
    await server.start();
    const address = server.server?.address();
    if (!address || typeof address === 'string') throw new Error('Web test server did not start');
    const headers = {
      Authorization: `Bearer ${server.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'web-request-1'
    };

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks`, {
        method: 'POST', headers, body: JSON.stringify({ agentId: 'agent-1', title: 'prepare report' })
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: 'task-web' });
      expect(desktopControlPlane.dispatch).toHaveBeenCalledWith({
        preferredAgentId: 'agent-1', message: 'prepare report', projectId: undefined,
        source: 'webhook', messageKey: 'web-request-1'
      });
      expect(orchestrator.createTask).not.toHaveBeenCalled();
    } finally {
      server.stop();
    }
  });

  it('allows typed preferences and rejects internal keys or malformed values', async () => {
    const db = makeDb({ theme: 'dark', notifications: true });
    const server = makeServer(db);
    await server.start();
    const address = server.server?.address();
    if (!address || typeof address === 'string') throw new Error('Web test server did not start');
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };

    try {
      const theme = await fetch(`${base}/api/settings/theme`, { headers });
      expect(theme.status).toBe(200);
      expect(await theme.json()).toEqual({ value: 'dark' });

      const update = await fetch(`${base}/api/settings/notifications`, {
        method: 'PUT', headers, body: JSON.stringify({ value: false })
      });
      expect(update.status).toBe(200);
      expect(db.store.notifications).toBe(false);

      const internal = await fetch(`${base}/api/settings/secret%3Aprovider%3Akey`, { headers });
      expect(internal.status).toBe(400);
      expect(JSON.stringify(await internal.json())).not.toContain('provider:key');

      const malformed = await fetch(`${base}/api/settings/thresholds`, {
        method: 'PUT', headers,
        body: JSON.stringify({ value: { cpu: 999, mem: 85, gpuTemp: 85 } })
      });
      expect(malformed.status).toBe(400);
      expect(db.store).not.toHaveProperty('thresholds');
    } finally {
      server.stop();
    }
  });

  it('stays closed after an asynchronous listen error and can retry after the port is released', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', () => resolve());
    });
    const address = blocker.address();
    if (!address || typeof address === 'string') throw new Error('Port blocker did not start');

    const server = makeServer(makeDb({ webPort: address.port }));
    try {
      await expect(server.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(server.server).toBeNull();
      expect(server.app).toBeNull();
      expect(server.cleanupTimer).toBeNull();

      await closeServer(blocker);
      await server.start();

      expect(server.server?.listening).toBe(true);
      expect(server.app).not.toBeNull();
      expect(server.cleanupTimer).not.toBeNull();
    } finally {
      if (blocker.listening) await closeServer(blocker);
      server.stop();
    }
  });

  it('can restart immediately after cancelling an in-flight start', async () => {
    const server = makeServer(makeDb({ webPort: await availablePort() }));
    const cancelled = server.start();
    server.stop();
    const restarted = server.start();

    await expect(cancelled).rejects.toThrow(/cancelled|closed before listening/);
    await restarted;
    expect(server.server?.listening).toBe(true);
    server.stop();
  });

  it('fails closed on a runtime server error without an unhandled error event', async () => {
    const db = makeDb({ webPort: await availablePort() });
    const server = makeServer(db);
    await server.start();
    const candidate = server.server;
    if (!candidate) throw new Error('Web test server did not start');

    candidate.emit('error', new Error('synthetic runtime failure'));

    expect(server.server).toBeNull();
    expect(server.app).toBeNull();
    expect(server.cleanupTimer).toBeNull();
    expect(db.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'webserver.runtime', result: 'error'
    }));
    await server.start();
    expect(server.server?.listening).toBe(true);
    server.stop();
  });
});
