/** 用量统计：日期筛选 + Token 总览 + 趋势图 + 按模型/员工分布 + 最近调用明细 */
import { useEffect, useState } from 'react';
import { useApp } from '../store';

type RangeKey = 'today' | '7d' | '30d' | 'all';
const RANGES: { key: RangeKey; label: string }[] = [
  { key: 'today', label: '今天' },
  { key: '7d', label: '7 天' },
  { key: '30d', label: '30 天' },
  { key: 'all', label: '全部' }
];

interface EnhancedData {
  total: { input: number; output: number; total: number };
  byModel: { model: string; input: number; output: number; total: number; count: number }[];
  byAgent: { agent_id: string; total: number; count: number }[];
  trend: { date: string; total: number }[];
  recent: { id: string; agentId: string; model: string; input: number; output: number; total: number; createdAt: number }[];
}

function sinceForRange(key: RangeKey): number | null {
  if (key === 'all') return null;
  const now = new Date();
  if (key === 'today') { now.setHours(0, 0, 0, 0); return now.getTime(); }
  if (key === '7d') return Date.now() - 7 * 86400000;
  return Date.now() - 30 * 86400000;
}

export function Usage() {
  const { snapshot } = useApp();
  const [range, setRange] = useState<RangeKey>('7d');
  const [data, setData] = useState<EnhancedData | null>(null);

  useEffect(() => {
    const load = () => void window.aibox.getUsageStatsEnhanced(sinceForRange(range)).then(setData);
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [range]);

  if (!snapshot) return null;
  const agentName = (id: string) => snapshot.agentCards.find((c) => c.agent.id === id)?.agent.name ?? id;

  const maxTrend = data ? Math.max(...data.trend.map((t) => t.total), 1) : 1;

  return (
    <>
      <div className="page-head">
        <h2>用量统计</h2>
        <span className="desc">Token 消耗、模型调用分布、员工用量与趋势</span>
        <div className="right">
          <div style={{ display: 'flex', gap: 4 }}>
            {RANGES.map((r) => (
              <button key={r.key} onClick={() => setRange(r.key)}
                style={{ padding: '5px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: range === r.key ? 'var(--accent)' : 'var(--input-bg)', color: range === r.key ? '#fff' : 'var(--text-2)' }}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {!data || data.total.total === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>
          暂无调用记录。配置模型供应商并执行任务后，Token 用量将自动统计。
        </div>
      ) : (
        <>
          {/* 总览卡片 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 16 }}>
            <div className="card" style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--accent)' }}>{data.total.total.toLocaleString()}</div>
              <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>总 Token</div>
            </div>
            <div className="card" style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--success)' }}>{data.total.input.toLocaleString()}</div>
              <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>输入 Token</div>
            </div>
            <div className="card" style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--warning)' }}>{data.total.output.toLocaleString()}</div>
              <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>输出 Token</div>
            </div>
          </div>

          {/* 7 天趋势 */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-title">最近 7 天趋势</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 100, padding: '0 8px' }}>
              {data.trend.map((t) => (
                <div key={t.date} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{t.total > 0 ? t.total.toLocaleString() : ''}</span>
                  <div style={{ width: '100%', maxWidth: 40, height: `${Math.max(4, (t.total / maxTrend) * 70)}px`, borderRadius: 4, background: t.total > 0 ? 'var(--accent)' : 'var(--input-bg)' }} />
                  <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{t.date}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
            {/* 按模型分布 */}
            <div className="card">
              <div className="card-title">模型调用分布</div>
              <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: 'var(--text-3)', textAlign: 'left' }}>
                    <th style={{ padding: '6px 10px' }}>模型</th>
                    <th style={{ padding: '6px 10px' }}>次数</th>
                    <th style={{ padding: '6px 10px' }}>合计</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byModel.map((m) => (
                    <tr key={m.model} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '6px 10px', fontWeight: 600 }}>{m.model || '—'}</td>
                      <td style={{ padding: '6px 10px' }}>{m.count}</td>
                      <td style={{ padding: '6px 10px', fontWeight: 600 }}>{m.total.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 按员工分布 */}
            <div className="card">
              <div className="card-title">员工用量分布</div>
              <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: 'var(--text-3)', textAlign: 'left' }}>
                    <th style={{ padding: '6px 10px' }}>员工</th>
                    <th style={{ padding: '6px 10px' }}>次数</th>
                    <th style={{ padding: '6px 10px' }}>Token</th>
                    <th style={{ padding: '6px 10px' }}>占比</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byAgent.map((a) => (
                    <tr key={a.agent_id} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '6px 10px', fontWeight: 600 }}>{agentName(a.agent_id)}</td>
                      <td style={{ padding: '6px 10px' }}>{a.count}</td>
                      <td style={{ padding: '6px 10px' }}>{a.total.toLocaleString()}</td>
                      <td style={{ padding: '6px 10px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--input-bg)', overflow: 'hidden' }}>
                            <div style={{ width: `${data.total.total ? Math.round((a.total / data.total.total) * 100) : 0}%`, height: '100%', background: 'var(--accent)', borderRadius: 3 }} />
                          </div>
                          <span style={{ fontSize: 11, color: 'var(--text-3)', minWidth: 32 }}>{data.total.total ? Math.round((a.total / data.total.total) * 100) : 0}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 最近调用明细 */}
          <div className="card">
            <div className="card-title">最近调用（50 条）</div>
            <div style={{ maxHeight: 280, overflowY: 'auto' }}>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: 'var(--text-3)', textAlign: 'left' }}>
                    <th style={{ padding: '6px 10px' }}>时间</th>
                    <th style={{ padding: '6px 10px' }}>助手</th>
                    <th style={{ padding: '6px 10px' }}>模型</th>
                    <th style={{ padding: '6px 10px' }}>输入</th>
                    <th style={{ padding: '6px 10px' }}>输出</th>
                    <th style={{ padding: '6px 10px' }}>合计</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((r) => (
                    <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '6px 10px', color: 'var(--text-3)' }}>
                        {new Date(r.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td style={{ padding: '6px 10px' }}>{agentName(r.agentId)}</td>
                      <td style={{ padding: '6px 10px' }}>{r.model}</td>
                      <td style={{ padding: '6px 10px' }}>{r.input.toLocaleString()}</td>
                      <td style={{ padding: '6px 10px' }}>{r.output.toLocaleString()}</td>
                      <td style={{ padding: '6px 10px', fontWeight: 600 }}>{r.total.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}
