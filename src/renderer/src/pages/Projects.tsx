/** 项目中心：以经营目标组织任务、员工与成果。 */
import { useMemo, useState } from 'react';
import { useApp } from '../store';
import { Modal, ProgressBar, TASK_STATUS_META } from '../components/common';
import { IconClock, IconFolder, IconPlay, IconPlus } from '../components/icons';
import { toast } from '../components/Toast';
import type { Project, ProjectInput, ProjectStatus, Task } from '@shared/types';

type ProjectFilter = 'open' | 'completed' | 'archived' | 'all';

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
  const { snapshot } = useApp();
  const [filter, setFilter] = useState<ProjectFilter>('open');
  const [editing, setEditing] = useState<Project | 'new' | null>(null);
  const [viewing, setViewing] = useState<Project | null>(null);
  const [dispatching, setDispatching] = useState<Project | null>(null);
  const [archiving, setArchiving] = useState<Project | null>(null);

  const projects = snapshot?.projects ?? [];
  const tasks = snapshot?.tasks ?? [];
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
    const scoped = tasks.filter((task) => task.projectId === project.id);
    const completed = scoped.filter((task) => task.status === 'COMPLETED').length;
    const deliverables = scoped.filter((task) => task.status === 'COMPLETED' && task.result?.trim()).length;
    const active = scoped.filter((task) => ['RUNNING', 'QUEUED', 'WAITING_APPROVAL', 'PAUSED'].includes(task.status)).length;
    return { tasks: scoped, completed, deliverables, active, progress: scoped.length ? Math.round((completed / scoped.length) * 100) : 0 };
  };

  return (
    <div className="projects-page">
      <div className="page-head">
        <h2>项目中心</h2>
        <span className="desc">{counts.open} 个进行中 · {tasks.filter((t) => t.projectId).length} 项已归属任务</span>
        <div className="right">
          <button className="btn small primary" type="button" onClick={() => setEditing('new')}><IconPlus size={13} />新建项目</button>
        </div>
      </div>

      <div className="project-filterbar" aria-label="项目状态筛选">
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
                </div>

                <div className="project-actions">
                  <button className="btn small" type="button" onClick={() => setViewing(project)}>详情</button>
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
      )}

      {editing && <ProjectEditor project={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {dispatching && <ProjectDispatch project={dispatching} onClose={() => setDispatching(null)} />}
      {viewing && <ProjectDetail project={viewing} tasks={tasks.filter((task) => task.projectId === viewing.id)} onClose={() => setViewing(null)} onDispatch={() => { setViewing(null); setDispatching(viewing); }} />}
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

const PROJECT_COLORS = ['#4d6bfe', '#22c1a3', '#3aa7ff', '#f59e0b', '#ef6a6a', '#8a5cf6'];

function ProjectEditor({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const [name, setName] = useState(project?.name ?? '');
  const [objective, setObjective] = useState(project?.objective ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [clientName, setClientName] = useState(project?.clientName ?? '');
  const [status, setStatus] = useState<Exclude<ProjectStatus, 'archived'>>(project?.status === 'archived' ? 'active' : project?.status ?? 'active');
  const [color, setColor] = useState(project?.color ?? PROJECT_COLORS[0]);
  const [dueDate, setDueDate] = useState(project?.dueAt ? localDateValue(project.dueAt) : '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (name.trim().length < 2) return toast.err('项目名称至少需要 2 个字符');
    const input: ProjectInput = {
      name: name.trim(), objective: objective.trim(), description: description.trim(), clientName: clientName.trim(),
      status, color, dueAt: dueDate ? new Date(`${dueDate}T23:59:59`).getTime() : null
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

function ProjectDetail({ project, tasks, onClose, onDispatch }: { project: Project; tasks: Task[]; onClose: () => void; onDispatch: () => void }) {
  const { snapshot } = useApp();
  const agentNames = new Map(snapshot?.agentCards.map((card) => [card.agent.id, card.agent.name]) ?? []);
  const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <Modal title={project.name} onClose={onClose} width={760} footer={(
      <>
        <button className="btn" type="button" onClick={onClose}>关闭</button>
        <button className="btn primary" type="button" disabled={['completed', 'archived'].includes(project.status)} onClick={onDispatch}><IconPlay size={13} />派发任务</button>
      </>
    )}>
      <div className="project-detail-head" style={{ '--project-color': project.color } as React.CSSProperties}>
        <span className="project-color" />
        <div><strong>{project.objective || '未设置核心目标'}</strong>{project.description && <p>{project.description}</p>}</div>
      </div>
      <div className="project-detail-meta"><span>{STATUS_META[project.status].label}</span><span>{project.clientName || '内部项目'}</span><span>{project.dueAt ? `截止 ${new Date(project.dueAt).toLocaleDateString('zh-CN')}` : '无截止时间'}</span></div>
      <div className="card-title" style={{ marginTop: 18 }}>关联任务<span className="sub">{tasks.length} 项</span></div>
      {sorted.length === 0 ? <div className="empty">暂无关联任务</div> : <div className="project-task-list">{sorted.slice(0, 20).map((task) => <div key={task.id}><span className={`tag ${TASK_STATUS_META[task.status].tag}`}>{TASK_STATUS_META[task.status].label}</span><strong>{task.title}</strong><span>{agentNames.get(task.agentId) ?? '未知员工'}</span><time>{new Date(task.createdAt).toLocaleDateString('zh-CN')}</time></div>)}</div>}
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
