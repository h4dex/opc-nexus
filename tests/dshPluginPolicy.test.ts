import { describe, expect, it, vi } from 'vitest';
import { DshPolicyBroker, type DshPolicyAuditEvent } from '../src/main/services/dshPolicyBroker.js';
import {
  createDshPluginPermissionResolver,
  pluginPermissionCapability,
  resolveBuiltinDshHostPolicy
} from '../src/main/services/dshPluginPolicy.js';
import { CapabilityRegistry, PluginHost } from '../src/main/services/pluginHost.js';

function visionRegistry() {
  const registry = new CapabilityRegistry();
  registry.register({
    schemaVersion: 1,
    id: 'opc.dsh.vision',
    name: 'Vision',
    version: '1.0.0',
    owner: 'dsh-cordis',
    permissions: ['artifact.read', 'engine.use', 'network.request'],
    capabilities: [{
      id: 'vision.describe',
      kind: 'tool',
      version: '1.0.0',
      permissions: ['artifact.read', 'engine.use', 'network.request']
    }, {
      id: 'vision.ocr',
      kind: 'tool',
      version: '1.0.0',
      permissions: ['artifact.read']
    }]
  });
  return registry;
}

describe('DSH PluginHost policy wiring', () => {
  it('maps every host permission into the narrow DSH capability vocabulary', () => {
    expect(pluginPermissionCapability('artifact.read')).toBe('fs.read');
    expect(pluginPermissionCapability('artifact.write')).toBe('artifact.publish');
    expect(pluginPermissionCapability('engine.use')).toBe('secret.use');
    expect(pluginPermissionCapability('network.request')).toBe('network.fetch');
    expect(pluginPermissionCapability('process.exec')).toBe('process.exec');
    expect(pluginPermissionCapability('secret.read')).toBeNull();
  });

  it('decides and audits every declared permission before invoking a handler', async () => {
    const audits: DshPolicyAuditEvent[] = [];
    const broker = new DshPolicyBroker({
      resolve: resolveBuiltinDshHostPolicy,
      audit: (event) => audits.push(event)
    });
    const host = new PluginHost(visionRegistry(), createDshPluginPermissionResolver(broker));
    const handler = vi.fn(async () => ({ ok: true }));
    host.attach('opc.dsh.vision', { 'vision.describe': handler });
    await expect(host.invoke({
      pluginId: 'opc.dsh.vision',
      capabilityId: 'vision.describe',
      input: { attachmentRef: { id: 'artifact-1' } },
      policyContext: {
        requestId: 'vision-request-1',
        organizationId: 'org-local',
        runtimeId: 'desktop-local',
        agentId: 'principal-local-admin',
        target: 'plugin:opc.dsh.vision/vision.describe'
      }
    })).resolves.toEqual({ ok: true });
    expect(handler).toHaveBeenCalledOnce();
    expect(audits.map((event) => [event.capability, event.result, event.reasonCode])).toEqual([
      ['fs.read', 'allow', 'builtin_vision_capability'],
      ['secret.use', 'allow', 'builtin_vision_capability'],
      ['network.fetch', 'allow', 'builtin_vision_capability']
    ]);
  });

  it('audits a fail-closed decision when authenticated invocation identity is missing', async () => {
    const audits: DshPolicyAuditEvent[] = [];
    const broker = new DshPolicyBroker({
      resolve: resolveBuiltinDshHostPolicy,
      audit: (event) => audits.push(event)
    });
    const handler = vi.fn();
    const host = new PluginHost(visionRegistry(), createDshPluginPermissionResolver(broker));
    host.attach('opc.dsh.vision', { 'vision.describe': handler });
    await expect(host.invoke({ pluginId: 'opc.dsh.vision', capabilityId: 'vision.describe' }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(handler).not.toHaveBeenCalled();
    expect(audits).toEqual([expect.objectContaining({
      capability: 'fs.read', result: 'deny', reasonCode: 'host_action_denied',
      organizationId: 'unknown', runtimeId: 'unknown', agentId: 'unknown'
    })]);
  });

  it('admits local OCR only for the attachment read capability', async () => {
    const audits: DshPolicyAuditEvent[] = [];
    const broker = new DshPolicyBroker({
      resolve: resolveBuiltinDshHostPolicy,
      audit: (event) => audits.push(event)
    });
    const handler = vi.fn(async () => ({ ok: true, text: 'hello' }));
    const host = new PluginHost(visionRegistry(), createDshPluginPermissionResolver(broker));
    host.attach('opc.dsh.vision', { 'vision.ocr': handler });

    await expect(host.invoke({
      pluginId: 'opc.dsh.vision',
      capabilityId: 'vision.ocr',
      input: { attachmentRef: { id: 'artifact-1' } },
      policyContext: {
        requestId: 'ocr-request-1',
        organizationId: 'org-local',
        runtimeId: 'desktop-local',
        agentId: 'principal-local-admin',
        target: 'plugin:opc.dsh.vision/vision.ocr'
      }
    })).resolves.toMatchObject({ ok: true, text: 'hello' });
    expect(audits.map((event) => [event.capability, event.result])).toEqual([['fs.read', 'allow']]);
  });

  it('keeps owner responses on an explicit principal-bound audited policy boundary', async () => {
    const audits: DshPolicyAuditEvent[] = [];
    const broker = new DshPolicyBroker({
      resolve: resolveBuiltinDshHostPolicy,
      audit: (event) => audits.push(event)
    });
    const policy = broker.scopeRuntime({
      organizationId: 'org-local', runtimeId: 'runtime-quest', agentId: 'agent-cordis'
    });
    for (const capability of ['fs.read', 'fs.write', 'external_message'] as const) {
      await expect(policy.decide({
        requestId: `owner-${capability}`,
        capability,
        target: 'quest:quest-1',
        operation: 'dsh.quest.owner.respond',
        sessionId: 'session-1',
        context: {
          boundary: 'quest-owner-response',
          principalBound: true,
          principalId: 'principal-owner'
        }
      })).resolves.toMatchObject({ effect: 'allow', reasonCode: 'bound_quest_owner_response' });
    }
    expect(audits.map((event) => [event.capability, event.result, event.reasonCode])).toEqual([
      ['fs.read', 'allow', 'bound_quest_owner_response'],
      ['fs.write', 'allow', 'bound_quest_owner_response'],
      ['external_message', 'allow', 'bound_quest_owner_response']
    ]);
    await expect(policy.decide({
      requestId: 'owner-unbound',
      capability: 'external_message',
      target: 'quest:quest-1',
      context: { boundary: 'quest-owner-response', principalBound: false }
    })).resolves.toMatchObject({ effect: 'deny', reasonCode: 'host_action_denied' });
  });
});
