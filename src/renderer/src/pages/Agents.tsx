/** 数字员工管理：搜索/筛选 + 批量操作 + 表格/卡片视图切换 + 标签管理 + 导入/导出 */
import { useEffect, useState, useMemo } from 'react';
import { useApp } from '../store';
import { AgentEditor } from '../components/AgentEditor';
import { ContextMenu, Modal, type CtxMenuItem } from '../components/common';
import { IconPlay, IconStop, IconPlus, IconTask } from '../components/icons';
import { toast } from '../components/Toast';
import type { Agent, AgentCardView, Project } from '@shared/types';

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

type ViewMode = 'table' | 'card';

export function Agents() {
  const { snapshot, setWizardOpen, navigationTarget, clearNavigationTarget } = useApp();
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
  const [taskAgent, setTaskAgent] = useState<Agent | null>(null);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskProjectId, setTaskProjectId] = useState('');
  const [taskBusy, setTaskBusy] = useState(false);

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

  const openTaskModal = (agent: Agent) => {
    setTaskAgent(agent);
    setTaskTitle('');
    setTaskProjectId('');
  };

  const closeTaskModal = () => {
    if (taskBusy) return;
    setTaskAgent(null);
    setTaskTitle('');
    setTaskProjectId('');
  };

  const scheduleTask = async () => {
    if (!taskAgent || !taskTitle.trim() || taskBusy) return;
    setTaskBusy(true);
    try {
      await window.aibox.createTask(taskAgent.id, taskTitle.trim(), taskProjectId || undefined);
      toast.ok(`任务已安排给「${taskAgent.name}」`);
      // closeTaskModal intentionally refuses to close while a request is active;
      // this path is already successful and should reset the form immediately.
      setTaskAgent(null);
      setTaskTitle('');
      setTaskProjectId('');
    } catch (error) {
      toast.err(error instanceof Error ? error.message : '任务安排失败');
    } finally {
      setTaskBusy(false);
    }
  };

  /** 右键菜单项 */
  const ctxItems = (card: AgentCardView): CtxMenuItem[] => {
    const agent = card.agent;
    const ready = agent.lifecycle === 'READY';
    return [
      { label: '安排任务', icon: <IconTask size={13} />, onClick: () => openTaskModal(agent) },
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
                const lc = LIFECYCLE_LABEL[agent.lifecycle] ?? LIFECYCLE_LABEL.DISABLED;
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
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                        <button className="btn small primary" onClick={() => openTaskModal(agent)} style={{ padding: '4px 9px', fontSize: 11.5 }}><IconTask size={12} />安排任务</button>
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
            const lc = LIFECYCLE_LABEL[agent.lifecycle] ?? LIFECYCLE_LABEL.DISABLED;
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
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn small primary" onClick={(e) => { e.stopPropagation(); openTaskModal(agent); }} style={{ fontSize: 11 }}><IconTask size={12} />安排任务</button>
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
      {detailAgent && <AgentDetailDrawer agent={detailAgent} onClose={() => setDetailAgent(null)} onEdit={() => { setEditAgent(detailAgent); setDetailAgent(null); }} />}
      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctxItems(ctx.card)} onClose={() => setCtx(null)} />}
      {taskAgent && <AgentTaskModal
        agent={taskAgent}
        projects={snapshot.projects}
        title={taskTitle}
        projectId={taskProjectId}
        busy={taskBusy}
        onTitleChange={setTaskTitle}
        onProjectChange={setTaskProjectId}
        onClose={closeTaskModal}
        onSubmit={() => void scheduleTask()}
      />}
    </>
  );
}

function AgentTaskModal({
  agent, projects, title, projectId, busy, onTitleChange, onProjectChange, onClose, onSubmit
}: {
  agent: Agent;
  projects: Project[];
  title: string;
  projectId: string;
  busy: boolean;
  onTitleChange: (value: string) => void;
  onProjectChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const availableProjects = projects.filter((project) => !['completed', 'archived'].includes(project.status));
  return (
    <Modal title={`安排任务 · ${agent.name}`} onClose={onClose} width={560} footer={<>
      <button className="btn" type="button" onClick={onClose} disabled={busy}>取消</button>
      <button className="btn primary" type="button" onClick={onSubmit} disabled={busy || !title.trim()}>
        <IconTask size={14} />{busy ? '安排中…' : '安排任务'}
      </button>
    </>}>
      <div className="field">
        <label>任务描述</label>
        <textarea
          autoFocus
          rows={5}
          maxLength={500}
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
          onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') onSubmit(); }}
          placeholder="说明目标、输入资料和预期结果"
        />
      </div>
      <div className="field" style={{ marginTop: 14 }}>
        <label>归属项目</label>
        <select value={projectId} onChange={(event) => onProjectChange(event.target.value)}>
          <option value="">未归项目</option>
          {availableProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </div>
      <div style={{ marginTop: 12, fontSize: 11.5, color: 'var(--text-3)' }}>
        任务会进入任务中心，并按员工当前状态和并发限制执行。
      </div>
    </Modal>
  );
}

/** 员工详情抽屉：最近任务 + Token 统计 + 活动日志 */
function AgentDetailDrawer({ agent, onClose, onEdit }: { agent: Agent; onClose: () => void; onEdit: () => void }) {
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

        <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} onClick={onEdit}>编辑员工配置</button>
      </div>
    </div>
  );
}
