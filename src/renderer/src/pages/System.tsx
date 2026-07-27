/** 系统状态页（PRD 6.3 / 11.x）：完整资源监控 + 调度保护策略 + 服务健康 */
import { useApp } from '../store';
import { RingGauge, Sparkline } from '../components/charts';
import { ProgressBar, formatBytes } from '../components/common';
import { IconChip, IconCpu, IconDb, IconGpu, IconLayers, IconMemory, IconWifi } from '../components/icons';

export function System() {
  const { resources, snapshot } = useApp();
  const last = resources.history[resources.history.length - 1];
  const diskPct = last && last.diskTotal > 0 ? Math.round(((last.diskTotal - last.diskFree) / last.diskTotal) * 100) : null;

  const healthItems = [
    { key: 'runtime', label: 'Nexus Runtime', icon: <IconLayers size={18} /> },
    { key: 'gateway', label: 'Messaging Gateway', icon: <IconWifi size={18} /> },
    { key: 'database', label: '本地数据库', icon: <IconDb size={18} /> }
  ] as const;

  return (
    <>
      <div className="page-head">
        <h2>系统状态</h2>
        <span className="desc">CPU / 内存 / GPU / 磁盘 / 网络 · 调度保护策略（11.2）</span>
      </div>

      <div className="dash-grid">
        <div className="card">
          <div className="card-title"><IconCpu size={17} />CPU</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
            <RingGauge percent={last?.cpu ?? null} size={140} stroke={13} color="var(--accent)">
              <div className="big-number" style={{ fontSize: 30 }}>{last?.cpu != null ? `${Math.round(last.cpu)}%` : '未知'}</div>
            </RingGauge>
            <div style={{ flex: 1 }}>
              <div style={{ color: 'var(--text-2)', fontSize: 12.5, marginBottom: 8 }}>{last?.cpuCores ?? 0} 逻辑核心 · 最近 10 分钟</div>
              <Sparkline data={resources.history.map((h) => h.cpu)} color="#4d6bfe" height={80} />
              <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 8 }}>持续 5 分钟 ≥85% 告警；≥95% 达 10 分钟并发降为 1</div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-title"><IconMemory size={17} />内存</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
            <RingGauge percent={last?.memoryPercent ?? null} size={140} stroke={13} color="var(--success)">
              <div className="big-number" style={{ fontSize: 30 }}>{last?.memoryPercent != null ? `${Math.round(last.memoryPercent)}%` : '未知'}</div>
            </RingGauge>
            <div style={{ flex: 1 }}>
              <div style={{ color: 'var(--text-2)', fontSize: 12.5, marginBottom: 8 }}>
                {last ? `${formatBytes(last.memoryUsed)} / ${formatBytes(last.memoryTotal)}` : ''}
              </div>
              <Sparkline data={resources.history.map((h) => h.memoryPercent)} color="#22c1a3" height={80} />
              <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 8 }}>≥85% 告警；连续 30 秒 ≥95% 停止派发新任务</div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-title"><IconGpu size={17} />GPU</div>
          {last?.gpu ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
              <RingGauge percent={last.gpu.utilization} size={140} stroke={13} color="var(--purple)">
                <div className="big-number" style={{ fontSize: 30 }}>{last.gpu.utilization != null ? `${Math.round(last.gpu.utilization)}%` : '未知'}</div>
              </RingGauge>
              <div style={{ flex: 1 }}>
                <div style={{ color: 'var(--text-2)', fontSize: 12.5, marginBottom: 4 }}>{last.gpu.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                  {last.gpu.temperature != null ? `温度 ${Math.round(last.gpu.temperature)}℃` : '温度未知'}
                  {last.gpu.vramTotal ? ` · 显存 ${formatBytes(last.gpu.vramUsed ?? 0)} / ${formatBytes(last.gpu.vramTotal)}` : ''}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 8 }}>温度 ≥85℃ 或显存 ≥90% 告警，暂停新的 GPU 任务</div>
              </div>
            </div>
          ) : (
            <div className="empty" style={{ padding: '30px 0' }}>未检测到 GPU（显示"未检测到"，不伪造 0%）</div>
          )}
        </div>

        <div className="card">
          <div className="card-title"><IconDb size={17} />磁盘（数据目录）</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
            <RingGauge percent={diskPct} size={140} stroke={13} color={diskPct !== null && diskPct > 90 ? 'var(--danger)' : 'var(--info)'}>
              <div className="big-number" style={{ fontSize: 30 }}>{diskPct !== null ? `${diskPct}%` : '未知'}</div>
            </RingGauge>
            <div style={{ flex: 1 }}>
              <div style={{ color: 'var(--text-2)', fontSize: 12.5, marginBottom: 8 }}>
                剩余 {last ? formatBytes(last.diskFree) : '—'} / 共 {last ? formatBytes(last.diskTotal) : '—'}
              </div>
              <ProgressBar percent={diskPct ?? 0} color="var(--info)" />
              <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 8 }}>剩余 &lt;10GB 告警；&lt;2GB 阻止新任务</div>
            </div>
          </div>
        </div>

        <div className="card span2">
          <div className="card-title"><IconChip size={17} />服务健康（每 30 秒检查，连续 3 次失败转为异常）</div>
          <div style={{ display: 'flex', gap: 14 }}>
            {healthItems.map((h) => {
              const v = resources.health[h.key];
              return (
                <div key={h.key} className="sys-card" style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ color: v === 'healthy' ? 'var(--success)' : v === 'degraded' ? 'var(--warning)' : 'var(--danger)' }}>{h.icon}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{h.label}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                      {v === 'healthy' ? '运行正常' : v === 'degraded' ? '性能降级' : '离线'}
                    </div>
                  </div>
                  <span className={`dot ${v === 'healthy' ? 'green' : v === 'degraded' ? 'orange' : 'red'}`} />
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 14, fontSize: 12, color: 'var(--text-2)' }}>
            网络：{last?.networkOnline ? '在线' : '离线'} · 客户端空闲内存目标 ≤350MB · 数字员工 {snapshot?.stats.totalAgents ?? 0}/50 · 并发任务 {snapshot?.stats.activeTasks ?? 0}/10
          </div>
        </div>
      </div>
    </>
  );
}
