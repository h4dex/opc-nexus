/** 专家团管理：创建团队（选协调者+成员+模式）+ 提交团队任务 + 查看执行状态 */
import { useEffect, useState } from 'react';
import { useApp } from '../store';
import { Modal } from '../components/common';
import { IconPlus, IconUser, IconPlay, IconX } from '../components/icons';

interface TeamData {
  id: string; name: string; coordinatorId: string; memberIds: string[]; mode: string; createdAt: number;
}

export function Teams() {
  const { snapshot } = useApp();
  const [teams, setTeams] = useState<TeamData[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [taskInput, setTaskInput] = useState<Record<string, string>>({});
  const [triggerMsg, setTriggerMsg] = useState<Record<string, string>>({});

  useEffect(() => {
    void window.aibox.listTeams().then(setTeams);
  }, [snapshot?.tasks.length]);

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
          还没有专家团。点击「组建团队」创建一个多 Agent 协作团队。
        </div>
      )}

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
                  {team.mode === 'coordinate' ? '🎯 主Agent协调模式' : '🔄 专家圆桌模式'}
                </div>
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
          </div>
        ))}
      </div>

      {createOpen && <CreateTeamModal onClose={() => setCreateOpen(false)} onCreated={(t) => { setTeams((prev) => [t, ...prev]); setCreateOpen(false); }} />}
    </>
  );
}

/** 创建团队弹窗 */
function CreateTeamModal({ onClose, onCreated }: { onClose: () => void; onCreated: (t: TeamData) => void }) {
  const { snapshot } = useApp();
  const [name, setName] = useState('');
  const [coordinatorId, setCoordinatorId] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [mode, setMode] = useState<'coordinate' | 'roundtable'>('coordinate');
  const [busy, setBusy] = useState(false);

  if (!snapshot) return null;
  const agents = snapshot.agentCards.filter((c) => c.agent.lifecycle === 'READY');

  const toggleMember = (id: string) => {
    setMemberIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const create = async () => {
    if (!name.trim() || !coordinatorId) return;
    setBusy(true);
    try {
      const t = await window.aibox.createTeam({ name: name.trim(), coordinatorId, memberIds: memberIds.filter((id) => id !== coordinatorId), mode });
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
