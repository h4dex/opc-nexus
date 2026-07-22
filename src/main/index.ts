/**
 * Electron 主进程入口
 * 跨平台：Windows 10/11 + Ubuntu 22.04+（PRD 4.1 首发 Windows，Linux 同架构兼容）
 */
import { app, BrowserWindow, Menu, nativeImage, shell, Tray } from 'electron';
import { join } from 'node:path';
import { Database } from './services/database.js';
import { Orchestrator } from './services/orchestrator.js';
import { ExecutorRegistry } from './services/executor/index.js';
import { ApprovalBroker } from './services/approvalBroker.js';
import { EngineManager } from './services/engineManager.js';
import { ChannelManager } from './services/channelManager.js';
import { FeishuChannel } from './services/channels/feishuChannel.js';
import { WecomChannel } from './services/channels/wecomChannel.js';
import { WeixinChannel } from './services/channels/wechatChannel.js';
import { ResourceMonitor } from './services/resourceMonitor.js';
import { Scheduler } from './services/scheduler.js';
import { notify } from './services/notifier.js';
import { seedIfEmpty } from './services/seed.js';
import { importCredentialsBootstrap } from './services/bootstrap.js';
import { McpManager } from './services/mcpManager.js';
import { SkillManager } from './services/skillManager.js';
import { ProviderManager } from './services/providerManager.js';
import { WorkflowEngine } from './services/workflowEngine.js';
import { TeamEngine } from './services/teamEngine.js';
import { registerIpc } from './ipc.js';

// 单实例锁：防止多开导致 SQLite 争用与重复调度
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWindow;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let dbRef: Database | null = null;

const isDev = !!process.env.ELECTRON_RENDERER_URL;

function createWindow() {
  // 窗口状态记忆：从 settings 恢复上次位置/大小/全屏
  const saved = dbRef?.getSetting<{ x?: number; y?: number; width?: number; height?: number; fullscreen?: boolean } | null>('windowState', null) ?? null;
  mainWindow = new BrowserWindow({
    width: saved?.width ?? 1440,
    height: saved?.height ?? 900,
    ...(saved?.x !== undefined && saved?.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 1180,   // 6.1：最小窗口 1180×720
    minHeight: 720,
    title: '数字员工 AI Box',
    backgroundColor: '#0f1218',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,      // 12.2 安全基线
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (saved?.fullscreen) mainWindow?.setFullScreen(true);
  });

  // 外部链接一律走系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // 关闭时最小化到托盘（控制中心常驻）+ 保存窗口状态
  mainWindow.on('close', (e) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const bounds = mainWindow.getBounds();
      dbRef?.setSetting('windowState', { ...bounds, fullscreen: mainWindow.isFullScreen() });
    }
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  if (isDev) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL!);
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
}

function createTray() {
  // 16×16 单色占位图标，避免依赖外部资源
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWElEQVR4nGNgGAWDHjAyMDAw/P//nxGXAkZGxn9oEhAbGWm0CJqGhoaGhvg3UHSMIUaNoBmRkZERXBQ0DY2MjIyM4m+gihtDjBpBMyIjIyO4KGgaGkODAAYGAPJpAh9rDsGxAAAAAElFTkSuQmCC'
  );
  tray = new Tray(icon);
  tray.setToolTip('数字员工 AI Box');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开控制台', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { type: 'separator' },
      { label: '退出', click: () => { isQuitting = true; app.quit(); } }
    ])
  );
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

app.whenReady().then(async () => {
  const db = await Database.create();
  dbRef = db;
  const broker = new ApprovalBroker(db);
  const engines = new EngineManager(db);
  const channels = new ChannelManager(db);
  const providerManager = new ProviderManager(db);
  const executors = new ExecutorRegistry(db, broker, providerManager);
  const orchestrator = new Orchestrator(db, executors, broker);
  const monitor = new ResourceMonitor();
  const scheduler = new Scheduler(db, orchestrator);
  const mcpManager = new McpManager(db);
  const skillManager = new SkillManager(db);
  const workflowEngine = new WorkflowEngine(db, orchestrator);
  const teamEngine = new TeamEngine(db, orchestrator);
  const feishu = new FeishuChannel(db, orchestrator);
    const wecom = new WecomChannel(db, orchestrator, broker);
    const weixin = new WeixinChannel(db, orchestrator, broker);

  // 工具循环的委派能力（P3b）与调度保护门禁（11.2）注入
  executors.setToolHost(orchestrator.toolHost());
  orchestrator.setDispatchGuard(() => monitor.getGuardReason());
  // 阈值来自设置页（settings.thresholds）；新告警边沿推系统通知
  monitor.setThresholdProvider(() => {
    const t = db.getSetting<{ cpu?: number; mem?: number; gpuTemp?: number }>('thresholds', {});
    return { cpu: t.cpu ?? 85, mem: t.mem ?? 85, gpuTemp: t.gpuTemp ?? 85 };
  });
  monitor.onAlert((message) => notify(db, '资源告警', message));

  engines.ensureBuiltinEngines();
  channels.ensureChannels();
  // 先执行崩溃恢复（清理上次异常遗留），再写入种子数据（首次启动），避免种子任务被误标 INTERRUPTED
  orchestrator.recoverAfterRestart();
  seedIfEmpty(db);
  // 凭据引导文件自动导入（credentials.bootstrap.json → safeStorage，导入后重命名）
  importCredentialsBootstrap(db);
  // 数据保留策略：启动 + 每 24h 清理（任务 90 天 / 资源 7 天 / 审计 1 年）
  db.cleanupRetention();
  setInterval(() => db.cleanupRetention(), 24 * 3_600_000);
  // 启动时真实检测本机 CLI（where/which + --version）与供应商配置，完成后再接管/调度任务
  void engines.detect().then(() => orchestrator.startScheduler());
  monitor.start(4000);
  scheduler.start();
  // 真实渠道凭据已配置且非停用 → 启动时自动重连（飞书 / 企微长连接 / 个微桥接）
  {
    const reconnectable = ['ONLINE', 'CONNECTING', 'RECONNECTING'];
    const statusOf = (id: string) =>
      (db.raw.prepare('SELECT status FROM channels WHERE id = ?').get(id) as { status: string } | undefined)?.status ?? '';
    if (reconnectable.includes(statusOf('ch-feishu'))) void feishu.connect();
    if (reconnectable.includes(statusOf('ch-wecom'))) void wecom.connect();
    if (reconnectable.includes(statusOf('ch-weixin'))) void weixin.connect();
  }

  registerIpc({ db, orchestrator, executors, engines, channels, feishu, wecom, weixin, scheduler, broker, monitor, mcp: mcpManager, skills: skillManager, providers: providerManager, workflows: workflowEngine, teams: teamEngine, getMainWindow: () => mainWindow });

  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  try {
    dbRef?.flush();
  } catch {
    /* 退出前尽力落盘 */
  }
});

app.on('window-all-closed', () => {
  // 托盘常驻，不因窗口关闭退出（macOS 约定一致）
});
