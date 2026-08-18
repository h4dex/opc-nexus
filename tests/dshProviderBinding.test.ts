import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const { resolveDshProviderBinding, resolveDshProviderCredential } = await import(
  '../src/main/services/dshProviderBinding.js'
);

interface FixtureOptions {
  protocol?: string | null;
  archived?: number;
}

function fixture(options: FixtureOptions = {}) {
  const protocol = options.protocol === null ? undefined : options.protocol ?? 'openai-chat';
  const db = {
    raw: {
      prepare: vi.fn((sql: string) => ({
        get: vi.fn(() => sql.includes('FROM agents')
          ? {
              organization_id: 'org-local', provider_id: 'provider-1',
              model_override: 'deepseek-chat', archived: options.archived ?? 0
            }
          : { config_json: JSON.stringify({ providerMode: 'managed', protocol }) })
      }))
    }
  };
  const providers = {
    resolveForAgentWithIdentity: vi.fn((providerId: string | null, modelOverride: string | null) => {
      if (providerId && providerId !== 'provider-1') return null;
      return {
        providerId: 'provider-1', model: modelOverride ?? 'deepseek-chat',
        baseUrl: 'https://api.example.test/v1', key: 'main-only-secret'
      };
    })
  };
  return { db, providers };
}

describe('managed DSH Provider binding', () => {
  it('accepts only the OpenAI Chat protocol required by the pinned adapter', () => {
    const compatible = fixture();
    expect(resolveDshProviderBinding(compatible.db as never, compatible.providers as never, { agentId: 'agent-1' }))
      .toEqual({ organizationId: 'org-local', providerId: 'provider-1', model: 'deepseek-chat' });

    for (const protocol of ['openai-responses', 'anthropic-messages']) {
      const incompatible = fixture({ protocol });
      expect(resolveDshProviderBinding(incompatible.db as never, incompatible.providers as never, { agentId: 'agent-1' }))
        .toBeNull();
      expect(incompatible.providers.resolveForAgentWithIdentity).not.toHaveBeenCalled();
    }
  });

  it('uses the managed engine default for legacy rows with no protocol', () => {
    const value = fixture({ protocol: null });
    expect(resolveDshProviderBinding(value.db as never, value.providers as never, { agentId: 'agent-1' }))
      .toMatchObject({ providerId: 'provider-1', model: 'deepseek-chat' });
  });

  it('rejects archived agents and returns credentials only from an exact identity match', () => {
    const archived = fixture({ archived: 1 });
    expect(resolveDshProviderBinding(archived.db as never, archived.providers as never, { agentId: 'agent-1' }))
      .toBeNull();

    const active = fixture();
    expect(resolveDshProviderCredential(active.providers as never, {
      providerId: 'provider-1', model: 'deepseek-chat'
    })).toEqual({
      providerId: 'provider-1', model: 'deepseek-chat',
      baseUrl: 'https://api.example.test/v1', apiKey: 'main-only-secret'
    });
    expect(resolveDshProviderCredential(active.providers as never, {
      providerId: 'provider-1', model: 'other-model'
    })).toEqual({
      providerId: 'provider-1', model: 'other-model',
      baseUrl: 'https://api.example.test/v1', apiKey: 'main-only-secret'
    });
    expect(resolveDshProviderCredential(active.providers as never, {
      providerId: 'provider-2', model: 'other-model'
    })).toBeNull();
  });
});
