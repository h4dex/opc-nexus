import { beforeAll, describe, expect, it, vi } from 'vitest';
import initSqlJs from 'sql.js';
import { createRequire } from 'node:module';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

import { Database } from '../src/main/services/database.js';
import { DesktopControlPlane } from '../src/main/services/desktopControlPlane.js';
import {
  DesktopIngressService,
  LOCAL_DESKTOP_ORGANIZATION_ID,
  LOCAL_DESKTOP_PRINCIPAL_ID
} from '../src/main/services/desktopIngressService.js';

const require = createRequire(import.meta.url);
let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
});

function testDatabase(): { db: Database; inner: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']> } {
  const inner = new SQL.Database();
  inner.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations(id TEXT PRIMARY KEY, slug TEXT UNIQUE, name TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE principals(
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      kind TEXT, display_name TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE agents(
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE projects(
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id)
    );
    CREATE TABLE conversations(
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id),
      project_id TEXT REFERENCES projects(id),
      organization_id TEXT REFERENCES organizations(id), principal_id TEXT REFERENCES principals(id),
      channel_id TEXT, channel_identity_id TEXT, external_conversation_key TEXT,
      title TEXT NOT NULL, last_message_at INTEGER NOT NULL, message_count INTEGER NOT NULL,
      created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE tasks(
      id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id), source TEXT NOT NULL,
      status TEXT NOT NULL, result TEXT, error TEXT
    );
    CREATE TABLE messages(
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      principal_id TEXT REFERENCES principals(id), conversation_id TEXT NOT NULL REFERENCES conversations(id),
      channel_id TEXT, channel_identity_id TEXT, external_message_key TEXT,
      dedupe_key TEXT NOT NULL UNIQUE, direction TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, task_id TEXT REFERENCES tasks(id), metadata_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE audit_logs(
      id TEXT PRIMARY KEY, actor TEXT, action TEXT, target TEXT, result TEXT, source TEXT, created_at INTEGER
    );
    INSERT INTO organizations VALUES('org-local', 'local', 'Local', 1, 1);
    INSERT INTO organizations VALUES('org-other', 'other', 'Other', 1, 1);
    INSERT INTO agents VALUES('agent-1', 'org-local', 0);
    INSERT INTO agents VALUES('agent-2', 'org-local', 0);
    INSERT INTO agents VALUES('agent-foreign', 'org-other', 0);
    INSERT INTO agents VALUES('agent-archived', 'org-local', 1);
    INSERT INTO projects VALUES('project-1', 'org-local');
    INSERT INTO projects VALUES('project-2', 'org-local');
    INSERT INTO projects VALUES('project-foreign', 'org-other');
  `);
  const db = Reflect.construct(Database as unknown as new () => Database, []);
  db.inner = inner;
  db.scheduleSave = () => {};
  return { db, inner };
}

function scalar(inner: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>, sql: string): unknown {
  return inner.exec(sql)[0]?.values[0]?.[0];
}

describe('DesktopIngressService', () => {
  it('persists local identity/messages exactly once and rejects cross-agent conversation reuse', () => {
    const { db, inner } = testDatabase();
    const ingress = new DesktopIngressService(db);
    const first = ingress.ingest({ agentId: 'agent-1', message: '分析本月经营数据', messageKey: 'desktop-msg-1' });
    const replay = ingress.ingest({
      agentId: 'agent-1', message: '分析本月经营数据', messageKey: 'desktop-msg-1'
    });

    expect(first).toMatchObject({
      organizationId: LOCAL_DESKTOP_ORGANIZATION_ID,
      principalId: LOCAL_DESKTOP_PRINCIPAL_ID,
      deduplicated: false
    });
    expect(replay).toMatchObject({ inputMessageId: first.inputMessageId, deduplicated: true });
    expect(replay.conversationId).toBe(first.conversationId);
    expect(scalar(inner, "SELECT COUNT(*) FROM messages WHERE direction = 'inbound'")).toBe(1);
    expect(scalar(inner, 'SELECT COUNT(*) FROM conversations')).toBe(1);
    expect(scalar(inner, 'SELECT message_count FROM conversations')).toBe(1);
    expect(() => ingress.ingest({
      agentId: 'agent-1', message: '不同内容', messageKey: 'desktop-msg-1'
    })).toThrow('messageKey is already bound');
    expect(() => ingress.ingest({
      agentId: 'agent-2', message: '越权续接', conversationId: first.conversationId, messageKey: 'desktop-msg-2'
    })).toThrow('会话不属于所选数字员工');
  });

  it('links a task and stores one canonical terminal response', () => {
    const { db, inner } = testDatabase();
    const ingress = new DesktopIngressService(db);
    const message = ingress.ingest({ agentId: 'agent-1', message: '生成报告', messageKey: 'desktop-msg-2' });
    inner.run(
      "INSERT INTO tasks(id, conversation_id, source, status, result, error) VALUES(?, ?, 'desktop', 'COMPLETED', '报告完成', NULL)",
      ['task-1', message.conversationId]
    );

    ingress.linkTask(message, 'task-1');
    ingress.recordTaskOutcome('task-1');
    ingress.recordTaskOutcome('task-1');

    expect(scalar(inner, "SELECT task_id FROM messages WHERE direction = 'inbound'")).toBe('task-1');
    expect(scalar(inner, "SELECT COUNT(*) FROM messages WHERE direction = 'outbound'")).toBe(1);
    expect(scalar(inner, "SELECT content FROM messages WHERE direction = 'outbound'")).toBe('报告完成');
  });

  it('keeps a conversation bound to one project and inherits it on later turns', () => {
    const { db, inner } = testDatabase();
    const ingress = new DesktopIngressService(db);
    const first = ingress.ingest({
      agentId: 'agent-1', message: '启动项目 Quest', messageKey: 'project-msg-1', projectId: 'project-1'
    });
    const continued = ingress.ingest({
      agentId: 'agent-1', message: '继续上一轮', messageKey: 'project-msg-2', conversationId: first.conversationId
    });

    expect(first.projectId).toBe('project-1');
    expect(continued.projectId).toBe('project-1');
    expect(scalar(inner, `SELECT project_id FROM conversations WHERE id = '${first.conversationId}'`)).toBe('project-1');
    expect(() => ingress.ingest({
      agentId: 'agent-1', message: '跨项目续接', messageKey: 'project-msg-3',
      conversationId: first.conversationId, projectId: 'project-2'
    })).toThrow('会话不属于所选项目');
    expect(() => ingress.ingest({
      agentId: 'agent-1', message: '外部项目', messageKey: 'project-msg-4', projectId: 'project-foreign'
    })).toThrow('project does not belong to the local organization');
  });

  it('rejects foreign or archived agents before creating a local conversation', () => {
    const { db, inner } = testDatabase();
    const ingress = new DesktopIngressService(db);

    expect(() => ingress.ingest({
      agentId: 'agent-foreign', message: 'cross-tenant task', messageKey: 'desktop-foreign'
    })).toThrow('agent does not belong to the local organization or is archived');
    expect(() => ingress.ingest({
      agentId: 'agent-archived', message: 'archived task', messageKey: 'desktop-archived'
    })).toThrow('agent does not belong to the local organization or is archived');
    expect(scalar(inner, 'SELECT COUNT(*) FROM conversations')).toBe(0);
    expect(scalar(inner, 'SELECT COUNT(*) FROM messages')).toBe(0);
  });

  it('stores a canonical cancellation response', () => {
    const { db, inner } = testDatabase();
    const ingress = new DesktopIngressService(db);
    const message = ingress.ingest({ agentId: 'agent-1', message: '停止任务', messageKey: 'desktop-msg-cancel' });
    inner.run(
      "INSERT INTO tasks(id, conversation_id, source, status, result, error) VALUES(?, ?, 'desktop', 'CANCELLED', NULL, NULL)",
      ['task-cancelled', message.conversationId]
    );

    ingress.linkTask(message, 'task-cancelled');
    ingress.recordTaskOutcome('task-cancelled');

    expect(scalar(inner, "SELECT content FROM messages WHERE direction = 'outbound'")).toBe('任务已取消。');
  });

  it('stores terminal outcomes for canonical voice and Web tasks', () => {
    const { db, inner } = testDatabase();
    const ingress = new DesktopIngressService(db);
    const voice = ingress.ingest({ agentId: 'agent-1', message: '语音任务', messageKey: 'voice-1' });
    const web = ingress.ingest({ agentId: 'agent-1', message: 'Web 任务', messageKey: 'web-1' });
    inner.run(
      "INSERT INTO tasks(id, conversation_id, source, status, result, error) VALUES(?, ?, 'voice', 'COMPLETED', '语音完成', NULL)",
      ['task-voice', voice.conversationId]
    );
    inner.run(
      "INSERT INTO tasks(id, conversation_id, source, status, result, error) VALUES(?, ?, 'webhook', 'COMPLETED', 'Web 完成', NULL)",
      ['task-web', web.conversationId]
    );

    ingress.linkTask(voice, 'task-voice');
    ingress.linkTask(web, 'task-web');
    ingress.recordTaskOutcome('task-voice');
    ingress.recordTaskOutcome('task-web');

    expect(scalar(inner, "SELECT COUNT(*) FROM messages WHERE direction = 'outbound'")).toBe(2);
  });
});

describe('DesktopControlPlane', () => {
  it('uses the canonical router contract with desktop source and no channel', async () => {
    const { db, inner } = testDatabase();
    const ingress = new DesktopIngressService(db);
    const dispatchCanonical = vi.fn(async (request) => {
      inner.run(
        "INSERT OR IGNORE INTO tasks(id, conversation_id, source, status, result, error) VALUES('task-control', ?, 'desktop', 'QUEUED', NULL, NULL)",
        [request.conversationId]
      );
      return { id: 'task-control', agentId: 'agent-1' };
    });
    const control = new DesktopControlPlane(db, ingress, { dispatchCanonical } as never);

    const result = await control.dispatch({
      preferredAgentId: 'agent-1', message: '安排财务员工分析现金流', messageKey: 'desktop-control-1', projectId: 'project-1'
    });

    expect(result).toMatchObject({ task: { id: 'task-control' } });
    expect(dispatchCanonical).toHaveBeenCalledWith(expect.objectContaining({
      source: 'desktop', channelId: null, organizationId: 'org-local',
      principalId: 'principal-local-admin', preferredAgentId: 'agent-1', projectId: 'project-1'
    }));
    expect(scalar(inner, "SELECT task_id FROM messages WHERE direction = 'inbound'")).toBe('task-control');
  });

  it('preserves voice source when dispatching through the shared control plane', async () => {
    const { db, inner } = testDatabase();
    const ingress = new DesktopIngressService(db);
    const dispatchCanonical = vi.fn(async (request) => {
      inner.run(
        "INSERT OR IGNORE INTO tasks(id, conversation_id, source, status, result, error) VALUES('task-voice-control', ?, 'voice', 'QUEUED', NULL, NULL)",
        [request.conversationId]
      );
      return { id: 'task-voice-control', agentId: 'agent-1' };
    });
    const control = new DesktopControlPlane(db, ingress, { dispatchCanonical } as never);

    await control.dispatch({
      preferredAgentId: 'agent-1', message: '整理会议纪要', source: 'voice', messageKey: 'voice-control-1'
    });

    expect(dispatchCanonical).toHaveBeenCalledWith(expect.objectContaining({ source: 'voice', channelId: null }));
  });

  it('rolls back an unlinked inbound message and empty conversation when dispatch is rejected', async () => {
    const { db, inner } = testDatabase();
    const ingress = new DesktopIngressService(db);
    const control = new DesktopControlPlane(db, ingress, {
      dispatchCanonical: vi.fn(async () => { throw new Error('尚未连接可执行模型'); })
    } as never);

    await expect(control.dispatch({
      preferredAgentId: 'agent-1', message: '生成交付报告', messageKey: 'desktop-control-failed'
    })).rejects.toThrow('尚未连接可执行模型');

    expect(scalar(inner, "SELECT COUNT(*) FROM messages WHERE external_message_key = 'desktop-control-failed'")).toBe(0);
    expect(scalar(inner, 'SELECT COUNT(*) FROM conversations')).toBe(0);
  });
});
