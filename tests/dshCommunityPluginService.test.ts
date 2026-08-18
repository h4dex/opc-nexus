import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DSH_COMMUNITY_PLUGIN_ALLOWLIST,
  DshCommunityPluginService,
  QUEST_DEFAULT_DSH_PLUGIN_PACK,
  type DshCommunityPluginAllowlistEntry,
  type DshCommunityPluginInstallCommand,
  type DshCommunityPluginPackDefinition,
  type DshCommunityPluginServiceOptions
} from '../src/main/services/dshCommunityPluginService.js';
import type { DshBuiltInCapabilityView } from '../src/shared/types.js';
import { DshPolicyBroker, type DshPolicyAuditEvent } from '../src/main/services/dshPolicyBroker.js';
import { resolveBuiltinDshHostPolicy } from '../src/main/services/dshPluginPolicy.js';

const roots: string[] = [];

const entry: DshCommunityPluginAllowlistEntry = {
  id: 'example-plugin',
  name: 'Example plugin',
  description: 'A test plugin',
  version: '1.2.3',
  source: { kind: 'package', packageName: '@example/plugin', version: '1.2.3' },
  capabilities: ['web'],
  risk: 'safe'
};

function harness(options: {
  state?: 'running' | 'stopped';
  runInstall?: (command: DshCommunityPluginInstallCommand) => Promise<{ ok: boolean; code: number | null; stdout?: string; stderr?: string }>;
  policy?: 'allow' | 'deny' | 'missing';
  allowlistEntry?: DshCommunityPluginAllowlistEntry;
  questDefaultPack?: DshCommunityPluginPackDefinition | null;
  builtInCapabilities?: readonly DshBuiltInCapabilityView[];
  resolveActivation?: DshCommunityPluginServiceOptions['resolveActivation'];
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'opc-dsh-plugin-'));
  roots.push(root);
  const runtimeRoot = join(root, 'runtime');
  const runtimeEntry = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const home = join(root, 'dsh-home');
  const profileDirectory = join(home, 'profiles', 'web');
  mkdirSync(join(runtimeEntry, '..'), { recursive: true });
  mkdirSync(profileDirectory, { recursive: true });
  writeFileSync(runtimeEntry, '// fake dsh entry', 'utf8');
  writeFileSync(join(profileDirectory, 'package.json'), '{"name":"dsh-profile-web","private":true,"dependencies":{}}\n', 'utf8');
  let state = options.state ?? 'stopped';
  const stop = vi.fn(async () => { state = 'stopped'; });
  const start = vi.fn(async () => { state = 'running'; });
  const commandLog: DshCommunityPluginInstallCommand[] = [];
  const runInstall = options.runInstall ?? (async (command: DshCommunityPluginInstallCommand) => {
    commandLog.push(command);
    const packageRoot = join(profileDirectory, 'node_modules', '@example', 'plugin');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@example/plugin', version: '1.2.3', dsh: { bundle: { patch: './cordis.patch.yml' } }
    }), 'utf8');
    writeFileSync(join(packageRoot, 'cordis.patch.yml'), '[]\n', 'utf8');
    return { ok: true, code: 0 };
  });
  const policyAudits: DshPolicyAuditEvent[] = [];
  const policyBroker = new DshPolicyBroker({
    resolve: options.policy === 'deny'
      ? async () => ({ effect: 'deny', reasonCode: 'profile_denied' })
      : resolveBuiltinDshHostPolicy,
    audit: (event) => policyAudits.push(event)
  });
  const scopedPolicy = policyBroker.scopeRuntime({
    organizationId: 'org-local', runtimeId: 'dsh-profile-agent-1-web', agentId: 'agent-1'
  });
  const service = new DshCommunityPluginService({
    runtimeRoot,
    runtimeEntry,
    nodeExecutable: process.execPath,
    allowlist: [options.allowlistEntry ?? entry],
    questDefaultPack: options.questDefaultPack,
    builtInCapabilities: options.builtInCapabilities,
    resolveActivation: options.resolveActivation,
    resolveProfile: () => ({ profileId: 'web', home, profileDirectory, getState: () => state, stop, start }),
    runInstall,
    ...(options.policy === 'missing' ? {} : { policyForProfile: () => scopedPolicy })
  });
  return { root, runtimeRoot, runtimeEntry, home, profileDirectory, service, stop, start, commandLog, policyAudits };
}

function writeInstalledPlugin(h: ReturnType<typeof harness>, version = entry.version): void {
  const packageRoot = join(h.profileDirectory, 'node_modules', '@example', 'plugin');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: entry.source.packageName,
    version,
    dsh: { bundle: { patch: './cordis.patch.yml' } }
  }), 'utf8');
  writeFileSync(join(packageRoot, 'cordis.patch.yml'), '[]\n', 'utf8');
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('DshCommunityPluginService', () => {
  it('accepts host UUID agent identifiers that begin with a digit', () => {
    const h = harness();

    expect(h.service.getCatalog('3397dad2-2e82-4b49-b2b0-2cde1e71053a').entries)
      .toHaveLength(1);
  });

  it('projects the ten-part Quest capability pack without enabling third-party code', () => {
    const root = mkdtempSync(join(tmpdir(), 'opc-dsh-plugin-default-pack-'));
    roots.push(root);
    const runtimeRoot = join(root, 'runtime');
    const home = join(root, 'dsh-home');
    const profileDirectory = join(home, 'profiles', 'web');
    mkdirSync(runtimeRoot, { recursive: true });
    mkdirSync(profileDirectory, { recursive: true });
    const service = new DshCommunityPluginService({
      runtimeRoot,
      resolveProfile: () => ({ profileId: 'web', home, profileDirectory, getState: () => 'stopped' })
    });

    const catalog = service.getCatalog('agent-1');
    expect(catalog.questDefaultPack).toMatchObject({
      id: 'quest-default',
      risk: 'native',
      status: 'blocked',
      installable: false,
      requiresConfirmation: false,
      installedCount: 0,
      liveCount: 0,
      totalCount: 10
    });
    expect(catalog.builtInCapabilities).toEqual([]);
    expect(QUEST_DEFAULT_DSH_PLUGIN_PACK.members.map((member) => member.pluginId)).toEqual([
      'dsh-anchored-standard',
      'dsh-web-ui',
      'dsh-better-sidebar',
      'modlens',
      'dsh-vision-toolkit',
      'dsh-tui',
      'dsh-browser',
      'dsh-workflow',
      'dsh-chat-import',
      'dsh-find-plugin'
    ]);
    expect(catalog.questDefaultPack?.members.map((member) => member.questPart)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(catalog.questDefaultPack?.members.filter((member) => member.defaultEnabled)).toHaveLength(0);
    expect(catalog.questDefaultPack?.members.every((member) => member.status === 'blocked')).toBe(true);
    for (const member of catalog.questDefaultPack?.members ?? []) {
      expect(() => service.issueConfirmation({ agentId: 'agent-1', pluginId: member.id }))
        .toThrow(/unavailable/);
    }
    expect(catalog.entries.find((item) => item.id === 'dsh-better-sidebar')).toMatchObject({
      runtimeBoundary: 'explicit-profile-permission', compatibility: 'verified', installable: false,
      reasonCodes: expect.arrayContaining(['EXPLICIT_PERMISSION_REQUIRED'])
    });
    expect(catalog.entries.find((item) => item.id === 'dsh-vision-toolkit')).toMatchObject({
      runtimeBoundary: 'main-adapter-required', compatibility: 'verified', installable: false,
      reasonCodes: expect.arrayContaining(['MAIN_ADAPTER_REQUIRED', 'VISION_CREDENTIAL_PROXY_REQUIRED'])
    });
    expect(catalog.entries.find((item) => item.id === 'dsh-tui')).toMatchObject({
      runtimeBoundary: 'standalone-only', compatibility: 'identity-conflict', installable: false
    });
    expect(catalog.entries.find((item) => item.id === 'dsh-workflow')).toMatchObject({
      runtimeBoundary: 'blocked', compatibility: 'incompatible', installable: false,
      source: { kind: 'github', github: { ref: '44b83c182aa02d1be8a0803e8446cb495f93cd8f' } }
    });
    expect(catalog.entries.find((item) => item.id === 'dsh-web-ui')).toMatchObject({
      compatibility: 'verified',
      source: { packageName: '@linxin666/dsh-web-ui-all', version: '0.1.19' },
      reasonCodes: expect.arrayContaining([
        'OFFICIAL_DSH_WEB_UI_ACTIVE',
        'COMMUNITY_ENHANCEMENTS_NOT_BUILT_IN',
        'DSH_RC6_BUNDLE_COMPOSITION_VERIFIED'
      ])
    });
    expect(catalog.entries.find((item) => item.id === 'dsh-chat-import')?.source).toMatchObject({
      packageName: 'dsh-chat-import', version: '0.5.1'
    });
    expect(catalog.entries.find((item) => item.id === 'dsh-find-plugin')).toMatchObject({
      runtimeBoundary: 'main-adapter-required',
      compatibility: 'verified',
      installable: false,
      reasonCodes: expect.arrayContaining(['NETWORK_PROXY_REQUIRED', 'DSH_RC6_STARTUP_VERIFIED'])
    });
    expect(catalog.warnings.join(' ')).toContain('默认启用 0 项');
  });

  it('reports an already-installed blocked package honestly and still permits removal', async () => {
    const h = harness({
      allowlistEntry: {
        ...entry,
        runtimeBoundary: 'blocked',
        compatibility: 'incompatible',
        reasonCodes: ['CURATED_BLOCK']
      },
      resolveActivation: () => ({ attached: true, health: 'healthy' })
    });
    writeInstalledPlugin(h);

    const plugin = h.service.getCatalog('agent-1').entries[0]!;
    expect(plugin).toMatchObject({
      status: 'installed',
      installedVersion: '1.2.3',
      installable: false,
      requiresRestart: false,
      activation: { attached: true, health: 'healthy', live: false },
      reasonCodes: expect.arrayContaining(['INSTALLED_OUTSIDE_APPROVED_BOUNDARY', 'DSH_RC6_INCOMPATIBLE'])
    });
    expect(() => h.service.issueConfirmation({ agentId: 'agent-1', pluginId: entry.id }))
      .toThrow(/unavailable/);
    await expect(h.service.issueLifecycleConfirmation({
      agentId: 'agent-1', pluginId: entry.id, action: 'uninstall'
    })).resolves.toMatchObject({ action: 'uninstall', pluginId: entry.id });
  });

  it('does not report an installed package live without runtime evidence', () => {
    const h = harness();
    writeInstalledPlugin(h);

    expect(h.service.getCatalog('agent-1').entries[0]).toMatchObject({
      status: 'installed',
      installedVersion: entry.version,
      activation: { attached: false, health: 'not-probed', live: false }
    });
  });

  it('requires attached healthy evidence before an approved package contributes to liveCount', () => {
    const pack: DshCommunityPluginPackDefinition = {
      id: 'test-pack',
      name: 'Test pack',
      description: 'One reviewed community package',
      risk: 'safe',
      members: [{ pluginId: entry.id, packageName: entry.source.packageName, version: entry.version }]
    };
    const detached = harness({
      questDefaultPack: pack,
      resolveActivation: () => ({ attached: false, health: 'healthy' })
    });
    writeInstalledPlugin(detached);
    expect(detached.service.getCatalog('agent-1')).toMatchObject({
      questDefaultPack: { installedCount: 1, liveCount: 0 },
      entries: [{ activation: { attached: false, health: 'healthy', live: false } }]
    });

    const unhealthy = harness({
      questDefaultPack: pack,
      resolveActivation: () => ({ attached: true, health: 'unhealthy' })
    });
    writeInstalledPlugin(unhealthy);
    expect(unhealthy.service.getCatalog('agent-1')).toMatchObject({
      questDefaultPack: { installedCount: 1, liveCount: 0 },
      entries: [{ activation: { attached: true, health: 'unhealthy', live: false } }]
    });

    const healthy = harness({
      questDefaultPack: pack,
      resolveActivation: () => ({ attached: true, health: 'healthy' })
    });
    writeInstalledPlugin(healthy);
    expect(healthy.service.getCatalog('agent-1')).toMatchObject({
      questDefaultPack: { installedCount: 1, liveCount: 1 },
      entries: [{ activation: { attached: true, health: 'healthy', live: true } }]
    });
  });

  it('projects Main-owned built-in capabilities without sharing mutable arrays', () => {
    const h = harness({
      builtInCapabilities: [{
        id: 'vision-ocr',
        name: 'Vision and OCR',
        description: 'Main-owned image understanding',
        provider: 'native-host',
        status: 'integrated',
        capabilities: ['vision', 'ocr']
      }]
    });

    const first = h.service.getCatalog('agent-1');
    expect(first.builtInCapabilities).toEqual([{
      id: 'vision-ocr',
      name: 'Vision and OCR',
      description: 'Main-owned image understanding',
      provider: 'native-host',
      status: 'integrated',
      capabilities: ['vision', 'ocr']
    }]);
    first.builtInCapabilities[0]!.capabilities.push('mutated');
    expect(h.service.getCatalog('agent-1').builtInCapabilities[0]!.capabilities)
      .toEqual(['vision', 'ocr']);
  });

  it('targets the mutable DSH profile and invokes the managed DSH plugin CLI', async () => {
    const h = harness();
    const confirmation = h.service.issueConfirmation({ agentId: 'agent-1', pluginId: 'example-plugin' });
    const result = await h.service.install({ agentId: 'agent-1', pluginId: 'example-plugin', confirmationToken: confirmation.token });
    expect(result).toMatchObject({ ok: true, status: 'restart-required', profileStopped: false, requiresRestart: true });
    expect(h.commandLog).toHaveLength(1);
    expect(h.commandLog[0]).toMatchObject({ executable: process.execPath, cwd: h.profileDirectory });
    expect(h.commandLog[0].args).toEqual([
      h.runtimeEntry, 'plugin', '--profile', 'web', 'add', '--workspace-root', '--save-exact', '--ignore-scripts', '@example/plugin@1.2.3'
    ]);
    expect(h.commandLog[0].env.DSH_HOME).toBe(h.home);
    expect(readFileSync(join(h.runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'utf8')).toContain('fake');
    expect(h.policyAudits.map((event) => event.capability)).toEqual([
      'package.install', 'process.exec', 'fs.write'
    ]);
  });

  it('treats a repeated exact-version install as a confirmed idempotent no-op', async () => {
    const h = harness();
    const firstConfirmation = h.service.issueConfirmation({ agentId: 'agent-1', pluginId: 'example-plugin' });
    await expect(h.service.install({
      agentId: 'agent-1', pluginId: 'example-plugin', confirmationToken: firstConfirmation.token
    })).resolves.toMatchObject({ ok: true, status: 'restart-required' });
    const secondConfirmation = h.service.issueConfirmation({ agentId: 'agent-1', pluginId: 'example-plugin' });
    await expect(h.service.install({
      agentId: 'agent-1', pluginId: 'example-plugin', confirmationToken: secondConfirmation.token
    })).resolves.toMatchObject({
      ok: true,
      status: 'installed',
      profileStopped: false,
      profileResumed: false,
      requiresRestart: false,
      message: expect.stringContaining('no changes')
    });
    expect(h.commandLog).toHaveLength(1);
    expect(h.policyAudits).toHaveLength(3);
  });

  it('rejects a Quest default pack member whose pinned coordinates do not match the catalog', () => {
    const root = mkdtempSync(join(tmpdir(), 'opc-dsh-plugin-unsafe-pack-'));
    roots.push(root);
    expect(() => new DshCommunityPluginService({
      runtimeRoot: root,
      allowlist: [{
        ...entry,
        capabilities: ['browser'],
        runtimeBoundary: 'main-adapter-required'
      }],
      questDefaultPack: {
        id: 'quest-default',
        name: 'Quest default',
        description: 'Unsafe test pack',
        risk: 'native',
        members: [{ pluginId: entry.id, packageName: entry.source.packageName, version: '9.9.9' }]
      }
    })).toThrow(/not an exact curated source/);
  });

  it('stops and resumes a running profile around installation', async () => {
    const h = harness({ state: 'running' });
    const confirmation = h.service.issueConfirmation({ agentId: 'agent-1', pluginId: 'example-plugin' });
    const result = await h.service.install({ agentId: 'agent-1', pluginId: 'example-plugin', confirmationToken: confirmation.token });
    expect(result).toMatchObject({ ok: true, profileStopped: true, profileResumed: true });
    expect(h.stop).toHaveBeenCalledOnce();
    expect(h.start).toHaveBeenCalledOnce();
  });

  it('updates an installed plugin through the action-bound lifecycle path', async () => {
    const h = harness();
    const packageRoot = join(h.profileDirectory, 'node_modules', '@example', 'plugin');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@example/plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } }
    }), 'utf8');
    writeFileSync(join(packageRoot, 'cordis.patch.yml'), '[]\n', 'utf8');

    const confirmation = await h.service.issueLifecycleConfirmation({
      agentId: 'agent-1', pluginId: 'example-plugin', action: 'update'
    });
    const result = await h.service.applyLifecycle({
      agentId: 'agent-1', pluginId: 'example-plugin', action: 'update', confirmationToken: confirmation.token
    });

    expect(result).toMatchObject({ ok: true, action: 'update', status: 'restart-required' });
    expect(h.commandLog[0].args).toEqual([
      h.runtimeEntry, 'plugin', '--profile', 'web', 'add', '--workspace-root', '--save-exact', '--ignore-scripts', '@example/plugin@1.2.3'
    ]);
    expect(h.policyAudits.map((event) => event.capability)).toEqual([
      'package.install', 'process.exec', 'fs.write'
    ]);
  });

  it('uninstalls only after both the dependency and bundle layer are removed', async () => {
    const h = harness({
      runInstall: async () => {
        rmSync(join(h.profileDirectory, 'node_modules', '@example', 'plugin'), { recursive: true, force: true });
        writeFileSync(join(h.profileDirectory, 'package.json'), JSON.stringify({
          name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [] } }
        }), 'utf8');
        return { ok: true, code: 0 };
      }
    });
    const packageRoot = join(h.profileDirectory, 'node_modules', '@example', 'plugin');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@example/plugin', version: '1.2.3', dsh: { bundle: { patch: './cordis.patch.yml' } }
    }), 'utf8');
    writeFileSync(join(packageRoot, 'cordis.patch.yml'), '[]\n', 'utf8');
    writeFileSync(join(h.profileDirectory, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', private: true,
      dependencies: { '@example/plugin': '1.2.3' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@example/plugin'] } }
    }), 'utf8');

    const confirmation = await h.service.issueLifecycleConfirmation({
      agentId: 'agent-1', pluginId: 'example-plugin', action: 'uninstall'
    });
    const result = await h.service.applyLifecycle({
      agentId: 'agent-1', pluginId: 'example-plugin', action: 'uninstall', confirmationToken: confirmation.token
    });

    expect(result).toMatchObject({ ok: true, action: 'uninstall', status: 'available' });
  });

  it('rejects an uninstall that leaves the package in profile metadata', async () => {
    const h = harness({
      runInstall: async () => {
        rmSync(join(h.profileDirectory, 'node_modules', '@example', 'plugin'), { recursive: true, force: true });
        return { ok: true, code: 0 };
      }
    });
    const packageRoot = join(h.profileDirectory, 'node_modules', '@example', 'plugin');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@example/plugin', version: '1.2.3', dsh: { bundle: { patch: './cordis.patch.yml' } }
    }), 'utf8');
    writeFileSync(join(packageRoot, 'cordis.patch.yml'), '[]\n', 'utf8');
    writeFileSync(join(h.profileDirectory, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', private: true,
      dependencies: { '@example/plugin': '1.2.3' },
      dsh: { profile: { bundles: ['@example/plugin'] } }
    }), 'utf8');

    const confirmation = await h.service.issueLifecycleConfirmation({
      agentId: 'agent-1', pluginId: 'example-plugin', action: 'uninstall'
    });
    const result = await h.service.applyLifecycle({
      agentId: 'agent-1', pluginId: 'example-plugin', action: 'uninstall', confirmationToken: confirmation.token
    });

    expect(result).toMatchObject({ ok: false, action: 'uninstall', status: 'broken' });
    expect(result.message).toContain('did not remove the package dependency and bundle layer');
  });

  it('requires an actual dsh.bundle patch file and restores profile metadata on failure', async () => {
    const h = harness({
      runInstall: async () => {
        writeFileSync(join(h.profileDirectory, 'package.json'), '{"name":"corrupted"}\n', 'utf8');
        return { ok: false, code: 17, stderr: 'simulated failure' };
      }
    });
    const before = readFileSync(join(h.profileDirectory, 'package.json'), 'utf8');
    const confirmation = h.service.issueConfirmation({ agentId: 'agent-1', pluginId: 'example-plugin' });
    const result = await h.service.install({ agentId: 'agent-1', pluginId: 'example-plugin', confirmationToken: confirmation.token });
    expect(result).toMatchObject({ ok: false, status: 'broken' });
    expect(result.message).toContain('DSH plugin install failed');
    expect(readFileSync(join(h.profileDirectory, 'package.json'), 'utf8')).toBe(before);
  });

  it('rejects a package that omits the dsh.bundle.patch contract', async () => {
    const h = harness({
      runInstall: async () => {
        const packageRoot = join(h.profileDirectory, 'node_modules', '@example', 'plugin');
        mkdirSync(packageRoot, { recursive: true });
        writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@example/plugin', version: '1.2.3' }), 'utf8');
        return { ok: true, code: 0 };
      }
    });
    const confirmation = h.service.issueConfirmation({ agentId: 'agent-1', pluginId: 'example-plugin' });
    const result = await h.service.install({ agentId: 'agent-1', pluginId: 'example-plugin', confirmationToken: confirmation.token });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('dsh.bundle patch contract');
  });

  it('consumes confirmation tokens once and binds them to the agent', () => {
    const h = harness();
    const confirmation = h.service.issueConfirmation({ agentId: 'agent-1', pluginId: 'example-plugin' });
    expect(() => h.service.install({ agentId: 'agent-2', pluginId: 'example-plugin', confirmationToken: confirmation.token })).toThrow(/invalid or expired/);
    expect(() => h.service.install({ agentId: 'agent-1', pluginId: 'example-plugin', confirmationToken: confirmation.token })).toThrow(/invalid or expired/);
  });

  it.each(['missing', 'deny'] as const)('does not mutate or invoke the installer when policy is %s', async (policyMode) => {
    const runInstall = vi.fn(async () => ({ ok: true, code: 0 }));
    const h = harness({ state: 'running', policy: policyMode, runInstall });
    const confirmation = h.service.issueConfirmation({ agentId: 'agent-1', pluginId: 'example-plugin' });
    const result = await h.service.install({
      agentId: 'agent-1', pluginId: 'example-plugin', confirmationToken: confirmation.token
    });
    expect(result).toMatchObject({ ok: false, profileStopped: false, profileResumed: false });
    expect(result.message).toContain('DSH policy denied plugin installation');
    expect(runInstall).not.toHaveBeenCalled();
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });
});
