/**
 * 执行监控（参考 Hermes Studio 对话式执行轨迹）：
 * 左侧任务列表（活跃任务置顶 + 旋转指示器）；右侧选中任务的实时执行流——
 * 阶段切换、工具调用（可展开参数/结果）、LLM 输出、审批干预（批准/拒绝按钮）。
 * 执行中任务通过 onTaskOutput 流式推送实时追加，辅以 5s 低频轮询补全非 output 事件。
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { useApp } from '../store';
import { TASK_STATUS_META, ContextMenu, type CtxMenuItem } from '../components/common';
import { IconCheck, IconX, IconPlay } from '../components/icons';
import type { Task, TaskEvent, Approval } from '@shared/types';

/** 事件类型 → 图标颜色 */
const EVENT_COLOR: Record<string, string> = {
  started: 'var(--accent)', stage: 'var(--accent)', tool_call: 'var(--warning)',
  tool_result: 'var(--success)', approval_required: 'var(--danger)',
  completed: 'var(--success)', failed: 'var(--danger)', interrupted: 'var(--text-3)'
};

export function Console() {
  const { snapshot } = useApp();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [result, setResult] = useState<string | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; task: Task } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  if (!snapshot) return null;
  const { tasks, approvals, agentCards } = snapshot;

  // 活跃任务优先，再按时间倒序
  const sorted = [...tasks].sort((a, b) => {
    const activeA = ['RUNNING', 'WAITING_APPROVAL', 'QUEUED'].includes(a.status) ? 1 : 0;
    const activeB = ['RUNNING', 'WAITING_APPROVAL', 'QUEUED'].includes(b.status) ? 1 : 0;
    if (activeA !== activeB) return activeB - activeA;
    return b.createdAt - a.createdAt;
  });

  const selected = tasks.find((t) => t.id === selectedId) ?? sorted[0] ?? null;
  const isRunning = selected && ['RUNNING', 'WAITING_APPROVAL', 'QUEUED'].includes(selected.status);

  /** 右键菜单项（按任务状态动态生成） */
  const ctxItems = (t: Task): CtxMenuItem[] => {
    const items: CtxMenuItem[] = [
      { label: '查看执行流', onClick: () => setSelectedId(t.id) },
      { label: '打开产物目录', onClick: () => void window.aibox.openTaskWorkspace(t.id) }
    ];
    if (['RUNNING', 'PAUSED', 'QUEUED'].includes(t.status)) {
      items.push({ divider: true, label: '', onClick: () => {} }, { label: '取消任务', danger: true, onClick: () => void window.aibox.cancelTask(t.id) });
    }
    return items;
  };

  // 加载选中任务的事件流（初始全量 + 流式追加 + 5s 低频补全）
  const selectedIdRef = useRef<string | null>(null);
  const loadEvents = useCallback(() => {
    if (!selectedIdRef.current) return;
    void window.aibox.getTaskEvents(selectedIdRef.current).then(setEvents);
    void window.aibox.getTaskResult(selectedIdRef.current).then(setResult);
  }, []);

  useEffect(() => {
    if (!selected) return;
    selectedIdRef.current = selected.id;
    setSelectedId(selected.id);
    loadEvents();
    // 流式输出实时追加（无需等待轮询）
    const unsub = window.aibox.onTaskOutput(({ taskId, chunk }) => {
      if (taskId !== selectedIdRef.current) return;
      setEvents((prev) => [...prev, {
        id: `rt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        taskId, eventType: 'output', payload: { chunk }, createdAt: Date.now()
      } as TaskEvent]);
    });
    // 5s 低频轮询补全 stage/progress/tool_call 等非 output 事件
    const timer = setInterval(loadEvents, 5000);
    return () => { unsub(); clearInterval(timer); };
  }, [selected?.id, loadEvents]);

  // 自动滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length]);

  const agentName = (id: string) => agentCards.find((c) => c.agent.id === id)?.agent.name ?? '—';
  const taskApprovals = approvals.filter((a) => a.taskId === selected?.id && a.status === 'pending');

  return (
    <>
      <div className="page-head">
        <h2>执行监控</h2>
        <span className="desc">实时查看 Hermes / CLI 引擎执行轨迹、工具调用与人工审批干预</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 16, height: 'calc(100vh - 160px)' }}>
        {/* 左侧：任务列表 */}
        <div className="card" style={{ overflowY: 'auto', padding: 8 }}>
          {sorted.slice(0, 30).map((t) => {
            const meta = TASK_STATUS_META[t.status];
            const active = ['RUNNING', 'WAITING_APPROVAL'].includes(t.status);
            return (
              <button key={t.id} onClick={() => setSelectedId(t.id)}
                onContextMenu={(e) => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, task: t }); }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', marginBottom: 4,
                  borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12.5, lineHeight: 1.6,
                  background: selected?.id === t.id ? 'var(--accent-soft)' : 'transparent',
                  color: 'var(--text-1)'
                }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {active && <span className="dot orange" style={{ animation: 'pulse 1s infinite' }} />}
                  <span style={{ fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.title}
                  </span>
                </div>
                <div style={{ color: 'var(--text-3)', fontSize: 11, marginTop: 2 }}>
                  {agentName(t.agentId)} · <span className={`tag ${meta.tag}`} style={{ fontSize: 10 }}>{meta.label}</span>
                </div>
              </button>
            );
          })}
        </div>

        {/* 右侧：执行流 */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 0 }}>
          {selected ? (
            <>
              {/* 头部：任务信息 + 进度 */}
              <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
                <div style={{ fontWeight: 650, fontSize: 14, marginBottom: 4 }}>{selected.title}</div>
                <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                  {agentName(selected.agentId)} · {selected.stage || '—'} · 进度 {selected.progress}%
                </div>
                <div style={{ height: 3, background: 'var(--input-bg)', borderRadius: 2, marginTop: 8 }}>
                  <div style={{ height: '100%', width: `${selected.progress}%`, background: 'var(--accent)', borderRadius: 2, transition: 'width .3s' }} />
                </div>
              </div>

              {/* 审批干预区（WAITING_APPROVAL 时显示） */}
              {taskApprovals.length > 0 && (
                <div style={{ padding: '12px 18px', background: 'var(--danger-soft)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
                  {taskApprovals.map((a) => <ApprovalCard key={a.id} approval={a} />)}
                </div>
              )}

              {/* 事件流 */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px' }}>
                {events.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: 13 }}>暂无执行事件…</div>}
                {events.map((e) => <EventRow key={e.id} event={e} />)}
                {/* 最终产物 */}
                {result && (
                  <div style={{ marginTop: 12, padding: '12px 14px', background: 'var(--input-bg)', borderRadius: 10, fontSize: 12.5, lineHeight: 1.8, whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto' }}>
                    <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--success)' }}>📄 执行产物</div>
                    {result.slice(0, 4000)}
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
            </>
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)' }}>
              选择一个任务查看执行轨迹
            </div>
          )}
        </div>
      </div>

      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctxItems(ctx.task)} onClose={() => setCtx(null)} />}
    </>
  );
}

/** 审批干预卡片：展示请求内容 + 批准/拒绝按钮 */
function ApprovalCard({ approval }: { approval: Approval }) {
  const [busy, setBusy] = useState(false);
  const decide = async (approve: boolean) => {
    setBusy(true);
    await window.aibox.decideApproval(approval.id, approve);
    setBusy(false);
  };
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--danger)', marginBottom: 4 }}>
        ⚠️ 需要人工审批（{approval.risk === 'high' ? '高危' : '写入'}操作）
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-1)', marginBottom: 8, whiteSpace: 'pre-wrap' }}>
        {approval.request}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn small primary" disabled={busy} onClick={() => void decide(true)}>
          <IconCheck size={13} />批准执行
        </button>
        <button className="btn small danger" disabled={busy} onClick={() => void decide(false)}>
          <IconX size={13} />拒绝
        </button>
      </div>
    </div>
  );
}

/** 单条事件行：按类型渲染不同样式（工具调用可展开，output 终端风格） */
function EventRow({ event }: { event: TaskEvent }) {
  const [expanded, setExpanded] = useState(false);
  const color = EVENT_COLOR[event.eventType] ?? 'var(--text-3)';
  const time = new Date(event.createdAt).toLocaleTimeString('zh-CN', { hour12: false });
  const p = event.payload;

  // CLI / LLM 实时输出：终端风格展示（让用户看到引擎在做什么）
  if (event.eventType === 'output') {
    const chunk = String(p.chunk ?? p.text ?? '');
    if (!chunk.trim()) return null;
    return (
      <pre style={{
        margin: '2px 0', padding: '6px 12px', background: '#0d1117', borderRadius: 6,
        fontSize: 11.5, lineHeight: 1.7, color: '#c9d1d9', whiteSpace: 'pre-wrap',
        wordBreak: 'break-all', borderLeft: '3px solid var(--accent)', maxHeight: 300, overflowY: 'auto'
      }}>
        {chunk.slice(0, 4000)}
      </pre>
    );
  }

  // 工具调用：可展开参数/结果
  if (event.eventType === 'tool_call') {
    return (
      <div style={{ marginBottom: 8 }}>
        <button onClick={() => setExpanded(!expanded)} style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
          background: 'var(--input-bg)', border: 'none', borderRadius: 8, padding: '8px 12px',
          cursor: 'pointer', fontSize: 12, color: 'var(--text-1)'
        }}>
          <span style={{ color: 'var(--warning)', fontWeight: 700 }}>🔧</span>
          <span style={{ fontWeight: 600 }}>{String(p.name ?? 'tool')}</span>
          <span style={{ color: 'var(--text-3)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {JSON.stringify(p.args ?? {}).slice(0, 60)}
          </span>
          <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{time}</span>
        </button>
        {expanded && (
          <pre style={{ margin: '4px 0 0 12px', padding: '8px 12px', background: 'var(--bg-1)', borderRadius: 6, fontSize: 11.5, lineHeight: 1.7, overflowX: 'auto', color: 'var(--text-2)' }}>
            {JSON.stringify(p.args ?? {}, null, 2)}
          </pre>
        )}
      </div>
    );
  }

  if (event.eventType === 'tool_result') {
    return (
      <div style={{ marginBottom: 8 }}>
        <button onClick={() => setExpanded(!expanded)} style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
          background: 'var(--input-bg)', border: 'none', borderRadius: 8, padding: '8px 12px',
          cursor: 'pointer', fontSize: 12, color: 'var(--text-1)'
        }}>
          <span style={{ color: p.error ? 'var(--danger)' : 'var(--success)', fontWeight: 700 }}>{p.error ? '✗' : '✓'}</span>
          <span style={{ fontWeight: 600 }}>{String(p.name ?? 'result')}</span>
          <span style={{ color: 'var(--text-3)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {String(p.error ?? p.result ?? p.status ?? '').slice(0, 80)}
          </span>
          <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{time}</span>
        </button>
        {expanded && (
          <pre style={{ margin: '4px 0 0 12px', padding: '8px 12px', background: 'var(--bg-1)', borderRadius: 6, fontSize: 11.5, lineHeight: 1.7, overflowX: 'auto', color: 'var(--text-2)', maxHeight: 200, overflowY: 'auto' }}>
            {String(p.error ?? p.result ?? JSON.stringify(p, null, 2)).slice(0, 2000)}
          </pre>
        )}
      </div>
    );
  }

  // 普通事件行
  const label = event.eventType === 'stage' ? String(p.stage ?? '')
    : event.eventType === 'approval_required' ? `⚠️ ${String(p.request ?? '').slice(0, 80)}`
    : event.eventType === 'failed' ? String(p.error ?? '执行失败')
    : event.eventType === 'completed' ? '执行完成'
    : event.eventType === 'started' ? '开始执行'
    : event.eventType;

  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6, fontSize: 12.5 }}>
      <span style={{ color: 'var(--text-3)', fontSize: 11, flexShrink: 0 }}>{time}</span>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0, marginTop: 4 }} />
      <span style={{ color: event.eventType === 'failed' ? 'var(--danger)' : 'var(--text-1)', lineHeight: 1.6 }}>{label}</span>
    </div>
  );
}
