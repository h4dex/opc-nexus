/**
 * 跨平台资源监控（PRD 11.x）
 * Windows: WMI / 性能计数器；Ubuntu: /proc、sysfs、nvidia-smi。
 * 采集失败返回 null —— 界面显示“未知”，不伪造 0%（6.5 验收）。
 * 持久化：每 30s 将采样写入 resource_samples 表，保留 7 天，支持长期趋势分析。
 */
import si from 'systeminformation';
import { app } from 'electron';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { availableParallelism, networkInterfaces as osNetworkInterfaces } from 'node:os';
import type { GpuSample, ResourceSample, ServiceHealth } from '../../shared/types.js';
import type { Database } from './database.js';

const MIB = 1024 * 1024;

/**
 * Windows 上 systeminformation.graphics() 会并发启动多组 PowerShell/WMI 查询。
 * 某些机器一次查询超过采样周期，最终堆叠出大量 powershell.exe。NVIDIA
 * 指标改用一个受超时约束的 nvidia-smi 进程；无 NVIDIA 时明确返回 null。
 */
function nvidiaSmiSample(): Promise<GpuSample | null> {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'],
      { timeout: 5000, maxBuffer: 64 * 1024, shell: false, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(parseNvidiaSmiSample(stdout));
      }
    );
  });
}

export function parseNvidiaSmiSample(stdout: string): GpuSample | null {
  const line = stdout.trim().split(/\r?\n/).find(Boolean);
  if (!line) return null;
  const fields = line.split(',').map((value) => value.trim());
  if (fields.length < 5 || !fields[0]) return null;
  const numberAt = (index: number): number | null => {
    const value = Number(fields[index]);
    return Number.isFinite(value) ? value : null;
  };
  const utilization = numberAt(1);
  const memoryUsedMiB = numberAt(2);
  const memoryTotalMiB = numberAt(3);
  return {
    name: fields[0],
    utilization: utilization === null ? null : Math.round(utilization * 10) / 10,
    vramUsed: memoryUsedMiB === null ? null : memoryUsedMiB * MIB,
    vramTotal: memoryTotalMiB === null ? null : memoryTotalMiB * MIB,
    temperature: numberAt(4)
  };
}

export async function collectGpuSample(platform: NodeJS.Platform): Promise<GpuSample | null> {
  // Avoid systeminformation.graphics() on Windows: it launches eight concurrent
  // PowerShell/WMI commands for controller and monitor metadata on every call.
  if (platform === 'win32') return nvidiaSmiSample();

  const graphics = await si.graphics();
  const controller = graphics.controllers.find((item) => item.utilizationGpu !== undefined || item.memoryTotal) ?? null;
  if (!controller) return null;
  const fallback = controller.utilizationGpu == null ? await nvidiaSmiSample() : null;
  return {
    name: controller.model || fallback?.name || 'GPU',
    utilization: typeof controller.utilizationGpu === 'number'
      ? Math.round(controller.utilizationGpu * 10) / 10
      : fallback?.utilization ?? null,
    vramUsed: typeof controller.memoryUsed === 'number' ? controller.memoryUsed * MIB : fallback?.vramUsed ?? null,
    vramTotal: typeof controller.memoryTotal === 'number' ? controller.memoryTotal * MIB : fallback?.vramTotal ?? null,
    temperature: typeof controller.temperatureGpu === 'number' ? controller.temperatureGpu : fallback?.temperature ?? null
  };
}

export function hasActiveNetworkInterface(
  interfaces: NodeJS.Dict<ReturnType<typeof osNetworkInterfaces>[string]>
): boolean {
  return Object.values(interfaces).some((entries) => entries?.some((entry) =>
    !entry.internal && (entry.family === 'IPv4' || entry.family === 'IPv6')
  ));
}

const HISTORY_LIMIT = 300;
const PERSIST_INTERVAL = 30_000; // 每 30s 持久化一次
const SLOW_METRICS_INTERVAL = 30_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 保留 7 天

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
  private persistTimer: NodeJS.Timeout | null = null;
  private running = false;
  private sampleInFlight = false;
  private slowSampleInFlight = false;
  private lastSlowSampleAt = Number.NEGATIVE_INFINITY;
  private slowMetrics: Pick<ResourceSample, 'gpu' | 'diskFree' | 'diskTotal'> = {
    gpu: null,
    diskFree: 0,
    diskTotal: 0
  };
  private listeners = new Set<(s: ResourceSample) => void>();
  private health: ServiceHealth = { runtime: 'healthy', gateway: 'healthy', database: 'healthy' };
  /** 阈值提供方（读 settings，由 main 注入） */
  private thresholds: () => Thresholds = () => ({ cpu: 85, mem: 85, gpuTemp: 85 });
  /** 告警边沿回调（新告警出现时触发一次，用于系统通知） */
  private alertListener: ((message: string) => void) | null = null;
  private cpuOverSince: number | null = null;
  private memOverSince: number | null = null;
  private activeAlerts = new Map<string, string>();
  private db: Database | null = null;

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly gpuCollector: (platform: NodeJS.Platform) => Promise<GpuSample | null> = collectGpuSample
  ) {}

  /** 注入数据库实例（由 main 装配后调用，启用持久化） */
  setDatabase(db: Database) {
    this.db = db;
  }

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
    this.running = true;
    this.requestSample();
    this.timer = setInterval(() => this.requestSample(), intervalMs);
    // 持久化定时器：每 30s 写入 DB + 清理过期数据
    this.persistTimer = setInterval(() => this.persistAndCleanup(), PERSIST_INTERVAL);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this.persistTimer) clearInterval(this.persistTimer);
    this.timer = null;
    this.persistTimer = null;
  }

  private requestSample(): void {
    if (!this.running || this.sampleInFlight) return;
    void this.sampleOnce();
  }

  onSample(fn: (s: ResourceSample) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getHistory(): ResourceSample[] {
    return this.history;
  }

  /** 长期趋势查询：从 DB 读取指定时间范围的降采样数据（最多返回 500 点） */
  getTrend(rangeMs: number): { timestamp: number; cpu: number | null; memory: number | null; gpu: number | null; temp: number | null }[] {
    if (!this.db) return [];
    const since = Date.now() - rangeMs;
    const rows = this.db.raw.prepare(
      'SELECT created_at, cpu, memory, gpu, temp FROM resource_samples WHERE created_at >= ? ORDER BY created_at'
    ).all(since) as { created_at: number; cpu: number | null; memory: number | null; gpu: number | null; temp: number | null }[];
    // 降采样：超过 500 点时等间距抽取
    if (rows.length <= 500) return rows.map((r) => ({ timestamp: r.created_at, cpu: r.cpu, memory: r.memory, gpu: r.gpu, temp: r.temp }));
    const step = Math.ceil(rows.length / 500);
    return rows.filter((_, i) => i % step === 0).map((r) => ({ timestamp: r.created_at, cpu: r.cpu, memory: r.memory, gpu: r.gpu, temp: r.temp }));
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

  /** 持久化当前采样到 DB + 清理 7 天前的旧数据 */
  private persistAndCleanup() {
    if (!this.db) return;
    const last = this.history[this.history.length - 1];
    if (!last) return;
    try {
      this.db.raw.prepare(
        'INSERT INTO resource_samples(scope, scope_id, cpu, memory, gpu, vram, temp, created_at) VALUES(?,?,?,?,?,?,?,?)'
      ).run('system', '', last.cpu, last.memoryPercent, last.gpu?.utilization ?? null, last.gpu?.vramUsed ?? null, last.gpu?.temperature ?? null, last.timestamp);
      // 清理过期数据（保留 7 天）
      const cutoff = Date.now() - RETENTION_MS;
      this.db.raw.prepare('DELETE FROM resource_samples WHERE created_at < ?').run(cutoff);
    } catch {
      /* 持久化失败不影响主流程 */
    }
  }

  private async sampleOnce(): Promise<void> {
    if (!this.running || this.sampleInFlight) return;
    this.sampleInFlight = true;
    let cpu: number | null = null;
    let cpuCores = availableParallelism();
    let memoryUsed = 0;
    let memoryTotal = 0;
    let memoryPercent: number | null = null;
    let networkOnline = false;

    try {
      try {
        const now = Date.now();
        if (now - this.lastSlowSampleAt >= SLOW_METRICS_INTERVAL) void this.refreshSlowMetrics(now);

        const [load, mem] = await Promise.allSettled([
          si.currentLoad(),
          si.mem()
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
        networkOnline = hasActiveNetworkInterface(osNetworkInterfaces());
      } catch {
        /* 整体采集异常 -> 各字段保持 null/默认 */
      }

      if (!this.running) return;
      this.emit({
        timestamp: Date.now(),
        cpu,
        cpuCores,
        memoryUsed,
        memoryTotal,
        memoryPercent,
        ...this.slowMetrics,
        networkOnline
      });
    } finally {
      this.sampleInFlight = false;
    }
  }

  private async refreshSlowMetrics(startedAt: number): Promise<void> {
    if (this.slowSampleInFlight) return;
    this.slowSampleInFlight = true;
    this.lastSlowSampleAt = startedAt;
    const dataDir = join(app.getPath('userData'), 'aibox-data');
    try {
      const [disk, gpu] = await Promise.allSettled([
        this.collectDiskSample(dataDir),
        this.gpuCollector(this.platform)
      ]);
      let diskFree = this.slowMetrics.diskFree;
      let diskTotal = this.slowMetrics.diskTotal;
      if (disk.status === 'fulfilled') {
        diskFree = disk.value.free;
        diskTotal = disk.value.total;
      }
      this.slowMetrics = {
        gpu: gpu.status === 'fulfilled' ? gpu.value : this.slowMetrics.gpu,
        diskFree,
        diskTotal
      };
    } finally {
      this.slowSampleInFlight = false;
    }
  }

  private async collectDiskSample(path: string): Promise<{ free: number; total: number }> {
    // Node's native statfs avoids systeminformation.fsSize(), which starts a
    // PowerShell/WMI process on Windows for every refresh.
    const value = await statfs(path);
    return {
      free: Number(value.bavail) * Number(value.bsize),
      total: Number(value.blocks) * Number(value.bsize)
    };
  }
}
