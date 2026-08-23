/** 专家团管理：模板一键组建 + 创建团队 + 提交团队任务 + 流水线进度 + 编辑/历史/配置/统计 */
import { useEffect, useState, useCallback } from 'react';
import { useApp } from '../store';
import { Modal } from '../components/common';
import { IconAlert, IconCheck, IconClock, IconFile, IconFlow, IconFolder, IconHistory, IconLayers, IconPlus, IconUser, IconPlay, IconX } from '../components/icons';
import { toast } from '../components/Toast';
import { TEAM_TEMPLATES, type TeamTemplate, type TeamTemplateAgent } from '../data/teamTemplates';
import { MARKET_ROLES, DEPARTMENTS, type MarketRole } from '../data/marketRoles';
import { NEXUS_ENGINE_ID, type TeamCollaborationOverview, type TeamRun, type TeamRunSubtask } from '../../../shared/types';
import { isUserVisibleEngine } from '../utils/engineVisibility';

interface TeamData {
  id: string; name: string; coordinatorId: string; memberIds: string[]; mode: string; workspace: string; createdAt: number;
}

interface SavedTeamTemplate {
  id: string;
  name: string;
  description: string;
  mode: string;
  members: TeamTemplateAgent[];
  createdAt: number;
}

const PHASE_LABEL: Record<string, string> = {
  clarify: '澄清/Spec', decompose: '拆解中', execute: '执行中', review: '验收中', done: '已完成', failed: '失败', cancelled: '已取消'
};

export function Teams() {
  const { snapshot, navigationTarget, clearNavigationTarget } = useApp();
  const [view, setView] = useState<'workspace' | 'templates'>('workspace');
  const [teams, setTeams] = useState<TeamData[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [taskInput, setTaskInput] = useState<Record<string, string>>({});
  const [projectInput, setProjectInput] = useState<Record<string, string>>({});
  const [triggerMsg, setTriggerMsg] = useState<Record<string, string>>({});
  const [deploying, setDeploying] = useState<string | null>(null);
  const [deployMsg, setDeployMsg] = useState('');
  const [runs, setRuns] = useState<Record<string, TeamRun | null>>({});
  const [editTeam, setEditTeam] = useState<TeamData | null>(null);
  const [historyTeam, setHistoryTeam] = useState<TeamData | null>(null);
  const [configTeam, setConfigTeam] = useState<TeamData | null>(null);
  const [timelineTeamId, setTimelineTeamId] = useState<string | null>(null);

  useEffect(() => {
    void window.aibox.listTeams().then(setTeams);
  }, [snapshot?.tasks.length]);
  useEffect(() => {
    if (navigationTarget?.entityType !== 'team') return;
    const team = teams.find((item) => item.id === navigationTarget.entityId);
    if (!team) return;
    setView('workspace');
    setHistoryTeam(team);
    clearNavigationTarget();
  }, [clearNavigationTarget, navigationTarget, teams]);

  /** 轮询活跃流水线进度（2s，有未完成 run 时） */
  const hasActiveRun = Object.values(runs).some((r) => r && (
    ['clarify', 'decompose', 'execute', 'review'].includes(r.phase)
    || r.subtasks.some((s) => s.status === 'retrying')
  ));
  const pollRuns = useCallback(() => {
    for (const t of teams) {
      void window.aibox.getTeamRuns(t.id).then((list) => {
        setRuns((prev) => ({ ...prev, [t.id]: list[0] ?? null }));
      });
    }
  }, [teams]);

  useEffect(() => {
    pollRuns();
    if (!hasActiveRun) return;
    const timer = setInterval(pollRuns, 2000);
    return () => clearInterval(timer);
  }, [pollRuns, hasActiveRun]);

  if (!snapshot) return null;

  const trigger = async (teamId: string) => {
    const task = taskInput[teamId]?.trim();
    if (!task) return;
    const r = await window.aibox.triggerTeam(teamId, task, projectInput[teamId] || undefined);
    setTriggerMsg((m) => ({ ...m, [teamId]: r.message }));
    setTaskInput((m) => ({ ...m, [teamId]: '' }));
    setTimeout(() => setTriggerMsg((m) => ({ ...m, [teamId]: '' })), 4000);
    // 立即拉取新 run
    void window.aibox.getTeamRuns(teamId).then((list) => setRuns((prev) => ({ ...prev, [teamId]: list[0] ?? null })));
  };

  /** 从内置或自定义模板组建团队：自动复用同名员工，缺失成员才创建。 */
  const deployTeamSpec = async (key: string, name: string, mode: 'coordinate' | 'roundtable', coordinator: TeamTemplateAgent, members: TeamTemplateAgent[]) => {
    setDeploying(key);
    setDeployMsg('');
    try {
      const existingNames = new Set(snapshot?.agentCards.map((c) => c.agent.name) ?? []);
      const engineId = snapshot?.engines.find((e) =>
        isUserVisibleEngine(e) && ['HEALTHY', 'SETUP_REQUIRED', 'AUTH_REQUIRED'].includes(e.status)
      )?.id ?? NEXUS_ENGINE_ID;
      const allAgents = [coordinator, ...members];
      const nameToId = new Map<string, string>();

      for (const ag of allAgents) {
        if (existingNames.has(ag.name)) {
          const found = snapshot?.agentCards.find((c) => c.agent.name === ag.name);
          if (found) nameToId.set(ag.name, found.agent.id);
        } else {
          const created = await window.aibox.createAgent({
            name: ag.name, role: ag.role, systemPrompt: '', soulMd: ag.soulMd, agentsMd: ag.agentsMd, userMd: '',
            engineId, workspace: '', permissionMode: 'autonomous', concurrencyLimit: 1, channelIds: []
          });
          nameToId.set(ag.name, created.id);
        }
      }

      const coordinatorId = nameToId.get(coordinator.name)!;
      const memberIds = members.map((m) => nameToId.get(m.name)!).filter(Boolean);
      const team = await window.aibox.createTeam({ name, coordinatorId, memberIds, mode });
      setTeams((prev) => [team as unknown as TeamData, ...prev]);
      setDeployMsg(`「${name}」组建成功，${allAgents.length} 位员工已就位`);
      toast.ok(`「${name}」组建成功`);
      setTimeout(() => setDeployMsg(''), 4000);
    } catch (e) {
      const message = `组建失败：${e instanceof Error ? e.message : String(e)}`;
      setDeployMsg(message);
      toast.err(message);
    } finally {
      setDeploying(null);
    }
  };

  const deployTemplate = (tpl: TeamTemplate) => deployTeamSpec(tpl.id, tpl.name, tpl.mode, tpl.coordinator, tpl.members);
  const deploySavedTemplate = (tpl: SavedTeamTemplate) => {
    const [coordinator, ...members] = tpl.members;
    if (!coordinator) { toast.err('模板没有可用成员'); return Promise.resolve(); }
    const mode = tpl.mode === 'roundtable' ? 'roundtable' : 'coordinate';
    return deployTeamSpec(tpl.id, tpl.name, mode, coordinator, members);
  };

  return (
    <>
      <div className="page-head">
        <h2>专家团</h2>
        <span className="desc">{view === 'workspace' ? `${teams.length} 个团队 · 协作过程、贡献与成果可追溯` : '内置方案与自定义团队模板'}</span>
        <div className="right">
          <div className="team-view-switch" aria-label="专家团视图">
            <button type="button" className={view === 'workspace' ? 'active' : ''} onClick={() => setView('workspace')}>协作工作台</button>
            <button type="button" className={view === 'templates' ? 'active' : ''} onClick={() => setView('templates')}>团队模板</button>
          </div>
          {view === 'workspace' && <button className="btn small primary" onClick={() => setCreateOpen(true)}><IconPlus size={13} />组建团队</button>}
        </div>
      </div>

      {view === 'templates' && (
        <div className="team-template-page">
          {deployMsg && <div className="team-deploy-message">{deployMsg}</div>}
          <section className="team-template-section">
            <header><div><IconLayers size={15} /><h3>内置团队方案</h3></div><span>缺失员工会自动创建，同名员工直接复用</span></header>
            <div className="team-template-grid">
              {TEAM_TEMPLATES.map((tpl) => (
                <div key={tpl.id} className="card team-template-card">
                  <div className="team-template-title"><strong>{tpl.name}</strong><span>{tpl.mode === 'coordinate' ? '协调模式' : '圆桌模式'}</span></div>
                  <p>{tpl.description}</p>
                  <div className="team-template-members"><IconUser size={13} /><span>{tpl.coordinator.name} · {tpl.members.map((m) => m.name).join('、')}</span></div>
                  <button className="btn small primary" disabled={deploying === tpl.id} onClick={() => void deployTemplate(tpl)}>
                    <IconPlus size={12} />{deploying === tpl.id ? '组建中...' : '一键组建'}
                  </button>
                </div>
              ))}
            </div>
          </section>
          <CustomTemplates deploying={deploying} onDeploy={deploySavedTemplate} />
        </div>
      )}

      {view === 'workspace' && (
        <div className="team-workspace">
          {teams.length === 0 && (
            <div className="team-empty card">
              <IconUser size={28} />
              <strong>还没有专家团</strong>
              <span>可从团队模板快速组建，或按当前员工自定义协作团队。</span>
              <div><button className="btn small primary" onClick={() => setView('templates')}><IconLayers size={13} />查看模板</button><button className="btn small" onClick={() => setCreateOpen(true)}><IconPlus size={13} />自定义组建</button></div>
            </div>
          )}

          <div className="team-list">
            {teams.map((team) => (
              <div className="card team-card" key={team.id}>
                <header className="team-card-header">
                  <div className="team-card-icon"><IconUser size={21} /></div>
                  <div className="team-card-title">
                    <div><strong>{team.name}</strong><span>{team.mode === 'coordinate' ? '主专家协调' : '专家圆桌'}</span></div>
                    <small><IconFlow size={12} />{team.mode === 'coordinate' ? '澄清 · 拆解 · 并行分派 · 验收' : '多视角分析 · 观点汇总 · 统一结论'}</small>
                    {team.workspace && <small title={team.workspace}><IconFolder size={12} /><span>{team.workspace}</span></small>}
                  </div>
                  <button className="btn small danger team-remove-button" title="解散团队" aria-label={`解散团队 ${team.name}`} onClick={() => void window.aibox.removeTeam(team.id).then(() => setTeams((items) => items.filter((item) => item.id !== team.id)))}>
                    <IconX size={12} /><span>解散</span>
                  </button>
                </header>

                <TeamCollaborationPanel team={team} refreshKey={`${runs[team.id]?.events.length ?? 0}:${runs[team.id]?.endedAt ?? 0}`} />

                <div className="team-task-compose">
                  <select className="project-scope-select" value={projectInput[team.id] ?? ''} onChange={(e) => setProjectInput((current) => ({ ...current, [team.id]: e.target.value }))} aria-label="团队任务归属项目">
                    <option value="">未归项目</option>
                    {(snapshot.projects ?? []).filter((project) => !['completed', 'archived'].includes(project.status)).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </select>
                  <input
                    value={taskInput[team.id] ?? ''}
                    onChange={(e) => setTaskInput((current) => ({ ...current, [team.id]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') void trigger(team.id); }}
                    placeholder="输入团队任务"
                  />
                  <button className="btn primary" disabled={!taskInput[team.id]?.trim()} onClick={() => void trigger(team.id)}><IconPlay size={13} />执行</button>
                </div>
                {triggerMsg[team.id] && <div className="team-trigger-message">{triggerMsg[team.id]}</div>}

                <div className="team-card-actions">
                  <button className="btn small" onClick={() => setEditTeam(team)}><IconUser size={12} />编辑团队</button>
                  <button className="btn small" disabled={!runs[team.id]} onClick={() => setTimelineTeamId(team.id)}><IconClock size={12} />执行时间线</button>
                  <button className="btn small" onClick={() => setHistoryTeam(team)}><IconHistory size={12} />执行历史</button>
                  <button className="btn small" onClick={() => setConfigTeam(team)}>配置</button>
                  <button className="btn small" onClick={() => void window.aibox.saveTeamAsTemplate(team.id).then((result) => { result.ok ? toast.ok(result.message) : toast.err(result.message); })}><IconLayers size={12} />保存为模板</button>
                </div>

                {runs[team.id] && <RunProgress run={runs[team.id]!} onRetry={async (runId, idx) => {
                  const result = await window.aibox.retryTeamSubtask(runId, idx);
                  setTriggerMsg((messages) => ({ ...messages, [team.id]: result.message }));
                  setTimeout(() => setTriggerMsg((messages) => ({ ...messages, [team.id]: '' })), 4000);
                  void window.aibox.getTeamRuns(team.id).then((list) => setRuns((previous) => ({ ...previous, [team.id]: list[0] ?? null })));
                }} onCancel={async (runId) => {
                  const result = await window.aibox.cancelTeamRun(runId);
                  setTriggerMsg((messages) => ({ ...messages, [team.id]: result.message }));
                  setTimeout(() => setTriggerMsg((messages) => ({ ...messages, [team.id]: '' })), 4000);
                  void window.aibox.getTeamRuns(team.id).then((list) => setRuns((previous) => ({ ...previous, [team.id]: list[0] ?? null })));
                }} />}
              </div>
            ))}
          </div>
        </div>
      )}

      {createOpen && <CreateTeamModal onClose={() => setCreateOpen(false)} onCreated={(t) => { setTeams((prev) => [t, ...prev]); setCreateOpen(false); }} />}
      {editTeam && <EditTeamModal team={editTeam} onClose={() => setEditTeam(null)} onSaved={(t) => { setTeams((prev) => prev.map((x) => x.id === t.id ? t : x)); setEditTeam(null); }} />}
      {historyTeam && <TeamHistoryModal team={historyTeam} onClose={() => setHistoryTeam(null)} />}
      {configTeam && <TeamConfigModal team={configTeam} onClose={() => setConfigTeam(null)} />}
      {timelineTeamId && runs[timelineTeamId] && (
        <TeamTimelineModal
          run={runs[timelineTeamId]!}
          teamName={teams.find((t) => t.id === timelineTeamId)?.name ?? ''}
          onClose={() => setTimelineTeamId(null)}
          onChanged={() => void window.aibox.getTeamRuns(timelineTeamId).then((list) => setRuns((prev) => ({ ...prev, [timelineTeamId]: list[0] ?? null })))}
        />
      )}
    </>
  );
}

/** 流水线进度面板：阶段指示器 + 子任务状态（并行调度视图）+ 手动重试 + 耗时 + 取消 + 最终结论 */
function RunProgress({ run, onRetry, onCancel }: { run: TeamRun; onRetry: (runId: string, subtaskIndex: number) => void; onCancel: (runId: string) => void }) {
  const { setRoute } = useApp();
  const active = ['clarify', 'decompose', 'execute', 'review'].includes(run.phase);
  const terminal = ['done', 'failed', 'cancelled'].includes(run.phase);
  const statusColor = (s: string) => s === 'done' ? 'var(--success)' : s === 'failed' ? 'var(--danger)' : s === 'skipped' ? 'var(--text-3)' : (s === 'running' || s === 'retrying') ? 'var(--accent)' : 'var(--text-3)';
  const statusLabel = (s: string) => s === 'done' ? '完成' : s === 'failed' ? '失败' : s === 'running' ? '执行中' : s === 'retrying' ? '重试中' : s === 'skipped' ? '已跳过' : '等待';

  // 耗时：活跃时每秒跳动，终态显示总耗时
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  const elapsedMs = (run.endedAt ?? now) - run.createdAt;
  const elapsedText = elapsedMs < 60_000 ? `${Math.max(0, Math.round(elapsedMs / 1000))}s` : `${Math.floor(elapsedMs / 60_000)}m${Math.round((elapsedMs % 60_000) / 1000)}s`;

  return (
    <div className="team-run-progress" style={{ marginTop: 12, padding: '12px 14px', borderRadius: 8, background: 'var(--input-bg)', border: '1px solid var(--card-border)' }}>
      {/* 阶段指示器 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: run.subtasks.length > 0 ? 10 : 0 }}>
        <span style={{ fontSize: 12, fontWeight: 650, color: run.phase === 'failed' ? 'var(--danger)' : run.phase === 'done' ? 'var(--success)' : run.phase === 'cancelled' ? 'var(--text-3)' : 'var(--accent)' }}>
          {run.phase === 'done' ? '✅' : run.phase === 'failed' ? '❌' : run.phase === 'cancelled' ? '⊘' : '⚙️'} {PHASE_LABEL[run.phase] ?? run.phase}
        </span>
        {run.phase === 'execute' && run.totalSteps > 0 && (
          <span style={{ fontSize: 11.5, color: 'var(--text-2)' }}>第 {run.currentStep} 轮调度 · 共 {run.totalSteps} 个子任务（并行执行）</span>
        )}
        <span style={{ fontSize: 11, color: 'var(--text-3)', fontVariantNumeric: 'tabular-nums' }}>⏱ {elapsedText}</span>
        {active && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>· {run.taskText.slice(0, 40)}{run.taskText.length > 40 ? '…' : ''}</span>}
        {/* 取消按钮：仅执行中可取消 */}
        {active && (
          <button className="btn small" style={{ marginLeft: 'auto', padding: '1px 8px', fontSize: 11, color: 'var(--danger)', flexShrink: 0 }}
            onClick={() => onCancel(run.id)}>■ 取消</button>
        )}
      </div>

      {(run.trace.project || run.trace.tasks.length > 0 || run.trace.deliverable) && (
        <div className="team-run-trace">
          <span><IconFlow size={12} />运行链路</span>
          {run.trace.project && <button type="button" onClick={() => setRoute('projects')}><IconFolder size={12} />{run.trace.project.name}</button>}
          {run.trace.tasks.length > 0 && <button type="button" onClick={() => setRoute('tasks')}><IconCheck size={12} />{run.trace.tasks.length} 个内部任务</button>}
          {run.trace.deliverable && <button type="button" onClick={() => setRoute('deliverables')}><IconFile size={12} />成果 · {run.trace.deliverable.reviewStatus === 'accepted' ? '已采纳' : run.trace.deliverable.reviewStatus === 'rejected' ? '已驳回' : run.trace.deliverable.reviewStatus === 'rework' ? '待返工' : '待验收'}</button>}
        </div>
      )}

      {/* 子任务列表（并行状态） */}
      {run.subtasks.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {run.subtasks.map((st, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span style={{ color: statusColor(st.status), fontWeight: 650, flexShrink: 0 }}>● {statusLabel(st.status)}</span>
              <span style={{ color: 'var(--text-1)', fontWeight: 550, flexShrink: 0 }}>{st.agent}</span>
              {st.round != null && st.round > 1 && <span style={{ fontSize: 10, color: 'var(--text-3)', flexShrink: 0 }}>R{st.round}</span>}
              {(st.retryCount ?? 0) > 0 && <span style={{ fontSize: 10, color: 'var(--warning, #fbbf24)', flexShrink: 0 }}>重试{st.retryCount}次</span>}
              <span style={{ color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{st.subtask}</span>
              {/* 手动重试按钮：仅终态 run 中的失败子任务可重试 */}
              {terminal && st.status === 'failed' && (
                <button className="btn small" style={{ padding: '1px 8px', fontSize: 11, flexShrink: 0, color: 'var(--accent)' }}
                  onClick={() => onRetry(run.id, i)}>↻ 重试</button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 错误 / 最终结论 */}
      {run.error && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--danger)' }}>{run.error}</div>}
      {run.phase === 'done' && run.finalResult && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-1)', background: 'var(--card)', padding: '8px 10px', borderRadius: 6, maxHeight: 120, overflowY: 'auto', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
          {run.finalResult}
        </div>
      )}
    </div>
  );
}

/** 执行时间线抽屉：决策脊柱 + 可展开轮次 + 决策透明化 + 执行干预控制，实时/复盘两用 */
interface TlRoundSubtask { agent: string; status: string; durationMs: number }
interface TlNode {
  kind: 'phase' | 'round' | 'decision' | 'marker' | 'review';
  phase?: string;
  round?: number;
  count?: number;
  action?: string;
  summary?: string;
  reasoning?: string;
  markerType?: 'cancelled' | 'skipped' | 'guidance' | 'force_retry' | 'manual_retry';
  reviewStatus?: 'passed' | 'partial' | 'failed';
  agent?: string;
  message?: string;
  ts: number;
  subtasks: TlRoundSubtask[];
}

const TL_PHASE_LABEL: Record<string, string> = { clarify: '澄清需求 · 生成 Spec', decompose: '任务拆解', review: '验收综合' };

function fmtDur(ms: number): string {
  if (ms <= 0) return '—';
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** 从事件流构建时间线节点；旧记录无事件时从 subtasks 重建 */
function buildTimeline(run: TeamRun): TlNode[] {
  const nodes: TlNode[] = [];
  if (run.events && run.events.length > 0) {
    for (const ev of run.events) {
      if (ev.type === 'phase') {
        nodes.push({ kind: 'phase', phase: ev.phase, ts: ev.ts, subtasks: [] });
      } else if (ev.type === 'round_start') {
        nodes.push({ kind: 'round', round: ev.round, count: ev.count, ts: ev.ts, subtasks: [] });
      } else if (ev.type === 'subtask_done') {
        for (let i = nodes.length - 1; i >= 0; i--) {
          if (nodes[i].kind === 'round' && nodes[i].round === ev.round) {
            nodes[i].subtasks.push({ agent: ev.agent, status: ev.status, durationMs: ev.durationMs });
            break;
          }
        }
      } else if (ev.type === 'decision') {
        nodes.push({ kind: 'decision', round: ev.round, action: ev.action, summary: ev.summary, reasoning: ev.reasoning, ts: ev.ts, subtasks: [] });
      } else if (ev.type === 'cancelled') {
        nodes.push({ kind: 'marker', markerType: 'cancelled', ts: ev.ts, subtasks: [] });
      } else if (ev.type === 'skipped') {
        nodes.push({ kind: 'marker', markerType: 'skipped', round: ev.round, agent: ev.agent, ts: ev.ts, subtasks: [] });
      } else if (ev.type === 'guidance') {
        nodes.push({ kind: 'marker', markerType: 'guidance', message: ev.message, ts: ev.ts, subtasks: [] });
      } else if (ev.type === 'intervention') {
        const markerType = ev.action === 'cancel' ? 'cancelled' : ev.action === 'skip' ? 'skipped' : ev.action;
        nodes.push({ kind: 'marker', markerType, message: ev.message, agent: ev.agent, ts: ev.ts, subtasks: [] });
      } else if (ev.type === 'review') {
        nodes.push({ kind: 'review', reviewStatus: ev.status, summary: ev.summary, ts: ev.ts, subtasks: [] });
      }
    }
    return nodes;
  }
  // 降级：旧记录无事件流，按 subtasks 的 round 重建
  if (run.subtasks.length > 0) {
    const byRound = new Map<number, TeamRunSubtask[]>();
    for (const st of run.subtasks) {
      const r = st.round ?? 1;
      if (!byRound.has(r)) byRound.set(r, []);
      byRound.get(r)!.push(st);
    }
    for (const [r, sts] of [...byRound.entries()].sort((a, b) => a[0] - b[0])) {
      nodes.push({ kind: 'round', round: r, count: sts.length, ts: run.createdAt, subtasks: sts.map((s) => ({ agent: s.agent, status: s.status, durationMs: 0 })) });
    }
  }
  return nodes;
}

function TeamTimelineModal({ run, teamName, onClose, onChanged }: {
  run: TeamRun; teamName: string; onClose: () => void; onChanged: () => void;
}) {
  const active = ['clarify', 'decompose', 'execute', 'review'].includes(run.phase);
  const terminal = ['done', 'failed', 'cancelled'].includes(run.phase);
  const nodes = buildTimeline(run);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [reasoningOpen, setReasoningOpen] = useState<Set<number>>(new Set());
  const [guidance, setGuidance] = useState('');
  const toggleRound = (r: number) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(r)) next.delete(r); else next.add(r);
    return next;
  });
  const toggleReasoning = (i: number) => setReasoningOpen((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });

  /** 统一执行干预控制：调用 IPC + Toast 反馈 + 触发刷新 */
  const doCtl = async (p: Promise<{ ok: boolean; message: string }>) => {
    const r = await p;
    if (r.ok) toast.ok(r.message); else toast.err(r.message);
    onChanged();
  };

  const maxDur = Math.max(1, ...nodes.flatMap((n) => n.subtasks.map((s) => s.durationMs)));
  const stColor = (s: string) => s === 'done' ? 'var(--success)' : s === 'failed' ? 'var(--danger)' : s === 'skipped' ? 'var(--text-3)' : 'var(--accent)';
  const stLabel = (s: string) => s === 'done' ? '✓' : s === 'failed' ? '✗' : s === 'skipped' ? '⊘' : '…';

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }} onClick={onClose}>
      <div className="card" onClick={(e) => e.stopPropagation()} style={{
        width: 540, height: '100%', borderRadius: 0, margin: 0, display: 'flex', flexDirection: 'column',
        borderLeft: '1px solid var(--card-border)', animation: 'toast-in .2s ease-out'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px', borderBottom: '1px solid var(--card-border)' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
              ⏱ 执行时间线 · {teamName}
              {active && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 650, color: 'var(--accent)', padding: '1px 8px', borderRadius: 10, background: 'var(--accent-soft)' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', animation: 'toast-in 1s ease-in-out infinite alternate' }} />实时
                </span>
              )}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>
              {run.taskText.slice(0, 44)}{run.taskText.length > 44 ? '…' : ''} · 总耗时 {fmtDur((run.endedAt ?? Date.now()) - run.createdAt)}
            </div>
          </div>
          <button className="btn small" onClick={onClose}><IconX size={13} />关闭</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
          {nodes.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: 12.5, textAlign: 'center', padding: 40 }}>暂无时间线数据</div>}

          {/* 执行干预控制面板（仅执行中） */}
          {active && run.subtasks.length > 0 && (
            <div style={{ marginBottom: 16, padding: '10px 12px', background: 'var(--input-bg)', border: '1px solid var(--accent)', borderRadius: 8 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--accent)', marginBottom: 8 }}>⚡ 执行干预（主Agent 下一轮响应）</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {run.subtasks.map((st, idx) => (
                  <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                    <span style={{ color: stColor(st.status), fontWeight: 700, width: 14, flexShrink: 0 }}>{stLabel(st.status)}</span>
                    <span style={{ color: 'var(--text-1)', fontWeight: 550, flexShrink: 0, maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{st.agent}</span>
                    <span style={{ color: 'var(--text-3)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 }}>{st.subtask.slice(0, 30)}</span>
                    {st.status === 'failed' && (
                      <button className="btn small" style={{ padding: '1px 7px', fontSize: 10.5, color: 'var(--accent)', flexShrink: 0 }} onClick={() => void doCtl(window.aibox.forceRetryTeamSubtask(run.id, idx))}>强制重试</button>
                    )}
                    {(st.status === 'pending' || st.status === 'running' || st.status === 'retrying') && (
                      <button className="btn small" style={{ padding: '1px 7px', fontSize: 10.5, color: 'var(--text-3)', flexShrink: 0 }} onClick={() => void doCtl(window.aibox.skipTeamSubtask(run.id, idx))}>跳过</button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ borderLeft: '2px solid var(--accent)', marginLeft: 10, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {nodes.map((n, i) => {
              if (n.kind === 'phase') {
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
                    <span style={{ position: 'absolute', left: -27, width: 12, height: 12, borderRadius: '50%', background: 'var(--accent)', border: '2px solid var(--bg)' }} />
                    <span style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--text-1)' }}>{TL_PHASE_LABEL[n.phase ?? ''] ?? n.phase}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{new Date(n.ts).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                  </div>
                );
              }
              if (n.kind === 'marker') {
                const mt = n.markerType;
                const mColor = mt === 'cancelled' ? 'var(--danger)' : ['guidance', 'force_retry', 'manual_retry'].includes(mt ?? '') ? 'var(--accent)' : 'var(--text-3)';
                const prefix = mt === 'guidance' ? '人工指导' : mt === 'force_retry' ? '强制重试' : mt === 'manual_retry' ? '手动重试' : mt === 'cancelled' ? '取消请求' : '跳过请求';
                const mText = `${prefix}：${n.message ?? n.agent ?? ''}`;
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, position: 'relative', fontSize: 11.5, color: mColor, background: 'var(--input-bg)', border: `1px dashed ${mColor}`, borderRadius: 6, padding: '6px 10px' }}>
                    <span style={{ position: 'absolute', left: -25, top: 8, width: 8, height: 8, borderRadius: '50%', background: mColor, border: '2px solid var(--bg)' }} />
                    <span style={{ lineHeight: 1.5 }}>{mText}</span>
                  </div>
                );
              }
              if (n.kind === 'review') {
                const reviewColor = n.reviewStatus === 'passed' ? 'var(--success)' : n.reviewStatus === 'failed' ? 'var(--danger)' : 'var(--warning)';
                const reviewLabel = n.reviewStatus === 'passed' ? '验收通过' : n.reviewStatus === 'failed' ? '验收未通过' : '部分通过';
                return (
                  <div key={i} style={{ position: 'relative', background: 'var(--input-bg)', borderLeft: `3px solid ${reviewColor}`, padding: '9px 11px' }}>
                    <span style={{ position: 'absolute', left: -27, top: 12, width: 10, height: 10, borderRadius: '50%', background: reviewColor, border: '2px solid var(--bg)' }} />
                    <div style={{ fontSize: 12, fontWeight: 700, color: reviewColor }}>{reviewLabel}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginTop: 3, lineHeight: 1.5 }}>{n.summary}</div>
                  </div>
                );
              }
              if (n.kind === 'decision') {
                const isFinish = n.action === 'finish';
                const dColor = isFinish ? 'var(--success)' : 'var(--warning)';
                const hasReasoning = !!n.reasoning;
                const open = reasoningOpen.has(i);
                return (
                  <div key={i} style={{ position: 'relative', background: 'var(--input-bg)', border: `1px solid ${dColor}`, borderRadius: 8, padding: '10px 12px' }}>
                    <span style={{ position: 'absolute', left: -27, top: 12, width: 10, height: 10, transform: 'rotate(45deg)', background: dColor, border: '2px solid var(--bg)' }} />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: dColor }}>◆ 主Agent决策{isFinish ? '：完成' : '：继续调度'}</span>
                      {hasReasoning && (
                        <button onClick={() => toggleReasoning(i)} style={{ marginLeft: 'auto', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 10.5, color: 'var(--text-3)' }}>
                          {open ? '▾ 收起推理' : '▸ 查看推理'}
                        </button>
                      )}
                    </div>
                    {n.summary && <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginTop: 3 }}>{n.summary}</div>}
                    {hasReasoning && open && (
                      <pre style={{ marginTop: 8, padding: '8px 10px', background: 'var(--card)', borderRadius: 6, fontSize: 11, lineHeight: 1.6, maxHeight: 220, overflowY: 'auto', whiteSpace: 'pre-wrap', color: 'var(--text-2)' }}>{n.reasoning}</pre>
                    )}
                  </div>
                );
              }
              const isCollapsed = collapsed.has(n.round ?? 0);
              const doneCount = n.subtasks.filter((s) => s.status === 'done').length;
              const failCount = n.subtasks.filter((s) => s.status === 'failed').length;
              return (
                <div key={i} style={{ position: 'relative', background: 'var(--input-bg)', border: '1px solid var(--card-border)', borderRadius: 8, overflow: 'hidden' }}>
                  <span style={{ position: 'absolute', left: -27, top: 14, width: 12, height: 12, borderRadius: '50%', background: 'var(--accent)', border: '2px solid var(--bg)' }} />
                  <button onClick={() => toggleRound(n.round ?? 0)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left' }}>
                    <span style={{ fontSize: 11, color: 'var(--text-3)', flexShrink: 0 }}>{isCollapsed ? '▸' : '▾'}</span>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--accent)', flexShrink: 0 }}>第 {n.round} 轮调度</span>
                    <span style={{ fontSize: 11, color: 'var(--text-3)', flexShrink: 0 }}>{n.count} 并行</span>
                    <span style={{ fontSize: 11, marginLeft: 'auto', flexShrink: 0 }}>
                      {doneCount > 0 && <span style={{ color: 'var(--success)' }}>{doneCount} 成 </span>}
                      {failCount > 0 && <span style={{ color: 'var(--danger)' }}>{failCount} 败</span>}
                    </span>
                  </button>
                  {!isCollapsed && (
                    <div style={{ padding: '0 12px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {n.subtasks.map((s, j) => (
                        <div key={j} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                          <span style={{ color: stColor(s.status), fontWeight: 700, width: 14, flexShrink: 0 }}>{stLabel(s.status)}</span>
                          <span style={{ color: 'var(--text-1)', fontWeight: 550, flexShrink: 0, maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.agent}</span>
                          <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--bg-2, #1a1d24)', overflow: 'hidden' }}>
                            <div style={{ width: `${Math.max(4, (s.durationMs / maxDur) * 100)}%`, height: '100%', background: stColor(s.status), borderRadius: 3 }} />
                          </div>
                          <span style={{ fontSize: 10.5, color: 'var(--text-3)', flexShrink: 0, fontVariantNumeric: 'tabular-nums', minWidth: 34, textAlign: 'right' }}>{fmtDur(s.durationMs)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {active && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
                <span style={{ position: 'absolute', left: -27, width: 12, height: 12, borderRadius: '50%', background: 'var(--accent)', animation: 'toast-in 1s ease-in-out infinite alternate' }} />
                <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>执行中…</span>
              </div>
            )}
            {terminal && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
                <span style={{ position: 'absolute', left: -27, width: 12, height: 12, borderRadius: '50%', background: run.phase === 'done' ? 'var(--success)' : run.phase === 'cancelled' ? 'var(--text-3)' : 'var(--danger)', border: '2px solid var(--bg)' }} />
                <span style={{ fontSize: 12.5, fontWeight: 700, color: run.phase === 'done' ? 'var(--success)' : run.phase === 'cancelled' ? 'var(--text-3)' : 'var(--danger)' }}>
                  {run.phase === 'done' ? '✅ 流水线完成' : run.phase === 'cancelled' ? '⊘ 流水线已取消' : '❌ 流水线失败'}
                </span>
              </div>
            )}
          </div>

          {run.phase === 'done' && run.finalResult && (
            <div style={{ marginTop: 16, padding: '10px 12px', background: 'var(--input-bg)', border: '1px solid var(--card-border)', borderRadius: 8 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-2)', marginBottom: 6 }}>最终结论</div>
              <div style={{ fontSize: 12, color: 'var(--text-1)', whiteSpace: 'pre-wrap', lineHeight: 1.6, maxHeight: 200, overflowY: 'auto' }}>{run.finalResult}</div>
            </div>
          )}
          {run.error && <div style={{ marginTop: 12, fontSize: 12, color: 'var(--danger)' }}>{run.error}</div>}

          {terminal && run.subtasks.some((s) => s.status === 'failed') && (
            <div style={{ marginTop: 16, padding: '10px 12px', background: 'var(--input-bg)', border: '1px solid var(--danger)', borderRadius: 8 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--danger)', marginBottom: 8 }}>失败子任务（可重试）</div>
              {run.subtasks.map((st, idx) => st.status === 'failed' ? (
                <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '4px 0' }}>
                  <span style={{ color: 'var(--text-1)', fontWeight: 550 }}>{st.agent}</span>
                  <span style={{ color: 'var(--text-3)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{st.subtask.slice(0, 40)}</span>
                  <button className="btn small" style={{ padding: '1px 8px', fontSize: 11, color: 'var(--accent)' }} onClick={() => void doCtl(window.aibox.retryTeamSubtask(run.id, idx))}>↻ 重试</button>
                </div>
              ) : null)}
            </div>
          )}
        </div>

        {/* 底部控制栏：注入指导 + 取消（仅执行中） */}
        {active && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 20px', borderTop: '1px solid var(--card-border)' }}>
            <input value={guidance} onChange={(e) => setGuidance(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && guidance.trim()) { void doCtl(window.aibox.injectTeamGuidance(run.id, guidance.trim())); setGuidance(''); } }}
              placeholder="向主Agent注入指导（如：别纠结 X，先做 Y）…"
              style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)', fontSize: 12.5 }} />
            <button className="btn small primary" disabled={!guidance.trim()} onClick={() => { void doCtl(window.aibox.injectTeamGuidance(run.id, guidance.trim())); setGuidance(''); }}>注入</button>
            <button className="btn small danger" onClick={() => void doCtl(window.aibox.cancelTeamRun(run.id))}>■ 取消</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** 组建团队弹窗：从员工市场选择专家，创建后自动实例化为现有员工 */
function CreateTeamModal({ onClose, onCreated }: { onClose: () => void; onCreated: (t: TeamData) => void }) {
  const { snapshot } = useApp();
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'coordinate' | 'roundtable'>('coordinate');
  const [workspace, setWorkspace] = useState('');
  const [dept, setDept] = useState<string>('全部');
  const [coordRole, setCoordRole] = useState<MarketRole | null>(null);
  const [memberRoles, setMemberRoles] = useState<MarketRole[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!snapshot) return null;

  const filteredRoles = MARKET_ROLES.filter((r) => dept === '全部' || r.department === dept);

  const toggleMember = (role: MarketRole) => {
    setMemberRoles((prev) => prev.some((r) => r.id === role.id) ? prev.filter((r) => r.id !== role.id) : [...prev, role]);
  };

  const pickDir = async () => {
    const dir = await window.aibox.pickDirectory();
    if (dir) setWorkspace(dir);
  };

  const create = async () => {
    if (!name.trim() || !coordRole) return;
    if (memberRoles.length === 0) { setError('请至少选择一位专家成员'); return; }
    setBusy(true); setError('');
    try {
      // 从员工市场实例化专家：已存在同名员工则复用，否则创建
      const existingNames = new Set(snapshot.agentCards.map((c) => c.agent.name));
      const engineId = snapshot.engines.find((e) =>
        isUserVisibleEngine(e) && ['HEALTHY', 'SETUP_REQUIRED', 'AUTH_REQUIRED'].includes(e.status)
      )?.id ?? NEXUS_ENGINE_ID;
      const allRoles = [coordRole, ...memberRoles.filter((r) => r.id !== coordRole.id)];
      const nameToId = new Map<string, string>();

      for (const role of allRoles) {
        if (existingNames.has(role.name)) {
          const found = snapshot.agentCards.find((c) => c.agent.name === role.name);
          if (found) nameToId.set(role.name, found.agent.id);
        } else {
          const created = await window.aibox.createAgent({
            name: role.name, role: role.role, systemPrompt: '', soulMd: role.soulMd, agentsMd: role.agentsMd, userMd: '',
            engineId, workspace: '', permissionMode: 'autonomous', concurrencyLimit: 1, channelIds: []
          });
          nameToId.set(role.name, created.id);
        }
      }

      const coordinatorId = nameToId.get(coordRole.name)!;
      const memberIds = allRoles.filter((r) => r.id !== coordRole.id).map((r) => nameToId.get(r.name)!).filter(Boolean);
      const t = await window.aibox.createTeam({ name: name.trim(), coordinatorId, memberIds, mode, workspace: workspace.trim() || undefined });
      onCreated(t as TeamData);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="组建专家团（从员工市场选择专家）" onClose={onClose} width={620}
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy || !name.trim() || !coordRole} onClick={() => void create()}>{busy ? '创建中…' : '创建团队'}</button></>}>
      <div className="field">
        <label>团队名称</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：产品评审团、技术攻关组" />
      </div>

      <div className="field">
        <label>协作模式</label>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => setMode('coordinate')} style={{ flex: 1, padding: '10px 14px', borderRadius: 8, cursor: 'pointer', textAlign: 'left', border: `1.5px solid ${mode === 'coordinate' ? 'var(--accent)' : 'var(--border)'}`, background: mode === 'coordinate' ? 'var(--accent-soft)' : 'transparent' }}>
            <div style={{ fontWeight: 650, fontSize: 13 }}>🎯 主Agent协调</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginTop: 3 }}>澄清Spec→拆解→分派→验收</div>
          </button>
          <button onClick={() => setMode('roundtable')} style={{ flex: 1, padding: '10px 14px', borderRadius: 8, cursor: 'pointer', textAlign: 'left', border: `1.5px solid ${mode === 'roundtable' ? 'var(--accent)' : 'var(--border)'}`, background: mode === 'roundtable' ? 'var(--accent-soft)' : 'transparent' }}>
            <div style={{ fontWeight: 650, fontSize: 13 }}>🔄 专家圆桌</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginTop: 3 }}>多专家 PK 观点→总结</div>
          </button>
        </div>
      </div>

      {/* 部门筛选 */}
      <div className="field">
        <label>选择专家（从员工市场，创建后自动录用为现有员工）</label>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
          {DEPARTMENTS.map((d) => (
            <button key={d} onClick={() => setDept(d)} style={{ padding: '4px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 600, background: dept === d ? 'var(--accent)' : 'var(--input-bg)', color: dept === d ? '#fff' : 'var(--text-2)' }}>{d}</button>
          ))}
        </div>

        {/* 协调者选择 */}
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 4 }}>主 Agent（协调者）— 点击选择：</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {filteredRoles.map((r) => (
              <button key={r.id} onClick={() => setCoordRole(r)} style={{ padding: '4px 10px', borderRadius: 6, fontSize: 11.5, fontWeight: 600, cursor: 'pointer', border: `1px solid ${coordRole?.id === r.id ? 'var(--accent)' : 'var(--border)'}`, background: coordRole?.id === r.id ? 'var(--accent-soft)' : 'transparent', color: coordRole?.id === r.id ? 'var(--accent)' : 'var(--text-2)' }}>
                👑 {r.name}
              </button>
            ))}
          </div>
        </div>

        {/* 成员多选 */}
        <div>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 4 }}>专家成员（可多选）：</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5, maxHeight: 160, overflowY: 'auto' }}>
            {filteredRoles.filter((r) => r.id !== coordRole?.id).map((r) => {
              const checked = memberRoles.some((m) => m.id === r.id);
              return (
                <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 10px', borderRadius: 6, cursor: 'pointer', border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`, background: checked ? 'var(--accent-soft)' : 'transparent', fontSize: 12 }}>
                  <input type="checkbox" checked={checked} onChange={() => toggleMember(r)} style={{ accentColor: 'var(--accent)', width: 14, height: 14 }} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{r.department}</span>
                </label>
              );
            })}
          </div>
        </div>
      </div>

      <div className="field">
        <label>共享工作目录（可选，留空自动创建）</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="默认：userData/workspaces/team-{id}" style={{ flex: 1 }} />
          <button className="btn small" onClick={() => void pickDir()}>选择</button>
        </div>
      </div>

      {error && <div style={{ fontSize: 12.5, color: 'var(--danger)', marginBottom: 8 }}>{error}</div>}
      <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.7, background: 'var(--input-bg)', padding: '10px 14px', borderRadius: 8 }}>
        选中的专家来自员工市场岗位模板。创建团队时，尚未录用的专家将自动创建为数字员工（含完整人设），已录用的直接复用。
      </div>
    </Modal>
  );
}

/** 团队协作全貌：角色拓扑、贡献指标、项目成果与最近决策。 */
function TeamCollaborationPanel({ team, refreshKey }: { team: TeamData; refreshKey: string }) {
  const { setRoute } = useApp();
  const [overview, setOverview] = useState<TeamCollaborationOverview | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void window.aibox.getTeamCollaborationOverview(team.id)
      .then((value) => { if (!cancelled) setOverview(value); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [team.id, team.coordinatorId, team.memberIds.join(':'), refreshKey]);

  if (failed) return <div className="team-overview-error"><IconAlert size={13} />协作数据暂时无法加载</div>;
  if (!overview) return <div className="team-overview-loading">正在汇总协作数据...</div>;

  const coordinator = overview.members.find((member) => member.teamRole === 'coordinator');
  const experts = overview.members.filter((member) => member.teamRole === 'expert');
  const latestDecision = overview.recentDecisions[0];
  const metrics = overview.metrics;

  return (
    <div className="team-overview">
      <div className="team-overview-kpis">
        <span><IconHistory size={14} /><small>累计运行</small><strong>{metrics.totalRuns}</strong>{metrics.activeRuns > 0 && <b>{metrics.activeRuns} 进行中</b>}</span>
        <span><IconCheck size={14} /><small>成功率</small><strong data-tone={metrics.totalRuns === 0 ? undefined : metrics.successRate >= 80 ? 'good' : 'warn'}>{metrics.totalRuns === 0 ? '--' : `${metrics.successRate}%`}</strong></span>
        <span><IconClock size={14} /><small>平均耗时</small><strong>{fmtDur(metrics.avgDurationMs)}</strong></span>
        <span><IconFolder size={14} /><small>关联项目</small><strong>{metrics.projectCount}</strong></span>
        <span><IconFile size={14} /><small>最终成果</small><strong>{metrics.deliverableCount}</strong><b>{metrics.acceptedDeliverables} 已采纳</b></span>
      </div>

      <div className="team-overview-main">
        <section className="team-topology">
          <header><h4>协作拓扑与贡献</h4><span>{metrics.interventionCount} 次人工介入</span></header>
          <div className="team-topology-flow">
            {coordinator && (
              <div className="team-member team-member-coordinator">
                <span className="team-member-avatar"><IconUser size={15} /></span>
                <span><strong>{coordinator.name}</strong><small title={coordinator.role}>{coordinator.role || '协调与验收'}</small></span>
                <b>{coordinator.decisions} 次决策</b>
              </div>
            )}
            <span className="team-flow-line"><IconFlow size={15} /></span>
            <div className="team-expert-list">
              {experts.map((member) => (
                <div className="team-member" key={member.agentId}>
                  <span className="team-member-avatar"><IconUser size={14} /></span>
                  <span><strong>{member.name}</strong><small title={member.role}>{member.role || '专业执行'}</small></span>
                  <span className="team-member-score"><i><em style={{ width: `${member.completionRate}%` }} /></i><b>{member.completed}/{member.assigned}</b></span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="team-linkage">
          <header><h4>项目与成果链路</h4>{overview.projects.length > 0 && <button type="button" onClick={() => setRoute('projects')}>查看项目</button>}</header>
          {overview.projects.length === 0 ? <div className="team-linkage-empty">尚未关联项目，执行任务时可选择项目归属</div> : (
            <div className="team-project-links">
              {overview.projects.slice(0, 3).map((project) => (
                <button type="button" key={project.projectId} onClick={() => setRoute('projects')}>
                  <span><strong>{project.projectName}</strong><small>{project.runCount} 次运行 · {project.deliverableCount} 项成果</small></span>
                  <b>{project.acceptedDeliverables}/{project.deliverableCount} 采纳</b>
                </button>
              ))}
            </div>
          )}
          {latestDecision && (
            <button type="button" className="team-latest-decision" onClick={() => setRoute('tasks')}>
              <IconFlow size={13} /><span><small>最近决策 · 第 {latestDecision.round} 轮</small><strong>{latestDecision.summary}</strong></span>
            </button>
          )}
        </section>
      </div>
    </div>
  );
}

/** 编辑团队弹窗：增删成员、更换协调者、修改模式 */
function EditTeamModal({ team, onClose, onSaved }: { team: TeamData; onClose: () => void; onSaved: (t: TeamData) => void }) {
  const { snapshot } = useApp();
  const [name, setName] = useState(team.name);
  const [coordinatorId, setCoordinatorId] = useState(team.coordinatorId);
  const [memberIds, setMemberIds] = useState<string[]>(team.memberIds);
  const [mode, setMode] = useState<'coordinate' | 'roundtable'>(team.mode as 'coordinate' | 'roundtable');
  const [busy, setBusy] = useState(false);
  if (!snapshot) return null;
  const agents = snapshot.agentCards.filter((c) => c.agent.lifecycle === 'READY');

  const toggleMember = (id: string) => {
    setMemberIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const save = async () => {
    setBusy(true);
    await window.aibox.updateTeam(team.id, { name, coordinatorId, memberIds: memberIds.filter((id) => id !== coordinatorId), mode });
    setBusy(false);
    onSaved({ ...team, name, coordinatorId, memberIds: memberIds.filter((id) => id !== coordinatorId), mode });
  };

  return (
    <Modal title="编辑团队" onClose={onClose} width={520}
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button></>}>
      <div className="field">
        <label>团队名称</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>协作模式</label>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => setMode('coordinate')} style={{ flex: 1, padding: '8px 12px', borderRadius: 8, cursor: 'pointer', border: `1.5px solid ${mode === 'coordinate' ? 'var(--accent)' : 'var(--border)'}`, background: mode === 'coordinate' ? 'var(--accent-soft)' : 'transparent', fontSize: 12.5, fontWeight: 600 }}>🎯 主Agent协调</button>
          <button onClick={() => setMode('roundtable')} style={{ flex: 1, padding: '8px 12px', borderRadius: 8, cursor: 'pointer', border: `1.5px solid ${mode === 'roundtable' ? 'var(--accent)' : 'var(--border)'}`, background: mode === 'roundtable' ? 'var(--accent-soft)' : 'transparent', fontSize: 12.5, fontWeight: 600 }}>🔄 专家圆桌</button>
        </div>
      </div>
      <div className="field">
        <label>主 Agent（协调者）</label>
        <select value={coordinatorId} onChange={(e) => setCoordinatorId(e.target.value)}>
          {agents.map((c) => <option key={c.agent.id} value={c.agent.id}>{c.agent.name}</option>)}
        </select>
      </div>
      <div className="field">
        <label>专家成员</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, maxHeight: 160, overflowY: 'auto' }}>
          {agents.filter((c) => c.agent.id !== coordinatorId).map((c) => (
            <label key={c.agent.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 6, cursor: 'pointer', border: `1px solid ${memberIds.includes(c.agent.id) ? 'var(--accent)' : 'var(--border)'}`, background: memberIds.includes(c.agent.id) ? 'var(--accent-soft)' : 'transparent', fontSize: 12 }}>
              <input type="checkbox" checked={memberIds.includes(c.agent.id)} onChange={() => toggleMember(c.agent.id)} style={{ accentColor: 'var(--accent)' }} />
              {c.agent.name}
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/** 执行历史弹窗 */
function TeamHistoryModal({ team, onClose }: { team: TeamData; onClose: () => void }) {
  const { setRoute } = useApp();
  const [runs, setRuns] = useState<TeamRun[] | null>(null);
  const [expandedOutput, setExpandedOutput] = useState<Record<string, string>>({});
  const [timelineRun, setTimelineRun] = useState<TeamRun | null>(null);

  useEffect(() => {
    void window.aibox.getTeamRuns(team.id).then(setRuns);
  }, [team.id]);

  if (!runs) return null;

  const loadOutput = async (taskId: string) => {
    if (expandedOutput[taskId]) return;
    const output = await window.aibox.getSubtaskOutput(taskId);
    setExpandedOutput((prev) => ({ ...prev, [taskId]: output ?? '(无输出)' }));
  };

  const phaseLabel = (p: string) => ({ clarify: '澄清/Spec', decompose: '拆解中', execute: '执行中', review: '验收中', done: '已完成', failed: '失败' }[p] ?? p);
  const phaseColor = (p: string) => p === 'done' ? 'var(--success)' : p === 'failed' ? 'var(--danger)' : 'var(--accent)';

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="card" style={{ width: 640, maxHeight: '75vh', overflowY: 'auto', padding: 20 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>执行历史 · {team.name}</h3>
          <button className="btn small" onClick={onClose}>关闭</button>
        </div>
        {runs.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: 12.5, padding: 20, textAlign: 'center' }}>暂无执行记录</div>}
        {runs.map((run) => (
          <div key={run.id} style={{ padding: '12px 14px', borderRadius: 8, background: 'var(--input-bg)', marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <span style={{ fontWeight: 650, fontSize: 12.5, color: phaseColor(run.phase) }}>{phaseLabel(run.phase)}</span>
              <span style={{ fontSize: 12, color: 'var(--text-2)', flex: 1 }}>{run.taskText.slice(0, 50)}{run.taskText.length > 50 ? '…' : ''}</span>
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{new Date(run.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
              {run.durationMs != null && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{(run.durationMs / 1000).toFixed(1)}s</span>}
              <button className="btn small" style={{ padding: '1px 7px', fontSize: 10.5 }} onClick={() => setTimelineRun(run)}><IconClock size={11} />时间线</button>
            </div>
            {(run.trace.project || run.trace.deliverable) && (
              <div className="team-history-trace">
                {run.trace.project && <button type="button" onClick={() => { setRoute('projects'); onClose(); }}><IconFolder size={11} />{run.trace.project.name}</button>}
                {run.trace.deliverable && <button type="button" onClick={() => { setRoute('deliverables'); onClose(); }}><IconFile size={11} />最终成果 · {run.trace.deliverable.reviewStatus === 'accepted' ? '已采纳' : '待验收'}</button>}
              </div>
            )}
            {/* 子任务列表 */}
            {run.subtasks.map((st, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '3px 0' }}>
                <span style={{ color: st.status === 'done' ? 'var(--success)' : st.status === 'failed' ? 'var(--danger)' : (st.status === 'running' || st.status === 'retrying') ? 'var(--accent)' : 'var(--text-3)', fontWeight: 650 }}>●</span>
                <span style={{ fontWeight: 550 }}>{st.agent}</span>
                {(st.retryCount ?? 0) > 0 && <span style={{ fontSize: 10, color: 'var(--warning, #fbbf24)' }}>重试{st.retryCount}次</span>}
                <span style={{ color: 'var(--text-2)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{st.subtask}</span>
                {st.taskId && (
                  <button className="btn small" style={{ padding: '1px 6px', fontSize: 10 }} onClick={() => void loadOutput(st.taskId!)}>查看输出</button>
                )}
                {['done', 'failed'].includes(run.phase) && st.status === 'failed' && (
                  <button className="btn small" style={{ padding: '1px 6px', fontSize: 10, color: 'var(--accent)' }}
                    onClick={() => void window.aibox.retryTeamSubtask(run.id, i).then(() => window.aibox.getTeamRuns(team.id).then(setRuns))}>↻ 重试</button>
                )}
              </div>
            ))}
            {/* 展开的子任务输出 */}
            {run.subtasks.filter((st) => st.taskId && expandedOutput[st.taskId]).map((st) => (
              <pre key={st.taskId} style={{ marginTop: 6, padding: '8px 10px', background: 'var(--card)', borderRadius: 6, fontSize: 11, lineHeight: 1.6, maxHeight: 120, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
                {expandedOutput[st.taskId!]}
              </pre>
            ))}
            {run.error && <div style={{ marginTop: 6, fontSize: 12, color: 'var(--danger)' }}>{run.error}</div>}
            {run.finalResult && (
              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-1)', background: 'var(--card)', padding: '8px 10px', borderRadius: 6, maxHeight: 100, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
                {run.finalResult}
              </div>
            )}
          </div>
        ))}
      </div>
      {timelineRun && <TeamTimelineModal run={timelineRun} teamName={team.name} onClose={() => setTimelineRun(null)} onChanged={() => {
        void window.aibox.getTeamRuns(team.id).then((items) => {
          setRuns(items);
          setTimelineRun((current) => items.find((item) => item.id === current?.id) ?? current);
        });
      }} />}
    </div>
  );
}

/** 团队配置弹窗 */
function TeamConfigModal({ team, onClose }: { team: TeamData; onClose: () => void }) {
  const [timeout, setTimeout_] = useState(600);
  const [maxRetries, setMaxRetries] = useState(1);
  const [concurrency, setConcurrency] = useState(1);
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void window.aibox.getTeamConfig(team.id).then((c) => {
      setTimeout_(c.timeout); setMaxRetries(c.maxRetries); setConcurrency(c.concurrency);
      setLoaded(true);
    });
  }, [team.id]);

  if (!loaded) return null;

  const save = async () => {
    await window.aibox.saveTeamConfig(team.id, { timeout, maxRetries, concurrency });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div className="card" style={{ width: 400, padding: 20 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>团队配置 · {team.name}</h3>
          <button className="btn small" onClick={onClose}>关闭</button>
        </div>
        <div className="field">
          <label>单步超时（秒）</label>
          <input type="number" min={60} max={3600} value={timeout} onChange={(e) => setTimeout_(Number(e.target.value))} />
        </div>
        <div className="field">
          <label>失败重试次数</label>
          <input type="number" min={0} max={5} value={maxRetries} onChange={(e) => setMaxRetries(Number(e.target.value))} />
        </div>
        <div className="field">
          <label>并行执行数</label>
          <input type="number" min={1} max={5} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn primary" onClick={() => void save()}>保存配置</button>
          {saved && <span style={{ fontSize: 12, color: 'var(--success)' }}>✓ 已保存</span>}
        </div>
      </div>
    </div>
  );
}

/** 自定义模板管理：保存后的模板可再次一键组建，不只是归档。 */
function CustomTemplates({ deploying, onDeploy }: { deploying: string | null; onDeploy: (template: SavedTeamTemplate) => Promise<void> }) {
  const [templates, setTemplates] = useState<SavedTeamTemplate[] | null>(null);

  useEffect(() => {
    void window.aibox.listTeamTemplates().then((items) => setTemplates(items as SavedTeamTemplate[]));
  }, []);

  if (!templates) return <div className="team-overview-loading">正在加载自定义模板...</div>;

  return (
    <section className="team-template-section">
      <header><div><IconFolder size={15} /><h3>自定义模板</h3></div><span>从现有团队保存，可反复组建</span></header>
      {templates.length === 0 ? <div className="team-template-empty">暂无自定义模板，可在协作工作台中将现有团队保存为模板。</div> : (
        <div className="team-template-grid">
        {templates.map((tpl) => (
          <div key={tpl.id} className="card team-template-card">
            <div className="team-template-title"><strong>{tpl.name}</strong><span>{tpl.mode === 'coordinate' ? '协调模式' : '圆桌模式'}</span></div>
            <p>{tpl.description}</p>
            <div className="team-template-members"><IconUser size={13} /><span>{tpl.members.map((member) => member.name).join('、') || '无可用成员'}</span></div>
            <div className="team-template-actions">
              <button className="btn small primary" disabled={deploying === tpl.id || tpl.members.length === 0} onClick={() => void onDeploy(tpl)}><IconPlus size={12} />{deploying === tpl.id ? '组建中...' : '一键组建'}</button>
              <button className="btn small danger" title="删除模板" aria-label={`删除模板 ${tpl.name}`} onClick={() => void window.aibox.removeTeamTemplate(tpl.id).then(() => setTemplates((previous) => previous?.filter((item) => item.id !== tpl.id) ?? null))}>
                <IconX size={12} />
              </button>
            </div>
          </div>
        ))}
        </div>
      )}
    </section>
  );
}
