/**
 * CLI 执行器：真实拉起本机 Codex CLI / Claude Code / OpenCode / Kimi Code 等（headless 模式）
 * - 安全基线（12.3）：spawn 一律 shell:false，参数数组传递，杜绝命令注入
 * - 工作目录限定在员工 workspace（7.2 边界），不存在则创建
 * - 事件解析对版本差异保持容忍：JSONL 解析失败的行当纯文本输出处理
 * - 泛化 CLI（generic-cli）：运行参数模板取自引擎目录，可被配置文件 engines[id].runArgs 覆写
 * - 凭据：spawn 前经 resolveEngineEnv 还原加密的环境变量，明文仅存活于子进程
 *
 * @author liyingjie <y@senke.com>
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { Agent, ExecutorKind, Task } from '../../../shared/types.js';
import type { Database } from '../database.js';
import { loadConfig } from '../config.js';
import { resolveEngineEnv } from '../engineEnv.js';
import { killQuietly, type ExecutorAdapter, type ExecutorCallbacks } from './types.js';

const TIMEOUT_MS = 10 * 60_000;
const MAX_RESULT_CHARS = 16_000;

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

  private buildCommand(prompt: string, task: Task, agent: Agent): { bin: string; args: string[] } {
    // P1a 静态限权：permissionMode → CLI 沙箱/权限参数；渠道来源任务 trusted 降级为 standard（10.5），autonomous 不降级
    // 专家团任务（source='team'）默认完全自主（autonomous），无需人工审批
    const baseMode = task.source === 'team' ? 'autonomous' : agent.permissionMode;
    const mode = task.source === 'channel' && baseMode === 'trusted' ? 'standard' : baseMode;
    if (this.kind === 'codex-cli') {
      // codex exec --json：非交互执行，stdout 输出 JSONL 事件流；有 session 则 resume 续跑（P2b）
      const sandbox = mode === 'readonly' ? 'read-only' : (mode === 'trusted' || mode === 'autonomous') ? 'danger-full-access' : 'workspace-write';
      const base = task.sessionId ? ['exec', 'resume', task.sessionId] : ['exec'];
      return { bin: this.resolveBin('codex'), args: [...base, '--json', '--skip-git-repo-check', '--sandbox', sandbox, prompt] };
    }
    if (this.kind === 'claude-cli') {
      // claude -p --output-format stream-json：NDJSON 事件流；--resume 续跑同一会话（P2b）
      const perm =
        mode === 'readonly'
          ? ['--allowedTools', 'Read,Glob,Grep']
          : (mode === 'trusted' || mode === 'autonomous')
            ? ['--dangerously-skip-permissions']
            : ['--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Edit,Write,Glob,Grep,Bash'];
      const resume = task.sessionId ? ['--resume', task.sessionId] : [];
      return { bin: this.resolveBin('claude'), args: ['-p', prompt, ...resume, ...perm, '--output-format', 'stream-json', '--verbose'] };
    }
    // 泛化 CLI：运行参数模板取配置覆写，否则用目录默认；{prompt} 替换为任务提示词（权限参数由 CLI 自身配置控制）
    const override = loadConfig().engines[this.engineId]?.runArgs;
    const template = override && override.length > 0 ? override : this.defaultRunArgs;
    const args = template.map((a) => (a === '{prompt}' ? prompt : a));
    if (!template.includes('{prompt}')) args.push(prompt);
    return { bin: this.resolveBin(this.engineId.replace(/^eng-/, '')), args };
  }

  start(task: Task, agent: Agent, cb: ExecutorCallbacks): void {
    const workspace = task.workspaceOverride || agent.workspace || join(app.getPath('userData'), 'workspaces', agent.id);
    try {
      mkdirSync(workspace, { recursive: true });
    } catch (err) {
      cb.onError(task.id, `工作目录不可用：${workspace}（${err instanceof Error ? err.message : String(err)}）`);
      return;
    }

    const prompt = task.sessionId
      ? `追问：${task.title}\n请在之前会话的基础上继续处理，并输出最终结果。`
      : `${agent.systemPrompt}\n\n当前任务：${task.title}\n请直接执行该任务，并输出最终结构化结果。`;
    const { bin, args } = this.buildCommand(prompt, task, agent);

    let child: ChildProcess;
    try {
      // 引擎自定义环境变量：敏感项经 safeStorage 解密后在此还原，仅存活于子进程
      child = spawn(bin, args, {
        cwd: workspace,
        shell: false,
        windowsHide: true,
        env: { ...process.env, ...resolveEngineEnv(this.db, this.engineId) }
      });
    } catch (err) {
      cb.onError(task.id, `无法启动 ${bin}：${err instanceof Error ? err.message : String(err)}`);
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

    let full = '';
    let outBuf = '';
    let stderrBuf = '';
    let lastFlush = Date.now();
    let lastProgress = 5;
    let sawStreamEvent = false;

    const flush = (force: boolean) => {
      if (outBuf && (force || Date.now() - lastFlush >= 300)) {
        cb.onOutput(task.id, outBuf);
        outBuf = '';
        lastFlush = Date.now();
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
      full += text;
      outBuf += text;
      bump(null, Math.min(90, 10 + Math.floor(full.length / 30)));
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
        else if (type === 'error') cb.onError(task.id, String(ev.message ?? 'Codex 执行错误'));
      } else {
        const type = ev.type as string;
        if (type === 'system') {
          // P2b：提取 session_id 作为会话锚点（追问时 --resume）
          if (typeof ev.session_id === 'string' && !task.sessionId) cb.onSession?.(task.id, ev.session_id);
          bump('规划步骤', 12);
        } else if (type === 'assistant') {
          const msg = ev.message as { content?: { type: string; text?: string }[] } | undefined;
          for (const c of msg?.content ?? []) {
            if (c.type === 'text' && c.text) pushText(c.text);
            else if (c.type === 'tool_use') bump('调用工具', Math.min(88, lastProgress + 6));
          }
        } else if (type === 'result') {
          if (ev.is_error) cb.onError(task.id, String(ev.result ?? 'Claude Code 执行错误'));
          else if (typeof ev.result === 'string' && ev.result && !full) pushText(ev.result);
          bump('校验结果', 95);
        }
      }
    };

    let stdoutBuf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line) handleLine(line);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      this.running.delete(task.id);
      // ENOENT = CLI 未安装/不在 PATH
      cb.onError(task.id, `启动失败：${err.message}（请确认 ${bin} 已安装并在 PATH 中）`);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      this.running.delete(task.id);
      if (this.abortedTasks.delete(task.id)) return; // 用户取消，不回报
      if (stdoutBuf.trim()) handleLine(stdoutBuf.trim());
      flush(true);
      if (code === 0) {
        bump('校验结果', 98);
        const result = full.trim() || (sawStreamEvent ? '（执行完成，无文本产物）' : stderrBuf.slice(0, 2000));
        cb.onDone(task.id, result.slice(0, MAX_RESULT_CHARS));
      } else {
        cb.onError(task.id, `进程退出码 ${code ?? 'null'}：${(stderrBuf || '无错误输出').slice(0, 300)}`);
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
