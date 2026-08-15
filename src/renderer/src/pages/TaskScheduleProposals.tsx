import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal } from '../components/common';
import { IconCheck, IconClock, IconRefresh, IconX } from '../components/icons';
import { toast } from '../components/Toast';
import { useApp } from '../store';
import type { TaskScheduleProposalRecord, TaskScheduleProposalStatus } from '../../../shared/types';

type ProposalFilter = 'pending' | 'all';
type Decision = { proposal: TaskScheduleProposalRecord; action: 'accept' | 'reject' };

const STATUS_LABEL: Record<TaskScheduleProposalStatus, string> = {
  pending: '待审核',
  accepted: '已创建',
  rejected: '已拒绝'
};

export function TaskScheduleProposals() {
  const { snapshot } = useApp();
  const [filter, setFilter] = useState<ProposalFilter>('pending');
  const [items, setItems] = useState<TaskScheduleProposalRecord[]>([]);
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
      setItems(await window.aibox.listTaskScheduleProposals({ status: filter, limit: 200 }));
    } catch (error) {
      toast.err(error instanceof Error ? error.message : '调度提案加载失败');
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
      if (decision.action === 'accept') await window.aibox.acceptTaskScheduleProposal(input);
      else await window.aibox.rejectTaskScheduleProposal(input);
      toast.ok(decision.action === 'accept' ? '自动计划已创建' : '调度提案已拒绝');
      setDecision(null);
      setReason('');
      await load();
    } catch (error) {
      toast.err(error instanceof Error ? error.message : '调度提案处理失败');
    } finally {
      setSaving(false);
    }
  };

  return <div className="memory-proposal-review">
    <div className="memory-proposal-toolbar">
      <div className="automation-segmented" role="tablist" aria-label="调度提案状态">
        <button type="button" role="tab" aria-selected={filter === 'pending'} className={filter === 'pending' ? 'active' : ''} onClick={() => setFilter('pending')}>待审核</button>
        <button type="button" role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部记录</button>
      </div>
      <span>{items.length} 条</span>
      <button className="icon-btn" type="button" title="刷新" aria-label="刷新调度提案" disabled={loading} onClick={() => void load()}><IconRefresh size={14} /></button>
    </div>

    <div className="memory-proposal-table task-schedule-proposal-table">
      <table className="table">
        <thead><tr><th>计划</th><th>执行员工</th><th>周期</th><th>提议者</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          {items.length === 0 && <tr><td colSpan={6}><div className="automation-empty"><IconClock size={24} /><strong>{loading ? '正在加载...' : '暂无调度提案'}</strong></div></td></tr>}
          {items.map((item) => <tr key={item.id}>
            <td><strong>{item.title}</strong><small title={item.content}>{item.content}</small></td>
            <td><strong>{agents.get(item.agentId) ?? item.agentId}</strong><small>{item.projectId ? projects.get(item.projectId) ?? item.projectId : '无归属项目'}</small></td>
            <td><strong>{cronDescription(item)}</strong><small>{new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })}</small></td>
            <td><strong>{item.proposedBy}</strong><small>{item.requestId}</small></td>
            <td><span className={`memory-proposal-status ${item.status}`}>{STATUS_LABEL[item.status]}</span></td>
            <td>{item.status === 'pending' ? <div className="memory-proposal-actions">
              <button className="icon-btn" type="button" title="接受并创建计划" aria-label="接受调度提案" onClick={() => { setReason(''); setDecision({ proposal: item, action: 'accept' }); }}><IconCheck size={14} /></button>
              <button className="icon-btn danger" type="button" title="拒绝" aria-label="拒绝调度提案" onClick={() => { setReason(''); setDecision({ proposal: item, action: 'reject' }); }}><IconX size={14} /></button>
            </div> : <small>{item.scheduleId ?? (item.decidedAt ? new Date(item.decidedAt).toLocaleString('zh-CN', { hour12: false }) : '--')}</small>}</td>
          </tr>)}
        </tbody>
      </table>
    </div>

    {decision && <Modal
      title={decision.action === 'accept' ? '创建自动计划' : '拒绝调度提案'}
      width={580}
      onClose={() => !saving && setDecision(null)}
      footer={<><button className="btn" type="button" disabled={saving} onClick={() => setDecision(null)}>取消</button><button className={`btn ${decision.action === 'accept' ? 'primary' : 'danger'}`} type="button" disabled={saving} onClick={() => void decide()}>{decision.action === 'accept' ? '接受并创建' : '确认拒绝'}</button></>}
    >
      <div className="memory-proposal-decision">
        <div className="task-schedule-proposal-summary"><strong>{decision.proposal.title}</strong><span>{cronDescription(decision.proposal)}</span><small>{agents.get(decision.proposal.agentId) ?? decision.proposal.agentId}</small></div>
        <blockquote>{decision.proposal.content}</blockquote>
        <div className="field"><label>审核备注</label><textarea rows={3} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="可选" /></div>
      </div>
    </Modal>}
  </div>;
}

function cronDescription(proposal: Pick<TaskScheduleProposalRecord, 'cronKind' | 'cronValue'>): string {
  if (proposal.cronKind === 'interval') return `每 ${proposal.cronValue} 小时`;
  if (proposal.cronKind === 'daily') return `每天 ${proposal.cronValue}`;
  const [part, time] = proposal.cronValue.split('|');
  if (proposal.cronKind === 'monthly') return `每月 ${part} 日 ${time}`;
  return `每${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][Number(part)] ?? part} ${time}`;
}
