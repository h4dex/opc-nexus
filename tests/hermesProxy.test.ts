import { createServer, type IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { HermesProxy } from '../src/main/services/hermesProxy.js';

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('missing port'));
      resolve(address.port);
    });
  });
}

function cookie(leaseId: string): string {
  return `__opc_hermes_workbench=${encodeURIComponent(leaseId)}`;
}

describe('HermesProxy', () => {
  it('stops promptly while a Workbench keep-alive connection exists', async () => {
    const proxy = new HermesProxy({
      projectId: 'project-1',
      resolveUpstream: () => null,
      resolveServiceToken: () => null
    });
    await proxy.start();
    const lease = proxy.createLease();
    await fetch(lease.url, { headers: { cookie: cookie(lease.leaseId) } });

    const startedAt = Date.now();
    await proxy.stop();

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(proxy.getStatus().running).toBe(false);
  });

  it('keeps the private host contract separate from Workbench leases', async () => {
    const onHostRequest = vi.fn(async (operation: string, payload: unknown) => ({ operation, payload }));
    const proxy = new HermesProxy({
      projectId: 'project-1',
      resolveUpstream: () => null,
      resolveServiceToken: () => null,
      hostToken: 'host-private-token',
      onHostRequest
    });
    await proxy.start();
    servers.push({ close: () => proxy.stop() });
    const status = proxy.getStatus();
    expect(status.origin).not.toBeNull();
    const url = `${status.origin}/__opc_nexus/host/submit-plan`;

    expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await fetch(url, {
      method: 'POST',
      headers: { 'x-opc-nexus-host-token': 'wrong-token' },
      body: '{}'
    })).status).toBe(401);

    const lease = proxy.createLease();
    expect((await fetch(url, {
      method: 'POST',
      headers: { cookie: cookie(lease.leaseId) },
      body: '{}'
    })).status).toBe(401);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-opc-nexus-host-token': 'host-private-token'
      },
      body: JSON.stringify({ objective: 'ship' })
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      result: { operation: 'submit-plan', payload: { objective: 'ship' } }
    });
    expect(onHostRequest).toHaveBeenCalledOnce();
  });

  it('returns the concrete governance validation reason for a rejected host plan', async () => {
    const onHostRequest = vi.fn(async () => {
      throw new Error('Hermes plan artifact web/index.html has no DAG owner');
    });
    const proxy = new HermesProxy({
      projectId: 'project-1',
      resolveUpstream: () => null,
      resolveServiceToken: () => null,
      hostToken: 'host-private-token',
      onHostRequest
    });
    await proxy.start();
    servers.push({ close: () => proxy.stop() });
    const status = proxy.getStatus();
    const response = await fetch(`${status.origin}/__opc_nexus/host/submit-plan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-opc-nexus-host-token': 'host-private-token'
      },
      body: JSON.stringify({ draft: {} })
    });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'Hermes plan artifact web/index.html has no DAG owner'
    });
  });

  it('exposes a lease-scoped project contract to desktop and mobile operators', async () => {
    const onProjectRequest = vi.fn(async (operation: string, payload: unknown, audience: string) => ({
      operation, payload, audience
    }));
    const proxy = new HermesProxy({
      projectId: 'project-1', resolveUpstream: () => null, resolveServiceToken: () => null,
      onProjectRequest
    });
    await proxy.start();
    servers.push({ close: () => proxy.stop() });
    const desktop = proxy.createLease(60_000, 'desktop');
    const operator = proxy.createLease(60_000, 'mobile-operator');

    const state = await fetch(`${desktop.url}__opc_nexus/project/state`, {
      headers: { cookie: cookie(desktop.leaseId) }
    });
    expect(state.status).toBe(200);
    await expect(state.json()).resolves.toMatchObject({
      ok: true, result: { operation: 'state', audience: 'desktop' }
    });
    const approved = await fetch(`${desktop.url}__opc_nexus/project/approve-plan`, {
      method: 'POST', headers: { cookie: cookie(desktop.leaseId), 'content-type': 'application/json' },
      body: JSON.stringify({ draftId: 'hermes-draft-1' })
    });
    expect(approved.status).toBe(200);
    const mobileApproved = await fetch(`${operator.url}__opc_nexus/project/approve-plan`, {
      method: 'POST', headers: { cookie: cookie(operator.leaseId), 'content-type': 'application/json' }, body: '{}'
    });
    expect(mobileApproved.status).toBe(200);
    await expect(mobileApproved.json()).resolves.toMatchObject({
      ok: true, result: { operation: 'approve-plan', audience: 'mobile-operator' }
    });
    expect(onProjectRequest).toHaveBeenCalledTimes(3);
  });

  it('streams project queue events only to desktop and mobile operators', async () => {
    const proxy = new HermesProxy({
      projectId: 'project-1', resolveUpstream: () => null, resolveServiceToken: () => null
    });
    await proxy.start();
    servers.push({ close: () => proxy.stop() });
    const operator = proxy.createLease(60_000, 'mobile-operator');
    const operatorSocket = new WebSocket(
      `${operator.url.replace('http:', 'ws:')}__opc_nexus/project/events`,
      { headers: { cookie: cookie(operator.leaseId) } }
    );
    const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
      operatorSocket.once('message', (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
      operatorSocket.once('error', reject);
    });
    expect(ready).toMatchObject({ type: 'project.events.ready', projectId: 'project-1' });
    const eventPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      operatorSocket.once('message', (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
      operatorSocket.once('error', reject);
    });
    proxy.publishProjectEvent({ type: 'chat.queue.delta', projectId: 'project-1', delta: '真实增量' });
    await expect(eventPromise).resolves.toMatchObject({ type: 'chat.queue.delta', delta: '真实增量' });
    operatorSocket.close();

  });

  it('keeps the upstream token in Main while proxying HTTP, downloads, WebSocket and control events', async () => {
    const upstreamToken = 'upstream-private-token';
    const upstream = createServer((request, response) => {
      if (request.url === '/' || request.url === '/chat') {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(`<html><head><script>window.__HERMES_SESSION_TOKEN__="${upstreamToken}";</script></head></html>`);
        return;
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const headerOk = request.headers['x-hermes-session-token'] === upstreamToken;
      const queryOk = url.pathname === '/api/files/download' && url.searchParams.get('token') === upstreamToken;
      response.writeHead(headerOk && (url.pathname !== '/api/files/download' || queryOk) ? 200 : 401, {
        'content-type': 'application/json'
      });
      response.end(JSON.stringify({ ok: headerOk && (url.pathname !== '/api/files/download' || queryOk) }));
    });
    const websocketServer = new WebSocketServer({ noServer: true });
    upstream.on('upgrade', (request: IncomingMessage, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.searchParams.get('token') !== upstreamToken) return socket.destroy();
      websocketServer.handleUpgrade(request, socket, head, (client) => {
        client.send(JSON.stringify({ method: 'event', params: { type: 'clarify.request', payload: { clarifyId: 'c1' } } }));
      });
    });
    const upstreamPort = await listen(upstream);
    servers.push({ close: () => new Promise((resolve) => websocketServer.close(() => upstream.close(() => resolve()))) });

    const onMessage = vi.fn();
    const proxy = new HermesProxy({
      projectId: 'project-1', resolveUpstream: () => `http://127.0.0.1:${upstreamPort}`,
      resolveServiceToken: () => upstreamToken, onUpstreamMessage: onMessage
    });
    await proxy.start();
    servers.push({ close: () => proxy.stop() });
    const lease = proxy.createLease();
    const headers = { cookie: cookie(lease.leaseId) };

    const html = await fetch(lease.url, { headers }).then((response) => response.text());
    expect(html).not.toContain(upstreamToken);
    expect(html).toContain('opc-nexus-main-proxy');
    expect(html).toContain('window.__OPC_NEXUS_PROJECT_MODE__="desktop"');
    await expect(fetch(`${lease.url}api/private`, { headers }).then((response) => response.json()))
      .resolves.toEqual({ ok: true });
    await expect(fetch(`${lease.url}api/files/download?token=opc-nexus-main-proxy`, { headers }).then((response) => response.json()))
      .resolves.toEqual({ ok: true });
    expect((await fetch(lease.url)).status).toBe(401);
    expect((await fetch(`${lease.url}config`, { headers })).status).toBe(403);
    expect((await fetch(`${lease.url}api/sessions?profile=another-project`, { headers })).status).toBe(403);

    const mobileLease = proxy.createLease(60_000, 'mobile-operator');
    const mobileHeaders = { cookie: cookie(mobileLease.leaseId) };
    expect((await fetch(mobileLease.url, { headers: mobileHeaders })).status).toBe(403);
    const mobileHtml = await fetch(`${mobileLease.url}chat`, { headers: mobileHeaders }).then((response) => response.text());
    expect(mobileHtml).toContain('window.__OPC_NEXUS_PROJECT_MODE__="mobile-operator"');
    expect((await fetch(`${mobileLease.url}sessions`, { headers: mobileHeaders })).status).toBe(403);
    expect((await fetch(`${mobileLease.url}api/files`, { headers: mobileHeaders })).status).toBe(403);
    expect((await fetch(`${mobileLease.url}api/memory`, { headers: mobileHeaders })).status).toBe(403);
    expect((await fetch(`${mobileLease.url}api/logs`, { headers: mobileHeaders })).status).toBe(403);
    expect((await fetch(`${mobileLease.url}api/status?profile=other`, { headers: mobileHeaders })).status).toBe(403);

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${lease.url.replace('http:', 'ws:')}api/ws?token=opc-nexus-main-proxy`, { headers });
      ws.once('message', () => { ws.close(); resolve(); });
      ws.once('error', reject);
    });
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ method: 'event' }));
  });

  it('intercepts governed client RPC calls instead of forwarding them upstream', async () => {
    const upstream = createServer();
    const websocketServer = new WebSocketServer({ noServer: true });
    const upstreamMessages = vi.fn();
    upstream.on('upgrade', (request, socket, head) => {
      websocketServer.handleUpgrade(request, socket, head, (client) => {
        client.on('message', (data) => {
          upstreamMessages(JSON.parse(data.toString()));
          client.send(data.toString());
        });
      });
    });
    const upstreamPort = await listen(upstream);
    servers.push({ close: () => new Promise((resolve) => websocketServer.close(() => upstream.close(() => resolve()))) });

    const onClientMessage = vi.fn(async (message: unknown) => {
      const frame = message as Record<string, unknown>;
      return frame.method === 'clarify.respond'
        ? { handled: true, result: { ok: true, governed: true } }
        : { handled: false };
    });
    const proxy = new HermesProxy({
      projectId: 'project-1', resolveUpstream: () => `http://127.0.0.1:${upstreamPort}`,
      resolveServiceToken: () => 'service-token', onClientMessage
    });
    await proxy.start();
    servers.push({ close: () => proxy.stop() });
    const lease = proxy.createLease();
    const headers = { cookie: cookie(lease.leaseId) };
    const ws = new WebSocket(`${lease.url.replace('http:', 'ws:')}api/ws`, { headers });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const governed = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
      ws.once('error', reject);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'answer-1', method: 'clarify.respond', params: { request_id: 'c1', answer: 'yes' } }));
    });
    expect(governed).toMatchObject({ id: 'answer-1', result: { ok: true, governed: true } });
    expect(upstreamMessages).not.toHaveBeenCalled();

    await new Promise<void>((resolve, reject) => {
      ws.once('message', () => resolve());
      ws.once('error', reject);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'other-1', method: 'session.get', params: {} }));
    });
    expect(upstreamMessages).toHaveBeenCalledWith(expect.objectContaining({ method: 'session.get' }));
    ws.close();
  });
});
