import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

import { Database } from '../src/main/services/database.js';
import { HermesConversationAttachmentService, HERMES_ATTACHMENT_MAX_BYTES } from '../src/main/services/hermesConversationAttachmentService.js';
import { HermesGovernanceBridge } from '../src/main/services/hermesGovernanceBridge.js';
import { ProjectManager } from '../src/main/services/projectManager.js';

const require = createRequire(import.meta.url);
let SQL: Awaited<ReturnType<typeof initSqlJs>>;
const openDatabases: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>[] = [];
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
});

afterEach(() => {
  while (openDatabases.length) openDatabases.pop()!.close();
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

type TestDatabase = Database & {
  inner: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>;
  scheduleSave: () => void;
};

function wrap(): TestDatabase {
  const inner = new SQL.Database();
  openDatabases.push(inner);
  const db = Reflect.construct(Database as unknown as new () => Database, []) as TestDatabase;
  db.inner = inner;
  db.scheduleSave = () => undefined;
  (db as unknown as { flush: () => void }).flush = () => undefined;
  (db as unknown as { migrate: () => void }).migrate();
  return db;
}

function fixture() {
  const db = wrap();
  const now = Date.UTC(2026, 7, 21, 12, 0, 0);
  db.inner.exec(`
    INSERT INTO engines(id, type, name, status) VALUES('eng-hermes-test', 'hermes-cli', 'Hermes Test', 'HEALTHY');
    INSERT INTO agents(
      id, organization_id, name, role, engine_id, lifecycle, workspace,
      permission_mode, capabilities_json, created_at, updated_at
    ) VALUES(
      'agent-hermes-test', 'org-local', 'Hermes Test', 'attachment review', 'eng-hermes-test', 'READY', '',
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
  const workspace = mkdtempSync(join(tmpdir(), 'aibox-hermes-attachment-'));
  temporaryDirectories.push(workspace);
  const project = new ProjectManager(db).create({
    name: 'Attachment project', objective: 'Verify real conversation files', status: 'active'
  });
  const conversation = new HermesGovernanceBridge(db).createConversation(project.id);
  const service = new HermesConversationAttachmentService(
    db,
    (projectId) => projectId === project.id ? workspace : null,
    () => now
  );
  return { db, workspace, project, conversation, service };
}

describe('HermesConversationAttachmentService', () => {
  it('stores a real project-scoped file and returns verified prompt context', () => {
    const f = fixture();
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    const uploaded = f.service.upload({
      projectId: f.project.id,
      conversationId: f.conversation.conversationId,
      name: 'brief.png',
      mediaType: 'image/png',
      bytes
    });

    expect(uploaded).toMatchObject({
      projectId: f.project.id,
      conversationId: f.conversation.conversationId,
      name: 'brief.png',
      mediaType: 'image/png',
      size: bytes.length
    });
    expect(uploaded.relativePath).toContain(`.opc-nexus/attachments/${f.conversation.conversationId}/`);
    expect(readFileSync(join(f.workspace, uploaded.relativePath))).toEqual(bytes);
    expect(f.service.list(f.project.id, f.conversation.conversationId)).toEqual([uploaded]);
    expect(f.service.read(f.project.id, uploaded.id)).toMatchObject({
      attachment: uploaded,
      bytes,
      contentType: 'image/png',
      disposition: 'inline'
    });

    const context = f.service.promptContext(f.project.id, f.conversation.conversationId, [uploaded.id]);
    expect(context.attachments).toEqual([uploaded]);
    expect(context.systemMessage).toContain('brief.png (image/png, 9 bytes');
    expect(context.systemMessage).toContain(join(f.workspace, uploaded.relativePath));
  });

  it('rejects cross-project references, oversized files, and tampered storage', () => {
    const f = fixture();
    expect(() => f.service.upload({
      projectId: 'project-outside',
      conversationId: f.conversation.conversationId,
      name: 'outside.txt',
      mediaType: 'text/plain',
      bytes: Buffer.from('outside')
    })).toThrow('Hermes 会话不属于当前项目');

    expect(() => f.service.upload({
      projectId: f.project.id,
      conversationId: f.conversation.conversationId,
      name: 'too-large.bin',
      mediaType: 'application/octet-stream',
      bytes: Buffer.alloc(HERMES_ATTACHMENT_MAX_BYTES + 1)
    })).toThrow('附件不能超过 32 MiB');

    const uploaded = f.service.upload({
      projectId: f.project.id,
      conversationId: f.conversation.conversationId,
      name: 'contract.txt',
      mediaType: 'text/plain',
      bytes: Buffer.from('original')
    });
    writeFileSync(join(f.workspace, uploaded.relativePath), 'changed');
    expect(() => f.service.read(f.project.id, uploaded.id)).toThrow('附件校验失败');
    expect(() => f.service.promptContext(f.project.id, f.conversation.conversationId, ['invalid']))
      .toThrow('附件清单无效');
  });
});
