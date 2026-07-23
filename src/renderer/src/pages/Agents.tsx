/** 数字员工管理：列表视图 + 状态/权限/引擎一览 + 快捷操作（编辑/启停/克隆/归档） */
import { useState } from 'react';
import { useApp } from '../store';
import { AgentEditor } from '../components/AgentEditor';
import { IconPlay, IconStop, IconPlus } from '../components/icons';
import type { Agent } from '@shared/types';

const PERM_LABEL: Record<string, { text: string; color: string }> = {
  readonly: { text: '只读', color: 'var(--text-3)' },
  standard: { text: '标准', color: 'var(--warning)' },
  trusted: { text: '受信任', color: 'var(--accent)' },
  autonomous: { text: '自主', color: 'var(--success)' }
};

const LIFECYCLE_LABEL: Record<string, { text: string; color: string }> = {
  READY: { text: '就绪', color: 'var(--success)' },
  STARTING: { text: '启动中', color: 'var(--accent)' },
  STOPPING: { text: '停止中', color: 'var(--text-3)' },
  DISABLED: { text: '已停用', color: 'var(--text-3)' },
  ERROR: { text: '异常', color: 'var(--danger)' }
};

export function Agents() {
  const { snapshot, setWizardOpen } = useApp();
  const [editAgent, setEditAgent] = useState<Agent | null>(null);

  if (!snapshot) return null;
  const { agentCards } = snapshot;

  return (
    <>
      <div className="page-head">
        <h2>数字员工</h2>
        <span className="desc">{agentCards.length} 位员工 · 管理助手配置、权限、引擎与生命周期</span>
        <div className="right">
          <button className="btn small primary" onClick={() => setWizardOpen(true)}><IconPlus size={13} />新建员工</button>
        </div>
      </div>

      {/* 员工列表 */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--input-bg)', color: 'var(--text-2)', fontSize: 12 }}>
              <th style={{ padding: '10px 16px', textAlign: 'left' }}>名称</th>
              <th style={{ padding: '10px 12px', textAlign: 'left' }}>职责</th>
              <th style={{ padding: '10px 12px', textAlign: 'center' }}>状态</th>
              <th style={{ padding: '10px 12px', textAlign: 'center' }}>权限</th>
              <th style={{ padding: '10px 12px', textAlign: 'left' }}>引擎 / 模型</th>
              <th style={{ padding: '10px 12px', textAlign: 'left' }}>能力（Skills / MCP）</th>
              <th style={{ padding: '10px 12px', textAlign: 'center' }}>当前任务</th>
              <th style={{ padding: '10px 12px', textAlign: 'center' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {agentCards.map((card) => {
              const { agent } = card;
              const lc = LIFECYCLE_LABEL[agent.lifecycle] ?? LIFECYCLE_LABEL.DISABLED;
              const perm = PERM_LABEL[agent.permissionMode] ?? PERM_LABEL.standard;
              return (
                <tr key={agent.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '12px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 32, height: 32, borderRadius: 8, background: `${agent.avatarColor}22`, color: agent.avatarColor, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13 }}>
                        {agent.name.slice(0, 1)}
                      </div>
                      <div>
                        <div style={{ fontWeight: 600 }}>{agent.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{agent.role.slice(0, 20)}…</div>
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: '12px', color: 'var(--text-2)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {agent.role.slice(0, 40)}
                  </td>
                  <td style={{ padding: '12px', textAlign: 'center' }}>
                    <span style={{ fontSize: 11.5, padding: '2px 8px', borderRadius: 4, border: `1px solid ${lc.color}`, color: lc.color }}>{lc.text}</span>
                  </td>
                  <td style={{ padding: '12px', textAlign: 'center' }}>
                    <span style={{ fontSize: 11.5, color: perm.color, fontWeight: 600 }}>{perm.text}</span>
                  </td>
                  <td style={{ padding: '12px', fontSize: 12, color: 'var(--text-2)' }}>
                    <div>{card.engineName}</div>
                    {card.modelName && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{card.modelName}</div>}
                  </td>
                  <td style={{ padding: '12px', maxWidth: 220 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {card.skills.map((s) => (
                        <span key={s} title={`Skill: ${s}`} style={{ fontSize: 10.5, padding: '1px 6px', borderRadius: 3, background: 'var(--accent-dim, rgba(77,107,254,.12))', color: 'var(--accent)', border: '1px solid var(--accent)', whiteSpace: 'nowrap' }}>{s}</span>
                      ))}
                      {card.mcpServers.map((m) => (
                        <span key={m} title={`MCP: ${m}`} style={{ fontSize: 10.5, padding: '1px 6px', borderRadius: 3, background: 'rgba(16,185,129,.1)', color: 'var(--success)', border: '1px solid var(--success)', whiteSpace: 'nowrap' }}>{m}</span>
                      ))}
                      {card.skills.length === 0 && card.mcpServers.length === 0 && (
                        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>未配置</span>
                      )}
                    </div>
                  </td>
                  <td style={{ padding: '12px', textAlign: 'center', fontSize: 12, color: card.currentTask ? 'var(--accent)' : 'var(--text-3)' }}>
                    {card.currentTask ? `${card.currentTask.progress}%` : '空闲'}
                  </td>
                  <td style={{ padding: '12px', textAlign: 'center' }}>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                      <button className="btn small" onClick={() => setEditAgent(agent)} style={{ padding: '4px 10px', fontSize: 11.5 }}>编辑</button>
                      {agent.lifecycle === 'READY' ? (
                        <button className="btn small" onClick={() => void window.aibox.stopAgent(agent.id)} style={{ padding: '4px 8px' }} title="停用"><IconStop size={12} /></button>
                      ) : (
                        <button className="btn small" onClick={() => void window.aibox.startAgent(agent.id)} style={{ padding: '4px 8px' }} title="启用"><IconPlay size={12} /></button>
                      )}
                      <button className="btn small" onClick={() => void window.aibox.cloneAgent(agent.id, `${agent.name} (副本)`)} style={{ padding: '4px 10px', fontSize: 11.5 }}>克隆</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {agentCards.length === 0 && (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>还没有数字员工，点击「新建员工」或到「员工市场」录用</div>
        )}
      </div>

      {editAgent && <AgentEditor agent={editAgent} onClose={() => setEditAgent(null)} />}
    </>
  );
}
