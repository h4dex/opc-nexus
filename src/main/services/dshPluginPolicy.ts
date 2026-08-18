import { randomUUID } from 'node:crypto';
import type {
  PluginInvocationPolicyContext,
  PluginPermissionRequest,
  PluginPermissionResolver
} from './pluginHost.js';
import {
  DshPolicyBroker,
  type DshPolicyCapability,
  type DshPolicyRequest,
  type DshPolicyResolution
} from './dshPolicyBroker.js';
import {
  VISION_OCR_TOOL_CAPABILITY_ID,
  VISION_PLUGIN_ID,
  VISION_TOOL_CAPABILITY_ID
} from './visionService.js';
import {
  DSH_QUEST_GOVERNANCE_CAPABILITY_ID,
  OPC_NEXUS_GOVERNANCE_PLUGIN_ID
} from './opcNexusGovernancePlugin.js';

const PERMISSION_CAPABILITIES: Readonly<Record<string, DshPolicyCapability>> = Object.freeze({
  'artifact.read': 'fs.read',
  'artifact.write': 'artifact.publish',
  'engine.use': 'secret.use',
  'tool.execute': 'delegate',
  'skill.read': 'fs.read',
  'channel.receive': 'external_message',
  'channel.send': 'external_message',
  'a2a.invoke': 'delegate',
  'network.request': 'network.fetch',
  'filesystem.read': 'fs.read',
  'filesystem.write': 'fs.write',
  'process.exec': 'process.exec'
});

const VISION_PERMISSIONS = new Set(['artifact.read', 'engine.use', 'network.request']);
const VISION_OCR_PERMISSIONS = new Set(['artifact.read']);
const QUEST_ADMISSION_PERMISSIONS = new Set(['artifact.read', 'artifact.write']);

export type DshPluginPolicyAuthorityResolver = (
  request: Readonly<PluginPermissionRequest>
) => Readonly<PluginInvocationPolicyContext> | null | Promise<Readonly<PluginInvocationPolicyContext> | null>;

export interface DshPluginPermissionPolicyOptions {
  resolveAuthority?: DshPluginPolicyAuthorityResolver;
}

export function pluginPermissionCapability(permission: string): DshPolicyCapability | null {
  return PERMISSION_CAPABILITIES[permission] ?? null;
}

/**
 * Adapt PluginHost's manifest permissions to the authoritative DSH policy
 * vocabulary. Missing caller identity and non-allow decisions are denied.
 */
export function createDshPluginPermissionResolver(
  broker: DshPolicyBroker,
  options: DshPluginPermissionPolicyOptions = {}
): PluginPermissionResolver {
  return async (request) => {
    const capability = pluginPermissionCapability(request.permission);
    if (!capability) return false;
    let authority = request.policyContext ?? null;
    if (!authority && options.resolveAuthority) {
      try { authority = await options.resolveAuthority(request); } catch { authority = null; }
    }
    if (!authority) {
      await broker.decide({
        requestId: randomUUID(),
        organizationId: 'unknown',
        runtimeId: 'unknown',
        agentId: 'unknown',
        capability,
        target: `plugin:${request.pluginId}/${request.capabilityId}`,
        operation: 'plugin.permission',
        context: {
          boundary: 'plugin-host-untrusted',
          pluginId: request.pluginId,
          capabilityId: request.capabilityId,
          permission: request.permission
        }
      });
      return false;
    }
    const decision = await broker.decide({
      requestId: authority.requestId,
      organizationId: authority.organizationId,
      runtimeId: authority.runtimeId,
      agentId: authority.agentId,
      capability,
      target: authority.target,
      operation: authority.operation ?? 'plugin.permission',
      ...(authority.sessionId === undefined ? {} : { sessionId: authority.sessionId }),
      ...(authority.taskId === undefined ? {} : { taskId: authority.taskId }),
      context: {
        boundary: 'plugin-host',
        pluginId: request.pluginId,
        pluginVersion: request.pluginVersion,
        pluginOwner: request.owner,
        capabilityId: request.capabilityId,
        capabilityKind: request.capabilityKind,
        permission: request.permission,
        ...(request.executionAdapter === undefined ? {} : { executionAdapter: request.executionAdapter })
      }
    });
    return decision.effect === 'allow';
  };
}

function contextRecord(request: Readonly<DshPolicyRequest>): Readonly<Record<string, unknown>> {
  return request.context ?? {};
}

/**
 * Built-in host policy. It grants only actions whose trust evidence is added
 * by a Main-owned adapter; unrecognized DSH/plugin input remains denied.
 */
export function resolveBuiltinDshHostPolicy(
  request: Readonly<DshPolicyRequest>
): DshPolicyResolution {
  const context = contextRecord(request);
  switch (context.boundary) {
    case 'plugin-host': {
      const permission = typeof context.permission === 'string' ? context.permission : '';
      const expected = pluginPermissionCapability(permission);
      if (expected !== request.capability) break;
      if (context.pluginId === VISION_PLUGIN_ID
        && context.pluginOwner === 'dsh-cordis'
        && ((context.capabilityId === VISION_TOOL_CAPABILITY_ID && VISION_PERMISSIONS.has(permission))
          || (context.capabilityId === VISION_OCR_TOOL_CAPABILITY_ID && VISION_OCR_PERMISSIONS.has(permission)))) {
        return { effect: 'allow', reasonCode: 'builtin_vision_capability' };
      }
      if (context.pluginId === OPC_NEXUS_GOVERNANCE_PLUGIN_ID
        && context.pluginOwner === 'nexus-governance'
        && context.capabilityId === DSH_QUEST_GOVERNANCE_CAPABILITY_ID
        && QUEST_ADMISSION_PERMISSIONS.has(permission)) {
        return { effect: 'allow', reasonCode: 'quest_admission_capability' };
      }
      break;
    }
    case 'provider-credential-proxy':
      if (context.providerBound === true
        && (request.capability === 'secret.use' || request.capability === 'network.fetch')) {
        return { effect: 'allow', reasonCode: 'bounded_provider_lease' };
      }
      break;
    case 'community-plugin-install':
      if (context.principalConfirmed === true && context.curated === true
        && (request.capability === 'package.install'
          || request.capability === 'process.exec'
          || request.capability === 'fs.write')) {
        return { effect: 'allow', reasonCode: 'confirmed_curated_install' };
      }
      break;
    case 'native-adapter':
      if (context.registered === true && request.capability === 'process.exec') {
        return { effect: 'allow', reasonCode: 'registered_native_adapter' };
      }
      break;
    case 'quest-owner-response':
      if (context.principalBound === true && typeof context.principalId === 'string'
        && (request.capability === 'fs.read'
          || request.capability === 'fs.write'
          || request.capability === 'external_message')) {
        return { effect: 'allow', reasonCode: 'bound_quest_owner_response' };
      }
      break;
    default:
      break;
  }
  return { effect: 'deny', reasonCode: 'host_action_denied' };
}
