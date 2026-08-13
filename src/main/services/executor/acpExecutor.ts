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
import { killQuietly, type ExecutorAdapter, type ExecutorCallbacks } from './types.js';
import { appendBoundedText, appendProcessOutput, boundedText, createProcessOutputBuffer, createUtf8StreamDecoder, finishProcessOutput } from '../textEncoding.js';

const TIMEOUT_MS = 15 * 60_000;
const MAX_RESULT_CHARS = 16_000;

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
  timer: NodeJS.Timeout;
  aborted: boolean;
}

/** 解析配置文件中的 ACP 启动命令 */
export function acpCommandFor(engineId: string): string[] | null {
  const cmd = loadConfig().engines[engineId]?.acpCommand;
  return Array.isArray(cmd) && cmd.length > 0 && cmd.every((c) => typeof c === 'string') ? cmd : null;
}

export class AcpExecutor implements ExecutorAdapter {
  readonly kind: ExecutorKind = 'acp';
  private running = new Map<string, RunningAcp>();

  constructor(private db: Database, private broker: ApprovalBroker) {}

  /** 注册表按引擎判定（引擎表 HEALTHY 由 detect 的握手探测写入） */
  engineReady(engineId: string): boolean {
    if (!acpCommandFor(engineId)) return false;
    const row = this.db.raw.prepare('SELECT status FROM engines WHERE id = ?').get(engineId) as { status: string } | undefined;
    return row?.status === 'HEALTHY';
  }

  /** ExecutorAdapter 接口：ACP 就绪与否按引擎粒度判断（registry 调 engineReady） */
  isReady(): boolean {
    return true;
  }

  start(task: Task, agent: Agent, cb: ExecutorCallbacks): void {
    const command = acpCommandFor(agent.engineId);
    if (!command) {
      cb.onError(task.id, `引擎 ${agent.engineId} 未配置 acpCommand（配置文件 aibox.config.json）`);
      return;
    }
    const workspace = agent.workspace;
    try {
      mkdirSync(workspace, { recursive: true });
    } catch (err) {
      cb.onError(task.id, `工作目录不可用：${workspace}（${err instanceof Error ? err.message : String(err)}）`);
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(command[0], command.slice(1), { cwd: workspace, shell: false, windowsHide: true, env: process.env });
    } catch (err) {
      cb.onError(task.id, `无法启动 ACP 引擎：${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const run: RunningAcp = {
      child,
      timer: setTimeout(() => {
        run.aborted = true;
        killQuietly(child);
        cb.onError(task.id, '执行超时（15 分钟），已终止 ACP 进程');
      }, TIMEOUT_MS),
      aborted: false
    };
    this.running.set(task.id, run);

    cb.onStage(task.id, '理解需求');
    cb.onProgress(task.id, 5);

    // ---------- JSON-RPC 通信层 ----------
    let nextId = 1;
    const pendingReq = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();
    const send = (msg: JsonRpcMessage) => {
      child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
    };
    const request = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pendingReq.set(id, { resolve, reject });
        send({ id, method, params });
      });

    const fullParts: string[] = [];
    const fullState = { length: 0, truncated: false };
    let full = '';
    let lastProgress = 5;
    const pushText = (text: string) => {
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
    const recordEvent = (type: string, payload: Record<string, unknown>) => {
      this.db.raw
        .prepare('INSERT INTO task_events(id, task_id, event_type, payload, created_at) VALUES(?, ?, ?, ?, ?)')
        .run(randomUUID(), task.id, type, JSON.stringify(payload), Date.now());
    };

    /** session/update 通知映射 */
    const handleUpdate = (update: Record<string, unknown>) => {
      const kind = update.sessionUpdate as string;
      if (kind === 'agent_message_chunk') {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.text) pushText(content.text);
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        if (kind === 'tool_call') {
          recordEvent('tool_call', { name: (update.title as string) ?? 'tool', args: {} });
          cb.onStage(task.id, '调用工具');
        }
        if (update.status === 'completed' || update.status === 'failed') {
          recordEvent('tool_result', { name: (update.title as string) ?? 'tool', status: update.status });
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
        const allow = options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always');
        const reject = options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always');
        const pick = (opt?: { optionId: string }) =>
          send({ id, result: opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } } });

        // 权限策略：readonly 拒绝；trusted（非渠道任务）自动批准；standard/渠道任务 → 审批 UI
        if (agent.permissionMode === 'readonly') return pick(reject);
        if (agent.permissionMode === 'trusted' && task.source !== 'channel') return pick(allow);
        const approved = await this.broker.request({
          taskId: task.id,
          agentId: agent.id,
          type: 'write_workspace',
          request: `${agent.name}（ACP 引擎）请求权限：${toolCall?.title ?? '执行工具操作'}`,
          risk: 'medium'
        });
        return pick(approved ? allow : reject);
      }
      // 未声明 fs/terminal 能力 → method not found
      send({ id, error: { code: -32601, message: `Method not supported: ${msg.method}` } });
    };

    // ---------- stdout 逐行解析 ----------
    let buf = '';
    const stdoutDecoder = createUtf8StreamDecoder();
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += stdoutDecoder.write(chunk);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(line) as JsonRpcMessage;
        } catch {
          continue; // 非 JSON 行忽略（引擎日志）
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
          void handleRequest(msg);
        }
      }
    });

    const stderrOutput = createProcessOutputBuffer();
    let stderrBuf = '';
    child.stderr?.on('data', (c: Buffer) => appendProcessOutput(stderrOutput, c));
    child.on('error', (err) => {
      clearTimeout(run.timer);
      this.running.delete(task.id);
      cb.onError(task.id, `ACP 进程启动失败：${err.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(run.timer);
      buf += stdoutDecoder.end();
      stderrBuf = finishProcessOutput(stderrOutput);
      const wasRunning = this.running.delete(task.id);
      // 会话未正常结束就退出 → 如实报错（正常完成路径已在 prompt 返回时处理）
      if (wasRunning && !run.aborted) {
        cb.onError(task.id, `ACP 进程意外退出（码 ${code ?? 'null'}）：${stderrBuf.slice(0, 300) || '无错误输出'}`);
      }
    });

    // ---------- 会话主流程 ----------
    void (async () => {
      try {
        await request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
        });
        cb.onStage(task.id, '规划步骤');
        const session = await request('session/new', { cwd: workspace, mcpServers: [] });
        const sessionId = String(session.sessionId ?? '');
        if (sessionId && !task.sessionId) cb.onSession?.(task.id, `acp-${sessionId}`);

        const promptText = `${agent.systemPrompt}\n\n当前任务：${task.title}\n请直接执行该任务，并输出最终结构化结果。`;
        const result = await request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: promptText }]
        });
        if (run.aborted) return;
        full = boundedText(fullParts, fullState);
        this.running.delete(task.id);
        clearTimeout(run.timer);
        killQuietly(child);

        const stopReason = String(result.stopReason ?? 'end_turn');
        if (stopReason === 'end_turn' || stopReason === 'max_turn_requests') {
          if (!full.trim()) {
            cb.onError(task.id, 'ACP 引擎未产生文本输出');
            return;
          }
          cb.onStage(task.id, '校验结果');
          cb.onProgress(task.id, 98);
          cb.onDone(task.id, full.slice(0, MAX_RESULT_CHARS));
        } else if (stopReason === 'cancelled') {
          /* 用户取消：状态由 orchestrator 置 CANCELLED */
        } else {
          cb.onError(task.id, `ACP 会话异常结束：${stopReason}`);
        }
      } catch (err) {
        if (run.aborted) return;
        this.running.delete(task.id);
        clearTimeout(run.timer);
        killQuietly(child);
        cb.onError(task.id, `ACP 执行失败：${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }

  abort(taskId: string): void {
    const run = this.running.get(taskId);
    if (run) {
      run.aborted = true;
      clearTimeout(run.timer);
      this.broker.abandonTask(taskId);
      killQuietly(run.child);
      this.running.delete(taskId);
    }
  }
}

/** 检测握手：spawn + initialize 成功即认为引擎可用（EngineManager.detect 调用，10s 超时） */
export function probeAcpEngine(command: string[]): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command[0], command.slice(1), { shell: false, windowsHide: true, env: process.env });
    } catch (err) {
      return resolve({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
    let settled = false;
    const done = (ok: boolean, message: string) => {
      if (!settled) {
        settled = true;
        killQuietly(child);
        resolve({ ok, message });
      }
    };
    const timer = setTimeout(() => done(false, '握手超时（10s）'), 10_000);
    let buf = '';
    const stdoutDecoder = createUtf8StreamDecoder();
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += stdoutDecoder.write(chunk);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcMessage;
          if (msg.id === 1 && msg.result !== undefined) {
            clearTimeout(timer);
            done(true, 'ok');
            return;
          }
        } catch {
          /* 忽略非 JSON 行 */
        }
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      done(false, err.message);
    });
    child.on('close', () => {
      clearTimeout(timer);
      buf += stdoutDecoder.end();
      done(false, '进程提前退出');
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
