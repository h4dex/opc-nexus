/** 工作流自定义节点组件（React Flow）：6 种节点类型 + start/end */
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { WfNodeConfig } from '@shared/types';

type NodeData = { label: string; config: WfNodeConfig; runStatus?: string };

const STATUS_COLOR: Record<string, string> = {
  pending: 'var(--text-3)',
  running: 'var(--accent)',
  completed: 'var(--success)',
  failed: 'var(--danger)'
};

function NodeShell({ color, icon, title, subtitle, data, hasInput = true, hasOutput = true }: {
  color: string; icon: string; title: string; subtitle?: string;
  data: NodeData; hasInput?: boolean; hasOutput?: boolean;
}) {
  const status = data.runStatus ?? 'pending';
  return (
    <div style={{
      minWidth: 160, padding: '10px 14px', borderRadius: 10,
      border: `2px solid ${status !== 'pending' ? STATUS_COLOR[status] : color}`,
      background: 'var(--card-bg, #1a1e26)', boxShadow: '0 2px 8px rgba(0,0,0,.25)',
      fontSize: 12, position: 'relative'
    }}>
      {hasInput && <Handle type="target" position={Position.Left} style={{ background: color }} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ fontSize: 15 }}>{icon}</span>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <div style={{ fontWeight: 650, color: 'var(--text-1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
          {subtitle && <div style={{ fontSize: 10.5, color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>{subtitle}</div>}
        </div>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLOR[status], flexShrink: 0 }} />
      </div>
      {hasOutput && <Handle type="source" position={Position.Right} style={{ background: color }} />}
    </div>
  );
}

export function AiWfNode({ data }: NodeProps) {
  const d = data as unknown as NodeData;
  return <NodeShell color="#8a5cf6" icon="🤖" title={d.label || 'AI 调用'} subtitle={d.config?.model || d.config?.prompt?.slice(0, 30)} data={d} />;
}

export function CliWfNode({ data }: NodeProps) {
  const d = data as unknown as NodeData;
  return <NodeShell color="#3aa7ff" icon="⌨️" title={d.label || 'CLI 命令'} subtitle={d.config?.command?.slice(0, 30)} data={d} />;
}

export function PythonWfNode({ data }: NodeProps) {
  const d = data as unknown as NodeData;
  return <NodeShell color="#22c1a3" icon="🐍" title={d.label || 'Python'} subtitle={d.config?.scriptPath || d.config?.script?.slice(0, 25)} data={d} />;
}

export function HttpWfNode({ data }: NodeProps) {
  const d = data as unknown as NodeData;
  return <NodeShell color="#f59e0b" icon="🌐" title={d.label || 'HTTP'} subtitle={`${d.config?.method ?? 'GET'} ${d.config?.url?.slice(0, 25) ?? ''}`} data={d} />;
}

export function CozeWfNode({ data }: NodeProps) {
  const d = data as unknown as NodeData;
  return <NodeShell color="#00b4d8" icon="⚡" title={d.label || 'Coze 工作流'} subtitle={d.config?.cozeWorkflowId ? `ID: ${d.config.cozeWorkflowId.slice(0, 20)}` : '未配置'} data={d} />;
}

export function DifyWfNode({ data }: NodeProps) {
  const d = data as unknown as NodeData;
  return <NodeShell color="#7c5cfc" icon="🔮" title={d.label || 'Dify 工作流'} subtitle={d.config?.difyWorkflowId ? `ID: ${d.config.difyWorkflowId.slice(0, 20)}` : '默认工作流'} data={d} />;
}

export function ConditionWfNode({ data }: NodeProps) {
  const d = data as unknown as NodeData;
  return (
    <div style={{
      minWidth: 160, padding: '10px 14px', borderRadius: 10,
      border: `2px solid ${(d.runStatus && d.runStatus !== 'pending') ? STATUS_COLOR[d.runStatus] : '#f97316'}`,
      background: 'var(--card-bg, #1a1e26)', boxShadow: '0 2px 8px rgba(0,0,0,.25)',
      fontSize: 12, position: 'relative', transform: 'rotate(0deg)'
    }}>
      <Handle type="target" position={Position.Left} style={{ background: '#f97316' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ fontSize: 15 }}>❓</span>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <div style={{ fontWeight: 650, color: 'var(--text-1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.label || '条件分支'}</div>
          <div style={{ fontSize: 10.5, color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>
            {d.config?.condition?.slice(0, 30) || '未配置条件'}
          </div>
        </div>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLOR[d.runStatus ?? 'pending'], flexShrink: 0 }} />
      </div>
      <Handle type="source" position={Position.Right} id="true" style={{ background: 'var(--success)', top: '35%' }} />
      <Handle type="source" position={Position.Right} id="false" style={{ background: 'var(--danger)', top: '65%' }} />
    </div>
  );
}

export function LoopWfNode({ data }: NodeProps) {
  const d = data as unknown as NodeData;
  return <NodeShell color="#06b6d4" icon="🔄" title={d.label || '循环'} subtitle={d.config?.loopItems ? `遍历: ${d.config.loopItems.slice(0, 25)}` : '未配置循环项'} data={d} />;
}

export function DelayWfNode({ data }: NodeProps) {
  const d = data as unknown as NodeData;
  return <NodeShell color="#a78bfa" icon="⏳" title={d.label || '延时'} subtitle={d.config?.delaySeconds ? `等待 ${d.config.delaySeconds} 秒` : '未配置'} data={d} />;
}

export function SubflowWfNode({ data }: NodeProps) {
  const d = data as unknown as NodeData;
  return <NodeShell color="#ec4899" icon="📦" title={d.label || '子工作流'} subtitle={d.config?.subflowId ? `引用: ${d.config.subflowId.slice(0, 20)}` : '未选择工作流'} data={d} />;
}

export function StartWfNode({ data }: NodeProps) {
  const d = data as unknown as NodeData;
  return (
    <div style={{
      width: 56, height: 56, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--success)', color: '#fff', fontWeight: 700, fontSize: 11, border: '3px solid var(--card-bg, #1a1e26)'
    }}>
      {d.label || '开始'}
      <Handle type="source" position={Position.Right} style={{ background: 'var(--success)' }} />
    </div>
  );
}

export function EndWfNode({ data }: NodeProps) {
  const d = data as unknown as NodeData;
  return (
    <div style={{
      width: 56, height: 56, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--danger)', color: '#fff', fontWeight: 700, fontSize: 11, border: '3px solid var(--card-bg, #1a1e26)'
    }}>
      <Handle type="target" position={Position.Left} style={{ background: 'var(--danger)' }} />
      {d.label || '结束'}
    </div>
  );
}

export const wfNodeTypes = {
  ai: AiWfNode,
  cli: CliWfNode,
  python: PythonWfNode,
  http: HttpWfNode,
  coze: CozeWfNode,
  dify: DifyWfNode,
  condition: ConditionWfNode,
  loop: LoopWfNode,
  delay: DelayWfNode,
  subflow: SubflowWfNode,
  start: StartWfNode,
  end: EndWfNode
};
