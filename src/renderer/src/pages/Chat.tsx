/** 对话聊天（Cherry Studio 风格）：左侧助手+会话列表，右侧消息流 + 输入框，流式输出 + Markdown 渲染 */
import { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import { useApp } from '../store';
import type { Conversation, Task, TaskEvent } from '@shared/types';

/** 轻量 Markdown 渲染（同步解析，输出 HTML） */
function Md({ text }: { text: string }) {
  const html = marked.parse(text, { async: false }) as string;
  return <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Chat() {
  const { snapshot } = useApp();
  const [agentId, setAgentId] = useState<string>('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<TaskEvent[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  if (!snapshot) return null;
  const { agentCards } = snapshot;
  const agents = agentCards.filter((c) => c.agent.lifecycle === 'READY');

  // 选中助手后加载会话列表
  useEffect(() => {
    if (!agentId) return;
    void window.aibox.listConversations(agentId).then(setConversations);
  }, [agentId, snapshot?.tasks.length]);

  // 选中会话后加载消息 + 流式订阅
  useEffect(() => {
    if (!convId) { setMessages([]); return; }
    const load = () => {
      const task = snapshot?.tasks.find((t) => t.sessionId === `conv-${convId}`);
      if (task) void window.aibox.getTaskEvents(task.id).then(setMessages);
    };
    load();
    // 流式输出订阅：实时追加 chunk
    const unsub = window.aibox.onTaskOutput(({ taskId, chunk }) => {
      const task = snapshot?.tasks.find((t) => t.sessionId === `conv-${convId}`);
      if (task && task.id === taskId) {
        setMessages((prev) => [...prev, { id: `stream-${Date.now()}`, taskId, eventType: 'output', payload: { chunk }, createdAt: Date.now() } as TaskEvent]);
      }
    });
    return () => { unsub(); };
  }, [convId, snapshot?.tasks]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.length]);

  const send = async () => {
    const text = input.trim();
    if (!text || !agentId || sending) return;
    setSending(true);
    setInput('');
    try {
      const r = await window.aibox.chatWithAgent(agentId, text, convId ?? undefined);
      setConvId(r.conversationId);
      // 刷新会话列表
      void window.aibox.listConversations(agentId).then(setConversations);
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', height: 'calc(100vh - 120px)', gap: 0 }}>
      {/* 左侧：助手选择 + 会话列表 */}
      <div style={{ borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <select value={agentId} onChange={(e) => { setAgentId(e.target.value); setConvId(null); }}
            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)', fontSize: 13 }}>
            <option value="">选择助手…</option>
            {agents.map((c) => <option key={c.agent.id} value={c.agent.id}>{c.agent.name}</option>)}
          </select>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
          <button onClick={() => setConvId(null)}
            style={{ display: 'block', width: '100%', padding: '10px 12px', marginBottom: 4, borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12.5, textAlign: 'left', background: convId === null ? 'var(--accent-soft)' : 'transparent', color: 'var(--text-1)', fontWeight: 600 }}>
            + 新对话
          </button>
          {conversations.map((c) => (
            <button key={c.id} onClick={() => setConvId(c.id)}
              style={{ display: 'block', width: '100%', padding: '10px 12px', marginBottom: 4, borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12.5, textAlign: 'left', background: convId === c.id ? 'var(--accent-soft)' : 'transparent', color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.title || '未命名对话'}
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{c.messageCount} 条 · {new Date(c.lastMessageAt).toLocaleDateString()}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 右侧：消息流 + 输入 */}
      <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 24px' }}>
          {!agentId && <div style={{ color: 'var(--text-3)', textAlign: 'center', marginTop: 80 }}>选择一个助手开始对话</div>}
          {agentId && messages.length === 0 && <div style={{ color: 'var(--text-3)', textAlign: 'center', marginTop: 80 }}>发送消息开始对话，助手将真实执行任务并回复结果</div>}
          {messages.map((e) => {
            if (e.eventType === 'output') {
              const text = String(e.payload.chunk ?? e.payload.text ?? '');
              return <div key={e.id} style={{ marginBottom: 12, padding: '10px 14px', background: 'var(--input-bg)', borderRadius: 10, fontSize: 13, lineHeight: 1.8 }}><Md text={text} /></div>;
            }
            if (e.eventType === 'tool_call') {
              return <div key={e.id} style={{ marginBottom: 8, fontSize: 12, color: 'var(--warning)' }}>🔧 {String(e.payload.name ?? '')} {JSON.stringify(e.payload.args ?? {}).slice(0, 60)}</div>;
            }
            if (e.eventType === 'completed') {
              return <div key={e.id} style={{ marginBottom: 8, fontSize: 12, color: 'var(--success)' }}>✅ 执行完成</div>;
            }
            if (e.eventType === 'failed') {
              return <div key={e.id} style={{ marginBottom: 8, fontSize: 12, color: 'var(--danger)' }}>❌ {String(e.payload.error ?? '执行失败')}</div>;
            }
            return null;
          })}
          <div ref={bottomRef} />
        </div>

        {/* 输入框 */}
        {agentId && (
          <div style={{ padding: '14px 24px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10 }}>
            <input value={input} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
              placeholder="输入消息…（Enter 发送）"
              style={{ flex: 1, padding: '10px 16px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)', fontSize: 13.5 }} />
            <button className="btn primary" disabled={sending || !input.trim()} onClick={() => void send()}>
              {sending ? '执行中…' : '发送'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
