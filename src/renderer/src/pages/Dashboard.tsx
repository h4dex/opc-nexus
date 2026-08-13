/** AI Box 工作台首页（PRD 6.x，按基准 UI 还原） */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { RingGauge, Sparkline } from '../components/charts';
import {
  AgentAvatar, Modal, ProgressBar, STATUS_META, formatBytes, formatUptime
} from '../components/common';
import {
  IconCalendar, IconChip, IconClock, IconCoffee, IconCpu, IconGpu, IconLayers,
  IconMemory, IconMessage, IconPause, IconPlay, IconPlus, IconStop, IconUser, IconWifi, IconAlert, IconTask, IconLog, IconX
} from '../components/icons';
import type { AgentCardView, PermissionMode, Schedule } from '@shared/types';
import { AgentEditor } from '../components/AgentEditor';

/** 权限徽章：显示当前模式 + 点击快速切换 */
const PERM_META: Record<PermissionMode, { label: string; color: string }> = {
  readonly: { label: '只读', color: 'var(--text-3)' },
  standard: { label: '标准审批', color: 'var(--warning)' },
  trusted: { label: '受信任', color: 'var(--accent)' },
  autonomous: { label: '完全自主', color: 'var(--success)' }
};

function PermBadge({ mode, onChange }: { mode: PermissionMode; onChange: (m: PermissionMode) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const meta = PERM_META[mode];

  // 点击外部自动关闭
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button onClick={() => setOpen(!open)} style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: 6,
        border: `1px solid ${meta.color}`, background: 'transparent', color: meta.color,
        fontSize: 12, fontWeight: 600, cursor: 'pointer'
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: meta.color }} />
        {meta.label} ▾
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 100,
          background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8,
          boxShadow: '0 8px 24px rgba(0,0,0,.3)', padding: 4, minWidth: 150
        }}>
          {(Object.entries(PERM_META) as [PermissionMode, { label: string; color: string }][]).map(([k, v]) => (
            <button key={k} onClick={() => { onChange(k); setOpen(false); }} style={{
              display: 'block', width: '100%', padding: '7px 12px', borderRadius: 6, border: 'none',
              background: k === mode ? 'var(--accent-soft)' : 'transparent',
              color: k === mode ? v.color : 'var(--text-2)', fontSize: 12.5, fontWeight: k === mode ? 650 : 400,
              cursor: 'pointer', textAlign: 'left'
            }}>
              {v.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Dashboard() {
  const { snapshot, resources } = useApp();
  const [detail, setDetail] = useState<AgentCardView | null>(null);
  if (!snapshot) return <div className="empty">加载中…</div>;

  const { stats, agentCards, todos } = snapshot;
  const last = resources.history[resources.history.length - 1];
  const runningPct = stats.totalAgents ? Math.round((stats.running / stats.totalAgents) * 100) : 0;
  const idlePct = stats.totalAgents ? Math.round((stats.idle / stats.totalAgents) * 100) : 0;

  return (
    <>
      <div className="dash-grid">
        {/* ================= AI Box 总览 ================= */}
        <section className="card">
          <div className="card-title">AI Box 总览</div>
          <div className="overview-body">
            <RingGauge percent={stats.totalAgents ? 100 : null} size={168} stroke={15} color="var(--accent)">
              <div style={{ fontSize: 12, color: 'var(--text-2)' }}>数字员工总数</div>
              <div className="big-number">{stats.totalAgents}<small>人</small></div>
            </RingGauge>

            <div className="stat-rows">
              <div className="stat-row">
                <span className="dot blue" />
                <span className="label">当前执行</span>
                <span className="value">{stats.running}<small>人</small></span>
                <div style={{ marginLeft: 'auto' }}>
                  <RingGauge percent={runningPct} size={56} stroke={7} color="var(--info)">
                    <span style={{ fontSize: 11, fontWeight: 700 }}>{runningPct}%</span>
                  </RingGauge>
                </div>
              </div>
              <div className="stat-row">
                <span className="dot green" />
                <span className="label">空闲/待命</span>
                <span className="value">{stats.idle}<small>人</small></span>
                <div style={{ marginLeft: 'auto' }}>
                  <RingGauge percent={idlePct} size={56} stroke={7} color="var(--success)">
                    <span style={{ fontSize: 11, fontWeight: 700 }}>{idlePct}%</span>
                  </RingGauge>
                </div>
              </div>
            </div>

            <div className="stat-rows" style={{ maxWidth: 190 }}>
              <div className="mini-stat">
                <span style={{ color: 'var(--accent)' }}><IconTask size={26} /></span>
                <div>
                  <div className="txt">今日完成任务</div>
                  <div className="num">{stats.todayCompleted}<small>项</small></div>
                </div>
              </div>
              <div className="mini-stat">
                <span style={{ color: 'var(--warning)' }}><IconLog size={26} /></span>
                <div>
                  <div className="txt">待处理待办</div>
                  <div className="num">{stats.pendingTodos}<small>项</small></div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ================= 数字员工 ================= */}
        <section className="card">
          <div className="card-title">数字员工<span className="sub">{agentCards.length} 个在岗</span></div>
          <AgentStrip cards={agentCards} onOpen={setDetail} />
        </section>

        {/* ================= AI Box 系统状态 ================= */}
        <section className="card">
          <div className="card-title">AI Box 系统状态<span className="sub">每 2 秒刷新 · 曲线保留最近 10 分钟</span></div>
          <div className="sys-grid">
            <div className="sys-card">
              <div className="head">CPU 负载<span className="ico"><IconCpu size={20} /></span></div>
              <div className="pct">{last?.cpu !== null && last?.cpu !== undefined ? `${Math.round(last.cpu)}%` : '未知'}</div>
              <div className="meta">{last?.cpuCores ?? 0} 逻辑核心</div>
              <Sparkline data={resources.history.map((h) => h.cpu).slice(-120)} color="#4d6bfe" />
            </div>
            <div className="sys-card">
              <div className="head">内存负载<span className="ico" style={{ color: 'var(--success)' }}><IconMemory size={20} /></span></div>
              <div className="pct">{last?.memoryPercent != null ? `${Math.round(last.memoryPercent)}%` : '未知'}</div>
              <div className="meta">{last ? `${formatBytes(last.memoryUsed)} / ${formatBytes(last.memoryTotal)}` : ''}</div>
              <ProgressBar percent={last?.memoryPercent ?? 0} />
            </div>
            <div className="sys-card">
              <div className="head">GPU 负载<span className="ico" style={{ color: 'var(--purple)' }}><IconGpu size={20} /></span></div>
              {last?.gpu ? (
                <>
                  <div className="pct">{last.gpu.utilization != null ? `${Math.round(last.gpu.utilization)}%` : '未知'}</div>
                  <div className="meta">
                    {last.gpu.temperature != null ? `温度 ${Math.round(last.gpu.temperature)}℃` : last.gpu.name}
                  </div>
                  <Sparkline data={resources.history.map((h) => h.gpu?.utilization ?? null).slice(-120)} color="#8a5cf6" />
                </>
              ) : (
                <>
                  <div className="pct" style={{ fontSize: 20, color: 'var(--text-2)' }}>未检测到</div>
                  <div className="meta">无可用 GPU 采集接口</div>
                  <Sparkline data={[]} color="#8a5cf6" />
                </>
              )}
            </div>
          </div>
          <div className="sys-footer card" style={{ padding: 0, marginTop: 14, borderRadius: 'var(--radius-md)' }}>
            <div className="item">
              <span style={{ color: 'var(--info)' }}><IconClock size={20} /></span>
              <div>
                <div className="t">设备运行时间</div>
                <div className="v"><SystemUptime /></div>
              </div>
            </div>
            <div className="item">
              <span style={{ color: 'var(--success)' }}><IconWifi size={20} /></span>
              <div>
                <div className="t">网络状态</div>
                <div className="v">{last?.networkOnline ? '在线' : '离线'}</div>
              </div>
            </div>
            <div className="item">
              <span style={{ color: 'var(--purple)' }}><IconLayers size={20} /></span>
              <div>
                <div className="t">模型服务状态</div>
                <div className="v">
                  <span className={`dot ${resources.health.runtime === 'healthy' ? 'green' : 'red'}`} style={{ marginRight: 6 }} />
                  {resources.health.runtime === 'healthy' ? '全部正常' : '存在异常'}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ================= 待处理事项 ================= */}
        <section className="card">
          <div className="card-title">待处理事项<span className="sub">{todos.length} 项</span></div>
          <div className="todo-list">
            {todos.length === 0 && <div className="empty"><IconCoffee size={28} />暂无待办，一切正常</div>}
            {todos.map((t) => (
              <div className="todo-item" key={t.id}>
                <span className={`dot ${t.severity === 'high' ? 'red' : t.severity === 'medium' ? 'blue' : t.severity === 'low' ? 'orange' : 'green'}`} />
                <span className="t">{t.title}</span>
                <span className="owner"><IconUser size={14} />{t.owner}</span>
                <span className="due"><IconCalendar size={14} />{t.dueText}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      {detail && <AgentDetailModal card={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

/** 数字员工横排卡片（突出前 4 个，可横向滚动浏览更多） */
function AgentStrip({ cards, onOpen }: { cards: AgentCardView[]; onOpen: (c: AgentCardView) => void }) {
  const primary = cards.slice(0, 4);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
      {primary.map((c) => {
        const meta = STATUS_META[c.derivedStatus];
        return (
          <button key={c.agent.id} className="agent-card" onClick={() => onOpen(c)} style={{ textAlign: 'center' }}>
            <AgentAvatar color={c.agent.avatarColor} />
            <span className="agent-status-label"><span className={`dot ${meta.dot}`} />{meta.label}</span>
            <span className="agent-name">{c.agent.name}</span>
            <span className="agent-task">{c.currentTask ? c.currentTask.title : '空闲中'}</span>
            {c.currentTask ? (
              <RingGauge percent={c.currentTask.progress} size={72} stroke={8}
                color={c.derivedStatus === 'error' ? 'var(--danger)' : 'var(--accent)'}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{c.currentTask.progress}%</span>
              </RingGauge>
            ) : c.needsAttention ? (
              <RingGauge percent={88} size={72} stroke={8} color="var(--warning)">
                <span style={{ fontSize: 22, color: 'var(--warning)', fontWeight: 700 }}>!</span>
              </RingGauge>
            ) : (
              <div style={{ height: 72, display: 'grid', placeItems: 'center', color: 'var(--text-3)' }}>
                <IconCoffee size={30} />
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

function SystemUptime() {
  const [uptime, setUptime] = useState<number | null>(null);
  useEffect(() => {
    void window.aibox.getSystemInfo().then((i) => setUptime(i.uptimeSec));
    const t = setInterval(() => setUptime((u) => (u === null ? null : u + 2)), 2000);
    return () => clearInterval(t);
  }, []);
  return <>{uptime === null ? '…' : formatUptime(uptime)}</>;
}

/** 员工详情弹窗：状态详情 + 快捷操作（6.4 / 7.4） */
function AgentDetailModal({ card, onClose }: { card: AgentCardView; onClose: () => void }) {
  const { snapshot } = useApp();
  const [taskTitle, setTaskTitle] = useState('');
  const [projectId, setProjectId] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const meta = STATUS_META[card.derivedStatus];
  const { agent } = card;

  const dispatchTask = async () => {
    const title = taskTitle.trim() || '手动派发任务';
    await window.aibox.createTask(agent.id, title, projectId || undefined);
    setTaskTitle('');
    onClose();
  };

  return (
    <Modal title={`数字员工 · ${agent.name}`} onClose={onClose}
      footer={
        <>
          {card.currentTask && (
            <>
              <button className="btn" onClick={() => void window.aibox.pauseTask(card.currentTask!.id).then(onClose)}>
                <IconPause size={14} />暂停
              </button>
              <button className="btn danger" onClick={() => void window.aibox.cancelTask(card.currentTask!.id).then(onClose)}>
                <IconStop size={14} />取消任务
              </button>
            </>
          )}
          <button className="btn primary" onClick={dispatchTask}><IconPlay size={14} />派发任务</button>
          <button className="btn" onClick={() => setEditorOpen(true)}>编辑人设</button>
        </>
      }>
      {editorOpen && <AgentEditor agent={agent} onClose={() => setEditorOpen(false)} />}
      <div style={{ display: 'flex', gap: 18, marginBottom: 18 }}>
        <AgentAvatar color={agent.avatarColor} size={76} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 17, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 10 }}>
            {agent.name}
            <span className={`tag ${meta.dot === 'blue' ? 'blue' : meta.dot === 'green' ? 'green' : meta.dot === 'red' ? 'red' : 'orange'}`}>
              <span className={`dot ${meta.dot}`} />{meta.label}
            </span>
          </div>
          <div style={{ color: 'var(--text-2)', fontSize: 12.5, marginTop: 6, lineHeight: 1.7 }}>{agent.role}</div>
        </div>
      </div>

      <table className="table">
        <tbody>
          <tr><td style={{ color: 'var(--text-2)', width: 110 }}>默认引擎</td><td>{card.engineName}</td></tr>
          <tr><td style={{ color: 'var(--text-2)' }}>工作目录</td><td style={{ fontFamily: 'monospace', fontSize: 12 }}>{agent.workspace}</td></tr>
          <tr><td style={{ color: 'var(--text-2)' }}>权限模式</td><td>
            <PermBadge mode={agent.permissionMode} onChange={(m) => void window.aibox.updateAgentPersona(agent.id, { permissionMode: m })} />
          </td></tr>
          <tr><td style={{ color: 'var(--text-2)' }}>当前任务</td><td>{card.currentTask ? `${card.currentTask.title}（${card.currentTask.stage} ${card.currentTask.progress}%）` : '无'}</td></tr>
          {card.uptimeText && <tr><td style={{ color: 'var(--text-2)' }}>运行时长</td><td>{card.uptimeText}</td></tr>}
          <tr><td style={{ color: 'var(--text-2)' }}>消息渠道</td><td>{card.channels.length ? card.channels.join(' / ') : '未绑定'}</td></tr>
        </tbody>
      </table>

      <div className="field" style={{ marginTop: 16 }}>
        <label>快速派发任务</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="任务归属项目" style={{ minWidth: 150 }}>
            <option value="">未归项目</option>
            {(snapshot?.projects ?? []).filter((project) => !['completed', 'archived'].includes(project.status)).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <input
            placeholder="输入任务描述，例如：整理本周发票并生成汇总"
            value={taskTitle}
            onChange={(e) => setTaskTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void dispatchTask()}
          />
        </div>
      </div>

      <ScheduleSection agentId={agent.id} />

      {card.needsAttention && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: 'var(--warning-soft)', color: 'var(--warning)', padding: '10px 14px', borderRadius: 10, fontSize: 12.5 }}>
          <IconAlert size={16} />该员工存在待审批或异常事项，请前往任务中心处理。
        </div>
      )}
    </Modal>
  );
}

const WEEK_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function scheduleText(s: Schedule): string {
  if (s.cronKind === 'interval') return `每 ${s.cronValue} 小时`;
  if (s.cronKind === 'daily') return `每天 ${s.cronValue}`;
  const [d, t] = s.cronValue.split('|');
  return `每${WEEK_LABEL[Number(d) || 0]} ${t ?? ''}`;
}

/** 定时任务管理（P3a）：每 N 小时 / 每天 HH:mm / 每周几 */
function ScheduleSection({ agentId }: { agentId: string }) {
  const { snapshot } = useApp();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<Schedule['cronKind']>('daily');
  const [hourInterval, setHourInterval] = useState(4);
  const [time, setTime] = useState('09:00');
  const [weekday, setWeekday] = useState(1);

  const schedules = (snapshot?.schedules ?? []).filter((s) => s.agentId === agentId);

  const add = async () => {
    if (!title.trim()) return;
    const cronValue = kind === 'interval' ? String(hourInterval) : kind === 'daily' ? time : `${weekday}|${time}`;
    await window.aibox.createSchedule({ agentId, title: title.trim(), cronKind: kind, cronValue });
    setTitle('');
  };

  return (
    <div className="field" style={{ marginTop: 16 }}>
      <label>定时任务（到期自动派发，来源标记为“定时”）</label>
      {schedules.map((s) => (
        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '6px 0' }}>
          <IconCalendar size={14} />
          <span style={{ flex: 1 }}>{s.title}</span>
          <span style={{ color: 'var(--text-2)' }}>{scheduleText(s)}</span>
          <span style={{ color: 'var(--text-3)', fontSize: 11 }}>下次 {new Date(s.nextRunAt).toLocaleString('zh-CN', { hour12: false })}</span>
          <button className="btn small" onClick={() => void window.aibox.toggleSchedule(s.id, !s.enabled)}>
            {s.enabled ? '暂停' : '启用'}
          </button>
          <button className="btn small danger" title="删除" onClick={() => void window.aibox.deleteSchedule(s.id)}><IconX size={12} /></button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
        <input style={{ flex: '1 1 160px' }} placeholder="例如：每日巡检报告" value={title} onChange={(e) => setTitle(e.target.value)} />
        <select value={kind} onChange={(e) => setKind(e.target.value as Schedule['cronKind'])}>
          <option value="interval">每 N 小时</option>
          <option value="daily">每天</option>
          <option value="weekly">每周</option>
        </select>
        {kind === 'interval' && (
          <input type="number" min={1} max={168} style={{ width: 70 }} value={hourInterval} onChange={(e) => setHourInterval(Math.max(1, Number(e.target.value) || 1))} />
        )}
        {kind === 'weekly' && (
          <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
            {WEEK_LABEL.map((w, i) => <option key={w} value={i}>{w}</option>)}
          </select>
        )}
        {kind !== 'interval' && <input type="time" value={time} onChange={(e) => setTime(e.target.value || '09:00')} />}
        <button className="btn small primary" onClick={() => void add()}><IconPlus size={13} />添加</button>
      </div>
    </div>
  );
}
