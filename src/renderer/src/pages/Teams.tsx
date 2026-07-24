/** 专家团管理：模板一键组建 + 创建团队 + 提交团队任务 + 流水线进度 + 编辑/历史/配置/统计 */
import { useEffect, useState, useCallback } from 'react';
import { useApp } from '../store';
import { Modal } from '../components/common';
import { IconPlus, IconUser, IconPlay, IconX } from '../components/icons';
import { TEAM_TEMPLATES, type TeamTemplate } from '../data/teamTemplates';
import { MARKET_ROLES, DEPARTMENTS, type MarketRole } from '../data/marketRoles';
import type { TeamRun, TeamRunSubtask, TeamTimelineEvent } from '../../../shared/types';

interface TeamData {
  id: string; name: string; coordinatorId: string; memberIds: string[]; mode: string; workspace: string; createdAt: number;
}

const PHASE_LABEL: Record<string, string> = {
  clarify: '澄清/Spec', decompose: '拆解中', execute: '执行中', review: '验收中', done: '已完成', failed: '失败'
};

export function Teams() {
  const { snapshot } = useApp();
  const [teams, setTeams] = useState<TeamData[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [taskInput, setTaskInput] = useState<Record<string, string>>({});
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
  const agents = snapshot.agentCards.filter((c) => c.agent.lifecycle === 'READY');
  const agentName = (id: string) => agents.find((c) => c.agent.id === id)?.agent.name ?? snapshot.agentCards.find((c) => c.agent.id === id)?.agent.name ?? '未知';

  const trigger = async (teamId: string) => {
    const task = taskInput[teamId]?.trim();
    if (!task) return;
    const r = await window.aibox.triggerTeam(teamId, task);
    setTriggerMsg((m) => ({ ...m, [teamId]: r.message }));
    setTaskInput((m) => ({ ...m, [teamId]: '' }));
    setTimeout(() => setTriggerMsg((m) => ({ ...m, [teamId]: '' })), 4000);
    // 立即拉取新 run
    void window.aibox.getTeamRuns(teamId).then((list) => setRuns((prev) => ({ ...prev, [teamId]: list[0] ?? null })));
  };

  /** 一键组建模板团队：自动创建缺失员工 + 创建团队 */
  const deployTemplate = async (tpl: TeamTemplate) => {
    setDeploying(tpl.id);
    setDeployMsg('');
    try {
      const existingNames = new Set(snapshot?.agentCards.map((c) => c.agent.name) ?? []);
      const engineId = snapshot?.engines.find((e) => ['HEALTHY', 'SETUP_REQUIRED', 'AUTH_REQUIRED'].includes(e.status))?.id ?? 'eng-hermes';
      const allAgents = [tpl.coordinator, ...tpl.members];
      const nameToId = new Map<string, string>();

      for (const ag of allAgents) {
        if (existingNames.has(ag.name)) {
          const found = snapshot?.agentCards.find((c) => c.agent.name === ag.name);
          if (found) nameToId.set(ag.name, found.agent.id);
        } else {
          const created = await window.aibox.createAgent({
            name: ag.name, role: ag.role, systemPrompt: '', soulMd: ag.soulMd, agentsMd: ag.agentsMd, userMd: '',
            engineId, workspace: '', permissionMode: ag.permissionMode, concurrencyLimit: 1, channelIds: []
          });
          nameToId.set(ag.name, created.id);
        }
      }

      const coordinatorId = nameToId.get(tpl.coordinator.name)!;
      const memberIds = tpl.members.map((m) => nameToId.get(m.name)!).filter(Boolean);
      const team = await window.aibox.createTeam({ name: tpl.name, coordinatorId, memberIds, mode: tpl.mode });
      setTeams((prev) => [team as unknown as TeamData, ...prev]);
      setDeployMsg(`✅ 「${tpl.name}」组建成功！${allAgents.length} 位员工就位。`);
      setTimeout(() => setDeployMsg(''), 4000);
    } catch (e) {
      setDeployMsg(`❌ 组建失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeploying(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>专家团</h2>
        <span className="desc">多 Agent 协作 · 主 Agent 协调拆解 · 专家并行执行 · 综合输出</span>
        <div className="right">
          <button className="btn small primary" onClick={() => setCreateOpen(true)}><IconPlus size={13} />组建团队</button>
        </div>
      </div>

      {teams.length === 0 && (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>
          还没有专家团。从下方模板一键组建，或点击「组建团队」自定义创建。
        </div>
      )}

      {/* 团队模板 */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 13.5, fontWeight: 650, marginBottom: 10, color: 'var(--text-1)' }}>🚀 团队模板（一键组建，缺失员工自动创建）</div>
        {deployMsg && <div style={{ fontSize: 12.5, marginBottom: 10, color: deployMsg.startsWith('✅') ? 'var(--success)' : 'var(--danger)' }}>{deployMsg}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
          {TEAM_TEMPLATES.map((tpl) => (
            <div key={tpl.id} className="card" style={{ padding: 14 }}>
              <div style={{ fontWeight: 650, fontSize: 13.5, marginBottom: 4 }}>{tpl.name}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginBottom: 8, lineHeight: 1.6 }}>{tpl.description}</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 10 }}>
                👑 {tpl.coordinator.name} + {tpl.members.map((m) => m.name).join('、')}
              </div>
              <button className="btn small primary" disabled={deploying === tpl.id} onClick={() => void deployTemplate(tpl)} style={{ width: '100%', justifyContent: 'center' }}>
                {deploying === tpl.id ? '组建中…' : '一键组建'}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* 自定义模板 */}
      <CustomTemplates />

      <div style={{ display: 'grid', gap: 14 }}>
        {teams.map((team) => (
          <div className="card" key={team.id} style={{ padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--accent-soft)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <IconUser size={22} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 650, fontSize: 15 }}>{team.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>
                  {team.mode === 'coordinate' ? '🎯 主专家协调：拆解→逐步分派→验收' : '🔄 专家圆桌：多视角观点→总结'}
                </div>
                {team.workspace && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>📁 {team.workspace}</div>}
              </div>
              <button className="btn small danger" onClick={() => void window.aibox.removeTeam(team.id).then(() => setTeams((t) => t.filter((x) => x.id !== team.id)))}>
                <IconX size={12} />解散
              </button>
            </div>

            {/* 成员展示 */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              <span style={{ padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 650, background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                👑 {agentName(team.coordinatorId)}（协调者）
              </span>
              {team.memberIds.map((id) => (
                <span key={id} style={{ padding: '4px 10px', borderRadius: 6, fontSize: 12, background: 'var(--input-bg)', color: 'var(--text-2)' }}>
                  {agentName(id)}
                </span>
              ))}
            </div>

            {/* 团队统计 */}
            <TeamStats teamId={team.id} />

            {/* 提交团队任务 */}
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={taskInput[team.id] ?? ''}
                onChange={(e) => setTaskInput((m) => ({ ...m, [team.id]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter') void trigger(team.id); }}
                placeholder="输入团队任务，Enter 提交…"
                style={{ flex: 1, padding: '9px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)', fontSize: 13 }}
              />
              <button className="btn primary" onClick={() => void trigger(team.id)}>
                <IconPlay size={13} />执行
              </button>
            </div>
            {triggerMsg[team.id] && (
              <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--success)', background: 'var(--input-bg)', padding: '8px 12px', borderRadius: 6 }}>
                {triggerMsg[team.id]}
              </div>
            )}

            {/* 操作按钮 */}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="btn small" onClick={() => setEditTeam(team)}>编辑团队</button>
              <button className="btn small" disabled={!runs[team.id]} onClick={() => setTimelineTeamId(team.id)}>⏱ 执行时间线</button>
              <button className="btn small" onClick={() => setHistoryTeam(team)}>执行历史</button>
              <button className="btn small" onClick={() => setConfigTeam(team)}>配置</button>
              <button className="btn small" onClick={() => void window.aibox.saveTeamAsTemplate(team.id).then((r) => { setDeployMsg(r.message); setTimeout(() => setDeployMsg(''), 3000); })}>保存为模板</button>
            </div>

            {/* 流水线进度面板 */}
            {runs[team.id] && <RunProgress run={runs[team.id]!} onRetry={async (runId, idx) => {
              const r = await window.aibox.retryTeamSubtask(runId, idx);
              setTriggerMsg((m) => ({ ...m, [team.id]: r.message }));
              setTimeout(() => setTriggerMsg((m) => ({ ...m, [team.id]: '' })), 4000);
              // 立即拉取更新
              void window.aibox.getTeamRuns(team.id).then((list) => setRuns((prev) => ({ ...prev, [team.id]: list[0] ?? null })));
            }} />}
          </div>
        ))}
      </div>

      {createOpen && <CreateTeamModal onClose={() => setCreateOpen(false)} onCreated={(t) => { setTeams((prev) => [t, ...prev]); setCreateOpen(false); }} />}
      {editTeam && <EditTeamModal team={editTeam} onClose={() => setEditTeam(null)} onSaved={(t) => { setTeams((prev) => prev.map((x) => x.id === t.id ? t : x)); setEditTeam(null); }} />}
      {historyTeam && <TeamHistoryModal team={historyTeam} onClose={() => setHistoryTeam(null)} />}
      {configTeam && <TeamConfigModal team={configTeam} onClose={() => setConfigTeam(null)} />}
      {timelineTeamId && runs[timelineTeamId] && (
        <TeamTimelineModal
          run={runs[timelineTeamId]!}
          teamName={teams.find((t) => t.id === timelineTeamId)?.name ?? ''}
          onClose={() => setTimelineTeamId(null)}
          onRetry={async (runId, idx) => {
            const r = await window.aibox.retryTeamSubtask(runId, idx);
            setTriggerMsg((m) => ({ ...m, [timelineTeamId]: r.message }));
            setTimeout(() => setTriggerMsg((m) => ({ ...m, [timelineTeamId]: '' })), 4000);
            void window.aibox.getTeamRuns(timelineTeamId).then((list) => setRuns((prev) => ({ ...prev, [timelineTeamId]: list[0] ?? null })));
          }}
        />
      )}
    </>
  );
}

/** 流水线进度面板：阶段指示器 + 子任务状态（并行调度视图）+ 手动重试 + 耗时 + 最终结论 */
function RunProgress({ run, onRetry }: { run: TeamRun; onRetry: (runId: string, subtaskIndex: number) => void }) {
  const active = ['clarify', 'decompose', 'execute', 'review'].includes(run.phase);
  const terminal = ['done', 'failed'].includes(run.phase);
  const statusColor = (s: string) => s === 'done' ? 'var(--success)' : s === 'failed' ? 'var(--danger)' : (s === 'running' || s === 'retrying') ? 'var(--accent)' : 'var(--text-3)';
  const statusLabel = (s: string) => s === 'done' ? '完成' : s === 'failed' ? '失败' : s === 'running' ? '执行中' : s === 'retrying' ? '重试中' : '等待';

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
    <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 8, background: 'var(--input-bg)', border: '1px solid var(--card-border)' }}>
      {/* 阶段指示器 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: run.subtasks.length > 0 ? 10 : 0 }}>
        <span style={{ fontSize: 12, fontWeight: 650, color: run.phase === 'failed' ? 'var(--danger)' : run.phase === 'done' ? 'var(--success)' : 'var(--accent)' }}>
          {run.phase === 'done' ? '✅' : run.phase === 'failed' ? '❌' : '⚙️'} {PHASE_LABEL[run.phase] ?? run.phase}
        </span>
        {run.phase === 'execute' && run.totalSteps > 0 && (
          <span style={{ fontSize: 11.5, color: 'var(--text-2)' }}>第 {run.currentStep} 轮调度 · 共 {run.totalSteps} 个子任务（并行执行）</span>
        )}
        <span style={{ fontSize: 11, color: 'var(--text-3)', fontVariantNumeric: 'tabular-nums' }}>⏱ {elapsedText}</span>
        {active && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>· {run.taskText.slice(0, 40)}{run.taskText.length > 40 ? '…' : ''}</span>}
      </div>

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

/** 执行时间线抽屉：决策脊柱 + 可展开轮次，实时/复盘两用 */
interface TlRoundSubtask { agent: string; status: string; durationMs: number }
interface TlNode {
  kind: 'phase' | 'round' | 'decision';
  phase?: string;
  round?: number;
  count?: number;
  action?: string;
  summary?: string;
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
        nodes.push({ kind: 'decision', round: ev.round, action: ev.action, summary: ev.summary, ts: ev.ts, subtasks: [] });
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

function TeamTimelineModal({ run, teamName, onClose, onRetry }: {
  run: TeamRun; teamName: string; onClose: () => void;
  onRetry: (runId: string, subtaskIndex: number) => void;
}) {
  const active = ['clarify', 'decompose', 'execute', 'review'].includes(run.phase);
  const terminal = ['done', 'failed'].includes(run.phase);
  const nodes = buildTimeline(run);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const toggleRound = (r: number) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(r)) next.delete(r); else next.add(r);
    return next;
  });

  const maxDur = Math.max(1, ...nodes.flatMap((n) => n.subtasks.map((s) => s.durationMs)));
  const stColor = (s: string) => s === 'done' ? 'var(--success)' : s === 'failed' ? 'var(--danger)' : 'var(--accent)';
  const stLabel = (s: string) => s === 'done' ? '✓' : s === 'failed' ? '✗' : '…';

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }} onClick={onClose}>
      <div className="card" onClick={(e) => e.stopPropagation()} style={{
        width: 540, height: '100%', borderRadius: 0, margin: 0, display: 'flex', flexDirection: 'column',
        borderLeft: '1px solid var(--card-border)', animation: 'toast-in .2s ease-out'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px', borderBottom: '1px solid var(--card-border)' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>⏱ 执行时间线 · {teamName}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>
              {run.taskText.slice(0, 44)}{run.taskText.length > 44 ? '…' : ''} · 总耗时 {fmtDur((run.endedAt ?? Date.now()) - run.createdAt)}
            </div>
          </div>
          <button className="btn small" onClick={onClose}><IconX size={13} />关闭</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
          {nodes.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: 12.5, textAlign: 'center', padding: 40 }}>暂无时间线数据</div>}

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
              if (n.kind === 'decision') {
                const isFinish = n.action === 'finish';
                return (
                  <div key={i} style={{ position: 'relative', background: 'var(--input-bg)', border: `1px solid ${isFinish ? 'var(--success)' : 'var(--warning)'}`, borderRadius: 8, padding: '10px 12px' }}>
                    <span style={{ position: 'absolute', left: -27, top: 12, width: 10, height: 10, transform: 'rotate(45deg)', background: isFinish ? 'var(--success)' : 'var(--warning)', border: '2px solid var(--bg)' }} />
                    <div style={{ fontSize: 12, fontWeight: 700, color: isFinish ? 'var(--success)' : 'var(--warning)' }}>
                      ◆ 主Agent决策{isFinish ? '：完成' : '：继续调度'}
                    </div>
                    {n.summary && <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginTop: 3 }}>{n.summary}</div>}
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
                <span style={{ position: 'absolute', left: -27, width: 12, height: 12, borderRadius: '50%', background: run.phase === 'done' ? 'var(--success)' : 'var(--danger)', border: '2px solid var(--bg)' }} />
                <span style={{ fontSize: 12.5, fontWeight: 700, color: run.phase === 'done' ? 'var(--success)' : 'var(--danger)' }}>
                  {run.phase === 'done' ? '✅ 流水线完成' : '❌ 流水线失败'}
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
                  <button className="btn small" style={{ padding: '1px 8px', fontSize: 11, color: 'var(--accent)' }} onClick={() => onRetry(run.id, idx)}>↻ 重试</button>
                </div>
              ) : null)}
            </div>
          )}
        </div>
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
      const engineId = snapshot.engines.find((e) => ['HEALTHY', 'SETUP_REQUIRED', 'AUTH_REQUIRED'].includes(e.status))?.id ?? 'eng-hermes';
      const allRoles = [coordRole, ...memberRoles.filter((r) => r.id !== coordRole.id)];
      const nameToId = new Map<string, string>();

      for (const role of allRoles) {
        if (existingNames.has(role.name)) {
          const found = snapshot.agentCards.find((c) => c.agent.name === role.name);
          if (found) nameToId.set(role.name, found.agent.id);
        } else {
          const created = await window.aibox.createAgent({
            name: role.name, role: role.role, systemPrompt: '', soulMd: role.soulMd, agentsMd: role.agentsMd, userMd: '',
            engineId, workspace: '', permissionMode: role.permissionMode, concurrencyLimit: 1, channelIds: []
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

/** 团队统计（异步加载） */
function TeamStats({ teamId }: { teamId: string }) {
  const [stats, setStats] = useState<{ totalRuns: number; avgDurationMs: number; successRate: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.aibox.getTeamStats(teamId).then((s) => { if (!cancelled) setStats(s); });
    return () => { cancelled = true; };
  }, [teamId]);
  if (!stats || stats.totalRuns === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 14, fontSize: 11.5, color: 'var(--text-2)', marginBottom: 12, padding: '6px 10px', background: 'var(--input-bg)', borderRadius: 6 }}>
      <span>累计执行: <b>{stats.totalRuns}</b></span>
      <span>平均耗时: <b style={{ color: 'var(--accent)' }}>{(stats.avgDurationMs / 1000).toFixed(1)}s</b></span>
      <span>成功率: <b style={{ color: stats.successRate >= 80 ? 'var(--success)' : 'var(--warning)' }}>{stats.successRate}%</b></span>
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
  const [runs, setRuns] = useState<TeamRun[] | null>(null);
  const [expandedOutput, setExpandedOutput] = useState<Record<string, string>>({});

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
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
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
            </div>
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

/** 自定义模板管理：列出/删除用户保存的团队模板 */
function CustomTemplates() {
  const [templates, setTemplates] = useState<{ id: string; name: string; description: string; mode: string; members: unknown[]; createdAt: number }[] | null>(null);

  useEffect(() => {
    void window.aibox.listTeamTemplates().then(setTemplates);
  }, []);

  if (!templates || templates.length === 0) return null;

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 13.5, fontWeight: 650, marginBottom: 10, color: 'var(--text-1)' }}>📁 自定义模板（从团队保存）</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
        {templates.map((tpl) => (
          <div key={tpl.id} className="card" style={{ padding: 14 }}>
            <div style={{ fontWeight: 650, fontSize: 13.5, marginBottom: 4 }}>{tpl.name}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginBottom: 8, lineHeight: 1.6 }}>{tpl.description}</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8 }}>
              {tpl.mode === 'coordinate' ? '🎯 协调模式' : '🔄 圆桌模式'} · {Array.isArray(tpl.members) ? tpl.members.length : 0} 位成员
            </div>
            <button className="btn small danger" style={{ width: '100%', justifyContent: 'center' }} onClick={() => void window.aibox.removeTeamTemplate(tpl.id).then(() => setTemplates((prev) => prev?.filter((t) => t.id !== tpl.id) ?? null))}>删除模板</button>
          </div>
        ))}
      </div>
    </div>
  );
}
