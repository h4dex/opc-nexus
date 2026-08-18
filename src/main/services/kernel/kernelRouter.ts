import type {
  ControlKernel,
  DispatchPlan,
  DispatchPlanDraft,
  KernelAttemptRecord,
  KernelAttemptRecorder,
  KernelRequest,
  WorkerCandidate
} from './types.js';

const MAX_MESSAGE_CHARS = 1_000_000;
const MAX_OBJECTIVE_CHARS = 16_000;
const MAX_MEMORY_PROPOSALS = 20;
const MAX_TASK_SCHEDULE_PROPOSALS = 10;
const NOOP_RECORDER: KernelAttemptRecorder = { record: () => {} };

export class KernelRoutingError extends Error {
  constructor(message: string, readonly failures: string[]) {
    super(message);
    this.name = 'KernelRoutingError';
  }
}

function cleanText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const text = value.trim();
  if (!text) throw new Error(`${field} cannot be empty`);
  if (text.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return text;
}

function validateRequest(request: KernelRequest): void {
  cleanText(request.requestId, 'requestId', 200);
  if (!['channel', 'desktop', 'voice', 'webhook'].includes(request.source)) {
    throw new Error('source must be channel, desktop, voice or webhook');
  }
  cleanText(request.organizationId, 'organizationId', 200);
  cleanText(request.principalId, 'principalId', 200);
  if (request.channelId !== null) cleanText(request.channelId, 'channelId', 200);
  cleanText(request.conversationId, 'conversationId', 200);
  cleanText(request.inputMessageId, 'inputMessageId', 200);
  cleanText(request.message, 'message', MAX_MESSAGE_CHARS);
  if (request.workers.length === 0) throw new Error('No eligible worker is available');
  const ids = new Set<string>();
  for (const worker of request.workers) {
    cleanText(worker.agentId, 'worker.agentId', 200);
    cleanText(worker.engineId, 'worker.engineId', 200);
    if (ids.has(worker.agentId)) throw new Error(`Duplicate worker candidate: ${worker.agentId}`);
    ids.add(worker.agentId);
  }
}

function validateCronValue(kind: string, value: unknown, field: string): string {
  const text = cleanText(value, field, 32);
  const clock = '(?:[01]\\d|2[0-3]):[0-5]\\d';
  if (kind === 'interval') {
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) throw new Error(`${field} must be decimal hours`);
    const hours = Number(text);
    if (!Number.isFinite(hours) || hours < 0.5 || hours > 168) {
      throw new Error(`${field} interval must be between 0.5 and 168 hours`);
    }
    return String(hours);
  }
  if (kind === 'daily' && new RegExp(`^${clock}$`).test(text)) return text;
  if (kind === 'weekly' && new RegExp(`^[0-6]\\|${clock}$`).test(text)) return text;
  if (kind === 'monthly' && new RegExp(`^(?:[1-9]|1\\d|2[0-8])\\|${clock}$`).test(text)) return text;
  throw new Error(`${field} is invalid for ${kind}`);
}

function validateDraft(draft: DispatchPlanDraft, request: KernelRequest): DispatchPlanDraft {
  const worker = request.workers.find((candidate) => candidate.agentId === draft.workerAgentId);
  if (!worker) throw new Error(`Kernel selected an ineligible worker: ${draft.workerAgentId}`);
  const priority = Number(draft.priority);
  if (!Number.isInteger(priority) || priority < -10 || priority > 10) {
    throw new Error('priority must be an integer between -10 and 10');
  }
  if (!Array.isArray(draft.expectedOutputs) || draft.expectedOutputs.length > 10) {
    throw new Error('expectedOutputs must contain at most 10 items');
  }
  if (!Array.isArray(draft.memoryProposals) || draft.memoryProposals.length > MAX_MEMORY_PROPOSALS) {
    throw new Error(`memoryProposals must contain at most ${MAX_MEMORY_PROPOSALS} items`);
  }
  if (!Array.isArray(draft.taskScheduleProposals) || draft.taskScheduleProposals.length > MAX_TASK_SCHEDULE_PROPOSALS) {
    throw new Error(`taskScheduleProposals must contain at most ${MAX_TASK_SCHEDULE_PROPOSALS} items`);
  }
  return {
    workerAgentId: worker.agentId,
    title: cleanText(draft.title, 'title', 200),
    objective: cleanText(draft.objective, 'objective', MAX_OBJECTIVE_CHARS),
    rationale: cleanText(draft.rationale, 'rationale', 2_000),
    priority,
    expectedOutputs: draft.expectedOutputs.map((item, index) => cleanText(item, `expectedOutputs[${index}]`, 300)),
    requiresHumanApproval: draft.requiresHumanApproval === true,
    memoryProposals: draft.memoryProposals.map((proposal, index) => {
      if (proposal.operation !== 'remember') throw new Error(`memoryProposals[${index}] has an unsupported operation`);
      if (!['principal', 'channel', 'conversation', 'agent', 'project'].includes(proposal.scope)) {
        throw new Error(`memoryProposals[${index}] has an unsupported scope`);
      }
      if (proposal.scope === 'channel' && !request.channelId) {
        throw new Error(`memoryProposals[${index}] requires channel context`);
      }
      if (proposal.scope === 'project' && !request.projectId) {
        throw new Error(`memoryProposals[${index}] requires project context`);
      }
      const kind = cleanText(proposal.kind, `memoryProposals[${index}].kind`, 80).toLowerCase();
      if (!/^[a-z0-9][a-z0-9._:-]*$/.test(kind)) {
        throw new Error(`memoryProposals[${index}].kind is invalid`);
      }
      const importance = Number(proposal.importance);
      if (!Number.isFinite(importance) || importance < 0 || importance > 1) {
        throw new Error(`memoryProposals[${index}].importance must be between 0 and 1`);
      }
      return {
        operation: 'remember' as const,
        kind,
        content: cleanText(proposal.content, `memoryProposals[${index}].content`, 4_000),
        scope: proposal.scope,
        importance
      };
    }),
    taskScheduleProposals: draft.taskScheduleProposals.map((proposal, index) => {
      const field = `taskScheduleProposals[${index}]`;
      if (proposal.operation !== 'create_task_schedule') {
        throw new Error(`${field} has an unsupported operation`);
      }
      if (!['interval', 'daily', 'weekly', 'monthly'].includes(proposal.cronKind)) {
        throw new Error(`${field}.cronKind is invalid`);
      }
      return {
        operation: 'create_task_schedule' as const,
        title: cleanText(proposal.title, `${field}.title`, 160),
        content: cleanText(proposal.content, `${field}.content`, 4_000),
        cronKind: proposal.cronKind,
        cronValue: validateCronValue(proposal.cronKind, proposal.cronValue, `${field}.cronValue`)
      };
    })
  };
}

/**
 * Selects exactly one ingress route. Cordis is the sole owner-facing AI;
 * Local CLI is a deterministic adapter for an employee selected explicitly.
 * A failed Cordis route is never retried through the Local CLI adapter.
 */
export class KernelRouter {
  private readonly conversationTails = new Map<string, Promise<void>>();

  constructor(
    private readonly primary: ControlKernel,
    private readonly directWorker: ControlKernel,
    private readonly recorder: KernelAttemptRecorder = NOOP_RECORDER,
    private readonly now: () => number = Date.now
  ) {
    if (primary.id !== 'cordis') throw new Error('Cordis must be the primary control kernel');
    if (directWorker.id !== 'local-cli') {
      throw new Error('The secondary route must be the explicit Local CLI dispatch adapter');
    }
  }

  async plan(request: KernelRequest): Promise<DispatchPlan> {
    validateRequest(request);
    const previous = this.conversationTails.get(request.conversationId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    this.conversationTails.set(request.conversationId, tail);
    await previous.catch(() => {});
    try {
      return await this.planUnlocked(request);
    } finally {
      release();
      if (this.conversationTails.get(request.conversationId) === tail) this.conversationTails.delete(request.conversationId);
    }
  }

  private async planUnlocked(request: KernelRequest): Promise<DispatchPlan> {
    const failures: string[] = [];
    let sequence = 0;
    const route = request.routingMode === 'direct-worker' ? 'direct-worker' : 'cordis';
    const kernel = route === 'direct-worker' ? this.directWorker : this.primary;
    const startedAt = this.now();
    if (!kernel.isReady()) {
      const detail = `${kernel.id} is not ready`;
      failures.push(detail);
      await this.record({ request, componentId: kernel.id, role: 'leader', sequence: ++sequence, status: 'skipped', startedAt, error: detail });
      throw new KernelRoutingError('The selected dispatch route is unavailable', failures);
    }
    try {
      const draft = validateDraft(await kernel.plan(request, []), request);
      await this.record({ request, componentId: kernel.id, role: 'leader', sequence: ++sequence, status: 'succeeded', startedAt, error: null });
      const worker = request.workers.find((candidate) => candidate.agentId === draft.workerAgentId)!;
      return Object.freeze({
        ...draft,
        schemaVersion: 1 as const,
        requestId: request.requestId,
        conversationId: request.conversationId,
        leaderKernel: kernel.id,
        workerEngineId: worker.engineId,
        // Retained in schema v1 for old persisted projections. Quest
        // clarification/review now lives inside the authoritative Cordis run.
        advisorAdvice: [],
        advisorReviews: []
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(`${kernel.id} leader: ${detail}`);
      await this.record({ request, componentId: kernel.id, role: 'leader', sequence: ++sequence, status: 'failed', startedAt, error: detail });
    }
    throw new KernelRoutingError('No control kernel produced a valid dispatch plan', failures);
  }

  private async record(input: Omit<KernelAttemptRecord, 'requestId' | 'conversationId' | 'endedAt'> & { request: KernelRequest }): Promise<void> {
    await this.recorder.record({
      requestId: input.request.requestId,
      conversationId: input.request.conversationId,
      componentId: input.componentId,
      role: input.role,
      sequence: input.sequence,
      status: input.status,
      startedAt: input.startedAt,
      endedAt: this.now(),
      error: input.error?.slice(0, 2_000) ?? null
    });
  }
}
