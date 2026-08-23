import { describe, expect, it, vi } from 'vitest';
import {
  CapabilityRegistry,
  PLUGIN_HOST_API_VERSION,
  PluginHost,
  PluginHostError,
  satisfiesPluginHostVersion,
  validatePluginManifest
} from '../src/main/services/pluginHost.js';

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: 'com.example.image-tools',
    name: 'Image tools',
    version: '1.2.0',
    hostApiVersion: '^1.0.0',
    capabilities: [{
      id: 'vision.describe',
      kind: 'tool',
      version: '1.0.0',
      permissions: ['artifact.read']
    }],
    permissions: ['artifact.read'],
    ...overrides
  };
}

describe('plugin manifest validation', () => {
  it('normalizes and freezes a valid declaration', () => {
    const value = validatePluginManifest(manifest());
    expect(value.id).toBe('com.example.image-tools');
    expect(value.owner).toBe('nexus-governance');
    expect(value.capabilities[0]?.owner).toBe('nexus-governance');
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.capabilities)).toBe(true);
    expect(satisfiesPluginHostVersion(PLUGIN_HOST_API_VERSION, '^1.0.0')).toBe(true);
    expect(satisfiesPluginHostVersion('2.0.0', '^1.0.0')).toBe(false);
  });

  it('rejects malformed versions, duplicate capabilities, unknown permissions, and secret ownership', () => {
    expect(() => validatePluginManifest(manifest({ version: '1.2' }))).toThrow(PluginHostError);
    expect(() => validatePluginManifest(manifest({
      capabilities: [
        { id: 'same', kind: 'skill', version: '1.0.0' },
        { id: 'same', kind: 'artifact', version: '1.0.0' }
      ]
    }))).toThrow(/Duplicate capability/);
    expect(() => validatePluginManifest(manifest({ permissions: ['unknown.use'] }))).toThrow(/Unknown plugin permission/);
    expect(() => validatePluginManifest(manifest({ permissions: ['secret.read'] }))).toThrow(/cannot claim/);
  });

  it('rejects a host range mismatch and undeclared capability permissions', () => {
    expect(() => validatePluginManifest(manifest({ hostApiVersion: '^2.0.0' }))).toThrow(PluginHostError);
    expect(() => validatePluginManifest(manifest({
      permissions: [],
      capabilities: [{ id: 'x', kind: 'skill', version: '1.0.0', permissions: ['skill.read'] }]
    }))).toThrow(/undeclared permission/);
  });

  it('requires explicit governance ownership and rejects secretary ownership', () => {
    const governance = validatePluginManifest(manifest({
      owner: 'nexus-governance',
      capabilities: [{ id: 'policy', kind: 'tool', version: '1.0.0', owner: 'nexus-governance' }]
    }));
    expect(governance.owner).toBe('nexus-governance');
    expect(governance.capabilities[0]?.owner).toBe('nexus-governance');
    expect(() => validatePluginManifest(manifest({ owner: 'nexus-secretary' }))).toThrow(/must be nexus-governance/);
  });

  it('normalizes execution adapters without granting them orchestration ownership', () => {
    const value = validatePluginManifest(manifest({
      executionAdapter: 'hermes-cli',
      capabilities: [{ id: 'worker', kind: 'engine', version: '1.0.0' }]
    }));
    expect(value.owner).toBe('nexus-governance');
    expect(value.executionAdapter).toBe('hermes-cli');
    expect(value.capabilities[0]?.executionAdapter).toBe('hermes-cli');
    expect(() => validatePluginManifest(manifest({ executionAdapter: 'nexus-secretary' }))).toThrow(/supported execution adapter/);
  });
});

describe('CapabilityRegistry', () => {
  it('registers, filters, disables, replaces, and removes without cross-plugin collisions', () => {
    const now = vi.fn(() => 1234);
    const registry = new CapabilityRegistry({ now });
    const first = registry.register(manifest());
    expect(first.enabled).toBe(true);
    expect(registry.listCapabilities({ kind: 'tool' })).toHaveLength(1);
    expect(() => registry.register(manifest())).toThrow(/already registered/);

    registry.register(manifest({ id: 'com.example.channel', capabilities: [{ id: 'vision.describe', kind: 'channel', version: '1.0.0' }] }));
    expect(registry.listCapabilities()).toHaveLength(2);
    registry.setEnabled('com.example.channel', false);
    expect(registry.listCapabilities()).toHaveLength(1);
    expect(registry.listCapabilities({ enabledOnly: false })).toHaveLength(2);

    const replacement = registry.replace('com.example.image-tools', manifest({ version: '1.3.0', capabilities: [{ id: 'vision.describe', kind: 'tool', version: '1.1.0' }] }));
    expect(replacement.manifest.version).toBe('1.3.0');
    expect(registry.unregister('com.example.channel')).toBe(true);
    expect(registry.unregister('missing')).toBe(false);
  });
});

describe('PluginHost', () => {
  it('requires explicit handler attachment and checks every declared permission', async () => {
    const registry = new CapabilityRegistry();
    registry.register(manifest());
    const authorize = vi.fn(async ({ permission }: { permission: string }) => permission === 'artifact.read');
    const host = new PluginHost(registry, authorize);
    expect(() => host.attach('missing', {})).toThrow(/not found/);
    const handler = vi.fn(async (input: unknown, context: { capabilityKind: string; owner: string; executionAdapter?: string }) => ({
      input,
      kind: context.capabilityKind,
      owner: context.owner,
      adapter: context.executionAdapter
    }));
    const binding = host.attach('com.example.image-tools', { 'vision.describe': handler });
    expect(host.isAttached('com.example.image-tools')).toBe(true);
    expect(host.isAttached('com.example.image-tools', 'vision.describe')).toBe(true);
    await expect(host.invoke({ pluginId: 'com.example.image-tools', capabilityId: 'vision.describe', input: { id: 1 } }))
      .resolves.toEqual({ input: { id: 1 }, kind: 'tool', owner: 'nexus-governance', adapter: undefined });
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ permission: 'artifact.read', owner: 'nexus-governance' }), expect.any(AbortSignal));
    expect(handler).toHaveBeenCalledTimes(1);
    binding.detach();
    expect(host.isAttached('com.example.image-tools')).toBe(false);
    await expect(host.invoke({ pluginId: 'com.example.image-tools', capabilityId: 'vision.describe' })).rejects.toMatchObject({ code: 'HANDLER_NOT_FOUND' });
  });

  it('fails closed when a permission resolver is missing, denies, or throws', async () => {
    const registry = new CapabilityRegistry();
    registry.register(manifest());
    const handler = vi.fn(() => 'should not run');
    const noPolicy = new PluginHost(registry);
    noPolicy.attach('com.example.image-tools', { 'vision.describe': handler });
    await expect(noPolicy.invoke({ pluginId: 'com.example.image-tools', capabilityId: 'vision.describe' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(handler).not.toHaveBeenCalled();

    const denied = new PluginHost(registry, async () => false);
    denied.attach('com.example.image-tools', { 'vision.describe': handler });
    await expect(denied.invoke({ pluginId: 'com.example.image-tools', capabilityId: 'vision.describe' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    const throws = new PluginHost(registry, async () => { throw new Error('policy unavailable'); });
    throws.attach('com.example.image-tools', { 'vision.describe': handler });
    await expect(throws.invoke({ pluginId: 'com.example.image-tools', capabilityId: 'vision.describe' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('keeps disabled plugins and aborted calls out of handlers, and wraps handler failures', async () => {
    const registry = new CapabilityRegistry();
    registry.register(manifest({ permissions: [], capabilities: [{ id: 'safe', kind: 'skill', version: '1.0.0' }] }));
    const host = new PluginHost(registry);
    const handler = vi.fn(async () => { throw new Error('plugin boom'); });
    host.attach('com.example.image-tools', { safe: handler });
    registry.setEnabled('com.example.image-tools', false);
    await expect(host.invoke({ pluginId: 'com.example.image-tools', capabilityId: 'safe' })).rejects.toMatchObject({ code: 'PLUGIN_DISABLED' });
    registry.setEnabled('com.example.image-tools', true);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(host.invoke({ pluginId: 'com.example.image-tools', capabilityId: 'safe', signal: controller.signal })).rejects.toThrow('cancelled');
    await expect(host.invoke({ pluginId: 'com.example.image-tools', capabilityId: 'safe' })).rejects.toMatchObject({ code: 'HANDLER_FAILED' });
  });
});
