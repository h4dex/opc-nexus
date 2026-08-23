import { createServer, type Server } from 'node:http';
import { request as requestHttps } from 'node:https';
import { WebSocket, WebSocketServer } from 'ws';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import selfsigned from 'selfsigned';
import {
  SecureLanGateway,
  isPrivateSecureLanAddress,
  type SecureLanAuditEvent,
  type SecureLanGatewayStatus,
  type SecureLanPolicyResolver,
  type SecureLanTlsIdentity
} from '../src/main/services/secureLanGateway.js';

interface TestResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface PairedSession {
  cookie: string;
  csrfCookie: string;
  csrf: string;
  role: 'viewer' | 'operator';
}

let tls: SecureLanTlsIdentity;
const gateways: SecureLanGateway[] = [];
const servers: Server[] = [];

beforeAll(async () => {
  const generated = await selfsigned.generate(
    [{ name: 'commonName', value: 'OPC-Nexus Secure LAN Test' }],
    {
      algorithm: 'sha256',
      keyType: 'rsa',
      keySize: 2048,
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        {
          name: 'subjectAltName',
          altNames: [
            { type: 7, ip: '127.0.0.1' },
            { type: 2, value: 'nexus.test' },
            { type: 2, value: 'wrong.test' }
          ]
        }
      ]
    }
  );
  tls = { key: generated.private, cert: generated.cert };
});

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
  await Promise.all(servers.splice(0).map(close));
});

afterAll(() => {
  tls = { key: '', cert: '' };
});

function listen(server: Server): Promise<number> {
  servers.push(server);
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
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    try { server.close(() => resolve()); } catch { resolve(); }
  });
}

function policy(runtimeId = 'runtime-1'): SecureLanPolicyResolver {
  return ({ pathname, websocket }) => {
    if (pathname === '/events' && websocket) {
      return { kind: 'websocket', runtimeId, roles: ['viewer', 'operator'], rateLimitBucket: 'stream' };
    }
    if (pathname === '/' || pathname === '/asset.js') {
      return { kind: 'web', runtimeId, methods: ['GET', 'HEAD'], roles: ['viewer', 'operator'] };
    }
    if (pathname === '/rpc') {
      return {
        kind: 'rpc',
        runtimeId,
        methods: ['POST'],
        roles: ['viewer', 'operator'],
        maxBodyBytes: 512,
        rpc: {
          methods: {
            'session.list': { roles: ['viewer', 'operator'], rateLimitBucket: 'read' },
            'session.prompt': { roles: ['operator'], rateLimitBucket: 'prompt' },
            'session.cancel': { roles: ['operator'], rateLimitBucket: 'control' }
          }
        }
      };
    }
    return null;
  };
}

async function makeGateway(options: {
  upstream?: string | null;
  resolvePolicy?: SecureLanPolicyResolver;
  audit?: (event: SecureLanAuditEvent) => void;
  limits?: ConstructorParameters<typeof SecureLanGateway>[0]['limits'];
  now?: () => number;
  resolveUpstreamHeaders?: ConstructorParameters<typeof SecureLanGateway>[0]['resolveUpstreamHeaders'];
  allowedSensitiveQueryNames?: readonly string[];
  sessionCookieName?: string;
  csrfCookieName?: string;
} = {}): Promise<{ gateway: SecureLanGateway; status: SecureLanGatewayStatus }> {
  const gateway = new SecureLanGateway({
    runtimeId: 'runtime-1',
    resolveUpstream: () => options.upstream ?? null,
    resolvePolicy: options.resolvePolicy ?? policy(),
    audit: options.audit,
    resolveUpstreamHeaders: options.resolveUpstreamHeaders,
    allowedSensitiveQueryNames: options.allowedSensitiveQueryNames,
    sessionCookieName: options.sessionCookieName,
    csrfCookieName: options.csrfCookieName,
    limits: options.limits,
    now: options.now
  });
  gateways.push(gateway);
  const status = await gateway.start({
    bindHost: '127.0.0.1',
    port: 0,
    publicHost: 'nexus.test',
    tls
  });
  return { gateway, status };
}

function httpsCall(
  status: SecureLanGatewayStatus,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}
): Promise<TestResponse> {
  if (!status.port || !status.authority) throw new Error('gateway is not running');
  const body = options.body;
  const headers: Record<string, string> = { Host: status.authority, ...options.headers };
  if (body !== undefined && headers['content-length'] === undefined && headers['Content-Length'] === undefined) {
    headers['Content-Length'] = String(Buffer.byteLength(body));
  }
  return new Promise((resolve, reject) => {
    const request = requestHttps({
      hostname: '127.0.0.1',
      port: status.port!,
      path,
      method: options.method ?? 'GET',
      headers,
      rejectUnauthorized: false
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

async function pair(
  gateway: SecureLanGateway,
  status: SecureLanGatewayStatus,
  role: 'viewer' | 'operator' = 'operator',
  sessionCookieName = '__Host-opc_secure_lan',
  csrfCookieName = '__Host-opc_secure_csrf'
): Promise<PairedSession> {
  const offer = gateway.createPairingOffer(role);
  const response = await httpsCall(status, '/api/v1/auth/pair', {
    method: 'POST',
    headers: {
      Origin: status.origin!,
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ code: offer.code })
  });
  expect(response.status).toBe(200);
  const cookieHeader = response.headers['set-cookie'];
  const cookies = Array.isArray(cookieHeader) ? cookieHeader : [cookieHeader!];
  const cookie = cookies.find((item) => item.startsWith(`${sessionCookieName}=`))!;
  const csrfCookie = cookies.find((item) => item.startsWith(`${csrfCookieName}=`))!;
  const payload = JSON.parse(response.body) as { csrfToken: string; role: 'viewer' | 'operator' };
  return {
    cookie: cookie.split(';', 1)[0]!,
    csrfCookie: csrfCookie.split(';', 1)[0]!,
    csrf: payload.csrfToken,
    role: payload.role
  };
}

function mutationHeaders(status: SecureLanGatewayStatus, session: PairedSession): Record<string, string> {
  return {
    Cookie: session.cookie,
    Origin: status.origin!,
    'Sec-Fetch-Site': 'same-origin',
    'X-OPC-CSRF': session.csrf,
    'Content-Type': 'application/json'
  };
}

describe('SecureLanGateway security contract', () => {
  it('is disabled by default and only binds explicit private addresses over TLS', async () => {
    expect(isPrivateSecureLanAddress('127.0.0.1')).toBe(true);
    expect(isPrivateSecureLanAddress('192.168.10.8')).toBe(true);
    expect(isPrivateSecureLanAddress('8.8.8.8')).toBe(false);
    expect(isPrivateSecureLanAddress('0.0.0.0')).toBe(false);

    const gateway = new SecureLanGateway({
      runtimeId: 'runtime-1',
      resolveUpstream: () => null,
      resolvePolicy: () => null
    });
    gateways.push(gateway);
    expect(gateway.getStatus()).toMatchObject({ enabled: false, running: false, state: 'stopped' });
    await expect(gateway.start({ bindHost: '0.0.0.0', tls })).rejects.toThrow(/private or loopback/);
    await expect(gateway.start({ bindHost: '127.0.0.1', publicHost: 'uncovered.test', tls }))
      .rejects.toThrow(/does not cover/);

    const status = await gateway.start({ bindHost: '127.0.0.1', publicHost: 'nexus.test', tls });
    expect(status).toMatchObject({
      enabled: true,
      running: true,
      origin: `https://nexus.test:${status.port}`,
      authority: `nexus.test:${status.port}`
    });
    expect(status.trustedAuthorities).toEqual([status.authority]);
    expect(status.certificateFingerprint).toMatch(/^sha256\//);

    const plainHttp = await fetch(`http://127.0.0.1:${status.port}/`).catch(() => null);
    expect(plainHttp).toBeNull();
  });

  it('exchanges a one-time body-only pairing code for a hardened cookie and never audits secrets', async () => {
    const audits: SecureLanAuditEvent[] = [];
    const { gateway, status } = await makeGateway({ audit: (event) => audits.push(event) });
    const offer = gateway.createPairingOffer('operator');
    const body = JSON.stringify({ code: offer.code });
    const response = await httpsCall(status, '/api/v1/auth/pair', {
      method: 'POST',
      headers: {
        Origin: status.origin!,
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json'
      },
      body
    });
    expect(response.status).toBe(200);
    const cookies = response.headers['set-cookie'] as string[];
    const cookie = cookies.find((item) => item.startsWith('__Host-opc_secure_lan='))!;
    const csrfCookie = cookies.find((item) => item.startsWith('__Host-opc_secure_csrf='))!;
    expect(cookie).toMatch(/^__Host-opc_secure_lan=[A-Za-z0-9_-]+;/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(csrfCookie).toMatch(/^__Host-opc_secure_csrf=[A-Za-z0-9_-]+;/);
    expect(csrfCookie).not.toContain('HttpOnly');
    expect(csrfCookie).toContain('Secure');
    expect(csrfCookie).toContain('SameSite=Strict');
    expect(csrfCookie).toContain('Path=/');
    const csrf = (JSON.parse(response.body) as { csrfToken: string }).csrfToken;
    expect(csrf).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(csrfCookie.split('=', 2)[1]!.split(';', 1)[0]).toBe(csrf);

    const replay = await httpsCall(status, '/api/v1/auth/pair', {
      method: 'POST',
      headers: {
        Origin: status.origin!,
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json'
      },
      body
    });
    expect(replay.status).toBe(401);
    const auditText = JSON.stringify(audits);
    expect(auditText).not.toContain(offer.code);
    expect(auditText).not.toContain(csrf);
    expect(auditText).not.toContain(cookie.split('=', 2)[1]!.split(';', 1)[0]!);
  });

  it('supports an isolated cookie namespace for the Hermes mobile route', async () => {
    const { gateway, status } = await makeGateway({
      sessionCookieName: '__Host-opc_hermes_mobile',
      csrfCookieName: '__Host-opc_hermes_csrf'
    });
    const session = await pair(
      gateway,
      status,
      'operator',
      '__Host-opc_hermes_mobile',
      '__Host-opc_hermes_csrf'
    );
    expect(session.cookie).toMatch(/^__Host-opc_hermes_mobile=/);
    expect(session.csrfCookie).toMatch(/^__Host-opc_hermes_csrf=/);
    expect(session.cookie).not.toContain('dsh_lan');
    expect(session.csrfCookie).not.toContain('dsh_csrf');
  });

  it('serves a secret-free hardened pairing page at the offer URL', async () => {
    const { gateway, status } = await makeGateway();
    const offer = gateway.createPairingOffer('operator');

    expect(offer.pairingUrl).toBe(`${status.origin}/pair`);
    expect(new URL(offer.pairingUrl).search).toBe('');
    expect(new URL(offer.pairingUrl).hash).toBe('');
    expect(offer.pairingUrl).not.toContain(offer.code);

    const response = await httpsCall(status, '/pair');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('same-origin');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['content-security-policy']).toContain("script-src 'none'");
    expect(response.headers['content-security-policy']).toMatch(/style-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(response.headers['content-security-policy']).not.toContain("'unsafe-inline'");
    expect(response.headers['content-security-policy']).toContain("form-action 'self'");
    expect(response.body).toContain('method="post"');
    expect(response.body).toContain('action="/api/v1/auth/pair"');
    expect(response.body).toContain('<meta name="referrer" content="same-origin">');
    expect(response.body).toContain('连接 Hermes 对话');
    expect(response.body).toContain('打开 Hermes 对话');
    expect(response.body).not.toContain('<script');
    expect(response.body).not.toContain(offer.code);

    expect((await httpsCall(status, `/pair?code=${offer.code}`)).status).toBe(400);
    expect((await httpsCall(status, '/pair', { headers: { Host: 'evil.invalid' } })).status).toBe(421);
  });

  it('accepts a same-origin Referer when a mobile form omits Origin', async () => {
    const { gateway, status } = await makeGateway();
    const offer = gateway.createPairingOffer('operator');
    const response = await httpsCall(status, '/api/v1/auth/pair', {
      method: 'POST',
      headers: {
        Referer: `${status.origin}/pair`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ code: offer.code }).toString()
    });
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('/');
  });

  it('pairs through a browser form and lets the unmodified DSH UI mutate with strict cookies', async () => {
    const upstreamRequests: Array<{ url?: string; cookie?: string; csrf?: string }> = [];
    const upstream = createServer((request, response) => {
      upstreamRequests.push({
        url: request.url,
        cookie: request.headers.cookie,
        csrf: request.headers['x-opc-csrf'] as string | undefined
      });
      response.setHeader('set-cookie', [
        'dsh_pref=compact; Path=/',
        '__Host-opc_secure_lan=replace; Path=/',
        '__Host-opc_secure_csrf=replace; Path=/'
      ]);
      if (request.url === '/') {
        response.setHeader('content-type', 'text/html');
        response.end('<!doctype html><title>Official DSH</title>');
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}');
    });
    const upstreamPort = await listen(upstream);
    const { gateway, status } = await makeGateway({ upstream: `http://127.0.0.1:${upstreamPort}/` });
    const offer = gateway.createPairingOffer('operator');
    const paired = await httpsCall(status, '/api/v1/auth/pair', {
      method: 'POST',
      headers: {
        Origin: status.origin!,
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ code: offer.code }).toString()
    });
    expect(paired.status).toBe(303);
    expect(paired.headers.location).toBe('/');
    expect(paired.body).toBe('');
    expect(paired.body).not.toContain(offer.code);

    const setCookies = paired.headers['set-cookie'] as string[];
    const sessionCookie = setCookies.find((item) => item.startsWith('__Host-opc_secure_lan='))!.split(';', 1)[0]!;
    const csrfCookie = setCookies.find((item) => item.startsWith('__Host-opc_secure_csrf='))!.split(';', 1)[0]!;
    const browserCookies = `${sessionCookie}; ${csrfCookie}`;

    const officialUi = await httpsCall(status, '/', { headers: { Cookie: browserCookies } });
    expect(officialUi.status).toBe(200);
    expect(officialUi.body).toContain('Official DSH');
    expect(officialUi.headers['set-cookie']).toEqual(['dsh_pref=compact; Path=/']);

    const prompt = JSON.stringify({ method: 'session.prompt', params: { text: 'work' } });
    const browserMutationHeaders = {
      Cookie: browserCookies,
      Origin: status.origin!,
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json'
    };
    expect((await httpsCall(status, '/rpc', {
      method: 'POST', headers: browserMutationHeaders, body: prompt
    })).status).toBe(200);

    expect(upstreamRequests).toEqual([
      { url: '/', cookie: undefined, csrf: undefined },
      { url: '/rpc', cookie: undefined, csrf: undefined }
    ]);
    expect((await httpsCall(status, '/rpc', {
      method: 'POST', headers: { ...browserMutationHeaders, 'X-OPC-CSRF': 'wrong' }, body: prompt
    })).status).toBe(403);
    expect((await httpsCall(status, '/rpc', {
      method: 'POST', headers: { ...browserMutationHeaders, Cookie: sessionCookie }, body: prompt
    })).status).toBe(403);
    expect((await httpsCall(status, '/rpc', {
      method: 'POST', headers: { ...browserMutationHeaders, Cookie: `${browserCookies}; ${csrfCookie}` }, body: prompt
    })).status).toBe(403);
    expect((await httpsCall(status, '/rpc', {
      method: 'POST', headers: { ...browserMutationHeaders, Origin: 'https://evil.invalid' }, body: prompt
    })).status).toBe(403);
    const { Origin: _origin, ...missingOriginHeaders } = browserMutationHeaders;
    expect((await httpsCall(status, '/rpc', {
      method: 'POST', headers: missingOriginHeaders, body: prompt
    })).status).toBe(403);
    const { ['Sec-Fetch-Site']: _fetchSite, ...missingFetchHeaders } = browserMutationHeaders;
    expect((await httpsCall(status, '/rpc', {
      method: 'POST', headers: missingFetchHeaders, body: prompt
    })).status).toBe(403);
    expect(upstreamRequests).toHaveLength(2);

    const logout = await httpsCall(status, '/api/v1/auth/logout', {
      method: 'POST', headers: browserMutationHeaders
    });
    expect(logout.status).toBe(204);
    expect(logout.headers['set-cookie']).toEqual(expect.arrayContaining([
      expect.stringMatching(/^__Host-opc_secure_lan=;.*Max-Age=0/),
      expect.stringMatching(/^__Host-opc_secure_csrf=;.*Max-Age=0/)
    ]));
    expect((await httpsCall(status, '/', { headers: { Cookie: browserCookies } })).status).toBe(401);
  });

  it('rejects forged Host, cross-site pairing, missing Fetch Metadata and secrets in URLs', async () => {
    const { gateway, status } = await makeGateway();
    const offer = gateway.createPairingOffer();
    const payload = JSON.stringify({ code: offer.code });
    const baseHeaders = { Origin: status.origin!, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };

    expect((await httpsCall(status, '/api/v1/auth/pair', {
      method: 'POST', headers: { ...baseHeaders, Host: 'evil.invalid' }, body: payload
    })).status).toBe(421);
    expect((await httpsCall(status, '/api/v1/auth/pair', {
      method: 'POST', headers: { ...baseHeaders, Origin: 'https://evil.invalid' }, body: payload
    })).status).toBe(403);
    expect((await httpsCall(status, '/api/v1/auth/pair', {
      method: 'POST', headers: { Origin: status.origin!, 'Content-Type': 'application/json' }, body: payload
    })).status).toBe(403);

    const session = await pair(gateway, status);
    expect((await httpsCall(status, '/asset.js?token=not-allowed', {
      headers: { Cookie: session.cookie }
    })).status).toBe(400);
  });

  it('preserves the public Host and Origin upstream while stripping LAN credentials', async () => {
    const seen: Array<{ host?: string; origin?: string; cookie?: string; csrf?: string; url?: string }> = [];
    const upstream = createServer((request, response) => {
      seen.push({
        host: request.headers.host,
        origin: request.headers.origin,
        cookie: request.headers.cookie,
        csrf: request.headers['x-opc-csrf'] as string | undefined,
        url: request.url
      });
      response.setHeader('content-type', 'text/javascript');
      response.setHeader('set-cookie', [
        'dsh_pref=compact; Path=/',
        '__Host-opc_secure_lan=replace; Path=/',
        '__Host-opc_secure_csrf=replace; Path=/'
      ]);
      response.end('window.dsh = true');
    });
    const upstreamPort = await listen(upstream);
    const { gateway, status } = await makeGateway({ upstream: `http://127.0.0.1:${upstreamPort}/` });
    const session = await pair(gateway, status);
    const response = await httpsCall(status, '/asset.js?v=1', {
      headers: {
        Cookie: `${session.cookie}; ${session.csrfCookie}; dsh_pref=wide`,
        Origin: status.origin!
      }
    });
    expect(response.status).toBe(200);
    expect(response.body).toBe('window.dsh = true');
    expect(seen).toEqual([{
      host: status.authority,
      origin: status.origin,
      cookie: 'dsh_pref=wide',
      csrf: undefined,
      url: '/asset.js?v=1'
    }]);
    expect(response.headers['set-cookie']).toEqual(['dsh_pref=compact; Path=/']);
  });

  it('injects Main-owned upstream credentials after stripping browser cookies', async () => {
    const seen: Array<{ cookie?: string; origin?: string; internal?: string; url?: string }> = [];
    const upstream = createServer((request, response) => {
      seen.push({
        cookie: request.headers.cookie,
        origin: request.headers.origin,
        internal: request.headers['x-hermes-internal'] as string | undefined,
        url: request.url
      });
      response.end('ok');
    });
    const upstreamPort = await listen(upstream);
    const { gateway, status } = await makeGateway({
      upstream: `http://127.0.0.1:${upstreamPort}/`,
      allowedSensitiveQueryNames: ['token'],
      resolveUpstreamHeaders: () => ({
        cookie: '__opc_hermes_workbench=main-owned-lease',
        origin: 'http://127.0.0.1:45678',
        'x-hermes-internal': 'main-only'
      })
    });
    const session = await pair(gateway, status);
    const response = await httpsCall(status, '/asset.js?token=public-compatibility-token', {
      headers: {
        Cookie: `${session.cookie}; ${session.csrfCookie}; __opc_hermes_workbench=attacker`,
        Origin: status.origin!
      }
    });
    expect(response.status).toBe(200);
    expect(seen).toEqual([{
      cookie: '__opc_hermes_workbench=main-owned-lease',
      origin: 'http://127.0.0.1:45678',
      internal: 'main-only',
      url: '/asset.js?token=public-compatibility-token'
    }]);
  });

  it('fails closed when an upstream resolver returns anything except literal loopback HTTP', async () => {
    const { gateway, status } = await makeGateway({ upstream: 'http://192.168.1.20:3080/' });
    const session = await pair(gateway, status);
    const response = await httpsCall(status, '/asset.js', { headers: { Cookie: session.cookie } });
    expect(response.status).toBe(502);
    expect(gateway.getStatus().lastError).toBe('Secure LAN proxy failure');
  });

  it('keeps the listener available and returns an explicit runtime-unavailable response when the upstream stops', async () => {
    const { gateway, status } = await makeGateway({ upstream: null });
    const session = await pair(gateway, status);
    const response = await httpsCall(status, '/asset.js', { headers: { Cookie: session.cookie } });

    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: 'runtime_unavailable' });
    expect(gateway.getStatus()).toMatchObject({ running: true, port: status.port, lastError: null });
  });

  it('parses RPC JSON, enforces method/role/CSRF policy, body limits, and prompt rate limits', async () => {
    const seen: unknown[] = [];
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.setHeader('content-type', 'application/json');
        response.end('{"ok":true}');
      });
    });
    const upstreamPort = await listen(upstream);
    const { gateway, status } = await makeGateway({
      upstream: `http://127.0.0.1:${upstreamPort}/`,
      limits: { prompt: { max: 1, windowMs: 60_000 }, maxBodyBytes: 1024 }
    });
    const operator = await pair(gateway, status, 'operator');
    const viewer = await pair(gateway, status, 'viewer');
    const prompt = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session.prompt', params: { text: 'work' } });

    expect((await httpsCall(status, '/rpc', {
      method: 'POST',
      headers: { ...mutationHeaders(status, operator), 'X-OPC-CSRF': 'wrong' },
      body: prompt
    })).status).toBe(403);
    expect((await httpsCall(status, '/rpc', {
      method: 'POST', headers: mutationHeaders(status, viewer), body: prompt
    })).status).toBe(403);
    expect((await httpsCall(status, '/rpc', {
      method: 'POST', headers: mutationHeaders(status, operator), body: JSON.stringify({ method: 'plugin.install' })
    })).status).toBe(403);
    expect(seen).toHaveLength(0);

    expect((await httpsCall(status, '/rpc', {
      method: 'POST', headers: mutationHeaders(status, operator), body: prompt
    })).status).toBe(200);
    expect(seen).toHaveLength(1);
    expect((await httpsCall(status, '/rpc', {
      method: 'POST', headers: mutationHeaders(status, operator), body: prompt
    })).status).toBe(429);

    const oversized = JSON.stringify({ method: 'session.cancel', padding: 'x'.repeat(600) });
    expect((await httpsCall(status, '/rpc', {
      method: 'POST', headers: mutationHeaders(status, operator), body: oversized
    })).status).toBe(413);
    expect(seen).toHaveLength(1);
  });

  it('rate-limits HTTP RPCs before running a lease or receipt authorizer', async () => {
    const authorize = vi.fn(() => true);
    let forwarded = 0;
    const upstream = createServer((_request, response) => {
      forwarded += 1;
      response.end('{}');
    });
    const upstreamPort = await listen(upstream);
    const guardedPolicy: SecureLanPolicyResolver = ({ pathname }) => pathname === '/rpc'
      ? {
          kind: 'rpc', runtimeId: 'runtime-1', methods: ['POST'],
          rpc: { methods: { 'session.prompt': { roles: ['operator'], rateLimitBucket: 'prompt', authorize } } }
        }
      : null;
    const { gateway, status } = await makeGateway({
      upstream: `http://127.0.0.1:${upstreamPort}/`,
      resolvePolicy: guardedPolicy,
      limits: { prompt: { max: 1, windowMs: 60_000 } }
    });
    const session = await pair(gateway, status);
    const request = {
      method: 'POST', headers: mutationHeaders(status, session),
      body: JSON.stringify({ method: 'session.prompt', params: { text: 'work' } })
    };
    expect((await httpsCall(status, '/rpc', request)).status).toBe(200);
    expect((await httpsCall(status, '/rpc', request)).status).toBe(429);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(forwarded).toBe(1);
  });

  it('bounds concurrent upstream requests per paired session', async () => {
    let releaseFirst!: () => void;
    let markReceived!: () => void;
    const received = new Promise<void>((resolve) => { markReceived = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const upstream = createServer(async (_request, response) => {
      markReceived();
      await release;
      response.end('ok');
    });
    const upstreamPort = await listen(upstream);
    const { gateway, status } = await makeGateway({
      upstream: `http://127.0.0.1:${upstreamPort}/`,
      limits: { maxConcurrentRequestsPerSession: 1 }
    });
    const session = await pair(gateway, status);
    const first = httpsCall(status, '/asset.js', { headers: { Cookie: session.cookie } });
    await received;
    const second = await httpsCall(status, '/asset.js', { headers: { Cookie: session.cookie } });
    expect(second.status).toBe(429);
    expect(gateway.getStatus().activeRequests).toBe(1);
    releaseFirst();
    expect((await first).status).toBe(200);
    expect(gateway.getStatus().activeRequests).toBe(0);
  });

  it('accepts browser WSS without optional Fetch Metadata while enforcing cookie, Origin and runtime scope', async () => {
    let upgradeHeaders: { host?: string; origin?: string; cookie?: string } | null = null;
    const upstream = createServer((_request, response) => response.writeHead(404).end());
    const upstreamSockets = new WebSocketServer({ noServer: true });
    upstream.on('upgrade', (request, socket, head) => {
      upgradeHeaders = {
        host: request.headers.host,
        origin: request.headers.origin,
        cookie: request.headers.cookie
      };
      upstreamSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.send('event:ready');
      });
    });
    const upstreamPort = await listen(upstream);
    const { gateway, status } = await makeGateway({ upstream: `http://127.0.0.1:${upstreamPort}/` });
    const session = await pair(gateway, status);

    const valid = new WebSocket(`wss://127.0.0.1:${status.port}/events`, {
      rejectUnauthorized: false,
      headers: {
        Host: status.authority!,
        Origin: status.origin!,
        Cookie: `${session.cookie}; ${session.csrfCookie}; dsh_socket=yes`
      }
    });
    const message = await new Promise<string>((resolve, reject) => {
      valid.once('message', (data) => resolve(data.toString()));
      valid.once('error', reject);
    });
    expect(message).toBe('event:ready');
    expect(upgradeHeaders).toEqual({
      host: status.authority,
      origin: status.origin,
      cookie: 'dsh_socket=yes'
    });

    const unauthorized = new WebSocket(`wss://127.0.0.1:${status.port}/events`, {
      rejectUnauthorized: false,
      headers: { Host: status.authority!, Origin: status.origin!, 'Sec-Fetch-Site': 'same-origin' }
    });
    const unauthorizedStatus = await new Promise<number>((resolve) => {
      unauthorized.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
      unauthorized.once('error', () => resolve(0));
    });
    expect(unauthorizedStatus).toBe(401);

    const crossOrigin = new WebSocket(`wss://127.0.0.1:${status.port}/events`, {
      rejectUnauthorized: false,
      headers: {
        Host: status.authority!, Origin: 'https://evil.invalid',
        'Sec-Fetch-Site': 'cross-site', Cookie: session.cookie
      }
    });
    const crossOriginStatus = await new Promise<number>((resolve) => {
      crossOrigin.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
      crossOrigin.once('error', () => resolve(0));
    });
    expect(crossOriginStatus).toBe(403);

    const forgedFetchMetadata = new WebSocket(`wss://127.0.0.1:${status.port}/events`, {
      rejectUnauthorized: false,
      headers: {
        Host: status.authority!, Origin: status.origin!,
        'Sec-Fetch-Site': 'cross-site', Cookie: session.cookie
      }
    });
    const forgedFetchStatus = await new Promise<number>((resolve) => {
      forgedFetchMetadata.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
      forgedFetchMetadata.once('error', () => resolve(0));
    });
    expect(forgedFetchStatus).toBe(403);

    const wrongRuntime = new SecureLanGateway({
      runtimeId: 'runtime-1',
      resolveUpstream: () => `http://127.0.0.1:${upstreamPort}/`,
      resolvePolicy: policy('another-runtime')
    });
    gateways.push(wrongRuntime);
    const wrongStatus = await wrongRuntime.start({ bindHost: '127.0.0.1', publicHost: 'wrong.test', tls });
    const wrongSession = await pair(wrongRuntime, wrongStatus);
    const wrongSocket = new WebSocket(`wss://127.0.0.1:${wrongStatus.port}/events`, {
      rejectUnauthorized: false,
      headers: {
        Host: wrongStatus.authority!, Origin: wrongStatus.origin!, 'Sec-Fetch-Site': 'same-origin', Cookie: wrongSession.cookie
      }
    });
    const wrongStatusCode = await new Promise<number>((resolve) => {
      wrongSocket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
      wrongSocket.once('error', () => resolve(0));
    });
    expect(wrongStatusCode).toBe(403);

    const closed = new Promise<void>((resolve) => valid.once('close', () => resolve()));
    await gateway.stop();
    await closed;
    expect(gateway.getStatus()).toMatchObject({ enabled: false, running: false, activeSessions: 0, activeWebSockets: 0 });
    const restarted = await gateway.start({ bindHost: '127.0.0.1', publicHost: 'nexus.test', tls });
    expect((await httpsCall(restarted, '/asset.js', { headers: { Cookie: session.cookie } })).status).toBe(401);
    upstreamSockets.close();
  });

  it('lets a paired mobile browser watch progress and approve while viewer sessions stay read-only and independent', async () => {
    const approvals: unknown[] = [];
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        approvals.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.setHeader('content-type', 'application/json');
        response.end('{"accepted":true}');
      });
    });
    const upstreamSockets = new WebSocketServer({ noServer: true });
    upstream.on('upgrade', (request, socket, head) => {
      upstreamSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.send(JSON.stringify({
          type: 'session/event', sessionId: 'dsh-session-project-1',
          event: { seq: 8, type: 'run/progress', data: { progress: 65, stage: 'rendering' } }
        }));
      });
    });
    const upstreamPort = await listen(upstream);
    const mobilePolicy: SecureLanPolicyResolver = ({ pathname, websocket }) => {
      if (pathname === '/api/events.mux' && websocket) {
        return {
          kind: 'websocket', runtimeId: 'runtime-1', roles: ['viewer', 'operator'],
          rateLimitBucket: 'stream'
        };
      }
      if (pathname === '/api/respond' && !websocket) {
        return {
          kind: 'rpc', runtimeId: 'runtime-1', methods: ['POST'], roles: ['operator'],
          rpc: {
            extractMethods: () => ['respond'],
            methods: { respond: { roles: ['operator'], rateLimitBucket: 'control' } }
          }
        };
      }
      return null;
    };
    const { gateway, status } = await makeGateway({
      upstream: `http://127.0.0.1:${upstreamPort}/`, resolvePolicy: mobilePolicy
    });
    const operator = await pair(gateway, status, 'operator');
    const viewer = await pair(gateway, status, 'viewer');
    expect(operator.cookie).not.toBe(viewer.cookie);
    expect(operator.csrf).not.toBe(viewer.csrf);
    expect(gateway.getStatus().activeSessions).toBe(2);

    const mobile = new WebSocket(`wss://127.0.0.1:${status.port}/api/events.mux`, {
      rejectUnauthorized: false,
      headers: {
        Host: status.authority!, Origin: status.origin!, 'Sec-Fetch-Site': 'same-origin',
        Cookie: `${operator.cookie}; ${operator.csrfCookie}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148'
      }
    });
    const progress = await new Promise<Record<string, unknown>>((resolve, reject) => {
      mobile.once('message', (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
      mobile.once('error', reject);
    });
    expect(progress).toMatchObject({
      type: 'session/event', sessionId: 'dsh-session-project-1',
      event: { seq: 8, type: 'run/progress', data: { progress: 65, stage: 'rendering' } }
    });

    const approval = JSON.stringify({ requestId: 'approval-publish-1', response: { decision: 'approve' } });
    const operatorHeaders = {
      ...mutationHeaders(status, operator),
      Cookie: `${operator.cookie}; ${operator.csrfCookie}`,
      'User-Agent': 'Mozilla/5.0 (Linux; Android 15) Mobile Safari/537.36'
    };
    expect((await httpsCall(status, '/api/respond', {
      method: 'POST', headers: operatorHeaders, body: approval
    })).status).toBe(200);
    expect(approvals).toEqual([{ requestId: 'approval-publish-1', response: { decision: 'approve' } }]);

    expect((await httpsCall(status, '/api/respond', {
      method: 'POST',
      headers: {
        ...mutationHeaders(status, viewer),
        Cookie: `${viewer.cookie}; ${viewer.csrfCookie}`,
        'User-Agent': 'Mozilla/5.0 (iPhone) Mobile'
      },
      body: approval
    })).status).toBe(403);
    expect(approvals).toHaveLength(1);

    mobile.terminate();
    upstreamSockets.close();
  });

  it('rate-limits client WebSocket RPCs before running a lease or receipt authorizer', async () => {
    const authorize = vi.fn(() => true);
    let forwarded = 0;
    const upstream = createServer((_request, response) => response.writeHead(404).end());
    const upstreamSockets = new WebSocketServer({ noServer: true });
    upstream.on('upgrade', (request, socket, head) => {
      upstreamSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.send('ready');
        webSocket.on('message', (data) => {
          forwarded += 1;
          webSocket.send(data);
        });
      });
    });
    const upstreamPort = await listen(upstream);
    const socketPolicy: SecureLanPolicyResolver = ({ pathname, websocket }) => pathname === '/events' && websocket
      ? {
          kind: 'websocket', runtimeId: 'runtime-1', roles: ['operator'], rateLimitBucket: 'stream',
          clientRpc: {
            methods: {
              'session.prompt': { roles: ['operator'], rateLimitBucket: 'prompt', authorize }
            }
          }
        }
      : null;
    const { gateway, status } = await makeGateway({
      upstream: `http://127.0.0.1:${upstreamPort}/`,
      resolvePolicy: socketPolicy,
      limits: { prompt: { max: 1, windowMs: 60_000 } }
    });
    const session = await pair(gateway, status);
    const socket = new WebSocket(`wss://127.0.0.1:${status.port}/events`, {
      rejectUnauthorized: false,
      headers: {
        Host: status.authority!, Origin: status.origin!, 'Sec-Fetch-Site': 'same-origin', Cookie: session.cookie
      }
    });
    const ready = new Promise<void>((resolve, reject) => {
      socket.on('message', (data) => data.toString() === 'ready' && resolve());
      socket.once('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    await ready;
    const payload = JSON.stringify({ method: 'session.prompt', params: { text: 'work' } });
    const echoed = new Promise<void>((resolve, reject) => {
      socket.once('message', () => resolve());
      socket.once('error', reject);
    });
    socket.send(payload);
    await echoed;
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.send(payload);
    await closed;
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(forwarded).toBe(1);
    upstreamSockets.close();
  });

  it('supports an injected lease/authorization check without forwarding rejected payloads', async () => {
    const authorize = vi.fn(async ({ payload }) => (
      (payload as { params?: { leaseToken?: string } }).params?.leaseToken === 'active-lease'
    ));
    let forwarded = 0;
    const upstream = createServer((_request, response) => {
      forwarded += 1;
      response.end('{}');
    });
    const upstreamPort = await listen(upstream);
    const guardedPolicy: SecureLanPolicyResolver = ({ pathname }) => pathname === '/rpc'
      ? {
          kind: 'rpc', runtimeId: 'runtime-1', methods: ['POST'],
          rpc: { methods: { 'session.prompt': { roles: ['operator'], rateLimitBucket: 'prompt', authorize } } }
        }
      : null;
    const { gateway, status } = await makeGateway({
      upstream: `http://127.0.0.1:${upstreamPort}/`,
      resolvePolicy: guardedPolicy
    });
    const session = await pair(gateway, status);

    expect((await httpsCall(status, '/rpc', {
      method: 'POST', headers: mutationHeaders(status, session),
      body: JSON.stringify({ method: 'session.prompt', params: { leaseToken: 'stale' } })
    })).status).toBe(403);
    expect((await httpsCall(status, '/rpc', {
      method: 'POST', headers: mutationHeaders(status, session),
      body: JSON.stringify({ method: 'session.prompt', params: { leaseToken: 'active-lease' } })
    })).status).toBe(200);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(forwarded).toBe(1);
  });
});
