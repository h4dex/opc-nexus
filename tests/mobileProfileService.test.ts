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

function dbStub() {
  return {
    raw: { prepare: () => ({ get: () => undefined, run: () => ({ changes: 1 }) }) },
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
    const service = new MobileProfileService(dbStub(), root) as any;
    const agent = {
      id: 'agent-config', name: 'Android Operator', kind: 'android_operator', modelOverride: 'gpt-test',
      soulMd: '', systemPrompt: '', agentsMd: '', userMd: ''
    };
    const home = service.profileHome(agent.id);
    mkdirSync(home, { recursive: true });
    service.readRootModelConfig = vi.fn().mockResolvedValue({
      default: 'root-model', provider: 'custom', base_url: 'https://models.example.test/v1',
      api_key: 'must-not-copy', extra_headers: { Authorization: 'must-not-copy' }
    });
    const previous = {
      key: process.env.OPENAI_API_KEY,
      base: process.env.OPENAI_BASE_URL,
      model: process.env.OPENAI_CHAT_MODEL
    };
    process.env.OPENAI_API_KEY = 'process-only-secret';
    process.env.OPENAI_BASE_URL = 'https://gateway.example.test/v1';
    process.env.OPENAI_CHAT_MODEL = 'env-model';
    try {
      await service.ensure(agent);
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
    expect(text).not.toContain('must-not-copy');
    expect(existsSync(join(home, '.env'))).toBe(false);
    expect(existsSync(join(home, 'auth.json'))).toBe(false);
  });
});
