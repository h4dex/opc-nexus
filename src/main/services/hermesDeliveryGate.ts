import type { Database } from './database.js';
import type { TaskStatus } from '../../shared/types.js';

export type HermesValidationVerdict = 'PASS' | 'FAIL' | 'BLOCKED' | null;

export interface HermesDeliveryGateResult {
  taskId: string;
  projectId: string | null;
  required: boolean;
  allowed: boolean;
  reason: string | null;
  validationTaskId: string | null;
  validationVerdict: HermesValidationVerdict;
}

const TERMINAL_STATUSES = new Set<TaskStatus>(['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED']);

function validationIntent(content: unknown): boolean {
  return typeof content === 'string' && /^Task intent: validation$/m.test(content);
}

function relatedTaskIds(content: unknown): string[] {
  if (typeof content !== 'string') return [];
  const marker = 'Related project tasks:';
  const start = content.indexOf(marker);
  if (start < 0) return [];
  const block = content.slice(start + marker.length).split(/\r?\n\s*\r?\n/, 1)[0] ?? '';
  return block
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => /^[A-Za-z0-9._:-]{1,128}$/.test(value));
}

/** Only a leading verdict is authoritative; prose mentioning PASS is not. */
export function parseHermesValidationVerdict(status: TaskStatus, result: unknown): HermesValidationVerdict {
  if (!TERMINAL_STATUSES.has(status)) return null;
  if (status !== 'COMPLETED' || typeof result !== 'string') return 'BLOCKED';
  const match = /^\s*(?:\*\*(PASS|FAIL|BLOCKED)\*\*|__(PASS|FAIL|BLOCKED)__|`(PASS|FAIL|BLOCKED)`|(PASS|FAIL|BLOCKED))(?=$|[\s:：.,，。;；!?！？])/i.exec(result);
  const verdict = match?.slice(1).find(Boolean);
  return verdict ? verdict.toUpperCase() as HermesValidationVerdict : 'BLOCKED';
}

interface TaskRow {
  id?: string;
  project_id?: string | null;
  conversation_id?: string | null;
  agent_id?: string | null;
  status?: TaskStatus;
  result?: string | null;
  error?: string | null;
  content?: string | null;
  created_at?: number;
}

/**
 * Main-owned delivery gate for Hermes plan tasks.
 *
 * Direct one-shot employee tasks are intentionally not forced through a
 * ceremony. A task projected from a Hermes plan is different: its owner can
 * only receive it as a deliverable after an independent employee has checked
 * the real result and returned a leading PASS verdict.
 */
export class HermesDeliveryGate {
  constructor(private readonly db: Database) {}

  check(taskId: string): HermesDeliveryGateResult {
    const task = this.db.raw.prepare(`
      SELECT id, project_id, conversation_id, agent_id, status, result, error, content, created_at
      FROM tasks WHERE id = ? AND deleted_at IS NULL
    `).get(taskId) as TaskRow | undefined;
    if (!task?.id) {
      return {
        taskId,
        projectId: null,
        required: true,
        allowed: false,
        reason: '任务不存在，无法确认交付状态',
        validationTaskId: null,
        validationVerdict: 'BLOCKED'
      };
    }

    let planJob: { draft_id?: string } | undefined;
    try {
      planJob = this.db.raw.prepare(
        'SELECT draft_id FROM hermes_plan_jobs WHERE task_id = ? LIMIT 1'
      ).get(task.id) as { draft_id?: string } | undefined;
    } catch {
      // The bridge creates this table during startup. If it is unavailable for
      // a project task, fail closed rather than accidentally delivering it.
      return this.blocked(task, 'Hermes 计划验收状态不可用，暂不交付');
    }

    // Tasks created by the simple @employee path have no plan-job row and can
    // be delivered from their own authoritative terminal state.
    if (!planJob?.draft_id) {
      const completed = task.status === 'COMPLETED';
      return {
        taskId: task.id,
        projectId: task.project_id ?? null,
        required: false,
        allowed: completed,
        reason: completed ? null : `任务当前状态为 ${task.status ?? 'UNKNOWN'}`,
        validationTaskId: null,
        validationVerdict: null
      };
    }

    const taskIdentity = task.id;
    if (!taskIdentity) return this.blocked(task, '任务身份不可用，无法确认交付状态');

    if (task.status !== 'COMPLETED') {
      return this.blocked(task, `执行任务当前状态为 ${task.status ?? 'UNKNOWN'}，尚未完成`);
    }

    const planTasks = this.db.raw.prepare(`
      SELECT t.id, t.agent_id
      FROM hermes_plan_jobs j
      JOIN tasks t ON t.id = j.task_id AND t.deleted_at IS NULL
      WHERE j.draft_id = ?
    `).all(planJob.draft_id) as Array<{ id?: string; agent_id?: string | null }>;
    const implementationTaskIds = new Set(
      planTasks.map((row) => row.id).filter((value): value is string => typeof value === 'string')
    );
    const implementationWorkers = new Set(
      planTasks.map((row) => row.agent_id).filter((value): value is string => typeof value === 'string')
    );

    const candidates = this.db.raw.prepare(`
      SELECT id, agent_id, status, result, error, content, created_at
      FROM tasks
      WHERE project_id = ? AND conversation_id = ? AND deleted_at IS NULL
        AND content LIKE 'Task intent: validation%'
      ORDER BY created_at DESC, id DESC
    `).all(task.project_id, task.conversation_id) as TaskRow[];
    const validation = candidates.find((candidate) => {
      if (!candidate.id || !validationIntent(candidate.content)) return false;
      if (candidate.agent_id && implementationWorkers.has(candidate.agent_id)) return false;
      const related = relatedTaskIds(candidate.content);
      return related.includes(taskIdentity) || (related.length > 0 && [...implementationTaskIds].every((id) => related.includes(id)));
    });

    if (!validation?.id) {
      return this.blocked(task, '尚未完成独立验收；主秘书必须先让未参与实现的数字员工验收');
    }
    const verdict = validation.status ? parseHermesValidationVerdict(validation.status, validation.result) : 'BLOCKED';
    if (verdict === 'PASS') {
      return {
        taskId: task.id,
        projectId: task.project_id ?? null,
        required: true,
        allowed: true,
        reason: null,
        validationTaskId: validation.id,
        validationVerdict: verdict
      };
    }
    const detail = validation.status && !TERMINAL_STATUSES.has(validation.status)
      ? `独立验收任务当前状态为 ${validation.status}`
      : verdict === 'FAIL'
        ? '独立验收未通过，需返工后重新验收'
        : verdict === 'BLOCKED'
          ? '独立验收被阻塞，缺少可复核证据'
          : '独立验收尚未返回 PASS';
    return {
      taskId: task.id,
      projectId: task.project_id ?? null,
      required: true,
      allowed: false,
      reason: detail,
      validationTaskId: validation.id,
      validationVerdict: verdict
    };
  }

  private blocked(task: TaskRow, reason: string): HermesDeliveryGateResult {
    return {
      taskId: task.id ?? '',
      projectId: task.project_id ?? null,
      required: true,
      allowed: false,
      reason,
      validationTaskId: null,
      validationVerdict: 'BLOCKED'
    };
  }
}
