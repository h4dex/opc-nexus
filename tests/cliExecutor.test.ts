/**
 * CliExecutor 测试(Codex CLI / Claude Code CLI / 泛化 CLI)
 *
 * 核心执行路径,评审文档标记的覆盖缺口。重点在两处易错且后果严重的逻辑:
 * 1. buildCommand 的权限映射 —— 映射错会静默放宽沙箱
 *    (如 readonly 员工拿到 danger-full-access,可任意改文件)
 * 2. JSONL 事件解析 —— 解析错会丢产物或把失败当成功
 *
 * 通过 mock child_process.spawn 注入可控的 stdout/exit,驱动真实解析逻辑。
 *
 * @author liyingjie <y@senke.com>
 */
// @ts-nocheck
/* eslint-disable */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

// CliExecutor ensures the workspace exists before spawning. Keep this unit test
// independent of host permissions (Linux CI cannot create /ws at filesystem root).
vi.mock('node:fs', () => ({ mkdirSync: vi.fn() }));

// 配置文件 mock：泛化 CLI 的 runArgs 覆写由用例控制
const appCfg: { engines: Record<string, { runArgs?: string[] }> } = { engines: {} };
vi.mock('../src/main/services/config.js', () => ({ loadConfig: () => appCfg }));

// 引擎环境变量：不引入 safeStorage 依赖
vi.mock('../src/main/services/engineEnv.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/main/services/engineEnv.js')>(),
  resolveEngineEnv: () => ({}),
  resolveConfiguredEngineEnv: () => ({})
}));

/** 受控子进程：可手动推 stdout/stderr 并触发退出 */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill() { this.killed = true; return true; }
  /** 推一行 stdout（自动补换行） */
  line(s: string) { this.stdout.emit('data', Buffer.from(s + '\n')); }
  out(s: string) { this.stdout.emit('data', Buffer.from(s)); }
  err(s: string) { this.stderr.emit('data', Buffer.from(s)); }
  exit(code: number) { this.emit('close', code); }
}

let lastSpawn: { bin: string; args: string[]; opts: unknown } | null = null;
let child: FakeChild;
// 拦截 cliLauncher 而非 node:child_process：执行器现经 spawnCli 启动，
// 由它负责 Windows 上 .cmd / npm shim / Store 应用的 cmd.exe 包装。
// 在此层断言可拿到「逻辑命令与参数」，不受平台包装干扰。
vi.mock('../src/main/services/cliLauncher.js', () => ({
  spawnCli: (bin: string, args: string[], opts: unknown) => {
    lastSpawn = { bin, args, opts };
    child = new FakeChild();
    return child;
  },
  runCli: async () => ({ ok: true, code: 0, stdout: 'v1.0.0', stderr: '' })
}));

const {
  CliExecutor,
  buildClaudeAuthCheckArgs,
  buildClaudeProbeArgs,
  buildCodexManagedArgs,
  buildOpenCodeManagedArgs,
  claudeProcessEnv,
  managedCodexProcessEnv,
  parseClaudeAuthStatus,
  parseClaudeProbeOutput,
  redactClaudeText
} = await import('../src/main/services/executor/cliExecutor.js');

/** engines 表 mock：status HEALTHY，path 为 null（走 fallback bin） */
function makeDb(status = 'HEALTHY', path: string | null = null) {
  return {
    raw: {
      prepare: (sql: string) => ({
        get: () => {
          if (/SELECT status FROM engines/.test(sql)) return { status };
          if (/SELECT path FROM engines/.test(sql)) return { path };
          return undefined;
        },
        all: () => [],
        run: () => ({ changes: 1 })
      })
    },
    transaction: (fn: () => void) => fn(),
    audit: vi.fn(),
    getSetting: (_k: string, fb: unknown) => fb,
    setSetting: vi.fn()
  } as never;
}

const task = (over = {}) => ({
  id: 't1', agentId: 'a1', title: '任务', source: 'desktop',
  sessionId: null, workspaceOverride: null, status: 'RUNNING', ...over
});
const agent = (over = {}) => ({
  id: 'a1', name: '员工', permissionMode: 'standard', workspace: '/ws', systemPrompt: 'sp', ...over
});
const cb = () => ({
  onStage: vi.fn(), onProgress: vi.fn(), onOutput: vi.fn(),
  onSession: vi.fn(), onDone: vi.fn(), onError: vi.fn()
});
const settle = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => { appCfg.engines = {}; lastSpawn = null; });

describe('就绪判定', () => {
  it('引擎表 HEALTHY 才就绪', () => {
    expect(new CliExecutor('codex-cli', makeDb('HEALTHY'), 'eng-codex').isReady()).toBe(true);
    expect(new CliExecutor('codex-cli', makeDb('NOT_INSTALLED'), 'eng-codex').isReady()).toBe(false);
    expect(new CliExecutor('codex-cli', makeDb('AUTH_REQUIRED'), 'eng-codex').isReady()).toBe(false);
  });

  it('优先用 detect 解析到的绝对路径（Windows .cmd 无法 shell:false 直启）', () => {
    new CliExecutor('codex-cli', makeDb('HEALTHY', 'C:/tools/codex.exe'), 'eng-codex')
      .start(task(), agent(), cb());
    expect(lastSpawn.bin).toBe('C:/tools/codex.exe');
  });

  it('无解析路径时回退到 PATH 中的命令名', () => {
    new CliExecutor('codex-cli', makeDb('HEALTHY', null), 'eng-codex').start(task(), agent(), cb());
    expect(lastSpawn.bin).toBe('codex');
  });
});

describe('Codex 权限映射（映射错会静默放宽沙箱）', () => {
  const sandboxFor = (permissionMode: string, source = 'desktop') => {
    new CliExecutor('codex-cli', makeDb(), 'eng-codex').start(task({ source }), agent({ permissionMode }), cb());
    const i = lastSpawn.args.indexOf('--sandbox');
    return i >= 0 ? lastSpawn.args[i + 1] : null;
  };

  it('readonly → read-only', () => {
    expect(sandboxFor('readonly')).toBe('read-only');
  });

  it('standard → workspace-write（可写工作区，不可越界）', () => {
    expect(sandboxFor('standard')).toBe('workspace-write');
  });

  it('trusted / autonomous 仍限定为 workspace-write', () => {
    expect(sandboxFor('trusted')).toBe('workspace-write');
    expect(sandboxFor('autonomous')).toBe('workspace-write');
  });

  it('渠道来源任务：trusted 降级为 workspace-write（10.5）', () => {
    // 关键安全边界：聊天里说一句就能全盘写，风险过高
    expect(sandboxFor('trusted', 'channel')).toBe('workspace-write');
  });

  it('渠道来源任务：autonomous 仍限定为 workspace-write', () => {
    expect(sandboxFor('autonomous', 'channel')).toBe('workspace-write');
  });

  it('专家团任务保留员工权限：standard 仍为 workspace-write', () => {
    expect(sandboxFor('standard', 'team')).toBe('workspace-write');
  });

  it('始终带 --json 与 --skip-git-repo-check（非交互执行前提）', () => {
    new CliExecutor('codex-cli', makeDb(), 'eng-codex').start(task(), agent(), cb());
    expect(lastSpawn.args).toContain('--json');
    expect(lastSpawn.args).toContain('--skip-git-repo-check');
  });

  it('无 session 时用 exec，有 session 时 exec resume 续跑', () => {
    new CliExecutor('codex-cli', makeDb(), 'eng-codex').start(task(), agent(), cb());
    expect(lastSpawn.args.slice(0, 1)).toEqual(['exec']);

    new CliExecutor('codex-cli', makeDb(), 'eng-codex').start(task({ sessionId: 'thread-abc' }), agent(), cb());
    expect(lastSpawn.args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(lastSpawn.args).toContain('thread-abc');
    expect(lastSpawn.args).not.toContain('--sandbox');
    expect(lastSpawn.args).toContain('sandbox_mode="workspace-write"');
  });

  it('工作目录传给 spawn 的 cwd，且 shell:false（杜绝命令注入）', () => {
    new CliExecutor('codex-cli', makeDb(), 'eng-codex').start(task(), agent({ workspace: '/my/ws' }), cb());
    expect(lastSpawn.opts.cwd).toBe('/my/ws');
    expect(lastSpawn.opts.shell).toBe(false);
  });

  it('任务级工作目录覆盖优先于员工工作目录', () => {
    new CliExecutor('codex-cli', makeDb(), 'eng-codex')
      .start(task({ workspaceOverride: '/shared' }), agent({ workspace: '/my/ws' }), cb());
    expect(lastSpawn.opts.cwd).toBe('/shared');
  });
});

describe('Claude Code Worker 边界', () => {
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  const argsFor = (permissionMode: string, source = 'desktop', sessionIdValue: string | null = null) => {
    new CliExecutor('claude-cli', makeDb(), 'eng-claude').start(
      task({ source, sessionId: sessionIdValue }),
      agent({ permissionMode }),
      cb()
    );
    const args = lastSpawn.args;
    child.exit(0);
    return args;
  };

  it('始终使用无交互 JSONL 与 safe-mode，禁用本机自定义和隐式 MCP', () => {
    const args = argsFor('standard');
    expect(args).toContain('-p');
    expect(args).toContain('stream-json');
    expect(args).toContain('--safe-mode');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--no-chrome');
  });

  it('readonly 只暴露读取工具且不询问权限', () => {
    const args = argsFor('readonly');
    expect(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2)).toEqual([
      '--permission-mode', 'dontAsk'
    ]);
    expect(args).toContain('--tools=Read,Glob,Grep');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('standard 可编辑工作区但不静默绕过 Bash 权限', () => {
    const args = argsFor('standard');
    expect(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2)).toEqual([
      '--permission-mode', 'acceptEdits'
    ]);
    expect(args).toContain('--tools=Read,Glob,Grep,Edit,Write,Bash');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--allowedTools');
  });

  it('trusted/autonomous 也不绕过 Claude 的项目边界；team 与渠道同样不提升', () => {
    expect(argsFor('trusted')).not.toContain('--dangerously-skip-permissions');
    expect(argsFor('autonomous', 'channel')).not.toContain('--dangerously-skip-permissions');
    expect(argsFor('trusted', 'channel')).not.toContain('--dangerously-skip-permissions');
    expect(argsFor('standard', 'team')).not.toContain('--dangerously-skip-permissions');
    expect(argsFor('autonomous')).toContain('acceptEdits');
  });

  it('只续接 Claude 命名空间或合法 UUID，不把其他执行器会话传给 --resume', () => {
    const namespaced = argsFor('standard', 'desktop', `claude:${sessionId}`);
    expect(namespaced.slice(namespaced.indexOf('--resume'), namespaced.indexOf('--resume') + 2)).toEqual([
      '--resume', sessionId
    ]);
    const legacyRaw = argsFor('standard', 'desktop', sessionId);
    expect(legacyRaw).toContain('--resume');
    const incompatible = argsFor('standard', 'desktop', 'codex-thread-123');
    expect(incompatible).not.toContain('--resume');
    expect(incompatible.at(-1)).toContain('sp');
    expect(incompatible.at(-1)).toContain('当前任务');
  });

  it('子进程不继承无关 ambient API keys，但保留该引擎受管凭据', () => {
    const env = claudeProcessEnv(
      { ANTHROPIC_API_KEY: 'managed-anthropic-key' },
      {
        PATH: 'C:\\tools', USERPROFILE: 'C:\\Users\\test',
        OPENAI_API_KEY: 'ambient-openai-key', DEEPSEEK_API_KEY: 'ambient-deepseek-key',
        ANTHROPIC_API_KEY: 'ambient-anthropic-key'
      }
    );
    expect(env.PATH).toBe('C:\\tools');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe('managed-anthropic-key');
  });

  it('探活参数禁用工具和会话落盘，并解析 auth/result JSON', () => {
    expect(buildClaudeAuthCheckArgs()).toEqual(['auth', 'status', '--json']);
    const probeArgs = buildClaudeProbeArgs();
    expect(probeArgs).toContain('--no-session-persistence');
    expect(probeArgs).toContain('--tools=');
    expect(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}').loggedIn).toBe(true);
    expect(parseClaudeAuthStatus('diagnostic\n{\n"loggedIn": true,\n"authMethod": "api_key"\n}').loggedIn).toBe(true);
    expect(parseClaudeProbeOutput('{"type":"result","is_error":false,"result":"OPC_CLAUDE_OK"}').ok).toBe(true);
    expect(parseClaudeProbeOutput('{"type":"result","is_error":true,"result":"HTTP 401"}').ok).toBe(false);
  });

  it('探活错误会脱敏该引擎密钥', () => {
    const text = redactClaudeText('Bearer claude-secret rejected', { ANTHROPIC_API_KEY: 'claude-secret' });
    expect(text).toBe('Bearer [REDACTED] rejected');
  });
});

describe('泛化 CLI 参数模板', () => {
  it('默认模板替换 {prompt} 占位', () => {
    new CliExecutor('generic-cli', makeDb(), 'eng-opencode', ['run', '{prompt}']).start(task(), agent(), cb());
    expect(lastSpawn.args[0]).toBe('run');
    expect(lastSpawn.args[1]).toContain('任务');
  });

  it('配置文件 runArgs 覆写默认模板', () => {
    appCfg.engines['eng-opencode'] = { runArgs: ['--custom', '{prompt}'] };
    new CliExecutor('generic-cli', makeDb(), 'eng-opencode', ['run', '{prompt}']).start(task(), agent(), cb());
    expect(lastSpawn.args[0]).toBe('--custom');
  });

  it('模板未含 {prompt} 时提示词追加到末尾（不丢任务内容）', () => {
    appCfg.engines['eng-opencode'] = { runArgs: ['--flag'] };
    new CliExecutor('generic-cli', makeDb(), 'eng-opencode').start(task(), agent(), cb());
    expect(lastSpawn.args[0]).toBe('--flag');
    expect(lastSpawn.args[1]).toContain('任务');
  });
});

describe('Codex JSONL 事件解析', () => {
  const run = (permissionMode = 'standard') => {
    const c = cb();
    new CliExecutor('codex-cli', makeDb(), 'eng-codex').start(task(), agent({ permissionMode }), c);
    return c;
  };

  it('thread.started 提取 thread_id 作为会话锚点（供追问 resume）', async () => {
    const c = run();
    child.line(JSON.stringify({ type: 'thread.started', thread_id: 'th-123' }));
    await settle();
    expect(c.onSession).toHaveBeenCalledWith('t1', 'th-123');
  });

  it('agent_message 文本进入产物', async () => {
    const c = run();
    child.line(JSON.stringify({ type: 'item.completed', item: { item_type: 'agent_message', text: '分析结论' } }));
    child.exit(0);
    await settle();
    expect(c.onDone).toHaveBeenCalledWith('t1', expect.stringContaining('分析结论'));
  });

  it('error 事件如实上报，且进程随后 code=0 退出也不覆盖为成功', async () => {
    const c = run();
    child.line(JSON.stringify({ type: 'error', message: '模型调用失败' }));
    child.exit(0); // 关键：错误后进程正常退出
    await settle();
    expect(c.onError).toHaveBeenCalledWith('t1', '模型调用失败');
    expect(c.onDone).not.toHaveBeenCalled();
  });

  it('非 JSON 行按纯文本纳入产物（容忍版本差异）', async () => {
    const c = run();
    child.line('plain text output');
    child.exit(0);
    await settle();
    expect(c.onDone).toHaveBeenCalledWith('t1', expect.stringContaining('plain text output'));
  });

  it('跨 chunk 分片的 JSON 行被正确拼接', async () => {
    const c = run();
    const ev = JSON.stringify({ type: 'item.completed', item: { item_type: 'agent_message', text: '跨片文本' } });
    child.out(ev.slice(0, 20));
    child.out(ev.slice(20) + '\n');
    child.exit(0);
    await settle();
    expect(c.onDone).toHaveBeenCalledWith('t1', expect.stringContaining('跨片文本'));
  });

  it('退出码非 0 如实报错并带上 stderr，不伪装完成', async () => {
    const c = run();
    child.err('command not found');
    child.exit(127);
    await settle();
    expect(c.onError).toHaveBeenCalledWith('t1', expect.stringContaining('127'));
    expect(c.onError.mock.calls[0][1]).toContain('command not found');
    expect(c.onDone).not.toHaveBeenCalled();
  });

  it('有事件流但无文本产物时给出明确说明而非空串', async () => {
    const c = run();
    child.line(JSON.stringify({ type: 'turn.completed' }));
    child.exit(0);
    await settle();
    expect(c.onDone).toHaveBeenCalledWith('t1', expect.stringContaining('无文本产物'));
  });

  it('spawn 失败（ENOENT）给出可操作提示', async () => {
    const c = run();
    child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }));
    await settle();
    expect(c.onError).toHaveBeenCalledWith('t1', expect.stringContaining('ENOENT'));
    expect(c.onError.mock.calls[0][1]).toContain('PATH');
  });
});

describe('Claude stream-json 事件解析', () => {
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';

  const run = () => {
    const callbacks = cb();
    new CliExecutor('claude-cli', makeDb(), 'eng-claude').start(task(), agent(), callbacks);
    return callbacks;
  };

  it('system 事件把 UUID 记录为 Claude 命名空间会话锚点', async () => {
    const callbacks = run();
    child.line(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }));
    await settle();
    expect(callbacks.onSession).toHaveBeenCalledWith('t1', `claude:${sessionId}`);
  });

  it('assistant 文本进入产物，result 成功结束', async () => {
    const callbacks = run();
    child.line(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Claude 产物' }] } }));
    child.line(JSON.stringify({ type: 'result', is_error: false, result: 'Claude 产物' }));
    child.exit(0);
    await settle();
    expect(callbacks.onDone).toHaveBeenCalledWith('t1', expect.stringContaining('Claude 产物'));
  });

  it('result is_error 如实失败，随后 code=0 不覆盖为成功', async () => {
    const callbacks = run();
    child.line(JSON.stringify({ type: 'result', is_error: true, result: 'HTTP 403 forbidden' }));
    child.exit(0);
    await settle();
    expect(callbacks.onError).toHaveBeenCalledWith('t1', 'HTTP 403 forbidden');
    expect(callbacks.onDone).not.toHaveBeenCalled();
  });
});

describe('中止与清理', () => {
  it('abort 后进程退出不再回报（状态由 orchestrator 置 CANCELLED）', async () => {
    const c = cb();
    const ex = new CliExecutor('codex-cli', makeDb(), 'eng-codex');
    ex.start(task(), agent(), c);
    ex.abort('t1');
    child.exit(0);
    await settle();
    expect(c.onDone).not.toHaveBeenCalled();
    expect(c.onError).not.toHaveBeenCalled();
  });

  it('abort 会终止子进程', () => {
    const ex = new CliExecutor('codex-cli', makeDb(), 'eng-codex');
    ex.start(task(), agent(), cb());
    ex.abort('t1');
    expect(child.killed).toBe(true);
  });

  it('对不存在的任务 abort 不抛异常', () => {
    expect(() => new CliExecutor('codex-cli', makeDb(), 'eng-codex').abort('nope')).not.toThrow();
  });
});

describe('Managed CLI Provider boundaries', () => {
  it('supplies the complete Codex Responses Provider schema', () => {
    const args = buildCodexManagedArgs('ping', 'worker-model', { baseUrl: 'https://provider.test/v1/' });
    expect(args.slice(0, 2)).toEqual(['exec', '--ignore-user-config']);
    expect(args).toContain('model_provider="opcnexus"');
    expect(args).toContain('model_providers.opcnexus.name="OPC-Nexus"');
    expect(args).toContain('model_providers.opcnexus.base_url="https://provider.test/v1"');
    expect(args).toContain('model_providers.opcnexus.env_key="OPENAI_API_KEY"');
    expect(args).toContain('model_providers.opcnexus.wire_api="responses"');
    expect(args.slice(-3)).toEqual(['--model', 'worker-model', 'ping']);
  });

  it('replaces ambient CODEX_HOME with a stable application-owned profile', () => {
    const first = managedCodexProcessEnv({ PATH: 'C:\\tools', CODEX_HOME: 'C:\\Users\\test\\.codex' }, 'agent:a1');
    const second = managedCodexProcessEnv({ CODEX_HOME: 'D:\\other' }, 'agent:a1');
    const other = managedCodexProcessEnv({}, 'agent:a2');
    expect(first.PATH).toBe('C:\\tools');
    expect(first.CODEX_HOME).toBe(second.CODEX_HOME);
    expect(first.CODEX_HOME).not.toBe('C:\\Users\\test\\.codex');
    expect(first.CODEX_HOME).toContain('aibox-data');
    expect(first.CODEX_HOME).toContain('codex');
    expect(other.CODEX_HOME).not.toBe(first.CODEX_HOME);
  });

  it('forces OpenCode pure mode and the managed model without duplicating explicit flags', () => {
    expect(buildOpenCodeManagedArgs(['run', 'ping'], 'ping', 'worker-model')).toEqual([
      'run', '--pure', '-m', 'opcnexus/worker-model', 'ping'
    ]);
    expect(buildOpenCodeManagedArgs(
      ['run', '--pure', '--model=opcnexus/custom', 'ping'],
      'ping',
      'worker-model'
    )).toEqual(['run', '--pure', '--model=opcnexus/custom', 'ping']);
    expect(buildOpenCodeManagedArgs(['--dir', 'workspace', 'run', 'ping'], 'ping', 'worker-model')).toEqual([
      '--dir', 'workspace', 'run', '--pure', '-m', 'opcnexus/worker-model', 'ping'
    ]);
  });
});
