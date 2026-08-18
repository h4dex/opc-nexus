import type { Database } from './database.js';
import { readEngineRuntimeConfig } from './engineEnv.js';
import { resolveDshProviderBinding } from './dshProviderBinding.js';
import type { ProviderManager } from './providerManager.js';
import {
  DSH_MANAGED_ENGINE_ID,
  type QuestProviderPreflightCode,
  type QuestProviderPreflightView
} from '../../shared/types.js';

export interface QuestProviderPreflightOptions {
  now?: () => number;
}

/** Probes the actual managed-Cordis Provider route without exposing credentials or endpoints. */
export class QuestProviderPreflightService {
  private readonly now: () => number;

  constructor(
    private readonly db: Database,
    private readonly providers: ProviderManager,
    options: QuestProviderPreflightOptions = {}
  ) {
    this.now = options.now ?? Date.now;
  }

  async probe(agentId: string): Promise<QuestProviderPreflightView> {
    const catalog = this.providers.list();
    const agent = this.db.raw.prepare(
      'SELECT provider_id, model_override FROM agents WHERE id = ?'
    ).get(agentId) as { provider_id?: string | null; model_override?: string | null } | undefined;
    const engine = readEngineRuntimeConfig(this.db, DSH_MANAGED_ENGINE_ID);
    const configuredProviderId = agent?.provider_id?.trim()
      || engine?.providerId
      || catalog.find((provider) => provider.isDefault)?.id
      || catalog[0]?.id
      || null;
    const configured = configuredProviderId
      ? catalog.find((provider) => provider.id === configuredProviderId) ?? null
      : null;
    const binding = resolveDshProviderBinding(this.db, this.providers, { agentId });

    if (!binding) {
      if (!configured) {
        return this.result('NOT_CONFIGURED', null, null, null, 0, '尚未配置模型 Provider');
      }
      if (!configured.hasKey) {
        return this.result(
          'CREDENTIAL_MISSING', configured.id, configured.name,
          agent?.model_override?.trim() || engine?.modelOverride || configured.model,
          0, '模型 Provider 尚未配置 API Key'
        );
      }
      return this.result(
        'CONFIGURATION_INVALID', configured.id, configured.name,
        agent?.model_override?.trim() || engine?.modelOverride || configured.model,
        0, 'DSH / Cordis 的模型绑定无效，请重新选择 Provider 和模型'
      );
    }

    const provider = catalog.find((item) => item.id === binding.providerId) ?? null;
    const verification = await this.providers.testById(binding.providerId);
    if (verification.ok) {
      return this.result(
        'READY', binding.providerId, provider?.name ?? binding.providerId,
        binding.model, verification.latencyMs, null
      );
    }
    const rejected = /\b(?:401|403)\b/.test(verification.error ?? '');
    return this.result(
      rejected ? 'CREDENTIAL_REJECTED' : 'CONNECTION_FAILED',
      binding.providerId,
      provider?.name ?? binding.providerId,
      binding.model,
      verification.latencyMs,
      rejected
        ? '模型 Provider 拒绝了当前 API Key，请更新凭据后重试'
        : `模型 Provider 连接失败：${verification.error ?? '未知错误'}`
    );
  }

  private result(
    code: QuestProviderPreflightCode,
    providerId: string | null,
    providerName: string | null,
    model: string | null,
    latencyMs: number,
    error: string | null
  ): QuestProviderPreflightView {
    return {
      ready: code === 'READY',
      code,
      providerId,
      providerName,
      model,
      latencyMs,
      error,
      checkedAt: this.now()
    };
  }
}
