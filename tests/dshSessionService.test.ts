import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import initSqlJs from 'sql.js';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

import { Database } from '../src/main/services/database.js';
import {
  DshCommandConflictError,
  DshEventCursorError,
  DshRevisionConflictError,
  DshSessionService,
  DshTakeoverConfirmationRequiredError
} from '../src/main/services/dshSessionService.js';

const require = createRequire(import.meta.url);
let SQL: Awaited<ReturnType<typeof initSqlJs>>;
const openDatabases: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>[] = [];

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
});

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()!.close();
});

function migratedDatabase(): { db: Database; inner: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']> } {
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
    ) VALUES(
      'agent-dsh-test', 'org-local', 'DSH Test Agent', 'lead', 'eng-dsh-test', 'READY', 1, 1
    );
  `);
  return { db, inner };
}

function serviceFixture(options: ConstructorParameters<typeof DshSessionService>[1] = {}) {
  const { db, inner } = migratedDatabase();
  let now = 10_000;
  const service = new DshSessionService(db, { now: () => now, ...options });
  service.upsertProfile({ id: 'profile-1', engineId: 'eng-dsh-test', version: 1 });
  service.upsertRuntimeInstance({
    id: 'runtime-1', agentId: 'agent-dsh-test', profileId: 'profile-1', processState: 'READY',
    endpoint: 'http://127.0.0.1:3080/', protocolVersion: 'opc-dsh/1'
  });
  const createSession = (controlMode: 'STANDALONE' | 'NEXUS_MANAGED' = 'STANDALONE') => service.upsertSession({
    id: 'session-1', upstreamSessionId: 'upstream-1', runtimeInstanceId: 'runtime-1',
    agentId: 'agent-dsh-test', workspace: 'E:/workspace', controlMode
  });
  return { db, inner, service, createSession, advance: (milliseconds: number) => { now += milliseconds; } };
}

describe('DshSessionService durable control plane', () => {
  it('migrates all durable DSH tables as schema v44', () => {
    const { inner } = migratedDatabase();
    const version = inner.exec("SELECT value FROM schema_meta WHERE key = 'schema_version'")[0].values[0][0];
    expect(version).toBe('44');
    const tables = inner.exec(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'dsh_%' ORDER BY name
    `)[0].values.map(([name]) => name);
    expect(tables).toEqual([
      'dsh_command_receipts',
      'dsh_control_leases',
      'dsh_events',
      'dsh_profiles',
      'dsh_runs',
      'dsh_runtime_instances',
      'dsh_sessions'
    ]);
    expect(inner.exec('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('starts a new rc.6 stream at seq=0 and exposes an empty cursor as -1', async () => {
    const { service, inner } = serviceFixture();
    const session = service.upsertSession({
      id: 'session-1', upstreamSessionId: 'upstream-1', runtimeInstanceId: 'runtime-1',
      agentId: 'agent-dsh-test', controlMode: 'STANDALONE'
    });
    const run = service.upsertRun({ id: 'run-1', sessionId: 'session-1', upstreamState: 'RUNNING' });
    expect(session.lastEventCursor).toBe(-1);
    expect(run.eventCursor).toBe(-1);
    await service.projectEvent({ sessionId: 'session-1', runId: 'run-1', seq: 0, type: 'turn/start', payload: {} });
    expect(service.getSession('session-1').lastEventCursor).toBe(0);
    expect(service.getRun('run-1').eventCursor).toBe(0);
    expect(service.readEvents({ sessionId: 'session-1', afterCursor: -1 }).events[0]?.seq).toBe(0);
    expect(inner.exec("SELECT seq FROM dsh_events WHERE session_id='session-1'")[0].values[0][0]).toBe(0);
  });

  it('rebuilds v40 cursor tables without losing rows during the v41 migration', () => {
    const inner = new SQL.Database();
    openDatabases.push(inner);
    inner.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta(key, value) VALUES ('schema_version', '40');
      CREATE TABLE dsh_profiles (
        id TEXT PRIMARY KEY, engine_id TEXT NOT NULL, provider_profile TEXT NOT NULL DEFAULT '',
        policy_json TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE dsh_runtime_instances (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, profile_id TEXT NOT NULL,
        process_state TEXT NOT NULL DEFAULT 'STOPPED', endpoint TEXT,
        protocol_version TEXT NOT NULL DEFAULT '', capabilities_json TEXT NOT NULL DEFAULT '{}',
        heartbeat_at INTEGER, crash_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE dsh_sessions (
        id TEXT PRIMARY KEY, upstream_session_id TEXT NOT NULL, runtime_instance_id TEXT NOT NULL,
        agent_id TEXT NOT NULL, conversation_id TEXT, parent_session_id TEXT,
        delegation_depth INTEGER NOT NULL DEFAULT 0, workspace TEXT NOT NULL DEFAULT '',
        control_mode TEXT NOT NULL DEFAULT 'STANDALONE', revision INTEGER NOT NULL DEFAULT 0,
        last_event_cursor INTEGER NOT NULL DEFAULT 0 CHECK(last_event_cursor >= 0),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(runtime_instance_id, upstream_session_id)
      );
      CREATE TABLE dsh_runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, nexus_task_id TEXT, team_run_id TEXT,
        dag_node_id TEXT, command_id TEXT UNIQUE, upstream_state TEXT NOT NULL DEFAULT 'QUEUED',
        event_cursor INTEGER NOT NULL DEFAULT 0 CHECK(event_cursor >= 0), checkpoint_ref TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE dsh_events (
        session_id TEXT NOT NULL, seq INTEGER NOT NULL CHECK(seq > 0), run_id TEXT,
        type TEXT NOT NULL, protocol_version TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, seq)
      );
    `);
    const db = Reflect.construct(Database as unknown as new () => Database, []);
    db.inner = inner;
    db.scheduleSave = () => {};
    (db as unknown as { flush: () => void }).flush = () => {};
    (db as unknown as { migrate: () => void }).migrate();
    expect(inner.exec("SELECT value FROM schema_meta WHERE key='schema_version'")[0].values[0][0]).toBe('44');
    const sessionSql = String(inner.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='dsh_sessions'")[0].values[0][0]);
    const eventSql = String(inner.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='dsh_events'")[0].values[0][0]);
    expect(sessionSql).toContain('last_event_cursor INTEGER NOT NULL DEFAULT -1');
    expect(eventSql).toContain('seq INTEGER NOT NULL CHECK(seq >= 0)');
    expect(inner.exec('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('upserts durable session/run identity without resetting cursors or revisions', async () => {
    const { service } = serviceFixture();
    service.upsertSession({
      id: 'session-1', upstreamSessionId: 'upstream-1', runtimeInstanceId: 'runtime-1',
      agentId: 'agent-dsh-test', workspace: 'E:/first', controlMode: 'STANDALONE'
    });
    service.upsertRun({ id: 'run-1', sessionId: 'session-1', upstreamState: 'RUNNING' });
    await service.projectEvent({ sessionId: 'session-1', runId: 'run-1', seq: 1, type: 'turn.started', payload: {} });
    const lease = service.acquireLease({
      sessionId: 'session-1', controller: 'HUMAN', surface: 'DESKTOP', principal: 'owner', expectedRevision: 0
    });

    const session = service.upsertSession({
      id: 'session-1', upstreamSessionId: 'upstream-1', runtimeInstanceId: 'runtime-1',
      agentId: 'agent-dsh-test', workspace: 'E:/updated', controlMode: 'NEXUS_MANAGED'
    });
    const run = service.upsertRun({ id: 'run-1', sessionId: 'session-1', upstreamState: 'PAUSED', checkpointRef: 'sha256:checkpoint' });

    expect(session).toMatchObject({ workspace: 'E:/updated', revision: 1, lastEventCursor: 1, controlMode: 'STANDALONE' });
    expect(session.lease).toMatchObject({ principal: 'owner' });
    expect(run).toMatchObject({ upstreamState: 'PAUSED', eventCursor: 1, checkpointRef: 'sha256:checkpoint' });
    expect(lease.token).not.toBe('');
    expect(() => service.upsertSession({
      id: 'session-1', upstreamSessionId: 'different', runtimeInstanceId: 'runtime-1',
      agentId: 'agent-dsh-test', controlMode: 'STANDALONE'
    })).toThrow('immutable');
  });

  it('rejects runtime, organization and parent-session ownership mismatches', () => {
    const { service, inner } = serviceFixture();
    inner.exec(`
      INSERT INTO engines(id, type, name) VALUES('eng-other', 'dsh-managed', 'Other DSH');
      INSERT INTO agents(
        id, organization_id, name, role, engine_id, lifecycle, created_at, updated_at
      ) VALUES(
        'agent-other', 'org-local', 'Other Agent', 'lead', 'eng-other', 'READY', 1, 1
      );
      INSERT INTO organizations(id, slug, name, created_at, updated_at)
      VALUES('org-other', 'other', 'Other', 1, 1);
      INSERT INTO agents(
        id, organization_id, name, role, engine_id, lifecycle, created_at, updated_at
      ) VALUES(
        'agent-other-org', 'org-other', 'Other Org Agent', 'lead', 'eng-dsh-test', 'READY', 1, 1
      );
      INSERT INTO conversations(
        id, organization_id, agent_id, title, last_message_at, message_count, created_at, updated_at
      ) VALUES(
        'conversation-other', 'org-other', 'agent-other-org', 'Other', 1, 0, 1, 1
      );
    `);

    service.upsertProfile({ id: 'profile-other', engineId: 'eng-other', version: 1 });
    expect(() => service.upsertRuntimeInstance({
      id: 'runtime-mismatched-engine', agentId: 'agent-dsh-test', profileId: 'profile-other', processState: 'READY'
    })).toThrow('same engine');

    expect(() => service.upsertSession({
      id: 'session-wrong-runtime-owner', upstreamSessionId: 'upstream-wrong-owner', runtimeInstanceId: 'runtime-1',
      agentId: 'agent-other', controlMode: 'STANDALONE'
    })).toThrow('another employee');
    expect(() => service.upsertSession({
      id: 'session-cross-org', upstreamSessionId: 'upstream-cross-org', runtimeInstanceId: 'runtime-1',
      agentId: 'agent-dsh-test', conversationId: 'conversation-other', controlMode: 'STANDALONE'
    })).toThrow('organization boundary');

    service.upsertSession({
      id: 'session-parent', upstreamSessionId: 'upstream-parent', runtimeInstanceId: 'runtime-1',
      agentId: 'agent-dsh-test', controlMode: 'NEXUS_MANAGED'
    });
    expect(() => service.upsertSession({
      id: 'session-invalid-depth', upstreamSessionId: 'upstream-invalid-depth', runtimeInstanceId: 'runtime-1',
      agentId: 'agent-dsh-test', parentSessionId: 'session-parent', delegationDepth: 2, controlMode: 'DELEGATED'
    })).toThrow('parent depth plus one');
    const child = service.upsertSession({
      id: 'session-child', upstreamSessionId: 'upstream-child', runtimeInstanceId: 'runtime-1',
      agentId: 'agent-dsh-test', parentSessionId: 'session-parent', delegationDepth: 1, controlMode: 'DELEGATED'
    });
    expect(child).toMatchObject({ parentSessionId: 'session-parent', delegationDepth: 1 });
    expect(() => service.upsertSession({
      id: 'session-child', upstreamSessionId: 'upstream-child', runtimeInstanceId: 'runtime-1',
      agentId: 'agent-dsh-test', delegationDepth: 0, controlMode: 'DELEGATED'
    })).toThrow('immutable');
  });

  it('persists strict event cursors before projection, deduplicates retries and rejects gaps/reuse', async () => {
    const projected = vi.fn();
    const projectionErrors = vi.fn();
    const { service, inner } = serviceFixture({ onEventProjected: projected, onProjectionError: projectionErrors });
    service.upsertSession({
      id: 'session-1', upstreamSessionId: 'upstream-1', runtimeInstanceId: 'runtime-1',
      agentId: 'agent-dsh-test', controlMode: 'STANDALONE'
    });
    service.upsertRun({ id: 'run-1', sessionId: 'session-1', upstreamState: 'RUNNING' });

    const first = await service.projectEvent({
      sessionId: 'session-1', runId: 'run-1', seq: 1, type: 'turn.delta',
      protocolVersion: 'opc-dsh/1', payload: { b: 2, a: 1 }
    });
    const retry = await service.projectEvent({
      sessionId: 'session-1', runId: 'run-1', seq: 1, type: 'turn.delta',
      protocolVersion: 'opc-dsh/1', payload: { a: 1, b: 2 }, createdAt: 99_999
    });
    expect(first.duplicate).toBe(false);
    expect(retry.duplicate).toBe(true);
    expect(projected).toHaveBeenCalledTimes(1);
    await expect(service.projectEvent({
      sessionId: 'session-1', runId: 'run-1', seq: 3, type: 'gap', payload: {}
    })).rejects.toBeInstanceOf(DshEventCursorError);
    await expect(service.projectEvent({
      sessionId: 'session-1', runId: 'run-1', seq: 1, type: 'changed', payload: { a: 1, b: 2 }
    })).rejects.toThrow('different content');

    await service.projectEvent({
      sessionId: 'session-1', runId: 'run-1', seq: 2, type: 'future.unknown',
      payload: {
        apiKey: 'secret-value',
        nested: { password: 'hidden', useful: 'visible' },
        message: 'request used Bearer abcdefghijklmnop'
      }
    });
    const page = service.readEvents({ sessionId: 'session-1', afterCursor: 1, limit: 10 });
    expect(page.nextCursor).toBe(2);
    expect(page.events[0]).toMatchObject({ type: 'future.unknown', payload: {
      apiKey: '[REDACTED]',
      nested: { password: '[REDACTED]', useful: 'visible' },
      message: 'request used Bearer [REDACTED]'
    } });
    expect(inner.exec("SELECT payload_json FROM dsh_events WHERE session_id='session-1' AND seq=2")[0].values[0][0])
      .toContain('secret-value');
    expect(service.getSession('session-1').lastEventCursor).toBe(2);
    expect(service.getRun('run-1').eventCursor).toBe(2);
    expect(projectionErrors).not.toHaveBeenCalled();
  });

  it('replays immutable session history for a later run without changing event ownership', async () => {
    const { service, inner } = serviceFixture();
    service.upsertSession({
      id: 'session-1', upstreamSessionId: 'upstream-1', runtimeInstanceId: 'runtime-1',
      agentId: 'agent-dsh-test', controlMode: 'STANDALONE'
    });
    service.upsertRun({ id: 'run-1', sessionId: 'session-1', upstreamState: 'COMPLETED' });
    await service.projectEvent({
      sessionId: 'session-1', runId: 'run-1', seq: 0, type: 'turn/start', payload: { turn: 0 }
    });
    service.upsertRun({ id: 'run-2', sessionId: 'session-1', upstreamState: 'RUNNING' });

    const replay = await service.projectEvent({
      sessionId: 'session-1', runId: 'run-2', seq: 0, type: 'turn/start', payload: { turn: 0 }
    });

    expect(replay.duplicate).toBe(true);
    expect(service.getRun('run-2').eventCursor).toBe(0);
    expect(inner.exec("SELECT run_id FROM dsh_events WHERE session_id='session-1' AND seq=0")[0].values[0][0]).toBe('run-1');
  });

  it('keeps a committed event when the explicit Orchestrator projection callback fails', async () => {
    const projectionError = vi.fn();
    const { service, inner } = serviceFixture({
      onEventProjected: () => { throw new Error('projection unavailable'); },
      onProjectionError: projectionError
    });
    service.upsertSession({
      id: 'session-1', upstreamSessionId: 'upstream-1', runtimeInstanceId: 'runtime-1',
      agentId: 'agent-dsh-test', controlMode: 'STANDALONE'
    });
    const result = await service.projectEvent({ sessionId: 'session-1', seq: 1, type: 'run.completed', payload: {} });
    expect(result.projectionError).toBe(true);
    expect(projectionError).toHaveBeenCalledOnce();
    expect(inner.exec("SELECT COUNT(*) FROM dsh_events WHERE session_id='session-1'")[0].values[0][0]).toBe(1);
  });

  it('uses revision CAS so concurrent lease requests cannot create two writers', () => {
    const { service, inner } = serviceFixture();
    service.upsertSession({
      id: 'session-1', upstreamSessionId: 'upstream-1', runtimeInstanceId: 'runtime-1',
      agentId: 'agent-dsh-test', controlMode: 'STANDALONE'
    });
    const first = service.acquireLease({
      sessionId: 'session-1', controller: 'HUMAN', surface: 'DESKTOP', principal: 'owner-a', expectedRevision: 0
    });
    expect(() => service.acquireLease({
      sessionId: 'session-1', controller: 'NEXUS', surface: 'INTERNAL', principal: 'secretary', expectedRevision: 0
    })).toThrow(DshRevisionConflictError);
    expect(() => service.acquireLease({
      sessionId: 'session-1', controller: 'NEXUS', surface: 'INTERNAL', principal: 'secretary', expectedRevision: 1
    })).toThrow(/controlled by HUMAN/);
    const persistedHash = inner.exec("SELECT token_hash FROM dsh_control_leases WHERE session_id='session-1'")[0].values[0][0];
    expect(persistedHash).not.toBe(first.token);
    expect(String(persistedHash)).toHaveLength(64);

    expect(() => service.renewLease({ sessionId: 'session-1', token: first.token, expectedRevision: 0 }))
      .toThrow(DshRevisionConflictError);
    const renewed = service.renewLease({ sessionId: 'session-1', token: first.token, expectedRevision: 1 });
    expect(renewed.status.revision).toBe(2);
    expect(() => service.releaseLease({ sessionId: 'session-1', token: 'wrong-token', expectedRevision: 2 }))
      .toThrow('invalid');
    expect(service.releaseLease({ sessionId: 'session-1', token: first.token, expectedRevision: 2 }))
      .toMatchObject({ revision: 3, lease: null, controlMode: 'STANDALONE' });
  });

  it('expires short leases durably and restores the pre-takeover control mode', async () => {
    const { service, advance, inner } = serviceFixture({ authorizeTakeover: () => true });
    service.upsertSession({
      id: 'session-1', upstreamSessionId: 'upstream-1', runtimeInstanceId: 'runtime-1',
      agentId: 'agent-dsh-test', controlMode: 'NEXUS_MANAGED'
    });
    const takeover = await service.takeoverLease({
      sessionId: 'session-1', controller: 'HUMAN', surface: 'DESKTOP', principal: 'owner',
      expectedRevision: 0, ttlMs: 5_000
    });
    expect(takeover.status).toMatchObject({ revision: 1, controlMode: 'TAKEOVER' });
    advance(5_001);
    expect(service.getControlStatus('session-1')).toMatchObject({
      revision: 2, controlMode: 'NEXUS_MANAGED', lease: null
    });
    expect(inner.exec("SELECT COUNT(*) FROM audit_logs WHERE action='dsh.control.expire'")[0].values[0][0]).toBe(1);
    expect(inner.exec("SELECT COUNT(*) FROM audit_logs WHERE action='dsh.control.release'")[0].values[0][0]).toBe(0);
  });

  it('requires a trusted turn-boundary gate and lets only one concurrent takeover win', async () => {
    const base = serviceFixture();
    base.createSession('NEXUS_MANAGED');
    base.service.acquireLease({
      sessionId: 'session-1', controller: 'NEXUS', surface: 'INTERNAL', principal: 'secretary', expectedRevision: 0
    });
    await expect(base.service.takeoverLease({
      sessionId: 'session-1', controller: 'HUMAN', surface: 'DESKTOP', principal: 'owner', expectedRevision: 1
    })).rejects.toBeInstanceOf(DshTakeoverConfirmationRequiredError);

    let releaseGate!: (allowed: boolean) => void;
    const gate = new Promise<boolean>((resolve) => { releaseGate = resolve; });
    const service = new DshSessionService(base.db, { now: () => 10_000, authorizeTakeover: () => gate });
    const request = {
      sessionId: 'session-1', controller: 'HUMAN' as const, surface: 'DESKTOP' as const,
      principal: 'owner', expectedRevision: 1, reason: 'owner requested control'
    };
    const attempts = [service.takeoverLease(request), service.takeoverLease(request)];
    releaseGate(true);
    const settled = await Promise.allSettled(attempts);
    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((item) => item.status === 'rejected')).toHaveLength(1);
    expect((settled.find((item) => item.status === 'rejected') as PromiseRejectedResult).reason)
      .toBeInstanceOf(DshRevisionConflictError);
    const status = service.getControlStatus('session-1');
    expect(status).toMatchObject({ revision: 2, controlMode: 'TAKEOVER', lease: {
      controller: 'HUMAN', surface: 'DESKTOP', principal: 'owner', revision: 2
    } });
    expect(service.releaseLeaseForPrincipal({
      ...request, expectedRevision: 2
    })).toMatchObject({ revision: 3, controlMode: 'NEXUS_MANAGED', lease: null });
  });

  it('deduplicates command receipts before checking the now-stale expected revision', () => {
    const { service, inner } = serviceFixture();
    service.upsertSession({
      id: 'session-1', upstreamSessionId: 'upstream-1', runtimeInstanceId: 'runtime-1',
      agentId: 'agent-dsh-test', controlMode: 'NEXUS_MANAGED'
    });
    service.upsertRun({ id: 'run-1', sessionId: 'session-1', upstreamState: 'RUNNING' });
    const lease = service.acquireLease({
      sessionId: 'session-1', controller: 'NEXUS', surface: 'INTERNAL', principal: 'secretary', expectedRevision: 0
    });
    const command = {
      commandId: 'command-1', sessionId: 'session-1', runId: 'run-1', commandType: 'question.answer',
      principal: 'secretary', leaseToken: lease.token, expectedRevision: 1, payload: { answer: 'A', detail: { x: 1 } }
    };
    const first = service.claimCommand(command);
    const retry = service.claimCommand({ ...command, payload: { detail: { x: 1 }, answer: 'A' } });
    expect(first).toMatchObject({ duplicate: false, receipt: { status: 'ACCEPTED', appliedRevision: 2 } });
    expect(retry).toMatchObject({ duplicate: true, receipt: { commandId: 'command-1', appliedRevision: 2 } });
    expect(inner.exec("SELECT COUNT(*) FROM dsh_command_receipts WHERE command_id='command-1'")[0].values[0][0]).toBe(1);
    expect(() => service.claimCommand({ ...command, payload: { answer: 'B' } }))
      .toThrow(DshCommandConflictError);
    expect(() => service.claimCommand({ ...command, commandId: 'command-2' }))
      .toThrow(/unresolved command receipt/);

    expect(service.completeCommand('command-1', { ok: true })).toMatchObject({ status: 'COMPLETED', result: { ok: true } });
    expect(service.completeCommand('command-1', { ok: true })).toMatchObject({ status: 'COMPLETED' });
    expect(() => service.completeCommand('command-1', { ok: false })).toThrow(DshCommandConflictError);
    const second = service.claimCommand({ ...command, commandId: 'command-2', expectedRevision: 2 });
    expect(second).toMatchObject({ duplicate: false, receipt: { status: 'ACCEPTED', appliedRevision: 3 } });
    expect(service.failCommand('command-2', 'explicit upstream rejection')).toMatchObject({ status: 'FAILED' });
    const third = service.claimCommand({ ...command, commandId: 'command-3', expectedRevision: 3 });
    expect(third).toMatchObject({ duplicate: false, receipt: { status: 'ACCEPTED', appliedRevision: 4 } });
    expect(inner.exec("SELECT COUNT(*) FROM audit_logs WHERE action='dsh.command.accept'")[0].values[0][0]).toBe(3);
  });
});
