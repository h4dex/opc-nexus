import { createServer, request as requestHttp, type Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  createDshStorageBootstrapUrl,
  DshWebGateway,
  normalizeDshUpstreamEndpoint
} from '../src/main/services/dshWebGateway.js';

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('missing test port'));
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function desktopCookie(gateway: DshWebGateway): Promise<{ cookie: string; origin: string }> {
  const status = gateway.getStatus();
  if (!status.origin) throw new Error('gateway did not start');
  const session = gateway.createDesktopSession();
  const response = await fetch(session.url, { redirect: 'manual' });
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe('/');
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error('gateway did not issue a desktop cookie');
  return { cookie: setCookie.split(';', 1)[0]!, origin: status.origin };
}

function rawRequest(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = requestHttp({ host: '127.0.0.1', port, path, headers }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end();
  });
}

describe('DshWebGateway', () => {
  it('accepts only explicit loopback HTTP runtime origins', () => {
    expect(normalizeDshUpstreamEndpoint('http://127.0.0.1:3080').href).toBe('http://127.0.0.1:3080/');
    expect(normalizeDshUpstreamEndpoint('http://[::1]:3080/').href).toBe('http://[::1]:3080/');
    for (const endpoint of [
      'http://localhost:3080/',
      'http://0.0.0.0:3080/',
      'https://127.0.0.1:3080/',
      'http://user:secret@127.0.0.1:3080/',
      'http://127.0.0.1:3080/base/'
    ]) {
      expect(() => normalizeDshUpstreamEndpoint(endpoint)).toThrow();
    }
  });

  it('serves a script-free same-origin storage bootstrap before proxying the official UI', async () => {
    let upstreamRequests = 0;
    const upstream = createServer((_request, response) => {
      upstreamRequests += 1;
      response.end('<!doctype html><title>Official DSH</title>');
    });
    const upstreamPort = await listen(upstream);
    const gateway = new DshWebGateway({
      resolveUpstream: () => `http://127.0.0.1:${upstreamPort}/`
    });
    try {
      await gateway.start();
      const issued = gateway.createDesktopSession();
      const bootstrapUrl = createDshStorageBootstrapUrl(issued.url);
      const bootstrap = await fetch(bootstrapUrl, { redirect: 'manual' });
      expect(bootstrap.status).toBe(200);
      expect(bootstrap.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(await bootstrap.text()).not.toContain('<script');
      expect(upstreamRequests).toBe(0);
      const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];
      expect(cookie).toBeTruthy();

      expect(await fetch(bootstrapUrl, { redirect: 'manual' }).then((response) => response.status)).toBe(401);
      const official = await fetch(`${gateway.getStatus().origin}/`, {
        headers: { cookie: cookie! }
      });
      expect(await official.text()).toContain('Official DSH');
      expect(upstreamRequests).toBe(1);
    } finally {
      await gateway.stop();
      await close(upstream);
    }
  });

  it('keeps a validated project-root scope in Main instead of placing it in the grant URL', async () => {
    const gateway = new DshWebGateway();
    try {
      await gateway.start();
      const issued = gateway.createDesktopSession({ rootUpstreamSessionId: 'upstream-project-root' });
      expect(issued.url).not.toContain('upstream-project-root');
      expect(() => gateway.createDesktopSession({ rootUpstreamSessionId: 'bad\u0000root' }))
        .toThrow('scope is invalid');
    } finally {
      await gateway.stop();
    }
  });

  it('uses a one-time desktop session and enforces Host and Origin before HTTP proxying', async () => {
    const seen: Array<{ method?: string; host?: string; origin?: string; cookie?: string; url?: string }> = [];
    const upstream = createServer((request, response) => {
      seen.push({
        method: request.method,
        host: request.headers.host,
        origin: request.headers.origin,
        cookie: request.headers.cookie,
        url: request.url
      });
      response.setHeader('content-type', 'application/json');
      response.setHeader('set-cookie', ['dsh_pref=compact; Path=/', '__opc_dsh_desktop=replace; Path=/']);
      response.end(JSON.stringify({ ok: true }));
    });
    const upstreamPort = await listen(upstream);
    const gateway = new DshWebGateway({
      resolveUpstream: () => `http://127.0.0.1:${upstreamPort}/`
    });

    try {
      const status = await gateway.start();
      expect(status).toMatchObject({ running: true, host: '127.0.0.1', activeDesktopSessions: 0 });
      expect(await fetch(`${status.origin}/rpc`).then((response) => response.status)).toBe(401);

      const issued = gateway.createDesktopSession();
      expect(issued.url).not.toContain('localhost');
      const first = await fetch(issued.url, { redirect: 'manual' });
      const cookie = first.headers.get('set-cookie')!.split(';', 1)[0]!;
      expect(first.status).toBe(303);
      expect(await fetch(issued.url, { redirect: 'manual' }).then((response) => response.status)).toBe(401);

      const response = await fetch(`${status.origin}/rpc?part=1`, {
        headers: { cookie: `${cookie}; dsh_client=yes` }
      });
      expect(await response.json()).toEqual({ ok: true });
      expect(response.headers.get('set-cookie')).toContain('dsh_pref=compact');
      expect(response.headers.get('set-cookie')).not.toContain('__opc_dsh_desktop=replace');
      expect(seen[0]).toEqual({
        method: 'GET',
        host: status.authority,
        origin: undefined,
        cookie: 'dsh_client=yes',
        url: '/rpc?part=1'
      });

      const port = status.port!;
      expect(await rawRequest(port, '/rpc', { host: 'evil.invalid', cookie })).toBe(401);
      expect(await fetch(`${status.origin}/rpc`, {
        method: 'POST',
        headers: { cookie, origin: 'https://evil.invalid' }
      }).then((next) => next.status)).toBe(401);
      expect(seen).toHaveLength(1);

      expect(await fetch(`${status.origin}/rpc`, {
        method: 'POST',
        headers: { cookie, origin: status.origin! },
        body: '{}'
      }).then((next) => next.status)).toBe(200);
      expect(seen[1]).toMatchObject({ method: 'POST', host: status.authority, origin: status.origin, url: '/rpc' });
    } finally {
      await gateway.stop();
      await close(upstream);
    }
    expect(gateway.getStatus()).toMatchObject({ state: 'stopped', running: false, port: null, activeDesktopSessions: 0 });
  });

  it('proxies authenticated WebSocket upgrades without exposing the gateway cookie', async () => {
    let upgradeHeaders: { host?: string; origin?: string; cookie?: string } | null = null;
    const upstream = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    const webSockets = new WebSocketServer({ noServer: true });
    upstream.on('upgrade', (request, socket, head) => {
      upgradeHeaders = {
        host: request.headers.host,
        origin: request.headers.origin,
        cookie: request.headers.cookie
      };
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.on('message', (message) => webSocket.send(`echo:${message.toString()}`));
      });
    });
    const upstreamPort = await listen(upstream);
    const gateway = new DshWebGateway({ resolveUpstream: () => `http://127.0.0.1:${upstreamPort}/` });

    try {
      await gateway.start();
      const { cookie, origin } = await desktopCookie(gateway);
      const url = `${origin.replace('http:', 'ws:')}/events`;
      const webSocket = new WebSocket(url, { headers: { Cookie: `${cookie}; dsh_socket=yes`, Origin: origin } });
      await new Promise<void>((resolve, reject) => {
        webSocket.once('open', resolve);
        webSocket.once('error', reject);
      });
      webSocket.send('hello');
      const message = await new Promise<string>((resolve, reject) => {
        webSocket.once('message', (data) => resolve(data.toString()));
        webSocket.once('error', reject);
      });
      expect(message).toBe('echo:hello');
      expect(upgradeHeaders).toEqual({
        host: gateway.getStatus().authority,
        origin,
        cookie: 'dsh_socket=yes'
      });
      webSocket.close();
    } finally {
      await gateway.stop();
      webSockets.close();
      await close(upstream);
    }
  });

  it('fails closed while the supervisor endpoint is missing or unsafe', async () => {
    let endpoint: string | null = null;
    let now = 1000;
    const gateway = new DshWebGateway({
      resolveUpstream: () => endpoint,
      bootstrapTtlMs: 10,
      now: () => now
    });
    try {
      await gateway.start();
      const expired = gateway.createDesktopSession();
      now += 11;
      expect(await fetch(expired.url, { redirect: 'manual' }).then((response) => response.status)).toBe(401);
      expect(gateway.getStatus().activeDesktopSessions).toBe(0);

      const { cookie, origin } = await desktopCookie(gateway);
      expect(await fetch(`${origin}/`, { headers: { cookie } }).then((response) => response.status)).toBe(502);
      endpoint = 'http://192.168.1.10:3080/';
      expect(await fetch(`${origin}/`, { headers: { cookie } }).then((response) => response.status)).toBe(502);
      expect(gateway.getStatus()).toMatchObject({ running: true, state: 'running' });
    } finally {
      await gateway.stop();
    }
  });

  it('releases Main-side write leases when desktop sessions are revoked or expire', async () => {
    let now = 1_000;
    const releaseClient = vi.fn();
    const gateway = new DshWebGateway({
      bootstrapTtlMs: 10,
      now: () => now,
      writeGuard: {
        claim: () => ({ projected: false, localSessionId: null, commandId: null }),
        completeClaim: () => {},
        failClaim: () => {},
        releaseClient,
        releaseAll: () => {}
      }
    });
    try {
      await gateway.start();
      const revoked = gateway.createDesktopSession();
      expect(gateway.revokeDesktopSession(revoked.id)).toBe(true);
      expect(releaseClient).toHaveBeenCalledWith(revoked.id);

      const expired = gateway.createDesktopSession();
      now += 11;
      expect(gateway.getStatus().activeDesktopSessions).toBe(0);
      expect(releaseClient).toHaveBeenCalledWith(expired.id);
      expect(releaseClient).toHaveBeenCalledTimes(2);
    } finally {
      await gateway.stop();
    }
  });
});
