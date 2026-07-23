/** 工作流节点配置面板：根据节点类型渲染不同表单字段 */
import { useState } from 'react';
import type { WfNodeConfig, WfNodeType, WfPlatformConfig, WorkflowDef } from '@shared/types';

interface Props {
  nodeType: WfNodeType;
  label: string;
  config: WfNodeConfig;
  platforms: WfPlatformConfig[];
  workflows?: WorkflowDef[];
  onChange: (label: string, config: WfNodeConfig) => void;
  onClose: () => void;
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--input-bg)', color: 'var(--text-1)', fontSize: 12.5, outline: 'none'
};
const labelStyle: React.CSSProperties = { fontSize: 11.5, color: 'var(--text-2)', marginBottom: 4, display: 'block', fontWeight: 600 };

function KVEditor({ value, onChange }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const entries = Object.entries(value);
  const [k, setK] = useState('');
  const [v, setV] = useState('');
  return (
    <div>
      {entries.map(([key, val]) => (
        <div key={key} style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--accent)', minWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{key}</span>
          <span style={{ fontSize: 11, color: 'var(--text-3)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{val}</span>
          <button className="btn small" style={{ padding: '2px 6px', fontSize: 10 }} onClick={() => { const n = { ...value }; delete n[key]; onChange(n); }}>×</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <input style={{ ...inputStyle, flex: 1 }} placeholder="key" value={k} onChange={(e) => setK(e.target.value)} />
        <input style={{ ...inputStyle, flex: 1 }} placeholder="value (支持 {{nodeId}})" value={v} onChange={(e) => setV(e.target.value)} />
        <button className="btn small" style={{ padding: '4px 8px' }} onClick={() => { if (k) { onChange({ ...value, [k]: v }); setK(''); setV(''); } }}>+</button>
      </div>
    </div>
  );
}

export function WfNodePanel({ nodeType, label, config, platforms, workflows, onChange, onClose }: Props) {
  const set = (patch: Partial<WfNodeConfig>) => onChange(label, { ...config, ...patch });
  const setLabel = (l: string) => onChange(l, config);

  if (nodeType === 'start' || nodeType === 'end') {
    return (
      <div style={{ padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <span style={{ fontWeight: 650, fontSize: 13 }}>{nodeType === 'start' ? '开始节点' : '结束节点'}</span>
          <button className="btn small" onClick={onClose}>关闭</button>
        </div>
        <label style={labelStyle}>名称</label>
        <input style={inputStyle} value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
    );
  }

  return (
    <div style={{ padding: 16, overflowY: 'auto', maxHeight: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontWeight: 650, fontSize: 13 }}>节点配置</span>
        <button className="btn small" onClick={onClose}>关闭</button>
      </div>

      <label style={labelStyle}>名称</label>
      <input style={{ ...inputStyle, marginBottom: 12 }} value={label} onChange={(e) => setLabel(e.target.value)} />

      {nodeType === 'ai' && (
        <>
          <label style={labelStyle}>Prompt（支持 {'{{nodeId}}'} 变量）</label>
          <textarea style={{ ...inputStyle, minHeight: 80, resize: 'vertical', marginBottom: 12 }} value={config.prompt ?? ''} onChange={(e) => set({ prompt: e.target.value })} />
          <label style={labelStyle}>模型（空则用默认供应商）</label>
          <input style={{ ...inputStyle, marginBottom: 12 }} value={config.model ?? ''} onChange={(e) => set({ model: e.target.value })} placeholder="deepseek-chat" />
          <label style={labelStyle}>Temperature: {config.temperature ?? 0.7}</label>
          <input type="range" min="0" max="2" step="0.1" value={config.temperature ?? 0.7} onChange={(e) => set({ temperature: Number(e.target.value) })} style={{ width: '100%', marginBottom: 12 }} />
        </>
      )}

      {nodeType === 'cli' && (
        <>
          <label style={labelStyle}>命令</label>
          <input style={{ ...inputStyle, marginBottom: 12 }} value={config.command ?? ''} onChange={(e) => set({ command: e.target.value })} placeholder="node script.js" />
          <label style={labelStyle}>参数（逗号分隔）</label>
          <input style={{ ...inputStyle, marginBottom: 12 }} value={(config.args ?? []).join(', ')} onChange={(e) => set({ args: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
          <label style={labelStyle}>工作目录</label>
          <input style={{ ...inputStyle, marginBottom: 12 }} value={config.cwd ?? ''} onChange={(e) => set({ cwd: e.target.value })} placeholder="可选" />
        </>
      )}

      {nodeType === 'python' && (
        <>
          <label style={labelStyle}>脚本路径（与内联脚本二选一）</label>
          <input style={{ ...inputStyle, marginBottom: 12 }} value={config.scriptPath ?? ''} onChange={(e) => set({ scriptPath: e.target.value })} placeholder="main.py" />
          <label style={labelStyle}>内联脚本</label>
          <textarea style={{ ...inputStyle, minHeight: 80, resize: 'vertical', marginBottom: 12, fontFamily: 'monospace' }} value={config.script ?? ''} onChange={(e) => set({ script: e.target.value })} placeholder="print('hello')" />
          <label style={labelStyle}>参数（逗号分隔）</label>
          <input style={{ ...inputStyle, marginBottom: 12 }} value={(config.pythonArgs ?? []).join(', ')} onChange={(e) => set({ pythonArgs: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
        </>
      )}

      {nodeType === 'http' && (
        <>
          <label style={labelStyle}>Method</label>
          <select style={{ ...inputStyle, marginBottom: 12 }} value={config.method ?? 'GET'} onChange={(e) => set({ method: e.target.value as WfNodeConfig['method'] })}>
            <option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option>
          </select>
          <label style={labelStyle}>URL（支持变量）</label>
          <input style={{ ...inputStyle, marginBottom: 12 }} value={config.url ?? ''} onChange={(e) => set({ url: e.target.value })} placeholder="https://api.example.com/data" />
          <label style={labelStyle}>Body（支持变量）</label>
          <textarea style={{ ...inputStyle, minHeight: 60, resize: 'vertical', marginBottom: 12, fontFamily: 'monospace' }} value={config.body ?? ''} onChange={(e) => set({ body: e.target.value })} placeholder='{"key": "{{nodeId}}"}' />
        </>
      )}

      {nodeType === 'coze' && (
        <>
          <label style={labelStyle}>平台凭据</label>
          <select style={{ ...inputStyle, marginBottom: 12 }} value={config.platformRef ?? ''} onChange={(e) => set({ platformRef: e.target.value })}>
            <option value="">选择平台…</option>
            {platforms.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.baseUrl})</option>)}
          </select>
          <label style={labelStyle}>Coze 工作流 ID</label>
          <input style={{ ...inputStyle, marginBottom: 12 }} value={config.cozeWorkflowId ?? ''} onChange={(e) => set({ cozeWorkflowId: e.target.value })} />
          <label style={labelStyle}>输入参数</label>
          <KVEditor value={config.cozeInputs ?? {}} onChange={(v) => set({ cozeInputs: v })} />
        </>
      )}

      {nodeType === 'dify' && (
        <>
          <label style={labelStyle}>平台凭据</label>
          <select style={{ ...inputStyle, marginBottom: 12 }} value={config.platformRef ?? ''} onChange={(e) => set({ platformRef: e.target.value })}>
            <option value="">选择平台…</option>
            {platforms.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.baseUrl})</option>)}
          </select>
          <label style={labelStyle}>Dify 工作流 ID（可选）</label>
          <input style={{ ...inputStyle, marginBottom: 12 }} value={config.difyWorkflowId ?? ''} onChange={(e) => set({ difyWorkflowId: e.target.value })} placeholder="空则用 API Key 绑定的默认工作流" />
          <label style={labelStyle}>输入参数</label>
          <KVEditor value={config.difyInputs ?? {}} onChange={(v) => set({ difyInputs: v })} />
        </>
      )}

      {nodeType === 'condition' && (
        <>
          <label style={labelStyle}>条件表达式（支持 {'{{nodeId}}'} 变量）</label>
          <input style={{ ...inputStyle, marginBottom: 8 }} value={config.condition ?? ''} onChange={(e) => set({ condition: e.target.value })} placeholder="例如: {{node1}} != '' 或 {{node2}} contains 'ok'" />
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 12, lineHeight: 1.6 }}>
            支持: != / == / contains / 非空即真。输出 'true' 或 'false'，下游节点根据输出值选择分支。
          </div>
          <label style={labelStyle}>True 分支目标节点 ID（可选）</label>
          <input style={{ ...inputStyle, marginBottom: 12 }} value={config.trueTarget ?? ''} onChange={(e) => set({ trueTarget: e.target.value })} placeholder="留空则用连线" />
          <label style={labelStyle}>False 分支目标节点 ID（可选）</label>
          <input style={{ ...inputStyle, marginBottom: 12 }} value={config.falseTarget ?? ''} onChange={(e) => set({ falseTarget: e.target.value })} placeholder="留空则用连线" />
        </>
      )}

      {nodeType === 'loop' && (
        <>
          <label style={labelStyle}>循环变量名</label>
          <input style={{ ...inputStyle, marginBottom: 12 }} value={config.loopVariable ?? ''} onChange={(e) => set({ loopVariable: e.target.value })} placeholder="item" />
          <label style={labelStyle}>循环项（逗号分隔或 {'{{nodeId}}'} 引用）</label>
          <input style={{ ...inputStyle, marginBottom: 12 }} value={config.loopItems ?? ''} onChange={(e) => set({ loopItems: e.target.value })} placeholder="a, b, c 或 {{node1}}" />
          <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.6 }}>
            每次循环将当前项存入 context[变量名]，索引存入 context[变量名_index]。输出为 JSON 数组。
          </div>
        </>
      )}

      {nodeType === 'delay' && (
        <>
          <label style={labelStyle}>延时秒数</label>
          <input style={{ ...inputStyle, marginBottom: 12 }} type="number" min={0} max={3600} value={config.delaySeconds ?? 1} onChange={(e) => set({ delaySeconds: Number(e.target.value) })} />
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>工作流将在此节点暂停指定时间后继续执行下游节点。</div>
        </>
      )}

      {nodeType === 'subflow' && (
        <>
          <label style={labelStyle}>引用工作流</label>
          <select style={{ ...inputStyle, marginBottom: 12 }} value={config.subflowId ?? ''} onChange={(e) => set({ subflowId: e.target.value })}>
            <option value="">选择工作流…</option>
            {(workflows ?? []).map((wf) => <option key={wf.id} value={wf.id}>{wf.name}</option>)}
          </select>
          <label style={labelStyle}>传入参数</label>
          <KVEditor value={config.subflowInputs ?? {}} onChange={(v) => set({ subflowInputs: v })} />
        </>
      )}

      <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <label style={labelStyle}>输出变量名（默认 = 节点 ID）</label>
        <input style={inputStyle} value={config.outputVar ?? ''} onChange={(e) => set({ outputVar: e.target.value })} placeholder="留空则用节点 ID" />
        <label style={{ ...labelStyle, marginTop: 10 }}>超时（秒）</label>
        <input style={inputStyle} type="number" value={config.timeout ?? 120} onChange={(e) => set({ timeout: Number(e.target.value) })} />
      </div>

      {/* 错误处理（重试/降级） */}
      {nodeType !== 'condition' && nodeType !== 'delay' && (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <label style={{ ...labelStyle, color: 'var(--warning)' }}>错误处理</label>
          <label style={labelStyle}>失败重试次数（0 = 不重试）</label>
          <input style={{ ...inputStyle, marginBottom: 10 }} type="number" min={0} max={10} value={config.retryCount ?? 0} onChange={(e) => set({ retryCount: Number(e.target.value) })} />
          {(config.retryCount ?? 0) > 0 && (
            <>
              <label style={labelStyle}>重试间隔（秒）</label>
              <input style={{ ...inputStyle, marginBottom: 10 }} type="number" min={1} max={60} value={config.retryDelay ?? 2} onChange={(e) => set({ retryDelay: Number(e.target.value) })} />
            </>
          )}
          <label style={labelStyle}>失败降级目标节点 ID（可选）</label>
          <input style={inputStyle} value={config.fallbackNodeId ?? ''} onChange={(e) => set({ fallbackNodeId: e.target.value })} placeholder="留空则工作流失败" />
        </div>
      )}
    </div>
  );
}
