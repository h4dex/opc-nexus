/** 自动计划：普通 Agent 任务与项目巡检/周报/月报共用调度管理。 */
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { Modal } from '../components/common';
import { IconClock, IconEdit, IconFile, IconPause, IconPlay, IconPlus, IconTrash } from '../components/icons';
import { toast } from '../components/Toast';
import type { AutomationScheduleKind, Schedule, ScheduleInput } from '../../../shared/types';

const KIND_META: Record<AutomationScheduleKind, { label: string; description: string }> = {
  task: { label: '员工任务', description: '按计划派发指令给指定数字员工' },
  project_inspection: { label: '项目巡检', description: '自动检查逾期、质量、重复工作与预算' },
  weekly_report: { label: '项目周报', description: '汇总近七天任务、成果、消耗和风险' },
  monthly_report: { label: '项目月报', description: '汇总本月经营进展、成本和交付情况' }
};

const CRON_LABEL: Record<Schedule['cronKind'], string> = {
  interval: '每 N 小时', daily: '每天', weekly: '每周', monthly: '每月'
};

export function Schedules({ embedded = false, onChanged }: { embedded?: boolean; onChanged?: () => void }) {
  const { snapshot } = useApp();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [form, setForm] = useState<Schedule | 'create' | null>(null);
  const [historyTarget, setHistoryTarget] = useState<Schedule | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Schedule | null>(null);
  const [filter, setFilter] = useState<'all' | 'automation' | 'task'>('all');

  useEffect(() => setSchedules(snapshot?.schedules ?? []), [snapshot?.schedules]);
  const visible = useMemo(() => schedules.filter((item) => filter === 'all'
    || (filter === 'task' ? item.automationKind === 'task' : item.automationKind !== 'task')), [filter, schedules]);
  if (!snapshot) return null;
  const agentNames = new Map(snapshot.agentCards.map((item) => [item.agent.id, item.agent.name]));
  const projectNames = new Map(snapshot.projects.map((item) => [item.id, item.name]));

  const toggle = async (schedule: Schedule) => {
    try {
      await window.aibox.toggleSchedule(schedule.id, !schedule.enabled);
      setSchedules((items) => items.map((item) => item.id === schedule.id ? { ...item, enabled: !schedule.enabled } : item));
      onChanged?.();
    } catch (error) { toast.err(error instanceof Error ? error.message : '计划状态更新失败'); }
  };
  const remove = async () => {
    if (!deleteTarget) return;
    try {
      await window.aibox.deleteSchedule(deleteTarget.id);
      setSchedules((items) => items.filter((item) => item.id !== deleteTarget.id));
      setDeleteTarget(null); onChanged?.(); toast.ok('自动计划已删除');
    } catch (error) { toast.err(error instanceof Error ? error.message : '删除失败'); }
  };

  return <section className="schedule-manager">
    {!embedded && <div className="page-head"><h2>自动计划</h2><span className="desc">定时派发任务、巡检与经营报告</span></div>}
    <div className="schedule-toolbar">
      <div className="automation-segmented" aria-label="计划类型筛选">
        {([['all', '全部'], ['automation', '经营计划'], ['task', '员工任务']] as const).map(([key, label]) =>
          <button key={key} type="button" className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}</button>)}
      </div>
      <span>{visible.length} 个计划</span>
      <button className="btn small primary" type="button" onClick={() => setForm('create')}><IconPlus size={13} />新建计划</button>
    </div>

    {visible.length === 0 ? <div className="automation-empty"><IconClock size={24} /><strong>暂无自动计划</strong><span>创建巡检、报告或员工任务计划。</span></div>
      : <div className="automation-plan-table"><table className="table"><thead><tr>
        <th>计划</th><th>对象</th><th>周期</th><th>最近 / 下次运行</th><th>状态</th><th>操作</th>
      </tr></thead><tbody>{visible.map((schedule) => <tr key={schedule.id}>
        <td><div className="schedule-title"><span data-kind={schedule.automationKind}><IconClock size={14} /></span><div><strong>{schedule.title}</strong><small>{KIND_META[schedule.automationKind].label}</small></div></div></td>
        <td>{schedule.automationKind === 'task'
          ? <><strong>{schedule.agentId ? agentNames.get(schedule.agentId) ?? '已归档员工' : '未指定员工'}</strong>{schedule.projectId && <small>{projectNames.get(schedule.projectId) ?? '已归档项目'}</small>}</>
          : <><strong>{schedule.projectId ? projectNames.get(schedule.projectId) ?? '已归档项目' : '未指定项目'}</strong><small>系统自动生成</small></>}</td>
        <td>{cronDescription(schedule)}</td>
        <td><div className="schedule-times"><span>{schedule.lastRunAt ? timeLabel(schedule.lastRunAt) : '尚未运行'}</span><small>{schedule.enabled ? countdown(schedule.nextRunAt) : '已暂停'}</small></div></td>
        <td><span className={`automation-status ${schedule.enabled ? 'active' : ''}`}>{schedule.enabled ? '运行中' : '已暂停'}</span></td>
        <td><div className="schedule-actions">
          <button className="icon-btn" type="button" title={schedule.enabled ? '暂停计划' : '启用计划'} onClick={() => void toggle(schedule)}>{schedule.enabled ? <IconPause size={14} /> : <IconPlay size={14} />}</button>
          <button className="icon-btn" type="button" title="执行历史" onClick={() => setHistoryTarget(schedule)}><IconFile size={14} /></button>
          <button className="icon-btn" type="button" title="编辑计划" onClick={() => setForm(schedule)}><IconEdit size={14} /></button>
          <button className="icon-btn danger" type="button" title="删除计划" onClick={() => setDeleteTarget(schedule)}><IconTrash size={14} /></button>
        </div></td>
      </tr>)}</tbody></table></div>}

    {form && <ScheduleForm schedule={form === 'create' ? undefined : form} onClose={() => setForm(null)} onSaved={(saved) => {
      setSchedules((items) => form === 'create' ? [...items, saved] : items.map((item) => item.id === saved.id ? saved : item));
      setForm(null); onChanged?.();
    }} />}
    {historyTarget && <ScheduleHistory schedule={historyTarget} onClose={() => setHistoryTarget(null)} />}
    {deleteTarget && <Modal title="删除自动计划" onClose={() => setDeleteTarget(null)} footer={<>
      <button className="btn" type="button" onClick={() => setDeleteTarget(null)}>取消</button>
      <button className="btn danger" type="button" onClick={() => void remove()}><IconTrash size={13} />确认删除</button>
    </>}><p>删除“{deleteTarget.title}”后不会再自动运行，已有任务和报告历史会继续保留。</p></Modal>}
  </section>;
}

function ScheduleForm({ schedule, onClose, onSaved }: { schedule?: Schedule; onClose: () => void; onSaved: (schedule: Schedule) => void }) {
  const { snapshot } = useApp();
  const [kind, setKind] = useState<AutomationScheduleKind>(schedule?.automationKind ?? 'project_inspection');
  const [agentId, setAgentId] = useState(schedule?.agentId ?? '');
  const [projectId, setProjectId] = useState(schedule?.projectId ?? '');
  const [title, setTitle] = useState(schedule?.title ?? '');
  const [content, setContent] = useState(schedule?.content ?? '');
  const [cronKind, setCronKind] = useState<Schedule['cronKind']>(schedule?.cronKind ?? 'weekly');
  const [cronValue, setCronValue] = useState(schedule?.cronValue ?? '1|09:00');
  const [busy, setBusy] = useState(false);
  if (!snapshot) return null;
  const agents = snapshot.agentCards.filter((item) => item.agent.lifecycle === 'READY');
  const projects = snapshot.projects.filter((item) => item.status !== 'archived');
  const valid = !!title.trim() && (kind === 'task' ? !!agentId : !!projectId);

  const selectKind = (next: AutomationScheduleKind) => {
    setKind(next);
    if (!title.trim() || Object.values(KIND_META).some((item) => title === item.label)) setTitle(KIND_META[next].label);
    if (next === 'weekly_report') { setCronKind('weekly'); setCronValue('5|17:00'); }
    if (next === 'monthly_report') { setCronKind('monthly'); setCronValue('1|09:00'); }
    if (next === 'project_inspection') { setCronKind('daily'); setCronValue('09:00'); }
  };
  const save = async () => {
    if (!valid) return;
    setBusy(true);
    const input: ScheduleInput = {
      automationKind: kind, agentId: kind === 'task' ? agentId : undefined,
      projectId: projectId || undefined, title: title.trim(), content: kind === 'task' ? content.trim() : '', cronKind, cronValue
    };
    try {
      if (schedule) {
        await window.aibox.updateSchedule(schedule.id, { ...input, agentId: input.agentId ?? '', projectId: input.projectId ?? '' });
        onSaved({ ...schedule, ...input, agentId: input.agentId ?? null, projectId: input.projectId ?? null, content: input.content ?? '' });
      } else onSaved(await window.aibox.createSchedule(input));
      toast.ok(schedule ? '自动计划已更新' : '自动计划已创建');
    } catch (error) { toast.err(error instanceof Error ? error.message : '计划保存失败'); }
    finally { setBusy(false); }
  };

  return <Modal title={schedule ? '编辑自动计划' : '新建自动计划'} width={620} onClose={onClose} footer={<>
    <button className="btn" type="button" onClick={onClose}>取消</button>
    <button className="btn primary" type="button" disabled={busy || !valid} onClick={() => void save()}>{busy ? '保存中...' : '保存计划'}</button>
  </>}>
    <div className="field"><label>计划类型</label><div className="schedule-kind-grid">{(Object.keys(KIND_META) as AutomationScheduleKind[]).map((value) =>
      <button key={value} type="button" className={kind === value ? 'active' : ''} onClick={() => selectKind(value)}><strong>{KIND_META[value].label}</strong><span>{KIND_META[value].description}</span></button>)}</div></div>
    <div className="automation-form-grid">
      {kind === 'task' && <div className="field"><label>数字员工</label><select value={agentId} onChange={(event) => setAgentId(event.target.value)}><option value="">选择员工</option>{agents.map((item) => <option value={item.agent.id} key={item.agent.id}>{item.agent.name} · {item.agent.role}</option>)}</select></div>}
      <div className="field"><label>{kind === 'task' ? '归属项目（可选）' : '项目'}</label><select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">{kind === 'task' ? '不归属项目' : '选择项目'}</option>{projects.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></div>
    </div>
    <div className="field"><label>计划标题</label><input value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} placeholder="例如：客户交付项目周报" /></div>
    {kind === 'task' && <div className="field"><label>任务指令</label><textarea rows={4} value={content} maxLength={4000} onChange={(event) => setContent(event.target.value)} placeholder="描述数字员工每次需要执行的具体工作" /></div>}
    <CronEditor kind={cronKind} value={cronValue} onChange={(nextKind, nextValue) => { setCronKind(nextKind); setCronValue(nextValue); }} />
  </Modal>;
}

function CronEditor({ kind, value, onChange }: { kind: Schedule['cronKind']; value: string; onChange: (kind: Schedule['cronKind'], value: string) => void }) {
  const changeKind = (next: Schedule['cronKind']) => onChange(next, next === 'interval' ? '4' : next === 'daily' ? '09:00' : '1|09:00');
  const [part, time = '09:00'] = value.split('|');
  return <div className="field"><label>执行周期</label><div className="automation-segmented schedule-cron-tabs">{(Object.keys(CRON_LABEL) as Schedule['cronKind'][]).map((item) =>
    <button className={kind === item ? 'active' : ''} type="button" key={item} onClick={() => changeKind(item)}>{CRON_LABEL[item]}</button>)}</div>
    <div className="schedule-cron-value">
      {kind === 'interval' && <><span>每</span><input aria-label="间隔小时" type="number" min={0.5} max={168} step={0.5} value={value} onChange={(event) => onChange(kind, event.target.value)} /><span>小时</span></>}
      {kind === 'daily' && <><span>每天</span><input aria-label="每日时间" type="time" value={value} onChange={(event) => onChange(kind, event.target.value)} /></>}
      {kind === 'weekly' && <><span>每周</span><select aria-label="星期" value={part} onChange={(event) => onChange(kind, `${event.target.value}|${time}`)}>{['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((label, index) => <option value={index} key={label}>{label}</option>)}</select><input aria-label="每周时间" type="time" value={time} onChange={(event) => onChange(kind, `${part}|${event.target.value}`)} /></>}
      {kind === 'monthly' && <><span>每月</span><input aria-label="每月日期" type="number" min={1} max={28} value={part} onChange={(event) => onChange(kind, `${event.target.value}|${time}`)} /><span>日</span><input aria-label="每月时间" type="time" value={time} onChange={(event) => onChange(kind, `${part}|${event.target.value}`)} /></>}
    </div>
  </div>;
}

function ScheduleHistory({ schedule, onClose }: { schedule: Schedule; onClose: () => void }) {
  const [history, setHistory] = useState<{ id: string; title: string; status: string; createdAt: number }[] | null>(null);
  useEffect(() => { void window.aibox.getScheduleHistory(schedule.id).then(setHistory).catch(() => setHistory([])); }, [schedule.id]);
  return <Modal title={`运行历史 · ${schedule.title}`} width={560} onClose={onClose} footer={<button className="btn" onClick={onClose}>关闭</button>}>
    {!history ? <div className="automation-empty">正在读取历史...</div> : history.length === 0 ? <div className="automation-empty">尚无运行记录</div>
      : <div className="schedule-history">{history.map((item) => <div key={item.id}><span data-status={item.status} /><strong>{item.title}</strong><small>{statusLabel(item.status)}</small><time>{timeLabel(item.createdAt)}</time></div>)}</div>}
  </Modal>;
}

function cronDescription(schedule: Schedule): string {
  if (schedule.cronKind === 'interval') return `每 ${schedule.cronValue} 小时`;
  if (schedule.cronKind === 'daily') return `每天 ${schedule.cronValue}`;
  const [part, time] = schedule.cronValue.split('|');
  if (schedule.cronKind === 'monthly') return `每月 ${part} 日 ${time}`;
  return `每${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][Number(part)] ?? part} ${time}`;
}
function countdown(timestamp: number): string {
  const difference = timestamp - Date.now();
  if (difference <= 0) return '即将运行';
  const hours = Math.floor(difference / 3_600_000); const minutes = Math.floor(difference % 3_600_000 / 60_000);
  if (hours >= 24) return `${Math.floor(hours / 24)} 天后运行`;
  return hours > 0 ? `${hours} 小时 ${minutes} 分后运行` : `${Math.max(1, minutes)} 分钟后运行`;
}
function timeLabel(timestamp: number): string { return new Date(timestamp).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function statusLabel(status: string): string { return ({ COMPLETED: '已完成', FAILED: '失败', RUNNING: '运行中', QUEUED: '排队', CANCELLED: '已取消' } as Record<string, string>)[status] ?? status; }
