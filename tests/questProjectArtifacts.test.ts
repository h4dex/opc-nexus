import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Quest project artifact panel source contract', () => {
  const rendererRoot = join(process.cwd(), 'src', 'renderer', 'src');
  const workbench = readFileSync(join(rendererRoot, 'pages', 'QuestWorkbench.tsx'), 'utf8');
  const panel = readFileSync(join(rendererRoot, 'pages', 'ProjectArtifactsPanel.tsx'), 'utf8');
  const app = readFileSync(join(rendererRoot, 'App.tsx'), 'utf8');
  const html = readFileSync(join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');

  it('keeps the office visualization and its requested primary navigation entry', () => {
    expect(app).toContain("{ key: 'office', label: '办公室'");
    expect(app).toContain("case 'office': return <Office />;");
    expect(workbench).toContain('<ProjectArtifactsPanel');
    expect(workbench).toContain('aria-label={artifactsOpen ? \'收起项目产物\' : \'打开项目产物\'}');
  });

  it('uses the preload boundary for directory, preview, and reveal operations', () => {
    expect(panel).toContain('window.aibox.listProjectArtifacts(projectId, relativeDirectory)');
    expect(panel).toContain("URL.createObjectURL(new Blob([htmlPreviewDocument], { type: 'text/html' }))");
    expect(panel).toContain('URL.revokeObjectURL(url)');
    expect(panel).toContain('sandbox="allow-same-origin"');
    expect(panel).toContain('window.aibox.previewProjectArtifact(projectId, entry.relativePath)');
    expect(panel).toContain('window.aibox.revealProjectArtifact(projectId, selected.relativePath)');
    expect(panel).not.toMatch(/\b(?:require|process|fs\.)\b/);
  });

  it('renders browser and rich-media previews without enabling Electron webview APIs', () => {
    expect(panel).toContain('sandbox="allow-same-origin"');
    expect(panel).not.toContain('allow-scripts');
    expect(panel).toContain("script-src 'none'");
    expect(panel).toContain('<MarkdownView');
    expect(panel).toContain('<video');
    expect(panel).toContain('<audio');
    expect(panel).toContain('PDF 预览');
    expect(panel).not.toContain('<webview');
    expect(html).toContain("frame-src 'self' blob: aibox-project:");
    expect(html).toContain("style-src 'self' 'unsafe-inline' aibox-project:");
    expect(html).toContain('aibox-artifact: aibox-project:');
    expect(html).not.toContain('frame-src *');
  });

  it('keeps artifacts mutually exclusive with operational drawers', () => {
    expect(workbench).toMatch(/const toggleArtifacts = \(\) => \{[\s\S]*?setGovernanceOpen\(false\);[\s\S]*?setPluginsOpen\(false\);[\s\S]*?setSetupOpen\(false\);[\s\S]*?setMobileOpen\(false\);/);
  });
});
