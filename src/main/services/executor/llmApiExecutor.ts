/**
 * Hermes 内置引擎：OpenAI 兼容 API 工具循环执行器（P1b，参考 Cherry Studio 供应商直连模式）
 * - Base URL / Model 存 settings；API Key 仅存 safeStorage（15.1），用前在主进程解密
 * - 原生 fetch + 手写 SSE 解析（含 tool_calls delta 合并），零新增依赖
 * - 工具循环：每轮携带 MCP 风格工具声明，模型产生 tool_calls 则执行工具后继续，最多 15 轮
 * - 权限语义：readonly 只注册只读工具；standard 下写/删工具经审批代理挂起等待人工批准；
 *   trusted 全自动；渠道来源任务（source='channel'）写类工具一律审批，不受 trusted 豁免（10.5）
 * - 会话化（P2b）：消息逐条落 task_messages，追问任务按 session_id 重建上下文
 */
import { randomUUID } from 'node:crypto';
import type { Agent, ExecutorKind, Task } from '../../../shared/types.js';
import type { Database } from '../database.js';
import type { ApprovalBroker } from '../approvalBroker.js';
import { getProviderSettings, readProviderKey, type ProviderSettings } from '../provider.js';
import type { ProviderManager } from '../providerManager.js';
import { toolsForPermission, toOpenAiTools, type ToolContext, type ToolDef, type ToolHost } from './tools.js';
import type { ExecutorAdapter, ExecutorCallbacks } from './types.js';

const TIMEOUT_MS = 15 * 60_000;
const MAX_RESULT_CHARS = 16_000;
const MAX_ROUNDS = 30;

interface RunningRun {
  controller: AbortController;
  timer: NodeJS.Timeout;
}

interface ToolCallAcc {
  id: string;
  name: string;
  args: string;
}

interface MessageRow {
  role: string;
  content: string;
  tool_calls_json: string | null;
}

type ChatMessage = Record<string, unknown>;

export class LlmApiExecutor implements ExecutorAdapter {
  readonly kind: ExecutorKind = 'llm-api';
  private running = new Map<string, RunningRun>();
  private host: ToolHost | null = null;
  private browserMgr: import('../browserManager.js').BrowserManager | null = null;
  private ocrService: import('../ocrService.js').OcrService | null = null;

  constructor(private db: Database, private broker: ApprovalBroker, private providerMgr?: ProviderManager) {}

  setToolHost(host: ToolHost) {
    this.host = host;
  }

  setBrowserManager(mgr: import('../browserManager.js').BrowserManager) {
    this.browserMgr = mgr;
  }

  setOcrService(svc: import('../ocrService.js').OcrService) {
    this.ocrService = svc;
  }

  private config(): ProviderSettings {
    return getProviderSettings(this.db);
  }

  /** 读取并解密 API Key（仅主进程；Renderer 永远拿不到明文） */
  private apiKey(): string | null {
    return readProviderKey(this.db);
  }

  isReady(): boolean {
    const c = this.config();
    return !!c.baseUrl && !!c.model && this.apiKey() !== null;
  }

  start(task: Task, agent: Agent, cb: ExecutorCallbacks): void {
    // 多供应商：优先用助手绑定的供应商，否则回退全局默认
    let baseUrl: string, model: string, key: string | null;
    const resolved = this.providerMgr?.resolveForAgent(
      (agent as unknown as { providerId?: string }).providerId ?? null,
      (agent as unknown as { modelOverride?: string }).modelOverride ?? null
    );
    if (resolved && resolved.key) {
      baseUrl = resolved.baseUrl;
      model = resolved.model;
      key = resolved.key;
    } else {
      const cfg = this.config();
      baseUrl = cfg.baseUrl;
      model = cfg.model;
      key = this.apiKey();
    }
    if (!key) {
      cb.onError(task.id, 'API Key 未配置，请在设置中完成模型供应商配置');
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error('执行超时（15 分钟）'));
    }, TIMEOUT_MS);
    this.running.set(task.id, { controller, timer });

    cb.onStage(task.id, '理解需求');
    cb.onProgress(task.id, 5);

    void this.runLoop(task, agent, { baseUrl, model, key, signal: controller.signal }, cb)
      .finally(() => {
        clearTimeout(timer);
        this.running.delete(task.id);
      });
  }

  abort(taskId: string): void {
    const run = this.running.get(taskId);
    if (run) {
      clearTimeout(run.timer);
      this.broker.abandonTask(taskId);
      run.controller.abort(new Error('用户取消'));
      this.running.delete(taskId);
    }
  }

  // ---------- 会话消息（task_messages） ----------

  private persistMessage(taskId: string, role: string, content: string, toolCallsJson: string | null = null) {
    this.db.raw
      .prepare('INSERT INTO task_messages(id, task_id, role, content, tool_calls_json, created_at) VALUES(?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), taskId, role, content, toolCallsJson, Date.now());
  }

  /** 按 session 链重建上下文（同 session_id 的全部任务消息，时间序） */
  private loadSessionMessages(sessionId: string): ChatMessage[] {
    const rows = this.db.raw
      .prepare(
        `SELECT tm.role, tm.content, tm.tool_calls_json FROM task_messages tm
         JOIN tasks t ON t.id = tm.task_id WHERE t.session_id = ? ORDER BY tm.created_at, tm.rowid`
      )
      .all(sessionId) as unknown as MessageRow[];
    return rows.map((r) => {
      const extra = r.tool_calls_json ? (JSON.parse(r.tool_calls_json) as Record<string, unknown>) : {};
      if (r.role === 'assistant') {
        return { role: 'assistant', content: r.content || null, ...(extra.tool_calls ? { tool_calls: extra.tool_calls } : {}) };
      }
      if (r.role === 'tool') {
        return { role: 'tool', content: r.content, tool_call_id: extra.tool_call_id ?? '' };
      }
      return { role: r.role, content: r.content };
    });
  }

  // ---------- 工具循环 ----------

  private async runLoop(
    task: Task,
    agent: Agent,
    opts: { baseUrl: string; model: string; key: string; signal: AbortSignal },
    cb: ExecutorCallbacks
  ): Promise<void> {
    // 会话锚点：追问任务继承 session，否则新建
    const sessionId = task.sessionId ?? `llm-${randomUUID()}`;
    if (!task.sessionId) cb.onSession?.(task.id, sessionId);

    // 专家团任务（source='team'）默认完全自主，无需人工审批，由 AI 自助判断
    const effectivePermission = task.source === 'team' ? 'autonomous' : agent.permissionMode;
    const tools = toolsForPermission(effectivePermission, agent.capabilities);
    const userPrompt = `当前任务：${task.title}\n请执行该任务并输出结构化结果（Markdown）。`;

    // 组合人设 system prompt：soul.md + agents.md + user.md + 基础 prompt + 绑定 skills
    const systemContent = this.composeSystemPrompt(agent);

    let messages: ChatMessage[];
    if (task.sessionId) {
      // 追问：重建历史上下文 + 本轮新指令
      messages = this.loadSessionMessages(sessionId);
      if (messages.length === 0) messages.push({ role: 'system', content: systemContent });
      messages.push({ role: 'user', content: userPrompt });
      this.persistMessage(task.id, 'user', userPrompt);
    } else {
      messages = [
        { role: 'system', content: systemContent },
        { role: 'user', content: userPrompt }
      ];
      this.persistMessage(task.id, 'system', systemContent);
      this.persistMessage(task.id, 'user', userPrompt);
    }

    const finalParts: string[] = [];

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      cb.onStage(task.id, round === 1 ? '规划步骤' : '生成产物');
      let turn: { content: string; toolCalls: ToolCallAcc[]; usage?: { input: number; output: number; total: number } };
      try {
        turn = await this.streamRound(task, messages, tools, opts, cb, round);
        if (turn.usage) this.recordUsage(task, agent, opts.model, turn.usage);
      } catch (err) {
        if (isAbort(err)) return;
        cb.onError(task.id, errMessage(err));
        return;
      }

      const toolCallsPayload = turn.toolCalls.map((t) => ({
        id: t.id,
        type: 'function',
        function: { name: t.name, arguments: t.args }
      }));
      messages.push({
        role: 'assistant',
        content: turn.content || null,
        ...(toolCallsPayload.length ? { tool_calls: toolCallsPayload } : {})
      });
      this.persistMessage(task.id, 'assistant', turn.content, toolCallsPayload.length ? JSON.stringify({ tool_calls: toolCallsPayload }) : null);
      if (turn.content.trim()) finalParts.push(turn.content.trim());

      if (turn.toolCalls.length === 0) {
        // 无工具调用 → 本轮内容即最终产物
        const full = finalParts.join('\n\n');
        if (!full.trim()) {
          cb.onError(task.id, '供应商返回空内容');
          return;
        }
        cb.onStage(task.id, '校验结果');
        cb.onProgress(task.id, 98);
        cb.onDone(task.id, full.slice(0, MAX_RESULT_CHARS));
        return;
      }

      // 逐个执行工具（含审批门禁）
      cb.onStage(task.id, '调用工具');
      for (const call of turn.toolCalls) {
        if (opts.signal.aborted) return;
        const result = await this.execToolCall(task, agent, call, tools, cb);
        if (result === null) return; // 已中止
        messages.push({ role: 'tool', content: result, tool_call_id: call.id });
        this.persistMessage(task.id, 'tool', result, JSON.stringify({ tool_call_id: call.id, name: call.name }));
      }
    }
    cb.onError(task.id, `工具调用轮次超限（${MAX_ROUNDS} 轮），已终止`);
  }

  /** 执行单个工具调用：事件落库 + 审批门禁 + 结果回填；返回 null 表示任务已中止 */
  private async execToolCall(
    task: Task,
    agent: Agent,
    call: ToolCallAcc,
    tools: ToolDef[],
    cb: ExecutorCallbacks
  ): Promise<string | null> {
    const record = (type: string, payload: Record<string, unknown>) => {
      this.db.raw
        .prepare('INSERT INTO task_events(id, task_id, event_type, payload, created_at) VALUES(?, ?, ?, ?, ?)')
        .run(randomUUID(), task.id, type, JSON.stringify(payload), Date.now());
    };

    const tool = tools.find((t) => t.name === call.name);
    let args: Record<string, unknown> = {};
    try {
      args = call.args ? (JSON.parse(call.args) as Record<string, unknown>) : {};
    } catch {
      /* 参数解析失败按空参处理，让工具自行报错 */
    }
    record('tool_call', { name: call.name, args });

    if (!tool) {
      const msg = `未知工具：${call.name}`;
      record('tool_result', { name: call.name, error: msg });
      return msg;
    }

    // 审批门禁（四级权限语义）：
    //   readonly  → 禁止写入类工具（上方已拦截）
    //   standard  → write + danger 均需人工批准
    //   trusted   → 仅 danger（删除等高危）需审批，write 自动通过
    //   autonomous→ 完全跳过，无需任何审批
    // 渠道来源任务（source='channel'）：trusted 降级为 standard（10.5），autonomous 不降级
    // 专家团任务（source='team'）：effectivePermission 已拾升为 autonomous，完全免审批
    const effectivePermission = task.source === 'team' ? 'autonomous' : agent.permissionMode;
    if (tool.risk !== 'safe' && effectivePermission === 'readonly') {
      const msg = '当前员工为只读权限模式，禁止执行写入类操作';
      record('tool_result', { name: call.name, error: msg });
      return msg;
    }
    const effectiveMode = task.source === 'channel' && effectivePermission === 'trusted' ? 'standard' : effectivePermission;
    const needApproval = tool.risk !== 'safe' && effectiveMode !== 'autonomous' && (
      effectiveMode === 'standard' || (effectiveMode === 'trusted' && tool.risk === 'danger')
    );
    if (needApproval) {
      const approvalType = tool.risk === 'danger' ? 'delete' : call.name === 'delegate_task' ? 'admin' : 'write_workspace';
      const approved = await this.broker.request({
        taskId: task.id,
        agentId: agent.id,
        type: approvalType,
        request: `${agent.name} 请求执行工具 ${call.name}：${JSON.stringify(args).slice(0, 160)}`,
        risk: tool.risk === 'danger' ? 'high' : 'medium'
      });
      if (this.running.get(task.id)?.controller.signal.aborted) return null;
      if (!approved) {
        const msg = '用户拒绝了该操作，请调整方案或跳过此步骤';
        record('tool_result', { name: call.name, error: msg });
        return msg;
      }
    }

    try {
      const ctx: ToolContext = { workspace: task.workspaceOverride || agent.workspace, agentId: agent.id, taskId: task.id, host: this.host, browserMgr: this.browserMgr, ocrService: this.ocrService };
      const result = await tool.execute(args, ctx);
      record('tool_result', { name: call.name, result: result.slice(0, 2000) });
      cb.onOutput(task.id, `\n[工具 ${call.name}] ${result.slice(0, 400)}\n`);
      return result;
    } catch (err) {
      const msg = `工具执行失败：${errMessage(err)}`;
      record('tool_result', { name: call.name, error: msg });
      return msg;
    }
  }

  /** 单轮流式请求：SSE 解析 content 与 tool_calls delta（按 index 合并） */
  private async streamRound(
    task: Task,
    messages: ChatMessage[],
    tools: ToolDef[],
    opts: { baseUrl: string; model: string; key: string; signal: AbortSignal },
    cb: ExecutorCallbacks,
    round: number
  ): Promise<{ content: string; toolCalls: ToolCallAcc[]; usage?: { input: number; output: number; total: number } }> {
    const url = `${opts.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${opts.key}`
      },
      body: JSON.stringify({
        model: opts.model,
        stream: true,
        stream_options: { include_usage: true },
        messages,
        tools: toOpenAiTools(tools),
        tool_choice: 'auto'
      }),
      signal: opts.signal
    }).catch((err) => {
      if (isAbort(err)) throw err;
      throw new Error(`网络请求失败：${errMessage(err)}`);
    });

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new Error(`供应商返回 HTTP ${res.status}：${body.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuf = '';
    let content = '';
    let outBuf = '';
    let lastFlush = Date.now();
    let lastProgress = 0;
    let usage: { input: number; output: number; total: number } | undefined;
    const toolCalls = new Map<number, ToolCallAcc>();

    const flushOutput = (force: boolean) => {
      if (outBuf && (force || Date.now() - lastFlush >= 300)) {
        cb.onOutput(task.id, outBuf);
        outBuf = '';
        lastFlush = Date.now();
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuf += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = sseBuf.indexOf('\n')) >= 0) {
        const line = sseBuf.slice(0, nl).trim();
        sseBuf = sseBuf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;

        let delta: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };
        try {
          const json = JSON.parse(data) as { choices?: { delta?: typeof delta }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
          delta = json.choices?.[0]?.delta ?? {};
          if (json.usage) usage = { input: json.usage.prompt_tokens ?? 0, output: json.usage.completion_tokens ?? 0, total: json.usage.total_tokens ?? 0 };
        } catch {
          continue; // 忽略心跳/注释帧
        }

        if (delta.content) {
          content += delta.content;
          outBuf += delta.content;
          const pct = Math.min(90, 10 + round * 4 + Math.floor(content.length / 40));
          if (pct > lastProgress) {
            lastProgress = pct;
            cb.onProgress(task.id, pct);
          }
          flushOutput(false);
        }
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const acc = toolCalls.get(idx) ?? { id: '', name: '', args: '' };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
          toolCalls.set(idx, acc);
        }
      }
    }

    flushOutput(true);
    return {
      content,
      toolCalls: [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => ({ ...v, id: v.id || randomUUID() })),
      usage
    };
  }

  /** 组合人设 system prompt：soul.md（身份）+ agents.md（行为指令）+ user.md（用户画像）+ 基础 prompt + 绑定 skills */
  private composeSystemPrompt(agent: Agent): string {
    const parts: string[] = [];
    if (agent.soulMd) parts.push(`# 身份与性格\n${agent.soulMd}`);
    if (agent.systemPrompt) parts.push(agent.systemPrompt);
    if (agent.agentsMd) parts.push(`# 行为指令\n${agent.agentsMd}`);
    if (agent.userMd) parts.push(`# 用户信息\n${agent.userMd}`);
    // 绑定的 skills 注入（区分普通 skill 和 workflow skill）
    const skills = this.db.raw.prepare(
      'SELECT s.name, s.description, s.content FROM skills s JOIN agent_skills as2 ON s.id = as2.skill_id WHERE as2.agent_id = ? AND s.enabled = 1'
    ).all(agent.id) as { name: string; description: string; content: string }[];
    for (const sk of skills) {
      if (sk.content.startsWith('workflow:')) {
        // 工作流类型 skill：注入可调用描述（不注入原始 workflow:id 字符串）
        parts.push(`# 可用工作流\n你可以请求执行工作流「${sk.name}」来完成相关任务。${sk.description ? `说明：${sk.description}` : ''}`);
      } else if (sk.content) {
        parts.push(`# 技能\n${sk.content}`);
      }
    }
    return parts.join('\n\n') || '你是一个智能助手。';
  }

  /** 记录 token 用量到 usage_records */
  private recordUsage(task: Task, agent: Agent, model: string, usage: { input: number; output: number; total: number }) {
    try {
      this.db.raw.prepare(
        'INSERT INTO usage_records(id, task_id, agent_id, model, input_tokens, output_tokens, total_tokens, created_at) VALUES(?,?,?,?,?,?,?,?)'
      ).run(randomUUID(), task.id, agent.id, model, usage.input, usage.output, usage.total, Date.now());
    } catch { /* 统计失败不影响主流程 */ }
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || /aborted|取消/.test(err.message));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
