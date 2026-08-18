import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import initSqlJs from 'sql.js';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

import { Database } from '../src/main/services/database.js';
import type { DshControlPort, DshSessionEvent, DshSessionSummary } from '../src/main/services/dshControlClient.js';
import { DshDelegationService } from '../src/main/services/dshDelegationService.js';
import { DshDelegationSyncService } from '../src/main/services/dshDelegationSyncService.js';
import { DshSessionService } from '../src/main/services/dshSessionService.js';

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
    INSERT INTO engines(id, type, name) VALUES('eng-dsh-sync', 'dsh-managed', 'DSH Sync');
    INSERT INTO agents(
      id, organization_id, name, role, engine_id, lifecycle, created_at, updated_at
    ) VALUES('agent-dsh-sync', 'org-local', 'DSH Sync Agent', 'lead', 'eng-dsh-sync', 'READY', 1, 1);
  `);
  const sessions = new DshSessionService(db, { now: () => 1_000 });
  sessions.upsertProfile({ id: 'profile-sync', engineId: 'eng-dsh-sync', version: 1 });
  sessions.upsertRuntimeInstance({
    id: 'runtime-sync', agentId: 'agent-dsh-sync', profileId: 'profile-sync', processState: 'READY'
  });
  const root = sessions.upsertSession({
    id: 'local-root', upstreamSessionId: 'up-root', runtimeInstanceId: 'runtime-sync',
    agentId: 'agent-dsh-sync', controlMode: 'NEXUS_MANAGED', workspace: 'E:/workspace'
  });
  const delegation = new DshDelegationService(db, { sessions, ...options });
  const sync = new DshDelegationSyncService(sessions, delegation);
  return { db, inner, sessions, delegation, sync, root };
}

function summary(sessionId: string, overrides: Partial<DshSessionSummary> = {}): DshSessionSummary {
  return { sessionId, updatedAt: 1_000, running: true, blank: false, ...overrides };
}

function fakePort(
  summaries: DshSessionSummary[],
  eventsBySession: Record<string, DshSessionEvent[]> = {}
): DshControlPort {
  return {
    listSessions: vi.fn(async () => summaries),
    readHistory: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      events: (eventsBySession[sessionId] ?? []).map((event) => ({ event })),
      hasMore: false
    })),
    createSession: vi.fn(),
    prompt: vi.fn(),
    cancel: vi.fn(),
    observeMux: vi.fn()
  } as unknown as DshControlPort;
}

describe('DshDelegationSyncService', () => {
  it('registers child summaries in parent-first order and never creates employee rows', () => {
    const { sync, delegation, inner } = fixture();
    const result = sync.syncSummaries({
      agentId: 'agent-dsh-sync', runtimeInstanceId: 'runtime-sync', rootSessionId: 'local-root',
      summaries: [
        summary('up-grandchild', { parentSessionId: 'up-child' }),
        summary('up-root', { running: false }),
        summary('up-child', { parentSessionId: 'up-root', cwd: 'E:/child' })
      ]
    });

    expect(result.registeredSessionIds).toHaveLength(2);
    expect(result.orphanSessionIds).toEqual([]);
    expect(result.skippedSessionIds).toEqual(['up-root']);
    const tree = delegation.getSessionTree('local-root');
    expect(tree.edges).toHaveLength(2);
    expect(tree.edges[0]?.parentSessionId).toBe('local-root');
    expect(tree.edges[1]?.parentSessionId).toBe(tree.edges[0]?.childSessionId);
    expect(tree.sessions.find((entry) => entry.session.sessionId === tree.edges[0]?.childSessionId)?.session.workspace)
      .toBe('E:/workspace');
    expect(inner.exec("SELECT COUNT(*) AS count FROM agents WHERE id LIKE 'dsh-child-%'")[0]?.values[0]?.[0]).toBe(0);

    const retry = sync.syncSummaries({
      agentId: 'agent-dsh-sync', runtimeInstanceId: 'runtime-sync', rootSessionId: 'local-root',
      summaries: [summary('up-child', { parentSessionId: 'up-root' })]
    });
    expect(retry.registeredSessionIds).toEqual([]);
    expect(retry.existingSessionIds).toHaveLength(1);
  });

  it('fails closed for missing and cross-runtime parents', () => {
    const { sync, sessions } = fixture();
    const result = sync.syncSummaries({
      agentId: 'agent-dsh-sync', runtimeInstanceId: 'runtime-sync', rootSessionId: 'local-root',
      summaries: [summary('up-orphan', { parentSessionId: 'up-missing' })]
    });
    expect(result.orphanSessionIds).toEqual(['up-orphan']);
    expect(result.registeredSessionIds).toEqual([]);

    sessions.upsertProfile({ id: 'profile-other', engineId: 'eng-dsh-sync', version: 1 });
    sessions.upsertRuntimeInstance({ id: 'runtime-other', agentId: 'agent-dsh-sync', profileId: 'profile-other', processState: 'READY' });
    sessions.upsertSession({
      id: 'other-root', upstreamSessionId: 'up-other-root', runtimeInstanceId: 'runtime-other',
      agentId: 'agent-dsh-sync', controlMode: 'NEXUS_MANAGED'
    });
    const cross = sync.syncSummaries({
      agentId: 'agent-dsh-sync', runtimeInstanceId: 'runtime-sync', rootSessionId: 'local-root',
      summaries: [summary('up-cross-child', { parentSessionId: 'up-other-root' })]
    });
    expect(cross.orphanSessionIds).toEqual(['up-cross-child']);
    expect(cross.rejected.some((issue) => issue.reason === 'parent-runtime-boundary')).toBe(true);
  });

  it('does not accept an upstream cwd or non-delegated control mode as authority', () => {
    const { sync } = fixture();
    const cwdResult = sync.syncSummaries({
      agentId: 'agent-dsh-sync', runtimeInstanceId: 'runtime-sync', rootSessionId: 'local-root',
      summaries: [summary('up-child', { parentSessionId: 'up-root', cwd: 'C:/outside' })]
    });
    const childId = cwdResult.registeredSessionIds[0]!;
    expect(childId).toBeTruthy();

    const modeResult = sync.syncSummaries({
      agentId: 'agent-dsh-sync', runtimeInstanceId: 'runtime-sync', rootSessionId: 'local-root',
      controlMode: 'NEXUS_MANAGED',
      summaries: [summary('up-other-child', { parentSessionId: 'up-root' })]
    });
    expect(modeResult.registeredSessionIds).toEqual([]);
    expect(modeResult.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ upstreamSessionId: 'up-other-child', reason: 'child-control-mode' })
    ]));
  });

  it('projects child history idempotently and derives terminal result state', async () => {
    const { sync, delegation, sessions } = fixture();
    const childSummary = summary('up-child', { parentSessionId: 'up-root', running: true });
    const registration = sync.syncSummaries({
      agentId: 'agent-dsh-sync', runtimeInstanceId: 'runtime-sync', rootSessionId: 'local-root',
      summaries: [childSummary]
    });
    const childId = registration.registeredSessionIds[0]!;
    const events: DshSessionEvent[] = [
      { type: 'user/message', seq: 0, time: 10, data: { content: [{ type: 'text', text: 'work' }] } },
      { type: 'assistant/message', seq: 1, time: 11, data: { message: { content: [{ type: 'text', text: 'done' }] } } },
      { type: 'turn/end', seq: 2, time: 12, data: { reason: { kind: 'completed' } } }
    ];
    const first = await sync.projectHistory({
      agentId: 'agent-dsh-sync', runtimeInstanceId: 'runtime-sync', client: fakePort([], { 'up-child': events }),
      sessionIds: [childId]
    });
    expect(first.projectedEventCount).toBe(3);
    expect(first.terminalSessionIds).toEqual([childId]);
    expect(first.errors).toEqual([]);
    expect(delegation.getSessionTree('local-root').sessions.find((entry) => entry.session.sessionId === childId))
      .toMatchObject({ active: false, latestRun: { state: 'COMPLETED', eventCursor: 2 }, eventCount: 3 });

    const second = await sync.projectHistory({
      agentId: 'agent-dsh-sync', runtimeInstanceId: 'runtime-sync', client: fakePort([], { 'up-child': events }),
      sessionIds: [childId]
    });
    expect(second.projectedEventCount).toBe(0);

    // A later inventory refresh with an empty history page must not erase a
    // durable terminal failure that was already projected for this child.
    const runId = delegation.getSessionTree('local-root').sessions
      .find((entry) => entry.session.sessionId === childId)?.latestRun?.id;
    expect(runId).toBeTruthy();
    // The service uses a deterministic run id; mutate that durable fact to
    // model a failure observed by another adapter before the next refresh.
    if (runId) sessions.upsertRun({ id: runId, sessionId: childId, upstreamState: 'FAILED' });
    const preserved = await sync.projectHistory({
      agentId: 'agent-dsh-sync', runtimeInstanceId: 'runtime-sync', client: fakePort([], { 'up-child': [] }),
      sessionIds: [childId]
    });
    expect(preserved.errors).toEqual([]);
    expect(sessions.getRun(runId!).upstreamState).toBe('FAILED');
  });

  it('syncRuntime uses the bounded list/history control surface', async () => {
    const { sync } = fixture();
    const client = fakePort([
      summary('up-root'),
      summary('up-child', { parentSessionId: 'up-root', running: false })
    ]);
    const result = await sync.syncRuntime({
      agentId: 'agent-dsh-sync', runtimeInstanceId: 'runtime-sync', rootSessionId: 'local-root', client
    });
    expect(client.listSessions).toHaveBeenCalledTimes(1);
    expect(client.readHistory).toHaveBeenCalledTimes(1);
    expect(result.registeredSessionIds).toHaveLength(1);
    expect(result.history?.projectedSessionIds).toHaveLength(1);
  });

  it('restores the child tree and event cursor after reopening the database', async () => {
    const { inner, sync } = fixture();
    const registration = sync.syncSummaries({
      agentId: 'agent-dsh-sync', runtimeInstanceId: 'runtime-sync', rootSessionId: 'local-root',
      summaries: [
        summary('up-grandchild', { parentSessionId: 'up-child' }),
        summary('up-child', { parentSessionId: 'up-root' })
      ]
    });
    expect(registration.registeredSessionIds).toHaveLength(2);
    const childId = registration.registeredSessionIds.find((sessionId) => {
      const rows = inner.exec(`SELECT upstream_session_id FROM dsh_sessions WHERE id = '${sessionId}'`);
      return rows[0]?.values[0]?.[0] === 'up-child';
    });
    expect(childId).toBeTruthy();

    const initialEvents: DshSessionEvent[] = [
      { type: 'user/message', seq: 0, time: 10, data: { content: [{ type: 'text', text: 'start' }] } },
      { type: 'assistant/message', seq: 1, time: 11, data: { message: { content: [{ type: 'text', text: 'working' }] } } }
    ];
    const firstProjection = await sync.projectHistory({
      agentId: 'agent-dsh-sync', runtimeInstanceId: 'runtime-sync',
      client: fakePort([], { 'up-child': initialEvents }), sessionIds: [childId!]
    });
    expect(firstProjection.projectedEventCount).toBe(2);

    const reopenedInner = new SQL.Database(inner.export());
    openDatabases.push(reopenedInner);
    const reopenedDb = Reflect.construct(Database as unknown as new () => Database, []);
    reopenedDb.inner = reopenedInner;
    reopenedDb.scheduleSave = () => {};
    (reopenedDb as unknown as { flush: () => void }).flush = () => {};
    (reopenedDb as unknown as { migrate: () => void }).migrate();
    const reopenedSessions = new DshSessionService(reopenedDb, { now: () => 2_000 });
    const reopenedDelegation = new DshDelegationService(reopenedDb, { sessions: reopenedSessions });
    const reopenedSync = new DshDelegationSyncService(reopenedSessions, reopenedDelegation);

    const restoredTree = reopenedDelegation.getSessionTree('local-root');
    expect(restoredTree.edges).toHaveLength(2);
    expect(restoredTree.sessions.find((entry) => entry.session.sessionId === childId))
      .toMatchObject({ eventCount: 2, latestRun: { eventCursor: 1 } });

    const completedEvents: DshSessionEvent[] = [
      ...initialEvents,
      { type: 'turn/end', seq: 2, time: 12, data: { reason: { kind: 'completed' } } }
    ];
    const resumedProjection = await reopenedSync.projectHistory({
      agentId: 'agent-dsh-sync', runtimeInstanceId: 'runtime-sync',
      client: fakePort([], { 'up-child': completedEvents }), sessionIds: [childId!]
    });
    expect(resumedProjection.projectedEventCount).toBe(1);
    expect(resumedProjection.terminalSessionIds).toEqual([childId]);
    expect(reopenedDelegation.getSessionTree('local-root').sessions.find((entry) => entry.session.sessionId === childId))
      .toMatchObject({ active: false, eventCount: 3, latestRun: { state: 'COMPLETED', eventCursor: 2 } });
  });

  it('reports a deleted history target without dereferencing an unavailable session', async () => {
    const { sync } = fixture();
    const result = await sync.projectHistory({
      agentId: 'agent-dsh-sync', runtimeInstanceId: 'runtime-sync', client: fakePort([]),
      sessionIds: ['missing-local-child']
    });
    expect(result.projectedEventCount).toBe(0);
    expect(result.errors).toEqual([
      expect.objectContaining({ sessionId: 'missing-local-child', reason: 'invalid-history-target' })
    ]);
  });
});
