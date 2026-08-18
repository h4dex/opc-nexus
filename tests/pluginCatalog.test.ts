import { describe, expect, it } from 'vitest';
import { CapabilityRegistry, PluginHost } from '../src/main/services/pluginHost.js';
import { PluginCatalogService } from '../src/main/services/pluginCatalog.js';
import { OPC_NEXUS_GOVERNANCE_PLUGIN_MANIFEST } from '../src/main/services/opcNexusGovernancePlugin.js';

describe('PluginCatalogService', () => {
  it('aggregates host, DSH, MCP and Skill sources without exposing legacy payloads', () => {
    const registry = new CapabilityRegistry({ now: () => 100 });
    registry.register({
      schemaVersion: 1,
      id: 'test-host-plugin',
      name: 'Test host plugin',
      version: '1.0.0',
      owner: 'dsh-cordis',
      capabilities: [{
        id: 'describe',
        kind: 'tool',
        version: '1.0.0',
        permissions: ['artifact.read']
      }]
    });

    const catalog = new PluginCatalogService({
      registry,
      now: () => 200,
      dsh: {
        getCatalog: () => ({
          available: true,
          scannedAt: 199,
          runtime: { packageName: '@deepseek-ai/dsh', expectedVersion: '1.0.0', installedVersion: '1.0.0', integrityVerified: true },
          policy: { valid: true, relativePath: 'policy.patch', sha256: 'abc', requiredTokenCount: 1, matchedTokenCount: 1 },
          packages: [{
            name: '@deepseek-ai/dsh-web', version: '1.0.0', categories: ['web'], safety: 'trusted',
            enablement: 'enabled', installed: true, reviewed: true, reasonCodes: []
          }],
          counts: { enabled: 1, disabled: 0, blocked: 0, missing: 0 },
          warnings: []
        })
      } as never,
      mcp: {
        list: () => [{
          id: 'mcp-1', name: 'Browser server', command: 'secret-command', args: ['--token', 'hidden'],
          env: { API_KEY: '***' }, enabled: true, scope: 'global', capability: 'browser', running: false, hasSecrets: true
        }]
      },
      skills: {
        list: () => [{
          id: 'skill-custom', name: 'Private skill', description: 'summary', content: 'PRIVATE SKILL BODY',
          enabled: true, createdAt: 123
        }]
      }
    });

    const view = catalog.getCatalog();
    expect(view.scannedAt).toBe(200);
    expect(view.sourceCounts).toEqual({ host: 1, dsh: 1, mcp: 1, skill: 1, cli: 0, acp: 0, a2a: 0 });
    expect(view.counts.degraded).toBe(1);
    expect(view.items.map((item) => item.source)).toEqual(['dsh', 'host', 'mcp', 'skill']);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('secret-command');
    expect(serialized).not.toContain('PRIVATE SKILL BODY');
    expect(serialized).not.toContain('--token');
    const mcp = view.items.find((item) => item.source === 'mcp');
    expect(mcp?.reasonCodes).toContain('NOT_RUNNING');
    expect(mcp?.permissions).toEqual(['process.exec']);
    expect(view.items.find((item) => item.source === 'dsh')?.lifecycle).toBe('live');
    expect(view.items.find((item) => item.source === 'host')?.lifecycle).toBe('installed');
  });

  it('keeps a broken source bounded and reports a warning', () => {
    const view = new PluginCatalogService({
      dsh: { getCatalog: () => { throw new Error('fixture failed'); } } as never,
      now: () => 1
    }).getCatalog();
    expect(view.items).toHaveLength(0);
    expect(view.warnings.some((warning) => warning.startsWith('DSH_CATALOG_ERROR:'))).toBe(true);
    expect(view.dsh).toBeNull();
  });

  it('marks only explicitly attached host capabilities live', async () => {
    const registry = new CapabilityRegistry();
    registry.register({
      schemaVersion: 1, id: 'attached', name: 'Attached', version: '1.0.0', owner: 'dsh-cordis',
      capabilities: [{ id: 'run', kind: 'tool', version: '1.0.0' }]
    });
    registry.register({
      schemaVersion: 1, id: 'unknown-package', name: 'Unknown', version: '1.0.0', owner: 'dsh-cordis',
      capabilities: [{ id: 'run', kind: 'tool', version: '1.0.0' }]
    });
    registry.register({
      schemaVersion: 1, id: 'partial', name: 'Partial', version: '1.0.0', owner: 'nexus-governance',
      capabilities: [
        { id: 'project', kind: 'artifact', version: '1.0.0' },
        { id: 'audit', kind: 'artifact', version: '1.0.0' }
      ]
    });
    const host = new PluginHost(registry);
    host.attach('attached', { run: async () => ({ ok: true }) });
    host.attach('partial', { project: async () => ({ ok: true }) });
    const items = new PluginCatalogService({ registry, host }).getCatalog().items;
    expect(items.find((item) => item.id === 'host:attached')?.lifecycle).toBe('live');
    expect(items.find((item) => item.id === 'host:partial')).toMatchObject({
      status: 'degraded', lifecycle: 'review', configured: false,
      reasonCodes: ['PARTIAL_CAPABILITY_BINDING']
    });
    expect(items.find((item) => item.id === 'host:unknown-package')).toMatchObject({
      lifecycle: 'installed', enabled: true
    });
    await expect(host.invoke({ pluginId: 'unknown-package', capabilityId: 'run' })).rejects.toMatchObject({ code: 'HANDLER_NOT_FOUND' });
  });

  it('allows scoped enablement changes while keeping DSH package state immutable', () => {
    const registry = new CapabilityRegistry();
    registry.register({
      schemaVersion: 1, id: 'toggle-host', name: 'Toggle host', version: '1.0.0', owner: 'dsh-cordis',
      capabilities: [{ id: 'tool', kind: 'tool', version: '1.0.0' }]
    });
    let mcpEnabled = true;
    let skillEnabled = true;
    const service = new PluginCatalogService({
      registry,
      mcp: { list: () => [{ id: 'mcp-1', name: 'mcp', command: 'x', args: [], env: {}, enabled: mcpEnabled, scope: 'global', capability: '', running: false, hasSecrets: false }], toggle: (_id, enabled) => { mcpEnabled = enabled; } },
      skills: { list: () => [{ id: 'skill-1', name: 'skill', description: '', content: '', enabled: skillEnabled, createdAt: 1 }], update: (_id, patch) => { skillEnabled = patch.enabled ?? skillEnabled; } }
    });
    service.setEnabled('host:toggle-host', false);
    service.setEnabled('mcp:mcp-1', false);
    service.setEnabled('skill:skill-1', false);
    expect(registry.get('toggle-host')?.enabled).toBe(false);
    expect(mcpEnabled).toBe(false);
    expect(skillEnabled).toBe(false);
    expect(() => service.setEnabled('dsh:package', false)).toThrow(/managed profile/);
  });

  it('distinguishes CLI, ACP and A2A adapters without making declarations executable', () => {
    const registry = new CapabilityRegistry({ now: () => 10 });
    registry.register(OPC_NEXUS_GOVERNANCE_PLUGIN_MANIFEST);
    const service = new PluginCatalogService({
      registry,
      engines: {
        list: () => ([
          {
            id: 'eng-codex', type: 'codex', name: 'Codex CLI', version: '1.2.3', path: 'C:\\secret\\codex.exe',
            status: 'HEALTHY', authStatus: 'authed', isDefault: false, runningInstances: 0,
            dataBoundary: 'local', installable: true,
            healthSignals: { detected: true, launchable: true, authenticated: true, taskVerified: true, detail: 'ok', checkedAt: 20 }
          },
          {
            id: 'external-research', type: 'external', name: 'Research ACP', version: null, path: 'C:\\secret\\acp.exe',
            status: 'AUTH_REQUIRED', authStatus: 'required', isDefault: false, runningInstances: 0,
            dataBoundary: 'external', installable: false
          },
          {
            id: 'eng-nexus', type: 'nexus', name: 'Legacy Nexus', version: null, path: null,
            status: 'SETUP_REQUIRED', authStatus: 'required', isDefault: false, runningInstances: 0,
            dataBoundary: 'legacy', installable: false
          }
        ])
      }
    });

    const view = service.getCatalog();
    expect(view.sourceCounts).toMatchObject({ cli: 1, acp: 2, a2a: 1 });
    expect(view.items.find((item) => item.id === 'cli:eng-codex')).toMatchObject({
      kind: 'cli-adapter', owner: 'dsh-cordis', status: 'degraded', lifecycle: 'review',
      enabled: false, configured: false, reasonCodes: ['CORDIS_BRIDGE_UNAVAILABLE']
    });
    expect(view.items.find((item) => item.id === 'acp:external-research')).toMatchObject({
      kind: 'acp-adapter', owner: 'dsh-cordis', lifecycle: 'review', configured: false
    });
    expect(view.items.find((item) => item.id.endsWith('.a2a-worker-boundary'))).toMatchObject({
      source: 'a2a', lifecycle: 'review', enabled: false, reasonCodes: ['DECLARATION_ONLY']
    });
    expect(view.items.some((item) => item.name === 'Legacy Nexus' || item.id.includes('eng-nexus'))).toBe(false);
    expect(JSON.stringify(view)).not.toContain('C:\\secret');
    expect(() => service.setEnabled('cli:eng-codex', false)).toThrow(/managed profile/);
  });

  it('promotes a healthy CLI only when the Cordis Worker bridge is registered', () => {
    const service = new PluginCatalogService({
      workerBridgeAvailable: (engineId) => engineId === 'eng-codex',
      engines: {
        list: () => ([{
          id: 'eng-codex', type: 'codex', name: 'Codex CLI', version: '1.2.3', path: null,
          status: 'HEALTHY', authStatus: 'authed', isDefault: false, runningInstances: 0,
          dataBoundary: 'local', installable: true,
          healthSignals: { detected: true, launchable: true, authenticated: true, taskVerified: true, detail: 'ok', checkedAt: 20 }
        }])
      }
    });

    expect(service.getCatalog().items.find((item) => item.id === 'cli:eng-codex')).toMatchObject({
      status: 'ready', lifecycle: 'live', enabled: true, configured: true, reasonCodes: []
    });
  });
});
