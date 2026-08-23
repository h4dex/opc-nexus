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
const providerState = vi.hoisted(() => ({
  current: null as null | { baseUrl: string; model: string; key: string }
}));
vi.mock('../src/main/services/engineEnv.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/main/services/engineEnv.js')>(),
  SECRET_PLACEHOLDER: '***',
  engineEnvSecretRef: (id: string) => `secret:engine:${id}:env`,
  resolveEngineProvider: () => providerState.current,
  resolveEngineEnv: () => providerState.current
    ? {
        OPENAI_API_KEY: providerState.current.key,
        OPENAI_BASE_URL: providerState.current.baseUrl,
        OPENAI_MODEL: providerState.current.model
      }
    : { ...managedEnv },
  resolveOpenCodeEngineEnv: () => providerState.current
    ? {
        OPENAI_API_KEY: providerState.current.key,
        OPENAI_BASE_URL: providerState.current.baseUrl,
        OPENAI_MODEL: providerState.current.model,
        OPENCODE_CONFIG_CONTENT: '{}'
      }
    : {},
  resolveClaudeEngineEnv: () => providerState.current
    ? {
        ANTHROPIC_API_KEY: providerState.current.key,
        ANTHROPIC_AUTH_TOKEN: providerState.current.key,
        ANTHROPIC_BASE_URL: providerState.current.baseUrl.replace(/\/v1$/i, ''),
        ANTHROPIC_MODEL: providerState.current.model
      }
    : { ...managedEnv },
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
    providerState.current = null;
  });

  it('uses a complete managed Codex Provider and an isolated auth home', async () => {
    providerState.current = {
      baseUrl: 'https://provider.test/v1',
      model: 'worker-model',
      key: 'managed-codex-key'
    };
    runCli
      .mockResolvedValueOnce({ ok: true, code: 0, stdout: 'codex-cli 0.145.0', stderr: '' })
      .mockResolvedValueOnce({ ok: true, code: 0, stdout: '{"type":"turn.completed"}', stderr: '' });

    const result = await probeCliAuth('eng-codex', 'codex', {} as never);

    expect(result.ok).toBe(true);
    expect(runCli.mock.calls[1][1]).toEqual(expect.arrayContaining([
      'model_providers.opcnexus.name="OPC-Nexus"',
      'model_providers.opcnexus.wire_api="responses"',
      '--model',
      'worker-model'
    ]));
    expect(runCli.mock.calls[1][1]).not.toContain('--ignore-user-config');
    expect(runCli.mock.calls[1][2].env.OPENAI_API_KEY).toBe('managed-codex-key');
    expect(runCli.mock.calls[1][2].env.CODEX_HOME).toContain('aibox-data');
    expect(runCli.mock.calls[1][2].env.CODEX_HOME).toContain('codex');
    expect(runCli.mock.calls[1][2].timeoutMs).toBe(120_000);
  });

  it('reports the real managed Codex upstream error when the process misses the hard timeout', async () => {
    providerState.current = {
      baseUrl: 'https://provider.test/v1',
      model: 'worker-model',
      key: 'managed-codex-key'
    };
    runCli
      .mockResolvedValueOnce({ ok: true, code: 0, stdout: 'codex-cli 0.145.0', stderr: '' })
      .mockResolvedValueOnce({
        ok: false,
        code: null,
        stdout: '{"type":"error","message":"unexpected status 502 Bad Gateway"}',
        stderr: '',
        error: '执行超时（120 秒）'
      });

    const result = await probeCliAuth('eng-codex', 'codex', {} as never);

    expect(result).toMatchObject({
      ok: false,
      status: 'DEGRADED',
      authStatus: 'unknown',
      signals: { taskVerified: false }
    });
    expect(result.message).toContain('502 Bad Gateway');
    expect(result.message).toContain('执行超时（120 秒）');
    expect(result.message).not.toContain('managed-codex-key');
  });

  it('runs managed OpenCode probes without external plugins', async () => {
    providerState.current = {
      baseUrl: 'https://provider.test/v1',
      model: 'worker-model',
      key: 'managed-opencode-key'
    };
    runCli
      .mockResolvedValueOnce({ ok: true, code: 0, stdout: 'OpenCode 1.18.4', stderr: '' })
      .mockResolvedValueOnce({ ok: true, code: 0, stdout: 'pong', stderr: '' });

    const result = await probeCliAuth('eng-opencode', 'opencode', {} as never);

    expect(result.ok).toBe(true);
    expect(runCli.mock.calls[1][1]).toEqual([
      'run', '--pure', '-m', 'opcnexus/worker-model', 'ping'
    ]);
    expect(runCli.mock.calls[1][2].env.OPENAI_API_KEY).toBe('managed-opencode-key');
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

  it('isolates managed Claude probes from the user Claude settings directory', async () => {
    providerState.current = {
      baseUrl: 'https://provider.test/v1',
      model: 'worker-model',
      key: 'managed-claude-key'
    };
    runCli
      .mockResolvedValueOnce(versionResult)
      .mockResolvedValueOnce({
        ok: true,
        code: 0,
        stdout: JSON.stringify({ type: 'result', is_error: false, result: 'OPC_CLAUDE_OK' }),
        stderr: ''
      });

    const result = await probeCliAuth('eng-claude', 'claude', {} as never);

    expect(result.ok).toBe(true);
    const env = runCli.mock.calls[1][2].env;
    expect(env.CLAUDE_CONFIG_DIR).toContain('aibox-data');
    expect(env.CLAUDE_CONFIG_DIR).toContain('claude');
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('managed-claude-key');
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
