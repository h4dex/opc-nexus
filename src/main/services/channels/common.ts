/**
 * 渠道任务公共链路：文本消息 → channel_routes 路由绑定员工 → createTask(source='channel')
 * → 轮询任务终态后回复结果（与飞书渠道同一套流程约定，超时 15 分钟转控制中心查看）。
 * 渠道来源任务的权限收紧（10.5）由执行器层统一实施（trusted 降级 + 写类工具强制审批）。
 * 对话指令（防长任务卡死/死循环的人工干预入口）：/状态 /取消 /暂停 /继续 /帮助。
 */
import type { Database } from '../database.js';
import type { Orchestrator } from '../orchestrator.js';
import type { ApprovalBroker } from '../approvalBroker.js';

const REPLY_POLL_MS = 2000;
const REPLY_TIMEOUT_MS = 15 * 60_000;

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
export function tryChannelCommand(db: Database, orchestrator: Orchestrator, channelId: string, text: string, ack: (msg: string) => void): boolean {
  const m = text.trim().match(COMMAND_RE);
  if (!m) return false;
  const [, cmd, arg] = m;

  const route = db.raw.prepare('SELECT agent_id FROM channel_routes WHERE channel_id = ? LIMIT 1').get(channelId) as { agent_id: string } | undefined;
  if (!route) {
    ack('该渠道尚未绑定数字员工，请在控制中心「连接中心」完成绑定。');
    return true;
  }
  const agentId = route.agent_id;
  const activeRows = () => db.raw.prepare(
    "SELECT id, title, status, progress, stage FROM tasks WHERE agent_id = ? AND deleted_at IS NULL AND status IN ('RUNNING','QUEUED','WAITING_APPROVAL','PAUSED') ORDER BY created_at"
  ).all(agentId) as { id: string; title: string; status: string; progress: number; stage: string }[];

  if (/^(状态|status)$/i.test(cmd)) {
    const rows = activeRows();
    if (rows.length === 0) {
      ack('当前没有执行中的任务。');
      return true;
    }
    const statusLabel: Record<string, string> = { RUNNING: '执行中', QUEUED: '排队', WAITING_APPROVAL: '待审批', PAUSED: '已暂停' };
    ack(rows.map((r, i) =>
      `${i + 1}. [${statusLabel[r.status] ?? r.status}] ${r.title}（${r.progress}% · ${r.stage}）`
    ).join('\n'));
    return true;
  }

  if (/^(取消|停止|终止|cancel|stop)$/i.test(cmd)) {
    const rows = activeRows();
    if (rows.length === 0) {
      ack('当前没有可取消的任务。');
      return true;
    }
    const all = /^(全部|所有|all)$/i.test(arg.trim());
    const targets = all ? rows : [rows[0]];
    let done = 0;
    for (const t of targets) {
      try { orchestrator.cancelTask(t.id); done++; } catch { /* 已终态跳过 */ }
    }
    ack(all ? `🛑 已终止 ${done} 个任务。` : `🛑 已终止任务：${targets[0].title}`);
    return true;
  }

  if (/^(暂停|pause)$/i.test(cmd)) {
    const running = activeRows().find((r) => r.status === 'RUNNING');
    if (!running) {
      ack('当前没有执行中的任务可暂停。');
      return true;
    }
    orchestrator.pauseTask(running.id);
    ack(`⏸️ 已暂停任务：${running.title}（回复 /继续 恢复）`);
    return true;
  }

  if (/^(继续|恢复|resume)$/i.test(cmd)) {
    const paused = activeRows().find((r) => r.status === 'PAUSED');
    if (!paused) {
      ack('当前没有暂停中的任务。');
      return true;
    }
    orchestrator.resumeTask(paused.id);
    ack(`▶️ 已恢复任务：${paused.title}`);
    return true;
  }

  if (/^(帮助|help|\?|？)$/i.test(cmd)) {
    ack(HELP_TEXT);
    return true;
  }

  ack(`未识别的指令「/${cmd}」。\n${HELP_TEXT}`);
  return true;
}

/**
 * 渠道审批拦截：若消息是审批回复且该渠道绑定员工有待审批，则执行审批决策而非创建新任务。
 * 返回 true 表示已处理（不需继续创建任务）。
 */
export function tryChannelApproval(db: Database, broker: ApprovalBroker, channelId: string, text: string, ack: (msg: string) => void): boolean {
  const isApprove = APPROVE_RE.test(text.trim());
  const isReject = REJECT_RE.test(text.trim());
  if (!isApprove && !isReject) return false;

  // 查找该渠道绑定员工的待审批
  const route = db.raw.prepare('SELECT agent_id FROM channel_routes WHERE channel_id = ? LIMIT 1').get(channelId) as { agent_id: string } | undefined;
  if (!route) return false;
  const pending = db.raw.prepare(
    "SELECT id, request FROM approvals WHERE agent_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
  ).get(route.agent_id) as { id: string; request: string } | undefined;
  if (!pending) {
    ack('当前没有待审批的操作。');
    return true;
  }

  broker.decide(pending.id, isApprove);
  ack(isApprove
    ? `✅ 已批准：${pending.request.slice(0, 80)}`
    : `❌ 已拒绝：${pending.request.slice(0, 80)}`);
  return true;
}

export function dispatchChannelTask(opts: {
  db: Database;
  orchestrator: Orchestrator;
  channelId: string;
  text: string;
  /** 即时回执（收到消息后立刻回复，也用于路由/校验失败提示） */
  ack: (message: string) => void;
  /** 终态回复（任务完成/失败/超时提示） */
  final: (message: string) => void;
}) {
  const { db, orchestrator, channelId, text, ack, final } = opts;
  if (!text) {
    ack('暂只支持文本消息，请用文字描述任务。');
    return;
  }
  // 路由：该渠道绑定的第一个员工（10.4 精确会话绑定 > 账号默认）
  const route = db.raw
    .prepare('SELECT agent_id FROM channel_routes WHERE channel_id = ? LIMIT 1')
    .get(channelId) as { agent_id: string } | undefined;
  if (!route) {
    ack('该渠道尚未绑定数字员工，请在控制中心「连接中心」完成绑定。');
    return;
  }

  let taskId: string;
  try {
    taskId = orchestrator.createTask(route.agent_id, text.slice(0, 200), 'channel').id;
  } catch (err) {
    ack(`任务创建失败：${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  ack('已接收任务，数字员工执行中…（高风险操作需在控制中心审批）');

  // 轮询任务终态后回复结果
  const started = Date.now();
  const poll = () => {
    const row = db.raw.prepare('SELECT status, result, error FROM tasks WHERE id = ?').get(taskId) as
      | { status: string; result: string | null; error: string | null }
      | undefined;
    if (!row) return;
    if (row.status === 'COMPLETED') {
      final(`✅ 任务完成：\n${row.result ?? '（无文本产物）'}`);
      return;
    }
    if (['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(row.status)) {
      final(`❌ 任务未完成（${row.status}）：${row.error ?? '无错误信息'}`);
      return;
    }
    if (Date.now() - started > REPLY_TIMEOUT_MS) {
      final('⏳ 任务仍在执行，请稍后到控制中心查看结果。');
      return;
    }
    setTimeout(poll, REPLY_POLL_MS);
  };
  setTimeout(poll, REPLY_POLL_MS);
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
