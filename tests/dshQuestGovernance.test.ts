import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import initSqlJs from 'sql.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

import { Database } from '../src/main/services/database.js';
import {
  createDshQuestGovernanceAdmissionHandler,
  DshQuestGovernanceService,
  resolveDshQuestProjectId
} from '../src/main/services/dshQuestGovernance.js';
import { ProjectManager } from '../src/main/services/projectManager.js';
import { ProjectWorkbenchService } from '../src/main/services/projectWorkbench.js';
import { SecretaryPlanningRepository } from '../src/main/services/secretaryPlanningAdapters.js';
import {
  PlanningError,
  hashCanonicalJson,
  type CompanyExecutionPlan,
  type DispatchPort,
  type DispatchWorkOrder,
  type PlanningComplexitySignals,
  type PlanningQuestion
} from '../src/main/services/secretaryPlanning.js';
import { CapabilityRegistry, PluginHost } from '../src/main/services/pluginHost.js';
import {
  DSH_QUEST_GOVERNANCE_CAPABILITY_ID,
  OPC_NEXUS_GOVERNANCE_PLUGIN_ID,
  OPC_NEXUS_GOVERNANCE_PLUGIN_MANIFEST
} from '../src/main/services/opcNexusGovernancePlugin.js';

const require = createRequire(import.meta.url);
let SQL: Awaited<ReturnType<typeof initSqlJs>>;
const openDatabases: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>[] = [];

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
});

afterEach(() => {
  while (openDatabases.length) openDatabases.pop()!.close();
});

type TestDatabase = Database & { inner: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>; scheduleSave: () => void };

function wrap(inner = new SQL.Database()): TestDatabase {
  openDatabases.push(inner);
  const db = Reflect.construct(Database as unknown as new () => Database, []) as TestDatabase;
  db.inner = inner;
  db.scheduleSave = () => {};
  (db as unknown as { flush: () => void }).flush = () => {};
  return db;
}

function signals(overrides: Partial<PlanningComplexitySignals> = {}): PlanningComplexitySignals {
  return {
    departmentIds: ['cordis', 'editorial'],
    hasCrossTeamDependencies: true,
    ambiguousObjective: true,
    ambiguousScope: false,
    ambiguousAcceptance: true,
    estimatedDurationMinutes: 180,
    estimatedCost: 8,
    estimatedTokenCount: 40_000,
    requiresNewTeam: true,
    irreversibleOperations: ['write_files'],
    compareAlternatives: true,
    phasedExecution: true,
    confirmBeforeExecution: true,
    estimatedTaskCount: 4,
    ...overrides
  };
}

function question(): PlanningQuestion {
  return {
    id: 'delivery-posture',
    kind: 'single',
    prompt: 'Which delivery posture should Cordis use?',
    options: [
      { id: 'fast', label: 'Fast', impact: 'Shorter review cycle' },
      { id: 'reviewed', label: 'Reviewed', impact: 'Adds an independent acceptance pass' }
    ],
    recommendedOptionId: 'reviewed',
    recommendationReason: 'The work crosses team boundaries.',
    allowOther: true
  };
}

function plan(projectObjective = 'Deliver a reviewed project artifact'): CompanyExecutionPlan {
  return {
    schemaVersion: 1,
    organizationId: 'org-local',
    objective: projectObjective,
    assumptions: ['The project workspace is available'],
    scope: { included: ['Research', 'Delivery'], excluded: ['Production publication'] },
    team: [{
      teamId: 'team-cordis',
      organizationId: 'org-local',
      leadAgentId: 'agent-cordis',
      memberAgentIds: ['agent-hermes'],
      proposedEphemeralRoles: ['fact checker']
    }],
    dag: [
      // The durable projection canonicalizes DAG nodes by id before hashing.
      // Cordis sends this already-normalized representation while dispatch
      // still follows dependencies rather than array order.
      {
        nodeId: 'node-deliver',
        organizationId: 'org-local',
        ownerAgentId: 'agent-hermes',
        dependencies: ['node-research'],
        workOrder: 'Create the reviewed project artifact.',
        expectedArtifacts: ['delivery.md'],
        acceptanceCriteria: ['Artifact satisfies the approved brief'],
        permissionProfile: 'standard',
        requiredPermissions: ['read', 'write'],
        budget: { timeMinutes: 40, tokenLimit: 8_000, costLimit: 2 },
        retryPolicy: { maxAttempts: 2, backoff: 'linear' }
      },
      {
        nodeId: 'node-research',
        organizationId: 'org-local',
        ownerAgentId: 'agent-cordis',
        dependencies: [],
        workOrder: 'Research and coordinate the delivery.',
        expectedArtifacts: ['research.md'],
        acceptanceCriteria: ['Sources are traceable'],
        permissionProfile: 'readonly',
        requiredPermissions: ['read'],
        budget: { timeMinutes: 20, tokenLimit: 4_000, costLimit: 1 },
        retryPolicy: { maxAttempts: 2, backoff: 'linear' }
      }
    ],
    risks: [{ risk: 'Unsupported claim', mitigation: 'Require traceable sources', ownerAgentId: 'agent-cordis' }],
    overallBudget: { timeMinutes: 90, tokenLimit: 20_000, costLimit: 5 },
    acceptanceCriteria: ['Both artifacts are present and reviewed']
  };
}

function createFixture(bytes?: Uint8Array) {
  const db = wrap(bytes ? new SQL.Database(bytes) : new SQL.Database());
  if (!bytes) {
    (db as unknown as { migrate: () => void }).migrate();
    const now = Date.UTC(2026, 7, 17, 12, 0, 0);
    db.inner.exec(`
      INSERT INTO engines(id, type, name, status) VALUES
        ('eng-cordis', 'dsh-managed', 'DSH / Cordis', 'HEALTHY'),
        ('eng-hermes', 'hermes-cli', 'Hermes', 'HEALTHY'),
        ('eng-extra', 'codex-cli', 'Codex', 'HEALTHY');
      INSERT INTO agents(
        id, organization_id, name, role, engine_id, lifecycle, workspace,
        permission_mode, capabilities_json, created_at, updated_at
      ) VALUES
        ('agent-cordis', 'org-local', 'Cordis', 'Quest lead', 'eng-cordis', 'READY', 'E:/opc/cordis', 'standard', '{}', ${now}, ${now}),
        ('agent-hermes', 'org-local', 'Hermes', 'Fixed writer', 'eng-hermes', 'READY', 'E:/opc/hermes', 'standard', '{}', ${now}, ${now}),
        ('agent-extra', 'org-local', 'Codex', 'Unselected worker', 'eng-extra', 'READY', 'E:/opc/codex', 'trusted', '{"shell":true}', ${now}, ${now});
      INSERT INTO dsh_profiles(id, engine_id, version, created_at, updated_at)
        VALUES('profile-cordis', 'eng-cordis', 1, ${now}, ${now});
      INSERT INTO dsh_runtime_instances(id, agent_id, profile_id, process_state, endpoint, created_at, updated_at)
        VALUES('runtime-cordis', 'agent-cordis', 'profile-cordis', 'READY', 'http://127.0.0.1:3101', ${now}, ${now});
      INSERT INTO dsh_sessions(
        id, upstream_session_id, runtime_instance_id, agent_id, workspace,
        control_mode, delegation_depth, created_at, updated_at
      ) VALUES(
        'session-cordis-root', 'upstream-cordis-root', 'runtime-cordis', 'agent-cordis',
        'E:/opc/project', 'NEXUS_MANAGED', 0, ${now}, ${now}
      );
    `);
  }
  const projects = new ProjectManager(db);
  const project = bytes
    ? projects.list()[0]!
    : projects.create({ name: 'Cordis Quest project', objective: 'Deliver a reviewed project artifact', status: 'active' });
  const workbench = new ProjectWorkbenchService(db);
  if (!bytes) workbench.saveSettings(project.id, { workerAgentIds: ['agent-hermes'], permissionMode: 'standard', mode: 'quest' });
  const repository = new SecretaryPlanningRepository(db);
  const createTask = vi.fn((order: DispatchWorkOrder) => {
    const taskId = `task-${order.nodeId}`;
    db.raw.prepare(
      `INSERT INTO tasks(id, agent_id, project_id, title, content, source, source_key, status, created_at)
       VALUES(?, ?, ?, ?, ?, 'team', ?, 'QUEUED', ?)
       ON CONFLICT(source, source_key) WHERE source_key IS NOT NULL DO NOTHING`
    ).run(taskId, order.ownerAgentId, project.id, order.workOrder, order.workOrder, order.idempotencyKey, Date.now());
    const existing = db.raw.prepare('SELECT id FROM tasks WHERE source = ? AND source_key = ?').get('team', order.idempotencyKey) as { id?: string } | undefined;
    return { taskId: String(existing?.id ?? taskId) };
  });
  const dispatchPort: DispatchPort = { createTask };
  const service = new DshQuestGovernanceService({ db, repository, dispatchPort, workbench, now: () => Date.UTC(2026, 7, 17, 13, 0, 0) });
  return { db, project, workbench, repository, service, createTask };
}

function openAndAnswer(fixture: ReturnType<typeof createFixture>) {
  let view = fixture.service.openQuest({
    planningSessionId: 'quest-cordis-1',
    projectId: fixture.project.id,
    dshSessionId: 'session-cordis-root',
    principalId: 'principal-local-admin',
    request: 'Coordinate a reviewed delivery across the configured team.',
    signals: signals()
  });
  view = fixture.service.projectQuestionSet({
    planningSessionId: view.session.id,
    dshSessionId: view.binding.dshSessionId,
    expectedRevision: view.session.revision,
    questionSet: { id: 'cordis-question-set-1', version: 1, questions: [question()] }
  });
  view = fixture.service.answerQuestions({
    planningSessionId: view.session.id,
    principalId: view.binding.principalId,
    expectedRevision: view.session.revision,
    dshQuestionSetId: 'cordis-question-set-1',
    dshVersion: 1,
    answers: [{ questionId: 'delivery-posture', selectedOptionIds: ['reviewed'], text: null }]
  });
  return view;
}

function projectPlan(fixture: ReturnType<typeof createFixture>, view: ReturnType<typeof openAndAnswer>, value = plan()) {
  const planHash = hashCanonicalJson(value);
  return fixture.service.projectPlan({
    planningSessionId: view.session.id,
    dshSessionId: view.binding.dshSessionId,
    expectedRevision: view.session.revision,
    plan: { id: 'cordis-plan-1', version: 1, hash: planHash, value }
  });
}

describe('DshQuestGovernanceService', () => {
  it('attaches a typed Cordis admission capability without granting owner decisions', async () => {
    const fixture = createFixture();
    const registry = new CapabilityRegistry();
    registry.register(OPC_NEXUS_GOVERNANCE_PLUGIN_MANIFEST);
    const authorize = vi.fn(async (request: { pluginId: string; capabilityId: string; owner: string; permission: string }) =>
      request.pluginId === OPC_NEXUS_GOVERNANCE_PLUGIN_ID
      && request.capabilityId === DSH_QUEST_GOVERNANCE_CAPABILITY_ID
      && request.owner === 'nexus-governance'
      && (request.permission === 'artifact.read' || request.permission === 'artifact.write'));
    const host = new PluginHost(registry, authorize);
    const verifySource = vi.fn(({ runtimeInstanceId, dshSessionId }: { runtimeInstanceId: string; dshSessionId: string }) =>
      runtimeInstanceId === 'runtime-cordis' && dshSessionId === 'session-cordis-root');
    host.attach(OPC_NEXUS_GOVERNANCE_PLUGIN_ID, {
      [DSH_QUEST_GOVERNANCE_CAPABILITY_ID]: createDshQuestGovernanceAdmissionHandler(fixture.service, { verifySource })
    });

    const invoke = (requestId: string, operation: string, payload: Record<string, unknown>, runtimeInstanceId = 'runtime-cordis') =>
      host.invoke({
        pluginId: OPC_NEXUS_GOVERNANCE_PLUGIN_ID,
        capabilityId: DSH_QUEST_GOVERNANCE_CAPABILITY_ID,
        input: {
          schemaVersion: 1,
          requestId,
          operation,
          runtimeInstanceId,
          dshSessionId: 'session-cordis-root',
          payload
        }
      }) as Promise<{ view: ReturnType<DshQuestGovernanceService['getQuest']> }>;

    let result = await invoke('admission-open-1', 'quest.open', {
      planningSessionId: 'quest-plugin-1',
      projectId: fixture.project.id,
      principalId: 'principal-local-admin',
      request: 'Coordinate a reviewed delivery across the configured team.',
      signals: signals()
    });
    expect(result.view.session.status).toBe('DRAFT');
    result = await invoke('admission-questions-1', 'questions.project', {
      planningSessionId: 'quest-plugin-1',
      expectedRevision: result.view.session.revision,
      questionSet: { id: 'cordis-plugin-questions-1', version: 1, questions: [question()] }
    });
    expect(result.view.session.status).toBe('NEEDS_INPUT');

    // Answering is a trusted owner-side action and is deliberately absent
    // from the Cordis admission operation set.
    let view = fixture.service.answerQuestions({
      planningSessionId: 'quest-plugin-1',
      principalId: 'principal-local-admin',
      expectedRevision: result.view.session.revision,
      dshQuestionSetId: 'cordis-plugin-questions-1',
      dshVersion: 1,
      answers: [{ questionId: 'delivery-posture', selectedOptionIds: ['reviewed'], text: null }]
    });
    const value = plan();
    result = await invoke('admission-plan-1', 'plan.project', {
      planningSessionId: 'quest-plugin-1',
      expectedRevision: view.session.revision,
      plan: { id: 'cordis-plugin-plan-1', version: 1, hash: hashCanonicalJson(value), value }
    });
    expect(result.view.session.status).toBe('PROPOSED');
    expect(fixture.createTask).not.toHaveBeenCalled();
    expect(host.isAttached(OPC_NEXUS_GOVERNANCE_PLUGIN_ID, DSH_QUEST_GOVERNANCE_CAPABILITY_ID)).toBe(true);
    expect(authorize).toHaveBeenCalledTimes(6);
    expect(verifySource).toHaveBeenCalledTimes(3);

    await expect(invoke('admission-owner-action', 'plan.approve', {
      planningSessionId: 'quest-plugin-1'
    })).rejects.toMatchObject({ code: 'HANDLER_FAILED', cause: expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }) });
    await expect(invoke('admission-wrong-runtime', 'quest.get', {
      planningSessionId: 'quest-plugin-1'
    }, 'runtime-other')).rejects.toMatchObject({ code: 'HANDLER_FAILED', cause: expect.objectContaining({ code: 'RUNTIME_BOUNDARY' }) });
    view = fixture.service.getQuest('quest-plugin-1');
    expect(view.session.status).toBe('PROPOSED');
    expect(fixture.createTask).not.toHaveBeenCalled();
  });

  it('projects Cordis questions and plan, requires exact boss approval, then dispatches project-scoped work', async () => {
    const fixture = createFixture();
    let view = openAndAnswer(fixture);
    expect(view.session.status).toBe('DRAFT');
    expect(view.questionProjections).toEqual([expect.objectContaining({ dshQuestionSetId: 'cordis-question-set-1', dshVersion: 1 })]);
    expect(fixture.createTask).not.toHaveBeenCalled();

    view = projectPlan(fixture, view);
    const projected = view.planProjections[0]!;
    expect(view.session.status).toBe('PROPOSED');
    expect(projected).toMatchObject({ dshPlanId: 'cordis-plan-1', dshVersion: 1, planHash: view.planVersions[0]!.hash });
    await expect(fixture.service.dispatchPlan({
      planningSessionId: view.session.id,
      principalId: view.binding.principalId,
      expectedRevision: view.session.revision,
      dshPlanId: projected.dshPlanId,
      dshVersion: projected.dshVersion,
      hash: projected.planHash
    })).rejects.toMatchObject({ code: 'PLAN_NOT_APPROVED' });
    expect(() => fixture.service.approvePlan({
      planningSessionId: view.session.id,
      principalId: view.binding.principalId,
      expectedRevision: view.session.revision,
      dshPlanId: projected.dshPlanId,
      dshVersion: projected.dshVersion,
      hash: '0'.repeat(64)
    })).toThrowError(expect.objectContaining({ code: 'PLAN_HASH_MISMATCH' }));

    view = fixture.service.approvePlan({
      planningSessionId: view.session.id,
      principalId: view.binding.principalId,
      expectedRevision: view.session.revision,
      dshPlanId: projected.dshPlanId,
      dshVersion: projected.dshVersion,
      hash: projected.planHash
    });
    view = await fixture.service.dispatchPlan({
      planningSessionId: view.session.id,
      principalId: view.binding.principalId,
      expectedRevision: view.session.revision,
      dshPlanId: projected.dshPlanId,
      dshVersion: projected.dshVersion,
      hash: projected.planHash
    });
    expect(view.session.status).toBe('DISPATCHED');
    expect(view.dispatchReceipts).toHaveLength(2);
    expect(fixture.createTask.mock.calls.map(([order]) => (order as DispatchWorkOrder).nodeId)).toEqual(['node-research', 'node-deliver']);
    const tasks = fixture.db.raw.prepare('SELECT project_id FROM tasks ORDER BY id').all() as Array<{ project_id: string }>;
    expect(tasks.map((task) => task.project_id)).toEqual([fixture.project.id, fixture.project.id]);
    expect(resolveDshQuestProjectId(fixture.db, view.session.id)).toBe(fixture.project.id);
  });

  it('treats replayed DSH facts as idempotent and reconstructs source identities after SQLite reopen', () => {
    const fixture = createFixture();
    let view = fixture.service.openQuest({
      planningSessionId: 'quest-cordis-1', projectId: fixture.project.id, dshSessionId: 'session-cordis-root',
      principalId: 'principal-local-admin', request: 'Coordinate a reviewed delivery across the configured team.', signals: signals()
    });
    const input = {
      planningSessionId: view.session.id,
      dshSessionId: view.binding.dshSessionId,
      expectedRevision: view.session.revision,
      questionSet: { id: 'cordis-question-set-1', version: 1, questions: [question()] }
    };
    view = fixture.service.projectQuestionSet(input);
    expect(fixture.service.projectQuestionSet(input).session.revision).toBe(view.session.revision);
    view = fixture.service.answerQuestions({
      planningSessionId: view.session.id, principalId: view.binding.principalId, expectedRevision: view.session.revision,
      dshQuestionSetId: 'cordis-question-set-1', dshVersion: 1,
      answers: [{ questionId: 'delivery-posture', selectedOptionIds: ['reviewed'], text: null }]
    });
    const value = plan();
    const planInput = {
      planningSessionId: view.session.id,
      dshSessionId: view.binding.dshSessionId,
      expectedRevision: view.session.revision,
      plan: { id: 'cordis-plan-1', version: 1, hash: hashCanonicalJson(value), value }
    };
    view = fixture.service.projectPlan(planInput);
    expect(fixture.service.projectPlan(planInput).session.revision).toBe(view.session.revision);

    const reopened = createFixture(fixture.db.inner.export());
    const restored = reopened.service.getQuest('quest-cordis-1');
    expect(restored.binding).toMatchObject({ projectId: fixture.project.id, dshSessionId: 'session-cordis-root' });
    expect(restored.questionProjections[0]).toMatchObject({ dshQuestionSetId: 'cordis-question-set-1', dshVersion: 1 });
    expect(restored.planProjections[0]).toMatchObject({ dshPlanId: 'cordis-plan-1', dshVersion: 1, planHash: planInput.plan.hash });
  });

  it('fails closed for another root, unselected workers, event gaps and unavailable host permissions', () => {
    const fixture = createFixture();
    let view = openAndAnswer(fixture);
    const gapInput = {
      planningSessionId: view.session.id,
      dshSessionId: view.binding.dshSessionId,
      expectedRevision: view.session.revision,
      plan: { id: 'cordis-plan-2', version: 2, hash: hashCanonicalJson(plan()), value: plan() }
    };
    expect(() => fixture.service.projectPlan(gapInput)).toThrowError(expect.objectContaining({ code: 'EVENT_GAP' }));

    const withUnselected = plan();
    withUnselected.team[0] = { ...withUnselected.team[0]!, memberAgentIds: ['agent-extra'] };
    withUnselected.dag[1] = { ...withUnselected.dag[1]!, ownerAgentId: 'agent-extra' };
    expect(() => projectPlan(fixture, view, withUnselected)).toThrowError(expect.objectContaining({ code: 'UNKNOWN_AGENT' }));

    const managedWrite = plan();
    const managedIndex = managedWrite.dag.findIndex((node) => node.ownerAgentId === 'agent-cordis');
    managedWrite.dag[managedIndex] = {
      ...managedWrite.dag[managedIndex]!, permissionProfile: 'autonomous', requiredPermissions: ['read', 'shell']
    };
    expect(() => projectPlan(fixture, view, managedWrite)).toThrowError(expect.objectContaining({ code: 'PERMISSION_DENIED' }));

    expect(() => fixture.service.projectQuestionSet({
      planningSessionId: view.session.id,
      dshSessionId: 'another-root',
      expectedRevision: view.session.revision,
      questionSet: { id: 'cordis-question-set-2', version: 2, questions: [question()] }
    })).toThrowError(expect.objectContaining({ code: 'SESSION_BOUNDARY' }));
  });

  it('rejects a child session and a root session from another organization', () => {
    const fixture = createFixture();
    const now = Date.UTC(2026, 7, 17, 12, 0, 0);
    fixture.db.inner.exec(`
      INSERT INTO dsh_sessions(
        id, upstream_session_id, runtime_instance_id, agent_id, parent_session_id, workspace,
        control_mode, delegation_depth, created_at, updated_at
      ) VALUES(
        'session-child', 'upstream-child', 'runtime-cordis', 'agent-cordis', 'session-cordis-root',
        'E:/opc/project', 'DELEGATED', 1, ${now}, ${now}
      );
      INSERT INTO organizations(id, slug, name, created_at, updated_at)
        VALUES('org-other', 'other', 'Other', ${now}, ${now});
      INSERT INTO principals(id, organization_id, kind, display_name, created_at, updated_at)
        VALUES('principal-other', 'org-other', 'person', 'Other owner', ${now}, ${now});
      INSERT INTO agents(
        id, organization_id, name, role, engine_id, lifecycle, workspace,
        permission_mode, capabilities_json, created_at, updated_at
      ) VALUES(
        'agent-other', 'org-other', 'Other Cordis', 'Quest lead', 'eng-cordis', 'READY',
        'E:/opc/other', 'readonly', '{}', ${now}, ${now}
      );
      INSERT INTO dsh_runtime_instances(id, agent_id, profile_id, process_state, endpoint, created_at, updated_at)
        VALUES('runtime-other', 'agent-other', 'profile-cordis', 'READY', 'http://127.0.0.1:3201', ${now}, ${now});
      INSERT INTO dsh_sessions(
        id, upstream_session_id, runtime_instance_id, agent_id, workspace,
        control_mode, delegation_depth, created_at, updated_at
      ) VALUES(
        'session-other-root', 'upstream-other-root', 'runtime-other', 'agent-other',
        'E:/opc/other', 'NEXUS_MANAGED', 0, ${now}, ${now}
      );
    `);
    const base = {
      planningSessionId: 'quest-invalid', projectId: fixture.project.id,
      principalId: 'principal-local-admin', request: 'Invalid boundary test', signals: signals()
    };
    expect(() => fixture.service.openQuest({ ...base, dshSessionId: 'session-child' }))
      .toThrowError(expect.objectContaining({ code: 'SESSION_BOUNDARY' }));
    expect(() => fixture.service.openQuest({ ...base, dshSessionId: 'session-other-root' }))
      .toThrowError(expect.objectContaining({ code: 'ORGANIZATION_BOUNDARY' }));
  });

  it('surfaces stable PlanningError codes for callers that must map failures to DSH events', () => {
    const fixture = createFixture();
    try {
      fixture.service.getQuest('missing-quest');
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(PlanningError);
      expect((error as PlanningError).code).toBe('SESSION_NOT_FOUND');
    }
  });
});
