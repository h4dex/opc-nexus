import type { PluginManifest } from './pluginHost.js';

/**
 * Declarative identity of this application when mounted in DSH/Cordis.
 *
 * The manifest advertises host-side governance capabilities only. It has no
 * planner, session owner, or arbitrary command handler; DSH/Cordis remains
 * the single AI/orchestration owner.
 */
export const OPC_NEXUS_GOVERNANCE_PLUGIN_ID = 'opc-nexus-governance' as const;
export const DSH_QUEST_GOVERNANCE_CAPABILITY_ID = 'dsh-quest-governance' as const;

export const OPC_NEXUS_GOVERNANCE_PLUGIN_MANIFEST: PluginManifest = {
  schemaVersion: 1,
  id: OPC_NEXUS_GOVERNANCE_PLUGIN_ID,
  name: 'OPC Nexus Governance',
  version: '2.0.0',
  owner: 'nexus-governance',
  executionAdapter: 'dsh-managed',
  hostApiVersion: '^1.0.0',
  description: 'Host governance, project projection and worker boundaries for the DSH/Cordis product core.',
  capabilities: [
    {
      id: DSH_QUEST_GOVERNANCE_CAPABILITY_ID,
      kind: 'artifact',
      version: '1.0.0',
      owner: 'nexus-governance',
      executionAdapter: 'dsh-managed',
      artifactKind: 'dsh-quest-governance',
      mediaTypes: ['application/json'],
      permissions: ['artifact.read', 'artifact.write'],
      description: 'Typed admission for Cordis-owned QuestionSets and Plans; owner decisions are intentionally excluded.'
    },
    {
      id: 'project-workbench',
      kind: 'artifact',
      version: '1.0.0',
      owner: 'nexus-governance',
      executionAdapter: 'dsh-managed',
      artifactKind: 'project-workbench',
      mediaTypes: ['application/json', 'text/markdown'],
      permissions: ['artifact.read', 'artifact.write']
    },
    {
      id: 'worker-directory',
      kind: 'artifact',
      version: '1.0.0',
      owner: 'nexus-governance',
      artifactKind: 'worker-directory',
      mediaTypes: ['application/json'],
      permissions: ['artifact.read'],
      description: 'Read-only fixed digital employee and approved external worker projection.'
    },
    {
      id: 'policy-evaluate',
      kind: 'tool',
      version: '1.0.0',
      owner: 'nexus-governance',
      executionAdapter: 'dsh-managed',
      toolName: 'governance.policy.evaluate',
      risk: 'safe',
      permissions: ['tool.execute']
    },
    {
      id: 'approval-audit-projection',
      kind: 'artifact',
      version: '1.0.0',
      owner: 'nexus-governance',
      artifactKind: 'approval-audit-projection',
      mediaTypes: ['application/json'],
      permissions: ['artifact.read'],
      description: 'Redacted approval and audit evidence; the plugin cannot write the authoritative audit log.'
    },
    {
      id: 'provider-credential-lease',
      kind: 'tool',
      version: '1.0.0',
      owner: 'nexus-governance',
      toolName: 'governance.provider.issue-lease',
      risk: 'write',
      permissions: ['tool.execute', 'engine.use', 'network.request'],
      description: 'Issues bounded provider leases without returning credentials to DSH or Renderer.'
    },
    {
      id: 'artifact-admission',
      kind: 'artifact',
      version: '1.0.0',
      owner: 'nexus-governance',
      artifactKind: 'artifact-admission',
      mediaTypes: ['application/json'],
      permissions: ['artifact.read', 'artifact.write'],
      description: 'Validates content identity, media policy and project ownership before artifact projection.'
    },
    {
      id: 'memory-archive',
      kind: 'artifact',
      version: '1.0.0',
      owner: 'nexus-governance',
      executionAdapter: 'dsh-managed',
      artifactKind: 'memory-archive',
      mediaTypes: ['application/json', 'text/markdown'],
      permissions: ['artifact.read', 'artifact.write']
    },
    {
      id: 'runtime-environment',
      kind: 'tool',
      version: '1.0.0',
      owner: 'nexus-governance',
      toolName: 'governance.runtime.inspect',
      risk: 'safe',
      permissions: ['tool.execute'],
      description: 'Reports managed runtime, CLI and isolated native-worker readiness without planning work.'
    },
    {
      id: 'channel-projection',
      kind: 'channel',
      version: '1.0.0',
      owner: 'nexus-governance',
      executionAdapter: 'dsh-managed',
      channelType: 'governed-channel',
      direction: 'bidirectional',
      permissions: ['channel.receive', 'channel.send']
    },
    {
      id: 'lan-mobile-gateway',
      kind: 'channel',
      version: '1.0.0',
      owner: 'nexus-governance',
      executionAdapter: 'dsh-managed',
      channelType: 'dsh-lan-mobile',
      direction: 'bidirectional',
      permissions: ['channel.receive', 'channel.send'],
      description: 'Authenticated desktop, LAN and mobile projection for DSH/Cordis.'
    },
    {
      id: 'acp-worker-boundary',
      kind: 'a2a',
      version: '1.0.0',
      owner: 'nexus-governance',
      executionAdapter: 'acp',
      protocol: 'acp',
      operations: ['authorize', 'invoke', 'status', 'cancel'],
      permissions: ['a2a.invoke'],
      description: 'ACP worker policy boundary'
    },
    {
      id: 'a2a-worker-boundary',
      kind: 'a2a',
      version: '1.0.0',
      owner: 'nexus-governance',
      executionAdapter: 'a2a',
      protocol: 'a2a',
      operations: ['authorize', 'invoke', 'status', 'cancel'],
      permissions: ['a2a.invoke'],
      description: 'A2A worker policy boundary'
    }
  ]
};
