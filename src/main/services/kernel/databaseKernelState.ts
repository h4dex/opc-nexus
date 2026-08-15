import { randomUUID } from 'node:crypto';
import type { Database } from '../database.js';
import type {
  ControlKernelId,
  DispatchPlan,
  KernelAttemptRecord,
  KernelAttemptRecorder,
  KernelRequest,
  KernelSessionStore
} from './types.js';

interface StoredPlanRow {
  request_id: string;
  task_id: string | null;
  status: 'planned' | 'committed' | 'failed';
  plan_json: string;
}

export interface StoredDispatchPlan {
  requestId: string;
  taskId: string | null;
  status: StoredPlanRow['status'];
  plan: DispatchPlan;
}

/** Durable control-plane state. It never owns canonical messages or memory. */
export class DatabaseKernelState implements KernelAttemptRecorder, KernelSessionStore {
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {}

  record(attempt: KernelAttemptRecord): void {
    const latest = this.db.raw.prepare(
      'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM kernel_attempts WHERE request_id = ?'
    ).get(attempt.requestId) as { sequence: number } | undefined;
    const sequence = Math.max(attempt.sequence, Number(latest?.sequence ?? 0) + 1);
    this.db.raw.prepare(
      `INSERT INTO kernel_attempts(
        id, request_id, conversation_id, component_id, role, sequence, status,
        started_at, ended_at, error
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_id, sequence) DO NOTHING`
    ).run(
      randomUUID(), attempt.requestId, attempt.conversationId, attempt.componentId,
      attempt.role, sequence, attempt.status, attempt.startedAt, attempt.endedAt, attempt.error
    );
  }

  get(conversationId: string, kernelId: ControlKernelId): string | null {
    const row = this.db.raw.prepare(
      'SELECT native_session_id FROM kernel_sessions WHERE conversation_id = ? AND kernel_id = ? LIMIT 1'
    ).get(conversationId, kernelId) as { native_session_id: string } | undefined;
    return row?.native_session_id ?? null;
  }

  set(conversationId: string, kernelId: ControlKernelId, sessionId: string): void {
    this.db.raw.prepare(
      `INSERT INTO kernel_sessions(conversation_id, kernel_id, native_session_id, updated_at)
       VALUES(?, ?, ?, ?)
       ON CONFLICT(conversation_id, kernel_id) DO UPDATE SET
         native_session_id = excluded.native_session_id,
         updated_at = excluded.updated_at`
    ).run(conversationId, kernelId, sessionId, this.now());
  }

  clear(conversationId: string, kernelId: ControlKernelId): void {
    this.db.raw.prepare(
      'DELETE FROM kernel_sessions WHERE conversation_id = ? AND kernel_id = ?'
    ).run(conversationId, kernelId);
  }

  savePlan(request: KernelRequest, plan: DispatchPlan): StoredDispatchPlan {
    if (request.requestId !== plan.requestId || request.conversationId !== plan.conversationId) {
      throw new Error('dispatch plan does not belong to the kernel request');
    }
    const encoded = JSON.stringify(plan);
    const now = this.now();
    this.db.raw.prepare(
      `INSERT INTO dispatch_plans(
        id, request_id, organization_id, principal_id, channel_id, conversation_id,
        input_message_id, leader_kernel, worker_agent_id, worker_engine_id, status,
        task_id, plan_json, created_at, committed_at, error
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', NULL, ?, ?, NULL, NULL)
      ON CONFLICT(request_id) DO NOTHING`
    ).run(
      randomUUID(), request.requestId, request.organizationId, request.principalId,
      request.channelId, request.conversationId, request.inputMessageId, plan.leaderKernel,
      plan.workerAgentId, plan.workerEngineId, encoded, now
    );
    const stored = this.findPlan(request.requestId);
    if (!stored) throw new Error('dispatch plan persistence failed');
    if (JSON.stringify(stored.plan) !== encoded) throw new Error('request already has a different dispatch plan');
    return stored;
  }

  markCommitted(requestId: string, taskId: string): StoredDispatchPlan {
    const now = this.now();
    this.db.raw.prepare(
      `UPDATE dispatch_plans SET status = 'committed', task_id = ?, committed_at = ?, error = NULL
       WHERE request_id = ? AND status = 'planned'`
    ).run(taskId, now, requestId);
    const stored = this.findPlan(requestId);
    if (!stored) throw new Error('dispatch plan was not found');
    if (stored.status !== 'committed' || stored.taskId !== taskId) {
      throw new Error('dispatch plan was already committed to another task or failed');
    }
    return stored;
  }

  markFailed(requestId: string, error: string): void {
    this.db.raw.prepare(
      `UPDATE dispatch_plans SET status = 'failed', error = ?
       WHERE request_id = ? AND status = 'planned'`
    ).run(error.slice(0, 2_000), requestId);
  }

  findPlan(requestId: string): StoredDispatchPlan | null {
    const row = this.db.raw.prepare(
      'SELECT request_id, task_id, status, plan_json FROM dispatch_plans WHERE request_id = ? LIMIT 1'
    ).get(requestId) as StoredPlanRow | undefined;
    if (!row) return null;
    return {
      requestId: row.request_id,
      taskId: row.task_id,
      status: row.status,
      plan: JSON.parse(row.plan_json) as DispatchPlan
    };
  }
}
