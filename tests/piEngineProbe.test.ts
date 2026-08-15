// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const runtime = vi.hoisted(() => ({
  home: 'C:/opc/pi/probe',
  sessionsDir: 'C:/opc/pi/probe/sessions',
  provider: 'opcnexus',
  model: 'deepseek-chat',
  env: {
    PI_CODING_AGENT_DIR: 'C:/opc/pi/probe',
    PI_CODING_AGENT_SESSION_DIR: 'C:/opc/pi/probe/sessions',
    OPENAI_API_KEY: 'probe-secret'
  }
}));
const cli = vi.hoisted(() => ({ run: vi.fn(), ensureProbe: vi.fn(() => runtime) }));

vi.mock('../src/main/services/piRuntimeProfile.js', () => ({
  PI_ENGINE_ID: 'eng-pi',
  PI_MANAGED_PROVIDER: 'opcnexus',
  PiRuntimeProfileService: class {
    ensureProbe() { return cli.ensureProbe(); }
  }
}));
vi.mock('../src/main/services/cliLauncher.js', () => ({
  runCli: cli.run,
  spawnCli: vi.fn()
}));
vi.mock('../src/main/services/engineEnv.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/main/services/engineEnv.js')>(),
  SECRET_PLACEHOLDER: '***',
  engineEnvSecretRef: (id: string) => `secret:${id}`,
  resolveEngineEnv: () => ({}),
  resolveConfiguredEngineEnv: () => ({}),
  splitSecretEnv: (env: Record<string, string>) => ({ safe: env, secrets: {} })
}));

const { probeCliAuth } = await import('../src/main/services/engineManager.js');

const db = {
  raw: {
    prepare: () => ({ get: () => undefined, all: () => [], run: () => ({ changes: 1 }) })
  },
  getSetting: (_key: string, fallback: unknown) => fallback,
  setSetting: vi.fn(),
  audit: vi.fn()
};

function successfulProbeJson(text = 'OPC_PI_OK'): string {
  return [
    JSON.stringify({ type: 'session', id: 'probe' }),
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
    JSON.stringify({ type: 'agent_end', messages: [] })
  ].join('\n');
}

beforeEach(() => {
  cli.run.mockReset();
  cli.ensureProbe.mockClear();
});

describe('Pi four-signal engine probe', () => {
  it('requires version, credential readiness, and a real model result before HEALTHY', async () => {
    cli.run
      .mockResolvedValueOnce({ ok: true, code: 0, stdout: '0.84.1', stderr: '' })
      .mockResolvedValueOnce({ ok: true, code: 0, stdout: '{"status":"ready","provider":"opcnexus"}', stderr: '' })
      .mockResolvedValueOnce({ ok: true, code: 0, stdout: successfulProbeJson(), stderr: '' });

    const result = await probeCliAuth('eng-pi', 'pi', db as never);

    expect(result).toMatchObject({
      ok: true,
      status: 'HEALTHY',
      authStatus: 'authed',
      signals: { detected: true, launchable: true, authenticated: true, taskVerified: true, detail: 'OPC_PI_OK' }
    });
    expect(cli.run.mock.calls[1][1]).toEqual([
      'auth', 'check', '--provider', 'opcnexus', '--model', 'deepseek-chat', '--json', '--no-refresh'
    ]);
    expect(cli.run.mock.calls[2][1]).toContain('--no-tools');
    expect(cli.run.mock.calls[2][2].env).toMatchObject({
      PI_CODING_AGENT_DIR: runtime.home,
      OPENAI_API_KEY: 'probe-secret'
    });
  });

  it('stops at AUTH_REQUIRED when Pi reports missing credentials', async () => {
    cli.run
      .mockResolvedValueOnce({ ok: true, code: 0, stdout: '0.84.1', stderr: '' })
      .mockResolvedValueOnce({
        ok: false,
        code: 1,
        stdout: '{"status":"not_ready","provider":"opcnexus","reason":"credentials_not_configured"}',
        stderr: ''
      });

    const result = await probeCliAuth('eng-pi', 'pi', db as never);

    expect(result).toMatchObject({
      ok: false,
      status: 'AUTH_REQUIRED',
      signals: { launchable: true, authenticated: false, taskVerified: false }
    });
    expect(cli.run).toHaveBeenCalledTimes(2);
  });

  it('does not promote an in-band HTTP 403 model error returned with exit code zero', async () => {
    cli.run
      .mockResolvedValueOnce({ ok: true, code: 0, stdout: '0.84.1', stderr: '' })
      .mockResolvedValueOnce({ ok: true, code: 0, stdout: '{"status":"ready"}', stderr: '' })
      .mockResolvedValueOnce({
        ok: true,
        code: 0,
        stdout: JSON.stringify({
          type: 'message_end',
          message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'HTTP 403 forbidden' }
        }),
        stderr: ''
      });

    const result = await probeCliAuth('eng-pi', 'pi', db as never);

    expect(result.ok).toBe(false);
    expect(result.status).toBe('AUTH_REQUIRED');
    expect(result.signals.taskVerified).toBe(false);
  });
});
