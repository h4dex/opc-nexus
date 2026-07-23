/** 多机协同：工作区管理 + 任务看板 + 远程 Agent + 连接信息 */
import { useEffect, useState, useCallback } from 'react';
import { Modal } from '../components/common';
import { IconPlus } from '../components/icons';
import type { CollabWorkspace, CollabTask, CollabAgent, CollabConnectInfo } from '../../../shared/types';

type TabKey = 'tasks' | 'agents' | 'connect' | 'rules';

export function Collab() {
  const [gitStatus, setGitStatus] = useState<{ installed: boolean; version: string | null } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installMsg, setInstallMsg] = useState('');
  const [workspaces, setWorkspaces] = useState<CollabWorkspace[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('tasks');
  const [tasks, setTasks] = useState<CollabTask[]>([]);
  const [agents, setAgents] = useState<CollabAgent[]>([]);
  const [connectInfo, setConnectInfo] = useState<CollabConnectInfo | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [taskCreateOpen, setTaskCreateOpen] = useState(false);
  const [msg, setMsg] = useState('');

  // 创建表单
  const [form, setForm] = useState({ name: '', repoPath: '', conventions: '', gitRules: '' });
  const [taskForm, setTaskForm] = useState({ title: '', description: '' });

  const checkGit = useCallback(async () => {
    const r = await window.aibox.collabCheckGit();
    setGitStatus({ installed: r.installed, version: r.version });
  }, []);

  const loadWorkspaces = useCallback(async () => {
    const list = await window.aibox.collabListWorkspaces();
    setWorkspaces(list);
    if (!selected && list.length > 0) setSelected(list[0].id);
  }, [selected]);

  const loadDetail = useCallback(async () => {
    if (!selected) return;
    const [t, a, c] = await Promise.all([
      window.aibox.collabListTasks(selected),
      window.aibox.collabListAgents(selected),
      window.aibox.collabGetConnectInfo(selected)
    ]);
    setTasks(t);
    setAgents(a);
    setConnectInfo(c);
  }, [selected]);

  useEffect(() => { void checkGit(); void loadWorkspaces(); }, [checkGit, loadWorkspaces]);
  useEffect(() => { void loadDetail(); }, [loadDetail]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 4000); };

  const installGit = async () => {
    setInstalling(true);
    setInstallMsg('正在安装 Git，请稍候...');
    const r = await window.aibox.collabInstallGit();
    setInstallMsg(r.message);
    setInstalling(false);
    if (r.ok) setTimeout(() => void checkGit(), 2000);
  };

  const createWorkspace = async () => {
    if (!form.name.trim() || !form.repoPath.trim()) { flash('请填写名称和目录'); return; }
    const ws = await window.aibox.collabCreateWorkspace({
      name: form.name.trim(), repoPath: form.repoPath.trim(),
      conventions: form.conventions, gitRules: form.gitRules
    });
    setCreateOpen(false);
    setForm({ name: '', repoPath: '', conventions: '', gitRules: '' });
    await loadWorkspaces();
    setSelected(ws.id);
    flash('工作区创建成功');
  };

  const startWs = async (id: string) => {
    const r = await window.aibox.collabStartWorkspace(id);
    flash(r.message);
    await loadWorkspaces();
  };

  const stopWs = async (id: string) => {
    await window.aibox.collabStopWorkspace(id);
    flash('已停止');
    await loadWorkspaces();
  };

  const removeWs = async (id: string) => {
    await window.aibox.collabRemoveWorkspace(id);
    if (selected === id) setSelected(null);
    await loadWorkspaces();
    flash('已删除');
  };

  const createTask = async () => {
    if (!selected || !taskForm.title.trim()) return;
    await window.aibox.collabCreateTask(selected, { title: taskForm.title.trim(), description: taskForm.description });
    setTaskCreateOpen(false);
    setTaskForm({ title: '', description: '' });
    await loadDetail();
    flash('子任务已创建');
  };

  const reviewTask = async (taskId: string, result: 'accept' | 'reject') => {
    const comment = result === 'accept' ? '验收通过' : '需要修改';
    const r = await window.aibox.collabReviewTask(taskId, result, comment);
    flash(r.message);
    await loadDetail();
  };

  const pickDir = async () => {
    const dir = await window.aibox.pickDirectory();
    if (dir) setForm((f) => ({ ...f, repoPath: dir }));
  };

  const saveRules = async () => {
    if (!selected) return;
    await window.aibox.collabUpdateRules(selected, { conventions: form.conventions, gitRules: form.gitRules });
    flash('规范已保存');
  };

  const gitReady = gitStatus?.installed === true;
  const currentWs = workspaces.find((w) => w.id === selected);

  // 任务按状态分组
  const taskCols: { key: string; label: string; items: CollabTask[] }[] = [
    { key: 'pending', label: '待领取', items: tasks.filter((t) => t.status === 'pending') },
    { key: 'claimed', label: '进行中', items: tasks.filter((t) => ['claimed', 'in_progress'].includes(t.status)) },
    { key: 'submitted', label: '待验收', items: tasks.filter((t) => t.status === 'submitted') },
    { key: 'done', label: '已完成', items: tasks.filter((t) => ['accepted', 'rejected'].includes(t.status)) }
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%' }}>
      {/* Git 环境状态条 */}
      <div className="card" style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className={`dot ${gitReady ? 'green' : 'red'}`} />
        {gitStatus === null ? <span style={{ color: 'var(--text-2)' }}>检测中...</span>
          : gitReady ? <span style={{ color: 'var(--text-2)' }}>Git 已就绪：{gitStatus.version}</span>
          : <span style={{ color: 'var(--danger, #f87171)' }}>未检测到 Git 环境</span>}
        {!gitReady && gitStatus !== null && (
          <button className="btn btn-sm" onClick={() => void installGit()} disabled={installing}>
            {installing ? '安装中...' : '一键安装 Git'}
          </button>
        )}
        {installMsg && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{installMsg}</span>}
        {msg && <span style={{ fontSize: 12, color: 'var(--accent, #4d6bfe)', marginLeft: 'auto' }}>{msg}</span>}
      </div>

      {!gitReady ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>
          多机协同功能需要 Git 环境支持，请先安装 Git 后使用。
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0 }}>
          {/* 左侧：工作区列表 */}
          <div style={{ width: 260, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button className="btn" onClick={() => setCreateOpen(true)} style={{ width: '100%' }}>
              <IconPlus size={14} /> 创建工作区
            </button>
            {workspaces.map((ws) => (
              <div key={ws.id} className={`card ${selected === ws.id ? 'active' : ''}`}
                style={{ padding: '10px 12px', cursor: 'pointer', borderLeft: selected === ws.id ? '3px solid var(--accent, #4d6bfe)' : '3px solid transparent' }}
                onClick={() => { setSelected(ws.id); setTab('tasks'); }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong style={{ fontSize: 13 }}>{ws.name}</strong>
                  <span className={`dot ${ws.status === 'active' ? 'green' : ws.status === 'stopped' ? 'red' : 'yellow'}`} />
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                  MCP :{ws.mcpPort} / Git :{ws.gitPort}
                </div>
                <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                  {ws.status !== 'active' && <button className="btn btn-xs" onClick={(e) => { e.stopPropagation(); void startWs(ws.id); }}>启动</button>}
                  {ws.status === 'active' && <button className="btn btn-xs" onClick={(e) => { e.stopPropagation(); void stopWs(ws.id); }}>停止</button>}
                  <button className="btn btn-xs" style={{ color: 'var(--danger, #f87171)' }} onClick={(e) => { e.stopPropagation(); void removeWs(ws.id); }}>删除</button>
                </div>
              </div>
            ))}
            {workspaces.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: 12, textAlign: 'center', padding: 20 }}>暂无工作区</div>}
          </div>

          {/* 右侧：详情 */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            {!currentWs ? (
              <div className="card" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)' }}>
                选择或创建一个协同工作区
              </div>
            ) : (
              <>
                {/* Tab 栏 */}
                <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
                  {([['tasks', '任务看板'], ['agents', '远程 Agent'], ['connect', '连接信息'], ['rules', '规范配置']] as [TabKey, string][]).map(([k, label]) => (
                    <button key={k} className={`btn btn-sm ${tab === k ? 'btn-primary' : ''}`} onClick={() => setTab(k)}>{label}</button>
                  ))}
                </div>

                {/* 任务看板 */}
                {tab === 'tasks' && (
                  <div style={{ flex: 1, overflow: 'auto' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>子任务（{tasks.length}）</span>
                      <button className="btn btn-sm" onClick={() => setTaskCreateOpen(true)}><IconPlus size={12} /> 新建任务</button>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                      {taskCols.map((col) => (
                        <div key={col.key} className="card" style={{ padding: 8, minHeight: 120 }}>
                          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6, borderBottom: '1px solid var(--border, #333)', paddingBottom: 4 }}>
                            {col.label}（{col.items.length}）
                          </div>
                          {col.items.map((t) => (
                            <div key={t.id} style={{ fontSize: 12, padding: '6px 8px', marginBottom: 4, background: 'var(--bg-2, #1a1d24)', borderRadius: 6 }}>
                              <div style={{ fontWeight: 500 }}>{t.title}</div>
                              <div style={{ color: 'var(--text-3)', fontSize: 11, marginTop: 2 }}>
                                {t.branchName}{t.assignedAgent ? ` · ${t.assignedAgent}` : ''}
                              </div>
                              {t.status === 'submitted' && (
                                <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                                  <button className="btn btn-xs" style={{ color: '#4ade80' }} onClick={() => void reviewTask(t.id, 'accept')}>通过</button>
                                  <button className="btn btn-xs" style={{ color: '#f87171' }} onClick={() => void reviewTask(t.id, 'reject')}>驳回</button>
                                </div>
                              )}
                              {t.status === 'accepted' && <span style={{ fontSize: 10, color: '#4ade80' }}>已通过</span>}
                              {t.status === 'rejected' && <span style={{ fontSize: 10, color: '#f87171' }}>已驳回</span>}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 远程 Agent */}
                {tab === 'agents' && (
                  <div style={{ flex: 1, overflow: 'auto' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>已连接 Agent（{agents.length}）</div>
                    {agents.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: 12 }}>暂无远程 Agent 连接。启动工作区后，其他机器可通过 MCP 连接。</div>}
                    {agents.map((a) => (
                      <div key={a.id} className="card" style={{ padding: '8px 12px', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className={`dot ${a.status === 'online' ? 'green' : 'red'}`} />
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{a.name}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 'auto' }}>
                          {a.status === 'online' ? '在线' : '离线'} · {new Date(a.lastHeartbeat).toLocaleTimeString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* 连接信息 */}
                {tab === 'connect' && (
                  <div style={{ flex: 1, overflow: 'auto' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>远程 Agent 连接配置</div>
                    {connectInfo ? (
                      <div className="card" style={{ padding: 16 }}>
                        <div style={{ display: 'grid', gap: 10, fontSize: 13 }}>
                          <div><span style={{ color: 'var(--text-3)' }}>MCP 地址：</span><code>{connectInfo.mcpUrl}</code></div>
                          <div><span style={{ color: 'var(--text-3)' }}>Git 地址：</span><code>{connectInfo.gitUrl}</code></div>
                          <div><span style={{ color: 'var(--text-3)' }}>认证 Token：</span><code style={{ fontSize: 11 }}>{connectInfo.token}</code></div>
                          <div style={{ marginTop: 8, padding: 10, background: 'var(--bg-2, #1a1d24)', borderRadius: 6, fontSize: 12, color: 'var(--text-2)' }}>
                            远程 Agent 配置示例（MCP Client）：<br />
                            <code>{`{ "url": "${connectInfo.mcpUrl}", "headers": { "Authorization": "Bearer <token>" } }`}</code>
                          </div>
                        </div>
                      </div>
                    ) : <div style={{ color: 'var(--text-3)', fontSize: 12 }}>请先启动工作区</div>}
                  </div>
                )}

                {/* 规范配置 */}
                {tab === 'rules' && (
                  <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div>
                      <label style={{ fontSize: 12, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>团队规范（Markdown）</label>
                      <textarea className="input" rows={6} value={form.conventions} onChange={(e) => setForm((f) => ({ ...f, conventions: e.target.value }))}
                        placeholder="编码规范、代码风格、PR 流程等..." style={{ width: '100%', resize: 'vertical' }} />
                    </div>
                    <div>
                      <label style={{ fontSize: 12, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>Git 规范</label>
                      <textarea className="input" rows={4} value={form.gitRules} onChange={(e) => setForm((f) => ({ ...f, gitRules: e.target.value }))}
                        placeholder="分支策略：task/<id> 开发，main 为主分支&#10;Commit 格式：feat/fix/docs: 描述" style={{ width: '100%', resize: 'vertical' }} />
                    </div>
                    <button className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => void saveRules()}>保存规范</button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* 创建工作区弹窗 */}
      {createOpen && (
        <Modal title="创建协同工作区" onClose={() => setCreateOpen(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-2)' }}>工作区名称</label>
              <input className="input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="如：项目A协同" />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-2)' }}>仓库目录（bare repo 将创建在此）</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input" value={form.repoPath} onChange={(e) => setForm((f) => ({ ...f, repoPath: e.target.value }))} placeholder="选择目录..." style={{ flex: 1 }} />
                <button className="btn btn-sm" onClick={() => void pickDir()}>选择</button>
              </div>
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-2)' }}>团队规范（可选）</label>
              <textarea className="input" rows={3} value={form.conventions} onChange={(e) => setForm((f) => ({ ...f, conventions: e.target.value }))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-2)' }}>Git 规范（可选）</label>
              <textarea className="input" rows={2} value={form.gitRules} onChange={(e) => setForm((f) => ({ ...f, gitRules: e.target.value }))} style={{ width: '100%' }} />
            </div>
            <button className="btn btn-primary" onClick={() => void createWorkspace()}>确认创建</button>
          </div>
        </Modal>
      )}

      {/* 创建任务弹窗 */}
      {taskCreateOpen && (
        <Modal title="创建子任务" onClose={() => setTaskCreateOpen(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-2)' }}>任务标题</label>
              <input className="input" value={taskForm.title} onChange={(e) => setTaskForm((f) => ({ ...f, title: e.target.value }))} placeholder="如：实现用户登录模块" />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-2)' }}>任务描述（含验收标准）</label>
              <textarea className="input" rows={4} value={taskForm.description} onChange={(e) => setTaskForm((f) => ({ ...f, description: e.target.value }))} style={{ width: '100%' }}
                placeholder="详细描述任务要求、技术约束和验收标准..." />
            </div>
            <button className="btn btn-primary" onClick={() => void createTask()}>创建</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
