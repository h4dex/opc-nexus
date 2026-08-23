/** 数字员工管理：搜索/筛选 + 批量操作 + 表格/卡片视图切换 + 标签管理 + 导入/导出 */
import { useEffect, useState, useMemo } from 'react';
import { useApp } from '../store';
import { AgentEditor } from '../components/AgentEditor';
import { ContextMenu, Modal, type CtxMenuItem } from '../components/common';
import { IconFolder, IconPlay, IconStop, IconPlus } from '../components/icons';
import type { Agent, AgentCardView } from '@shared/types';

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

function lifecycleMeta(card: AgentCardView): { text: string; color: string } {
  if (card.agent.lifecycle === 'READY' && card.engineStatus !== 'HEALTHY') {
    if (card.engineStatus === 'AUTH_REQUIRED') return { text: '待登录', color: 'var(--warning)' };
    if (card.engineStatus === 'SETUP_REQUIRED' || card.engineStatus === 'NOT_INSTALLED') {
      return { text: '待配置', color: 'var(--warning)' };
    }
    return { text: '引擎异常', color: 'var(--danger)' };
  }
  return LIFECYCLE_LABEL[card.agent.lifecycle] ?? LIFECYCLE_LABEL.DISABLED;
}

type ViewMode = 'table' | 'card';

export function Agents() {
  const { snapshot, setWizardOpen, navigationTarget, clearNavigationTarget, openQuest, setRoute, questProjectId } = useApp();
  const [editAgent, setEditAgent] = useState<Agent | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; card: AgentCardView } | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterPerm, setFilterPerm] = useState('');
  const [filterTag, setFilterTag] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchMsg, setBatchMsg] = useState('');
  const [importMsg, setImportMsg] = useState('');
  const [detailAgent, setDetailAgent] = useState<Agent | null>(null);
  const [questAgent, setQuestAgent] = useState<Agent | null>(null);
  const [questProjects, setQuestProjects] = useState<Array<{
    id: string;
    name: string;
    allowed: boolean;
    policy: 'dynamic' | 'fixed' | 'unavailable';
    reason: string;
  }>>([]);
  const [questProjectChoice, setQuestProjectChoice] = useState('');
  const [questProjectsLoading, setQuestProjectsLoading] = useState(false);
  const [questProjectsError, setQuestProjectsError] = useState<string | null>(null);

  useEffect(() => {
    if (!snapshot || navigationTarget?.entityType !== 'agent') return;
    const agent = snapshot.agentCards.find((item) => item.agent.id === navigationTarget.entityId)?.agent;
    if (!agent) return;
    setSearch('');
    setFilterStatus('');
    setFilterPerm('');
    setFilterTag('');
    setDetailAgent(agent);
    clearNavigationTarget();
  }, [clearNavigationTarget, navigationTarget, snapshot]);

  if (!snapshot) return null;
  const { agentCards } = snapshot;

  // 收集所有标签
  const allTags = useMemo(() => {
    const tags = new Set<string>();
    agentCards.forEach((c) => (c.agent.tags ?? []).forEach((t) => tags.add(t)));
    return [...tags].sort();
  }, [agentCards]);

  // 筛选
  const filtered = useMemo(() => {
    return agentCards.filter((c) => {
      const { agent } = c;
      if (search && !agent.name.toLowerCase().includes(search.toLowerCase()) && !agent.role.toLowerCase().includes(search.toLowerCase())) return false;
      if (filterStatus && agent.lifecycle !== filterStatus) return false;
      if (filterPerm && agent.permissionMode !== filterPerm) return false;
      if (filterTag && !(agent.tags ?? []).includes(filterTag)) return false;
      return true;
    });
  }, [agentCards, search, filterStatus, filterPerm, filterTag]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };
  const selectAll = () => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map((c) => c.agent.id)));
  };

  const batchAction = async (action: 'start' | 'stop' | 'delete') => {
    if (selected.size === 0) return;
    const r = await window.aibox.batchAgentAction([...selected], action);
    setBatchMsg(r.message);
    setSelected(new Set());
    setTimeout(() => setBatchMsg(''), 3000);
  };

  const importAgent = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      const r = await window.aibox.importAgent(text);
      setImportMsg(r.message);
      setTimeout(() => setImportMsg(''), 4000);
    };
    input.click();
  };

  const exportAgent = async (id: string) => {
    const json = await window.aibox.exportAgent(id);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const agent = agentCards.find((c) => c.agent.id === id)?.agent;
    a.download = `${agent?.name ?? 'agent'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const prepareQuest = async (agent: Agent) => {
    setQuestAgent(agent);
    setQuestProjects([]);
    setQuestProjectChoice('');
    setQuestProjectsError(null);
    setQuestProjectsLoading(true);
    const projects = (snapshot?.projects ?? [])
      .filter((project) => project.status !== 'archived')
      .sort((left, right) => Number(right.id === questProjectId) - Number(left.id === questProjectId)
        || right.updatedAt - left.updatedAt);
    if (projects.length === 0) {
      setQuestProjectsLoading(false);
      return;
    }
    const results = await Promise.all(projects.map(async (project) => {
      try {
        const workbench = await window.aibox.getProjectWorkbench(project.id);
        const fixed = workbench.settings.workerAgentIds;
        const allowed = fixed.length === 0 || fixed.includes(agent.id);
        return {
          id: project.id,
          name: project.name,
          allowed,
          policy: fixed.length === 0 ? 'dynamic' as const : allowed ? 'fixed' as const : 'unavailable' as const,
          reason: fixed.length === 0
            ? '动态组队，可使用该员工'
            : allowed ? '该员工已在固定员工池中' : '固定员工池未包含该员工'
        };
      } catch {
        return {
          id: project.id,
          name: project.name,
          allowed: false,
          policy: 'unavailable' as const,
          reason: '项目配置暂时无法读取'
        };
      }
    }));
    setQuestProjects(results);
    setQuestProjectChoice(results.find((project) => project.allowed)?.id ?? '');
    if (!results.some((project) => project.allowed)) {
      setQuestProjectsError('没有允许该员工加入的项目，请先在项目 Quest 设置中更新固定员工池。');
    }
    setQuestProjectsLoading(false);
  };

  const launchQuest = () => {
    if (!questAgent || !questProjectChoice) return;
    const employeeId = questAgent.id;
    const projectId = questProjectChoice;
    setQuestAgent(null);
    openQuest(projectId, employeeId);
  };

  /** 右键菜单项 */
  const ctxItems = (card: AgentCardView): CtxMenuItem[] => {
    const agent = card.agent;
    const ready = agent.lifecycle === 'READY';
    return [
      { label: '在 Quest 中使用', icon: <IconFolder size={13} />, onClick: () => void prepareQuest(agent) },
      { label: '编辑 / 设置', onClick: () => setEditAgent(agent) },
      { label: '打开工作目录', onClick: () => void window.aibox.openAgentWorkspace(agent.id) },
      { label: '导出配置', onClick: () => void exportAgent(agent.id) },
      { divider: true, label: '', onClick: () => {} },
      ready
        ? { label: '停用', onClick: () => void window.aibox.stopAgent(agent.id) }
        : { label: '启用', onClick: () => void window.aibox.startAgent(agent.id) },
      { label: '克隆', onClick: () => void window.aibox.cloneAgent(agent.id, `${agent.name} (副本)`) }
    ];
  };

  const selectStyle: React.CSSProperties = {
    padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)',
    background: 'var(--input-bg)', color: 'var(--text-1)', fontSize: 12, outline: 'none'
  };

  return (
    <>
      <div className="page-head">
        <h2>数字员工</h2>
        <span className="desc">{agentCards.length} 位员工 · 管理助手配置、权限、引擎与生命周期</span>
        <div className="right">
          <button className="btn small" onClick={() => importAgent()}>导入</button>
          <button className="btn small" onClick={() => setViewMode(viewMode === 'table' ? 'card' : 'table')}>
            {viewMode === 'table' ? '卡片视图' : '列表视图'}
          </button>
          <button className="btn small primary" onClick={() => setWizardOpen(true)}><IconPlus size={13} />新建员工</button>
        </div>
      </div>

      {/* 搜索/筛选栏 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索名称或职责…"
          style={{ ...selectStyle, flex: '1 1 180px' }}
        />
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} style={selectStyle}>
          <option value="">全部状态</option>
          <option value="READY">就绪</option>
          <option value="STARTING">启动中</option>
          <option value="DISABLED">已停用</option>
          <option value="ERROR">异常</option>
        </select>
        <select value={filterPerm} onChange={(e) => setFilterPerm(e.target.value)} style={selectStyle}>
          <option value="">全部权限</option>
          <option value="readonly">只读</option>
          <option value="standard">标准</option>
          <option value="trusted">受信任</option>
          <option value="autonomous">自主</option>
        </select>
        {allTags.length > 0 && (
          <select value={filterTag} onChange={(e) => setFilterTag(e.target.value)} style={selectStyle}>
            <option value="">全部标签</option>
            {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{filtered.length} / {agentCards.length} 位</span>
      </div>

      {/* 批量操作工具栏 */}
      {selected.size > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, padding: '8px 14px', borderRadius: 8, background: 'var(--accent-soft)', alignItems: 'center', fontSize: 12.5 }}>
          <span style={{ fontWeight: 650 }}>已选 {selected.size} 位</span>
          <button className="btn small" onClick={() => void batchAction('start')}><IconPlay size={12} />批量启用</button>
          <button className="btn small" onClick={() => void batchAction('stop')}><IconStop size={12} />批量停用</button>
          <button className="btn small danger" onClick={() => void batchAction('delete')}>批量删除</button>
          <button className="btn small" onClick={() => setSelected(new Set())}>取消选择</button>
        </div>
      )}
      {batchMsg && <div style={{ fontSize: 12.5, marginBottom: 10, color: 'var(--success)' }}>{batchMsg}</div>}
      {importMsg && <div style={{ fontSize: 12.5, marginBottom: 10, color: importMsg.includes('已导入') ? 'var(--success)' : 'var(--danger)' }}>{importMsg}</div>}

      {/* 表格视图 */}
      {viewMode === 'table' && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--input-bg)', color: 'var(--text-2)', fontSize: 12 }}>
                <th style={{ padding: '10px 12px', width: 36 }}>
                  <input type="checkbox" checked={selected.size === filtered.length && filtered.length > 0} onChange={selectAll} style={{ accentColor: 'var(--accent)' }} />
                </th>
                <th style={{ padding: '10px 12px', textAlign: 'left' }}>名称</th>
                <th style={{ padding: '10px 12px', textAlign: 'left' }}>职责</th>
                <th style={{ padding: '10px 12px', textAlign: 'center' }}>状态</th>
                <th style={{ padding: '10px 12px', textAlign: 'center' }}>权限</th>
                <th style={{ padding: '10px 12px', textAlign: 'left' }}>引擎 / 模型</th>
                <th style={{ padding: '10px 12px', textAlign: 'left' }}>标签</th>
                <th style={{ padding: '10px 12px', textAlign: 'center' }}>当前任务</th>
                <th style={{ padding: '10px 12px', textAlign: 'center' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((card) => {
                const { agent } = card;
                const lc = lifecycleMeta(card);
                const perm = PERM_LABEL[agent.permissionMode] ?? PERM_LABEL.standard;
                return (
                  <tr key={agent.id} style={{ borderTop: '1px solid var(--border)' }}
                    onContextMenu={(e) => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, card }); }}>
                    <td style={{ padding: '12px', textAlign: 'center' }}>
                      <input type="checkbox" checked={selected.has(agent.id)} onChange={() => toggleSelect(agent.id)} style={{ accentColor: 'var(--accent)' }} />
                    </td>
                    <td style={{ padding: '12px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }} onClick={() => setDetailAgent(agent)}>
                        <div style={{ width: 32, height: 32, borderRadius: 8, background: `${agent.avatarColor}22`, color: agent.avatarColor, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13 }}>
                          {agent.name.slice(0, 1)}
                        </div>
                        <div>
                          <div style={{ fontWeight: 600 }}>{agent.name}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{agent.role.slice(0, 20)}…</div>
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '12px', color: 'var(--text-2)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
                    <td style={{ padding: '12px', maxWidth: 140 }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                        {(agent.tags ?? []).map((t) => (
                          <span key={t} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: 'var(--input-bg)', color: 'var(--text-2)', border: '1px solid var(--border)' }}>{t}</span>
                        ))}
                        {(agent.tags ?? []).length === 0 && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>—</span>}
                      </div>
                    </td>
                    <td style={{ padding: '12px', textAlign: 'center', fontSize: 12, color: card.currentTask ? 'var(--accent)' : 'var(--text-3)' }}>
                      {card.currentTask ? `${card.currentTask.progress}%` : '空闲'}
                    </td>
                    <td style={{ padding: '12px', textAlign: 'center' }}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap' }}>
                        <button className="btn small primary" onClick={() => void prepareQuest(agent)} style={{ padding: '4px 9px', fontSize: 11.5 }}><IconFolder size={12} />在 Quest 中使用</button>
                        <button className="btn small" onClick={() => setEditAgent(agent)} style={{ padding: '4px 10px', fontSize: 11.5 }}>编辑</button>
                        {agent.lifecycle === 'READY' ? (
                          <button className="btn small" onClick={() => void window.aibox.stopAgent(agent.id)} style={{ padding: '4px 8px' }} title="停用"><IconStop size={12} /></button>
                        ) : (
                          <button className="btn small" onClick={() => void window.aibox.startAgent(agent.id)} style={{ padding: '4px 8px' }} title="启用"><IconPlay size={12} /></button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>
              {agentCards.length === 0 ? '还没有数字员工，点击「新建员工」或到「员工市场」录用' : '无匹配结果，请调整筛选条件'}
            </div>
          )}
        </div>
      )}

      {/* 卡片视图 */}
      {viewMode === 'card' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
          {filtered.map((card) => {
            const { agent } = card;
            const lc = lifecycleMeta(card);
            const perm = PERM_LABEL[agent.permissionMode] ?? PERM_LABEL.standard;
            return (
              <div key={agent.id} className="card" style={{ padding: 16, cursor: 'pointer', border: selected.has(agent.id) ? '2px solid var(--accent)' : undefined }}
                onClick={() => toggleSelect(agent.id)}
                onContextMenu={(e) => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, card }); }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: `${agent.avatarColor}22`, color: agent.avatarColor, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 16 }}>
                    {agent.name.slice(0, 1)}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 650, fontSize: 14 }}>{agent.name}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>{agent.role.slice(0, 30)}</div>
                  </div>
                  <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: `1px solid ${lc.color}`, color: lc.color }}>{lc.text}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10, fontSize: 11.5 }}>
                  <span style={{ color: perm.color, fontWeight: 600 }}>{perm.text}</span>
                  <span style={{ color: 'var(--text-3)' }}>·</span>
                  <span style={{ color: 'var(--text-2)' }}>{card.engineName}</span>
                  {card.modelName && <><span style={{ color: 'var(--text-3)' }}>·</span><span style={{ color: 'var(--text-3)' }}>{card.modelName}</span></>}
                </div>
                {(agent.tags ?? []).length > 0 && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
                    {(agent.tags ?? []).map((t) => (
                      <span key={t} style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, background: 'var(--input-bg)', color: 'var(--text-2)', border: '1px solid var(--border)' }}>{t}</span>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button className="btn small primary" onClick={(e) => { e.stopPropagation(); void prepareQuest(agent); }} style={{ fontSize: 11 }}><IconFolder size={12} />在 Quest 中使用</button>
                  <button className="btn small" onClick={(e) => { e.stopPropagation(); setEditAgent(agent); }} style={{ fontSize: 11 }}>编辑</button>
                  {agent.lifecycle === 'READY' ? (
                    <button className="btn small" onClick={(e) => { e.stopPropagation(); void window.aibox.stopAgent(agent.id); }} style={{ fontSize: 11 }}>停用</button>
                  ) : (
                    <button className="btn small" onClick={(e) => { e.stopPropagation(); void window.aibox.startAgent(agent.id); }} style={{ fontSize: 11 }}>启用</button>
                  )}
                  <button className="btn small" onClick={(e) => { e.stopPropagation(); void exportAgent(agent.id); }} style={{ fontSize: 11 }}>导出</button>
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div style={{ gridColumn: '1 / -1', padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>无匹配结果</div>
          )}
        </div>
      )}

      {editAgent && <AgentEditor agent={editAgent} onClose={() => setEditAgent(null)} />}
      {detailAgent && <AgentDetailDrawer agent={detailAgent} onClose={() => setDetailAgent(null)} onEdit={() => { setEditAgent(detailAgent); setDetailAgent(null); }} onUse={() => { const agent = detailAgent; setDetailAgent(null); void prepareQuest(agent); }} />}
      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctxItems(ctx.card)} onClose={() => setCtx(null)} />}
      {questAgent && (
        <Modal
          title={`选择 ${questAgent.name} 使用的项目`}
          onClose={() => setQuestAgent(null)}
          width={520}
          footer={(
            <>
              <button className="btn" type="button" onClick={() => setQuestAgent(null)}>取消</button>
              {questProjects.length === 0 && !questProjectsLoading
                ? <button className="btn primary" type="button" onClick={() => { setQuestAgent(null); setRoute('projects'); }}>前往项目中心</button>
                : <button className="btn primary" type="button" disabled={!questProjectChoice || questProjectsLoading} onClick={launchQuest}>打开 Quest</button>}
            </>
          )}
        >
          {questProjectsLoading && <div className="page-loading">正在读取项目员工范围...</div>}
          {!questProjectsLoading && questProjects.length === 0 && (
            <div className="empty-state"><strong>还没有可用项目</strong><p>先创建项目并确认交付目录，再使用数字员工。</p></div>
          )}
          {!questProjectsLoading && questProjects.length > 0 && (
            <div style={{ display: 'grid', gap: 8 }} role="radiogroup" aria-label="Quest 项目选择">
              {questProjects.map((project) => (
                <label
                  key={project.id}
                  style={{
                    display: 'grid', gridTemplateColumns: '20px minmax(0, 1fr)', gap: 10,
                    padding: '11px 12px', border: `1px solid ${questProjectChoice === project.id ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 6, opacity: project.allowed ? 1 : 0.58,
                    background: questProjectChoice === project.id ? 'var(--accent-soft)' : 'var(--input-bg)',
                    cursor: project.allowed ? 'pointer' : 'not-allowed'
                  }}
                >
                  <input
                    type="radio"
                    name="quest-project"
                    value={project.id}
                    checked={questProjectChoice === project.id}
                    disabled={!project.allowed}
                    onChange={() => setQuestProjectChoice(project.id)}
                    style={{ marginTop: 2, accentColor: 'var(--accent)' }}
                  />
                  <span style={{ minWidth: 0 }}>
                    <strong style={{ display: 'block', fontSize: 13 }}>{project.name}</strong>
                    <small style={{ display: 'block', marginTop: 3, color: project.allowed ? 'var(--text-2)' : 'var(--warning)' }}>{project.reason}</small>
                  </span>
                </label>
              ))}
            </div>
          )}
          {questProjectsError && <div role="alert" style={{ marginTop: 12, color: 'var(--warning)', fontSize: 12 }}>{questProjectsError}</div>}
        </Modal>
      )}
    </>
  );
}

/** 员工详情抽屉：最近任务 + Token 统计 + 活动日志 */
function AgentDetailDrawer({ agent, onClose, onEdit, onUse }: { agent: Agent; onClose: () => void; onEdit: () => void; onUse: () => void }) {
  const [detail, setDetail] = useState<{
    tasks: { id: string; title: string; status: string; progress: number; createdAt: number }[];
    usage: { totalTokens: number; inputTokens: number; outputTokens: number; calls: number };
    events: { id: string; eventType: string; createdAt: number }[];
  } | null>(null);

  useEffect(() => {
    let active = true;
    setDetail(null);
    void window.aibox.getAgentDetail(agent.id).then((value) => { if (active) setDetail(value); }).catch(() => { if (active) setDetail({ tasks: [], usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0, calls: 0 }, events: [] }); });
    return () => { active = false; };
  }, [agent.id]);

  if (!detail) return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 900 }} onClick={onClose}>
      <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 420, background: 'var(--card)', borderLeft: '1px solid var(--border)', padding: 20 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ color: 'var(--text-3)', fontSize: 12 }}>正在加载员工详情…</div>
      </div>
    </div>
  );

  const statusLabel = (s: string) => ({ QUEUED: '排队', RUNNING: '执行中', COMPLETED: '完成', FAILED: '失败', CANCELLED: '取消', PAUSED: '暂停' }[s] ?? s);
  const statusColor = (s: string) => s === 'COMPLETED' ? 'var(--success)' : s === 'FAILED' ? 'var(--danger)' : s === 'RUNNING' ? 'var(--accent)' : 'var(--text-3)';

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 900 }} onClick={onClose}>
      <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 420, background: 'var(--card)', borderLeft: '1px solid var(--border)', padding: 20, overflowY: 'auto', boxShadow: '-4px 0 24px rgba(0,0,0,.3)' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: `${agent.avatarColor}22`, color: agent.avatarColor, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 16 }}>{agent.name.slice(0, 1)}</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{agent.name}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{agent.role.slice(0, 30)}</div>
            </div>
          </div>
          <button className="btn small" onClick={onClose}>×</button>
        </div>

        {/* Token 统计 */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
          <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--input-bg)', textAlign: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)' }}>{detail.usage.totalTokens.toLocaleString()}</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>总 Token</div>
          </div>
          <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--input-bg)', textAlign: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--success)' }}>{detail.usage.calls}</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>调用次数</div>
          </div>
          <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--input-bg)', textAlign: 'center' }}>
            <div style={{ fontSize: 14, fontWeight: 650, color: 'var(--text-1)' }}>{detail.usage.inputTokens.toLocaleString()}</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>输入 Token</div>
          </div>
          <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--input-bg)', textAlign: 'center' }}>
            <div style={{ fontSize: 14, fontWeight: 650, color: 'var(--text-1)' }}>{detail.usage.outputTokens.toLocaleString()}</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>输出 Token</div>
          </div>
        </div>

        {/* 最近任务 */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 650, fontSize: 13, marginBottom: 8 }}>最近任务</div>
          {detail.tasks.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-3)' }}>暂无任务记录</div>}
          {detail.tasks.map((t) => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 6, background: 'var(--input-bg)', marginBottom: 4, fontSize: 12 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor(t.status), flexShrink: 0 }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-1)' }}>{t.title}</span>
              <span style={{ color: statusColor(t.status), fontWeight: 600, fontSize: 11 }}>{statusLabel(t.status)}</span>
              <span style={{ color: 'var(--text-3)', fontSize: 10.5 }}>{new Date(t.createdAt).toLocaleDateString('zh-CN')}</span>
            </div>
          ))}
        </div>

        {/* 活动日志 */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 650, fontSize: 13, marginBottom: 8 }}>活动日志</div>
          {detail.events.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-3)' }}>暂无活动</div>}
          <div style={{ maxHeight: 160, overflowY: 'auto', fontSize: 11.5, lineHeight: 2 }}>
            {detail.events.map((e) => (
              <div key={e.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span style={{ color: 'var(--text-3)', fontFamily: 'monospace', fontSize: 10.5, minWidth: 60 }}>{new Date(e.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                <span style={{ color: 'var(--text-2)' }}>{e.eventType}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" style={{ flex: 1, justifyContent: 'center' }} onClick={onUse}><IconFolder size={14} />在项目中使用</button>
          <button className="btn" style={{ flex: 1, justifyContent: 'center' }} onClick={onEdit}>编辑员工配置</button>
        </div>
      </div>
    </div>
  );
}
