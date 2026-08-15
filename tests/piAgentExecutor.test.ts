// @ts-nocheck
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));
vi.mock('../src/main/services/engineEnv.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/main/services/engineEnv.js')>()
}));

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill() { this.killed = true; return true; }
  line(value: unknown) { this.stdout.emit('data', Buffer.from(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`)); }
  err(value: string) { this.stderr.emit('data', Buffer.from(value)); }
  exit(code: number) { this.emit('close', code); }
}

let child: FakeChild;
let lastSpawn: { bin: string; args: string[]; opts: Record<string, unknown> } | null;
vi.mock('../src/main/services/cliLauncher.js', () => ({
  spawnCli: (bin: string, args: string[], opts: Record<string, unknown>) => {
    child = new FakeChild();
    lastSpawn = { bin, args, opts };
    return child;
  }
}));

const {
  PiAgentExecutor,
  PI_SAFE_TOOLS,
  buildPiArgs,
  parsePiAuthCheck,
  parsePiProbeOutput,
  piSessionIdFor,
  redactPiText
} = await import('../src/main/services/executor/piAgentExecutor.js');

function makeDb(status = 'HEALTHY', path: string | null = null) {
  return {
    raw: {
      prepare: (sql: string) => ({
        get: () => {
          if (/SELECT status FROM engines/.test(sql)) return { status };
          if (/SELECT path FROM engines/.test(sql)) return { path };
          if (/SELECT config_json FROM engines/.test(sql)) return undefined;
          return undefined;
        },
        all: () => [],
        run: () => ({ changes: 1 })
      })
    },
    getSetting: (_key: string, fallback: unknown) => fallback,
    audit: vi.fn()
  };
}

const workspace = mkdtempSync(join(tmpdir(), 'opc-pi-executor-'));
const runtime = {
  home: join(workspace, 'pi-home'),
  sessionsDir: join(workspace, 'sessions'),
  workspaceGuardExtension: join(workspace, 'pi-home', 'opc-workspace-guard.mjs'),
  provider: 'opcnexus',
  model: 'deepseek-chat',
  env: { PI_CODING_AGENT_DIR: join(workspace, 'pi-home'), OPENAI_API_KEY: 'provider-secret' }
};
const profiles = { ensure: vi.fn(() => runtime) };
const task = (overrides = {}) => ({
  id: 'task-1', title: 'Inspect the repository', source: 'desktop', sessionId: null,
  workspaceOverride: null, ...overrides
});
const agent = (overrides = {}) => ({
  id: 'agent-1', workspace, systemPrompt: 'Be precise', permissionMode: 'standard', ...overrides
});
const callbacks = () => ({
  onStage: vi.fn(), onProgress: vi.fn(), onOutput: vi.fn(), onSession: vi.fn(),
  onDone: vi.fn(), onError: vi.fn()
});

beforeEach(() => {
  lastSpawn = null;
  profiles.ensure.mockClear();
});

describe('Pi command boundary', () => {
  it('uses a stable namespaced session and restores only Pi sessions', () => {
    const fresh = piSessionIdFor(task());
    expect(fresh).toMatch(/^opc-[a-f0-9]{32}$/);
    expect(piSessionIdFor(task())).toBe(fresh);
    expect(piSessionIdFor(task({ sessionId: 'pi-existing.1' }))).toBe('existing.1');
    expect(piSessionIdFor(task({ sessionId: 'codex-thread' }))).toBe(fresh);
  });

  it('disables project resources and exposes only the reviewed read-only tools', () => {
    const args = buildPiArgs(task(), agent(), runtime, 'prompt');
    expect(args.slice(0, 2)).toEqual(['--mode', 'json']);
    expect(args).toContain('--no-approve');
    expect(args).toContain('--no-extensions');
    expect(args.slice(args.indexOf('--extension'), args.indexOf('--extension') + 2)).toEqual([
      '--extension', runtime.workspaceGuardExtension
    ]);
    expect(args).toContain('--no-skills');
    expect(args).toContain('--no-context-files');
    expect(args[args.indexOf('--tools') + 1]).toBe(PI_SAFE_TOOLS.join(','));
    for (const unsafe of ['bash', 'edit', 'write']) {
      expect(args[args.indexOf('--tools') + 1].split(',')).not.toContain(unsafe);
    }
  });

  it('parses auth and authoritative assistant probe output', () => {
    expect(parsePiAuthCheck('{"status":"ready","provider":"opcnexus"}')).toEqual({ ready: true, reason: 'ready' });
    expect(parsePiAuthCheck('{"status":"not_ready","reason":"credentials_not_configured"}')).toEqual({
      ready: false, reason: 'credentials_not_configured'
    });
    const output = [
      JSON.stringify({ type: 'session', id: 's1' }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'OPC_PI_OK' }] } })
    ].join('\n');
    expect(parsePiProbeOutput(output)).toEqual({ ok: true, output: 'OPC_PI_OK', error: null });
  });

  it('redacts task-scoped credentials from diagnostics', () => {
    expect(redactPiText('Bearer provider-secret and engine-secret', {
      OPENAI_API_KEY: 'provider-secret', ENGINE_TOKEN: 'engine-secret'
    })).toBe('Bearer [REDACTED] and [REDACTED]');
  });
});

describe('PiAgentExecutor', () => {
  it('is ready only when the engine state is HEALTHY', () => {
    expect(new PiAgentExecutor(makeDb('HEALTHY'), profiles).isReady()).toBe(true);
    expect(new PiAgentExecutor(makeDb('AUTH_REQUIRED'), profiles).isReady()).toBe(false);
  });

  it('streams JSON deltas, stores the Pi session, and returns the authoritative final message', () => {
    const cb = callbacks();
    new PiAgentExecutor(makeDb('HEALTHY', 'C:/tools/pi.cmd'), profiles).start(task(), agent(), cb);

    expect(lastSpawn.bin).toBe('C:/tools/pi.cmd');
    expect(lastSpawn.opts).toMatchObject({ cwd: workspace, shell: false });
    expect(lastSpawn.opts.env).toMatchObject({ OPENAI_API_KEY: 'provider-secret' });
    child.line({ type: 'session', id: 'session-1' });
    child.line({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'draft' } });
    child.line({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'final result' }] }
    });
    child.line({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'final result' }] }] });
    child.exit(0);

    expect(cb.onSession).toHaveBeenCalledWith('task-1', 'pi-session-1');
    expect(cb.onOutput).toHaveBeenCalledWith('task-1', 'draft');
    expect(cb.onDone).toHaveBeenCalledWith('task-1', 'final result');
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('does not turn an in-band model error into a successful task', () => {
    const cb = callbacks();
    new PiAgentExecutor(makeDb(), profiles).start(task(), agent(), cb);
    child.line({
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'HTTP 403 forbidden' }
    });
    child.exit(0);

    expect(cb.onError).toHaveBeenCalledWith('task-1', expect.stringContaining('HTTP 403'));
    expect(cb.onDone).not.toHaveBeenCalled();
  });

  it('redacts secrets on a non-zero process exit', () => {
    const cb = callbacks();
    new PiAgentExecutor(makeDb(), profiles).start(task(), agent(), cb);
    child.err('provider rejected provider-secret');
    child.exit(1);

    const message = cb.onError.mock.calls[0][1];
    expect(message).toContain('[REDACTED]');
    expect(message).not.toContain('provider-secret');
  });

  it('kills the process and suppresses callbacks after abort', () => {
    const cb = callbacks();
    const executor = new PiAgentExecutor(makeDb(), profiles);
    executor.start(task(), agent(), cb);
    executor.abort('task-1');
    child.exit(0);

    expect(child.killed).toBe(true);
    expect(cb.onDone).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
  });
});
