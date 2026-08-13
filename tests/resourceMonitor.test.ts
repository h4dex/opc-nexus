import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

const currentLoad = vi.fn();
const mem = vi.fn();
const graphics = vi.fn();
const networkInterfaces = vi.fn();
const execFile = vi.fn();
const statfs = vi.fn();

vi.mock('electron', async () => await import('./__mocks__/electron.js'));
vi.mock('systeminformation', () => ({
  default: { currentLoad, mem, graphics, networkInterfaces }
}));
vi.mock('node:child_process', () => ({ execFile }));
vi.mock('node:fs/promises', () => ({ statfs }));

const { ResourceMonitor, collectGpuSample, hasActiveNetworkInterface, parseNvidiaSmiSample } = await import('../src/main/services/resourceMonitor.js');

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function resolveBaseMetrics(): void {
  mem.mockResolvedValue({ active: 4_000, total: 10_000 });
  statfs.mockResolvedValue({ bavail: 50, bsize: 1_000, blocks: 100 });
  networkInterfaces.mockResolvedValue({ operstate: 'up' });
}

describe('ResourceMonitor memory boundaries', () => {
  it('does not start a second sample while the previous sample is still running', async () => {
    vi.useFakeTimers();
    resolveBaseMetrics();
    let releaseLoad!: (value: { currentLoad: number; cpus: unknown[] }) => void;
    currentLoad.mockImplementationOnce(() => new Promise((resolve) => { releaseLoad = resolve; }));
    currentLoad.mockResolvedValue({ currentLoad: 12, cpus: [{}, {}] });
    const monitor = new ResourceMonitor('win32', vi.fn().mockResolvedValue(null));

    monitor.start(10);
    await vi.advanceTimersByTimeAsync(100);
    expect(currentLoad).toHaveBeenCalledTimes(1);

    releaseLoad({ currentLoad: 10, cpus: [{}, {}] });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(currentLoad).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it('uses one nvidia-smi query instead of systeminformation graphics on Windows', async () => {
    execFile.mockImplementation((_bin, _args, _options, callback) => {
      callback(null, 'NVIDIA RTX, 17, 1024, 8192, 53\n');
    });

    await expect(collectGpuSample('win32')).resolves.toMatchObject({
      name: 'NVIDIA RTX', utilization: 17, vramUsed: 1024 * 1024 * 1024, temperature: 53
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(graphics).not.toHaveBeenCalled();
  });

  it('parses unavailable NVIDIA fields without manufacturing zero values', () => {
    expect(parseNvidiaSmiSample('NVIDIA RTX, N/A, N/A, 8192, N/A')).toEqual({
      name: 'NVIDIA RTX', utilization: null, vramUsed: null,
      vramTotal: 8192 * 1024 * 1024, temperature: null
    });
  });

  it('detects network state from native interfaces without starting a WMI query', () => {
    expect(hasActiveNetworkInterface({
      Loopback: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
      Ethernet: [{ address: '192.168.1.8', netmask: '255.255.255.0', family: 'IPv4', mac: '01:02:03:04:05:06', internal: false, cidr: '192.168.1.8/24' }]
    })).toBe(true);
    expect(hasActiveNetworkInterface({
      Loopback: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }]
    })).toBe(false);
    expect(networkInterfaces).not.toHaveBeenCalled();
  });

  it('reads disk capacity through native statfs instead of a Windows WMI query', async () => {
    vi.useFakeTimers();
    resolveBaseMetrics();
    currentLoad.mockResolvedValue({ currentLoad: 12, cpus: [{}, {}] });
    const monitor = new ResourceMonitor('win32', vi.fn().mockResolvedValue(null));

    monitor.start(10);
    await vi.advanceTimersByTimeAsync(1);
    expect(statfs).toHaveBeenCalledWith(join('/tmp/test-userData', 'aibox-data'));
    monitor.stop();
  });
});
