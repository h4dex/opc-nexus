import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { createRequire } from 'node:module';
import { DatabaseKernelState } from '../src/main/services/kernel/databaseKernelState.js';
import type { DispatchPlan, KernelRequest } from '../src/main/services/kernel/types.js';

const require = createRequire(import.meta.url);
let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
});

const DDL = `
CREATE TABLE kernel_attempts (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  component_id TEXT NOT NULL, role TEXT NOT NULL, sequence INTEGER NOT NULL,
  status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, error TEXT,
  UNIQUE(request_id, sequence)
);
CREATE TABLE kernel_sessions (
  conversation_id TEXT NOT NULL, kernel_id TEXT NOT NULL, native_session_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY(conversation_id, kernel_id)
);
CREATE TABLE dispatch_plans (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, organization_id TEXT NOT NULL,
  principal_id TEXT NOT NULL, channel_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  input_message_id TEXT NOT NULL, leader_kernel TEXT NOT NULL, worker_agent_id TEXT NOT NULL,
  worker_engine_id TEXT NOT NULL, status TEXT NOT NULL, task_id TEXT, plan_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, committed_at INTEGER, error TEXT
);
`;

function statement(db: InstanceType<typeof SQL.Database>, sql: string) {
  return {
    run: (...params: unknown[]) => {
      db.run(sql, params);
      return { changes: db.getRowsModified() };
    },
    get: (...params: unknown[]) => {
      const statement = db.prepare(sql);
      try {
        statement.bind(params);
        return statement.step() ? statement.getAsObject() : undefined;
      } finally {
        statement.free();
      }
    },
    all: (...params: unknown[]) => {
      const statement = db.prepare(sql);
      const rows: Record<string, unknown>[] = [];
      try {
        statement.bind(params);
        while (statement.step()) rows.push(statement.getAsObject());
        return rows;
      } finally {
        statement.free();
      }
    }
  };
}

function testDb() {
  const inner = new SQL.Database();
  inner.exec(DDL);
  return {
    inner,
    raw: { prepare: (sql: string) => statement(inner, sql) }
  };
}

function request(): KernelRequest {
  return {
    requestId: 'kernel:message-1', source: 'channel', organizationId: 'org-1', principalId: 'principal-1',
    channelId: 'ch-weixin', conversationId: 'conversation-1', inputMessageId: 'message-1',
    message: 'Prepare a report', preferredAgentId: 'agent-1', projectId: null,
    workers: [{ agentId: 'agent-1', name: 'Ops', role: 'operations', engineId: 'eng-pi', capabilities: [] }],
    memories: []
  };
}

function plan(overrides: Partial<DispatchPlan> = {}): DispatchPlan {
  return {
    schemaVersion: 1, requestId: 'kernel:message-1', conversationId: 'conversation-1',
    leaderKernel: 'hermes', workerAgentId: 'agent-1', workerEngineId: 'eng-pi',
    title: 'Prepare report', objective: 'Prepare the complete report', rationale: 'Role match',
    priority: 0, expectedOutputs: ['report'], requiresHumanApproval: false,
    memoryProposals: [], taskScheduleProposals: [], advisorAdvice: [], advisorReviews: [], ...overrides
  };
}

describe('DatabaseKernelState', () => {
  let db: ReturnType<typeof testDb>;
  let state: DatabaseKernelState;

  beforeEach(() => {
    db = testDb();
    state = new DatabaseKernelState(db as never, () => 1234);
  });

  it('preserves repeated routing attempts with monotonic sequences and persists native sessions', () => {
    const attempt = {
      requestId: 'kernel:message-1', conversationId: 'conversation-1', componentId: 'hermes' as const,
      role: 'leader' as const, sequence: 1, status: 'failed' as const,
      startedAt: 10, endedAt: 20, error: 'HTTP 401'
    };
    state.record(attempt);
    state.record(attempt);
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM kernel_attempts').get()).toMatchObject({ count: 2 });
    expect(db.raw.prepare('SELECT sequence FROM kernel_attempts ORDER BY sequence').all())
      .toEqual([{ sequence: 1 }, { sequence: 2 }]);

    state.set('conversation-1', 'hermes', 'session-a');
    state.set('conversation-1', 'hermes', 'session-b');
    expect(state.get('conversation-1', 'hermes')).toBe('session-b');
    expect(state.get('conversation-1', 'nexus')).toBeNull();
    state.clear('conversation-1', 'hermes');
    expect(state.get('conversation-1', 'hermes')).toBeNull();
  });

  it('stores one immutable plan per request and commits it idempotently', () => {
    expect(state.savePlan(request(), plan()).status).toBe('planned');
    expect(state.savePlan(request(), plan()).status).toBe('planned');
    expect(() => state.savePlan(request(), plan({ objective: 'A different plan' }))).toThrow('different dispatch plan');

    expect(state.markCommitted('kernel:message-1', 'task-1')).toMatchObject({ status: 'committed', taskId: 'task-1' });
    expect(state.markCommitted('kernel:message-1', 'task-1')).toMatchObject({ status: 'committed', taskId: 'task-1' });
    expect(() => state.markCommitted('kernel:message-1', 'task-2')).toThrow('another task');
  });

  it('does not allow a failed plan to be committed', () => {
    state.savePlan(request(), plan());
    state.markFailed('kernel:message-1', 'no eligible worker');
    expect(state.findPlan('kernel:message-1')).toMatchObject({ status: 'failed', taskId: null });
    expect(() => state.markCommitted('kernel:message-1', 'task-1')).toThrow('failed');
  });
});
