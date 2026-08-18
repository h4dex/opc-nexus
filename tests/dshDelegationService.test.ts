import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import initSqlJs from 'sql.js';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

import { Database } from '../src/main/services/database.js';
import { DshSessionService } from '../src/main/services/dshSessionService.js';
import {
  DshDelegationBoundaryError,
  DshDelegationLimitError,
  DshDelegationService,
  DshDelegationTreeCycleError,
  DshDelegationTreeOrphanError
} from '../src/main/services/dshDelegationService.js';

const require = createRequire(import.meta.url);
let SQL: Awaited<ReturnType<typeof initSqlJs>>;
const openDatabases: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>[] = [];

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
});

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()!.close();
});

function fixture(options: ConstructorParameters<typeof DshDelegationService>[1] = {}) {
  const inner = new SQL.Database();
  openDatabases.push(inner);
  const db = Reflect.construct(Database as unknown as new () => Database, []);
  db.inner = inner;
  db.scheduleSave = () => {};
  (db as unknown as { flush: () => void }).flush = () => {};
  (db as unknown as { migrate: () => void }).migrate();
  inner.exec(`
    INSERT INTO engines(id, type, name) VALUES('eng-dsh-test', 'dsh-managed', 'DSH Test');
    INSERT INTO agents(
      id, organization_id, name, role, engine_id, lifecycle, created_at, updated_at
    ) VALUES('agent-dsh-test', 'org-local', 'DSH Test Agent', 'lead', 'eng-dsh-test', 'READY', 1, 1);
  `);
  const sessionService = new DshSessionService(db, { now: () => 1_000 });
  sessionService.upsertProfile({ id: 'profile-1', engineId: 'eng-dsh-test', version: 1 });
  sessionService.upsertRuntimeInstance({
    id: 'runtime-1', agentId: 'agent-dsh-test', profileId: 'profile-1', processState: 'READY'
  });
  const root = sessionService.upsertSession({
    id: 'session-root', upstreamSessionId: 'up-root', runtimeInstanceId: 'runtime-1',
    agentId: 'agent-dsh-test', controlMode: 'NEXUS_MANAGED'
  });
  const service = new DshDelegationService(db, { sessions: sessionService, ...options });
  return { db, inner, sessionService, service, root };
}

function childInput(parentSessionId: string, id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    upstreamSessionId: `up-${id}`,
    runtimeInstanceId: 'runtime-1',
    agentId: 'agent-dsh-test',
    parentSessionId,
    controlMode: 'DELEGATED' as const,
    ...overrides
  };
}

describe('DshDelegationService', () => {
  it('projects a bounded root tree with run/event status and truncation', async () => {
    const { service, sessionService } = fixture({ maxTreeNodes: 3 });
    const child = service.createChildSession(childInput('session-root', 'session-child'));
    const grandchild = service.createChildSession(childInput(child.sessionId, 'session-grandchild'));
    sessionService.upsertRun({ id: 'run-child', sessionId: child.sessionId, upstreamState: 'RUNNING' });
    sessionService.upsertRun({ id: 'run-grandchild', sessionId: grandchild.sessionId, upstreamState: 'COMPLETED' });
    await sessionService.projectEvent({
      sessionId: grandchild.sessionId, runId: 'run-grandchild', seq: 0,
      type: 'result.completed', payload: { summary: 'done', artifactRef: 'artifact://result-1' }
    });

    const tree = service.getSessionTree('session-root');
    expect(tree.rootSessionId).toBe('session-root');
    expect(tree.sessions.map((entry) => entry.session.sessionId)).toEqual([
      'session-root', 'session-child', 'session-grandchild'
    ]);
    expect(tree.sessions.find((entry) => entry.session.sessionId === 'session-grandchild')).toMatchObject({
      latestRun: { state: 'COMPLETED' }, eventCount: 1, latestEvent: { type: 'result.completed' }, active: false
    });
    expect(tree.edges).toEqual([
      { parentSessionId: 'session-root', childSessionId: 'session-child' },
      { parentSessionId: 'session-child', childSessionId: 'session-grandchild' }
    ]);
    expect(tree.truncated).toBe(false);
    expect(service.getSessionTree('session-root', { maxNodes: 2 }).truncated).toBe(true);
  });

  it('rejects cycles and detached parent rows before exposing a tree', () => {
    const { service, inner } = fixture();
    const child = service.createChildSession(childInput('session-root', 'session-child'));
    inner.exec("UPDATE dsh_sessions SET parent_session_id = 'session-child' WHERE id = 'session-root'");
    expect(() => service.getSessionTree('session-root')).toThrow(DshDelegationTreeCycleError);

    // Restore the cycle, then create an FK-valid tree and deliberately detach
    // the child with foreign keys disabled to model a damaged legacy database.
    inner.exec("UPDATE dsh_sessions SET parent_session_id = NULL, delegation_depth = 0 WHERE id = 'session-root'");
    inner.exec('PRAGMA foreign_keys = OFF');
    inner.exec("UPDATE dsh_sessions SET parent_session_id = 'missing-parent' WHERE id = 'session-child'");
    inner.exec('PRAGMA foreign_keys = ON');
    expect(() => service.getSessionTree('session-root')).toThrow(DshDelegationTreeOrphanError);
    expect(service.getSessionTree('session-root', { allowOrphans: true }).orphanSessionIds).toContain(child.sessionId);
  });

  it('enforces depth, direct concurrency, root total count and cost atomically', () => {
    const { service, sessionService } = fixture({
      limits: { maxDepth: 1, maxConcurrentChildren: 1, maxTotalChildren: 2, maxCost: 5 }
    });
    const first = service.createChildSession(childInput('session-root', 'session-first', { estimatedCost: 3 }));
    sessionService.upsertRun({ id: 'run-first', sessionId: first.sessionId, upstreamState: 'RUNNING' });
    expect(() => service.createChildSession(childInput('session-root', 'session-second', { estimatedCost: 1 })))
      .toThrowError(expect.objectContaining({ kind: 'maxConcurrentChildren' }));

    sessionService.upsertRun({ id: 'run-first-done', sessionId: first.sessionId, upstreamState: 'COMPLETED' });
    expect(() => service.createChildSession(childInput('session-root', 'session-second', { estimatedCost: 3 })))
      .toThrowError(expect.objectContaining({ kind: 'maxCost' }));
    expect(() => service.createChildSession(childInput(first.sessionId, 'session-grandchild')))
      .toThrowError(expect.objectContaining({ kind: 'maxDepth' }));

    const second = service.createChildSession(childInput('session-root', 'session-second', { estimatedCost: 1 }));
    expect(second.delegationDepth).toBe(1);
    expect(() => service.createChildSession(childInput('session-root', 'session-third')))
      .toThrowError(expect.objectContaining({ kind: 'maxTotalChildren' }));
  });

  it('keeps registration inside the parent runtime, employee and organization', () => {
    const { service, inner } = fixture();
    inner.exec(`
      INSERT INTO engines(id, type, name) VALUES('eng-other', 'dsh-managed', 'Other');
      INSERT INTO agents(id, organization_id, name, role, engine_id, lifecycle, created_at, updated_at)
        VALUES('agent-other', 'org-local', 'Other', 'worker', 'eng-other', 'READY', 1, 1);
      INSERT INTO dsh_profiles(id, engine_id, version, created_at, updated_at)
        VALUES('profile-other', 'eng-other', 1, 1, 1);
      INSERT INTO dsh_runtime_instances(id, agent_id, profile_id, process_state, created_at, updated_at)
        VALUES('runtime-other', 'agent-other', 'profile-other', 'READY', 1, 1);
    `);
    expect(() => service.createChildSession(childInput('session-root', 'session-cross-agent', {
      agentId: 'agent-other'
    }))).toThrow(DshDelegationBoundaryError);
    expect(() => service.createChildSession(childInput('session-root', 'session-cross-runtime', {
      runtimeInstanceId: 'runtime-other'
    }))).toThrow(DshDelegationBoundaryError);
  });

  it('cascades deepest children through an injected port and reports timeout without TaskStatus writes', async () => {
    const requests: string[] = [];
    const { service, sessionService, inner } = fixture({
      cancellationPort: {
        requestCancel: async ({ sessionId }) => {
          requests.push(sessionId);
          if (sessionId === 'session-slow') await new Promise((resolve) => setTimeout(resolve, 30));
          return sessionId === 'session-fast' ? { confirmed: true } : undefined;
        }
      }
    });
    const fast = service.createChildSession(childInput('session-root', 'session-fast'));
    const slow = service.createChildSession(childInput('session-root', 'session-slow'));
    sessionService.upsertRun({ id: 'run-fast', sessionId: fast.sessionId, upstreamState: 'RUNNING' });
    sessionService.upsertRun({ id: 'run-slow', sessionId: slow.sessionId, upstreamState: 'RUNNING' });
    const result = await service.cascadeCancel('session-root', { timeoutMs: 5, reason: 'stop now' });
    expect(requests).toEqual(['session-fast', 'session-slow']);
    expect(result.confirmedSessionIds).toEqual(['session-fast']);
    expect(result.timedOutSessionIds).toEqual(['session-slow']);
    expect(result.status).toBe('PARTIAL');
    expect(result.targets.map((target) => target.sessionId)).toEqual(['session-fast', 'session-slow']);
    expect(inner.exec("SELECT status FROM tasks WHERE id = 'missing-task'")).toEqual([]);
  });

  it('waits for each deeper cancellation acknowledgement before requesting its parent', async () => {
    const requests: string[] = [];
    let confirmGrandchild!: () => void;
    let confirmChild!: () => void;
    const { service } = fixture({
      cancellationPort: {
        requestCancel: async ({ sessionId }) => {
          requests.push(sessionId);
          if (sessionId === 'session-grandchild') {
            await new Promise<void>((resolve) => { confirmGrandchild = resolve; });
          }
          if (sessionId === 'session-child') {
            await new Promise<void>((resolve) => { confirmChild = resolve; });
          }
          return { confirmed: true };
        }
      }
    });
    service.createChildSession(childInput('session-root', 'session-child'));
    service.createChildSession(childInput('session-child', 'session-grandchild'));

    const cancellation = service.cascadeCancel('session-root', { includeRoot: true, timeoutMs: 1_000 });
    await vi.waitFor(() => expect(requests).toEqual(['session-grandchild']));

    confirmGrandchild();
    await vi.waitFor(() => expect(requests).toEqual(['session-grandchild', 'session-child']));

    confirmChild();
    await vi.waitFor(() => expect(requests).toEqual(['session-grandchild', 'session-child', 'session-root']));

    await expect(cancellation).resolves.toMatchObject({
      status: 'CONFIRMED',
      requestedSessionIds: ['session-grandchild', 'session-child', 'session-root'],
      confirmedSessionIds: ['session-grandchild', 'session-child', 'session-root']
    });
  });

  it('returns explicit pending status when no cancel adapter is configured', async () => {
    const { service } = fixture();
    service.createChildSession(childInput('session-root', 'session-child'));
    const result = await service.requestCascadeCancellation('session-root', { timeoutMs: 10 });
    expect(result.status).toBe('PENDING');
    expect(result.pendingSessionIds).toEqual(['session-child']);
    expect(result.confirmedSessionIds).toEqual([]);
  });

  it('aggregates bounded summaries and artifact references with redaction', async () => {
    const { service, sessionService } = fixture({ maxSummaryBytes: 2_000 });
    const child = service.createChildSession(childInput('session-root', 'session-child'));
    sessionService.upsertRun({ id: 'run-child', sessionId: child.sessionId, upstreamState: 'COMPLETED' });
    await sessionService.projectEvent({
      sessionId: child.sessionId, runId: 'run-child', seq: 0, type: 'result.completed',
      payload: {
        summary: 'A'.repeat(8_000),
        artifactRef: 'artifact://one',
        nested: { artifact_uri: 'artifact://two', apiKey: 'do-not-leak' }
      }
    });
    const aggregate = service.summarizeChildResults('session-root');
    expect(aggregate.totalChildren).toBe(1);
    expect(aggregate.results[0]).toMatchObject({
      sessionId: 'session-child', runId: 'run-child', status: 'COMPLETED', truncated: true,
      artifactRefs: ['artifact://one', 'artifact://two']
    });
    expect(aggregate.results[0]?.summary).not.toContain('do-not-leak');
    expect(JSON.stringify(aggregate).length).toBeLessThan(8_000);
  });

  it('makes identical child registration idempotent without bypassing identity checks', () => {
    const { service } = fixture();
    const input = childInput('session-root', 'session-child');
    const first = service.createChildSession(input);
    const retry = service.registerChildSession(input);
    expect(retry.sessionId).toBe(first.sessionId);
    expect(() => service.createChildSession({ ...input, upstreamSessionId: 'different-upstream' }))
      .toThrow(DshDelegationBoundaryError);
  });

  it('exposes typed limit errors with current and requested values', () => {
    const { service } = fixture({ limits: { maxDepth: 0 } });
    try {
      service.createChildSession(childInput('session-root', 'session-child'));
      throw new Error('expected limit error');
    } catch (error) {
      expect(error).toBeInstanceOf(DshDelegationLimitError);
      expect(error).toMatchObject({ kind: 'maxDepth', limit: 0, current: 0, requested: 1 });
    }
  });
});
