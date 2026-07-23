/** 定时任务管理：按员工分组展示 + 创建/编辑/启停/删除 + 执行历史 + 每月周期 + 任务内容模板 */
import { useEffect, useState } from 'react';
import { useApp } from '../store';
import { Modal } from '../components/common';
import { IconPlus, IconPlay, IconStop, IconX } from '../components/icons';

interface ScheduleData {
  id: string; agentId: string; title: string; content: string; cronKind: string; cronValue: string; enabled: boolean; lastRunAt: number | null; nextRunAt: number;
}

const KIND_LABEL: Record<string, string> = { interval: '每 N 小时', daily: '每天定时', weekly: '每周定时', monthly: '每月定时' };

export function Schedules() {
  const { snapshot } = useApp();
  const [schedules, setSchedules] = useState<ScheduleData[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ScheduleData | null>(null);
  const [historyTarget, setHistoryTarget] = useState<ScheduleData | null>(null);

  useEffect(() => {
    if (snapshot?.schedules) setSchedules(snapshot.schedules as unknown as ScheduleData[]);
  }, [snapshot?.schedules]);

  if (!snapshot) return null;
  const agentName = (id: string) => snapshot.agentCards.find((c) => c.agent.id === id)?.agent.name ?? '未知';
  const agentColor = (id: string) => snapshot.agentCards.find((c) => c.agent.id === id)?.agent.avatarColor ?? 'var(--accent)';

  // 按员工分组
  const grouped = new Map<string, ScheduleData[]>();
  for (const s of schedules) {
    const list = grouped.get(s.agentId) ?? [];
    list.push(s);
    grouped.set(s.agentId, list);
  }

  const toggle = async (id: string, enabled: boolean) => {
    await window.aibox.toggleSchedule(id, enabled);
    setSchedules((s) => s.map((x) => x.id === id ? { ...x, enabled } : x));
  };

  const remove = async (id: string) => {
    await window.aibox.deleteSchedule(id);
    setSchedules((s) => s.filter((x) => x.id !== id));
  };

  const cronDesc = (s: ScheduleData) => {
    if (s.cronKind === 'interval') return `每 ${s.cronValue} 小时`;
    if (s.cronKind === 'daily') return `每天 ${s.cronValue}`;
    if (s.cronKind === 'weekly') {
      const [day, time] = s.cronValue.split('|');
      const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      return `每${days[Number(day)] ?? day} ${time ?? ''}`;
    }
    if (s.cronKind === 'monthly') {
      const [date, time] = s.cronValue.split('|');
      return `每月 ${date} 日 ${time ?? ''}`;
    }
    return s.cronValue;
  };

  const countdown = (nextRunAt: number) => {
    const diff = nextRunAt - Date.now();
    if (diff <= 0) return '即将执行';
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    if (h > 24) return `${Math.floor(h / 24)} 天 ${h % 24} 小时后`;
    if (h > 0) return `${h} 小时 ${m} 分钟后`;
    return `${m} 分钟后`;
  };

  return (
    <>
      <div className="page-head">
        <h2>定时任务</h2>
        <span className="desc">{schedules.length} 个计划 · 按岗位分组 · 每个员工支持多个定时任务</span>
        <div className="right">
          <button className="btn small primary" onClick={() => setCreateOpen(true)}><IconPlus size={13} />新建计划</button>
        </div>
      </div>

      {schedules.length === 0 && (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>
          还没有定时任务。点击「新建计划」为助手设置自动执行。
        </div>
      )}

      {/* 按员工分组展示 */}
      <div style={{ display: 'grid', gap: 16 }}>
        {[...grouped.entries()].map(([agentId, list]) => (
          <div key={agentId} className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {/* 分组头 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 18px', background: 'var(--input-bg)', borderBottom: '1px solid var(--border)' }}>
              <div style={{ width: 28, height: 28, borderRadius: 7, background: `${agentColor(agentId)}22`, color: agentColor(agentId), display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 12 }}>
                {agentName(agentId).slice(0, 1)}
              </div>
              <span style={{ fontWeight: 650, fontSize: 13.5, flex: 1 }}>{agentName(agentId)}</span>
              <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{list.length} 个定时任务</span>
            </div>
            {/* 任务列表 */}
            <div style={{ padding: '8px 18px' }}>
              {list.map((s) => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border)', opacity: s.enabled ? 1 : 0.6 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{s.title}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginTop: 2 }}>
                      {cronDesc(s)}
                      {s.enabled && <span style={{ marginLeft: 10, color: 'var(--accent)' }}>下次：{countdown(s.nextRunAt)}</span>}
                      {s.lastRunAt && <span style={{ marginLeft: 10, color: 'var(--text-3)' }}>上次：{new Date(s.lastRunAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>}
                    </div>
                    {s.content && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.content.slice(0, 60)}</div>}
                  </div>
                  <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: s.enabled ? 'var(--success-soft, rgba(34,197,94,.1))' : 'var(--input-bg)', color: s.enabled ? 'var(--success)' : 'var(--text-3)', flexShrink: 0 }}>
                    {s.enabled ? '运行中' : '已暂停'}
                  </span>
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    <button className="btn small" onClick={() => void toggle(s.id, !s.enabled)} title={s.enabled ? '暂停' : '启用'}>
                      {s.enabled ? <IconStop size={12} /> : <IconPlay size={12} />}
                    </button>
                    <button className="btn small" onClick={() => setHistoryTarget(s)} title="执行历史" style={{ fontSize: 11, padding: '3px 8px' }}>历史</button>
                    <button className="btn small" onClick={() => setEditTarget(s)} style={{ fontSize: 11, padding: '3px 8px' }}>编辑</button>
                    <button className="btn small danger" onClick={() => void remove(s.id)} title="删除"><IconX size={12} /></button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {createOpen && <ScheduleFormModal mode="create" onClose={() => setCreateOpen(false)} onSaved={(s) => { setSchedules((prev) => [...prev, s]); setCreateOpen(false); }} />}
      {editTarget && <ScheduleFormModal mode="edit" schedule={editTarget} onClose={() => setEditTarget(null)} onSaved={(s) => { setSchedules((prev) => prev.map((x) => x.id === s.id ? s : x)); setEditTarget(null); }} />}
      {historyTarget && <ScheduleHistoryModal schedule={historyTarget} onClose={() => setHistoryTarget(null)} />}
    </>
  );
}

/** 创建/编辑定时任务弹窗 */
function ScheduleFormModal({ mode, schedule, onClose, onSaved }: {
  mode: 'create' | 'edit'; schedule?: ScheduleData; onClose: () => void; onSaved: (s: ScheduleData) => void;
}) {
  const { snapshot } = useApp();
  const [agentId, setAgentId] = useState(schedule?.agentId ?? '');
  const [title, setTitle] = useState(schedule?.title ?? '');
  const [content, setContent] = useState(schedule?.content ?? '');
  const [cronKind, setCronKind] = useState<'interval' | 'daily' | 'weekly' | 'monthly'>((schedule?.cronKind as 'interval' | 'daily' | 'weekly' | 'monthly') ?? 'daily');
  const [cronValue, setCronValue] = useState(schedule?.cronValue ?? '09:00');
  const [busy, setBusy] = useState(false);

  if (!snapshot) return null;
  const agents = snapshot.agentCards.filter((c) => c.agent.lifecycle === 'READY');

  const save = async () => {
    if (!title.trim() || (mode === 'create' && !agentId)) return;
    setBusy(true);
    try {
      if (mode === 'create') {
        const s = await window.aibox.createSchedule({ agentId, title: title.trim(), content: content.trim(), cronKind, cronValue });
        onSaved(s as unknown as ScheduleData);
      } else if (schedule) {
        await window.aibox.updateSchedule(schedule.id, { title: title.trim(), content: content.trim(), cronKind, cronValue });
        onSaved({ ...schedule, title: title.trim(), content: content.trim(), cronKind, cronValue });
      }
    } finally { setBusy(false); }
  };

  return (
    <Modal title={mode === 'create' ? '新建定时任务' : '编辑定时任务'} onClose={onClose} width={520}
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy || !title.trim() || (mode === 'create' && !agentId)} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button></>}>
      {mode === 'create' && (
        <div className="field">
          <label>执行助手（岗位）</label>
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">选择助手…</option>
            {agents.map((c) => <option key={c.agent.id} value={c.agent.id}>{c.agent.name}（{c.agent.role.slice(0, 15)}）</option>)}
          </select>
        </div>
      )}
      <div className="field">
        <label>任务标题</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：每日晨报汇总、每周数据巡检" />
      </div>
      <div className="field">
        <label>任务详细指令（可选，作为 prompt 派发给助手）</label>
        <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="例如：请汇总今日所有渠道的客户咨询，按优先级分类整理为表格，并给出跟进建议。"
          style={{ width: '100%', minHeight: 80, resize: 'vertical', fontFamily: 'inherit', fontSize: 12.5, padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)' }} />
      </div>
      <div className="field">
        <label>执行周期</label>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          {(['interval', 'daily', 'weekly', 'monthly'] as const).map((k) => (
            <button key={k} onClick={() => { setCronKind(k); if (k === 'interval') setCronValue('4'); else if (k === 'daily') setCronValue('09:00'); else if (k === 'weekly') setCronValue('1|09:00'); else setCronValue('1|09:00'); }}
              style={{ padding: '5px 12px', borderRadius: 6, border: `1px solid ${cronKind === k ? 'var(--accent)' : 'var(--border)'}`, background: cronKind === k ? 'var(--accent-soft)' : 'transparent', color: cronKind === k ? 'var(--accent)' : 'var(--text-2)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        {cronKind === 'interval' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>每</span>
            <input type="number" min={1} max={168} value={cronValue} onChange={(e) => setCronValue(e.target.value)} style={{ width: 60, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)', textAlign: 'center' }} />
            <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>小时执行一次</span>
          </div>
        )}
        {cronKind === 'daily' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>每天</span>
            <input type="time" value={cronValue} onChange={(e) => setCronValue(e.target.value)} style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)' }} />
            <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>执行</span>
          </div>
        )}
        {cronKind === 'weekly' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <select value={cronValue.split('|')[0] ?? '1'} onChange={(e) => setCronValue(`${e.target.value}|${cronValue.split('|')[1] ?? '09:00'}`)} style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)' }}>
              {['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((d, i) => <option key={i} value={String(i + 1)}>{d}</option>)}
            </select>
            <input type="time" value={cronValue.split('|')[1] ?? '09:00'} onChange={(e) => setCronValue(`${cronValue.split('|')[0] ?? '1'}|${e.target.value}`)} style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)' }} />
          </div>
        )}
        {cronKind === 'monthly' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>每月</span>
            <input type="number" min={1} max={28} value={cronValue.split('|')[0] ?? '1'} onChange={(e) => setCronValue(`${e.target.value}|${cronValue.split('|')[1] ?? '09:00'}`)} style={{ width: 55, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)', textAlign: 'center' }} />
            <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>日</span>
            <input type="time" value={cronValue.split('|')[1] ?? '09:00'} onChange={(e) => setCronValue(`${cronValue.split('|')[0] ?? '1'}|${e.target.value}`)} style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)' }} />
          </div>
        )}
      </div>
    </Modal>
  );
}

/** 执行历史弹窗 */
function ScheduleHistoryModal({ schedule, onClose }: { schedule: ScheduleData; onClose: () => void }) {
  const [history, setHistory] = useState<{ id: string; title: string; status: string; createdAt: number }[] | null>(null);

  if (!history) {
    void window.aibox.getScheduleHistory(schedule.id).then(setHistory);
    return null;
  }

  const statusLabel = (s: string) => ({ QUEUED: '排队', RUNNING: '执行中', COMPLETED: '完成', FAILED: '失败', CANCELLED: '取消' }[s] ?? s);
  const statusColor = (s: string) => s === 'COMPLETED' ? 'var(--success)' : s === 'FAILED' ? 'var(--danger)' : s === 'RUNNING' ? 'var(--accent)' : 'var(--text-3)';

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div className="card" style={{ width: 520, maxHeight: '65vh', overflowY: 'auto', padding: 20 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>执行历史 · {schedule.title}</h3>
          <button className="btn small" onClick={onClose}>关闭</button>
        </div>
        {history.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: 12.5, padding: 20, textAlign: 'center' }}>暂无执行记录</div>}
        {history.map((h) => (
          <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 6, background: 'var(--input-bg)', marginBottom: 4, fontSize: 12.5 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor(h.status), flexShrink: 0 }} />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.title.slice(0, 40)}</span>
            <span style={{ color: statusColor(h.status), fontWeight: 600, fontSize: 11.5 }}>{statusLabel(h.status)}</span>
            <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{new Date(h.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
