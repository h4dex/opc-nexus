/**
 * ACP 执行器（P2a）：以 Agent Client Protocol（JSON-RPC 2.0 over stdio）统一接入外部引擎。
 * 流程：spawn 引擎进程 → initialize → session/new(cwd=workspace) → session/prompt，
 * 处理 session/update 通知（agent_message_chunk→输出、tool_call→事件、plan→阶段）；
 * session/request_permission 复用审批代理：readonly 直接拒绝、trusted 自动批准、standard 走审批 UI。
 * 引擎命令来自配置文件 engines[id].acpCommand（如 ["gemini","--experimental-acp"]）。
 * 未声明 fs 能力，引擎的 fs/* 请求一律返回 method-not-found。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Agent, ExecutorKind, Task } from '../../../shared/types.js';
import type { Database } from '../database.js';
import type { ApprovalBroker } from '../approvalBroker.js';
import { loadConfig } from '../config.js';
import { childProcessEnv, resolveEngineEnv } from '../engineEnv.js';
import {
  DEEPSEEK_HARNESS_ENGINE_ID,
  cleanupHarnessEnv,
  deepseekHarnessCommand,
  deepseekHarnessEnv,
  deepseekHarnessProviderReady,
  deepseekHarnessProcessEnv
} from '../deepseekHarnessRuntime.js';
import { harnessProviderVerificationIsCurrent } from '../harnessProviderVerification.js';
import { killQuietly, type ExecutorAdapter, type ExecutorCallbacks } from './types.js';
import { appendBoundedText, appendProcessOutput, boundedText, createProcessOutputBuffer, createUtf8StreamDecoder, finishProcessOutput } from '../textEncoding.js';

const TIMEOUT_MS = 15 * 60_000;
const MAX_RESULT_CHARS = 16_000;
const ACP_EXIT_GRACE_MS = 1_000;
const DEEPSEEK_HARNESS_EXIT_GRACE_MS = 5_000;

// Keep protocol input bounded even when a sidecar never emits a newline.
export const MAX_ACP_FRAME_BYTES = 1024 * 1024;
export const MAX_ACP_UPDATE_EVENTS = 4_096;
export const MAX_ACP_TOOL_EVENTS = 1_024;
export const MAX_ACP_ERROR_CHARS = 2_000;
export const MAX_ACP_TOOL_TITLE_CHARS = 256;
export const MAX_ACP_APPROVAL_REQUEST_CHARS = 1_000;
export const MAX_ACP_INBOUND_REQUESTS_PER_TASK_TOTAL = 1_024;
export const MAX_ACP_INBOUND_REQUESTS_PER_TASK = 8;
export const MAX_ACP_INBOUND_REQUESTS_GLOBAL = 32;

const ACP_FRAME_LIMIT_ERROR = `ACP protocol frame exceeds maximum size (${MAX_ACP_FRAME_BYTES} bytes)`;
const ACP_UPDATE_LIMIT_ERROR = `ACP session update event limit exceeded (${MAX_ACP_UPDATE_EVENTS})`;
const ACP_TOOL_LIMIT_ERROR = `ACP tool event limit exceeded (${MAX_ACP_TOOL_EVENTS})`;
const ACP_INBOUND_REQUEST_LIMIT_CODE = -32000;
const ACP_INBOUND_REQUEST_LIMIT_ERROR = 'ACP inbound request concurrency limit exceeded';
const ACP_INBOUND_REQUEST_TOTAL_LIMIT_ERROR = `ACP client request event limit exceeded (${MAX_ACP_INBOUND_REQUESTS_PER_TASK_TOTAL})`;
const ACP_PERMISSION_BUSY_ERROR = 'Permission request already pending';

const MANAGED_HARNESS_SECRET_KEYS = ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY'] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Redact provider credentials from text emitted by the managed Harness. */
export function redactManagedHarnessText(text: string, env: Record<string, string>): string {
  if (!text) return text;
  const secrets = [...new Set(MANAGED_HARNESS_SECRET_KEYS
    .map((key) => env[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0))]
    .sort((a, b) => b.length - a.length);
  let redacted = text;
  for (const secret of secrets) {
    const escaped = escapeRegExp(secret);
    redacted = redacted.replace(new RegExp(`Bearer\\s+${escaped}`, 'gi'), '[REDACTED]');
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

function frameExceedsLimit(buffer: string): boolean {
  return Buffer.byteLength(buffer, 'utf8') > MAX_ACP_FRAME_BYTES;
}

function boundedExternalText(value: unknown, maxChars: number, fallback = ''): string {
  const text = typeof value === 'string' ? value : fallback;
  if (text.length <= maxChars) return text;
  const marker = '[truncated]';
  if (maxChars <= marker.length) return marker.slice(0, maxChars);
  return `${text.slice(0, maxChars - marker.length)}${marker}`;
}

function boundedErrorText(text: string): string {
  return boundedExternalText(text, MAX_ACP_ERROR_CHARS);
}

interface ManagedTextRedactor {
  push(text: string): string;
  finish(): string;
}

/**
 * Hold a short raw suffix so a credential split across ACP notifications can
 * never be reconstructed from individually emitted renderer chunks.
 */
function createManagedTextRedactor(env: Record<string, string> | null): ManagedTextRedactor {
  const secrets = env
    ? [...new Set(MANAGED_HARNESS_SECRET_KEYS
      .map((key) => env[key])
      .filter((value): value is string => typeof value === 'string' && value.length > 0))]
    : [];
  if (!env || secrets.length === 0) {
    return { push: (text) => text, finish: () => '' };
  }

  const holdChars = Math.max(...secrets.map((secret) => secret.length)) - 1;
  let pending = '';
  return {
    push(text) {
      const combined = pending + text;
      let split = Math.max(0, combined.length - holdChars);
      for (const secret of secrets) {
        let start = combined.indexOf(secret);
        while (start >= 0) {
          const end = start + secret.length;
          if (start < split && end > split) split = start;
          start = combined.indexOf(secret, start + 1);
        }
      }
      const ready = combined.slice(0, split);
      pending = combined.slice(split);
      return redactManagedHarnessText(ready, env);
    },
    finish() {
      const ready = redactManagedHarnessText(pending, env);
      pending = '';
      return ready;
    }
  };
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface RunningAcp {
  child: ChildProcess;
  timer: NodeJS.Timeout | null;
  aborted: boolean;
  sessionId: string | null;
  send: ((message: JsonRpcMessage) => void) | null;
  shutdown: ((cancelSession: boolean) => void) | null;
  cancel: (() => void) | null;
}

function stopProbeChild(child: ChildProcess, managedHarness: boolean): void {
  if (!managedHarness) {
    killQuietly(child);
    return;
  }
  try { child.stdin?.end(); } catch { /* Process already closed. */ }
  const timer = setTimeout(() => killQuietly(child), DEEPSEEK_HARNESS_EXIT_GRACE_MS);
  timer.unref?.();
}

export interface AcpTaskProbeResult {
  ok: boolean;
  message: string;
  initialized: boolean;
  sessionCreated: boolean;
  output: string;
}

function validCommand(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === 'string' && part.length > 0);
}

/**
 * Resolve an ACP command from the engine row first, then the legacy app config.
 * The path + runArgs branch keeps engines registered by older OPC-Nexus builds
 * executable after upgrading.
 */
export function acpCommandFor(db: Database, engineId: string): string[] | null;
/** @deprecated Pass Database so custom engines stored in SQLite are visible. */
export function acpCommandFor(engineId: string): string[] | null;
export function acpCommandFor(dbOrEngineId: Database | string, maybeEngineId?: string): string[] | null {
  const db = typeof dbOrEngineId === 'string' ? null : dbOrEngineId;
  const engineId = typeof dbOrEngineId === 'string' ? dbOrEngineId : maybeEngineId;
  if (!engineId) return null;
  if (engineId === DEEPSEEK_HARNESS_ENGINE_ID) return deepseekHarnessCommand();

  if (db) {
    const row = db.raw.prepare('SELECT config_json, path FROM engines WHERE id = ?').get(engineId) as
      | { config_json?: string | null; path?: string | null }
      | undefined;
    if (row) {
      let config: { acpCommand?: unknown; command?: unknown; runArgs?: unknown } = {};
      if (row.config_json) {
        try {
          config = JSON.parse(row.config_json) as typeof config;
        } catch {
          /* Invalid per-engine config falls through to the app config. */
        }
      }
      if (validCommand(config.acpCommand)) return config.acpCommand;
      const command = typeof config.command === 'string' && config.command.length > 0
        ? config.command
        : row.path;
      if (command && (config.runArgs === undefined || Array.isArray(config.runArgs))) {
        const args = config.runArgs ?? [];
        if (args.every((part) => typeof part === 'string')) return [command, ...args];
      }
    }
  }

  const command = loadConfig().engines[engineId]?.acpCommand;
  return validCommand(command) ? command : null;
}

export class AcpExecutor implements ExecutorAdapter {
  readonly kind: ExecutorKind = 'acp';
  private running = new Map<string, RunningAcp>();
  private inboundRequestsInFlight = 0;

  constructor(private db: Database, private broker: ApprovalBroker) {}

  /** 注册表按引擎判定（引擎表 HEALTHY 由 detect 的握手探测写入） */
  engineReady(engineId: string): boolean {
    if (!acpCommandFor(this.db, engineId)) return false;
    const row = this.db.raw.prepare('SELECT status FROM engines WHERE id = ?').get(engineId) as { status: string } | undefined;
    return row?.status === 'HEALTHY'
      && (engineId !== DEEPSEEK_HARNESS_ENGINE_ID || harnessProviderVerificationIsCurrent(this.db));
  }

  /** ExecutorAdapter 接口：ACP 就绪与否按引擎粒度判断（registry 调 engineReady） */
  isReady(): boolean {
    return true;
  }

  start(task: Task, agent: Agent, cb: ExecutorCallbacks): void {
    const failBeforeStart = (message: string) => {
      cb.onError(task.id, message);
      cb.onReleased?.(task.id);
    };
    const command = acpCommandFor(this.db, agent.engineId);
    if (!command) {
      failBeforeStart(`引擎 ${agent.engineId} 未配置 acpCommand（配置文件 aibox.config.json）`);
      return;
    }
    if (agent.engineId === DEEPSEEK_HARNESS_ENGINE_ID && !deepseekHarnessProviderReady(this.db, agent)) {
      failBeforeStart('DeepSeek Harness 供应商未配置或 API Key 无效，请在设置中完成配置');
      return;
    }
    const workspace = task.workspaceOverride || agent.workspace;
    try {
      mkdirSync(workspace, { recursive: true });
    } catch (err) {
      failBeforeStart(`工作目录不可用：${workspace}（${err instanceof Error ? err.message : String(err)}）`);
      return;
    }

    let child: ChildProcess;
    let managedEnv: Record<string, string> | null = null;
    try {
      const engineEnv = resolveEngineEnv(this.db, agent.engineId);
      managedEnv = agent.engineId === DEEPSEEK_HARNESS_ENGINE_ID
        ? deepseekHarnessEnv(this.db, agent)
        : null;
      child = spawn(command[0], command.slice(1), {
        cwd: workspace,
        shell: false,
        windowsHide: true,
        env: agent.engineId === DEEPSEEK_HARNESS_ENGINE_ID
          ? deepseekHarnessProcessEnv(managedEnv ?? {})
          : childProcessEnv(engineEnv)
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const safeDetail = managedEnv ? redactManagedHarnessText(detail, managedEnv) : detail;
      if (managedEnv) {
        try { cleanupHarnessEnv(managedEnv, true); } catch { /* Preserve the launch error. */ }
      }
      failBeforeStart(`无法启动 ACP 引擎：${safeDetail}`);
      return;
    }

    const run: RunningAcp = {
      child,
      timer: null,
      aborted: false,
      sessionId: null,
      send: null,
      shutdown: null,
      cancel: null
    };
    this.running.set(task.id, run);

    // ---------- JSON-RPC 通信层 ----------
    let nextId = 1;
    const pendingReq = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();
    let finished = false;
    let childClosed = false;
    let released = false;
    let exitTimer: NodeJS.Timeout | null = null;
    let terminalCallback: (() => void) | null = null;
    const deliverTerminal = () => {
      const callback = terminalCallback;
      terminalCallback = null;
      callback?.();
    };
    const release = () => {
      if (released) return;
      released = true;
      if (this.running.get(task.id) === run) this.running.delete(task.id);
      cb.onReleased?.(task.id);
    };
    const send = (msg: JsonRpcMessage) => {
      child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
    };
    run.send = send;
    const request = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        if (finished) {
          reject(new Error('ACP 进程已结束'));
          return;
        }
        const id = nextId++;
        pendingReq.set(id, { resolve, reject });
        send({ id, method, params });
      });
    const rejectPending = (error: Error) => {
      for (const pending of pendingReq.values()) pending.reject(error);
      pendingReq.clear();
    };
    let inboundRequestCount = 0;
    const inboundRequestTokens = new Set<symbol>();
    let permissionRequestInFlight = false;
    const releaseInboundRequest = (token: symbol) => {
      if (!inboundRequestTokens.delete(token)) return;
      this.inboundRequestsInFlight = Math.max(0, this.inboundRequestsInFlight - 1);
    };
    const releaseAllInboundRequests = () => {
      this.inboundRequestsInFlight = Math.max(0, this.inboundRequestsInFlight - inboundRequestTokens.size);
      inboundRequestTokens.clear();
      permissionRequestInFlight = false;
    };
    const abandonApproval = () => {
      try {
        this.broker.abandonTask(task.id);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`[ACP] approval cleanup failed: ${boundedErrorText(managedEnv ? redactManagedHarnessText(detail, managedEnv) : detail)}`);
      }
    };
    const shutdown = (cancelSession: boolean) => {
      if (cancelSession && run.sessionId && run.send) {
        run.send({ method: 'session/cancel', params: { sessionId: run.sessionId } });
      }
      try { child.stdin?.end(); } catch { /* Process already closed. */ }
      if (!childClosed && !exitTimer) {
        const graceMs = agent.engineId === DEEPSEEK_HARNESS_ENGINE_ID
          ? DEEPSEEK_HARNESS_EXIT_GRACE_MS
          : ACP_EXIT_GRACE_MS;
        exitTimer = setTimeout(() => killQuietly(child), graceMs);
        exitTimer.unref?.();
      }
    };
    run.shutdown = shutdown;
    const clearRunTimer = () => {
      if (run.timer) clearTimeout(run.timer);
      run.timer = null;
    };
    const finish = (error?: string, result?: string, cancelSession = false) => {
      if (finished) return;
      finished = true;
      clearRunTimer();
      const safeError = error
        ? boundedErrorText(managedEnv ? redactManagedHarnessText(error, managedEnv) : error)
        : error;
      // A malicious peer may resolve session/prompt while a permission request
      // is still pending. Every terminal path must therefore release it.
      releaseAllInboundRequests();
      abandonApproval();
      rejectPending(new Error(safeError || 'ACP 会话已结束'));
      shutdown(cancelSession);
      const notify = () => {
        if (safeError) cb.onError(task.id, safeError);
        else if (result !== undefined) cb.onDone(task.id, result);
      };
      if (managedEnv) terminalCallback = notify;
      else notify();
    };
    run.cancel = () => {
      if (finished) return;
      finished = true;
      run.aborted = true;
      clearRunTimer();
      releaseAllInboundRequests();
      abandonApproval();
      rejectPending(new Error('ACP 会话已取消'));
      shutdown(true);
    };
    run.timer = setTimeout(() => {
      run.aborted = true;
      finish('执行超时（15 分钟），已请求取消 ACP 会话', undefined, true);
    }, TIMEOUT_MS);

    const fullParts: string[] = [];
    const fullState = { length: 0, truncated: false };
    let full = '';
    let lastProgress = 5;
    let updateEventCount = 0;
    let toolEventCount = 0;
    const outputRedactor = createManagedTextRedactor(managedEnv);
    const appendOutput = (text: string) => {
      const before = fullState.length;
      appendBoundedText(fullParts, fullState, text);
      const accepted = text.slice(0, Math.max(0, fullState.length - before));
      if (accepted) cb.onOutput(task.id, accepted);
      const pct = Math.min(90, 10 + Math.floor(fullState.length / 30));
      if (pct > lastProgress) {
        lastProgress = pct;
        cb.onProgress(task.id, pct);
      }
    };
    const pushText = (text: string) => appendOutput(outputRedactor.push(text));
    const recordEvent = (type: string, payload: Record<string, unknown>) => {
      this.db.raw
        .prepare('INSERT INTO task_events(id, task_id, event_type, payload, created_at) VALUES(?, ?, ?, ?, ?)')
        .run(randomUUID(), task.id, type, JSON.stringify(payload), Date.now());
    };

    /** session/update 通知映射 */
    const handleUpdate = (update: Record<string, unknown>) => {
      if (finished) return;
      updateEventCount += 1;
      if (updateEventCount > MAX_ACP_UPDATE_EVENTS) {
        run.aborted = true;
        finish(ACP_UPDATE_LIMIT_ERROR, undefined, true);
        return;
      }
      const kind = update.sessionUpdate as string;
      if (kind === 'tool_call' || kind === 'tool_call_update') {
        toolEventCount += 1;
        if (toolEventCount > MAX_ACP_TOOL_EVENTS) {
          run.aborted = true;
          finish(ACP_TOOL_LIMIT_ERROR, undefined, true);
          return;
        }
      }
      if (kind === 'agent_message_chunk') {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.text) pushText(content.text);
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        const title = managedEnv
          ? 'DeepSeek Harness tool'
          : boundedExternalText(update.title, MAX_ACP_TOOL_TITLE_CHARS, 'tool');
        if (kind === 'tool_call') {
          recordEvent('tool_call', { name: title, args: {} });
          cb.onStage(task.id, '调用工具');
        }
        if (update.status === 'completed' || update.status === 'failed') {
          recordEvent('tool_result', { name: title, status: update.status });
        }
      } else if (kind === 'plan') {
        cb.onStage(task.id, '规划步骤');
        if (lastProgress < 12) cb.onProgress(task.id, (lastProgress = 12));
      } else if (kind === 'agent_thought_chunk') {
        // 思考内容不进产物，只推进阶段
        cb.onStage(task.id, '规划步骤');
      }
    };

    /** 引擎→客户端请求处理（审批 / 未支持能力） */
    const handleRequest = async (msg: JsonRpcMessage) => {
      const id = msg.id!;
      if (msg.method === 'session/request_permission') {
        const params = msg.params ?? {};
        const options = (params.options as { optionId: string; kind: string }[] | undefined) ?? [];
        const toolCall = params.toolCall as { title?: string } | undefined;
        const toolTitle = managedEnv
          ? 'DeepSeek Harness tool'
          : boundedExternalText(toolCall?.title, MAX_ACP_TOOL_TITLE_CHARS, '执行工具操作');
        const allow = options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always');
        const reject = options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always');
        const pick = (opt?: { optionId: string }) =>
          send({ id, result: opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } } });

        // ACP rc.6 不携带稳定风险等级，沿用 OPC-Nexus 的统一权限语义。
        const effectiveMode = task.source === 'team' ? 'autonomous' : agent.permissionMode;
        if (effectiveMode === 'readonly') return pick(reject);
        if (effectiveMode === 'autonomous' || (effectiveMode === 'trusted' && task.source !== 'channel')) return pick(allow);
        const approved = await this.broker.request({
          taskId: task.id,
          agentId: agent.id,
          type: 'write_workspace',
          request: boundedExternalText(
            `${agent.name}（ACP 引擎）请求权限：${toolTitle}`,
            MAX_ACP_APPROVAL_REQUEST_CHARS
          ),
          risk: 'medium'
        });
        if (run.aborted || finished) return;
        return pick(approved ? allow : reject);
      }
      // 未声明 fs/terminal 能力 → method not found
      send({ id, error: { code: -32601, message: `Method not supported: ${msg.method}` } });
    };

    const rejectInboundRequest = (msg: JsonRpcMessage, message: string) => {
      send({ id: msg.id!, error: { code: ACP_INBOUND_REQUEST_LIMIT_CODE, message } });
    };
    const dispatchInboundRequest = (msg: JsonRpcMessage) => {
      inboundRequestCount += 1;
      if (inboundRequestCount > MAX_ACP_INBOUND_REQUESTS_PER_TASK_TOTAL) {
        rejectInboundRequest(msg, ACP_INBOUND_REQUEST_TOTAL_LIMIT_ERROR);
        run.aborted = true;
        finish(ACP_INBOUND_REQUEST_TOTAL_LIMIT_ERROR, undefined, true);
        return;
      }
      const isPermissionRequest = msg.method === 'session/request_permission';
      if (isPermissionRequest && permissionRequestInFlight) {
        rejectInboundRequest(msg, ACP_PERMISSION_BUSY_ERROR);
        return;
      }
      if (
        inboundRequestTokens.size >= MAX_ACP_INBOUND_REQUESTS_PER_TASK
        || this.inboundRequestsInFlight >= MAX_ACP_INBOUND_REQUESTS_GLOBAL
      ) {
        rejectInboundRequest(msg, ACP_INBOUND_REQUEST_LIMIT_ERROR);
        return;
      }

      const token = Symbol('acp-inbound-request');
      inboundRequestTokens.add(token);
      this.inboundRequestsInFlight += 1;
      if (isPermissionRequest) permissionRequestInFlight = true;
      void handleRequest(msg).catch((err) => {
        if (!finished) finish(`ACP 客户端请求处理失败：${err instanceof Error ? err.message : String(err)}`);
      }).finally(() => {
        releaseInboundRequest(token);
        if (isPermissionRequest) permissionRequestInFlight = false;
      });
    };

    // ---------- stdout 逐行解析 ----------
    let buf = '';
    const stdoutDecoder = createUtf8StreamDecoder();
    child.stdout?.on('data', (chunk: Buffer) => {
      if (finished) return;
      buf += stdoutDecoder.write(chunk);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        if (finished) return;
        const rawLine = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (frameExceedsLimit(rawLine)) {
          run.aborted = true;
          finish(ACP_FRAME_LIMIT_ERROR, undefined, true);
          return;
        }
        const line = rawLine.trim();
        if (!line) continue;
        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(line) as JsonRpcMessage;
        } catch {
          finish(`ACP 协议错误：stdout 包含非 JSON 数据：${line.slice(0, 200)}`);
          return;
        }
        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
          const p = pendingReq.get(msg.id as number);
          if (p) {
            pendingReq.delete(msg.id as number);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result ?? {});
          }
        } else if (msg.method === 'session/update') {
          const update = (msg.params?.update ?? {}) as Record<string, unknown>;
          handleUpdate(update);
        } else if (msg.method && msg.id !== undefined) {
          dispatchInboundRequest(msg);
        }
      }
      if (frameExceedsLimit(buf)) {
        run.aborted = true;
        finish(ACP_FRAME_LIMIT_ERROR, undefined, true);
      }
    });

    const stderrOutput = createProcessOutputBuffer();
    let stderrBuf = '';
    child.stderr?.on('data', (c: Buffer) => appendProcessOutput(stderrOutput, c));
    child.stdin?.on('error', (err) => {
      finish(`ACP stdin 写入失败：${err.message}`);
    });
    child.on('error', (err) => {
      finish(`ACP 进程启动失败：${err.message}`);
    });
    child.on('close', (code) => {
      childClosed = true;
      releaseAllInboundRequests();
      if (exitTimer) clearTimeout(exitTimer);
      exitTimer = null;
      buf += stdoutDecoder.end();
      stderrBuf = finishProcessOutput(stderrOutput);
      if (!finished && !run.aborted) {
        if (frameExceedsLimit(buf)) finish(ACP_FRAME_LIMIT_ERROR, undefined, true);
        else finish(`ACP 进程意外退出（码 ${code ?? 'null'}）：${stderrBuf.slice(0, 300) || '无错误输出'}`);
      } else {
        rejectPending(new Error(`ACP 进程已退出（代码 ${code ?? 'null'}）`));
      }
      if (managedEnv) {
        try { cleanupHarnessEnv(managedEnv, true); } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          console.error(`[DeepSeek Harness] runtime cleanup failed: ${redactManagedHarnessText(detail, managedEnv)}`);
        }
      }
      deliverTerminal();
      release();
    });

    cb.onStage(task.id, '理解需求');
    cb.onProgress(task.id, 5);

    // ---------- 会话主流程 ----------
    void (async () => {
      try {
        await request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
        });
        if (run.aborted || finished) return;
        cb.onStage(task.id, '规划步骤');
        const session = await request('session/new', { cwd: workspace, mcpServers: [] });
        if (run.aborted || finished) return;
        const sessionId = String(session.sessionId ?? '');
        if (!sessionId) throw new Error('ACP session/new 未返回 sessionId');
        run.sessionId = sessionId;

        const promptText = `${agent.systemPrompt}\n\n当前任务：${task.content || task.title}\n请直接执行该任务，并输出最终结构化结果。`;
        const result = await request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: promptText }]
        });
        if (run.aborted) return;
        appendOutput(outputRedactor.finish());
        full = boundedText(fullParts, fullState);

        const stopReason = String(result.stopReason ?? 'end_turn');
        if (stopReason === 'end_turn') {
          if (!full.trim()) {
            finish('ACP 引擎未产生文本输出');
            return;
          }
          cb.onStage(task.id, '校验结果');
          cb.onProgress(task.id, 98);
          finish(undefined, full.slice(0, MAX_RESULT_CHARS));
        } else if (stopReason === 'cancelled') {
          // A locally requested abort returns above via run.aborted. Reaching
          // this branch means the sidecar cancelled independently, so the
          // orchestrator still needs a terminal callback.
          finish('ACP 会话已取消或中断');
        } else if (stopReason === 'max_turn_requests') {
          finish('ACP 引擎达到最大轮次限制，任务未完整完成');
        } else {
          finish(`ACP 会话异常结束：${stopReason}`);
        }
      } catch (err) {
        if (run.aborted || finished) return;
        finish(`ACP 执行失败：${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }

  abort(taskId: string): void {
    const run = this.running.get(taskId);
    run?.cancel?.();
  }
}

/** 检测握手：spawn + initialize 成功即认为引擎可用（EngineManager.detect 调用，10s 超时） */
export interface AcpProbeOptions {
  managedHarness?: boolean;
  /** Optional read-only prompt used by control-plane advisors. */
  prompt?: string;
  maxOutputChars?: number;
}

export function probeAcpEngine(
  command: string[],
  env: Record<string, string> = {},
  options: AcpProbeOptions = {}
): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    const managedHarness = options.managedHarness === true;
    let child: ChildProcess;
    try {
      child = spawn(command[0], command.slice(1), {
        shell: false,
        windowsHide: true,
        env: managedHarness
          ? deepseekHarnessProcessEnv(env)
          : childProcessEnv(env)
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (managedHarness) {
        try { cleanupHarnessEnv(env); } catch { /* Preserve the launch error. */ }
      }
      return resolve({
        ok: false,
        message: boundedErrorText(managedHarness ? redactManagedHarnessText(detail, env) : detail)
      });
    }
    let settled = false;
    let childClosed = false;
    let outcome: { ok: boolean; message: string } | null = null;
    const cleanup = () => {
      if (!managedHarness) return;
      try { cleanupHarnessEnv(env); } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`[DeepSeek Harness] probe cleanup failed: ${redactManagedHarnessText(detail, env)}`);
      }
    };
    const done = (ok: boolean, message: string) => {
      if (settled) return;
      settled = true;
      outcome = {
        ok,
        message: boundedErrorText(managedHarness ? redactManagedHarnessText(message, env) : message)
      };
      stopProbeChild(child, managedHarness);
      if (!managedHarness || childClosed) {
        cleanup();
        resolve(outcome);
      }
    };
    const timer = setTimeout(() => done(false, '握手超时（10s）'), 10_000);
    let buf = '';
    const stdoutDecoder = createUtf8StreamDecoder();
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      buf += stdoutDecoder.write(chunk);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        if (settled) return;
        const rawLine = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (frameExceedsLimit(rawLine)) {
          clearTimeout(timer);
          done(false, ACP_FRAME_LIMIT_ERROR);
          return;
        }
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcMessage;
          if (msg.id === 1 && msg.error) {
            clearTimeout(timer);
            done(false, msg.error.message);
            return;
          }
          if (msg.id === 1 && msg.result !== undefined) {
            if (msg.error) {
              clearTimeout(timer);
              done(false, msg.error.message);
              return;
            }
            clearTimeout(timer);
            done(true, 'ok');
            return;
          }
        } catch {
          /* 忽略非 JSON 行 */
        }
      }
      if (frameExceedsLimit(buf)) {
        clearTimeout(timer);
        done(false, ACP_FRAME_LIMIT_ERROR);
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      done(false, err.message);
    });
    child.on('close', () => {
      childClosed = true;
      clearTimeout(timer);
      buf += stdoutDecoder.end();
      done(false, frameExceedsLimit(buf) ? ACP_FRAME_LIMIT_ERROR : '进程提前退出');
      if (managedHarness && outcome) {
        cleanup();
        resolve(outcome);
      }
    });
    child.stdin?.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }
      }) + '\n'
    );
  });
}

/**
 * Run a real, read-only ACP turn. A successful initialize is deliberately not
 * enough here: health is verified only after session/prompt emits model text.
 */
export function probeAcpTask(
  command: string[],
  env: Record<string, string> = {},
  cwd = process.cwd(),
  timeoutMs = 60_000,
  options: AcpProbeOptions = {}
): Promise<AcpTaskProbeResult> {
  return new Promise((resolve) => {
    const managedHarness = options.managedHarness === true;
    const prompt = options.prompt?.trim() || 'Reply with exactly OPC_HARNESS_OK. Do not call tools.';
    const maxOutputChars = Math.max(100, Math.min(options.maxOutputChars ?? 4_000, 16_000));
    let child: ChildProcess;
    try {
      child = spawn(command[0], command.slice(1), {
        cwd,
        shell: false,
        windowsHide: true,
        env: managedHarness
          ? deepseekHarnessProcessEnv(env)
          : childProcessEnv(env)
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (managedHarness) {
        try { cleanupHarnessEnv(env); } catch { /* Preserve the launch error. */ }
      }
      return resolve({
        ok: false,
        message: boundedErrorText(managedHarness ? redactManagedHarnessText(detail, env) : detail),
        initialized: false,
        sessionCreated: false,
        output: ''
      });
    }

    let settled = false;
    let childClosed = false;
    let initialized = false;
    let sessionCreated = false;
    let sessionId = '';
    let timer: NodeJS.Timeout | undefined;
    let stderr = '';
    let buf = '';
    let updateEventCount = 0;
    let toolEventCount = 0;
    let outcome: AcpTaskProbeResult | null = null;
    const stdoutDecoder = createUtf8StreamDecoder();
    const outputParts: string[] = [];
    const outputState = { length: 0, truncated: false };
    const send = (message: JsonRpcMessage) => {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    };
    const done = (ok: boolean, message: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const rawOutput = boundedText(outputParts, outputState).trim();
      const output = managedHarness ? redactManagedHarnessText(rawOutput, env) : rawOutput;
      if (!ok && sessionId) send({ method: 'session/cancel', params: { sessionId } });
      stopProbeChild(child, managedHarness);
      outcome = {
        ok,
        message: boundedErrorText(managedHarness ? redactManagedHarnessText(message, env) : message),
        initialized,
        sessionCreated,
        output
      };
      if (!managedHarness || childClosed) resolve(outcome);
    };
    const failFromRpc = (stage: string, msg: JsonRpcMessage) => {
      const detail = msg.error?.message || stderr.trim() || '未知错误';
      done(false, `${stage} 失败：${detail.slice(0, 500)}`);
    };

    timer = setTimeout(() => done(false, `最小任务超时（${Math.ceil(timeoutMs / 1000)}s）`), timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      buf += stdoutDecoder.write(chunk);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        if (settled) return;
        const rawLine = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (frameExceedsLimit(rawLine)) {
          done(false, ACP_FRAME_LIMIT_ERROR);
          return;
        }
        const line = rawLine.trim();
        if (!line) continue;
        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(line) as JsonRpcMessage;
        } catch {
          continue;
        }

        if (msg.method === 'session/update') {
          const update = (msg.params?.update ?? {}) as Record<string, unknown>;
          updateEventCount += 1;
          if (updateEventCount > MAX_ACP_UPDATE_EVENTS) {
            done(false, ACP_UPDATE_LIMIT_ERROR);
            return;
          }
          const kind = update.sessionUpdate;
          if (kind === 'tool_call' || kind === 'tool_call_update') {
            toolEventCount += 1;
            if (toolEventCount > MAX_ACP_TOOL_EVENTS) {
              done(false, ACP_TOOL_LIMIT_ERROR);
              return;
            }
          }
          if (update.sessionUpdate === 'agent_message_chunk') {
            const content = update.content as { type?: string; text?: string } | undefined;
            if (content?.type === 'text' && content.text) {
              appendBoundedText(outputParts, outputState, content.text, maxOutputChars);
            }
          }
          continue;
        }

        // The probe never grants host-side filesystem or terminal permissions.
        if (msg.method && msg.id !== undefined) {
          send({ id: msg.id, error: { code: -32601, message: `Method not supported during health probe: ${msg.method}` } });
          continue;
        }

        if (msg.id === 1) {
          if (msg.error || msg.result === undefined) {
            failFromRpc('ACP initialize', msg);
            continue;
          }
          initialized = true;
          send({ id: 2, method: 'session/new', params: { cwd, mcpServers: [] } });
          continue;
        }

        if (msg.id === 2) {
          if (msg.error || msg.result === undefined) {
            failFromRpc('ACP session/new', msg);
            continue;
          }
          sessionId = String(msg.result.sessionId ?? '');
          if (!sessionId) {
            done(false, 'ACP session/new 未返回 sessionId');
            continue;
          }
          sessionCreated = true;
          send({
            id: 3,
            method: 'session/prompt',
            params: {
              sessionId,
              prompt: [{ type: 'text', text: prompt }]
            }
          });
          continue;
        }

        if (msg.id === 3) {
          if (msg.error || msg.result === undefined) {
            failFromRpc('ACP session/prompt', msg);
            continue;
          }
          const output = boundedText(outputParts, outputState).trim();
          if (!output) {
            done(false, 'ACP session/prompt 已结束，但没有返回模型文本');
            continue;
          }
          done(true, '最小 ACP 任务已返回模型文本');
        }
      }
      if (frameExceedsLimit(buf)) done(false, ACP_FRAME_LIMIT_ERROR);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4_000) stderr += chunk.toString('utf8').slice(0, 4_000 - stderr.length);
    });
    child.on('error', (err) => done(false, err.message));
    child.on('close', (code) => {
      childClosed = true;
      buf += stdoutDecoder.end();
      const detail = stderr.trim();
      done(false, frameExceedsLimit(buf)
        ? ACP_FRAME_LIMIT_ERROR
        : `ACP 进程提前退出（代码 ${code ?? 'null'}）${detail ? `：${detail.slice(0, 500)}` : ''}`);
      if (managedHarness) {
        try { cleanupHarnessEnv(env); } catch (err) {
          const cleanupDetail = err instanceof Error ? err.message : String(err);
          console.error(`[DeepSeek Harness] task probe cleanup failed: ${redactManagedHarnessText(cleanupDetail, env)}`);
        }
        if (outcome) resolve(outcome);
      }
    });

    send({
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }
    });
  });
}
