/**
 * 工作流编辑器页面：左侧工作流列表 + 中间 React Flow 画布 + 右侧节点配置面板
 * 支持拖拽创建节点、连线、保存、运行、发布为 Skill
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap, addEdge, useNodesState, useEdgesState,
  type Connection, type Node, type Edge, type ReactFlowInstance
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { wfNodeTypes } from '../components/wfNodes';
import { WfNodePanel } from '../components/WfNodePanel';
import { IconPlus, IconPlay, IconFlow, IconSettings } from '../components/icons';
import type { WorkflowDef, WfNode, WfEdge, WfNodeConfig, WfNodeType, WfPlatformConfig, WfNodeEvent, WfVariable } from '@shared/types';

const NODE_PALETTE: { type: WfNodeType; label: string; icon: string; color: string }[] = [
  { type: 'ai', label: 'AI 调用', icon: '🤖', color: '#8a5cf6' },
  { type: 'cli', label: 'CLI 命令', icon: '⌨️', color: '#3aa7ff' },
  { type: 'python', label: 'Python', icon: '🐍', color: '#22c1a3' },
  { type: 'http', label: 'HTTP', icon: '🌐', color: '#f59e0b' },
  { type: 'coze', label: 'Coze', icon: '⚡', color: '#00b4d8' },
  { type: 'dify', label: 'Dify', icon: '🔮', color: '#7c5cfc' },
  { type: 'condition', label: '条件分支', icon: '❓', color: '#f97316' },
  { type: 'loop', label: '循环', icon: '🔄', color: '#06b6d4' },
  { type: 'delay', label: '延时', icon: '⏳', color: '#a78bfa' },
  { type: 'subflow', label: '子工作流', icon: '📦', color: '#ec4899' },
  { type: 'start', label: '开始', icon: '▶', color: 'var(--success)' },
  { type: 'end', label: '结束', icon: '⏹', color: 'var(--danger)' }
];

let nodeIdCounter = 0;

export function Workflows() {
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [selected, setSelected] = useState<WorkflowDef | null>(null);
  const [platforms, setPlatforms] = useState<WfPlatformConfig[]>([]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [runStatuses, setRunStatuses] = useState<Map<string, string>>(new Map());
  const [showPlatformMgr, setShowPlatformMgr] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showVariables, setShowVariables] = useState(false);
  const [history, setHistory] = useState<{ id: string; status: string; error: string | null; startedAt: number; endedAt: number | null; durationMs: number | null }[]>([]);
  const [validation, setValidation] = useState<{ valid: boolean; errors: string[]; warnings: string[] } | null>(null);
  const [importMsg, setImportMsg] = useState('');
  const rfRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 加载工作流列表 + 平台列表
  const load = useCallback(() => {
    void window.aibox.listWorkflows().then(setWorkflows);
    void window.aibox.listWfPlatforms().then(setPlatforms);
  }, []);
  useEffect(() => { load(); }, [load]);

  // 监听节点执行事件（实时变色）
  useEffect(() => {
    const unsub = window.aibox.onWfNodeEvent((e: WfNodeEvent) => {
      if (selected && e.workflowId === selected.id) {
        setRunStatuses((prev) => new Map(prev).set(e.nodeId, e.status));
        setNodes((nds) => nds.map((n) => n.id === e.nodeId ? { ...n, data: { ...n.data, runStatus: e.status } } : n));
      }
    });
    return unsub;
  }, [selected, setNodes]);

  // 选中工作流 → 加载画布
  const openWorkflow = (wf: WorkflowDef) => {
    setSelected(wf);
    setSelectedNode(null);
    setRunStatuses(new Map());
    const rfNodes: Node[] = wf.nodes.map((n) => ({
      id: n.id, type: n.type, position: n.position,
      data: { label: n.label, config: n.config, runStatus: 'pending' }
    }));
    const rfEdges: Edge[] = wf.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, animated: true }));
    setNodes(rfNodes);
    setEdges(rfEdges);
  };

  // 新建工作流
  const createNew = async () => {
    const wf = await window.aibox.createWorkflow({ name: `工作流 ${workflows.length + 1}`, description: '', nodes: [], edges: [] });
    setWorkflows((prev) => [wf, ...prev]);
    openWorkflow(wf);
  };

  // 保存当前画布到后端
  const save = async () => {
    if (!selected) return;
    const wfNodes: WfNode[] = nodes.map((n) => ({
      id: n.id, type: (n.type ?? 'ai') as WfNodeType, label: (n.data as { label: string }).label ?? '',
      position: n.position, config: (n.data as { config: WfNodeConfig }).config ?? {}
    }));
    const wfEdges: WfEdge[] = edges.map((e) => ({ id: e.id, source: e.source, target: e.target }));
    await window.aibox.updateWorkflow(selected.id, { nodes: wfNodes, edges: wfEdges });
    load();
  };

  // 连线
  const onConnect = useCallback((conn: Connection) => {
    setEdges((eds) => addEdge({ ...conn, animated: true, id: `e-${Date.now()}` }, eds));
  }, [setEdges]);

  // 从面板拖入创建节点
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('wfNodeType') as WfNodeType;
    if (!type) return;
    const palette = NODE_PALETTE.find((p) => p.type === type);
    const pos = rfRef.current?.screenToFlowPosition({ x: e.clientX, y: e.clientY }) ?? { x: 200, y: 200 };
    const id = `${type}-${++nodeIdCounter}-${Date.now().toString(36)}`;
    const newNode: Node = {
      id, type, position: pos,
      data: { label: palette?.label ?? type, config: {}, runStatus: 'pending' }
    };
    setNodes((nds) => [...nds, newNode]);
  }, [setNodes]);

  const onDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }, []);

  // 节点点击 → 打开配置面板
  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => { setSelectedNode(node); }, []);

  // 配置面板修改
  const onNodeConfigChange = (label: string, config: WfNodeConfig) => {
    if (!selectedNode) return;
    setNodes((nds) => nds.map((n) => n.id === selectedNode.id ? { ...n, data: { ...n.data, label, config } } : n));
    setSelectedNode({ ...selectedNode, data: { ...selectedNode.data, label, config } });
  };

  // 运行
  const run = async () => {
    if (!selected) return;
    await save();
    // 执行前校验
    const wfNodes: WfNode[] = nodes.map((n) => ({
      id: n.id, type: (n.type ?? 'ai') as WfNodeType, label: (n.data as { label: string }).label ?? '',
      position: n.position, config: (n.data as { config: WfNodeConfig }).config ?? {}
    }));
    const wfEdges: WfEdge[] = edges.map((e) => ({ id: e.id, source: e.source, target: e.target }));
    const v = await window.aibox.validateWorkflow({ nodes: wfNodes, edges: wfEdges });
    setValidation(v);
    if (!v.valid) return;
    setRunStatuses(new Map());
    setNodes((nds) => nds.map((n) => ({ ...n, data: { ...n.data, runStatus: 'pending' } })));
    await window.aibox.triggerWorkflow(selected.id);
  };

  // 发布为 Skill
  const publish = async () => {
    if (!selected) return;
    const r = await window.aibox.publishWorkflowAsSkill(selected.id);
    if (r.ok) load();
  };

  // 删除
  const remove = async () => {
    if (!selected) return;
    await window.aibox.removeWorkflow(selected.id);
    setSelected(null);
    setNodes([]);
    setEdges([]);
    load();
  };

  // 导出工作流
  const exportWf = async () => {
    if (!selected) return;
    const json = await window.aibox.exportWorkflow(selected.id);
    if (!json) return;
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selected.name.replace(/[^\w\u4e00-\u9fa5]/g, '_')}.workflow.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 导入工作流
  const importWf = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      const r = await window.aibox.importWorkflow(text);
      setImportMsg(r.message);
      setTimeout(() => setImportMsg(''), 4000);
      if (r.ok) load();
    };
    input.click();
  };

  // 查看执行历史
  const openHistory = async () => {
    if (!selected) return;
    const runs = await window.aibox.listWorkflowRuns(selected.id);
    setHistory(runs);
    setShowHistory(true);
  };

  const selectedNodeData = selectedNode?.data as { label: string; config: WfNodeConfig } | undefined;

  return (
    <>
      <div className="page-head">
        <h2>工作流</h2>
        <span className="desc">{workflows.length} 个工作流 · 可视化编排 AI/CLI/Python/HTTP/Coze/Dify/条件/循环/延时/子流程 节点</span>
        <div className="right">
          <button className="btn small" onClick={() => importWf()}>导入</button>
          <button className="btn small" onClick={() => setShowPlatformMgr(true)}><IconSettings size={13} />平台管理</button>
          <button className="btn small primary" onClick={() => void createNew()}><IconPlus size={13} />新建工作流</button>
        </div>
      </div>
      {importMsg && <div style={{ fontSize: 12.5, marginBottom: 10, color: importMsg.includes('已导入') ? 'var(--success)' : 'var(--danger)' }}>{importMsg}</div>}

      {/* 平台凭据管理弹窗 */}
      {showPlatformMgr && <PlatformManager platforms={platforms} onClose={() => setShowPlatformMgr(false)} onChanged={load} />}

      <div style={{ display: 'grid', gridTemplateColumns: selected ? '220px 1fr' + (selectedNode ? ' 280px' : '') : '220px 1fr', gap: 12, height: 'calc(100vh - 170px)' }}>
        {/* 左侧：工作流列表 */}
        <div className="card" style={{ overflowY: 'auto', padding: 8 }}>
          {workflows.map((wf) => (
            <button key={wf.id} onClick={() => openWorkflow(wf)} style={{
              display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', marginBottom: 4,
              borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12.5,
              background: selected?.id === wf.id ? 'var(--accent-soft)' : 'transparent', color: 'var(--text-1)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <IconFlow size={14} />
                <span style={{ fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{wf.name}</span>
                {wf.publishedAsSkill && <span style={{ fontSize: 9, color: 'var(--success)', border: '1px solid var(--success)', borderRadius: 3, padding: '0 3px' }}>Skill</span>}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 3 }}>
                {wf.nodes.length} 节点 · <span style={{ color: wf.status === 'running' ? 'var(--accent)' : wf.status === 'failed' ? 'var(--danger)' : 'var(--text-3)' }}>{wf.status}</span>
              </div>
            </button>
          ))}
          {workflows.length === 0 && <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>暂无工作流</div>}
        </div>

        {/* 中间：React Flow 画布 */}
        {selected ? (
          <div className="card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {/* 工具栏 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: '1px solid var(--border)', flexShrink: 0, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 650, fontSize: 13, flex: 1 }}>{selected.name}</span>
              {/* 节点面板（拖拽源） */}
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {NODE_PALETTE.map((p) => (
                  <div key={p.type} draggable onDragStart={(e) => e.dataTransfer.setData('wfNodeType', p.type)}
                    title={p.label} style={{
                      width: 28, height: 28, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: 'var(--input-bg)', border: `1px solid ${p.color}`, cursor: 'grab', fontSize: 13
                    }}>{p.icon}</div>
                ))}
              </div>
              <button className="btn small" onClick={() => void save()}>保存</button>
              <button className="btn small primary" onClick={() => void run()}><IconPlay size={12} />运行</button>
              <button className="btn small" onClick={() => void openHistory()}>历史</button>
              <button className="btn small" onClick={() => setShowVariables(true)}>变量</button>
              <button className="btn small" onClick={() => void exportWf()}>导出</button>
              <button className="btn small" onClick={() => void publish()}>发布 Skill</button>
              <button className="btn small danger" onClick={() => void remove()}>删除</button>
            </div>
            {/* 校验结果 */}
            {validation && !validation.valid && (
              <div style={{ padding: '8px 14px', background: 'var(--danger-soft, rgba(239,68,68,.1))', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--danger)' }}>
                {validation.errors.map((e, i) => <div key={i}>✖ {e}</div>)}
              </div>
            )}
            {validation && validation.valid && validation.warnings.length > 0 && (
              <div style={{ padding: '8px 14px', background: 'var(--warning-soft)', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--warning)' }}>
                {validation.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
              </div>
            )}
            {/* 画布 */}
            <div ref={wrapRef} style={{ flex: 1 }} onDrop={onDrop} onDragOver={onDragOver}>
              <ReactFlow
                nodes={nodes} edges={edges} nodeTypes={wfNodeTypes}
                onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
                onConnect={onConnect} onNodeClick={onNodeClick}
                onInit={(inst) => { rfRef.current = inst; }}
                fitView deleteKeyCode="Delete"
                style={{ background: 'var(--bg-1)' }}
              >
                <Background gap={16} size={1} />
                <Controls />
                <MiniMap style={{ background: 'var(--card-bg)' }} />
              </ReactFlow>
            </div>
          </div>
        ) : (
          <div className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)' }}>
            选择或新建一个工作流开始编辑
          </div>
        )}

        {/* 右侧：节点配置面板 */}
        {selectedNode && selectedNodeData && (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <WfNodePanel
              nodeType={(selectedNode.type ?? 'ai') as WfNodeType}
              label={selectedNodeData.label ?? ''}
              config={selectedNodeData.config ?? {}}
              platforms={platforms}
              workflows={workflows}
              onChange={onNodeConfigChange}
              onClose={() => setSelectedNode(null)}
            />
          </div>
        )}
      </div>

      {/* 执行历史弹窗 */}
      {showHistory && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setShowHistory(false)}>
          <div className="card" style={{ width: 560, maxHeight: '70vh', overflowY: 'auto', padding: 20 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>执行历史 · {selected?.name}</h3>
              <button className="btn small" onClick={() => setShowHistory(false)}>关闭</button>
            </div>
            {history.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: 12.5, padding: 20, textAlign: 'center' }}>暂无执行记录</div>}
            {history.map((r) => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 8, background: 'var(--input-bg)', marginBottom: 6, fontSize: 12.5 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: r.status === 'completed' ? 'var(--success)' : r.status === 'failed' ? 'var(--danger)' : 'var(--accent)', flexShrink: 0 }} />
                <span style={{ fontWeight: 600, color: r.status === 'completed' ? 'var(--success)' : r.status === 'failed' ? 'var(--danger)' : 'var(--accent)' }}>
                  {r.status === 'completed' ? '成功' : r.status === 'failed' ? '失败' : '运行中'}
                </span>
                <span style={{ color: 'var(--text-2)', flex: 1 }}>{new Date(r.startedAt).toLocaleString('zh-CN', { hour12: false })}</span>
                {r.durationMs != null && <span style={{ color: 'var(--text-3)' }}>{(r.durationMs / 1000).toFixed(1)}s</span>}
                {r.error && <span style={{ color: 'var(--danger)', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.error}>{r.error}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 全局变量管理弹窗 */}
      {showVariables && selected && (
        <VariablesManager
          workflowId={selected.id}
          variables={selected.variables ?? []}
          onClose={() => setShowVariables(false)}
          onSaved={(vars) => { setSelected({ ...selected, variables: vars }); load(); }}
        />
      )}
    </>
  );
}

/** 平台凭据管理弹窗：添加/编辑/测试/删除 Coze/Dify 平台 */
function PlatformManager({ platforms, onClose, onChanged }: { platforms: WfPlatformConfig[]; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [editId, setEditId] = useState<string | undefined>();
  const [testResult, setTestResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)',
    background: 'var(--input-bg)', color: 'var(--text-1)', fontSize: 12.5, outline: 'none'
  };

  const savePlatform = async () => {
    if (!name || !baseUrl) return;
    setBusy(true);
    await window.aibox.saveWfPlatform({ id: editId, name, baseUrl, token: token || undefined });
    setBusy(false);
    setName(''); setBaseUrl(''); setToken(''); setEditId(undefined);
    onChanged();
  };

  const testPlatform = async (id: string) => {
    setBusy(true);
    const r = await window.aibox.testWfPlatform(id);
    setTestResult(r.message);
    setBusy(false);
  };

  const removePlatform = async (id: string) => {
    await window.aibox.removeWfPlatform(id);
    onChanged();
  };

  const startEdit = (p: WfPlatformConfig) => {
    setEditId(p.id); setName(p.name); setBaseUrl(p.baseUrl); setToken('');
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div className="card" style={{ width: 480, maxHeight: '80vh', overflowY: 'auto', padding: 20 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>外部工作流平台管理</h3>
          <button className="btn small" onClick={onClose}>关闭</button>
        </div>

        {/* 已配置平台列表 */}
        <div style={{ marginBottom: 16 }}>
          {platforms.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: 12, marginBottom: 8 }}>未配置任何平台</div>}
          {platforms.map((p) => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, background: 'var(--input-bg)', marginBottom: 6, fontSize: 12 }}>
              <span style={{ fontWeight: 600, flex: 1 }}>{p.name}</span>
              <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{p.baseUrl}</span>
              <span style={{ fontSize: 10, color: p.hasToken ? 'var(--success)' : 'var(--danger)' }}>{p.hasToken ? '已配置' : '未配置'}</span>
              <button className="btn small" style={{ padding: '2px 8px', fontSize: 10.5 }} onClick={() => void testPlatform(p.id)}>测试</button>
              <button className="btn small" style={{ padding: '2px 8px', fontSize: 10.5 }} onClick={() => startEdit(p)}>编辑</button>
              <button className="btn small danger" style={{ padding: '2px 8px', fontSize: 10.5 }} onClick={() => void removePlatform(p.id)}>删除</button>
            </div>
          ))}
          {testResult && <div style={{ fontSize: 11.5, color: 'var(--accent)', marginTop: 4 }}>{testResult}</div>}
        </div>

        {/* 添加/编辑表单 */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 10 }}>{editId ? '编辑平台' : '添加平台'}</div>
          <label style={{ fontSize: 11, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>名称</label>
          <input style={{ ...inputStyle, marginBottom: 10 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Coze 国内 / Dify 自部署" />
          <label style={{ fontSize: 11, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>API 基址</label>
          <input style={{ ...inputStyle, marginBottom: 10 }} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.coze.cn 或 https://api.dify.ai" />
          <label style={{ fontSize: 11, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>Token / API Key（安全存储，不回显）</label>
          <input style={{ ...inputStyle, marginBottom: 12 }} type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={editId ? '留空则不修改' : '输入 Token'} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn small primary" disabled={busy || !name || !baseUrl} onClick={() => void savePlatform()}>保存</button>
            {editId && <button className="btn small" onClick={() => { setEditId(undefined); setName(''); setBaseUrl(''); setToken(''); }}>取消编辑</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 全局变量管理弹窗：添加/编辑/删除工作流级变量 */
function VariablesManager({ workflowId, variables, onClose, onSaved }: {
  workflowId: string; variables: WfVariable[]; onClose: () => void; onSaved: (vars: WfVariable[]) => void;
}) {
  const [vars, setVars] = useState<WfVariable[]>(variables);
  const [name, setName] = useState('');
  const [defaultValue, setDefaultValue] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)',
    background: 'var(--input-bg)', color: 'var(--text-1)', fontSize: 12.5, outline: 'none'
  };

  const addVar = () => {
    if (!name.trim()) return;
    setVars((prev) => [...prev, { name: name.trim(), defaultValue, description: desc.trim() || undefined }]);
    setName(''); setDefaultValue(''); setDesc('');
  };

  const removeVar = (idx: number) => {
    setVars((prev) => prev.filter((_, i) => i !== idx));
  };

  const save = async () => {
    setBusy(true);
    await window.aibox.saveWfVariables(workflowId, vars);
    setBusy(false);
    onSaved(vars);
    onClose();
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div className="card" style={{ width: 500, maxHeight: '70vh', overflowY: 'auto', padding: 20 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>全局变量管理</h3>
          <button className="btn small" onClick={onClose}>关闭</button>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 12, lineHeight: 1.6 }}>
          全局变量可在工作流触发时作为输入参数传入，节点中通过 {'{{变量名}}'} 引用。
        </div>

        {/* 已有变量列表 */}
        {vars.map((v, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, background: 'var(--input-bg)', marginBottom: 6, fontSize: 12.5 }}>
            <span style={{ fontWeight: 650, color: 'var(--accent)', minWidth: 80 }}>{v.name}</span>
            <span style={{ color: 'var(--text-2)', flex: 1 }}>{v.defaultValue || '(空)'}</span>
            {v.description && <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{v.description}</span>}
            <button className="btn small danger" style={{ padding: '2px 8px', fontSize: 10.5 }} onClick={() => removeVar(i)}>删除</button>
          </div>
        ))}
        {vars.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: 12, marginBottom: 12 }}>未定义变量</div>}

        {/* 添加变量表单 */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 10 }}>添加变量</div>
          <label style={{ fontSize: 11, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>变量名</label>
          <input style={{ ...inputStyle, marginBottom: 10 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如: input_text" />
          <label style={{ fontSize: 11, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>默认值</label>
          <input style={{ ...inputStyle, marginBottom: 10 }} value={defaultValue} onChange={(e) => setDefaultValue(e.target.value)} placeholder="触发时未传入则用此值" />
          <label style={{ fontSize: 11, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>描述（可选）</label>
          <input style={{ ...inputStyle, marginBottom: 12 }} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="变量用途说明" />
          <button className="btn small" onClick={addVar}>添加</button>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存变量'}</button>
        </div>
      </div>
    </div>
  );
}
