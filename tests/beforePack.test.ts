import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('release beforePack guard', () => {
  it('uses the lockfile-installed Electron distribution for offline packaging', () => {
    const config = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8');
    expect(config).toMatch(/^electronDist:\s*node_modules\/electron\/dist\s*$/m);
    const executable = process.platform === 'win32' ? 'electron.exe' : 'electron';
    expect(existsSync(join(process.cwd(), 'node_modules', 'electron', 'dist', executable))).toBe(true);
  });

  it('verifies the Android artifact, Hermes runtime, and bundled worker runtimes before packaging', () => {
    const source = readFileSync(join(process.cwd(), 'scripts', 'before-pack.cjs'), 'utf8');
    expect(source).toContain('verifyDist({ requireRelease: true })');
    expect(source).toContain('verifyHermesRuntime({ platform: targetPlatform, arch: targetArch })');
    expect(source).toContain('verifyAgentRuntime(id, spec)');
    expect(source).not.toMatch(/deepseek|harness|dsh/i);
  });
});
