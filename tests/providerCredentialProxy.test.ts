import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROVIDER_CREDENTIAL_PROXY_MAX_REQUEST_BYTES,
  ProviderCredentialProxy,
  type ProviderCredentialAuditEvent,
  type ProviderCredentialBinding,
  type ProviderCredentialResolution
} from '../src/main/services/providerCredentialProxy.js';

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function callHttp(
  proxy: ProviderCredentialProxy,
  path: string,
  options: { method?: string; token?: string; body?: string; origin?: string; host?: string; contentType?: string } = {}
): Promise<HttpResult> {
  const status = proxy.getStatus();
  if (!status.port) throw new Error('proxy is not listening');
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Host: options.host ?? `${status.host}:${status.port}`
    };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) {
      headers['Content-Type'] = options.contentType ?? 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(options.body));
    }
    if (options.origin !== undefined) headers.Origin = options.origin;
    const request = httpRequest({
      hostname: status.host,
      port: status.port,
      path,
      method: options.method ?? 'GET',
      headers
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('error', reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

function json(result: HttpResult): Record<string, unknown> {
  return JSON.parse(result.body) as Record<string, unknown>;
}

describe('ProviderCredentialProxy', () => {
  let now: number;
  let proxy: ProviderCredentialProxy;
  let resolver: ReturnType<typeof vi.fn>;
  let upstream: ReturnType<typeof vi.fn>;
  let audits: ProviderCredentialAuditEvent[];
  let defaultResolution: ProviderCredentialResolution;

  beforeEach(async () => {
    now = 1_700_000_000_000;
    defaultResolution = {
      organizationId: 'org-local',
      providerId: 'provider-a',
      model: 'deepseek-chat',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'sk-real-provider-secret'
    };
    resolver = vi.fn(async () => ({ ...defaultResolution }));
    upstream = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));
    audits = [];
    proxy = new ProviderCredentialProxy({
      resolveProvider: resolver,
      fetch: upstream as unknown as typeof fetch,
      now: () => now,
      audit: (event) => audits.push(event),
      maxGrantTtlMs: 60_000,
      upstreamTimeoutMs: 30_000
    });
    await proxy.start(0);
  });

  afterEach(async () => {
    await proxy.stop();
  });

  async function issue(overrides: Partial<Parameters<typeof proxy.issueGrant>[0]> = {}) {
    return proxy.issueGrant({
      organizationId: 'org-local',
      runtimeId: 'runtime-1',
      agentId: 'agent-1',
      providerId: 'provider-a',
      model: 'deepseek-chat',
      ttlMs: 10_000,
      maxRequests: 10,
      maxConcurrentRequests: 2,
      maxRequestBytes: 16 * 1024,
      ...overrides
    });
  }

  it('binds an opaque token to a runtime and never exposes the Provider key', async () => {
    const issued = await issue();
    const snapshot = proxy.inspectGrant(issued.grantId);
    expect(issued.token).toMatch(/^dshp_[A-Za-z0-9_-]{43}$/);
    expect(snapshot?.tokenHash).not.toContain(issued.token);
    expect(snapshot).not.toHaveProperty('apiKey');
    expect(JSON.stringify({ issued, snapshot, audits })).not.toContain(defaultResolution.apiKey);
    expect(JSON.stringify(proxy.getStatus())).not.toContain(defaultResolution.apiKey);
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-local', runtimeId: 'runtime-1', agentId: 'agent-1',
      providerId: 'provider-a', model: 'deepseek-chat'
    }));
  });

  it('does not issue a capability when the proxy stops during credential resolution', async () => {
    let resolveCredential!: (value: ProviderCredentialResolution) => void;
    resolver.mockImplementationOnce(() => new Promise<ProviderCredentialResolution>((resolve) => {
      resolveCredential = resolve;
    }));

    const pending = issue({ runtimeId: 'runtime-stop-race' });
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(1));
    await proxy.stop();
    resolveCredential({ ...defaultResolution });

    await expect(pending).rejects.toThrow('not running');
    expect(proxy.getStatus()).toMatchObject({ running: false, activeGrants: 0 });
    expect(audits).toContainEqual(expect.objectContaining({
      action: 'grant.issue', result: 'denied', reason: 'proxy_stopped'
    }));
  });

  it('renews an active opaque capability without replacing its token or scope', async () => {
    const issued = await issue();
    const originalExpiry = issued.expiresAt;
    now += 5_000;

    const renewed = await proxy.renewGrant(issued.grantId, 20_000);

    expect(renewed.expiresAt).toBe(now + 20_000);
    expect(renewed.expiresAt).toBeGreaterThan(originalExpiry);
    expect(proxy.inspectGrant(issued.grantId)).toMatchObject({
      expiresAt: renewed.expiresAt,
      providerId: 'provider-a',
      model: 'deepseek-chat',
      revokedAt: null
    });
    expect((await callHttp(proxy, '/v1/models', { token: issued.token })).status).toBe(200);
    expect(audits).toContainEqual(expect.objectContaining({ action: 'grant.renew', result: 'ok' }));
  });

  it('refuses to renew a revoked capability', async () => {
    const issued = await issue();
    expect(proxy.revokeGrant(issued.grantId, 'test')).toBe(true);
    await expect(proxy.renewGrant(issued.grantId, 10_000)).rejects.toThrow('not active');
  });

  it('does not renew a capability revoked during credential resolution', async () => {
    const issued = await issue();
    const originalExpiry = issued.expiresAt;
    let resolveCredential!: (value: ProviderCredentialResolution) => void;
    resolver.mockImplementationOnce(() => new Promise<ProviderCredentialResolution>((resolve) => {
      resolveCredential = resolve;
    }));

    const pending = proxy.renewGrant(issued.grantId, 20_000);
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(2));
    expect(proxy.revokeGrant(issued.grantId, 'renew_race')).toBe(true);
    resolveCredential({ ...defaultResolution });

    await expect(pending).rejects.toThrow('not active');
    expect(proxy.inspectGrant(issued.grantId)).toMatchObject({
      expiresAt: originalExpiry,
      revokedAt: expect.any(Number)
    });
    expect(audits).not.toContainEqual(expect.objectContaining({
      action: 'grant.renew', result: 'ok'
    }));
  });

  it('does not renew a capability when the proxy stops during credential resolution', async () => {
    const issued = await issue();
    const originalExpiry = issued.expiresAt;
    let resolveCredential!: (value: ProviderCredentialResolution) => void;
    resolver.mockImplementationOnce(() => new Promise<ProviderCredentialResolution>((resolve) => {
      resolveCredential = resolve;
    }));

    const pending = proxy.renewGrant(issued.grantId, 20_000);
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(2));
    await proxy.stop();
    resolveCredential({ ...defaultResolution });

    await expect(pending).rejects.toThrow('not running');
    expect(proxy.inspectGrant(issued.grantId)).toMatchObject({
      expiresAt: originalExpiry,
      revokedAt: expect.any(Number)
    });
    expect(audits).toContainEqual(expect.objectContaining({
      action: 'grant.renew', result: 'denied', reason: 'proxy_stopped'
    }));
  });

  it('accepts the shared production request-size cap and rejects values above it', async () => {
    const issued = await issue({ maxRequestBytes: PROVIDER_CREDENTIAL_PROXY_MAX_REQUEST_BYTES });
    expect(proxy.inspectGrant(issued.grantId)?.maxRequestBytes)
      .toBe(PROVIDER_CREDENTIAL_PROXY_MAX_REQUEST_BYTES);
    await expect(issue({
      runtimeId: 'runtime-over-limit',
      maxRequestBytes: PROVIDER_CREDENTIAL_PROXY_MAX_REQUEST_BYTES + 1
    })).rejects.toThrow('Invalid Provider request size');
  });

  it('serves only the scoped model and rejects browser/CORS and Host requests', async () => {
    const issued = await issue();
    const models = await callHttp(proxy, '/v1/models', { token: issued.token });
    expect(models.status).toBe(200);
    expect(json(models).data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'deepseek-chat', owned_by: 'provider-a' })
    ]));

    const cors = await callHttp(proxy, '/v1/models', { token: issued.token, origin: 'https://evil.example' });
    expect(cors.status).toBe(403);
    expect(cors.headers['access-control-allow-origin']).toBeUndefined();

    const badHost = await callHttp(proxy, '/v1/models', {
      token: issued.token,
      host: `localhost:${proxy.getStatus().port}`
    });
    expect(badHost.status).toBe(403);
    expect(await callHttp(proxy, '/v1/embeddings', { token: issued.token })).toMatchObject({ status: 404 });
  });

  it('rejects model escalation before contacting the upstream Provider', async () => {
    const issued = await issue();
    const result = await callHttp(proxy, '/v1/chat/completions', {
      method: 'POST',
      token: issued.token,
      body: JSON.stringify({ model: 'more-powerful-model', messages: [] })
    });
    expect(result.status).toBe(403);
    expect(json(result).error).toMatchObject({ code: 'model_scope_violation' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('admits an additional model only after Main authorizes the live grant', async () => {
    resolver.mockImplementation(async (binding: ProviderCredentialBinding) => ({
      ...defaultResolution,
      model: binding.model
    }));
    const issued = await issue();

    await proxy.authorizeGrantModel(issued.grantId, 'deepseek-reasoner');

    const models = await callHttp(proxy, '/v1/models', { token: issued.token });
    expect((json(models).data as Array<{ id: string }>).map((item) => item.id).sort())
      .toEqual(['deepseek-chat', 'deepseek-reasoner']);
    const result = await callHttp(proxy, '/v1/chat/completions', {
      method: 'POST',
      token: issued.token,
      body: JSON.stringify({ model: 'deepseek-reasoner', messages: [] })
    });
    expect(result.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    expect(audits).toContainEqual(expect.objectContaining({
      action: 'grant.model.authorize', result: 'ok', grantId: issued.grantId,
      model: 'deepseek-reasoner'
    }));
  });

  it('refuses model authorization across a Provider route boundary', async () => {
    const issued = await issue();
    resolver.mockImplementationOnce(async (binding: ProviderCredentialBinding) => ({
      ...defaultResolution,
      model: binding.model,
      baseUrl: 'https://another-provider.example/v1'
    }));

    await expect(proxy.authorizeGrantModel(issued.grantId, 'deepseek-reasoner'))
      .rejects.toThrow('route changed');
    const result = await callHttp(proxy, '/v1/chat/completions', {
      method: 'POST', token: issued.token,
      body: JSON.stringify({ model: 'deepseek-reasoner', messages: [] })
    });
    expect(result.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rejects body-level credential and routing overrides', async () => {
    const issued = await issue();
    const result = await callHttp(proxy, '/v1/chat/completions', {
      method: 'POST',
      token: issued.token,
      body: JSON.stringify({
        model: 'deepseek-chat',
        api_key: 'attacker-supplied-key',
        base_url: 'https://attacker.example/v1',
        messages: []
      })
    });
    expect(result.status).toBe(403);
    expect(json(result).error).toMatchObject({ code: 'provider_scope_violation' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('forwards only the scoped Provider request and streams the response', async () => {
    let sentHeaders: Record<string, string> | undefined;
    let sentRedirect: unknown;
    upstream.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      sentHeaders = init.headers as Record<string, string>;
      sentRedirect = init.redirect;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"ok":'));
          controller.enqueue(new TextEncoder().encode('true}\n\n'));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const issued = await issue();
    const result = await callHttp(proxy, '/v1/chat/completions', {
      method: 'POST',
      token: issued.token,
      body: JSON.stringify({ model: 'deepseek-chat', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe('data: {"ok":true}\n\n');
    expect(sentHeaders?.authorization).toBe(`Bearer ${defaultResolution.apiKey}`);
    expect(sentHeaders?.authorization).not.toContain(issued.token);
    expect(sentHeaders).not.toHaveProperty('cookie');
    expect(sentRedirect).toBe('error');
  });

  it('enforces request size, request-count budget, expiration and revocation', async () => {
    const issued = await issue({ maxRequests: 2, maxRequestBytes: 64 });
    const oversized = await callHttp(proxy, '/v1/chat/completions', {
      method: 'POST', token: issued.token,
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'x'.repeat(200) }] })
    });
    expect(oversized.status).toBe(413);

    const first = await callHttp(proxy, '/v1/models', { token: issued.token });
    expect(first.status).toBe(200);
    const exhausted = await callHttp(proxy, '/v1/models', { token: issued.token });
    expect(exhausted.status).toBe(429);
    expect(json(exhausted).error).toMatchObject({ code: 'request_budget_exhausted' });

    const expiring = await issue({ ttlMs: 1_000 });
    now += 1_001;
    expect((await callHttp(proxy, '/v1/models', { token: expiring.token })).status).toBe(401);

    const revocable = await issue();
    expect(proxy.revokeGrant(revocable.grantId)).toBe(true);
    expect((await callHttp(proxy, '/v1/models', { token: revocable.token })).status).toBe(401);
  });

  it('limits concurrent upstream calls and revokes in-flight requests', async () => {
    let release!: (response: Response) => void;
    upstream.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    const issued = await issue({ maxConcurrentRequests: 1, maxRequests: 5 });
    const first = callHttp(proxy, '/v1/chat/completions', {
      method: 'POST', token: issued.token, body: JSON.stringify({ model: 'deepseek-chat', messages: [] })
    });
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
    const second = await callHttp(proxy, '/v1/chat/completions', {
      method: 'POST', token: issued.token, body: JSON.stringify({ model: 'deepseek-chat', messages: [] })
    });
    expect(second.status).toBe(429);
    expect(json(second).error).toMatchObject({ code: 'concurrency_limit_exceeded' });
    proxy.revokeGrant(issued.grantId, 'test_revoke');
    release(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const firstResult = await first;
    expect([200, 502]).toContain(firstResult.status);
    expect(proxy.inspectGrant(issued.grantId)?.revokedAt).not.toBeNull();
  });

  it('does not start a request when revocation wins during credential resolution', async () => {
    const issued = await issue();
    let resolveCredential!: (value: ProviderCredentialResolution) => void;
    resolver.mockImplementationOnce(() => new Promise<ProviderCredentialResolution>((resolve) => {
      resolveCredential = resolve;
    }));
    const pending = callHttp(proxy, '/v1/models', { token: issued.token });
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(2));
    expect(proxy.revokeGrant(issued.grantId, 'resolution_race')).toBe(true);
    resolveCredential({ ...defaultResolution });
    expect((await pending).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('fails closed when the Provider binding changes or resolver fails', async () => {
    const issued = await issue();
    defaultResolution = { ...defaultResolution, baseUrl: 'https://another.example/v1' };
    const changed = await callHttp(proxy, '/v1/models', { token: issued.token });
    expect(changed.status).toBe(503);
    resolver.mockRejectedValueOnce(new Error(`secret=${defaultResolution.apiKey}`));
    const failed = await issue().catch((error: Error) => error);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).not.toContain(defaultResolution.apiKey);
    expect(JSON.stringify(audits)).not.toContain(defaultResolution.apiKey);
  });

  it('stops on loopback and revokes all runtime grants', async () => {
    const first = await issue();
    const second = await issue({ runtimeId: 'runtime-2' });
    expect(proxy.revokeRuntime('runtime-1')).toBe(1);
    expect((await callHttp(proxy, '/v1/models', { token: first.token })).status).toBe(401);
    expect((await callHttp(proxy, '/v1/models', { token: second.token })).status).toBe(200);
    await proxy.stop();
    expect(proxy.getStatus().running).toBe(false);
    expect(proxy.inspectGrant(second.grantId)?.revokedAt).not.toBeNull();
  });

  it('revokes Provider rotations and emergency all-grant shutdowns', async () => {
    resolver.mockImplementation(async (binding: ProviderCredentialBinding) => ({
      ...defaultResolution,
      providerId: binding.providerId
    }));
    const first = await issue({ providerId: 'provider-rotate' });
    const second = await issue({ runtimeId: 'runtime-other' });
    expect(proxy.revokeProvider('provider-rotate', 'rotation')).toBe(1);
    expect((await callHttp(proxy, '/v1/models', { token: first.token })).status).toBe(401);
    expect((await callHttp(proxy, '/v1/models', { token: second.token })).status).toBe(200);
    expect(proxy.revokeAll('emergency')).toBe(1);
    expect((await callHttp(proxy, '/v1/models', { token: second.token })).status).toBe(401);
  });

  it('does not follow upstream redirects', async () => {
    const issued = await issue();
    upstream.mockRejectedValueOnce(new Error('redirect disallowed'));
    const result = await callHttp(proxy, '/v1/chat/completions', {
      method: 'POST', token: issued.token,
      body: JSON.stringify({ model: 'deepseek-chat', messages: [] })
    });
    expect(result.status).toBe(502);
  });

  it('does not issue a grant when an injected audit sink fails', async () => {
    const blocked = new ProviderCredentialProxy({
      resolveProvider: () => ({ ...defaultResolution }),
      audit: () => { throw new Error('audit unavailable'); }
    });
    await blocked.start(0);
    await expect(blocked.issueGrant({
      organizationId: 'org-local',
      runtimeId: 'runtime-audit',
      agentId: 'agent-audit',
      providerId: 'provider-a',
      model: 'deepseek-chat',
      ttlMs: 10_000,
      maxRequests: 1,
      maxConcurrentRequests: 1,
      maxRequestBytes: 1024
    })).rejects.toThrow('grant unavailable');
    expect(blocked.getStatus().activeGrants).toBe(0);
    await blocked.stop();
  });
});

describe('ProviderCredentialProxy network binding', () => {
  it('does not expose a non-loopback listening address', async () => {
    const proxy = new ProviderCredentialProxy({
      resolveProvider: () => ({
        organizationId: 'org', providerId: 'p', model: 'm',
        baseUrl: 'https://provider.example/v1', apiKey: 'secret'
      })
    });
    const status = await proxy.start(0);
    expect(status.host).toBe('127.0.0.1');
    expect((proxy.getStatus().port as number)).toBeGreaterThan(0);
    await proxy.stop();
  });

  it('rejects a port occupied by another listener', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as AddressInfo).port;
    const proxy = new ProviderCredentialProxy({
      resolveProvider: () => ({
        organizationId: 'org', providerId: 'p', model: 'm',
        baseUrl: 'https://provider.example/v1', apiKey: 'secret'
      })
    });
    await expect(proxy.start(port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await proxy.stop();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });
});
