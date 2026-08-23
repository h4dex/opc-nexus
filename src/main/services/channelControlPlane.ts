import { randomUUID } from 'node:crypto';
import type { Database } from './database.js';
import type { ChannelIngressResult } from './channelIngressService.js';
import type { CreateTaskResult, Orchestrator } from './orchestrator.js';
import type { MemoryService } from './memoryService.js';
import type { MemoryProposalService } from './memoryProposalService.js';
import type { TaskScheduleProposalService } from './taskScheduleProposalService.js';
import type { DatabaseKernelState } from './kernel/databaseKernelState.js';
import type { KernelRouter } from './kernel/kernelRouter.js';
import type { KernelRequest, WorkerCandidate } from './kernel/types.js';

export interface ChannelControlPlaneInput {
  ingress: ChannelIngressResult;
  message: string;
  preferredAgentId: string;
  projectId?: string | null;
}

export interface CanonicalControlPlaneInput {
  source: KernelRequest['source'];
  organizationId: string;
  principalId: string;
  channelId: string | null;
  conversationId: string;
  inputMessageId: string;
  message: string;
  preferredAgentId: string;
  projectId?: string | null;
  routingMode?: KernelRequest['routingMode'];
}

type Row = Record<string, unknown>;

function stringArray(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function enabledCapabilities(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.entries(parsed).filter(([, enabled]) => enabled === true).map(([name]) => name);
  } catch {
    return [];
  }
}

function workerCandidate(row: Row): WorkerCandidate {
  return {
    agentId: String(row.id),
    name: String(row.name),
    role: String(row.role),
    engineId: String(row.engine_id),
    capabilities: [
      ...enabledCapabilities(row.capabilities_json),
      ...stringArray(row.tags_json).map((tag) => `tag:${tag}`)
    ]
  };
}

/**
 * Converts a canonical inbound message into one durable dispatch plan and
 * commits it through Orchestrator. Kernels cannot create tasks directly.
 */
export class ChannelControlPlane {
  private readonly requestTails = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Database,
    private readonly orchestrator: Orchestrator,
    private readonly router: Pick<KernelRouter, 'plan'>,
    private readonly memory: Pick<MemoryService, 'recall'>,
    private readonly state: DatabaseKernelState,
    private readonly proposals?: Pick<MemoryProposalService, 'capture'>,
    private readonly scheduleProposals?: Pick<TaskScheduleProposalService, 'capture'>
  ) {}

  async dispatch(input: ChannelControlPlaneInput): Promise<CreateTaskResult> {
    return this.dispatchCanonical({
      source: 'channel',
      organizationId: input.ingress.organizationId,
      principalId: input.ingress.principalId,
      channelId: input.ingress.channelId,
      conversationId: input.ingress.conversationId,
      inputMessageId: input.ingress.messageId,
      message: input.message,
      preferredAgentId: input.preferredAgentId,
      projectId: input.projectId,
      // Legacy channel ingress is only a compatibility path. Hermes owns
      // project conversations; if this path is used, execute only the
      // explicitly selected worker and never promote a CLI to a scheduler.
      routingMode: 'direct-worker'
    });
  }

  async dispatchCanonical(input: CanonicalControlPlaneInput): Promise<CreateTaskResult> {
    const requestId = `kernel:${input.inputMessageId}`;
    return this.withRequestLock(requestId, () => this.dispatchUnlocked(input, requestId));
  }

  private async dispatchUnlocked(input: CanonicalControlPlaneInput, requestId: string): Promise<CreateTaskResult> {
    const existing = this.state.findPlan(requestId);
    if (existing?.status === 'failed') throw new Error('该消息的调度计划已失败，请在控制中心重试');
    const request = existing
      ? this.buildPersistedRequest(input, existing.plan.workerAgentId, existing.plan.workerEngineId)
      : this.buildRequest(input);
    const plan = existing?.plan ?? await this.router.plan(request);
    const task = this.orchestrator.applyDispatchPlan(request, plan, this.state);
    if (this.proposals) {
      try {
        this.proposals.capture(request, plan);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.db.audit({
          id: randomUUID(), actor: 'system', action: 'memory.proposal.capture',
          target: request.requestId, result: `failed:${detail.slice(0, 500)}`, source: request.source
        });
      }
    }
    if (this.scheduleProposals) {
      try {
        this.scheduleProposals.capture(request, plan);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.db.audit({
          id: randomUUID(), actor: 'system', action: 'task_schedule.proposal.capture',
          target: request.requestId, result: `failed:${detail.slice(0, 500)}`, source: request.source
        });
      }
    }
    return task;
  }

  private buildPersistedRequest(input: CanonicalControlPlaneInput, agentId: string, engineId: string): KernelRequest {
    const worker = this.persistedWorker(input.organizationId, agentId, engineId);
    if (!worker) throw new Error('Persisted dispatch worker is no longer eligible');
    return {
      requestId: `kernel:${input.inputMessageId}`,
      source: input.source,
      organizationId: input.organizationId,
      principalId: input.principalId,
      channelId: input.channelId,
      conversationId: input.conversationId,
      inputMessageId: input.inputMessageId,
      message: input.message,
      routingMode: 'direct-worker',
      preferredAgentId: agentId,
      projectId: input.projectId ?? null,
      workers: [worker],
      memories: []
    };
  }

  private async withRequestLock<T>(requestId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.requestTails.get(requestId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    this.requestTails.set(requestId, tail);
    await previous.catch(() => {});
    try {
      return await run();
    } finally {
      release();
      if (this.requestTails.get(requestId) === tail) this.requestTails.delete(requestId);
    }
  }

  private buildRequest(input: CanonicalControlPlaneInput): KernelRequest {
    const workers = this.eligibleWorkers(input.organizationId);
    if (workers.length === 0) throw new Error('没有已就绪且引擎健康的执行员工');
    const preferred = workers.some((worker) => worker.agentId === input.preferredAgentId)
      ? input.preferredAgentId
      : null;
    // Hermes is the only planner. This legacy dispatch plane may execute an
    // explicitly selected worker, but it never selects a CLI as an
    // owner-facing control kernel.
    const routingMode = 'direct-worker' as const;
    const recallContext = {
      organizationId: input.organizationId,
      principalId: input.principalId,
      channelId: input.channelId,
      conversationId: input.conversationId,
      projectId: input.projectId ?? null,
      query: input.message
    };
    const recalled = this.memory.recall({ ...recallContext, agentId: null, limit: 20 });
    const workerMemory = workers.flatMap((worker) => this.memory.recall({
      ...recallContext,
      agentId: worker.agentId,
      limit: 3
    }).filter((item) => item.scopes.some((scope) => scope.type === 'agent' && scope.id === worker.agentId))
      .map((item) => ({ ...item, agentId: worker.agentId })));
    const memories = new Map(recalled.map((item) => [item.id, item]));
    for (const item of workerMemory) memories.set(item.id, item);
    return {
      requestId: `kernel:${input.inputMessageId}`,
      source: input.source,
      organizationId: input.organizationId,
      principalId: input.principalId,
      channelId: input.channelId,
      conversationId: input.conversationId,
      inputMessageId: input.inputMessageId,
      message: input.message,
      routingMode,
      preferredAgentId: preferred,
      projectId: input.projectId ?? null,
      workers,
      memories: [...memories.values()].map((item) => ({
        id: item.id,
        kind: item.kind,
        content: item.content,
        importance: item.importance,
        ...('agentId' in item && typeof item.agentId === 'string' ? { agentId: item.agentId } : {})
      }))
    };
  }

  private eligibleWorkers(organizationId: string): WorkerCandidate[] {
    const rows = this.db.raw.prepare(
      `SELECT a.id, a.name, a.role, a.engine_id, a.capabilities_json, a.tags_json
       FROM agents a JOIN engines e ON e.id = a.engine_id
       WHERE a.organization_id = ?
         AND a.archived = 0 AND a.lifecycle = 'READY' AND e.status = 'HEALTHY'
       ORDER BY a.created_at ASC LIMIT 100`
    ).all(organizationId) as Row[];
    return rows.map(workerCandidate);
  }

  private persistedWorker(organizationId: string, agentId: string, engineId: string): WorkerCandidate | null {
    const row = this.db.raw.prepare(
      `SELECT a.id, a.name, a.role, a.engine_id, a.capabilities_json, a.tags_json
       FROM agents a JOIN engines e ON e.id = a.engine_id
       WHERE a.organization_id = ? AND a.id = ? AND a.engine_id = ?
         AND a.archived = 0 AND a.lifecycle = 'READY' AND e.status = 'HEALTHY'
       LIMIT 1`
    ).get(organizationId, agentId, engineId) as Row | undefined;
    return row ? workerCandidate(row) : null;
  }
}
