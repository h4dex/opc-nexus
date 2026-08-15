// @ts-nocheck
import { describe, expect, it } from 'vitest';
import {
  ChannelIngressService,
  buildChannelMessageDedupeKey
} from '../src/main/services/channelIngressService.js';
import { ChannelManager } from '../src/main/services/channelManager.js';
import { createMockDb } from './helpers/mockDb.js';

function tenantDb() {
  const db = createMockDb();
  db.tables.organizations.set('tenant-a', { id: 'tenant-a', slug: 'org-a' });
  db.tables.organizations.set('tenant-b', { id: 'tenant-b', slug: 'org-b' });
  db.tables.channels.set('ch-weixin', { id: 'ch-weixin', organization_id: 'tenant-a' });
  db.tables.channels.set('ch-feishu', { id: 'ch-feishu', organization_id: 'tenant-a' });
  db.tables.channels.set('ch-weixin-b', { id: 'ch-weixin-b', organization_id: 'tenant-b' });
  db.tables.agents.set('agent-1', { id: 'agent-1', organization_id: 'tenant-a', archived: 0 });
  db.tables.agents.set('agent-b', { id: 'agent-b', organization_id: 'tenant-b', archived: 0 });
  db.tables.agents.set('agent-archived', { id: 'agent-archived', organization_id: 'tenant-a', archived: 1 });
  return db;
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    organizationKey: 'org-a',
    channelId: 'ch-weixin',
    agentId: 'agent-1',
    externalIdentity: 'user-1',
    conversationKey: 'direct:user-1',
    messageKey: 'message-1',
    text: '整理客户反馈',
    receivedAt: 1_700_000_000_000,
    ...overrides
  };
}

describe('ChannelIngressService', () => {
  it('deduplicates identical ingress and recovers its linked task', () => {
    const db = tenantDb();
    const service = new ChannelIngressService(db as never);

    const first = service.ingest(input());
    expect(first.deduplicated).toBe(false);
    expect(first.taskId).toBeNull();
    service.linkTask(first, 'task-1');

    const replay = service.ingest(input());
    expect(replay).toMatchObject({
      messageId: first.messageId,
      conversationId: first.conversationId,
      dedupeKey: first.dedupeKey,
      taskId: 'task-1',
      deduplicated: true
    });
    expect(db.tables.messages.size).toBe(1);
    expect(db.tables.conversations.get(first.conversationId)?.message_count).toBe(1);
  });

  it('scopes the same external message key by organization, channel, identity, and conversation', () => {
    const db = tenantDb();
    const service = new ChannelIngressService(db as never);
    const variants = [
      input(),
      input({ organizationKey: 'org-b', channelId: 'ch-weixin-b', agentId: 'agent-b' }),
      input({ channelId: 'ch-feishu' }),
      input({ externalIdentity: 'user-2' }),
      input({ conversationKey: 'group:finance' })
    ];

    const results = variants.map((value) => service.ingest(value));
    expect(new Set(results.map((result) => result.messageId)).size).toBe(5);
    expect(new Set(results.map((result) => result.dedupeKey)).size).toBe(5);
    expect(db.tables.messages.size).toBe(5);
  });

  it('uses length-prefixed hashing so delimiter-like values cannot collide', () => {
    const common = {
      organizationKey: 'org',
      channelId: 'channel',
      direction: 'inbound' as const,
      messageKey: 'message'
    };
    const left = buildChannelMessageDedupeKey({
      ...common,
      externalIdentity: 'a|1:b',
      conversationKey: 'c'
    });
    const right = buildChannelMessageDedupeKey({
      ...common,
      externalIdentity: 'a',
      conversationKey: '1:b|c'
    });
    expect(left).not.toBe(right);
  });

  it('persists outbound terminal replies idempotently', () => {
    const db = tenantDb();
    const service = new ChannelIngressService(db as never);
    const context = service.ingest(input());

    const firstId = service.recordOutbound(context, {
      messageKey: 'task:task-1:completed',
      content: '任务完成',
      taskId: 'task-1'
    });
    const replayId = service.recordOutbound(context, {
      messageKey: 'task:task-1:completed',
      content: '任务完成',
      taskId: 'task-1'
    });

    expect(replayId).toBe(firstId);
    expect([...db.tables.messages.values()].filter((row) => row.direction === 'outbound')).toHaveLength(1);
    expect(db.tables.conversations.get(context.conversationId)?.message_count).toBe(2);
  });

  it('stores long canonical content without task-title truncation leaking into the message', () => {
    const db = tenantDb();
    const service = new ChannelIngressService(db as never);
    const text = `${'长消息正文'.repeat(12_000)}END`;

    const result = service.ingest(input({ text }));

    expect(db.tables.messages.get(result.messageId)?.content).toBe(text);
    expect(db.tables.conversations.get(result.conversationId)?.title).toBe(text.slice(0, 60));
  });

  it('rejects cross-organization or archived routing targets before creating identities', () => {
    const db = tenantDb();
    const service = new ChannelIngressService(db as never);

    expect(() => service.ingest(input({ channelId: 'ch-weixin-b' })))
      .toThrow('channel does not belong to organization');
    expect(() => service.ingest(input({ agentId: 'agent-b' })))
      .toThrow('agent does not belong to organization or is archived');
    expect(() => service.ingest(input({ agentId: 'agent-archived' })))
      .toThrow('agent does not belong to organization or is archived');
    expect(db.tables.principals.size).toBe(0);
    expect(db.tables.channel_identities.size).toBe(0);
    expect(db.tables.conversations.size).toBe(0);
    expect(db.tables.messages.size).toBe(0);
  });
});

describe('ChannelManager tenant boundary', () => {
  it('binds only channels and active agents from the same organization', () => {
    const db = tenantDb();
    const manager = new ChannelManager(db as never);

    manager.bindAgent('ch-weixin', 'agent-1');
    manager.bindAgent('ch-weixin', 'agent-1');
    expect(db.tables.channel_routes.size).toBe(1);
    expect(() => manager.bindAgent('ch-weixin', 'agent-b'))
      .toThrow('渠道和数字员工必须属于同一组织');
    expect(() => manager.bindAgent('ch-weixin', 'agent-archived'))
      .toThrow('数字员工不存在或已归档');
    expect(db.tables.channel_routes.size).toBe(1);
  });
});
