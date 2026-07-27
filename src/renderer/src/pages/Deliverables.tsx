/** 成果库：按专家团终稿或单个数字员工查看产出，并进行质量标记。 */
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { AgentAvatar, Modal } from '../components/common';
import { IconCheck, IconLayers, IconRefresh, IconTask, IconX } from '../components/icons';
import { toast } from '../components/Toast';
import type { Task, TaskQuality, TeamRun } from '../../../shared/types';

type QualityKey = 'accepted' | 'rejected' | 'rework' | 'unmarked';
type FilterKey = 'all' | QualityKey;

interface TeamDeliverable {
  id: string;
  teamName: string;
  projectId: string | null;
  title: string;
  result: string;
  createdAt: number;
  endedAt: number;
}

type Viewing =
  | { kind: 'task'; item: Task }
  | { kind: 'team'; item: TeamDeliverable };

const QUALITY_META: Record<QualityKey, { label: string; tone: QualityKey }> = {
  accepted: { label: '已采纳', tone: 'accepted' },
  rejected: { label: '已驳回', tone: 'rejected' },
  rework: { label: '需返工', tone: 'rework' },
  unmarked: { label: '未标记', tone: 'unmarked' }
};

const QUALITY_FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'accepted', label: '已采纳' },
  { key: 'rework', label: '需返工' },
  { key: 'rejected', label: '已驳回' },
  { key: 'unmarked', label: '未标记' }
];

export function Deliverables() {
  const { snapshot } = useApp();
  const [filter, setFilter] = useState<FilterKey>('all');
  const [agentFilter, setAgentFilter] = useState<string>('team');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [viewing, setViewing] = useState<Viewing | null>(null);
  const [teamDeliverables, setTeamDeliverables] = useState<TeamDeliverable[]>([]);
  const [teamLoading, setTeamLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const loadTeamDeliverables = async () => {
      try {
        const teams = await window.aibox.listTeams();
        const runsByTeam = await Promise.all(teams.map((team) => window.aibox.getTeamRuns(team.id)));
        if (cancelled) return;

        const items = teams.flatMap((team, index) => (
          runsByTeam[index]
            .filter((run: TeamRun) => run.phase === 'done' && run.finalResult?.trim())
            .map((run: TeamRun) => ({
              id: run.id,
              teamName: team.name,
              projectId: run.projectId,
              title: run.taskText,
              result: run.finalResult!.trim(),
              createdAt: run.createdAt,
              endedAt: run.endedAt ?? run.createdAt
            }))
        ));

        setTeamDeliverables(items.sort((a, b) => b.endedAt - a.endedAt));
      } catch {
        // IPC 暂不可用时保留上一次结果，下一轮轮询自动重试。
      } finally {
        if (!cancelled) setTeamLoading(false);
      }
    };

    void loadTeamDeliverables();
    const timer = window.setInterval(() => void loadTeamDeliverables(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const matchesProject = (projectId: string | null) => projectFilter === 'all'
    || (projectFilter === 'unassigned' ? !projectId : projectId === projectFilter);

  const deliverables = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.tasks
      .filter((task) => task.status === 'COMPLETED' && task.result?.trim())
      .filter((task) => matchesProject(task.projectId))
      .sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt));
  }, [projectFilter, snapshot]);

  const scopedTeamDeliverables = useMemo(
    () => teamDeliverables.filter((item) => matchesProject(item.projectId)),
    [projectFilter, teamDeliverables]
  );

  const agents = useMemo(() => {
    if (!snapshot) return [];

    const counts = new Map<string, number>();
    deliverables.forEach((item) => counts.set(item.agentId, (counts.get(item.agentId) ?? 0) + 1));

    const result = snapshot.agentCards
      .filter(({ agent }) => !agent.archived || counts.has(agent.id))
      .map(({ agent }) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        color: agent.avatarColor,
        count: counts.get(agent.id) ?? 0
      }));

    const knownIds = new Set(result.map((agent) => agent.id));
    counts.forEach((count, id) => {
      if (!knownIds.has(id)) {
        result.push({ id, name: '数字员工', role: '已归档员工', color: 'var(--text-3)', count });
      }
    });

    return result.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
  }, [deliverables, snapshot]);

  useEffect(() => {
    if (agentFilter !== 'team' && !agents.some((agent) => agent.id === agentFilter)) {
      setAgentFilter('team');
    }
  }, [agentFilter, agents]);

  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);

  const scopedDeliverables = useMemo(() => (
    agentFilter === 'team'
      ? []
      : deliverables.filter((item) => item.agentId === agentFilter)
  ), [agentFilter, deliverables]);

  const qualityCounts = useMemo(() => {
    const counts: Record<FilterKey, number> = {
      all: scopedDeliverables.length,
      accepted: 0,
      rejected: 0,
      rework: 0,
      unmarked: 0
    };
    scopedDeliverables.forEach((item) => {
      counts[item.quality ?? 'unmarked'] += 1;
    });
    return counts;
  }, [scopedDeliverables]);

  const filtered = useMemo(() => (
    filter === 'all'
      ? scopedDeliverables
      : scopedDeliverables.filter((item) => (item.quality ?? 'unmarked') === filter)
  ), [filter, scopedDeliverables]);

  if (!snapshot) return null;

  const selectedAgent = agentFilter === 'team' ? null : agentById.get(agentFilter);
  const scopeLabel = selectedAgent?.name ?? '专家团整体';
  const scopeCount = agentFilter === 'team' ? scopedTeamDeliverables.length : scopedDeliverables.length;
  const visibleCount = agentFilter === 'team' ? scopedTeamDeliverables.length : filtered.length;
  const hasResults = visibleCount > 0;
  const projects = snapshot.projects ?? [];
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const projectScopeLabel = projectFilter === 'all' ? '全部项目' : projectFilter === 'unassigned' ? '未归项目' : projectById.get(projectFilter)?.name ?? '已归档项目';

  const setQuality = async (task: Task, quality: TaskQuality) => {
    await window.aibox.setTaskQuality(task.id, quality);
    const label = quality ? QUALITY_META[quality].label : '已清除标记';
    toast.ok(`「${task.title.slice(0, 20)}」${label}`);
  };

  const copyOutput = (content: string) => {
    void navigator.clipboard.writeText(content);
    toast.ok('产出已复制到剪贴板');
  };

  const viewingTitle = viewing?.item.title ?? '';
  const viewingOwner = viewing?.kind === 'team'
    ? `${viewing.item.teamName} · 专家团终稿`
    : viewing?.kind === 'task'
      ? agentById.get(viewing.item.agentId)?.name ?? '数字员工'
      : '';
  const viewingTime = viewing?.kind === 'team'
    ? viewing.item.endedAt
    : viewing?.kind === 'task'
      ? viewing.item.endedAt ?? viewing.item.createdAt
      : 0;
  const viewingResult = viewing?.item.result ?? '';
  const viewingProjectId = viewing?.item.projectId ?? null;

  return (
    <div className="deliverables-page">
      <div className="page-head">
        <h2>成果库</h2>
        <span className="desc">{agents.length} 位数字员工 · {deliverables.length + scopedTeamDeliverables.length} 项成果</span>
        <div className="right">
          <select className="project-scope-select" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} aria-label="按项目筛选成果" style={{ minWidth: 160 }}>
            <option value="all">全部项目</option>
            <option value="unassigned">未归项目</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </div>
      </div>

      <section className="deliverable-owner-section" aria-labelledby="deliverable-owner-title">
        <div className="deliverable-section-head">
          <h3 id="deliverable-owner-title">成果归属</h3>
          <span>{projectScopeLabel} · {scopeLabel} · {scopeCount} 项</span>
        </div>
        <div className="deliverable-owner-list">
          <button
            className={`deliverable-owner-option ${agentFilter === 'team' ? 'active' : ''}`}
            type="button"
            aria-pressed={agentFilter === 'team'}
            onClick={() => setAgentFilter('team')}
          >
            <span className="deliverable-team-avatar"><IconLayers size={19} /></span>
            <span className="deliverable-owner-copy">
              <strong>专家团整体</strong>
              <small>协作终稿</small>
            </span>
            <span className="deliverable-owner-count">{scopedTeamDeliverables.length}</span>
          </button>

          {agents.map((agent) => (
            <button
              key={agent.id}
              className={`deliverable-owner-option ${agentFilter === agent.id ? 'active' : ''}`}
              type="button"
              aria-pressed={agentFilter === agent.id}
              onClick={() => setAgentFilter(agent.id)}
            >
              <AgentAvatar color={agent.color} size={36} />
              <span className="deliverable-owner-copy">
                <strong>{agent.name}</strong>
                <small>{agent.role}</small>
              </span>
              <span className="deliverable-owner-count">{agent.count}</span>
            </button>
          ))}
        </div>
      </section>

      {agentFilter !== 'team' && (
        <div className="deliverable-filterbar">
          <div className="deliverable-filter-label">质量状态</div>
          <div className="deliverable-quality-switch" aria-label="按质量状态筛选">
            {QUALITY_FILTERS.map((item) => (
              <button
                key={item.key}
                className={filter === item.key ? 'active' : ''}
                type="button"
                aria-pressed={filter === item.key}
                onClick={() => setFilter(item.key)}
              >
                {item.label}<span>{qualityCounts[item.key]}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="deliverable-results-head">
        <div>
          <h3>{scopeLabel}成果</h3>
          <span>展示 {visibleCount} / {scopeCount} 项</span>
        </div>
      </div>

      {!hasResults ? (
        <div className="deliverable-empty">
          <span><IconLayers size={26} /></span>
          <strong>{teamLoading && agentFilter === 'team' ? '正在汇总' : '暂无成果'}</strong>
          <small>
            {agentFilter === 'team'
              ? '专家团完成协作后，终稿会汇总到这里。'
              : `${scopeLabel}在当前质量状态下没有成果。`}
          </small>
        </div>
      ) : agentFilter === 'team' ? (
        <div className="deliverable-list">
          {scopedTeamDeliverables.map((item) => (
            <article key={item.id} className="card deliverable-card">
              <div className="deliverable-card-top">
                <span className="deliverable-team-avatar"><IconLayers size={19} /></span>
                <div className="deliverable-card-heading">
                  <strong title={item.title}>{item.title}</strong>
                  <div className="deliverable-card-meta">
                    <span>{item.teamName}</span>
                    <span>{item.projectId ? projectById.get(item.projectId)?.name ?? '已归档项目' : '未归项目'}</span>
                    <span className="deliverable-source"><IconTask size={11} />专家团终稿</span>
                    <time>{new Date(item.endedAt).toLocaleString('zh-CN', { hour12: false })}</time>
                  </div>
                </div>
              </div>

              <div className="deliverable-preview">
                {item.result.slice(0, 240)}{item.result.length > 240 ? '…' : ''}
              </div>

              <div className="deliverable-actions">
                <button className="btn small" type="button" onClick={() => setViewing({ kind: 'team', item })}>查看完整终稿</button>
                <button className="btn small" type="button" onClick={() => copyOutput(item.result)}>复制</button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="deliverable-list">
          {filtered.map((item) => {
            const quality = item.quality ?? 'unmarked';
            const owner = agentById.get(item.agentId);
            return (
              <article key={item.id} className="card deliverable-card">
                <div className="deliverable-card-top">
                  <AgentAvatar color={owner?.color ?? 'var(--text-3)'} size={38} />
                  <div className="deliverable-card-heading">
                    <strong title={item.title}>{item.title}</strong>
                    <div className="deliverable-card-meta">
                      <span>{owner?.name ?? '数字员工'}</span>
                      <span>{item.projectId ? projectById.get(item.projectId)?.name ?? '已归档项目' : '未归项目'}</span>
                      {item.source === 'team' && <span className="deliverable-source"><IconTask size={11} />专家团子任务</span>}
                      <time>{new Date(item.endedAt ?? item.createdAt).toLocaleString('zh-CN', { hour12: false })}</time>
                    </div>
                  </div>
                  <span className="deliverable-quality" data-tone={QUALITY_META[quality].tone}>
                    {QUALITY_META[quality].label}
                  </span>
                </div>

                <div className="deliverable-preview">
                  {(item.result ?? '').slice(0, 240)}{(item.result ?? '').length > 240 ? '…' : ''}
                </div>

                <div className="deliverable-actions">
                  <button className="btn small" type="button" onClick={() => setViewing({ kind: 'task', item })}>查看完整产出</button>
                  <button className="btn small" type="button" onClick={() => copyOutput(item.result ?? '')}>复制</button>
                  <span className="deliverable-action-divider" />
                  <button className="btn small deliverable-accept" type="button" aria-pressed={quality === 'accepted'} onClick={() => void setQuality(item, 'accepted')}>
                    <IconCheck size={13} />采纳
                  </button>
                  <button className="btn small deliverable-rework" type="button" aria-pressed={quality === 'rework'} onClick={() => void setQuality(item, 'rework')}>
                    <IconRefresh size={13} />返工
                  </button>
                  <button className="btn small deliverable-reject" type="button" aria-pressed={quality === 'rejected'} onClick={() => void setQuality(item, 'rejected')}>
                    <IconX size={13} />驳回
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {viewing && (
        <Modal
          title={viewingTitle}
          onClose={() => setViewing(null)}
          width={680}
          footer={(
            <>
              <button className="btn" type="button" onClick={() => copyOutput(viewingResult)}>复制全文</button>
              <button className="btn primary" type="button" onClick={() => setViewing(null)}>关闭</button>
            </>
          )}
        >
          <div className="deliverable-modal-meta">
            {viewingProjectId ? projectById.get(viewingProjectId)?.name ?? '已归档项目' : '未归项目'} · {viewingOwner} · {new Date(viewingTime).toLocaleString('zh-CN', { hour12: false })}
          </div>
          <pre className="deliverable-modal-output">{viewingResult}</pre>
        </Modal>
      )}
    </div>
  );
}
