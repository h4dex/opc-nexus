/** 项目中心：以经营目标组织任务、员工与成果。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { Modal, ProgressBar } from '../components/common';
import { IconAlert, IconCheck, IconClock, IconFolder, IconLayers, IconPlay, IconPlus, IconTask, IconUser } from '../components/icons';
import { toast } from '../components/Toast';
import { TrailingRefreshController } from '../utils/trailingRefresh';
import type { Project, ProjectHealth, ProjectInput, ProjectOperationsOverview, ProjectStatus } from '@shared/types';

type ProjectFilter = 'open' | 'completed' | 'archived' | 'all';
type ProjectView = 'operations' | 'list';

const STATUS_META: Record<ProjectStatus, { label: string; tone: string }> = {
  planning: { label: '规划中', tone: 'gray' },
  active: { label: '进行中', tone: 'blue' },
  paused: { label: '已暂停', tone: 'orange' },
  completed: { label: '已完成', tone: 'green' },
  archived: { label: '已归档', tone: 'gray' }
};

const FILTERS: { key: ProjectFilter; label: string }[] = [
  { key: 'open', label: '进行中' },
  { key: 'completed', label: '已完成' },
  { key: 'archived', label: '已归档' },
  { key: 'all', label: '全部' }
];

export function Projects() {
  const { snapshot, navigationTarget, clearNavigationTarget, openQuest } = useApp();
  const [view, setView] = useState<ProjectView>('operations');
  const [filter, setFilter] = useState<ProjectFilter>('open');
  const [operations, setOperations] = useState<ProjectOperationsOverview | null>(null);
  const [editing, setEditing] = useState<Project | 'new' | null>(null);
  const [dispatching, setDispatching] = useState<Project | null>(null);
  const [archiving, setArchiving] = useState<Project | null>(null);
  const refreshRef = useRef<TrailingRefreshController<ProjectOperationsOverview> | null>(null);
  if (!refreshRef.current) refreshRef.current = new TrailingRefreshController();
  const refresh = refreshRef.current;
  const firstLoadRef = useRef(true);

  const projects = snapshot?.projects ?? [];
  const tasks = snapshot?.tasks ?? [];
  const openProjectWorkbench = useCallback((project: Project) => {
    openQuest(project.id);
  }, [openQuest]);
  const loadOperations = useCallback((immediate = false) => refresh.request({
    run: () => window.aibox.getProjectOperations(),
    accept: setOperations,
    reject: (error) => toast.err(error instanceof Error ? error.message : '项目经营数据加载失败')
  }, { immediate }), [refresh]);
  useEffect(() => {
    return () => {
      firstLoadRef.current = true;
      refresh.cancel();
    };
  }, [refresh]);
  useEffect(() => {
    void loadOperations(firstLoadRef.current);
    firstLoadRef.current = false;
  }, [loadOperations, snapshot?.version]);
  useEffect(() => {
    if (!snapshot || navigationTarget?.entityType !== 'project') return;
    const project = snapshot.projects.find((item) => item.id === navigationTarget.entityId);
    if (!project) return;
    clearNavigationTarget();
    void openProjectWorkbench(project);
  }, [clearNavigationTarget, navigationTarget, openProjectWorkbench, snapshot]);
  const operationByProject = useMemo(
    () => new Map(operations?.projects.map((item) => [item.project.id, item]) ?? []),
    [operations]
  );
  const visible = useMemo(() => projects.filter((project) => {
    if (filter === 'all') return true;
    if (filter === 'open') return ['planning', 'active', 'paused'].includes(project.status);
    return project.status === filter;
  }), [filter, projects]);

  if (!snapshot) return null;

  const counts = {
    open: projects.filter((p) => ['planning', 'active', 'paused'].includes(p.status)).length,
    completed: projects.filter((p) => p.status === 'completed').length,
    archived: projects.filter((p) => p.status === 'archived').length,
    all: projects.length
  };

  const statsFor = (project: Project) => {
    const operation = operationByProject.get(project.id);
    if (operation) return {
      tasks: tasks.filter((task) => task.projectId === project.id), completed: operation.tasks.completed,
      deliverables: operation.deliverables.total, active: operation.tasks.active, progress: operation.progress,
      acceptanceRate: operation.acceptanceRate, health: operation.health
    };
    const scoped = tasks.filter((task) => task.projectId === project.id);
    const completed = scoped.filter((task) => task.status === 'COMPLETED').length;
    const deliverables = scoped.filter((task) => task.status === 'COMPLETED' && (task.hasResult || task.result?.trim())).length;
    const active = scoped.filter((task) => ['RUNNING', 'QUEUED', 'WAITING_APPROVAL', 'PAUSED'].includes(task.status)).length;
    return { tasks: scoped, completed, deliverables, active, progress: scoped.length ? Math.round((completed / scoped.length) * 100) : 0, acceptanceRate: 0, health: 'on_track' as ProjectHealth };
  };

  return (
    <div className="projects-page">
      <div className="page-head">
        <h2>项目中心</h2>
        <span className="desc">{view === 'operations' ? `${counts.open} 个进行中 · ${operations?.summary.atRiskProjects ?? 0} 个需关注` : `${tasks.filter((t) => t.projectId).length} 项已归属任务`}</span>
        <div className="right">
          <div className="project-view-switch" aria-label="项目中心视图">
            <button type="button" className={view === 'operations' ? 'active' : ''} onClick={() => setView('operations')}>经营看板</button>
            <button type="button" className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>项目清单</button>
          </div>
          <button className="btn small primary" type="button" onClick={() => setEditing('new')}><IconPlus size={13} />新建项目</button>
        </div>
      </div>

      {view === 'operations' && <ProjectOperationsDashboard value={operations} onOpen={(project) => void openProjectWorkbench(project)} onCreate={() => setEditing('new')} />}

      {view === 'list' && <><div className="project-filterbar" aria-label="项目状态筛选">
        {FILTERS.map((item) => (
          <button key={item.key} type="button" className={filter === item.key ? 'active' : ''} onClick={() => setFilter(item.key)}>
            {item.label}<span>{counts[item.key]}</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="project-empty">
          <span><IconFolder size={28} /></span>
          <strong>{projects.length === 0 ? '还没有项目' : '当前状态下没有项目'}</strong>
          {projects.length === 0 && <button className="btn small primary" type="button" onClick={() => setEditing('new')}><IconPlus size={13} />新建项目</button>}
        </div>
      ) : (
        <div className="project-list">
          {visible.map((project) => {
            const stats = statsFor(project);
            const status = STATUS_META[project.status];
            const overdue = project.dueAt !== null && project.dueAt < Date.now() && !['completed', 'archived'].includes(project.status);
            return (
              <article className="project-item" key={project.id} style={{ '--project-color': project.color } as React.CSSProperties}>
                <div className="project-item-main">
                  <span className="project-color" />
                  <div className="project-heading">
                    <div>
                      <strong>{project.name}</strong>
                      <span className={`tag ${status.tone}`}>{status.label}</span>
                      <ProjectHealthBadge health={stats.health} />
                    </div>
                    <p>{project.objective || project.description || '尚未填写项目目标'}</p>
                    <div className="project-meta">
                      {project.clientName && <span>{project.clientName}</span>}
                      <span className={overdue ? 'overdue' : ''}><IconClock size={12} />{project.dueAt ? `${overdue ? '已逾期 · ' : ''}${new Date(project.dueAt).toLocaleDateString('zh-CN')}` : '未设置截止时间'}</span>
                    </div>
                  </div>
                </div>

                <div className="project-progress">
                  <div><span>项目进度</span><strong>{stats.progress}%</strong></div>
                  <ProgressBar percent={stats.progress} color={project.color} />
                </div>

                <div className="project-metrics">
                  <span><strong>{stats.tasks.length}</strong>任务</span>
                  <span><strong>{stats.active}</strong>执行中</span>
                  <span><strong>{stats.deliverables}</strong>成果</span>
                  <span><strong>{stats.acceptanceRate}%</strong>验收率</span>
                </div>

                <div className="project-actions">
                  <button
                    className="btn small"
                    type="button"
                    disabled={project.status === 'archived'}
                    onClick={() => openProjectWorkbench(project)}
                    title={project.status === 'archived' ? '归档项目不可打开 Quest' : '打开项目 Quest'}
                  >打开 Quest</button>
                  <button className="btn small primary" type="button" disabled={['completed', 'archived'].includes(project.status)} onClick={() => setDispatching(project)}><IconPlay size={12} />派发任务</button>
                  {project.status === 'archived' ? (
                    <button className="btn small" type="button" onClick={() => void window.aibox.updateProject(project.id, { status: 'active' }).then(() => toast.ok('项目已恢复'))}>恢复</button>
                  ) : (
                    <>
                      <button className="btn small" type="button" onClick={() => setEditing(project)}>编辑</button>
                      <button className="btn small" type="button" onClick={() => setArchiving(project)}>归档</button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}</>}

      {editing && <ProjectEditor project={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {dispatching && <ProjectDispatch project={dispatching} onClose={() => setDispatching(null)} />}
      {archiving && (
        <Modal title="归档项目" onClose={() => setArchiving(null)} footer={(
          <>
            <button className="btn" type="button" onClick={() => setArchiving(null)}>取消</button>
            <button className="btn danger" type="button" onClick={() => {
              void window.aibox.archiveProject(archiving.id).then(() => { toast.ok('项目已归档，历史任务与成果仍会保留'); setArchiving(null); });
            }}>确认归档</button>
          </>
        )}>
          <p style={{ color: 'var(--text-2)', lineHeight: 1.7 }}>归档“{archiving.name}”后将不能继续派发任务，已有任务和成果不会删除。</p>
        </Modal>
      )}
    </div>
  );
}

const HEALTH_META: Record<ProjectHealth, { label: string; tone: string }> = {
  on_track: { label: '正常推进', tone: 'on-track' },
  attention: { label: '需要关注', tone: 'attention' },
  at_risk: { label: '存在风险', tone: 'at-risk' },
  completed: { label: '已闭环', tone: 'completed' },
  inactive: { label: '已归档', tone: 'inactive' }
};

function ProjectHealthBadge({ health }: { health: ProjectHealth }) {
  const meta = HEALTH_META[health];
  return <span className="project-health" data-tone={meta.tone}>{meta.label}</span>;
}

function ProjectOperationsDashboard({ value, onOpen, onCreate }: {
  value: ProjectOperationsOverview | null;
  onOpen: (project: Project) => void;
  onCreate: () => void;
}) {
  const ownerLoad = useMemo(() => {
    const owners = new Map<string, {
      agentId: string; name: string; role: string; total: number; active: number; completed: number; failed: number; projects: Set<string>;
    }>();
    for (const item of value?.projects ?? []) {
      if (item.project.status === 'archived') continue;
      for (const owner of item.owners) {
        const current = owners.get(owner.agentId) ?? {
          agentId: owner.agentId, name: owner.name, role: owner.role, total: 0, active: 0, completed: 0, failed: 0, projects: new Set<string>()
        };
        current.total += owner.totalTasks;
        current.active += owner.activeTasks;
        current.completed += owner.completedTasks;
        current.failed += owner.failedTasks;
        current.projects.add(item.project.name);
        owners.set(owner.agentId, current);
      }
    }
    return [...owners.values()].sort((a, b) => b.active - a.active || b.total - a.total || a.name.localeCompare(b.name, 'zh-CN'));
  }, [value]);

  if (!value) return <div className="project-ops-loading">正在汇总项目经营数据...</div>;
  if (value.projects.length === 0) return (
    <div className="project-empty project-ops-empty">
      <span><IconFolder size={28} /></span><strong>还没有可分析的项目</strong>
      <button className="btn small primary" type="button" onClick={onCreate}><IconPlus size={13} />新建项目</button>
    </div>
  );

  const healthProjects = value.projects.filter((item) => item.project.status !== 'archived');
  const deliverableTotals = healthProjects.reduce((total, item) => ({
    accepted: total.accepted + item.deliverables.accepted,
    rework: total.rework + item.deliverables.rework,
    rejected: total.rejected + item.deliverables.rejected,
    unmarked: total.unmarked + item.deliverables.unmarked,
    all: total.all + item.deliverables.total
  }), { accepted: 0, rework: 0, rejected: 0, unmarked: 0, all: 0 });
  const statusEntries: Array<{ key: ProjectStatus; label: string; color: string }> = [
    { key: 'planning', label: '规划中', color: '#8b95a7' }, { key: 'active', label: '进行中', color: '#4d6bfe' },
    { key: 'paused', label: '已暂停', color: '#f59e0b' }, { key: 'completed', label: '已完成', color: '#22c1a3' },
    { key: 'archived', label: '已归档', color: '#596273' }
  ];
  const kpis = [
    { label: '进行中项目', value: value.summary.openProjects, suffix: '个', icon: <IconFolder size={17} />, tone: 'blue' },
    { label: '需要关注', value: value.summary.atRiskProjects, suffix: '个', icon: <IconAlert size={17} />, tone: value.summary.atRiskProjects ? 'red' : 'green' },
    { label: '任务完成率', value: value.summary.taskCompletionRate, suffix: '%', icon: <IconTask size={17} />, tone: 'cyan' },
    { label: '已采纳成果', value: value.summary.acceptedDeliverables, suffix: '项', icon: <IconCheck size={17} />, tone: 'green' },
    { label: '待验收成果', value: value.summary.pendingAcceptance, suffix: '项', icon: <IconLayers size={17} />, tone: value.summary.pendingAcceptance ? 'orange' : 'green' }
  ];

  return <div className="project-operations">
    <div className="project-ops-kpis">{kpis.map((item) => <div key={item.label} data-tone={item.tone}>
      <span className="project-ops-kpi-icon">{item.icon}</span><span><small>{item.label}</small><strong>{item.value}<b>{item.suffix}</b></strong></span>
    </div>)}</div>

    <div className="project-ops-main">
      <section className="project-ops-section">
        <header><div><h3>项目健康度</h3><span>{healthProjects.length} 个项目组合</span></div><small>按风险优先级排序</small></header>
        <div className="project-health-list">
          {healthProjects.slice(0, 8).map((item) => <button key={item.project.id} type="button" onClick={() => onOpen(item.project)}>
            <span className="project-health-color" style={{ background: item.project.color }} />
            <span className="project-health-name"><strong>{item.project.name}</strong><small>{item.tasks.total} 项任务 · {item.deliverables.total} 项成果 · {item.owners.length} 名员工</small></span>
            <ProjectHealthBadge health={item.health} />
            <span className="project-health-progress"><span><i style={{ width: `${item.progress}%`, background: item.project.color }} /></span><b>{item.progress}%</b></span>
            <span className="project-health-accept"><small>验收率</small><strong>{item.acceptanceRate}%</strong></span>
          </button>)}
        </div>
      </section>

      <section className="project-ops-section project-risk-section">
        <header><div><h3>风险与阻塞</h3><span>{value.risks.length} 项待处理</span></div><small>{value.summary.overdueProjects} 个逾期</small></header>
        {value.risks.length === 0 ? <div className="project-risk-empty"><IconCheck size={20} />暂无项目风险</div> : <div className="project-risk-list">
          {value.risks.slice(0, 8).map((risk) => <button key={risk.id} type="button" data-severity={risk.severity} onClick={() => {
            const item = value.projects.find((project) => project.project.id === risk.projectId);
            if (item) onOpen(item.project);
          }}><span className="project-risk-dot" /><span><strong>{risk.title}</strong><small>{risk.projectName} · {risk.detail}</small></span><b>{risk.count}</b></button>)}
        </div>}
      </section>
    </div>

    <div className="project-ops-lower">
      <section className="project-ops-section">
        <header><div><h3>员工负载</h3><span>{ownerLoad.length} 名参与员工</span></div><small>活跃任务优先</small></header>
        <div className="project-owner-load">
          {ownerLoad.slice(0, 8).map((owner) => <div key={owner.agentId}><span className="project-owner-icon"><IconUser size={14} /></span><span><strong>{owner.name}</strong><small>{[...owner.projects].slice(0, 2).join('、')}</small></span><span><b>{owner.active}</b> 活跃</span><span>{owner.completed}/{owner.total} 完成</span>{owner.failed > 0 && <span className="project-owner-failed">{owner.failed} 失败</span>}</div>)}
        </div>
      </section>

      <section className="project-ops-section">
        <header><div><h3>组合与验收</h3><span>{value.summary.totalProjects} 个项目 · {deliverableTotals.all} 项成果</span></div><small>当前组合结构</small></header>
        <div className="project-status-bars">{statusEntries.map((status) => {
          const count = value.statusDistribution[status.key];
          const width = value.summary.totalProjects ? Math.round((count / value.summary.totalProjects) * 100) : 0;
          return <div key={status.key}><span>{status.label}</span><span><i style={{ width: `${width}%`, background: status.color }} /></span><b>{count}</b></div>;
        })}</div>
        <div className="project-acceptance-strip">
          <span data-tone="accepted"><strong>{deliverableTotals.accepted}</strong>已采纳</span>
          <span data-tone="unmarked"><strong>{deliverableTotals.unmarked}</strong>未验收</span>
          <span data-tone="rework"><strong>{deliverableTotals.rework}</strong>需返工</span>
          <span data-tone="rejected"><strong>{deliverableTotals.rejected}</strong>已驳回</span>
        </div>
      </section>
    </div>
  </div>;
}

const PROJECT_COLORS = ['#4d6bfe', '#22c1a3', '#3aa7ff', '#f59e0b', '#ef6a6a', '#8a5cf6'];

function ProjectEditor({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const [name, setName] = useState(project?.name ?? '');
  const [objective, setObjective] = useState(project?.objective ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [clientName, setClientName] = useState(project?.clientName ?? '');
  const [status, setStatus] = useState<Exclude<ProjectStatus, 'archived'>>(project?.status === 'archived' ? 'active' : project?.status ?? 'active');
  const [color, setColor] = useState(project?.color ?? PROJECT_COLORS[0]);
  const [dueDate, setDueDate] = useState(project?.dueAt ? localDateValue(project.dueAt) : '');
  const [workspaceMode, setWorkspaceMode] = useState<'automatic' | 'custom'>('automatic');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (name.trim().length < 2) return toast.err('项目名称至少需要 2 个字符');
    const input: ProjectInput = {
      name: name.trim(), objective: objective.trim(), description: description.trim(), clientName: clientName.trim(),
      status, color, dueAt: dueDate ? new Date(`${dueDate}T23:59:59`).getTime() : null,
      ...(!project ? { workspaceMode } : {})
    };
    setSaving(true);
    try {
      if (project) await window.aibox.updateProject(project.id, input);
      else await window.aibox.createProject(input);
      toast.ok(project ? '项目已更新' : '项目已创建');
      onClose();
    } catch (error) {
      toast.err(error instanceof Error ? error.message : '保存项目失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={project ? `编辑项目 · ${project.name}` : '新建项目'} onClose={onClose} width={640} footer={(
      <>
        <button className="btn" type="button" onClick={onClose}>取消</button>
        <button className="btn primary" type="button" disabled={saving || name.trim().length < 2} onClick={() => void save()}>{saving ? '保存中…' : '保存项目'}</button>
      </>
    )}>
      <div className="project-form-grid">
        <div className="field"><label>项目名称 *</label><input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="例如：新品发布准备" /></div>
        <div className="field"><label>客户 / 业务方</label><input value={clientName} maxLength={100} onChange={(e) => setClientName(e.target.value)} placeholder="内部项目可留空" /></div>
        <div className="field project-form-wide"><label>核心目标</label><textarea rows={3} value={objective} maxLength={500} onChange={(e) => setObjective(e.target.value)} placeholder="描述项目最终要达成的业务结果" /></div>
        <div className="field project-form-wide"><label>项目说明</label><textarea rows={3} value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} placeholder="背景、范围、约束与关键资料" /></div>
        <div className="field"><label>状态</label><select value={status} onChange={(e) => setStatus(e.target.value as Exclude<ProjectStatus, 'archived'>)}><option value="planning">规划中</option><option value="active">进行中</option><option value="paused">已暂停</option><option value="completed">已完成</option></select></div>
        <div className="field"><label>截止时间</label><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>
        {!project && <div className="field project-form-wide"><label>交付目录</label><div className="project-workspace-mode" role="group" aria-label="项目交付目录模式">
          <button type="button" className={workspaceMode === 'automatic' ? 'active' : ''} onClick={() => setWorkspaceMode('automatic')}><IconFolder size={13} />系统自动分配</button>
          <button type="button" className={workspaceMode === 'custom' ? 'active' : ''} onClick={() => setWorkspaceMode('custom')}><IconFolder size={13} />创建时选择目录</button>
        </div></div>}
        <div className="field project-form-wide"><label>识别颜色</label><div className="project-swatches">{PROJECT_COLORS.map((item) => <button key={item} type="button" className={color === item ? 'active' : ''} style={{ background: item }} aria-label={`选择颜色 ${item}`} title={item} onClick={() => setColor(item)} />)}</div></div>
      </div>
    </Modal>
  );
}

function ProjectDispatch({ project, onClose }: { project: Project; onClose: () => void }) {
  const { snapshot } = useApp();
  const agents = snapshot?.agentCards.filter((card) => !card.agent.archived && card.agent.lifecycle === 'READY') ?? [];
  const [agentId, setAgentId] = useState(agents[0]?.agent.id ?? '');
  const [title, setTitle] = useState('');
  const [sending, setSending] = useState(false);

  const dispatch = async () => {
    if (!agentId || !title.trim()) return;
    setSending(true);
    try {
      await window.aibox.createTask(agentId, title.trim(), project.id);
      toast.ok(`任务已归入“${project.name}”`);
      onClose();
    } catch (error) {
      toast.err(error instanceof Error ? error.message : '任务派发失败');
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal title={`派发任务 · ${project.name}`} onClose={onClose} width={560} footer={(
      <>
        <button className="btn" type="button" onClick={onClose}>取消</button>
        <button className="btn primary" type="button" disabled={!agentId || !title.trim() || sending} onClick={() => void dispatch()}><IconPlay size={13} />{sending ? '派发中…' : '派发任务'}</button>
      </>
    )}>
      <div className="field"><label>数字员工</label><select value={agentId} onChange={(e) => setAgentId(e.target.value)}><option value="">选择在岗员工</option>{agents.map((card) => <option key={card.agent.id} value={card.agent.id}>{card.agent.name} · {card.agent.role}</option>)}</select></div>
      <div className="field" style={{ marginTop: 14 }}><label>任务简报</label><textarea rows={5} value={title} maxLength={500} onChange={(e) => setTitle(e.target.value)} placeholder="说明预期成果、输入资料和验收标准" /></div>
    </Modal>
  );
}

function localDateValue(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
