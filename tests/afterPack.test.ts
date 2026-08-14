// @ts-nocheck
/* eslint-disable */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const { assertPackagedHarness } = require('../scripts/after-pack.cjs');
const roots: string[] = [];

function context() {
  const appOutDir = join(tmpdir(), `aibox-after-pack-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  roots.push(appOutDir);
  return { appOutDir, electronPlatformName: 'win32' };
}

function writeRuntimeFile(appOutDir: string, relative: string, size = 1) {
  const path = join(appOutDir, 'resources', 'runtime', 'deepseek-harness', relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(size, 1));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('DeepSeek Harness afterPack guard', () => {
  it('fails when electron-builder filters the sidecar node_modules entry', () => {
    const ctx = context();
    writeRuntimeFile(ctx.appOutDir, 'opc-acp-entry.mjs');
    writeRuntimeFile(ctx.appOutDir, 'config/cordis.yml');

    expect(() => assertPackagedHarness(ctx)).toThrow(/dsh-acp-demo/);
  });

  it('fails when the OPC-owned lifecycle entry is missing', () => {
    const ctx = context();
    writeRuntimeFile(ctx.appOutDir, 'node_modules/@deepseek-ai/dsh-acp-demo/lib/bin.js');
    writeRuntimeFile(ctx.appOutDir, 'config/cordis.yml');

    expect(() => assertPackagedHarness(ctx)).toThrow(/opc-acp-entry/);
  });

  it('accepts a complete, non-trivial packaged runtime', () => {
    const ctx = context();
    const required = [
      'node_modules/@deepseek-ai/dsh-acp-demo/lib/bin.js',
      'opc-acp-entry.mjs',
      'config/cordis.yml',
      'package.json',
      'package-lock.json',
      'README.md',
      'THIRD-PARTY-NOTICES.md',
    ];
    for (const relative of required) writeRuntimeFile(ctx.appOutDir, relative);
    for (let index = 0; index < 100; index += 1) {
      writeRuntimeFile(ctx.appOutDir, `node_modules/pkg-${index}/payload.bin`, index === 0 ? 1024 * 1024 : 1);
    }

    expect(assertPackagedHarness(ctx)).toMatchObject({ files: 107 });
  });
});
