// @ts-nocheck
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const execFile = vi.fn((_file, _args, _options, callback) => callback(null, 'ok', ''));
vi.mock('node:child_process', () => ({ execFile }));

const { TOOLS } = await import('../src/main/services/executor/tools.js');

const originalSecret = process.env.OPC_NEXUS_TEST_SECRET;
const originalProviderKey = process.env.OPENAI_API_KEY;
const originalHttpProxy = process.env.HTTP_PROXY;
const originalHttpsProxy = process.env.HTTPS_PROXY;
const originalAllProxy = process.env.ALL_PROXY;
const originalCodexHome = process.env.CODEX_HOME;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  execFile.mockClear();
  restoreEnv('OPC_NEXUS_TEST_SECRET', originalSecret);
  restoreEnv('OPENAI_API_KEY', originalProviderKey);
  restoreEnv('HTTP_PROXY', originalHttpProxy);
  restoreEnv('HTTPS_PROXY', originalHttpsProxy);
  restoreEnv('ALL_PROXY', originalAllProxy);
  restoreEnv('CODEX_HOME', originalCodexHome);
  restoreEnv('CLAUDE_CONFIG_DIR', originalClaudeConfigDir);
});

describe('executor tool process boundary', () => {
  it('runs shell commands with the minimal host allowlist instead of the main-process environment', async () => {
    process.env.OPC_NEXUS_TEST_SECRET = 'ambient-internal-secret';
    process.env.OPENAI_API_KEY = 'ambient-provider-secret';
    process.env.HTTP_PROXY = 'http://proxy-user:proxy-pass@proxy.test:8080';
    process.env.HTTPS_PROXY = 'http://proxy-user:proxy-pass@proxy.test:8443';
    process.env.ALL_PROXY = 'socks5://proxy-user:proxy-pass@proxy.test:1080';
    process.env.CODEX_HOME = 'C:/Users/test/.codex';
    process.env.CLAUDE_CONFIG_DIR = 'C:/Users/test/.claude';
    const runCommand = TOOLS.find((tool) => tool.name === 'run_command');

    await runCommand.execute({ command: 'echo ok' }, {
      workspace: process.cwd(), agentId: 'agent-1', taskId: 'task-1', host: null
    });

    const options = execFile.mock.calls[0][2];
    expect(options.env).toBeDefined();
    expect(options.env.OPC_NEXUS_TEST_SECRET).toBeUndefined();
    expect(options.env.OPENAI_API_KEY).toBeUndefined();
    expect(options.env.HTTP_PROXY).toBeUndefined();
    expect(options.env.HTTPS_PROXY).toBeUndefined();
    expect(options.env.ALL_PROXY).toBeUndefined();
    expect(options.env.CODEX_HOME).toBeUndefined();
    expect(options.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(Object.values(options.env)).not.toContain('ambient-internal-secret');
    expect(Object.values(options.env)).not.toContain('ambient-provider-secret');
  });
});
