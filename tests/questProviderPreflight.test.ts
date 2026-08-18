import { describe, expect, it, vi } from 'vitest';
import { QuestProviderPreflightService } from '../src/main/services/questProviderPreflight.js';

function fixture(options: {
  hasKey?: boolean;
  binding?: boolean;
  probe?: { ok: boolean; latencyMs: number; error: string | null };
} = {}) {
  const provider = {
    id: 'provider-main', name: 'DeepSeek', baseUrl: 'https://api.example/v1',
    model: 'deepseek-chat', isDefault: true, hasKey: options.hasKey ?? true, createdAt: 1
  };
  const db = {
    raw: {
      prepare: (sql: string) => ({
        get: () => sql.includes('FROM agents')
          ? { organization_id: 'org-local', provider_id: provider.id, model_override: null, archived: 0 }
          : sql.includes('FROM engines')
            ? { config_json: JSON.stringify({ providerId: provider.id, protocol: 'openai-chat' }) }
            : undefined
      })
    }
  };
  const providers = {
    list: vi.fn(() => [provider]),
    resolveForAgentWithIdentity: vi.fn(() => (options.binding ?? true)
      ? { providerId: provider.id, baseUrl: provider.baseUrl, model: provider.model, key: 'main-secret' }
      : null),
    testById: vi.fn(async () => options.probe ?? { ok: true, latencyMs: 42, error: null })
  };
  return {
    providers,
    service: new QuestProviderPreflightService(db as never, providers as never, { now: () => 1234 })
  };
}

describe('QuestProviderPreflightService', () => {
  it('verifies the exact managed Cordis binding and returns only safe metadata', async () => {
    const { service, providers } = fixture();
    const result = await service.probe('agent-cordis');

    expect(providers.testById).toHaveBeenCalledWith('provider-main');
    expect(result).toEqual({
      ready: true, code: 'READY', providerId: 'provider-main', providerName: 'DeepSeek',
      model: 'deepseek-chat', latencyMs: 42, error: null, checkedAt: 1234
    });
    expect(JSON.stringify(result)).not.toContain('main-secret');
    expect(JSON.stringify(result)).not.toContain('api.example');
  });

  it('distinguishes a missing credential before a task reaches DSH', async () => {
    const { service, providers } = fixture({ hasKey: false, binding: false });
    const result = await service.probe('agent-cordis');

    expect(result).toMatchObject({ ready: false, code: 'CREDENTIAL_MISSING', providerId: 'provider-main' });
    expect(providers.testById).not.toHaveBeenCalled();
  });

  it('turns upstream authentication rejection into an actionable failure', async () => {
    const { service } = fixture({ probe: { ok: false, latencyMs: 18, error: 'HTTP 401' } });
    const result = await service.probe('agent-cordis');

    expect(result).toMatchObject({
      ready: false,
      code: 'CREDENTIAL_REJECTED',
      error: '模型 Provider 拒绝了当前 API Key，请更新凭据后重试'
    });
  });
});
