import { createHash, randomUUID } from 'node:crypto';
import type { Database } from './database.js';

export const LOCAL_DESKTOP_ORGANIZATION_ID = 'org-local';
export const LOCAL_DESKTOP_PRINCIPAL_ID = 'principal-local-admin';

export interface DesktopIngressInput {
  agentId: string;
  message: string;
  conversationId?: string;
  messageKey?: string;
  receivedAt?: number;
}

export interface DesktopIngressResult {
  organizationId: typeof LOCAL_DESKTOP_ORGANIZATION_ID;
  principalId: typeof LOCAL_DESKTOP_PRINCIPAL_ID;
  conversationId: string;
  inputMessageId: string;
  messageKey: string;
  taskId: string | null;
  deduplicated: boolean;
}

interface ConversationRow {
  id: string;
  agent_id: string;
  organization_id: string | null;
  principal_id: string | null;
}

function required(value: string | undefined, field: string, max: number): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) throw new Error(`${field} is required`);
  if (normalized.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return normalized;
}

function digest(namespace: string, values: string[]): string {
  const encoded = values.map((value) => `${Buffer.byteLength(value, 'utf8')}:${value}`).join('|');
  return createHash('sha256').update(`${namespace}|${encoded}`, 'utf8').digest('hex');
}

function messageIdentity(conversationId: string, messageKey: string): { id: string; dedupeKey: string } {
  const hash = digest('desktop-message', [
    LOCAL_DESKTOP_ORGANIZATION_ID,
    LOCAL_DESKTOP_PRINCIPAL_ID,
    conversationId,
    messageKey
  ]);
  return { id: `message-${hash.slice(0, 32)}`, dedupeKey: `desktop-message:${hash}` };
}

/** Canonical identity/conversation/message ingress for the local desktop UI. */
export class DesktopIngressService {
  constructor(private readonly db: Database) {}

  ingest(input: DesktopIngressInput): DesktopIngressResult {
    const agentId = required(input.agentId, 'agentId', 200);
    const message = required(input.message, 'message', 1_000_000);
    const messageKey = required(input.messageKey ?? randomUUID(), 'messageKey', 200);
    const now = input.receivedAt ?? Date.now();
    let result: DesktopIngressResult | null = null;

    this.db.transaction(() => {
      this.ensureIdentity(now);
      this.assertLocalAgent(agentId);
      if (!input.conversationId?.trim()) {
        const replay = this.db.raw.prepare(
          `SELECT m.id, m.task_id, m.content, m.conversation_id, c.agent_id
           FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE m.organization_id = ? AND m.principal_id = ?
             AND m.channel_id IS NULL AND m.direction = 'inbound'
             AND m.external_message_key = ?
           LIMIT 1`
        ).get(
          LOCAL_DESKTOP_ORGANIZATION_ID,
          LOCAL_DESKTOP_PRINCIPAL_ID,
          messageKey
        ) as {
          id: string;
          task_id: string | null;
          content: string;
          conversation_id: string;
          agent_id: string;
        } | undefined;
        if (replay) {
          if (replay.agent_id !== agentId || replay.content !== message) {
            throw new Error('messageKey is already bound to a different desktop request');
          }
          result = {
            organizationId: LOCAL_DESKTOP_ORGANIZATION_ID,
            principalId: LOCAL_DESKTOP_PRINCIPAL_ID,
            conversationId: replay.conversation_id,
            inputMessageId: replay.id,
            messageKey,
            taskId: replay.task_id,
            deduplicated: true
          };
          return;
        }
      }
      const conversationId = this.resolveConversation(agentId, input.conversationId, message, now);
      const identity = messageIdentity(conversationId, messageKey);
      const existing = this.db.raw.prepare(
        `SELECT id, task_id, content FROM messages
         WHERE id = ? AND organization_id = ? AND principal_id = ?
           AND conversation_id = ? AND direction = 'inbound' LIMIT 1`
      ).get(
        identity.id,
        LOCAL_DESKTOP_ORGANIZATION_ID,
        LOCAL_DESKTOP_PRINCIPAL_ID,
        conversationId
      ) as { id: string; task_id: string | null; content: string } | undefined;
      if (existing) {
        if (existing.content !== message) throw new Error('messageKey is already bound to different content');
        result = {
          organizationId: LOCAL_DESKTOP_ORGANIZATION_ID,
          principalId: LOCAL_DESKTOP_PRINCIPAL_ID,
          conversationId,
          inputMessageId: existing.id,
          messageKey,
          taskId: existing.task_id,
          deduplicated: true
        };
        return;
      }

      const inserted = this.db.raw.prepare(
        `INSERT INTO messages(
          id, organization_id, principal_id, conversation_id, channel_id, channel_identity_id,
          external_message_key, dedupe_key, direction, role, content, task_id, metadata_json, created_at
        ) VALUES(?, ?, ?, ?, NULL, NULL, ?, ?, 'inbound', 'user', ?, NULL, '{}', ?)
        ON CONFLICT DO NOTHING`
      ).run(
        identity.id,
        LOCAL_DESKTOP_ORGANIZATION_ID,
        LOCAL_DESKTOP_PRINCIPAL_ID,
        conversationId,
        messageKey,
        identity.dedupeKey,
        message,
        now
      ).changes > 0;
      const persisted = this.db.raw.prepare(
        `SELECT id, task_id FROM messages
         WHERE id = ? AND organization_id = ? AND principal_id = ?
           AND conversation_id = ? AND direction = 'inbound' LIMIT 1`
      ).get(
        identity.id,
        LOCAL_DESKTOP_ORGANIZATION_ID,
        LOCAL_DESKTOP_PRINCIPAL_ID,
        conversationId
      ) as { id: string; task_id: string | null } | undefined;
      if (!persisted) throw new Error('desktop message identity conflicted with existing data');
      if (inserted) {
        this.db.raw.prepare(
          `UPDATE conversations
           SET last_message_at = ?, message_count = message_count + 1, updated_at = ?
           WHERE id = ? AND organization_id = ? AND principal_id = ?`
        ).run(now, now, conversationId, LOCAL_DESKTOP_ORGANIZATION_ID, LOCAL_DESKTOP_PRINCIPAL_ID);
      }
      result = {
        organizationId: LOCAL_DESKTOP_ORGANIZATION_ID,
        principalId: LOCAL_DESKTOP_PRINCIPAL_ID,
        conversationId,
        inputMessageId: persisted.id,
        messageKey,
        taskId: persisted.task_id,
        deduplicated: !inserted
      };
    });

    if (!result) throw new Error('desktop ingress persistence failed');
    return result;
  }

  linkTask(input: DesktopIngressResult, taskId: string): void {
    const normalizedTaskId = required(taskId, 'taskId', 200);
    this.db.raw.prepare(
      `UPDATE messages SET task_id = ?
       WHERE id = ? AND organization_id = ? AND principal_id = ? AND conversation_id = ?
         AND direction = 'inbound' AND (task_id IS NULL OR task_id = ?)`
    ).run(
      normalizedTaskId,
      input.inputMessageId,
      input.organizationId,
      input.principalId,
      input.conversationId,
      normalizedTaskId
    );
    const linked = this.db.raw.prepare(
      `SELECT task_id FROM messages
       WHERE id = ? AND organization_id = ? AND principal_id = ? AND conversation_id = ? LIMIT 1`
    ).get(
      input.inputMessageId,
      input.organizationId,
      input.principalId,
      input.conversationId
    ) as { task_id: string | null } | undefined;
    if (linked?.task_id !== normalizedTaskId) throw new Error('desktop message is already linked to another task');
  }

  recordTaskOutcome(taskId: string): void {
    const task = this.db.raw.prepare(
      `SELECT t.id, t.conversation_id, t.status, t.result, t.error,
              c.organization_id, c.principal_id
       FROM tasks t JOIN conversations c ON c.id = t.conversation_id
       WHERE t.id = ? AND t.source IN ('desktop', 'voice', 'webhook')
         AND t.conversation_id IS NOT NULL LIMIT 1`
    ).get(taskId) as {
      id: string;
      conversation_id: string;
      status: string;
      result: string | null;
      error: string | null;
      organization_id: string | null;
      principal_id: string | null;
    } | undefined;
    if (!task || task.organization_id !== LOCAL_DESKTOP_ORGANIZATION_ID || task.principal_id !== LOCAL_DESKTOP_PRINCIPAL_ID) return;
    const content = task.status === 'COMPLETED'
      ? task.result?.trim() || '任务已完成。'
      : task.status === 'CANCELLED'
        ? '任务已取消。'
        : `任务未完成（${task.status}）：${task.error?.trim() || '无错误信息'}`;
    const key = `task:${task.id}:terminal`;
    const identity = messageIdentity(task.conversation_id, key);
    const now = Date.now();
    const inserted = this.db.raw.prepare(
      `INSERT INTO messages(
        id, organization_id, principal_id, conversation_id, channel_id, channel_identity_id,
        external_message_key, dedupe_key, direction, role, content, task_id, metadata_json, created_at
      ) VALUES(?, ?, ?, ?, NULL, NULL, ?, ?, 'outbound', 'assistant', ?, ?, ?, ?)
      ON CONFLICT DO NOTHING`
    ).run(
      identity.id,
      LOCAL_DESKTOP_ORGANIZATION_ID,
      LOCAL_DESKTOP_PRINCIPAL_ID,
      task.conversation_id,
      key,
      identity.dedupeKey,
      content,
      task.id,
      JSON.stringify({ status: task.status }),
      now
    ).changes > 0;
    if (inserted) {
      this.db.raw.prepare(
        `UPDATE conversations SET last_message_at = ?, message_count = message_count + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND principal_id = ?`
      ).run(now, now, task.conversation_id, LOCAL_DESKTOP_ORGANIZATION_ID, LOCAL_DESKTOP_PRINCIPAL_ID);
    }
  }

  private ensureIdentity(now: number): void {
    this.db.raw.prepare(
      `INSERT INTO organizations(id, slug, name, created_at, updated_at)
       VALUES(?, 'local', '本地组织', ?, ?) ON CONFLICT DO NOTHING`
    ).run(LOCAL_DESKTOP_ORGANIZATION_ID, now, now);
    this.db.raw.prepare(
      `INSERT INTO principals(id, organization_id, kind, display_name, created_at, updated_at)
       VALUES(?, ?, 'person', '本地管理员', ?, ?) ON CONFLICT DO NOTHING`
    ).run(LOCAL_DESKTOP_PRINCIPAL_ID, LOCAL_DESKTOP_ORGANIZATION_ID, now, now);
  }

  private assertLocalAgent(agentId: string): void {
    const agent = this.db.raw.prepare(
      'SELECT organization_id, archived FROM agents WHERE id = ? LIMIT 1'
    ).get(agentId) as { organization_id: string; archived: number } | undefined;
    if (!agent || agent.organization_id !== LOCAL_DESKTOP_ORGANIZATION_ID || agent.archived !== 0) {
      throw new Error('agent does not belong to the local organization or is archived');
    }
  }

  private resolveConversation(agentId: string, requestedId: string | undefined, message: string, now: number): string {
    const existingId = requestedId?.trim() ?? '';
    if (!existingId) {
      const id = randomUUID();
      this.db.raw.prepare(
        `INSERT INTO conversations(
          id, agent_id, organization_id, principal_id, channel_id, channel_identity_id,
          external_conversation_key, title, last_message_at, message_count, created_at, updated_at
        ) VALUES(?, ?, ?, ?, NULL, NULL, NULL, ?, ?, 0, ?, ?)`
      ).run(
        id,
        agentId,
        LOCAL_DESKTOP_ORGANIZATION_ID,
        LOCAL_DESKTOP_PRINCIPAL_ID,
        message.slice(0, 60),
        now,
        now,
        now
      );
      return id;
    }

    const id = required(existingId, 'conversationId', 200);
    const row = this.db.raw.prepare(
      'SELECT id, agent_id, organization_id, principal_id FROM conversations WHERE id = ? LIMIT 1'
    ).get(id) as ConversationRow | undefined;
    if (!row) throw new Error('会话不存在');
    if (row.agent_id !== agentId) throw new Error('会话不属于所选数字员工');
    if (row.organization_id && row.organization_id !== LOCAL_DESKTOP_ORGANIZATION_ID) throw new Error('会话不属于本地组织');
    if (row.principal_id && row.principal_id !== LOCAL_DESKTOP_PRINCIPAL_ID) throw new Error('会话不属于当前用户');
    this.db.raw.prepare(
      `UPDATE conversations SET organization_id = ?, principal_id = ?, updated_at = ?
       WHERE id = ? AND (organization_id IS NULL OR organization_id = ?)
         AND (principal_id IS NULL OR principal_id = ?)`
    ).run(
      LOCAL_DESKTOP_ORGANIZATION_ID,
      LOCAL_DESKTOP_PRINCIPAL_ID,
      now,
      id,
      LOCAL_DESKTOP_ORGANIZATION_ID,
      LOCAL_DESKTOP_PRINCIPAL_ID
    );
    return id;
  }
}
