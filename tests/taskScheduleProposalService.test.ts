import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Scheduler } from '../src/main/services/scheduler.js';
import { TaskScheduleProposalService } from '../src/main/services/taskScheduleProposalService.js';
import type { DispatchPlan, KernelRequest } from '../src/main/services/kernel/types.js';

const require = createRequire(import.meta.url);
let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
});

const DDL = `
PRAGMA foreign_keys = ON;
CREATE TABLE organizations (id TEXT PRIMARY KEY);
CREATE TABLE principals (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id));
CREATE TABLE channels (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id));
CREATE TABLE agents (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE projects (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE conversations (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  principal_id TEXT REFERENCES principals(id), channel_id TEXT REFERENCES channels(id)
);
CREATE TABLE tasks (id TEXT PRIMARY KEY, source TEXT NOT NULL, project_id TEXT REFERENCES projects(id));
CREATE TABLE schedules (
  id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(id), project_id TEXT REFERENCES projects(id),
  automation_kind TEXT NOT NULL DEFAULT 'task', title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
  cron_kind TEXT NOT NULL, cron_value TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER, next_run_at INTEGER NOT NULL
);
CREATE TABLE dispatch_plans (
  request_id TEXT PRIMARY KEY, status TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  principal_id TEXT NOT NULL REFERENCES principals(id), channel_id TEXT REFERENCES channels(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id), input_message_id TEXT NOT NULL,
  worker_agent_id TEXT NOT NULL REFERENCES agents(id), worker_engine_id TEXT NOT NULL,
  leader_kernel TEXT NOT NULL, task_id TEXT REFERENCES tasks(id), plan_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE task_schedule_proposals (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES dispatch_plans(request_id) ON DELETE CASCADE,
  proposal_index INTEGER NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  principal_id TEXT REFERENCES principals(id), channel_id TEXT REFERENCES channels(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  agent_id TEXT NOT NULL REFERENCES agents(id), project_id TEXT REFERENCES projects(id),
  operation TEXT NOT NULL CHECK(operation = 'create_task_schedule'),
  title TEXT NOT NULL, content TEXT NOT NULL,
  cron_kind TEXT NOT NULL CHECK(cron_kind IN ('interval', 'daily', 'weekly', 'monthly')),
  cron_value TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'rejected')),
  proposed_by TEXT NOT NULL, decided_by TEXT, decision_reason TEXT,
  schedule_id TEXT REFERENCES schedules(id), created_at INTEGER NOT NULL, decided_at INTEGER,
  UNIQUE(request_id, proposal_index)
);
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
  result TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL
);
`;

type SqlJsDatabase = InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>;

function statement(db: SqlJsDatabase, sql: string) {
  return {
    run: (...params: unknown[]) => {
      db.run(sql, params);
      return { changes: db.getRowsModified() };
    },
    get: (...params: unknown[]) => {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params);
        return stmt.step() ? stmt.getAsObject() : undefined;
      } finally {
        stmt.free();
      }
    },
    all: (...params: unknown[]) => {
      const stmt = db.prepare(sql);
      const rows: Record<string, unknown>[] = [];
      try {
        stmt.bind(params);
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      } finally {
        stmt.free();
      }
    }
  };
}

class TestDatabase {
  readonly inner: SqlJsDatabase;
  readonly raw: { prepare: (sql: string) => ReturnType<typeof statement> };
  failAuditAction: string | null = null;
  private auditClock = 20_000;

  constructor() {
    this.inner = new SQL.Database();
    this.inner.exec(DDL);
    this.inner.exec(`
      INSERT INTO organizations(id) VALUES('org-a'), ('org-b');
      INSERT INTO principals(id, organization_id) VALUES('person-a', 'org-a'), ('person-b', 'org-b');
      INSERT INTO channels(id, organization_id) VALUES('wechat-a', 'org-a'), ('wechat-b', 'org-b');
      INSERT INTO agents(id, organization_id, archived) VALUES('agent-a', 'org-a', 0), ('agent-b', 'org-b', 0);
      INSERT INTO projects(id, organization_id, status) VALUES('project-a', 'org-a', 'active'), ('project-b', 'org-b', 'active');
      INSERT INTO conversations(id, organization_id, principal_id, channel_id) VALUES
        ('conv-a', 'org-a', 'person-a', 'wechat-a'), ('conv-b', 'org-b', 'person-b', 'wechat-b');
    `);
    this.raw = { prepare: (sql: string) => statement(this.inner, sql) };
  }

  transaction(fn: () => void): void {
    this.inner.exec('BEGIN');
    try {
      fn();
      this.inner.exec('COMMIT');
    } catch (error) {
      this.inner.exec('ROLLBACK');
      throw error;
    }
  }

  audit(entry: { id: string; actor: string; action: string; target: string; result: string; source?: string }): void {
    this.raw.prepare(
      'INSERT INTO audit_logs(id, actor, action, target, result, source, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)'
    ).run(entry.id, entry.actor, entry.action, entry.target, entry.result, entry.source ?? 'desktop', this.auditClock++);
    if (entry.action === this.failAuditAction) throw new Error(`injected audit failure: ${entry.action}`);
  }

  rows(sql: string, ...params: unknown[]): Record<string, unknown>[] {
    return this.raw.prepare(sql).all(...params);
  }

  close(): void {
    this.inner.close();
  }
}

function request(overrides: Partial<KernelRequest> = {}): KernelRequest {
  return {
    requestId: 'request-a', source: 'channel', organizationId: 'org-a', principalId: 'person-a',
    channelId: 'wechat-a', conversationId: 'conv-a', inputMessageId: 'message-a',
    message: 'Create a recurring report', preferredAgentId: 'agent-a', projectId: 'project-a',
    workers: [{ agentId: 'agent-a', name: 'Worker', role: 'Operations', engineId: 'engine-a', capabilities: [] }],
    memories: [], ...overrides
  };
}

function plan(overrides: Partial<DispatchPlan> = {}): DispatchPlan {
  return {
    schemaVersion: 1, requestId: 'request-a', conversationId: 'conv-a', leaderKernel: 'hermes',
    workerAgentId: 'agent-a', workerEngineId: 'engine-a', title: 'Dispatch task', objective: 'Do the work',
    rationale: 'Worker match', priority: 0, expectedOutputs: ['result'], requiresHumanApproval: false,
    memoryProposals: [],
    taskScheduleProposals: [{
      operation: 'create_task_schedule', title: 'Daily report', content: 'Prepare the daily report',
      cronKind: 'daily', cronValue: '09:00'
    }],
    advisorAdvice: [], advisorReviews: [], ...overrides
  };
}

function storePlan(db: TestDatabase, req: KernelRequest, dispatch: DispatchPlan, status = 'committed'): void {
  const taskId = `task:${req.requestId}`;
  db.raw.prepare('INSERT INTO tasks(id, source, project_id) VALUES(?, ?, ?)')
    .run(taskId, req.source, req.projectId);
  db.raw.prepare(
    `INSERT INTO dispatch_plans(
      request_id, status, organization_id, principal_id, channel_id, conversation_id,
      input_message_id, worker_agent_id, worker_engine_id, leader_kernel, task_id,
      plan_json, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    req.requestId, status, req.organizationId, req.principalId, req.channelId,
    req.conversationId, req.inputMessageId, dispatch.workerAgentId, dispatch.workerEngineId,
    dispatch.leaderKernel, taskId, JSON.stringify(dispatch), 1
  );
}

describe('TaskScheduleProposalService', () => {
  let db: TestDatabase;
  let scheduler: Scheduler;
  let service: TaskScheduleProposalService;

  beforeEach(() => {
    db = new TestDatabase();
    scheduler = new Scheduler(db as never, {} as never);
    service = new TaskScheduleProposalService(db as never, scheduler, () => 1_000);
  });

  afterEach(() => db.close());

  it('captures only committed plans and deduplicates by request index', () => {
    const req = request();
    const dispatch = plan();
    storePlan(db, req, dispatch);

    const first = service.capture(req, dispatch);
    const second = service.capture(req, dispatch);

    expect(first[0]).toMatchObject({ status: 'pending', agentId: 'agent-a', projectId: 'project-a' });
    expect(second[0].id).toBe(first[0].id);
    expect(db.rows('SELECT * FROM task_schedule_proposals')).toHaveLength(1);
  });

  it('rejects suggestions that differ from the committed plan', () => {
    const req = request();
    const dispatch = plan();
    storePlan(db, req, dispatch);
    const altered = plan({
      taskScheduleProposals: [{
        operation: 'create_task_schedule', title: 'Changed', content: 'Different task',
        cronKind: 'daily', cronValue: '10:00'
      }]
    });

    expect(() => service.capture(req, altered)).toThrow('do not match the committed dispatch plan');
    expect(db.rows('SELECT * FROM task_schedule_proposals')).toEqual([]);
  });

  it('accepts through Scheduler and remains idempotent', () => {
    const req = request();
    const dispatch = plan();
    storePlan(db, req, dispatch);
    const proposal = service.capture(req, dispatch)[0];

    const accepted = service.accept({ organizationId: 'org-a', proposalId: proposal.id, actor: 'admin' });
    const repeated = service.accept({ organizationId: 'org-a', proposalId: proposal.id, actor: 'admin' });

    expect(accepted.proposal).toMatchObject({ status: 'accepted', scheduleId: accepted.schedule.id });
    expect(accepted.schedule).toMatchObject({ agentId: 'agent-a', projectId: 'project-a', automationKind: 'task' });
    expect(repeated.schedule.id).toBe(accepted.schedule.id);
    expect(db.rows('SELECT * FROM schedules')).toHaveLength(1);
  });

  it('rolls back both schedule and decision when acceptance audit fails', () => {
    const req = request();
    const dispatch = plan();
    storePlan(db, req, dispatch);
    const proposal = service.capture(req, dispatch)[0];
    db.failAuditAction = 'task_schedule.proposal.accept';

    expect(() => service.accept({ organizationId: 'org-a', proposalId: proposal.id, actor: 'admin' }))
      .toThrow('injected audit failure');
    expect(db.rows('SELECT * FROM schedules')).toEqual([]);
    expect(service.list({ organizationId: 'org-a' })[0]).toMatchObject({ status: 'pending', scheduleId: null });
  });

  it('rejects without creating a schedule and enforces organization scope', () => {
    const req = request();
    const dispatch = plan();
    storePlan(db, req, dispatch);
    const proposal = service.capture(req, dispatch)[0];

    expect(() => service.accept({ organizationId: 'org-b', proposalId: proposal.id, actor: 'admin' }))
      .toThrow('was not found');
    const rejected = service.reject({ organizationId: 'org-a', proposalId: proposal.id, actor: 'admin' });
    expect(rejected.status).toBe('rejected');
    expect(db.rows('SELECT * FROM schedules')).toEqual([]);
  });

  it('recovers proposals omitted after a committed dispatch', () => {
    const req = request();
    const dispatch = plan();
    storePlan(db, req, dispatch);

    expect(service.recoverCommitted()).toEqual({ scannedPlans: 1, recoveredProposals: 1, failedPlans: 0 });
    expect(service.recoverCommitted()).toEqual({ scannedPlans: 1, recoveredProposals: 0, failedPlans: 0 });
    expect(service.list({ organizationId: 'org-a' })).toHaveLength(1);
  });
});
