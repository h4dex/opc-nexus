/**
 * CLI 执行器：真实拉起本机 Codex CLI / Claude Code / OpenCode（headless 模式）
 * - 安全基线（12.3）：spawn 一律 shell:false，参数数组传递，杜绝命令注入
 * - 工作目录限定在员工 workspace（7.2 边界），不存在则创建
 * - 事件解析对版本差异保持容忍：JSONL 解析失败的行当纯文本输出处理
 * - 泛化 CLI（generic-cli）：运行参数模板取自引擎目录，可被配置文件 engines[id].runArgs 覆写
 * - 凭据：spawn 前经 resolveEngineEnv 还原加密的环境变量，明文仅存活于子进程
 *
 * @author liyingjie <y@senke.com>
 */
import { type ChildProcess } from 'node:child_process';
import { spawnCli } from '../cliLauncher.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { app } from 'electron';
import type { Agent, ExecutorKind, Task } from '../../../shared/types.js';
import type { Database } from '../database.js';
import type { ResolvedProvider } from '../providerManager.js';
import { loadConfig } from '../config.js';
import {
  childProcessEnv,
  createSensitiveTextRedactor,
  redactSensitiveText,
  readEngineRuntimeConfig,
  resolveClaudeEngineEnv,
  resolveEngineEnv,
  resolveEngineProvider,
  resolveOpenCodeEngineEnv
} from '../engineEnv.js';
import { killQuietly, type ExecutorAdapter, type ExecutorCallbacks } from './types.js';
import { appendProcessOutput, createProcessOutputBuffer, createUtf8StreamDecoder, finishProcessOutput } from '../textEncoding.js';
import { appendBoundedText, boundedText } from '../textEncoding.js';

const TIMEOUT_MS = 10 * 60_000;
const MAX_RESULT_CHARS = 16_000;
const MAX_STREAM_BUFFER_CHARS = 1_024 * 1_024;

export const CLAUDE_ENGINE_ID = 'eng-claude';
export const CLAUDE_PROBE_SENTINEL = 'OPC_CLAUDE_OK';
const CLAUDE_SESSION_PREFIX = 'claude:';
const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Return an application-owned Codex home for managed invocations.
 *
 * Codex's `--ignore-user-config` deliberately does not ignore authentication
 * files. A dedicated home therefore has to be supplied as well, otherwise a
 * user's native OAuth login can silently win over the Provider selected in
 * OPC-Nexus. The profile key is hashed so arbitrary Agent ids cannot escape
 * the application data directory, while remaining stable for session resume.
 */
export function managedCodexProcessEnv(
  runtimeEnv: NodeJS.ProcessEnv,
  profileKey: string
): NodeJS.ProcessEnv {
  const digest = createHash('sha256').update(profileKey).digest('hex').slice(0, 16);
  const home = join(app.getPath('userData'), 'aibox-data', 'codex', 'profiles', digest);
  mkdirSync(home, { recursive: true });
  return { ...runtimeEnv, CODEX_HOME: home };
}

function lastJsonRecord(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* Fall through to JSONL parsing. */ }
  const objectStart = trimmed.indexOf('{');
  const objectEnd = trimmed.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    try {
      const parsed = JSON.parse(trimmed.slice(objectStart, objectEnd + 1)) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* Fall through to line-by-line parsing. */ }
  }
  const lines = trimmed.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* Ignore non-JSON diagnostics. */ }
  }
  return null;
}

function claudeSessionId(anchor: string | null): string | null {
  if (!anchor) return null;
  const candidate = anchor.startsWith(CLAUDE_SESSION_PREFIX)
    ? anchor.slice(CLAUDE_SESSION_PREFIX.length)
    : anchor;
  return CLAUDE_SESSION_ID_RE.test(candidate) ? candidate : null;
}

export function claudeSessionAnchor(sessionId: string): string | null {
  return CLAUDE_SESSION_ID_RE.test(sessionId) ? `${CLAUDE_SESSION_PREFIX}${sessionId}` : null;
}

/** Claude inherits only process mechanics; model credentials must come from the
 * encrypted engine environment or Claude's own local auth store. */
export function claudeProcessEnv(
  runtimeEnv: Record<string, string>,
  hostEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return childProcessEnv(runtimeEnv, hostEnv);
}

export function redactClaudeText(text: string, env: NodeJS.ProcessEnv): string {
  return redactSensitiveText(text, env);
}

export function buildClaudeAuthCheckArgs(): string[] {
  return ['auth', 'status', '--json'];
}

export function parseClaudeAuthStatus(text: string): { loggedIn: boolean; detail: string } {
  const record = lastJsonRecord(text);
  if (!record) return { loggedIn: false, detail: 'Claude auth status did not return JSON' };
  const loggedIn = record.loggedIn === true;
  const method = typeof record.authMethod === 'string' ? record.authMethod : 'unknown';
  const provider = typeof record.apiProvider === 'string' ? record.apiProvider : 'unknown';
  return {
    loggedIn,
    detail: loggedIn ? `authenticated via ${method} (${provider})` : 'Claude Code is not logged in'
  };
}

export function buildClaudeProbeArgs(model?: string, managedProvider = false): string[] {
  return [
    '-p', '--output-format', 'json', '--safe-mode', '--strict-mcp-config', '--no-chrome',
    '--no-session-persistence', '--max-budget-usd', '0.05', '--permission-mode', 'dontAsk',
    '--tools=', ...(managedProvider ? ['--bare'] : []), ...(model ? ['--model', model] : []),
    `Reply with exactly ${CLAUDE_PROBE_SENTINEL}`
  ];
}

/** Build a Codex probe using an OPC-managed Responses provider. */
export function buildCodexManagedArgs(
  prompt: string,
  model: string,
  provider: Pick<ResolvedProvider, 'baseUrl'>
): string[] {
  return [
    'exec', '--ignore-user-config', '--json', '--skip-git-repo-check', '--sandbox', 'read-only',
    '-c', 'model_provider="opcnexus"',
    '-c', 'model_providers.opcnexus.name="OPC-Nexus"',
    '-c', `model_providers.opcnexus.base_url=${JSON.stringify(provider.baseUrl.replace(/\/+$/, ''))}`,
    '-c', 'model_providers.opcnexus.env_key="OPENAI_API_KEY"',
    '-c', 'model_providers.opcnexus.wire_api="responses"',
    '--model', model, prompt
  ];
}

/** Apply the managed OpenCode route without loading user plugins. */
export function buildOpenCodeManagedArgs(args: string[], prompt: string, model: string): string[] {
  const managed = [...args];
  if (!managed.includes('--pure')) {
    const runIndex = managed.indexOf('run');
    managed.splice(runIndex >= 0 ? runIndex + 1 : 0, 0, '--pure');
  }
  if (!managed.some((arg) => arg === '-m' || arg === '--model'
    || arg.startsWith('-m=') || arg.startsWith('--model='))) {
    const promptIndex = managed.lastIndexOf(prompt);
    managed.splice(promptIndex >= 0 ? promptIndex : managed.length, 0, '-m', `opcnexus/${model}`);
  }
  return managed;
}

export function parseClaudeProbeOutput(text: string): { ok: boolean; output: string; error: string | null } {
  const record = lastJsonRecord(text);
  if (!record) return { ok: false, output: '', error: 'Claude probe did not return JSON' };
  const output = typeof record.result === 'string' ? record.result.trim() : '';
  if (record.is_error === true) return { ok: false, output, error: output || 'Claude probe reported an error' };
  if (!output.includes(CLAUDE_PROBE_SENTINEL)) {
    return { ok: false, output, error: output ? `Unexpected Claude probe output: ${output}` : 'Claude probe returned no result' };
  }
  return { ok: true, output, error: null };
}

export function buildClaudeTaskArgs(
  prompt: string,
  sessionAnchor: string | null,
  permissionMode: Agent['permissionMode'],
  model?: string,
  managedProvider = false
): string[] {
  const tools = permissionMode === 'readonly'
    ? 'Read,Glob,Grep'
    : 'Read,Glob,Grep,Edit,Write,Bash';
  const permissions = permissionMode === 'readonly'
    ? ['--permission-mode', 'dontAsk']
    : (permissionMode === 'trusted' || permissionMode === 'autonomous')
      ? ['--dangerously-skip-permissions']
      : ['--permission-mode', 'acceptEdits'];
  const resumeId = claudeSessionId(sessionAnchor);
  return [
    '-p', '--output-format', 'stream-json', '--verbose', '--safe-mode',
    '--strict-mcp-config', '--no-chrome', ...(managedProvider ? ['--bare'] : []), ...permissions, `--tools=${tools}`,
    ...(model ? ['--model', model] : []),
    ...(resumeId ? ['--resume', resumeId] : []), prompt
  ];
}

interface RunningChild {
  child: ChildProcess;
  timer: NodeJS.Timeout;
}

export class CliExecutor implements ExecutorAdapter {
  private running = new Map<string, RunningChild>();
  /** 被用户主动取消的任务：close 回调中不再回报错误（状态已由 orchestrator 置 CANCELLED） */
  private abortedTasks = new Set<string>();

  constructor(
    readonly kind: Extract<ExecutorKind, 'codex-cli' | 'claude-cli' | 'generic-cli'>,
    private db: Database,
    /** 引擎表主键（就绪判定 / 路径解析 / 配置覆写键） */
    private engineId: string,
    /** 泛化 CLI 的默认非交互运行参数（{prompt} 占位；可被配置文件覆写） */
    private defaultRunArgs: string[] = ['-p', '{prompt}']
  ) {}

  /** CLI 就绪 = 引擎表状态 HEALTHY（由 EngineManager.detect 真实探测后写入） */
  isReady(): boolean {
    const row = this.db.raw.prepare('SELECT status FROM engines WHERE id = ?').get(this.engineId) as { status: string } | undefined;
    return row?.status === 'HEALTHY';
  }

  /** 优先使用 EngineManager.detect 解析到的真实路径（Windows 上 .cmd 无法 shell:false 直启，detect 已优先 .exe） */
  private resolveBin(fallback: string): string {
    const row = this.db.raw.prepare('SELECT path FROM engines WHERE id = ?').get(this.engineId) as { path: string | null } | undefined;
    return row?.path || fallback;
  }

  private buildCommand(
    prompt: string,
    task: Task,
    agent: Agent,
    model?: string,
    managedProvider: ResolvedProvider | null = null
  ): { bin: string; args: string[] } {
    // P1a 静态限权：permissionMode → CLI 沙箱/权限参数；任务来源只用于
    // 渠道安全降级，不得把 team/nested 任务提升为 autonomous。
    const baseMode = agent.permissionMode;
    const mode = task.source === 'channel' && baseMode === 'trusted' ? 'standard' : baseMode;
    if (this.kind === 'codex-cli') {
      // codex exec --json：非交互执行，stdout 输出 JSONL 事件流；有 session 则 resume 续跑（P2b）
      const sandbox = mode === 'readonly' ? 'read-only' : (mode === 'trusted' || mode === 'autonomous') ? 'danger-full-access' : 'workspace-write';
      const providerArgs = managedProvider ? [
        '--ignore-user-config',
        '-c', 'model_provider="opcnexus"',
        '-c', 'model_providers.opcnexus.name="OPC-Nexus"',
        '-c', `model_providers.opcnexus.base_url=${JSON.stringify(managedProvider.baseUrl.replace(/\/+$/, ''))}`,
        '-c', 'model_providers.opcnexus.env_key="OPENAI_API_KEY"',
        '-c', 'model_providers.opcnexus.wire_api="responses"'
      ] : [];
      const commonArgs = [
        ...providerArgs,
        '--json',
        '--skip-git-repo-check',
        ...(model ? ['--model', model] : [])
      ];
      const args = task.sessionId
        // `codex exec resume` does not accept `--sandbox`; use its supported
        // config override so a resumed task keeps the same permission policy.
        ? ['exec', 'resume', ...commonArgs, '-c', `sandbox_mode=${JSON.stringify(sandbox)}`, task.sessionId, prompt]
        : ['exec', ...commonArgs, '--sandbox', sandbox, prompt];
      return {
        bin: this.resolveBin('codex'),
        args
      };
    }
    if (this.kind === 'claude-cli') {
      return {
        bin: this.resolveBin('claude'),
        args: buildClaudeTaskArgs(prompt, task.sessionId, mode, model, Boolean(managedProvider))
      };
    }
    // 泛化 CLI：运行参数模板取配置覆写，否则用目录默认；{prompt} 替换为任务提示词（权限参数由 CLI 自身配置控制）
    const override = readEngineRuntimeConfig(this.db, this.engineId)?.runArgs
      ?? loadConfig().engines[this.engineId]?.runArgs;
    const template = override && override.length > 0 ? override : this.defaultRunArgs;
    const args = template.map((a) => {
      if (a === '{prompt}') return prompt;
      if (a === '{model}') return model ?? '';
      if (a === '{provider}') return 'opcnexus';
      return a;
    }).filter(Boolean);
    if (!template.includes('{prompt}')) args.push(prompt);
    const managedArgs = this.engineId === 'eng-opencode' && managedProvider
      ? buildOpenCodeManagedArgs(args, prompt, managedProvider.model)
      : args;
    return { bin: this.resolveBin(this.engineId.replace(/^eng-/, '')), args: managedArgs };
  }

  start(task: Task, agent: Agent, cb: ExecutorCallbacks): void {
    const workspace = task.workspaceOverride || agent.workspace || join(app.getPath('userData'), 'workspaces', agent.id);
    try {
      mkdirSync(workspace, { recursive: true });
    } catch (err) {
      cb.onError(task.id, `工作目录不可用：${workspace}（${err instanceof Error ? err.message : String(err)}）`);
      return;
    }

    const resumableSession = this.kind === 'claude-cli'
      ? claudeSessionId(task.sessionId) !== null
      : task.sessionId !== null;
    const prompt = resumableSession
      ? `追问：${task.content || task.title}\n请在之前会话的基础上继续处理，并输出最终结果。`
      : `${agent.systemPrompt}\n\n当前任务：${task.content || task.title}\n请直接执行该任务，并输出最终结构化结果。`;
    let child: ChildProcess;
    let bin = this.engineId.replace(/^eng-/, '');
    let args: string[] = [];
    let env: NodeJS.ProcessEnv = {};
    try {
      // 引擎自定义环境变量：敏感项经 safeStorage 解密后在此还原，仅存活于子进程
      const engineEnv = this.kind === 'claude-cli'
        ? resolveClaudeEngineEnv(this.db, this.engineId, agent)
        : this.engineId === 'eng-opencode'
          ? resolveOpenCodeEngineEnv(this.db, this.engineId, agent)
          : resolveEngineEnv(this.db, this.engineId, agent);
      env = childProcessEnv(engineEnv);
      const model = this.kind === 'claude-cli' ? env.ANTHROPIC_MODEL : env.OPENAI_MODEL;
      const provider = resolveEngineProvider(this.db, this.engineId, agent);
      const managedProvider = provider && (
        this.kind === 'claude-cli'
          ? env.ANTHROPIC_API_KEY === provider.key && env.ANTHROPIC_BASE_URL === provider.baseUrl.replace(/\/+$/, '')
          : env.OPENAI_API_KEY === provider.key && env.OPENAI_BASE_URL === provider.baseUrl.replace(/\/+$/, '')
      ) ? provider : null;
      if (managedProvider && this.kind === 'codex-cli') {
        env = managedCodexProcessEnv(env, `agent:${agent.id}`);
      }
      ({ bin, args } = this.buildCommand(prompt, task, agent, model, managedProvider));
      child = spawnCli(bin, args, {
        cwd: workspace,
        shell: false,
        windowsHide: true,
        env
      });
    } catch (err) {
      cb.onError(task.id, redactSensitiveText(`无法启动 ${bin}：${err instanceof Error ? err.message : String(err)}`, env));
      return;
    }

    const timer = setTimeout(() => {
      this.abortedTasks.add(task.id); // 标记为超时中止，防止 close 事件双重回调
      this.running.delete(task.id);
      killQuietly(child); // Windows 兼容 + 进程已退出时不抛
      cb.onError(task.id, '执行超时（10 分钟），已终止进程');
    }, TIMEOUT_MS);
    this.running.set(task.id, { child, timer });

    cb.onStage(task.id, '理解需求');
    cb.onProgress(task.id, 5);

    const fullParts: string[] = [];
    const fullState = { length: 0, truncated: false };
    let full = '';
    let outBuf = '';
    const stderrOutput = createProcessOutputBuffer();
    let stderrBuf = '';
    let lastFlush = Date.now();
    let lastProgress = 5;
    let sawStreamEvent = false;
    const streamRedactor = createSensitiveTextRedactor(env);

    const flush = (force: boolean) => {
      if (outBuf && (force || Date.now() - lastFlush >= 300)) {
        const safe = streamRedactor.push(outBuf);
        if (safe) cb.onOutput(task.id, safe);
        outBuf = '';
        lastFlush = Date.now();
      }
      if (force) {
        const tail = streamRedactor.finish();
        if (tail) cb.onOutput(task.id, tail);
      }
    };
    const bump = (stage: string | null, pct: number) => {
      if (stage) cb.onStage(task.id, stage);
      if (pct > lastProgress) {
        lastProgress = pct;
        cb.onProgress(task.id, pct);
      }
    };
    const pushText = (text: string) => {
      appendBoundedText(fullParts, fullState, text);
      if (outBuf.length < 32 * 1024) outBuf += text.slice(0, 32 * 1024 - outBuf.length);
      bump(null, Math.min(90, 10 + Math.floor(fullState.length / 30)));
      flush(false);
    };

    /** 解析单行输出：Codex / Claude 两套 JSONL 事件 schema 容忍解析；泛化 CLI 一律当纯文本 */
    const handleLine = (line: string): void => {
      if (this.kind === 'generic-cli') {
        pushText(line + '\n');
        return;
      }
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line) as Record<string, unknown>;
      } catch {
        pushText(line + '\n'); // 非 JSON 行 = 纯文本输出
        return;
      }
      sawStreamEvent = true;
      if (this.kind === 'codex-cli') {
        const type = ev.type as string;
        if (type === 'thread.started' || type === 'turn.started') {
          // P2b：提取 thread id 作为会话锚点（追问时 exec resume）
          if (type === 'thread.started' && typeof ev.thread_id === 'string' && !task.sessionId) cb.onSession?.(task.id, ev.thread_id);
          bump('规划步骤', 12);
        } else if (type === 'item.completed') {
          const item = ev.item as { item_type?: string; type?: string; text?: string } | undefined;
          const itemType = item?.item_type ?? item?.type;
          if (itemType === 'agent_message' && item?.text) pushText(item.text);
          else bump('调用工具', Math.min(88, lastProgress + 6));
        } else if (type === 'turn.completed') bump('校验结果', 95);
        else if (type === 'error') {
          // 事件流已报错：标记中止，避免进程随后以 code=0 退出时 close 分支再调 onDone
          this.abortedTasks.add(task.id);
          cb.onError(task.id, redactSensitiveText(String(ev.message ?? 'Codex 执行错误'), env));
        }
      } else {
        const type = ev.type as string;
        if (type === 'system') {
          // P2b：提取 session_id 作为会话锚点（追问时 --resume）
          if (typeof ev.session_id === 'string' && !task.sessionId) {
            const anchor = claudeSessionAnchor(ev.session_id);
            if (anchor) cb.onSession?.(task.id, anchor);
          }
          bump('规划步骤', 12);
        } else if (type === 'assistant') {
          const msg = ev.message as { content?: { type: string; text?: string }[] } | undefined;
          for (const c of msg?.content ?? []) {
            if (c.type === 'text' && c.text) pushText(c.text);
            else if (c.type === 'tool_use') bump('调用工具', Math.min(88, lastProgress + 6));
          }
        } else if (type === 'result') {
          if (ev.is_error) {
            this.abortedTasks.add(task.id); // 同上：防 close 分支覆盖为成功
            cb.onError(task.id, redactSensitiveText(String(ev.result ?? 'Claude Code 执行错误'), env));
          } else if (typeof ev.result === 'string' && ev.result && fullState.length === 0) pushText(ev.result);
          bump('校验结果', 95);
        }
      }
    };

    let stdoutBuf = '';
    const stdoutDecoder = createUtf8StreamDecoder();
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += stdoutDecoder.write(chunk);
      if (stdoutBuf.length > MAX_STREAM_BUFFER_CHARS) {
        stdoutBuf = stdoutBuf.slice(-MAX_STREAM_BUFFER_CHARS);
      }
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line) handleLine(line);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => appendProcessOutput(stderrOutput, chunk));

    child.on('error', (err) => {
      clearTimeout(timer);
      this.running.delete(task.id);
      // ENOENT = CLI 未安装/不在 PATH
      cb.onError(task.id, redactSensitiveText(`启动失败：${err.message}（请确认 ${bin} 已安装并在 PATH 中）`, env));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      this.running.delete(task.id);
      if (this.abortedTasks.delete(task.id)) return; // 用户取消，不回报
      stdoutBuf += stdoutDecoder.end();
      stderrBuf = finishProcessOutput(stderrOutput);
      if (stdoutBuf.trim()) handleLine(stdoutBuf.trim());
      full = boundedText(fullParts, fullState);
      flush(true);
      if (code === 0) {
        bump('校验结果', 98);
        const result = full.trim() || (sawStreamEvent ? '（执行完成，无文本产物）' : stderrBuf.slice(0, 2000));
        cb.onDone(task.id, redactSensitiveText(result, env).slice(0, MAX_RESULT_CHARS));
      } else {
        cb.onError(task.id, redactSensitiveText(`进程退出码 ${code ?? 'null'}：${(stderrBuf || '无错误输出').slice(0, 300)}`, env));
      }
    });
  }

  abort(taskId: string): void {
    const run = this.running.get(taskId);
    if (run) {
      this.abortedTasks.add(taskId);
      clearTimeout(run.timer);
      // 进程可能已自行退出（spawn 失败/崩溃），此时 kill 抛 EINVAL/ESRCH，不应外泄
      killQuietly(run.child);
      this.running.delete(taskId);
    }
  }
}
