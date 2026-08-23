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
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { app } from 'electron';
import type { Agent, ExecutorKind, Task } from '../../../shared/types.js';
import type { Database } from '../database.js';
import type { ResolvedProvider } from '../providerManager.js';
import { loadConfig } from '../config.js';
import {
  claudeProviderBaseUrl,
  type ClaudeGatewayRoute,
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
const CODEX_PLUGIN_ISOLATION_ARGS = [
  '--disable', 'plugins',
  '--disable', 'remote_plugin',
  '--disable', 'plugin_sharing',
  '--disable', 'multi_agent',
  '--disable', 'multi_agent_v2'
];
const CODEX_SANDBOX_SETUP_TIMEOUT_MS = 60_000;
const managedCodexSandboxReadyHomes = new Set<string>();

type CodexAppServerSpawner = typeof spawnCli;

function codexSandboxAbortError(): Error {
  const error = new Error('Codex Windows 安全工作区准备已取消');
  error.name = 'AbortError';
  return error;
}

function codexRpcError(message: Record<string, unknown>, fallback: string): string {
  const error = message.error;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const detail = (error as Record<string, unknown>).message;
    if (typeof detail === 'string' && detail.trim()) return detail.trim();
  }
  return fallback;
}

/**
 * Initialize the official Codex Windows sandbox for one application-owned
 * CODEX_HOME. Copying a user's cap_sid, auth database, or sandbox directories
 * would cross both identity and trust boundaries, so use App Server setup.
 */
export function ensureManagedCodexWindowsSandbox(
  bin: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  signal?: AbortSignal,
  platform: NodeJS.Platform = process.platform,
  spawnImpl: CodexAppServerSpawner = spawnCli
): Promise<void> {
  if (platform !== 'win32') return Promise.resolve();
  if (!env.CODEX_HOME) return Promise.reject(new Error('受管 Codex Profile 缺少 CODEX_HOME'));
  if (signal?.aborted) return Promise.reject(codexSandboxAbortError());

  return new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    let settled = false;
    let stdoutBuffer = '';
    const stderrOutput = createProcessOutputBuffer();
    const stdoutDecoder = createUtf8StreamDecoder();
    let timer: NodeJS.Timeout;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { child.stdin?.end(); } catch { /* Process may already be closed. */ }
      killQuietly(child);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(codexSandboxAbortError());
    const failFromExit = (prefix: string) => {
      const stderr = finishProcessOutput(stderrOutput).trim();
      finish(new Error(stderr ? `${prefix}：${stderr.slice(0, 600)}` : prefix));
    };

    const send = (message: Record<string, unknown>) => {
      if (!child.stdin?.writable) {
        finish(new Error('Codex App Server 标准输入不可用'));
        return;
      }
      child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
    };

    const handleMessage = (message: Record<string, unknown>) => {
      if (message.id === 1) {
        if (message.error) {
          finish(new Error(codexRpcError(message, 'Codex App Server 初始化失败')));
          return;
        }
        send({ method: 'initialized', params: {} });
        send({ id: 2, method: 'windowsSandbox/readiness', params: {} });
        return;
      }
      if (message.id === 2) {
        if (message.error) {
          finish(new Error(codexRpcError(message, '无法读取 Codex Windows Sandbox 状态')));
          return;
        }
        const result = message.result as { status?: unknown } | undefined;
        if (result?.status === 'ready') {
          finish();
          return;
        }
        if (result?.status !== 'notConfigured' && result?.status !== 'updateRequired') {
          finish(new Error(`Codex Windows Sandbox 返回未知状态：${String(result?.status ?? 'missing')}`));
          return;
        }
        send({
          id: 3,
          method: 'windowsSandbox/setupStart',
          params: { mode: 'unelevated', cwd }
        });
        return;
      }
      if (message.id === 3) {
        if (message.error) {
          finish(new Error(codexRpcError(message, 'Codex Windows Sandbox 初始化请求失败')));
          return;
        }
        const result = message.result as { started?: unknown } | undefined;
        if (result?.started !== true) finish(new Error('Codex Windows Sandbox 初始化未启动'));
        return;
      }
      if (message.method === 'windowsSandbox/setupCompleted') {
        const params = message.params as { success?: unknown; error?: unknown } | undefined;
        if (params?.success === true) finish();
        else finish(new Error(
          typeof params?.error === 'string' && params.error.trim()
            ? `Codex Windows Sandbox 初始化失败：${params.error.trim()}`
            : 'Codex Windows Sandbox 初始化失败'
        ));
      }
    };

    try {
      child = spawnImpl(bin, ['app-server', '--stdio', ...CODEX_PLUGIN_ISOLATION_ARGS], {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      reject(new Error(`无法启动 Codex App Server：${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    timer = setTimeout(() => failFromExit('Codex Windows Sandbox 初始化超时'), CODEX_SANDBOX_SETUP_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr?.on('data', (chunk: Buffer) => appendProcessOutput(stderrOutput, chunk));
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += stdoutDecoder.write(chunk);
      let newline: number;
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line) as unknown;
          if (message && typeof message === 'object' && !Array.isArray(message)) {
            handleMessage(message as Record<string, unknown>);
          }
        } catch {
          // App Server responses are JSONL; non-protocol diagnostics are ignored.
        }
      }
    });
    child.once('error', (error) => finish(new Error(`Codex App Server 启动失败：${error.message}`)));
    child.once('close', (code) => {
      if (!settled) failFromExit(`Codex App Server 在初始化完成前退出（${code ?? 'null'}）`);
    });
    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'opc-nexus', version: '1.0.0' },
        capabilities: { experimentalApi: true }
      }
    });
  });
}

async function prepareManagedCodexWindowsSandbox(
  bin: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  signal: AbortSignal
): Promise<void> {
  if (process.platform !== 'win32') return;
  const home = env.CODEX_HOME;
  if (!home) throw new Error('受管 Codex Profile 缺少 CODEX_HOME');
  if (managedCodexSandboxReadyHomes.has(home)) return;
  await ensureManagedCodexWindowsSandbox(bin, env, cwd, signal);
  managedCodexSandboxReadyHomes.add(home);
}

function managedCodexProfileHome(profileKey: string): string {
  const digest = createHash('sha256').update(profileKey).digest('hex').slice(0, 16);
  return join(app.getPath('userData'), 'aibox-data', 'codex', 'profiles', digest);
}

/**
 * Return an application-owned Codex home for managed invocations.
 *
 * A dedicated home prevents a user's native OAuth login or config from
 * silently winning over the Provider selected in OPC-Nexus. Managed workers
 * must load this isolated config because the official Windows Sandbox setup
 * persists its mode there. The profile key is hashed so arbitrary Agent ids
 * cannot escape application data while remaining stable for session resume.
 */
export function managedCodexProcessEnv(
  runtimeEnv: NodeJS.ProcessEnv,
  profileKey: string
): NodeJS.ProcessEnv {
  const home = managedCodexProfileHome(profileKey);
  mkdirSync(home, { recursive: true });
  return { ...isolatedCodexProcessEnv(runtimeEnv), CODEX_HOME: home };
}

export function buildManagedCodexModelCatalog(model: string): Record<string, unknown> {
  const slug = model.trim();
  if (!slug) throw new Error('Managed Codex model is required');
  return {
    models: [{
      slug,
      display_name: slug,
      description: 'OPC-Nexus managed Codex worker model',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [{ effort: 'medium', description: 'Balanced reasoning' }],
      shell_type: 'shell_command',
      visibility: 'list',
      supported_in_api: true,
      priority: 1,
      base_instructions: 'You are a managed Codex worker inside OPC-Nexus. Execute only the assigned project task. Use apply_patch for file edits, keep all writes inside the current workspace, and never claim success without verifying the requested artifacts.',
      include_skills_usage_instructions: true,
      default_reasoning_summary: 'none',
      support_verbosity: false,
      default_verbosity: 'low',
      apply_patch_tool_type: 'freeform',
      web_search_tool_type: 'text_and_image',
      truncation_policy: { mode: 'tokens', limit: 10_000 },
      supports_parallel_tool_calls: true,
      supports_image_detail_original: false,
      context_window: 128_000,
      max_context_window: 128_000,
      comp_hash: `opc-nexus-${createHash('sha256').update(slug).digest('hex').slice(0, 12)}`,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: ['text'],
      supports_search_tool: false,
      use_responses_lite: false,
      tool_mode: 'code_mode_only'
    }]
  };
}

/** Custom Responses providers do not publish Codex model capabilities. Without
 * this catalog Codex omits apply_patch and PowerShell writes are rejected by
 * its non-interactive command policy before the workspace sandbox can run. */
export function prepareManagedCodexModelCatalog(profileKey: string, model: string): string {
  const home = managedCodexProfileHome(profileKey);
  mkdirSync(home, { recursive: true });
  const digest = createHash('sha256').update(model.trim()).digest('hex').slice(0, 16);
  const target = join(home, `model-catalog-${digest}.json`);
  if (existsSync(target)) return target;
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(buildManagedCodexModelCatalog(model), null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx'
  });
  try {
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Best-effort temporary cleanup. */ }
    if (!existsSync(target)) throw error;
  }
  return target;
}

/** Do not let a parent Codex Desktop session or an engine-level environment
 * override the permission profile selected by OPC-Nexus for this worker. */
export function isolatedCodexProcessEnv(runtimeEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const isolated = { ...runtimeEnv };
  for (const key of [
    'CODEX_PERMISSION_PROFILE',
    'CODEX_THREAD_ID',
    'CODEX_SESSION_ID',
    'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'
  ]) delete isolated[key];
  return isolated;
}

/** Keep managed Claude invocations independent from ~/.claude/settings.json.
 * Claude Code 2.1.x still reads settings-level env values in --bare mode, so
 * an ambient ANTHROPIC_AUTH_TOKEN or Base URL can otherwise override the
 * Provider selected in OPC-Nexus. */
export function managedClaudeProcessEnv(
  runtimeEnv: NodeJS.ProcessEnv,
  profileKey: string
): NodeJS.ProcessEnv {
  const digest = createHash('sha256').update(profileKey).digest('hex').slice(0, 16);
  const home = join(app.getPath('userData'), 'aibox-data', 'claude', 'profiles', digest);
  mkdirSync(home, { recursive: true });
  const isolated: NodeJS.ProcessEnv = {
    ...runtimeEnv,
    CLAUDE_CONFIG_DIR: home,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
  };
  return isolated;
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
  provider: Pick<ResolvedProvider, 'baseUrl'>,
  modelCatalogPath: string
): string[] {
  return [
    'exec', '--strict-config', '--ignore-rules', '--json', '--skip-git-repo-check',
    ...CODEX_PLUGIN_ISOLATION_ARGS,
    '-c', 'default_permissions=:read-only',
    '-c', 'model_provider="opcnexus"',
    '-c', 'model_providers.opcnexus.name="OPC-Nexus"',
    '-c', `model_providers.opcnexus.base_url=${JSON.stringify(provider.baseUrl.replace(/\/+$/, ''))}`,
    '-c', 'model_providers.opcnexus.env_key="OPENAI_API_KEY"',
    '-c', 'model_providers.opcnexus.wire_api="responses"',
    '-c', `model_catalog_json=${JSON.stringify(modelCatalogPath)}`,
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
  // Claude has no host-verifiable project sandbox when permission checks are
  // bypassed. acceptEdits keeps its cwd boundary active while avoiding the
  // normal per-edit prompts; never translate autonomy into host-wide access.
  const permissions = permissionMode === 'readonly'
    ? ['--permission-mode', 'dontAsk']
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
  private preparing = new Map<string, AbortController>();
  /** 被用户主动取消的任务：close 回调中不再回报错误（状态已由 orchestrator 置 CANCELLED） */
  private abortedTasks = new Set<string>();

  constructor(
    readonly kind: Extract<ExecutorKind, 'codex-cli' | 'claude-cli' | 'generic-cli'>,
    private db: Database,
    /** 引擎表主键（就绪判定 / 路径解析 / 配置覆写键） */
    private engineId: string,
    /** 泛化 CLI 的默认非交互运行参数（{prompt} 占位；可被配置文件覆写） */
    private defaultRunArgs: string[] = ['-p', '{prompt}'],
    private resolveClaudeGateway?: () => ClaudeGatewayRoute | null
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
    managedProvider: ResolvedProvider | null = null,
    managedCodexCatalogPath: string | null = null
  ): { bin: string; args: string[] } {
    // P1a 静态限权：permissionMode → CLI 沙箱/权限参数；任务来源只用于
    // 渠道安全降级，不得把 team/nested 任务提升为 autonomous。
    const baseMode = agent.permissionMode;
    const mode = task.source === 'channel' && baseMode === 'trusted' ? 'standard' : baseMode;
    if (this.kind === 'codex-cli') {
      // codex exec --json：非交互执行，stdout 输出 JSONL 事件流；有 session 则 resume 续跑（P2b）
      // Codex 0.145+ uses named permission profiles as the authority. Its
      // legacy --sandbox flag can be accepted while the effective profile
      // silently remains read-only, so use the built-in profile explicitly.
      const permissionProfile = mode === 'readonly' ? ':read-only' : ':workspace';
      const providerArgs = managedProvider ? [
        '-c', 'model_provider="opcnexus"',
        '-c', 'model_providers.opcnexus.name="OPC-Nexus"',
        '-c', `model_providers.opcnexus.base_url=${JSON.stringify(managedProvider.baseUrl.replace(/\/+$/, ''))}`,
        '-c', 'model_providers.opcnexus.env_key="OPENAI_API_KEY"',
        '-c', 'model_providers.opcnexus.wire_api="responses"',
        '-c', `model_catalog_json=${JSON.stringify(managedCodexCatalogPath)}`
      ] : [];
      if (managedProvider && !managedCodexCatalogPath) {
        throw new Error('Managed Codex model catalog is unavailable');
      }
      const commonArgs = [
        ...providerArgs,
        '--strict-config',
        '--ignore-rules',
        '--json',
        '--skip-git-repo-check',
        ...CODEX_PLUGIN_ISOLATION_ARGS,
        '-c', `default_permissions=${permissionProfile}`,
        ...(model ? ['--model', model] : [])
      ];
      const args = task.sessionId
        ? ['exec', 'resume', ...commonArgs, task.sessionId, prompt]
        : ['exec', ...commonArgs, prompt];
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
    void this.startInternal(task, agent, cb);
  }

  private async startInternal(task: Task, agent: Agent, cb: ExecutorCallbacks): Promise<void> {
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
    let managedCodexCatalogPath: string | null = null;
    let requiresManagedCodexSandbox = false;
    try {
      // 引擎自定义环境变量：敏感项经 safeStorage 解密后在此还原，仅存活于子进程
      const claudeGateway = this.kind === 'claude-cli' ? this.resolveClaudeGateway?.() ?? null : null;
      const engineEnv = this.kind === 'claude-cli'
        ? resolveClaudeEngineEnv(this.db, this.engineId, agent, claudeGateway)
        : this.engineId === 'eng-opencode'
          ? resolveOpenCodeEngineEnv(this.db, this.engineId, agent)
          : resolveEngineEnv(this.db, this.engineId, agent);
      env = childProcessEnv(engineEnv);
      const model = this.kind === 'claude-cli' ? env.ANTHROPIC_MODEL : env.OPENAI_MODEL;
      const provider = resolveEngineProvider(this.db, this.engineId, agent);
      const managedProvider = provider && (
        this.kind === 'claude-cli'
          ? (env.AIBOX_ANTHROPIC_ADAPTER === 'anthropic-openai'
            || (env.ANTHROPIC_API_KEY === provider.key
              && env.ANTHROPIC_BASE_URL === claudeProviderBaseUrl(provider.baseUrl)))
          : env.OPENAI_API_KEY === provider.key && env.OPENAI_BASE_URL === provider.baseUrl.replace(/\/+$/, '')
      ) ? provider : null;
      if (this.kind === 'codex-cli') env = isolatedCodexProcessEnv(env);
      if (managedProvider && this.kind === 'codex-cli') {
        const profileKey = `agent:${agent.id}`;
        env = managedCodexProcessEnv(env, profileKey);
        managedCodexCatalogPath = prepareManagedCodexModelCatalog(profileKey, model || managedProvider.model);
        requiresManagedCodexSandbox = agent.permissionMode !== 'readonly';
      } else if (managedProvider && this.kind === 'claude-cli') {
        env = managedClaudeProcessEnv(env, `agent:${agent.id}`);
      }
      ({ bin, args } = this.buildCommand(prompt, task, agent, model, managedProvider, managedCodexCatalogPath));
      if (requiresManagedCodexSandbox) {
        const controller = new AbortController();
        this.preparing.set(task.id, controller);
        cb.onStage(task.id, '准备安全工作区');
        cb.onProgress(task.id, 2);
        try {
          await prepareManagedCodexWindowsSandbox(bin, env, workspace, controller.signal);
        } finally {
          if (this.preparing.get(task.id) === controller) this.preparing.delete(task.id);
        }
        if (this.abortedTasks.delete(task.id)) return;
      }
      child = spawnCli(bin, args, {
        cwd: workspace,
        shell: false,
        windowsHide: true,
        env
      });
    } catch (err) {
      if (this.abortedTasks.delete(task.id)) return;
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
    const preparing = this.preparing.get(taskId);
    if (preparing) {
      this.abortedTasks.add(taskId);
      this.preparing.delete(taskId);
      preparing.abort();
      return;
    }
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
