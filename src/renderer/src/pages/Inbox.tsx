/** 「待我处理」收件箱：聚合待审批 / 失败任务 / 需关注的团队运行，带人性化上下文与一键操作 */
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { toast } from '../components/Toast';
import { humanizeTaskError } from '../utils/humanize';
import { IconCheck, IconX } from '../components/icons';
import type { Approval, Task, TeamRun } from '../../../shared/types';

type ItemKind = 'approval' | 'failed' | 'team';

interface InboxItem {
  key: string;
  kind: ItemKind;
  title: string;
  agentName: string;
  ts: number;
  reason: string;
  suggestion: string;
  severity: 'info' | 'warn' | 'danger';
  // 原始引用，供操作使用
  approval?: Approval;
  task?: Task;
  run?: TeamRun & { teamName: string };
}

const KIND_META: Record<ItemKind, { label: string; color: string; icon: string }> = {
  approval: { label: '待审批', color: 'var(--warning)', icon: '🛡️' },
  failed: { label: '任务失败', color: 'var(--danger)', icon: '⚠️' },
  team: { label: '团队运行', color: 'var(--accent)', icon: '👥' }
};

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

export function Inbox() {
  const { snapshot, setRoute } = useApp();
  const [attentionRuns, setAttentionRuns] = useState<(TeamRun & { teamName: string })[]>([]);

  useEffect(() => {
    void window.aibox.listAttentionRuns().then(setAttentionRuns);
  }, [snapshot?.version]);

  const agentName = useMemo(() => {
    const m = new Map<string, string>();
    snapshot?.agentCards.forEach((c) => m.set(c.agent.id, c.agent.name));
    return m;
  }, [snapshot]);

  const items = useMemo<InboxItem[]>(() => {
    if (!snapshot) return [];
    const list: InboxItem[] = [];

    // 待审批
    for (const a of snapshot.approvals.filter((x) => x.status === 'pending')) {
      const riskText = a.risk === 'high' ? '高风险' : a.risk === 'medium' ? '中风险' : '低风险';
      list.push({
        key: `ap-${a.id}`, kind: 'approval', title: a.request.slice(0, 80),
        agentName: agentName.get(a.agentId) ?? '数字员工', ts: a.createdAt,
        reason: `请求执行一个${riskText}操作，需要你批准后才能继续。`,
        suggestion: '确认该操作安全后批准；如有疑问可拒绝。',
        severity: a.risk === 'high' ? 'danger' : a.risk === 'medium' ? 'warn' : 'info',
        approval: a
      });
    }

    // 失败任务
    for (const t of snapshot.tasks.filter((x) => x.status === 'FAILED')) {
      const h = humanizeTaskError(t.error, t.stage);
      list.push({
        key: `tk-${t.id}`, kind: 'failed', title: t.title.slice(0, 80),
        agentName: agentName.get(t.agentId) ?? '数字员工', ts: t.endedAt ?? t.createdAt,
        reason: h?.reason ?? '执行失败', suggestion: h?.suggestion ?? '可重试一次。',
        severity: h?.severity ?? 'danger', task: t
      });
    }

    // 需关注的团队运行
    for (const r of attentionRuns) {
      const failedCount = r.subtasks.filter((s) => s.status === 'failed').length;
      list.push({
        key: `run-${r.id}`, kind: 'team', title: `${r.teamName} · ${r.taskText.slice(0, 60)}`,
        agentName: r.teamName, ts: r.endedAt ?? r.createdAt,
        reason: r.phase === 'cancelled' ? '该团队运行被取消。' : `团队运行失败${failedCount > 0 ? `，${failedCount} 个子任务未完成` : ''}。`,
        suggestion: '打开执行时间线查看失败原因，可对失败子任务重试。',
        severity: 'warn', run: r
      });
    }

    return list.sort((a, b) => b.ts - a.ts);
  }, [snapshot, attentionRuns, agentName]);

  if (!snapshot) return null;

  const decide = async (id: string, approve: boolean) => {
    await window.aibox.decideApproval(id, approve);
    toast.ok(approve ? '已批准' : '已拒绝');
  };

  const retryTask = async (t: Task) => {
    await window.aibox.createFollowUpTask(t.id, `重试：${t.title}`);
    toast.ok('已重新发起任务');
  };

  return (
    <>
      <div className="page-head">
        <h2>待我处理</h2>
        <span className="desc">需要你介入的事项：审批 · 失败任务 · 团队运行 · 共 {items.length} 项</span>
      </div>

      {items.length === 0 ? (
        <div className="card" style={{ padding: 60, textAlign: 'center' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🎉</div>
          <div style={{ fontSize: 15, fontWeight: 650, color: 'var(--text-1)' }}>全部处理完毕</div>
          <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 6 }}>没有待审批、失败或需要关注的事项，数字员工们运转正常。</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.map((it) => {
            const meta = KIND_META[it.kind];
            return (
              <div key={it.key} className="card" style={{ padding: '14px 16px', borderLeft: `3px solid ${meta.color}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <span style={{ fontSize: 16 }}>{meta.icon}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: meta.color, padding: '1px 8px', borderRadius: 10, background: 'var(--input-bg)' }}>{meta.label}</span>
                  <span style={{ fontSize: 13, fontWeight: 650, color: 'var(--text-1)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.title}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-3)', flexShrink: 0 }}>{timeAgo(it.ts)}</span>
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.7, marginBottom: 4 }}>
                  <span style={{ color: 'var(--text-3)' }}>{it.agentName} · </span>{it.reason}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 10 }}>💡 {it.suggestion}</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {it.kind === 'approval' && it.approval && (
                    <>
                      <button className="btn small primary" onClick={() => void decide(it.approval!.id, true)}><IconCheck size={13} />批准</button>
                      <button className="btn small danger" onClick={() => void decide(it.approval!.id, false)}><IconX size={13} />拒绝</button>
                    </>
                  )}
                  {it.kind === 'failed' && it.task && (
                    <button className="btn small primary" onClick={() => void retryTask(it.task!)}>↻ 重试任务</button>
                  )}
                  {it.kind === 'team' && (
                    <button className="btn small" onClick={() => setRoute('teams')}>查看执行时间线</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
