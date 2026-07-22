/** 用量统计：Token 消耗总览 + 按模型分布 + 最近调用明细 */
import { useEffect, useState } from 'react';
import { useApp } from '../store';

interface UsageData {
  total: { input: number; output: number; total: number };
  byModel: { model: string; input: number; output: number; total: number; count: number }[];
  recent: { id: string; agentId: string; model: string; input: number; output: number; total: number; createdAt: number }[];
}

export function Usage() {
  const { snapshot } = useApp();
  const [data, setData] = useState<UsageData | null>(null);

  useEffect(() => {
    void window.aibox.getUsageStats().then(setData);
    const timer = setInterval(() => void window.aibox.getUsageStats().then(setData), 10000);
    return () => clearInterval(timer);
  }, []);

  if (!snapshot) return null;
  const agentName = (id: string) => snapshot.agentCards.find((c) => c.agent.id === id)?.agent.name ?? id;

  return (
    <>
      <div className="page-head">
        <h2>用量统计</h2>
        <span className="desc">Token 消耗、模型调用分布与费用追踪</span>
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

          {/* 按模型分布 */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-title">模型调用分布</div>
            <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--text-3)', textAlign: 'left' }}>
                  <th style={{ padding: '8px 12px' }}>模型</th>
                  <th style={{ padding: '8px 12px' }}>调用次数</th>
                  <th style={{ padding: '8px 12px' }}>输入</th>
                  <th style={{ padding: '8px 12px' }}>输出</th>
                  <th style={{ padding: '8px 12px' }}>合计</th>
                </tr>
              </thead>
              <tbody>
                {data.byModel.map((m) => (
                  <tr key={m.model} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 12px', fontWeight: 600 }}>{m.model || '—'}</td>
                    <td style={{ padding: '8px 12px' }}>{m.count}</td>
                    <td style={{ padding: '8px 12px' }}>{m.input.toLocaleString()}</td>
                    <td style={{ padding: '8px 12px' }}>{m.output.toLocaleString()}</td>
                    <td style={{ padding: '8px 12px', fontWeight: 600 }}>{m.total.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 最近调用明细 */}
          <div className="card">
            <div className="card-title">最近调用（50 条）</div>
            <div style={{ maxHeight: 300, overflowY: 'auto' }}>
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
