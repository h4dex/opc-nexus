import { randomUUID } from 'node:crypto';
import type { Database } from './database.js';
import type { MemoryItem, MemoryScopeContext, MemoryService } from './memoryService.js';
import type { DispatchPlan, KernelRequest, MemoryProposalScope } from './kernel/types.js';

export const AUTO_ACCEPT_CONVERSATION_MEMORY_SETTING = 'memory:autoAcceptConversationProposals';

export type MemoryProposalStatus = 'pending' | 'accepted' | 'rejected';

export interface MemoryProposalRecord {
  id: string;
  requestId: string;
  proposalIndex: number;
  organizationId: string;
  principalId: string | null;
  channelId: string | null;
  conversationId: string | null;
  agentId: string | null;
  projectId: string | null;
  operation: 'remember';
  kind: string;
  content: string;
  importance: number;
  scopeType: MemoryProposalScope;
  scopeId: string;
  status: MemoryProposalStatus;
  proposedBy: string;
  decidedBy: string | null;
  decisionReason: string | null;
  memoryId: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface ListMemoryProposalsInput {
  organizationId: string;
  status?: MemoryProposalStatus | 'all';
  limit?: number;
}

export interface DecideMemoryProposalInput {
  organizationId: string;
  proposalId: string;
  actor: string;
  reason?: string;
  source?: string;
}

export interface AcceptedMemoryProposal {
  proposal: MemoryProposalRecord;
  memory: MemoryItem;
}

export interface MemoryProposalRecoveryResult {
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

/**
 * Durable review queue for prompt-originated memory suggestions. A proposal is
 * never canonical memory until this service accepts it through MemoryService.
 */
export class MemoryProposalService {
  constructor(
    private readonly db: Database,
    private readonly memory: MemoryService,
    private readonly now: () => number = Date.now
  ) {}

  recoverCommitted(): MemoryProposalRecoveryResult {
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
        if (!Array.isArray(plan.memoryProposals) || plan.memoryProposals.length === 0) continue;
        const existing = this.db.raw.prepare(
          'SELECT COUNT(*) AS count FROM memory_proposals WHERE request_id = ?'
        ).get(requestId) as Row | undefined;
        const existingCount = Number(existing?.count ?? 0);
        if (existingCount === plan.memoryProposals.length) continue;
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
        this.capture(request, plan);
        recoveredProposals += Math.max(0, plan.memoryProposals.length - existingCount);
      } catch (error) {
        failedPlans += 1;
        const detail = error instanceof Error ? error.message : String(error);
        try {
          this.db.transaction(() => this.db.audit({
            id: randomUUID(), actor: 'system', action: 'memory.proposal.recover',
            target: requestId, result: `failed:${detail.slice(0, 500)}`, source: 'startup'
          }));
        } catch {
          // Recovery is best-effort; a broken audit sink must not block startup.
        }
      }
    }
    return { scannedPlans: rows.length, recoveredProposals, failedPlans };
  }

  capture(request: KernelRequest, plan: DispatchPlan): MemoryProposalRecord[] {
    this.assertCommittedPlan(request, plan);
    if (plan.memoryProposals.length === 0) return [];
    const createdAt = this.now();
    const records: MemoryProposalRecord[] = [];

    this.db.transaction(() => {
      for (const [proposalIndex, proposal] of plan.memoryProposals.entries()) {
        const kind = required(proposal.kind, 'memory proposal kind', 80).toLowerCase();
        if (!/^[a-z0-9][a-z0-9._:-]*$/.test(kind)) {
          throw new Error('memory proposal kind is invalid');
        }
        const content = required(proposal.content, 'memory proposal content', 4_000);
        if (!Number.isFinite(proposal.importance) || proposal.importance < 0 || proposal.importance > 1) {
          throw new Error('memory proposal importance must be between 0 and 1');
        }
        const scopeId = this.scopeId(request, plan, proposal.scope);
        const candidate = {
          id: randomUUID(), requestId: request.requestId, proposalIndex,
          organizationId: request.organizationId, principalId: request.principalId,
          channelId: request.channelId, conversationId: request.conversationId,
          agentId: plan.workerAgentId, projectId: request.projectId,
          operation: 'remember' as const, kind, content, importance: proposal.importance,
          scopeType: proposal.scope, scopeId, status: 'pending' as const,
          proposedBy: plan.leaderKernel, decidedBy: null, decisionReason: null,
          memoryId: null, createdAt, decidedAt: null
        };
        const inserted = this.db.raw.prepare(
          `INSERT INTO memory_proposals(
            id, request_id, proposal_index, organization_id, principal_id, channel_id,
            conversation_id, agent_id, project_id, operation, kind, content, importance,
            scope_type, scope_id, status, proposed_by, decided_by, decision_reason,
            memory_id, created_at, decided_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'remember', ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, ?, NULL)
          ON CONFLICT(request_id, proposal_index) DO NOTHING`
        ).run(
          candidate.id, candidate.requestId, candidate.proposalIndex, candidate.organizationId,
          candidate.principalId, candidate.channelId, candidate.conversationId, candidate.agentId,
          candidate.projectId, candidate.kind, candidate.content, candidate.importance,
          candidate.scopeType, candidate.scopeId, candidate.proposedBy, candidate.createdAt
        ).changes;
        const stored = this.byRequestIndex(candidate.requestId, candidate.proposalIndex);
        if (!stored || !this.matchesCandidate(stored, candidate)) {
          throw new Error('request already has a different memory proposal');
        }
        this.db.audit({
          id: randomUUID(), actor: plan.leaderKernel, action: 'memory.proposal.capture',
          target: stored.id, result: inserted === 1 ? 'pending' : 'deduplicated', source: request.source
        });
        records.push(stored);
      }
    });

    if (this.db.getSetting<boolean>(AUTO_ACCEPT_CONVERSATION_MEMORY_SETTING, false) === true) {
      for (const proposal of records) {
        if (proposal.scopeType !== 'conversation' || proposal.status !== 'pending') continue;
        try {
          this.accept({
            organizationId: proposal.organizationId,
            proposalId: proposal.id,
            actor: 'memory-policy',
            reason: 'Local conversation auto-accept setting is enabled',
            source: request.source
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.db.transaction(() => this.db.audit({
            id: randomUUID(), actor: 'memory-policy', action: 'memory.proposal.auto_accept',
            target: proposal.id, result: `failed:${detail.slice(0, 500)}`, source: request.source
          }));
        }
      }
    }
    return records.map((record) => this.get(record.organizationId, record.id) ?? record);
  }

  list(input: ListMemoryProposalsInput): MemoryProposalRecord[] {
    const organizationId = required(input.organizationId, 'organizationId');
    this.assertOrganization(organizationId);
    const status = input.status ?? 'pending';
    if (!['pending', 'accepted', 'rejected', 'all'].includes(status)) {
      throw new Error('memory proposal status is invalid');
    }
    const limit = boundedLimit(input.limit, 100, 200);
    const rows = status === 'all'
      ? this.db.raw.prepare(
        'SELECT * FROM memory_proposals WHERE organization_id = ? ORDER BY created_at DESC, proposal_index ASC LIMIT ?'
      ).all(organizationId, limit) as Row[]
      : this.db.raw.prepare(
        `SELECT * FROM memory_proposals WHERE organization_id = ? AND status = ?
         ORDER BY created_at DESC, proposal_index ASC LIMIT ?`
      ).all(organizationId, status, limit) as Row[];
    return rows.map((row) => this.map(row));
  }

  accept(input: DecideMemoryProposalInput): AcceptedMemoryProposal {
    const organizationId = required(input.organizationId, 'organizationId');
    const proposalId = required(input.proposalId, 'proposalId');
    const actor = required(input.actor, 'actor');
    const reason = optionalReason(input.reason);
    const current = this.get(organizationId, proposalId);
    if (!current) throw new Error('memory proposal was not found');
    if (current.status === 'rejected') throw new Error('rejected memory proposal cannot be accepted');
    if (current.status === 'accepted') {
      if (!current.memoryId) throw new Error('accepted memory proposal has no memory');
      const memory = this.memory.get(organizationId, current.memoryId);
      if (!memory) throw new Error('accepted memory proposal points to missing memory');
      return { proposal: current, memory };
    }

    const decidedAt = this.now();
    const memory = this.memory.rememberWithCommit({
      ...this.memoryScope(current),
      kind: current.kind,
      content: current.content,
      importance: current.importance,
      actor,
      source: input.source ?? 'desktop'
    }, (remembered) => {
      const changed = this.db.raw.prepare(
        `UPDATE memory_proposals SET status = 'accepted', decided_by = ?, decision_reason = ?,
           memory_id = ?, decided_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'pending'`
      ).run(actor, reason, remembered.id, decidedAt, proposalId, organizationId).changes;
      if (changed !== 1) throw new Error('memory proposal decision conflict');
      this.db.audit({
        id: randomUUID(), actor, action: 'memory.proposal.accept', target: proposalId,
        result: remembered.id, source: input.source
      });
    });
    const proposal = this.get(organizationId, proposalId);
    if (!proposal) throw new Error('accepted memory proposal was not found');
    return { proposal, memory };
  }

  reject(input: DecideMemoryProposalInput): MemoryProposalRecord {
    const organizationId = required(input.organizationId, 'organizationId');
    const proposalId = required(input.proposalId, 'proposalId');
    const actor = required(input.actor, 'actor');
    const reason = optionalReason(input.reason);
    const current = this.get(organizationId, proposalId);
    if (!current) throw new Error('memory proposal was not found');
    if (current.status === 'accepted') throw new Error('accepted memory proposal cannot be rejected');
    if (current.status === 'rejected') return current;
    const decidedAt = this.now();
    this.db.transaction(() => {
      const changed = this.db.raw.prepare(
        `UPDATE memory_proposals SET status = 'rejected', decided_by = ?, decision_reason = ?, decided_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'pending'`
      ).run(actor, reason, decidedAt, proposalId, organizationId).changes;
      if (changed !== 1) throw new Error('memory proposal decision conflict');
      this.db.audit({
        id: randomUUID(), actor, action: 'memory.proposal.reject', target: proposalId,
        result: reason ?? 'rejected', source: input.source
      });
    });
    const proposal = this.get(organizationId, proposalId);
    if (!proposal) throw new Error('rejected memory proposal was not found');
    return proposal;
  }

  private get(organizationId: string, proposalId: string): MemoryProposalRecord | null {
    this.assertOrganization(organizationId);
    const row = this.db.raw.prepare(
      'SELECT * FROM memory_proposals WHERE id = ? AND organization_id = ? LIMIT 1'
    ).get(proposalId, organizationId) as Row | undefined;
    return row ? this.map(row) : null;
  }

  private byRequestIndex(requestId: string, proposalIndex: number): MemoryProposalRecord | null {
    const row = this.db.raw.prepare(
      'SELECT * FROM memory_proposals WHERE request_id = ? AND proposal_index = ? LIMIT 1'
    ).get(requestId, proposalIndex) as Row | undefined;
    return row ? this.map(row) : null;
  }

  private assertOrganization(organizationId: string): void {
    const row = this.db.raw.prepare('SELECT id FROM organizations WHERE id = ? LIMIT 1')
      .get(organizationId) as Row | undefined;
    if (!row) throw new Error('organization was not found');
  }

  private assertCommittedPlan(request: KernelRequest, plan: DispatchPlan): void {
    if (request.requestId !== plan.requestId || request.conversationId !== plan.conversationId) {
      throw new Error('dispatch plan does not belong to the kernel request');
    }
    const row = this.db.raw.prepare(
      `SELECT status, organization_id, principal_id, channel_id, conversation_id,
              input_message_id, worker_agent_id, worker_engine_id, leader_kernel
       FROM dispatch_plans WHERE request_id = ? LIMIT 1`
    ).get(request.requestId) as Row | undefined;
    if (!row || row.status !== 'committed') throw new Error('memory proposals require a committed dispatch plan');
    const matches = String(row.organization_id) === request.organizationId
      && String(row.principal_id) === request.principalId
      && (row.channel_id === null || row.channel_id === undefined ? null : String(row.channel_id)) === request.channelId
      && String(row.conversation_id) === request.conversationId
      && String(row.input_message_id) === request.inputMessageId
      && String(row.worker_agent_id) === plan.workerAgentId
      && String(row.worker_engine_id) === plan.workerEngineId
      && String(row.leader_kernel) === plan.leaderKernel;
    if (!matches) throw new Error('committed dispatch plan context does not match memory proposals');
  }

  private scopeId(request: KernelRequest, plan: DispatchPlan, scope: MemoryProposalScope): string {
    switch (scope) {
      case 'principal': return required(request.principalId, 'principalId');
      case 'channel': return required(request.channelId, 'channelId');
      case 'conversation': return required(request.conversationId, 'conversationId');
      case 'agent': return required(plan.workerAgentId, 'workerAgentId');
      case 'project': return required(request.projectId, 'projectId');
    }
  }

  private memoryScope(proposal: MemoryProposalRecord): MemoryScopeContext {
    const organizationId = proposal.organizationId;
    switch (proposal.scopeType) {
      case 'principal': return { organizationId, principalId: proposal.scopeId };
      case 'channel': return { organizationId, channelId: proposal.scopeId };
      case 'conversation': return {
        organizationId,
        principalId: proposal.principalId,
        channelId: proposal.channelId,
        conversationId: proposal.scopeId
      };
      case 'agent': return { organizationId, agentId: proposal.scopeId };
      case 'project': return { organizationId, projectId: proposal.scopeId };
    }
  }

  private matchesCandidate(stored: MemoryProposalRecord, candidate: MemoryProposalRecord): boolean {
    return stored.requestId === candidate.requestId
      && stored.proposalIndex === candidate.proposalIndex
      && stored.organizationId === candidate.organizationId
      && stored.principalId === candidate.principalId
      && stored.channelId === candidate.channelId
      && stored.conversationId === candidate.conversationId
      && stored.agentId === candidate.agentId
      && stored.projectId === candidate.projectId
      && stored.operation === candidate.operation
      && stored.kind === candidate.kind
      && stored.content === candidate.content
      && stored.importance === candidate.importance
      && stored.scopeType === candidate.scopeType
      && stored.scopeId === candidate.scopeId
      && stored.proposedBy === candidate.proposedBy;
  }

  private map(row: Row): MemoryProposalRecord {
    const nullableString = (value: unknown) => value === null || value === undefined ? null : String(value);
    const nullableNumber = (value: unknown) => value === null || value === undefined ? null : Number(value);
    return {
      id: String(row.id),
      requestId: String(row.request_id),
      proposalIndex: Number(row.proposal_index),
      organizationId: String(row.organization_id),
      principalId: nullableString(row.principal_id),
      channelId: nullableString(row.channel_id),
      conversationId: nullableString(row.conversation_id),
      agentId: nullableString(row.agent_id),
      projectId: nullableString(row.project_id),
      operation: 'remember',
      kind: String(row.kind),
      content: String(row.content),
      importance: Number(row.importance),
      scopeType: String(row.scope_type) as MemoryProposalScope,
      scopeId: String(row.scope_id),
      status: String(row.status) as MemoryProposalStatus,
      proposedBy: String(row.proposed_by),
      decidedBy: nullableString(row.decided_by),
      decisionReason: nullableString(row.decision_reason),
      memoryId: nullableString(row.memory_id),
      createdAt: Number(row.created_at),
      decidedAt: nullableNumber(row.decided_at)
    };
  }
}
