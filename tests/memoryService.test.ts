import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryService } from '../src/main/services/memoryService.js';
import {
  AUTO_ACCEPT_CONVERSATION_MEMORY_SETTING,
  MemoryProposalService
} from '../src/main/services/memoryProposalService.js';
import type { DispatchPlan, KernelRequest } from '../src/main/services/kernel/types.js';

const require = createRequire(import.meta.url);
let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
});

const DDL = `
PRAGMA foreign_keys = ON;
CREATE TABLE organizations (id TEXT PRIMARY KEY);
CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id)
);
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id)
);
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id)
);
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id)
);
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  principal_id TEXT REFERENCES principals(id),
  channel_id TEXT REFERENCES channels(id)
);
CREATE TABLE memory_items (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  importance REAL NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  forgotten_at INTEGER
);
CREATE UNIQUE INDEX idx_memory_active_dedupe
  ON memory_items(organization_id, content_hash, scope_key)
  WHERE status = 'active';
CREATE TABLE memory_scopes (
  memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  PRIMARY KEY(memory_id, scope_type)
);
CREATE TABLE memory_versions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  content TEXT NOT NULL,
  importance REAL NOT NULL,
  status TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  change_kind TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(memory_id, revision)
);
CREATE TABLE memory_terms (
  memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  term TEXT NOT NULL,
  weight REAL NOT NULL,
  PRIMARY KEY(memory_id, term)
);
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  result TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id)
);
CREATE TABLE dispatch_plans (
  request_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  channel_id TEXT,
  conversation_id TEXT NOT NULL,
  input_message_id TEXT NOT NULL,
  worker_agent_id TEXT NOT NULL,
  worker_engine_id TEXT NOT NULL,
  leader_kernel TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id),
  plan_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE memory_proposals (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  proposal_index INTEGER NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  principal_id TEXT REFERENCES principals(id),
  channel_id TEXT REFERENCES channels(id),
  conversation_id TEXT REFERENCES conversations(id),
  agent_id TEXT REFERENCES agents(id),
  project_id TEXT REFERENCES projects(id),
  operation TEXT NOT NULL CHECK(operation = 'remember'),
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  importance REAL NOT NULL CHECK(importance >= 0 AND importance <= 1),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'rejected')),
  proposed_by TEXT NOT NULL,
  decided_by TEXT,
  decision_reason TEXT,
  memory_id TEXT REFERENCES memory_items(id),
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  UNIQUE(request_id, proposal_index)
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

class SqlJsMemoryDatabase {
  readonly inner: SqlJsDatabase;
  readonly raw: { prepare: (sql: string) => ReturnType<typeof statement> };
  failAuditAction: string | null = null;
  private readonly settings = new Map<string, unknown>();
  private auditClock = 10_000;

  constructor() {
    this.inner = new SQL.Database();
    this.inner.exec(DDL);
    this.inner.exec(`
      INSERT INTO organizations(id) VALUES('org-a'), ('org-b');
      INSERT INTO principals(id, organization_id) VALUES
        ('person-1', 'org-a'), ('person-2', 'org-a'), ('person-b', 'org-b');
      INSERT INTO channels(id, organization_id) VALUES('wechat', 'org-a'), ('wechat-b', 'org-b');
      INSERT INTO agents(id, organization_id) VALUES('agent-1', 'org-a'), ('agent-b', 'org-b');
      INSERT INTO projects(id, organization_id) VALUES('project-1', 'org-a'), ('project-b', 'org-b');
      INSERT INTO conversations(id, organization_id, principal_id, channel_id) VALUES
        ('conv-1', 'org-a', 'person-1', 'wechat'),
        ('conv-2', 'org-a', 'person-1', 'wechat'),
        ('conv-person-2', 'org-a', 'person-2', 'wechat'),
        ('conv-b', 'org-b', 'person-b', 'wechat-b');
    `);
    this.raw = { prepare: (sql: string) => statement(this.inner, sql) };
  }

  getSetting<T>(key: string, fallback: T): T {
    return (this.settings.has(key) ? this.settings.get(key) : fallback) as T;
  }

  setSetting(key: string, value: unknown): void {
    this.settings.set(key, value);
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

function kernelRequest(overrides: Partial<KernelRequest> = {}): KernelRequest {
  return {
    requestId: 'request-1',
    source: 'channel',
    organizationId: 'org-a',
    principalId: 'person-1',
    channelId: 'wechat',
    conversationId: 'conv-1',
    inputMessageId: 'message-1',
    message: 'Remember my preference',
    preferredAgentId: 'agent-1',
    projectId: 'project-1',
    workers: [{ agentId: 'agent-1', name: 'Worker', role: 'work', engineId: 'engine-1', capabilities: [] }],
    memories: [],
    ...overrides
  };
}

function dispatchPlan(overrides: Partial<DispatchPlan> = {}): DispatchPlan {
  return {
    schemaVersion: 1,
    requestId: 'request-1',
    conversationId: 'conv-1',
    leaderKernel: 'hermes',
    workerAgentId: 'agent-1',
    workerEngineId: 'engine-1',
    title: 'Task',
    objective: 'Complete the task',
    rationale: 'Best worker match',
    priority: 0,
    expectedOutputs: ['result'],
    requiresHumanApproval: false,
    memoryProposals: [{
      operation: 'remember', kind: 'preference', content: 'Use concise replies',
      scope: 'conversation', importance: 0.8
    }],
    taskScheduleProposals: [],
    advisorAdvice: [],
    advisorReviews: [],
    ...overrides
  };
}

function storePlan(
  db: SqlJsMemoryDatabase,
  request: KernelRequest,
  plan: DispatchPlan,
  status: 'planned' | 'committed' | 'failed' = 'committed'
): void {
  const taskId = `task:${request.requestId}`;
  db.raw.prepare('INSERT INTO tasks(id, source, project_id) VALUES(?, ?, ?)')
    .run(taskId, request.source, request.projectId);
  db.raw.prepare(
    `INSERT INTO dispatch_plans(
      request_id, status, organization_id, principal_id, channel_id, conversation_id,
      input_message_id, worker_agent_id, worker_engine_id, leader_kernel, task_id, plan_json, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    request.requestId, status, request.organizationId, request.principalId, request.channelId,
    request.conversationId, request.inputMessageId, plan.workerAgentId, plan.workerEngineId,
    plan.leaderKernel, taskId, JSON.stringify(plan), 1_000
  );
}

describe('MemoryService', () => {
  let db: SqlJsMemoryDatabase;
  let service: MemoryService;
  let clock: number;

  beforeEach(() => {
    db = new SqlJsMemoryDatabase();
    clock = 1_000;
    service = new MemoryService(db as never, () => clock++);
  });

  afterEach(() => db.close());

  it('requires every supplied scope to match and never crosses organizations or conversations', () => {
    const organizationWide = service.remember({
      organizationId: 'org-a', kind: 'policy', content: 'Use approved suppliers', importance: 0.1, actor: 'admin'
    });
    const conversationOne = service.remember({
      organizationId: 'org-a', principalId: 'person-1', channelId: 'wechat', conversationId: 'conv-1',
      kind: 'preference', content: 'Conversation one secret', importance: 0.9, actor: 'kernel'
    });
    const conversationTwo = service.remember({
      organizationId: 'org-a', principalId: 'person-1', channelId: 'wechat', conversationId: 'conv-2',
      kind: 'preference', content: 'Conversation two secret', importance: 0.8, actor: 'kernel'
    });
    const otherPrincipal = service.remember({
      organizationId: 'org-a', principalId: 'person-2', channelId: 'wechat', conversationId: 'conv-person-2',
      kind: 'preference', content: 'Other principal secret', importance: 0.7, actor: 'kernel'
    });
    const otherTenant = service.remember({
      organizationId: 'org-b', principalId: 'person-b', channelId: 'wechat-b', conversationId: 'conv-b',
      kind: 'preference', content: 'Other tenant secret', importance: 1, actor: 'kernel'
    });

    const recalled = service.recall({
      organizationId: 'org-a', principalId: 'person-1', channelId: 'wechat', conversationId: 'conv-1'
    });
    expect(recalled.map((item) => item.id)).toEqual([conversationOne.id, organizationWide.id]);
    expect(recalled.map((item) => item.id)).not.toContain(conversationTwo.id);
    expect(recalled.map((item) => item.id)).not.toContain(otherPrincipal.id);
    expect(recalled.map((item) => item.id)).not.toContain(otherTenant.id);

    expect(service.recall({ organizationId: 'org-a', principalId: 'person-1', channelId: 'wechat' }).map((item) => item.id))
      .toEqual([organizationWide.id]);
    expect(service.get('org-b', conversationOne.id)).toBeNull();
  });

  it('deduplicates normalized content only inside the exact scope and audits the retry', () => {
    const first = service.remember({
      organizationId: 'org-a', conversationId: 'conv-1', kind: 'fact',
      content: 'DeepSeek   endpoint', actor: 'kernel', source: 'wechat'
    });
    const duplicate = service.remember({
      organizationId: 'org-a', conversationId: 'conv-1', kind: 'fact',
      content: ' deepseek endpoint ', actor: 'kernel', source: 'wechat-retry'
    });
    const otherScope = service.remember({
      organizationId: 'org-a', conversationId: 'conv-2', kind: 'fact',
      content: 'deepseek endpoint', actor: 'kernel'
    });

    expect(duplicate.id).toBe(first.id);
    expect(otherScope.id).not.toBe(first.id);
    expect(db.rows('SELECT id FROM memory_items')).toHaveLength(2);
    expect(db.rows('SELECT revision FROM memory_versions WHERE memory_id = ?', first.id)).toHaveLength(1);
    expect(db.rows('SELECT action, result, source FROM audit_logs ORDER BY rowid')).toEqual([
      { action: 'memory.remember', result: 'created', source: 'wechat' },
      { action: 'memory.remember', result: 'deduplicated', source: 'wechat-retry' },
      { action: 'memory.remember', result: 'created', source: 'desktop' }
    ]);
  });

  it('uses optimistic revisions and rolls a stale update back without changing the lexical index', () => {
    const original = service.remember({
      organizationId: 'org-a', kind: 'fact', content: 'alpha value', actor: 'kernel'
    });
    const updated = service.update({
      organizationId: 'org-a', memoryId: original.id, expectedRevision: 1,
      content: 'beta value', importance: 0.8, actor: 'admin', reason: 'corrected'
    });

    expect(updated).toMatchObject({ revision: 2, content: 'beta value', importance: 0.8 });
    expect(() => service.update({
      organizationId: 'org-a', memoryId: original.id, expectedRevision: 1,
      content: 'stale value', actor: 'stale-writer'
    })).toThrow('memory revision conflict');
    expect(service.get('org-a', original.id)).toMatchObject({ revision: 2, content: 'beta value' });
    expect(db.rows('SELECT revision, change_kind FROM memory_versions WHERE memory_id = ? ORDER BY revision', original.id)).toEqual([
      { revision: 1, change_kind: 'remember' },
      { revision: 2, change_kind: 'update' }
    ]);
    expect(db.rows('SELECT term FROM memory_terms WHERE memory_id = ? ORDER BY term', original.id)).toEqual([
      { term: 'beta' }, { term: 'value' }
    ]);
  });

  it('forgets with a revision, retains history, and excludes the item from recall', () => {
    const original = service.remember({
      organizationId: 'org-a', conversationId: 'conv-1', kind: 'preference',
      content: 'Use concise replies', actor: 'kernel'
    });
    const forgotten = service.forget({
      organizationId: 'org-a', memoryId: original.id, expectedRevision: 1,
      actor: 'admin', reason: 'user requested deletion'
    });

    expect(forgotten).toMatchObject({ status: 'forgotten', revision: 2, forgottenAt: 1_001 });
    expect(service.recall({ organizationId: 'org-a', conversationId: 'conv-1', query: 'concise' })).toEqual([]);
    expect(db.rows('SELECT revision, status, change_kind, reason FROM memory_versions WHERE memory_id = ? ORDER BY revision', original.id)).toEqual([
      { revision: 1, status: 'active', change_kind: 'remember', reason: null },
      { revision: 2, status: 'forgotten', change_kind: 'forget', reason: 'user requested deletion' }
    ]);
  });

  it('returns only lexical matches and ranks exact matches ahead of importance-only candidates', () => {
    service.remember({
      organizationId: 'org-a', conversationId: 'conv-1', kind: 'fact',
      content: 'Quarterly finance budget', importance: 1, actor: 'kernel'
    });
    const match = service.remember({
      organizationId: 'org-a', conversationId: 'conv-1', kind: 'fact',
      content: 'DeepSeek API endpoint is configured', importance: 0.1, actor: 'kernel'
    });
    const chineseMatch = service.remember({
      organizationId: 'org-a', conversationId: 'conv-1', kind: 'preference',
      content: '用户偏好中文回复', importance: 0.2, actor: 'kernel'
    });
    service.remember({
      organizationId: 'org-a', conversationId: 'conv-2', kind: 'fact',
      content: 'DeepSeek API endpoint belongs to another conversation', importance: 1, actor: 'kernel'
    });

    expect(service.recall({ organizationId: 'org-a', conversationId: 'conv-1', query: 'deepseek api' }).map((item) => item.id))
      .toEqual([match.id]);
    expect(service.recall({ organizationId: 'org-a', conversationId: 'conv-1', query: '中文' }).map((item) => item.id))
      .toEqual([chineseMatch.id]);
    expect(service.recall({ organizationId: 'org-a', conversationId: 'conv-1', query: 'absent phrase' })).toEqual([]);
  });

  it('keeps mutations and their audit record in one transaction', () => {
    const original = service.remember({
      organizationId: 'org-a', kind: 'fact', content: 'original value', actor: 'kernel'
    });
    db.failAuditAction = 'memory.update';

    expect(() => service.update({
      organizationId: 'org-a', memoryId: original.id, expectedRevision: 1,
      content: 'uncommitted value', actor: 'admin', source: 'desktop'
    })).toThrow('injected audit failure');
    expect(service.get('org-a', original.id)).toMatchObject({ revision: 1, content: 'original value' });
    expect(db.rows('SELECT revision FROM memory_versions WHERE memory_id = ?', original.id)).toEqual([{ revision: 1 }]);
    expect(db.rows("SELECT action FROM audit_logs WHERE action = 'memory.update'")).toEqual([]);
  });

  it('rejects scope ids owned by another organization', () => {
    expect(() => service.remember({
      organizationId: 'org-a', agentId: 'agent-b', kind: 'fact', content: 'private', actor: 'admin'
    })).toThrow('agentId does not belong to organization');
    expect(() => service.recall({ organizationId: 'org-a', projectId: 'project-b' }))
      .toThrow('projectId does not belong to organization');
    expect(() => service.remember({
      organizationId: 'org-a', principalId: 'person-2', conversationId: 'conv-1',
      kind: 'fact', content: 'mismatched conversation', actor: 'admin'
    })).toThrow('conversationId does not belong to principalId');
    expect(db.rows('SELECT id FROM memory_items')).toEqual([]);
  });
});

describe('MemoryProposalService', () => {
  let db: SqlJsMemoryDatabase;
  let memory: MemoryService;
  let proposals: MemoryProposalService;
  let clock: number;

  beforeEach(() => {
    db = new SqlJsMemoryDatabase();
    clock = 20_000;
    memory = new MemoryService(db as never, () => clock++);
    proposals = new MemoryProposalService(db as never, memory, () => clock++);
  });

  afterEach(() => db.close());

  it('keeps prompt-originated proposals pending by default and captures retries idempotently', () => {
    const request = kernelRequest();
    const plan = dispatchPlan();
    storePlan(db, request, plan);

    const first = proposals.capture(request, plan);
    const retry = proposals.capture(request, plan);

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ status: 'pending', scopeType: 'conversation', scopeId: 'conv-1' });
    expect(retry[0].id).toBe(first[0].id);
    expect(db.rows('SELECT id FROM memory_proposals')).toHaveLength(1);
    expect(db.rows('SELECT id FROM memory_items')).toEqual([]);
    expect(db.rows("SELECT result FROM audit_logs WHERE action = 'memory.proposal.capture' ORDER BY rowid"))
      .toEqual([{ result: 'pending' }, { result: 'deduplicated' }]);
  });

  it('refuses proposals from a plan that was not successfully committed', () => {
    const request = kernelRequest();
    const plan = dispatchPlan();
    storePlan(db, request, plan, 'failed');

    expect(() => proposals.capture(request, plan)).toThrow('committed dispatch plan');
    expect(db.rows('SELECT id FROM memory_proposals')).toEqual([]);
    expect(db.rows('SELECT id FROM memory_items')).toEqual([]);
  });

  it('recovers missing proposals from committed plans after restart', () => {
    const request = kernelRequest();
    const plan = dispatchPlan();
    storePlan(db, request, plan);

    expect(proposals.recoverCommitted()).toEqual({
      scannedPlans: 1, recoveredProposals: 1, failedPlans: 0
    });
    expect(proposals.list({ organizationId: 'org-a' })).toHaveLength(1);
    expect(proposals.recoverCommitted()).toEqual({
      scannedPlans: 1, recoveredProposals: 0, failedPlans: 0
    });
    expect(db.rows('SELECT id FROM memory_proposals')).toHaveLength(1);
  });

  it('accepts once and atomically links the canonical memory', () => {
    const request = kernelRequest();
    const plan = dispatchPlan();
    storePlan(db, request, plan);
    const [pending] = proposals.capture(request, plan);

    const accepted = proposals.accept({
      organizationId: 'org-a', proposalId: pending.id, actor: 'admin', reason: 'confirmed'
    });
    const retry = proposals.accept({ organizationId: 'org-a', proposalId: pending.id, actor: 'admin' });

    expect(accepted.proposal).toMatchObject({ status: 'accepted', memoryId: accepted.memory.id, decidedBy: 'admin' });
    expect(accepted.memory.scopes).toEqual(expect.arrayContaining([
      { type: 'organization', id: 'org-a' },
      { type: 'principal', id: 'person-1' },
      { type: 'channel', id: 'wechat' },
      { type: 'conversation', id: 'conv-1' }
    ]));
    expect(retry.memory.id).toBe(accepted.memory.id);
    expect(db.rows('SELECT id FROM memory_items')).toHaveLength(1);
    expect(db.rows('SELECT id FROM memory_versions')).toHaveLength(1);
    expect(proposals.list({ organizationId: 'org-a', status: 'accepted' })).toHaveLength(1);
  });

  it('rolls canonical memory back when accepting the proposal cannot be audited', () => {
    const request = kernelRequest();
    const plan = dispatchPlan();
    storePlan(db, request, plan);
    const [pending] = proposals.capture(request, plan);
    db.failAuditAction = 'memory.proposal.accept';

    expect(() => proposals.accept({ organizationId: 'org-a', proposalId: pending.id, actor: 'admin' }))
      .toThrow('injected audit failure');
    expect(proposals.list({ organizationId: 'org-a' })[0]).toMatchObject({ status: 'pending', memoryId: null });
    expect(db.rows('SELECT id FROM memory_items')).toEqual([]);
    expect(db.rows("SELECT action FROM audit_logs WHERE action IN ('memory.remember', 'memory.proposal.accept')"))
      .toEqual([]);
  });

  it('persists rejection and never permits a rejected proposal to create memory', () => {
    const request = kernelRequest();
    const plan = dispatchPlan();
    storePlan(db, request, plan);
    const [pending] = proposals.capture(request, plan);

    const rejected = proposals.reject({
      organizationId: 'org-a', proposalId: pending.id, actor: 'admin', reason: 'not durable'
    });
    expect(rejected).toMatchObject({ status: 'rejected', decisionReason: 'not durable' });
    expect(proposals.reject({ organizationId: 'org-a', proposalId: pending.id, actor: 'admin' }).id).toBe(pending.id);
    expect(() => proposals.accept({ organizationId: 'org-a', proposalId: pending.id, actor: 'admin' }))
      .toThrow('cannot be accepted');
    expect(db.rows('SELECT id FROM memory_items')).toEqual([]);
  });

  it('auto-accepts only conversation scope after explicit local opt-in', () => {
    db.setSetting(AUTO_ACCEPT_CONVERSATION_MEMORY_SETTING, true);
    const request = kernelRequest();
    const plan = dispatchPlan({
      memoryProposals: [
        { operation: 'remember', kind: 'preference', content: 'Conversation preference', scope: 'conversation', importance: 0.7 },
        { operation: 'remember', kind: 'fact', content: 'Principal fact', scope: 'principal', importance: 0.6 }
      ]
    });
    storePlan(db, request, plan);

    const captured = proposals.capture(request, plan);
    expect(captured.map((proposal) => proposal.status)).toEqual(['accepted', 'pending']);
    expect(db.rows('SELECT id FROM memory_items')).toHaveLength(1);
  });
});
