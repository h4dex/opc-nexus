import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { HermesConversationAttachment } from '../../shared/types.js';
import type { Database } from './database.js';

const MAX_BYTES = 32 * 1024 * 1024;
const SAFE_ID = /^hermes-conversation-[A-Za-z0-9-]{8,100}$/;
const SAFE_ATTACHMENT_ID = /^hermes-attachment-[A-Za-z0-9-]{8,100}$/;

export interface HermesAttachmentUpload {
  projectId: string;
  conversationId: string;
  name: string;
  mediaType: string;
  bytes: Buffer;
}

export interface HermesAttachmentRead {
  attachment: HermesConversationAttachment;
  bytes: Buffer;
  contentType: string;
  disposition: 'inline' | 'attachment';
}

interface AttachmentRow {
  id: string;
  project_id: string;
  conversation_id: string;
  original_name: string;
  media_type: string;
  size: number;
  sha256: string;
  relative_path: string;
  created_at: number;
}

function safeName(value: string): string {
  const name = basename(value.trim()).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || name === '.' || name === '..' || name.length > 180) throw new Error('附件文件名无效');
  return name;
}

function safeMime(value: string): string {
  const mime = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;[^\r\n]*)?$/i.test(mime)
    ? mime.slice(0, 160)
    : 'application/octet-stream';
}

function assertRegularDirectory(path: string, label: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} 不是安全目录`);
}

function assertContained(root: string, path: string): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const rel = relative(resolvedRoot, resolvedPath);
  if (!rel || rel.startsWith('..') || rel.includes(':') || resolve(resolvedRoot, rel) !== resolvedPath) {
    throw new Error('附件路径越界');
  }
}

function dispositionFor(mime: string): 'inline' | 'attachment' {
  return mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/')
    || mime === 'application/pdf' || mime.startsWith('text/') ? 'inline' : 'attachment';
}

/** Main-owned project attachment storage. Every path is checked before use. */
export class HermesConversationAttachmentService {
  constructor(
    private readonly db: Database,
    private readonly resolveWorkspace: (projectId: string) => string | null,
    private readonly now: () => number = Date.now
  ) {
    this.db.raw.prepare(`
      CREATE TABLE IF NOT EXISTS hermes_conversation_attachments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `).run();
    this.db.raw.prepare(`
      CREATE INDEX IF NOT EXISTS idx_hermes_conversation_attachments_scope
      ON hermes_conversation_attachments(project_id, conversation_id, created_at)
    `).run();
  }

  upload(input: HermesAttachmentUpload): HermesConversationAttachment {
    if (!SAFE_ID.test(input.conversationId)) throw new Error('Hermes 会话标识无效');
    if (!Buffer.isBuffer(input.bytes) || input.bytes.length === 0) throw new Error('附件内容为空');
    if (input.bytes.length > MAX_BYTES) throw new Error('附件不能超过 32 MiB');
    const conversation = this.db.raw.prepare(
      'SELECT id FROM conversations WHERE id = ? AND project_id = ?'
    ).get(input.conversationId, input.projectId) as { id?: string } | undefined;
    if (conversation?.id !== input.conversationId) throw new Error('Hermes 会话不属于当前项目');
    const workspace = this.requireWorkspace(input.projectId);
    const name = safeName(input.name);
    const mediaType = safeMime(input.mediaType);
    const attachmentId = `hermes-attachment-${randomUUID()}`;
    const dir = join(workspace, '.opc-nexus', 'attachments', input.conversationId);
    assertContained(workspace, dir);
    assertRegularDirectory(join(workspace, '.opc-nexus'), '项目附件根目录');
    assertRegularDirectory(join(workspace, '.opc-nexus', 'attachments'), '项目附件目录');
    assertRegularDirectory(dir, '会话附件目录');
    const storedName = `${attachmentId}_${name}`;
    const target = join(dir, storedName);
    assertContained(workspace, target);
    const relativePath = relative(workspace, target).replaceAll('\\', '/');
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const now = this.now();
    const temporary = join(dir, `.${storedName}.${randomUUID()}.upload`);
    try {
      writeFileSync(temporary, input.bytes, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, target);
      this.db.raw.prepare(`
        INSERT INTO hermes_conversation_attachments
          (id, project_id, conversation_id, original_name, media_type, size, sha256, relative_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(attachmentId, input.projectId, input.conversationId, name, mediaType, input.bytes.length, sha256, relativePath, now);
    } catch (error) {
      try { rmSync(temporary, { force: true }); } catch { /* best effort cleanup */ }
      try { rmSync(target, { force: true }); } catch { /* best effort cleanup */ }
      throw error;
    }
    return this.toView({
      id: attachmentId, project_id: input.projectId, conversation_id: input.conversationId,
      original_name: name, media_type: mediaType, size: input.bytes.length, sha256,
      relative_path: relativePath, created_at: now
    });
  }

  read(projectId: string, attachmentId: string): HermesAttachmentRead {
    if (!SAFE_ATTACHMENT_ID.test(attachmentId)) throw new Error('Hermes 附件标识无效');
    const row = this.db.raw.prepare(`
      SELECT * FROM hermes_conversation_attachments WHERE id = ? AND project_id = ?
    `).get(attachmentId, projectId) as AttachmentRow | undefined;
    if (!row) throw new Error('附件不存在或不属于当前项目');
    const workspace = this.requireWorkspace(projectId);
    const target = resolve(workspace, row.relative_path);
    assertContained(workspace, target);
    let stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('附件文件不安全');
    const bytes = readFileSync(target);
    if (bytes.length !== row.size || createHash('sha256').update(bytes).digest('hex') !== row.sha256) {
      throw new Error('附件校验失败，文件可能已被修改');
    }
    return {
      attachment: this.toView(row),
      bytes,
      contentType: safeMime(row.media_type),
      disposition: dispositionFor(row.media_type)
    };
  }

  list(projectId: string, conversationId: string): HermesConversationAttachment[] {
    return (this.db.raw.prepare(`
      SELECT * FROM hermes_conversation_attachments WHERE project_id = ? AND conversation_id = ? ORDER BY created_at, id
    `).all(projectId, conversationId) as unknown as AttachmentRow[]).map((row) => this.toView(row));
  }

  promptContext(projectId: string, conversationId: string, ids: unknown): { attachments: HermesConversationAttachment[]; systemMessage: string } {
    if (!Array.isArray(ids) || ids.length === 0) return { attachments: [], systemMessage: '' };
    const normalized = ids.filter((id): id is string => typeof id === 'string' && SAFE_ATTACHMENT_ID.test(id)).slice(0, 16);
    if (normalized.length !== ids.length) throw new Error('附件清单无效');
    const rows = normalized.map((id) => this.db.raw.prepare(`
      SELECT * FROM hermes_conversation_attachments WHERE id = ? AND project_id = ? AND conversation_id = ?
    `).get(id, projectId, conversationId) as AttachmentRow | undefined);
    if (rows.some((row) => !row)) throw new Error('附件不属于当前 Hermes 会话');
    const attachments = rows.filter((row): row is AttachmentRow => Boolean(row)).map((row) => this.toView(row));
    const workspace = this.requireWorkspace(projectId);
    const paths = rows.map((row) => resolve(workspace, row!.relative_path));
    paths.forEach((path) => assertContained(workspace, path));
    return {
      attachments,
      systemMessage: [
        'The owner attached the following real files to this turn. Read them from the exact paths when your tools support it.',
        ...rows.map((row, index) => `- ${row!.original_name} (${row!.media_type}, ${row!.size} bytes, sha256 ${row!.sha256}): ${paths[index]}`)
      ].join('\n')
    };
  }

  private requireWorkspace(projectId: string): string {
    const workspace = this.resolveWorkspace(projectId)?.trim() ?? '';
    if (!workspace) throw new Error('请先为项目选择工作目录，才能上传附件');
    const resolved = resolve(workspace);
    assertRegularDirectory(resolved, '项目工作目录');
    return resolved;
  }

  private toView(row: AttachmentRow): HermesConversationAttachment {
    return {
      id: row.id,
      projectId: row.project_id,
      conversationId: row.conversation_id,
      name: row.original_name,
      mediaType: row.media_type,
      size: Number(row.size),
      sha256: row.sha256,
      relativePath: row.relative_path,
      url: `/__opc_nexus/project/attachments/${encodeURIComponent(row.id)}`,
      createdAt: Number(row.created_at)
    };
  }
}

export { MAX_BYTES as HERMES_ATTACHMENT_MAX_BYTES };
