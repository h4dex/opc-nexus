import { describe, expect, it, vi } from 'vitest';
import { HermesConversationContext } from '../src/main/services/hermesConversationContext.js';

function contextFor(row: Record<string, unknown> | undefined) {
  const get = vi.fn(() => row);
  const db = { raw: { prepare: vi.fn(() => ({ get })) } };
  return { context: new HermesConversationContext(db as never), get };
}

describe('Hermes Quest conversation identity', () => {
  it('keeps a scheduler conversation identified as Hermes rather than a retired scheduler or worker', () => {
    const { context } = contextFor({
      conversation_id: 'hermes-conversation-main', employee_id: null, agent_id: null
    });

    const message = context.resolve('project-1', 'hermes-conversation-main');

    expect(message).toContain('You are Hermes, the OPC-Nexus AI dispatcher');
    expect(message).toContain('Never identify yourself as a retired scheduler, a selected worker');
    expect(message).toContain('Employee @mentions are delegation targets only');
  });

  it('pins each employee identity and memory policy across turns without treating mentions as identity changes', () => {
    const { context } = contextFor({
      conversation_id: 'hermes-conversation-backend',
      employee_id: 'agent-backend',
      agent_id: 'agent-backend',
      name: '后端工程师',
      role: '后端开发助手',
      system_prompt: '你负责后端架构、接口实现和数据库迁移。',
      memory_mode: 'long_term',
      soul_md: '只报告真实执行结果。',
      agents_md: '先验证，再交付。',
      user_md: '老板偏好简洁说明。'
    });

    const message = context.resolve('project-1', 'hermes-conversation-backend');

    expect(message).toContain('named "后端工程师" with role "后端开发助手"');
    expect(message).toContain('identity remains "后端工程师" on every turn');
    expect(message).toContain('@mentions are delegation targets only');
    expect(message).toContain('Long-term memory is enabled for this employee');
    expect(message).toContain('Employee system instructions:\n你负责后端架构、接口实现和数据库迁移。');
    expect(message).toContain('Employee soul:\n只报告真实执行结果。');
    expect(message).not.toContain('You are Hermes, the OPC-Nexus AI dispatcher');
  });

  it('blocks a removed employee instead of silently falling back to another identity', () => {
    const { context } = contextFor({
      conversation_id: 'hermes-conversation-removed',
      employee_id: 'agent-removed',
      agent_id: null
    });

    expect(() => context.resolve('project-1', 'hermes-conversation-removed'))
      .toThrow('no longer available');
  });
});
