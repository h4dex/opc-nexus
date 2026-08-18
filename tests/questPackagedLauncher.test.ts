import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('packaged Quest-only launchers', () => {
  const root = process.cwd();
  const builder = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
  const installer = readFileSync(join(root, 'build', 'installer.nsh'), 'utf8');

  it('adds and removes a Windows Start menu Quest shortcut without replacing the main shortcut', () => {
    expect(builder).toContain('shortcutName: 数字员工 AI Box');
    expect(builder).toContain('include: build/installer.nsh');
    expect(installer).toContain('!macro customInstall');
    expect(installer).toContain('CreateShortCut "$SMPROGRAMS\\Quest.lnk"');
    expect(installer).toContain('"--quest-only"');
    expect(installer).toContain('!macro customUnInstall');
    expect(installer).toContain('Delete "$SMPROGRAMS\\Quest.lnk"');
  });

  it('publishes a Linux desktop action for the same Quest-only profile', () => {
    expect(builder).toContain('executableName: aibox-control-center');
    expect(builder).toContain('Actions: Quest;');
    expect(builder).toContain('desktopActions:');
    expect(builder).toContain('Exec: aibox-control-center --quest-only');
  });
});
