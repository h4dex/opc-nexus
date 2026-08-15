import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal } from '../components/common';
import { IconCheck, IconMemory, IconRefresh, IconX } from '../components/icons';
import { toast } from '../components/Toast';
import { useApp } from '../store';
import type { MemoryProposalRecord, MemoryProposalStatus } from '../../../shared/types';

type ProposalFilter = 'pending' | 'all';
type Decision = { proposal: MemoryProposalRecord; action: 'accept' | 'reject' };

const STATUS_LABEL: Record<MemoryProposalStatus, string> = {
  pending: '待审核',
  accepted: '已接受',
  rejected: '已拒绝'
};

const SCOPE_LABEL: Record<MemoryProposalRecord['scopeType'], string> = {
  principal: '用户',
  channel: '渠道',
  conversation: '会话',
  agent: '员工',
  project: '项目'
};

export function MemoryProposals() {
  const { snapshot } = useApp();
  const [filter, setFilter] = useState<ProposalFilter>('pending');
  const [items, setItems] = useState<MemoryProposalRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const agents = useMemo(() => new Map<string, string>(
    snapshot?.agentCards.map((card) => [card.agent.id, card.agent.name]) ?? []
  ), [snapshot?.agentCards]);
  const projects = useMemo(() => new Map<string, string>(
    snapshot?.projects.map((project) => [project.id, project.name]) ?? []
  ), [snapshot?.projects]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await window.aibox.listMemoryProposals({ status: filter, limit: 200 }));
    } catch (error) {
      toast.err(error instanceof Error ? error.message : '记忆提案加载失败');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { void load(); }, [load]);

  const decide = async () => {
    if (!decision) return;
    setSaving(true);
    try {
      const input = { proposalId: decision.proposal.id, reason: reason.trim() || undefined };
      if (decision.action === 'accept') await window.aibox.acceptMemoryProposal(input);
      else await window.aibox.rejectMemoryProposal(input);
      toast.ok(decision.action === 'accept' ? '记忆已写入' : '提案已拒绝');
      setDecision(null);
      setReason('');
      await load();
    } catch (error) {
      toast.err(error instanceof Error ? error.message : '记忆提案处理失败');
    } finally {
      setSaving(false);
    }
  };

  const targetLabel = (item: MemoryProposalRecord): string => {
    if (item.scopeType === 'agent' && item.agentId) return agents.get(item.agentId) ?? item.agentId;
    if (item.scopeType === 'project' && item.projectId) return projects.get(item.projectId) ?? item.projectId;
    if (item.scopeType === 'principal') return item.principalId ?? item.scopeId;
    if (item.scopeType === 'channel') return item.channelId ?? item.scopeId;
    return item.conversationId ?? item.scopeId;
  };

  return <div className="memory-proposal-review">
    <div className="memory-proposal-toolbar">
      <div className="automation-segmented" role="tablist" aria-label="记忆提案状态">
        <button type="button" role="tab" aria-selected={filter === 'pending'} className={filter === 'pending' ? 'active' : ''} onClick={() => setFilter('pending')}>待审核</button>
        <button type="button" role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部记录</button>
      </div>
      <span>{items.length} 条</span>
      <button className="icon-btn" type="button" title="刷新" aria-label="刷新记忆提案" disabled={loading} onClick={() => void load()}><IconRefresh size={14} /></button>
    </div>

    <div className="memory-proposal-table">
      <table className="table">
        <thead><tr><th>记忆内容</th><th>范围</th><th>提议者</th><th>时间</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          {items.length === 0 && <tr><td colSpan={6}><div className="automation-empty"><IconMemory size={24} /><strong>{loading ? '正在加载...' : '暂无记忆提案'}</strong></div></td></tr>}
          {items.map((item) => <tr key={item.id}>
            <td><strong>{item.content}</strong><small>{item.kind} · 重要度 {item.importance}</small></td>
            <td><strong>{SCOPE_LABEL[item.scopeType]}</strong><small title={item.scopeId}>{targetLabel(item)}</small></td>
            <td><strong>{item.proposedBy}</strong><small>{item.requestId}</small></td>
            <td><time>{new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })}</time></td>
            <td><span className={`memory-proposal-status ${item.status}`}>{STATUS_LABEL[item.status]}</span></td>
            <td>{item.status === 'pending' ? <div className="memory-proposal-actions">
              <button className="icon-btn" type="button" title="接受" aria-label="接受记忆提案" onClick={() => { setReason(''); setDecision({ proposal: item, action: 'accept' }); }}><IconCheck size={14} /></button>
              <button className="icon-btn danger" type="button" title="拒绝" aria-label="拒绝记忆提案" onClick={() => { setReason(''); setDecision({ proposal: item, action: 'reject' }); }}><IconX size={14} /></button>
            </div> : <small>{item.decidedAt ? new Date(item.decidedAt).toLocaleString('zh-CN', { hour12: false }) : '--'}</small>}</td>
          </tr>)}
        </tbody>
      </table>
    </div>

    {decision && <Modal
      title={decision.action === 'accept' ? '接受记忆提案' : '拒绝记忆提案'}
      width={560}
      onClose={() => !saving && setDecision(null)}
      footer={<><button className="btn" type="button" disabled={saving} onClick={() => setDecision(null)}>取消</button><button className={`btn ${decision.action === 'accept' ? 'primary' : 'danger'}`} type="button" disabled={saving} onClick={() => void decide()}>{decision.action === 'accept' ? '接受并写入' : '确认拒绝'}</button></>}
    >
      <div className="memory-proposal-decision">
        <blockquote>{decision.proposal.content}</blockquote>
        <div className="field"><label>审核备注</label><textarea rows={3} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="可选" /></div>
      </div>
    </Modal>}
  </div>;
}
