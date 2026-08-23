import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Quest default plugin drawer source contract', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'pages', 'QuestWorkbench.tsx'), 'utf8');
  const styles = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'pages', 'questWorkbench.css'), 'utf8');

  it('reads project capabilities only from the unified plugin catalog', () => {
    expect(source).toContain('window.aibox.getPluginCatalog()');
    expect(source).toContain('setUnifiedPluginCatalog(unifiedResult)');
    expect(source).toContain('unifiedPluginCatalog?.items ?? []');
    expect(source).toContain('REQUIRED_PROJECT_PLUGIN_IDS.has(plugin.id)');
    expect(source).toContain('WORKER_PLUGIN_SOURCES.has(plugin.source)');
    expect(source).toContain('HERMES_PROJECT_CAPABILITY_SOURCES.has(plugin.source)');
    expect(source).toContain('选择已真实接入 Hermes 的 MCP 与技能');
    expect(source).toContain('统一插件目录中暂无可选项目能力');
    expect(source).toContain("plugin.lifecycle === 'missing' ? '未安装' : '未就绪'");
  });

  it('only persists project capability ids and exposes no plugin lifecycle controls', () => {
    expect(source).toContain('settingsDraft?.pluginIds.includes(plugin.id)');
    expect(source).toContain('? [...new Set([...settingsDraft.pluginIds, plugin.id])]');
    expect(source).toContain(': settingsDraft.pluginIds.filter((id) => id !== plugin.id)');
    expect(source).toContain('window.aibox.saveQuestSettings(projectId, { ...settingsDraft, mode: \'quest\' })');
    expect(source).not.toContain('prepareDshCommunityPluginInstall');
    expect(source).not.toContain('installDshCommunityPlugin');
    expect(source).not.toContain('prepareDshCommunityPluginLifecycle');
    expect(source).not.toContain('applyDshCommunityPluginLifecycle');
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
