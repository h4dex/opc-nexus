/**
 * Agent 编排器（PRD 7/8 章）
 * - 分层状态机：Agent 生命周期 / Task / Engine / Channel 互不混用（7.3）
 * - FIFO 队列 + 固定并发（6.2：V1.0 基础调度）
 * - 首页派生状态互斥归类：异常/离线 > 执行中/待审批 > 暂停 > 排队/启动中 > 空闲
 * - 崩溃恢复：启动时扫描 RUNNING 记录，无法恢复的标记 INTERRUPTED（13.2）
 * - 自动补位（replenishTasks）默认关闭：它会生成用户从未派发的任务，
 *   开启后统计口径不再可信，仅供演示环境显式启用
 *
 * @author liyingjie <y@senke.com>
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { app } from 'electron';
import type { Database } from './database.js';
import type { ExecutorRegistry } from './executor/index.js';
import type { ExecutorCallbacks } from './executor/types.js';
import type { ApprovalBroker } from './approvalBroker.js';
import type { ToolHost } from './executor/tools.js';
import { notify } from './notifier.js';
import { loadUserConfig } from './userConfig.js';
import type {
  Agent, AgentCardView, Approval, CreateAgentInput, DashboardStats, DerivedAgentStatus,
  ExecutorKind, Task, TaskEvent, TaskQuality, TaskStatus, TodoItem
} from '../../shared/types.js';

type Row = Record<string, unknown>;

const STAGES = ['理解需求', '规划步骤', '调用工具', '生成产物', '校验结果'];

/** 演示模式后续任务池（仅 demoAutoTasks 开启时生效，生产环境完全隔离） */
const DEMO_TASK_POOL = [
  '数据同步与核对', '例行报表生成', '异常记录复核', '客户资料更新',
  '库存快照比对', '工单流转跟踪', '日志归档整理', '指标看板刷新',
  '待办事项跟进', '周报素材汇总', '接口连通性巡检', '文档版本整理'
];

/** 默认演示水位：0 = 生产默认不自动补位（演示需显式设置 settings.demoTargetRunning > 0） */
const DEFAULT_TARGET_RUNNING = 0;

export class Orchestrator {
  private listeners = new Set<() => void>();
  /** 任务输出流式订阅（推送到渲染进程逐字显示） */
  private outputListeners = new Set<(taskId: string, chunk: string) => void>();
  /** 任务终态订阅（webhook 通知等；status 仅 COMPLETED/FAILED/INTERRUPTED） */
  private finishListeners = new Set<(info: { taskId: string; agentId: string; status: 'COMPLETED' | 'FAILED' | 'INTERRUPTED'; title: string; result: string | null; error: string | null }) => void>();
  private schedulerTimer: NodeJS.Timeout | null = null;
  private lastEmit = 0;
  private emitTimer: NodeJS.Timeout | null = null;
  /** 调度保护门禁（由 main 注入，基于资源监控）：返回非空字符串 = 阻止派发的原因 */
  private dispatchGuard: () => string | null = () => null;

  constructor(private db: Database, private executors: ExecutorRegistry, private broker: ApprovalBroker) {}

  setDispatchGuard(fn: () => string | null) {
    this.dispatchGuard = fn;
  }

  /** delegate_task 工具的编排能力（P3b A2A 内部委派） */
  toolHost(): ToolHost {
    return {
      findAgentIdByName: (name) => {
        // P3b：仅在岗（READY）员工可接受委派，避免子任务无限期排队
        const r = this.db.raw.prepare("SELECT id FROM agents WHERE name = ? AND archived = 0 AND lifecycle = 'READY'").get(name) as { id: string } | undefined;
        return r?.id ?? null;
      },
      createDelegatedTask: (agentId, title, parentTaskId) => this.createTask(agentId, title, 'delegated', { parentId: parentTaskId }),
      waitForTask: (taskId, timeoutMs) =>
        new Promise((resolve) => {
          const started = Date.now();
          const check = () => {
            const row = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Row | undefined;
            if (!row) return resolve(null);
            const t = this.mapTask(row);
            if (['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(t.status)) return resolve(t);
            if (Date.now() - started >= timeoutMs) return resolve(null);
            setTimeout(check, 2000);
          };
          check();
        }),
      delegationDepth: (taskId) => {
        let depth = 0;
        let cur: string | null = taskId;
        while (cur && depth < 10) {
          const r = this.db.raw.prepare('SELECT parent_id FROM tasks WHERE id = ?').get(cur) as { parent_id: string | null } | undefined;
          if (!r?.parent_id) break;
          depth++;
          cur = r.parent_id;
        }
        return depth;
      }
    };
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 订阅任务输出流（用于流式推送到渲染进程） */
  onOutput(fn: (taskId: string, chunk: string) => void): () => void {
    this.outputListeners.add(fn);
    return () => this.outputListeners.delete(fn);
  }

  /** 订阅任务终态（执行器回调驱动；用于对外通知渠道） */
  onTaskFinished(fn: (info: { taskId: string; agentId: string; status: 'COMPLETED' | 'FAILED' | 'INTERRUPTED'; title: string; result: string | null; error: string | null }) => void): () => void {
    this.finishListeners.add(fn);
    return () => this.finishListeners.delete(fn);
  }

  /** 快照推送节流（300ms）：执行器高频进度回调下避免全量快照洪泛，并保证尾随一次 */
  private emit() {
    const now = Date.now();
    const elapsed = now - this.lastEmit;
    if (elapsed >= 300 && !this.emitTimer) {
      this.lastEmit = now;
      for (const fn of this.listeners) fn();
      return;
    }
    if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        this.lastEmit = Date.now();
        for (const fn of this.listeners) fn();
      }, 300 - elapsed);
    }
  }

  /** 崩溃恢复：应用重启后把无主 RUNNING 标记为 INTERRUPTED，不伪装成 FAILED/COMPLETED */
  recoverAfterRestart() {
    const running = this.db.raw.prepare("SELECT id FROM tasks WHERE status IN ('RUNNING','WAITING_APPROVAL','PAUSED')").all() as { id: string }[];
    if (running.length === 0) return;
    this.db.transaction(() => {
      const now = Date.now();
      for (const t of running) {
        this.db.raw.prepare("UPDATE tasks SET status = 'INTERRUPTED', ended_at = ?, error = '客户端异常退出，任务中断' WHERE id = ?").run(now, t.id);
        this.db.raw.prepare("UPDATE agent_runs SET ended_at = ?, status = 'INTERRUPTED' WHERE task_id = ? AND ended_at IS NULL").run(now, t.id);
      }
    });
    this.db.audit({ id: randomUUID(), actor: 'system', action: 'recovery.markInterrupted', target: `${running.length} tasks`, result: 'ok' });
  }

  /** 执行调度器：接管数据库中 RUNNING 但无执行器在跑的任务（种子/重启恢复），
   *  并周期补位维持演示水位 + 长任务看门狗。随机推进逻辑已移交 SimulatedExecutor 内部。 */
  startScheduler() {
    this.adoptRunningTasks();
    if (this.schedulerTimer) return;
    this.schedulerTimer = setInterval(() => {
      this.replenishTasks();
      this.watchdogSweep();
      this.emit();
    }, 2000);
  }

  /** 长任务看门狗（P4 防卡死/死循环）：RUNNING 超过 config.yaml task.maxRunMinutes 的任务
   *  强制中断（abort 执行器 + INTERRUPTED），如实告知超时原因；0 = 不限制。
   *  WAITING_APPROVAL/PAUSED 属人工等待，不计入看门狗。 */
  private watchdogSweep() {
    const maxMinutes = loadUserConfig().task.maxRunMinutes;
    if (!maxMinutes || maxMinutes <= 0) return;
    const deadline = Date.now() - maxMinutes * 60_000;
    const rows = this.db.raw
      .prepare("SELECT id, agent_id, title, started_at FROM tasks WHERE status = 'RUNNING' AND started_at IS NOT NULL AND started_at < ?")
      .all(deadline) as { id: string; agent_id: string; title: string; started_at: number }[];
    for (const t of rows) {
      const now = Date.now();
      this.broker.abandonTask(t.id);
      this.executors.abort(t.id);
      this.db.transaction(() => {
        this.db.raw.prepare("UPDATE tasks SET status = 'INTERRUPTED', ended_at = ?, error = ? WHERE id = ? AND status = 'RUNNING'")
          .run(now, `看门狗超时：运行超过 ${maxMinutes} 分钟已强制中断（user/config.yaml task.maxRunMinutes 可调）`, t.id);
        this.db.raw.prepare("UPDATE agent_runs SET ended_at = ?, status = 'INTERRUPTED' WHERE task_id = ? AND ended_at IS NULL").run(now, t.id);
        this.recordEvent(t.id, 'interrupted', { reason: 'watchdog-timeout', maxMinutes }, now);
      });
      this.db.audit({ id: randomUUID(), actor: 'system', action: 'task.watchdogInterrupt', target: t.id, result: `${maxMinutes}min` });
      notify(this.db, '任务看门狗中断', `「${t.title.slice(0, 60)}」运行超过 ${maxMinutes} 分钟，已强制中断`);
      for (const fn of this.finishListeners) {
        try {
          fn({ taskId: t.id, agentId: t.agent_id, status: 'INTERRUPTED', title: t.title, result: null, error: `看门狗超时（${maxMinutes} 分钟）` });
        } catch { /* 通知失败不影响调度 */ }
      }
      this.scheduleNext(t.agent_id);
    }
  }

  /** 启动接管：把无主 RUNNING 任务交给执行器（模拟器从当前进度继续；LLM/CLI 重新发起执行） */
  private adoptRunningTasks() {
    const rows = this.db.raw.prepare("SELECT * FROM tasks WHERE status = 'RUNNING' ORDER BY created_at").all() as Row[];
    for (const r of rows) {
      const task = this.mapTask(r);
      if (this.executors.isExecuting(task.id)) continue;
      const agent = this.getAgent(task.agentId);
      if (agent && agent.lifecycle === 'READY') this.dispatchTask(task, agent);
    }
  }

  /** 读取可配置的演示水位（settings.demoTargetRunning），默认 0 = 关闭自动补位 */
  private targetRunning(): number {
    return this.db.getSetting<number>('demoTargetRunning', DEFAULT_TARGET_RUNNING);
  }

  /** 为无活跃任务且处于演示模式的 READY 员工补充后续任务。
   *  默认关闭（demoAutoTasks=false）：生产环境绝不自动造任务，仅演示场景显式开启。 */
  private replenishTasks() {
    if (!this.db.getSetting<boolean>('demoAutoTasks', false)) return;
    if (this.dispatchGuard() !== null) return;
    const target = this.targetRunning();
    if (target <= 0) return; // 水位为 0 = 生产模式，不自动补位
    const active = (this.db.raw.prepare("SELECT COUNT(*) c FROM tasks WHERE status IN ('RUNNING','QUEUED','WAITING_APPROVAL','PAUSED')").get() as { c: number }).c;
    if (active >= target) return;
    const idleRows = this.db.raw
      .prepare(
        `SELECT id, engine_id FROM agents WHERE archived = 0 AND lifecycle = 'READY' AND id NOT IN
         (SELECT agent_id FROM tasks WHERE status IN ('RUNNING','QUEUED','WAITING_APPROVAL','PAUSED'))`
      )
      .all() as { id: string; engine_id: string }[];
    // 仅对演示模式（simulated）员工补位，真实引擎员工绝不自动派单
    const idle = idleRows.filter((a) => this.executors.kindFor(a.engine_id) === 'simulated');
    const quota = Math.min(2, target - active, idle.length);
    for (let i = 0; i < quota; i++) {
      const pick = Math.floor(Math.random() * idle.length);
      const [agent] = idle.splice(pick, 1); // 剔除已选，避免同周期重复派单
      const title = DEMO_TASK_POOL[Math.floor(Math.random() * DEMO_TASK_POOL.length)];
      this.createTask(agent.id, title);
    }
  }

  // ---------- 查询 ----------

  private mapAgent(r: Row): Agent {
    let capabilities = { network: false, shell: false, install: false, browser: false, computer: false };
    try {
      const raw = r.capabilities_json as string | undefined;
      if (raw) capabilities = { ...capabilities, ...(JSON.parse(raw) as Partial<typeof capabilities>) };
    } catch { /* 解析失败用默认值 */ }
    let tags: string[] = [];
    try { const raw = r.tags_json as string | undefined; if (raw) tags = JSON.parse(raw) as string[]; } catch { /* empty */ }
    let modelOverrides: { temperature?: number; topP?: number; maxTokens?: number } | undefined;
    try { const raw = r.model_overrides_json as string | undefined; if (raw) modelOverrides = JSON.parse(raw); } catch { /* empty */ }
    return {
      id: r.id as string, name: r.name as string, role: r.role as string,
      systemPrompt: r.system_prompt as string,
      soulMd: (r.soul_md as string) ?? '', agentsMd: (r.agents_md as string) ?? '', userMd: (r.user_md as string) ?? '',
      lifecycle: r.lifecycle as Agent['lifecycle'],
      engineId: r.engine_id as string, workspace: r.workspace as string,
      permissionMode: r.permission_mode as Agent['permissionMode'],
      capabilities, tags, modelOverrides,
      modelOverride: (r.model_override as string) || undefined,
      concurrencyLimit: r.concurrency_limit as number, archived: (r.archived as number) === 1,
      avatarColor: r.avatar_color as string, createdAt: r.created_at as number, updatedAt: r.updated_at as number
    };
  }

  private mapTask(r: Row): Task {
    return {
      id: r.id as string, agentId: r.agent_id as string, title: r.title as string,
      projectId: (r.project_id as string | null) ?? null,
      source: r.source as Task['source'], parentId: r.parent_id as string | null,
      status: r.status as TaskStatus, priority: r.priority as number, progress: r.progress as number,
      stage: r.stage as string, error: r.error as string | null, result: (r.result as string | null) ?? null,
      quality: (r.quality as TaskQuality) ?? null,
      sessionId: (r.session_id as string | null) ?? null,
      workspaceOverride: (r.workspace_override as string | null) ?? null,
      createdAt: r.created_at as number, startedAt: r.started_at as number | null, endedAt: r.ended_at as number | null
    };
  }

  /** 设置任务产出的人工质量标记（成果管理：采纳/驳回/返工） */
  setTaskQuality(taskId: string, quality: TaskQuality): Task | null {
    const row = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Row | undefined;
    if (!row) return null;
    this.db.raw.prepare('UPDATE tasks SET quality = ? WHERE id = ?').run(quality, taskId);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'task.quality', target: taskId, result: quality ?? 'cleared' });
    this.emit();
    return this.mapTask({ ...row, quality });
  }

  private getAgent(id: string): Agent | null {
    const r = this.db.raw.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Row | undefined;
    return r ? this.mapAgent(r) : null;
  }

  /** 任务事件时间线（详情弹窗实时流；output 为增量文本事件） */
  taskEvents(taskId: string): TaskEvent[] {
    const rows = this.db.raw.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at, rowid').all(taskId) as Row[];
    return rows.map((r) => ({
      id: r.id as string,
      taskId: r.task_id as string,
      eventType: r.event_type as string,
      payload: JSON.parse((r.payload as string) || '{}') as Record<string, unknown>,
      createdAt: r.created_at as number
    }));
  }

  /** 任务产物全文（tasks.result，截断 16KB） */
  taskResult(taskId: string): string | null {
    const r = this.db.raw.prepare('SELECT result FROM tasks WHERE id = ?').get(taskId) as { result: string | null } | undefined;
    return r?.result ?? null;
  }

  /** 解析任务产物目录：task.workspaceOverride > agent.workspace > userData/workspaces/agentId */
  resolveTaskWorkspace(taskId: string): string | null {
    const row = this.db.raw.prepare('SELECT agent_id, workspace_override FROM tasks WHERE id = ?').get(taskId) as { agent_id: string; workspace_override: string | null } | undefined;
    if (!row) return null;
    if (row.workspace_override) return row.workspace_override;
    const agent = this.getAgent(row.agent_id);
    if (!agent) return null;
    return agent.workspace || join(app.getPath('userData'), 'workspaces', agent.id);
  }

  /** 解析员工工作目录 */
  resolveAgentWorkspace(agentId: string): string | null {
    const agent = this.getAgent(agentId);
    if (!agent) return null;
    return agent.workspace || join(app.getPath('userData'), 'workspaces', agent.id);
  }

  listAgents(): Agent[] {
    return (this.db.raw.prepare('SELECT * FROM agents WHERE archived = 0 ORDER BY created_at').all() as Row[]).map((r) => this.mapAgent(r));
  }

  /** 归档（软删除）助手 */
  archiveAgent(id: string) {
    this.db.raw.prepare('UPDATE agents SET archived = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
    this.emit();
  }

  /** 更新助手人设（soul.md / agents.md / user.md / 基础 prompt / 权限模式） */
  updateAgentPersona(id: string, patch: import('../../shared/types.js').AgentPersonaPatch): Agent {
    const agent = this.getAgent(id);
    if (!agent) throw new Error('助手不存在');
    const fields: string[] = [];
    const values: (string | number)[] = [];
    if (patch.name !== undefined) { fields.push('name = ?'); values.push(patch.name); }
    if (patch.role !== undefined) { fields.push('role = ?'); values.push(patch.role); }
    if (patch.systemPrompt !== undefined) { fields.push('system_prompt = ?'); values.push(patch.systemPrompt); }
    if (patch.soulMd !== undefined) { fields.push('soul_md = ?'); values.push(patch.soulMd); }
    if (patch.agentsMd !== undefined) { fields.push('agents_md = ?'); values.push(patch.agentsMd); }
    if (patch.userMd !== undefined) { fields.push('user_md = ?'); values.push(patch.userMd); }
    if (patch.permissionMode !== undefined) { fields.push('permission_mode = ?'); values.push(patch.permissionMode); }
    if (patch.capabilities !== undefined) {
      const merged = { ...agent.capabilities, ...patch.capabilities };
      fields.push('capabilities_json = ?'); values.push(JSON.stringify(merged));
    }
    if (patch.tags !== undefined) { fields.push('tags_json = ?'); values.push(JSON.stringify(patch.tags)); }
    if (patch.modelOverrides !== undefined) { fields.push('model_overrides_json = ?'); values.push(JSON.stringify(patch.modelOverrides)); }
    if (patch.engineId !== undefined) { fields.push('engine_id = ?'); values.push(patch.engineId); }
    if (patch.modelOverride !== undefined) { fields.push('model_override = ?'); values.push(patch.modelOverride || ''); }
    if (fields.length === 0) return agent;
    fields.push('updated_at = ?'); values.push(Date.now());
    values.push(id);
    this.db.raw.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    this.emit();
    return this.getAgent(id)!;
  }

  // ---------- 会话（持续多轮对话） ----------

  listConversations(agentId: string): import('../../shared/types.js').Conversation[] {
    return (this.db.raw.prepare('SELECT * FROM conversations WHERE agent_id = ? ORDER BY last_message_at DESC LIMIT 50').all(agentId) as Row[]).map((r) => ({
      id: r.id as string, agentId: r.agent_id as string, title: r.title as string,
      lastMessageAt: r.last_message_at as number, messageCount: r.message_count as number
    }));
  }

  /** 创建新会话并发送第一条消息（创建任务执行） */
  chatWithAgent(agentId: string, message: string, conversationId?: string): { conversationId: string; task: Task } {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error('助手不存在');
    const now = Date.now();
    let convId = conversationId ?? '';
    if (!convId) {
      convId = randomUUID();
      this.db.raw.prepare('INSERT INTO conversations(id, agent_id, title, last_message_at, message_count) VALUES(?,?,?,?,?)')
        .run(convId, agentId, message.slice(0, 60), now, 1);
    } else {
      this.db.raw.prepare('UPDATE conversations SET last_message_at = ?, message_count = message_count + 1 WHERE id = ?').run(now, convId);
    }
    // 创建任务，继承会话 session（多轮上下文重建）
    const task = this.createTask(agentId, message.slice(0, 200), 'desktop', { sessionId: `conv-${convId}` });
    this.emit();
    return { conversationId: convId, task };
  }

  // ---------- 用量统计 ----------

  usageStats(): { total: { input: number; output: number; total: number }; byModel: { model: string; input: number; output: number; total: number; count: number }[]; recent: { id: string; agentId: string; model: string; input: number; output: number; total: number; createdAt: number }[] } {
    const total = this.db.raw.prepare('SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(total_tokens),0) t FROM usage_records').get() as { i: number; o: number; t: number };
    const byModel = (this.db.raw.prepare('SELECT model, SUM(input_tokens) input, SUM(output_tokens) output, SUM(total_tokens) total, COUNT(*) count FROM usage_records GROUP BY model ORDER BY total DESC').all() as Row[]).map((r) => ({
      model: r.model as string, input: r.input as number, output: r.output as number, total: r.total as number, count: r.count as number
    }));
    const recent = (this.db.raw.prepare('SELECT * FROM usage_records ORDER BY created_at DESC LIMIT 50').all() as Row[]).map((r) => ({
      id: r.id as string, agentId: r.agent_id as string, model: r.model as string,
      input: r.input_tokens as number, output: r.output_tokens as number, total: r.total_tokens as number, createdAt: r.created_at as number
    }));
    return { total: { input: total.i, output: total.o, total: total.t }, byModel, recent };
  }

  listTasks(): Task[] {
    return (this.db.raw.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 200').all() as Row[]).map((r) => this.mapTask(r));
  }

  listApprovals(): Approval[] {
    const rows = this.db.raw.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC").all() as Row[];
    return rows.map((r) => ({
      id: r.id as string, taskId: r.task_id as string, agentId: r.agent_id as string,
      type: r.type as Approval['type'], request: r.request as string, risk: r.risk as Approval['risk'],
      status: 'pending', createdAt: r.created_at as number, decidedAt: null
    }));
  }

  /** 6.2 派生状态：互斥归类，同一数字员工只计入一类 */
  private deriveStatus(agent: Agent, activeTask: Task | null): DerivedAgentStatus {
    if (agent.lifecycle === 'ERROR') return 'error';
    if (activeTask && (activeTask.status === 'RUNNING' || activeTask.status === 'WAITING_APPROVAL')) return 'running';
    if (activeTask && activeTask.status === 'PAUSED') return 'paused';
    if (agent.lifecycle === 'STARTING' || agent.lifecycle === 'STOPPING' || (activeTask && activeTask.status === 'QUEUED')) return 'starting';
    return 'idle';
  }

  agentCards(): AgentCardView[] {
    const agents = this.listAgents();
    const activeTasks = this.db.raw
      .prepare("SELECT * FROM tasks WHERE status IN ('RUNNING','QUEUED','WAITING_APPROVAL','PAUSED') ORDER BY created_at DESC")
      .all() as Row[];
    const taskByAgent = new Map<string, Task>();
    for (const r of activeTasks) {
      const t = this.mapTask(r);
      if (!taskByAgent.has(t.agentId)) taskByAgent.set(t.agentId, t);
    }
    const engineNames = new Map(
      (this.db.raw.prepare('SELECT id, name FROM engines').all() as { id: string; name: string }[]).map((e) => [e.id, e.name])
    );
    const channelRows = this.db.raw
      .prepare("SELECT c.type, cr.agent_id FROM channel_routes cr JOIN channels c ON c.id = cr.channel_id WHERE c.status != 'DISABLED'")
      .all() as { type: string; agent_id: string }[];
    const channelsByAgent = new Map<string, Set<string>>();
    for (const r of channelRows) {
      if (!channelsByAgent.has(r.agent_id)) channelsByAgent.set(r.agent_id, new Set());
      channelsByAgent.get(r.agent_id)!.add(r.type);
    }
    const runs = this.db.raw
      .prepare('SELECT agent_id, MIN(started_at) AS since FROM agent_runs WHERE ended_at IS NULL GROUP BY agent_id')
      .all() as { agent_id: string; since: number }[];
    const runSince = new Map(runs.map((r) => [r.agent_id, r.since]));

    // 助手绑定的 Skills（agent_skills 关联表）
    const skillRows = this.db.raw
      .prepare('SELECT as2.agent_id, s.name FROM agent_skills as2 JOIN skills s ON s.id = as2.skill_id WHERE s.enabled = 1')
      .all() as { agent_id: string; name: string }[];
    const skillsByAgent = new Map<string, string[]>();
    for (const r of skillRows) {
      if (!skillsByAgent.has(r.agent_id)) skillsByAgent.set(r.agent_id, []);
      skillsByAgent.get(r.agent_id)!.push(r.name);
    }

    // MCP 服务器（scope='global' 对所有助手可见，scope=agentId 为专属）
    const mcpRows = this.db.raw
      .prepare('SELECT id, name, scope FROM mcp_servers WHERE enabled = 1')
      .all() as { id: string; name: string; scope: string }[];
    const globalMcp = mcpRows.filter((m) => m.scope === 'global').map((m) => m.name);

    // 助手模型解析：provider_id + model_override → 实际模型名
    const agentProviderRows = this.db.raw
      .prepare('SELECT id, provider_id, model_override FROM agents WHERE archived = 0')
      .all() as { id: string; provider_id: string | null; model_override: string | null }[];
    const providerRows = this.db.raw
      .prepare('SELECT id, model, is_default FROM providers')
      .all() as { id: string; model: string; is_default: number }[];
    const defaultProvider = providerRows.find((p) => p.is_default === 1);
    const providerModelMap = new Map(providerRows.map((p) => [p.id, p.model]));
    const modelByAgent = new Map<string, string>();
    for (const ar of agentProviderRows) {
      if (ar.model_override) { modelByAgent.set(ar.id, ar.model_override); }
      else if (ar.provider_id && providerModelMap.has(ar.provider_id)) { modelByAgent.set(ar.id, providerModelMap.get(ar.provider_id)!); }
      else if (defaultProvider) { modelByAgent.set(ar.id, defaultProvider.model); }
    }

    return agents.map((agent) => {
      const task = taskByAgent.get(agent.id) ?? null;
      const derived = this.deriveStatus(agent, task);
      const since = runSince.get(agent.id);
      const agentMcp = mcpRows.filter((m) => m.scope === agent.id).map((m) => m.name);
      return {
        agent,
        derivedStatus: derived,
        currentTask: task
          ? { id: task.id, title: task.title, progress: task.progress, stage: task.stage, executor: this.executors.kindFor(agent.engineId) }
          : null,
        uptimeText: since ? formatDuration(Date.now() - since) : '',
        channels: [...(channelsByAgent.get(agent.id) ?? [])] as AgentCardView['channels'],
        engineName: engineNames.get(agent.engineId) ?? '未配置引擎',
        modelName: modelByAgent.get(agent.id) ?? '',
        needsAttention: derived === 'error' || task?.status === 'WAITING_APPROVAL',
        skills: skillsByAgent.get(agent.id) ?? [],
        mcpServers: [...globalMcp, ...agentMcp]
      };
    });
  }

  /** 6.2 首页统计口径：总数 = 执行中 + 空闲/待命 + 暂停/启动中 + 异常/离线 */
  stats(): DashboardStats {
    const cards = this.agentCards().filter((c) => c.agent.lifecycle !== 'DISABLED');
    const s: DashboardStats = {
      totalAgents: cards.length, running: 0, idle: 0, pausedOrStarting: 0, errorOrOffline: 0,
      activeTasks: 0, pendingTodos: 0, todayCompleted: 0
    };
    for (const c of cards) {
      if (c.derivedStatus === 'running') s.running++;
      else if (c.derivedStatus === 'idle') s.idle++;
      else if (c.derivedStatus === 'error') s.errorOrOffline++;
      else s.pausedOrStarting++;
    }
    s.activeTasks = (this.db.raw.prepare("SELECT COUNT(*) c FROM tasks WHERE status IN ('RUNNING','QUEUED','WAITING_APPROVAL','PAUSED')").get() as { c: number }).c;
    s.pendingTodos = (this.db.raw.prepare("SELECT COUNT(*) c FROM approvals WHERE status = 'pending'").get() as { c: number }).c;
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    s.todayCompleted = (this.db.raw.prepare("SELECT COUNT(*) c FROM tasks WHERE status = 'COMPLETED' AND deleted_at IS NULL AND ended_at >= ?").get(dayStart.getTime()) as { c: number }).c;
    return s;
  }

  /** 待办 = 待审批 + 渠道异常 + 系统提醒（6.2 待处理事项） */
  todos(): TodoItem[] {
    const items: TodoItem[] = [];
    for (const a of this.listApprovals()) {
      const agent = this.db.raw.prepare('SELECT name FROM agents WHERE id = ?').get(a.agentId) as { name: string } | undefined;
      items.push({
        id: a.id, title: a.request, owner: agent?.name ?? '未知员工',
        dueText: '等待审批', severity: a.risk === 'high' ? 'high' : 'medium', kind: 'approval'
      });
    }
    const errChannels = this.db.raw.prepare("SELECT * FROM channels WHERE status IN ('ERROR','AUTH_EXPIRED')").all() as Row[];
    for (const c of errChannels) {
      items.push({
        id: `ch-${c.id}`, title: `渠道「${c.account_name || c.type}」连接异常，需要重新鉴权`, owner: '连接中心',
        dueText: '尽快处理', severity: 'high', kind: 'channel'
      });
    }
    return items.slice(0, 12);
  }

  // ---------- 命令 ----------

  createAgent(input: CreateAgentInput): Agent {
    if (input.name.length < 2 || input.name.length > 30) throw new Error('名称需为 2—30 字');
    if (input.role.length < 2 || input.role.length > 500) throw new Error('职责描述需为 2—500 字');
    const engine = this.db.raw.prepare("SELECT status FROM engines WHERE id = ?").get(input.engineId) as { status: string } | undefined;
    if (!engine || !['HEALTHY', 'SETUP_REQUIRED', 'AUTH_REQUIRED'].includes(engine.status)) {
      throw new Error('只能选择已安装或待配置的引擎（未就绪引擎将以演示模式执行）');
    }
    // 同名员工已存在（含已归档）：复用而非重复插入（agents.name 有 UNIQUE 约束）
    const existing = this.db.raw.prepare('SELECT id, archived FROM agents WHERE name = ?').get(input.name) as { id: string; archived: number } | undefined;
    if (existing) {
      if (existing.archived === 1) {
        // 已归档的同名员工：重新激活并更新配置
        this.db.raw.prepare(
          `UPDATE agents SET archived = 0, role = ?, system_prompt = ?, soul_md = ?, agents_md = ?, user_md = ?, engine_id = ?, permission_mode = ?, lifecycle = 'READY', updated_at = ? WHERE id = ?`
        ).run(input.role, input.systemPrompt, input.soulMd ?? '', input.agentsMd ?? '', input.userMd ?? '', input.engineId, input.permissionMode, Date.now(), existing.id);
        this.emit();
        return this.listAgents().find((a) => a.id === existing.id)!;
      }
      // 未归档的同名员工：直接返回已有的
      return this.listAgents().find((a) => a.id === existing.id)!;
    }
    const now = Date.now();
    const id = randomUUID();
    const colors = ['#4d6bfe', '#22c1a3', '#8a5cf6', '#f59e0b', '#3aa7ff', '#ef6a6a'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    // 独立工作区：未指定时自动创建 userData/aibox-data/workspaces/{name}/
    let workspace = input.workspace;
    if (!workspace) {
      const safeName = input.name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 30);
      workspace = join(app.getPath('userData'), 'aibox-data', 'workspaces', safeName);
      mkdirSync(workspace, { recursive: true });
    }
    this.db.transaction(() => {
      this.db.raw.prepare(
        `INSERT INTO agents(id, name, role, system_prompt, soul_md, agents_md, user_md, lifecycle, engine_id, workspace, permission_mode, concurrency_limit, archived, avatar_color, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, 'READY', ?, ?, ?, ?, 0, ?, ?, ?)`
      ).run(id, input.name, input.role, input.systemPrompt, input.soulMd ?? '', input.agentsMd ?? '', input.userMd ?? '', input.engineId, input.workspace, input.permissionMode, input.concurrencyLimit, color, now, now);
      for (const chId of input.channelIds) {
        this.db.raw.prepare('INSERT INTO channel_routes(id, channel_id, conversation_key, agent_id, policy) VALUES(?, ?, ?, ?, ?)')
          .run(randomUUID(), chId, '*', id, '{}');
      }
    });
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'agent.create', target: input.name, result: 'ok' });
    this.emit();
    return this.listAgents().find((a) => a.id === id)!;
  }

  startAgent(id: string) {
    this.db.raw.prepare("UPDATE agents SET lifecycle = 'READY', updated_at = ? WHERE id = ?").run(Date.now(), id);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'agent.start', target: id, result: 'ok' });
    this.emit();
  }

  stopAgent(id: string) {
    const now = Date.now();
    this.db.transaction(() => {
      this.db.raw.prepare("UPDATE agents SET lifecycle = 'DISABLED', updated_at = ? WHERE id = ?").run(now, id);
      const active = this.db.raw.prepare("SELECT id FROM tasks WHERE agent_id = ? AND status IN ('RUNNING','QUEUED','PAUSED','WAITING_APPROVAL')").all(id) as { id: string }[];
      for (const t of active) {
        this.broker.abandonTask(t.id);
        this.executors.abort(t.id);
        this.cancelTaskInternal(t.id, now);
      }
    });
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'agent.stop', target: id, result: 'ok' });
    this.emit();
  }

  /** 创建任务：该员工无活跃任务且未超并发 → 立即经执行器派发；否则进入 QUEUED 等待 FIFO 调度。
   *  opts.parentId：委派/追问的父任务；opts.sessionId：继承会话锚点（P2b 追问续跑）；
   *  opts.workspaceOverride：任务级工作空间覆盖（团队共享工作空间） */
  createTask(agentId: string, title: string, source: Task['source'] = 'desktop', opts: { parentId?: string; sessionId?: string; workspaceOverride?: string; projectId?: string } = {}): Task {
    const now = Date.now();
    const id = randomUUID();
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error('员工不存在');
    let projectId = opts.projectId ?? null;
    if (!projectId && opts.parentId) {
      const parent = this.db.raw.prepare('SELECT project_id FROM tasks WHERE id = ?').get(opts.parentId) as { project_id: string | null } | undefined;
      projectId = parent?.project_id ?? null;
    }
    if (projectId) {
      const project = this.db.raw.prepare("SELECT id FROM projects WHERE id = ? AND status != 'archived'").get(projectId) as { id: string } | undefined;
      if (!project) throw new Error('项目不存在或已归档');
    }
    const active = (this.db.raw.prepare("SELECT COUNT(*) c FROM tasks WHERE agent_id = ? AND status IN ('RUNNING','WAITING_APPROVAL','PAUSED')").get(agentId) as { c: number }).c;
    const guardReason = this.dispatchGuard();
    const canRun = agent.lifecycle === 'READY' && active < Math.max(1, agent.concurrencyLimit) && guardReason === null;
    this.db.transaction(() => {
      this.db.raw.prepare(
        'INSERT INTO tasks(id, agent_id, project_id, title, source, parent_id, status, priority, progress, stage, error, session_id, workspace_override, created_at, started_at, ended_at) VALUES(?, ?, ?, ?, ?, ?, ?, 0, 0, ?, NULL, ?, ?, ?, ?, NULL)'
      ).run(id, agentId, projectId, title, source, opts.parentId ?? null, canRun ? 'RUNNING' : 'QUEUED', canRun ? STAGES[0] : guardReason ?? '排队中', opts.sessionId ?? null, opts.workspaceOverride ?? null, now, canRun ? now : null);
      if (canRun) {
        this.db.raw.prepare('INSERT INTO agent_runs(id, agent_id, task_id, pid, session_id, status, started_at, ended_at) VALUES(?, ?, ?, ?, ?, ?, ?, NULL)')
          .run(randomUUID(), agentId, id, process.pid, randomUUID(), 'RUNNING', now);
      }
      this.db.raw.prepare('INSERT INTO task_events(id, task_id, event_type, payload, created_at) VALUES(?, ?, ?, ?, ?)')
        .run(randomUUID(), id, canRun ? 'started' : 'queued', '{}', now);
    });
    const task = this.listTasks().find((t) => t.id === id)!;
    if (canRun) this.dispatchTask(task, agent);
    this.emit();
    return task;
  }

  /** 等待任务到达终态（供团队流水线等编排逻辑轮询；超时返回 null）。轮询间隔指数退避 500ms→4s，降低并行任务时的 DB 压力 */
  waitForTask(taskId: string, timeoutMs: number): Promise<Task | null> {
    return new Promise((resolve) => {
      const started = Date.now();
      let delay = 500;
      const check = () => {
        const row = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Row | undefined;
        if (!row) return resolve(null);
        const t = this.mapTask(row);
        if (['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(t.status)) return resolve(t);
        if (Date.now() - started >= timeoutMs) return resolve(null);
        delay = Math.min(delay * 1.5, 4000);
        setTimeout(check, delay);
      };
      check();
    });
  }

  /** 追问/续跑（P2b）：新任务继承父任务的会话锚点，执行器以 resume/上下文重建方式继续 */
  createFollowUpTask(parentTaskId: string, title: string): Task {
    const row = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(parentTaskId) as Row | undefined;
    if (!row) throw new Error('原任务不存在');
    const parent = this.mapTask(row);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'task.followUp', target: parentTaskId, result: 'ok' });
    return this.createTask(parent.agentId, title, parent.source === 'schedule' ? 'desktop' : parent.source, {
      parentId: parent.id,
      sessionId: parent.sessionId ?? undefined
    });
  }

  /** 重新执行终态任务：保留归属与工作区，但不复用失败会话。 */
  retryTask(taskId: string): Task {
    const row = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(taskId) as Row | undefined;
    if (!row) throw new Error('原任务不存在或已删除');
    const original = this.mapTask(row);
    if (!['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(original.status)) throw new Error('任务尚未结束，不能重试');
    const retried = this.createTask(original.agentId, original.title, original.source === 'schedule' ? 'desktop' : original.source, {
      parentId: original.id,
      projectId: original.projectId ?? undefined,
      workspaceOverride: original.workspaceOverride ?? undefined
    });
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'task.retry', target: taskId, result: retried.id });
    return retried;
  }

  /** 软删除终态任务：执行记录和成果来源仍保留在数据库中。 */
  deleteTask(taskId: string): void {
    const row = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(taskId) as Row | undefined;
    if (!row) throw new Error('任务不存在或已删除');
    const task = this.mapTask(row);
    if (!['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(task.status)) throw new Error('请先取消任务，再执行删除');
    const activeChild = this.db.raw.prepare("SELECT id FROM tasks WHERE parent_id = ? AND deleted_at IS NULL AND status IN ('RUNNING','QUEUED','WAITING_APPROVAL','PAUSED')").get(taskId) as { id: string } | undefined;
    if (activeChild) throw new Error('该任务仍有执行中的后续任务，暂不能删除');
    this.db.raw.prepare('UPDATE tasks SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(Date.now(), taskId);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'task.delete', target: taskId, result: 'soft-deleted' });
    this.emit();
  }

  /** 经执行器注册表派发（真实引擎未就绪时自动回退演示模式） */
  private dispatchTask(task: Task, agent: Agent) {
    const kind = this.executors.kindFor(agent.engineId);
    this.executors.dispatch(task, agent, this.makeCallbacks(task.id, agent.id, agent.engineId, kind));
  }

  /** 任务事件落库（13.2 审计可追溯；详情页时间线数据源） */
  private recordEvent(taskId: string, eventType: string, payload: Record<string, unknown>, now: number) {
    this.db.raw.prepare('INSERT INTO task_events(id, task_id, event_type, payload, created_at) VALUES(?, ?, ?, ?, ?)')
      .run(randomUUID(), taskId, eventType, JSON.stringify(payload), now);
  }

  /** 执行器回调：统一走“状态更新 + task_events 同事务”模式；终态触发该员工 FIFO 补位 */
  private makeCallbacks(taskId: string, agentId: string, engineId: string, kind: ExecutorKind): ExecutorCallbacks {
    const finish = (status: 'COMPLETED' | 'FAILED' | 'INTERRUPTED', info: { result?: string; error?: string }) => {
      const now = Date.now();
      // 真实执行鉴权失败：如实把引擎标为 AUTH_REQUIRED，不掩盖
      const authFailed = kind !== 'simulated' && !!info.error && /401|403|unauthorized|auth|鉴权|登录/i.test(info.error);
      this.db.transaction(() => {
        if (status === 'COMPLETED') {
          this.db.raw.prepare("UPDATE tasks SET status = 'COMPLETED', progress = 100, stage = '完成', result = ?, ended_at = ? WHERE id = ?").run(info.result ?? null, now, taskId);
          this.recordEvent(taskId, 'result', { result: info.result ?? '' }, now);
          this.recordEvent(taskId, 'completed', { progress: 100 }, now);
        } else {
          this.db.raw.prepare('UPDATE tasks SET status = ?, error = ?, ended_at = ? WHERE id = ?').run(status, info.error ?? null, now, taskId);
          this.recordEvent(taskId, status === 'FAILED' ? 'failed' : 'interrupted', { error: info.error ?? '' }, now);
        }
        this.db.raw.prepare('UPDATE agent_runs SET ended_at = ?, status = ? WHERE task_id = ? AND ended_at IS NULL').run(now, status, taskId);
        if (authFailed) {
          this.db.raw.prepare("UPDATE engines SET status = 'AUTH_REQUIRED', auth_status = 'required' WHERE id = ?").run(engineId);
        }
      });
      if (status === 'FAILED') {
        const t = this.db.raw.prepare('SELECT title FROM tasks WHERE id = ?').get(taskId) as { title: string } | undefined;
        notify(this.db, '任务执行失败', `${t?.title ?? taskId}：${(info.error ?? '').slice(0, 120)}`);
      }
      if (authFailed) notify(this.db, '引擎需要重新登录', '执行引擎鉴权失败，已标记为待登录，请到引擎中心处理');
      // 终态订阅（webhook 等对外通知）：查询落库后的最终数据,异常不影响主流程
      {
        const t = this.db.raw.prepare('SELECT title FROM tasks WHERE id = ?').get(taskId) as { title: string } | undefined;
        for (const fn of this.finishListeners) {
          try {
            fn({ taskId, agentId, status, title: t?.title ?? taskId, result: info.result ?? null, error: info.error ?? null });
          } catch { /* 通知失败不影响调度 */ }
        }
      }
      this.emit();
      this.scheduleNext(agentId);
    };
    return {
      onStage: (id, stage) => {
        const now = Date.now();
        this.db.transaction(() => {
          const changed = this.db.raw.prepare("UPDATE tasks SET stage = ? WHERE id = ? AND status = 'RUNNING'").run(stage, id).changes;
          if (changed > 0) this.recordEvent(id, 'stage', { stage }, now);
        });
        this.emit();
      },
      onProgress: (id, progress) => {
        const now = Date.now();
        this.db.transaction(() => {
          const changed = this.db.raw.prepare("UPDATE tasks SET progress = ? WHERE id = ? AND status = 'RUNNING'").run(progress, id).changes;
          if (changed > 0) this.recordEvent(id, 'progress', { progress }, now);
        });
        this.emit();
      },
      onOutput: (id, chunk) => {
        // 高频增量文本：落事件库 + 流式推送到渲染进程（逐字显示）
        this.recordEvent(id, 'output', { chunk }, Date.now());
        for (const fn of this.outputListeners) fn(id, chunk);
      },
      onSession: (id, sessionId) => {
        // P2b：会话锚点落库（仅首次），追问时继承
        this.db.raw.prepare('UPDATE tasks SET session_id = ? WHERE id = ? AND session_id IS NULL').run(sessionId, id);
      },
      onDone: (id, result) => finish('COMPLETED', { result }),
      onError: (id, message) => finish(/超时|中断/.test(message) ? 'INTERRUPTED' : 'FAILED', { error: message })
    };
  }

  /** FIFO 调度：任务到达终态后，启动该员工最早的 QUEUED 任务（6.2 基础调度；资源保护时暂停） */
  private scheduleNext(agentId: string) {
    const agent = this.getAgent(agentId);
    if (!agent || agent.lifecycle !== 'READY') return;
    if (this.dispatchGuard() !== null) return;
    const active = (this.db.raw.prepare("SELECT COUNT(*) c FROM tasks WHERE agent_id = ? AND status IN ('RUNNING','WAITING_APPROVAL','PAUSED')").get(agentId) as { c: number }).c;
    if (active >= Math.max(1, agent.concurrencyLimit)) return;
    const row = this.db.raw.prepare("SELECT * FROM tasks WHERE agent_id = ? AND status = 'QUEUED' ORDER BY created_at LIMIT 1").get(agentId) as Row | undefined;
    if (!row) return;
    const now = Date.now();
    this.db.transaction(() => {
      this.db.raw.prepare("UPDATE tasks SET status = 'RUNNING', stage = ?, started_at = ? WHERE id = ?").run(STAGES[0], now, row.id as string);
      this.db.raw.prepare('INSERT INTO agent_runs(id, agent_id, task_id, pid, session_id, status, started_at, ended_at) VALUES(?, ?, ?, ?, ?, ?, ?, NULL)')
        .run(randomUUID(), agentId, row.id as string, process.pid, randomUUID(), 'RUNNING', now);
      this.recordEvent(row.id as string, 'started', {}, now);
    });
    const task = this.mapTask(row);
    task.status = 'RUNNING';
    this.dispatchTask(task, agent);
    this.emit();
  }

  private cancelTaskInternal(taskId: string, now: number) {
    this.db.raw.prepare("UPDATE tasks SET status = 'CANCELLED', ended_at = ? WHERE id = ? AND status IN ('RUNNING','QUEUED','WAITING_APPROVAL','PAUSED')").run(now, taskId);
    this.db.raw.prepare("UPDATE agent_runs SET ended_at = ?, status = 'CANCELLED' WHERE task_id = ? AND ended_at IS NULL").run(now, taskId);
    this.db.raw.prepare("UPDATE approvals SET status = 'rejected', decided_at = ? WHERE task_id = ? AND status = 'pending'").run(now, taskId);
  }

  cancelTask(taskId: string) {
    const task = this.db.raw.prepare('SELECT agent_id, status FROM tasks WHERE id = ? AND deleted_at IS NULL').get(taskId) as { agent_id: string; status: TaskStatus } | undefined;
    if (!task) throw new Error('任务不存在或已删除');
    if (!['RUNNING', 'QUEUED', 'WAITING_APPROVAL', 'PAUSED'].includes(task.status)) throw new Error('任务已经结束，不能取消');
    this.broker.abandonTask(taskId);
    this.executors.abort(taskId);
    this.cancelTaskInternal(taskId, Date.now());
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'task.cancel', target: taskId, result: 'ok' });
    this.emit();
    this.scheduleNext(task.agent_id);
  }

  pauseTask(taskId: string) {
    this.executors.abort(taskId);
    this.db.raw.prepare("UPDATE tasks SET status = 'PAUSED' WHERE id = ? AND status = 'RUNNING'").run(taskId);
    this.emit();
  }

  resumeTask(taskId: string) {
    // 重置 started_at：看门狗按“本段运行时长”计时，暂停等待期不计入（否则恢复即被误杀）
    const changed = this.db.raw.prepare("UPDATE tasks SET status = 'RUNNING', started_at = ? WHERE id = ? AND status = 'PAUSED'").run(Date.now(), taskId).changes;
    if (changed > 0) {
      const row = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Row | undefined;
      const agent = row ? this.getAgent(row.agent_id as string) : null;
      if (row && agent) this.dispatchTask(this.mapTask(row), agent);
    }
    this.emit();
  }

  decideApproval(approvalId: string, approve: boolean) {
    const now = Date.now();
    const ap = this.db.raw.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as Row | undefined;
    if (!ap) return;
    // P1b：命中活跃执行器（工具循环正挂起等待）→ 仅唤醒，不重新派发；拒绝也不 fail 整个任务
    const wasLive = this.broker.decide(approvalId, approve);
    this.db.transaction(() => {
      this.db.raw.prepare('UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?').run(approve ? 'approved' : 'rejected', now, approvalId);
      if (approve || wasLive) {
        // 重置 started_at：审批等待期不计入看门狗时长（否则长时间等审批的任务恢复即被误杀）
        this.db.raw.prepare("UPDATE tasks SET status = 'RUNNING', started_at = ? WHERE id = ? AND status = 'WAITING_APPROVAL'").run(now, ap.task_id as string);
      } else {
        this.db.raw.prepare("UPDATE tasks SET status = 'FAILED', ended_at = ?, error = '审批被拒绝' WHERE id = ? AND status = 'WAITING_APPROVAL'").run(now, ap.task_id as string);
      }
    });
    // 非活跃执行器（种子数据/重启后遗留）且批准 → 重新派发执行（13.2 审批链路）
    if (approve && !wasLive) {
      const row = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(ap.task_id as string) as Row | undefined;
      const agent = row ? this.getAgent(row.agent_id as string) : null;
      if (row && agent && row.status === 'RUNNING' && !this.executors.isExecuting(row.id as string)) {
        this.dispatchTask(this.mapTask(row), agent);
      }
    }
    this.db.audit({ id: randomUUID(), actor: 'admin', action: approve ? 'approval.approve' : 'approval.reject', target: approvalId, result: 'ok' });
    this.emit();
  }
}

export function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}天 ${h}小时`;
  if (h > 0) return `${h}小时 ${m}分`;
  return `${m}分 ${sec % 60}秒`;
}
