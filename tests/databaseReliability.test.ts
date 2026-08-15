import { beforeAll, describe, expect, it, vi } from 'vitest';
import initSqlJs from 'sql.js';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

import { Database } from '../src/main/services/database.js';
import { seedIfEmpty } from '../src/main/services/seed.js';

const require = createRequire(import.meta.url);
let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
});

function database(inner: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>): Database {
  const db = Reflect.construct(Database as unknown as new () => Database, []);
  db.inner = inner;
  db.scheduleSave = () => {};
  (db as unknown as { flush: () => void }).flush = () => {};
  return db;
}

function count(inner: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>, sql: string): number {
  return Number(inner.exec(sql)[0]?.values[0]?.[0] ?? 0);
}

function value(inner: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>, sql: string): unknown {
  return inner.exec(sql)[0]?.values[0]?.[0];
}

function v35Database(): { db: Database; inner: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']> } {
  const inner = new SQL.Database();
  inner.exec(`
    CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_meta VALUES('schema_version', '35');
    CREATE TABLE projects(id TEXT PRIMARY KEY);
    CREATE TABLE agents(id TEXT PRIMARY KEY);
    CREATE TABLE channels(id TEXT PRIMARY KEY);
    CREATE TABLE organizations(
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE principals(
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      kind TEXT NOT NULL DEFAULT 'person', display_name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE channel_identities(
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      channel_id TEXT NOT NULL REFERENCES channels(id), principal_id TEXT NOT NULL REFERENCES principals(id),
      external_identity_key TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE conversations(
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id),
      organization_id TEXT REFERENCES organizations(id), principal_id TEXT REFERENCES principals(id),
      channel_id TEXT REFERENCES channels(id), channel_identity_id TEXT REFERENCES channel_identities(id),
      external_conversation_key TEXT, title TEXT NOT NULL DEFAULT '', last_message_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE tasks(
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), project_id TEXT REFERENCES projects(id),
      conversation_id TEXT REFERENCES conversations(id), input_message_id TEXT REFERENCES messages(id),
      title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'desktop',
      source_key TEXT, parent_id TEXT, status TEXT NOT NULL DEFAULT 'QUEUED', priority INTEGER NOT NULL DEFAULT 0,
      progress INTEGER NOT NULL DEFAULT 0, stage TEXT NOT NULL DEFAULT '', error TEXT, result TEXT, quality TEXT,
      session_id TEXT, workspace_override TEXT, engine_override TEXT, is_demo INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, deleted_at INTEGER
    );
    CREATE TABLE messages(
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      principal_id TEXT REFERENCES principals(id), conversation_id TEXT NOT NULL REFERENCES conversations(id),
      channel_id TEXT REFERENCES channels(id), channel_identity_id TEXT REFERENCES channel_identities(id),
      external_message_key TEXT, dedupe_key TEXT NOT NULL UNIQUE, direction TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '', task_id TEXT REFERENCES tasks(id), metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE kernel_attempts(
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id),
      component_id TEXT NOT NULL, role TEXT NOT NULL, sequence INTEGER NOT NULL, status TEXT NOT NULL,
      started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, error TEXT, UNIQUE(request_id, sequence)
    );
    CREATE TABLE kernel_sessions(
      conversation_id TEXT NOT NULL REFERENCES conversations(id), kernel_id TEXT NOT NULL,
      native_session_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(conversation_id, kernel_id)
    );
    CREATE TABLE dispatch_plans(
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, organization_id TEXT NOT NULL REFERENCES organizations(id),
      principal_id TEXT NOT NULL REFERENCES principals(id), channel_id TEXT NOT NULL REFERENCES channels(id),
      conversation_id TEXT NOT NULL REFERENCES conversations(id), input_message_id TEXT NOT NULL REFERENCES messages(id),
      leader_kernel TEXT NOT NULL, worker_agent_id TEXT NOT NULL REFERENCES agents(id), worker_engine_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned', task_id TEXT, plan_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      committed_at INTEGER, error TEXT
    );

    INSERT INTO projects VALUES('project-1');
    INSERT INTO agents VALUES('agent-1');
    INSERT INTO channels VALUES('ch-1');
    INSERT INTO organizations VALUES('org-1','org-1','Org 1',1,1);
    INSERT INTO principals VALUES('principal-1', 'org-1','person','User 1',1,1);
    INSERT INTO channel_identities VALUES('identity-1', 'org-1', 'ch-1', 'principal-1','external-user-1','User 1','{}',1,1);
    INSERT INTO conversations VALUES(
      'conversation-1', 'agent-1', 'org-1', 'principal-1', 'ch-1', 'identity-1',
      'direct:1', '', 1, 1, 1, 1
    );
    INSERT INTO messages VALUES(
      'message-1', 'org-1', 'principal-1', 'conversation-1', 'ch-1', 'identity-1',
      'external-1', 'dedupe-1', 'inbound', 'user', 'hello', 'task-winner', '{}', 1
    );
    INSERT INTO tasks(
      id, agent_id, project_id, conversation_id, input_message_id, title, content,
      source, source_key, status, created_at
    ) VALUES
      ('task-duplicate', 'agent-1', 'project-1', 'conversation-1', 'message-1', 'duplicate', 'duplicate',
       'channel', 'duplicate', 'COMPLETED', 1),
      ('task-winner', 'agent-1', 'project-1', 'conversation-1', 'message-1', 'winner', 'winner',
       'channel', 'winner', 'COMPLETED', 2);
    INSERT INTO dispatch_plans VALUES(
      'plan-1', 'kernel:message-1', 'org-1', 'principal-1', 'ch-1', 'conversation-1',
      'message-1', 'hermes', 'agent-1', 'engine-1', 'committed', 'task-winner', '{}', 2, 2, NULL
    );
  `);
  return { db: database(inner), inner };
}

describe('database v38 reliability gates', () => {
  it.each(['', '0', '-1', '35.5', 'not-a-version'])('rejects illegal schema version %j before running DDL', (version) => {
    const inner = new SQL.Database();
    inner.exec('CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    if (version) inner.run("INSERT INTO schema_meta VALUES('schema_version', ?)", [version]);
    const db = database(inner);

    expect(() => (db as unknown as { migrate: () => void }).migrate()).toThrow('数据库版本非法');
    expect(count(inner, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='projects'")).toBe(0);
  });

  it('rejects a future schema before running DDL', () => {
    const inner = new SQL.Database();
    inner.exec("CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES('schema_version', '39')");
    const db = database(inner);

    expect(() => (db as unknown as { migrate: () => void }).migrate()).toThrow('高于当前应用支持');
    expect(count(inner, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='projects'")).toBe(0);
  });

  it('only treats a truly empty database as version zero', () => {
    const inner = new SQL.Database();
    inner.exec('CREATE TABLE unrelated_data(id TEXT PRIMARY KEY)');
    const db = database(inner);

    expect(() => (db as unknown as { migrate: () => void }).migrate()).toThrow('缺少 schema_version');
    expect(count(inner, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='schema_meta'")).toBe(0);
  });

  it('migrates a truly empty database to v38 with foreign keys enabled', () => {
    const inner = new SQL.Database();
    const db = database(inner);

    expect(() => (db as unknown as { migrate: () => void }).migrate()).not.toThrow();
    expect(value(inner, "SELECT value FROM schema_meta WHERE key='schema_version'")).toBe('38');
    expect(value(inner, 'PRAGMA foreign_keys')).toBe(1);
    expect(count(inner, 'PRAGMA foreign_key_check')).toBe(0);

    inner.exec(`
      INSERT INTO workflows(id, name, created_at) VALUES('workflow-1','Workflow',1);
      INSERT INTO workflow_runs(id, workflow_id, started_at) VALUES('workflow-run-1','workflow-1',1);
      DELETE FROM workflows WHERE id = 'workflow-1';
    `);
    expect(count(inner, "SELECT COUNT(*) FROM workflow_runs WHERE id='workflow-run-1'")).toBe(0);
  });

  it('keeps optional demo approvals attached to real demo tasks under foreign keys', () => {
    const inner = new SQL.Database();
    const db = database(inner);
    (db as unknown as { migrate: () => void }).migrate();
    inner.exec("INSERT INTO engines(id, type, name) VALUES('eng-hermes','hermes','Nexus Agent')");
    db.setSetting('seedDemoData', true);

    expect(() => seedIfEmpty(db)).not.toThrow();
    expect(count(inner, 'SELECT COUNT(*) FROM approvals')).toBe(8);
    expect(count(inner, `SELECT COUNT(*) FROM approvals ap
      LEFT JOIN tasks t ON t.id = ap.task_id WHERE t.id IS NULL`)).toBe(0);
    expect(count(inner, 'PRAGMA foreign_key_check')).toBe(0);
  });

  it('migrates v35 duplicate message links conservatively and enables foreign keys', () => {
    const { db, inner } = v35Database();
    expect(() => (db as unknown as { migrate: () => void }).migrate()).not.toThrow();

    expect(value(inner, "SELECT value FROM schema_meta WHERE key='schema_version'")).toBe('38');
    expect(value(inner, 'PRAGMA foreign_keys')).toBe(1);
    expect(value(inner, "SELECT input_message_id FROM tasks WHERE id='task-winner'")).toBe('message-1');
    expect(value(inner, "SELECT input_message_id FROM tasks WHERE id='task-duplicate'")).toBeNull();
    expect(value(inner, "SELECT task_id FROM messages WHERE id='message-1'")).toBe('task-winner');
    expect(() => inner.exec(`INSERT INTO tasks(
      id, agent_id, conversation_id, input_message_id, title, content, source, status, created_at
    ) VALUES('task-third','agent-1','conversation-1','message-1','third','third','channel','QUEUED',3)`)).toThrow(/UNIQUE/);
    expect(() => inner.exec("INSERT INTO tasks(id,agent_id,title,content,created_at) VALUES('bad-task','missing','bad','bad',3)")).toThrow(/FOREIGN KEY/);
    expect(count(inner, 'PRAGMA foreign_key_check')).toBe(0);
  });

  it('rebuilds a missing historical task as an interrupted durable receipt', () => {
    const { db, inner } = v35Database();
    inner.exec("DELETE FROM tasks WHERE id = 'task-winner'");

    expect(() => (db as unknown as { migrate: () => void }).migrate()).not.toThrow();
    expect(value(inner, "SELECT status FROM tasks WHERE id='task-winner'")).toBe('INTERRUPTED');
    expect(value(inner, "SELECT deleted_at IS NOT NULL FROM tasks WHERE id='task-winner'")).toBe(1);
    expect(value(inner, "SELECT input_message_id FROM tasks WHERE id='task-winner'")).toBe('message-1');
    expect(value(inner, "SELECT task_id FROM messages WHERE id='message-1'")).toBe('task-winner');
    expect(value(inner, "SELECT task_id FROM dispatch_plans WHERE id='plan-1'")).toBe('task-winner');
    expect(count(inner, 'PRAGMA foreign_key_check')).toBe(0);
  });

  it('uses the reciprocal task claim and repoints the committed plan deterministically', () => {
    const { db, inner } = v35Database();
    inner.exec("UPDATE messages SET task_id = 'task-duplicate' WHERE id = 'message-1'");

    expect(() => (db as unknown as { migrate: () => void }).migrate()).not.toThrow();
    expect(value(inner, "SELECT input_message_id FROM tasks WHERE id='task-duplicate'")).toBe('message-1');
    expect(value(inner, "SELECT input_message_id FROM tasks WHERE id='task-winner'")).toBeNull();
    expect(value(inner, "SELECT task_id FROM dispatch_plans WHERE id='plan-1'")).toBe('task-duplicate');
  });

  it('fails closed when a task input has no recoverable inbound evidence', () => {
    const { db, inner } = v35Database();
    inner.exec(`INSERT INTO tasks(
      id, agent_id, conversation_id, input_message_id, title, content, source, status, created_at
    ) VALUES('task-broken','agent-1','conversation-1','missing-message','broken','broken','channel','FAILED',3)`);

    expect(() => (db as unknown as { migrate: () => void }).migrate()).toThrow(/没有可验证的入站消息/);
    expect(value(inner, "SELECT value FROM schema_meta WHERE key='schema_version'")).toBe('35');
    expect(value(inner, "SELECT input_message_id FROM tasks WHERE id='task-broken'")).toBe('missing-message');
  });

  it('fails closed when one entity has evidence for multiple organizations', () => {
    const { db, inner } = v35Database();
    inner.exec(`
      INSERT INTO organizations VALUES('org-2','org-2','Org 2',2,2);
      INSERT INTO principals VALUES('principal-2','org-2','person','User 2',2,2);
      INSERT INTO channel_identities VALUES(
        'identity-2','org-2','ch-1','principal-2','external-user-2','User 2','{}',2,2
      );
      INSERT INTO conversations VALUES(
        'conversation-2','agent-1','org-2','principal-2','ch-1','identity-2',
        'direct:2','',2,1,2,2
      );
      INSERT INTO messages VALUES(
        'message-2','org-2','principal-2','conversation-2','ch-1','identity-2',
        'external-2','dedupe-2','inbound','user','other tenant',NULL,'{}',2
      );
    `);

    expect(() => (db as unknown as { migrate: () => void }).migrate()).toThrow(/同时属于多个组织/);
    expect(value(inner, "SELECT value FROM schema_meta WHERE key='schema_version'")).toBe('35');
  });

  it('creates a local desktop principal and permits plans without a channel', () => {
    const { db, inner } = v35Database();
    (db as unknown as { migrate: () => void }).migrate();
    inner.exec(`
      INSERT INTO agents(id, organization_id) VALUES('agent-local','org-local');
      INSERT INTO conversations(
        id, agent_id, organization_id, principal_id, channel_id, title,
        last_message_at, message_count, created_at, updated_at
      ) VALUES(
        'conversation-local','agent-local','org-local','principal-local-admin',NULL,'Desktop',3,1,3,3
      );
      INSERT INTO messages(
        id, organization_id, principal_id, conversation_id, channel_id, dedupe_key,
        direction, role, content, metadata_json, created_at
      ) VALUES(
        'message-local','org-local','principal-local-admin','conversation-local',NULL,
        'desktop:message-local','inbound','user','desktop task','{}',3
      );
      INSERT INTO dispatch_plans(
        id, request_id, organization_id, principal_id, channel_id, conversation_id,
        input_message_id, leader_kernel, worker_agent_id, worker_engine_id,
        status, plan_json, created_at
      ) VALUES(
        'plan-local','kernel:message-local','org-local','principal-local-admin',NULL,
        'conversation-local','message-local','hermes','agent-local','eng-hermes',
        'planned','{}',3
      );
    `);

    expect(value(inner, "SELECT organization_id FROM principals WHERE id='principal-local-admin'")).toBe('org-local');
    expect(value(inner, "SELECT channel_id FROM dispatch_plans WHERE id='plan-local'")).toBeNull();
    expect(count(inner, 'PRAGMA foreign_key_check')).toBe(0);
  });

  it('enforces durable memory proposal checks, uniqueness, indexes, and foreign keys', () => {
    const { db, inner } = v35Database();
    (db as unknown as { migrate: () => void }).migrate();
    inner.exec(`INSERT INTO memory_proposals(
      id, request_id, proposal_index, organization_id, principal_id, channel_id,
      conversation_id, agent_id, project_id, operation, kind, content, importance,
      scope_type, scope_id, status, proposed_by, created_at
    ) VALUES(
      'proposal-1','kernel:message-1',0,'org-1','principal-1','ch-1',
      'conversation-1','agent-1','project-1','remember','preference','Use concise replies',0.8,
      'principal','principal-1','pending','hermes',3
    )`);

    expect(() => inner.exec(`INSERT INTO memory_proposals(
      id, request_id, proposal_index, organization_id, operation, kind, content,
      importance, scope_type, scope_id, proposed_by, created_at
    ) VALUES('proposal-duplicate','kernel:message-1',0,'org-1','remember','x','x',0.5,'agent','agent-1','hermes',3)`)).toThrow(/UNIQUE/);
    expect(() => inner.exec(`INSERT INTO memory_proposals(
      id, request_id, proposal_index, organization_id, operation, kind, content,
      importance, scope_type, scope_id, proposed_by, created_at
    ) VALUES('proposal-bad-importance','request-2',0,'org-1','remember','x','x',2,'agent','agent-1','hermes',3)`)).toThrow(/CHECK/);
    expect(() => inner.exec(`INSERT INTO memory_proposals(
      id, request_id, proposal_index, organization_id, operation, kind, content,
      importance, scope_type, scope_id, proposed_by, created_at
    ) VALUES('proposal-bad-operation','request-3',0,'org-1','forget','x','x',0.5,'agent','agent-1','hermes',3)`)).toThrow(/CHECK/);
    expect(() => inner.exec(`INSERT INTO memory_proposals(
      id, request_id, proposal_index, organization_id, agent_id, operation, kind, content,
      importance, scope_type, scope_id, proposed_by, created_at
    ) VALUES('proposal-bad-fk','request-4',0,'org-1','missing-agent','remember','x','x',0.5,'agent','missing-agent','hermes',3)`)).toThrow(/FOREIGN KEY/);
    for (const index of [
      'idx_memory_proposals_status',
      'idx_memory_proposals_request',
      'idx_memory_proposals_conversation'
    ]) {
      expect(count(inner, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='${index}'`)).toBe(1);
    }
  });

  it('migrates durable task schedule proposals with tenant context and constraints', () => {
    const { db, inner } = v35Database();
    (db as unknown as { migrate: () => void }).migrate();
    inner.exec(`INSERT INTO task_schedule_proposals(
      id, request_id, proposal_index, organization_id, principal_id, channel_id,
      conversation_id, agent_id, project_id, operation, title, content,
      cron_kind, cron_value, status, proposed_by, created_at
    ) VALUES(
      'schedule-proposal-1','kernel:message-1',0,'org-1','principal-1','ch-1',
      'conversation-1','agent-1','project-1','create_task_schedule','Daily report',
      'Prepare the report','daily','09:00','pending','hermes',3
    )`);

    expect(() => inner.exec(`INSERT INTO task_schedule_proposals(
      id, request_id, proposal_index, organization_id, conversation_id, agent_id,
      operation, title, content, cron_kind, cron_value, proposed_by, created_at
    ) VALUES(
      'schedule-proposal-duplicate','kernel:message-1',0,'org-1','conversation-1','agent-1',
      'create_task_schedule','x','x','daily','09:00','hermes',3
    )`)).toThrow(/UNIQUE/);
    expect(() => inner.exec(`INSERT INTO task_schedule_proposals(
      id, request_id, proposal_index, organization_id, conversation_id, agent_id,
      operation, title, content, cron_kind, cron_value, proposed_by, created_at
    ) VALUES(
      'schedule-proposal-bad-kind','kernel:message-1',1,'org-1','conversation-1','agent-1',
      'create_task_schedule','x','x','yearly','09:00','hermes',3
    )`)).toThrow(/CHECK/);
    expect(() => inner.exec(`INSERT INTO task_schedule_proposals(
      id, request_id, proposal_index, organization_id, conversation_id, agent_id,
      operation, title, content, cron_kind, cron_value, proposed_by, created_at
    ) VALUES(
      'schedule-proposal-bad-agent','kernel:message-1',2,'org-1','conversation-1','missing-agent',
      'create_task_schedule','x','x','daily','09:00','hermes',3
    )`)).toThrow(/FOREIGN KEY/);
    for (const index of [
      'idx_task_schedule_proposals_status',
      'idx_task_schedule_proposals_request',
      'idx_task_schedule_proposals_conversation'
    ]) {
      expect(count(inner, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='${index}'`)).toBe(1);
    }
    expect(count(inner, 'PRAGMA foreign_key_check')).toBe(0);
  });

  it('deletes a conversation without leaving task, message, plan, or kernel references behind', () => {
    const { db, inner } = v35Database();
    (db as unknown as { migrate: () => void }).migrate();
    inner.exec(`
      INSERT INTO kernel_attempts(
        id, request_id, conversation_id, component_id, role, sequence,
        status, started_at, ended_at
      ) VALUES('attempt-1','kernel:message-1','conversation-1','hermes','leader',1,'succeeded',1,2);
      INSERT INTO kernel_sessions(conversation_id, kernel_id, native_session_id, updated_at)
        VALUES('conversation-1','hermes','native-1',2);
      DELETE FROM conversations WHERE id = 'conversation-1';
    `);

    expect(count(inner, "SELECT COUNT(*) FROM messages WHERE id='message-1'")).toBe(0);
    expect(count(inner, "SELECT COUNT(*) FROM dispatch_plans WHERE id='plan-1'")).toBe(0);
    expect(count(inner, "SELECT COUNT(*) FROM kernel_attempts WHERE id='attempt-1'")).toBe(0);
    expect(count(inner, "SELECT COUNT(*) FROM kernel_sessions WHERE native_session_id='native-1'")).toBe(0);
    expect(value(inner, "SELECT conversation_id FROM tasks WHERE id='task-winner'")).toBeNull();
    expect(value(inner, "SELECT input_message_id FROM tasks WHERE id='task-winner'")).toBeNull();
    expect(count(inner, 'PRAGMA foreign_key_check')).toBe(0);
  });

  it('keeps a permanent canonical receipt while purging expired task payload', () => {
    const { db, inner } = v35Database();
    (db as unknown as { migrate: () => void }).migrate();
    inner.exec(`
      UPDATE tasks SET ended_at = 1 WHERE id = 'task-winner';
      INSERT INTO task_events(id, task_id, event_type, created_at) VALUES('event-1','task-winner','completed',1);
      INSERT INTO task_messages(id, task_id, role, created_at) VALUES('task-message-1','task-winner','assistant',1);
      INSERT INTO agent_runs(id, agent_id, task_id, session_id, status, started_at, ended_at)
        VALUES('run-1','agent-1','task-winner','session-1','COMPLETED',1,1);
      INSERT INTO approvals(id, task_id, agent_id, type, request, created_at)
        VALUES('approval-1','task-winner','agent-1','tool','request',1);
      INSERT INTO mobile_devices(
        id, protocol_version, identity_public_key, identity_fingerprint, certificate_fingerprint, paired_at
      ) VALUES('device-1',1,'public','fingerprint','certificate',1);
      INSERT INTO mobile_control_sessions(id, agent_id, device_id, task_id, status, started_at, expires_at)
        VALUES('mobile-session-1','agent-1','device-1','task-winner','completed',1,2);
      INSERT INTO mobile_commands(id, session_id, agent_id, device_id, task_id, tool_name, started_at)
        VALUES('command-1','mobile-session-1','agent-1','device-1','task-winner','tap',4102444800000);
      INSERT INTO mobile_artifacts(
        id, device_id, agent_id, task_id, command_id, kind, mime_type, filename,
        storage_name, size, sha256, created_at
      ) VALUES(
        'artifact-1','device-1','agent-1','task-winner','command-1','image','image/png','a.png',
        'a.png',1,'hash',4102444800000
      );
    `);

    expect(() => db.cleanupRetention()).not.toThrow();
    expect(count(inner, "SELECT COUNT(*) FROM tasks WHERE id='task-winner'")).toBe(1);
    expect(value(inner, "SELECT status FROM tasks WHERE id='task-winner'")).toBe('COMPLETED');
    expect(value(inner, "SELECT title FROM tasks WHERE id='task-winner'")).toBe('');
    expect(value(inner, "SELECT content FROM tasks WHERE id='task-winner'")).toBe('');
    expect(value(inner, "SELECT deleted_at IS NOT NULL FROM tasks WHERE id='task-winner'")).toBe(1);
    expect(value(inner, "SELECT task_id FROM messages WHERE id='message-1'")).toBe('task-winner');
    expect(value(inner, "SELECT task_id FROM dispatch_plans WHERE id='plan-1'")).toBe('task-winner');
    expect(value(inner, "SELECT task_id FROM mobile_control_sessions WHERE id='mobile-session-1'")).toBeNull();
    expect(value(inner, "SELECT task_id FROM mobile_commands WHERE id='command-1'")).toBeNull();
    expect(value(inner, "SELECT task_id FROM mobile_artifacts WHERE id='artifact-1'")).toBeNull();
    expect(() => inner.exec(`INSERT INTO tasks(
      id, agent_id, conversation_id, input_message_id, title, content, source, status, created_at
    ) VALUES('task-retry','agent-1','conversation-1','message-1','retry','retry','channel','QUEUED',3)`)).toThrow(/UNIQUE/);
    expect(count(inner, 'PRAGMA foreign_key_check')).toBe(0);
  });
});
