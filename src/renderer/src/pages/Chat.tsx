/** 对话聊天（Cherry Studio 风格）：左侧助手+会话列表，右侧消息流 + 输入框，流式输出 + Markdown 渲染 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { useApp } from '../store';
import type { Conversation, TaskEvent } from '@shared/types';
import { appendTaskOutput, compactTaskEvents } from '../utils/taskEvents';

/** 表格规范化：在紧跟非表格文本的表格行前补空行，避免 GFM 解析失败（尤其含对齐标记 | :---: | 的表格） */
function normalizeTables(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1] ?? '';
    if (/^\s*\|/.test(line) && prev.trim() !== '' && !/^\s*\|/.test(prev)) {
      out.push('');
    }
    out.push(line);
  }
  return out.join('\n');
}

/** 轻量 Markdown 渲染（同步解析 + DOMPurify 消毒 + 代码块复制按钮） */
function Md({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const raw = marked.parse(normalizeTables(text), { async: false, gfm: true, breaks: true }) as string;
  const html = DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] });

  // 为代码块注入复制按钮
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.code-copy-btn')) return;
      pre.style.position = 'relative';
      const btn = document.createElement('button');
      btn.className = 'code-copy-btn';
      btn.textContent = '复制';
      btn.style.cssText = 'position:absolute;top:6px;right:6px;padding:2px 8px;font-size:11px;border:1px solid var(--border);background:var(--card);color:var(--text-2);border-radius:5px;cursor:pointer;opacity:.75';
      btn.onclick = () => {
        const code = pre.querySelector('code')?.textContent ?? pre.textContent ?? '';
        void navigator.clipboard.writeText(code);
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = '复制'; }, 1500);
      };
      pre.appendChild(btn);
    });
  }, [html]);

  return <div ref={ref} className="md-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Chat() {
  const { snapshot } = useApp();
  const [agentId, setAgentId] = useState<string>('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<TaskEvent[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [lastUserMsg, setLastUserMsg] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const convIdRef = useRef<string | null>(null);
  const activeTaskRef = useRef<string | null>(null);

  // 保持 ref 同步
  convIdRef.current = convId;
  activeTaskRef.current = activeTaskId;

  // 选中助手后加载会话列表
  useEffect(() => {
    if (!agentId) return;
    void window.aibox.listConversations(agentId).then(setConversations);
  }, [agentId, snapshot?.tasks.length]);

  // 选中会话后加载消息（仅依赖 convId，不依赖 snapshot.tasks 避免重复订阅）
  const loadMessages = useCallback(() => {
    const cid = convIdRef.current;
    if (!cid) { setMessages([]); return; }
    // 通过 snapshot 查找对应任务（用 ref 避免闭包过期）
    const tasks = useApp.getState().snapshot?.tasks ?? [];
    const task = tasks.find((t) => t.sessionId === `conv-${cid}`);
    if (task) {
      activeTaskRef.current = task.id;
      setActiveTaskId(task.id);
      void window.aibox.getTaskEvents(task.id).then((items) => setMessages(compactTaskEvents(items)));
    }
  }, []);

  useEffect(() => {
    if (!convId) { setMessages([]); setActiveTaskId(null); return; }
    loadMessages();
  }, [convId, loadMessages]);

  // 流式输出订阅：仅挂载一次，通过 ref 判断当前会话，避免重复订阅导致消息重复
  useEffect(() => {
    const unsub = window.aibox.onTaskOutput(({ taskId, chunk }) => {
      if (taskId !== activeTaskRef.current) return;
      setMessages((prev) => appendTaskOutput(prev, taskId, chunk));
    });
    return unsub;
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'auto' }); }, [messages.length]);

  // 所有 hooks 必须在早退之前调用（保活页面在 snapshot 加载前即挂载，早退后置 hooks 会触发 hooks 数量不一致）
  if (!snapshot) return null;
  const { agentCards } = snapshot;
  const agents = agentCards.filter((c) => c.agent.lifecycle === 'READY');

  const send = async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || !agentId || sending) return;
    setSending(true);
    setInput('');
    setLastUserMsg(text);
    try {
      const r = await window.aibox.chatWithAgent(agentId, text, convId ?? undefined);
      setConvId(r.conversationId);
      setActiveTaskId(r.task.id);
      activeTaskRef.current = r.task.id;
      // 刷新会话列表
      void window.aibox.listConversations(agentId).then(setConversations);
    } finally {
      setSending(false);
    }
  };

  /** 重新生成：重发最后一条用户消息 */
  const regenerate = () => {
    if (lastUserMsg && !sending) void send(lastUserMsg);
  };

  /** 停止生成：取消当前活跃任务 */
  const stopGeneration = async () => {
    if (!activeTaskId) return;
    await window.aibox.cancelTask(activeTaskId);
    setSending(false);
  };

  /** 会话重命名 */
  const doRename = async () => {
    if (!renamingId || !renameText.trim()) { setRenamingId(null); return; }
    await window.aibox.renameConversation(renamingId, renameText.trim());
    setRenamingId(null);
    if (agentId) void window.aibox.listConversations(agentId).then(setConversations);
  };

  /** 删除会话 */
  const doDelete = async (id: string) => {
    await window.aibox.deleteConversation(id);
    if (convId === id) { setConvId(null); setMessages([]); }
    if (agentId) void window.aibox.listConversations(agentId).then(setConversations);
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
            <div key={c.id} style={{ position: 'relative', marginBottom: 4 }}>
              {renamingId === c.id ? (
                <input value={renameText} onChange={(e) => setRenameText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void doRename(); if (e.key === 'Escape') setRenamingId(null); }}
                  onBlur={() => void doRename()}
                  autoFocus
                  style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--accent)', background: 'var(--input-bg)', color: 'var(--text-1)', fontSize: 12.5 }} />
              ) : (
                <button onClick={() => setConvId(c.id)}
                  onContextMenu={(e) => { e.preventDefault(); setRenamingId(c.id); setRenameText(c.title); }}
                  style={{ display: 'block', width: '100%', padding: '10px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12.5, textAlign: 'left', background: convId === c.id ? 'var(--accent-soft)' : 'transparent', color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.title || '未命名对话'}
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{c.messageCount} 条 · {new Date(c.lastMessageAt).toLocaleDateString()}</span>
                </button>
              )}
              {/* 删除按钮（悬停显示） */}
              {renamingId !== c.id && (
                <button onClick={() => void doDelete(c.id)} title="删除会话"
                  style={{ position: 'absolute', top: 8, right: 6, width: 20, height: 20, borderRadius: 4, border: 'none', background: 'transparent', color: 'var(--text-3)', cursor: 'pointer', fontSize: 13, lineHeight: '20px', opacity: 0.5 }}
                  onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                  onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.5')}>
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
        <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-3)', borderTop: '1px solid var(--border)' }}>
          右键会话可重命名
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
              return (
                <div key={e.id} className="chat-msg" style={{ position: 'relative', marginBottom: 12, padding: '10px 14px', background: 'var(--input-bg)', borderRadius: 10, fontSize: 13, lineHeight: 1.8 }}>
                  <Md text={text} />
                  <button className="msg-copy-btn" title="复制回复" onClick={() => { void navigator.clipboard.writeText(text); }}
                    style={{ position: 'absolute', top: 6, right: 6, padding: '2px 7px', fontSize: 10.5, border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-3)', borderRadius: 5, cursor: 'pointer', opacity: 0.6 }}
                    onMouseEnter={(ev) => (ev.currentTarget.style.opacity = '1')}
                    onMouseLeave={(ev) => (ev.currentTarget.style.opacity = '0.6')}>复制</button>
                </div>
              );
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
          {/* 打字指示器 */}
          {sending && (
            <div style={{ marginBottom: 12, padding: '10px 14px', background: 'var(--input-bg)', borderRadius: 10, fontSize: 13, color: 'var(--text-3)', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              <span className="typing-dot" />正在思考并执行<span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" />
            </div>
          )}
          {/* 重新生成（有历史回复且未在生成时） */}
          {!sending && lastUserMsg && messages.some((m) => m.eventType === 'output') && (
            <div style={{ marginBottom: 12 }}>
              <button className="btn small" onClick={regenerate} style={{ fontSize: 11.5 }}>↻ 重新生成</button>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* 输入框 + 停止生成 */}
        {agentId && (
          <div style={{ padding: '14px 24px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10 }}>
            <input value={input} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
              placeholder="输入消息…（Enter 发送）"
              style={{ flex: 1, padding: '10px 16px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)', fontSize: 13.5 }} />
            {sending ? (
              <button className="btn danger" onClick={() => void stopGeneration()} title="停止生成">
                ■ 停止
              </button>
            ) : (
              <button className="btn primary" disabled={!input.trim()} onClick={() => void send()}>
                发送
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
