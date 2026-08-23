// @ts-nocheck
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const { HermesRuntimeProfileService } = await import('../src/main/services/hermesRuntimeProfile.js');

function agent(overrides = {}) {
  return {
    id: 'agent-1', name: '运营助手', role: '运营', kind: 'general', systemPrompt: 'system',
    soulMd: 'soul', agentsMd: 'rules', userMd: 'prefers concise answers', modelOverride: undefined,
    ...overrides
  };
}

function db(providerId: string | null = 'provider-1', modelOverride: string | null = null) {
  return {
    raw: {
      prepare: (sql: string) => ({
        get: () => /FROM agents/.test(sql) ? { provider_id: providerId, model_override: modelOverride } : undefined,
        all: () => [],
        run: () => ({ changes: 1 })
      })
    },
    getSetting: (_key: string, fallback: unknown) => fallback,
    audit: vi.fn()
  };
}

describe('HermesRuntimeProfileService', () => {
  it('writes only non-secret routing config and returns task-scoped credentials', () => {
    const root = mkdtempSync(join(tmpdir(), 'opc-hermes-profile-'));
    const providers = {
      resolveForAgent: vi.fn(() => ({
        baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', key: 'secret-key'
      }))
    };
    const service = new HermesRuntimeProfileService(db() as never, providers as never, root);

    const prepared = service.ensure(agent() as never);
    const config = readFileSync(join(prepared.home, 'config.yaml'), 'utf8');

    expect(config).toContain('"provider": "opcnexus"');
    expect(config).toContain('https://api.deepseek.com/v1');
    expect(config).toContain('"max_tokens": 16384');
    expect(config).not.toContain('secret-key');
    expect(prepared.env).toMatchObject({
      HERMES_HOME: prepared.home,
      HERMES_INFERENCE_MODEL: 'deepseek-chat',
      HERMES_INFERENCE_PROVIDER: 'opcnexus',
      OPENAI_API_KEY: 'secret-key'
    });
    const managedUserPath = join(prepared.home, 'USER.md');
    const learnedUserPath = join(prepared.home, 'memories', 'USER.md');
    expect(readFileSync(managedUserPath, 'utf8')).toBe('prefers concise answers');
    expect(readFileSync(learnedUserPath, 'utf8')).toBe('prefers concise answers');

    writeFileSync(learnedUserPath, 'learned preference', 'utf8');
    const updated = service.ensure(agent({ userMd: 'updated preference' }) as never);
    expect(updated.home).toBe(prepared.home);
    expect(readFileSync(managedUserPath, 'utf8')).toBe('updated preference');
    expect(readFileSync(learnedUserPath, 'utf8')).toBe('learned preference');
  });

  it('isolates profile paths by Agent id and passes the Agent provider binding', () => {
    const root = mkdtempSync(join(tmpdir(), 'opc-hermes-profile-'));
    const providers = { resolveForAgent: vi.fn(() => ({ baseUrl: 'https://provider.test/v1', model: 'm', key: 'k' })) };
    const service = new HermesRuntimeProfileService(db('bound-provider', 'bound-model') as never, providers as never, root);

    const first = service.ensure(agent({ id: 'agent/../one' }) as never);
    const second = service.ensure(agent({ id: 'agent-two' }) as never);

    expect(first.home).not.toBe(second.home);
    expect(first.home.startsWith(root)).toBe(true);
    expect(providers.resolveForAgent).toHaveBeenCalledWith('bound-provider', 'bound-model');
  });

  it('fails closed when the bound Provider or secret is unavailable', () => {
    const root = mkdtempSync(join(tmpdir(), 'opc-hermes-profile-'));
    const service = new HermesRuntimeProfileService(
      db('missing-provider') as never,
      { resolveForAgent: () => null } as never,
      root
    );
    expect(() => service.ensure(agent() as never)).toThrow('Configured model Provider is unavailable');
  });

  it('isolates controller native memory by organization, principal and conversation', () => {
    const root = mkdtempSync(join(tmpdir(), 'opc-hermes-profile-'));
    const providers = {
      resolveForAgent: vi.fn(() => ({ baseUrl: 'https://provider.test/v1', model: 'm', key: 'k' }))
    };
    const service = new HermesRuntimeProfileService(db(null) as never, providers as never, root);

    const first = service.ensureController('org-a', 'principal-a', 'conversation-a');
    const otherPrincipal = service.ensureController('org-a', 'principal-b', 'conversation-a');
    const otherConversation = service.ensureController('org-a', 'principal-a', 'conversation-b');

    expect(new Set([first.home, otherPrincipal.home, otherConversation.home]).size).toBe(3);
    writeFileSync(join(first.home, 'memories', 'USER.md'), 'private memory', 'utf8');
    expect(readFileSync(join(otherPrincipal.home, 'memories', 'USER.md'), 'utf8')).toBe('');
    expect(readFileSync(join(otherConversation.home, 'memories', 'USER.md'), 'utf8')).toBe('');
  });

  it('recreates an isolated probe profile from the default OPC Provider', () => {
    const root = mkdtempSync(join(tmpdir(), 'opc-hermes-profile-'));
    const providers = {
      resolveForAgent: vi.fn(() => ({ baseUrl: 'https://provider.test/v1', model: 'probe-model', key: 'probe-key' }))
    };
    const service = new HermesRuntimeProfileService(db(null) as never, providers as never, root);

    const prepared = service.ensureProbe();

    expect(providers.resolveForAgent).toHaveBeenCalledWith(null, null);
    expect(prepared.env.HERMES_HOME).toBe(prepared.home);
    expect(readFileSync(join(prepared.home, 'config.yaml'), 'utf8')).not.toContain('probe-key');
  });
});
