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
    expect(workbench).toContain("setEmbedError(error instanceof Error ? error.message : 'Hermes 工作区打开失败')");
    expect(workbench).toContain('<strong>Hermes 工作区连接失败</strong>');
    expect(workbench).toContain('<strong>Hermes 项目服务不可用</strong>');
    expect(workbench).toContain('api.openEmbeddedHermesWorkbench({');
    expect(workbench).toContain('void window.aibox.startHermesProject(project.id).catch(() => undefined);');
    expect(workbench).toContain('coalesces this with the later open request');
    expect(workbench).toContain('...(initialConversationIdRef.current ? { conversationId: initialConversationIdRef.current } : {})');
    expect(workbench).toContain('<span>{embedError}</span>');
    expect(workbench).toContain('连接设置</button>');
    expect(setup).toContain('window.aibox.getEnvironmentDiagnostics()');
    expect(setup).toContain('window.aibox.detectEngines()');
  });

  it('stores provider secrets through the typed Main boundary only', () => {
    expect(setup).toContain('window.aibox.createProvider({');
    expect(setup).toContain('window.aibox.updateProvider(selected.id');
    expect(setup).toContain('window.aibox.testProviderById(providerId)');
    expect(setup).toContain('window.aibox.fetchProviderModels(selected.id)');
    expect(setup).toContain('已读取 ${result.models.length} 个上游模型');
    expect(setup).toContain('list="quest-provider-models"');
    expect(setup).toContain("配置已保存，但模型验证失败");
    expect(setup).toContain('type="password"');
    expect(setup).not.toContain('localStorage');
    expect(setup).not.toContain('sessionStorage');
  });

  it('does not recreate the retired Cordis scheduler when engines are re-detected', () => {
    const detectHandler = ipc.slice(
      ipc.indexOf("handle('aibox:detectEngines'"),
      ipc.indexOf("handle('aibox:getInstallGuide'")
    );
    expect(detectHandler).not.toContain('ensureCordisAgent(');
    expect(detectHandler).not.toContain("action: 'cordis.repair'");
    expect(detectHandler).toContain('pushSnapshot()');
  });
});
