/**
 * Hermes Agent 执行器：真实拉起 NousResearch/hermes-agent CLI（headless 一次性模式）。
 *
 * 接口事实均经本机实测核实（v0.19.0），详见 src/docs/architecture-review.md 附录：
 * - `hermes -z "<prompt>"`：stdout 仅输出最终响应纯文本，**无 JSONL 事件流**，
 *   故无法像 Codex/Claude 那样做细粒度阶段解析，进度按输出长度粗粒度推进
 * - `--usage-file <path>`：写出 JSON 用量报告（含 session_id / token / 成本），
 *   失败时也会写出；这是拿到 session_id 的**唯一途径**（-z 模式不打印 session 行）
 * - `-r <session_id>`：续接会话；配合 --no-restore-cwd 阻止 cd 回旧目录，
 *   因为工作目录由本应用按员工 workspace 托管
 * - 无 `--cwd` 参数，工作目录只能经 spawn 的 cwd 选项传入
 * - 退出码：0 成功 / 1 错误 / 2 空响应或参数校验失败 / 130 中断
 *
 * 权限映射（对应四级权限模型）：
 *   readonly            → 不传 --accept-hooks，并用 -t 限制为只读工具集
 *   standard            → 不传 --accept-hooks（保留 hook 审批）
 *   trusted/autonomous  → 传 --accept-hooks
 * 渠道来源任务的 trusted 降级为 standard（10.5），autonomous 不降级。
 * 任何情况下都不传 --yolo：它会绕过全部危险命令审批，不映射到本应用任一权限级别。
 *
 * @author liyingjie <y@senke.com>
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import type { Agent, ExecutorKind, Task } from '../../../shared/types.js';
import type { Database } from '../database.js';
import { loadConfig } from '../config.js';
import { resolveEngineEnv } from '../engineEnv.js';
import type { ExecutorAdapter, ExecutorCallbacks } from './types.js';

const ENGINE_ID = 'eng-hermes-cli';
const TIMEOUT_MS = 15 * 60_000;
const MAX_RESULT_CHARS = 16_000;

/** hermes --usage-file 写出的 JSON 结构（仅取本应用需要的字段） */
interface HermesUsageReport {
  session_id?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  model?: string | null;
  failed?: boolean;
  failure?: string;
}

interface RunningChild {
  child: ChildProcess;
  timer: NodeJS.Timeout;
  usageFile: string;
}

export class HermesAgentExecutor implements ExecutorAdapter {
  readonly kind: ExecutorKind = 'generic-cli';
  private running = new Map<string, RunningChild>();
  /** 被用户主动取消的任务：close 回调中不再回报错误（状态已由 orchestrator 置 CANCELLED） */
  private abortedTasks = new Set<string>();

  constructor(private db: Database) {}

  /** 就绪 = 引擎表状态 HEALTHY（由 EngineManager.detect 真实探测 hermes 二进制后写入） */
  isReady(): boolean {
    const row = this.db.raw.prepare('SELECT status FROM engines WHERE id = ?').get(ENGINE_ID) as { status: string } | undefined;
    return row?.status === 'HEALTHY';
  }

  /** 优先用 detect 解析到的真实路径（Windows 上 .cmd 无法 shell:false 直启，detect 已优先 .exe） */
  private resolveBin(): string {
    const row = this.db.raw.prepare('SELECT path FROM engines WHERE id = ?').get(ENGINE_ID) as { path: string | null } | undefined;
    return row?.path || 'hermes';
  }

  /** 构造 headless 参数；运行参数模板可被配置文件 engines['eng-hermes-cli'].runArgs 覆写 */
  private buildArgs(prompt: string, task: Task, agent: Agent, usageFile: string): string[] {
    const override = loadConfig().engines[ENGINE_ID]?.runArgs;
    if (override && override.length > 0) {
      // 用户完全接管参数模板：仅做 {prompt} 占位替换，不再叠加本应用的默认策略
      const args = override.map((a) => (a === '{prompt}' ? prompt : a));
      if (!override.includes('{prompt}')) args.push(prompt);
      return args;
    }

    const args = ['-z', prompt, '--usage-file', usageFile];

    // 权限映射：trusted/autonomous 才免 hook 审批；渠道来源任务的 trusted 降级为 standard（10.5）
    const baseMode = task.source === 'team' ? 'autonomous' : agent.permissionMode;
    const mode = task.source === 'channel' && baseMode === 'trusted' ? 'standard' : baseMode;
    if (mode === 'trusted' || mode === 'autonomous') args.push('--accept-hooks');
    if (mode === 'readonly') args.push('-t', 'files');

    // 会话续接：工作目录由本应用托管，阻止 hermes cd 回会话记录的旧目录
    if (task.sessionId?.startsWith('hermes-')) {
      args.push('-r', task.sessionId.slice('hermes-'.length), '--no-restore-cwd');
    }
    if (agent.modelOverride) args.push('-m', agent.modelOverride);
    return args;
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
    const usageFile = join(tmpdir(), `hermes-usage-${randomUUID().slice(0, 8)}.json`);
    const args = this.buildArgs(prompt, task, agent, usageFile);
    const bin = this.resolveBin();

    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        cwd: workspace,
        shell: false,
        windowsHide: true,
        env: { ...process.env, ...resolveEngineEnv(this.db, ENGINE_ID) }
      });
    } catch (err) {
      cb.onError(task.id, `无法启动 ${bin}：${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      cb.onError(task.id, '执行超时（15 分钟），已终止 Hermes 进程');
    }, TIMEOUT_MS);
    this.running.set(task.id, { child, timer, usageFile });

    cb.onStage(task.id, '理解需求');
    cb.onProgress(task.id, 5);

    // -z 模式无事件流：按输出长度粗粒度推进进度，不伪造阶段细节
    let full = '';
    let stderrBuf = '';
    let outBuf = '';
    let lastFlush = Date.now();
    let lastProgress = 5;

    const flush = (force: boolean) => {
      if (outBuf && (force || Date.now() - lastFlush >= 300)) {
        cb.onOutput(task.id, outBuf);
        outBuf = '';
        lastFlush = Date.now();
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      full += text;
      outBuf += text;
      const pct = Math.min(90, 10 + Math.floor(full.length / 30));
      if (pct > lastProgress) {
        lastProgress = pct;
        cb.onProgress(task.id, pct);
        if (pct > 40) cb.onStage(task.id, '生成产物');
      }
      flush(false);
    });
    child.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString('utf8'); });

    child.on('error', (err) => {
      clearTimeout(timer);
      this.running.delete(task.id);
      this.cleanupUsage(usageFile);
      cb.onError(task.id, `启动失败：${err.message}（请确认 hermes 已安装并在 PATH 中）`);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      this.running.delete(task.id);
      if (this.abortedTasks.delete(task.id)) {
        this.cleanupUsage(usageFile);
        return; // 用户取消，状态已由 orchestrator 置 CANCELLED
      }
      flush(true);

      // 用量报告：失败时同样写出，先读再按退出码分流
      const usage = this.readUsage(usageFile);
      if (usage?.session_id && !task.sessionId) cb.onSession?.(task.id, `hermes-${usage.session_id}`);
      if (usage) this.recordUsage(task, agent, usage);

      if (code === 0) {
        const result = full.trim();
        if (!result) {
          cb.onError(task.id, 'Hermes 执行完成但未产生文本输出');
          return;
        }
        cb.onStage(task.id, '校验结果');
        cb.onProgress(task.id, 98);
        cb.onDone(task.id, result.slice(0, MAX_RESULT_CHARS));
        return;
      }

      // 退出码语义（实测）：1 = 运行错误；2 = 空响应/参数校验失败；130 = 中断
      const detail = usage?.failure || stderrBuf.trim() || full.trim() || '无错误输出';
      if (code === 130) {
        cb.onError(task.id, 'Hermes 执行被中断');
      } else if (code === 2) {
        cb.onError(task.id, `Hermes 未产生有效响应（退出码 2）：${detail.slice(0, 300)}`);
      } else {
        cb.onError(task.id, `Hermes 执行失败（退出码 ${code ?? 'null'}）：${detail.slice(0, 300)}`);
      }
    });
  }

  abort(taskId: string): void {
    const run = this.running.get(taskId);
    if (run) {
      this.abortedTasks.add(taskId);
      clearTimeout(run.timer);
      run.child.kill();
      this.running.delete(taskId);
    }
  }

  /** 读取并删除临时用量文件；读取失败不影响主流程 */
  private readUsage(path: string): HermesUsageReport | null {
    try {
      const report = JSON.parse(readFileSync(path, 'utf8')) as HermesUsageReport;
      return report;
    } catch {
      return null;
    } finally {
      this.cleanupUsage(path);
    }
  }

  private cleanupUsage(path: string): void {
    try { rmSync(path, { force: true }); } catch { /* 临时文件清理失败可忽略 */ }
  }

  /** token 用量落库（与 Nexus executor 口径一致，供用量统计页汇总） */
  private recordUsage(task: Task, agent: Agent, usage: HermesUsageReport): void {
    if (!usage.total_tokens && !usage.input_tokens && !usage.output_tokens) return;
    try {
      this.db.raw.prepare(
        'INSERT INTO usage_records(id, task_id, agent_id, model, input_tokens, output_tokens, total_tokens, created_at) VALUES(?,?,?,?,?,?,?,?)'
      ).run(
        randomUUID(), task.id, agent.id, usage.model ?? 'hermes',
        usage.input_tokens ?? 0, usage.output_tokens ?? 0, usage.total_tokens ?? 0, Date.now()
      );
    } catch { /* 统计失败不影响主流程 */ }
  }
}
