/** 定时任务管理：统一查看/创建/启停/删除所有助手的定时任务 */
import { useEffect, useState } from 'react';
import { useApp } from '../store';
import { Modal } from '../components/common';
import { IconPlus, IconPlay, IconStop, IconX } from '../components/icons';

interface ScheduleData {
  id: string; agentId: string; title: string; cronKind: string; cronValue: string; enabled: boolean; lastRunAt: number | null; nextRunAt: number;
}

const KIND_LABEL: Record<string, string> = { interval: '每 N 小时', daily: '每天定时', weekly: '每周定时' };

export function Schedules() {
  const { snapshot } = useApp();
  const [schedules, setSchedules] = useState<ScheduleData[]>([]);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (snapshot?.schedules) setSchedules(snapshot.schedules as unknown as ScheduleData[]);
  }, [snapshot?.schedules]);

  if (!snapshot) return null;
  const agentName = (id: string) => snapshot.agentCards.find((c) => c.agent.id === id)?.agent.name ?? '未知';

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
    return s.cronValue;
  };

  return (
    <>
      <div className="page-head">
        <h2>定时任务</h2>
        <span className="desc">{schedules.length} 个计划 · 自动按周期为助手派发任务</span>
        <div className="right">
          <button className="btn small primary" onClick={() => setCreateOpen(true)}><IconPlus size={13} />新建计划</button>
        </div>
      </div>

      {schedules.length === 0 && (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>
          还没有定时任务。点击「新建计划」为助手设置自动执行。
        </div>
      )}

      <div style={{ display: 'grid', gap: 12 }}>
        {schedules.map((s) => (
          <div className="card" key={s.id} style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14, opacity: s.enabled ? 1 : 0.6 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{s.title}</div>
              <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 3 }}>
                {agentName(s.agentId)} · {cronDesc(s)}
                {s.lastRunAt && <span style={{ marginLeft: 10, color: 'var(--text-3)' }}>上次：{new Date(s.lastRunAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>}
              </div>
            </div>
            <span style={{ fontSize: 11.5, padding: '3px 8px', borderRadius: 4, background: s.enabled ? 'var(--success-soft, rgba(34,197,94,.1))' : 'var(--input-bg)', color: s.enabled ? 'var(--success)' : 'var(--text-3)' }}>
              {s.enabled ? '运行中' : '已暂停'}
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn small" onClick={() => void toggle(s.id, !s.enabled)} title={s.enabled ? '暂停' : '启用'}>
                {s.enabled ? <IconStop size={13} /> : <IconPlay size={13} />}
              </button>
              <button className="btn small danger" onClick={() => void remove(s.id)} title="删除"><IconX size={13} /></button>
            </div>
          </div>
        ))}
      </div>

      {createOpen && <CreateScheduleModal onClose={() => setCreateOpen(false)} onCreated={(s) => { setSchedules((prev) => [...prev, s]); setCreateOpen(false); }} />}
    </>
  );
}

function CreateScheduleModal({ onClose, onCreated }: { onClose: () => void; onCreated: (s: ScheduleData) => void }) {
  const { snapshot } = useApp();
  const [agentId, setAgentId] = useState('');
  const [title, setTitle] = useState('');
  const [cronKind, setCronKind] = useState<'interval' | 'daily' | 'weekly'>('interval');
  const [cronValue, setCronValue] = useState('4');
  const [busy, setBusy] = useState(false);

  if (!snapshot) return null;
  const agents = snapshot.agentCards.filter((c) => c.agent.lifecycle === 'READY');

  const create = async () => {
    if (!agentId || !title.trim()) return;
    setBusy(true);
    try {
      const s = await window.aibox.createSchedule({ agentId, title: title.trim(), cronKind, cronValue });
      onCreated(s as unknown as ScheduleData);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="新建定时任务" onClose={onClose} width={480}
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy || !agentId || !title.trim()} onClick={() => void create()}>{busy ? '创建中…' : '创建'}</button></>}>
      <div className="field">
        <label>执行助手</label>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">选择助手…</option>
          {agents.map((c) => <option key={c.agent.id} value={c.agent.id}>{c.agent.name}</option>)}
        </select>
      </div>
      <div className="field">
        <label>任务标题（将作为任务内容派发给助手）</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：每日晨报汇总、每周数据巡检" />
      </div>
      <div className="field">
        <label>执行周期</label>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          {(['interval', 'daily', 'weekly'] as const).map((k) => (
            <button key={k} onClick={() => setCronKind(k)} style={{
              padding: '6px 14px', borderRadius: 6, border: `1px solid ${cronKind === k ? 'var(--accent)' : 'var(--border)'}`,
              background: cronKind === k ? 'var(--accent-soft)' : 'transparent', color: cronKind === k ? 'var(--accent)' : 'var(--text-2)',
              fontSize: 12.5, fontWeight: 600, cursor: 'pointer'
            }}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        {cronKind === 'interval' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>每</span>
            <input type="number" min={1} max={24} value={cronValue} onChange={(e) => setCronValue(e.target.value)} style={{ width: 60, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)', textAlign: 'center' }} />
            <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>小时执行一次</span>
          </div>
        )}
        {cronKind === 'daily' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>每天</span>
            <input type="time" value={cronValue === '4' ? '09:00' : cronValue} onChange={(e) => setCronValue(e.target.value)} style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)' }} />
            <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>执行</span>
          </div>
        )}
        {cronKind === 'weekly' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <select value={cronValue.split('|')[0] ?? '1'} onChange={(e) => setCronValue(`${e.target.value}|${cronValue.split('|')[1] ?? '09:00'}`)} style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)' }}>
              {['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((d, i) => <option key={i} value={String(i + 1)}>{d}</option>)}
            </select>
            <input type="time" value={cronValue.split('|')[1] ?? '09:00'} onChange={(e) => setCronValue(`${cronValue.split('|')[0] ?? '1'}|${e.target.value}`)} style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)' }} />
            <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>执行</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
