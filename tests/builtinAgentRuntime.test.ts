import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const actual = await import('./__mocks__/electron.js');
  const root = mkdtempSync(join(tmpdir(), 'opc-builtin-runtime-'));
  return {
    ...actual,
    app: {
      ...actual.app,
      getAppPath: () => root,
      getPath: (name: string) => name === 'userData' ? join(root, 'userData') : root
    }
  };
});

const { BUILTIN_AGENT_RUNTIME_SPECS, builtinAgentRuntimeSpec, locateBuiltinAgentRuntime } =
  await import('../src/main/services/builtinAgentRuntime.js');

describe('application-owned Codex/Pi runtime resolution', () => {
  it('keeps pinned package identity and license metadata', () => {
    expect(BUILTIN_AGENT_RUNTIME_SPECS).toEqual(expect.arrayContaining([
      expect.objectContaining({ engineId: 'eng-codex', packageName: '@openai/codex', license: 'Apache-2.0' }),
      expect.objectContaining({ engineId: 'eng-pi', packageName: '@earendil-works/pi-coding-agent', license: 'MIT' })
    ]));
    expect(builtinAgentRuntimeSpec('eng-hermes-cli')).toBeNull();
  });

  it('prefers an app-owned entry and reports the installed package version', async () => {
    const root = (await import('electron')).app.getAppPath();
    const spec = builtinAgentRuntimeSpec('eng-pi')!;
    const packageDir = join(root, 'runtime', 'agent-clis', spec.directory, 'node_modules', ...spec.packageName.split('/'));
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(join(root, 'runtime', 'agent-clis', spec.directory, ...spec.entry.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ version: '0.84.2' }));
    const entry = join(root, 'runtime', 'agent-clis', spec.directory, ...spec.entry.split('/'));
    writeFileSync(entry, '');
    expect(locateBuiltinAgentRuntime('eng-pi')).toMatchObject({
      source: 'app', version: '0.84.2', entryPath: entry
    });
    rmSync(root, { recursive: true, force: true });
  });
});
