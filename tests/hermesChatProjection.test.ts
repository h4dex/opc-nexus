import { describe, expect, it } from 'vitest';
import {
  projectHermesChatMessages,
  safeHermesActivityDetail
} from '../src/main/services/hermesChatProjection.js';

describe('Hermes chat Renderer projection', () => {
  it('projects tool calls and results as structured activities while redacting credentials', () => {
    const messages = projectHermesChatMessages([
      {
        id: 'assistant-1', role: 'assistant', content: '', reasoning_content: 'private chain of thought',
        tool_calls: [{ function: { name: 'web_search', arguments: JSON.stringify({ query: 'OPC Nexus', apiKey: 'sk-not-for-renderer-123456' }) } }],
        timestamp: 1_700_000_000
      },
      {
        id: 'tool-1', role: 'tool', tool_name: 'web_search',
        content: 'Authorization: Bearer abcdefghijklmnop\n{"items":[1,2]}', timestamp: 1_700_000_001
      }
    ], 'session-1');

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'assistant', content: '' });
    expect(messages[0]?.activities.map((item) => item.kind)).toEqual(['reasoning', 'tool_call']);
    expect(messages[0]?.activities[0]?.detail).not.toContain('private chain of thought');
    expect(JSON.stringify(messages)).not.toContain('sk-not-for-renderer');
    expect(JSON.stringify(messages)).not.toContain('abcdefghijklmnop');
    expect(JSON.stringify(messages)).toContain('[REDACTED]');
  });

  it('never exposes system prompt content and keeps ordinary owner/assistant messages visible', () => {
    const messages = projectHermesChatMessages([
      { role: 'system', content: 'secret project policy' },
      { role: 'user', content: '检查官网' },
      { role: 'assistant', content: '已经完成检查。' }
    ], 'session-2');

    expect(messages[0]).toMatchObject({ role: 'system', content: '' });
    expect(messages[0]?.activities[0]?.title).toBe('系统上下文已应用');
    expect(JSON.stringify(messages)).not.toContain('secret project policy');
    expect(messages.slice(1).map((item) => item.content)).toEqual(['检查官网', '已经完成检查。']);
  });

  it('bounds deeply nested execution details', () => {
    const detail = safeHermesActivityDetail({ password: 'not-visible', output: 'x'.repeat(20_000) });
    expect(detail).toContain('[REDACTED]');
    expect(detail?.length).toBeLessThan(12_100);
    expect(detail).toContain('[TRUNCATED]');
  });
});
