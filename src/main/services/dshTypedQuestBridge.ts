import { randomUUID } from 'node:crypto';
import {
  hashCanonicalJson,
  type CompanyExecutionPlan,
  type PlanningComplexitySignals,
  type PlanningQuestion,
  type PlanningQuestionAnswer
} from './secretaryPlanning.js';
import type {
  DshControlPort,
  DshMuxEnvelope,
  DshQuestionAnswer,
  DshQuestionItem,
  DshQuestionRequestedFrame,
  DshQuestionResolvedFrame,
  DshRespondReceipt,
  DshTypedMuxFrame
} from './dshControlClient.js';
import { parseDshTypedMuxFrame } from './dshControlClient.js';
import type {
  DshQuestGovernanceService,
  DshQuestGovernanceView,
  ProjectDshPlanInput,
  ProjectDshQuestionSetInput
} from './dshQuestGovernance.js';
import type { DshScopedPolicyBroker } from './dshPolicyBroker.js';
import {
  DSH_QUEST_GOVERNANCE_CAPABILITY_ID,
  OPC_NEXUS_GOVERNANCE_PLUGIN_ID
} from './opcNexusGovernancePlugin.js';

const MAX_CONTEXT_TEXT = 20_000;
const MAX_PLAN_ID = 256;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type DshTypedQuestBridgeErrorCode =
  | 'CONTEXT_REQUIRED'
  | 'SESSION_BOUNDARY'
  | 'UNSUPPORTED_QUESTION'
  | 'QUESTION_NOT_FOUND'
  | 'ANSWER_INVALID'
  | 'PLAN_INVALID'
  | 'POLICY_DENIED'
  | 'ABORTED';

export class DshTypedQuestBridgeError extends Error {
  constructor(readonly code: DshTypedQuestBridgeErrorCode, message: string) {
    super(message);
    this.name = 'DshTypedQuestBridgeError';
  }
}

/** The non-secret identity and gate facts required to bind one DSH root. */
export interface DshTypedQuestContext {
  runtimeInstanceId: string;
  /** Upstream DSH id when the durable host projection uses a different id. */
  upstreamSessionId?: string;
  dshSessionId: string;
  planningSessionId: string;
  projectId: string;
  principalId: string;
  request: string;
  signals: PlanningComplexitySignals;
}

export interface DshTypedQuestBridgeOptions {
  governance: Pick<
    DshQuestGovernanceService,
    'openQuest' | 'getQuest' | 'projectQuestionSet' | 'projectPlan' | 'answerQuestions'
  >;
  /** Main-authenticated policy scope for the bound DSH root/session. */
  policyForContext?: (context: Readonly<DshTypedQuestContext>) => DshScopedPolicyBroker | null | Promise<DshScopedPolicyBroker | null>;
  /** Optional resolver used by the mux consumer; direct methods still require context. */
  resolveContext?: (dshSessionId: string) => DshTypedQuestContext | null | Promise<DshTypedQuestContext | null>;
}

export interface DshPlanReviewProjection {
  questionId: string;
  /** Exact rc.6 presentation intent; no prose parsing is performed. */
  kind: 'plan-review';
  approveLabel: string;
  markdown: string;
}

export interface DshQuestionSetProjection {
  sourceId: string;
  sourceVersion: number;
  payloadHash: string;
  questions: PlanningQuestion[];
  planReview: DshPlanReviewProjection | null;
  view: DshQuestGovernanceView;
}

export interface DshQuestionRequestedResult {
  kind: 'question-requested';
  rpcId: string;
  frame: DshQuestionRequestedFrame;
  projection: DshQuestionSetProjection;
}

export interface DshQuestionResolvedResult {
  kind: 'question-resolved';
  rpcId: string;
  frame: DshQuestionResolvedFrame;
  /** The corresponding request is absent when the stream was resumed late. */
  requested?: DshQuestionRequestedResult;
}

export type DshTypedQuestEvent = DshQuestionRequestedResult | DshQuestionResolvedResult;

export interface DshTypedPlanSource {
  id: string;
  version: number;
  value: CompanyExecutionPlan;
  /** Optional declaration; the bridge always recomputes and verifies it. */
  hash?: string;
}

export interface DshPlanProjectionResult {
  sourceId: string;
  sourceVersion: number;
  planHash: string;
  view: DshQuestGovernanceView;
}

export interface DshAnswerProjectionResult {
  answers: PlanningQuestionAnswer[];
  view: DshQuestGovernanceView;
  receipt: DshRespondReceipt;
}

interface PendingQuestion {
  result: DshQuestionRequestedResult;
  context: DshTypedQuestContext;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string, max = MAX_CONTEXT_TEXT): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new DshTypedQuestBridgeError('CONTEXT_REQUIRED', `${field} is invalid`);
  }
  return value.trim();
}

function id(value: unknown, field: string, max = 128): string {
  const result = text(value, field, max);
  if (!IDENTIFIER.test(result)) throw new DshTypedQuestBridgeError('CONTEXT_REQUIRED', `${field} is invalid`);
  return result;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DshTypedQuestBridgeError('ABORTED', 'DSH Quest bridge operation was aborted');
}

function safeQuestionId(sourceId: string, index: number): string {
  const normalized = sourceId.trim().replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '');
  if (normalized && IDENTIFIER.test(normalized)) return normalized;
  return `dsh-question-${hashCanonicalJson({ sourceId, index }).slice(0, 24)}`;
}

function optionId(questionId: string, index: number, label: string): string {
  return `dsh-option-${hashCanonicalJson({ questionId, index, label }).slice(0, 24)}`;
}

function toPlanningQuestion(item: DshQuestionItem, index: number): {
  question: PlanningQuestion;
  planReview: DshPlanReviewProjection | null;
} {
  const questionId = safeQuestionId(item.id, index);
  const options = item.options ?? [];
  let kind: PlanningQuestion['kind'];
  if (options.length === 0) {
    kind = 'text';
  } else {
    // The governance contract intentionally limits planning choices to 2-4;
    // arbitrary ask_user_question prompts stay in DSH and are not guessed into
    // a project decision.
    if (options.length < 2 || options.length > 4) {
      throw new DshTypedQuestBridgeError('UNSUPPORTED_QUESTION', `DSH question ${item.id} has unsupported option count`);
    }
    kind = item.multiSelect === true ? 'multi' : 'single';
  }
  let review: DshPlanReviewProjection | null = null;
  let recommendedOptionId: string | null = null;
  let recommendationReason: string | null = null;
  if (item.intent !== undefined) {
    if (item.intent.kind !== 'plan-review' || item.detail === undefined || item.detail.trim().length === 0) {
      throw new DshTypedQuestBridgeError('UNSUPPORTED_QUESTION', 'plan-review requires non-empty detail');
    }
    const approvalIndex = options.findIndex((option) => option.label === item.intent?.approve);
    if (approvalIndex < 0) throw new DshTypedQuestBridgeError('UNSUPPORTED_QUESTION', 'plan-review approval option is missing');
    const approvalId = optionId(questionId, approvalIndex, options[approvalIndex]!.label);
    recommendedOptionId = approvalId;
    // Keep this bounded because the durable planning schema stores the reason
    // as text. The original Markdown is also returned in `planReview`.
    if (item.detail.length > MAX_CONTEXT_TEXT) {
      throw new DshTypedQuestBridgeError('UNSUPPORTED_QUESTION', 'plan-review detail exceeds governance limit');
    }
    recommendationReason = item.detail;
    review = {
      questionId,
      kind: 'plan-review',
      approveLabel: item.intent.approve,
      markdown: item.detail
    };
  }
  const mappedOptions = options.map((option, optionIndex) => ({
    id: optionId(questionId, optionIndex, option.label),
    label: option.label,
    impact: option.description ?? option.label
  }));
  return {
    question: {
      id: questionId,
      kind,
      prompt: item.question,
      options: mappedOptions,
      recommendedOptionId,
      recommendationReason,
      allowOther: true
    },
    planReview: review
  };
}

function questionSetSource(frame: DshQuestionRequestedFrame): { id: string; hash: string } {
  const hash = hashCanonicalJson({ sessionId: frame.sessionId, questions: frame.questions });
  return { id: `dsh-questions-${hash.slice(0, 48)}`, hash };
}

function contextFor(context: DshTypedQuestContext, sessionId: string): DshTypedQuestContext {
  const upstreamSessionId = context.upstreamSessionId ?? context.dshSessionId;
  if (upstreamSessionId !== sessionId) {
    throw new DshTypedQuestBridgeError('SESSION_BOUNDARY', 'typed DSH frame belongs to another root session');
  }
  return {
    ...context,
    runtimeInstanceId: id(context.runtimeInstanceId, 'runtimeInstanceId'),
    ...(context.upstreamSessionId === undefined
      ? {}
      : { upstreamSessionId: id(context.upstreamSessionId, 'upstreamSessionId') }),
    dshSessionId: id(context.dshSessionId, 'dshSessionId'),
    planningSessionId: id(context.planningSessionId, 'planningSessionId'),
    projectId: id(context.projectId, 'projectId'),
    principalId: id(context.principalId, 'principalId'),
    request: text(context.request, 'request')
  };
}

function questionSetInput(
  context: DshTypedQuestContext,
  sourceId: string,
  version: number,
  questions: PlanningQuestion[],
  expectedRevision: number
): ProjectDshQuestionSetInput {
  return {
    planningSessionId: context.planningSessionId,
    dshSessionId: context.dshSessionId,
    expectedRevision,
    questionSet: { id: sourceId, version, questions }
  };
}

function planInput(
  context: DshTypedQuestContext,
  source: DshTypedPlanSource,
  hash: string,
  expectedRevision: number
): ProjectDshPlanInput {
  return {
    planningSessionId: context.planningSessionId,
    dshSessionId: context.dshSessionId,
    expectedRevision,
    plan: { id: source.id, version: source.version, hash, value: source.value }
  };
}

/**
 * Main-process bridge for the stable typed portion of DSH rc.6. It owns no
 * planner state: all durable state transitions remain in governance service.
 */
export class DshTypedQuestBridge {
  private readonly pending = new Map<string, PendingQuestion>();
  private readonly serial = new Map<string, Promise<void>>();

  constructor(private readonly options: DshTypedQuestBridgeOptions) {}

  /**
   * Gate every durable Quest projection before it reaches the governance
   * service. Admission uses the governance plugin's manifest permissions;
   * owner responses use a separate principal-bound boundary.
   */
  private async authorize(
    context: DshTypedQuestContext,
    operation: string,
    ownerResponse: boolean,
    signal?: AbortSignal
  ): Promise<void> {
    assertNotAborted(signal);
    let policy: DshScopedPolicyBroker | null = null;
    try { policy = await this.options.policyForContext?.(context) ?? null; } catch { policy = null; }
    if (!policy) throw new DshTypedQuestBridgeError('POLICY_DENIED', 'DSH Quest policy scope is unavailable');
    const permissions = ownerResponse
      ? [
          { capability: 'fs.read' as const, permission: 'artifact.read' },
          { capability: 'fs.write' as const, permission: 'artifact.write' },
          { capability: 'external_message' as const, permission: 'channel.send' }
        ]
      : [
          { capability: 'fs.read' as const, permission: 'artifact.read' },
          { capability: 'artifact.publish' as const, permission: 'artifact.write' }
        ];
    const decisions = await Promise.all(permissions.map(({ capability, permission }) => policy!.decide({
      requestId: randomUUID(),
      capability,
      target: `quest:${context.planningSessionId}`,
      operation,
      sessionId: context.dshSessionId,
      context: ownerResponse
        ? {
            boundary: 'quest-owner-response',
            principalBound: true,
            principalId: context.principalId,
            planningSessionId: context.planningSessionId,
            permission
          }
        : {
            boundary: 'plugin-host',
            pluginId: OPC_NEXUS_GOVERNANCE_PLUGIN_ID,
            pluginOwner: 'nexus-governance',
            capabilityId: DSH_QUEST_GOVERNANCE_CAPABILITY_ID,
            capabilityKind: 'artifact',
            permission
          }
    })));
    // The caller may cancel while the policy resolver is running. Re-check at
    // the write boundary so an allowed decision cannot commit stale work.
    assertNotAborted(signal);
    const denied = decisions.find((decision) => decision.effect !== 'allow');
    if (denied) {
      throw new DshTypedQuestBridgeError('POLICY_DENIED', `DSH Quest policy denied ${operation}: ${denied.reasonCode}`);
    }
  }

  async handleEnvelope(envelope: DshMuxEnvelope, signal?: AbortSignal): Promise<DshTypedQuestEvent | null> {
    assertNotAborted(signal);
    const frame = parseDshTypedMuxFrame(envelope.payload);
    if (frame === null) return null;
    if (frame.type === 'question/requested') {
      const context = await this.options.resolveContext?.(frame.sessionId);
      if (!context) throw new DshTypedQuestBridgeError('CONTEXT_REQUIRED', 'no project context is bound to DSH session');
      return this.projectQuestionSet(frame, context, envelope.rpcId, signal);
    }
    const requested = this.pending.get(envelope.rpcId) ?? this.pending.get(frame.questionRpcId);
    this.pending.delete(frame.questionRpcId);
    if (envelope.rpcId !== frame.questionRpcId) this.pending.delete(envelope.rpcId);
    return {
      kind: 'question-resolved',
      rpcId: envelope.rpcId,
      frame,
      ...(requested === undefined ? {} : { requested: requested.result })
    };
  }

  async projectQuestionSet(
    frame: DshQuestionRequestedFrame,
    context: DshTypedQuestContext,
    rpcId = frame.sessionId,
    signal?: AbortSignal
  ): Promise<DshQuestionRequestedResult> {
    assertNotAborted(signal);
    const bound = contextFor(context, frame.sessionId);
    return this.exclusive(bound.planningSessionId, async () => {
      assertNotAborted(signal);
      const source = questionSetSource(frame);
      const converted = frame.questions.map((item, index) => toPlanningQuestion(item, index));
      if (converted.length < 1 || converted.length > 3) {
        throw new DshTypedQuestBridgeError('UNSUPPORTED_QUESTION', 'DSH QuestionSet must contain 1 to 3 planning questions');
      }
      await this.authorize(bound, 'dsh.quest.questions.project', false, signal);
      const questions = converted.map((entry) => entry.question);
      const planReview = converted.find((entry) => entry.planReview !== null)?.planReview ?? null;
      let view = this.options.governance.openQuest({
        planningSessionId: bound.planningSessionId,
        projectId: bound.projectId,
        dshSessionId: bound.dshSessionId,
        principalId: bound.principalId,
        request: bound.request,
        signals: bound.signals
      });
      const existing = view.questionProjections.find((projection) => projection.dshQuestionSetId === source.id);
      let sourceVersion = existing?.dshVersion ?? (view.session.questionSetVersion + 1);
      if (!existing) {
        view = this.options.governance.projectQuestionSet(questionSetInput(
          bound, source.id, sourceVersion, questions, view.session.revision
        ));
      }
      const result: DshQuestionRequestedResult = {
        kind: 'question-requested',
        rpcId,
        frame,
        projection: {
          sourceId: source.id,
          sourceVersion,
          payloadHash: hashCanonicalJson(questions),
          questions,
          planReview,
          view
        }
      };
      this.pending.set(rpcId, { result, context: bound });
      return result;
    });
  }

  /** Project a structured CompanyExecutionPlan supplied by Cordis. */
  async projectPlan(
    context: DshTypedQuestContext,
    source: DshTypedPlanSource,
    signal?: AbortSignal
  ): Promise<DshPlanProjectionResult> {
    assertNotAborted(signal);
    const bound = contextFor(context, context.upstreamSessionId ?? context.dshSessionId);
    const sourceId = id(source?.id, 'plan.id', MAX_PLAN_ID);
    if (!Number.isSafeInteger(source?.version) || source.version < 1) {
      throw new DshTypedQuestBridgeError('PLAN_INVALID', 'plan.version is invalid');
    }
    let planHash: string;
    try {
      planHash = hashCanonicalJson(source.value);
    } catch (error) {
      throw new DshTypedQuestBridgeError('PLAN_INVALID', error instanceof Error ? error.message : 'plan is not JSON-safe');
    }
    if (source.hash !== undefined && source.hash !== planHash) {
      throw new DshTypedQuestBridgeError('PLAN_INVALID', 'plan.hash does not match the typed plan value');
    }
    return this.exclusive(bound.planningSessionId, async () => {
      assertNotAborted(signal);
      await this.authorize(bound, 'dsh.quest.plan.project', false, signal);
      let view = this.options.governance.openQuest({
        planningSessionId: bound.planningSessionId,
        projectId: bound.projectId,
        dshSessionId: bound.dshSessionId,
        principalId: bound.principalId,
        request: bound.request,
        signals: bound.signals
      });
      const existing = view.planProjections.find((projection) => projection.dshPlanId === sourceId);
      if (existing) {
        if (existing.dshVersion !== source.version || existing.planHash !== planHash) {
          throw new DshTypedQuestBridgeError('PLAN_INVALID', 'typed DSH plan identity conflicts with its projection');
        }
      } else {
        view = this.options.governance.projectPlan(planInput(
          bound, { ...source, id: sourceId }, planHash, view.session.revision
        ));
      }
      return { sourceId, sourceVersion: source.version, planHash, view };
    });
  }

  /** Convert the exact DSH answer labels to the local governance IDs. */
  toGovernanceAnswers(frame: DshQuestionRequestedFrame, answer: DshQuestionAnswer): PlanningQuestionAnswer[] {
    const converted = frame.questions.map((item, index) => toPlanningQuestion(item, index).question);
    if (!Array.isArray(answer.answers) || answer.answers.length !== converted.length) {
      throw new DshTypedQuestBridgeError('ANSWER_INVALID', 'DSH answer does not cover every question');
    }
    const byId = new Map(answer.answers.map((item) => [item.id, item]));
    return converted.map((question, index) => {
      const source = frame.questions[index]!;
      const candidate = byId.get(source.id);
      if (!candidate) throw new DshTypedQuestBridgeError('ANSWER_INVALID', `missing answer for ${source.id}`);
      const labels = new Map((source.options ?? []).map((option, optionIndex) => [
        option.label,
        optionId(question.id, optionIndex, option.label)
      ]));
      const selectedOptionIds = candidate.selected.map((label) => {
        const mapped = labels.get(label);
        if (!mapped) throw new DshTypedQuestBridgeError('ANSWER_INVALID', `unknown answer option for ${source.id}`);
        return mapped;
      });
      return {
        questionId: question.id,
        selectedOptionIds,
        text: candidate.custom ?? null
      };
    });
  }

  /** Persist the owner answer before sending it upstream (at-least-once safe). */
  async answerQuestion(
    client: DshControlPort,
    request: { rpcId: string; frame: DshQuestionRequestedFrame; context: DshTypedQuestContext; principalId: string; answer: DshQuestionAnswer },
    signal?: AbortSignal
  ): Promise<DshAnswerProjectionResult> {
    assertNotAborted(signal);
    const bound = contextFor(request.context, request.frame.sessionId);
    const principalId = id(request.principalId, 'principalId');
    if (principalId !== bound.principalId) {
      throw new DshTypedQuestBridgeError('SESSION_BOUNDARY', 'owner response principal does not own this Quest');
    }
    const answers = this.toGovernanceAnswers(request.frame, request.answer);
    await this.authorize(bound, 'dsh.quest.owner.respond', true, signal);
    const viewBefore = this.options.governance.getQuest(bound.planningSessionId);
    const source = questionSetSource(request.frame);
    const projection = viewBefore.questionProjections.find((item) => item.dshQuestionSetId === source.id);
    if (!projection) throw new DshTypedQuestBridgeError('QUESTION_NOT_FOUND', 'question set is not projected');
    const view = this.options.governance.answerQuestions({
      planningSessionId: bound.planningSessionId,
      principalId,
      expectedRevision: viewBefore.session.revision,
      dshQuestionSetId: projection.dshQuestionSetId,
      dshVersion: projection.dshVersion,
      answers
    });
    const receipt = await client.respondQuestion({
      rpcId: request.rpcId,
      sessionId: bound.upstreamSessionId ?? bound.dshSessionId,
      answer: request.answer
    }, signal);
    return { answers, view, receipt };
  }

  private async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.serial.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current, () => current);
    this.serial.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.serial.get(key) === queued) this.serial.delete(key);
    }
  }
}

/** Type guard useful to mux consumers that already decoded an envelope. */
export function isDshTypedQuestFrame(value: unknown): value is DshTypedMuxFrame {
  return record(value) && (value.type === 'question/requested' || value.type === 'question/resolved');
}
