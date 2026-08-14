// @ts-nocheck
/* eslint-disable */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const { getProviderConfig, providerReady, readProviderKey, testProvider } = await import('../src/main/services/provider.js');
const { ProviderManager } = await import('../src/main/services/providerManager.js');

function makeDb(rows: Record<string, unknown>[], secrets: Record<string, string>) {
  return {
    raw: {
      prepare: (sql: string) => ({
        get: (...args: unknown[]) => {
          if (/WHERE id = \?/.test(sql)) return rows.find((row) => row.id === args[0]);
          if (/is_default = 1/.test(sql)) return rows.find((row) => row.is_default === 1);
          if (/ORDER BY created_at/.test(sql)) return rows[0];
          return undefined;
        },
        all: () => rows,
        run: vi.fn(() => ({ changes: 1 }))
      })
    },
    getSetting: (key: string, fallback: unknown) => secrets[key] ?? fallback,
    setSetting: vi.fn(),
    audit: vi.fn(),
    transaction: (fn: () => void) => fn()
  };
}

function encrypted(value: string): string {
  return Buffer.from(`enc:${value}`).toString('base64');
}

describe('Provider credential readiness', () => {
  it.each(['', '   '])('treats an encrypted empty credential as not configured', (key) => {
    const db = makeDb([{
      id: 'provider-1', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
      api_key_ref: 'secret:provider:provider-1', is_default: 1, created_at: 1
    }], { 'secret:provider:provider-1': encrypted(key) });

    expect(providerReady(db as never)).toBe(false);
    expect(getProviderConfig(db as never).hasKey).toBe(false);
    expect(readProviderKey(db as never)).toBeNull();
    expect(new ProviderManager(db as never).resolveForAgent(null, null)).toBeNull();
  });

  it('normalizes a decrypted credential before sharing it with execution paths', () => {
    const db = makeDb([{
      id: 'provider-1', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
      api_key_ref: 'secret:provider:provider-1', is_default: 1, created_at: 1
    }], { 'secret:provider:provider-1': encrypted('  valid-key  ') });

    expect(readProviderKey(db as never)).toBe('valid-key');
  });

  it('does not fall back when an explicitly bound Provider is missing', () => {
    const db = makeDb([{
      id: 'provider-default', base_url: 'https://default.example/v1', model: 'default-model',
      api_key_ref: 'secret:provider:provider-default', is_default: 1, created_at: 1
    }], { 'secret:provider:provider-default': encrypted('default-key') });

    const manager = new ProviderManager(db as never);
    expect(manager.resolveForAgent('provider-missing', null)).toBeNull();
    expect(manager.resolveForAgent(null, null)).toEqual({
      baseUrl: 'https://default.example/v1', model: 'default-model', key: 'default-key'
    });
  });

  it.each([
    { base_url: '   ', model: 'deepseek-chat' },
    { base_url: 'https://api.deepseek.com/v1', model: '   ' }
  ])('rejects a Provider with missing endpoint or model', (partial) => {
    const db = makeDb([{
      id: 'provider-1', ...partial, api_key_ref: 'secret:provider:provider-1', is_default: 1, created_at: 1
    }], { 'secret:provider:provider-1': encrypted('valid-key') });

    const manager = new ProviderManager(db as never);
    expect(manager.resolveForAgent('provider-1', null)).toBeNull();
    expect(manager.resolveForAgent(null, null)).toBeNull();
  });

  it('validates a new key before changing the default Provider', () => {
    const rows = [{
      id: 'provider-default', base_url: 'https://default.example/v1', model: 'default-model',
      api_key_ref: 'secret:provider:provider-default', is_default: 1, created_at: 1
    }];
    const db = makeDb(rows, { 'secret:provider:provider-default': encrypted('default-key') });
    const manager = new ProviderManager(db as never);
    const updateAll = vi.spyOn(db.raw, 'prepare');

    expect(() => manager.update('provider-missing', { isDefault: true })).toThrow('供应商不存在');
    expect(updateAll.mock.calls.map(([sql]) => sql).filter((sql) => /SET is_default = 0/.test(sql))).toHaveLength(0);
  });

  it.each([
    'file:///tmp/provider',
    'ftp://provider.test/v1',
    'https://user:password@provider.test/v1',
    'https://provider.test/v1?target=https://attacker.test',
    'https://provider.test/v1#attacker',
    'http://provider.test/v1'
  ])('fails closed for an unsafe stored Provider endpoint: %s', (baseUrl) => {
    const db = makeDb([{
      id: 'provider-1', base_url: baseUrl, model: 'model',
      api_key_ref: 'secret:provider:provider-1', is_default: 1, created_at: 1
    }], { 'secret:provider:provider-1': encrypted('valid-key') });
    const manager = new ProviderManager(db as never);

    expect(providerReady(db as never)).toBe(false);
    expect(readProviderKey(db as never)).toBeNull();
    expect(manager.resolveForAgent(null, null)).toBeNull();
  });

  it.each([
    'http://localhost:11434/v1',
    'http://127.0.0.1:11434/v1',
    'http://[::1]:11434/v1'
  ])('allows an HTTP loopback Provider endpoint: %s', (baseUrl) => {
    const db = makeDb([{
      id: 'provider-1', base_url: baseUrl, model: 'model',
      api_key_ref: 'secret:provider:provider-1', is_default: 1, created_at: 1
    }], { 'secret:provider:provider-1': encrypted('valid-key') });

    expect(new ProviderManager(db as never).resolveForAgent(null, null)).toMatchObject({ baseUrl, key: 'valid-key' });
  });

  it('does not send the stored Bearer key to an override on another origin', async () => {
    const db = makeDb([{
      id: 'provider-1', base_url: 'https://provider.test/v1', model: 'model',
      api_key_ref: 'secret:provider:provider-1', is_default: 1, created_at: 1
    }], { 'secret:provider:provider-1': encrypted('stored-key') });
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as never;
    try {
      await expect(testProvider(db as never, { baseUrl: 'https://attacker.test/v1' }))
        .resolves.toMatchObject({ ok: false, error: expect.stringContaining('requires an API Key') });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses an explicit override key for another origin and rejects redirects', async () => {
    const db = makeDb([{
      id: 'provider-1', base_url: 'https://provider.test/v1', model: 'model',
      api_key_ref: 'secret:provider:provider-1', is_default: 1, created_at: 1
    }], { 'secret:provider:provider-1': encrypted('stored-key') });
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.headers).toEqual({ Authorization: 'Bearer override-key' });
      expect(init.redirect).toBe('error');
      throw new TypeError('fetch failed');
    });
    globalThis.fetch = fetchSpy as never;
    try {
      await expect(testProvider(db as never, {
        baseUrl: 'https://other.test/v1', apiKey: 'override-key'
      })).resolves.toMatchObject({ ok: false, error: 'Provider connection failed' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not return an upstream error body from testById', async () => {
    const db = makeDb([{
      id: 'provider-1', base_url: 'https://provider.test/v1', model: 'model',
      api_key_ref: 'secret:provider:provider-1', is_default: 1, created_at: 1
    }], { 'secret:provider:provider-1': encrypted('stored-key') });
    const originalFetch = globalThis.fetch;
    const body = 'upstream-secret-response';
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe('error');
      return new Response(body, { status: 401 });
    });
    globalThis.fetch = fetchSpy as never;
    try {
      const result = await new ProviderManager(db as never).testById('provider-1');
      expect(result).toMatchObject({ ok: false, error: 'HTTP 401' });
      expect(result.error).not.toContain(body);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not return an upstream error body from the legacy connection test', async () => {
    const db = makeDb([{
      id: 'provider-1', base_url: 'https://provider.test/v1', model: 'model',
      api_key_ref: 'secret:provider:provider-1', is_default: 1, created_at: 1
    }], { 'secret:provider:provider-1': encrypted('stored-key') });
    const originalFetch = globalThis.fetch;
    const body = 'upstream-secret-response';
    globalThis.fetch = vi.fn(async () => new Response(body, { status: 403 })) as never;
    try {
      const result = await testProvider(db as never);
      expect(result).toMatchObject({ ok: false, error: 'HTTP 403' });
      expect(result.error).not.toContain(body);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not pair an orphaned legacy secret with the built-in default endpoint', () => {
    const db = makeDb([], { 'secret:provider:hermes:key': encrypted('orphaned-key') });

    expect(readProviderKey(db as never)).toBeNull();
    expect(providerReady(db as never)).toBe(false);
  });
});
