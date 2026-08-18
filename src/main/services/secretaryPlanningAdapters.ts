import type { Database } from './database.js';
import type { Orchestrator } from './orchestrator.js';
import {
  PLANNING_SESSION_STATUSES,
  PlanningError,
  canonicalJson,
  hashCanonicalJson,
  type CompanyExecutionPlan,
  type DispatchPort,
  type DispatchWorkOrder,
  type PlanDispatchReceipt,
  type PlanningQuestion,
  type PlanningQuestionAnswer,
  type PlanningRepository,
  type PlanningSession,
  type PlanVersionRecord,
  type PlanVersionStatus,
  type QuestionSet
} from './secretaryPlanning.js';

type PlanningDatabase = Pick<Database, 'raw' | 'transaction'>;
type PlanningOrchestrator = Pick<Orchestrator, 'createTask'>;
type Row = Record<string, unknown>;

const PLAN_VERSION_STATUSES: readonly PlanVersionStatus[] = ['PROPOSED', 'APPROVED', 'REJECTED', 'SUPERSEDED'];

const PLANNING_DDL = [
  `CREATE TABLE IF NOT EXISTS planning_sessions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN (
      'DRAFT','NEEDS_INPUT','PROPOSED','APPROVED','DISPATCHED','CLOSED','REJECTED','SUPERSEDED','CANCELLED'
    )),
    revision INTEGER NOT NULL CHECK(revision > 0),
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS planning_question_sets (
    session_id TEXT NOT NULL REFERENCES planning_sessions(id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK(version > 0),
    id TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL,
    answered_at INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(session_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS plan_versions (
    session_id TEXT NOT NULL REFERENCES planning_sessions(id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK(version > 0),
    plan_hash TEXT NOT NULL CHECK(length(plan_hash) = 64),
    status TEXT NOT NULL CHECK(status IN ('PROPOSED','APPROVED','REJECTED','SUPERSEDED')),
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(session_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS plan_nodes (
    session_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    node_id TEXT NOT NULL,
    plan_hash TEXT NOT NULL CHECK(length(plan_hash) = 64),
    owner_agent_id TEXT NOT NULL,
    dependency_node_ids_json TEXT NOT NULL,
    node_json TEXT NOT NULL,
    task_id TEXT,
    idempotency_key TEXT,
    dispatched_at INTEGER,
    PRIMARY KEY(session_id, plan_version, node_id),
    FOREIGN KEY(session_id, plan_version)
      REFERENCES plan_versions(session_id, version) ON DELETE CASCADE,
    CHECK(
      (task_id IS NULL AND idempotency_key IS NULL AND dispatched_at IS NULL)
      OR (task_id IS NOT NULL AND idempotency_key IS NOT NULL AND dispatched_at IS NOT NULL)
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_nodes_idempotency
    ON plan_nodes(idempotency_key) WHERE idempotency_key IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_nodes_task
    ON plan_nodes(task_id) WHERE task_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_planning_sessions_status
    ON planning_sessions(status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_plan_versions_hash
    ON plan_versions(plan_hash)`
] as const;

function persistenceError(message: string): PlanningError {
  return new PlanningError('PERSISTENCE_CORRUPTION', message);
}

function conflict(message: string): PlanningError {
  return new PlanningError('REVISION_CONFLICT', message);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw persistenceError(`${field} is missing`);
  return value;
}

function requiredInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw persistenceError(`${field} is not a safe integer`);
  return parsed;
}

function nullableInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return requiredInteger(value, field);
}

function parseJson(value: unknown, field: string): unknown {
  if (typeof value !== 'string') throw persistenceError(`${field} is not JSON text`);
  try {
    const parsed: unknown = JSON.parse(value);
    canonicalJson(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof PlanningError) throw persistenceError(`${field} is outside the canonical JSON domain`);
    throw persistenceError(`${field} contains invalid JSON`);
  }
}

function requireObject(value: unknown, field: string): Row {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw persistenceError(`${field} is not an object`);
  return value as Row;
}

function encode(value: unknown): string {
  return canonicalJson(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertSessionPayload(row: Row): PlanningSession {
  const payload = requireObject(parseJson(row.payload_json, 'planning_sessions.payload_json'), 'planning session payload');
  const status = requiredString(payload.status, 'planning session status');
  if (!PLANNING_SESSION_STATUSES.includes(status as PlanningSession['status'])) {
    throw persistenceError(`planning session has invalid status ${status}`);
  }
  const session = payload as unknown as PlanningSession;
  const id = requiredString(row.id, 'planning_sessions.id');
  const organizationId = requiredString(row.organization_id, 'planning_sessions.organization_id');
  const principalId = requiredString(row.principal_id, 'planning_sessions.principal_id');
  const revision = requiredInteger(row.revision, 'planning_sessions.revision');
  const createdAt = requiredInteger(row.created_at, 'planning_sessions.created_at');
  const updatedAt = requiredInteger(row.updated_at, 'planning_sessions.updated_at');
  if (
    session.id !== id
    || session.organizationId !== organizationId
    || session.principalId !== principalId
    || session.status !== status
    || session.revision !== revision
    || session.createdAt !== createdAt
    || session.updatedAt !== updatedAt
  ) throw persistenceError(`planning session ${id} columns do not match its payload`);
  if (typeof session.request !== 'string' || session.request.length === 0) throw persistenceError(`planning session ${id} has no request`);
  if (session.gateDecision === null || typeof session.gateDecision !== 'object') {
    throw persistenceError(`planning session ${id} has no gate decision`);
  }
  return session;
}

function assertQuestionSetPayload(row: Row): QuestionSet {
  const payload = requireObject(parseJson(row.payload_json, 'planning_question_sets.payload_json'), 'question set payload');
  const questionSet = payload as unknown as QuestionSet;
  const sessionId = requiredString(row.session_id, 'planning_question_sets.session_id');
  const version = requiredInteger(row.version, 'planning_question_sets.version');
  const id = requiredString(row.id, 'planning_question_sets.id');
  const createdAt = requiredInteger(row.created_at, 'planning_question_sets.created_at');
  const answeredAt = nullableInteger(row.answered_at, 'planning_question_sets.answered_at');
  if (
    questionSet.sessionId !== sessionId
    || questionSet.version !== version
    || questionSet.id !== id
    || questionSet.createdAt !== createdAt
    || questionSet.answeredAt !== answeredAt
    || !Array.isArray(questionSet.questions)
  ) throw persistenceError(`question set ${sessionId}:${version} columns do not match its payload`);
  if (answeredAt === null) {
    if (questionSet.answers !== null || questionSet.answeredBy !== null) {
      throw persistenceError(`unanswered question set ${sessionId}:${version} contains answer data`);
    }
  } else if (!Array.isArray(questionSet.answers) || typeof questionSet.answeredBy !== 'string') {
    throw persistenceError(`answered question set ${sessionId}:${version} is incomplete`);
  }
  return questionSet;
}

function assertPlanVersionPayload(row: Row): PlanVersionRecord {
  const payload = requireObject(parseJson(row.payload_json, 'plan_versions.payload_json'), 'plan version payload');
  const record = payload as unknown as PlanVersionRecord;
  const sessionId = requiredString(row.session_id, 'plan_versions.session_id');
  const version = requiredInteger(row.version, 'plan_versions.version');
  const hash = requiredString(row.plan_hash, 'plan_versions.plan_hash');
  const status = requiredString(row.status, 'plan_versions.status');
  const createdAt = requiredInteger(row.created_at, 'plan_versions.created_at');
  if (!PLAN_VERSION_STATUSES.includes(status as PlanVersionStatus)) throw persistenceError(`plan version has invalid status ${status}`);
  if (
    record.sessionId !== sessionId
    || record.version !== version
    || record.hash !== hash
    || record.status !== status
    || record.createdAt !== createdAt
    || record.plan === null
    || typeof record.plan !== 'object'
  ) throw persistenceError(`plan version ${sessionId}:${version} columns do not match its payload`);
  if (hashCanonicalJson(record.plan) !== hash) throw persistenceError(`plan version ${sessionId}:${version} hash does not match its plan`);
  return record;
}

function immutableQuestionSetShape(questionSet: QuestionSet): {
  id: string;
  sessionId: string;
  version: number;
  questions: PlanningQuestion[];
  createdAt: number;
} {
  return {
    id: questionSet.id,
    sessionId: questionSet.sessionId,
    version: questionSet.version,
    questions: questionSet.questions,
    createdAt: questionSet.createdAt
  };
}

function immutablePlanShape(record: PlanVersionRecord): {
  sessionId: string;
  version: number;
  hash: string;
  plan: CompanyExecutionPlan;
  createdAt: number;
} {
  return {
    sessionId: record.sessionId,
    version: record.version,
    hash: record.hash,
    plan: record.plan,
    createdAt: record.createdAt
  };
}

/**
 * Durable sql.js adapter for the secretary planning domain. Schema creation is
 * idempotent so it can be initialized independently until the tables move into
 * the application's numbered migration chain.
 */
export class SecretaryPlanningRepository implements PlanningRepository {
  private transactionDepth = 0;

  constructor(private readonly db: PlanningDatabase) {
    this.initializeSchema();
  }

  initializeSchema(): void {
    this.transaction(() => {
      for (const statement of PLANNING_DDL) this.db.raw.prepare(statement).run();
    });
  }

  transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return operation();
    let result!: T;
    let completed = false;
    this.db.transaction(() => {
      this.transactionDepth += 1;
      try {
        result = operation();
        completed = true;
      } finally {
        this.transactionDepth -= 1;
      }
    });
    if (!completed) throw persistenceError('planning transaction did not complete');
    return result;
  }

  getSession(sessionId: string): PlanningSession | null {
    const row = this.db.raw.prepare('SELECT * FROM planning_sessions WHERE id = ?').get(sessionId) as Row | undefined;
    return row ? assertSessionPayload(row) : null;
  }

  listSessions(limit: number): PlanningSession[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw conflict('planning session list limit is invalid');
    const rows = this.db.raw.prepare(
      'SELECT * FROM planning_sessions ORDER BY updated_at DESC, id DESC LIMIT ?'
    ).all(limit) as Row[];
    return rows.map(assertSessionPayload);
  }

  saveSession(session: PlanningSession, expectedRevision: number | null): void {
    if (!Number.isSafeInteger(session.revision) || session.revision < 1) throw conflict('planning session revision is invalid');
    const payload = encode(session);
    if (expectedRevision === null) {
      if (session.revision !== 1) throw conflict('a new planning session must start at revision 1');
      const inserted = this.db.raw.prepare(
        `INSERT INTO planning_sessions(
          id, organization_id, principal_id, status, revision, payload_json, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`
      ).run(
        session.id, session.organizationId, session.principalId, session.status,
        session.revision, payload, session.createdAt, session.updatedAt
      ).changes;
      if (inserted !== 1) throw conflict(`planning session ${session.id} already exists`);
      return;
    }

    if (session.revision !== expectedRevision + 1) throw conflict('planning session revision must advance by exactly one');
    const current = this.getSession(session.id);
    if (!current || current.revision !== expectedRevision) throw conflict(`planning session ${session.id} revision changed`);
    if (
      current.organizationId !== session.organizationId
      || current.principalId !== session.principalId
      || current.createdAt !== session.createdAt
      || current.request !== session.request
      || !sameJson(current.gateDecision, session.gateDecision)
      || !sameJson(current.signals ?? null, session.signals ?? null)
    ) throw conflict('planning session identity fields are immutable');
    const changed = this.db.raw.prepare(
      `UPDATE planning_sessions
       SET status = ?, revision = ?, payload_json = ?, updated_at = ?
       WHERE id = ? AND revision = ?`
    ).run(session.status, session.revision, payload, session.updatedAt, session.id, expectedRevision).changes;
    if (changed !== 1) throw conflict(`planning session ${session.id} revision changed`);
  }

  getQuestionSet(sessionId: string, version: number): QuestionSet | null {
    const row = this.db.raw.prepare(
      'SELECT * FROM planning_question_sets WHERE session_id = ? AND version = ?'
    ).get(sessionId, version) as Row | undefined;
    return row ? assertQuestionSetPayload(row) : null;
  }

  saveQuestionSet(questionSet: QuestionSet, expectedAnsweredAt: number | null | undefined): void {
    const payload = encode(questionSet);
    if (expectedAnsweredAt === undefined) {
      const inserted = this.db.raw.prepare(
        `INSERT INTO planning_question_sets(
          session_id, version, id, payload_json, answered_at, created_at
        ) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, version) DO NOTHING`
      ).run(
        questionSet.sessionId, questionSet.version, questionSet.id, payload,
        questionSet.answeredAt, questionSet.createdAt
      ).changes;
      if (inserted !== 1) throw conflict(`question set ${questionSet.sessionId}:${questionSet.version} already exists`);
      return;
    }

    const current = this.getQuestionSet(questionSet.sessionId, questionSet.version);
    if (!current || current.answeredAt !== expectedAnsweredAt) {
      throw conflict(`question set ${questionSet.sessionId}:${questionSet.version} changed`);
    }
    if (!sameJson(immutableQuestionSetShape(current), immutableQuestionSetShape(questionSet))) {
      throw conflict('question set identity and questions are immutable');
    }
    const predicate = expectedAnsweredAt === null ? 'answered_at IS NULL' : 'answered_at = ?';
    const params = expectedAnsweredAt === null
      ? [payload, questionSet.answeredAt, questionSet.sessionId, questionSet.version]
      : [payload, questionSet.answeredAt, questionSet.sessionId, questionSet.version, expectedAnsweredAt];
    const changed = this.db.raw.prepare(
      `UPDATE planning_question_sets SET payload_json = ?, answered_at = ?
       WHERE session_id = ? AND version = ? AND ${predicate}`
    ).run(...params).changes;
    if (changed !== 1) throw conflict(`question set ${questionSet.sessionId}:${questionSet.version} changed`);
  }

  getPlanVersion(sessionId: string, version: number): PlanVersionRecord | null {
    const row = this.db.raw.prepare(
      'SELECT * FROM plan_versions WHERE session_id = ? AND version = ?'
    ).get(sessionId, version) as Row | undefined;
    if (!row) return null;
    const record = assertPlanVersionPayload(row);
    if (!Array.isArray(record.plan.dag)) throw persistenceError(`plan version ${sessionId}:${version} has no DAG`);
    const nodeRows = this.db.raw.prepare(
      `SELECT node_id, plan_hash, owner_agent_id, dependency_node_ids_json, node_json
       FROM plan_nodes WHERE session_id = ? AND plan_version = ? ORDER BY node_id`
    ).all(sessionId, version) as Row[];
    if (nodeRows.length !== record.plan.dag.length) throw persistenceError(`plan version ${sessionId}:${version} has incomplete node projection`);
    const expectedNodes = new Map(record.plan.dag.map((node) => [node.nodeId, node]));
    for (const nodeRow of nodeRows) {
      const nodeId = requiredString(nodeRow.node_id, 'plan_nodes.node_id');
      const expected = expectedNodes.get(nodeId);
      if (!expected) throw persistenceError(`plan version ${sessionId}:${version} contains unexpected node ${nodeId}`);
      const storedNode = parseJson(nodeRow.node_json, `plan_nodes.${nodeId}.node_json`);
      const dependencies = parseJson(nodeRow.dependency_node_ids_json, `plan_nodes.${nodeId}.dependencies`);
      if (
        nodeRow.plan_hash !== record.hash
        || nodeRow.owner_agent_id !== expected.ownerAgentId
        || !sameJson(storedNode, expected)
        || !sameJson(dependencies, expected.dependencies)
      ) throw persistenceError(`plan node ${sessionId}:${version}:${nodeId} does not match its approved plan`);
    }
    return record;
  }

  listPlanVersions(sessionId: string): PlanVersionRecord[] {
    const rows = this.db.raw.prepare(
      'SELECT version FROM plan_versions WHERE session_id = ? ORDER BY version'
    ).all(sessionId) as Row[];
    return rows.map((row) => {
      const record = this.getPlanVersion(sessionId, requiredInteger(row.version, 'plan_versions.version'));
      if (!record) throw persistenceError(`plan version ${sessionId}:${String(row.version)} disappeared while listing`);
      return record;
    });
  }

  savePlanVersion(planVersion: PlanVersionRecord, expectedStatus: PlanVersionStatus | null): void {
    this.transaction(() => {
      if (hashCanonicalJson(planVersion.plan) !== planVersion.hash) throw conflict('plan version hash does not match its plan');
      const payload = encode(planVersion);
      if (expectedStatus === null) {
        const inserted = this.db.raw.prepare(
          `INSERT INTO plan_versions(
            session_id, version, plan_hash, status, payload_json, created_at
          ) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, version) DO NOTHING`
        ).run(
          planVersion.sessionId, planVersion.version, planVersion.hash,
          planVersion.status, payload, planVersion.createdAt
        ).changes;
        if (inserted !== 1) throw conflict(`plan version ${planVersion.sessionId}:${planVersion.version} already exists`);
        for (const node of planVersion.plan.dag) {
          this.db.raw.prepare(
            `INSERT INTO plan_nodes(
              session_id, plan_version, node_id, plan_hash, owner_agent_id,
              dependency_node_ids_json, node_json, task_id, idempotency_key, dispatched_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`
          ).run(
            planVersion.sessionId, planVersion.version, node.nodeId, planVersion.hash,
            node.ownerAgentId, encode(node.dependencies), encode(node)
          );
        }
        return;
      }

      const current = this.getPlanVersion(planVersion.sessionId, planVersion.version);
      if (!current || current.status !== expectedStatus) {
        throw conflict(`plan version ${planVersion.sessionId}:${planVersion.version} changed`);
      }
      if (!sameJson(immutablePlanShape(current), immutablePlanShape(planVersion))) {
        throw conflict('plan version identity, hash, content, and creation time are immutable');
      }
      if (current.status !== 'PROPOSED') {
        throw conflict(`decided plan version ${planVersion.sessionId}:${planVersion.version} is immutable`);
      }
      const changed = this.db.raw.prepare(
        `UPDATE plan_versions SET status = ?, payload_json = ?
         WHERE session_id = ? AND version = ? AND status = ?`
      ).run(
        planVersion.status, payload, planVersion.sessionId, planVersion.version, expectedStatus
      ).changes;
      if (changed !== 1) throw conflict(`plan version ${planVersion.sessionId}:${planVersion.version} changed`);
    });
  }

  getDispatchReceipt(sessionId: string, planVersion: number, nodeId: string): PlanDispatchReceipt | null {
    const row = this.db.raw.prepare(
      `SELECT plan_hash, task_id, idempotency_key, dispatched_at
       FROM plan_nodes WHERE session_id = ? AND plan_version = ? AND node_id = ?`
    ).get(sessionId, planVersion, nodeId) as Row | undefined;
    if (!row) return null;
    if (row.task_id === null || row.task_id === undefined) {
      if (row.idempotency_key !== null || row.dispatched_at !== null) {
        throw persistenceError(`undispatched node ${sessionId}:${planVersion}:${nodeId} has partial receipt data`);
      }
      return null;
    }
    const receipt: PlanDispatchReceipt = {
      sessionId,
      planVersion,
      planHash: requiredString(row.plan_hash, 'plan_nodes.plan_hash'),
      nodeId,
      taskId: requiredString(row.task_id, 'plan_nodes.task_id'),
      idempotencyKey: requiredString(row.idempotency_key, 'plan_nodes.idempotency_key'),
      createdAt: requiredInteger(row.dispatched_at, 'plan_nodes.dispatched_at')
    };
    const expectedKey = `planning:${sessionId}:${planVersion}:${receipt.planHash}:${nodeId}`;
    if (receipt.idempotencyKey !== expectedKey) {
      throw persistenceError(`dispatch receipt ${sessionId}:${planVersion}:${nodeId} has an invalid idempotency key`);
    }
    return receipt;
  }

  saveDispatchReceipt(receipt: PlanDispatchReceipt): void {
    const current = this.getDispatchReceipt(receipt.sessionId, receipt.planVersion, receipt.nodeId);
    if (current) {
      if (
        current.planHash !== receipt.planHash
        || current.taskId !== receipt.taskId
        || current.idempotencyKey !== receipt.idempotencyKey
      ) throw new PlanningError('DISPATCH_CONFLICT', `dispatch receipt for node ${receipt.nodeId} conflicts`);
      return;
    }
    const changed = this.db.raw.prepare(
      `UPDATE plan_nodes
       SET task_id = ?, idempotency_key = ?, dispatched_at = ?
       WHERE session_id = ? AND plan_version = ? AND node_id = ?
         AND plan_hash = ? AND task_id IS NULL`
    ).run(
      receipt.taskId, receipt.idempotencyKey, receipt.createdAt,
      receipt.sessionId, receipt.planVersion, receipt.nodeId, receipt.planHash
    ).changes;
    if (changed === 1) return;
    const raced = this.getDispatchReceipt(receipt.sessionId, receipt.planVersion, receipt.nodeId);
    if (
      raced
      && raced.planHash === receipt.planHash
      && raced.taskId === receipt.taskId
      && raced.idempotencyKey === receipt.idempotencyKey
    ) return;
    throw new PlanningError('DISPATCH_CONFLICT', `plan node ${receipt.nodeId} is missing, changed, or already mapped`);
  }
}

function taskTitle(order: DispatchWorkOrder): string {
  const firstLine = order.workOrder.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const title = firstLine || `Plan node ${order.nodeId}`;
  return title.length <= 120 ? title : `${title.slice(0, 117)}...`;
}

function markdownList(values: readonly string[], emptyLabel: string): string {
  return values.length === 0 ? `- ${emptyLabel}` : values.map((value) => `- ${value}`).join('\n');
}

function taskContent(order: DispatchWorkOrder): string {
  const content = [
    order.workOrder,
    '',
    '## Plan reference',
    `- Session: ${order.sessionId}`,
    `- Version: ${order.planVersion}`,
    `- Hash: ${order.planHash}`,
    `- Node: ${order.nodeId}`,
    '',
    '## Dependencies',
    markdownList(order.dependencyTaskIds, 'None'),
    '',
    '## Expected artifacts',
    markdownList(order.expectedArtifacts, 'None'),
    '',
    '## Acceptance criteria',
    markdownList(order.acceptanceCriteria, 'None'),
    '',
    '## Execution boundary',
    `- Permission profile: ${order.permissionProfile}`,
    `- Permissions: ${order.requiredPermissions.join(', ') || 'None'}`,
    `- Time budget: ${order.budget.timeMinutes} minutes`,
    `- Token budget: ${order.budget.tokenLimit}`,
    `- Cost budget: ${order.budget.costLimit}`,
    `- Retry: ${order.retryPolicy.maxAttempts} attempt(s), ${order.retryPolicy.backoff} backoff`
  ].join('\n');
  if (content.length > 1_000_000) throw new PlanningError('TASK_PAYLOAD_TOO_LARGE', `plan node ${order.nodeId} exceeds task content limits`);
  return content;
}

/** Maps an approved plan node to Orchestrator's canonical task ingress. */
export interface OrchestratorPlanningDispatchPortOptions {
  /** Required by DSH Quest projections so every compatibility Task remains project-scoped. */
  resolveProjectId?: (planningSessionId: string) => string | null;
}

export class OrchestratorPlanningDispatchPort implements DispatchPort {
  constructor(
    private readonly orchestrator: PlanningOrchestrator,
    private readonly options: OrchestratorPlanningDispatchPortOptions = {}
  ) {}

  createTask(order: DispatchWorkOrder): { taskId: string } {
    const expectedKey = `planning:${order.sessionId}:${order.planVersion}:${order.planHash}:${order.nodeId}`;
    if (order.idempotencyKey !== expectedKey) {
      throw new PlanningError('DISPATCH_CONFLICT', `plan node ${order.nodeId} has an invalid idempotency key`);
    }
    const projectId = this.options.resolveProjectId?.(order.sessionId);
    if (this.options.resolveProjectId && !projectId) {
      throw new PlanningError('PROJECT_BOUNDARY', `planning session ${order.sessionId} has no project binding`);
    }
    const task = this.orchestrator.createTask(order.ownerAgentId, taskTitle(order), 'team', {
      sourceKey: order.idempotencyKey,
      content: taskContent(order),
      dependencyTaskIds: [...order.dependencyTaskIds],
      ...(projectId ? { projectId } : {})
    });
    return { taskId: task.id };
  }
}
