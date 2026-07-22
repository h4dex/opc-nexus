/**
 * 审批代理（P1b）：执行器运行时权限请求 → approvals 表 + 任务挂起 WAITING_APPROVAL，
 * 等待用户在任务中心批准/拒绝后唤醒执行（8.x 审批链路真实化）。
 * - 挂起以 Promise 表达；应用重启后未决审批对应任务由崩溃恢复置 INTERRUPTED（不悬挂）
 * - decide() 返回是否命中"活跃执行器"，orchestrator 据此区分：活跃 → 仅唤醒；
 *   非活跃（种子数据/执行器已退出）→ 沿用旧逻辑（批准后重新派发）
 */
import { randomUUID } from 'node:crypto';
import type { Database } from './database.js';
import { notify } from './notifier.js';
import type { Approval } from '../../shared/types.js';

export interface ApprovalRequest {
  taskId: string;
  agentId: string;
  type: Approval['type'];
  request: string;
  risk: Approval['risk'];
}

export class ApprovalBroker {
  /** approvalId → 唤醒执行器 */
  private pending = new Map<string, (approved: boolean) => void>();
  /** taskId → 该任务当前挂起的 approvalId（abort 时取消） */
  private byTask = new Map<string, string>();
  private listeners = new Set<() => void>();

  constructor(private db: Database) {}

  /** 审批产生/决策后需要推送快照（由 ipc 层订阅） */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  /** 发起审批：写库 + 任务挂起，返回用户决策（true=批准）。任务被取消时 resolve(false)。 */
  request(req: ApprovalRequest): Promise<boolean> {
    const id = randomUUID();
    const now = Date.now();
    this.db.transaction(() => {
      this.db.raw
        .prepare('INSERT INTO approvals(id, task_id, agent_id, type, request, risk, status, created_at, decided_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, NULL)')
        .run(id, req.taskId, req.agentId, req.type, req.request, req.risk, 'pending', now);
      this.db.raw.prepare("UPDATE tasks SET status = 'WAITING_APPROVAL' WHERE id = ? AND status = 'RUNNING'").run(req.taskId);
      this.db.raw
        .prepare('INSERT INTO task_events(id, task_id, event_type, payload, created_at) VALUES(?, ?, ?, ?, ?)')
        .run(randomUUID(), req.taskId, 'approval_required', JSON.stringify({ approvalId: id, request: req.request, risk: req.risk }), now);
    });
    notify(this.db, '数字员工请求审批', req.request);
    this.emit();
    return new Promise<boolean>((resolve) => {
      this.pending.set(id, (approved) => {
        this.pending.delete(id);
        this.byTask.delete(req.taskId);
        resolve(approved);
      });
      this.byTask.set(req.taskId, id);
    });
  }

  /** 用户决策：命中活跃执行器返回 true（仅唤醒，不重派发） */
  decide(approvalId: string, approved: boolean): boolean {
    const wake = this.pending.get(approvalId);
    if (!wake) return false;
    wake(approved);
    return true;
  }

  /** 任务取消/中止：挂起的审批按拒绝处理并标记 rejected */
  abandonTask(taskId: string) {
    const approvalId = this.byTask.get(taskId);
    if (!approvalId) return;
    this.db.raw.prepare("UPDATE approvals SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'").run(Date.now(), approvalId);
    this.pending.get(approvalId)?.(false);
  }
}
