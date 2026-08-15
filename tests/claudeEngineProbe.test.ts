// @ts-nocheck
/* eslint-disable */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const runCli = vi.hoisted(() => vi.fn());
vi.mock('../src/main/services/cliLauncher.js', () => ({
  runCli,
  spawnCli: vi.fn()
}));

const managedEnv = vi.hoisted(() => ({ ANTHROPIC_API_KEY: 'claude-secret' }));
vi.mock('../src/main/services/engineEnv.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/main/services/engineEnv.js')>(),
  SECRET_PLACEHOLDER: '***',
  engineEnvSecretRef: (id: string) => `secret:engine:${id}:env`,
  resolveEngineEnv: () => ({ ...managedEnv }),
  resolveConfiguredEngineEnv: () => ({ ...managedEnv }),
  splitSecretEnv: (env: Record<string, string>) => ({ safe: env, secrets: {} })
}));

vi.mock('../src/main/services/config.js', () => ({
  loadConfig: () => ({ engines: {}, npmRegistry: '' }),
  sanitizeRegistry: () => null
}));

vi.mock('../src/main/services/provider.js', () => ({
  providerReady: () => false,
  getProviderSettings: () => ({ baseUrl: '', model: '' }),
  readProviderKey: () => null
}));

const { probeCliAuth } = await import('../src/main/services/engineManager.js');

const versionResult = { ok: true, code: 0, stdout: '2.1.220 (Claude Code)', stderr: '' };
const authResult = {
  ok: true,
  code: 0,
  stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' }),
  stderr: ''
};

describe('Claude Code EngineManager probe', () => {
  beforeEach(() => {
    runCli.mockReset();
  });

  it('requires launch, auth status and a real toolless model result before HEALTHY', async () => {
    runCli
      .mockResolvedValueOnce(versionResult)
      .mockResolvedValueOnce(authResult)
      .mockResolvedValueOnce({
        ok: true,
        code: 0,
        stdout: JSON.stringify({ type: 'result', is_error: false, result: 'OPC_CLAUDE_OK' }),
        stderr: ''
      });

    const result = await probeCliAuth('eng-claude', 'C:\\tools\\claude.exe', {} as never);

    expect(result).toMatchObject({
      ok: true,
      status: 'HEALTHY',
      authStatus: 'authed',
      signals: { detected: true, launchable: true, authenticated: true, taskVerified: true }
    });
    expect(runCli).toHaveBeenCalledTimes(3);
    expect(runCli.mock.calls[1][1]).toEqual(['auth', 'status', '--json']);
    expect(runCli.mock.calls[2][1]).toEqual(expect.arrayContaining([
      '-p', '--safe-mode', '--no-session-persistence'
    ]));
    expect(runCli.mock.calls[2][1].at(-1)).toContain('OPC_CLAUDE_OK');
    expect(runCli.mock.calls[2][2].env.ANTHROPIC_API_KEY).toBe('claude-secret');
  });

  it('stops before the paid model probe when Claude is not logged in', async () => {
    runCli
      .mockResolvedValueOnce(versionResult)
      .mockResolvedValueOnce({
        ok: false,
        code: 1,
        stdout: JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }),
        stderr: ''
      });

    const result = await probeCliAuth('eng-claude', 'claude', {} as never);

    expect(result).toMatchObject({
      ok: false,
      status: 'AUTH_REQUIRED',
      authStatus: 'required',
      signals: { taskVerified: false }
    });
    expect(runCli).toHaveBeenCalledTimes(2);
  });

  it('classifies a model 403 as AUTH_REQUIRED and redacts the managed key', async () => {
    runCli
      .mockResolvedValueOnce(versionResult)
      .mockResolvedValueOnce(authResult)
      .mockResolvedValueOnce({
        ok: true,
        code: 0,
        stdout: JSON.stringify({
          type: 'result',
          is_error: true,
          result: 'HTTP 403 Bearer claude-secret rejected'
        }),
        stderr: ''
      });

    const result = await probeCliAuth('eng-claude', 'claude', {} as never);

    expect(result).toMatchObject({
      ok: false,
      status: 'AUTH_REQUIRED',
      authStatus: 'required',
      signals: { authenticated: false, taskVerified: false }
    });
    expect(result.message).not.toContain('claude-secret');
    expect(result.message).toContain('[REDACTED]');
  });
});
