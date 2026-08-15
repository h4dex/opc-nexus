/**
 * Hermes Agent 执行器：真实拉起 NousResearch/hermes-agent CLI（headless 模式）。
 *
 * 接口事实均经本机实测核实（v0.19.0），详见 src/docs/architecture-review.md 附录：
 * - `hermes -z "<prompt>"`：stdout 仅输出最终响应纯文本，**无 JSONL 事件流**，
 *   故无法像 Codex/Claude 那样做细粒度阶段解析，进度按输出长度粗粒度推进
 * - `--usage-file <path>`：写出 JSON 用量报告（含 session_id / token / 成本），
 *   失败时也会写出；这是拿到 session_id 的**唯一途径**（-z 模式不打印 session 行）
 * - v0.19.0 的顶层 `-z` 会在 chat 分支前退出，因而会静默忽略 `--resume`；首轮使用
 *   `-z + --usage-file`，续接必须使用 `chat -Q -q ... --resume <session_id>`
 * - quiet chat 把 `session_id: ...` 写到 stderr；配合 --no-restore-cwd 阻止 cd 回旧目录
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
import { type ChildProcess } from 'node:child_process';
import { spawnCli } from '../cliLauncher.js';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import type { Agent, ExecutorKind, Task } from '../../../shared/types.js';
import type { Database } from '../database.js';
import { loadConfig } from '../config.js';
import {
  childProcessEnv,
  createSensitiveTextRedactor,
  readEngineRuntimeConfig,
  redactSensitiveText
} from '../engineEnv.js';
import { HermesRuntimeProfileService, type PreparedHermesRuntime } from '../hermesRuntimeProfile.js';
import { parseHermesQuietSessionId } from '../hermesCliProtocol.js';
import { killQuietly, type ExecutorAdapter, type ExecutorCallbacks } from './types.js';
import type { MobileGatewayService } from '../mobileGatewayService.js';
import { appendBoundedText, appendProcessOutput, boundedText, createProcessOutputBuffer, createUtf8StreamDecoder, finishProcessOutput } from '../textEncoding.js';

const ENGINE_ID = 'eng-hermes-cli';
const TIMEOUT_MS = 15 * 60_000;
const MAX_RESULT_CHARS = 16_000;

/**
 * readonly 权限下允许的 Hermes 内置工具集。
 * 名称必须与 `hermes tools list` 输出一致（均为单数形式）；传入未知名称时
 * hermes 会报 "did not contain any valid toolsets" 并以退出码 2 直接失败。
 * 这里只放只读类：检索/看文件/看图，不含 terminal、code_execution、browser 等可写副作用的集合。
 */
const READONLY_TOOLSETS = ['file', 'web', 'vision', 'session_search'];

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

const HERMES_FAILURE_TEXT = /HTTP\s+(?:400|401|403|408|409|422|429|5\d\d)\b|missing authentication header|no usable credentials|auth(?:entication)?[_\s-]?unavailable|invalid[_\s-]?(?:api[_\s-]?)?key|unauthorized|forbidden|rate limit|quota|billing|provider.*(?:failed|error)|api call failed/i;

export function hermesFailureDetail(usage: HermesUsageReport | null, stdout: string, stderr: string): string | null {
  const explicit = usage?.failure?.trim();
  if (explicit) return explicit.slice(0, 500);
  const combined = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
  if (usage?.failed === true) return (combined || 'Hermes usage report marked the request as failed').slice(0, 500);
  return HERMES_FAILURE_TEXT.test(combined) ? combined.slice(0, 500) : null;
}

interface RunningChild {
  child: ChildProcess;
  timer: NodeJS.Timeout;
  usageFile: string;
  mobile: boolean;
}

export class HermesAgentExecutor implements ExecutorAdapter {
  readonly kind: ExecutorKind = 'generic-cli';
  private running = new Map<string, RunningChild>();
  /** 被用户主动取消的任务：close 回调中不再回报错误（状态已由 orchestrator 置 CANCELLED） */
  private abortedTasks = new Set<string>();
  private preparingTasks = new Set<string>();
  private mobileGateway: MobileGatewayService | null = null;
  private readonly profiles: HermesRuntimeProfileService;

  constructor(private db: Database) {
    this.profiles = new HermesRuntimeProfileService(db);
  }

  setMobileGateway(gateway: MobileGatewayService): void {
    this.mobileGateway = gateway;
  }

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
  private buildArgs(
    prompt: string,
    task: Task,
    agent: Agent,
    usageFile: string,
    runtime: Pick<PreparedHermesRuntime, 'model' | 'provider'> | null = null
  ): string[] {
    const resumedSession = task.sessionId?.startsWith('hermes-')
      ? task.sessionId.slice('hermes-'.length)
      : null;
    if (agent.kind === 'android_operator') {
      const args = resumedSession
        ? ['chat', '-Q', '-q', prompt, '--accept-hooks', '-t', 'android', '--resume', resumedSession, '--no-restore-cwd']
        : ['-z', prompt, '--usage-file', usageFile, '--accept-hooks', '-t', 'android'];
      const model = runtime?.model ?? agent.modelOverride;
      if (model) args.push('-m', model);
      if (runtime) args.push('--provider', runtime.provider);
      return args;
    }
    const override = readEngineRuntimeConfig(this.db, ENGINE_ID)?.runArgs
      ?? loadConfig().engines[ENGINE_ID]?.runArgs;
    if (override && override.length > 0) {
      // 用户完全接管参数模板：仅做 {prompt} 占位替换，不再叠加本应用的默认策略
      const args = override.map((a) => (a === '{prompt}' ? prompt : a));
      if (!override.includes('{prompt}')) args.push(prompt);
      const model = runtime?.model ?? agent.modelOverride;
      if (model && !args.some((arg) => arg === '-m' || arg === '--model' || arg.startsWith('--model='))) args.push('-m', model);
      if (runtime && !args.some((arg) => arg === '--provider')) args.push('--provider', runtime.provider);
      return args;
    }

    const args = resumedSession
      ? ['chat', '-Q', '-q', prompt]
      : ['-z', prompt, '--usage-file', usageFile];

    // 权限映射：trusted/autonomous 才免 hook 审批；渠道来源任务的 trusted 降级为 standard（10.5）。
    // team/nested 来源不得改变员工本身的权限等级。
    const baseMode = agent.permissionMode;
    const mode = task.source === 'channel' && baseMode === 'trusted' ? 'standard' : baseMode;
    if (mode === 'trusted' || mode === 'autonomous') args.push('--accept-hooks');
    // readonly：限制为只读工具集。名称须与 `hermes tools list` 的内置 toolset 一致
    // （实测为单数 `file`；曾误写 `files` 导致 hermes 直接以退出码 2 拒绝执行）。
    if (mode === 'readonly') args.push('-t', READONLY_TOOLSETS.join(','));

    // 会话续接：工作目录由本应用托管，阻止 hermes cd 回会话记录的旧目录
    if (resumedSession) {
      args.push('--resume', resumedSession, '--no-restore-cwd');
    }
    const model = runtime?.model ?? agent.modelOverride;
    if (model) args.push('-m', model);
    if (runtime) args.push('--provider', runtime.provider);
    return args;
  }

  start(task: Task, agent: Agent, cb: ExecutorCallbacks): void {
    if (agent.kind === 'android_operator') {
      void this.startMobile(task, agent, cb);
      return;
    }
    this.startProcess(task, agent, cb, null);
  }

  private async startMobile(task: Task, agent: Agent, cb: ExecutorCallbacks): Promise<void> {
    const gateway = this.mobileGateway;
    if (!gateway) {
      cb.onError(task.id, 'OPC-Nexus Mobile Gateway 未初始化');
      return;
    }
    this.preparingTasks.add(task.id);
    try {
      const mobile = await gateway.prepareTask(task, agent);
      this.preparingTasks.delete(task.id);
      if (this.abortedTasks.delete(task.id)) {
        gateway.finishTask(task.id, 'cancelled');
        return;
      }
      this.startProcess(task, agent, cb, {
        OPCNEXUS_MOBILE_GATEWAY_URL: mobile.gatewayUrl,
        OPCNEXUS_MOBILE_TASK_TOKEN: mobile.token
      }, mobile.runtime);
    } catch (error) {
      this.preparingTasks.delete(task.id);
      gateway.finishTask(task.id, 'cancelled');
      if (!this.abortedTasks.delete(task.id)) cb.onError(task.id, `手机任务准备失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private startProcess(
    task: Task,
    agent: Agent,
    cb: ExecutorCallbacks,
    mobileEnv: Record<string, string> | null,
    preparedRuntime: PreparedHermesRuntime | null = null
  ): void {
    const workspace = task.workspaceOverride || agent.workspace || join(app.getPath('userData'), 'workspaces', agent.id);
    try {
      mkdirSync(workspace, { recursive: true });
    } catch (err) {
      cb.onError(task.id, `工作目录不可用：${workspace}（${err instanceof Error ? err.message : String(err)}）`);
      if (mobileEnv) this.mobileGateway?.finishTask(task.id, 'cancelled');
      return;
    }

    let runtime: PreparedHermesRuntime | null = preparedRuntime;
    if (!runtime) {
      try {
        runtime = this.profiles.ensure(agent);
      } catch (error) {
        cb.onError(task.id, `Hermes 运行配置不可用：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }

    const prompt = task.sessionId
      ? `追问：${task.content || task.title}\n请在之前会话的基础上继续处理，并输出最终结果。`
      : `${agent.systemPrompt}\n\n当前任务：${task.content || task.title}\n请直接执行该任务，并输出最终结构化结果。`;
    const usageFile = join(tmpdir(), `hermes-usage-${randomUUID().slice(0, 8)}.json`);
    const args = this.buildArgs(prompt, task, agent, usageFile, runtime);
    const bin = this.resolveBin();
    const env = childProcessEnv({
      ...runtime.env,
      ...mobileEnv
    });

    let child: ChildProcess;
    try {
      child = spawnCli(bin, args, {
        cwd: workspace,
        shell: false,
        windowsHide: true,
        env
      });
    } catch (err) {
      if (mobileEnv) this.mobileGateway?.finishTask(task.id, 'cancelled');
      cb.onError(task.id, redactSensitiveText(`无法启动 ${bin}：${err instanceof Error ? err.message : String(err)}`, env));
      return;
    }

    const timer = setTimeout(() => {
      this.abortedTasks.add(task.id); // 标记为超时中止，防止 close 事件双重回调
      this.running.delete(task.id);
      this.cleanupUsage(usageFile);
      killQuietly(child);
      if (mobileEnv) this.mobileGateway?.finishTask(task.id, 'expired');
      cb.onError(task.id, '执行超时（15 分钟），已终止 Hermes 进程');
    }, TIMEOUT_MS);
    this.running.set(task.id, { child, timer, usageFile, mobile: !!mobileEnv });

    cb.onStage(task.id, '理解需求');
    cb.onProgress(task.id, 5);

    // Hermes headless modes have no event stream: advance coarsely by output length.
    const fullParts: string[] = [];
    const fullState = { length: 0, truncated: false };
    let full = '';
    const stderrOutput = createProcessOutputBuffer();
    let stderrBuf = '';
    let outBuf = '';
    let lastFlush = Date.now();
    let lastProgress = 5;
    const stdoutDecoder = createUtf8StreamDecoder();
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

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = stdoutDecoder.write(chunk);
      appendBoundedText(fullParts, fullState, text);
      // Keep the live buffer bounded independently; fullParts remains the
      // authoritative capped result assembled at process close.
      if (text && outBuf.length < 32 * 1024) outBuf += text.slice(0, 32 * 1024 - outBuf.length);
      const pct = Math.min(90, 10 + Math.floor(fullState.length / 30));
      if (pct > lastProgress) {
        lastProgress = pct;
        cb.onProgress(task.id, pct);
        if (pct > 40) cb.onStage(task.id, '生成产物');
      }
      flush(false);
    });
    child.stderr?.on('data', (chunk: Buffer) => appendProcessOutput(stderrOutput, chunk));

    child.on('error', (err) => {
      clearTimeout(timer);
      this.running.delete(task.id);
      this.cleanupUsage(usageFile);
      if (mobileEnv) this.mobileGateway?.finishTask(task.id, 'cancelled');
      cb.onError(task.id, redactSensitiveText(`启动失败：${err.message}（请确认 hermes 已安装并在 PATH 中）`, env));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      this.running.delete(task.id);
      if (this.abortedTasks.delete(task.id)) {
        this.cleanupUsage(usageFile);
        if (mobileEnv) this.mobileGateway?.finishTask(task.id, 'cancelled');
        return; // 用户取消，状态已由 orchestrator 置 CANCELLED
      }
      const tail = stdoutDecoder.end();
      if (tail) appendBoundedText(fullParts, fullState, tail);
      if (tail && outBuf.length < 32 * 1024) outBuf += tail.slice(0, 32 * 1024 - outBuf.length);
      full = boundedText(fullParts, fullState);
      stderrBuf = finishProcessOutput(stderrOutput);
      flush(true);

      // 用量报告：失败时同样写出，先读再按退出码分流
      const usage = this.readUsage(usageFile);
      const nativeSessionId = usage?.session_id || parseHermesQuietSessionId(stderrBuf);
      if (usage) this.recordUsage(task, agent, usage);
      const reportedFailure = hermesFailureDetail(usage, full, stderrBuf);
      if (mobileEnv) this.mobileGateway?.finishTask(task.id, code === 0 && !reportedFailure ? 'completed' : 'failed');

      if (code === 0) {
        if (reportedFailure) {
          cb.onError(task.id, `Hermes 执行失败：${redactSensitiveText(reportedFailure, env)}`);
          return;
        }
        const result = full.trim();
        if (!result) {
          cb.onError(task.id, 'Hermes 执行完成但未产生文本输出');
          return;
        }
        if (nativeSessionId) cb.onSession?.(task.id, `hermes-${nativeSessionId}`);
        cb.onStage(task.id, '校验结果');
        cb.onProgress(task.id, 98);
        cb.onDone(task.id, redactSensitiveText(result, env).slice(0, MAX_RESULT_CHARS));
        return;
      }

      // 退出码语义（实测）：1 = 运行错误；2 = 空响应/参数校验失败；130 = 中断
      const detail = redactSensitiveText(usage?.failure || stderrBuf.trim() || full.trim() || '无错误输出', env);
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
      killQuietly(run.child);
      this.cleanupUsage(run.usageFile); // 中止路径同样要清理临时用量文件，避免 tmp 堆积
      this.running.delete(taskId);
      if (run.mobile) this.mobileGateway?.finishTask(taskId, 'cancelled');
    } else if (this.preparingTasks.has(taskId)) {
      this.abortedTasks.add(taskId);
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
