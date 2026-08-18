import type { Database } from './database.js';
import { readEngineRuntimeConfig, requiredProviderProtocol } from './engineEnv.js';
import { DSH_MANAGED_ENGINE_ID } from '../../shared/types.js';
import type { ProviderCredentialResolution } from './providerCredentialProxy.js';
import type { ProviderManager } from './providerManager.js';
import type { DshRuntimeEnvironmentContext } from './dshSupervisor.js';

export interface DshProviderBinding {
  organizationId: string;
  providerId: string;
  model: string;
}

/** Resolve a managed DSH route without exposing its Provider credential. */
export function resolveDshProviderBinding(
  db: Database,
  providers: ProviderManager,
  context: Pick<DshRuntimeEnvironmentContext, 'agentId'>
): DshProviderBinding | null {
  const agent = db.raw.prepare(
    'SELECT organization_id, provider_id, model_override, archived FROM agents WHERE id = ?'
  ).get(context.agentId) as {
    organization_id?: string | null;
    provider_id?: string | null;
    model_override?: string | null;
    archived?: number;
  } | undefined;
  if (!agent || agent.archived === 1) return null;

  let engineConfig: ReturnType<typeof readEngineRuntimeConfig> = null;
  try {
    engineConfig = readEngineRuntimeConfig(db, DSH_MANAGED_ENGINE_ID);
  } catch {
    return null;
  }
  const protocol = engineConfig?.protocol ?? requiredProviderProtocol(DSH_MANAGED_ENGINE_ID);
  if (protocol !== 'openai-chat') return null;

  const providerId = agent.provider_id?.trim() || engineConfig?.providerId || null;
  const modelOverride = agent.model_override?.trim() || engineConfig?.modelOverride || null;
  const resolved = providers.resolveForAgentWithIdentity(providerId, modelOverride);
  if (!resolved) return null;
  return {
    organizationId: agent.organization_id?.trim() || 'org-local',
    providerId: resolved.providerId,
    model: resolved.model
  };
}

export function resolveDshProviderCredential(
  providers: ProviderManager,
  binding: Pick<DshProviderBinding, 'providerId' | 'model'>
): ProviderCredentialResolution | null {
  const resolved = providers.resolveForAgentWithIdentity(binding.providerId, binding.model);
  if (!resolved || resolved.providerId !== binding.providerId || resolved.model !== binding.model) return null;
  return {
    providerId: resolved.providerId,
    model: resolved.model,
    baseUrl: resolved.baseUrl,
    apiKey: resolved.key
  };
}
