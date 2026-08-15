// @ts-nocheck
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const { MobileProfileService } = await import('../src/main/services/mobileProfileService.js');

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function dbStub(agentBinding?: { provider_id?: string | null; model_override?: string | null }) {
  return {
    raw: {
      prepare: (sql: string) => ({
        get: () => /SELECT provider_id, model_override FROM agents/.test(sql) ? agentBinding : undefined,
        run: () => ({ changes: 1 })
      })
    },
    getSetting: (_key: string, fallback: unknown) => fallback
  } as never;
}

describe('MobileProfileService compensation', () => {
  it('restores an existing profile byte-for-byte on rollback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opcnexus-profile-'));
    roots.push(root);
    const service = new MobileProfileService(dbStub(), root);
    const home = service.profileHome('agent-123');
    mkdirSync(join(home, 'plugins'), { recursive: true });
    writeFileSync(join(home, 'config.yaml'), 'old-config\n');
    writeFileSync(join(home, 'plugins', 'old.txt'), 'old-plugin');

    const checkpoint = service.checkpoint('agent-123');
    writeFileSync(join(home, 'config.yaml'), 'new-config\n');
    writeFileSync(join(home, 'new.txt'), 'new-file');
    service.rollback(checkpoint);

    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe('old-config\n');
    expect(readFileSync(join(home, 'plugins', 'old.txt'), 'utf8')).toBe('old-plugin');
    expect(existsSync(join(home, 'new.txt'))).toBe(false);
  });

  it('removes a newly-created profile on rollback and deletes backups on commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opcnexus-profile-'));
    roots.push(root);
    const service = new MobileProfileService(dbStub(), root);
    const fresh = service.checkpoint('fresh-agent');
    mkdirSync(service.profileHome('fresh-agent'), { recursive: true });
    writeFileSync(join(service.profileHome('fresh-agent'), 'partial.txt'), 'partial');
    service.rollback(fresh);
    expect(existsSync(service.profileHome('fresh-agent'))).toBe(false);

    const existingHome = service.profileHome('existing-agent');
    mkdirSync(existingHome, { recursive: true });
    writeFileSync(join(existingHome, 'state.txt'), 'state');
    const existing = service.checkpoint('existing-agent');
    expect(existing.backupPath && existsSync(existing.backupPath)).toBe(true);
    service.commit(existing);
    expect(existing.backupPath).toBeNull();
    expect(readFileSync(join(existingHome, 'state.txt'), 'utf8')).toBe('state');
  });

  it('writes only non-sensitive model routing and keeps credentials out of the profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opcnexus-profile-'));
    roots.push(root);
    const resolveForAgent = vi.fn().mockReturnValue({
      baseUrl: 'https://gateway.example.test/v1',
      model: 'gpt-test',
      key: 'provider-only-secret'
    });
    const service = new MobileProfileService(
      dbStub({ provider_id: 'prov-mobile', model_override: null }),
      root,
      { resolveForAgent } as never
    );
    const agent = {
      id: 'agent-config', name: 'Android Operator', kind: 'android_operator', modelOverride: 'gpt-test',
      soulMd: '', systemPrompt: '', agentsMd: '', userMd: ''
    };
    const home = service.profileHome(agent.id);
    mkdirSync(home, { recursive: true });
    const previous = {
      key: process.env.OPENAI_API_KEY,
      base: process.env.OPENAI_BASE_URL,
      model: process.env.OPENAI_CHAT_MODEL
    };
    process.env.OPENAI_API_KEY = 'process-only-secret';
    process.env.OPENAI_BASE_URL = 'https://gateway.example.test/v1';
    process.env.OPENAI_CHAT_MODEL = 'env-model';
    let runtime;
    try {
      runtime = await service.ensure(agent as never);
    } finally {
      if (previous.key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous.key;
      if (previous.base === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = previous.base;
      if (previous.model === undefined) delete process.env.OPENAI_CHAT_MODEL; else process.env.OPENAI_CHAT_MODEL = previous.model;
    }

    const text = readFileSync(join(home, 'config.yaml'), 'utf8');
    const config = JSON.parse(text.split('\n').slice(1).join('\n'));
    expect(config.model).toEqual({ default: 'gpt-test', provider: 'opcnexus' });
    expect(config.providers.opcnexus).toMatchObject({
      api: 'https://gateway.example.test/v1', key_env: 'OPENAI_API_KEY', default_model: 'gpt-test'
    });
    expect(text).not.toContain('process-only-secret');
    expect(text).not.toContain('provider-only-secret');
    expect(existsSync(join(home, '.env'))).toBe(false);
    expect(existsSync(join(home, 'auth.json'))).toBe(false);
    expect(resolveForAgent).toHaveBeenCalledWith('prov-mobile', 'gpt-test');
    expect(runtime).toMatchObject({
      home,
      model: 'gpt-test',
      provider: 'opcnexus',
      env: {
        HERMES_HOME: home,
        HERMES_INFERENCE_MODEL: 'gpt-test',
        HERMES_INFERENCE_PROVIDER: 'opcnexus',
        OPENAI_API_KEY: 'provider-only-secret',
        OPENAI_BASE_URL: 'https://gateway.example.test/v1',
        OPENAI_API_BASE: 'https://gateway.example.test/v1'
      }
    });
  });

  it('fails closed instead of inheriting global Hermes or process credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opcnexus-profile-'));
    roots.push(root);
    const resolveForAgent = vi.fn().mockReturnValue(null);
    const service = new MobileProfileService(dbStub(), root, { resolveForAgent } as never);
    const oldKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'ambient-secret-that-must-not-run';
    try {
      await expect(service.ensure({
        id: 'agent-unconfigured',
        kind: 'android_operator',
        name: 'Android Operator',
        modelOverride: undefined
      } as never)).rejects.toThrow(/模型供应商|Provider|provider/i);
    } finally {
      if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldKey;
    }
    expect(existsSync(service.profileHome('agent-unconfigured'))).toBe(false);
  });

  it('preserves the persistent Hermes user profile across task preparation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opcnexus-profile-'));
    roots.push(root);
    const service = new MobileProfileService(
      dbStub({ provider_id: 'prov-mobile', model_override: null }),
      root,
      { resolveForAgent: vi.fn().mockReturnValue({
        baseUrl: 'https://gateway.example.test/v1',
        model: 'gpt-test',
        key: 'provider-secret'
      }) } as never
    );
    const agent = {
      id: 'agent-memory', name: 'Android Operator', kind: 'android_operator',
      userMd: 'Initial operator context', soulMd: '', systemPrompt: '', agentsMd: ''
    } as never;
    const home = service.profileHome(agent.id);
    mkdirSync(join(home, 'memories'), { recursive: true });
    writeFileSync(join(home, 'memories', 'USER.md'), 'Learned preference from an earlier task', 'utf8');

    await service.ensure(agent);

    expect(readFileSync(join(home, 'memories', 'USER.md'), 'utf8'))
      .toBe('Learned preference from an earlier task');
    expect(readFileSync(join(home, 'USER.md'), 'utf8')).toBe('Initial operator context');
  });
});
