import { createHash, randomUUID } from 'node:crypto';
import type { Database } from './database.js';

export const DEFAULT_ORGANIZATION_KEY = 'local';

export interface ChannelIngressInput {
  organizationKey?: string;
  organizationName?: string;
  channelId: string;
  agentId: string;
  externalIdentity: string;
  externalIdentityDisplayName?: string;
  conversationKey: string;
  messageKey?: string;
  text: string;
  metadata?: Record<string, unknown>;
  receivedAt?: number;
}

export interface ChannelConversationContext {
  organizationId: string;
  organizationKey: string;
  principalId: string;
  channelId: string;
  channelIdentityId: string;
  externalIdentity: string;
  conversationId: string;
  conversationKey: string;
}

export interface ChannelIngressResult extends ChannelConversationContext {
  messageId: string;
  messageKey: string;
  dedupeKey: string;
  taskId: string | null;
  deduplicated: boolean;
}

export interface ChannelOutboundMessageInput {
  messageKey: string;
  content: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
  createdAt?: number;
}

interface ScopedMessageRow {
  id: string;
  task_id: string | null;
}

const MAX_MESSAGE_CHARS = 1_000_000;

function required(value: string | undefined, label: string, maxLength = 1_000): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters`);
  return normalized;
}

function stableDigest(namespace: string, parts: string[]): string {
  const encoded = parts
    .map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`)
    .join('|');
  return createHash('sha256').update(`${namespace}|${encoded}`, 'utf8').digest('hex');
}

function stableId(prefix: string, parts: string[]): string {
  return `${prefix}-${stableDigest(prefix, parts).slice(0, 32)}`;
}

export function buildChannelMessageDedupeKey(input: {
  organizationKey: string;
  channelId: string;
  externalIdentity: string;
  conversationKey: string;
  direction: 'inbound' | 'outbound';
  messageKey: string;
}): string {
  return `channel-message:${stableDigest('channel-message', [
    input.organizationKey,
    input.channelId,
    input.externalIdentity,
    input.conversationKey,
    input.direction,
    input.messageKey
  ])}`;
}

function metadataJson(metadata: Record<string, unknown> | undefined): string {
  const encoded = JSON.stringify(metadata ?? {});
  if (encoded.length > 32_000) throw new Error('channel message metadata exceeds 32000 characters');
  return encoded;
}

/**
 * Resolves the durable identity -> conversation -> message chain for channel
 * traffic. Every lookup uses the complete tenant/channel/identity scope.
 */
export class ChannelIngressService {
  constructor(private readonly db: Database) {}

  ingest(input: ChannelIngressInput): ChannelIngressResult {
    const organizationKey = required(input.organizationKey ?? DEFAULT_ORGANIZATION_KEY, 'organizationKey', 200);
    const organizationName = input.organizationName?.trim() || (organizationKey === DEFAULT_ORGANIZATION_KEY ? 'Local organization' : organizationKey);
    const channelId = required(input.channelId, 'channelId', 200);
    const agentId = required(input.agentId, 'agentId', 200);
    const externalIdentity = required(input.externalIdentity, 'externalIdentity');
    const conversationKey = required(input.conversationKey, 'conversationKey');
    const messageKey = input.messageKey?.trim() || `generated:${randomUUID()}`;
    const text = required(input.text, 'text', MAX_MESSAGE_CHARS);
    const receivedAt = input.receivedAt ?? Date.now();
    const encodedMetadata = metadataJson(input.metadata);
    const dedupeKey = buildChannelMessageDedupeKey({
      organizationKey,
      channelId,
      externalIdentity,
      conversationKey,
      direction: 'inbound',
      messageKey
    });
    let result: ChannelIngressResult | null = null;

    this.db.transaction(() => {
      const organizationId = this.resolveOrganization(organizationKey, organizationName, receivedAt);
      this.assertOwnedRoute(organizationId, channelId, agentId);
      const identity = this.resolveIdentity({
        organizationId,
        channelId,
        externalIdentity,
        displayName: input.externalIdentityDisplayName?.trim() || '',
        metadataJson: encodedMetadata,
        now: receivedAt
      });
      const conversationId = this.resolveConversation({
        organizationId,
        principalId: identity.principalId,
        channelId,
        channelIdentityId: identity.channelIdentityId,
        externalConversationKey: conversationKey,
        agentId,
        title: text.slice(0, 60),
        now: receivedAt
      });
      const message = this.findMessage({
        organizationId,
        channelId,
        channelIdentityId: identity.channelIdentityId,
        conversationId,
        direction: 'inbound',
        externalMessageKey: messageKey
      });
      if (message) {
        result = {
          organizationId,
          organizationKey,
          principalId: identity.principalId,
          channelId,
          channelIdentityId: identity.channelIdentityId,
          externalIdentity,
          conversationId,
          conversationKey,
          messageId: message.id,
          messageKey,
          dedupeKey,
          taskId: message.task_id,
          deduplicated: true
        };
        return;
      }

      const messageId = stableId('message', [dedupeKey]);
      const inserted = this.db.raw.prepare(
        `INSERT INTO messages(
          id, organization_id, principal_id, conversation_id, channel_id, channel_identity_id,
          external_message_key, dedupe_key, direction, role, content, task_id, metadata_json, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'inbound', 'user', ?, NULL, ?, ?)
        ON CONFLICT DO NOTHING`
      ).run(
        messageId,
        organizationId,
        identity.principalId,
        conversationId,
        channelId,
        identity.channelIdentityId,
        messageKey,
        dedupeKey,
        text,
        encodedMetadata,
        receivedAt
      ).changes > 0;
      const persisted = this.findMessage({
        organizationId,
        channelId,
        channelIdentityId: identity.channelIdentityId,
        conversationId,
        direction: 'inbound',
        externalMessageKey: messageKey
      });
      if (!persisted) throw new Error('channel message scope conflicted with an existing dedupe key');
      if (inserted) {
        this.db.raw.prepare(
          `UPDATE conversations
           SET agent_id = ?, last_message_at = ?, message_count = message_count + 1, updated_at = ?
           WHERE id = ? AND organization_id = ? AND channel_id = ? AND channel_identity_id = ?`
        ).run(agentId, receivedAt, receivedAt, conversationId, organizationId, channelId, identity.channelIdentityId);
      }
      result = {
        organizationId,
        organizationKey,
        principalId: identity.principalId,
        channelId,
        channelIdentityId: identity.channelIdentityId,
        externalIdentity,
        conversationId,
        conversationKey,
        messageId: persisted.id,
        messageKey,
        dedupeKey,
        taskId: persisted.task_id,
        deduplicated: !inserted
      };
    });

    if (!result) throw new Error('channel ingress persistence failed');
    return result;
  }

  linkTask(context: ChannelIngressResult, taskId: string): void {
    const normalizedTaskId = required(taskId, 'taskId', 200);
    this.db.raw.prepare(
      `UPDATE messages SET task_id = ?
       WHERE id = ? AND organization_id = ? AND channel_id = ? AND channel_identity_id = ?
         AND conversation_id = ? AND (task_id IS NULL OR task_id = ?)`
    ).run(
      normalizedTaskId,
      context.messageId,
      context.organizationId,
      context.channelId,
      context.channelIdentityId,
      context.conversationId,
      normalizedTaskId
    );
    const linked = this.db.raw.prepare(
      `SELECT id, task_id FROM messages
       WHERE id = ? AND organization_id = ? AND channel_id = ? AND channel_identity_id = ?
         AND conversation_id = ? LIMIT 1`
    ).get(
      context.messageId,
      context.organizationId,
      context.channelId,
      context.channelIdentityId,
      context.conversationId
    ) as ScopedMessageRow | undefined;
    if (!linked || linked.task_id !== normalizedTaskId) {
      throw new Error('channel message is already linked to another task');
    }
  }

  recordOutbound(context: ChannelConversationContext, input: ChannelOutboundMessageInput): string {
    const messageKey = required(input.messageKey, 'messageKey');
    const content = required(input.content, 'content', MAX_MESSAGE_CHARS);
    const createdAt = input.createdAt ?? Date.now();
    const dedupeKey = buildChannelMessageDedupeKey({
      organizationKey: context.organizationKey,
      channelId: context.channelId,
      externalIdentity: context.externalIdentity,
      conversationKey: context.conversationKey,
      direction: 'outbound',
      messageKey
    });
    const existing = this.findMessage({
      organizationId: context.organizationId,
      channelId: context.channelId,
      channelIdentityId: context.channelIdentityId,
      conversationId: context.conversationId,
      direction: 'outbound',
      externalMessageKey: messageKey
    });
    if (existing) return existing.id;

    const messageId = stableId('message', [dedupeKey]);
    const inserted = this.db.raw.prepare(
      `INSERT INTO messages(
        id, organization_id, principal_id, conversation_id, channel_id, channel_identity_id,
        external_message_key, dedupe_key, direction, role, content, task_id, metadata_json, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'outbound', 'assistant', ?, ?, ?, ?)
      ON CONFLICT DO NOTHING`
    ).run(
      messageId,
      context.organizationId,
      context.principalId,
      context.conversationId,
      context.channelId,
      context.channelIdentityId,
      messageKey,
      dedupeKey,
      content,
      input.taskId ?? null,
      metadataJson(input.metadata),
      createdAt
    ).changes > 0;
    const persisted = this.findMessage({
      organizationId: context.organizationId,
      channelId: context.channelId,
      channelIdentityId: context.channelIdentityId,
      conversationId: context.conversationId,
      direction: 'outbound',
      externalMessageKey: messageKey
    });
    if (!persisted) throw new Error('outbound channel message persistence failed');
    if (inserted) {
      this.db.raw.prepare(
        `UPDATE conversations
         SET last_message_at = ?, message_count = message_count + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND channel_id = ? AND channel_identity_id = ?`
      ).run(
        createdAt,
        createdAt,
        context.conversationId,
        context.organizationId,
        context.channelId,
        context.channelIdentityId
      );
    }
    return persisted.id;
  }

  private resolveOrganization(slug: string, name: string, now: number): string {
    const proposedId = slug === DEFAULT_ORGANIZATION_KEY ? 'org-local' : stableId('organization', [slug]);
    this.db.raw.prepare(
      `INSERT INTO organizations(id, slug, name, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`
    ).run(proposedId, slug, name, now, now);
    const organization = this.db.raw.prepare(
      'SELECT id FROM organizations WHERE slug = ? LIMIT 1'
    ).get(slug) as { id: string } | undefined;
    if (!organization) throw new Error('organization resolution failed');
    return organization.id;
  }

  private assertOwnedRoute(organizationId: string, channelId: string, agentId: string): void {
    const channel = this.db.raw.prepare(
      'SELECT organization_id FROM channels WHERE id = ? LIMIT 1'
    ).get(channelId) as { organization_id: string } | undefined;
    if (!channel || channel.organization_id !== organizationId) {
      throw new Error('channel does not belong to organization');
    }

    const agent = this.db.raw.prepare(
      'SELECT organization_id, archived FROM agents WHERE id = ? LIMIT 1'
    ).get(agentId) as { organization_id: string; archived: number } | undefined;
    if (!agent || agent.organization_id !== organizationId || agent.archived !== 0) {
      throw new Error('agent does not belong to organization or is archived');
    }
  }

  private resolveIdentity(input: {
    organizationId: string;
    channelId: string;
    externalIdentity: string;
    displayName: string;
    metadataJson: string;
    now: number;
  }): { principalId: string; channelIdentityId: string } {
    const existing = this.db.raw.prepare(
      `SELECT id, principal_id FROM channel_identities
       WHERE organization_id = ? AND channel_id = ? AND external_identity_key = ? LIMIT 1`
    ).get(input.organizationId, input.channelId, input.externalIdentity) as
      | { id: string; principal_id: string }
      | undefined;
    if (existing) return { principalId: existing.principal_id, channelIdentityId: existing.id };

    const principalId = stableId('principal', [input.organizationId, input.channelId, input.externalIdentity]);
    const channelIdentityId = stableId('channel-identity', [input.organizationId, input.channelId, input.externalIdentity]);
    this.db.raw.prepare(
      `INSERT INTO principals(id, organization_id, kind, display_name, created_at, updated_at)
       VALUES(?, ?, 'person', ?, ?, ?) ON CONFLICT DO NOTHING`
    ).run(principalId, input.organizationId, input.displayName, input.now, input.now);
    this.db.raw.prepare(
      `INSERT INTO channel_identities(
        id, organization_id, channel_id, principal_id, external_identity_key,
        display_name, metadata_json, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`
    ).run(
      channelIdentityId,
      input.organizationId,
      input.channelId,
      principalId,
      input.externalIdentity,
      input.displayName,
      input.metadataJson,
      input.now,
      input.now
    );
    const persisted = this.db.raw.prepare(
      `SELECT id, principal_id FROM channel_identities
       WHERE organization_id = ? AND channel_id = ? AND external_identity_key = ? LIMIT 1`
    ).get(input.organizationId, input.channelId, input.externalIdentity) as
      | { id: string; principal_id: string }
      | undefined;
    if (!persisted) throw new Error('channel identity resolution failed');
    return { principalId: persisted.principal_id, channelIdentityId: persisted.id };
  }

  private resolveConversation(input: {
    organizationId: string;
    principalId: string;
    channelId: string;
    channelIdentityId: string;
    externalConversationKey: string;
    agentId: string;
    title: string;
    now: number;
  }): string {
    const existing = this.db.raw.prepare(
      `SELECT id FROM conversations
       WHERE organization_id = ? AND channel_id = ? AND channel_identity_id = ?
         AND external_conversation_key = ? LIMIT 1`
    ).get(
      input.organizationId,
      input.channelId,
      input.channelIdentityId,
      input.externalConversationKey
    ) as { id: string } | undefined;
    if (existing) return existing.id;

    const conversationId = stableId('conversation', [
      input.organizationId,
      input.channelId,
      input.channelIdentityId,
      input.externalConversationKey
    ]);
    this.db.raw.prepare(
      `INSERT INTO conversations(
        id, agent_id, organization_id, principal_id, channel_id, channel_identity_id,
        external_conversation_key, title, last_message_at, message_count, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?) ON CONFLICT DO NOTHING`
    ).run(
      conversationId,
      input.agentId,
      input.organizationId,
      input.principalId,
      input.channelId,
      input.channelIdentityId,
      input.externalConversationKey,
      input.title,
      input.now,
      input.now,
      input.now
    );
    const persisted = this.db.raw.prepare(
      `SELECT id FROM conversations
       WHERE organization_id = ? AND channel_id = ? AND channel_identity_id = ?
         AND external_conversation_key = ? LIMIT 1`
    ).get(
      input.organizationId,
      input.channelId,
      input.channelIdentityId,
      input.externalConversationKey
    ) as { id: string } | undefined;
    if (!persisted) throw new Error('channel conversation resolution failed');
    return persisted.id;
  }

  private findMessage(scope: {
    organizationId: string;
    channelId: string;
    channelIdentityId: string;
    conversationId: string;
    direction: 'inbound' | 'outbound';
    externalMessageKey: string;
  }): ScopedMessageRow | undefined {
    return this.db.raw.prepare(
      `SELECT id, task_id FROM messages
       WHERE organization_id = ? AND channel_id = ? AND channel_identity_id = ?
         AND conversation_id = ? AND direction = ? AND external_message_key = ? LIMIT 1`
    ).get(
      scope.organizationId,
      scope.channelId,
      scope.channelIdentityId,
      scope.conversationId,
      scope.direction,
      scope.externalMessageKey
    ) as ScopedMessageRow | undefined;
  }
}
