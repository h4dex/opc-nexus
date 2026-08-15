// @ts-nocheck
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const { PiRuntimeProfileService } = await import('../src/main/services/piRuntimeProfile.js');

function db(providerId: string | null = 'provider-1') {
  return {
    raw: {
      prepare: (sql: string) => ({
        get: () => /FROM agents/.test(sql) ? { provider_id: providerId } : undefined,
        all: () => [],
        run: () => ({ changes: 1 })
      })
    },
    getSetting: (_key: string, fallback: unknown) => fallback,
    audit: vi.fn()
  };
}

describe('PiRuntimeProfileService', () => {
  it('writes managed routing without persisting the provider key', () => {
    const root = mkdtempSync(join(tmpdir(), 'opc-pi-profile-'));
    const providers = {
      resolveForAgent: vi.fn(() => ({
        baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', key: 'secret-key'
      }))
    };
    const service = new PiRuntimeProfileService(db() as never, providers, root);

    const prepared = service.ensure({ id: 'agent-1', modelOverride: undefined });
    const models = readFileSync(join(prepared.home, 'models.json'), 'utf8');
    const settings = readFileSync(join(prepared.home, 'settings.json'), 'utf8');
    const guard = readFileSync(prepared.workspaceGuardExtension, 'utf8');

    expect(models).toContain('https://api.deepseek.com/v1');
    expect(models).toContain('deepseek-chat');
    expect(models).toContain('$OPENAI_API_KEY');
    expect(models).not.toContain('secret-key');
    expect(settings).not.toContain('secret-key');
    expect(guard).not.toContain('secret-key');
    expect(guard).toContain("new Set(['read', 'grep', 'find', 'ls'])");
    expect(prepared.env).toMatchObject({
      PI_CODING_AGENT_DIR: prepared.home,
      PI_CODING_AGENT_SESSION_DIR: prepared.sessionsDir,
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
      OPENAI_API_KEY: 'secret-key'
    });
  });

  it('blocks absolute and traversal paths for every Pi read-only tool', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opc-pi-profile-'));
    const workspace = mkdtempSync(join(tmpdir(), 'opc-pi-workspace-'));
    mkdirSync(join(workspace, 'src'));
    writeFileSync(join(workspace, 'src', 'index.ts'), 'export {};\n');
    const service = new PiRuntimeProfileService(db() as never, {
      resolveForAgent: () => ({ baseUrl: 'https://provider.test/v1', model: 'm', key: 'secret-key' })
    }, root);
    const prepared = service.ensure({ id: 'agent-guard', modelOverride: undefined });
    const cases: Array<{ toolName: string; path: string }> = [];
    for (const toolName of ['read', 'grep', 'find', 'ls']) {
      for (const path of ['../outside.txt', 'src/../outside.txt', '/etc/passwd', 'C:\\Windows\\win.ini']) {
        cases.push({ toolName, path });
      }
      cases.push({ toolName, path: 'src' });
    }

    const extensionUrl = pathToFileURL(prepared.workspaceGuardExtension).href;
    const script = `
      const extension = await import(${JSON.stringify(extensionUrl)});
      let guard;
      extension.default({ on(name, handler) { if (name === 'tool_call') guard = handler; } });
      if (typeof guard !== 'function') throw new Error('Pi workspace guard did not register');
      const cases = ${JSON.stringify(cases)};
      const results = cases.map(({ toolName, path }) => guard(
        { toolName, input: { path } },
        { cwd: ${JSON.stringify(workspace)} }
      ));
      process.stdout.write(JSON.stringify(results));
    `;
    const results = JSON.parse(execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', script],
      { encoding: 'utf8' }
    ));

    for (let index = 0; index < results.length; index += 5) {
      for (const blocked of results.slice(index, index + 4)) {
        expect(blocked).toMatchObject({ block: true });
      }
      expect(results[index + 4]).toBeNull();
    }
  });

  it('uses stable isolated paths and honors the employee provider/model binding', () => {
    const root = mkdtempSync(join(tmpdir(), 'opc-pi-profile-'));
    const providers = {
      resolveForAgent: vi.fn(() => ({ baseUrl: 'https://provider.test/v1', model: 'bound-model', key: 'k' }))
    };
    const service = new PiRuntimeProfileService(db('bound-provider') as never, providers, root);

    const first = service.ensure({ id: 'agent/../one', modelOverride: 'override-model' });
    const same = service.ensure({ id: 'agent/../one', modelOverride: 'override-model' });
    const second = service.ensure({ id: 'agent-two', modelOverride: undefined });

    expect(first.home).toBe(same.home);
    expect(first.home).not.toBe(second.home);
    expect(first.home.startsWith(root)).toBe(true);
    expect(providers.resolveForAgent).toHaveBeenCalledWith('bound-provider', 'override-model');
  });

  it('fails closed when no complete provider is available', () => {
    const root = mkdtempSync(join(tmpdir(), 'opc-pi-profile-'));
    const service = new PiRuntimeProfileService(db() as never, { resolveForAgent: () => null }, root);

    expect(() => service.ensure({ id: 'agent-1', modelOverride: undefined })).toThrow('Configured model Provider is unavailable');
  });

  it('creates an isolated default-provider probe profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'opc-pi-profile-'));
    const providers = {
      resolveForAgent: vi.fn(() => ({ baseUrl: 'https://provider.test/v1', model: 'probe-model', key: 'probe-key' }))
    };
    const service = new PiRuntimeProfileService(db(null) as never, providers, root);

    const prepared = service.ensureProbe();

    expect(providers.resolveForAgent).toHaveBeenCalledWith(null, null);
    expect(readFileSync(join(prepared.home, 'models.json'), 'utf8')).not.toContain('probe-key');
  });
});
