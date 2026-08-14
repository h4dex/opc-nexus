// @ts-nocheck
/* eslint-disable */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { Arch } = require('builder-util');
const { assertHarnessTarget } = require('../scripts/before-pack.cjs');
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
});
