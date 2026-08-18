import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import {
  OrchestratorPlanningDispatchPort,
  SecretaryPlanningRepository
} from '../src/main/services/secretaryPlanningAdapters.js';
import {
  PlanningError,
  SecretaryPlanningService,
  type CompanyExecutionPlan,
  type DispatchPort,
  type DispatchWorkOrder,
  type PlanValidationPolicy,
  type PlanningComplexitySignals
} from '../src/main/services/secretaryPlanning.js';

const require = createRequire(import.meta.url);
let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
});

type SqlJsDatabase = InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>;

function statement(db: SqlJsDatabase, sql: string) {
  return {
    run: (...params: unknown[]) => {
      db.run(sql, params);
      return { changes: db.getRowsModified() };
    },
    get: (...params: unknown[]) => {
      const prepared = db.prepare(sql);
      try {
        prepared.bind(params);
        return prepared.step() ? prepared.getAsObject() : undefined;
      } finally {
        prepared.free();
      }
    },
    all: (...params: unknown[]) => {
      const prepared = db.prepare(sql);
      const rows: Record<string, unknown>[] = [];
      try {
        prepared.bind(params);
        while (prepared.step()) rows.push(prepared.getAsObject());
        return rows;
      } finally {
        prepared.free();
      }
    }
  };
}

class TestDatabase {
  readonly inner: SqlJsDatabase;
  readonly raw: { prepare: (sql: string) => ReturnType<typeof statement> };

  constructor() {
    this.inner = new SQL.Database();
    this.inner.exec('PRAGMA foreign_keys = ON');
    this.raw = { prepare: (sql: string) => statement(this.inner, sql) };
  }

  transaction(operation: () => void): void {
    this.inner.exec('BEGIN');
    try {
      operation();
      this.inner.exec('COMMIT');
    } catch (error) {
      this.inner.exec('ROLLBACK');
      throw error;
    }
  }

  rows(sql: string, ...params: unknown[]): Record<string, unknown>[] {
    return this.raw.prepare(sql).all(...params);
  }

  close(): void {
    this.inner.close();
  }
}

function signals(): PlanningComplexitySignals {
  return {
    departmentIds: ['engineering', 'quality'],
    hasCrossTeamDependencies: true,
    ambiguousObjective: false,
    ambiguousScope: false,
    ambiguousAcceptance: false,
    estimatedDurationMinutes: 90,
    estimatedCost: 5,
    estimatedTokenCount: 5_000,
    requiresNewTeam: false,
    irreversibleOperations: ['write_files'],
    compareAlternatives: false,
    phasedExecution: true,
    confirmBeforeExecution: true,
    estimatedTaskCount: 2
  };
}

function validationPolicy(): PlanValidationPolicy {
  return {
    organizationId: 'org-1',
    agents: [
      {
        id: 'agent-build', organizationId: 'org-1', lifecycle: 'READY', archived: false,
        permissionProfiles: ['standard'], permissions: ['read', 'write']
      },
      {
        id: 'agent-review', organizationId: 'org-1', lifecycle: 'READY', archived: false,
        permissionProfiles: ['standard'], permissions: ['read']
      }
    ],
    allowedPermissionProfiles: ['standard'],
    allowedPermissions: ['read', 'write'],
    maxBudget: { timeMinutes: 180, tokenLimit: 20_000, costLimit: 20 },
    maxRetryAttempts: 3,
    allowEphemeralTeams: false
  };
}

function plan(): CompanyExecutionPlan {
  return {
    schemaVersion: 1,
    organizationId: 'org-1',
    objective: 'Build and independently review the integration',
    assumptions: ['The workspace is available'],
    scope: { included: ['Implementation', 'Review'], excluded: ['Production rollout'] },
    team: [{
      teamId: 'team-delivery', organizationId: 'org-1', leadAgentId: 'agent-build',
      memberAgentIds: ['agent-review'], proposedEphemeralRoles: []
    }],
    dag: [
      {
        nodeId: 'node-review', organizationId: 'org-1', ownerAgentId: 'agent-review',
        dependencies: ['node-build'], workOrder: 'Review the implementation',
        expectedArtifacts: ['Review report'], acceptanceCriteria: ['No blocking defects'],
        permissionProfile: 'standard', requiredPermissions: ['read'],
        budget: { timeMinutes: 20, tokenLimit: 2_000, costLimit: 2 },
        retryPolicy: { maxAttempts: 2, backoff: 'linear' }
      },
      {
        nodeId: 'node-build', organizationId: 'org-1', ownerAgentId: 'agent-build',
        dependencies: [], workOrder: 'Implement the approved design',
        expectedArtifacts: ['Source changes'], acceptanceCriteria: ['Focused tests pass'],
        permissionProfile: 'standard', requiredPermissions: ['read', 'write'],
        budget: { timeMinutes: 40, tokenLimit: 4_000, costLimit: 4 },
        retryPolicy: { maxAttempts: 2, backoff: 'exponential' }
      }
    ],
    risks: [{ risk: 'Regression', mitigation: 'Independent review', ownerAgentId: 'agent-review' }],
    overallBudget: { timeMinutes: 70, tokenLimit: 7_000, costLimit: 7 },
    acceptanceCriteria: ['Both artifacts are delivered']
  };
}

function createTaskHarness() {
  const tasksByKey = new Map<string, { id: string }>();
  const createTask = vi.fn((_agentId: string, _title: string, _source: string, options: { sourceKey?: string }) => {
    const key = options.sourceKey ?? '';
    const existing = tasksByKey.get(key);
    if (existing) return { ...existing, deduplicated: true };
    const task = { id: `task-${tasksByKey.size + 1}` };
    tasksByKey.set(key, task);
    return task;
  });
  return {
    createTask,
    tasksByKey,
    port: new OrchestratorPlanningDispatchPort({ createTask } as never)
  };
}

function createService(repository: SecretaryPlanningRepository, port: DispatchPort) {
  let id = 0;
  let now = 10_000;
  return new SecretaryPlanningService(repository, port, {
    idFactory: () => `generated-${++id}`,
    now: () => ++now
  });
}

function expectPlanningCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error(`expected PlanningError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(PlanningError);
    expect((error as PlanningError).code).toBe(code);
  }
}

describe('SecretaryPlanningRepository', () => {
  let database: TestDatabase;

  beforeEach(() => {
    database = new TestDatabase();
  });

  afterEach(() => {
    database.close();
  });

  it('idempotently creates the four durable planning tables', () => {
    new SecretaryPlanningRepository(database as never);
    new SecretaryPlanningRepository(database as never);
    const tables = database.rows(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN (
         'planning_sessions','planning_question_sets','plan_versions','plan_nodes'
       ) ORDER BY name`
    ).map((row) => row.name);
    expect(tables).toEqual(['plan_nodes', 'plan_versions', 'planning_question_sets', 'planning_sessions']);
  });

  it('rolls back an entire domain transaction', () => {
    const repository = new SecretaryPlanningRepository(database as never);
    const service = createService(repository, createTaskHarness().port);
    expect(() => repository.transaction(() => {
      service.createSession({
        id: 'session-rollback', organizationId: 'org-1', principalId: 'owner-1',
        request: 'This session must roll back', signals: signals()
      });
      throw new Error('injected failure');
    })).toThrow('injected failure');
    expect(repository.getSession('session-rollback')).toBeNull();
  });

  it('uses revision CAS and preserves immutable session identity', () => {
    const repository = new SecretaryPlanningRepository(database as never);
    const service = createService(repository, createTaskHarness().port);
    const original = service.createSession({
      id: 'session-cas', organizationId: 'org-1', principalId: 'owner-1',
      request: 'Test session CAS', signals: signals()
    });
    const updated = { ...original, status: 'CANCELLED' as const, revision: 2, updatedAt: original.updatedAt + 1 };
    repository.saveSession(updated, 1);
    expect(repository.getSession('session-cas')).toMatchObject({ status: 'CANCELLED', revision: 2 });

    expectPlanningCode(() => repository.saveSession({ ...updated, revision: 3 }, 1), 'REVISION_CONFLICT');
    expectPlanningCode(() => repository.saveSession({
      ...updated, organizationId: 'org-2', revision: 3
    }, 2), 'REVISION_CONFLICT');
  });

  it('persists versioned questions and rejects stale answer CAS', () => {
    const repository = new SecretaryPlanningRepository(database as never);
    const service = createService(repository, createTaskHarness().port);
    service.createSession({
      id: 'session-questions', organizationId: 'org-1', principalId: 'owner-1',
      request: 'Clarify the delivery mode', signals: signals()
    });
    service.issueQuestionSet('session-questions', [{
      id: 'delivery-mode', kind: 'single', prompt: 'Choose a delivery mode',
      options: [
        { id: 'fast', label: 'Fast', impact: 'Higher risk' },
        { id: 'safe', label: 'Safe', impact: 'Longer schedule' }
      ],
      recommendedOptionId: 'safe', recommendationReason: 'It preserves review time', allowOther: true
    }]);
    service.answerQuestionSet('session-questions', 1, 'owner-1', [{
      questionId: 'delivery-mode', selectedOptionIds: ['safe'], text: null
    }]);

    const stored = repository.getQuestionSet('session-questions', 1)!;
    expect(stored).toMatchObject({ version: 1, answeredBy: 'owner-1' });
    expect(stored.answers?.[0].selectedOptionIds).toEqual(['safe']);
    expectPlanningCode(() => repository.saveQuestionSet({ ...stored, answeredBy: 'owner-2' }, null), 'REVISION_CONFLICT');
  });

  it('persists every DAG node and rejects plan mutation during a status CAS', () => {
    const repository = new SecretaryPlanningRepository(database as never);
    const service = createService(repository, createTaskHarness().port);
    service.createSession({
      id: 'session-plan', organizationId: 'org-1', principalId: 'owner-1',
      request: 'Build and review', signals: signals()
    });
    const proposed = service.proposePlan('session-plan', plan(), validationPolicy());
    expect(database.rows(
      'SELECT node_id FROM plan_nodes WHERE session_id = ? AND plan_version = ? ORDER BY node_id',
      'session-plan', 1
    ).map((row) => row.node_id)).toEqual(['node-build', 'node-review']);
    expect(repository.getPlanVersion('session-plan', 1)).toEqual(proposed);

    const mutated = structuredClone(proposed);
    mutated.plan.dag[0].workOrder = 'Changed after hashing';
    expectPlanningCode(() => repository.savePlanVersion(mutated, 'PROPOSED'), 'REVISION_CONFLICT');
    const approved = service.approvePlan('session-plan', 1, proposed.hash, 'owner-1');
    expect(approved.status).toBe('APPROVED');
    expectPlanningCode(() => repository.savePlanVersion({ ...approved, status: 'REJECTED' }, 'PROPOSED'), 'REVISION_CONFLICT');
    expectPlanningCode(() => repository.savePlanVersion({ ...approved, approvedBy: 'forged-owner' }, 'APPROVED'), 'REVISION_CONFLICT');
  });

  it('detects an incomplete node projection as persistent corruption', () => {
    const repository = new SecretaryPlanningRepository(database as never);
    const service = createService(repository, createTaskHarness().port);
    service.createSession({
      id: 'session-corrupt', organizationId: 'org-1', principalId: 'owner-1',
      request: 'Persist the complete DAG', signals: signals()
    });
    service.proposePlan('session-corrupt', plan(), validationPolicy());
    database.raw.prepare(
      "DELETE FROM plan_nodes WHERE session_id = 'session-corrupt' AND node_id = 'node-review'"
    ).run();
    expectPlanningCode(() => repository.getPlanVersion('session-corrupt', 1), 'PERSISTENCE_CORRUPTION');
  });

  it('recovers an approved hash, DAG mapping, and receipts across repository instances', async () => {
    const taskHarness = createTaskHarness();
    const firstRepository = new SecretaryPlanningRepository(database as never);
    const firstService = createService(firstRepository, taskHarness.port);
    firstService.createSession({
      id: 'session-restart', organizationId: 'org-1', principalId: 'owner-1',
      request: 'Execute a durable plan', signals: signals()
    });
    const proposed = firstService.proposePlan('session-restart', plan(), validationPolicy());
    firstService.approvePlan('session-restart', 1, proposed.hash, 'owner-1');

    const recoveredRepository = new SecretaryPlanningRepository(database as never);
    const recoveredService = createService(recoveredRepository, taskHarness.port);
    expect(recoveredService.getSession('session-restart')).toMatchObject({
      status: 'APPROVED', approvedPlanVersion: 1, approvedPlanHash: proposed.hash
    });
    const receipts = await recoveredService.dispatchApprovedPlan('session-restart', validationPolicy());
    expect(receipts.map((receipt) => receipt.nodeId)).toEqual(['node-build', 'node-review']);
    expect(taskHarness.createTask).toHaveBeenCalledTimes(2);
    expect(taskHarness.createTask.mock.calls.map((call) => call[2])).toEqual(['team', 'team']);
    expect(taskHarness.createTask.mock.calls[0][3].sourceKey).toContain(proposed.hash);
    expect(taskHarness.createTask.mock.calls[1][3].content).toContain('task-1');

    const afterRestart = new SecretaryPlanningService(
      new SecretaryPlanningRepository(database as never),
      taskHarness.port
    );
    await expect(afterRestart.dispatchApprovedPlan('session-restart', validationPolicy())).resolves.toEqual(receipts);
    expect(taskHarness.createTask).toHaveBeenCalledTimes(2);
    expect(database.rows(
      'SELECT node_id, task_id FROM plan_nodes WHERE session_id = ? ORDER BY node_id', 'session-restart'
    )).toEqual([
      { node_id: 'node-build', task_id: 'task-1' },
      { node_id: 'node-review', task_id: 'task-2' }
    ]);

    const replayWithDifferentTime = { ...receipts[0], createdAt: receipts[0].createdAt + 1_000 };
    expect(() => recoveredRepository.saveDispatchReceipt(replayWithDifferentTime)).not.toThrow();
    expectPlanningCode(() => recoveredRepository.saveDispatchReceipt({
      ...receipts[0], taskId: 'different-task'
    }), 'DISPATCH_CONFLICT');
  });

  it('recovers the crash window after task creation but before receipt persistence', async () => {
    const taskHarness = createTaskHarness();
    const repository = new SecretaryPlanningRepository(database as never);
    const setup = createService(repository, taskHarness.port);
    setup.createSession({
      id: 'session-crash-window', organizationId: 'org-1', principalId: 'owner-1',
      request: 'Recover task ingress idempotently', signals: signals()
    });
    const proposed = setup.proposePlan('session-crash-window', plan(), validationPolicy());
    setup.approvePlan('session-crash-window', 1, proposed.hash, 'owner-1');

    let injectCrash = true;
    const crashAfterTask: DispatchPort = {
      createTask: (order) => {
        const created = taskHarness.port.createTask(order);
        if (injectCrash) {
          injectCrash = false;
          throw new Error('simulated crash after canonical task ingress');
        }
        return created;
      }
    };
    const interrupted = createService(repository, crashAfterTask);
    await expect(interrupted.dispatchApprovedPlan('session-crash-window', validationPolicy()))
      .rejects.toThrow('simulated crash after canonical task ingress');
    expect(taskHarness.tasksByKey.size).toBe(1);
    expect(repository.getDispatchReceipt('session-crash-window', 1, 'node-build')).toBeNull();

    const recovered = createService(
      new SecretaryPlanningRepository(database as never),
      taskHarness.port
    );
    const receipts = await recovered.dispatchApprovedPlan('session-crash-window', validationPolicy());
    expect(receipts.map((receipt) => receipt.taskId)).toEqual(['task-1', 'task-2']);
    expect(taskHarness.tasksByKey.size).toBe(2);
    expect(taskHarness.createTask).toHaveBeenCalledTimes(3);
    expect(taskHarness.createTask.mock.calls[0][3].sourceKey)
      .toBe(taskHarness.createTask.mock.calls[1][3].sourceKey);
  });
});

describe('OrchestratorPlanningDispatchPort', () => {
  function workOrder(overrides: Partial<DispatchWorkOrder> = {}): DispatchWorkOrder {
    const hash = 'a'.repeat(64);
    return {
      idempotencyKey: `planning:session-1:2:${hash}:node-review`,
      sessionId: 'session-1', organizationId: 'org-1', planVersion: 2,
      planHash: hash, nodeId: 'node-review', ownerAgentId: 'agent-review',
      dependencyTaskIds: ['task-build'], workOrder: 'Review the implementation',
      expectedArtifacts: ['Review report'], acceptanceCriteria: ['No blockers'],
      permissionProfile: 'standard', requiredPermissions: ['read'],
      budget: { timeMinutes: 20, tokenLimit: 2_000, costLimit: 2 },
      retryPolicy: { maxAttempts: 2, backoff: 'linear' },
      ...overrides
    };
  }

  it('uses the approved node idempotency key as Orchestrator sourceKey', () => {
    const harness = createTaskHarness();
    const order = workOrder();
    const first = harness.port.createTask(order);
    const second = harness.port.createTask(order);
    expect(first).toEqual(second);
    expect(harness.createTask).toHaveBeenNthCalledWith(
      1,
      'agent-review',
      'Review the implementation',
      'team',
      expect.objectContaining({
        sourceKey: order.idempotencyKey,
        dependencyTaskIds: order.dependencyTaskIds
      })
    );
    const content = harness.createTask.mock.calls[0][3].content as string;
    expect(content).toContain(order.planHash);
    expect(content).toContain('task-build');
    expect(content).toContain('Review report');
    expect(content).toContain('No blockers');
  });

  it('rejects a key that does not bind session, version, hash, and node', () => {
    const harness = createTaskHarness();
    expectPlanningCode(() => harness.port.createTask(workOrder({ idempotencyKey: 'forged-key' })), 'DISPATCH_CONFLICT');
    expect(harness.createTask).not.toHaveBeenCalled();
  });

  it('fails closed without a project binding and forwards the durable project id when present', () => {
    const createTask = vi.fn(() => ({ id: 'task-scoped' }));
    const unbound = new OrchestratorPlanningDispatchPort(
      { createTask } as never,
      { resolveProjectId: () => null }
    );
    expectPlanningCode(() => unbound.createTask(workOrder()), 'PROJECT_BOUNDARY');
    expect(createTask).not.toHaveBeenCalled();

    const scoped = new OrchestratorPlanningDispatchPort(
      { createTask } as never,
      { resolveProjectId: () => 'project-1' }
    );
    expect(scoped.createTask(workOrder())).toEqual({ taskId: 'task-scoped' });
    expect(createTask).toHaveBeenCalledWith(
      'agent-review',
      'Review the implementation',
      'team',
      expect.objectContaining({ projectId: 'project-1' })
    );
  });
});
