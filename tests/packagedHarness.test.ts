// @ts-nocheck
/* eslint-disable */
import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  ENABLED_FUSE_VALUE,
  packagedEnvironment,
  resolvePackagedExecutable
} = require('../scripts/verify-packaged-deepseek-harness.cjs');

describe('Packaged DeepSeek Harness verification', () => {
  it('does not pass ambient credentials or Node injection options to the packaged sidecar', () => {
    const env = packagedEnvironment(
      { AIBOX_DSH_MODEL: 'deepseek-chat', ELECTRON_RUN_AS_NODE: '0' },
      {
        Path: 'C:\\runtime-bin',
        TEMP: 'C:\\Temp',
        CSC_LINK: 'signing-secret',
        GITHUB_TOKEN: 'github-secret',
        DEEPSEEK_API_KEY: 'provider-secret',
        NODE_OPTIONS: '--require malicious-hook.cjs'
      }
    );

    expect(env).toMatchObject({
      Path: 'C:\\runtime-bin', TEMP: 'C:\\Temp', AIBOX_DSH_MODEL: 'deepseek-chat',
      ELECTRON_RUN_AS_NODE: '1'
    });
    expect(env).not.toHaveProperty('CSC_LINK');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(env).not.toHaveProperty('DEEPSEEK_API_KEY');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
  });

  it('accepts an unpacked Windows directory and identifies the Electron executable by its fuse wire', async () => {
    const root = join(tmpdir(), `aibox-packaged-win-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const app = join(root, 'OPC-Nexus.exe');
      const helper = join(root, 'setup-helper.exe');
      writeFileSync(app, 'app');
      writeFileSync(helper, 'helper');

      const resolved = await resolvePackagedExecutable(root, {
        platform: 'win32',
        readFuseWire: async (candidate: string) => {
          if (candidate === app) return { version: '1', 0: ENABLED_FUSE_VALUE };
          throw new Error('not Electron');
        }
      });

      expect(resolved.executable).toBe(app);
      expect(resolved.fuses[0]).toBe(ENABLED_FUSE_VALUE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a Linux unpacked directory without assuming a product executable name', async () => {
    const root = join(tmpdir(), `aibox-packaged-linux-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const app = join(root, 'aibox-control-center');
      const data = join(root, 'resources.pak');
      writeFileSync(app, 'app');
      writeFileSync(data, 'data');
      chmodSync(app, 0o755);

      const resolved = await resolvePackagedExecutable(root, {
        platform: 'linux',
        readFuseWire: async (candidate: string) => {
          if (candidate === app) return { version: '1', 0: ENABLED_FUSE_VALUE };
          throw new Error('not Electron');
        }
      });

      expect(resolved.executable).toBe(app);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when an unpacked directory contains multiple Electron executables', async () => {
    const root = join(tmpdir(), `aibox-packaged-ambiguous-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      writeFileSync(join(root, 'one.exe'), 'one');
      writeFileSync(join(root, 'two.exe'), 'two');

      await expect(resolvePackagedExecutable(root, {
        platform: 'win32',
        readFuseWire: async () => ({ version: '1', 0: ENABLED_FUSE_VALUE })
      })).rejects.toThrow(/exactly one Electron executable.*found 2/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
