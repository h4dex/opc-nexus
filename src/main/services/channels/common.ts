/**
 * 渠道任务公共链路：文本消息 → canonical ingress → channel_routes 路由绑定员工 → control kernel
 * → 轮询任务终态后回复结果（与飞书渠道同一套流程约定，超时 15 分钟转控制中心查看）。
 * 渠道来源任务的权限收紧（10.5）由执行器层统一实施（trusted 降级 + 写类工具强制审批）。
 * 对话指令（防长任务卡死/死循环的人工干预入口）：/状态 /取消 /暂停 /继续 /帮助。
 */
import type { Database } from '../database.js';
import type { CreateTaskResult, Orchestrator } from '../orchestrator.js';
import {
  ChannelIngressService,
  DEFAULT_ORGANIZATION_KEY,
  type ChannelIngressResult
} from '../channelIngressService.js';

const REPLY_POLL_MS = 2000;
const REPLY_TIMEOUT_MS = 15 * 60_000;
/** 当前进程已经为哪些任务维护终态回复轮询；重启后为空，允许上游重投恢复回复。 */
const activeReplyPolls = new Set<string>();
/** Serialize command/approval redeliveries for one durable inbound message. */
const channelActionTails = new Map<string, Promise<void>>();

/** 审批关键词检测：用户通过渠道回复“批准/同意/拒绝/取消”触发审批决策 */
const APPROVE_RE = /^(批准|同意|approve|yes|确认执行)$/i;
const REJECT_RE = /^(拒绝|取消|reject|no|不执行)$/i;

/** 对话指令（以 / 或 # 开头，全角斜杠亦可） */
const COMMAND_RE = /^[/#／]\s*(\S+)\s*(.*)$/;

const HELP_TEXT = [
  '可用指令：',
  '/状态 — 查看当前执行中/排队任务与进度',
  '/取消 — 终止当前任务（防卡死/死循环）',
  '/取消 全部 — 终止该员工全部活跃任务',
  '/暂停 — 暂停当前执行中任务',
  '/继续 — 恢复暂停的任务',
  '/帮助 — 显示本说明',
  '回复「批准 / 拒绝」处理待审批操作'
].join('\n');

/**
 * 渠道对话指令拦截：/状态 /取消 /暂停 /继续 /帮助。
 * 返回 true 表示已处理（不再创建新任务）。设计目标（P4）：
 * 长任务卡死或模型陷入死循环时，用户可从聊天侧随时干预，无需回到控制中心。
 */
export interface ChannelControlScope {
  agentId: string;
  conversationId: string;
}

interface ChannelTaskRow {
  id: string;
  title: string;
  status: string;
  progress: number;
  stage: string;
}

type ChannelControlAction =
  | { kind: 'cancel'; taskIds: string[] }
  | { kind: 'pause'; taskId: string }
  | { kind: 'resume'; taskId: string }
  | { kind: 'approval'; approvalId: string; approve: boolean }
  | { kind: 'informational' };

interface PlannedChannelControl {
  action: ChannelControlAction;
  reply: string;
}

interface ChannelControlReceiptMetadata {
  schemaVersion: 1;
  status: 'CLAIMED' | 'COMPLETED';
  sourceMessageId: string;
  action: ChannelControlAction;
}

interface ChannelControlReceiptRow {
  id: string;
  content: string;
  metadata_json: string;
}

const ACTIVE_TASK_STATUSES = new Set(['RUNNING', 'QUEUED', 'WAITING_APPROVAL', 'PAUSED']);
const TERMINAL_TASK_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED']);

function activeChannelTasks(db: Database, scope: ChannelControlScope): ChannelTaskRow[] {
  return db.raw.prepare(
    "SELECT id, title, status, progress, stage FROM tasks WHERE agent_id = ? AND conversation_id = ? AND source = 'channel' AND deleted_at IS NULL AND status IN ('RUNNING','QUEUED','WAITING_APPROVAL','PAUSED') ORDER BY created_at"
  ).all(scope.agentId, scope.conversationId) as unknown as ChannelTaskRow[];
}

function planChannelCommand(db: Database, scope: ChannelControlScope, text: string): PlannedChannelControl | null {
  const m = text.trim().match(COMMAND_RE);
  if (!m) return null;
  const [, cmd, arg] = m;

  if (/^(状态|status)$/i.test(cmd)) {
    const rows = activeChannelTasks(db, scope);
    if (rows.length === 0) return { action: { kind: 'informational' }, reply: '当前没有执行中的任务。' };
    const statusLabel: Record<string, string> = { RUNNING: '执行中', QUEUED: '排队', WAITING_APPROVAL: '待审批', PAUSED: '已暂停' };
    return {
      action: { kind: 'informational' },
      reply: rows.map((r, i) => `${i + 1}. [${statusLabel[r.status] ?? r.status}] ${r.title}（${r.progress}% · ${r.stage}）`).join('\n')
    };
  }

  if (/^(取消|停止|终止|cancel|stop)$/i.test(cmd)) {
    const rows = activeChannelTasks(db, scope);
    if (rows.length === 0) return { action: { kind: 'informational' }, reply: '当前没有可取消的任务。' };
    const all = /^(全部|所有|all)$/i.test(arg.trim());
    const targets = all ? rows : [rows[0]];
    return {
      action: { kind: 'cancel', taskIds: targets.map((target) => target.id) },
      reply: all ? `🛑 已终止 ${targets.length} 个任务。` : `🛑 已终止任务：${targets[0].title}`
    };
  }

  if (/^(暂停|pause)$/i.test(cmd)) {
    const running = activeChannelTasks(db, scope).find((row) => row.status === 'RUNNING');
    return running
      ? { action: { kind: 'pause', taskId: running.id }, reply: `⏸️ 已暂停任务：${running.title}（回复 /继续 恢复）` }
      : { action: { kind: 'informational' }, reply: '当前没有执行中的任务可暂停。' };
  }

  if (/^(继续|恢复|resume)$/i.test(cmd)) {
    const paused = activeChannelTasks(db, scope).find((row) => row.status === 'PAUSED');
    return paused
      ? { action: { kind: 'resume', taskId: paused.id }, reply: `▶️ 已恢复任务：${paused.title}` }
      : { action: { kind: 'informational' }, reply: '当前没有暂停中的任务。' };
  }

  if (/^(帮助|help|\?|？)$/i.test(cmd)) return { action: { kind: 'informational' }, reply: HELP_TEXT };
  return { action: { kind: 'informational' }, reply: `未识别的指令「/${cmd}」。\n${HELP_TEXT}` };
}

function planChannelApproval(db: Database, scope: ChannelControlScope, text: string): PlannedChannelControl | null {
  const isApprove = APPROVE_RE.test(text.trim());
  const isReject = REJECT_RE.test(text.trim());
  if (!isApprove && !isReject) return null;

  const pending = db.raw.prepare(
    `SELECT a.id, a.request FROM approvals a
     JOIN tasks t ON t.id = a.task_id
     WHERE a.agent_id = ? AND a.status = 'pending'
       AND t.conversation_id = ? AND t.source = 'channel'
     ORDER BY a.created_at DESC LIMIT 1`
  ).get(scope.agentId, scope.conversationId) as { id: string; request: string } | undefined;
  if (!pending) return { action: { kind: 'informational' }, reply: '当前没有待审批的操作。' };
  return {
    action: { kind: 'approval', approvalId: pending.id, approve: isApprove },
    reply: isApprove
      ? `✅ 已批准：${pending.request.slice(0, 80)}`
      : `❌ 已拒绝：${pending.request.slice(0, 80)}`
  };
}

function taskState(db: Database, taskId: string): { status: string } | null {
  const row = db.raw.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(taskId) as { status?: unknown } | undefined;
  return row && typeof row.status === 'string' ? { status: row.status } : null;
}

function applyChannelControlAction(db: Database, orchestrator: Orchestrator, action: ChannelControlAction): void {
  if (action.kind === 'informational') return;
  if (action.kind === 'cancel') {
    for (const taskId of action.taskIds) {
      const before = taskState(db, taskId);
      if (!before) throw new Error(`渠道控制目标任务不存在：${taskId}`);
      if (TERMINAL_TASK_STATUSES.has(before.status)) continue;
      if (!ACTIVE_TASK_STATUSES.has(before.status)) throw new Error(`渠道控制目标任务状态不可取消：${before.status}`);
      orchestrator.cancelTask(taskId);
      const after = taskState(db, taskId);
      if (!after || !TERMINAL_TASK_STATUSES.has(after.status)) throw new Error(`渠道控制目标任务未终止：${taskId}`);
    }
    return;
  }
  if (action.kind === 'pause') {
    const before = taskState(db, action.taskId);
    if (!before) throw new Error(`渠道控制目标任务不存在：${action.taskId}`);
    if (before.status === 'PAUSED' || TERMINAL_TASK_STATUSES.has(before.status)) return;
    if (before.status !== 'RUNNING') throw new Error(`渠道控制目标任务状态不可暂停：${before.status}`);
    orchestrator.pauseTask(action.taskId);
    if (taskState(db, action.taskId)?.status !== 'PAUSED') throw new Error(`渠道控制目标任务未暂停：${action.taskId}`);
    return;
  }
  if (action.kind === 'resume') {
    const before = taskState(db, action.taskId);
    if (!before) throw new Error(`渠道控制目标任务不存在：${action.taskId}`);
    if (before.status === 'RUNNING' || TERMINAL_TASK_STATUSES.has(before.status)) return;
    if (before.status !== 'PAUSED') throw new Error(`渠道控制目标任务状态不可恢复：${before.status}`);
    orchestrator.resumeTask(action.taskId);
    const after = taskState(db, action.taskId);
    if (!after || (after.status !== 'RUNNING' && !TERMINAL_TASK_STATUSES.has(after.status))) {
      throw new Error(`渠道控制目标任务未恢复：${action.taskId}`);
    }
    return;
  }

  const approval = db.raw.prepare('SELECT * FROM approvals WHERE id = ?').get(action.approvalId) as { status?: unknown } | undefined;
  if (!approval || typeof approval.status !== 'string') throw new Error(`渠道审批目标不存在：${action.approvalId}`);
  const expected = action.approve ? 'approved' : 'rejected';
  if (approval.status === expected) return;
  if (approval.status !== 'pending') throw new Error(`渠道审批目标已有相反决策：${action.approvalId}`);
  orchestrator.decideApproval(action.approvalId, action.approve);
  const decided = db.raw.prepare('SELECT * FROM approvals WHERE id = ?').get(action.approvalId) as { status?: unknown } | undefined;
  if (decided?.status !== expected) throw new Error(`渠道审批目标未完成决策：${action.approvalId}`);
}

export function tryChannelCommand(
  db: Database,
  orchestrator: Orchestrator,
  scope: ChannelControlScope,
  text: string,
  ack: (msg: string) => void
): boolean {
  const planned = planChannelCommand(db, scope, text);
  if (!planned) return false;
  applyChannelControlAction(db, orchestrator, planned.action);
  ack(planned.reply);
  return true;
}

/**
 * 渠道审批拦截：若消息是审批回复且该渠道绑定员工有待审批，则执行审批决策而非创建新任务。
 * 返回 true 表示已处理（不需继续创建任务）。
 */
export function tryChannelApproval(
  db: Database,
  orchestrator: Orchestrator,
  scope: ChannelControlScope,
  text: string,
  ack: (msg: string) => void
): boolean {
  const planned = planChannelApproval(db, scope, text);
  if (!planned) return false;
  applyChannelControlAction(db, orchestrator, planned.action);
  ack(planned.reply);
  return true;
}

export interface ChannelTaskPlanner {
  dispatch(input: { ingress: ChannelIngressResult; message: string; preferredAgentId: string }): Promise<CreateTaskResult>;
}

async function withChannelActionLock<T>(messageId: string, run: () => Promise<T>): Promise<T> {
  const previous = channelActionTails.get(messageId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  channelActionTails.set(messageId, tail);
  await previous.catch(() => {});
  try {
    return await run();
  } finally {
    release();
    if (channelActionTails.get(messageId) === tail) channelActionTails.delete(messageId);
  }
}

function parseControlAction(value: unknown): ChannelControlAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const action = value as Record<string, unknown>;
  if (action.kind === 'informational') return { kind: 'informational' };
  if (action.kind === 'cancel' && Array.isArray(action.taskIds)) {
    const taskIds = action.taskIds.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 200);
    return taskIds.length === action.taskIds.length && taskIds.length > 0 ? { kind: 'cancel', taskIds } : null;
  }
  if ((action.kind === 'pause' || action.kind === 'resume') && typeof action.taskId === 'string' && action.taskId.length > 0 && action.taskId.length <= 200) {
    return { kind: action.kind, taskId: action.taskId };
  }
  if (action.kind === 'approval'
    && typeof action.approvalId === 'string'
    && action.approvalId.length > 0
    && action.approvalId.length <= 200
    && typeof action.approve === 'boolean') {
    return { kind: 'approval', approvalId: action.approvalId, approve: action.approve };
  }
  return null;
}

function parseControlReceipt(
  row: ChannelControlReceiptRow,
  sourceMessageId: string
): ChannelControlReceiptMetadata | 'legacy-completed' {
  let value: unknown;
  try {
    value = JSON.parse(row.metadata_json);
  } catch {
    throw new Error('渠道控制回执元数据损坏');
  }
  if (value && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).status === 'CONTROL_HANDLED') {
    return 'legacy-completed';
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('渠道控制回执元数据无效');
  const metadata = value as Record<string, unknown>;
  const action = parseControlAction(metadata.action);
  if (metadata.schemaVersion !== 1
    || (metadata.status !== 'CLAIMED' && metadata.status !== 'COMPLETED')
    || metadata.sourceMessageId !== sourceMessageId
    || !action) {
    throw new Error('渠道控制回执声明无效');
  }
  return {
    schemaVersion: 1,
    status: metadata.status,
    sourceMessageId,
    action
  };
}

function findControlReceipt(db: Database, conversationId: string, receiptKey: string): ChannelControlReceiptRow | undefined {
  return db.raw.prepare(
    `SELECT id, content, metadata_json FROM messages
     WHERE conversation_id = ? AND direction = 'outbound' AND external_message_key = ?
     LIMIT 1`
  ).get(conversationId, receiptKey) as ChannelControlReceiptRow | undefined;
}

async function handleDurableChannelControl(opts: {
  db: Database;
  orchestrator: Orchestrator;
  ingress: ChannelIngressResult;
  ingressService: Pick<ChannelIngressService, 'recordOutbound'>;
  scope: ChannelControlScope;
  text: string;
  ack: (message: string) => void;
}): Promise<boolean> {
  const { db, orchestrator, ingress, ingressService, scope, text, ack } = opts;
  const receiptKey = `control:${ingress.messageId}`;
  let receipt = findControlReceipt(db, ingress.conversationId, receiptKey);
  if (!receipt) {
    const planned = planChannelCommand(db, scope, text) ?? planChannelApproval(db, scope, text);
    if (!planned) return false;
    const metadata: ChannelControlReceiptMetadata = {
      schemaVersion: 1,
      status: 'CLAIMED',
      sourceMessageId: ingress.messageId,
      action: planned.action
    };
    ingressService.recordOutbound(ingress, {
      messageKey: receiptKey,
      content: planned.reply,
      metadata: { ...metadata }
    });
    receipt = findControlReceipt(db, ingress.conversationId, receiptKey);
    if (!receipt) throw new Error('渠道控制声明持久化失败');
  }

  const parsed = parseControlReceipt(receipt, ingress.messageId);
  if (parsed === 'legacy-completed') {
    ack(receipt.content);
    return true;
  }
  if (parsed.status === 'COMPLETED') {
    db.flush();
    ack(receipt.content);
    return true;
  }

  // The exact target is durable before any Orchestrator side effect. A replay
  // reconciles this target and never re-runs the latest-task/latest-approval query.
  db.flush();
  applyChannelControlAction(db, orchestrator, parsed.action);
  db.flush();
  const completed: ChannelControlReceiptMetadata = { ...parsed, status: 'COMPLETED' };
  const changed = db.raw.prepare(
    `UPDATE messages SET content = ?, metadata_json = ?
     WHERE id = ? AND conversation_id = ? AND direction = 'outbound' AND external_message_key = ?`
  ).run(receipt.content, JSON.stringify(completed), receipt.id, ingress.conversationId, receiptKey).changes;
  if (changed !== 1) throw new Error('渠道控制回执完成状态写入失败');
  const verified = findControlReceipt(db, ingress.conversationId, receiptKey);
  if (!verified || parseControlReceipt(verified, ingress.messageId) === 'legacy-completed'
    || (parseControlReceipt(verified, ingress.messageId) as ChannelControlReceiptMetadata).status !== 'COMPLETED') {
    throw new Error('渠道控制回执完成状态校验失败');
  }
  db.flush();
  ack(receipt.content);
  return true;
}

export async function dispatchChannelTask(opts: {
  db: Database;
  orchestrator: Orchestrator;
  channelId: string;
  text: string;
  /** Tenant boundary. The desktop app currently uses one local organization. */
  organizationKey?: string;
  /** Stable sender identity supplied by the channel, never a credential/token. */
  externalIdentity?: string;
  externalIdentityDisplayName?: string;
  /** Stable direct-chat/group/thread key supplied by the channel. */
  conversationKey?: string;
  /** 渠道消息的稳定 ID；用于上游重投/进程重启后的持久化去重。 */
  sourceKey?: string;
  metadata?: Record<string, unknown>;
  /** Test/adapter injection point; production defaults to the durable service. */
  ingressService?: Pick<ChannelIngressService, 'ingest' | 'linkTask' | 'recordOutbound'>;
  /** Required control-plane router. Channel tasks cannot bypass the control kernel. */
  taskPlanner: ChannelTaskPlanner;
  /** 即时回执（收到消息后立刻回复，也用于路由/校验失败提示） */
  ack: (message: string) => void;
  /** 终态回复（任务完成/失败/超时提示） */
  final: (message: string) => void;
}): Promise<boolean> {
  const { db, orchestrator, channelId, text, sourceKey, taskPlanner, ack, final } = opts;
  if (!text) {
    ack('暂只支持文本消息，请用文字描述任务。');
    return true;
  }
  const conversationKey = opts.conversationKey?.trim() || '*';
  // 两次 AND-scope 查询实现“精确会话绑定 > 渠道默认”，避免 OR 条件扩大作用域。
  const exactRoute = conversationKey === '*'
    ? undefined
    : db.raw.prepare(
      'SELECT agent_id FROM channel_routes WHERE channel_id = ? AND conversation_key = ? LIMIT 1'
    ).get(channelId, conversationKey) as { agent_id: string } | undefined;
  const route = exactRoute ?? db.raw.prepare(
    "SELECT agent_id FROM channel_routes WHERE channel_id = ? AND conversation_key = '*' LIMIT 1"
  ).get(channelId) as { agent_id: string } | undefined;
  if (!route) {
    ack('该渠道尚未绑定数字员工，请在控制中心「连接中心」完成绑定。');
    return true;
  }

  let taskId: string;
  let deduplicated = false;
  const ingressService = opts.ingressService ?? new ChannelIngressService(db);
  let ingress: ChannelIngressResult;
  try {
    ingress = ingressService.ingest({
      organizationKey: opts.organizationKey ?? DEFAULT_ORGANIZATION_KEY,
      channelId,
      agentId: route.agent_id,
      externalIdentity: opts.externalIdentity?.trim() || `anonymous:${channelId}`,
      externalIdentityDisplayName: opts.externalIdentityDisplayName,
      conversationKey,
      messageKey: sourceKey,
      text,
      metadata: opts.metadata
    });
    const handledControl = await withChannelActionLock(ingress.messageId, () => handleDurableChannelControl({
      db,
      orchestrator,
      ingress,
      ingressService,
      scope: { agentId: route.agent_id, conversationId: ingress.conversationId },
      text,
      ack
    }));
    if (handledControl) return true;

    if (ingress.taskId) {
      taskId = ingress.taskId;
      deduplicated = true;
    } else {
      // v32/v33 used channelId:sourceKey. Recover such a task after upgrade,
      // then link it into the canonical message chain instead of duplicating it.
      const normalizedSourceKey = sourceKey?.trim();
      const legacySourceKey = normalizedSourceKey ? `${channelId}:${normalizedSourceKey}` : null;
      const legacy = legacySourceKey
        ? db.raw.prepare('SELECT * FROM tasks WHERE source = ? AND source_key = ?').get('channel', legacySourceKey) as { id: string } | undefined
        : undefined;
      if (!legacy) ack('已接收消息，控制核正在规划并选择执行员工…');
      const task = legacy
        ? { id: legacy.id, deduplicated: true as const }
        : await taskPlanner.dispatch({ ingress, message: text, preferredAgentId: route.agent_id });
      taskId = task.id;
      deduplicated = task.deduplicated === true;
      ingressService.linkTask(ingress, taskId);
    }
    db.flush();
    if (deduplicated && activeReplyPolls.has(taskId)) return true;
  } catch (err) {
    ack(`任务创建失败：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  const finish = (message: string, messageKey: string, status: string) => {
    try {
      ingressService.recordOutbound(ingress, {
        messageKey,
        content: message,
        taskId,
        metadata: { status }
      });
    } catch (error) {
      console.error(`[ChannelIngress] Failed to persist outbound message for task ${taskId}:`, error);
    }
    final(message);
  };
  const current = deduplicated
    ? db.raw.prepare('SELECT status, result, error FROM tasks WHERE id = ?').get(taskId) as
      | { status: string; result: string | null; error: string | null }
      | undefined
    : undefined;
  if (current?.status === 'COMPLETED') {
    finish(`✅ 任务完成：\n${current.result ?? '（无文本产物）'}`, `task:${taskId}:completed`, current.status);
    return true;
  }
  if (current && ['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(current.status)) {
    finish(`❌ 任务未完成（${current.status}）：${current.error ?? '无错误信息'}`, `task:${taskId}:terminal`, current.status);
    return true;
  }

  activeReplyPolls.add(taskId);
  ack(deduplicated
    ? '已恢复任务状态跟踪，数字员工仍在执行中…'
    : '控制核规划完成，数字员工已接单。');

  // 轮询任务终态后回复结果
  const started = Date.now();
  const poll = () => {
    const row = db.raw.prepare('SELECT status, result, error FROM tasks WHERE id = ?').get(taskId) as
      | { status: string; result: string | null; error: string | null }
      | undefined;
    if (!row) {
      activeReplyPolls.delete(taskId);
      return;
    }
    if (row.status === 'COMPLETED') {
      activeReplyPolls.delete(taskId);
      finish(`✅ 任务完成：\n${row.result ?? '（无文本产物）'}`, `task:${taskId}:completed`, row.status);
      return;
    }
    if (['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(row.status)) {
      activeReplyPolls.delete(taskId);
      finish(`❌ 任务未完成（${row.status}）：${row.error ?? '无错误信息'}`, `task:${taskId}:terminal`, row.status);
      return;
    }
    if (Date.now() - started > REPLY_TIMEOUT_MS) {
      activeReplyPolls.delete(taskId);
      finish('⏳ 任务仍在执行，请稍后到控制中心查看结果。', `task:${taskId}:timeout`, 'TIMEOUT');
      return;
    }
    setTimeout(poll, REPLY_POLL_MS);
  };
  setTimeout(poll, REPLY_POLL_MS);
  return true;
}

/** WebSocket 最小接口（使用 ws 库，Node.js 原生 WebSocket 对部分服务器兼容性不足） */
export interface WsLike {
  send(data: string): void;
  close(): void;
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: Buffer | string) => void): void;
  on(event: 'close', cb: (code: number, reason: Buffer) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  removeListener(event: string, cb: (...args: unknown[]) => void): void;
}

export type WsCtor = new (url: string, opts?: { handshakeTimeout?: number }) => WsLike;

/** 获取 ws 库构造器（动态 import 避免未使用时引入开销） */
export async function createWs(url: string): Promise<WsLike> {
  const { default: WebSocket } = await import('ws');
  return new WebSocket(url, { handshakeTimeout: 8000 }) as unknown as WsLike;
}
