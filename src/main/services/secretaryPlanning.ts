import { createHash, randomUUID } from 'node:crypto';

export const PLANNING_SESSION_STATUSES = [
  'DRAFT',
  'NEEDS_INPUT',
  'PROPOSED',
  'APPROVED',
  'DISPATCHED',
  'CLOSED',
  'REJECTED',
  'SUPERSEDED',
  'CANCELLED'
] as const;

export type PlanningSessionStatus = typeof PLANNING_SESSION_STATUSES[number];
export type PlanningQuestionKind = 'single' | 'multi' | 'text';
export type PlanningAgentLifecycle = 'DISABLED' | 'STARTING' | 'READY' | 'STOPPING' | 'ERROR';
export type PlanVersionStatus = 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'SUPERSEDED';
export type JsonPrimitive = string | number | boolean | null;
export type CanonicalJsonValue = JsonPrimitive | CanonicalJsonValue[] | { [key: string]: CanonicalJsonValue };

export interface PlanningQuestionOption {
  id: string;
  label: string;
  impact: string;
}

export interface PlanningQuestion {
  id: string;
  kind: PlanningQuestionKind;
  prompt: string;
  options: PlanningQuestionOption[];
  recommendedOptionId: string | null;
  recommendationReason: string | null;
  allowOther: true;
}

export interface PlanningQuestionAnswer {
  questionId: string;
  selectedOptionIds: string[];
  text: string | null;
}

export interface QuestionSet {
  id: string;
  sessionId: string;
  version: number;
  questions: PlanningQuestion[];
  answers: PlanningQuestionAnswer[] | null;
  createdAt: number;
  answeredAt: number | null;
  answeredBy: string | null;
}

export type IrreversibleOperation =
  | 'write_files'
  | 'install_software'
  | 'send_external_message'
  | 'production_change'
  | 'payment'
  | 'delete_data'
  | 'publish';

export type PlanningGateReason =
  | 'CROSS_TEAM'
  | 'AMBIGUOUS_OBJECTIVE'
  | 'AMBIGUOUS_SCOPE'
  | 'AMBIGUOUS_ACCEPTANCE'
  | 'LONG_TASK'
  | 'HIGH_COST'
  | 'HIGH_TOKEN_BUDGET'
  | 'NEW_TEAM'
  | 'IRREVERSIBLE_OPERATION'
  | 'COMPARE_ALTERNATIVES'
  | 'PHASED_EXECUTION'
  | 'EXPLICIT_CONFIRMATION'
  | 'COMPLEXITY_SCORE';

export interface PlanningComplexitySignals {
  departmentIds: readonly string[];
  hasCrossTeamDependencies: boolean;
  ambiguousObjective: boolean;
  ambiguousScope: boolean;
  ambiguousAcceptance: boolean;
  estimatedDurationMinutes: number;
  estimatedCost: number;
  estimatedTokenCount: number;
  requiresNewTeam: boolean;
  irreversibleOperations: readonly IrreversibleOperation[];
  compareAlternatives: boolean;
  phasedExecution: boolean;
  confirmBeforeExecution: boolean;
  estimatedTaskCount?: number;
}

export interface PlanningGateConfig {
  longTaskMinutes: number;
  highCost: number;
  highTokenCount: number;
  complexityScoreThreshold: number;
}

export interface PlanningGateDecision {
  requiresPlanning: boolean;
  complexityScore: number;
  riskScore: number;
  reasons: PlanningGateReason[];
}

export interface PlanBudget {
  timeMinutes: number;
  tokenLimit: number;
  costLimit: number;
}

export interface PlanRetryPolicy {
  maxAttempts: number;
  backoff: 'none' | 'linear' | 'exponential';
}

export interface PlanTeamAssignment {
  teamId: string;
  organizationId: string;
  leadAgentId: string;
  memberAgentIds: string[];
  proposedEphemeralRoles: string[];
}

export interface PlanDagNode {
  nodeId: string;
  organizationId: string;
  ownerAgentId: string;
  dependencies: string[];
  workOrder: string;
  expectedArtifacts: string[];
  acceptanceCriteria: string[];
  permissionProfile: string;
  requiredPermissions: string[];
  budget: PlanBudget;
  retryPolicy: PlanRetryPolicy;
}

export interface PlanRisk {
  risk: string;
  mitigation: string;
  ownerAgentId: string;
}

export interface CompanyExecutionPlan {
  schemaVersion: 1;
  organizationId: string;
  objective: string;
  assumptions: string[];
  scope: {
    included: string[];
    excluded: string[];
  };
  team: PlanTeamAssignment[];
  dag: PlanDagNode[];
  risks: PlanRisk[];
  overallBudget: PlanBudget;
  acceptanceCriteria: string[];
}

export interface PlanningAgentSnapshot {
  id: string;
  organizationId: string;
  lifecycle: PlanningAgentLifecycle;
  archived: boolean;
  permissionProfiles: readonly string[];
  permissions: readonly string[];
}

export interface PlanValidationPolicy {
  organizationId: string;
  agents: readonly PlanningAgentSnapshot[];
  allowedPermissionProfiles: readonly string[];
  allowedPermissions: readonly string[];
  maxBudget: PlanBudget;
  maxRetryAttempts: number;
  allowEphemeralTeams: boolean;
}

export interface PlanningSession {
  id: string;
  organizationId: string;
  principalId: string;
  request: string;
  /** Original deterministic gate inputs; optional for sessions created before v1 control-plane persistence. */
  signals?: PlanningComplexitySignals;
  status: PlanningSessionStatus;
  gateDecision: PlanningGateDecision;
  questionSetVersion: number;
  activeQuestionSetVersion: number | null;
  latestPlanVersion: number;
  approvedPlanVersion: number | null;
  approvedPlanHash: string | null;
  dispatchPlanVersion: number | null;
  dispatchPlanHash: string | null;
  dispatchStartedAt: number | null;
  supersededBySessionId: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface PlanVersionRecord {
  sessionId: string;
  version: number;
  hash: string;
  status: PlanVersionStatus;
  plan: CompanyExecutionPlan;
  createdAt: number;
  approvedAt: number | null;
  approvedBy: string | null;
  rejectedAt: number | null;
  rejectedBy: string | null;
  supersededAt: number | null;
  supersededByVersion: number | null;
  supersedesVersion: number | null;
}

export interface PlanDispatchReceipt {
  sessionId: string;
  planVersion: number;
  planHash: string;
  nodeId: string;
  taskId: string;
  idempotencyKey: string;
  createdAt: number;
}

export interface DispatchWorkOrder {
  idempotencyKey: string;
  sessionId: string;
  organizationId: string;
  planVersion: number;
  planHash: string;
  nodeId: string;
  ownerAgentId: string;
  dependencyTaskIds: string[];
  workOrder: string;
  expectedArtifacts: string[];
  acceptanceCriteria: string[];
  permissionProfile: string;
  requiredPermissions: string[];
  budget: PlanBudget;
  retryPolicy: PlanRetryPolicy;
}

export interface DispatchPort {
  /** Implementations must return the same task for a repeated idempotencyKey. */
  createTask(order: DispatchWorkOrder): Promise<{ taskId: string }> | { taskId: string };
}

export interface PlanningRepository {
  transaction<T>(operation: () => T): T;
  getSession(sessionId: string): PlanningSession | null;
  listSessions(limit: number): PlanningSession[];
  saveSession(session: PlanningSession, expectedRevision: number | null): void;
  getQuestionSet(sessionId: string, version: number): QuestionSet | null;
  saveQuestionSet(questionSet: QuestionSet, expectedAnsweredAt: number | null | undefined): void;
  getPlanVersion(sessionId: string, version: number): PlanVersionRecord | null;
  listPlanVersions(sessionId: string): PlanVersionRecord[];
  savePlanVersion(planVersion: PlanVersionRecord, expectedStatus: PlanVersionStatus | null): void;
  getDispatchReceipt(sessionId: string, planVersion: number, nodeId: string): PlanDispatchReceipt | null;
  saveDispatchReceipt(receipt: PlanDispatchReceipt): void;
}

export class PlanningError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PlanningError';
  }
}

const DEFAULT_GATE_CONFIG: PlanningGateConfig = {
  longTaskMinutes: 60,
  highCost: 10,
  highTokenCount: 100_000,
  complexityScoreThreshold: 5
};

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TEXT_LENGTH = 20_000;
const COST_SCALE = 1_000_000;

function fail(code: string, message: string): never {
  throw new PlanningError(code, message);
}

function assertFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) fail('INVALID_NUMBER', `${name} must be a finite non-negative number`);
}

function assertSafeNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_NUMBER', `${name} must be a non-negative safe integer`);
}

function assertBoolean(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== 'boolean') fail('INVALID_GATE_SIGNALS', `${name} must be a boolean`);
}

function normalizeCost(value: number, name: string): number {
  assertFiniteNonNegative(value, name);
  if (value > Number.MAX_SAFE_INTEGER / COST_SCALE) fail('INVALID_NUMBER', `${name} exceeds the supported monetary range`);
  const scaled = Math.round(value * COST_SCALE);
  if (Math.abs(value * COST_SCALE - scaled) > 1e-6) fail('INVALID_NUMBER', `${name} supports at most 6 decimal places`);
  return scaled / COST_SCALE;
}

function normalizeId(value: unknown, path: string): string {
  if (typeof value !== 'string') fail('INVALID_PLAN', `${path} must be a string`);
  const normalized = value.trim();
  if (!IDENTIFIER_PATTERN.test(normalized)) fail('INVALID_PLAN', `${path} is not a valid identifier`);
  return normalized;
}

function normalizeText(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string') fail('INVALID_PLAN', `${path} must be a string`);
  const normalized = value.trim();
  if (!allowEmpty && normalized.length === 0) fail('INVALID_PLAN', `${path} must not be empty`);
  if (normalized.length > MAX_TEXT_LENGTH) fail('INVALID_PLAN', `${path} is too long`);
  assertValidUnicode(normalized, path);
  return normalized;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_PLAN', `${path} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('INVALID_PLAN', `${path} must be a plain object`);
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('INVALID_PLAN', `${path} contains unknown field ${key}`);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail('INVALID_PLAN', `${path}.${key} is required`);
  }
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail('INVALID_PLAN', `${path} must be an array`);
  return value;
}

function normalizeTextList(value: unknown, path: string, requireItems = false): string[] {
  const items = requireArray(value, path).map((item, index) => normalizeText(item, `${path}[${index}]`));
  if (requireItems && items.length === 0) fail('INVALID_PLAN', `${path} must contain at least one item`);
  if (new Set(items).size !== items.length) fail('INVALID_PLAN', `${path} contains duplicate values`);
  return items;
}

function normalizeIdList(value: unknown, path: string): string[] {
  const items = requireArray(value, path).map((item, index) => normalizeId(item, `${path}[${index}]`));
  if (new Set(items).size !== items.length) fail('INVALID_PLAN', `${path} contains duplicate identifiers`);
  return items;
}

function normalizeBudget(value: unknown, path: string): PlanBudget {
  const row = requireRecord(value, path);
  assertExactKeys(row, ['timeMinutes', 'tokenLimit', 'costLimit'], path);
  const timeMinutes = row.timeMinutes;
  const tokenLimit = row.tokenLimit;
  const costLimit = row.costLimit;
  if (typeof timeMinutes !== 'number' || typeof tokenLimit !== 'number' || typeof costLimit !== 'number') {
    fail('INVALID_BUDGET', `${path} values must be numbers`);
  }
  assertSafeNonNegativeInteger(timeMinutes, `${path}.timeMinutes`);
  assertSafeNonNegativeInteger(tokenLimit, `${path}.tokenLimit`);
  return { timeMinutes, tokenLimit, costLimit: normalizeCost(costLimit, `${path}.costLimit`) };
}

function normalizeRetryPolicy(value: unknown, path: string): PlanRetryPolicy {
  const row = requireRecord(value, path);
  assertExactKeys(row, ['maxAttempts', 'backoff'], path);
  if (typeof row.maxAttempts !== 'number') fail('INVALID_PLAN', `${path}.maxAttempts must be a number`);
  if (!Number.isSafeInteger(row.maxAttempts) || row.maxAttempts < 1) fail('INVALID_PLAN', `${path}.maxAttempts must be a positive safe integer`);
  if (row.backoff !== 'none' && row.backoff !== 'linear' && row.backoff !== 'exponential') {
    fail('INVALID_PLAN', `${path}.backoff is invalid`);
  }
  return { maxAttempts: row.maxAttempts, backoff: row.backoff };
}

function costUnits(value: number): number {
  return Math.round(value * COST_SCALE);
}

function assertValidUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail('INVALID_JSON_STRING', `${path} contains an unpaired surrogate`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail('INVALID_JSON_STRING', `${path} contains an unpaired surrogate`);
    }
  }
}

export function canonicalJson(value: unknown): string {
  const active = new Set<object>();

  const serialize = (current: unknown, path: string): string => {
    if (current === null) return 'null';
    if (typeof current === 'string') {
      assertValidUnicode(current, path);
      return JSON.stringify(current);
    }
    if (typeof current === 'boolean') return current ? 'true' : 'false';
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) fail('INVALID_JSON_NUMBER', `${path} contains a non-finite number`);
      if (Number.isInteger(current) && !Number.isSafeInteger(current)) {
        fail('INVALID_JSON_NUMBER', `${path} contains an unsafe integer`);
      }
      return Object.is(current, -0) ? '0' : JSON.stringify(current);
    }
    if (typeof current !== 'object') fail('INVALID_JSON_VALUE', `${path} contains an unsupported JSON value`);
    if (active.has(current)) fail('INVALID_JSON_VALUE', `${path} contains a cycle`);
    active.add(current);
    try {
      if (Array.isArray(current)) {
        for (const key of Reflect.ownKeys(current)) {
          if (typeof key !== 'string') fail('INVALID_JSON_VALUE', `${path} contains a symbol property`);
          if (key === 'length') continue;
          if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length) {
            fail('INVALID_JSON_VALUE', `${path} contains a non-index array property`);
          }
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
            fail('INVALID_JSON_VALUE', `${path}[${key}] is not a plain JSON array item`);
          }
        }
        const values: string[] = [];
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(current, index)) fail('INVALID_JSON_VALUE', `${path} contains a sparse array`);
          values.push(serialize(current[index], `${path}[${index}]`));
        }
        return `[${values.join(',')}]`;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) fail('INVALID_JSON_VALUE', `${path} must contain only plain objects`);
      const record = current as Record<string, unknown>;
      const ownKeys = Reflect.ownKeys(record);
      if (ownKeys.some((key) => typeof key !== 'string')) fail('INVALID_JSON_VALUE', `${path} contains a symbol property`);
      const keys = (ownKeys as string[]).sort();
      const properties = keys.map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
          fail('INVALID_JSON_VALUE', `${path}.${key} is not a plain enumerable JSON property`);
        }
        assertValidUnicode(key, `${path} key`);
        return `${JSON.stringify(key)}:${serialize(descriptor.value, `${path}.${key}`)}`;
      });
      return `{${properties.join(',')}}`;
    } finally {
      active.delete(current);
    }
  };

  return serialize(value, '$');
}

export function hashCanonicalJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function evaluatePlanningGate(
  signals: PlanningComplexitySignals,
  config: Partial<PlanningGateConfig> = {}
): PlanningGateDecision {
  const policy = { ...DEFAULT_GATE_CONFIG, ...config };
  assertFiniteNonNegative(policy.longTaskMinutes, 'longTaskMinutes');
  assertFiniteNonNegative(policy.highCost, 'highCost');
  assertFiniteNonNegative(policy.highTokenCount, 'highTokenCount');
  assertFiniteNonNegative(policy.complexityScoreThreshold, 'complexityScoreThreshold');
  assertFiniteNonNegative(signals.estimatedDurationMinutes, 'estimatedDurationMinutes');
  assertFiniteNonNegative(signals.estimatedCost, 'estimatedCost');
  assertSafeNonNegativeInteger(signals.estimatedTokenCount, 'estimatedTokenCount');
  if (signals.estimatedTaskCount !== undefined) assertSafeNonNegativeInteger(signals.estimatedTaskCount, 'estimatedTaskCount');

  for (const name of [
    'hasCrossTeamDependencies', 'ambiguousObjective', 'ambiguousScope', 'ambiguousAcceptance', 'requiresNewTeam',
    'compareAlternatives', 'phasedExecution', 'confirmBeforeExecution'
  ] as const) assertBoolean(signals[name], name);
  if (!Array.isArray(signals.departmentIds)) fail('INVALID_GATE_SIGNALS', 'departmentIds must be an array');
  if (!Array.isArray(signals.irreversibleOperations)) fail('INVALID_GATE_SIGNALS', 'irreversibleOperations must be an array');
  const validIrreversibleOperations = new Set<IrreversibleOperation>([
    'write_files', 'install_software', 'send_external_message', 'production_change', 'payment', 'delete_data', 'publish'
  ]);
  for (const operation of signals.irreversibleOperations) {
    if (!validIrreversibleOperations.has(operation)) fail('INVALID_GATE_SIGNALS', `unknown irreversible operation ${String(operation)}`);
  }

  const departments = new Set(signals.departmentIds.map((item, index) => normalizeId(item, `departmentIds[${index}]`)));
  const reasons: PlanningGateReason[] = [];
  let complexityScore = 0;
  let riskScore = 0;
  const add = (reason: PlanningGateReason, complexity: number, risk: number) => {
    reasons.push(reason);
    complexityScore += complexity;
    riskScore += risk;
  };

  if (departments.size >= 2 || signals.hasCrossTeamDependencies) add('CROSS_TEAM', 3, 1);
  if (signals.ambiguousObjective) add('AMBIGUOUS_OBJECTIVE', 2, 1);
  if (signals.ambiguousScope) add('AMBIGUOUS_SCOPE', 2, 1);
  if (signals.ambiguousAcceptance) add('AMBIGUOUS_ACCEPTANCE', 2, 1);
  if (signals.estimatedDurationMinutes >= policy.longTaskMinutes) add('LONG_TASK', 2, 1);
  if (signals.estimatedCost >= policy.highCost) add('HIGH_COST', 1, 3);
  if (signals.estimatedTokenCount >= policy.highTokenCount) add('HIGH_TOKEN_BUDGET', 1, 2);
  if (signals.requiresNewTeam) add('NEW_TEAM', 3, 2);
  if (signals.irreversibleOperations.length > 0) add('IRREVERSIBLE_OPERATION', 1, 5);
  if (signals.compareAlternatives) add('COMPARE_ALTERNATIVES', 2, 0);
  if (signals.phasedExecution) add('PHASED_EXECUTION', 2, 0);
  if (signals.confirmBeforeExecution) add('EXPLICIT_CONFIRMATION', 0, 1);
  if ((signals.estimatedTaskCount ?? 0) >= 4) {
    complexityScore += Math.min(6, Math.floor((signals.estimatedTaskCount ?? 0) / 2));
  }

  if (reasons.length === 0 && complexityScore + riskScore >= policy.complexityScoreThreshold) {
    reasons.push('COMPLEXITY_SCORE');
  }
  return {
    requiresPlanning: reasons.length > 0 || complexityScore + riskScore >= policy.complexityScoreThreshold,
    complexityScore,
    riskScore,
    reasons
  };
}

function normalizeQuestions(input: readonly PlanningQuestion[]): PlanningQuestion[] {
  if (input.length < 1 || input.length > 3) fail('INVALID_QUESTION_SET', 'a question set must contain 1 to 3 questions');
  const questionIds = new Set<string>();
  return input.map((candidate, questionIndex) => {
    const row = requireRecord(candidate, `questions[${questionIndex}]`);
    assertExactKeys(row, ['id', 'kind', 'prompt', 'options', 'recommendedOptionId', 'recommendationReason', 'allowOther'], `questions[${questionIndex}]`);
    const id = normalizeId(row.id, `questions[${questionIndex}].id`);
    if (questionIds.has(id)) fail('INVALID_QUESTION_SET', `duplicate question id ${id}`);
    questionIds.add(id);
    if (row.kind !== 'single' && row.kind !== 'multi' && row.kind !== 'text') fail('INVALID_QUESTION_SET', `question ${id} has an invalid kind`);
    if (row.allowOther !== true) fail('INVALID_QUESTION_SET', `question ${id} must allow an additional answer`);
    const rawOptions = requireArray(row.options, `question ${id}.options`);
    if (row.kind === 'text' ? rawOptions.length !== 0 : rawOptions.length < 2 || rawOptions.length > 4) {
      fail('INVALID_QUESTION_SET', row.kind === 'text'
        ? `text question ${id} must not contain options`
        : `question ${id} must contain 2 to 4 options`);
    }
    const optionIds = new Set<string>();
    const options = rawOptions.map((candidateOption, optionIndex): PlanningQuestionOption => {
      const option = requireRecord(candidateOption, `question ${id}.options[${optionIndex}]`);
      assertExactKeys(option, ['id', 'label', 'impact'], `question ${id}.options[${optionIndex}]`);
      const optionId = normalizeId(option.id, `question ${id}.options[${optionIndex}].id`);
      if (optionIds.has(optionId)) fail('INVALID_QUESTION_SET', `question ${id} contains duplicate option ${optionId}`);
      optionIds.add(optionId);
      return {
        id: optionId,
        label: normalizeText(option.label, `question ${id}.option ${optionId}.label`),
        impact: normalizeText(option.impact, `question ${id}.option ${optionId}.impact`)
      };
    });
    const recommendedOptionId = row.recommendedOptionId === null
      ? null
      : normalizeId(row.recommendedOptionId, `question ${id}.recommendedOptionId`);
    if (recommendedOptionId !== null && !optionIds.has(recommendedOptionId)) {
      fail('INVALID_QUESTION_SET', `question ${id} recommends an unknown option`);
    }
    const recommendationReason = row.recommendationReason === null
      ? null
      : normalizeText(row.recommendationReason, `question ${id}.recommendationReason`);
    if ((recommendedOptionId === null) !== (recommendationReason === null)) {
      fail('INVALID_QUESTION_SET', `question ${id} recommendation id and reason must be provided together`);
    }
    return {
      id,
      kind: row.kind,
      prompt: normalizeText(row.prompt, `question ${id}.prompt`),
      options,
      recommendedOptionId,
      recommendationReason,
      allowOther: true
    };
  });
}

function normalizeAnswers(questionSet: QuestionSet, input: readonly PlanningQuestionAnswer[]): PlanningQuestionAnswer[] {
  if (input.length !== questionSet.questions.length) fail('INVALID_ANSWERS', 'every question must be answered exactly once');
  const byId = new Map(questionSet.questions.map((question) => [question.id, question]));
  const answered = new Set<string>();
  const normalized = input.map((candidate, index): PlanningQuestionAnswer => {
    const row = requireRecord(candidate, `answers[${index}]`);
    assertExactKeys(row, ['questionId', 'selectedOptionIds', 'text'], `answers[${index}]`);
    const questionId = normalizeId(row.questionId, `answers[${index}].questionId`);
    const question = byId.get(questionId);
    if (!question || answered.has(questionId)) fail('INVALID_ANSWERS', `answer references an unknown or duplicate question ${questionId}`);
    answered.add(questionId);
    const selectedOptionIds = normalizeIdList(row.selectedOptionIds, `answer ${questionId}.selectedOptionIds`);
    const text = row.text === null ? null : normalizeText(row.text, `answer ${questionId}.text`);
    const allowed = new Set(question.options.map((option) => option.id));
    if (selectedOptionIds.some((id) => !allowed.has(id))) fail('INVALID_ANSWERS', `answer ${questionId} selects an unknown option`);
    if (question.kind === 'text') {
      if (selectedOptionIds.length !== 0 || text === null) fail('INVALID_ANSWERS', `text question ${questionId} requires text only`);
    } else if (question.kind === 'single') {
      if (selectedOptionIds.length > 1 || (selectedOptionIds.length === 0 && text === null)) {
        fail('INVALID_ANSWERS', `single question ${questionId} requires one option or an additional answer`);
      }
    } else if (selectedOptionIds.length === 0 && text === null) {
      fail('INVALID_ANSWERS', `multi question ${questionId} requires options or an additional answer`);
    }
    return { questionId, selectedOptionIds, text };
  });
  return normalized.sort((left, right) => left.questionId.localeCompare(right.questionId));
}

export function normalizeAndValidatePlan(input: unknown, policy: PlanValidationPolicy): CompanyExecutionPlan {
  const row = requireRecord(input, 'plan');
  assertExactKeys(row, [
    'schemaVersion', 'organizationId', 'objective', 'assumptions', 'scope', 'team', 'dag', 'risks', 'overallBudget', 'acceptanceCriteria'
  ], 'plan');
  if (row.schemaVersion !== 1) fail('INVALID_PLAN', 'plan.schemaVersion must be 1');
  const organizationId = normalizeId(row.organizationId, 'plan.organizationId');
  const expectedOrganizationId = normalizeId(policy.organizationId, 'policy.organizationId');
  if (organizationId !== expectedOrganizationId) fail('ORGANIZATION_BOUNDARY', 'plan belongs to a different organization');
  if (!Number.isSafeInteger(policy.maxRetryAttempts) || policy.maxRetryAttempts < 1) {
    fail('INVALID_POLICY', 'policy.maxRetryAttempts must be a positive safe integer');
  }

  const agentById = new Map<string, PlanningAgentSnapshot>();
  for (const agent of policy.agents) {
    if (agentById.has(agent.id)) fail('INVALID_POLICY', `duplicate agent snapshot ${agent.id}`);
    agentById.set(agent.id, agent);
  }
  const validateAgent = (agentId: string, path: string): PlanningAgentSnapshot => {
    const agent = agentById.get(agentId);
    if (!agent) fail('UNKNOWN_AGENT', `${path} references unknown agent ${agentId}`);
    if (agent.organizationId !== organizationId) fail('ORGANIZATION_BOUNDARY', `agent ${agentId} belongs to a different organization`);
    if (agent.archived) fail('AGENT_NOT_ELIGIBLE', `agent ${agentId} is archived`);
    if (agent.lifecycle !== 'READY') fail('AGENT_NOT_ELIGIBLE', `agent ${agentId} is not READY`);
    return agent;
  };

  const teamRows = requireArray(row.team, 'plan.team');
  if (teamRows.length === 0) fail('INVALID_PLAN', 'plan.team must not be empty');
  const teamIds = new Set<string>();
  const roster = new Set<string>();
  const team = teamRows.map((candidate, index): PlanTeamAssignment => {
    const item = requireRecord(candidate, `plan.team[${index}]`);
    assertExactKeys(item, ['teamId', 'organizationId', 'leadAgentId', 'memberAgentIds', 'proposedEphemeralRoles'], `plan.team[${index}]`);
    const teamId = normalizeId(item.teamId, `plan.team[${index}].teamId`);
    if (teamIds.has(teamId)) fail('INVALID_PLAN', `duplicate team id ${teamId}`);
    teamIds.add(teamId);
    const teamOrganizationId = normalizeId(item.organizationId, `team ${teamId}.organizationId`);
    if (teamOrganizationId !== organizationId) fail('ORGANIZATION_BOUNDARY', `team ${teamId} crosses the organization boundary`);
    const leadAgentId = normalizeId(item.leadAgentId, `team ${teamId}.leadAgentId`);
    validateAgent(leadAgentId, `team ${teamId}`);
    const memberAgentIds = normalizeIdList(item.memberAgentIds, `team ${teamId}.memberAgentIds`).sort();
    if (memberAgentIds.includes(leadAgentId)) fail('INVALID_PLAN', `team ${teamId} repeats its lead as a member`);
    for (const memberId of memberAgentIds) validateAgent(memberId, `team ${teamId}`);
    for (const agentId of [leadAgentId, ...memberAgentIds]) {
      if (roster.has(agentId)) fail('ORGANIZATION_BOUNDARY', `agent ${agentId} is assigned to multiple teams`);
      roster.add(agentId);
    }
    const proposedEphemeralRoles = normalizeTextList(item.proposedEphemeralRoles, `team ${teamId}.proposedEphemeralRoles`).sort();
    if (proposedEphemeralRoles.length > 0 && !policy.allowEphemeralTeams) {
      fail('ORGANIZATION_BOUNDARY', `team ${teamId} proposes an unauthorized ephemeral team`);
    }
    return { teamId, organizationId: teamOrganizationId, leadAgentId, memberAgentIds, proposedEphemeralRoles };
  }).sort((left, right) => left.teamId.localeCompare(right.teamId));

  const allowedProfiles = new Set(policy.allowedPermissionProfiles);
  const globallyAllowedPermissions = new Set(policy.allowedPermissions);
  const rawNodes = requireArray(row.dag, 'plan.dag');
  if (rawNodes.length === 0) fail('INVALID_DAG', 'plan.dag must not be empty');
  const nodeIds = new Set<string>();
  const dag = rawNodes.map((candidate, index): PlanDagNode => {
    const item = requireRecord(candidate, `plan.dag[${index}]`);
    assertExactKeys(item, [
      'nodeId', 'organizationId', 'ownerAgentId', 'dependencies', 'workOrder', 'expectedArtifacts', 'acceptanceCriteria',
      'permissionProfile', 'requiredPermissions', 'budget', 'retryPolicy'
    ], `plan.dag[${index}]`);
    const nodeId = normalizeId(item.nodeId, `plan.dag[${index}].nodeId`);
    if (nodeIds.has(nodeId)) fail('INVALID_DAG', `duplicate DAG node ${nodeId}`);
    nodeIds.add(nodeId);
    const nodeOrganizationId = normalizeId(item.organizationId, `node ${nodeId}.organizationId`);
    if (nodeOrganizationId !== organizationId) fail('ORGANIZATION_BOUNDARY', `node ${nodeId} crosses the organization boundary`);
    const ownerAgentId = normalizeId(item.ownerAgentId, `node ${nodeId}.ownerAgentId`);
    const agent = validateAgent(ownerAgentId, `node ${nodeId}`);
    if (!roster.has(ownerAgentId)) fail('ORGANIZATION_BOUNDARY', `node ${nodeId} owner is outside the approved team roster`);
    const permissionProfile = normalizeId(item.permissionProfile, `node ${nodeId}.permissionProfile`);
    if (!allowedProfiles.has(permissionProfile) || !agent.permissionProfiles.includes(permissionProfile)) {
      fail('PERMISSION_DENIED', `node ${nodeId} requests unauthorized permission profile ${permissionProfile}`);
    }
    const requiredPermissions = normalizeIdList(item.requiredPermissions, `node ${nodeId}.requiredPermissions`);
    for (const permission of requiredPermissions) {
      if (!globallyAllowedPermissions.has(permission) || !agent.permissions.includes(permission)) {
        fail('PERMISSION_DENIED', `node ${nodeId} requests unauthorized permission ${permission}`);
      }
    }
    const retryPolicy = normalizeRetryPolicy(item.retryPolicy, `node ${nodeId}.retryPolicy`);
    if (retryPolicy.maxAttempts > policy.maxRetryAttempts) fail('PERMISSION_DENIED', `node ${nodeId} exceeds retry policy`);
    return {
      nodeId,
      organizationId: nodeOrganizationId,
      ownerAgentId,
      dependencies: normalizeIdList(item.dependencies, `node ${nodeId}.dependencies`).sort(),
      workOrder: normalizeText(item.workOrder, `node ${nodeId}.workOrder`),
      expectedArtifacts: normalizeTextList(item.expectedArtifacts, `node ${nodeId}.expectedArtifacts`, true),
      acceptanceCriteria: normalizeTextList(item.acceptanceCriteria, `node ${nodeId}.acceptanceCriteria`, true),
      permissionProfile,
      requiredPermissions: requiredPermissions.sort(),
      budget: normalizeBudget(item.budget, `node ${nodeId}.budget`),
      retryPolicy
    };
  }).sort((left, right) => left.nodeId.localeCompare(right.nodeId));

  for (const node of dag) {
    if (node.dependencies.includes(node.nodeId)) fail('INVALID_DAG', `node ${node.nodeId} depends on itself`);
    for (const dependency of node.dependencies) {
      if (!nodeIds.has(dependency)) fail('INVALID_DAG', `node ${node.nodeId} has missing dependency ${dependency}`);
    }
  }
  topologicallySortPlanNodes(dag);

  const overallBudget = normalizeBudget(row.overallBudget, 'plan.overallBudget');
  const maximumBudget = normalizeBudget(policy.maxBudget, 'policy.maxBudget');
  const nodeTime = dag.reduce((sum, node) => sum + node.budget.timeMinutes, 0);
  const nodeTokens = dag.reduce((sum, node) => sum + node.budget.tokenLimit, 0);
  const nodeCostUnits = dag.reduce((sum, node) => sum + costUnits(node.budget.costLimit), 0);
  if (!Number.isSafeInteger(nodeTime) || !Number.isSafeInteger(nodeTokens) || !Number.isSafeInteger(nodeCostUnits)) {
    fail('BUDGET_EXCEEDED', 'aggregate node budget exceeds the supported numeric range');
  }
  if (nodeTime > overallBudget.timeMinutes || nodeTokens > overallBudget.tokenLimit || nodeCostUnits > costUnits(overallBudget.costLimit)) {
    fail('BUDGET_EXCEEDED', 'aggregate node budget exceeds plan.overallBudget');
  }
  if (
    overallBudget.timeMinutes > maximumBudget.timeMinutes
    || overallBudget.tokenLimit > maximumBudget.tokenLimit
    || costUnits(overallBudget.costLimit) > costUnits(maximumBudget.costLimit)
  ) fail('BUDGET_EXCEEDED', 'plan.overallBudget exceeds policy limits');

  const rawRisks = requireArray(row.risks, 'plan.risks');
  const risks = rawRisks.map((candidate, index): PlanRisk => {
    const item = requireRecord(candidate, `plan.risks[${index}]`);
    assertExactKeys(item, ['risk', 'mitigation', 'ownerAgentId'], `plan.risks[${index}]`);
    const ownerAgentId = normalizeId(item.ownerAgentId, `plan.risks[${index}].ownerAgentId`);
    validateAgent(ownerAgentId, `plan.risks[${index}]`);
    if (!roster.has(ownerAgentId)) fail('ORGANIZATION_BOUNDARY', `risk owner ${ownerAgentId} is outside the approved team roster`);
    return {
      risk: normalizeText(item.risk, `plan.risks[${index}].risk`),
      mitigation: normalizeText(item.mitigation, `plan.risks[${index}].mitigation`),
      ownerAgentId
    };
  });
  const scope = requireRecord(row.scope, 'plan.scope');
  assertExactKeys(scope, ['included', 'excluded'], 'plan.scope');
  return {
    schemaVersion: 1,
    organizationId,
    objective: normalizeText(row.objective, 'plan.objective'),
    assumptions: normalizeTextList(row.assumptions, 'plan.assumptions'),
    scope: {
      included: normalizeTextList(scope.included, 'plan.scope.included'),
      excluded: normalizeTextList(scope.excluded, 'plan.scope.excluded')
    },
    team,
    dag,
    risks,
    overallBudget,
    acceptanceCriteria: normalizeTextList(row.acceptanceCriteria, 'plan.acceptanceCriteria', true)
  };
}

export function topologicallySortPlanNodes(nodes: readonly PlanDagNode[]): PlanDagNode[] {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  if (byId.size !== nodes.length) fail('INVALID_DAG', 'DAG contains duplicate node ids');
  const indegree = new Map(nodes.map((node) => [node.nodeId, node.dependencies.length]));
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dependency of node.dependencies) {
      if (!byId.has(dependency)) fail('INVALID_DAG', `node ${node.nodeId} has missing dependency ${dependency}`);
      if (dependency === node.nodeId) fail('INVALID_DAG', `node ${node.nodeId} depends on itself`);
      const list = dependents.get(dependency) ?? [];
      list.push(node.nodeId);
      dependents.set(dependency, list);
    }
  }
  const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id).sort();
  const sorted: PlanDagNode[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    sorted.push(byId.get(id)!);
    for (const dependent of (dependents.get(id) ?? []).sort()) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  if (sorted.length !== nodes.length) fail('INVALID_DAG', 'DAG contains a cycle');
  return sorted;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryPlanningRepository implements PlanningRepository {
  private sessions = new Map<string, PlanningSession>();
  private questionSets = new Map<string, QuestionSet>();
  private planVersions = new Map<string, PlanVersionRecord>();
  private receipts = new Map<string, PlanDispatchReceipt>();

  transaction<T>(operation: () => T): T {
    const backup = clone({
      sessions: [...this.sessions.entries()],
      questionSets: [...this.questionSets.entries()],
      planVersions: [...this.planVersions.entries()],
      receipts: [...this.receipts.entries()]
    });
    try {
      return operation();
    } catch (error) {
      this.sessions = new Map(backup.sessions);
      this.questionSets = new Map(backup.questionSets);
      this.planVersions = new Map(backup.planVersions);
      this.receipts = new Map(backup.receipts);
      throw error;
    }
  }

  getSession(sessionId: string): PlanningSession | null {
    const value = this.sessions.get(sessionId);
    return value ? clone(value) : null;
  }

  listSessions(limit: number): PlanningSession[] {
    return [...this.sessions.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))
      .slice(0, limit)
      .map(clone);
  }

  saveSession(session: PlanningSession, expectedRevision: number | null): void {
    const current = this.sessions.get(session.id);
    if (expectedRevision === null) {
      if (current) fail('REVISION_CONFLICT', `planning session ${session.id} already exists`);
    } else if (!current || current.revision !== expectedRevision) {
      fail('REVISION_CONFLICT', `planning session ${session.id} revision changed`);
    } else if (
      current.organizationId !== session.organizationId
      || current.principalId !== session.principalId
      || current.createdAt !== session.createdAt
      || current.request !== session.request
      || canonicalJson(current.gateDecision) !== canonicalJson(session.gateDecision)
      || canonicalJson(current.signals ?? null) !== canonicalJson(session.signals ?? null)
    ) {
      fail('REVISION_CONFLICT', `planning session ${session.id} identity fields are immutable`);
    }
    this.sessions.set(session.id, clone(session));
  }

  getQuestionSet(sessionId: string, version: number): QuestionSet | null {
    const value = this.questionSets.get(`${sessionId}:${version}`);
    return value ? clone(value) : null;
  }

  saveQuestionSet(questionSet: QuestionSet, expectedAnsweredAt: number | null | undefined): void {
    const key = `${questionSet.sessionId}:${questionSet.version}`;
    const current = this.questionSets.get(key);
    if (expectedAnsweredAt === undefined) {
      if (current) fail('REVISION_CONFLICT', `question set ${key} already exists`);
    } else if (!current || current.answeredAt !== expectedAnsweredAt) {
      fail('REVISION_CONFLICT', `question set ${key} changed`);
    }
    this.questionSets.set(key, clone(questionSet));
  }

  getPlanVersion(sessionId: string, version: number): PlanVersionRecord | null {
    const value = this.planVersions.get(`${sessionId}:${version}`);
    return value ? clone(value) : null;
  }

  listPlanVersions(sessionId: string): PlanVersionRecord[] {
    return [...this.planVersions.values()]
      .filter((record) => record.sessionId === sessionId)
      .sort((left, right) => left.version - right.version)
      .map(clone);
  }

  savePlanVersion(planVersion: PlanVersionRecord, expectedStatus: PlanVersionStatus | null): void {
    const key = `${planVersion.sessionId}:${planVersion.version}`;
    const current = this.planVersions.get(key);
    if (expectedStatus === null) {
      if (current) fail('REVISION_CONFLICT', `plan version ${key} already exists`);
    } else if (!current || current.status !== expectedStatus) {
      fail('REVISION_CONFLICT', `plan version ${key} changed`);
    }
    this.planVersions.set(key, clone(planVersion));
  }

  getDispatchReceipt(sessionId: string, planVersion: number, nodeId: string): PlanDispatchReceipt | null {
    const value = this.receipts.get(`${sessionId}:${planVersion}:${nodeId}`);
    return value ? clone(value) : null;
  }

  saveDispatchReceipt(receipt: PlanDispatchReceipt): void {
    const key = `${receipt.sessionId}:${receipt.planVersion}:${receipt.nodeId}`;
    const current = this.receipts.get(key);
    if (current) {
      if (
        current.sessionId !== receipt.sessionId
        || current.planVersion !== receipt.planVersion
        || current.planHash !== receipt.planHash
        || current.nodeId !== receipt.nodeId
        || current.taskId !== receipt.taskId
        || current.idempotencyKey !== receipt.idempotencyKey
      ) fail('DISPATCH_CONFLICT', `dispatch receipt ${key} conflicts`);
      return;
    }
    this.receipts.set(key, clone(receipt));
  }
}

export interface SecretaryPlanningDependencies {
  now?: () => number;
  idFactory?: () => string;
}

export class SecretaryPlanningService {
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(
    private readonly repository: PlanningRepository,
    private readonly dispatchPort: DispatchPort,
    dependencies: SecretaryPlanningDependencies = {}
  ) {
    this.now = dependencies.now ?? Date.now;
    this.idFactory = dependencies.idFactory ?? randomUUID;
  }

  createSession(input: {
    id?: string;
    organizationId: string;
    principalId: string;
    request: string;
    signals: PlanningComplexitySignals;
    gateConfig?: Partial<PlanningGateConfig>;
  }): PlanningSession {
    const now = this.now();
    const session: PlanningSession = {
      id: normalizeId(input.id ?? this.idFactory(), 'session.id'),
      organizationId: normalizeId(input.organizationId, 'session.organizationId'),
      principalId: normalizeId(input.principalId, 'session.principalId'),
      request: normalizeText(input.request, 'session.request'),
      signals: {
        ...input.signals,
        departmentIds: [...input.signals.departmentIds],
        irreversibleOperations: [...input.signals.irreversibleOperations]
      },
      status: 'DRAFT',
      gateDecision: evaluatePlanningGate(input.signals, input.gateConfig),
      questionSetVersion: 0,
      activeQuestionSetVersion: null,
      latestPlanVersion: 0,
      approvedPlanVersion: null,
      approvedPlanHash: null,
      dispatchPlanVersion: null,
      dispatchPlanHash: null,
      dispatchStartedAt: null,
      supersededBySessionId: null,
      revision: 1,
      createdAt: now,
      updatedAt: now
    };
    this.repository.saveSession(session, null);
    return clone(session);
  }

  getSession(sessionId: string): PlanningSession {
    return this.requireSession(sessionId);
  }

  issueQuestionSet(sessionId: string, questions: readonly PlanningQuestion[]): QuestionSet {
    return this.repository.transaction(() => {
      const session = this.requireSession(sessionId);
      if (session.status !== 'DRAFT') fail('INVALID_STATE', `cannot issue questions while session is ${session.status}`);
      const now = this.now();
      const version = session.questionSetVersion + 1;
      const questionSet: QuestionSet = {
        id: normalizeId(this.idFactory(), 'questionSet.id'),
        sessionId,
        version,
        questions: normalizeQuestions(questions),
        answers: null,
        createdAt: now,
        answeredAt: null,
        answeredBy: null
      };
      this.repository.saveQuestionSet(questionSet, undefined);
      this.saveSessionUpdate(session, {
        status: 'NEEDS_INPUT',
        questionSetVersion: version,
        activeQuestionSetVersion: version,
        updatedAt: now
      });
      return clone(questionSet);
    });
  }

  answerQuestionSet(
    sessionId: string,
    questionSetVersion: number,
    principalId: string,
    answers: readonly PlanningQuestionAnswer[]
  ): QuestionSet {
    return this.repository.transaction(() => {
      const session = this.requireSession(sessionId);
      if (session.status !== 'NEEDS_INPUT' || session.activeQuestionSetVersion !== questionSetVersion) {
        fail('STALE_QUESTION_SET', 'answers do not target the active question set version');
      }
      if (session.principalId !== principalId) fail('PRINCIPAL_MISMATCH', 'only the session principal may answer planning questions');
      const questionSet = this.repository.getQuestionSet(sessionId, questionSetVersion);
      if (!questionSet || questionSet.answeredAt !== null) fail('STALE_QUESTION_SET', 'question set is missing or already answered');
      const now = this.now();
      const answered: QuestionSet = {
        ...questionSet,
        answers: normalizeAnswers(questionSet, answers),
        answeredAt: now,
        answeredBy: principalId
      };
      this.repository.saveQuestionSet(answered, null);
      this.saveSessionUpdate(session, { status: 'DRAFT', activeQuestionSetVersion: null, updatedAt: now });
      return clone(answered);
    });
  }

  proposePlan(sessionId: string, input: unknown, policy: PlanValidationPolicy): PlanVersionRecord {
    return this.repository.transaction(() => {
      const session = this.requireSession(sessionId);
      if (!['DRAFT', 'PROPOSED', 'APPROVED', 'REJECTED'].includes(session.status)) {
        fail('INVALID_STATE', `cannot propose a plan while session is ${session.status}`);
      }
      if (session.dispatchStartedAt !== null) fail('DISPATCH_IN_PROGRESS', 'a plan cannot be modified after dispatch has started');
      if (policy.organizationId !== session.organizationId) fail('ORGANIZATION_BOUNDARY', 'validation policy does not match the session organization');
      const plan = normalizeAndValidatePlan(input, policy);
      const now = this.now();
      const version = session.latestPlanVersion + 1;
      let supersedesVersion: number | null = null;
      if (session.latestPlanVersion > 0) {
        const previous = this.repository.getPlanVersion(sessionId, session.latestPlanVersion);
        if (!previous) fail('PLAN_NOT_FOUND', 'latest plan version is missing');
        supersedesVersion = previous.version;
        // Approved and rejected records are immutable decision evidence. A new
        // version points backward; only an unapproved proposal is closed out.
        if (previous.status === 'PROPOSED') {
          const superseded: PlanVersionRecord = {
            ...previous,
            status: 'SUPERSEDED',
            supersededAt: now,
            supersededByVersion: version
          };
          this.repository.savePlanVersion(superseded, 'PROPOSED');
        }
      }
      const record: PlanVersionRecord = {
        sessionId,
        version,
        hash: hashCanonicalJson(plan),
        status: 'PROPOSED',
        plan,
        createdAt: now,
        approvedAt: null,
        approvedBy: null,
        rejectedAt: null,
        rejectedBy: null,
        supersededAt: null,
        supersededByVersion: null,
        supersedesVersion
      };
      this.repository.savePlanVersion(record, null);
      this.saveSessionUpdate(session, {
        status: 'PROPOSED',
        latestPlanVersion: version,
        approvedPlanVersion: null,
        approvedPlanHash: null,
        dispatchPlanVersion: null,
        dispatchPlanHash: null,
        dispatchStartedAt: null,
        updatedAt: now
      });
      return clone(record);
    });
  }

  approvePlan(sessionId: string, version: number, hash: string, principalId: string): PlanVersionRecord {
    return this.repository.transaction(() => {
      const session = this.requireSession(sessionId);
      if (session.status !== 'PROPOSED' || session.latestPlanVersion !== version) {
        fail('STALE_PLAN_VERSION', 'approval does not target the current proposed plan');
      }
      if (session.principalId !== principalId) fail('PRINCIPAL_MISMATCH', 'only the session principal may approve a plan');
      const record = this.requirePlanVersion(sessionId, version);
      if (record.status !== 'PROPOSED' || record.supersededByVersion !== null || record.hash !== hash) {
        fail('PLAN_HASH_MISMATCH', 'approval must name the exact active plan version and hash');
      }
      if (hashCanonicalJson(record.plan) !== record.hash) fail('PLAN_HASH_MISMATCH', 'stored plan does not match its hash');
      const now = this.now();
      const approved: PlanVersionRecord = { ...record, status: 'APPROVED', approvedAt: now, approvedBy: principalId };
      this.repository.savePlanVersion(approved, 'PROPOSED');
      this.saveSessionUpdate(session, {
        status: 'APPROVED',
        approvedPlanVersion: version,
        approvedPlanHash: hash,
        dispatchPlanVersion: null,
        dispatchPlanHash: null,
        dispatchStartedAt: null,
        updatedAt: now
      });
      return clone(approved);
    });
  }

  rejectPlan(sessionId: string, version: number, hash: string, principalId: string): PlanVersionRecord {
    return this.repository.transaction(() => {
      const session = this.requireSession(sessionId);
      if (session.status !== 'PROPOSED' || session.latestPlanVersion !== version) fail('STALE_PLAN_VERSION', 'rejection targets a stale plan');
      if (session.principalId !== principalId) fail('PRINCIPAL_MISMATCH', 'only the session principal may reject a plan');
      const record = this.requirePlanVersion(sessionId, version);
      if (record.status !== 'PROPOSED' || record.hash !== hash) fail('PLAN_HASH_MISMATCH', 'rejection must name the exact plan hash');
      const now = this.now();
      const rejected: PlanVersionRecord = { ...record, status: 'REJECTED', rejectedAt: now, rejectedBy: principalId };
      this.repository.savePlanVersion(rejected, 'PROPOSED');
      this.saveSessionUpdate(session, { status: 'REJECTED', updatedAt: now });
      return clone(rejected);
    });
  }

  async dispatchApprovedPlan(sessionId: string, policy: PlanValidationPolicy): Promise<PlanDispatchReceipt[]> {
    const session = this.requireSession(sessionId);
    if (session.status !== 'APPROVED' && session.status !== 'DISPATCHED') {
      fail('PLAN_NOT_APPROVED', 'plan must be approved before dispatch');
    }
    if (session.approvedPlanVersion === null || session.approvedPlanHash === null) fail('PLAN_NOT_APPROVED', 'approved plan reference is missing');
    if (policy.organizationId !== session.organizationId) fail('ORGANIZATION_BOUNDARY', 'dispatch policy does not match the session organization');
    const record = this.requirePlanVersion(sessionId, session.approvedPlanVersion);
    if (record.status !== 'APPROVED' || record.hash !== session.approvedPlanHash || hashCanonicalJson(record.plan) !== record.hash) {
      fail('PLAN_HASH_MISMATCH', 'approved plan record is inconsistent');
    }
    if (session.status === 'DISPATCHED') {
      return topologicallySortPlanNodes(record.plan.dag).map((node) => {
        const receipt = this.repository.getDispatchReceipt(sessionId, record.version, node.nodeId);
        if (!receipt || receipt.planHash !== record.hash) {
          fail('DISPATCH_CONFLICT', `dispatched node ${node.nodeId} has no matching receipt`);
        }
        return receipt;
      });
    }
    const plan = normalizeAndValidatePlan(record.plan, policy);
    this.repository.transaction(() => {
      const current = this.requireSession(sessionId);
      if (
        current.status !== 'APPROVED'
        || current.approvedPlanVersion !== record.version
        || current.approvedPlanHash !== record.hash
      ) fail('REVISION_CONFLICT', 'planning session changed before dispatch');
      if (current.dispatchStartedAt === null) {
        this.saveSessionUpdate(current, {
          dispatchPlanVersion: record.version,
          dispatchPlanHash: record.hash,
          dispatchStartedAt: this.now(),
          updatedAt: this.now()
        });
      } else if (current.dispatchPlanVersion !== record.version || current.dispatchPlanHash !== record.hash) {
        fail('DISPATCH_CONFLICT', 'another plan version already owns the dispatch claim');
      }
    });
    const orderedNodes = topologicallySortPlanNodes(plan.dag);
    const receipts = new Map<string, PlanDispatchReceipt>();
    for (const node of orderedNodes) {
      const current = this.repository.getDispatchReceipt(sessionId, record.version, node.nodeId);
      if (current) {
        if (current.planHash !== record.hash) fail('DISPATCH_CONFLICT', `node ${node.nodeId} was dispatched from another plan hash`);
        receipts.set(node.nodeId, current);
        continue;
      }
      const dependencyTaskIds = node.dependencies.map((dependency) => {
        const receipt = receipts.get(dependency)
          ?? this.repository.getDispatchReceipt(sessionId, record.version, dependency);
        if (!receipt) fail('DISPATCH_CONFLICT', `dependency ${dependency} has no dispatch receipt`);
        return receipt.taskId;
      });
      const idempotencyKey = `planning:${sessionId}:${record.version}:${record.hash}:${node.nodeId}`;
      const result = await this.dispatchPort.createTask({
        idempotencyKey,
        sessionId,
        organizationId: plan.organizationId,
        planVersion: record.version,
        planHash: record.hash,
        nodeId: node.nodeId,
        ownerAgentId: node.ownerAgentId,
        dependencyTaskIds,
        workOrder: node.workOrder,
        expectedArtifacts: [...node.expectedArtifacts],
        acceptanceCriteria: [...node.acceptanceCriteria],
        permissionProfile: node.permissionProfile,
        requiredPermissions: [...node.requiredPermissions],
        budget: { ...node.budget },
        retryPolicy: { ...node.retryPolicy }
      });
      const taskId = normalizeId(result?.taskId, `dispatch result for ${node.nodeId}`);
      const receipt: PlanDispatchReceipt = {
        sessionId,
        planVersion: record.version,
        planHash: record.hash,
        nodeId: node.nodeId,
        taskId,
        idempotencyKey,
        createdAt: this.now()
      };
      this.repository.saveDispatchReceipt(receipt);
      receipts.set(node.nodeId, receipt);
    }
    this.repository.transaction(() => {
      const latest = this.requireSession(sessionId);
      if (latest.status === 'DISPATCHED') return;
      if (
        latest.status !== 'APPROVED'
        || latest.approvedPlanVersion !== record.version
        || latest.approvedPlanHash !== record.hash
        || latest.dispatchPlanVersion !== record.version
        || latest.dispatchPlanHash !== record.hash
      ) fail('REVISION_CONFLICT', 'planning session changed during dispatch');
      this.saveSessionUpdate(latest, { status: 'DISPATCHED', updatedAt: this.now() });
    });
    return orderedNodes.map((node) => clone(receipts.get(node.nodeId)!));
  }

  closeSession(sessionId: string): PlanningSession {
    return this.repository.transaction(() => {
      const session = this.requireSession(sessionId);
      if (session.status !== 'DISPATCHED') fail('INVALID_STATE', 'only a dispatched planning session may be closed');
      return this.saveSessionUpdate(session, { status: 'CLOSED', updatedAt: this.now() });
    });
  }

  cancelSession(sessionId: string): PlanningSession {
    return this.repository.transaction(() => {
      const session = this.requireSession(sessionId);
      if (['DISPATCHED', 'CLOSED', 'SUPERSEDED', 'CANCELLED'].includes(session.status)) {
        fail('INVALID_STATE', `cannot cancel a session while it is ${session.status}`);
      }
      if (session.dispatchStartedAt !== null) fail('DISPATCH_IN_PROGRESS', 'a session cannot be cancelled after dispatch has started');
      return this.saveSessionUpdate(session, { status: 'CANCELLED', updatedAt: this.now() });
    });
  }

  supersedeSession(sessionId: string, replacementSessionId: string): PlanningSession {
    return this.repository.transaction(() => {
      const session = this.requireSession(sessionId);
      const replacement = this.requireSession(replacementSessionId);
      if (session.id === replacement.id) fail('INVALID_STATE', 'a planning session cannot supersede itself');
      if (session.organizationId !== replacement.organizationId || session.principalId !== replacement.principalId) {
        fail('ORGANIZATION_BOUNDARY', 'replacement session must have the same organization and principal');
      }
      if (['DISPATCHED', 'CLOSED', 'SUPERSEDED', 'CANCELLED'].includes(session.status)) {
        fail('INVALID_STATE', `cannot supersede a session while it is ${session.status}`);
      }
      return this.saveSessionUpdate(session, {
        status: 'SUPERSEDED',
        supersededBySessionId: replacement.id,
        updatedAt: this.now()
      });
    });
  }

  private requireSession(sessionId: string): PlanningSession {
    const session = this.repository.getSession(sessionId);
    if (!session) fail('SESSION_NOT_FOUND', `planning session ${sessionId} does not exist`);
    return session;
  }

  private requirePlanVersion(sessionId: string, version: number): PlanVersionRecord {
    if (!Number.isSafeInteger(version) || version < 1) fail('STALE_PLAN_VERSION', 'plan version is invalid');
    const plan = this.repository.getPlanVersion(sessionId, version);
    if (!plan) fail('PLAN_NOT_FOUND', `plan version ${version} does not exist`);
    return plan;
  }

  private saveSessionUpdate(
    current: PlanningSession,
    update: Partial<Omit<PlanningSession, 'id' | 'revision' | 'createdAt'>>
  ): PlanningSession {
    const next: PlanningSession = { ...current, ...update, revision: current.revision + 1 };
    this.repository.saveSession(next, current.revision);
    return clone(next);
  }
}
