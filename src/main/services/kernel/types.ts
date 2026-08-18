export type ControlKernelId = 'cordis' | 'local-cli' | 'hermes' | 'nexus';
export type PlanningAdvisorId = 'deepseek-harness';
export type KernelRoutingMode = 'cordis' | 'direct-worker';

export interface WorkerCandidate {
  agentId: string;
  name: string;
  role: string;
  engineId: string;
  capabilities: string[];
}

export interface KernelMemoryContext {
  id: string;
  kind: string;
  content: string;
  importance: number;
  /** Present only for memory scoped to one eligible worker. */
  agentId?: string;
}

export interface KernelRequest {
  requestId: string;
  source: 'channel' | 'desktop' | 'voice' | 'webhook';
  organizationId: string;
  principalId: string;
  channelId: string | null;
  conversationId: string;
  inputMessageId: string;
  message: string;
  /**
   * `cordis` is the default owner-facing route. `direct-worker` is only for
   * an employee that the user selected explicitly; it never acts as a
   * fallback planner when Cordis is unavailable.
   */
  routingMode?: KernelRoutingMode;
  preferredAgentId: string | null;
  projectId: string | null;
  workers: WorkerCandidate[];
  memories: KernelMemoryContext[];
}

export interface AdvisorAdvice {
  advisorId: PlanningAdvisorId;
  summary: string;
}

export interface AdvisorReview {
  advisorId: PlanningAdvisorId;
  accepted: boolean;
  summary: string;
}

export type MemoryProposalScope = 'principal' | 'channel' | 'conversation' | 'agent' | 'project';

export interface MemoryProposal {
  operation: 'remember';
  kind: string;
  content: string;
  scope: MemoryProposalScope;
  importance: number;
}

export type TaskScheduleCronKind = 'interval' | 'daily' | 'weekly' | 'monthly';

/** A legacy projection suggestion. Cordis remains the schedule/run owner. */
export interface TaskScheduleProposal {
  operation: 'create_task_schedule';
  title: string;
  content: string;
  cronKind: TaskScheduleCronKind;
  cronValue: string;
}

export interface DispatchPlanDraft {
  workerAgentId: string;
  title: string;
  objective: string;
  rationale: string;
  priority: number;
  expectedOutputs: string[];
  requiresHumanApproval: boolean;
  memoryProposals: MemoryProposal[];
  taskScheduleProposals: TaskScheduleProposal[];
}

export interface DispatchPlan extends DispatchPlanDraft {
  schemaVersion: 1;
  requestId: string;
  conversationId: string;
  leaderKernel: ControlKernelId;
  workerEngineId: string;
  advisorAdvice: AdvisorAdvice[];
  advisorReviews: AdvisorReview[];
}

export interface ControlKernel {
  readonly id: ControlKernelId;
  isReady(): boolean;
  plan(request: KernelRequest, advice: AdvisorAdvice[]): Promise<DispatchPlanDraft>;
}

export interface PlanningAdvisor {
  readonly id: PlanningAdvisorId;
  isReady(): boolean;
  shouldAdvise(request: KernelRequest): boolean;
  advise(request: KernelRequest): Promise<AdvisorAdvice>;
  review?(request: KernelRequest, plan: DispatchPlanDraft): Promise<AdvisorReview>;
}

export type KernelAttemptRole = 'advisor' | 'leader' | 'reviewer';
export type KernelAttemptStatus = 'succeeded' | 'failed' | 'skipped';

export interface KernelAttemptRecord {
  requestId: string;
  conversationId: string;
  componentId: ControlKernelId | PlanningAdvisorId;
  role: KernelAttemptRole;
  sequence: number;
  status: KernelAttemptStatus;
  startedAt: number;
  endedAt: number;
  error: string | null;
}

export interface KernelAttemptRecorder {
  record(attempt: KernelAttemptRecord): void | Promise<void>;
}

/** Legacy native-controller sessions are an optimization/cache. Cordis owns
 * the canonical AI session; governance keeps only the bounded host projection. */
export interface KernelSessionStore {
  get(conversationId: string, kernelId: ControlKernelId): string | null;
  set(conversationId: string, kernelId: ControlKernelId, sessionId: string): void;
  clear(conversationId: string, kernelId: ControlKernelId): void;
}
