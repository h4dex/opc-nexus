/**
 * Electron 主进程入口
 * 跨平台：Windows 10/11 + Ubuntu 22.04+（PRD 4.1 首发 Windows，Linux 同架构兼容）
 */
import { app, BrowserWindow, Menu, nativeImage, protocol, screen, shell, Tray } from 'electron';
import { randomUUID } from 'node:crypto';
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
import { ILINK_QUIT_CLEANUP_BUDGET_MS } from './services/channels/ilinkClient.js';
import { ResourceMonitor } from './services/resourceMonitor.js';
import { Scheduler } from './services/scheduler.js';
import { notify } from './services/notifier.js';
import { seedIfEmpty, seedMcpServers, seedSkills } from './services/seed.js';
import { importCredentialsBootstrap, importProviderFromUserConfig } from './services/bootstrap.js';
import { migrateLegacyProvider } from './services/provider.js';
import { loadUserConfig } from './services/userConfig.js';
import { WecomWebhookNotifier } from './services/wecomWebhook.js';
import { McpManager } from './services/mcpManager.js';
import { SkillManager } from './services/skillManager.js';
import { ProviderManager } from './services/providerManager.js';
import { WorkflowEngine } from './services/workflowEngine.js';
import { WfPlatformManager } from './services/wfPlatformManager.js';
import { TeamEngine } from './services/teamEngine.js';
import { ProjectManager } from './services/projectManager.js';
import { DeliverableManager } from './services/deliverableManager.js';
import { KnowledgeManager } from './services/knowledgeManager.js';
import { DiscoveryManager } from './services/discoveryManager.js';
import { AutomationManager } from './services/automationManager.js';
import { CollabManager } from './services/collabManager.js';
import { WebServer } from './services/webServer.js';
import { ApiBridge } from './services/apiBridge.js';
import { MobileGatewayService } from './services/mobileGatewayService.js';
import { MobileAdbService } from './services/mobileAdbService.js';
import { ChannelControlPlane } from './services/channelControlPlane.js';
import { DesktopControlPlane } from './services/desktopControlPlane.js';
import { DesktopIngressService } from './services/desktopIngressService.js';
import { MemoryService } from './services/memoryService.js';
import { MemoryProposalService } from './services/memoryProposalService.js';
import { TaskScheduleProposalService } from './services/taskScheduleProposalService.js';
import { HermesRuntimeProfileService } from './services/hermesRuntimeProfile.js';
import { DatabaseKernelState } from './services/kernel/databaseKernelState.js';
import { DeepSeekPlanningAdvisor } from './services/kernel/deepseekPlanningAdvisor.js';
import { HermesControlKernel } from './services/kernel/hermesControlKernel.js';
import { KernelRouter } from './services/kernel/kernelRouter.js';
import { NexusControlKernel } from './services/kernel/nexusControlKernel.js';
import { registerIpc } from './ipc.js';

protocol.registerSchemesAsPrivileged([{
  scheme: 'aibox-mobile',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}]);

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
let mcpRef: McpManager | null = null;
let browserRef: import('./services/browserManager.js').BrowserManager | null = null;
let mobileRef: MobileGatewayService | null = null;
let webServerRef: WebServer | null = null;
let monitorRef: ResourceMonitor | null = null;
let weixinRef: WeixinChannel | null = null;
let feishuRef: FeishuChannel | null = null;
let ocrRef: import('./services/ocrService.js').OcrService | null = null;
/** 语音服务引用：退出时需关闭活跃会话，避免麦克风与云端连接残留 */
let voiceRef: import('./services/voiceService.js').VoiceService | null = null;

const isDev = !!process.env.ELECTRON_RENDERER_URL;

function registerMobileProtocol(mobile: MobileGatewayService): void {
  void protocol.handle('aibox-mobile', (request) => {
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    let url: URL;
    try { url = new URL(request.url); } catch { return new Response('Bad request', { status: 400 }); }
    const id = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) return new Response('Not found', { status: 404 });
    const value = url.hostname === 'pairing'
      ? mobile.getPairingImage(id)
      : url.hostname === 'preview'
        ? mobile.getPreview(id)
        : url.hostname === 'artifact'
          ? mobile.getArtifactFile(id)
          : null;
    if (!value) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    return new Response(new Uint8Array(value.data), {
      status: 200,
      headers: {
        'content-type': value.mimeType,
        'content-length': String(value.data.length),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      }
    });
  });
}

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
  const providerManager = new ProviderManager(db, (change) => engines.invalidateProviderVerification(change));
  const executors = new ExecutorRegistry(db, broker, providerManager);
  const orchestrator = new Orchestrator(db, executors, broker);
  const scheduler = new Scheduler(db, orchestrator);
  const kernelState = new DatabaseKernelState(db);
  const memory = new MemoryService(db);
  const memoryProposals = new MemoryProposalService(db, memory);
  memoryProposals.recoverCommitted();
  const taskScheduleProposals = new TaskScheduleProposalService(db, scheduler);
  taskScheduleProposals.recoverCommitted();
  const kernelRouter = new KernelRouter(
    new HermesControlKernel(db, new HermesRuntimeProfileService(db, providerManager), kernelState, undefined, engines),
    new NexusControlKernel(),
    [new DeepSeekPlanningAdvisor(db)],
    kernelState
  );
  const channelControlPlane = new ChannelControlPlane(
    db, orchestrator, kernelRouter, memory, kernelState, memoryProposals, taskScheduleProposals
  );
  const desktopIngress = new DesktopIngressService(db);
  const desktopControlPlane = new DesktopControlPlane(db, desktopIngress, channelControlPlane);
  orchestrator.onTaskFinished(({ taskId }) => desktopIngress.recordTaskOutcome(taskId));
  const mobile = new MobileGatewayService(db);
  const mobileAdb = new MobileAdbService();
  mobileRef = mobile;
  registerMobileProtocol(mobile);
  executors.setMobileGateway(mobile);
  orchestrator.setMobileDispatchPolicy({
    canDispatch: (agentId) => mobile.canDispatch(agentId),
    releaseAgent: (agentId) => mobile.unbindAgent(agentId)
  });
  mobile.onEvent((event) => {
    if (event.agentId && ['device_connected', 'binding_changed', 'session_ended'].includes(event.type)) {
      orchestrator.wakeAgentQueue(event.agentId);
    }
  });
  const monitor = new ResourceMonitor();
  monitorRef = monitor;
  monitor.setDatabase(db);
  const mcpManager = new McpManager(db);
  mcpRef = mcpManager;
  const skillManager = new SkillManager(db);
  const wfPlatformMgr = new WfPlatformManager(db);
  const workflowEngine = new WorkflowEngine(db, providerManager, wfPlatformMgr);
  const projectManager = new ProjectManager(db);
  const deliverableManager = new DeliverableManager(db);
  const knowledgeManager = new KnowledgeManager(db);
  const automationManager = new AutomationManager(db, { projects: projectManager, deliverables: deliverableManager });
  scheduler.setAutomationHandler((kind, projectId, scheduleId) => {
    automationManager.run(kind, projectId, 'scheduled', scheduleId);
  });
  const teamEngine = new TeamEngine(db, orchestrator, knowledgeManager);
  const discoveryManager = new DiscoveryManager(db, {
    projects: projectManager, deliverables: deliverableManager, knowledge: knowledgeManager, teams: teamEngine, automation: automationManager
  });
  const collabManager = new CollabManager(db);
  const feishu = new FeishuChannel(db, orchestrator, channelControlPlane);
  feishuRef = feishu;
  const wecom = new WecomChannel(db, orchestrator, channelControlPlane);
  const weixin = new WeixinChannel(db, orchestrator, { taskPlanner: channelControlPlane });
  weixinRef = weixin;

  // 工具循环的委派能力（P3b）与调度保护门禁（11.2）注入
  executors.setToolHost(orchestrator.toolHost());
  executors.setMcpManager(mcpManager);
  // 浏览器自动化管理器（Playwright/CDP）注入
  const { BrowserManager } = await import('./services/browserManager.js');
  const browserMgr = new BrowserManager();
  browserRef = browserMgr;
  executors.setBrowserManager(browserMgr);
  // OCR 服务（PaddleOCR WASM）注入
  const { OcrService } = await import('./services/ocrService.js');
  const ocrService = new OcrService(db);
  ocrRef = ocrService;
  executors.setOcrService(ocrService);
  // 语音任务下达服务（云端 NLS / 本地模型双路；凭据留在主进程）
  const { VoiceService } = await import('./services/voiceService.js');
  const voiceService = new VoiceService(db);
  voiceRef = voiceService;
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
  knowledgeManager.syncAcceptedDeliverables(deliverableManager);
  // 凭据引导文件自动导入（credentials.bootstrap.json → safeStorage，导入后重命名）
  importCredentialsBootstrap(db);
  // 兼容迁移：旧版 settings provider:hermes（历史键名）→ providers 表；运行时统一使用 Nexus/Provider ID
  migrateLegacyProvider(db);
  // user/config.yaml 的 provider 段 → providers 表 + safeStorage
  // 顺序在 migrateLegacyProvider 之后：文件是用户显式意图，优先级高于历史迁移值
  importProviderFromUserConfig(db);
  // 用户配置文件 user/config.yaml（不存在则生成模板）：企微凭据导入 safeStorage
  const userCfg = loadUserConfig();
  if (userCfg.wecom.botId && userCfg.wecom.secret) {
    try {
      wecom.saveCredentials(userCfg.wecom.botId, userCfg.wecom.secret);
    } catch {
      /* 密钥库不可用时跳过，渠道页可手动配置 */
    }
  }
  // 数据保留策略：启动 + 每 24h 清理（任务 90 天 / 资源 7 天 / 审计 1 年）
  db.cleanupRetention();
  setInterval(() => db.cleanupRetention(), 24 * 3_600_000);
  monitor.start(4000);
  scheduler.start();
  const mobileGatewayConfig = db.getSetting<{ enabled?: boolean; host?: string; port?: number }>('mobile:gateway', {});
  if (mobileGatewayConfig.enabled && mobileGatewayConfig.host) {
    void mobile.start(mobileGatewayConfig.host, mobileGatewayConfig.port).catch((error) => {
      console.error('[MobileGateway] 自动启动失败:', error);
    });
  }
  // 真实渠道凭据已配置且非停用 → 启动时自动重连（飞书 / 企微长连接 / 微信 iLink 长轮询）
  {
    const reconnectable = ['ONLINE', 'CONNECTING', 'RECONNECTING'];
    const statusOf = (id: string) =>
      (db.raw.prepare('SELECT status FROM channels WHERE id = ?').get(id) as { status: string } | undefined)?.status ?? '';
    if (reconnectable.includes(statusOf('ch-feishu'))) void feishu.connect();
    // 企微：config.yaml 提供了凭据时首次也自动连（UNCONFIGURED → 直接建立长连接）
    const wecomStatus = statusOf('ch-wecom');
    if (reconnectable.includes(wecomStatus) || (userCfg.wecom.botId && userCfg.wecom.secret && wecomStatus !== 'DISABLED')) void wecom.connect();
    if (reconnectable.includes(statusOf('ch-weixin'))) void weixin.connect();
  }

  // 企微 webhook 通知（config.yaml wecom.webhookUrl；仅推送任务完成结果）
  const webhookNotifier = new WecomWebhookNotifier();
  orchestrator.onTaskFinished((info) => {
    if (info.status !== 'COMPLETED') return;
    const agent = db.raw.prepare('SELECT name FROM agents WHERE id = ?').get(info.agentId) as { name: string } | undefined;
    webhookNotifier.notifyTaskCompleted(info.title, agent?.name ?? '数字员工', info.result);
  });

  // 本地 API Bridge（反向代理，供 Claude Code/Codex 等引擎使用）
  const apiBridge = new ApiBridge(db, providerManager);
  if (db.getSetting<string>('bridge_enabled', 'false') === 'true') {
    try {
      await apiBridge.toggle(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ApiBridge] 自动启动失败，服务保持关闭: ${message}`);
      db.audit({ id: randomUUID(), actor: 'system', action: 'bridge.start', target: 'api-bridge', result: 'start-error' });
    }
  }

  // 局域网 Web 管理服务器（工控机远程管理）
  const webServer = new WebServer({ db, orchestrator, engines, channels, providers: providerManager, mcp: mcpManager, skills: skillManager, teams: teamEngine, desktopControlPlane });
  webServerRef = webServer;

  const { pushSnapshot } = registerIpc({ db, orchestrator, desktopControlPlane, executors, engines, channels, feishu, wecom, weixin, scheduler, broker, monitor, mcp: mcpManager, skills: skillManager, providers: providerManager, workflows: workflowEngine, projects: projectManager, deliverables: deliverableManager, knowledge: knowledgeManager, automation: automationManager, discovery: discoveryManager, teams: teamEngine, wfPlatforms: wfPlatformMgr, collab: collabManager, ocr: ocrService, voice: voiceService, apiBridge, webServer, mobile, mobileAdb, memory, memoryProposals, taskScheduleProposals, getMainWindow: () => mainWindow });

  // Detect after IPC registration so the completed engine state is pushed to
  // an already-open Renderer instead of remaining at the seeded placeholder.
  void engines.detect().then(() => {
    pushSnapshot();
    orchestrator.startScheduler();
    teamEngine.recoverOrResume(); // 引擎就绪后续跑中断的专家团流水线（可恢复状态机）
  });

  try {
    await webServer.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[WebServer] 启动失败，服务保持关闭: ${message}`);
    db.audit({ id: randomUUID(), actor: 'system', action: 'webserver.start', target: 'web-admin', result: 'failed' });
  }

  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitCleanupStarted = false;

function waitForQuitCleanup(cleanup: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, ILINK_QUIT_CLEANUP_BUDGET_MS);
    void cleanup.then(finish, finish);
  });
}

app.on('before-quit', (event) => {
  isQuitting = true;
  if (!quitCleanupStarted) {
    event.preventDefault();
    quitCleanupStarted = true;
    void waitForQuitCleanup(weixinRef?.dispose() ?? Promise.resolve()).finally(() => {
      try { dbRef?.flush(); } catch { /* 退出前尽力落盘 */ }
      app.quit();
    });
  }
  try {
    mcpRef?.dispose();
    browserRef?.dispose();
    mobileRef?.dispose();
    feishuRef?.dispose();
    ocrRef?.dispose();
    webServerRef?.stop();
    monitorRef?.stop();
  } catch {
    /* 关闭失败不阻塞退出 */
  }
  try {
    voiceRef?.stopAll(); // 关闭活跃语音会话，停止拾音与云端连接
  } catch {
    /* 关闭失败不阻塞退出 */
  }
  try {
    if (quitCleanupStarted && !event.defaultPrevented) dbRef?.flush();
  } catch {
    /* 退出前尽力落盘 */
  }
});

app.on('window-all-closed', () => {
  // 托盘常驻，不因窗口关闭退出（macOS 约定一致）
});
