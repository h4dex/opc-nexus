import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));
vi.mock('../src/main/services/config.js', () => ({
  loadConfig: () => ({ engines: {}, npmRegistry: 'https://registry.npmjs.org' }),
  sanitizeRegistry: (value: unknown) => typeof value === 'string' ? value : null
}));

import {
  CLI_FAILURE_BODY_PATTERN,
  ENGINE_CATALOG,
  EngineManager,
  RETIRED_ENGINE_IDS,
  sanitizeEngineRouting,
  cliInstallWasDetected,
  cliLaunchProbeTimeoutMs
} from '../src/main/services/engineManager.js';

function listDb(rows: Record<string, unknown>[]) {
  return {
    raw: {
      prepare: () => ({
        all: () => rows,
        get: () => undefined,
        run: vi.fn()
      })
    },
    getSetting: (_key: string, fallback: unknown) => fallback,
    setSetting: vi.fn(),
    audit: vi.fn(),
    transaction: (run: () => unknown) => run()
  };
}

describe('EngineManager current product boundary', () => {
  it('publishes only current built-in and CLI worker engines', () => {
    expect(ENGINE_CATALOG.map((entry) => entry.id).sort()).toEqual([
      'eng-claude',
      'eng-codex',
      'eng-hermes-cli',
      'eng-nexus',
      'eng-opencode',
      'eng-pi'
    ]);
    expect(ENGINE_CATALOG.every((entry) => entry.dataBoundary.length > 0)).toBe(true);
  });

  it('keeps retired product engines out of the catalog', () => {
    const ids = new Set(ENGINE_CATALOG.map((entry) => entry.id));
    for (const retired of RETIRED_ENGINE_IDS) expect(ids.has(retired)).toBe(false);
    expect([...ids].some((id) => /deepseek-harness|dsh/i.test(id))).toBe(false);
  });

  it('describes Nexus as built in and Hermes as a real local CLI', () => {
    expect(ENGINE_CATALOG.find((entry) => entry.id === 'eng-nexus')).toMatchObject({
      type: 'nexus',
      bin: null,
      npmPackage: null
    });
    expect(ENGINE_CATALOG.find((entry) => entry.id === 'eng-hermes-cli')).toMatchObject({
      type: 'hermes-cli',
      bin: 'hermes',
      npmPackage: null
    });
  });

  it('cleans retired scheduler/runtime targets without touching valid worker routes', () => {
    expect(sanitizeEngineRouting({
      desktop: 'eng-deepseek-harness',
      channel: 'eng-opencode',
      schedule: 'eng-hermes',
      team: 'missing-engine',
      ignored: 'eng-opencode'
    }, new Set(['eng-opencode']))).toEqual({ channel: 'eng-opencode' });
  });

  it('uses the official packages for Codex and Claude workers', () => {
    expect(ENGINE_CATALOG.find((entry) => entry.id === 'eng-codex')?.npmPackage).toBe('@openai/codex');
    expect(ENGINE_CATALOG.find((entry) => entry.id === 'eng-claude')?.npmPackage).toBe('@anthropic-ai/claude-code');
  });

  it('does not treat installation alone as authenticated health', () => {
    expect(cliInstallWasDetected('AUTH_REQUIRED')).toBe(true);
    expect(cliInstallWasDetected('HEALTHY')).toBe(true);
    expect(cliInstallWasDetected('NOT_INSTALLED')).toBe(false);
    expect(cliInstallWasDetected('ERROR')).toBe(false);
  });

  it('recognizes provider failures without matching normal output', () => {
    expect(CLI_FAILURE_BODY_PATTERN.test('HTTP 401: Missing Authentication header')).toBe(true);
    expect(CLI_FAILURE_BODY_PATTERN.test('No usable credentials found for provider')).toBe(true);
    expect(CLI_FAILURE_BODY_PATTERN.test('pong')).toBe(false);
  });

  it('gives first-run employee profiles enough launch time', () => {
    expect(cliLaunchProbeTimeoutMs('eng-hermes-cli', { HERMES_HOME: 'C:\\profiles\\employee' })).toBe(45_000);
    expect(cliLaunchProbeTimeoutMs('eng-hermes-cli', {})).toBe(15_000);
    expect(cliLaunchProbeTimeoutMs('eng-pi', {})).toBe(45_000);
    expect(cliLaunchProbeTimeoutMs('eng-codex', {})).toBe(15_000);
  });

  it('returns renderer-safe engine rows and reports missing install guides honestly', () => {
    const rows = [{
      id: 'eng-codex',
      type: 'codex',
      name: 'OpenAI Codex CLI',
      version: '1.2.3',
      path: 'C:/bin/codex.exe',
      status: 'HEALTHY',
      auth_status: 'authed',
      is_default: 1,
      data_boundary: 'local',
      config_json: JSON.stringify({ providerId: 'provider-main' })
    }];
    const manager = new EngineManager(listDb(rows) as never);
    expect(manager.list()).toEqual([expect.objectContaining({
      id: 'eng-codex',
      status: 'HEALTHY',
      authStatus: 'authed',
      isDefault: true
    })]);
    expect(manager.installGuide('missing-engine')).toBeNull();
  });
});
