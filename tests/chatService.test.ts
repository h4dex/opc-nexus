import { describe, expect, it, vi } from 'vitest';
import { ChatService } from '../src/main/services/chatService.js';

function fakeDb(conversation: Record<string, unknown> | undefined, messages: Record<string, unknown>[]) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    raw: {
      prepare: (sql: string) => ({
        get: (...args: unknown[]) => {
          calls.push({ sql, args });
          return conversation;
        },
        all: (...args: unknown[]) => {
          calls.push({ sql, args });
          return messages;
        }
      })
    }
  };
  return { db: db as never, calls };
}

const baseConversation = {
  id: 'conv-1', agent_id: 'agent-1', organization_id: 'org-local', principal_id: 'principal-local-admin',
  project_id: 'project-1',
  channel_id: null, channel_identity_id: null, external_conversation_key: null,
  title: '测试会话', last_message_at: 30, message_count: 3, created_at: 1, updated_at: 30
};

describe('ChatService canonical timeline', () => {
  it('returns a bounded chronological page and a keyset cursor', () => {
    const { db, calls } = fakeDb(baseConversation, [
      { id: 'm-3', conversation_id: 'conv-1', direction: 'outbound', role: 'assistant', content: 'third', task_id: 'task-3', created_at: 30 },
      { id: 'm-2', conversation_id: 'conv-1', direction: 'inbound', role: 'user', content: 'second', task_id: null, created_at: 20 },
      { id: 'm-1', conversation_id: 'conv-1', direction: 'inbound', role: 'user', content: 'first', task_id: null, created_at: 10 }
    ]);
    const service = new ChatService(db);
    const page = service.getTimeline({ agentId: 'agent-1', conversationId: 'conv-1', limit: 2 });

    expect(page.messages.map((message) => message.id)).toEqual(['m-2', 'm-3']);
    expect(page.conversation.projectId).toBe('project-1');
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual({ createdAt: 20, id: 'm-2' });
    expect(calls[1]?.args).toEqual(['conv-1', 'org-local', 'principal-local-admin', 3]);
  });

  it('rejects a conversation outside the requested employee or tenant', () => {
    const { db } = fakeDb(undefined, []);
    const service = new ChatService(db);
    expect(() => service.getTimeline({ agentId: 'agent-2', conversationId: 'conv-1' })).toThrow('会话不存在或无权访问');
  });

  it('normalizes unknown roles and bounds oversized message content', () => {
    const long = 'x'.repeat(200_001);
    const { db } = fakeDb(baseConversation, [
      { id: 'm-1', conversation_id: 'conv-1', direction: 'outbound', role: 'provider-secret', content: long, task_id: null, created_at: 1 }
    ]);
    const page = new ChatService(db).getTimeline({ agentId: 'agent-1', conversationId: 'conv-1' });
    expect(page.messages[0]).toMatchObject({ role: 'system', truncated: true });
    expect(page.messages[0]?.content.length).toBeLessThanOrEqual(200_020);
  });

  it('rejects malformed cursors before issuing a message query', () => {
    const { db, calls } = fakeDb(baseConversation, []);
    expect(() => new ChatService(db).getTimeline({
      agentId: 'agent-1', conversationId: 'conv-1', cursor: { createdAt: -1, id: 'm-1' }
    })).toThrow(/timestamp/);
    expect(calls).toHaveLength(0);
  });
});
