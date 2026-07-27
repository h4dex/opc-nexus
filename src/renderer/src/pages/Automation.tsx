/** 经营自动化工作台：巡检报告、计划、预算推荐、客户交付与数据治理。 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { Modal } from '../components/common';
import { MarkdownView } from '../components/MarkdownView';
import { Schedules } from './Schedules';
import { toast } from '../components/Toast';
import {
  IconAlert, IconCheck, IconClock, IconDb, IconDownload, IconEdit, IconFile, IconFolder,
  IconPlus, IconRefresh, IconUser
} from '../components/icons';
import type {
  AssigneeRecommendation, AutomationFinding, AutomationOverview, AutomationReport, AutomationReportKind,
  CustomerDelivery, CustomerDeliveryInput, DeliverableSummary, Project, ProjectBudget
} from '../../../shared/types';

type Tab = 'overview' | 'plans' | 'budget' | 'delivery';
const REPORT_LABEL: Record<AutomationReportKind, string> = {
  project_inspection: '立即巡检', weekly_report: '生成周报', monthly_report: '生成月报'
};
const FINDING_LABEL: Record<AutomationFinding['kind'], string> = {
  overdue: '逾期', low_quality: '质量', duplicate_work: '重复工作', budget: '预算'
};

export function Automation() {
  const { snapshot } = useApp();
  const [tab, setTab] = useState<Tab>('overview');
  const [scope, setScope] = useState('all');
  const [overview, setOverview] = useState<AutomationOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState<AutomationReportKind | null>(null);
  const [actionProjectId, setActionProjectId] = useState('');
  const [report, setReport] = useState<AutomationReport | null>(null);
  const [budget, setBudget] = useState<ProjectBudget | null>(null);
  const [recommendProjectId, setRecommendProjectId] = useState('');
  const [recommendBrief, setRecommendBrief] = useState('');
  const [recommendations, setRecommendations] = useState<AssigneeRecommendation[]>([]);
  const [recommendBusy, setRecommendBusy] = useState(false);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [restoreConfirm, setRestoreConfirm] = useState(false);
  const [restartReady, setRestartReady] = useState(false);

  const projects = useMemo(() => snapshot?.projects.filter((item) => item.status !== 'archived') ?? [], [snapshot?.projects]);
  const load = useCallback(async () => {
    setLoading(true);
    try { setOverview(await window.aibox.getAutomationOverview(scope === 'all' ? undefined : scope)); }
    catch (error) { toast.err(error instanceof Error ? error.message : '经营数据加载失败'); }
    finally { setLoading(false); }
  }, [scope]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const fallback = scope !== 'all' ? scope : projects[0]?.id ?? '';
    setActionProjectId((current) => projects.some((item) => item.id === current) ? current : fallback);
    setRecommendProjectId((current) => projects.some((item) => item.id === current) ? current : fallback);
  }, [projects, scope]);
  if (!snapshot) return null;

  const runReport = async (kind: AutomationReportKind) => {
    if (!actionProjectId) return;
    setRunning(kind);
    try {
      const created = await window.aibox.runAutomationReport(kind, actionProjectId);
      setReport(created); await load(); toast.ok(`${REPORT_LABEL[kind]}已完成`);
    } catch (error) { toast.err(error instanceof Error ? error.message : '报告生成失败'); }
    finally { setRunning(null); }
  };
  const recommend = async () => {
    if (!recommendProjectId) return;
    setRecommendBusy(true);
    try { setRecommendations(await window.aibox.recommendAssignees(recommendProjectId, recommendBrief.trim())); }
    catch (error) { toast.err(error instanceof Error ? error.message : '推荐失败'); }
    finally { setRecommendBusy(false); }
  };
  const updateDelivery = async (item: CustomerDelivery, status: 'delivered' | 'accepted') => {
    try { await window.aibox.updateCustomerDeliveryStatus(item.id, status); await load(); toast.ok(status === 'delivered' ? '已记录客户交付' : '已记录客户确认'); }
    catch (error) { toast.err(error instanceof Error ? error.message : '交付状态更新失败'); }
  };
  const restore = async () => {
    setRestoreConfirm(false);
    const result = await window.aibox.restoreData();
    if (result.ok) { setRestartReady(true); toast.ok(result.message); }
    else if (result.message !== '已取消') toast.err(result.message);
  };

  return <div className="automation-page">
    <div className="page-head">
      <h2>经营自动化</h2><span className="desc">{loading ? '正在更新...' : `更新于 ${overview ? new Date(overview.generatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '--'}`}</span>
      <div className="right">
        <select className="project-scope-select" value={scope} aria-label="按项目筛选经营数据" onChange={(event) => setScope(event.target.value)}><option value="all">专家团整体</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
        <button className="icon-btn" type="button" title="刷新" aria-label="刷新经营数据" disabled={loading} onClick={() => void load()}><IconRefresh size={15} /></button>
      </div>
    </div>
    <nav className="automation-tabs" aria-label="经营自动化视图">
      {([['overview', '经营概览'], ['plans', '自动计划'], ['budget', '预算与推荐'], ['delivery', '交付与数据']] as const).map(([key, label]) =>
        <button key={key} type="button" className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}
    </nav>

    {tab === 'overview' && overview && <>
      <div className="automation-metrics">
        <Metric icon={<IconClock size={17} />} value={overview.summary.activePlans} label="运行计划" />
        <Metric icon={<IconAlert size={17} />} value={overview.summary.highRiskFindings} label="高风险" tone={overview.summary.highRiskFindings ? 'danger' : 'normal'} />
        <Metric icon={<IconFile size={17} />} value={overview.summary.reportsThisMonth} label="本月报告" />
        <Metric icon={<IconDb size={17} />} value={overview.summary.overBudgetProjects} label="预算超额" tone={overview.summary.overBudgetProjects ? 'danger' : 'normal'} />
        <Metric icon={<IconCheck size={17} />} value={overview.summary.pendingDeliveries} label="待确认交付" tone={overview.summary.pendingDeliveries ? 'warn' : 'normal'} />
      </div>
      <section className="automation-runbar">
        <div><label>运行项目</label><select value={actionProjectId} onChange={(event) => setActionProjectId(event.target.value)}>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></div>
        {(Object.keys(REPORT_LABEL) as AutomationReportKind[]).map((kind) => <button className={kind === 'project_inspection' ? 'btn primary' : 'btn'} type="button" key={kind} disabled={!actionProjectId || running !== null} onClick={() => void runReport(kind)}>{running === kind ? '生成中...' : REPORT_LABEL[kind]}</button>)}
      </section>
      <div className="automation-overview-grid">
        <section className="automation-section"><header><h3>经营异常</h3><span>{overview.findings.length}</span></header>
          {overview.findings.length === 0 ? <div className="automation-empty"><IconCheck size={24} /><strong>当前无经营异常</strong></div>
            : <div className="automation-findings">{overview.findings.map((item) => <article key={item.id} data-severity={item.severity}>
              <span>{FINDING_LABEL[item.kind]}</span><div><strong>{item.title}</strong><small>{item.projectName}</small><p>{item.detail}</p></div><b>{item.count}</b>
            </article>)}</div>}
        </section>
        <section className="automation-section"><header><h3>周期报告</h3><span>{overview.reports.length}</span></header>
          {overview.reports.length === 0 ? <div className="automation-empty"><IconFile size={24} /><strong>暂无报告</strong></div>
            : <div className="automation-reports">{overview.reports.slice(0, 12).map((item) => <button type="button" key={item.id} onClick={() => setReport(item)}>
              <span data-kind={item.kind}><IconFile size={15} /></span><div><strong>{item.title}</strong><small>{new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })} · {item.trigger === 'scheduled' ? '自动计划' : '手动生成'}</small></div><b>{item.findings.length} 项异常</b>
            </button>)}</div>}
        </section>
      </div>
    </>}

    {tab === 'plans' && <Schedules embedded onChanged={() => void load()} />}

    {tab === 'budget' && overview && <div className="automation-budget-grid">
      <section className="automation-section"><header><h3>项目预算</h3><span>{overview.budgets.length}</span></header>
        <div className="budget-list">{overview.budgets.map((item) => <article key={item.projectId} data-status={item.status}>
          <div className="budget-heading"><div><strong>{item.projectName}</strong><small>{budgetStatus(item.status)}</small></div><button className="icon-btn" type="button" title="编辑预算" onClick={() => setBudget(item)}><IconEdit size={14} /></button></div>
          <div className="budget-progress"><span style={{ width: `${Math.min(100, item.usagePercent)}%` }} /></div>
          <div className="budget-values"><span><b>{item.spentTokens.toLocaleString('zh-CN')}</b> / {item.tokenLimit ? item.tokenLimit.toLocaleString('zh-CN') : '未设置'} Token</span><span><b>¥{item.spentCost.toFixed(2)}</b> / {item.costLimit ? `¥${item.costLimit.toFixed(2)}` : '未设置'}</span></div>
        </article>)}</div>
      </section>
      <section className="automation-section assignee-panel"><header><h3>执行人推荐</h3><IconUser size={16} /></header>
        <div className="field"><label>项目</label><select value={recommendProjectId} onChange={(event) => { setRecommendProjectId(event.target.value); setRecommendations([]); }}>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></div>
        <div className="field"><label>任务摘要</label><textarea rows={3} maxLength={500} value={recommendBrief} onChange={(event) => setRecommendBrief(event.target.value)} placeholder="例如：整理客户访谈并输出需求优先级" /></div>
        <button className="btn primary" type="button" disabled={!recommendProjectId || recommendBusy} onClick={() => void recommend()}>{recommendBusy ? '分析中...' : '推荐执行人'}</button>
        <div className="recommendation-list">{recommendations.map((item, index) => <article key={item.agentId}><b>{index + 1}</b><div><strong>{item.agentName}</strong><small>{item.role}</small><p>{item.reason}</p></div><span>{item.score}<small>匹配分</small></span></article>)}</div>
      </section>
    </div>}

    {tab === 'delivery' && overview && <>
      <div className="delivery-toolbar"><div><strong>客户交付记录</strong><span>{overview.deliveries.length} 条</span></div><button className="btn primary" type="button" onClick={() => setDeliveryOpen(true)}><IconPlus size={13} />新建交付</button></div>
      <div className="customer-delivery-table"><table className="table"><thead><tr><th>交付</th><th>项目 / 客户</th><th>成果</th><th>时间</th><th>状态</th><th>操作</th></tr></thead><tbody>
        {overview.deliveries.length === 0 && <tr><td colSpan={6}><div className="automation-empty">暂无客户交付记录</div></td></tr>}
        {overview.deliveries.map((item) => <tr key={item.id}><td><strong>{item.title}</strong>{item.note && <small>{item.note}</small>}</td><td><strong>{item.projectName}</strong><small>{item.customerName}</small></td><td>{item.deliverableIds.length} 项</td><td>{new Date(item.updatedAt).toLocaleString('zh-CN', { hour12: false })}</td><td><span className={`delivery-status ${item.status}`}>{deliveryStatus(item.status)}</span></td><td>{item.status === 'draft' ? <button className="btn small primary" onClick={() => void updateDelivery(item, 'delivered')}>标记已交付</button> : item.status === 'delivered' ? <button className="btn small primary" onClick={() => void updateDelivery(item, 'accepted')}>客户已确认</button> : <span className="delivery-complete"><IconCheck size={13} />已完成</span>}</td></tr>)}
      </tbody></table></div>
      <div className="automation-data-grid">
        <section className="automation-section"><header><h3>审计日志</h3><span>{overview.auditLogs.length}</span></header><div className="automation-audits">{overview.auditLogs.slice(0, 50).map((item) => <div key={item.id}><time>{new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })}</time><strong>{auditLabel(item.action)}</strong><span>{item.result}</span></div>)}</div></section>
        <section className="automation-section data-controls"><header><h3>备份与恢复</h3><IconDb size={16} /></header>
          <button className="btn" type="button" onClick={() => void window.aibox.exportData().then((result) => result.ok ? toast.ok(result.message) : result.message !== '已取消' && toast.err(result.message))}><IconDownload size={14} />导出数据库备份</button>
          <button className="btn danger" type="button" onClick={() => setRestoreConfirm(true)}><IconRefresh size={14} />从备份恢复</button>
          {restartReady && <div className="restore-ready"><IconCheck size={16} /><span>备份已暂存，重启后生效</span><button className="btn small primary" onClick={() => void window.aibox.restartApp()}>立即重启</button></div>}
        </section>
      </div>
    </>}

    {report && <Modal title={report.title} width={820} onClose={() => setReport(null)} footer={<button className="btn" onClick={() => setReport(null)}>关闭</button>}><div className="report-meta"><span>{report.trigger === 'scheduled' ? '自动计划' : '手动生成'}</span><time>{new Date(report.createdAt).toLocaleString('zh-CN', { hour12: false })}</time><b>{report.metrics.totalTokens.toLocaleString('zh-CN')} Token · ¥{report.metrics.estimatedCost.toFixed(2)}</b></div><MarkdownView content={report.content} className="automation-report-markdown" /></Modal>}
    {budget && <BudgetModal budget={budget} onClose={() => setBudget(null)} onSaved={async () => { setBudget(null); await load(); }} />}
    {deliveryOpen && <DeliveryModal projects={projects} defaultProjectId={scope === 'all' ? actionProjectId : scope} onClose={() => setDeliveryOpen(false)} onSaved={async () => { setDeliveryOpen(false); await load(); }} />}
    {restoreConfirm && <Modal title="从备份恢复" onClose={() => setRestoreConfirm(false)} footer={<><button className="btn" onClick={() => setRestoreConfirm(false)}>取消</button><button className="btn danger" onClick={() => void restore()}>选择备份并恢复</button></>}><div className="restore-warning"><IconAlert size={20} /><p>当前数据库将在下次重启时被所选备份替换。系统会先校验完整性、核心表和数据库版本；当前数据库不会在校验失败时被修改。</p></div></Modal>}
  </div>;
}

function Metric({ icon, value, label, tone = 'normal' }: { icon: React.ReactNode; value: number; label: string; tone?: string }) {
  return <div data-tone={tone}><span>{icon}</span><b>{value}</b><small>{label}</small></div>;
}

function BudgetModal({ budget, onClose, onSaved }: { budget: ProjectBudget; onClose: () => void; onSaved: () => void }) {
  const [tokenLimit, setTokenLimit] = useState(String(budget.tokenLimit || ''));
  const [costLimit, setCostLimit] = useState(String(budget.costLimit || ''));
  const [warningPercent, setWarningPercent] = useState(budget.warningPercent);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await window.aibox.setProjectBudget(budget.projectId, { tokenLimit: Number(tokenLimit) || 0, costLimit: Number(costLimit) || 0, warningPercent });
      toast.ok('项目预算已更新'); onSaved();
    } catch (error) { toast.err(error instanceof Error ? error.message : '预算保存失败'); }
    finally { setBusy(false); }
  };
  return <Modal title={`设置预算 · ${budget.projectName}`} width={500} onClose={onClose} footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy} onClick={() => void save()}>保存预算</button></>}>
    <div className="automation-form-grid"><div className="field"><label>Token 预算</label><input type="number" min={0} value={tokenLimit} onChange={(event) => setTokenLimit(event.target.value)} placeholder="0 表示不限制" /></div><div className="field"><label>费用预算（¥）</label><input type="number" min={0} step={0.01} value={costLimit} onChange={(event) => setCostLimit(event.target.value)} placeholder="0 表示不限制" /></div></div>
    <div className="field"><label>预警阈值：{warningPercent}%</label><input type="range" min={50} max={100} step={5} value={warningPercent} onChange={(event) => setWarningPercent(Number(event.target.value))} /></div>
  </Modal>;
}

function DeliveryModal({ projects, defaultProjectId, onClose, onSaved }: { projects: Project[]; defaultProjectId: string; onClose: () => void; onSaved: () => void }) {
  const [projectId, setProjectId] = useState(defaultProjectId || projects[0]?.id || '');
  const [deliverables, setDeliverables] = useState<DeliverableSummary[]>([]);
  const [customerName, setCustomerName] = useState(''); const [title, setTitle] = useState(''); const [note, setNote] = useState('');
  const [selected, setSelected] = useState<string[]>([]); const [busy, setBusy] = useState(false);
  useEffect(() => { void window.aibox.listDeliverables().then(setDeliverables); }, []);
  useEffect(() => setSelected([]), [projectId]);
  const eligible = deliverables.filter((item) => item.projectId === projectId && item.reviewStatus === 'accepted');
  const save = async () => {
    const input: CustomerDeliveryInput = { projectId, customerName: customerName.trim(), title: title.trim(), note: note.trim(), deliverableIds: selected };
    setBusy(true);
    try { await window.aibox.createCustomerDelivery(input); toast.ok('客户交付记录已创建'); onSaved(); }
    catch (error) { toast.err(error instanceof Error ? error.message : '交付记录创建失败'); }
    finally { setBusy(false); }
  };
  return <Modal title="新建客户交付" width={620} onClose={onClose} footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy || !projectId || customerName.trim().length < 2 || title.trim().length < 2 || selected.length === 0} onClick={() => void save()}>创建交付</button></>}>
    <div className="automation-form-grid"><div className="field"><label>项目</label><select value={projectId} onChange={(event) => setProjectId(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></div><div className="field"><label>客户</label><input maxLength={100} value={customerName} onChange={(event) => setCustomerName(event.target.value)} /></div></div>
    <div className="field"><label>交付标题</label><input maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} /></div>
    <div className="field"><label>已采纳成果</label><div className="delivery-picks">{eligible.length === 0 ? <span>当前项目暂无已采纳成果</span> : eligible.map((item) => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => setSelected((items) => event.target.checked ? [...items, item.id] : items.filter((id) => id !== item.id))} /><div><strong>{item.title}</strong><small>{item.ownerName} · v{item.latestVersion}</small></div></label>)}</div></div>
    <div className="field"><label>交付备注</label><textarea rows={3} maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} /></div>
  </Modal>;
}

function budgetStatus(status: ProjectBudget['status']): string { return ({ unset: '未设置', normal: '正常', warning: '接近上限', exceeded: '已超额' })[status]; }
function deliveryStatus(status: CustomerDelivery['status']): string { return ({ draft: '草稿', delivered: '已交付', accepted: '客户已确认' })[status]; }
function auditLabel(action: string): string {
  const labels: Record<string, string> = { 'data.export': '导出备份', 'data.restore.stage': '恢复备份', 'delivery.create': '创建交付', 'delivery.status': '交付状态', 'automation.budget.update': '更新预算', 'schedule.create': '创建计划', 'schedule.update': '更新计划', 'schedule.delete': '删除计划', 'schedule.toggle': '启停计划', 'schedule.run': '运行计划' };
  if (action.startsWith('automation.')) return '生成经营报告';
  return labels[action] ?? action;
}
