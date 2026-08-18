// @ts-nocheck
/* eslint-disable */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { Arch } = require('builder-util');
const { assertHarnessTarget, assertVerificationResult, verifyHarnessRuntimes } = require('../scripts/before-pack.cjs');
const hostArch = process.arch === 'arm' ? 'armv7l' : process.arch;

describe('DeepSeek Harness beforePack target guard', () => {
  it('accepts electron-builder numeric Arch for the current host', () => {
    expect(() => assertHarnessTarget({
      electronPlatformName: process.platform,
      arch: Arch[hostArch]
    })).not.toThrow();
  });

  it('rejects a numeric target Arch that does not match the prepared runtime host', () => {
    const otherArch = hostArch === 'x64' ? Arch.arm64 : Arch.x64;
    expect(() => assertHarnessTarget({
      electronPlatformName: process.platform,
      arch: otherArch
    })).toThrow(/must be prepared for/);
  });

  it('rejects cross-platform packaging of native runtime packages', () => {
    const otherPlatform = process.platform === 'win32' ? 'linux' : 'win32';
    expect(() => assertHarnessTarget({
      electronPlatformName: otherPlatform,
      arch: Arch[hostArch]
    })).toThrow(/prepare and package on/);
  });

  it('uses the lockfile-installed Electron distribution for offline packaging', () => {
    const config = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8');
    expect(config).toMatch(/^electronDist:\s*node_modules\/electron\/dist\s*$/m);
    const executable = process.platform === 'win32' ? 'electron.exe' : 'electron';
    expect(existsSync(join(process.cwd(), 'node_modules', 'electron', 'dist', executable))).toBe(true);
  });

  it('awaits the managed Electron smoke before completing the release gate', async () => {
    let release!: (result: { status: number }) => void;
    const managed = new Promise<{ status: number }>((resolve) => { release = resolve; });
    let completed = false;
    const verification = verifyHarnessRuntimes(
      () => ({ status: 0 }),
      () => managed
    ).then(() => { completed = true; });

    await Promise.resolve();
    expect(completed).toBe(false);
    release({ status: 0 });
    await verification;
    expect(completed).toBe(true);
  });

  it('reports signals and missing process results without an undefined exit code', () => {
    expect(() => assertVerificationResult({ status: null, signal: 'SIGTERM' }, 'Managed'))
      .toThrow(/signal SIGTERM/);
    expect(() => assertVerificationResult(undefined, 'Managed'))
      .toThrow(/returned no process result/);
  });
});
