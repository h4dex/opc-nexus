/** 统一行动中心：聚合审批、执行异常、成果验收和项目风险。 */
import { useMemo, useState } from 'react';
import { useApp } from '../store';
import { toast } from '../components/Toast';
import {
  IconAlert, IconArchive, IconCheck, IconClock, IconFile, IconFolder, IconLayers,
  IconRefresh, IconTask, IconX
} from '../components/icons';
import type { ActionCenterItem, ActionCenterKind } from '../../../shared/types';

type ActionFilter = 'all' | ActionCenterKind;

const KIND_META: Record<ActionCenterKind, { label: string; icon: React.ReactNode }> = {
  approval: { label: '待审批', icon: <IconCheck size={15} /> },
  failed_task: { label: '失败任务', icon: <IconTask size={15} /> },
  team_run: { label: '团队异常', icon: <IconLayers size={15} /> },
  deliverable: { label: '成果验收', icon: <IconFile size={15} /> },
  project_risk: { label: '项目风险', icon: <IconFolder size={15} /> }
};

const FILTERS: Array<{ key: ActionFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'approval', label: '审批' },
  { key: 'failed_task', label: '任务' },
  { key: 'team_run', label: '团队' },
  { key: 'deliverable', label: '成果' },
  { key: 'project_risk', label: '项目' }
];

function timeAgo(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(timestamp).toLocaleDateString('zh-CN');
}

export function Inbox() {
  const { snapshot, actionCenter, navigate, refreshActionCenter } = useApp();
  const [filter, setFilter] = useState<ActionFilter>('all');
  const [workingKey, setWorkingKey] = useState<string | null>(null);
  const items = useMemo(() => (actionCenter?.items ?? []).filter((item) => filter === 'all' || item.kind === filter), [actionCenter, filter]);

  const decide = async (item: ActionCenterItem, approve: boolean) => {
    if (!item.approvalId) return;
    setWorkingKey(item.key);
    try {
      await window.aibox.decideApproval(item.approvalId, approve);
      await refreshActionCenter();
      toast.ok(approve ? '审批已通过' : '审批已拒绝');
    } catch (error) {
      toast.err(error instanceof Error ? error.message : '审批处理失败');
    } finally {
      setWorkingKey(null);
    }
  };

  const dismiss = async (item: ActionCenterItem) => {
    setWorkingKey(item.key);
    try {
      await window.aibox.dismissAction(item.key, item.fingerprint);
      await refreshActionCenter();
      toast.ok('已忽略本次状态，状态变化后会重新出现');
    } catch (error) {
      toast.err(error instanceof Error ? error.message : '忽略失败');
    } finally {
      setWorkingKey(null);
    }
  };

  const retry = async (item: ActionCenterItem) => {
    const task = snapshot?.tasks.find((candidate) => candidate.id === item.target.entityId);
    if (!task) return;
    setWorkingKey(item.key);
    try {
      await window.aibox.retryTask(task.id);
      await refreshActionCenter();
      toast.ok('重试任务已创建');
    } catch (error) {
      toast.err(error instanceof Error ? error.message : '任务重试失败');
    } finally {
      setWorkingKey(null);
    }
  };

  const openTarget = (item: ActionCenterItem) => {
    navigate(item.target.route, { entityType: item.target.entityType, entityId: item.target.entityId });
  };

  const countFor = (key: ActionFilter) => key === 'all' ? actionCenter?.total ?? 0 : actionCenter?.counts[key] ?? 0;

  return <div className="action-center-page">
    <div className="page-head">
      <h2>待我处理</h2>
      <span className="desc">{actionCenter ? `${actionCenter.total} 项待处理 · 按风险优先排列` : '正在汇总待处理事项'}</span>
      <div className="right">
        <button className="btn small" type="button" onClick={() => void refreshActionCenter()}><IconRefresh size={13} />刷新</button>
      </div>
    </div>

    <div className="action-center-summary">
      <span data-tone={actionCenter?.counts.approval ? 'warn' : 'muted'}><IconCheck size={16} /><b>{actionCenter?.counts.approval ?? 0}</b><small>待审批</small></span>
      <span data-tone={actionCenter?.counts.failed_task ? 'danger' : 'muted'}><IconTask size={16} /><b>{actionCenter?.counts.failed_task ?? 0}</b><small>失败任务</small></span>
      <span data-tone={actionCenter?.counts.deliverable ? 'info' : 'muted'}><IconFile size={16} /><b>{actionCenter?.counts.deliverable ?? 0}</b><small>成果验收</small></span>
      <span data-tone={(actionCenter?.counts.project_risk ?? 0) + (actionCenter?.counts.team_run ?? 0) ? 'warn' : 'muted'}><IconAlert size={16} /><b>{(actionCenter?.counts.project_risk ?? 0) + (actionCenter?.counts.team_run ?? 0)}</b><small>运营风险</small></span>
    </div>

    <div className="action-center-filter" aria-label="行动类型筛选">
      {FILTERS.map((item) => <button key={item.key} type="button" className={filter === item.key ? 'active' : ''} onClick={() => setFilter(item.key)}>
        {item.label}<span>{countFor(item.key)}</span>
      </button>)}
    </div>

    {!actionCenter ? <div className="action-center-empty"><IconClock size={25} /><strong>正在加载行动中心</strong></div>
      : items.length === 0 ? <div className="action-center-empty"><IconCheck size={25} /><strong>{actionCenter.total === 0 ? '全部处理完毕' : '当前分类没有待处理事项'}</strong><small>{actionCenter.total === 0 ? '新的审批、异常和风险会在这里出现。' : '切换到其他分类继续处理。'}</small></div>
        : <div className="action-center-list">{items.map((item) => {
          const meta = KIND_META[item.kind];
          const working = workingKey === item.key;
          return <article className="action-center-item" data-severity={item.severity} key={item.key}>
            <span className="action-center-kind-icon">{meta.icon}</span>
            <div className="action-center-body">
              <header><span>{meta.label}</span><strong>{item.title}</strong><time>{timeAgo(item.createdAt)}</time></header>
              <p><b>{item.owner}</b>{item.reason}</p>
              <small>{item.suggestion}</small>
            </div>
            <div className="action-center-actions">
              {item.kind === 'approval' && <>
                <button className="btn small primary" type="button" disabled={working} onClick={() => void decide(item, true)}><IconCheck size={12} />批准</button>
                <button className="btn small danger" type="button" disabled={working} onClick={() => void decide(item, false)}><IconX size={12} />拒绝</button>
              </>}
              {item.kind === 'failed_task' && <button className="btn small primary" type="button" disabled={working} onClick={() => void retry(item)}><IconRefresh size={12} />重试</button>}
              <button className="btn small" type="button" disabled={working} onClick={() => openTarget(item)}>查看详情</button>
              <button className="icon-btn action-center-dismiss" type="button" disabled={working} title="忽略本次状态" aria-label={`忽略 ${item.title}`} onClick={() => void dismiss(item)}><IconArchive size={13} /></button>
            </div>
          </article>;
        })}</div>}
  </div>;
}
