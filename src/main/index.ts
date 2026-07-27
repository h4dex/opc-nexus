/**
 * Electron 主进程入口
 * 跨平台：Windows 10/11 + Ubuntu 22.04+（PRD 4.1 首发 Windows，Linux 同架构兼容）
 */
import { app, BrowserWindow, Menu, nativeImage, screen, shell, Tray } from 'electron';
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
import { seedIfEmpty, seedMcpServers, seedSkills } from './services/seed.js';
import { importCredentialsBootstrap } from './services/bootstrap.js';
import { McpManager } from './services/mcpManager.js';
import { SkillManager } from './services/skillManager.js';
import { ProviderManager } from './services/providerManager.js';
import { WorkflowEngine } from './services/workflowEngine.js';
import { WfPlatformManager } from './services/wfPlatformManager.js';
import { TeamEngine } from './services/teamEngine.js';
import { ProjectManager } from './services/projectManager.js';
import { DeliverableManager } from './services/deliverableManager.js';
import { CollabManager } from './services/collabManager.js';
import { WebServer } from './services/webServer.js';
import { ApiBridge } from './services/apiBridge.js';
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
  const display = saved?.x !== undefined && saved?.y !== undefined
    ? screen.getDisplayMatching({ x: saved.x, y: saved.y, width: saved.width ?? 1440, height: saved.height ?? 900 })
    : screen.getPrimaryDisplay();
  const work = display.workArea;
  const minWidth = Math.min(900, work.width);
  const minHeight = Math.min(600, work.height);
  const width = Math.min(Math.max(saved?.width ?? 1440, minWidth), work.width);
  const height = Math.min(Math.max(saved?.height ?? 900, minHeight), work.height);
  const x = saved?.x === undefined ? undefined : Math.min(Math.max(saved.x, work.x), work.x + work.width - width);
  const y = saved?.y === undefined ? undefined : Math.min(Math.max(saved.y, work.y), work.y + work.height - height);
  mainWindow = new BrowserWindow({
    width,
    height,
    ...(x !== undefined && y !== undefined ? { x, y } : {}),
    minWidth,
    minHeight,
    title: '数字员工 AI Box',
    backgroundColor: '#0f1218',
    ...((): { icon?: string } => {
      const p = join(app.getAppPath(), 'build', 'icon.png');
      return { icon: p };
    })(),
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
  // 优先加载品牌图标（build/icon.png，随包分发），加载失败降级为内置占位图
  const placeholder = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWElEQVR4nGNgGAWDHjAyMDAw/P//nxGXAkZGxn9oEhAbGWm0CJqGhoaGhvg3UHSMIUaNoBmRkZERXBQ0DY2MjIyM4m+gihtDjBpBMyIjIyO4KGgaGkODAAYGAPJpAh9rDsGxAAAAAElFTkSuQmCC'
  );
  let icon = placeholder;
  for (const candidate of [join(app.getAppPath(), 'build', 'icon.png'), join(import.meta.dirname, '../../build/icon.png')]) {
    const img = nativeImage.createFromPath(candidate);
    if (!img.isEmpty()) { icon = img; break; }
  }
  // 托盘使用 16x16（Windows）/ 22x22（Linux）
  icon = icon.resize({ width: 16, height: 16 });
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
  monitor.setDatabase(db);
  const scheduler = new Scheduler(db, orchestrator);
  const mcpManager = new McpManager(db);
  const skillManager = new SkillManager(db);
  const wfPlatformMgr = new WfPlatformManager(db);
  const workflowEngine = new WorkflowEngine(db, providerManager, wfPlatformMgr);
  const projectManager = new ProjectManager(db);
  const deliverableManager = new DeliverableManager(db);
  const teamEngine = new TeamEngine(db, orchestrator);
  const collabManager = new CollabManager(db);
  const feishu = new FeishuChannel(db, orchestrator);
    const wecom = new WecomChannel(db, orchestrator, broker);
    const weixin = new WeixinChannel(db, orchestrator, broker);

  // 工具循环的委派能力（P3b）与调度保护门禁（11.2）注入
  executors.setToolHost(orchestrator.toolHost());
  // 浏览器自动化管理器（Playwright/CDP）注入
  const { BrowserManager } = await import('./services/browserManager.js');
  const browserMgr = new BrowserManager();
  executors.setBrowserManager(browserMgr);
  // OCR 服务（PaddleOCR WASM）注入
  const { OcrService } = await import('./services/ocrService.js');
  const ocrService = new OcrService(db);
  executors.setOcrService(ocrService);
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
  // 注：团队流水线的中断续跑（recoverOrResume）延迟到引擎就绪后执行，见下方 engines.detect 回调
  seedIfEmpty(db);
  seedMcpServers(db);
  seedSkills(db);
  // 凭据引导文件自动导入（credentials.bootstrap.json → safeStorage，导入后重命名）
  importCredentialsBootstrap(db);
  // 数据保留策略：启动 + 每 24h 清理（任务 90 天 / 资源 7 天 / 审计 1 年）
  db.cleanupRetention();
  setInterval(() => db.cleanupRetention(), 24 * 3_600_000);
  // 启动时真实检测本机 CLI（where/which + --version）与供应商配置，完成后再接管/调度任务，并续跑中断的团队流水线
  void engines.detect().then(() => {
    orchestrator.startScheduler();
    teamEngine.recoverOrResume(); // 引擎就绪后续跑中断的专家团流水线（可恢复状态机）
  });
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

  // 本地 API Bridge（反向代理，供 Claude Code/Codex 等引擎使用）
  const apiBridge = new ApiBridge(db, providerManager);
  if (db.getSetting<string>('bridge_enabled', 'false') === 'true') apiBridge.start();

  // 局域网 Web 管理服务器（工控机远程管理）
  const webServer = new WebServer({ db, orchestrator, engines, channels, providers: providerManager, mcp: mcpManager, skills: skillManager, teams: teamEngine });

  registerIpc({ db, orchestrator, executors, engines, channels, feishu, wecom, weixin, scheduler, broker, monitor, mcp: mcpManager, skills: skillManager, providers: providerManager, workflows: workflowEngine, projects: projectManager, deliverables: deliverableManager, teams: teamEngine, wfPlatforms: wfPlatformMgr, collab: collabManager, ocr: ocrService, apiBridge, webServer, getMainWindow: () => mainWindow });

  webServer.start();

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
