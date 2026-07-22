/**
 * 跨平台资源监控（PRD 11.x）
 * Windows: WMI / 性能计数器；Ubuntu: /proc、sysfs、nvidia-smi。
 * 采集失败返回 null —— 界面显示"未知"，不伪造 0%（6.5 验收）。
 */
import si from 'systeminformation';
import { app } from 'electron';
import { join } from 'node:path';
import type { GpuSample, ResourceSample, ServiceHealth } from '../../shared/types.js';

const HISTORY_LIMIT = 300; // 每2秒一条 → 保留最近10分钟

export interface Thresholds {
  cpu: number;
  mem: number;
  gpuTemp: number;
}

const SUSTAIN_MS = 5 * 60_000; // CPU/内存持续超限 5 分钟才告警（11.2）
const DISK_WARN_BYTES = 10 * 1024 ** 3;
const DISK_BLOCK_BYTES = 2 * 1024 ** 3;

export class ResourceMonitor {
  private history: ResourceSample[] = [];
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<(s: ResourceSample) => void>();
  private health: ServiceHealth = { runtime: 'healthy', gateway: 'healthy', database: 'healthy' };
  /** 阈值提供方（读 settings，由 main 注入） */
  private thresholds: () => Thresholds = () => ({ cpu: 85, mem: 85, gpuTemp: 85 });
  /** 告警边沿回调（新告警出现时触发一次，用于系统通知） */
  private alertListener: ((message: string) => void) | null = null;
  private cpuOverSince: number | null = null;
  private memOverSince: number | null = null;
  private activeAlerts = new Map<string, string>();

  setThresholdProvider(fn: () => Thresholds) {
    this.thresholds = fn;
  }

  onAlert(fn: (message: string) => void) {
    this.alertListener = fn;
  }

  /** 当前活跃告警（首页待办区展示） */
  getAlerts(): string[] {
    return [...this.activeAlerts.values()];
  }

  /** 调度保护门禁（11.2）：内存 ≥95% 或磁盘 <2GB 时停止派发新任务；返回阻止原因 */
  getGuardReason(): string | null {
    const last = this.history[this.history.length - 1];
    if (!last) return null;
    if (last.memoryPercent !== null && last.memoryPercent >= 95) return '内存占用 ≥95%，暂停派发新任务';
    if (last.diskTotal > 0 && last.diskFree < DISK_BLOCK_BYTES) return '磁盘剩余 <2GB，暂停派发新任务';
    return null;
  }

  /** 阈值判定：CPU/内存持续 5 分钟超限、GPU 温度、磁盘低空间；进入/退出告警取边沿 */
  private checkThresholds(s: ResourceSample) {
    const t = this.thresholds();
    const now = s.timestamp;
    const next = new Map<string, string>();

    if (s.cpu !== null && s.cpu >= t.cpu) {
      this.cpuOverSince ??= now;
      if (now - this.cpuOverSince >= SUSTAIN_MS) next.set('cpu', `CPU 持续 5 分钟 ≥${t.cpu}%，建议检查任务负载`);
    } else {
      this.cpuOverSince = null;
    }
    if (s.memoryPercent !== null && s.memoryPercent >= t.mem) {
      this.memOverSince ??= now;
      if (now - this.memOverSince >= SUSTAIN_MS || s.memoryPercent >= 95) {
        next.set('mem', `内存占用 ≥${Math.max(t.mem, Math.round(s.memoryPercent))}%，${s.memoryPercent >= 95 ? '已暂停派发新任务' : '建议关注'}`);
      }
    } else {
      this.memOverSince = null;
    }
    if (s.gpu?.temperature != null && s.gpu.temperature >= t.gpuTemp) {
      next.set('gpu', `GPU 温度 ${Math.round(s.gpu.temperature)}℃ ≥${t.gpuTemp}℃`);
    }
    if (s.diskTotal > 0 && s.diskFree < DISK_WARN_BYTES) {
      next.set('disk', s.diskFree < DISK_BLOCK_BYTES ? '磁盘剩余不足 2GB，已阻止新任务' : '磁盘剩余不足 10GB，请及时清理');
    }

    // 新出现的告警触发一次通知（边沿）
    for (const [key, msg] of next) {
      if (!this.activeAlerts.has(key)) this.alertListener?.(msg);
    }
    this.activeAlerts = next;
  }

  start(intervalMs = 2000) {
    if (this.timer) return;
    void this.sampleOnce();
    this.timer = setInterval(() => void this.sampleOnce(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onSample(fn: (s: ResourceSample) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getHistory(): ResourceSample[] {
    return this.history;
  }

  getHealth(): ServiceHealth {
    return this.health;
  }

  setServiceHealth(patch: Partial<ServiceHealth>) {
    this.health = { ...this.health, ...patch };
  }

  private emit(s: ResourceSample) {
    this.history.push(s);
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
    this.checkThresholds(s);
    for (const fn of this.listeners) {
      try {
        fn(s);
      } catch {
        /* listener 异常不影响采集 */
      }
    }
  }

  private async sampleOnce() {
    const dataDir = join(app.getPath('userData'), 'aibox-data');
    let cpu: number | null = null;
    let cpuCores = 0;
    let memoryUsed = 0;
    let memoryTotal = 0;
    let memoryPercent: number | null = null;
    let gpu: GpuSample | null = null;
    let diskFree = 0;
    let diskTotal = 0;
    let networkOnline = false;

    try {
      const [load, mem, graphics, fsSize, net] = await Promise.allSettled([
        si.currentLoad(),
        si.mem(),
        si.graphics(),
        si.fsSize(),
        si.networkInterfaces('default')
      ]);

      if (load.status === 'fulfilled') {
        cpu = Math.round(load.value.currentLoad * 10) / 10;
        cpuCores = load.value.cpus?.length || 0;
      }
      if (mem.status === 'fulfilled') {
        memoryUsed = mem.value.active;
        memoryTotal = mem.value.total;
        memoryPercent = mem.value.total > 0 ? Math.round((mem.value.active / mem.value.total) * 1000) / 10 : null;
      }
      if (graphics.status === 'fulfilled') {
        const g = graphics.value.controllers.find((c) => c.utilizationGpu !== undefined || c.memoryTotal) ?? null;
        if (g) {
          gpu = {
            name: g.model || 'GPU',
            utilization: typeof g.utilizationGpu === 'number' ? Math.round(g.utilizationGpu * 10) / 10 : null,
            vramUsed: typeof g.memoryUsed === 'number' && typeof g.memoryTotal === 'number' ? g.memoryUsed * 1024 * 1024 : null,
            vramTotal: typeof g.memoryTotal === 'number' ? g.memoryTotal * 1024 * 1024 : null,
            temperature: typeof g.temperatureGpu === 'number' ? g.temperatureGpu : null
          };
        }
      }
      if (fsSize.status === 'fulfilled') {
        // 数据目录所在盘
        const mount = process.platform === 'win32' ? dataDir.slice(0, 2) : '/';
        const fs = fsSize.value.find((f) => mount.length <= 2 ? f.fs.startsWith(mount) : f.mount === '/') ?? fsSize.value[0];
        if (fs) {
          diskFree = fs.available;
          diskTotal = fs.size;
        }
      }
      if (net.status === 'fulfilled' && net.value) {
        networkOnline = net.value.operstate === 'up';
      }
    } catch {
      /* 整体采集异常 → 各字段保持 null/默认 */
    }

    // 无独立计数信息时用 OS 核数兜底
    if (!cpuCores) {
      try {
        cpuCores = (await si.cpu()).cores;
      } catch {
        cpuCores = 0;
      }
    }

    this.emit({
      timestamp: Date.now(),
      cpu,
      cpuCores,
      memoryUsed,
      memoryTotal,
      memoryPercent,
      gpu,
      diskFree,
      diskTotal,
      networkOnline
    });
  }
}
