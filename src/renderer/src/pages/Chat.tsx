/** Legacy Local CLI chat. Cordis conversations live in the official DSH Web UI. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import type {
  Conversation,
  ConversationMessageView,
  TaskEvent,
  TaskStatus
} from '@shared/types';
import { appendTaskOutput, compactTaskEvents } from '../utils/taskEvents';
import { MarkdownView } from '../components/MarkdownView';
import { IconChevronRight, IconLog, IconMessage, IconRefresh, IconSend, IconStop } from '../components/icons';
import { toast } from '../components/Toast';
import { DSH_MANAGED_ENGINE_ID } from '@shared/types';

const ACTIVE_TASK_STATUSES: TaskStatus[] = ['QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'PAUSED'];
const TERMINAL_TASK_STATUSES: TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'];

function taskIsActive(status: TaskStatus | undefined): boolean {
  return status !== undefined && ACTIVE_TASK_STATUSES.includes(status);
}

function taskIsTerminal(status: TaskStatus | undefined): boolean {
  return status !== undefined && TERMINAL_TASK_STATUSES.includes(status);
}

function messageLabel(message: ConversationMessageView): string {
  if (message.role === 'user' || message.direction === 'inbound') return '老板';
  if (message.role === 'tool') return '工具';
  return '员工';
}

export function Chat() {
  const {
    snapshot,
    setRoute,
    chatTarget,
    clearAgentChatTarget
  } = useApp();
  const [agentId, setAgentId] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessageView[]>([]);
  const [nextCursor, setNextCursor] = useState<{ createdAt: number; id: string } | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [activity, setActivity] = useState<TaskEvent[]>([]);
  const [input, setInput] = useState('');
  const [dispatching, setDispatching] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [lastUserMsg, setLastUserMsg] = useState('');
  const [activityOpen, setActivityOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeTaskRef = useRef<string | null>(null);
  const timelineRequestRef = useRef(0);

  const agents = useMemo(
    () => (snapshot?.agentCards ?? []).filter((card) =>
      card.agent.lifecycle === 'READY' && card.agent.engineId !== DSH_MANAGED_ENGINE_ID
    ),
    [snapshot]
  );
  const selectedCard = snapshot?.agentCards.find((card) => card.agent.id === agentId) ?? null;
  const selectedAgent = selectedCard?.agent ?? null;
  const activeTask = snapshot?.tasks.find((task) => task.id === activeTaskId) ?? null;
  const busy = dispatching || taskIsActive(activeTask?.status);

  // Direct navigation from Agents opens one employee and (optionally) one conversation.
  useEffect(() => {
    if (!chatTarget) return;
    setAgentId(chatTarget.agentId);
    setConvId(chatTarget.conversationId);
    setMessages([]);
    setActivity([]);
    setLastUserMsg('');
    clearAgentChatTarget();
  }, [chatTarget, clearAgentChatTarget]);

  useEffect(() => {
    if (!agentId) {
      setConversations([]);
      return;
    }
    let alive = true;
    void window.aibox.listConversations(agentId).then((items) => {
      if (alive) setConversations(items);
    }).catch(() => {
      if (alive) setConversations([]);
    });
    return () => { alive = false; };
  }, [agentId, snapshot?.version]);

  const loadTimeline = useCallback(async (employeeId: string, conversationId: string) => {
    const requestId = ++timelineRequestRef.current;
    const page = await window.aibox.getConversationTimeline({
      agentId: employeeId,
      conversationId,
      limit: 100
    });
    if (requestId !== timelineRequestRef.current) return;
    setMessages(page.messages);
    setNextCursor(page.nextCursor);
    setHasMore(page.hasMore);
  }, []);

  const loadMore = useCallback(async () => {
    if (!agentId || !convId || !nextCursor || !hasMore) return;
    const requestId = ++timelineRequestRef.current;
    try {
      const page = await window.aibox.getConversationTimeline({
        agentId,
        conversationId: convId,
        cursor: nextCursor,
        limit: 100
      });
      if (requestId !== timelineRequestRef.current) return;
      setMessages((current) => [...page.messages, ...current]);
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (error) {
      toast.err(error instanceof Error ? error.message : '加载历史消息失败');
    }
  }, [agentId, convId, hasMore, nextCursor]);

  const refreshActivity = useCallback(async (taskId: string | null) => {
    if (!taskId) {
      setActivity([]);
      return;
    }
    try {
      setActivity(compactTaskEvents(await window.aibox.getTaskEvents(taskId)));
    } catch {
      setActivity([]);
    }
  }, []);

  // Canonical history is the source of truth for every selected conversation.
  useEffect(() => {
    if (!agentId || !convId) {
      setMessages([]);
      setNextCursor(null);
      setHasMore(false);
      setActiveTaskId(null);
      activeTaskRef.current = null;
      setActivity([]);
      return;
    }
    let alive = true;
    void loadTimeline(agentId, convId).catch((error) => {
      if (alive) toast.err(error instanceof Error ? error.message : '加载会话失败');
    });
    const tasks = useApp.getState().snapshot?.tasks ?? [];
    const candidate = tasks
      .filter((task) => task.agentId === agentId && task.conversationId === convId)
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    const taskId = candidate?.id ?? null;
    setActiveTaskId(taskId);
    activeTaskRef.current = taskId;
    void refreshActivity(taskId);
    return () => { alive = false; };
  }, [agentId, convId, loadTimeline, refreshActivity]);

  // Keep the active task attached when a new snapshot arrives after dispatch.
  useEffect(() => {
    if (!agentId || !convId || !snapshot) return;
    const candidate = snapshot.tasks
      .filter((task) => task.agentId === agentId && task.conversationId === convId)
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    if (!candidate) return;
    if (candidate.id !== activeTaskRef.current) {
      activeTaskRef.current = candidate.id;
      setActiveTaskId(candidate.id);
      void refreshActivity(candidate.id);
    }
    if (taskIsTerminal(candidate.status)) {
      void loadTimeline(agentId, convId).catch(() => undefined);
    }
  }, [agentId, convId, snapshot, loadTimeline, refreshActivity]);

  useEffect(() => {
    const unsub = window.aibox.onTaskOutput(({ taskId, chunk }) => {
      if (taskId !== activeTaskRef.current) return;
      setActivity((prev) => appendTaskOutput(prev, taskId, chunk));
      setActivityOpen(true);
    });
    return unsub;
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages.length, activity.length]);

  if (!snapshot) return null;

  const send = async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || !agentId || busy) return;
    setDispatching(true);
    setInput('');
    try {
      const result = await window.aibox.chatWithAgent(agentId, text, convId ?? undefined);
      setLastUserMsg(text);
      setConvId(result.conversationId);
      setActiveTaskId(result.task.id);
      activeTaskRef.current = result.task.id;
      await Promise.all([
        window.aibox.listConversations(agentId).then(setConversations),
        loadTimeline(agentId, result.conversationId).catch(() => undefined),
        refreshActivity(result.task.id)
      ]);
    } catch (error) {
      setInput((current) => current.trim() ? current : text);
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('QUEST_REQUIRED')) {
        toast.err('复杂任务请从“项目与 Quest”交给 Cordis');
        setRoute('projects');
      } else {
        toast.err(message);
      }
    } finally {
      setDispatching(false);
    }
  };

  const stopGeneration = async () => {
    if (!activeTaskId) return;
    try {
      await window.aibox.cancelTask(activeTaskId);
    } catch (error) {
      toast.err(error instanceof Error ? error.message : '停止任务失败');
    }
  };

  const doRename = async () => {
    if (!renamingId || !renameText.trim()) {
      setRenamingId(null);
      return;
    }
    await window.aibox.renameConversation(renamingId, renameText.trim());
    setRenamingId(null);
    if (agentId) void window.aibox.listConversations(agentId).then(setConversations);
  };

  const doDelete = async (id: string) => {
    await window.aibox.deleteConversation(id);
    if (convId === id) {
      setConvId(null);
      setMessages([]);
      setActivity([]);
    }
    if (agentId) void window.aibox.listConversations(agentId).then(setConversations);
  };

  const streamingText = activity
    .filter((event) => event.eventType === 'output')
    .map((event) => String(event.payload.chunk ?? event.payload.text ?? ''))
    .join('');

  return (
    <div className="nexus-chat">
      <aside className="nexus-chat-rail">
        <div className="nexus-chat-rail-head">
          <div className="nexus-chat-title"><IconMessage size={16} />Local CLI 兼容对话</div>
          <select value={agentId} onChange={(event) => { setAgentId(event.target.value); setConvId(null); setMessages([]); setActivity([]); }}>
            <option value="">选择数字员工</option>
            {agents.map((card) => <option key={card.agent.id} value={card.agent.id}>{card.agent.name}</option>)}
          </select>
        </div>
        <div className="nexus-chat-conversations">
          <button className={`conversation-item new ${convId === null ? 'selected' : ''}`} onClick={() => { setConvId(null); setMessages([]); setActivity([]); }}>
            <span>新对话</span><span className="conversation-plus">+</span>
          </button>
          {conversations.map((conversation) => (
            <div key={conversation.id} className="conversation-row">
              {renamingId === conversation.id ? (
                <input value={renameText} onChange={(event) => setRenameText(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') void doRename(); if (event.key === 'Escape') setRenamingId(null); }}
                  onBlur={() => void doRename()} autoFocus />
              ) : (
                <button className={`conversation-item ${convId === conversation.id ? 'selected' : ''}`} onClick={() => { setConvId(conversation.id); setLastUserMsg(''); }}
                  onContextMenu={(event) => { event.preventDefault(); setRenamingId(conversation.id); setRenameText(conversation.title); }}>
                  <span className="conversation-name">{conversation.title || '未命名对话'}</span>
                  <span className="conversation-meta">{conversation.messageCount} 条 · {new Date(conversation.lastMessageAt).toLocaleDateString()}</span>
                </button>
              )}
              {renamingId !== conversation.id && <button className="conversation-delete" onClick={() => void doDelete(conversation.id)} title="删除会话">×</button>}
            </div>
          ))}
        </div>
        <div className="nexus-chat-rail-foot">右键会话可重命名</div>
      </aside>

      <section className="nexus-chat-main">
        <header className="nexus-chat-header">
          <div>
            <div className="nexus-chat-heading">{selectedAgent?.name ?? '选择数字员工'}</div>
            <div className="nexus-chat-subheading">{selectedAgent?.role ?? '从员工列表进入兼容对话'}</div>
          </div>
        </header>

        <div className="nexus-chat-stream">
          {!agentId && <div className="chat-empty"><IconMessage size={26} /><span>选择一位数字员工开始对话</span></div>}
          {agentId && convId && hasMore && <button className="load-older" onClick={() => void loadMore()}><IconRefresh size={13} />加载更早消息</button>}
          {agentId && !convId && messages.length === 0 && <div className="chat-empty"><span>发送消息开始对话</span></div>}
          {messages.map((message) => (
            <article key={message.id} className={`canonical-message ${message.direction === 'inbound' ? 'from-owner' : 'from-agent'}`}>
              <div className="message-label">{messageLabel(message)}<time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>
              <div className="message-body"><MarkdownView content={message.content} /></div>
              {message.truncated && <div className="message-warning">此消息过长，已按显示上限截断</div>}
            </article>
          ))}
          {busy && streamingText && (
            <article className="canonical-message from-agent streaming-message">
              <div className="message-label">员工 · 执行中</div>
              <div className="message-body"><MarkdownView content={streamingText} /></div>
            </article>
          )}
          {busy && !streamingText && <div className="thinking-indicator"><span className="typing-dot" />正在执行<span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" /></div>}
          {!busy && lastUserMsg && messages.some((message) => message.direction === 'outbound') && (
            <button className="btn small regenerate" onClick={() => void send(lastUserMsg)} title="重发上一条消息"><IconRefresh size={12} />重新生成</button>
          )}
          <div ref={bottomRef} />
        </div>

        <details className="nexus-chat-activity" open={activityOpen} onToggle={(event) => setActivityOpen(event.currentTarget.open)}>
          <summary><IconLog size={14} />执行活动 <span>{activity.length}</span><IconChevronRight size={13} /></summary>
          <div className="activity-list">
            {activity.length === 0 && <span className="muted">暂无活动</span>}
            {activity.map((event) => (
              <div key={event.id} className="activity-item">
                <time>{new Date(event.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</time>
                <span className={`activity-kind ${event.eventType}`}>{event.eventType}</span>
                <span>{event.eventType === 'tool_call' ? String(event.payload.name ?? '') : event.eventType === 'failed' ? String(event.payload.error ?? '') : event.eventType === 'output' ? '输出增量' : ''}</span>
              </div>
            ))}
          </div>
        </details>

        {agentId && (
          <div className="nexus-chat-composer">
            <textarea value={input} onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }}
              placeholder="输入消息…（Enter 发送，Shift+Enter 换行）" rows={2} disabled={busy} />
            {busy ? (
              <button className="btn danger composer-action" onClick={() => void stopGeneration()} title="停止当前任务"><IconStop size={14} />停止</button>
            ) : (
              <button className="btn primary composer-action" disabled={!input.trim()} onClick={() => void send()} title="发送消息"><IconSend size={14} />发送</button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
