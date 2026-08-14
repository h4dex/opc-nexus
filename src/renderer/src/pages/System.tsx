/** 系统状态页（PRD 6.3 / 11.x）：完整资源监控 + 调度保护策略 + 服务健康 */
import { useEffect, useState } from 'react';
import type { AppMemorySnapshot } from '@shared/types';
import { useApp } from '../store';
import { RingGauge, Sparkline } from '../components/charts';
import { ProgressBar, formatBytes } from '../components/common';
import { IconChip, IconCpu, IconDb, IconGpu, IconLayers, IconMemory, IconWifi } from '../components/icons';

const APP_MEMORY_POLL_MS = 10_000;
const APP_MEMORY_HISTORY_LIMIT = 60;

function processLabel(type: string, name: string | null): string {
  if (type === 'Browser') return 'Main';
  if (type === 'Tab') return 'Renderer';
  if (type === 'GPU') return 'GPU';
  if (type === 'Utility') return name ? `Utility · ${name}` : 'Utility';
  return name || type;
}

function useAppMemory(): { current: AppMemorySnapshot | null; history: number[] } {
  const [current, setCurrent] = useState<AppMemorySnapshot | null>(null);
  const [history, setHistory] = useState<number[]>([]);

  useEffect(() => {
    let active = true;
    let timer: number | null = null;
    const sample = async () => {
      try {
        const next = await window.aibox.getAppMemory();
        if (!active) return;
        setCurrent(next);
        setHistory((items) => [...items, next.totalBytes].slice(-APP_MEMORY_HISTORY_LIMIT));
      } catch {
        // 主进程退出或重载期间保留最后一次有效数据。
      }
      if (active) timer = window.setTimeout(() => void sample(), APP_MEMORY_POLL_MS);
    };
    void sample();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  return { current, history };
}

export function System() {
  const { resources, snapshot } = useApp();
  const appMemory = useAppMemory();
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
          <div className="card-title"><IconMemory size={17} />整机内存</div>
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
          <div className="card-title"><IconMemory size={17} />Electron 进程内存</div>
          {appMemory.current ? (
            <div className="app-memory-layout">
              <div>
                <div className="big-number" style={{ fontSize: 30 }}>{formatBytes(appMemory.current.totalBytes)}</div>
                <div style={{ color: 'var(--text-2)', fontSize: 12.5, margin: '4px 0 10px' }}>
                  {appMemory.current.basis === 'private' ? '私有内存合计' : '工作集近似合计'} · Main JS 堆 {formatBytes(appMemory.current.mainHeapUsedBytes)}
                  <br />不含浏览器自动化、CLI 引擎等外部子进程
                </div>
                <Sparkline
                  data={appMemory.history}
                  color="#d99a22"
                  height={72}
                  max={Math.max(1, ...appMemory.history) * 1.1}
                />
              </div>
              <div className="app-memory-processes">
                {appMemory.current.processes.slice(0, 8).map((metric) => (
                  <div key={`${metric.pid}-name`} style={{ display: 'contents' }}>
                    <span style={{ color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${processLabel(metric.type, metric.name)} · PID ${metric.pid}`}>
                      {processLabel(metric.type, metric.name)}
                    </span>
                    <b style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatBytes(metric.memoryBytes)}</b>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="empty" style={{ padding: '28px 0' }}>正在读取应用进程内存...</div>
          )}
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
            网络：{last?.networkOnline ? '在线' : '离线'} · 数字员工 {snapshot?.stats.totalAgents ?? 0}/50 · 并发任务 {snapshot?.stats.activeTasks ?? 0}/10
          </div>
        </div>
      </div>
    </>
  );
}
