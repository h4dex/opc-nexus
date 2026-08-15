import { randomUUID } from 'node:crypto';
import type { Schedule } from '../../shared/types.js';
import type { Database } from './database.js';
import type { Scheduler } from './scheduler.js';
import type {
  DispatchPlan,
  KernelRequest,
  TaskScheduleCronKind,
  TaskScheduleProposal
} from './kernel/types.js';

export type TaskScheduleProposalStatus = 'pending' | 'accepted' | 'rejected';

export interface TaskScheduleProposalRecord {
  id: string;
  requestId: string;
  proposalIndex: number;
  organizationId: string;
  principalId: string | null;
  channelId: string | null;
  conversationId: string;
  agentId: string;
  projectId: string | null;
  operation: 'create_task_schedule';
  title: string;
  content: string;
  cronKind: TaskScheduleCronKind;
  cronValue: string;
  status: TaskScheduleProposalStatus;
  proposedBy: string;
  decidedBy: string | null;
  decisionReason: string | null;
  scheduleId: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface ListTaskScheduleProposalsInput {
  organizationId: string;
  status?: TaskScheduleProposalStatus | 'all';
  limit?: number;
}

export interface DecideTaskScheduleProposalInput {
  organizationId: string;
  proposalId: string;
  actor: string;
  reason?: string;
  source?: string;
}

export interface AcceptedTaskScheduleProposal {
  proposal: TaskScheduleProposalRecord;
  schedule: Schedule;
}

export interface TaskScheduleProposalRecoveryResult {
  scannedPlans: number;
  recoveredProposals: number;
  failedPlans: number;
}

type Row = Record<string, unknown>;

function required(value: string | null | undefined, field: string, max = 200): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) throw new Error(`${field} is required`);
  if (normalized.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return normalized;
}

function optionalReason(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (normalized.length > 2_000) throw new Error('decision reason exceeds 2000 characters');
  return normalized || null;
}

function boundedLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new Error('limit must be a finite number');
  return Math.min(max, Math.max(1, Math.trunc(value)));
}

function normalizedCron(kind: TaskScheduleCronKind, value: string): string {
  const text = required(value, 'task schedule proposal cronValue', 32);
  const clock = '(?:[01]\\d|2[0-3]):[0-5]\\d';
  if (kind === 'interval') {
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) throw new Error('interval cronValue must be decimal hours');
    const hours = Number(text);
    if (!Number.isFinite(hours) || hours < 0.5 || hours > 168) {
      throw new Error('interval cronValue must be between 0.5 and 168 hours');
    }
    return String(hours);
  }
  if (kind === 'daily' && new RegExp(`^${clock}$`).test(text)) return text;
  if (kind === 'weekly' && new RegExp(`^[0-6]\\|${clock}$`).test(text)) return text;
  if (kind === 'monthly' && new RegExp(`^(?:[1-9]|1\\d|2[0-8])\\|${clock}$`).test(text)) return text;
  throw new Error(`cronValue is invalid for ${kind}`);
}

/** Durable review queue for kernel-originated task schedule suggestions. */
export class TaskScheduleProposalService {
  constructor(
    private readonly db: Database,
    private readonly scheduler: Pick<Scheduler, 'createWithCommit' | 'list'>,
    private readonly now: () => number = Date.now
  ) {}

  recoverCommitted(): TaskScheduleProposalRecoveryResult {
    const rows = this.db.raw.prepare(
      `SELECT dp.request_id, dp.organization_id, dp.principal_id, dp.channel_id,
              dp.conversation_id, dp.input_message_id, dp.worker_agent_id,
              dp.worker_engine_id, dp.plan_json, t.source, t.project_id
       FROM dispatch_plans dp
       LEFT JOIN tasks t ON t.id = dp.task_id
       WHERE dp.status = 'committed'
       ORDER BY dp.created_at ASC`
    ).all() as Row[];
    let recoveredProposals = 0;
    let failedPlans = 0;

    for (const row of rows) {
      const requestId = String(row.request_id);
      try {
        const plan = JSON.parse(String(row.plan_json)) as DispatchPlan;
        const proposals = Array.isArray(plan.taskScheduleProposals) ? plan.taskScheduleProposals : [];
        if (proposals.length === 0) continue;
        const existing = this.db.raw.prepare(
          'SELECT COUNT(*) AS count FROM task_schedule_proposals WHERE request_id = ?'
        ).get(requestId) as Row | undefined;
        const existingCount = Number(existing?.count ?? 0);
        if (existingCount === proposals.length) continue;
        const rawSource = String(row.source);
        const source: KernelRequest['source'] = ['channel', 'desktop', 'voice', 'webhook'].includes(rawSource)
          ? rawSource as KernelRequest['source']
          : 'channel';
        const channelId = row.channel_id === null || row.channel_id === undefined ? null : String(row.channel_id);
        const request: KernelRequest = {
          requestId,
          source,
          organizationId: String(row.organization_id),
          principalId: String(row.principal_id),
          channelId,
          conversationId: String(row.conversation_id),
          inputMessageId: String(row.input_message_id),
          message: 'Recovered committed dispatch plan',
          preferredAgentId: String(row.worker_agent_id),
          projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
          workers: [{
            agentId: String(row.worker_agent_id),
            engineId: String(row.worker_engine_id),
            name: 'Recovered dispatch worker',
            role: '',
            capabilities: []
          }],
          memories: []
        };
        this.capture(request, { ...plan, taskScheduleProposals: proposals });
        recoveredProposals += Math.max(0, proposals.length - existingCount);
      } catch (error) {
        failedPlans += 1;
        const detail = error instanceof Error ? error.message : String(error);
        try {
          this.db.transaction(() => this.db.audit({
            id: randomUUID(), actor: 'system', action: 'task_schedule.proposal.recover',
            target: requestId, result: `failed:${detail.slice(0, 500)}`, source: 'startup'
          }));
        } catch {
          // Recovery is best-effort; a broken audit sink must not block startup.
        }
      }
    }
    return { scannedPlans: rows.length, recoveredProposals, failedPlans };
  }

  capture(request: KernelRequest, plan: DispatchPlan): TaskScheduleProposalRecord[] {
    this.assertCommittedPlan(request, plan);
    if (!Array.isArray(plan.taskScheduleProposals)) throw new Error('task schedule proposals must be an array');
    if (plan.taskScheduleProposals.length === 0) return [];
    if (plan.taskScheduleProposals.length > 10) throw new Error('task schedule proposals must contain at most 10 items');
    const createdAt = this.now();
    const records: TaskScheduleProposalRecord[] = [];

    this.db.transaction(() => {
      for (const [proposalIndex, proposal] of plan.taskScheduleProposals.entries()) {
        const normalized = this.normalizeProposal(proposal);
        const candidate: TaskScheduleProposalRecord = {
          id: randomUUID(), requestId: request.requestId, proposalIndex,
          organizationId: request.organizationId, principalId: request.principalId,
          channelId: request.channelId, conversationId: request.conversationId,
          agentId: plan.workerAgentId, projectId: request.projectId,
          ...normalized, status: 'pending', proposedBy: plan.leaderKernel,
          decidedBy: null, decisionReason: null, scheduleId: null,
          createdAt, decidedAt: null
        };
        const inserted = this.db.raw.prepare(
          `INSERT INTO task_schedule_proposals(
            id, request_id, proposal_index, organization_id, principal_id, channel_id,
            conversation_id, agent_id, project_id, operation, title, content,
            cron_kind, cron_value, status, proposed_by, decided_by, decision_reason,
            schedule_id, created_at, decided_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'create_task_schedule', ?, ?, ?, ?,
                   'pending', ?, NULL, NULL, NULL, ?, NULL)
          ON CONFLICT(request_id, proposal_index) DO NOTHING`
        ).run(
          candidate.id, candidate.requestId, candidate.proposalIndex, candidate.organizationId,
          candidate.principalId, candidate.channelId, candidate.conversationId, candidate.agentId,
          candidate.projectId, candidate.title, candidate.content, candidate.cronKind,
          candidate.cronValue, candidate.proposedBy, candidate.createdAt
        ).changes;
        const stored = this.byRequestIndex(candidate.requestId, candidate.proposalIndex);
        if (!stored || !this.matchesCandidate(stored, candidate)) {
          throw new Error('request already has a different task schedule proposal');
        }
        this.db.audit({
          id: randomUUID(), actor: plan.leaderKernel, action: 'task_schedule.proposal.capture',
          target: stored.id, result: inserted === 1 ? 'pending' : 'deduplicated', source: request.source
        });
        records.push(stored);
      }
    });
    return records;
  }

  list(input: ListTaskScheduleProposalsInput): TaskScheduleProposalRecord[] {
    const organizationId = required(input.organizationId, 'organizationId');
    this.assertOrganization(organizationId);
    const status = input.status ?? 'pending';
    if (!['pending', 'accepted', 'rejected', 'all'].includes(status)) {
      throw new Error('task schedule proposal status is invalid');
    }
    const limit = boundedLimit(input.limit, 100, 200);
    const rows = status === 'all'
      ? this.db.raw.prepare(
        'SELECT * FROM task_schedule_proposals WHERE organization_id = ? ORDER BY created_at DESC, proposal_index ASC LIMIT ?'
      ).all(organizationId, limit) as Row[]
      : this.db.raw.prepare(
        `SELECT * FROM task_schedule_proposals WHERE organization_id = ? AND status = ?
         ORDER BY created_at DESC, proposal_index ASC LIMIT ?`
      ).all(organizationId, status, limit) as Row[];
    return rows.map((row) => this.map(row));
  }

  accept(input: DecideTaskScheduleProposalInput): AcceptedTaskScheduleProposal {
    const organizationId = required(input.organizationId, 'organizationId');
    const proposalId = required(input.proposalId, 'proposalId');
    const actor = required(input.actor, 'actor');
    const reason = optionalReason(input.reason);
    const current = this.get(organizationId, proposalId);
    if (!current) throw new Error('task schedule proposal was not found');
    if (current.status === 'rejected') throw new Error('rejected task schedule proposal cannot be accepted');
    if (current.status === 'accepted') {
      if (!current.scheduleId) throw new Error('accepted task schedule proposal has no schedule');
      const schedule = this.scheduler.list().find((item) => item.id === current.scheduleId);
      if (!schedule) throw new Error('accepted task schedule proposal points to missing schedule');
      return { proposal: current, schedule };
    }
    this.assertOwnedTarget(current);

    const decidedAt = this.now();
    const schedule = this.scheduler.createWithCommit({
      automationKind: 'task',
      agentId: current.agentId,
      projectId: current.projectId ?? undefined,
      title: current.title,
      content: current.content,
      cronKind: current.cronKind,
      cronValue: current.cronValue
    }, actor, (created) => {
      const changed = this.db.raw.prepare(
        `UPDATE task_schedule_proposals SET status = 'accepted', decided_by = ?,
           decision_reason = ?, schedule_id = ?, decided_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'pending'`
      ).run(actor, reason, created.id, decidedAt, proposalId, organizationId).changes;
      if (changed !== 1) throw new Error('task schedule proposal decision conflict');
      this.db.audit({
        id: randomUUID(), actor, action: 'task_schedule.proposal.accept', target: proposalId,
        result: created.id, source: input.source
      });
    });
    const proposal = this.get(organizationId, proposalId);
    if (!proposal) throw new Error('accepted task schedule proposal was not found');
    return { proposal, schedule };
  }

  reject(input: DecideTaskScheduleProposalInput): TaskScheduleProposalRecord {
    const organizationId = required(input.organizationId, 'organizationId');
    const proposalId = required(input.proposalId, 'proposalId');
    const actor = required(input.actor, 'actor');
    const reason = optionalReason(input.reason);
    const current = this.get(organizationId, proposalId);
    if (!current) throw new Error('task schedule proposal was not found');
    if (current.status === 'accepted') throw new Error('accepted task schedule proposal cannot be rejected');
    if (current.status === 'rejected') return current;
    const decidedAt = this.now();
    this.db.transaction(() => {
      const changed = this.db.raw.prepare(
        `UPDATE task_schedule_proposals SET status = 'rejected', decided_by = ?,
           decision_reason = ?, decided_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'pending'`
      ).run(actor, reason, decidedAt, proposalId, organizationId).changes;
      if (changed !== 1) throw new Error('task schedule proposal decision conflict');
      this.db.audit({
        id: randomUUID(), actor, action: 'task_schedule.proposal.reject', target: proposalId,
        result: reason ?? 'rejected', source: input.source
      });
    });
    const proposal = this.get(organizationId, proposalId);
    if (!proposal) throw new Error('rejected task schedule proposal was not found');
    return proposal;
  }

  private normalizeProposal(proposal: TaskScheduleProposal): TaskScheduleProposal {
    if (proposal.operation !== 'create_task_schedule') throw new Error('task schedule proposal operation is invalid');
    if (!['interval', 'daily', 'weekly', 'monthly'].includes(proposal.cronKind)) {
      throw new Error('task schedule proposal cronKind is invalid');
    }
    return {
      operation: 'create_task_schedule',
      title: required(proposal.title, 'task schedule proposal title', 160),
      content: required(proposal.content, 'task schedule proposal content', 4_000),
      cronKind: proposal.cronKind,
      cronValue: normalizedCron(proposal.cronKind, proposal.cronValue)
    };
  }

  private get(organizationId: string, proposalId: string): TaskScheduleProposalRecord | null {
    this.assertOrganization(organizationId);
    const row = this.db.raw.prepare(
      'SELECT * FROM task_schedule_proposals WHERE id = ? AND organization_id = ? LIMIT 1'
    ).get(proposalId, organizationId) as Row | undefined;
    return row ? this.map(row) : null;
  }

  private byRequestIndex(requestId: string, proposalIndex: number): TaskScheduleProposalRecord | null {
    const row = this.db.raw.prepare(
      'SELECT * FROM task_schedule_proposals WHERE request_id = ? AND proposal_index = ? LIMIT 1'
    ).get(requestId, proposalIndex) as Row | undefined;
    return row ? this.map(row) : null;
  }

  private assertOrganization(organizationId: string): void {
    const row = this.db.raw.prepare('SELECT id FROM organizations WHERE id = ? LIMIT 1')
      .get(organizationId) as Row | undefined;
    if (!row) throw new Error('organization was not found');
  }

  private assertOwnedTarget(proposal: TaskScheduleProposalRecord): void {
    const agent = this.db.raw.prepare(
      'SELECT id FROM agents WHERE id = ? AND organization_id = ? AND archived = 0 LIMIT 1'
    ).get(proposal.agentId, proposal.organizationId) as Row | undefined;
    if (!agent) throw new Error('task schedule proposal worker is not available in this organization');
    if (!proposal.projectId) return;
    const project = this.db.raw.prepare(
      "SELECT id FROM projects WHERE id = ? AND organization_id = ? AND status != 'archived' LIMIT 1"
    ).get(proposal.projectId, proposal.organizationId) as Row | undefined;
    if (!project) throw new Error('task schedule proposal project is not available in this organization');
  }

  private assertCommittedPlan(request: KernelRequest, plan: DispatchPlan): void {
    if (request.requestId !== plan.requestId || request.conversationId !== plan.conversationId) {
      throw new Error('dispatch plan does not belong to the kernel request');
    }
    const row = this.db.raw.prepare(
      `SELECT dp.status, dp.organization_id, dp.principal_id, dp.channel_id,
              dp.conversation_id, dp.input_message_id, dp.worker_agent_id,
              dp.worker_engine_id, dp.leader_kernel, dp.plan_json, t.source, t.project_id
       FROM dispatch_plans dp LEFT JOIN tasks t ON t.id = dp.task_id
       WHERE dp.request_id = ? LIMIT 1`
    ).get(request.requestId) as Row | undefined;
    if (!row || row.status !== 'committed') throw new Error('task schedule proposals require a committed dispatch plan');
    const nullable = (value: unknown): string | null => value === null || value === undefined ? null : String(value);
    const matches = String(row.organization_id) === request.organizationId
      && String(row.principal_id) === request.principalId
      && nullable(row.channel_id) === request.channelId
      && String(row.conversation_id) === request.conversationId
      && String(row.input_message_id) === request.inputMessageId
      && String(row.worker_agent_id) === plan.workerAgentId
      && String(row.worker_engine_id) === plan.workerEngineId
      && String(row.leader_kernel) === plan.leaderKernel
      && nullable(row.project_id) === request.projectId
      && String(row.source) === request.source;
    if (!matches) throw new Error('committed dispatch plan context does not match task schedule proposals');
    const storedPlan = JSON.parse(String(row.plan_json)) as Partial<DispatchPlan>;
    const storedProposals = Array.isArray(storedPlan.taskScheduleProposals) ? storedPlan.taskScheduleProposals : [];
    if (JSON.stringify(storedProposals) !== JSON.stringify(plan.taskScheduleProposals)) {
      throw new Error('task schedule proposals do not match the committed dispatch plan');
    }
  }

  private matchesCandidate(stored: TaskScheduleProposalRecord, candidate: TaskScheduleProposalRecord): boolean {
    return stored.requestId === candidate.requestId
      && stored.proposalIndex === candidate.proposalIndex
      && stored.organizationId === candidate.organizationId
      && stored.principalId === candidate.principalId
      && stored.channelId === candidate.channelId
      && stored.conversationId === candidate.conversationId
      && stored.agentId === candidate.agentId
      && stored.projectId === candidate.projectId
      && stored.operation === candidate.operation
      && stored.title === candidate.title
      && stored.content === candidate.content
      && stored.cronKind === candidate.cronKind
      && stored.cronValue === candidate.cronValue
      && stored.proposedBy === candidate.proposedBy;
  }

  private map(row: Row): TaskScheduleProposalRecord {
    const nullableString = (value: unknown) => value === null || value === undefined ? null : String(value);
    const nullableNumber = (value: unknown) => value === null || value === undefined ? null : Number(value);
    return {
      id: String(row.id),
      requestId: String(row.request_id),
      proposalIndex: Number(row.proposal_index),
      organizationId: String(row.organization_id),
      principalId: nullableString(row.principal_id),
      channelId: nullableString(row.channel_id),
      conversationId: String(row.conversation_id),
      agentId: String(row.agent_id),
      projectId: nullableString(row.project_id),
      operation: 'create_task_schedule',
      title: String(row.title),
      content: String(row.content),
      cronKind: String(row.cron_kind) as TaskScheduleCronKind,
      cronValue: String(row.cron_value),
      status: String(row.status) as TaskScheduleProposalStatus,
      proposedBy: String(row.proposed_by),
      decidedBy: nullableString(row.decided_by),
      decisionReason: nullableString(row.decision_reason),
      scheduleId: nullableString(row.schedule_id),
      createdAt: Number(row.created_at),
      decidedAt: nullableNumber(row.decided_at)
    };
  }
}
