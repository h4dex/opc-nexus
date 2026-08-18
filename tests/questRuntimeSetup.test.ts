import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Quest-only runtime recovery source contract', () => {
  const root = process.cwd();
  const workbench = readFileSync(join(root, 'src', 'renderer', 'src', 'pages', 'QuestWorkbench.tsx'), 'utf8');
  const setup = readFileSync(join(root, 'src', 'renderer', 'src', 'pages', 'QuestRuntimeSetup.tsx'), 'utf8');
  const ipc = readFileSync(join(root, 'src', 'main', 'ipc.ts'), 'utf8');

  it('keeps model and environment repair inside the Quest shell', () => {
    expect(workbench).toContain('<QuestRuntimeSetup');
    expect(workbench).toContain('打开 Quest 连接设置');
    expect(workbench).toContain('retryEmbed');
    expect(workbench).toContain("setEmbedError(error instanceof Error ? error.message : 'DSH 工作区打开失败')");
    expect(workbench).toContain("'DSH 工作区连接失败'");
    expect(workbench).toContain("'模型连接不可用'");
    expect(workbench).toContain('api.preflightQuestProvider(project.id, agentId)');
    expect(workbench).toContain('<span>{embedError}</span>');
    expect(workbench).toContain('连接设置</button>');
    expect(setup).toContain('window.aibox.getEnvironmentDiagnostics()');
    expect(setup).toContain('window.aibox.detectEngines()');
  });

  it('stores provider secrets through the typed Main boundary only', () => {
    expect(setup).toContain('window.aibox.createProvider({');
    expect(setup).toContain('window.aibox.updateProvider(selected.id');
    expect(setup).toContain('window.aibox.testProviderById(providerId)');
    expect(setup).toContain("配置已保存，但模型验证失败");
    expect(setup).toContain('type="password"');
    expect(setup).not.toContain('localStorage');
    expect(setup).not.toContain('sessionStorage');
  });

  it('repairs the built-in Cordis employee when engines are re-detected', () => {
    const detectHandler = ipc.slice(
      ipc.indexOf("ipcMain.handle('aibox:detectEngines'"),
      ipc.indexOf("ipcMain.handle('aibox:getInstallGuide'")
    );
    expect(detectHandler).toContain('ensureCordisAgent(');
    expect(detectHandler).toContain("action: 'cordis.repair'");
    expect(detectHandler).toContain('pushSnapshot()');
  });
});
