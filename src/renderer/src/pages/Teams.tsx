/** 专家团管理：模板一键组建 + 创建团队 + 提交团队任务 + 流水线进度 */
import { useEffect, useState, useCallback } from 'react';
import { useApp } from '../store';
import { Modal } from '../components/common';
import { IconPlus, IconUser, IconPlay, IconX } from '../components/icons';
import { TEAM_TEMPLATES, type TeamTemplate } from '../data/teamTemplates';
import type { TeamRun } from '../../../shared/types';

interface TeamData {
  id: string; name: string; coordinatorId: string; memberIds: string[]; mode: string; workspace: string; createdAt: number;
}

const PHASE_LABEL: Record<string, string> = {
  decompose: '拆解中', execute: '执行中', review: '验收中', done: '已完成', failed: '失败'
};

export function Teams() {
  const { snapshot } = useApp();
  const [teams, setTeams] = useState<TeamData[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [taskInput, setTaskInput] = useState<Record<string, string>>({});
  const [triggerMsg, setTriggerMsg] = useState<Record<string, string>>({});
  const [deploying, setDeploying] = useState<string | null>(null);
  const [deployMsg, setDeployMsg] = useState('');
  /** 每个团队最新一次流水线记录 */
  const [runs, setRuns] = useState<Record<string, TeamRun | null>>({});

  useEffect(() => {
    void window.aibox.listTeams().then(setTeams);
  }, [snapshot?.tasks.length]);

  /** 轮询活跃流水线进度（2s，有未完成 run 时） */
  const hasActiveRun = Object.values(runs).some((r) => r && ['decompose', 'execute', 'review'].includes(r.phase));
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

            {/* 流水线进度面板 */}
            {runs[team.id] && <RunProgress run={runs[team.id]!} />}
          </div>
        ))}
      </div>

      {createOpen && <CreateTeamModal onClose={() => setCreateOpen(false)} onCreated={(t) => { setTeams((prev) => [t, ...prev]); setCreateOpen(false); }} />}
    </>
  );
}

/** 流水线进度面板：阶段指示器 + 子任务状态 + 最终结论 */
function RunProgress({ run }: { run: TeamRun }) {
  const active = ['decompose', 'execute', 'review'].includes(run.phase);
  const statusColor = (s: string) => s === 'done' ? 'var(--success)' : s === 'failed' ? 'var(--danger)' : s === 'running' ? 'var(--accent)' : 'var(--text-3)';
  const statusLabel = (s: string) => s === 'done' ? '完成' : s === 'failed' ? '失败' : s === 'running' ? '执行中' : '等待';

  return (
    <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 8, background: 'var(--input-bg)', border: '1px solid var(--card-border)' }}>
      {/* 阶段指示器 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: run.subtasks.length > 0 ? 10 : 0 }}>
        <span style={{ fontSize: 12, fontWeight: 650, color: run.phase === 'failed' ? 'var(--danger)' : run.phase === 'done' ? 'var(--success)' : 'var(--accent)' }}>
          {run.phase === 'done' ? '✅' : run.phase === 'failed' ? '❌' : '⚙️'} {PHASE_LABEL[run.phase] ?? run.phase}
        </span>
        {run.phase === 'execute' && run.totalSteps > 0 && (
          <span style={{ fontSize: 11.5, color: 'var(--text-2)' }}>子任务 {run.currentStep}/{run.totalSteps}</span>
        )}
        {active && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>· {run.taskText.slice(0, 40)}{run.taskText.length > 40 ? '…' : ''}</span>}
      </div>

      {/* 子任务列表 */}
      {run.subtasks.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {run.subtasks.map((st, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12 }}>
              <span style={{ color: statusColor(st.status), fontWeight: 650, flexShrink: 0 }}>● {statusLabel(st.status)}</span>
              <span style={{ color: 'var(--text-1)', fontWeight: 550, flexShrink: 0 }}>{st.agent}</span>
              <span style={{ color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{st.subtask}</span>
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

/** 创建团队弹窗 */
function CreateTeamModal({ onClose, onCreated }: { onClose: () => void; onCreated: (t: TeamData) => void }) {
  const { snapshot } = useApp();
  const [name, setName] = useState('');
  const [coordinatorId, setCoordinatorId] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [mode, setMode] = useState<'coordinate' | 'roundtable'>('coordinate');
  const [workspace, setWorkspace] = useState('');
  const [busy, setBusy] = useState(false);

  if (!snapshot) return null;
  const agents = snapshot.agentCards.filter((c) => c.agent.lifecycle === 'READY');

  const toggleMember = (id: string) => {
    setMemberIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const pickDir = async () => {
    const dir = await window.aibox.pickDirectory();
    if (dir) setWorkspace(dir);
  };

  const create = async () => {
    if (!name.trim() || !coordinatorId) return;
    setBusy(true);
    try {
      const t = await window.aibox.createTeam({ name: name.trim(), coordinatorId, memberIds: memberIds.filter((id) => id !== coordinatorId), mode, workspace: workspace.trim() || undefined });
      onCreated(t as TeamData);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="组建专家团" onClose={onClose} width={560}
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy || !name.trim() || !coordinatorId} onClick={() => void create()}>{busy ? '创建中…' : '创建团队'}</button></>}>
      <div className="field">
        <label>团队名称</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：产品评审团、技术攻关组" />
      </div>

      <div className="field">
        <label>协作模式</label>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => setMode('coordinate')} style={{
            flex: 1, padding: '10px 14px', borderRadius: 8, cursor: 'pointer', textAlign: 'left',
            border: `1.5px solid ${mode === 'coordinate' ? 'var(--accent)' : 'var(--border)'}`,
            background: mode === 'coordinate' ? 'var(--accent-soft)' : 'transparent'
          }}>
            <div style={{ fontWeight: 650, fontSize: 13 }}>🎯 主Agent协调</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginTop: 3 }}>协调者拆解任务→分派专家→综合结论</div>
          </button>
          <button onClick={() => setMode('roundtable')} style={{
            flex: 1, padding: '10px 14px', borderRadius: 8, cursor: 'pointer', textAlign: 'left',
            border: `1.5px solid ${mode === 'roundtable' ? 'var(--accent)' : 'var(--border)'}`,
            background: mode === 'roundtable' ? 'var(--accent-soft)' : 'transparent'
          }}>
            <div style={{ fontWeight: 650, fontSize: 13 }}>🔄 专家圆桌</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginTop: 3 }}>各专家发表观点→协调者总结</div>
          </button>
        </div>
      </div>

      <div className="field">
        <label>主 Agent（协调者）— 负责分析、拆解、综合</label>
        <select value={coordinatorId} onChange={(e) => setCoordinatorId(e.target.value)}>
          <option value="">选择协调者…</option>
          {agents.map((c) => <option key={c.agent.id} value={c.agent.id}>{c.agent.name}（{c.agent.role}）</option>)}
        </select>
      </div>

      <div className="field">
        <label>共享工作目录（可选，留空自动创建）— 团队成员共享，通过 MD 文件交接</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="默认：userData/workspaces/team-{id}" style={{ flex: 1 }} />
          <button className="btn small" onClick={() => void pickDir()}>选择</button>
        </div>
      </div>

      <div className="field">
        <label>专家成员（可多选）</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, maxHeight: 180, overflowY: 'auto' }}>
          {agents.filter((c) => c.agent.id !== coordinatorId).map((c) => (
            <label key={c.agent.id} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 6, cursor: 'pointer',
              border: `1px solid ${memberIds.includes(c.agent.id) ? 'var(--accent)' : 'var(--border)'}`,
              background: memberIds.includes(c.agent.id) ? 'var(--accent-soft)' : 'transparent', fontSize: 12.5,
              color: 'var(--text-1)'
            }}>
              <input type="checkbox" checked={memberIds.includes(c.agent.id)} onChange={() => toggleMember(c.agent.id)} style={{ accentColor: 'var(--accent)', width: 15, height: 15 }} />
              {c.agent.name}
            </label>
          ))}
        </div>
        {agents.length <= 1 && <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6 }}>至少需要 2 个就绪助手才能组建团队（可到员工市场录用）</div>}
      </div>
    </Modal>
  );
}
