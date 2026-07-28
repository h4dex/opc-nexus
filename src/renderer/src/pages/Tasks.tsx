/** 任务中心（PRD 5 信息架构 / 8.x 审批与失败处理） */
import { useEffect, useState } from 'react';
import { useApp } from '../store';
import { TASK_STATUS_META, Modal, ProgressBar, ContextMenu, type CtxMenuItem } from '../components/common';
import { IconCheck, IconPause, IconPlay, IconRefresh, IconStop, IconTrash, IconX } from '../components/icons';
import { toast } from '../components/Toast';
import type { Task, TaskEvent } from '@shared/types';

type TabKey = 'active' | 'approval' | 'done';

interface CtxState { x: number; y: number; task: Task }

export function Tasks() {
  const { snapshot, navigationTarget, clearNavigationTarget } = useApp();
  const [tab, setTab] = useState<TabKey>('active');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [ctx, setCtx] = useState<CtxState | null>(null);
  const [followUpTask, setFollowUpTask] = useState<Task | null>(null);
  const [followUpText, setFollowUpText] = useState('');
  const [projectFilter, setProjectFilter] = useState('all');
  const [deleting, setDeleting] = useState<Task | null>(null);
  useEffect(() => {
    if (!snapshot || navigationTarget?.entityType !== 'task') return;
    const task = snapshot.tasks.find((item) => item.id === navigationTarget.entityId);
    if (!task) return;
    setProjectFilter('all');
    setTab(task.status === 'WAITING_APPROVAL' ? 'approval'
      : ['RUNNING', 'QUEUED', 'PAUSED'].includes(task.status) ? 'active' : 'done');
    setDetailId(task.id);
    clearNavigationTarget();
  }, [clearNavigationTarget, navigationTarget, snapshot]);
  if (!snapshot) return null;

  const { tasks, approvals, agentCards } = snapshot;
  const projects = snapshot.projects ?? [];
  const agentName = new Map(agentCards.map((c) => [c.agent.id, c.agent.name]));
  const projectName = new Map(projects.map((project) => [project.id, project.name]));
  const matchesProject = (task: Task) => projectFilter === 'all'
    || (projectFilter === 'unassigned' ? !task.projectId : task.projectId === projectFilter);

  const active = tasks.filter((t) => ['RUNNING', 'QUEUED', 'PAUSED'].includes(t.status));
  const waiting = tasks.filter((t) => t.status === 'WAITING_APPROVAL');
  const done = tasks.filter((t) => ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(t.status));

  const baseList: Task[] = tab === 'active' ? active : tab === 'approval' ? waiting : done;
  const list = baseList.filter(matchesProject);
  const visibleApprovals = approvals.filter((approval) => {
    const task = tasks.find((item) => item.id === approval.taskId);
    return task ? matchesProject(task) : projectFilter === 'all';
  });
  const terminal = (task: Task) => ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(task.status);

  const retryTask = async (task: Task) => {
    try {
      await window.aibox.retryTask(task.id);
      toast.ok(`已重新执行“${task.title}”`);
    } catch (error) {
      toast.err(error instanceof Error ? error.message : '任务重试失败');
    }
  };

  const cancelTask = async (task: Task) => {
    try {
      await window.aibox.cancelTask(task.id);
      toast.ok('任务已取消');
    } catch (error) {
      toast.err(error instanceof Error ? error.message : '任务取消失败');
    }
  };

  const deleteTask = async () => {
    if (!deleting) return;
    try {
      await window.aibox.deleteTask(deleting.id);
      toast.ok('任务已从任务中心删除，执行审计与成果追溯仍会保留');
      setDeleting(null);
      if (detailId === deleting.id) setDetailId(null);
    } catch (error) {
      toast.err(error instanceof Error ? error.message : '任务删除失败');
    }
  };

  /** 右键菜单：根据任务状态动态生成菜单项 */
  const ctxItems = (t: Task): CtxMenuItem[] => {
    const items: CtxMenuItem[] = [
      { label: '查看详情', onClick: () => setDetailId(t.id) },
      { label: '打开产物目录', onClick: () => void window.aibox.openTaskWorkspace(t.id) },
    ];
    if (['COMPLETED', 'FAILED'].includes(t.status)) {
      items.push({ label: '追问 / 续跑', onClick: () => { setFollowUpTask(t); setFollowUpText(''); } });
    }
    if (terminal(t)) items.push(
      { label: '重新执行', onClick: () => void retryTask(t) },
      { divider: true, label: '', onClick: () => {} },
      { label: '删除任务', danger: true, onClick: () => setDeleting(t) }
    );
    if (t.status === 'RUNNING') items.push({ label: '暂停', onClick: () => void window.aibox.pauseTask(t.id) });
    if (t.status === 'PAUSED') items.push({ label: '继续', onClick: () => void window.aibox.resumeTask(t.id) });
    if (['RUNNING', 'PAUSED', 'QUEUED', 'WAITING_APPROVAL'].includes(t.status)) {
      items.push({ divider: true, label: '', onClick: () => {} }, { label: '取消任务', danger: true, onClick: () => void window.aibox.cancelTask(t.id) });
    }
    return items;
  };

  return (
    <>
      <div className="page-head">
        <h2>任务中心</h2>
        <span className="desc">执行中 {active.length} · 待审批 {approvals.length + waiting.length} · 已结束 {done.length}</span>
        <div className="right">
          <select className="project-scope-select" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} aria-label="按项目筛选任务" style={{ minWidth: 150 }}>
            <option value="all">全部项目</option>
            <option value="unassigned">未归项目</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          {(['active', 'approval', 'done'] as TabKey[]).map((k) => (
            <button key={k} className={`chip ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
              {k === 'active' ? '执行中 / 排队' : k === 'approval' ? '待审批' : '历史任务'}
            </button>
          ))}
        </div>
      </div>

      {/* 待审批面板 */}
      {tab === 'approval' && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title">审批请求<span className="sub">高风险操作必须显示命令、路径和预期影响（15.1）</span></div>
          {visibleApprovals.length === 0 && <div className="empty">暂无待审批事项</div>}
          {visibleApprovals.map((a) => (
            <div className="todo-item" key={a.id}>
              <span className={`dot ${a.risk === 'high' ? 'red' : a.risk === 'medium' ? 'orange' : 'green'}`} />
              <div style={{ flex: 1 }}>
                <div className="t">{a.request}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginTop: 3 }}>
                  {agentName.get(a.agentId) ?? '未知员工'} · 风险等级：{a.risk === 'high' ? '高' : a.risk === 'medium' ? '中' : '低'}
                </div>
              </div>
              <button className="btn small primary" onClick={() => void window.aibox.decideApproval(a.id, true)}>
                <IconCheck size={13} />批准
              </button>
              <button className="btn small danger" onClick={() => void window.aibox.decideApproval(a.id, false)}>
                <IconX size={13} />拒绝
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>任务</th><th>项目</th><th>数字员工</th><th>来源</th><th>状态</th><th style={{ width: 160 }}>进度</th><th>开始时间</th><th style={{ width: 170 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr><td colSpan={8}><div className="empty">暂无任务</div></td></tr>
            )}
            {list.map((t) => {
              const meta = TASK_STATUS_META[t.status];
              return (
                <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => setDetailId(t.id)}
                  onContextMenu={(e) => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, task: t }); }}>
                  <td style={{ fontWeight: 550 }}>{t.title}</td>
                  <td>{t.projectId ? <span className="tag blue">{projectName.get(t.projectId) ?? '已归档项目'}</span> : <span style={{ color: 'var(--text-3)' }}>未归项目</span>}</td>
                  <td>{agentName.get(t.agentId) ?? '—'}</td>
                  <td><span className="tag gray">{sourceLabel(t.source)}</span></td>
                  <td><span className={`tag ${meta.tag}`}>{meta.label}</span></td>
                  <td>
                    {t.status === 'RUNNING' || t.status === 'PAUSED' ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ flex: 1 }}><ProgressBar percent={t.progress} color={t.status === 'PAUSED' ? 'var(--warning)' : 'var(--accent)'} /></div>
                        <span style={{ fontSize: 11.5, color: 'var(--text-2)', minWidth: 32 }}>{t.progress}%</span>
                      </div>
                    ) : t.status === 'COMPLETED' ? '100%' : '—'}
                  </td>
                  <td style={{ color: 'var(--text-2)', fontSize: 12 }}>{t.startedAt ? new Date(t.startedAt).toLocaleString('zh-CN', { hour12: false }) : '—'}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                      {t.status === 'RUNNING' && (
                        <button className="btn small" title="暂停" onClick={() => void window.aibox.pauseTask(t.id)}><IconPause size={13} /></button>
                      )}
                      {t.status === 'PAUSED' && (
                        <button className="btn small" title="继续" onClick={() => void window.aibox.resumeTask(t.id)}><IconPlay size={13} /></button>
                      )}
                      {['RUNNING', 'PAUSED', 'QUEUED', 'WAITING_APPROVAL'].includes(t.status) && (
                        <button className="btn small danger" title="取消任务" aria-label={`取消 ${t.title}`} onClick={() => void cancelTask(t)}><IconStop size={13} /></button>
                      )}
                      {terminal(t) && <>
                        <button className="btn small" title="重新执行" aria-label={`重新执行 ${t.title}`} onClick={() => void retryTask(t)}><IconRefresh size={13} /></button>
                        <button className="btn small danger" title="删除任务" aria-label={`删除 ${t.title}`} onClick={() => setDeleting(t)}><IconTrash size={13} /></button>
                      </>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {detailId && (() => {
        const task = tasks.find((t) => t.id === detailId);
        return task ? (
          <TaskDetailModal task={task} tasks={tasks} agentName={agentName.get(task.agentId) ?? '—'} projectName={task.projectId ? projectName.get(task.projectId) ?? '已归档项目' : '未归项目'}
            onOpen={setDetailId} onClose={() => setDetailId(null)} />
        ) : null;
      })()}

      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctxItems(ctx.task)} onClose={() => setCtx(null)} />}

      {/* 追问 / 续跑弹窗：基于原任务会话锚点创建新任务 */}
      {followUpTask && (
        <Modal title={`追问 / 续跑 · ${followUpTask.title.slice(0, 30)}`} onClose={() => setFollowUpTask(null)}
          footer={<>
            <button className="btn" onClick={() => setFollowUpTask(null)}>取消</button>
            <button className="btn primary" disabled={!followUpText.trim()} onClick={() => {
              void window.aibox.createFollowUpTask(followUpTask.id, followUpText.trim())
                .then(() => { toast.ok('续跑任务已创建，继承原会话上下文'); setFollowUpTask(null); })
                .catch((e) => toast.err(`创建失败：${e instanceof Error ? e.message : String(e)}`));
            }}>提交续跑</button>
          </>}>
          <div className="field">
            <label>追问 / 续跑指令（将继承原任务的会话上下文）</label>
            <textarea className="input" rows={4} value={followUpText} onChange={(e) => setFollowUpText(e.target.value)}
              style={{ width: '100%', resize: 'vertical' }}
              placeholder="例如：继续上次未完成的部分 / 在上次结果基础上优化…" />
          </div>
        </Modal>
      )}

      {deleting && <Modal title="删除任务" onClose={() => setDeleting(null)} footer={<>
        <button className="btn" type="button" onClick={() => setDeleting(null)}>取消</button>
        <button className="btn danger" type="button" onClick={() => void deleteTask()}><IconTrash size={13} />确认删除</button>
      </>}>
        <p style={{ color: 'var(--text-2)', lineHeight: 1.7 }}>“{deleting.title}”将从任务中心和经营统计中移除。执行审计、关联成果及知识来源仍会保留。</p>
      </Modal>}
    </>
  );
}

/** 事件类型→中文标签（output 合并为实时输出区，不逐条展示） */
const EVENT_LABEL: Record<string, string> = {
  queued: '进入队列', started: '开始执行', stage: '阶段切换', progress: '进度更新',
  tool_call: '工具调用', tool_result: '工具结果', approval_required: '等待审批',
  result: '产出结果', completed: '执行完成', failed: '执行失败', interrupted: '执行中断'
};

/** 事件行的补充描述（工具名/参数/错误等） */
function eventDetail(e: TaskEvent): string {
  const p = e.payload;
  switch (e.eventType) {
    case 'stage': return String(p.stage ?? '');
    case 'tool_call': return `${String(p.name ?? '')} ${JSON.stringify(p.args ?? {}).slice(0, 80)}`;
    case 'tool_result': return `${String(p.name ?? '')}：${String(p.error ?? p.result ?? p.status ?? '').slice(0, 100)}`;
    case 'approval_required': return String(p.request ?? '').slice(0, 100);
    case 'failed':
    case 'interrupted': return String(p.error ?? '');
    default: return '';
  }
}

/** 任务详情：事件时间线 + 实时输出 + 产物全文 + 父/子任务跳转 + 追问续跑（执行中每 2s 轮询，13.2 可追溯） */
function TaskDetailModal({ task, tasks, agentName, projectName, onOpen, onClose }: {
  task: Task; tasks: Task[]; agentName: string; projectName: string; onOpen: (id: string) => void; onClose: () => void;
}) {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [result, setResult] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState('');
  const meta = TASK_STATUS_META[task.status];
  const running = ['RUNNING', 'QUEUED', 'WAITING_APPROVAL', 'PAUSED'].includes(task.status);

  const sendFollowUp = async () => {
    const title = followUp.trim();
    if (!title) return;
    await window.aibox.createFollowUpTask(task.id, title);
    setFollowUp('');
    onClose();
  };

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [ev, res] = await Promise.all([
        window.aibox.getTaskEvents(task.id),
        window.aibox.getTaskResult(task.id)
      ]);
      if (alive) {
        setEvents(ev);
        setResult(res);
      }
    };
    void load();
    const timer = running ? setInterval(() => void load(), 2000) : null;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [task.id, running]);

  const output = events.filter((e) => e.eventType === 'output').map((e) => String(e.payload.chunk ?? '')).join('');
  const timeline = events.filter((e) => e.eventType !== 'output' && e.eventType !== 'progress');
  // P3b：父/子任务链接（委派与追问均通过 parentId 关联）
  const parent = task.parentId ? tasks.find((t) => t.id === task.parentId) ?? null : null;
  const children = tasks.filter((t) => t.parentId === task.id);

  return (
    <Modal title={`任务详情 · ${task.title}`} onClose={onClose} width={720}
      footer={
        <div style={{ display: 'flex', gap: 8, flex: 1 }}>
          <input
            style={{ flex: 1 }}
            placeholder={task.sessionId ? '追问或补充指令，将在同一会话中继续执行…' : '继续派发后续任务（新会话）…'}
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void sendFollowUp()}
          />
          <button className="btn primary" onClick={() => void sendFollowUp()}>追问 / 续跑</button>
        </div>
      }>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <span className={`tag ${meta.tag}`}>{meta.label}</span>
        <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{agentName} · {task.stage} · {task.progress}%</span>
        <span className="tag gray">{projectName}</span>
        {task.parentId && <span className="tag gray">续跑/子任务</span>}
        {task.sessionId && <span className="tag blue" title={task.sessionId}>会话已保留</span>}
        {task.error && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{task.error}</span>}
      </div>
      {(task.status === 'RUNNING' || task.status === 'PAUSED') && <ProgressBar percent={task.progress} />}

      {(parent || children.length > 0) && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 12, fontSize: 12.5 }}>
          {parent && (
            <>
              <span style={{ color: 'var(--text-2)' }}>父任务：</span>
              <button className="btn small" onClick={() => onOpen(parent.id)}>
                {parent.title}（{TASK_STATUS_META[parent.status].label}）
              </button>
            </>
          )}
          {children.length > 0 && <span style={{ color: 'var(--text-2)' }}>子任务：</span>}
          {children.map((c) => (
            <button key={c.id} className="btn small" onClick={() => onOpen(c.id)}>
              {c.title}（{TASK_STATUS_META[c.status].label}）
            </button>
          ))}
        </div>
      )}

      <div className="card-title" style={{ marginTop: 16 }}>执行时间线<span className="sub">{timeline.length} 个事件</span></div>
      <div style={{ maxHeight: 180, overflowY: 'auto', fontSize: 12.5, lineHeight: 2 }}>
        {timeline.length === 0 && <div className="empty">暂无事件</div>}
        {timeline.map((e) => (
          <div key={e.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
            <span style={{ color: 'var(--text-3)', fontFamily: 'monospace', fontSize: 11.5, minWidth: 68 }}>
              {new Date(e.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}
            </span>
            <span style={{ fontWeight: 550, minWidth: 72 }}>{EVENT_LABEL[e.eventType] ?? e.eventType}</span>
            <span style={{ color: 'var(--text-2)', wordBreak: 'break-all' }}>{eventDetail(e)}</span>
          </div>
        ))}
      </div>

      {(output || result) && (
        <>
          <div className="card-title" style={{ marginTop: 16 }}>{result ? '执行产物' : '实时输出'}</div>
          <pre style={{
            maxHeight: 260, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            background: 'var(--input-bg)', borderRadius: 10, padding: '12px 14px', fontSize: 12, lineHeight: 1.7, margin: 0
          }}>{result ?? output}</pre>
        </>
      )}
    </Modal>
  );
}

function sourceLabel(s: Task['source']): string {
  return { desktop: '桌面', channel: '消息渠道', schedule: '定时', webhook: 'Webhook', delegated: '子代理', team: '专家团', voice: '语音' }[s];
}
