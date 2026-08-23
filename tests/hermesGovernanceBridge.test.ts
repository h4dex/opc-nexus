import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import initSqlJs from 'sql.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

import { Database } from '../src/main/services/database.js';
import {
  HermesGovernanceBridge,
  type HermesClarifyResponder,
  type HermesDelegationProjector,
  type HermesPlanProjector
} from '../src/main/services/hermesGovernanceBridge.js';
import { ProjectManager } from '../src/main/services/projectManager.js';

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

function wrap(): TestDatabase {
  const inner = new SQL.Database();
  openDatabases.push(inner);
  const db = Reflect.construct(Database as unknown as new () => Database, []) as TestDatabase;
  db.inner = inner;
  db.scheduleSave = () => {};
  (db as unknown as { flush: () => void }).flush = () => {};
  (db as unknown as { migrate: () => void }).migrate();
  return db;
}

function fixture() {
  const db = wrap();
  const now = Date.UTC(2026, 7, 18, 10, 0, 0);
  db.inner.exec(`
    INSERT INTO engines(id, type, name, status) VALUES('eng-dsh', 'dsh-managed', 'DSH', 'HEALTHY');
    INSERT INTO agents(
      id, organization_id, name, role, engine_id, lifecycle, workspace,
      permission_mode, capabilities_json, created_at, updated_at
    ) VALUES(
      'agent-dsh', 'org-local', 'DSH', 'dispatcher', 'eng-dsh', 'READY', 'E:/opc/work',
      'standard', '{}', ${now}, ${now}
    );
    CREATE TABLE hermes_session_bindings (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      principal_id TEXT NOT NULL REFERENCES principals(id),
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      hermes_session_id TEXT NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, conversation_id)
    );
  `);
  const project = new ProjectManager(db).create({ name: 'Hermes bridge', objective: 'Test governed clarification', status: 'active' });
  let clock = now;
  const bridge = new HermesGovernanceBridge(db, () => clock);
  const respond = vi.fn<HermesClarifyResponder['respond']>(async () => undefined);
  bridge.attachClarifyResponder({ respond });
  return { db, project, bridge, respond, setNow: (value: number) => { clock = value; }, now };
}

function nativeClarify(projectId: string, requestId = 'clarify-1') {
  return {
    method: 'event',
    params: {
      type: 'clarify.request',
      session_id: 'hermes-session-1',
      payload: { question: 'Choose a delivery mode', choices: ['preview', 'package'], request_id: requestId }
    }
  };
}

function hostPlanDraft() {
  return {
    projectId: 'attempted-project-override',
    conversationId: 'attempted-conversation-override',
    source: 'hermes',
    model: 'attempted-model-override',
    objective: 'Publish a verified project result',
    assumptions: ['The project workspace is available'],
    scope: { included: ['Create the result'], excluded: ['Production deployment'] },
    team: [{ workerAgentId: 'agent-dsh', responsibility: 'Implement and verify', capabilities: ['code'] }],
    dag: [{
      id: 'work-1', title: 'Create result', workerAgentId: 'agent-dsh', dependsOn: [],
      acceptanceCriteria: ['A real result.md exists'], expectedArtifacts: ['result.md']
    }],
    risks: [{ id: 'risk-1', description: 'Output may be incomplete', mitigation: 'Verify the file', approvalRequired: false }],
    budget: { maxCost: 10, maxTokens: 20_000, maxConcurrent: 1 },
    acceptanceCriteria: ['The result is reviewable'],
    expectedArtifacts: [{ relativePath: 'result.md', mediaType: 'text/markdown', previewable: true }],
    memoryRefs: ['MEMORY.md']
  };
}

function insertHermesTask(
  db: TestDatabase,
  input: {
    id: string;
    agentId: string;
    projectId: string;
    conversationId: string;
    title: string;
    content?: string;
    status?: string;
    result?: string | null;
    error?: string | null;
    createdAt?: number;
  }
): void {
  const at = input.createdAt ?? Date.now();
  const status = input.status ?? 'COMPLETED';
  db.raw.prepare(`
    INSERT INTO tasks(
      id, agent_id, project_id, conversation_id, title, content, source, status,
      progress, stage, error, result, artifacts_required, created_at, ended_at
    ) VALUES(?, ?, ?, ?, ?, ?, 'team', ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    input.id, input.agentId, input.projectId, input.conversationId, input.title,
    input.content ?? '', status, status === 'COMPLETED' ? 100 : 0,
    status === 'COMPLETED' ? '完成' : '执行中', input.error ?? null, input.result ?? null, at,
    status === 'COMPLETED' ? at : null
  );
}

describe('HermesGovernanceBridge clarification governance', () => {
  it('creates independent scheduler and employee conversations without replacing prior tabs', () => {
    const f = fixture();
    const scheduler = f.bridge.createConversation(f.project.id);
    const employee = f.bridge.createConversation(f.project.id, { employeeId: 'agent-dsh' });

    expect(scheduler.conversationId).not.toBe(employee.conversationId);
    expect(scheduler.employee).toBeNull();
    expect(employee).toMatchObject({
      title: 'DSH · 员工会话',
      employee: { id: 'agent-dsh', name: 'DSH', memoryMode: 'short_term' },
      hasSession: false
    });
    expect(f.bridge.listConversations(f.project.id).map((item) => item.conversationId))
      .toEqual(expect.arrayContaining([scheduler.conversationId, employee.conversationId]));

    const binding = f.bridge.ensureSessionBinding(f.project.id, 'hermes-tab-session', {
      conversationId: employee.conversationId,
      principalId: 'principal-local-admin'
    });
    expect(binding.conversationId).toBe(employee.conversationId);
    expect(f.bridge.listConversations(f.project.id)
      .find((item) => item.conversationId === employee.conversationId)?.hasSession).toBe(true);
  });

  it('migrates legacy DSH plan projection columns without losing persisted facts', () => {
    const db = wrap();
    db.raw.prepare(`
      CREATE TABLE hermes_plan_drafts (
        draft_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        model TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'DRAFT',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `).run();
    db.raw.prepare(`
      CREATE TABLE hermes_plan_projections (
        draft_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        planning_session_id TEXT NOT NULL,
        dsh_session_id TEXT NOT NULL,
        dsh_plan_id TEXT NOT NULL,
        dsh_version INTEGER NOT NULL,
        plan_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `).run();
    db.raw.prepare(`
      INSERT INTO hermes_plan_projections(
        draft_id, project_id, planning_session_id, dsh_session_id, dsh_plan_id,
        dsh_version, plan_hash, status, created_at, updated_at
      ) VALUES('draft-legacy', 'project-legacy', 'governance-1', 'hermes-session-1',
        'hermes-plan-1', 3, 'hash-1', 'APPROVED', 1, 2)
    `).run();

    new HermesGovernanceBridge(db);

    const columns = (db.raw.prepare('PRAGMA table_info(hermes_plan_projections)').all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining([
      'governance_session_id', 'hermes_session_id', 'plan_id', 'plan_version'
    ]));
    expect(columns.some((name) => name.startsWith('dsh_'))).toBe(false);
    expect(db.raw.prepare(`
      SELECT governance_session_id, hermes_session_id, plan_id, plan_version, plan_hash, status
      FROM hermes_plan_projections WHERE draft_id = 'draft-legacy'
    `).get()).toEqual({
      governance_session_id: 'governance-1',
      hermes_session_id: 'hermes-session-1',
      plan_id: 'hermes-plan-1',
      plan_version: 3,
      plan_hash: 'hash-1',
      status: 'APPROVED'
    });
  });

  it('keeps retired employee history out of the current Quest tab list', () => {
    const f = fixture();
    const employee = f.bridge.createConversation(f.project.id, { employeeId: 'agent-dsh' });
    f.db.raw.prepare("UPDATE agents SET archived = 1 WHERE id = 'agent-dsh'").run();

    expect(f.bridge.listConversations(f.project.id).find((item) => item.conversationId === employee.conversationId))
      .toBeUndefined();
    expect(f.db.raw.prepare('SELECT id FROM conversations WHERE id = ?').get(employee.conversationId))
      .toEqual({ id: employee.conversationId });
  });

  it('returns the continued Hermes turn to a waiting channel caller', async () => {
    const f = fixture();
    f.respond.mockResolvedValueOnce({ content: 'Plan updated from the owner answer.' });
    f.bridge.ingestControlMessage(f.project.id, nativeClarify(f.project.id));

    const resumed = await f.bridge.answerClarifyAndWait({
      clarifyId: 'clarify-1', projectId: f.project.id, principalId: 'principal-local-admin', answer: 'preview'
    });

    expect(resumed).toMatchObject({
      request: { clarifyId: 'clarify-1', status: 'ANSWERED' },
      content: 'Plan updated from the owner answer.'
    });
    expect(f.respond).toHaveBeenCalledOnce();
  });

  it('normalizes native Hermes events and persists the owner answer once', async () => {
    const f = fixture();
    const request = f.bridge.ingestControlMessage(f.project.id, nativeClarify(f.project.id));
    expect(request).toMatchObject({ clarifyId: 'clarify-1', projectId: f.project.id, status: 'OPEN' });

    const answered = await f.bridge.answerClarify({
      clarifyId: 'clarify-1', projectId: f.project.id, principalId: 'principal-local-admin', answer: 'preview'
    });
    expect(answered.status).toBe('ANSWERED');
    expect(f.respond).toHaveBeenCalledWith(f.project.id, 'clarify-1', 'preview');

    await f.bridge.answerClarify({
      clarifyId: 'clarify-1', projectId: f.project.id, principalId: 'principal-local-admin', answer: 'preview'
    });
    expect(f.respond).toHaveBeenCalledOnce();
  });

  it('keeps the host answer authoritative when Hermes resume is temporarily offline', async () => {
    const f = fixture();
    f.respond.mockRejectedValueOnce(new Error('Hermes service disconnected'));
    f.bridge.ingestControlMessage(f.project.id, nativeClarify(f.project.id));
    const answered = await f.bridge.answerClarify({
      clarifyId: 'clarify-1', projectId: f.project.id, principalId: 'principal-local-admin', answer: 'preview'
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(answered.status).toBe('ANSWERED');
    expect(f.bridge.getClarify('clarify-1')?.status).toBe('ANSWERED');
    expect(f.db.raw.prepare('SELECT status, attempts, last_error FROM hermes_clarify_resumes WHERE clarify_id = ?')
      .get('clarify-1')).toEqual({
        status: 'FAILED', attempts: 1, last_error: 'Hermes service disconnected'
      });

    await f.bridge.resumePendingClarifications(f.project.id);
    expect(f.respond).toHaveBeenCalledTimes(2);
    expect(f.db.raw.prepare('SELECT status, attempts, last_error FROM hermes_clarify_resumes WHERE clarify_id = ?')
      .get('clarify-1')).toEqual({ status: 'RESUMED', attempts: 2, last_error: null });
  });

  it('persists API clarify through the Host Contract and blocks premature plan submission', async () => {
    const f = fixture();
    const persisted = await f.bridge.handleHostRequest(f.project.id, 'clarify', {
      clarifyId: 'clarify-host-1',
      hermesSessionId: 'hermes-host-session-clarify',
      question: 'Which delivery target should be used?',
      choices: ['preview', 'package'],
      multiSelect: false
    });
    expect(persisted).toMatchObject({ clarifyId: 'clarify-host-1', status: 'OPEN' });
    await expect(f.bridge.handleHostRequest(f.project.id, 'submit-plan', {
      hermesSessionId: 'hermes-host-session-clarify', model: 'provider/model-1', draft: hostPlanDraft()
    })).rejects.toThrow('blocked by unanswered clarification clarify-host-1');
  });

  it('expires durable questions and rejects principals outside the project organization', async () => {
    const f = fixture();
    f.db.inner.exec(`
      INSERT INTO organizations(id, slug, name, created_at, updated_at)
      VALUES('org-other', 'other', 'Other', ${f.now}, ${f.now});
      INSERT INTO principals(id, organization_id, kind, display_name, created_at, updated_at)
      VALUES('principal-other', 'org-other', 'person', 'Other owner', ${f.now}, ${f.now});
    `);
    f.bridge.ingestControlMessage(f.project.id, nativeClarify(f.project.id));
    await expect(f.bridge.answerClarify({
      clarifyId: 'clarify-1', projectId: f.project.id, principalId: 'principal-other', answer: 'preview'
    })).rejects.toThrow('outside the project organization');
    expect(f.respond).not.toHaveBeenCalled();

    const expiring = {
      ...(f.bridge.getClarify('clarify-1')!),
      clarifyId: 'clarify-expiring',
      expiresAt: f.now + 1_000
    };
    f.bridge.persistClarify(expiring);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    f.setNow(f.now + 2_000);
    expect(f.bridge.expireDue()).toBe(1);
    expect(f.bridge.getClarify('clarify-expiring')?.status).toBe('EXPIRED');
  });

  it('requires every plan artifact to have exactly one DAG owner', () => {
    const f = fixture();
    const conversation = f.bridge.createConversation(f.project.id);
    const draft = {
      ...hostPlanDraft(),
      projectId: f.project.id,
      conversationId: conversation.conversationId
    };

    expect(() => f.bridge.admitPlanDraft({
      ...draft,
      dag: [{ ...draft.dag[0], expectedArtifacts: [] }]
    })).toThrow('artifact result.md has no DAG owner');
    expect(() => f.bridge.admitPlanDraft({
      ...draft,
      expectedArtifacts: [
        ...draft.expectedArtifacts,
        { relativePath: 'other.md', mediaType: 'text/markdown', previewable: true }
      ],
      dag: [
        draft.dag[0],
        {
          id: 'work-2', title: 'Duplicate result', workerAgentId: 'agent-dsh', dependsOn: ['work-1'],
          acceptanceCriteria: ['Review result.md'], expectedArtifacts: ['result.md', 'other.md']
        }
      ]
    })).toThrow('assigned to both work-1 and work-2');
  });

  it('injects the service project scope and projects repeated host plans exactly once', async () => {
    const f = fixture();
    const projectPlan = vi.fn<HermesPlanProjector['project']>(async (_draft, admission) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        governanceSessionId: 'governance-host-1',
        sessionId: 'hermes-session-1',
        planId: `plan-${admission.draftId}`,
        version: 1,
        hash: admission.hash
      };
    });
    f.bridge.attachPlanProjector({
      project: projectPlan,
      approve: vi.fn(async () => undefined),
      dispatch: vi.fn(async () => undefined)
    });
    const request = {
      hermesSessionId: 'hermes-host-session-1',
      model: 'provider/model-1',
      draft: hostPlanDraft()
    };

    const [first, second] = await Promise.all([
      f.bridge.handleHostRequest(f.project.id, 'submit-plan', request),
      f.bridge.handleHostRequest(f.project.id, 'submit-plan', request)
    ]);

    expect(first).toEqual(second);
    expect(projectPlan).toHaveBeenCalledOnce();
    expect(projectPlan.mock.calls[0]?.[0]).toMatchObject({
      projectId: f.project.id,
      conversationId: expect.stringMatching(/^hermes-conversation-/),
      source: 'hermes',
      model: 'provider/model-1'
    });
    expect(f.db.raw.prepare('SELECT COUNT(*) AS count FROM hermes_plan_drafts').get()).toEqual({ count: 1 });
    expect(f.db.raw.prepare('SELECT COUNT(*) AS count FROM hermes_plan_projections').get()).toEqual({ count: 1 });
  });

  it('maps an admitted delegate request once through host governance and never leaves a fake ADMITTED row', async () => {
    const f = fixture();
    const projectPlan = vi.fn<HermesPlanProjector['project']>(async (_draft, admission) => ({
      governanceSessionId: 'governance-delegate-1', sessionId: 'hermes-session-1',
      planId: 'plan-1', version: 1, hash: admission.hash
    }));
    f.bridge.attachPlanProjector({
      project: projectPlan,
      approve: vi.fn(async () => undefined),
      dispatch: vi.fn(async () => undefined)
    });
    await f.bridge.handleHostRequest(f.project.id, 'submit-plan', {
      hermesSessionId: 'hermes-delegate-session-1', model: 'provider/model-1', draft: hostPlanDraft()
    });
    const projectDelegation = vi.fn<HermesDelegationProjector['project']>(() => ({
      jobIds: ['task-real-1'], runIds: [null], planHash: 'approved-plan-hash'
    }));
    f.bridge.attachDelegationProjector({ project: projectDelegation });
    const request = {
      parentSessionId: 'hermes-delegate-session-1', parentRunId: 'hermes-parent-run-1',
      projectId: f.project.id,
      tasks: [{ id: 'work-1', title: 'Create result', description: 'Create the approved result', dependsOn: [] }],
      workerAgentId: 'agent-dsh', dependencies: [],
      permissions: { network: false, shell: false, install: false, browser: false, computer: false, mobile: false },
      budget: { maxCost: 10, maxTokens: 20_000 }, maxDepth: 1, maxConcurrentChildren: 1
    };

    const first = f.bridge.admitDelegation(request);
    const retry = f.bridge.admitDelegation(request);
    expect(first).toMatchObject({ status: 'DISPATCHED', requestId: retry.requestId });
    expect(retry.status).toBe('DISPATCHED');
    expect(projectDelegation).toHaveBeenCalledOnce();
    expect(f.db.raw.prepare('SELECT status FROM hermes_delegation_requests WHERE request_id = ?')
      .get(first.requestId)).toEqual({ status: 'DISPATCHED' });
  });

  it('rejects delegation when no host projector is attached instead of persisting a placeholder', async () => {
    const f = fixture();
    f.bridge.attachPlanProjector({
      project: vi.fn(async (_draft, admission) => ({
        governanceSessionId: 'governance-delegate-2', sessionId: 'hermes-session-2',
        planId: 'plan-2', version: 1, hash: admission.hash
      })),
      approve: vi.fn(async () => undefined), dispatch: vi.fn(async () => undefined)
    });
    await f.bridge.handleHostRequest(f.project.id, 'submit-plan', {
      hermesSessionId: 'hermes-delegate-session-2', model: 'provider/model-1', draft: hostPlanDraft()
    });
    expect(() => f.bridge.admitDelegation({
      parentSessionId: 'hermes-delegate-session-2', parentRunId: 'run-2', projectId: f.project.id,
      tasks: [{ id: 'work-1', title: 'Create result', description: 'Create result', dependsOn: [] }],
      workerAgentId: 'agent-dsh', dependencies: [],
      permissions: { network: false, shell: false, install: false, browser: false, computer: false, mobile: false },
      budget: { maxCost: 1, maxTokens: 1_000 }, maxDepth: 1, maxConcurrentChildren: 1
    })).toThrow('OPC-Nexus delegation governance is unavailable');
    expect(f.db.raw.prepare('SELECT COUNT(*) AS count FROM hermes_delegation_requests').get()).toEqual({ count: 0 });
  });

  it('keeps a completed Hermes plan task in acceptance until an independent worker returns PASS', () => {
    const f = fixture();
    f.db.inner.exec(`
      INSERT INTO agents(
        id, organization_id, name, role, engine_id, lifecycle, workspace,
        permission_mode, capabilities_json, created_at, updated_at
      ) VALUES(
        'agent-reviewer', 'org-local', '验收员', '独立验收', 'eng-dsh', 'READY', 'E:/opc/work',
        'standard', '{}', ${f.now}, ${f.now}
      );
    `);
    const conversationId = f.bridge.createConversation(f.project.id).conversationId;
    insertHermesTask(f.db, {
      id: 'task-plan-impl', agentId: 'agent-dsh', projectId: f.project.id, conversationId,
      title: '实现官网', result: '文件已生成'
    });
    f.db.raw.prepare(`
      INSERT INTO hermes_plan_drafts(
        draft_id, project_id, conversation_id, model, payload_json, payload_hash, status, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, 'DISPATCHED', ?, ?)
    `).run('draft-gate', f.project.id, conversationId, 'test-model', '{}', 'gate-hash', f.now, f.now);
    f.db.raw.prepare(
      'INSERT INTO hermes_plan_jobs(draft_id, node_id, task_id, created_at) VALUES(?, ?, ?, ?)'
    ).run('draft-gate', 'work-1', 'task-plan-impl', f.now);

    expect(f.bridge.getDeliveryGate('task-plan-impl')).toMatchObject({
      required: true, allowed: false, validationVerdict: 'BLOCKED',
      reason: expect.stringContaining('尚未完成独立验收')
    });

    insertHermesTask(f.db, {
      id: 'task-plan-review', agentId: 'agent-reviewer', projectId: f.project.id, conversationId,
      title: '独立验收官网',
      content: 'Task intent: validation\n\n检查真实成果\n\nRelated project tasks:\ntask-plan-impl\n\n只报告证据。',
      result: '**PASS**\n\n真实预览和文件均已检查。'
    });
    expect(f.bridge.getDeliveryGate('task-plan-impl')).toMatchObject({
      required: true, allowed: true, validationTaskId: 'task-plan-review', validationVerdict: 'PASS'
    });

    f.db.raw.prepare('UPDATE tasks SET result = ?, status = ? WHERE id = ?')
      .run('FAIL: 移动端遮挡', 'COMPLETED', 'task-plan-review');
    expect(f.bridge.getDeliveryGate('task-plan-impl')).toMatchObject({
      allowed: false, validationTaskId: 'task-plan-review', validationVerdict: 'FAIL',
      reason: expect.stringContaining('未通过')
    });
  });

  it('does not add an acceptance ceremony to a simple one-shot employee task', () => {
    const f = fixture();
    const conversationId = f.bridge.createConversation(f.project.id).conversationId;
    insertHermesTask(f.db, {
      id: 'task-simple', agentId: 'agent-dsh', projectId: f.project.id, conversationId,
      title: '润色一句话', result: '已完成'
    });
    expect(f.bridge.getDeliveryGate('task-simple')).toEqual({
      taskId: 'task-simple', projectId: f.project.id, required: false, allowed: true,
      reason: null, validationTaskId: null, validationVerdict: null
    });
  });

  it('matches every implementation task when a secretary validation covers a multi-node plan', () => {
    const f = fixture();
    f.db.inner.exec(`
      INSERT INTO agents(
        id, organization_id, name, role, engine_id, lifecycle, workspace,
        permission_mode, capabilities_json, created_at, updated_at
      ) VALUES(
        'agent-reviewer-2', 'org-local', '验收员 2', '独立验收', 'eng-dsh', 'READY', 'E:/opc/work',
        'standard', '{}', ${f.now}, ${f.now}
      );
      INSERT INTO agents(
        id, organization_id, name, role, engine_id, lifecycle, workspace,
        permission_mode, capabilities_json, created_at, updated_at
      ) VALUES(
        'agent-reviewer-3', 'org-local', '验收员 3', '独立验收', 'eng-dsh', 'READY', 'E:/opc/work',
        'standard', '{}', ${f.now}, ${f.now}
      );
    `);
    const conversationId = f.bridge.createConversation(f.project.id).conversationId;
    insertHermesTask(f.db, {
      id: 'task-plan-impl-a', agentId: 'agent-dsh', projectId: f.project.id, conversationId,
      title: '实现首页', result: '首页已生成'
    });
    insertHermesTask(f.db, {
      id: 'task-plan-impl-b', agentId: 'agent-reviewer-2', projectId: f.project.id, conversationId,
      title: '实现接口', result: '接口已生成'
    });
    f.db.raw.prepare(`
      INSERT INTO hermes_plan_drafts(
        draft_id, project_id, conversation_id, model, payload_json, payload_hash, status, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, 'DISPATCHED', ?, ?)
    `).run('draft-gate-multi', f.project.id, conversationId, 'test-model', '{}', 'gate-hash-multi', f.now, f.now);
    f.db.raw.prepare(
      'INSERT INTO hermes_plan_jobs(draft_id, node_id, task_id, created_at) VALUES(?, ?, ?, ?)'
    ).run('draft-gate-multi', 'work-a', 'task-plan-impl-a', f.now);
    f.db.raw.prepare(
      'INSERT INTO hermes_plan_jobs(draft_id, node_id, task_id, created_at) VALUES(?, ?, ?, ?)'
    ).run('draft-gate-multi', 'work-b', 'task-plan-impl-b', f.now);
    insertHermesTask(f.db, {
      id: 'task-plan-review-multi', agentId: 'agent-reviewer-3', projectId: f.project.id, conversationId,
      title: '独立验收',
      content: 'Task intent: validation\n\nRelated project tasks:\ntask-plan-impl-a\ntask-plan-impl-b\n\n只报告证据。',
      result: '**PASS**\n\n真实检查通过。'
    });
    expect(f.bridge.getDeliveryGate('task-plan-impl-a')).toMatchObject({
      allowed: true, validationVerdict: 'PASS'
    });
    expect(f.bridge.getDeliveryGate('task-plan-impl-b')).toMatchObject({
      allowed: true, validationVerdict: 'PASS'
    });
  });
});
