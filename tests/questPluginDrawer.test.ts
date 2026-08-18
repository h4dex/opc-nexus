import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Quest default plugin drawer source contract', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'pages', 'QuestWorkbench.tsx'), 'utf8');
  const styles = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'pages', 'questWorkbench.css'), 'utf8');

  it('separates Main-owned built-ins from the ten community candidates', () => {
    expect(source).toContain('pluginCatalog?.questDefaultPack');
    expect(source).toContain('pluginCatalog?.builtInCapabilities');
    expect(source).toContain('pluginPack?.liveCount');
    expect(source).toContain("padStart(2, '0')");
    expect(source).toContain("reasonCodes.includes('OFFICIAL_DSH_WEB_UI_ACTIVE')");
    expect(source).toContain('社区候选 · 安装');
    expect(source).toContain('内置能力');
    expect(source).toContain('官方基础 UI 已集成；社区增强包仍需独立核验');
    expect(source).toContain("plugin.activation.live ? '运行已验证'");
    expect(source).not.toContain('核心能力已加载');
    expect(source).toContain('PLUGIN_REASON_LABELS');
  });

  it('keeps execution fail-closed and uses the confirmation IPC', () => {
    expect(source).toContain('{plugin.installable && (');
    expect(source).toContain('prepareDshCommunityPluginInstall(agentId, plugin.id)');
    expect(source).toContain('installDshCommunityPlugin({');
    expect(source).toContain('if (!agentId || pluginBusyId || !plugin.installable) return;');
    expect(source).toContain('prepareDshCommunityPluginLifecycle(agentId, plugin.id, action)');
    expect(source).toContain("applyCommunityPluginLifecycle(plugin, 'uninstall')");
  });

  it('keeps plugin, governance, and connection drawers mutually exclusive without mobile overlap', () => {
    expect(source).toMatch(/const toggleGovernance = \(\) => \{[\s\S]*?setPluginsOpen\(false\);[\s\S]*?setSetupOpen\(false\);[\s\S]*?setMobileOpen\(false\);[\s\S]*?\n  \};/);
    expect(source).toMatch(/const togglePlugins = \(\) => \{[\s\S]*?setGovernanceOpen\(false\);[\s\S]*?setSetupOpen\(false\);[\s\S]*?setMobileOpen\(false\);[\s\S]*?\n  \};/);
    expect(source).toMatch(/const toggleSetup = \(\) => \{[\s\S]*?setGovernanceOpen\(false\);[\s\S]*?setPluginsOpen\(false\);[\s\S]*?setMobileOpen\(false\);[\s\S]*?\n  \};/);
    expect(source).toMatch(/const toggleMobile = \(\) => \{[\s\S]*?setGovernanceOpen\(false\);[\s\S]*?setPluginsOpen\(false\);[\s\S]*?setSetupOpen\(false\);[\s\S]*?\n  \};/);
    expect(styles).toContain('.quest-workbench.plugins-open .quest-embedded-column');
    expect(styles).toMatch(/\.quest-plugin-drawer,[\s\S]*?\.quest-runtime-setup,[\s\S]*?\.quest-mobile-access \{ width: 100%; min-width: 0; max-width: none;/);
  });
});
