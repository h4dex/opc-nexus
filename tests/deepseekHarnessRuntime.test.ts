// @ts-nocheck
/* eslint-disable */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'aibox-harness-runtime-test-'));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => root
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    decryptString: (value: Buffer) => value.toString().replace(/^enc:/, '')
  }
}));

const {
  DEEPSEEK_HARNESS_ENGINE_ID,
  cleanupHarnessEnv,
  deepseekHarnessCommand,
  deepseekHarnessEnv,
  deepseekHarnessProbeEnv,
  deepseekHarnessProcessEnv,
  deepseekHarnessProviderReady,
  deepseekHarnessSnapshotEnv,
  harnessNodeSupported
} = await import('../src/main/services/deepseekHarnessRuntime.js');

function makeDb(provider = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', key: 'key' }, skills = [], options = {}) {
  return {
    raw: {
      prepare: (sql: string) => ({
        get: () => {
          if (/COUNT\(\*\).*FROM providers/.test(sql)) return { c: options.providerCount ?? 1 };
          if (/FROM agents WHERE id/.test(sql)) return { provider_id: options.providerId ?? 'provider-1', model_override: null };
          if (/FROM providers WHERE id/.test(sql) || /FROM providers WHERE is_default/.test(sql)) {
            if (options.missingProvider) return undefined;
            return { base_url: provider.baseUrl, model: provider.model, api_key_ref: 'secret:provider:provider-1' };
          }
          return undefined;
        },
        all: () => (/FROM skills/.test(sql) ? skills : [])
      })
    },
    getSetting: (key: string, fallback: unknown) => key === 'secret:provider:provider-1'
      ? Buffer.from(`enc:${provider.key}`).toString('base64')
      : fallback
  };
}

function agent(overrides = {}) {
  return {
    id: 'agent-1',
    engineId: DEEPSEEK_HARNESS_ENGINE_ID,
    permissionMode: 'standard',
    modelOverride: undefined,
    ...overrides
  };
}

function skillFile(env: Record<string, string>, name: string): string {
  return join(env.AIBOX_DSH_MANAGED_SKILLS_DIR, name, 'SKILL.md');
}

describe('DeepSeek Harness managed runtime', () => {
  it('enforces the Electron Node compatibility floor', () => {
    expect(harnessNodeSupported('22.18.0')).toBe(false);
    expect(harnessNodeSupported('22.19.0')).toBe(true);
    expect(harnessNodeSupported('23.0.0')).toBe(false);
    expect(harnessNodeSupported('24.0.0')).toBe(true);
    expect(harnessNodeSupported('invalid')).toBe(false);
  });

  it('uses Electron as Node for the pinned local ACP entry', () => {
    const command = deepseekHarnessCommand();
    expect(command?.[0]).toBe(process.execPath);
    expect(command?.[1].replaceAll('\\', '/')).toContain('deepseek-harness/dist/opc-acp-entry.mjs');
    expect(command?.at(-2)).toBe('--config');
  });

  it('routes the official DeepSeek endpoint without leaking OpenAI aliases', () => {
    const env = deepseekHarnessEnv(makeDb({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', key: 'ds-key' }) as never, agent() as never);
    expect(env).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      AIBOX_DSH_PROVIDER: 'deepseek-official',
      AIBOX_DSH_MODEL: 'deepseek-chat',
      DEEPSEEK_API_KEY: 'ds-key',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com'
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    cleanupHarnessEnv(env, true);
  });

  it('routes OpenAI-compatible endpoints through the fixed aibox provider', () => {
    const env = deepseekHarnessEnv(
      makeDb({ baseUrl: 'https://gateway.example/v1', model: 'custom-model', key: 'oa-key' }) as never,
      agent({ modelOverride: 'agent-model' }) as never
    );
    expect(env).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      AIBOX_DSH_PROVIDER: 'aibox-openai',
      AIBOX_DSH_MODEL: 'agent-model',
      OPENAI_API_KEY: 'oa-key',
      OPENAI_BASE_URL: 'https://gateway.example/v1'
    });
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    cleanupHarnessEnv(env, true);
  });

  it('does not forward unrelated ambient credentials to the sidecar', () => {
    const previousKey = process.env.UNRELATED_VENDOR_API_KEY;
    const previousPath = process.env.PATH;
    process.env.UNRELATED_VENDOR_API_KEY = 'must-not-leak';
    process.env.PATH = 'C:\\runtime-bin';
    try {
      const env = deepseekHarnessProcessEnv({ ELECTRON_RUN_AS_NODE: '1', DEEPSEEK_API_KEY: 'current-provider-key' });
      expect(env.PATH).toBe('C:\\runtime-bin');
      expect(env.DEEPSEEK_API_KEY).toBe('current-provider-key');
      expect(env.UNRELATED_VENDOR_API_KEY).toBeUndefined();
    } finally {
      if (previousKey === undefined) delete process.env.UNRELATED_VENDOR_API_KEY;
      else process.env.UNRELATED_VENDOR_API_KEY = previousKey;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it('publishes only enabled OPC-owned SKILL.md bundles', () => {
    const env = deepseekHarnessSnapshotEnv(makeDb(undefined, [
      { id: 'skill-1', name: 'Release Notes', description: 'Draft release notes', content: '# Steps\nWrite facts.' }
    ]) as never, agent() as never);
    const file = skillFile(env, 'opc-skill-1-release-notes');
    expect(readFileSync(file, 'utf8')).toContain('name: opc-skill-1-release-notes');
    expect(readFileSync(file, 'utf8')).toContain('# Steps\nWrite facts.');
    expect(readdirSync(env.AIBOX_DSH_MANAGED_SKILLS_DIR)).toEqual(['opc-skill-1-release-notes']);
    cleanupHarnessEnv(env, true);
    expect(existsSync(env.AIBOX_DSH_SESSIONS_ROOT)).toBe(false);
  });

  it('keeps concurrent immutable snapshots and Session indexes isolated', () => {
    const db = makeDb(undefined, [
      { id: 'skill-1', name: 'Managed', description: 'Managed only', content: '# Managed' }
    ]);
    const env1 = deepseekHarnessSnapshotEnv(db as never, agent() as never);
    const env2 = deepseekHarnessSnapshotEnv(db as never, agent() as never);

    expect(env1.AIBOX_DSH_MANAGED_SKILLS_DIR).not.toBe(env2.AIBOX_DSH_MANAGED_SKILLS_DIR);
    expect(env1.AIBOX_DSH_SESSIONS_ROOT).not.toBe(env2.AIBOX_DSH_SESSIONS_ROOT);
    expect(existsSync(skillFile(env1, 'opc-skill-1-managed'))).toBe(true);
    expect(existsSync(skillFile(env2, 'opc-skill-1-managed'))).toBe(true);

    cleanupHarnessEnv(env1, true);
    expect(existsSync(env1.AIBOX_DSH_MANAGED_SKILLS_DIR)).toBe(false);
    expect(existsSync(env1.AIBOX_DSH_SESSIONS_ROOT)).toBe(false);
    expect(existsSync(skillFile(env2, 'opc-skill-1-managed'))).toBe(true);
    cleanupHarnessEnv(env2, true);
  });

  it('keeps a live snapshot when publishing a duplicate bundle fails', () => {
    const env = deepseekHarnessSnapshotEnv(makeDb(undefined, [
      { id: 'same', name: 'Name', description: '', content: '# first' }
    ]) as never, agent() as never);
    expect(() => deepseekHarnessSnapshotEnv(makeDb(undefined, [
      { id: 'same', name: 'Name', description: '', content: '# first' },
      { id: 'same', name: 'Name', description: '', content: '# duplicate' }
    ]) as never, agent() as never)).toThrow('Duplicate managed Harness Skill id');
    expect(existsSync(skillFile(env, 'opc-same-name'))).toBe(true);
    cleanupHarnessEnv(env, true);
  });

  it('uses an empty immutable Skill snapshot for each probe', () => {
    const env1 = deepseekHarnessProbeEnv(makeDb() as never);
    const env2 = deepseekHarnessProbeEnv(makeDb() as never);
    expect(readdirSync(env1.AIBOX_DSH_MANAGED_SKILLS_DIR)).toEqual([]);
    expect(readdirSync(env2.AIBOX_DSH_MANAGED_SKILLS_DIR)).toEqual([]);
    expect(env1.AIBOX_DSH_MANAGED_SKILLS_DIR).not.toBe(env2.AIBOX_DSH_MANAGED_SKILLS_DIR);
    expect(env1.AIBOX_DSH_SESSIONS_ROOT).not.toBe(env2.AIBOX_DSH_SESSIONS_ROOT);
    cleanupHarnessEnv(env1);
    expect(existsSync(env2.AIBOX_DSH_MANAGED_SKILLS_DIR)).toBe(true);
    cleanupHarnessEnv(env2);
  });

  it('rejects traversal Agent ids before creating runtime directories', () => {
    expect(() => deepseekHarnessSnapshotEnv(makeDb() as never, agent({ id: '..\\..\\escape' }) as never)).toThrow('Invalid Agent id');
    expect(existsSync(join(root, 'escape'))).toBe(false);
  });

  it('fails closed when a managed ancestor is a junction', () => {
    const external = join(root, 'external-managed-root');
    const aiboxData = join(root, 'aibox-data');
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, 'sentinel.txt'), 'keep', 'utf8');
    symlinkSync(external, aiboxData, 'junction');
    expect(() => deepseekHarnessSnapshotEnv(makeDb() as never, agent() as never)).toThrow('must be a real directory');
    expect(readFileSync(join(external, 'sentinel.txt'), 'utf8')).toBe('keep');
    expect(readdirSync(external)).toEqual(['sentinel.txt']);
    rmSync(aiboxData, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  });

  it('rejects cleanup paths outside the exact lease layout', () => {
    const rogue = join(root, 'aibox-data', 'unrelated');
    mkdirSync(rogue, { recursive: true });
    expect(() => cleanupHarnessEnv({ AIBOX_DSH_MANAGED_SKILLS_DIR: rogue })).toThrow();
    expect(existsSync(rogue)).toBe(true);
  });

  it('rejects exact-layout cleanup paths that were not issued as active leases', () => {
    const forgedSkill = join(
      root,
      'aibox-data',
      'deepseek-harness',
      'agents',
      'agent-1',
      'skill-snapshots',
      'snapshot-00000000-0000-4000-8000-000000000001'
    );
    const forgedSession = join(
      root,
      'aibox-data',
      'deepseek-harness',
      'sessions',
      'agent-1',
      'session-00000000-0000-4000-8000-000000000002'
    );
    mkdirSync(forgedSkill, { recursive: true });
    mkdirSync(forgedSession, { recursive: true });
    writeFileSync(join(forgedSkill, 'sentinel.txt'), 'keep', 'utf8');
    writeFileSync(join(forgedSession, 'sentinel.txt'), 'keep', 'utf8');

    expect(() => cleanupHarnessEnv({
      AIBOX_DSH_MANAGED_SKILLS_DIR: forgedSkill,
      AIBOX_DSH_SESSIONS_ROOT: forgedSession
    }, true)).toThrow('not an active process lease');
    expect(readFileSync(join(forgedSkill, 'sentinel.txt'), 'utf8')).toBe('keep');
    expect(readFileSync(join(forgedSession, 'sentinel.txt'), 'utf8')).toBe('keep');
  });

  it('fails closed for missing or incomplete Provider bindings', () => {
    const empty = makeDb({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', key: '   ' });
    expect(deepseekHarnessProviderReady(empty as never, agent() as never)).toBe(false);
    const missing = makeDb(undefined, [], { missingProvider: true, providerId: 'provider-missing' });
    expect(deepseekHarnessProviderReady(missing as never, agent() as never)).toBe(false);
  });
});

afterEach(() => {
  rmSync(join(root, 'aibox-data'), { recursive: true, force: true });
  rmSync(join(root, 'external-managed-root'), { recursive: true, force: true });
});
