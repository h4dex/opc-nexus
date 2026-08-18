import { describe, expect, it } from 'vitest';
import { validatePluginManifest } from '../src/main/services/pluginHost.js';
import { OPC_NEXUS_GOVERNANCE_PLUGIN_MANIFEST } from '../src/main/services/opcNexusGovernancePlugin.js';

describe('opc-nexus-governance plugin identity', () => {
  it('is a valid DSH host declaration owned by governance', () => {
    const manifest = validatePluginManifest(OPC_NEXUS_GOVERNANCE_PLUGIN_MANIFEST);
    expect(manifest.id).toBe('opc-nexus-governance');
    expect(manifest.owner).toBe('nexus-governance');
    expect(manifest.capabilities.map((capability) => capability.id)).toEqual([
      'dsh-quest-governance',
      'project-workbench',
      'worker-directory',
      'policy-evaluate',
      'approval-audit-projection',
      'provider-credential-lease',
      'artifact-admission',
      'memory-archive',
      'runtime-environment',
      'channel-projection',
      'lan-mobile-gateway',
      'acp-worker-boundary',
      'a2a-worker-boundary'
    ]);
    expect(manifest.capabilities.some((capability) => /planner|secretary|session-owner/.test(capability.id))).toBe(false);
    expect(manifest.capabilities.filter((capability) => capability.kind === 'a2a')).toEqual([
      expect.objectContaining({ id: 'acp-worker-boundary', protocol: 'acp', executionAdapter: 'acp' }),
      expect.objectContaining({ id: 'a2a-worker-boundary', protocol: 'a2a', executionAdapter: 'a2a' })
    ]);
    expect(JSON.stringify(manifest)).not.toContain('secret.read');
  });
});
