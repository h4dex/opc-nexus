import { randomUUID } from 'node:crypto';
import type { Database } from './database.js';

export interface HermesAcceptanceTaskFinished {
  taskId: string;
  agentId: string;
  status: 'COMPLETED' | 'FAILED' | 'INTERRUPTED' | 'CANCELLED';
}

interface HermesAcceptanceRuntime {
  getStatus(projectId: string): { state: string };
  enqueueProjectTurn(projectId: string, input: {
    conversationId: string;
    principalId: string;
    message: string;
    title?: string;
    systemMessage?: string;
  }): { id: string };
}

export interface HermesAcceptanceArtifactRuntime {
  start(taskId: string): Promise<{ ok: boolean; error?: string | null }>;
}

interface PlanRow {
  draft_id?: string;
  conversation_id?: string;
  principal_id?: string;
  employee_id?: string | null;
}

interface PlanTaskRow {
  task_id?: string;
  agent_id?: string | null;
  status?: string;
}

interface ValidationRow {
  id?: string;
  agent_id?: string | null;
  content?: string | null;
  status?: string;
}

interface RuntimeRow {
  task_id?: string;
  payload?: string | null;
}

interface ChatQueueRow {
  id?: string;
  title?: string | null;
  message?: string | null;
  status?: string;
}

export interface HermesAcceptanceReviewer {
  id: string;
  name: string;
  role?: string | null;
}

type ReviewerResolver = (projectId: string, excludedAgentIds: ReadonlySet<string>) => HermesAcceptanceReviewer[];

const VALIDATION_MARKER = '[OPC-NEXUS-AUTO-VALIDATION]';
const VALIDATION_STATUS_MARKER = '[OPC-NEXUS-AUTO-VALIDATION-STATUS]';
const FOLLOWUP_MARKER = '[OPC-NEXUS-AUTO-FOLLOWUP]';
// Give Main-owned artifact startup a brief chance to persist its real URL
// before the secretary is prompted. A missing URL still fails closed.
const ACCEPTANCE_TRIGGER_DELAY_MS = 1_500;

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

/**
 * Wakes the Hermes primary coordinator after a governed plan really finishes.
 * The coordinator still chooses the reviewer and calls Nexus tools; Main only
 * supplies a durable trigger and prevents duplicate or self-review requests.
 */
export class HermesAcceptanceCoordinator {
  private readonly requested = new Set<string>();
  private readonly followupsRequested = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly runtime: HermesAcceptanceRuntime,
    private readonly reviewerResolver?: ReviewerResolver,
    private readonly artifactRuntime?: HermesAcceptanceArtifactRuntime,
  ) {}

  onTaskFinished(info: HermesAcceptanceTaskFinished): void {
    if (info.status !== 'COMPLETED') {
      // A failed worker must not disappear from the owner's workflow. Wake
      // the primary secretary so it can read the authoritative failure and
      // ask the worker for a factual status before proposing a bounded retry.
      if (['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(info.status)) {
        setTimeout(() => this.considerFailedTask(info.taskId), ACCEPTANCE_TRIGGER_DELAY_MS);
      }
      return;
    }
    // Plan-job rows are committed immediately after task creation. Deferring
    // one turn also covers a very fast worker finishing before that insert.
    // The project scan is a compensating read: it covers a missed/late
    // completion callback without creating a second acceptance state machine.
    setTimeout(() => {
      void this.considerTask(info.taskId);
      this.considerValidationCompletion(info.taskId);
      const projectId = this.projectForTask(info.taskId);
      if (projectId) this.scanProject(projectId);
    }, ACCEPTANCE_TRIGGER_DELAY_MS);
  }

  scanProject(projectId: string): void {
    try {
      const rows = this.db.raw.prepare(`
        SELECT j.task_id
        FROM hermes_plan_jobs j
        JOIN tasks t ON t.id = j.task_id AND t.project_id = ? AND t.deleted_at IS NULL
        WHERE t.status = 'COMPLETED'
        ORDER BY t.ended_at DESC, t.id DESC
        LIMIT 32
      `).all(projectId) as Array<{ task_id?: string }>;
      for (const row of rows) if (row.task_id) void this.considerTask(row.task_id);
      const completedValidations = this.db.raw.prepare(`
        SELECT id
        FROM tasks
        WHERE project_id = ? AND deleted_at IS NULL
          AND status IN ('COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED')
          AND content LIKE 'Task intent: validation%'
        ORDER BY ended_at DESC, id DESC
        LIMIT 32
      `).all(projectId) as Array<{ id?: string }>;
      for (const row of completedValidations) if (row.id) this.considerValidationCompletion(row.id);
    } catch {
      // Older databases may not have the Hermes plan tables until the bridge
      // has initialized. The next task completion/health event retries it.
    }
  }

  private considerFailedTask(taskId: string): void {
    let task: {
      id?: string;
      project_id?: string;
      conversation_id?: string;
      agent_id?: string | null;
      title?: string;
      status?: string;
      content?: string | null;
      result?: string | null;
      error?: string | null;
    } | undefined;
    try {
      task = this.db.raw.prepare(`
        SELECT id, project_id, conversation_id, agent_id, title, status, content, result, error
        FROM tasks
        WHERE id = ? AND deleted_at IS NULL
        LIMIT 1
      `).get(taskId) as typeof task;
    } catch {
      return;
    }
    if (!task?.id || !task.project_id || !task.conversation_id || !task.status) return;
    if (!['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(task.status)) return;
    // Validation/status-inquiry tasks are already follow-up work. Do not
    // recursively wake the secretary for their own terminal state.
    if (typeof task.content === 'string' && /^Task intent: (status_inquiry|validation)$/m.test(task.content)) return;

    let plan: PlanRow | undefined;
    try {
      plan = this.db.raw.prepare(`
        SELECT d.draft_id, d.conversation_id, c.principal_id, p.employee_id
        FROM hermes_plan_jobs j
        JOIN hermes_plan_drafts d ON d.draft_id = j.draft_id
        JOIN hermes_plan_projections g
          ON g.draft_id = d.draft_id AND g.project_id = d.project_id
         AND g.status IN ('APPROVED', 'DISPATCHED')
        JOIN conversations c ON c.id = d.conversation_id AND c.project_id = d.project_id
        LEFT JOIN hermes_conversation_profiles p
          ON p.project_id = c.project_id AND p.conversation_id = c.id
        WHERE j.task_id = ?
        LIMIT 1
      `).get(taskId) as PlanRow | undefined;
    } catch {
      return;
    }
    if (!plan?.draft_id || !plan.conversation_id || !plan.principal_id || !task.agent_id) return;
    // A pinned employee conversation is not the owner-facing coordinator.
    if (plan.employee_id) return;
    const key = `${plan.draft_id}:${task.id}`;
    if (this.followupsRequested.has(key)) return;

    const runtimeStatus = this.runtime.getStatus(task.project_id);
    if (runtimeStatus.state !== 'healthy') {
      this.audit('hermes.followup.auto-blocked', task.project_id, `${plan.draft_id}:${task.id}:runtime=${runtimeStatus.state}`);
      return;
    }

    const marker = `${FOLLOWUP_MARKER} plan=${plan.draft_id} task=${task.id}`;
    try {
      const queued = this.db.raw.prepare(`
        SELECT id FROM hermes_chat_queue
        WHERE project_id = ? AND conversation_id = ? AND message LIKE ?
        ORDER BY created_at DESC LIMIT 1
      `).get(task.project_id, plan.conversation_id, `%${marker}%`) as { id?: string } | undefined;
      if (queued?.id) {
        this.followupsRequested.add(key);
        return;
      }
    } catch {
      return;
    }

    this.followupsRequested.add(key);
    const detail = String(task.error || task.result || '没有可用的终态产出').replace(/[\r\n]+/g, ' ').slice(0, 2_000);
    const message = [
      marker,
      `你是本项目主秘书。数字员工“${task.title || task.agent_id}”的真实任务已进入 ${task.status}，不能把它当作完成。`,
      `第一步必须调用 nexus_task_status，taskId=${task.id}，waitSeconds=0，读取权威 status、result 和 failureReason。Main 记录的错误摘要：${detail}`,
      `如果没有真实产出或原因需要员工解释，再调用 nexus_delegate_task：workerAgentId=${task.agent_id}，intent=status_inquiry，relatedTaskIds=["${task.id}"]，expectedArtifacts=[]，询问它实际做到了哪一步、缺少什么和是否可恢复。`,
      '收到真实回执后，只有在预算、权限和项目目录仍然有效时，才能向老板提出一次有界的 execution 重派建议；不得静默无限重试、复制占位文件或把失败改写为成功。向老板汇总时必须保留 FAILED、CANCELLED 或 INTERRUPTED 原因。'
    ].join('\n');
    try {
      const queued = this.runtime.enqueueProjectTurn(task.project_id, {
        conversationId: plan.conversation_id,
        principalId: plan.principal_id,
        message,
        title: '主秘书追问失败员工',
        systemMessage: '这是 Main 在数字员工没有真实产出后发出的治理跟进。必须先读 nexus_task_status，再通过 status_inquiry 询问原员工；禁止伪造完成。'
      });
      this.audit('hermes.followup.auto-request', task.project_id, `${plan.draft_id}:${task.id}:queue=${queued.id}`);
    } catch (error) {
      this.followupsRequested.delete(key);
      this.audit(
        'hermes.followup.auto-error',
        task.project_id,
        `${plan.draft_id}:${task.id}:${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000)
      );
    }
  }

  private async considerTask(taskId: string): Promise<void> {
    let plan: PlanRow | undefined;
    try {
      plan = this.db.raw.prepare(`
        SELECT d.draft_id, d.conversation_id, c.principal_id,
               p.employee_id
        FROM hermes_plan_jobs j
        JOIN hermes_plan_drafts d ON d.draft_id = j.draft_id
        JOIN hermes_plan_projections g
          ON g.draft_id = d.draft_id AND g.project_id = d.project_id
         AND g.status IN ('APPROVED', 'DISPATCHED')
        JOIN conversations c ON c.id = d.conversation_id AND c.project_id = d.project_id
        LEFT JOIN hermes_conversation_profiles p
          ON p.project_id = c.project_id AND p.conversation_id = c.id
        -- The draft remains PROJECTED after host admission. Approval and
        -- dispatch are authoritative in hermes_plan_projections, joined
        -- above; filtering on d.status would silently suppress validation.
        WHERE j.task_id = ?
        LIMIT 1
      `).get(taskId) as PlanRow | undefined;
    } catch {
      return;
    }
    if (!plan?.draft_id || !plan.conversation_id || !plan.principal_id) return;
    // A pinned employee is not the primary coordinator. It must not create a
    // plan-level acceptance request on behalf of the owner.
    if (plan.employee_id) return;
    const key = `${plan.draft_id}:${plan.conversation_id}`;
    if (this.requested.has(key)) return;

    let tasks: PlanTaskRow[];
    try {
      tasks = this.db.raw.prepare(`
        SELECT j.task_id, t.agent_id, t.status
        FROM hermes_plan_jobs j
        JOIN tasks t ON t.id = j.task_id AND t.deleted_at IS NULL
        WHERE j.draft_id = ?
        ORDER BY j.node_id
      `).all(plan.draft_id) as PlanTaskRow[];
    } catch {
      return;
    }
    const taskIds = tasks.map((row) => row.task_id).filter((value): value is string => Boolean(value));
    if (taskIds.length === 0 || tasks.some((row) => row.status !== 'COMPLETED')) return;
    const implementationWorkers = new Set(
      tasks.map((row) => row.agent_id).filter((value): value is string => Boolean(value))
    );

    const projectId = this.projectForPlan(plan.draft_id);
    if (!projectId) return;
    // Main owns preview startup. Starting every completed artifact here makes
    // runtime evidence available for unattended acceptance; failures remain
    // fail-closed and are reflected in the subsequent runtime gate.
    if (this.artifactRuntime) {
      for (const taskId of taskIds) {
        try { await this.artifactRuntime.start(taskId); } catch { /* gate below records the missing evidence */ }
      }
    }
    const reviewers = this.availableReviewers(projectId, implementationWorkers);
    if (reviewers.length === 0) {
      this.audit('hermes.acceptance.auto-blocked', projectId, `${plan.draft_id}:no-independent-ready-reviewer`);
      return;
    }
    const runtimeEvidence = this.runtimeEvidence(taskIds);
    const reviewerEvidence = reviewers
      .map((reviewer) => `- ${reviewer.name} (${reviewer.id})${reviewer.role ? `：${reviewer.role}` : ''}`)
      .join('\n');
    let validations: ValidationRow[] = [];
    try {
      validations = this.db.raw.prepare(`
        SELECT id, agent_id, content, status
        FROM tasks
        WHERE project_id = ? AND conversation_id = ? AND deleted_at IS NULL
          AND content LIKE 'Task intent: validation%'
        ORDER BY created_at DESC, id DESC
      `).all(projectId, plan.conversation_id) as ValidationRow[];
    } catch {
      return;
    }
    const existing = validations.find((row) => {
      if (!row.id || (row.agent_id && implementationWorkers.has(row.agent_id))) return false;
      const related = new Set(relatedTaskIds(row.content));
      return taskIds.every((id) => related.has(id));
    });
    if (existing) return;

    // An owner-triggered validation turn may already be waiting for or using
    // this exact implementation set. Suppress the automatic prompt before it
    // reaches Hermes; the dispatcher remains the final atomic dedupe boundary.
    try {
      const activeTurns = this.db.raw.prepare(`
        SELECT id, title, message, status
        FROM hermes_chat_queue
        WHERE project_id = ? AND conversation_id = ?
          AND status IN ('QUEUED', 'RUNNING')
        ORDER BY created_at, id
        LIMIT 128
      `).all(projectId, plan.conversation_id) as ChatQueueRow[];
      const equivalentTurn = activeTurns.find((row) => {
        const text = `${row.title ?? ''}\n${row.message ?? ''}`;
        return /(?:validation|验收)/i.test(text) && taskIds.every((id) => text.includes(id));
      });
      if (equivalentTurn?.id) {
        this.requested.add(key);
        this.audit('hermes.acceptance.auto-deduplicated', projectId, `${plan.draft_id}:queue=${equivalentTurn.id}`);
        return;
      }
    } catch {
      return;
    }

    const runtimeStatus = this.runtime.getStatus(projectId);
    if (runtimeStatus.state !== 'healthy') {
      this.audit('hermes.acceptance.auto-blocked', projectId, `${plan.draft_id}:runtime=${runtimeStatus.state}`);
      return;
    }

    // The queue is durable. Re-opening the app must not enqueue the same
    // acceptance prompt again while the previous one is still pending.
    try {
      const queued = this.db.raw.prepare(`
        SELECT id FROM hermes_chat_queue
        WHERE project_id = ? AND conversation_id = ? AND message LIKE ?
        ORDER BY created_at DESC LIMIT 1
      `).get(projectId, plan.conversation_id, `%${VALIDATION_MARKER} plan=${plan.draft_id}%`) as { id?: string } | undefined;
      if (queued?.id) {
        this.requested.add(key);
        return;
      }
    } catch {
      return;
    }

    this.requested.add(key);
    const message = [
      `${VALIDATION_MARKER} plan=${plan.draft_id}`,
      '你是本项目主秘书。该 Hermes 计划的所有实现任务已真实完成。',
      `请先用 nexus_task_status 查询这些实现任务：${taskIds.join(', ')}。`,
      runtimeEvidence
        ? `Main 已从真实产物运行事件记录了以下预览证据：\n${runtimeEvidence}\n只能使用这里的完整 URL；禁止猜测端口、使用 :0、file:// 或不存在的路径。验收员工必须先用 http_request 对这个精确 URL 发起 GET，再用 browser_navigate 打开同一 URL，并用 browser_get_content 检查真实 DOM；任一工具不可用或检查失败都必须返回 BLOCKED。`
        : 'Main 没有记录到可用的运行地址。不得猜测端口或使用 file://；若验收需要运行页面，必须如实返回 BLOCKED。',
      `Main 已确认以下 READY 且未参与实现的验收员工，workerAgentId 必须从这个列表中精确选择，禁止编造或猜测 ID：\n${reviewerEvidence}`,
      '然后选择一名 READY 且没有参与上述实现任务的数字员工，调用 nexus_delegate_task：intent 必须为 validation，relatedTaskIds 必须包含全部上述任务，expectedArtifacts 必须为 []。验收员工不得创建新的验收文件，必须把首个非空结果词写成 PASS、FAIL 或 BLOCKED，并列出实际工具证据。',
      '等待验收员工进入终态，再用 nexus_task_status 查询它。只有权威 validationVerdict=PASS 才能向老板报告交付；FAIL 或 BLOCKED 必须如实说明并提出有限返工建议。不要自己验收、不要伪造结果、不要再次派发实现任务。'
    ].join('\n');
    try {
      const queued = this.runtime.enqueueProjectTurn(projectId, {
        conversationId: plan.conversation_id,
        principalId: plan.principal_id,
        message,
        title: '主秘书独立验收',
        systemMessage: '这是 Main 在实现任务全部完成后自动发出的治理触发。必须通过 Nexus 工具询问其他子 Agent，不能用文字假设代替验收。'
      });
      this.audit('hermes.acceptance.auto-request', projectId, `${plan.draft_id}:queue=${queued.id}`);
    } catch (error) {
      this.requested.delete(key);
      this.audit(
        'hermes.acceptance.auto-error',
        projectId,
        `${plan.draft_id}:${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000)
      );
    }
  }

  /**
   * A secretary can dispatch an independent validator and then stop after the
   * dispatch receipt. Once that validator reaches a terminal state, Main
   * queues a second, durable turn requiring the secretary to read the
   * authoritative task status before reporting to the owner. This keeps the
   * model's prose from becoming the source of truth while preserving the
   * secretary as the user-facing coordinator.
   */
  private considerValidationCompletion(taskId: string): void {
    let validation: {
      id?: string;
      project_id?: string;
      conversation_id?: string;
      agent_id?: string | null;
      status?: string;
      content?: string | null;
    } | undefined;
    try {
      validation = this.db.raw.prepare(`
        SELECT id, project_id, conversation_id, agent_id, status, content
        FROM tasks
        WHERE id = ? AND deleted_at IS NULL
          AND content LIKE 'Task intent: validation%'
        LIMIT 1
      `).get(taskId) as typeof validation;
    } catch {
      return;
    }
    if (!validation?.id || !validation.project_id || !validation.conversation_id) return;
    if (!['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(String(validation.status))) return;
    const related = relatedTaskIds(validation.content);
    if (related.length === 0) return;

    let plans: Array<{ draft_id?: string; conversation_id?: string; principal_id?: string }>;
    try {
      const placeholders = related.map(() => '?').join(', ');
      plans = this.db.raw.prepare(`
        SELECT DISTINCT d.draft_id, d.conversation_id, c.principal_id
        FROM hermes_plan_jobs j
        JOIN hermes_plan_drafts d ON d.draft_id = j.draft_id
        JOIN conversations c ON c.id = d.conversation_id AND c.project_id = d.project_id
        WHERE j.task_id IN (${placeholders}) AND d.project_id = ?
      `).all(...related, validation.project_id) as Array<{ draft_id?: string; conversation_id?: string; principal_id?: string }>;
    } catch {
      return;
    }

    for (const plan of plans) {
      if (!plan.draft_id || !plan.conversation_id || !plan.principal_id) continue;
      // Do not ask a validator to validate an incomplete implementation DAG.
      let implementation: Array<{ task_id?: string; agent_id?: string | null; status?: string }>;
      try {
        implementation = this.db.raw.prepare(`
          SELECT j.task_id, t.agent_id, t.status
          FROM hermes_plan_jobs j
          JOIN tasks t ON t.id = j.task_id AND t.deleted_at IS NULL
          WHERE j.draft_id = ?
          ORDER BY j.node_id
        `).all(plan.draft_id) as Array<{ task_id?: string; agent_id?: string | null; status?: string }>;
      } catch {
        continue;
      }
      if (implementation.length === 0 || implementation.some((row) => row.status !== 'COMPLETED')) continue;
      const implementationWorkers = new Set(
        implementation.map((row) => row.agent_id).filter((value): value is string => Boolean(value))
      );
      if (validation.agent_id && implementationWorkers.has(validation.agent_id)) continue;

      let alreadyQueued: { id?: string } | undefined;
      try {
        alreadyQueued = this.db.raw.prepare(`
          SELECT id FROM hermes_chat_queue
          WHERE project_id = ? AND conversation_id = ? AND message LIKE ?
          ORDER BY created_at DESC LIMIT 1
        `).get(
          validation.project_id,
          plan.conversation_id,
          `%${VALIDATION_STATUS_MARKER} plan=${plan.draft_id} validation=${validation.id}%`
        ) as { id?: string } | undefined;
      } catch {
        continue;
      }
      if (alreadyQueued?.id) continue;

      const message = [
        `${VALIDATION_STATUS_MARKER} plan=${plan.draft_id} validation=${validation.id}`,
        '你是本项目主秘书。独立验收员工已经进入终态。现在必须调用 nexus_task_status，waitSeconds 必须为 0，读取该验收任务的权威 status、terminal 和 validationVerdict。',
        '只能根据这次工具回执向老板汇总 PASS、FAIL 或 BLOCKED；不要根据验收员工之前的文字自行推断，不要重新派发任何任务。validationVerdict 不是 PASS 时不得宣称交付完成。'
      ].join('\n');
      try {
        const queued = this.runtime.enqueueProjectTurn(validation.project_id, {
          conversationId: plan.conversation_id,
          principalId: plan.principal_id,
          message,
          title: '主秘书读取独立验收结果',
          systemMessage: '这是 Main 在独立验收员工进入终态后自动发出的治理跟进。必须调用 nexus_task_status 读取权威 validationVerdict，再向老板汇总。'
        });
        this.audit('hermes.acceptance.auto-status-request', validation.project_id, `${plan.draft_id}:${validation.id}:queue=${queued.id}`);
      } catch (error) {
        this.audit(
          'hermes.acceptance.auto-status-error',
          validation.project_id,
          `${plan.draft_id}:${validation.id}:${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000)
        );
      }
    }
  }

  private projectForPlan(draftId: string): string | null {
    try {
      const row = this.db.raw.prepare('SELECT project_id FROM hermes_plan_drafts WHERE draft_id = ?').get(draftId) as { project_id?: string } | undefined;
      return row?.project_id ?? null;
    } catch {
      return null;
    }
  }

  private runtimeEvidence(taskIds: string[]): string | null {
    if (taskIds.length === 0) return null;
    try {
      const placeholders = taskIds.map(() => '?').join(', ');
      const rows = this.db.raw.prepare(`
        SELECT task_id, payload
        FROM task_events
        WHERE event_type = 'artifact_runtime' AND task_id IN (${placeholders})
        ORDER BY created_at DESC, rowid DESC
        LIMIT 64
      `).all(...taskIds) as RuntimeRow[];
      const seen = new Set<string>();
      const entries: string[] = [];
      for (const row of rows) {
        if (!row.task_id || typeof row.payload !== 'string') continue;
        let runtime: Record<string, unknown> | undefined;
        try {
          const parsed = JSON.parse(row.payload) as { runtime?: Record<string, unknown> };
          runtime = parsed.runtime;
        } catch {
          continue;
        }
        const url = typeof runtime?.url === 'string' ? runtime.url.trim() : '';
        const state = typeof runtime?.state === 'string' ? runtime.state : '';
        if (!url || !/^https?:\/\/127\.0\.0\.1:\d{1,5}\/$/.test(url) || !['STARTING', 'RUNNING'].includes(state)) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        entries.push(`- task ${row.task_id}: ${url}`);
      }
      return entries.length > 0 ? entries.join('\n') : null;
    } catch {
      return null;
    }
  }

  private projectForTask(taskId: string): string | null {
    try {
      const row = this.db.raw.prepare(
        'SELECT project_id FROM tasks WHERE id = ? AND deleted_at IS NULL'
      ).get(taskId) as { project_id?: string | null } | undefined;
      return row?.project_id ?? null;
    } catch {
      return null;
    }
  }

  private availableReviewers(projectId: string, excludedAgentIds: ReadonlySet<string>): HermesAcceptanceReviewer[] {
    try {
      const reviewers = this.reviewerResolver
        ? this.reviewerResolver(projectId, excludedAgentIds)
        : (() => {
            const rows = this.db.raw.prepare(`
              SELECT a.id, a.name, a.role
              FROM agents a
              JOIN projects p ON p.id = ? AND p.organization_id = a.organization_id
              WHERE a.lifecycle = 'READY' AND a.archived = 0
              ORDER BY a.name, a.id
            `).all(projectId) as unknown as HermesAcceptanceReviewer[];
            return rows;
          })();
      return reviewers.filter((reviewer) => (
        typeof reviewer.id === 'string'
        && reviewer.id.length > 0
        && !excludedAgentIds.has(reviewer.id)
      ));
    } catch {
      return [];
    }
  }

  private audit(action: string, projectId: string, result: string): void {
    this.db.audit({
      id: randomUUID(), actor: 'system', action, target: projectId, result, source: 'hermes'
    });
  }
}
