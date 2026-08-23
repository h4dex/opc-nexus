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
import { existsSync, mkdirSync, readdirSync, rmdirSync } from 'node:fs';
import { app } from 'electron';
import type { Database } from './database.js';
import type { ExecutorRegistry } from './executor/index.js';
import type { ExecutionBinding, ExecutorCallbacks } from './executor/types.js';
import type { ApprovalBroker, ApprovalRequest } from './approvalBroker.js';
import type { ToolHost } from './executor/tools.js';
import type { DatabaseKernelState } from './kernel/databaseKernelState.js';
import type { DispatchPlan, KernelRequest } from './kernel/types.js';
import { notify } from './notifier.js';
import { loadUserConfig } from './userConfig.js';
import { MAX_TASK_OUTPUT_CHARS } from './textEncoding.js';
import { ANDROID_OPERATOR_ENGINE_ID, assertAndroidOperatorEngine } from './mobileEnginePolicy.js';
import type {
  Agent, AgentCardView, Approval, ApprovalScope, CreateAgentInput, DashboardStats, DerivedAgentStatus,
  EngineStatus, ProjectArtifactManifest, Task, TaskEvent, TaskQuality, TaskStatus, TodoItem
} from '../../shared/types.js';
import { engineDisplayName } from '../../shared/engineVisibility.js';

type Row = Record<string, unknown>;

export function ownerFacingEngineName(engineId: string, name: string | undefined): string {
  return engineDisplayName(engineId, name);
}

export interface AgentCreationCheckpoint {
  existing: Row | null;
  autoWorkspacePath: string | null;
  autoWorkspaceExisted: boolean;
}

export type CreateTaskResult = Task & { deduplicated?: true };

export interface TaskFinishedInfo {
  taskId: string;
  agentId: string;
  status: 'COMPLETED' | 'FAILED' | 'INTERRUPTED' | 'CANCELLED';
  title: string;
  result: string | null;
  error: string | null;
}

export interface CreateTaskOptions {
  parentId?: string;
  /** Durable task prerequisites. A task cannot dispatch until all are COMPLETED. */
  dependencyTaskIds?: string[];
  sessionId?: string;
  workspaceOverride?: string;
  projectId?: string;
  engineOverride?: string;
  sourceKey?: string;
  conversationId?: string;
  inputMessageId?: string;
  content?: string;
  priority?: number;
  initialApprovalRequest?: string;
  /** Same-agent engine handoff is intentional; ordinary A2A delegation may
   * never target an employee already present in the ancestor chain. */
  allowAncestorAgentDelegation?: boolean;
  /** Main-process commit hook. Runs in the task transaction before any Worker starts. */
  onPersisted?: (taskId: string) => void;
  /** Project tasks require real file evidence by default; pure conversation tasks opt out explicitly. */
  requiresArtifacts?: boolean;
}

export interface ProjectArtifactCompletionValidator {
  validateTaskCompletion(input: {
    taskId: string;
    projectId: string;
    startedAt: number;
    endedAt: number;
  }): Promise<{ ok: true; manifest: ProjectArtifactManifest } | { ok: false; error: string }>;
}

const STAGES = ['理解需求', '规划步骤', '调用工具', '生成产物', '校验结果'];

const MAX_TASK_OUTPUT_EVENTS = 512;
const MAX_TASK_EVENTS_QUERY = 1000;
const MAX_TASK_RESULT_CHARS = 16_000;
const MAX_TASK_DEPENDENCIES = 128;
const OUTPUT_STATE_TTL_MS = 60_000;
const DISPATCH_PLAN_APPROVAL_TYPE = 'dispatch_plan';
const ACTIVE_TASK_STATUSES = ['QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'PAUSED'] as const;
const TERMINAL_TASK_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'] as const;
const MAX_DELEGATION_ANCESTRY = 100;

const EXPLICIT_AUTH_FAILURE_PATTERNS = [
  /^(?:error:\s*)?HTTP\s+(?:401|403)\b/i,
  /^(?:error:\s*)?(?:api|provider|model)(?:\s+request)?(?:\s+failed)?[^\r\n]{0,80}\b(?:401|403)\b/i,
  /^(?:error:\s*)?(?:api\s+)?request\s+failed\s+with\s+status(?:\s+code)?\s+(?:401|403)\b/i,
  /^Hermes\s+(?:\u6267\u884c\u5931\u8d25|execution failed)\s*[:\uff1a]\s*HTTP\s+(?:401|403)\b/i,
  /^(?:\u6a21\u578b)?\u4f9b\u5e94\u5546\u8fd4\u56de\s+HTTP\s+(?:401|403)\b/i,
  /\bmissing authentication(?:\s+header)?\b/i,
  /\bno usable credentials\b/i,
  /\b(?:invalid|expired|missing|revoked)\s+(?:api[ _-]?)?(?:key|token|credential)s?\b/i,
  /\b(?:api[ _-]?key|credential|access token)\s+(?:is\s+)?(?:invalid|expired|missing|revoked)\b/i,
  /^(?:error:\s*)?(?:unauthorized|forbidden)\b/i,
  /(?:\u6a21\u578b\u4f9b\u5e94\u5546|API|Provider).{0,24}(?:\u9274\u6743\u5931\u8d25|\u51ed\u636e\u65e0\u6548|\u51ed\u636e\u8fc7\u671f|\u672a\u6388\u6743)/i
];

/** Only trusted provider/CLI authentication diagnostics may demote an engine. */
function isExecutorAuthenticationFailure(error: string | undefined): boolean {
  if (!error) return false;
  const detail = error.trim();
  return detail.length > 0 && EXPLICIT_AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(detail));
}

function approvalScope(type: unknown): ApprovalScope {
  // `tool` was briefly used for plan approvals before scopes were explicit.
  return type === DISPATCH_PLAN_APPROVAL_TYPE || type === 'tool' ? 'dispatch_plan' : 'runtime_tool';
}

interface TaskOutputState {
  chars: number;
  events: number;
  truncated: boolean;
  closed: boolean;
}

interface CancelledTaskRecord {
  id: string;
  agentId: string;
  title: string;
  error: string;
}

interface TaskDependencyGate {
  ready: boolean;
  pending: string[];
  failed: string[];
}

export class Orchestrator {
  private listeners = new Set<() => void>();
  /** 任务输出流式订阅（推送到渲染进程逐字显示） */
  private outputListeners = new Set<(taskId: string, chunk: string) => void>();
  /** Per-task output budget. Prevents a verbose CLI from filling SQLite and
   * the renderer with one event per token forever. */
  private outputStates = new Map<string, TaskOutputState>();
  /** Resume requests made while an aborted ACP child is still closing. */
  private resumeAfterRelease = new Set<string>();
  /** 任务终态订阅（webhook、canonical conversation 等）。 */
  private finishListeners = new Set<(info: TaskFinishedInfo) => void>();
  private schedulerTimer: NodeJS.Timeout | null = null;
  private lastEmit = 0;
  private emitTimer: NodeJS.Timeout | null = null;
  /** Prevent recursive cross-agent wakeups from re-entering one FIFO queue. */
  private schedulingAgents = new Set<string>();
  /** Executor completion can wait for asynchronous project artifact hashing. */
  private finalizingTasks = new Set<string>();
  /** 调度保护门禁（由 main 注入，基于资源监控）：返回非空字符串 = 阻止派发的原因 */
  private dispatchGuard: () => string | null = () => null;
  private projectWorkspaceResolver: ((projectId: string) => string | null) | null = null;
  private projectArtifactCompletionValidator: ProjectArtifactCompletionValidator | null = null;
  private mobileDispatchPolicy: {
    canDispatch(agentId: string): { bound: boolean; ready: boolean; reason: string };
    releaseAgent?(agentId: string): void;
  } | null = null;

  constructor(private db: Database, private executors: ExecutorRegistry, private broker: ApprovalBroker) {
    this.broker.setStateController?.({
      request: (request, approvalId, now) => this.requestRuntimeApproval(request, approvalId, now),
      abandon: (taskId, approvalId, now) => this.abandonRuntimeApproval(taskId, approvalId, now)
    });
  }

  /** Production injects the Main-approved project directory resolver. */
  setProjectWorkspaceResolver(resolver: (projectId: string) => string | null): void {
    this.projectWorkspaceResolver = resolver;
  }

  setProjectArtifactCompletionValidator(validator: ProjectArtifactCompletionValidator): void {
    this.projectArtifactCompletionValidator = validator;
  }

  private resolveProjectWorkspace(projectId: string | null, requested?: string): string | null {
    if (!projectId) return requested?.trim() || null;
    if (!this.projectWorkspaceResolver) return requested?.trim() || null;
    const workspace = this.projectWorkspaceResolver(projectId)?.trim() ?? '';
    if (!workspace) throw new Error('请先为项目选择工作目录，再开始执行');
    return workspace;
  }

  private requestRuntimeApproval(req: ApprovalRequest, approvalId: string, now: number): void {
    this.db.transaction(() => {
      const task = this.db.raw.prepare('SELECT agent_id, status FROM tasks WHERE id = ?').get(req.taskId) as
        | { agent_id: string; status: TaskStatus }
        | undefined;
      if (!task || task.agent_id !== req.agentId || task.status !== 'RUNNING') {
        throw new Error('runtime approval requires a running task owned by the requesting agent');
      }
      this.db.raw.prepare(
        'INSERT INTO approvals(id, task_id, agent_id, type, request, risk, status, created_at, decided_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, NULL)'
      ).run(approvalId, req.taskId, req.agentId, req.type, req.request, req.risk, 'pending', now);
      const changed = this.db.raw.prepare(
        "UPDATE tasks SET status = 'WAITING_APPROVAL' WHERE id = ? AND status = 'RUNNING'"
      ).run(req.taskId).changes;
      if (changed !== 1) throw new Error('runtime approval task transition conflicted');
      this.recordEvent(req.taskId, 'approval_required', {
        approvalId,
        scope: 'runtime_tool',
        request: req.request,
        risk: req.risk
      }, now);
    });
  }

  private abandonRuntimeApproval(taskId: string, approvalId: string, now: number): void {
    this.db.transaction(() => {
      const changed = this.db.raw.prepare(
        "UPDATE approvals SET status = 'rejected', decided_at = ? WHERE id = ? AND task_id = ? AND status = 'pending'"
      ).run(now, approvalId, taskId).changes;
      if (changed > 0) {
        this.recordEvent(taskId, 'approval_decided', {
          approvalId,
          scope: 'runtime_tool',
          approved: false,
          reason: 'task_abandoned'
        }, now);
      }
    });
  }

  setDispatchGuard(fn: () => string | null) {
    this.dispatchGuard = fn;
  }

  setMobileDispatchPolicy(policy: {
    canDispatch(agentId: string): { bound: boolean; ready: boolean; reason: string };
    releaseAgent?(agentId: string): void;
  }) {
    this.mobileDispatchPolicy = policy;
  }

  private delegationOrganization(parentTaskId: string): string | null {
    const parent = this.db.raw.prepare(
      'SELECT agent_id FROM tasks WHERE id = ? AND deleted_at IS NULL'
    ).get(parentTaskId) as { agent_id: string } | undefined;
    if (!parent) return null;
    const owner = this.db.raw.prepare(
      'SELECT organization_id, archived FROM agents WHERE id = ?'
    ).get(parent.agent_id) as { organization_id: string | null; archived: number } | undefined;
    if (!owner || owner.archived !== 0) return null;
    const organizationId = owner?.organization_id?.trim() ?? '';
    return organizationId || null;
  }

  private agentOrganization(agentId: string): string | null {
    const row = this.db.raw.prepare(
      'SELECT organization_id FROM agents WHERE id = ?'
    ).get(agentId) as { organization_id: string | null } | undefined;
    const organizationId = row?.organization_id?.trim() ?? '';
    return organizationId || null;
  }

  private parentTaskAssociation(parentTaskId: string): { organizationId: string; projectId: string | null } | null {
    const parent = this.db.raw.prepare(
      'SELECT agent_id, project_id FROM tasks WHERE id = ? AND deleted_at IS NULL'
    ).get(parentTaskId) as { agent_id: string; project_id: string | null } | undefined;
    if (!parent) return null;
    const organizationId = this.agentOrganization(parent.agent_id);
    return organizationId ? { organizationId, projectId: parent.project_id ?? null } : null;
  }

  /** Resolve inherited project ownership and enforce the task tenant boundary. */
  private resolveTaskProject(agentId: string, parentTaskId?: string, requestedProjectId?: string): string | null {
    const organizationId = this.agentOrganization(agentId);
    if (!organizationId) throw new Error('\u5458\u5de5\u4e0d\u5b58\u5728');

    const parent = parentTaskId ? this.parentTaskAssociation(parentTaskId) : null;
    if (parentTaskId && (!parent || parent.organizationId !== organizationId)) {
      throw new Error('\u7236\u4efb\u52a1\u4e0d\u5b58\u5728\u6216\u4e0d\u53ef\u5173\u8054');
    }

    const projectId = requestedProjectId ?? parent?.projectId ?? null;
    if (!projectId) return null;
    const project = this.db.raw.prepare(
      "SELECT id, organization_id FROM projects WHERE id = ? AND status != 'archived'"
    ).get(projectId) as { id: string; organization_id: string | null } | undefined;
    if (!project || project.organization_id?.trim() !== organizationId) {
      throw new Error('\u9879\u76ee\u4e0d\u5b58\u5728\u6216\u5df2\u5f52\u6863');
    }
    return projectId;
  }

  private assertDelegationTarget(parentTaskId: string, targetAgentId: string, allowCurrentAgent = false): void {
    const parent = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(parentTaskId) as Row | undefined;
    if (!parent) throw new Error('父任务不存在，或目标员工不可委派');

    // A task that has already left the live state machine cannot create new
    // work. This closes the race where cancellation wins after lookup but
    // before the delegated INSERT transaction.
    if (!ACTIVE_TASK_STATUSES.includes(parent.status as typeof ACTIVE_TASK_STATUSES[number])) {
      throw new Error('父任务已经结束，不能继续委派');
    }
    // Validate the existing parent chain before accepting another edge. The
    // normal INSERT path always creates a fresh UUID, but this guard protects
    // against imported/corrupted rows and makes cycle failures explicit.
    const seen = new Set<string>();
    let current: Row | undefined = parent;
    let depth = 0;
    while (current) {
      const currentId = String(current.id ?? '');
      if (!currentId || seen.has(currentId)) {
        throw new Error('父任务祖先链存在循环，无法委派');
      }
      seen.add(currentId);
      const isImmediateParent = currentId === parentTaskId;
      if (current.agent_id === targetAgentId && !(allowCurrentAgent && isImmediateParent)) {
        throw new Error('委派目标已出现在祖先任务链中，不能形成员工循环委派');
      }
      depth += 1;
      if (depth > MAX_DELEGATION_ANCESTRY) {
        throw new Error('父任务祖先链过深或存在循环，无法委派');
      }
      // parent_id also links independent desktop follow-ups/retries. Only a
      // consecutive delegated edge represents an active wait relationship.
      if (current.source !== 'delegated') break;
      const ancestorId = typeof current.parent_id === 'string' && current.parent_id.length > 0
        ? current.parent_id
        : null;
      if (!ancestorId) break;
      current = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(ancestorId) as Row | undefined;
      if (!current) throw new Error('父任务祖先链无效，无法委派');
    }
    if (!this.delegationChainIsLive(parent)) {
      throw new Error('父任务的委派祖先已经结束，不能继续委派');
    }

    const organizationId = this.delegationOrganization(parentTaskId);
    const target = organizationId
      ? this.db.raw.prepare(
          "SELECT id FROM agents WHERE id = ? AND organization_id = ? AND archived = 0 AND lifecycle = 'READY'"
        ).get(targetAgentId, organizationId) as { id: string } | undefined
      : undefined;
    if (!target) throw new Error('父任务不存在，或目标员工不可委派');
  }

  /** A delegated task is runnable only while every delegated parent edge
   * leads to a live task. Desktop follow-ups deliberately terminate the walk. */
  private delegationChainIsLive(task: Row): boolean {
    const seen = new Set<string>();
    let current: Row | undefined = task;
    while (current?.source === 'delegated') {
      const currentId = String(current.id ?? '');
      const parentId = typeof current.parent_id === 'string' && current.parent_id.length > 0
        ? current.parent_id
        : null;
      if (!currentId || !parentId || seen.has(currentId) || seen.has(parentId)) return false;
      seen.add(currentId);
      const parent = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(parentId) as Row | undefined;
      if (!parent || !ACTIVE_TASK_STATUSES.includes(parent.status as typeof ACTIVE_TASK_STATUSES[number])) return false;
      current = parent;
    }
    return true;
  }

  private queuedDelegations(): { id: string; parent_id: string; agent_id: string }[] {
    return this.db.raw.prepare(
      "SELECT id, parent_id, agent_id FROM tasks WHERE source = 'delegated' AND status = 'QUEUED' AND deleted_at IS NULL"
    ).all() as { id: string; parent_id: string; agent_id: string }[];
  }

  private activeDelegations(): Row[] {
    return this.db.raw.prepare(
      "SELECT * FROM tasks WHERE source = 'delegated' AND status IN ('QUEUED','RUNNING','WAITING_APPROVAL','PAUSED') AND deleted_at IS NULL"
    ).all() as Row[];
  }

  /** Find delegated work that must be abandoned when its parent tree is being
   * interrupted. This includes running/approval/paused children, not only the
   * queued rows that the FIFO scheduler could otherwise start later. */
  private recoveryDelegationIds(interruptedIds: ReadonlySet<string>): Set<string> {
    const result = new Set<string>();
    for (const child of this.activeDelegations()) {
      const seen = new Set<string>();
      let parentId = typeof child.parent_id === 'string' && child.parent_id.length > 0 ? child.parent_id : null;
      while (parentId) {
        if (interruptedIds.has(parentId)) {
          result.add(String(child.id));
          break;
        }
        if (seen.has(parentId)) {
          result.add(String(child.id));
          break;
        }
        seen.add(parentId);
        const parent = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(parentId) as Row | undefined;
        if (!parent || !ACTIVE_TASK_STATUSES.includes(parent.status as typeof ACTIVE_TASK_STATUSES[number])) {
          result.add(String(child.id));
          break;
        }
        if (parent.source !== 'delegated') break;
        parentId = typeof parent.parent_id === 'string' && parent.parent_id.length > 0 ? parent.parent_id : null;
      }
    }
    return result;
  }

  private activeTaskOccupants(): { id: string; agent_id: string; status: TaskStatus }[] {
    return this.db.raw.prepare(
      "SELECT id, agent_id, status FROM tasks WHERE status IN ('RUNNING','PAUSED') AND deleted_at IS NULL"
    ).all() as { id: string; agent_id: string; status: TaskStatus }[];
  }

  /**
   * Reject a newly queued delegation only when the wait cycle is a hard
   * deadlock. An employee-level cycle is not sufficient with concurrency > 1:
   * another active task may finish and release a slot. Every slot on every
   * employee in the cycle must be occupied by a task whose queued children all
   * remain inside that same cycle.
   */
  private assertNoDelegationWaitCycle(parentTaskId: string, targetAgentId: string): void {
    const parent = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(parentTaskId) as Row | undefined;
    if (!parent) throw new Error('父任务不存在，无法检查委派等待关系');
    const parentAgentId = String(parent.agent_id ?? '');
    const graph = new Map<string, Set<string>>();
    const queuedByParent = new Map<string, Set<string>>();
    for (const edge of this.queuedDelegations()) {
      const edgeParent = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(edge.parent_id) as Row | undefined;
      if (!edgeParent
        || !ACTIVE_TASK_STATUSES.includes(edgeParent.status as typeof ACTIVE_TASK_STATUSES[number])
        || !this.delegationChainIsLive(edgeParent)) continue;
      const from = String(edgeParent.agent_id ?? '');
      const to = String(edge.agent_id ?? '');
      if (!from || !to) continue;
      const outgoing = queuedByParent.get(edge.parent_id) ?? new Set<string>();
      outgoing.add(to);
      queuedByParent.set(edge.parent_id, outgoing);
      const targets = graph.get(from) ?? new Set<string>();
      targets.add(to);
      graph.set(from, targets);
    }

    // The edge being inserted is not visible in queuedDelegations() yet.
    const pendingOutgoing = queuedByParent.get(parentTaskId) ?? new Set<string>();
    pendingOutgoing.add(targetAgentId);
    queuedByParent.set(parentTaskId, pendingOutgoing);
    const parentTargets = graph.get(parentAgentId) ?? new Set<string>();
    parentTargets.add(targetAgentId);
    graph.set(parentAgentId, parentTargets);

    const findPath = (current: string, target: string, visited: Set<string>): string[] | null => {
      if (current === target) return [current];
      if (visited.has(current)) return null;
      visited.add(current);
      for (const next of graph.get(current) ?? []) {
        const tail = findPath(next, target, visited);
        if (tail) return [current, ...tail];
      }
      return null;
    };
    const cyclePath = findPath(targetAgentId, parentAgentId, new Set<string>());
    if (!cyclePath) return;
    const cycleAgents = new Set(cyclePath);
    const occupants = this.activeTaskOccupants();
    const occupantsByAgent = new Map<string, typeof occupants>();
    for (const task of occupants) {
      const list = occupantsByAgent.get(task.agent_id) ?? [];
      list.push(task);
      occupantsByAgent.set(task.agent_id, list);
    }
    for (const agentId of cycleAgents) {
      const agent = this.getAgent(agentId);
      const limit = Math.max(1, agent?.concurrencyLimit ?? 1);
      if (this.agentOccupancy(agentId) < limit) return;
      const blocked = (occupantsByAgent.get(agentId) ?? []).filter((task) => {
        const targets = queuedByParent.get(task.id);
        return Boolean(targets && targets.size > 0 && [...targets].every((target) => cycleAgents.has(target)));
      }).length;
      if (blocked < limit) return;
    }
    throw new Error('委派等待关系会形成员工循环，子任务无法取得执行槽');
  }

  /**
   * Check whether a child assigned to an employee can acquire a slot while
   * its parent is still executing. In particular, coding delegation keeps the
   * same employee and otherwise self-deadlocks at concurrency=1.
   */
  private delegationCapacity(agentId: string, parentTaskId: string): {
    available: boolean;
    active: number;
    limit: number;
    reason?: string;
  } {
    const parent = this.db.raw.prepare('SELECT agent_id, status FROM tasks WHERE id = ? AND deleted_at IS NULL').get(parentTaskId) as
      { agent_id: string; status: TaskStatus } | undefined;
    const agent = this.getAgent(agentId);
    if (!parent) {
      return { available: false, active: 0, limit: 0, reason: '父任务不存在，无法创建编码委派' };
    }
    if (parent.agent_id !== agentId) {
      return { available: false, active: 0, limit: 0, reason: '编码委派必须保留父任务的员工归属，只能覆盖执行引擎' };
    }
    if (!ACTIVE_TASK_STATUSES.includes(parent.status as typeof ACTIVE_TASK_STATUSES[number])) {
      return { available: false, active: 0, limit: 0, reason: '父任务已经结束，不能创建编码委派' };
    }
    if (!agent || agent.archived || agent.lifecycle !== 'READY') {
      return { available: false, active: 0, limit: 0, reason: '父任务员工当前不可用，无法创建编码委派' };
    }
    const limit = Math.max(1, agent.concurrencyLimit);
    const active = this.agentOccupancy(agentId);
    if (active >= limit) {
      return {
        available: false,
        active,
        limit,
        reason: `当前员工「${agent.name}」并发槽已占满（${active}/${limit}），编码委派会等待父任务释放自身槽位而自锁；请提高并发上限，或改用 delegate_task 委派给其他员工`
      };
    }
    return { available: true, active, limit };
  }

  /** delegate_task 工具的编排能力（P3b A2A 内部委派） */
  toolHost(): ToolHost {
    return {
      findAgentIdByName: (name, parentTaskId) => {
        // 名称解析与父任务同租户；创建时还会在写事务内二次校验。
        const organizationId = this.delegationOrganization(parentTaskId);
        if (!organizationId) return null;
        const r = this.db.raw.prepare(
          "SELECT id FROM agents WHERE name = ? AND organization_id = ? AND archived = 0 AND lifecycle = 'READY'"
        ).get(name, organizationId) as { id: string } | undefined;
        return r?.id ?? null;
      },
      createDelegatedTask: (agentId, title, parentTaskId) => this.createTask(agentId, title, 'delegated', { parentId: parentTaskId }),
      // E-2 编码委派：员工归属不变，仅把执行引擎覆盖为编码引擎
      createEngineDelegatedTask: (agentId, title, parentTaskId, engineId) => {
        const capacity = this.delegationCapacity(agentId, parentTaskId);
        if (!capacity.available) throw new Error(capacity.reason ?? '当前无法创建编码委派');
        // codingEngineReady is a UI/tool-registration hint; the durable
        // creation boundary must recheck because engine state can change
        // between discovery and invocation.
        const engine = this.db.raw.prepare('SELECT status FROM engines WHERE id = ?').get(engineId) as { status: string } | undefined;
        if (engine?.status !== 'HEALTHY') throw new Error('编码委派目标引擎不存在或当前不可用');
        return this.createTask(agentId, title, 'delegated', {
          parentId: parentTaskId,
          engineOverride: engineId,
          allowAncestorAgentDelegation: true
        });
      },
      delegationCapacity: (agentId, parentTaskId) => this.delegationCapacity(agentId, parentTaskId),
      codingEngineReady: () => {
        const engineId = 'eng-opencode';
        const row = this.db.raw.prepare('SELECT name, status FROM engines WHERE id = ?').get(engineId) as { name: string; status: string } | undefined;
        return { ready: row?.status === 'HEALTHY', engineId, name: row?.name ?? 'OpenCode' };
      },
      cancelTask: (taskId, reason) => this.cancelTask(taskId, reason),
      waitForTask: (taskId, timeoutMs, parentTaskId) => this.waitForTask(taskId, timeoutMs, parentTaskId),
      delegationDepth: (taskId) => {
        let depth = 0;
        let cur: string | null = taskId;
        const seen = new Set<string>();
        while (cur) {
          if (seen.has(cur)) throw new Error('父任务祖先链存在循环，无法委派');
          seen.add(cur);
          const r = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(cur) as Row | undefined;
          if (!r || r.source !== 'delegated' || typeof r.parent_id !== 'string' || !r.parent_id) break;
          depth++;
          if (depth > MAX_DELEGATION_ANCESTRY) throw new Error('父任务祖先链过深或存在循环，无法委派');
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
  onTaskFinished(fn: (info: TaskFinishedInfo) => void): () => void {
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

  /** 崩溃恢复：保留尚未执行的计划审批；其余无主运行态中断并关闭运行时审批。 */
  recoverAfterRestart() {
    const active = this.db.raw.prepare("SELECT id, status FROM tasks WHERE status IN ('RUNNING','WAITING_APPROVAL','PAUSED')").all() as { id: string; status: TaskStatus }[];
    const pendingApprovals = active.length > 0
      ? this.db.raw.prepare("SELECT * FROM approvals WHERE status = 'pending'").all() as Row[]
      : [];
    const durablePlanTasks = new Set(
      pendingApprovals
        .filter((approval) => approvalScope(approval.type) === 'dispatch_plan')
        .map((approval) => approval.task_id as string)
    );
    const interruptedCandidates = active.filter((task) =>
      task.status !== 'WAITING_APPROVAL' || !durablePlanTasks.has(task.id)
    );
    const recoveryDelegationIds = this.recoveryDelegationIds(new Set(interruptedCandidates.map((task) => task.id)));
    // Delegated descendants are abandoned as CANCELLED. A delegated row may
    // itself appear in the active scan; remove it from the INTERRUPTED set so
    // one task receives one terminal transition and one finish notification.
    const interrupted = interruptedCandidates.filter((task) => !recoveryDelegationIds.has(task.id));
    const now = Date.now();
    const cancelled: CancelledTaskRecord[] = [];
    if (interrupted.length > 0 || recoveryDelegationIds.size > 0) {
      this.db.transaction(() => {
        for (const t of interrupted) {
          this.db.raw.prepare("UPDATE tasks SET status = 'INTERRUPTED', ended_at = ?, error = '客户端异常退出，任务中断' WHERE id = ?").run(now, t.id);
          this.db.raw.prepare("UPDATE agent_runs SET ended_at = ?, status = 'INTERRUPTED' WHERE task_id = ? AND ended_at IS NULL").run(now, t.id);
          // Mobile leases live in SQLite, while the gateway's in-memory token
          // map cannot survive a process restart. Close the lease together with
          // the interrupted task so a reconnect is not blocked by stale state.
          this.db.raw.prepare(
            "UPDATE mobile_control_sessions SET status = 'disconnected', ended_at = COALESCE(ended_at, ?) WHERE task_id = ? AND status = 'active'"
          ).run(now, t.id);
          this.recordEvent(t.id, 'interrupted', { reason: 'app-restart' }, now);
          for (const approval of pendingApprovals.filter((item) => item.task_id === t.id)) {
            this.db.raw.prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run('rejected', now, approval.id as string);
            this.recordEvent(t.id, 'approval_decided', {
              approvalId: approval.id,
              scope: approvalScope(approval.type),
              approved: false,
              reason: 'runtime_interrupted_on_restart'
            }, now);
          }
        }
        for (const taskId of recoveryDelegationIds) {
          const row = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(taskId) as Row | undefined;
          if (!row || !ACTIVE_TASK_STATUSES.includes(row.status as typeof ACTIVE_TASK_STATUSES[number])) continue;
          const error = '上级委派在应用重启前已结束，委派已取消';
          if (!this.cancelTaskInternal(taskId, now, error)) continue;
          this.db.raw.prepare(
            "UPDATE mobile_control_sessions SET status = 'disconnected', ended_at = COALESCE(ended_at, ?) WHERE task_id = ? AND status = 'active'"
          ).run(now, taskId);
          cancelled.push({
            id: taskId,
            agentId: String(row.agent_id),
            title: String(row.title ?? taskId),
            error
          });
        }
      });
      this.releaseCancelledTasks(cancelled);
    }

    for (const task of interrupted) this.settleTaskDependents(task.id, 'INTERRUPTED', '前置任务在应用重启时中断');
    for (const task of cancelled) this.settleTaskDependents(task.id, 'CANCELLED', task.error);

    if (interrupted.length === 0 && cancelled.length === 0) return;
    this.notifyCancelledTasks(cancelled);
    for (const task of interrupted) {
      const row = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Row | undefined;
      if (!row) continue;
      for (const fn of this.finishListeners) {
        try {
          fn({
            taskId: task.id,
            agentId: String(row.agent_id),
            status: 'INTERRUPTED',
            title: String(row.title ?? task.id),
            result: null,
            error: String(row.error ?? '客户端异常退出，任务中断')
          });
        } catch { /* 通知失败不影响恢复 */ }
      }
    }
    if (interrupted.length > 0) {
      this.db.audit({ id: randomUUID(), actor: 'system', action: 'recovery.markInterrupted', target: `${interrupted.length} tasks`, result: 'ok' });
    }
    if (cancelled.length > 0) {
      this.db.audit({ id: randomUUID(), actor: 'system', action: 'recovery.cancelOrphanedDelegations', target: `${cancelled.length} tasks`, result: 'ok' });
    }
    this.emit();
  }

  /** 执行调度器：接管数据库中 RUNNING 但无执行器在跑的任务，并执行长任务看门狗。 */
  startScheduler() {
    this.adoptRunningTasks();
    if (this.schedulerTimer) return;
    this.schedulerTimer = setInterval(() => {
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
      this.settleTaskDependents(t.id, 'INTERRUPTED', `前置任务 ${t.id} 看门狗中断`);
      this.scheduleNext(t.agent_id);
    }
  }

  /** 启动接管：把无主 RUNNING 任务交给真实执行器。 */
  private adoptRunningTasks() {
    const rows = this.db.raw.prepare("SELECT * FROM tasks WHERE status = 'RUNNING' ORDER BY created_at").all() as Row[];
    for (const r of rows) {
      const task = this.mapTask(r);
      if (this.executors.isExecuting(task.id)) continue;
      const agent = this.getAgent(task.agentId);
      if (agent && agent.lifecycle === 'READY') this.dispatchTask(task, agent);
    }
  }

  // ---------- 查询 ----------

  private mapAgent(r: Row): Agent {
    let capabilities = { network: false, shell: false, install: false, browser: false, computer: false, mobile: false };
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
      kind: ((r.agent_kind as string) || 'general') as Agent['kind'],
      systemPrompt: r.system_prompt as string,
      soulMd: (r.soul_md as string) ?? '', agentsMd: (r.agents_md as string) ?? '', userMd: (r.user_md as string) ?? '',
      lifecycle: r.lifecycle as Agent['lifecycle'],
      engineId: r.engine_id as string, workspace: r.workspace as string,
      permissionMode: r.permission_mode as Agent['permissionMode'],
      memoryMode: (['long_term', 'short_term', 'none'].includes(String(r.memory_mode))
        ? r.memory_mode
        : 'short_term') as Agent['memoryMode'],
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
      conversationId: (r.conversation_id as string | null) ?? null,
      inputMessageId: (r.input_message_id as string | null) ?? null,
      content: ((r.content as string | null) || (r.title as string)),
      source: r.source as Task['source'], parentId: r.parent_id as string | null,
      status: r.status as TaskStatus, priority: r.priority as number, progress: r.progress as number,
      stage: r.stage as string, error: r.error as string | null, result: (r.result as string | null) ?? null,
      hasResult: typeof r.has_result === 'number'
        ? (r.has_result as number) === 1
        : Boolean((r.result as string | null | undefined)?.trim()),
      quality: (r.quality as TaskQuality) ?? null,
      sessionId: (r.session_id as string | null) ?? null,
      workspaceOverride: (r.workspace_override as string | null) ?? null,
      requiresArtifacts: Number(r.artifacts_required ?? 0) === 1,
      engineOverride: (r.engine_override as string | null) ?? null,
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
    // Read the newest bounded window and restore chronological order. A task
    // can legitimately have many tool/progress events, but the UI must never
    // receive an unbounded history in one IPC response.
    const rows = this.db.raw
      .prepare(`SELECT id, task_id, event_type,
        CASE WHEN event_type = 'result' THEN '{}' ELSE payload END AS payload,
        created_at
        FROM task_events WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(taskId, MAX_TASK_EVENTS_QUERY) as Row[];
    return rows.reverse().map((r) => ({
      id: r.id as string,
      taskId: r.task_id as string,
      eventType: r.event_type as string,
      payload: (() => {
        try { return JSON.parse((r.payload as string) || '{}') as Record<string, unknown>; }
        catch { return { error: '事件数据损坏' }; }
      })(),
      createdAt: r.created_at as number
    }));
  }

  /** 任务产物全文（tasks.result，截断 16KB） */
  taskResult(taskId: string): string | null {
    const r = this.db.raw.prepare('SELECT result FROM tasks WHERE id = ?').get(taskId) as { result: string | null } | undefined;
    return typeof r?.result === 'string' ? r.result.slice(0, MAX_TASK_RESULT_CHARS) : null;
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

  checkpointAgentCreation(input: CreateAgentInput): AgentCreationCheckpoint {
    const existing = this.db.raw.prepare('SELECT * FROM agents WHERE name = ?').get(input.name) as Row | undefined;
    const safeName = input.name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 30);
    const autoWorkspacePath = !existing && !input.workspace
      ? join(app.getPath('userData'), 'aibox-data', 'workspaces', safeName)
      : null;
    return {
      existing: existing ? { ...existing } : null,
      autoWorkspacePath,
      autoWorkspaceExisted: autoWorkspacePath ? existsSync(autoWorkspacePath) : false
    };
  }

  rollbackAgentCreation(checkpoint: AgentCreationCheckpoint, agentId: string): void {
    if (checkpoint.existing) {
      const columns = Object.keys(checkpoint.existing).filter((column) => column !== 'id');
      const assignments = columns.map((column) => `${column} = ?`).join(', ');
      this.db.raw.prepare(`UPDATE agents SET ${assignments} WHERE id = ?`)
        .run(...columns.map((column) => checkpoint.existing![column] as string | number | null), checkpoint.existing.id as string);
      this.db.audit({ id: randomUUID(), actor: 'system', action: 'agent.create.rollback', target: agentId, result: 'restored-existing' });
      this.emit();
      return;
    }
    this.discardNewAgent(agentId);
    const workspace = checkpoint.autoWorkspacePath;
    if (workspace && !checkpoint.autoWorkspaceExisted && existsSync(workspace) && readdirSync(workspace).length === 0) {
      rmdirSync(workspace);
    }
  }

  discardNewAgent(id: string): void {
    const activeTasks = (this.db.raw.prepare('SELECT COUNT(*) AS count FROM tasks WHERE agent_id = ?').get(id) as { count: number } | undefined)?.count ?? 0;
    if (activeTasks > 0) throw new Error('Cannot discard an agent after tasks have been created');
    this.db.transaction(() => {
      this.db.raw.prepare('DELETE FROM channel_routes WHERE agent_id = ?').run(id);
      this.db.raw.prepare('DELETE FROM agent_skills WHERE agent_id = ?').run(id);
      this.db.raw.prepare('DELETE FROM mobile_agent_configs WHERE agent_id = ?').run(id);
      this.db.raw.prepare('DELETE FROM agents WHERE id = ?').run(id);
    });
    this.db.audit({ id: randomUUID(), actor: 'system', action: 'agent.create.rollback', target: id, result: 'profile-failed' });
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
    if (patch.memoryMode !== undefined) {
      if (!['long_term', 'short_term', 'none'].includes(patch.memoryMode)) throw new Error('员工记忆策略无效');
      fields.push('memory_mode = ?'); values.push(patch.memoryMode);
    }
    const nextKind = patch.kind ?? agent.kind;
    const nextEngineId = patch.kind === 'android_operator'
      ? ANDROID_OPERATOR_ENGINE_ID
      : patch.engineId ?? agent.engineId;
    assertAndroidOperatorEngine(nextKind, nextEngineId);
    if (patch.kind !== undefined) {
      fields.push('agent_kind = ?'); values.push(patch.kind);
      fields.push('engine_id = ?'); values.push(nextEngineId);
      fields.push('concurrency_limit = ?'); values.push(patch.kind === 'android_operator' ? 1 : agent.concurrencyLimit);
    }
    if (patch.capabilities !== undefined || patch.kind !== undefined) {
      const merged = { ...agent.capabilities, ...patch.capabilities };
      if (nextKind === 'android_operator') Object.assign(merged, { network: false, shell: false, install: false, browser: false, computer: false, mobile: true });
      else merged.mobile = false;
      fields.push('capabilities_json = ?'); values.push(JSON.stringify(merged));
    }
    if (patch.tags !== undefined) { fields.push('tags_json = ?'); values.push(JSON.stringify(patch.tags)); }
    if (patch.modelOverrides !== undefined) { fields.push('model_overrides_json = ?'); values.push(JSON.stringify(patch.modelOverrides)); }
    if (patch.engineId !== undefined && patch.kind === undefined) {
      fields.push('engine_id = ?'); values.push(patch.engineId);
    }
    if (patch.modelOverride !== undefined) { fields.push('model_override = ?'); values.push(patch.modelOverride || ''); }
    if (fields.length === 0) return agent;
    fields.push('updated_at = ?'); values.push(Date.now());
    values.push(id);
    this.db.raw.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    if (agent.kind === 'android_operator' && nextKind === 'general') {
      this.mobileDispatchPolicy?.releaseAgent?.(id);
    }
    this.emit();
    return this.getAgent(id)!;
  }

  // ---------- 会话（持续多轮对话） ----------

  listConversations(agentId: string): import('../../shared/types.js').Conversation[] {
    return (this.db.raw.prepare('SELECT * FROM conversations WHERE agent_id = ? AND channel_id IS NULL ORDER BY last_message_at DESC LIMIT 50').all(agentId) as Row[]).map((r) => ({
      id: r.id as string, agentId: r.agent_id as string, title: r.title as string,
      projectId: (r.project_id as string | null) ?? null,
      organizationId: (r.organization_id as string | null) ?? null,
      principalId: (r.principal_id as string | null) ?? null,
      channelId: (r.channel_id as string | null) ?? null,
      channelIdentityId: (r.channel_identity_id as string | null) ?? null,
      externalConversationKey: (r.external_conversation_key as string | null) ?? null,
      lastMessageAt: r.last_message_at as number, messageCount: r.message_count as number,
      createdAt: (r.created_at as number | null) ?? null,
      updatedAt: (r.updated_at as number | null) ?? null
    }));
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

  listTasks(options: { includeResult?: boolean } = {}): Task[] {
    const select = options.includeResult === false
      ? `id, agent_id, project_id, conversation_id, input_message_id, title, content,
         source, parent_id, status, priority, progress, stage, error,
         NULL AS result, CASE WHEN result IS NOT NULL AND LENGTH(TRIM(result)) > 0 THEN 1 ELSE 0 END AS has_result,
         quality, session_id, workspace_override, engine_override, artifacts_required, created_at, started_at, ended_at`
      : '*';
    return (this.db.raw.prepare(`SELECT ${select} FROM tasks WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 200`).all() as Row[])
      .map((r) => this.mapTask(r));
  }

  listApprovals(): Approval[] {
    const rows = this.db.raw.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC").all() as Row[];
    return rows.map((r) => ({
      id: r.id as string, taskId: r.task_id as string, agentId: r.agent_id as string,
      scope: approvalScope(r.type),
      type: (r.type === 'tool' ? DISPATCH_PLAN_APPROVAL_TYPE : r.type) as Approval['type'],
      request: r.request as string, risk: r.risk as Approval['risk'],
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
    const engineRows = this.db.raw.prepare('SELECT id, name, status FROM engines').all() as {
      id: string; name: string; status: EngineStatus;
    }[];
    const engineNames = new Map(engineRows.map((engine) => [engine.id, engine.name]));
    const engineStatuses = new Map(engineRows.map((engine) => [engine.id, engine.status]));
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
      const engineStatus = engineStatuses.get(agent.engineId) ?? 'NOT_INSTALLED';
      const since = runSince.get(agent.id);
      const agentMcp = mcpRows.filter((m) => m.scope === agent.id).map((m) => m.name);
      return {
        agent,
        derivedStatus: derived,
        engineStatus,
        currentTask: task
          ? { id: task.id, title: task.title, progress: task.progress, stage: task.stage, executor: this.executors.kindFor(agent.engineId) }
          : null,
        uptimeText: since ? formatDuration(Date.now() - since) : '',
        channels: [...(channelsByAgent.get(agent.id) ?? [])] as AgentCardView['channels'],
        engineName: ownerFacingEngineName(agent.engineId, engineNames.get(agent.engineId)),
        modelName: modelByAgent.get(agent.id) ?? '',
        needsAttention: derived === 'error' || engineStatus !== 'HEALTHY' || task?.status === 'WAITING_APPROVAL',
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
    s.activeTasks = (this.db.raw.prepare("SELECT COUNT(*) c FROM tasks WHERE is_demo = 0 AND status IN ('RUNNING','QUEUED','WAITING_APPROVAL','PAUSED')").get() as { c: number }).c;
    s.pendingTodos = (this.db.raw.prepare("SELECT COUNT(*) c FROM approvals WHERE status = 'pending' AND agent_id NOT IN (SELECT id FROM agents WHERE is_demo = 1)").get() as { c: number }).c;
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    s.todayCompleted = (this.db.raw.prepare("SELECT COUNT(*) c FROM tasks WHERE is_demo = 0 AND status = 'COMPLETED' AND deleted_at IS NULL AND ended_at >= ?").get(dayStart.getTime()) as { c: number }).c;
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
    const kind = input.kind ?? 'general';
    const memoryMode = input.memoryMode ?? 'short_term';
    if (!['long_term', 'short_term', 'none'].includes(memoryMode)) throw new Error('员工记忆策略无效');
    const engineId = kind === 'android_operator' ? ANDROID_OPERATOR_ENGINE_ID : input.engineId;
    if (kind === 'android_operator' && input.concurrencyLimit !== 1) throw new Error('Android 手机操作员并发数必须为 1');
    const engine = this.db.raw.prepare("SELECT status FROM engines WHERE id = ?").get(engineId) as { status: string } | undefined;
    if (!engine || !['HEALTHY', 'SETUP_REQUIRED', 'AUTH_REQUIRED'].includes(engine.status)) {
      throw new Error('只能选择已安装或待配置的引擎（引擎就绪前不会执行任务）');
    }
    // 同名员工已存在（含已归档）：复用而非重复插入（agents.name 有 UNIQUE 约束）
    const existing = this.db.raw.prepare('SELECT id, archived FROM agents WHERE name = ?').get(input.name) as { id: string; archived: number } | undefined;
    if (existing) {
      if (existing.archived === 1) {
        // 已归档的同名员工：重新激活并更新配置
        this.db.raw.prepare(
          `UPDATE agents SET archived = 0, role = ?, system_prompt = ?, soul_md = ?, agents_md = ?, user_md = ?, engine_id = ?, permission_mode = ?, memory_mode = ?, agent_kind = ?, concurrency_limit = ?, lifecycle = 'READY', updated_at = ? WHERE id = ?`
        ).run(input.role, input.systemPrompt, input.soulMd ?? '', input.agentsMd ?? '', input.userMd ?? '', engineId, input.permissionMode, memoryMode, kind, kind === 'android_operator' ? 1 : input.concurrencyLimit, Date.now(), existing.id);
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
        `INSERT INTO agents(id, name, role, system_prompt, soul_md, agents_md, user_md, lifecycle, engine_id, workspace, permission_mode, memory_mode, concurrency_limit, archived, avatar_color, agent_kind, capabilities_json, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, 'READY', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
      ).run(
        id, input.name, input.role, input.systemPrompt, input.soulMd ?? '', input.agentsMd ?? '', input.userMd ?? '',
        engineId, workspace, input.permissionMode, memoryMode, kind === 'android_operator' ? 1 : input.concurrencyLimit, color, kind,
        JSON.stringify(kind === 'android_operator'
          ? { network: false, shell: false, install: false, browser: false, computer: false, mobile: true }
          : { network: false, shell: false, install: false, browser: false, computer: false, mobile: false }),
        now, now
      );
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
    this.scheduleNext(id);
    this.emit();
  }

  stopAgent(id: string) {
    const now = Date.now();
    const active = this.db.raw.prepare("SELECT id FROM tasks WHERE agent_id = ? AND status IN ('RUNNING','QUEUED','PAUSED','WAITING_APPROVAL')").all(id) as { id: string }[];
    const taskIds = new Set<string>();
    for (const task of active) {
      for (const descendant of this.collectTaskTree(task.id)) taskIds.add(descendant);
    }
    const cancelled = this.cancelTaskSet(
      [...taskIds],
      now,
      '数字员工已停止',
      '父任务因员工停止而取消',
      new Set(active.map((task) => task.id)),
      () => {
        this.db.raw.prepare("UPDATE agents SET lifecycle = 'DISABLED', updated_at = ? WHERE id = ?").run(now, id);
      }
    );
    this.notifyCancelledTasks(cancelled);
    this.settleCancelledTaskDependents(cancelled);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'agent.stop', target: id, result: 'ok' });
    this.emit();
    for (const agentId of new Set(cancelled.map((task) => task.agentId))) {
      if (agentId !== id) this.scheduleNext(agentId);
    }
  }

  /** Validate and normalize prerequisites before a task row is committed. */
  private normalizeDependencyTaskIds(agentId: string, taskId: string, raw: unknown): string[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) throw new Error('任务依赖必须是数组');
    if (raw.length > MAX_TASK_DEPENDENCIES) throw new Error(`任务依赖不能超过 ${MAX_TASK_DEPENDENCIES} 项`);
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const value of raw) {
      if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
        throw new Error('任务依赖 ID 无效');
      }
      if (value === taskId) throw new Error('任务不能依赖自身');
      if (seen.has(value)) throw new Error(`任务依赖重复：${value}`);
      seen.add(value);
      ids.push(value);
    }
    if (ids.length === 0) return ids;
    const targetOrg = this.db.raw.prepare('SELECT organization_id FROM agents WHERE id = ?').get(agentId) as
      { organization_id: string } | undefined;
    if (!targetOrg?.organization_id) throw new Error('任务所属组织不存在');
    for (const dependencyId of ids) {
      const dependency = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(dependencyId) as Row | undefined;
      if (!dependency) throw new Error(`任务依赖不存在或已删除：${dependencyId}`);
      const dependencyOrg = this.db.raw.prepare('SELECT organization_id FROM agents WHERE id = ?').get(String(dependency.agent_id)) as
        { organization_id: string } | undefined;
      if (!dependencyOrg?.organization_id || dependencyOrg.organization_id !== targetOrg.organization_id) {
        throw new Error(`任务依赖跨组织：${dependencyId}`);
      }
    }
    return ids;
  }

  private dependencyIds(taskId: string): string[] {
    return (this.db.raw.prepare(
      'SELECT dependency_task_id FROM task_dependencies WHERE task_id = ? ORDER BY dependency_task_id'
    ).all(taskId) as { dependency_task_id: string }[]).map((row) => String(row.dependency_task_id));
  }

  private dependencyGateForIds(ids: readonly string[]): TaskDependencyGate {
    const pending: string[] = [];
    const failed: string[] = [];
    for (const dependencyId of ids) {
      const dependency = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(dependencyId) as Row | undefined;
      // A missing prerequisite is corruption. Treat it as failed rather than
      // allowing a dependent task to run against an unknown input.
      if (!dependency) {
        failed.push(dependencyId);
        continue;
      }
      const status = dependency.status as TaskStatus;
      if (status === 'COMPLETED') continue;
      if (status === 'FAILED' || status === 'CANCELLED' || status === 'INTERRUPTED') failed.push(dependencyId);
      else pending.push(dependencyId);
    }
    return { ready: pending.length === 0 && failed.length === 0, pending, failed };
  }

  private dependencyGate(taskId: string): TaskDependencyGate {
    return this.dependencyGateForIds(this.dependencyIds(taskId));
  }

  private dependentTaskIds(taskId: string): string[] {
    return (this.db.raw.prepare(
      `SELECT td.task_id
       FROM task_dependencies td
       JOIN tasks t ON t.id = td.task_id
       WHERE td.dependency_task_id = ? AND t.deleted_at IS NULL`
    ).all(taskId) as { task_id: string }[]).map((row) => String(row.task_id));
  }

  /**
   * Recursively cancel dependents when an upstream task cannot produce its
   * contract. The transaction commits all dependency decisions before any
   * executor abort/notification is attempted.
   */
  private cascadeDependencyFailure(rootTaskId: string, reason: string, now: number): CancelledTaskRecord[] {
    const queue = [rootTaskId];
    const visited = new Set<string>();
    const cancelled: CancelledTaskRecord[] = [];
    this.db.transaction(() => {
      while (queue.length > 0) {
        const upstreamId = queue.shift()!;
        if (visited.has(upstreamId)) continue;
        visited.add(upstreamId);
        for (const dependentId of this.dependentTaskIds(upstreamId)) {
          for (const candidateId of this.collectTaskTree(dependentId)) {
            if (visited.has(candidateId)) continue;
            const row = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(candidateId) as Row | undefined;
            if (!row || !ACTIVE_TASK_STATUSES.includes(row.status as typeof ACTIVE_TASK_STATUSES[number])) continue;
            if (!this.cancelTaskInternal(candidateId, now, reason)) continue;
            this.db.raw.prepare("UPDATE tasks SET stage = '依赖失败', error = ? WHERE id = ? AND status = 'CANCELLED'")
              .run(reason, candidateId);
            cancelled.push({
              id: candidateId,
              agentId: String(row.agent_id),
              title: String(row.title ?? candidateId),
              error: reason
            });
            queue.push(candidateId);
          }
        }
      }
    });
    return cancelled;
  }

  /** Wake dependents after completion, or fail-closed and wake their queues
   * after a non-success terminal transition. */
  private settleTaskDependents(taskId: string, status: TaskStatus, reason: string): void {
    const dependentAgents = new Set<string>();
    for (const dependentId of this.dependentTaskIds(taskId)) {
      const row = this.db.raw.prepare('SELECT agent_id FROM tasks WHERE id = ? AND deleted_at IS NULL').get(dependentId) as
        { agent_id: string } | undefined;
      if (row?.agent_id) dependentAgents.add(String(row.agent_id));
    }
    if (status !== 'COMPLETED') {
      const cancelled = this.cascadeDependencyFailure(taskId, reason, Date.now());
      if (cancelled.length > 0) {
        this.releaseCancelledTasks(cancelled);
        this.notifyCancelledTasks(cancelled);
        for (const item of cancelled) dependentAgents.add(item.agentId);
      }
    }
    for (const agentId of dependentAgents) this.scheduleNext(agentId);
  }

  /** 创建任务：该员工无活跃任务且未超并发 → 立即经执行器派发；否则进入 QUEUED 等待 FIFO 调度。
   *  opts.parentId：委派/追问的父任务；opts.sessionId：继承会话锚点（P2b 追问续跑）；
   *  opts.workspaceOverride：任务级工作空间覆盖（团队共享工作空间）；
   *  opts.engineOverride：任务级引擎覆盖（E-2 编码委派，员工归属不变）；
   *  opts.sourceKey：外部来源的稳定消息 ID；重复键返回原任务并标记 deduplicated；
   *  opts.conversationId：canonical conversation 外键。 */
  createTask(agentId: string, title: string, source: Task['source'] = 'desktop', opts: CreateTaskOptions = {}): CreateTaskResult {
    const now = Date.now();
    const id = randomUUID();
    const sourceKey = opts.sourceKey?.trim() || null;
    const content = (opts.content ?? title).trim();
    if (!content) throw new Error('任务内容不能为空');
    if (content.length > 1_000_000) throw new Error('任务内容超过 1000000 字符');
    const priority = opts.priority ?? 0;
    if (!Number.isInteger(priority) || priority < -10 || priority > 10) throw new Error('任务优先级必须为 -10 到 10 的整数');
    const approvalRequest = opts.initialApprovalRequest?.trim() || null;
    if (source === 'delegated') {
      if (!opts.parentId) throw new Error('委派任务必须关联父任务');
      this.assertDelegationTarget(opts.parentId, agentId, Boolean(opts.allowAncestorAgentDelegation));
    }
    if (sourceKey) {
      const existing = this.db.raw.prepare('SELECT * FROM tasks WHERE source = ? AND source_key = ?').get(source, sourceKey) as Row | undefined;
      if (existing) {
        if (opts.onPersisted) this.db.transaction(() => opts.onPersisted?.(String(existing.id)));
        return Object.assign(this.mapTask(existing), { deduplicated: true as const });
      }
    }
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error('员工不存在');
    const dependencyTaskIds = this.normalizeDependencyTaskIds(agentId, id, opts.dependencyTaskIds);
    const dependencyGate = this.dependencyGateForIds(dependencyTaskIds);
    assertAndroidOperatorEngine(agent.kind, agent.engineId);
    const mobileState = agent.kind === 'android_operator'
      ? this.mobileDispatchPolicy?.canDispatch(agentId) ?? { bound: false, ready: false, reason: '手机控制服务尚未启动' }
      : null;
    if (mobileState && !mobileState.bound) throw new Error('Android 手机操作员尚未绑定设备');
    // 引擎路由规则（settings.engine_routing）：按任务来源指定优先引擎。
    // 显式 engineOverride（编码委派）优先级最高；路由规则仅在引擎健康时生效，
    // 避免把任务路由到未安装的引擎上。
    let engineOverride = agent.kind === 'android_operator' ? null : opts.engineOverride ?? null;
    if (agent.kind === 'general' && !engineOverride) {
      const routed = this.db.getSetting<Record<string, string>>('engine_routing', {})[source];
      if (routed && routed !== agent.engineId) {
        const row = this.db.raw.prepare('SELECT status FROM engines WHERE id = ?').get(routed) as { status: string } | undefined;
        if (row?.status === 'HEALTHY') engineOverride = routed;
      }
    }
    const projectId = this.resolveTaskProject(agentId, opts.parentId, opts.projectId);
    const workspaceOverride = this.resolveProjectWorkspace(projectId, opts.workspaceOverride);
    const requiresArtifacts = opts.requiresArtifacts ?? Boolean(projectId);
    const active = this.agentOccupancy(agentId);
    const guardReason = this.dispatchGuard();
    const canRun = dependencyGate.ready && !approvalRequest && agent.lifecycle === 'READY' && active < Math.max(1, agent.concurrencyLimit) && guardReason === null && (!mobileState || mobileState.ready);
    const queuedStage = dependencyGate.pending.length > 0
      ? `等待前置任务（${dependencyGate.pending.length}）`
      : guardReason ?? mobileState?.reason ?? '排队中';
    const dependencyError = dependencyGate.failed.length > 0
      ? `前置任务未成功完成，已阻止执行：${dependencyGate.failed.join(', ')}`
      : null;
    const initialStatus = dependencyError ? 'CANCELLED' : approvalRequest ? 'WAITING_APPROVAL' : canRun ? 'RUNNING' : 'QUEUED';
    const initialStage = dependencyError ? '依赖失败' : approvalRequest ? '等待审批' : canRun ? STAGES[0] : queuedStage;
    if (source === 'delegated' && !canRun) this.assertNoDelegationWaitCycle(opts.parentId!, agentId);
    let inserted = false;
    this.db.transaction(() => {
      const transactionProjectId = this.resolveTaskProject(agentId, opts.parentId, opts.projectId);
      if (transactionProjectId !== projectId) throw new Error('父任务或项目关联已发生变化');
      const transactionWorkspace = this.resolveProjectWorkspace(transactionProjectId, opts.workspaceOverride);
      if (transactionWorkspace !== workspaceOverride) throw new Error('项目工作目录已发生变化，请重新派发任务');
      // Lookup and commit are separate calls. Recheck under the write
      // transaction so an archived/moved target cannot cross the tenant gate.
      if (source === 'delegated') {
        this.assertDelegationTarget(opts.parentId!, agentId, Boolean(opts.allowAncestorAgentDelegation));
        if (!canRun) this.assertNoDelegationWaitCycle(opts.parentId!, agentId);
      }
      inserted = this.db.raw.prepare(
        `INSERT INTO tasks(
          id, agent_id, project_id, conversation_id, input_message_id, title, content,
          source, source_key, parent_id, status, priority, progress, stage, error,
          session_id, workspace_override, engine_override, artifacts_required, created_at, started_at, ended_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, source_key) WHERE source_key IS NOT NULL DO NOTHING`
      ).run(
        id, agentId, projectId, opts.conversationId ?? null, opts.inputMessageId ?? null,
        title, content, source, sourceKey, opts.parentId ?? null, initialStatus, priority,
         initialStage, dependencyError, opts.sessionId ?? null, workspaceOverride, engineOverride, requiresArtifacts ? 1 : 0,
         now, canRun ? now : null, dependencyError ? now : null
      ).changes > 0;
      if (!inserted) return;
      for (const dependencyTaskId of dependencyTaskIds) {
        this.db.raw.prepare(
          'INSERT INTO task_dependencies(task_id, dependency_task_id, created_at) VALUES(?, ?, ?)'
        ).run(id, dependencyTaskId, now);
      }
      if (canRun) {
        this.db.raw.prepare('INSERT INTO agent_runs(id, agent_id, task_id, pid, session_id, status, started_at, ended_at) VALUES(?, ?, ?, ?, ?, ?, ?, NULL)')
          .run(randomUUID(), agentId, id, process.pid, randomUUID(), 'RUNNING', now);
      }
      if (dependencyError) {
        this.db.raw.prepare('INSERT INTO task_events(id, task_id, event_type, payload, created_at) VALUES(?, ?, ?, ?, ?)')
          .run(randomUUID(), id, 'dependency_blocked', JSON.stringify({ failed: dependencyGate.failed, error: dependencyError }), now);
      } else if (approvalRequest) {
        const approvalId = randomUUID();
        this.db.raw.prepare(
          'INSERT INTO approvals(id, task_id, agent_id, type, request, risk, status, created_at, decided_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, NULL)'
        ).run(approvalId, id, agentId, DISPATCH_PLAN_APPROVAL_TYPE, approvalRequest, 'medium', 'pending', now);
        this.db.raw.prepare('INSERT INTO task_events(id, task_id, event_type, payload, created_at) VALUES(?, ?, ?, ?, ?)')
          .run(randomUUID(), id, 'approval_required', JSON.stringify({ approvalId, scope: 'dispatch_plan', request: approvalRequest, risk: 'medium' }), now);
      } else {
        this.db.raw.prepare('INSERT INTO task_events(id, task_id, event_type, payload, created_at) VALUES(?, ?, ?, ?, ?)')
          .run(randomUUID(), id, canRun ? 'started' : 'queued', '{}', now);
      }
      opts.onPersisted?.(id);
    });
    if (!inserted) {
      const existing = sourceKey
        ? this.db.raw.prepare('SELECT * FROM tasks WHERE source = ? AND source_key = ?').get(source, sourceKey) as Row | undefined
        : undefined;
      if (!existing) throw new Error('任务创建失败');
      return Object.assign(this.mapTask(existing), { deduplicated: true as const });
    }
    const created = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row;
    const task = this.mapTask(created);
    if (canRun) this.dispatchTask(task, agent);
    if (approvalRequest && !dependencyError) notify(this.db, '任务计划等待审批', approvalRequest);
    if (dependencyError) {
      for (const fn of this.finishListeners) {
        try {
          fn({ taskId: id, agentId, status: 'CANCELLED', title, result: null, error: dependencyError });
        } catch { /* notification failure must not alter state */ }
      }
      this.settleTaskDependents(id, 'CANCELLED', dependencyError);
    }
    this.emit();
    return task;
  }

  /**
   * Sole commit point for a validated control-kernel plan. Planning is
   * side-effect free; only this method may turn the plan into a runnable task.
   */
  applyDispatchPlan(request: KernelRequest, plan: DispatchPlan, state: DatabaseKernelState): CreateTaskResult {
    if (request.requestId !== plan.requestId || request.conversationId !== plan.conversationId) {
      throw new Error('调度计划与请求不匹配');
    }

    let stored = state.findPlan(request.requestId);
    if (stored) stored = state.savePlan(request, plan);
    if (stored?.status === 'failed') throw new Error('调度计划已标记失败');
    if (stored?.status === 'committed') {
      const existing = stored.taskId
        ? this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(stored.taskId) as Row | undefined
        : undefined;
      if (!existing) throw new Error('已提交调度计划对应的任务不存在');
      return Object.assign(this.mapTask(existing), { deduplicated: true as const });
    }

    const selected = request.workers.find((worker) => worker.agentId === plan.workerAgentId);
    if (!selected || selected.engineId !== plan.workerEngineId) throw new Error('调度计划选择了不可用的执行员工');
    const agent = this.getAgent(plan.workerAgentId);
    if (!agent || agent.archived || agent.lifecycle !== 'READY') throw new Error('调度计划选择的员工当前不可执行');
    if (agent.engineId !== plan.workerEngineId) throw new Error('员工执行引擎在规划后发生变化，请重新规划');
    assertAndroidOperatorEngine(agent.kind, plan.workerEngineId);

    stored ??= state.savePlan(request, plan);
    if (stored.status === 'failed') throw new Error('调度计划已标记失败');
    if (stored.status === 'committed') {
      const existing = stored.taskId
        ? this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(stored.taskId) as Row | undefined
        : undefined;
      if (!existing) throw new Error('已提交调度计划对应的任务不存在');
      return Object.assign(this.mapTask(existing), { deduplicated: true as const });
    }

    const reviewConcerns = plan.advisorReviews
      .filter((review) => !review.accepted)
      .map((review) => `${review.advisorId}: ${review.summary}`)
      .join('；')
      .slice(0, 1_200);
    const approvalRequest = plan.requiresHumanApproval
      ? `控制核计划请求执行「${plan.title}」：${plan.rationale}${reviewConcerns ? `；复核意见：${reviewConcerns}` : ''}`
      : undefined;
    const task = this.createTask(plan.workerAgentId, plan.title, request.source, {
      projectId: request.projectId ?? undefined,
      conversationId: request.conversationId,
      inputMessageId: request.inputMessageId,
      sessionId: `conv-${request.conversationId}`,
      sourceKey: `kernel:${request.requestId}`,
      engineOverride: plan.workerEngineId,
      content: plan.objective,
      priority: plan.priority,
      initialApprovalRequest: approvalRequest,
      onPersisted: (taskId) => {
        state.markCommitted(request.requestId, taskId);
        this.db.audit({
          id: randomUUID(),
          actor: plan.leaderKernel,
          action: 'kernel.plan.commit',
          target: taskId,
          result: `${plan.workerAgentId}:${plan.workerEngineId}`,
          source: request.source
        });
      }
    });
    return task;
  }

  /**
   * 等待任务到达终态（供团队流水线和委派工具使用；超时返回 null）。
   * 传入 parentTaskId 时，父任务进入终态/消失会先取消子任务，避免
   * 委派工具被中止后留下无人回收的 QUEUED/RUNNING 任务。
   */
  waitForTask(taskId: string, timeoutMs: number, parentTaskId?: string): Promise<Task | null> {
    return new Promise((resolve) => {
      const started = Date.now();
      let delay = 500;
      let settled = false;
      const finish = (value: Task | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const check = () => {
        if (settled) return;
        const row = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Row | undefined;
        if (!row) return finish(null);
        const t = this.mapTask(row);
        if (TERMINAL_TASK_STATUSES.includes(t.status as typeof TERMINAL_TASK_STATUSES[number])) return finish(t);

        if (parentTaskId) {
          const parent = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(parentTaskId) as Row | undefined;
          const parentLive = parent
            ? !TERMINAL_TASK_STATUSES.includes(parent.status as typeof TERMINAL_TASK_STATUSES[number])
            : false;
          if (!parentLive) {
            // cancelTask is idempotent with respect to a child that completed
            // between the read above and this call.
            try { this.cancelTask(taskId, '父任务已结束'); } catch { /* child may have completed concurrently */ }
            const canceled = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Row | undefined;
            return finish(canceled ? this.mapTask(canceled) : null);
          }
        }

        if (Date.now() - started >= timeoutMs) return finish(null);
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
    const source = parent.source === 'schedule' || parent.source === 'delegated' ? 'desktop' : parent.source;
    return this.createTask(parent.agentId, title, source, {
      parentId: parent.id,
      sessionId: parent.sessionId ?? undefined,
      conversationId: parent.conversationId ?? undefined,
      content: title,
      requiresArtifacts: parent.requiresArtifacts
    });
  }

  /** 重新执行终态任务：保留归属与工作区，但不复用失败会话。 */
  retryTask(taskId: string): Task {
    const row = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(taskId) as Row | undefined;
    if (!row) throw new Error('原任务不存在或已删除');
    const original = this.mapTask(row);
    if (!['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(original.status)) throw new Error('任务尚未结束，不能重试');
    const source = original.source === 'schedule' || original.source === 'delegated' ? 'desktop' : original.source;
    const retried = this.createTask(original.agentId, original.title, source, {
      parentId: original.id,
      projectId: original.projectId ?? undefined,
      conversationId: original.conversationId ?? undefined,
      workspaceOverride: original.workspaceOverride ?? undefined,
      engineOverride: original.engineOverride ?? undefined,
      content: original.content,
      requiresArtifacts: original.requiresArtifacts
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
    const activeDependent = this.db.raw.prepare(
      `SELECT td.task_id
       FROM task_dependencies td
       JOIN tasks t ON t.id = td.task_id
       WHERE td.dependency_task_id = ?
         AND t.deleted_at IS NULL
         AND t.status IN ('RUNNING','QUEUED','WAITING_APPROVAL','PAUSED')`
    ).get(taskId) as { task_id: string } | undefined;
    if (activeDependent) throw new Error('该任务仍有未完成的依赖后续任务，暂不能删除');
    this.db.raw.prepare('UPDATE tasks SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(Date.now(), taskId);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'task.delete', target: taskId, result: 'soft-deleted' });
    this.emit();
  }

  /** 经执行器注册表派发。 */
  private dispatchTask(task: Task, agent: Agent) {
    // 任务级引擎覆盖优先（E-2 编码委派）：子任务仍归属原员工，仅执行引擎不同
    const requestedEngineId = task.engineOverride || agent.engineId;
    const binding: ExecutionBinding = {
      requestedEngineId,
      resolvedEngineId: null,
      executorKind: 'unavailable',
      usedFallback: false
    };
    this.executors.dispatch(
      task,
      { ...agent, engineId: requestedEngineId },
      this.makeCallbacks(task.id, agent.id, binding, agent.kind),
      (resolved) => {
        Object.assign(binding, resolved);
        this.db.raw.prepare(
          'UPDATE agent_runs SET requested_engine_id = ?, resolved_engine_id = ?, executor_kind = ? WHERE task_id = ? AND ended_at IS NULL'
        ).run(resolved.requestedEngineId, resolved.resolvedEngineId, resolved.executorKind, task.id);
        this.db.audit({
          id: randomUUID(),
          actor: 'system',
          action: 'task.executorResolved',
          target: task.id,
          result: JSON.stringify(resolved),
          source: task.source
        });
      }
    );
  }

  /** 任务事件落库（13.2 审计可追溯；详情页时间线数据源） */
  private recordEvent(taskId: string, eventType: string, payload: Record<string, unknown>, now: number) {
    this.db.raw.prepare('INSERT INTO task_events(id, task_id, event_type, payload, created_at) VALUES(?, ?, ?, ?, ?)')
      .run(randomUUID(), taskId, eventType, JSON.stringify(payload), now);
  }

  /** Return a mobile task to FIFO while its process has not acquired a lease.
   * Retrying an already-issued non-idempotent phone command would be unsafe;
   * this path is limited to preparation-time offline/lease races. */
  private deferMobilePreparation(taskId: string, reason: string): boolean {
    const now = Date.now();
    let changed = false;
    this.db.transaction(() => {
      changed = this.db.raw.prepare(
        `UPDATE tasks
         SET status = 'QUEUED', stage = ?, error = NULL, started_at = NULL, ended_at = NULL
         WHERE id = ? AND status = 'RUNNING'`
      ).run(reason, taskId).changes > 0;
      if (!changed) return;
      this.db.raw.prepare(
        "UPDATE agent_runs SET ended_at = ?, status = 'INTERRUPTED' WHERE task_id = ? AND ended_at IS NULL"
      ).run(now, taskId);
      this.recordEvent(taskId, 'queued', { reason: 'mobile-preparation-deferred', detail: reason }, now);
    });
    if (changed) this.emit();
    return changed;
  }

  /** Ignore output arriving after cancellation/timeout and release the small
   * per-task accounting entry after late child-process callbacks settle. */
  private closeOutputState(taskId: string) {
    const state = this.outputStates.get(taskId) ?? { chars: 0, events: 0, truncated: false, closed: false };
    state.closed = true;
    this.outputStates.set(taskId, state);
    setTimeout(() => {
      if (this.outputStates.get(taskId) === state) this.outputStates.delete(taskId);
    }, OUTPUT_STATE_TTL_MS);
  }

  /** 执行器回调：统一走“状态更新 + task_events 同事务”模式；终态触发该员工 FIFO 补位 */
  private makeCallbacks(taskId: string, agentId: string, binding: ExecutionBinding, agentKind: Agent['kind']): ExecutorCallbacks {
    const finish = async (status: 'COMPLETED' | 'FAILED' | 'INTERRUPTED', info: { result?: string; error?: string }) => {
      if (this.finalizingTasks.has(taskId)) return;
      this.finalizingTasks.add(taskId);
      const completionSignaledAt = Date.now();
      this.closeOutputState(taskId);
      const boundedResult = typeof info.result === 'string' ? info.result.slice(0, MAX_TASK_RESULT_CHARS) : undefined;
      let finalStatus = status;
      let finalError = info.error;
      let artifactManifest: ProjectArtifactManifest | null = null;

      if (status === 'COMPLETED' && this.projectArtifactCompletionValidator) {
          const task = this.db.raw.prepare(
            'SELECT * FROM tasks WHERE id = ?'
          ).get(taskId) as { project_id: string | null; artifacts_required?: number; started_at: number | null; created_at: number | null } | undefined;
        if (task?.project_id && Number(task.artifacts_required ?? 0) === 1) {
          const executionStartedAt = Number.isSafeInteger(task.started_at)
            ? Number(task.started_at) : completionSignaledAt;
          // Approval and dependency resumes reset started_at for watchdog
          // purposes. A worker can have already written a real artifact while
          // that resume is being finalized, so the task creation time remains
          // the lower bound for admission. The scanner still rejects stale,
          // symlinked, out-of-root, and unchanged files.
          const createdAt = Number.isSafeInteger(task.created_at) ? Number(task.created_at) : executionStartedAt;
          const startedAt = Math.min(createdAt, executionStartedAt);
          this.db.transaction(() => {
            const changed = this.db.raw.prepare(
              "UPDATE tasks SET stage = ? WHERE id = ? AND status = 'RUNNING'"
            ).run('校验项目产物', taskId).changes;
            if (changed > 0) this.recordEvent(taskId, 'stage', { stage: '校验项目产物' }, completionSignaledAt);
          });
          this.emit();
          try {
            const evidence = await this.projectArtifactCompletionValidator.validateTaskCompletion({
              taskId,
              projectId: task.project_id,
              startedAt,
              endedAt: completionSignaledAt
            });
            if (evidence.ok) artifactManifest = evidence.manifest;
            else {
              finalStatus = 'FAILED';
              finalError = evidence.error;
            }
          } catch {
            finalStatus = 'FAILED';
            finalError = '项目产物校验服务异常，任务未标记为完成';
          }
        }
      }

      const now = Date.now();
      // 真实执行鉴权失败：如实把引擎标为 AUTH_REQUIRED，不掩盖
      const authFailed = binding.resolvedEngineId !== null
        && binding.executorKind !== 'unavailable'
        && isExecutorAuthenticationFailure(finalError);
      // 终态守卫（数据层最后防线）：只有非终态任务才能落终态。
      // 迟到回调（看门狗中断后进程才退出、用户取消后执行器才收尾、执行器双重回调）
      // 一律丢弃，绝不把已 INTERRUPTED/CANCELLED 的任务改写成 COMPLETED。
      const LIVE = "('QUEUED','RUNNING','WAITING_APPROVAL','PAUSED')";
      let applied = false;
      this.db.transaction(() => {
        if (finalStatus === 'COMPLETED') {
          applied = this.db.raw.prepare(`UPDATE tasks SET status = 'COMPLETED', progress = 100, stage = '完成', result = ?, ended_at = ? WHERE id = ? AND status IN ${LIVE}`)
            .run(boundedResult ?? null, now, taskId).changes > 0;
          if (!applied) return;
          if (artifactManifest) this.recordEvent(taskId, 'artifact_manifest', { manifest: artifactManifest }, now);
          const result = boundedResult ?? '';
          this.recordEvent(taskId, 'result', { available: result.length > 0, chars: result.length }, now);
          this.recordEvent(taskId, 'completed', { progress: 100 }, now);
        } else {
          applied = this.db.raw.prepare(`UPDATE tasks SET status = ?, error = ?, ended_at = ? WHERE id = ? AND status IN ${LIVE}`)
            .run(finalStatus, finalError ?? null, now, taskId).changes > 0;
          if (!applied) return;
          if (status === 'COMPLETED' && finalStatus === 'FAILED') {
            this.recordEvent(taskId, 'artifact_validation_failed', { error: finalError ?? '' }, now);
          }
          this.recordEvent(taskId, finalStatus === 'FAILED' ? 'failed' : 'interrupted', { error: finalError ?? '' }, now);
        }
        this.db.raw.prepare('UPDATE agent_runs SET ended_at = ?, status = ? WHERE task_id = ? AND ended_at IS NULL').run(now, finalStatus, taskId);
        if (authFailed && binding.resolvedEngineId) {
          this.db.raw.prepare("UPDATE engines SET status = 'AUTH_REQUIRED', auth_status = 'required' WHERE id = ?").run(binding.resolvedEngineId);
        }
      });
      // 守卫拦下的迟到回调：不通知、不推 webhook、不触发补位，只做一次并发释放后返回
      if (!applied) {
        this.finalizingTasks.delete(taskId);
        this.emit();
        this.scheduleNext(agentId);
        return;
      }
      if (finalStatus === 'FAILED') {
        const t = this.db.raw.prepare('SELECT title FROM tasks WHERE id = ?').get(taskId) as { title: string } | undefined;
        notify(this.db, '任务执行失败', `${t?.title ?? taskId}：${(finalError ?? '').slice(0, 120)}`);
      }
      if (authFailed) notify(this.db, '引擎需要重新登录', '执行引擎鉴权失败，已标记为待登录，请到引擎中心处理');
      this.settleTaskDependents(
        taskId,
        finalStatus,
        finalError ?? `前置任务 ${taskId} 以 ${finalStatus} 结束`
      );
      // 终态订阅（webhook 等对外通知）：查询落库后的最终数据,异常不影响主流程
      {
        const t = this.db.raw.prepare('SELECT title FROM tasks WHERE id = ?').get(taskId) as { title: string } | undefined;
        for (const fn of this.finishListeners) {
          try {
            fn({ taskId, agentId, status: finalStatus, title: t?.title ?? taskId, result: boundedResult ?? null, error: finalError ?? null });
          } catch { /* 通知失败不影响调度 */ }
        }
      }
      this.finalizingTasks.delete(taskId);
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
        // 高频增量文本：保留有限预算后再落事件库/推送，避免长任务
        // 造成 SQLite、IPC 和 React 状态同时线性增长。
        const state = this.outputStates.get(id) ?? { chars: 0, events: 0, truncated: false, closed: false };
        this.outputStates.set(id, state);
        if (state.closed || !chunk || state.events >= MAX_TASK_OUTPUT_EVENTS || state.chars >= MAX_TASK_OUTPUT_CHARS) return;
        const remaining = MAX_TASK_OUTPUT_CHARS - state.chars;
        const accepted = chunk.slice(0, remaining);
        if (!accepted) return;
        state.chars += accepted.length;
        state.events += 1;
        this.recordEvent(id, 'output', { chunk: accepted }, Date.now());
        for (const fn of this.outputListeners) fn(id, accepted);
        if (accepted.length < chunk.length || state.events >= MAX_TASK_OUTPUT_EVENTS || state.chars >= MAX_TASK_OUTPUT_CHARS) {
          state.truncated = true;
        }
      },
      onSession: (id, sessionId) => {
        // P2b：会话锚点落库（仅首次），追问时继承
        this.db.raw.prepare('UPDATE tasks SET session_id = ? WHERE id = ? AND session_id IS NULL').run(sessionId, id);
      },
      onReleased: () => {
        if (this.resumeAfterRelease.delete(taskId)) this.resumePausedTask(taskId);
        this.emit();
        this.scheduleNext(agentId);
      },
      onDone: (id, result) => { void finish('COMPLETED', { result }); },
      onError: (id, message) => {
        const preparationRace = agentKind === 'android_operator'
          && /手机任务准备失败：.*(?:Android device is offline|active control lease)/i.test(message);
        if (preparationRace && this.deferMobilePreparation(taskId, '手机暂时不可用，等待连接或当前控制会话释放')) return;
        void finish(/超时|中断/.test(message) ? 'INTERRUPTED' : 'FAILED', { error: message });
      }
    };
  }

  /**
   * Count occupied Agent slots across durable task state and executor resources.
   * ACP children remain present in the registry after their task reaches a
   * terminal state, so the union must be counted without double-counting a
   * PAUSED child that is represented in both places.
   */
  private agentOccupancy(agentId: string, excludeTaskId?: string): number {
    // A dispatch-plan approval has not acquired an execution slot. Runtime
    // tool approvals remain counted through the live executor registry below.
    const occupying = ['RUNNING', 'PAUSED'];
    let active = (this.db.raw.prepare("SELECT COUNT(*) c FROM tasks WHERE agent_id = ? AND status IN ('RUNNING','PAUSED')").get(agentId) as { c: number }).c;

    if (excludeTaskId) {
      const excluded = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(excludeTaskId) as Row | undefined;
      if (excluded?.agent_id === agentId && occupying.includes(excluded.status as string)) {
        active = Math.max(0, active - 1);
      }
    }

    for (const taskId of this.executors.activeTaskIdsForAgent(agentId)) {
      if (taskId === excludeTaskId) continue;
      const row = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Row | undefined;
      if (!row || !occupying.includes(row.status as string)) active += 1;
    }
    return active;
  }

  private resumePausedTask(taskId: string): boolean {
    const row = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Row | undefined;
    if (!row || row.status !== 'PAUSED') return false;
    const agentId = row.agent_id as string;
    const agent = this.getAgent(agentId);
    if (!agent || agent.lifecycle !== 'READY') return false;
    if (this.agentOccupancy(agentId, taskId) >= Math.max(1, agent.concurrencyLimit)) return false;

    // Watchdog time is measured per running segment; the paused interval does
    // not count toward maxRunMinutes.
    const changed = this.db.raw.prepare("UPDATE tasks SET status = 'RUNNING', started_at = ? WHERE id = ? AND status = 'PAUSED'").run(Date.now(), taskId).changes;
    if (changed === 0) return false;
    const resumed = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Row | undefined;
    if (!resumed) return false;
    this.dispatchTask(this.mapTask(resumed), agent);
    return true;
  }

  /** FIFO 调度：任务到达终态后，启动该员工最早的 QUEUED 任务（6.2 基础调度；资源保护时暂停） */
  private scheduleNext(agentId: string) {
    if (this.schedulingAgents.has(agentId)) return;
    this.schedulingAgents.add(agentId);
    try {
    const agent = this.getAgent(agentId);
    if (!agent || agent.lifecycle !== 'READY') return;
    if (this.dispatchGuard() !== null) return;
    if (agent.kind === 'android_operator' && !this.mobileDispatchPolicy?.canDispatch(agentId).ready) return;
    const active = this.agentOccupancy(agentId);
    if (active >= Math.max(1, agent.concurrencyLimit)) return;
    let prunedOrphan = false;
    while (true) {
      const rows = this.db.raw.prepare("SELECT * FROM tasks WHERE agent_id = ? AND status = 'QUEUED' ORDER BY created_at").all(agentId) as Row[];
      if (rows.length === 0) {
        if (prunedOrphan) this.emit();
        return;
      }
      let dispatched = false;
      for (const row of rows) {
      if (row.source === 'delegated' && !this.delegationChainIsLive(row)) {
        const cancelled = this.cancelTaskSet(
          this.collectTaskTree(String(row.id)),
          Date.now(),
          '父任务已经结束，排队中的委派已取消',
          '上级委派已经结束'
        );
        if (cancelled.length === 0) return;
        prunedOrphan = true;
        this.notifyCancelledTasks(cancelled);
        this.settleCancelledTaskDependents(cancelled);
        this.db.audit({ id: randomUUID(), actor: 'system', action: 'task.cancelOrphanedDelegation', target: String(row.id), result: 'ok' });
        for (const affectedAgentId of new Set(cancelled.map((task) => task.agentId))) {
          if (affectedAgentId !== agentId) this.scheduleNext(affectedAgentId);
        }
        continue;
      }
      const gate = this.dependencyGate(String(row.id));
      if (!gate.ready) {
        if (gate.failed.length === 0) continue;
        const reason = `前置任务未成功完成，已阻止执行：${gate.failed.join(', ')}`;
        const cancelled = this.cancelTaskSet(
          this.collectTaskTree(String(row.id)),
          Date.now(),
          reason,
          reason
        );
        if (cancelled.length === 0) continue;
        prunedOrphan = true;
        this.notifyCancelledTasks(cancelled);
        this.settleCancelledTaskDependents(cancelled);
        for (const affectedAgentId of new Set(cancelled.map((task) => task.agentId))) {
          if (affectedAgentId !== agentId) this.scheduleNext(affectedAgentId);
        }
        continue;
      }
      const now = Date.now();
      this.db.transaction(() => {
        this.db.raw.prepare("UPDATE tasks SET status = 'RUNNING', stage = ?, started_at = ? WHERE id = ? AND status = 'QUEUED'").run(STAGES[0], now, row.id as string);
        this.db.raw.prepare('INSERT INTO agent_runs(id, agent_id, task_id, pid, session_id, status, started_at, ended_at) VALUES(?, ?, ?, ?, ?, ?, ?, NULL)')
          .run(randomUUID(), agentId, row.id as string, process.pid, randomUUID(), 'RUNNING', now);
        this.recordEvent(row.id as string, 'started', {}, now);
      });
      const task = this.mapTask(row);
      task.status = 'RUNNING';
      this.dispatchTask(task, agent);
      this.emit();
      dispatched = true;
      break;
      }
      if (dispatched) return;
      // Every queued row is waiting on a prerequisite. A later completion
      // will call this method through settleTaskDependents.
      return;
    }
    } finally {
      this.schedulingAgents.delete(agentId);
    }
  }

  /** 设备上线或控制租约释放后，唤醒对应手机员工的 FIFO 队列。 */
  wakeAgentQueue(agentId: string): void {
    this.scheduleNext(agentId);
  }

  /** Resource guard recovery is system-wide, so every durable FIFO with queued work must be reconsidered. */
  wakeQueuedAgentQueues(releasedReason?: string): number {
    if (this.dispatchGuard() !== null) return 0;
    const queued = (this.db.raw.prepare(
      'SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY created_at DESC'
    ).all() as Row[]).filter((task) => task.status === 'QUEUED');
    if (releasedReason) {
      for (const task of queued) {
        if (task.stage !== releasedReason) continue;
        this.db.raw.prepare("UPDATE tasks SET stage = '排队中' WHERE id = ? AND status = 'QUEUED'").run(task.id as string);
      }
    }
    const agentIds = [...new Set(queued.map((task) => task.agent_id as string))];
    for (const agentId of agentIds) this.scheduleNext(agentId);
    if (queued.length > 0) this.emit();
    return agentIds.length;
  }

  /** Return the root task and delegated descendants, cycle-safe. parent_id is
   * also used by follow-ups/retries, which are independent executions and
   * must not be cancelled as delegation children. */
  private collectTaskTree(rootTaskId: string): string[] {
    const queue = [rootTaskId];
    const seen = new Set<string>();
    const result: string[] = [];
    while (queue.length > 0) {
      const parentId = queue.shift()!;
      if (seen.has(parentId)) continue;
      seen.add(parentId);
      result.push(parentId);
      const children = this.db.raw.prepare(
        "SELECT id FROM tasks WHERE parent_id = ? AND deleted_at IS NULL AND source = 'delegated'"
      ).all(parentId) as { id: string }[];
      for (const child of children) {
        if (child?.id && !seen.has(child.id)) queue.push(child.id);
      }
    }
    return result;
  }

  /**
   * Mark a single live task cancelled. The guarded UPDATE is deliberately the
   * first state transition; executor aborts happen only after the whole set is
   * durable, so synchronous onError/onDone callbacks cannot win the race.
   */
  private cancelTaskInternal(taskId: string, now: number, reason: string): boolean {
    const changed = this.db.raw.prepare(
      "UPDATE tasks SET status = 'CANCELLED', ended_at = ? WHERE id = ? AND status IN ('RUNNING','QUEUED','WAITING_APPROVAL','PAUSED')"
    ).run(now, taskId).changes > 0;
    if (!changed) return false;
    this.db.raw.prepare("UPDATE agent_runs SET ended_at = ?, status = 'CANCELLED' WHERE task_id = ? AND ended_at IS NULL").run(now, taskId);
    this.db.raw.prepare("UPDATE approvals SET status = 'rejected', decided_at = ? WHERE task_id = ? AND status = 'pending'").run(now, taskId);
    this.recordEvent(taskId, 'cancelled', { reason }, now);
    return true;
  }

  private releaseCancelledTasks(cancelled: CancelledTaskRecord[]): void {
    for (const task of cancelled) {
      this.resumeAfterRelease.delete(task.id);
      this.closeOutputState(task.id);
      try { this.broker.abandonTask(task.id); } catch { /* best effort */ }
      try { this.executors.abort(task.id); } catch { /* best effort */ }
    }
  }

  /**
   * Cancel a set of tasks atomically, then release broker/executor resources.
   * The caller supplies root/descendant messages for finish subscribers.
   */
  private cancelTaskSet(
    taskIds: string[],
    now: number,
    rootReason: string,
    descendantReason: string,
    rootTaskIds = new Set(taskIds.slice(0, 1)),
    beforePersist?: () => void
  ): CancelledTaskRecord[] {
    const cancelled: CancelledTaskRecord[] = [];
    this.db.transaction(() => {
      beforePersist?.();
      for (const taskId of taskIds) {
        const row = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(taskId) as Row | undefined;
        if (!row || !ACTIVE_TASK_STATUSES.includes(row.status as typeof ACTIVE_TASK_STATUSES[number])) continue;
        const error = rootTaskIds.has(taskId) ? rootReason : descendantReason;
        const record = {
          id: taskId,
          agentId: String(row.agent_id),
          title: String(row.title ?? taskId),
          error
        };
        if (!this.cancelTaskInternal(taskId, now, error)) continue;
        cancelled.push(record);
      }
    });

    // State is already terminal before either callback-capable resource is
    // touched. A failing abort must not prevent the rest of the tree from
    // being released.
    this.releaseCancelledTasks(cancelled);
    return cancelled;
  }

  private notifyCancelledTasks(cancelled: CancelledTaskRecord[]): void {
    for (const task of cancelled) {
      for (const fn of this.finishListeners) {
        try {
          fn({ taskId: task.id, agentId: task.agentId, status: 'CANCELLED', title: task.title, result: null, error: task.error });
        } catch { /* notification failure must not alter state */ }
      }
    }
  }

  /**
   * A cancellation request may include a delegation tree. Every task that was
   * durably cancelled is an upstream prerequisite in its own right, so settle
   * each distinct id instead of only settling the user-facing root.
   */
  private settleCancelledTaskDependents(cancelled: readonly CancelledTaskRecord[]): void {
    const settled = new Set<string>();
    for (const task of cancelled) {
      if (settled.has(task.id)) continue;
      settled.add(task.id);
      this.settleTaskDependents(task.id, 'CANCELLED', task.error);
    }
  }

  /** Cancel a task and all active descendants; public API remains one-arg compatible. */
  cancelTask(taskId: string, reason = '用户取消任务') {
    const task = this.db.raw.prepare('SELECT agent_id, status FROM tasks WHERE id = ? AND deleted_at IS NULL').get(taskId) as { agent_id: string; status: TaskStatus } | undefined;
    if (!task) throw new Error('任务不存在或已删除');
    if (!ACTIVE_TASK_STATUSES.includes(task.status as typeof ACTIVE_TASK_STATUSES[number])) throw new Error('任务已经结束，不能取消');

    const cancelled = this.cancelTaskSet(this.collectTaskTree(taskId), Date.now(), reason, '父任务已取消');
    const rootCancelled = cancelled.some((item) => item.id === taskId);
    if (!rootCancelled) {
      // Another terminal transition won between the initial read and our
      // guarded UPDATE. Preserve the existing API error instead of emitting a
      // duplicate cancellation event.
      const latest = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(taskId) as Row | undefined;
      if (!latest) throw new Error('任务不存在或已删除');
      if (latest.status === 'RUNNING' && latest.stage === '等待执行取消确认') return;
      if (!ACTIVE_TASK_STATUSES.includes(latest.status as typeof ACTIVE_TASK_STATUSES[number])) throw new Error('任务已经结束，不能取消');
      return;
    }

    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'task.cancel', target: taskId, result: 'ok' });
    this.notifyCancelledTasks(cancelled);
    this.settleCancelledTaskDependents(cancelled);
    this.emit();
    for (const agentId of new Set(cancelled.map((item) => item.agentId))) this.scheduleNext(agentId);
  }

  pauseTask(taskId: string) {
    const changed = this.db.raw.prepare("UPDATE tasks SET status = 'PAUSED' WHERE id = ? AND status = 'RUNNING'").run(taskId).changes;
    if (changed > 0) this.executors.abort(taskId);
    this.emit();
  }

  resumeTask(taskId: string) {
    const row = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Row | undefined;
    if (!row || row.status !== 'PAUSED') return;
    if (this.executors.isExecuting(taskId)) {
      this.resumeAfterRelease.add(taskId);
      this.emit();
      return;
    }
    this.resumePausedTask(taskId);
    this.emit();
  }

  private dispatchPlanReadiness(taskId: string, agent: Agent): { ready: boolean; stage: string } {
    if (agent.archived) return { ready: false, stage: '员工已归档' };
    if (agent.lifecycle !== 'READY') return { ready: false, stage: `员工未就绪（${agent.lifecycle}）` };
    const dependency = this.dependencyGate(taskId);
    if (dependency.failed.length > 0) {
      return { ready: false, stage: `等待前置任务失败（${dependency.failed.join(', ')}）` };
    }
    if (!dependency.ready) return { ready: false, stage: `等待前置任务（${dependency.pending.length}）` };
    const guardReason = this.dispatchGuard();
    if (guardReason) return { ready: false, stage: guardReason };
    if (agent.kind === 'android_operator') {
      const mobile = this.mobileDispatchPolicy?.canDispatch(agent.id)
        ?? { bound: false, ready: false, reason: '手机控制服务尚未启动' };
      if (!mobile.ready) return { ready: false, stage: mobile.reason };
    }
    if (this.agentOccupancy(agent.id, taskId) >= Math.max(1, agent.concurrencyLimit)) {
      return { ready: false, stage: '排队中' };
    }
    return { ready: true, stage: STAGES[0] };
  }

  decideApproval(approvalId: string, approve: boolean) {
    const now = Date.now();
    const ap = this.db.raw.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as Row | undefined;
    if (!ap || ap.status !== 'pending') return;
    const scope = approvalScope(ap.type);
    const taskId = ap.task_id as string;

    if (scope === 'dispatch_plan') {
      const row = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Row | undefined;
      if (!row || row.status !== 'WAITING_APPROVAL') return;
      const agent = this.getAgent(row.agent_id as string);
      const readiness = agent && approve
        ? this.dispatchPlanReadiness(taskId, agent)
        : { ready: false, stage: '审批被拒绝' };

      this.db.transaction(() => {
        this.db.raw.prepare('UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?').run(approve ? 'approved' : 'rejected', now, approvalId);
        this.recordEvent(taskId, 'approval_decided', { approvalId, scope, approved: approve }, now);
        if (!approve) {
          this.db.raw.prepare("UPDATE tasks SET status = 'FAILED', ended_at = ?, error = '审批被拒绝' WHERE id = ? AND status = 'WAITING_APPROVAL'").run(now, taskId);
          this.recordEvent(taskId, 'failed', { error: '审批被拒绝' }, now);
          return;
        }
        if (!agent || !readiness.ready) {
          this.db.raw.prepare("UPDATE tasks SET status = 'QUEUED', stage = ?, started_at = NULL WHERE id = ? AND status = 'WAITING_APPROVAL'")
            .run(readiness.stage, taskId);
          this.recordEvent(taskId, 'queued', { reason: readiness.stage, afterApproval: true }, now);
          return;
        }
        this.db.raw.prepare("UPDATE tasks SET status = 'RUNNING', stage = ?, started_at = ? WHERE id = ? AND status = 'WAITING_APPROVAL'")
          .run(STAGES[0], now, taskId);
        this.db.raw.prepare(
          'INSERT INTO agent_runs(id, agent_id, task_id, pid, session_id, status, started_at, ended_at) VALUES(?, ?, ?, ?, ?, ?, ?, NULL)'
        ).run(randomUUID(), agent.id, taskId, process.pid, randomUUID(), 'RUNNING', now);
        this.recordEvent(taskId, 'started', { afterApproval: true }, now);
      });

      if (approve && agent && readiness.ready) {
        const started = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Row | undefined;
        if (started?.status === 'RUNNING') this.dispatchTask(this.mapTask(started), agent);
      }
      this.db.audit({ id: randomUUID(), actor: 'admin', action: approve ? 'approval.approve' : 'approval.reject', target: approvalId, result: readiness.ready ? 'running' : approve ? 'queued' : 'rejected' });
      this.emit();
      if (!approve) {
        this.settleTaskDependents(taskId, 'FAILED', '前置任务审批被拒绝');
        this.scheduleNext(ap.agent_id as string);
      }
      return;
    }

    // P1b：命中活跃执行器（工具循环正挂起等待）→ 仅唤醒，不重新派发；拒绝也不 fail 整个任务
    const wasLive = this.broker.decide(approvalId, approve);
    this.db.transaction(() => {
      this.db.raw.prepare('UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?').run(approve ? 'approved' : 'rejected', now, approvalId);
      this.recordEvent(taskId, 'approval_decided', { approvalId, scope, approved: approve }, now);
      if (approve || wasLive) {
        // 重置 started_at：审批等待期不计入看门狗时长（否则长时间等审批的任务恢复即被误杀）
        this.db.raw.prepare("UPDATE tasks SET status = 'RUNNING', started_at = ? WHERE id = ? AND status = 'WAITING_APPROVAL'").run(now, taskId);
      } else {
        this.db.raw.prepare("UPDATE tasks SET status = 'FAILED', ended_at = ?, error = '审批被拒绝' WHERE id = ? AND status = 'WAITING_APPROVAL'").run(now, taskId);
      }
    });
    // 非活跃执行器（种子数据/重启后遗留）且批准 → 重新派发执行（13.2 审批链路）
    if (approve && !wasLive) {
      const row = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Row | undefined;
      const agent = row ? this.getAgent(row.agent_id as string) : null;
      if (row && agent && row.status === 'RUNNING' && !this.executors.isExecuting(row.id as string)) {
        const activeRun = this.db.raw.prepare('SELECT id FROM agent_runs WHERE task_id = ? AND ended_at IS NULL LIMIT 1')
          .get(row.id as string) as { id: string } | undefined;
        if (!activeRun) {
          this.db.raw.prepare(
            'INSERT INTO agent_runs(id, agent_id, task_id, pid, session_id, status, started_at, ended_at) VALUES(?, ?, ?, ?, ?, ?, ?, NULL)'
          ).run(randomUUID(), agent.id, row.id as string, process.pid, randomUUID(), 'RUNNING', now);
        }
        this.dispatchTask(this.mapTask(row), agent);
      }
    }
    this.db.audit({ id: randomUUID(), actor: 'admin', action: approve ? 'approval.approve' : 'approval.reject', target: approvalId, result: 'ok' });
    this.emit();
    if (!approve && !wasLive) {
      this.settleTaskDependents(taskId, 'FAILED', '前置任务审批被拒绝');
      this.scheduleNext(ap.agent_id as string);
    }
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
