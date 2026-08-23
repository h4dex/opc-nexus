import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

// @ts-nocheck
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { verifyPackaged } = require('../scripts/verify-packaged-agent-runtimes.cjs');

describe('packaged Codex/Pi runtime gate', () => {
  it('rejects an incomplete package and accepts both pinned entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'opc-agent-package-'));
    try {
      const resources = join(root, 'resources');
      const manifest = [
        ['codex', '@openai/codex', 'bin/codex.js', '0.149.0'],
        ['pi', '@earendil-works/pi-coding-agent', 'dist/cli.js', '0.84.2']
      ] as const;
      for (const [directory, packageName, entry, version] of manifest) {
        const runtimeDir = join(resources, 'agent-runtimes', directory);
        const packageDir = join(runtimeDir, 'node_modules', ...packageName.split('/'));
        mkdirSync(packageDir, { recursive: true });
        writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ version }));
        const entryPath = join(runtimeDir, 'node_modules', ...packageName.split('/'), entry);
        mkdirSync(join(entryPath, '..'), { recursive: true });
        writeFileSync(entryPath, '');
      }
      expect(() => verifyPackaged(root)).not.toThrow();
      rmSync(join(resources, 'agent-runtimes', 'pi'), { recursive: true, force: true });
      expect(() => verifyPackaged(root)).toThrow(/eng-pi/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
