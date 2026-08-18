import { randomUUID } from 'node:crypto';
import type { Database } from './database.js';
import type { DshProjectExecutionContext, ProjectWorkbenchService } from './projectWorkbench.js';
import {
  PlanningError,
  SecretaryPlanningService as DurablePlanningProjection,
  canonicalJson,
  hashCanonicalJson,
  type CompanyExecutionPlan,
  type DispatchPort,
  type PlanDispatchReceipt,
  type PlanValidationPolicy,
  type PlanningAgentSnapshot,
  type PlanningComplexitySignals,
  type PlanningQuestion,
  type PlanningQuestionAnswer,
  type PlanningRepository,
  type PlanningSession,
  type PlanVersionRecord,
  type QuestionSet
} from './secretaryPlanning.js';
import type { PluginCapabilityHandler } from './pluginHost.js';

type Row = Record<string, unknown>;
type GovernanceDatabase = Pick<Database, 'raw' | 'audit'>;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PERMISSION_PROFILES = ['readonly', 'standard', 'trusted', 'autonomous'] as const;
const CAPABILITY_NAMES = ['network', 'shell', 'install', 'browser', 'computer', 'mobile'] as const;
const MAX_ADMISSION_BYTES = 2 * 1024 * 1024;
const ADMISSION_OPERATIONS = [
  'quest.open',
  'questions.project',
  'plan.project',
  'quest.get'
] as const;

export const DSH_QUEST_ADMISSION_SCHEMA_VERSION = 1 as const;
export type DshQuestAdmissionOperation = typeof ADMISSION_OPERATIONS[number];

const GOVERNANCE_DDL = [
  `CREATE TABLE IF NOT EXISTS dsh_quest_governance_bindings (
    planning_session_id TEXT PRIMARY KEY REFERENCES planning_sessions(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    dsh_session_id TEXT NOT NULL REFERENCES dsh_sessions(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    principal_id TEXT NOT NULL REFERENCES principals(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dsh_quest_bindings_project
    ON dsh_quest_governance_bindings(project_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_dsh_quest_bindings_dsh_session
    ON dsh_quest_governance_bindings(dsh_session_id, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS dsh_quest_question_projections (
    planning_session_id TEXT NOT NULL REFERENCES dsh_quest_governance_bindings(planning_session_id) ON DELETE CASCADE,
    dsh_question_set_id TEXT NOT NULL,
    dsh_version INTEGER NOT NULL CHECK(dsh_version > 0),
    local_version INTEGER NOT NULL CHECK(local_version > 0),
    payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(planning_session_id, dsh_version),
    UNIQUE(planning_session_id, dsh_question_set_id),
    UNIQUE(planning_session_id, local_version)
  )`,
  `CREATE TABLE IF NOT EXISTS dsh_quest_plan_projections (
    planning_session_id TEXT NOT NULL REFERENCES dsh_quest_governance_bindings(planning_session_id) ON DELETE CASCADE,
    dsh_plan_id TEXT NOT NULL,
    dsh_version INTEGER NOT NULL CHECK(dsh_version > 0),
    local_version INTEGER NOT NULL CHECK(local_version > 0),
    plan_hash TEXT NOT NULL CHECK(length(plan_hash) = 64),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(planning_session_id, dsh_version),
    UNIQUE(planning_session_id, dsh_plan_id),
    UNIQUE(planning_session_id, local_version)
  )`
] as const;

export interface DshQuestGovernanceBinding {
  planningSessionId: string;
  projectId: string;
  dshSessionId: string;
  organizationId: string;
  principalId: string;
  createdAt: number;
  updatedAt: number;
}

export interface DshQuestQuestionProjection {
  dshQuestionSetId: string;
  dshVersion: number;
  localVersion: number;
  payloadHash: string;
  createdAt: number;
}

export interface DshQuestPlanProjection {
  dshPlanId: string;
  dshVersion: number;
  localVersion: number;
  planHash: string;
  createdAt: number;
}

export interface DshQuestGovernanceView {
  binding: DshQuestGovernanceBinding;
  session: PlanningSession;
  activeQuestionSet: QuestionSet | null;
  planVersions: PlanVersionRecord[];
  questionProjections: DshQuestQuestionProjection[];
  planProjections: DshQuestPlanProjection[];
  dispatchReceipts: PlanDispatchReceipt[];
}

export interface OpenDshQuestInput {
  planningSessionId: string;
  projectId: string;
  dshSessionId: string;
  principalId: string;
  request: string;
  signals: PlanningComplexitySignals;
}

export interface ProjectDshQuestionSetInput {
  planningSessionId: string;
  dshSessionId: string;
  expectedRevision: number;
  questionSet: {
    id: string;
    version: number;
    questions: readonly PlanningQuestion[];
  };
}

export interface AnswerDshQuestQuestionsInput {
  planningSessionId: string;
  principalId: string;
  expectedRevision: number;
  dshQuestionSetId: string;
  dshVersion: number;
  answers: readonly PlanningQuestionAnswer[];
}

export interface ProjectDshPlanInput {
  planningSessionId: string;
  dshSessionId: string;
  expectedRevision: number;
  plan: {
    id: string;
    version: number;
    hash: string;
    value: CompanyExecutionPlan;
  };
}

export interface DecideDshQuestPlanInput {
  planningSessionId: string;
  principalId: string;
  expectedRevision: number;
  dshPlanId: string;
  dshVersion: number;
  hash: string;
}

export interface DispatchDshQuestPlanInput extends DecideDshQuestPlanInput {}

export interface DshQuestGovernanceDependencies {
  db: GovernanceDatabase;
  repository: PlanningRepository;
  dispatchPort: DispatchPort;
  workbench: Pick<ProjectWorkbenchService, 'resolveExecutionContext' | 'bindRootSession'>;
  now?: () => number;
}

export interface DshQuestAdmissionSource {
  runtimeInstanceId: string;
  dshSessionId: string;
}

export interface DshQuestAdmissionEnvelope {
  schemaVersion: typeof DSH_QUEST_ADMISSION_SCHEMA_VERSION;
  requestId: string;
  operation: DshQuestAdmissionOperation;
  runtimeInstanceId: string;
  dshSessionId: string;
  payload: Record<string, unknown>;
}

export interface DshQuestAdmissionResult {
  schemaVersion: typeof DSH_QUEST_ADMISSION_SCHEMA_VERSION;
  requestId: string;
  operation: DshQuestAdmissionOperation;
  view: DshQuestGovernanceView;
}

export interface DshQuestAdmissionOptions {
  /**
   * Main-side runtime/session identity check. A future DSH transport must
   * authenticate before invoking PluginHost; this verifier only confirms that
   * the authenticated runtime is the durable owner of the projected session.
   */
  verifySource(source: Readonly<DshQuestAdmissionSource>, signal: AbortSignal): boolean | Promise<boolean>;
}

function fail(code: string, message: string): never {
  throw new PlanningError(code, message);
}

function id(value: unknown, field: string): string {
  if (typeof value !== 'string' || value !== value.trim() || !ID_PATTERN.test(value)) {
    fail('INVALID_INPUT', `${field} is invalid`);
  }
  return value;
}

function text(value: unknown, field: string, max = 20_000): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    fail('INVALID_INPUT', `${field} is invalid`);
  }
  return value.trim();
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail('INVALID_INPUT', `${field} must be a positive integer`);
  return Number(value);
}

function hash(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) fail('INVALID_INPUT', `${field} is invalid`);
  return value;
}

function number(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail('PERSISTENCE_CORRUPTION', `${field} is invalid`);
  return parsed;
}

function rowText(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== 'string' || value.length === 0) fail('PERSISTENCE_CORRUPTION', `${field} is missing`);
  return value;
}

function boolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function capabilities(value: unknown): Record<string, boolean> {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
  } catch {
    return {};
  }
}

function bindingFromRow(row: Row): DshQuestGovernanceBinding {
  return {
    planningSessionId: rowText(row, 'planning_session_id'),
    projectId: rowText(row, 'project_id'),
    dshSessionId: rowText(row, 'dsh_session_id'),
    organizationId: rowText(row, 'organization_id'),
    principalId: rowText(row, 'principal_id'),
    createdAt: number(row.created_at, 'created_at'),
    updatedAt: number(row.updated_at, 'updated_at')
  };
}

function questionProjectionFromRow(row: Row): DshQuestQuestionProjection {
  return {
    dshQuestionSetId: rowText(row, 'dsh_question_set_id'),
    dshVersion: number(row.dsh_version, 'dsh_version'),
    localVersion: number(row.local_version, 'local_version'),
    payloadHash: rowText(row, 'payload_hash'),
    createdAt: number(row.created_at, 'created_at')
  };
}

function planProjectionFromRow(row: Row): DshQuestPlanProjection {
  return {
    dshPlanId: rowText(row, 'dsh_plan_id'),
    dshVersion: number(row.dsh_version, 'dsh_version'),
    localVersion: number(row.local_version, 'local_version'),
    planHash: rowText(row, 'plan_hash'),
    createdAt: number(row.created_at, 'created_at')
  };
}

function questionPayloadHash(questions: readonly PlanningQuestion[]): string {
  return hashCanonicalJson(questions);
}

function profilesThrough(mode: string): string[] {
  const index = PERMISSION_PROFILES.indexOf(mode as typeof PERMISSION_PROFILES[number]);
  return [...PERMISSION_PROFILES.slice(0, index < 0 ? 2 : index + 1)];
}

function admissionRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ADMISSION', `${field} must be an object`);
  return value as Record<string, unknown>;
}

function exactAdmissionKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const expected = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !expected.has(key));
  const missing = allowed.filter((key) => !(key in value));
  if (unexpected.length > 0 || missing.length > 0) {
    fail('INVALID_ADMISSION', `${field} does not match the admission schema`);
  }
}

function admissionEnvelope(input: unknown): DshQuestAdmissionEnvelope {
  let encoded: string;
  try {
    encoded = canonicalJson(input);
  } catch (error) {
    if (error instanceof PlanningError) fail('INVALID_ADMISSION', error.message);
    throw error;
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_ADMISSION_BYTES) fail('INVALID_ADMISSION', 'DSH Quest admission exceeds the size limit');
  const value = admissionRecord(input, 'admission');
  exactAdmissionKeys(value, [
    'schemaVersion', 'requestId', 'operation', 'runtimeInstanceId', 'dshSessionId', 'payload'
  ], 'admission');
  if (value.schemaVersion !== DSH_QUEST_ADMISSION_SCHEMA_VERSION) fail('INVALID_ADMISSION', 'unsupported DSH Quest admission schema');
  if (!ADMISSION_OPERATIONS.includes(value.operation as DshQuestAdmissionOperation)) {
    fail('UNSUPPORTED_OPERATION', 'operation is not available through the Cordis admission capability');
  }
  return {
    schemaVersion: DSH_QUEST_ADMISSION_SCHEMA_VERSION,
    requestId: id(value.requestId, 'requestId'),
    operation: value.operation as DshQuestAdmissionOperation,
    runtimeInstanceId: id(value.runtimeInstanceId, 'runtimeInstanceId'),
    dshSessionId: id(value.dshSessionId, 'dshSessionId'),
    payload: admissionRecord(value.payload, 'payload')
  };
}

function openPayload(payload: Record<string, unknown>, dshSessionId: string): OpenDshQuestInput {
  exactAdmissionKeys(payload, ['planningSessionId', 'projectId', 'principalId', 'request', 'signals'], 'quest.open payload');
  const signalValue = admissionRecord(payload.signals, 'signals');
  const requiredSignalKeys = [
    'departmentIds', 'hasCrossTeamDependencies', 'ambiguousObjective', 'ambiguousScope',
    'ambiguousAcceptance', 'estimatedDurationMinutes', 'estimatedCost', 'estimatedTokenCount',
    'requiresNewTeam', 'irreversibleOperations', 'compareAlternatives', 'phasedExecution',
    'confirmBeforeExecution'
  ];
  const allowedSignalKeys = [...requiredSignalKeys, 'estimatedTaskCount'];
  const unexpected = Object.keys(signalValue).filter((key) => !allowedSignalKeys.includes(key));
  const missing = requiredSignalKeys.filter((key) => !(key in signalValue));
  if (unexpected.length > 0 || missing.length > 0) fail('INVALID_ADMISSION', 'signals do not match the admission schema');
  return {
    planningSessionId: id(payload.planningSessionId, 'planningSessionId'),
    projectId: id(payload.projectId, 'projectId'),
    dshSessionId,
    principalId: id(payload.principalId, 'principalId'),
    request: text(payload.request, 'request'),
    signals: structuredClone(signalValue) as unknown as PlanningComplexitySignals
  };
}

function questionPayload(payload: Record<string, unknown>, dshSessionId: string): ProjectDshQuestionSetInput {
  exactAdmissionKeys(payload, ['planningSessionId', 'expectedRevision', 'questionSet'], 'questions.project payload');
  const questionSet = admissionRecord(payload.questionSet, 'questionSet');
  exactAdmissionKeys(questionSet, ['id', 'version', 'questions'], 'questionSet');
  if (!Array.isArray(questionSet.questions)) fail('INVALID_ADMISSION', 'questionSet.questions must be an array');
  return {
    planningSessionId: id(payload.planningSessionId, 'planningSessionId'),
    dshSessionId,
    expectedRevision: positiveInteger(payload.expectedRevision, 'expectedRevision'),
    questionSet: {
      id: id(questionSet.id, 'questionSet.id'),
      version: positiveInteger(questionSet.version, 'questionSet.version'),
      questions: structuredClone(questionSet.questions) as PlanningQuestion[]
    }
  };
}

function planPayload(payload: Record<string, unknown>, dshSessionId: string): ProjectDshPlanInput {
  exactAdmissionKeys(payload, ['planningSessionId', 'expectedRevision', 'plan'], 'plan.project payload');
  const plan = admissionRecord(payload.plan, 'plan');
  exactAdmissionKeys(plan, ['id', 'version', 'hash', 'value'], 'plan');
  return {
    planningSessionId: id(payload.planningSessionId, 'planningSessionId'),
    dshSessionId,
    expectedRevision: positiveInteger(payload.expectedRevision, 'expectedRevision'),
    plan: {
      id: id(plan.id, 'plan.id'),
      version: positiveInteger(plan.version, 'plan.version'),
      hash: hash(plan.hash, 'plan.hash'),
      value: structuredClone(admissionRecord(plan.value, 'plan.value')) as unknown as CompanyExecutionPlan
    }
  };
}

/**
 * Main-process projection and policy boundary for DSH/Cordis Quest facts.
 * Cordis creates the questions and plans. This service only binds, validates,
 * approves, audits and projects them into host-owned project/task records.
 */
export class DshQuestGovernanceService {
  private readonly projection: DurablePlanningProjection;
  private readonly now: () => number;

  constructor(private readonly dependencies: DshQuestGovernanceDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.projection = new DurablePlanningProjection(dependencies.repository, dependencies.dispatchPort, {
      now: this.now,
      idFactory: randomUUID
    });
    for (const statement of GOVERNANCE_DDL) dependencies.db.raw.prepare(statement).run();
  }

  openQuest(input: OpenDshQuestInput): DshQuestGovernanceView {
    const planningSessionId = id(input?.planningSessionId, 'planningSessionId');
    const projectId = id(input?.projectId, 'projectId');
    const dshSessionId = id(input?.dshSessionId, 'dshSessionId');
    const principalId = id(input?.principalId, 'principalId');
    const request = text(input?.request, 'request');
    const existing = this.findBinding(planningSessionId);
    if (existing) {
      const session = this.projection.getSession(planningSessionId);
      if (existing.projectId !== projectId || existing.dshSessionId !== dshSessionId
        || existing.principalId !== principalId || session.request !== request) {
        fail('PROJECTION_CONFLICT', 'DSH Quest identity conflicts with the existing governance projection');
      }
      return this.getQuest(planningSessionId);
    }

    const boundary = this.requireBoundary(projectId, dshSessionId, principalId);
    this.dependencies.workbench.resolveExecutionContext(projectId, boundary.agentId, dshSessionId);
    const now = this.now();
    this.dependencies.repository.transaction(() => {
      this.projection.createSession({
        id: planningSessionId,
        organizationId: boundary.organizationId,
        principalId,
        request,
        signals: input.signals
      });
      this.dependencies.db.raw.prepare(
        `INSERT INTO dsh_quest_governance_bindings(
          planning_session_id, project_id, dsh_session_id, organization_id, principal_id, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?)`
      ).run(planningSessionId, projectId, dshSessionId, boundary.organizationId, principalId, now, now);
    });
    this.dependencies.workbench.bindRootSession(projectId, dshSessionId);
    this.audit('dsh.quest.open', planningSessionId, `project=${projectId};session=${dshSessionId}`, `dsh:${dshSessionId}`);
    return this.getQuest(planningSessionId);
  }

  projectQuestionSet(input: ProjectDshQuestionSetInput): DshQuestGovernanceView {
    const binding = this.requireDshProjectionBoundary(input?.planningSessionId, input?.dshSessionId);
    const sourceId = id(input.questionSet?.id, 'questionSet.id');
    const sourceVersion = positiveInteger(input.questionSet?.version, 'questionSet.version');
    const payloadHash = questionPayloadHash(input.questionSet?.questions ?? []);
    const existing = this.findQuestionProjection(binding.planningSessionId, sourceVersion);
    if (existing) {
      if (existing.dshQuestionSetId !== sourceId || existing.payloadHash !== payloadHash) {
        fail('PROJECTION_CONFLICT', 'DSH QuestionSet version conflicts with its existing projection');
      }
      return this.getQuest(binding.planningSessionId);
    }
    const session = this.assertRevision(binding.planningSessionId, input.expectedRevision);
    if (sourceVersion !== session.questionSetVersion + 1) {
      fail('EVENT_GAP', 'DSH QuestionSet versions must be projected without gaps');
    }
    this.dependencies.repository.transaction(() => {
      const questionSet = this.projection.issueQuestionSet(binding.planningSessionId, input.questionSet.questions);
      if (questionSet.version !== sourceVersion) fail('PROJECTION_CONFLICT', 'local QuestionSet projection version diverged from DSH');
      this.dependencies.db.raw.prepare(
        `INSERT INTO dsh_quest_question_projections(
          planning_session_id, dsh_question_set_id, dsh_version, local_version, payload_hash, created_at
        ) VALUES(?, ?, ?, ?, ?, ?)`
      ).run(binding.planningSessionId, sourceId, sourceVersion, questionSet.version, payloadHash, this.now());
    });
    this.touch(binding.planningSessionId);
    this.audit('dsh.quest.questions.project', binding.planningSessionId, `id=${sourceId};version=${sourceVersion}`, `dsh:${binding.dshSessionId}`);
    return this.getQuest(binding.planningSessionId);
  }

  answerQuestions(input: AnswerDshQuestQuestionsInput): DshQuestGovernanceView {
    const binding = this.requirePrincipal(input?.planningSessionId, input?.principalId);
    this.assertRevision(binding.planningSessionId, input.expectedRevision);
    const projection = this.requireQuestionProjection(
      binding.planningSessionId,
      id(input.dshQuestionSetId, 'dshQuestionSetId'),
      positiveInteger(input.dshVersion, 'dshVersion')
    );
    this.projection.answerQuestionSet(
      binding.planningSessionId,
      projection.localVersion,
      binding.principalId,
      input.answers
    );
    this.touch(binding.planningSessionId);
    this.audit('dsh.quest.questions.answer', binding.planningSessionId, `version=${projection.dshVersion}`, binding.principalId);
    return this.getQuest(binding.planningSessionId);
  }

  projectPlan(input: ProjectDshPlanInput): DshQuestGovernanceView {
    const binding = this.requireDshProjectionBoundary(input?.planningSessionId, input?.dshSessionId);
    const sourceId = id(input.plan?.id, 'plan.id');
    const sourceVersion = positiveInteger(input.plan?.version, 'plan.version');
    const sourceHash = hash(input.plan?.hash, 'plan.hash');
    if (hashCanonicalJson(input.plan?.value) !== sourceHash) fail('PLAN_HASH_MISMATCH', 'DSH plan payload does not match its declared hash');
    const existing = this.findPlanProjection(binding.planningSessionId, sourceVersion);
    if (existing) {
      if (existing.dshPlanId !== sourceId || existing.planHash !== sourceHash) {
        fail('PROJECTION_CONFLICT', 'DSH plan version conflicts with its existing projection');
      }
      return this.getQuest(binding.planningSessionId);
    }
    const session = this.assertRevision(binding.planningSessionId, input.expectedRevision);
    if (sourceVersion !== session.latestPlanVersion + 1) fail('EVENT_GAP', 'DSH plan versions must be projected without gaps');
    const policy = this.validationPolicy(binding, session);
    this.dependencies.repository.transaction(() => {
      const record = this.projection.proposePlan(binding.planningSessionId, input.plan.value, policy);
      if (record.version !== sourceVersion || record.hash !== sourceHash) {
        fail('PROJECTION_CONFLICT', 'local plan projection diverged from DSH identity');
      }
      this.dependencies.db.raw.prepare(
        `INSERT INTO dsh_quest_plan_projections(
          planning_session_id, dsh_plan_id, dsh_version, local_version, plan_hash, created_at
        ) VALUES(?, ?, ?, ?, ?, ?)`
      ).run(binding.planningSessionId, sourceId, sourceVersion, record.version, record.hash, this.now());
    });
    this.touch(binding.planningSessionId);
    this.audit('dsh.quest.plan.project', binding.planningSessionId, `id=${sourceId};version=${sourceVersion};hash=${sourceHash}`, `dsh:${binding.dshSessionId}`);
    return this.getQuest(binding.planningSessionId);
  }

  approvePlan(input: DecideDshQuestPlanInput): DshQuestGovernanceView {
    const binding = this.requirePrincipal(input?.planningSessionId, input?.principalId);
    this.assertRevision(binding.planningSessionId, input.expectedRevision);
    const projection = this.requirePlanProjection(
      binding.planningSessionId,
      id(input.dshPlanId, 'dshPlanId'),
      positiveInteger(input.dshVersion, 'dshVersion'),
      hash(input.hash, 'hash')
    );
    this.projection.approvePlan(binding.planningSessionId, projection.localVersion, projection.planHash, binding.principalId);
    this.touch(binding.planningSessionId);
    this.audit('dsh.quest.plan.approve', binding.planningSessionId, `version=${projection.dshVersion};hash=${projection.planHash}`, binding.principalId);
    return this.getQuest(binding.planningSessionId);
  }

  rejectPlan(input: DecideDshQuestPlanInput): DshQuestGovernanceView {
    const binding = this.requirePrincipal(input?.planningSessionId, input?.principalId);
    this.assertRevision(binding.planningSessionId, input.expectedRevision);
    const projection = this.requirePlanProjection(
      binding.planningSessionId,
      id(input.dshPlanId, 'dshPlanId'),
      positiveInteger(input.dshVersion, 'dshVersion'),
      hash(input.hash, 'hash')
    );
    this.projection.rejectPlan(binding.planningSessionId, projection.localVersion, projection.planHash, binding.principalId);
    this.touch(binding.planningSessionId);
    this.audit('dsh.quest.plan.reject', binding.planningSessionId, `version=${projection.dshVersion};hash=${projection.planHash}`, binding.principalId);
    return this.getQuest(binding.planningSessionId);
  }

  async dispatchPlan(input: DispatchDshQuestPlanInput): Promise<DshQuestGovernanceView> {
    const binding = this.requirePrincipal(input?.planningSessionId, input?.principalId);
    const session = this.assertRevision(binding.planningSessionId, input.expectedRevision);
    const projection = this.requirePlanProjection(
      binding.planningSessionId,
      id(input.dshPlanId, 'dshPlanId'),
      positiveInteger(input.dshVersion, 'dshVersion'),
      hash(input.hash, 'hash')
    );
    if (session.approvedPlanVersion !== projection.localVersion || session.approvedPlanHash !== projection.planHash) {
      fail('PLAN_NOT_APPROVED', 'dispatch must target the exact boss-approved DSH plan');
    }
    await this.projection.dispatchApprovedPlan(binding.planningSessionId, this.validationPolicy(binding, session));
    this.assertProjectScopedReceipts(binding, projection);
    this.touch(binding.planningSessionId);
    this.audit('dsh.quest.plan.dispatch', binding.planningSessionId, `version=${projection.dshVersion};hash=${projection.planHash}`, binding.principalId);
    return this.getQuest(binding.planningSessionId);
  }

  getBinding(planningSessionId: string): DshQuestGovernanceBinding {
    const binding = this.findBinding(id(planningSessionId, 'planningSessionId'));
    if (!binding) fail('SESSION_NOT_FOUND', 'DSH Quest governance binding does not exist');
    this.assertBindingIntegrity(binding);
    return binding;
  }

  getQuest(planningSessionId: string): DshQuestGovernanceView {
    const binding = this.getBinding(planningSessionId);
    const session = this.projection.getSession(binding.planningSessionId);
    const questionProjections = this.listQuestionProjections(binding.planningSessionId);
    const planProjections = this.listPlanProjections(binding.planningSessionId);
    const activeQuestionSet = session.questionSetVersion > 0
      ? this.dependencies.repository.getQuestionSet(binding.planningSessionId, session.questionSetVersion)
      : null;
    const planVersions = this.dependencies.repository.listPlanVersions(binding.planningSessionId);
    const dispatchReceipts = planVersions.flatMap((record) => record.plan.dag
      .map((node) => this.dependencies.repository.getDispatchReceipt(binding.planningSessionId, record.version, node.nodeId))
      .filter((receipt): receipt is PlanDispatchReceipt => receipt !== null));
    return { binding, session, activeQuestionSet, planVersions, questionProjections, planProjections, dispatchReceipts };
  }

  listProjectQuests(projectId: string, limit = 50): DshQuestGovernanceView[] {
    const safeProjectId = id(projectId, 'projectId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_INPUT', 'limit is invalid');
    const rows = this.dependencies.db.raw.prepare(
      `SELECT planning_session_id FROM dsh_quest_governance_bindings
       WHERE project_id = ? ORDER BY updated_at DESC, planning_session_id DESC LIMIT ?`
    ).all(safeProjectId, limit) as Row[];
    return rows.map((row) => this.getQuest(rowText(row, 'planning_session_id')));
  }

  private requireBoundary(
    projectId: string,
    dshSessionId: string,
    principalId: string,
    options: { allowArchived?: boolean } = {}
  ): { organizationId: string; agentId: string } {
    const project = this.dependencies.db.raw.prepare(
      'SELECT id, organization_id, status FROM projects WHERE id = ?'
    ).get(projectId) as Row | undefined;
    if (!project) fail('PROJECT_NOT_FOUND', 'project does not exist');
    if (project.status === 'archived' && !options.allowArchived) fail('PROJECT_ARCHIVED', 'archived projects cannot start a Quest');
    const session = this.dependencies.db.raw.prepare(
      `SELECT s.id, s.agent_id, s.parent_session_id, a.organization_id
       FROM dsh_sessions s JOIN agents a ON a.id = s.agent_id WHERE s.id = ?`
    ).get(dshSessionId) as Row | undefined;
    if (!session || session.parent_session_id !== null && session.parent_session_id !== undefined) {
      fail('SESSION_BOUNDARY', 'DSH Quest must bind to a root session');
    }
    const organizationId = rowText(project, 'organization_id');
    if (rowText(session, 'organization_id') !== organizationId) fail('ORGANIZATION_BOUNDARY', 'DSH session and project belong to different organizations');
    const principal = this.dependencies.db.raw.prepare(
      'SELECT id FROM principals WHERE id = ? AND organization_id = ?'
    ).get(principalId, organizationId) as Row | undefined;
    if (!principal) fail('PRINCIPAL_MISMATCH', 'Quest principal is outside the project organization');
    const conflicting = this.dependencies.db.raw.prepare(
      `SELECT project_id FROM dsh_quest_governance_bindings
       WHERE dsh_session_id = ? AND project_id <> ? LIMIT 1`
    ).get(dshSessionId, projectId) as Row | undefined;
    if (conflicting) fail('PROJECT_BOUNDARY', 'DSH root session is already projected into another project');
    return { organizationId, agentId: rowText(session, 'agent_id') };
  }

  private requireDshProjectionBoundary(planningSessionId: unknown, dshSessionId: unknown): DshQuestGovernanceBinding {
    const binding = this.getBinding(id(planningSessionId, 'planningSessionId'));
    if (binding.dshSessionId !== id(dshSessionId, 'dshSessionId')) fail('SESSION_BOUNDARY', 'DSH fact came from another root session');
    return binding;
  }

  private requirePrincipal(planningSessionId: unknown, principalId: unknown): DshQuestGovernanceBinding {
    const binding = this.getBinding(id(planningSessionId, 'planningSessionId'));
    if (binding.principalId !== id(principalId, 'principalId')) fail('PRINCIPAL_MISMATCH', 'only the Quest owner may decide this plan');
    return binding;
  }

  private assertRevision(planningSessionId: string, expectedRevision: unknown): PlanningSession {
    const expected = positiveInteger(expectedRevision, 'expectedRevision');
    const session = this.projection.getSession(planningSessionId);
    if (session.revision !== expected) fail('REVISION_CONFLICT', `Quest revision changed from ${expected} to ${session.revision}`);
    return session;
  }

  private assertBindingIntegrity(binding: DshQuestGovernanceBinding): void {
    const boundary = this.requireBoundary(binding.projectId, binding.dshSessionId, binding.principalId, { allowArchived: true });
    if (boundary.organizationId !== binding.organizationId) fail('PERSISTENCE_CORRUPTION', 'Quest binding organization changed');
    const session = this.projection.getSession(binding.planningSessionId);
    if (session.organizationId !== binding.organizationId || session.principalId !== binding.principalId) {
      fail('PERSISTENCE_CORRUPTION', 'Quest planning projection identity does not match its binding');
    }
  }

  private validationPolicy(binding: DshQuestGovernanceBinding, session: PlanningSession): PlanValidationPolicy {
    const root = this.dependencies.db.raw.prepare('SELECT agent_id FROM dsh_sessions WHERE id = ?').get(binding.dshSessionId) as Row | undefined;
    if (!root) fail('SESSION_BOUNDARY', 'DSH root session no longer exists');
    const rootAgentId = rowText(root, 'agent_id');
    const context = this.dependencies.workbench.resolveExecutionContext(binding.projectId, rootAgentId, binding.dshSessionId);
    const eligibleIds = new Set([rootAgentId, ...context.quest.workerAgentIds]);
    const rows = this.dependencies.db.raw.prepare(
      `SELECT a.id, a.organization_id, a.lifecycle, a.archived, a.permission_mode,
              a.capabilities_json, e.type AS engine_type
       FROM agents a JOIN engines e ON e.id = a.engine_id
       WHERE a.organization_id = ? ORDER BY a.id`
    ).all(binding.organizationId) as Row[];
    const agents: PlanningAgentSnapshot[] = rows.filter((row) => eligibleIds.has(String(row.id))).map((row) => {
      const mode = PERMISSION_PROFILES.includes(row.permission_mode as typeof PERMISSION_PROFILES[number])
        ? String(row.permission_mode)
        : 'autonomous';
      const flags = capabilities(row.capabilities_json);
      const permissions = new Set<string>(['read']);
      if (mode !== 'readonly') permissions.add('write');
      for (const capability of CAPABILITY_NAMES) if (flags[capability] === true) permissions.add(capability);
      const lifecycle = String(row.lifecycle);
      return {
        id: rowText(row, 'id'),
        organizationId: rowText(row, 'organization_id'),
        lifecycle: ['DISABLED', 'STARTING', 'READY', 'STOPPING', 'ERROR'].includes(lifecycle)
          ? lifecycle as PlanningAgentSnapshot['lifecycle']
          : 'ERROR',
        archived: boolean(row.archived),
        permissionProfiles: profilesThrough(mode),
        permissions: [...permissions].sort()
      };
    });
    const allowedProfiles = profilesThrough(context.quest.permissionMode);
    const allowedPermissions = new Set(agents.flatMap((agent) => agent.permissions));
    if (context.quest.permissionMode === 'readonly') {
      for (const permission of [...allowedPermissions]) if (permission !== 'read') allowedPermissions.delete(permission);
    }
    if (context.quest.permissionMode === 'standard') {
      for (const permission of [...allowedPermissions]) if (permission !== 'read' && permission !== 'write') allowedPermissions.delete(permission);
    }
    const score = session.gateDecision.complexityScore + session.gateDecision.riskScore;
    return {
      organizationId: binding.organizationId,
      agents,
      allowedPermissionProfiles: allowedProfiles,
      allowedPermissions: [...allowedPermissions].sort(),
      maxBudget: {
        timeMinutes: Math.min(24 * 60, Math.max(60, score * 240)),
        tokenLimit: Math.min(2_000_000, Math.max(50_000, score * 100_000)),
        costLimit: Math.min(1_000, Math.max(10, score * 50))
      },
      maxRetryAttempts: 3,
      allowEphemeralTeams: context.quest.mode === 'quest'
    };
  }

  private assertProjectScopedReceipts(binding: DshQuestGovernanceBinding, projection: DshQuestPlanProjection): void {
    const plan = this.dependencies.repository.getPlanVersion(binding.planningSessionId, projection.localVersion);
    if (!plan) fail('PLAN_NOT_FOUND', 'dispatched DSH plan projection is missing');
    for (const node of plan.plan.dag) {
      const receipt = this.dependencies.repository.getDispatchReceipt(binding.planningSessionId, projection.localVersion, node.nodeId);
      if (!receipt) fail('DISPATCH_CONFLICT', `plan node ${node.nodeId} has no dispatch receipt`);
      const task = this.dependencies.db.raw.prepare('SELECT project_id FROM tasks WHERE id = ?').get(receipt.taskId) as Row | undefined;
      if (!task || task.project_id !== binding.projectId) {
        fail('PROJECT_BOUNDARY', `plan node ${node.nodeId} was not projected into its Quest project`);
      }
    }
  }

  private findBinding(planningSessionId: string): DshQuestGovernanceBinding | null {
    const row = this.dependencies.db.raw.prepare(
      'SELECT * FROM dsh_quest_governance_bindings WHERE planning_session_id = ?'
    ).get(planningSessionId) as Row | undefined;
    return row ? bindingFromRow(row) : null;
  }

  private findQuestionProjection(planningSessionId: string, dshVersion: number): DshQuestQuestionProjection | null {
    const row = this.dependencies.db.raw.prepare(
      'SELECT * FROM dsh_quest_question_projections WHERE planning_session_id = ? AND dsh_version = ?'
    ).get(planningSessionId, dshVersion) as Row | undefined;
    return row ? questionProjectionFromRow(row) : null;
  }

  private requireQuestionProjection(planningSessionId: string, sourceId: string, sourceVersion: number): DshQuestQuestionProjection {
    const projection = this.findQuestionProjection(planningSessionId, sourceVersion);
    if (!projection || projection.dshQuestionSetId !== sourceId) fail('STALE_QUESTION_SET', 'answer does not target the active DSH QuestionSet');
    return projection;
  }

  private findPlanProjection(planningSessionId: string, dshVersion: number): DshQuestPlanProjection | null {
    const row = this.dependencies.db.raw.prepare(
      'SELECT * FROM dsh_quest_plan_projections WHERE planning_session_id = ? AND dsh_version = ?'
    ).get(planningSessionId, dshVersion) as Row | undefined;
    return row ? planProjectionFromRow(row) : null;
  }

  private requirePlanProjection(planningSessionId: string, sourceId: string, sourceVersion: number, sourceHash: string): DshQuestPlanProjection {
    const projection = this.findPlanProjection(planningSessionId, sourceVersion);
    if (!projection || projection.dshPlanId !== sourceId || projection.planHash !== sourceHash) {
      fail('PLAN_HASH_MISMATCH', 'decision does not target the exact DSH plan id, version and hash');
    }
    return projection;
  }

  private listQuestionProjections(planningSessionId: string): DshQuestQuestionProjection[] {
    return (this.dependencies.db.raw.prepare(
      'SELECT * FROM dsh_quest_question_projections WHERE planning_session_id = ? ORDER BY dsh_version'
    ).all(planningSessionId) as Row[]).map(questionProjectionFromRow);
  }

  private listPlanProjections(planningSessionId: string): DshQuestPlanProjection[] {
    return (this.dependencies.db.raw.prepare(
      'SELECT * FROM dsh_quest_plan_projections WHERE planning_session_id = ? ORDER BY dsh_version'
    ).all(planningSessionId) as Row[]).map(planProjectionFromRow);
  }

  private touch(planningSessionId: string): void {
    this.dependencies.db.raw.prepare(
      'UPDATE dsh_quest_governance_bindings SET updated_at = ? WHERE planning_session_id = ?'
    ).run(this.now(), planningSessionId);
  }

  private audit(action: string, target: string, result: string, actor: string): void {
    this.dependencies.db.audit({ id: randomUUID(), actor, action, target, result, source: 'dsh' });
  }
}

/** Resolve a project for the project-aware planning dispatch adapter. */
export function resolveDshQuestProjectId(db: GovernanceDatabase, planningSessionId: string): string | null {
  const row = db.raw.prepare(
    'SELECT project_id FROM dsh_quest_governance_bindings WHERE planning_session_id = ?'
  ).get(planningSessionId) as Row | undefined;
  return typeof row?.project_id === 'string' && row.project_id.length > 0 ? row.project_id : null;
}

/**
 * Cordis-facing admission handler for the governance plugin.
 *
 * It intentionally cannot answer questions, approve/reject plans, or dispatch
 * work. Those are trusted owner-side governance actions performed directly on
 * DshQuestGovernanceService after the relevant desktop/LAN approval boundary.
 * rc.6 does not currently provide a stable typed Quest event contract, so no
 * chat/tool event is guessed or parsed into this envelope.
 */
export function createDshQuestGovernanceAdmissionHandler(
  service: DshQuestGovernanceService,
  options: DshQuestAdmissionOptions
): PluginCapabilityHandler {
  return async (input, context): Promise<DshQuestAdmissionResult> => {
    if (context.owner !== 'nexus-governance' || context.capabilityKind !== 'artifact') {
      fail('CAPABILITY_BOUNDARY', 'DSH Quest admission requires the governance artifact capability');
    }
    const envelope = admissionEnvelope(input);
    const source = Object.freeze({
      runtimeInstanceId: envelope.runtimeInstanceId,
      dshSessionId: envelope.dshSessionId
    });
    let verified = false;
    try {
      verified = await options.verifySource(source, context.signal);
    } catch {
      verified = false;
    }
    if (!verified) fail('RUNTIME_BOUNDARY', 'runtime does not own the projected DSH root session');
    if (context.signal.aborted) {
      throw context.signal.reason instanceof Error ? context.signal.reason : new Error('DSH Quest admission aborted');
    }

    let view: DshQuestGovernanceView;
    switch (envelope.operation) {
      case 'quest.open':
        view = service.openQuest(openPayload(envelope.payload, envelope.dshSessionId));
        break;
      case 'questions.project':
        view = service.projectQuestionSet(questionPayload(envelope.payload, envelope.dshSessionId));
        break;
      case 'plan.project':
        view = service.projectPlan(planPayload(envelope.payload, envelope.dshSessionId));
        break;
      case 'quest.get': {
        exactAdmissionKeys(envelope.payload, ['planningSessionId'], 'quest.get payload');
        view = service.getQuest(id(envelope.payload.planningSessionId, 'planningSessionId'));
        if (view.binding.dshSessionId !== envelope.dshSessionId) fail('SESSION_BOUNDARY', 'Quest belongs to another DSH root session');
        break;
      }
      default:
        fail('UNSUPPORTED_OPERATION', 'operation is not available through the Cordis admission capability');
    }
    return {
      schemaVersion: DSH_QUEST_ADMISSION_SCHEMA_VERSION,
      requestId: envelope.requestId,
      operation: envelope.operation,
      view
    };
  };
}

/** Kept separate so tests and future policy plugins can inspect the secret-free execution context. */
export type DshQuestExecutionContext = DshProjectExecutionContext;
