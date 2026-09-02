/**
 * Electron 主进程入口
 * 跨平台：Windows 10/11 + Ubuntu 22.04+（PRD 4.1 首发 Windows，Linux 同架构兼容）
 */
import { app, BrowserWindow, Menu, nativeImage, protocol, screen, shell, Tray } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
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
import {
  purgeDemoData,
  purgeRetiredProductState,
  purgeRetiredRuntimeDirectories,
  seedMcpServers,
  ensureBuiltinSkills
} from './services/seed.js';
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
import { ApiBridge } from './services/apiBridge.js';
import { MobileGatewayService } from './services/mobileGatewayService.js';
import { MobileAdbService } from './services/mobileAdbService.js';
import { ChannelControlPlane } from './services/channelControlPlane.js';
import { DesktopControlPlane } from './services/desktopControlPlane.js';
import { DesktopIngressService } from './services/desktopIngressService.js';
import { MemoryService } from './services/memoryService.js';
import { MemoryProposalService } from './services/memoryProposalService.js';
import { TaskScheduleProposalService } from './services/taskScheduleProposalService.js';
import { DatabaseKernelState } from './services/kernel/databaseKernelState.js';
import { HermesIngressKernel } from './services/kernel/hermesIngressKernel.js';
import { KernelRouter } from './services/kernel/kernelRouter.js';
import { LocalCliDispatchAdapter } from './services/kernel/localCliDispatchAdapter.js';
import { registerIpc } from './ipc.js';
import { isAllowedExternalUrl, isAllowedMainNavigation } from './services/navigationPolicy.js';
import { PluginCatalogService } from './services/pluginCatalog.js';
import { EnvironmentDiagnosticsService } from './services/environmentDiagnostics.js';
import { ProjectWorkbenchService } from './services/projectWorkbench.js';
import {
  NEXUS_VISION_PLUGIN_MANIFEST,
  VISION_OCR_TOOL_CAPABILITY_ID,
  VISION_TOOL_CAPABILITY_ID,
  VisionService
} from './services/visionService.js';
import { CapabilityRegistry, PluginHost } from './services/pluginHost.js';
import { HostPolicyBroker } from './services/hostPolicyBroker.js';
import {
  createHostPluginPermissionResolver,
  resolveBuiltinHostPolicy
} from './services/hostPluginPolicy.js';
import { ARTIFACT_PROTOCOL_SCHEME, ArtifactRefService } from './services/artifactRef.js';
import { registerArtifactProtocol } from './services/artifactProtocol.js';
import {
  PROJECT_ARTIFACT_PROTOCOL_SCHEME,
  ProjectArtifactService,
  registerProjectArtifactProtocol
} from './services/projectArtifactService.js';
import { ProjectArtifactManifestService, readTaskArtifactManifest } from './services/projectArtifactManifest.js';
import {
  ArtifactRuntimeManager,
  type ArtifactRuntimeCaptureInput
} from './services/artifactRuntimeManager.js';
import { NEXUS_ENGINE_ID, type AgentCapabilities, type AgentMemoryMode, type PermissionMode, type ProjectArtifactScreenshotEvidence } from '../shared/types.js';
import { QuestWindowManager } from './services/questWindowManager.js';
import { parseQuestLaunchRequest, QuestLaunchCoordinator } from './services/questLaunch.js';
import { HermesServiceManager, resolveHermesRuntimeLaunch } from './services/hermesServiceManager.js';
import { HermesWorkbenchWindowManager } from './services/hermesWorkbenchWindow.js';
import { HermesEmbeddedWorkbenchManager } from './services/hermesEmbeddedWorkbench.js';
import { HermesGovernanceBridge } from './services/hermesGovernanceBridge.js';
import { HermesChannelRouter } from './services/hermesChannelRouter.js';
import { HermesMobileGatewayService } from './services/hermesMobileGateway.js';
import { HermesConversationAttachmentService } from './services/hermesConversationAttachmentService.js';
import { HermesConversationContext } from './services/hermesConversationContext.js';
import { assertHermesPlanDraft } from './services/hermesProtocol.js';
import { AgentMentionResolver } from './services/agentMentionResolver.js';
import { HermesEmployeeDispatcher } from './services/hermesEmployeeDispatcher.js';
import { HermesAcceptanceCoordinator } from './services/hermesAcceptanceCoordinator.js';
import { HermesProjectPluginBridge } from './services/hermesProjectPluginBridge.js';
import { HermesToolBridge } from './services/hermesToolBridge.js';
import { DebugLogService } from './services/debugLogService.js';
import { parseHermesValidationVerdict } from './services/hermesDeliveryGate.js';
import { isLegacyBootstrappedCordisAgent } from './services/legacyCordisMigration.js';
import { parseQuestSlashCommand, resolveQuestSlashCommand } from './services/questSlashCommand.js';
import { resolveEngineProvider } from './services/engineEnv.js';

// Set the native application identity before any notification or window is created.
// In development Electron otherwise uses the fallback name `electron.app`, which
// leaks into Windows toast notification titles instead of the product name.
const PRODUCT_NAME = '数字员工 AI Box';
app.setName(PRODUCT_NAME);
if (process.platform === 'win32') {
  app.setAppUserModelId('com.senke.aibox');
}

if (process.env.AIBOX_DISABLE_HARDWARE_ACCELERATION === '1') {
  app.disableHardwareAcceleration();
}

const userDataArgument = process.argv.find((argument) => argument.startsWith('--aibox-user-data='));
const userDataOverride = process.env.AIBOX_USER_DATA_DIR?.trim()
  || userDataArgument?.slice('--aibox-user-data='.length).trim();
if (userDataOverride) {
  if (userDataOverride.length > 4_096 || /[\u0000-\u001f\u007f]/.test(userDataOverride)) {
    throw new Error('AIBOX_USER_DATA_DIR is invalid');
  }
  const userDataPath = resolve(userDataOverride);
  mkdirSync(userDataPath, { recursive: true });
  app.setPath('userData', userDataPath);
}

const nodeRequire = createRequire(import.meta.url);

/**
 * The product name changed after the first desktop releases, which changed
 * Electron's default userData folder from `aibox-control-center` to the
 * localized product name. Preserve an existing user's database and Hermes
 * files when the new folder is still empty. Explicit test/user-data overrides
 * are never redirected to another folder.
 */
async function migrateLegacyUserDataIfEmpty(): Promise<void> {
  if (userDataOverride) return;
  const currentRoot = resolve(app.getPath('userData'));
  const legacyRoot = resolve(join(app.getPath('appData'), 'aibox-control-center'));
  if (currentRoot.toLowerCase() === legacyRoot.toLowerCase()) return;

  const legacyData = join(legacyRoot, 'aibox-data');
  const legacyDb = join(legacyData, 'aibox.db');
  if (!existsSync(legacyDb)) return;

  const currentData = join(currentRoot, 'aibox-data');
  const currentDb = join(currentData, 'aibox.db');
  let currentHasUserData = false;
  if (existsSync(currentDb)) {
    try {
      const wasmPath = nodeRequire.resolve('sql.js/dist/sql-wasm.wasm');
      const SQL = await initSqlJs({ locateFile: () => wasmPath });
      const current = new SQL.Database(new Uint8Array(readFileSync(currentDb)));
      const row = current.exec(`
        SELECT
          (SELECT COUNT(*) FROM projects),
          (SELECT COUNT(*) FROM agents WHERE archived = 0),
          (SELECT COUNT(*) FROM tasks)
      `)[0]?.values[0] as unknown[] | undefined;
      currentHasUserData = row?.some((value) => Number(value) > 0) === true;
      current.close();
    } catch {
      // Do not replace an unreadable database automatically; Database.create
      // has its own corruption backup and recovery path.
      return;
    }
  }
  if (currentHasUserData) return;

  const backupData = `${currentData}.before-legacy-migration-${Date.now()}`;
  try {
    mkdirSync(currentRoot, { recursive: true });
    if (existsSync(currentData)) renameSync(currentData, backupData);
    // Copy the database explicitly first. Windows can report a recursive
    // directory copy as successful while skipping a locked/large SQLite file;
    // losing the database here would make a valid legacy install look empty.
    mkdirSync(currentData, { recursive: true });
    copyFileSync(legacyDb, currentDb);
    for (const entry of readdirSync(legacyData, { withFileTypes: true })) {
      if (entry.name === 'aibox.db' || entry.isSymbolicLink()) continue;
      const source = join(legacyData, entry.name);
      const target = join(currentData, entry.name);
      if (entry.isDirectory()) cpSync(source, target, { recursive: true, force: false, errorOnExist: false });
      else copyFileSync(source, target);
    }
    console.info(`[DataMigration] migrated legacy user data: ${legacyRoot} -> ${currentRoot}`);
  } catch (error) {
    if (existsSync(backupData) && !existsSync(currentData)) {
      try { renameSync(backupData, currentData); } catch { /* preserve original error */ }
    }
    console.error(`[DataMigration] legacy user data migration failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'aibox-mobile',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  },
  {
    scheme: ARTIFACT_PROTOCOL_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  },
  {
    scheme: PROJECT_ARTIFACT_PROTOCOL_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }
]);

const startupQuestLaunch = parseQuestLaunchRequest([
  ...process.argv,
  ...(process.env.AIBOX_QUEST_ONLY === '1' ? ['--quest-only'] : []),
  ...(process.env.AIBOX_QUEST_PROJECT ? [`--quest-project=${process.env.AIBOX_QUEST_PROJECT}`] : [])
]);
let lastQuestProjectId = startupQuestLaunch?.projectId ?? null;
let questWindowRef: QuestWindowManager | null = null;
let resolveQuestLaunchProject = (projectId: string | null): string | null => projectId;
let desktopSurfaceReady = false;
let pendingMainWindowRequest = false;
const questLaunchCoordinator = new QuestLaunchCoordinator((error, projectId) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Quest] Failed to open project ${projectId ?? '(automatic)'}: ${message}`);
});
if (startupQuestLaunch) void questLaunchCoordinator.request(startupQuestLaunch.projectId);

// 单实例锁：防止多开导致 SQLite 争用与重复调度
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const questRequest = parseQuestLaunchRequest(argv);
    if (questRequest) {
      void questLaunchCoordinator.request(questRequest.projectId);
      return;
    }
    requestMainSurface();
  });
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let dbRef: Database | null = null;
let mcpRef: McpManager | null = null;
let browserRef: import('./services/browserManager.js').BrowserManager | null = null;
let mobileRef: MobileGatewayService | null = null;
let monitorRef: ResourceMonitor | null = null;
let weixinRef: WeixinChannel | null = null;
let feishuRef: FeishuChannel | null = null;
let ocrRef: import('./services/ocrService.js').OcrService | null = null;
/** 语音服务引用：退出时需关闭活跃会话，避免麦克风与云端连接残留 */
let voiceRef: import('./services/voiceService.js').VoiceService | null = null;
let hermesRef: HermesServiceManager | null = null;
let hermesWindowRef: HermesWorkbenchWindowManager | null = null;
let hermesMobileRef: HermesMobileGatewayService | null = null;
let artifactRuntimeRef: ArtifactRuntimeManager | null = null;
let debugLogRef: DebugLogService | null = null;

async function captureArtifactPreviewScreenshots(
  input: ArtifactRuntimeCaptureInput
): Promise<ProjectArtifactScreenshotEvidence[]> {
  const url = new URL(input.url);
  const host = url.hostname.toLowerCase();
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || (host !== 'localhost' && host !== '::1' && !host.startsWith('127.'))
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.taskId)) {
    throw new Error('预览地址或任务标识无效');
  }
  const outputRelativeDirectory = `.opc-nexus/delivery/${input.taskId}`;
  const outputDirectory = join(input.projectRoot, '.opc-nexus', 'delivery', input.taskId);
  mkdirSync(outputDirectory, { recursive: true });
  const preview = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: 1440,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: true,
      backgroundThrottling: false
    }
  });
  preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  preview.webContents.on('will-navigate', (event, target) => {
    try {
      if (new URL(target).origin !== url.origin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  const wait = (ms: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, ms));
  const evidence: ProjectArtifactScreenshotEvidence[] = [];
  const capture = async (viewport: 'desktop' | 'mobile', width: number, height: number) => {
    preview.setContentSize(width, height);
    await wait(350);
    const image = await preview.webContents.capturePage();
    const bytes = image.toPNG();
    if (bytes.length < 256) throw new Error(`${viewport} 截图为空`);
    const filename = `preview-${viewport}.png`;
    const target = join(outputDirectory, filename);
    const temporary = join(outputDirectory, `.${filename}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, bytes, { flag: 'wx' });
      renameSync(temporary, target);
    } finally {
      try { rmSync(temporary, { force: true }); } catch { /* already renamed */ }
    }
    evidence.push({
      relativePath: `${outputRelativeDirectory}/${filename}`,
      viewport,
      width,
      height,
      mediaType: 'image/png',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      createdAt: Date.now()
    });
  };
  try {
    await Promise.race([
      preview.loadURL(input.url),
      wait(15_000).then(() => { throw new Error('预览页面加载超时'); })
    ]);
    await wait(800);
    await capture('desktop', 1440, 900);
    await capture('mobile', 390, 844);
    return evidence;
  } finally {
    if (!preview.isDestroyed()) preview.destroy();
  }
}

const isDev = !!process.env.ELECTRON_RENDERER_URL;

function rendererEntryUrl(): string {
  return isDev
    ? process.env.ELECTRON_RENDERER_URL!
    : pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href;
}

function rendererPreloadPath(): string {
  return join(import.meta.dirname, '../preload/index.mjs');
}

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
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: rendererPreloadPath(),
      contextIsolation: true,      // 12.2 安全基线
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (saved?.fullscreen) mainWindow?.setFullScreen(true);
  });

  const rendererEntry = rendererEntryUrl();
  const openExternal = (url: string): void => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
  };

  // 主窗口只能停留在自己的 Renderer；外部链接仅允许显式协议并交给系统浏览器。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedMainNavigation(url, rendererEntry)) return;
    event.preventDefault();
    openExternal(url);
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
    void mainWindow.loadURL(rendererEntry);
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
}

function requestMainSurface(): void {
  const main = mainWindow;
  if (main && !main.isDestroyed()) {
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
    return;
  }
  if (!desktopSurfaceReady) {
    pendingMainWindowRequest = true;
    return;
  }
  pendingMainWindowRequest = false;
  createWindow();
}

function showPrimarySurface(): void {
  const main = mainWindow;
  if (main && !main.isDestroyed()) {
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
    return;
  }
  const quest = questWindowRef?.getWindow() ?? null;
  if (quest && !quest.isDestroyed()) {
    if (quest.isMinimized()) quest.restore();
    quest.show();
    quest.focus();
    return;
  }
  if (startupQuestLaunch) {
    void questLaunchCoordinator.request(lastQuestProjectId);
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
      { label: '打开控制台', click: requestMainSurface },
      { label: '打开 Quest', click: () => { void questLaunchCoordinator.request(lastQuestProjectId); } },
      { type: 'separator' },
      { label: '退出', click: () => { isQuitting = true; app.quit(); } }
    ])
  );
  tray.on('click', showPrimarySurface);
}

app.whenReady().then(async () => {
  await migrateLegacyUserDataIfEmpty();
  const db = await Database.create();
  dbRef = db;
  const debugLogs = new DebugLogService(join(
    app.isPackaged ? dirname(app.getPath('exe')) : app.getAppPath(),
    'user',
    'logs'
  ));
  debugLogs.initialize(db.getSetting<boolean>('debug:enabled', false), db);
  debugLogRef = debugLogs;
  app.on('browser-window-created', (_event, window) => debugLogs.attachWindow(window));
  const artifactRefs = new ArtifactRefService({
    root: join(app.getPath('userData'), 'aibox-data', 'artifacts'),
    audit: (event) => db.audit({
      id: randomUUID(),
      actor: 'system',
      action: `artifact.${event.action}`,
      target: event.artifactId ?? 'artifact',
      result: event.reason ? `${event.result}:${event.reason}` : event.result
    })
  });
  registerArtifactProtocol(protocol, artifactRefs);
  const broker = new ApprovalBroker(db);
  const engines = new EngineManager(db);
  const channels = new ChannelManager(db);
  const providerManager = new ProviderManager(db, (change) => {
    engines.invalidateProviderVerification(change);
  });
  // One Main-owned adapter endpoint is shared by CLI workers. Claude Code
  // receives an Anthropic-compatible route while the bridge keeps the real
  // Provider credential and performs the OpenAI translation in Main.
  const apiBridge = new ApiBridge(db, providerManager);
  const vision = new VisionService({
    attachmentRoot: join(app.getPath('userData'), 'aibox-data', 'vision-attachments'),
    settings: db,
    providers: providerManager,
    imageInspector: {
      inspect: async (data) => {
        const sharp = (await import('sharp')).default;
        const metadata = await sharp(Buffer.from(data), { failOn: 'error' }).metadata();
        return { width: metadata.width, height: metadata.height };
      }
    }
  });
  const pluginRegistry = new CapabilityRegistry();
  pluginRegistry.register(NEXUS_VISION_PLUGIN_MANIFEST);
  const hostPolicyBroker = new HostPolicyBroker({
    resolve: resolveBuiltinHostPolicy,
    audit: (event) => db.audit({
      id: event.decisionId,
      actor: event.agentId,
      action: event.action,
      target: `${event.runtimeId}:${event.capability ?? 'invalid'}`,
      result: `${event.result}:${event.reasonCode}`,
      source: 'nexus'
    })
  });
  const pluginHost = new PluginHost(pluginRegistry, createHostPluginPermissionResolver(hostPolicyBroker, {
    // The current desktop vision IPC is a trusted local Main invocation. Remote
    // transports must supply their authenticated runtime/session policyContext.
    resolveAuthority: (request) => {
      if (request.pluginId === NEXUS_VISION_PLUGIN_MANIFEST.id
        && request.owner === 'nexus-governance'
        && (request.capabilityId === VISION_TOOL_CAPABILITY_ID
          || request.capabilityId === VISION_OCR_TOOL_CAPABILITY_ID)) {
        return {
          requestId: randomUUID(),
          organizationId: 'org-local',
          runtimeId: 'desktop-local',
          agentId: 'principal-local-admin',
          target: `plugin:${request.pluginId}/${request.capabilityId}`,
          operation: request.capabilityId
        };
      }
      return null;
    }
  }));
  pluginHost.attach(NEXUS_VISION_PLUGIN_MANIFEST.id, {
    [VISION_TOOL_CAPABILITY_ID]: vision.createToolHandler(),
    [VISION_OCR_TOOL_CAPABILITY_ID]: vision.createOcrToolHandler({
      recognizeBytes: (data) => {
        if (!ocrRef) throw new Error('Local OCR runtime is unavailable');
        return ocrRef.recognizeBytes(data);
      }
    })
  });
  // One read-only projection for the Plugins surface. Existing MCP/Skill
  // managers remain authoritative and are intentionally not replaced here.
  const pluginCatalog = new PluginCatalogService({
    registry: pluginRegistry,
    host: pluginHost,
    // Managers are initialized a little later; the service receives them at
    // registration time below after their construction.
  });
  const environmentDiagnostics = new EnvironmentDiagnosticsService({
    nativeRoots: [app.getAppPath(), process.resourcesPath].filter((value): value is string => typeof value === 'string'),
    audit: (event) => db.audit({
      id: randomUUID(), actor: 'system', action: `environment.${event.action}`,
      target: event.target, result: event.reason ? `${event.result}:${event.reason}` : event.result
    })
  });
  const executors = new ExecutorRegistry(db, broker, providerManager, () => {
    const status = apiBridge.getStatus();
    if (!status.running || !status.port) return null;
    return { baseUrl: `http://127.0.0.1:${status.port}`, key: apiBridge.getBridgeKey() };
  });
  const orchestrator = new Orchestrator(db, executors, broker);
  for (const agent of orchestrator.listAgents().filter(isLegacyBootstrappedCordisAgent)) {
    const active = db.raw.prepare(`
      SELECT COUNT(*) AS count FROM tasks
      WHERE agent_id = ? AND status IN ('QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'PAUSED')
    `).get(agent.id) as { count?: number } | undefined;
    if ((active?.count ?? 0) > 0) continue;
    orchestrator.archiveAgent(agent.id);
    db.audit({
      id: randomUUID(), actor: 'system', action: 'legacy.cordis.archive',
      target: agent.id, result: 'archived', source: 'migration'
    });
  }
  const scheduler = new Scheduler(db, orchestrator);
  const kernelState = new DatabaseKernelState(db);
  const memory = new MemoryService(db);
  const memoryProposals = new MemoryProposalService(db, memory);
  memoryProposals.recoverCommitted();
  const taskScheduleProposals = new TaskScheduleProposalService(db, scheduler);
  taskScheduleProposals.recoverCommitted();
  const kernelRouter = new KernelRouter(
    new HermesIngressKernel(),
    new LocalCliDispatchAdapter(),
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
  // Attach legacy managers to the same catalog instance once they exist.
  pluginCatalog.setSources({ mcp: mcpManager, skills: skillManager, engines });
  const wfPlatformMgr = new WfPlatformManager(db);
  const workflowEngine = new WorkflowEngine(db, providerManager, wfPlatformMgr);
  const projectManager = new ProjectManager(db);
  const hermesGovernance = new HermesGovernanceBridge(db);
  let resolveHermesProjectProvider = (_projectId: string) =>
    providerManager.resolveForAgent(null, null);
  let handleHermesHostRequest: (
    projectId: string,
    operation: string,
    payload: unknown
  ) => Promise<unknown> = async () => { throw new Error('Hermes host contract is not ready'); };
  let hermesToolBridge: HermesToolBridge | null = null;
  let hermesAcceptanceCoordinator: HermesAcceptanceCoordinator | null = null;
  let handleHermesProjectRequest: (
    projectId: string,
    operation: string,
    payload: unknown,
    audience: 'desktop' | 'mobile-operator'
  ) => Promise<unknown> = async () => { throw new Error('Hermes project contract is not ready'); };
  const hermesServices = new HermesServiceManager(db, {
    onDiagnostic: (event) => debugLogs.record(
      event.phase === 'error' ? 'error' : 'info',
      `hermes.${event.component}`,
      event.phase,
      event
    ),
    onProjectEvent: (projectId, event) => {
      apiBridge.publishBusinessEvent({ type: 'hermes.event', projectId, event });
    },
    onUpstreamMessage: (projectId, message) => {
      try {
        hermesGovernance.ingestControlMessage(projectId, message);
      } catch (error) {
        db.audit({
          id: randomUUID(), actor: 'system', action: 'hermes.bridge.reject', target: projectId,
          result: error instanceof Error ? error.message : String(error), source: 'hermes'
        });
      }
    },
    onClientMessage: (projectId, message) =>
      hermesGovernance.handleClientControlMessage(projectId, message),
    onHostRequest: (projectId, operation, payload) =>
      handleHermesHostRequest(projectId, operation, payload),
    onProjectRequest: (projectId, operation, payload, audience) =>
      handleHermesProjectRequest(projectId, operation, payload, audience),
    resolveProviderEnvironment: (projectId) => {
      const provider = resolveHermesProjectProvider(projectId);
      const environment: Record<string, string> = {};
      if (provider) {
        Object.assign(environment, {
          OPENAI_API_KEY: provider.key,
          OPENAI_BASE_URL: provider.baseUrl,
          OPENAI_API_BASE: provider.baseUrl,
          HERMES_INFERENCE_MODEL: provider.model,
          HERMES_INFERENCE_PROVIDER: 'opcnexus'
        });
      }
      return environment;
    }
  });
  hermesServices.setSessionBinder((projectId, hermesSessionId, requested) =>
    hermesGovernance.ensureSessionBinding(projectId, hermesSessionId, requested));
  hermesServices.setProjectHealthyHandler(async (projectId) => {
    await hermesGovernance.resumePendingClarifications(projectId);
    hermesAcceptanceCoordinator?.scanProject(projectId);
  });
  hermesGovernance.attachClarifyResponder({
    respond: (projectId, clarifyId, answer) =>
      hermesServices.answerClarification(projectId, clarifyId, answer)
  });
  hermesRef = hermesServices;
  const hermesMobile = new HermesMobileGatewayService(db, hermesServices, {
    trace: (projectId, event) => debugLogs.record(
      event.phase.endsWith('.error') ? 'error' : 'debug',
      'hermes.mobile.transport',
      event.phase,
      { projectId, ...event }
    )
  });
  hermesMobileRef = hermesMobile;
  const hermesWindows = new HermesWorkbenchWindowManager(hermesServices);
  const hermesEmbedded = new HermesEmbeddedWorkbenchManager(hermesServices);
  hermesWindowRef = hermesWindows;
  resolveQuestLaunchProject = (requestedProjectId) => {
    const candidates = projectManager.list().filter((project) => project.status !== 'archived');
    if (requestedProjectId) return requestedProjectId;
    return candidates.sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id ?? null;
  };
  const questWindows = new QuestWindowManager({
    rendererEntry: rendererEntryUrl(),
    preloadPath: rendererPreloadPath(),
    onClosed: (projectId) => {
      // Standalone Quest may switch projects after startup. Tray/OS activation
      // must restore the last owned project instead of the original CLI value.
      lastQuestProjectId = projectId;
      setTimeout(() => {
        const main = mainWindow;
        if (!main || main.isDestroyed() || main.webContents.isDestroyed()) return;
        main.webContents.send('aibox:questWindowClosed', projectId);
      }, 0);
    }
  });
  questWindowRef = questWindows;
  const deliverableManager = new DeliverableManager(db);
  const projectWorkbench = new ProjectWorkbenchService(db, {
    listDeliverables: () => deliverableManager.list(),
    getDeliveryGate: (taskId) => hermesGovernance.getDeliveryGate(taskId)
  });
  resolveHermesProjectProvider = (projectId) => {
    const selectedModel = projectWorkbench.getSettings(projectId).model?.trim() || null;
    return selectedModel
      ? providerManager.resolveByModel(selectedModel)
      : providerManager.resolveForAgent(null, null);
  };
  const agentMentions = new AgentMentionResolver(db, projectWorkbench);
  const hermesConversationContext = new HermesConversationContext(db);
  hermesServices.setConversationContextResolver((projectId, conversationId) =>
    hermesConversationContext.resolve(projectId, conversationId));
  const hermesEmployeeDispatcher = new HermesEmployeeDispatcher(db, orchestrator, projectWorkbench);
  hermesAcceptanceCoordinator = new HermesAcceptanceCoordinator(
    db,
    hermesServices,
    (projectId, excludedAgentIds) => {
      const project = db.raw.prepare(
        'SELECT organization_id FROM projects WHERE id = ? AND status <> \'archived\''
      ).get(projectId) as { organization_id?: string } | undefined;
      if (!project?.organization_id) return [];
      const selection = projectWorkbench.getWorkerSelection(projectId);
      const allowed = selection.mode === 'restricted' ? new Set(selection.workerAgentIds) : null;
      const rows = db.raw.prepare(`
        SELECT id, name, role
        FROM agents
        WHERE organization_id = ? AND lifecycle = 'READY' AND archived = 0
        ORDER BY name, id
      `).all(project.organization_id) as Array<{ id?: string; name?: string; role?: string | null }>;
      return rows
        .filter((row) => (
          typeof row.id === 'string'
          && !excludedAgentIds.has(row.id)
          && (!allowed || allowed.has(row.id))
        ))
        .map((row) => ({ id: row.id!, name: row.name ?? row.id!, role: row.role ?? null }));
    },
    {
      start: async (taskId) => {
        const result = await artifactRuntimeRef?.start(taskId);
        return result ?? { ok: false, error: 'artifact runtime unavailable' };
      }
    }
  );
  const hermesProjectPlugins = new HermesProjectPluginBridge(db, projectWorkbench, mcpManager, skillManager);
  const hermesAttachments = new HermesConversationAttachmentService(
    db,
    (projectId) => projectWorkbench.getExplicitWorkspacePath(projectId)
  );
  handleHermesHostRequest = async (projectId, operation, payload) => {
    if (operation === 'create-employee') {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Hermes employee profile is invalid');
      }
      const input = payload as Record<string, unknown>;
      if (input.ownerConfirmed !== true) {
        throw new Error('Hermes employee creation requires explicit owner confirmation');
      }
      const text = (value: unknown, field: string, min: number, max: number): string => {
        if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max
          || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Hermes employee ${field} is invalid`);
        return value.trim();
      };
      const name = text(input.name, 'name', 2, 30);
      const role = text(input.role, 'role', 2, 500);
      const systemPrompt = typeof input.systemPrompt === 'string' ? input.systemPrompt.trim() : '';
      const soulMd = typeof input.soulMd === 'string' ? input.soulMd.trim() : '';
      const agentsMd = typeof input.agentsMd === 'string' ? input.agentsMd.trim() : '';
      const userMd = typeof input.userMd === 'string' ? input.userMd.trim() : '';
      for (const value of [systemPrompt, soulMd, agentsMd, userMd]) {
        if (value.length > 100_000 || /[\u0000]/.test(value)) throw new Error('Hermes employee persona is invalid');
      }
      const permissionMode = input.permissionMode === undefined ? 'autonomous' : input.permissionMode;
      if (!['readonly', 'standard', 'trusted', 'autonomous'].includes(String(permissionMode))) {
        throw new Error('Hermes employee permission mode is invalid');
      }
      const memoryMode = input.memoryMode === undefined ? 'short_term' : input.memoryMode;
      if (!['long_term', 'short_term', 'none'].includes(String(memoryMode))) {
        throw new Error('Hermes employee memory mode is invalid');
      }
      const concurrencyLimit = input.concurrencyLimit === undefined ? 1 : Number(input.concurrencyLimit);
      if (!Number.isSafeInteger(concurrencyLimit) || concurrencyLimit < 1 || concurrencyLimit > 8) {
        throw new Error('Hermes employee concurrency limit is invalid');
      }
      const capabilityNames: (keyof AgentCapabilities)[] = ['network', 'shell', 'install', 'browser', 'computer'];
      const rawCapabilities = input.capabilities === undefined ? {} : input.capabilities;
      if (!rawCapabilities || typeof rawCapabilities !== 'object' || Array.isArray(rawCapabilities)) {
        throw new Error('Hermes employee capabilities are invalid');
      }
      const capabilities: Partial<AgentCapabilities> = {};
      for (const capability of capabilityNames) {
        const value = (rawCapabilities as Record<string, unknown>)[capability];
        if (value !== undefined && typeof value !== 'boolean') throw new Error(`Hermes employee capability ${capability} is invalid`);
        if (value !== undefined) capabilities[capability] = value;
      }
      const requestedEngine = input.engineId === undefined ? '' : text(input.engineId, 'engineId', 1, 100);
      const engineId = requestedEngine || (db.raw.prepare(`
        SELECT id FROM engines
        WHERE status IN ('HEALTHY', 'SETUP_REQUIRED', 'AUTH_REQUIRED')
        ORDER BY CASE WHEN id = ? THEN 0 WHEN status = 'HEALTHY' THEN 1 ELSE 2 END, id
        LIMIT 1
      `).get(NEXUS_ENGINE_ID) as { id?: string } | undefined)?.id;
      if (!engineId) throw new Error('没有可用于创建数字员工的已配置引擎，请先完成引擎中心配置');
      const engine = db.raw.prepare(
        "SELECT id FROM engines WHERE id = ? AND status IN ('HEALTHY', 'SETUP_REQUIRED', 'AUTH_REQUIRED')"
      ).get(engineId) as { id?: string } | undefined;
      if (engine?.id !== engineId) throw new Error('所选数字员工引擎尚未配置或不可用');
      const agent = orchestrator.createAgent({
        name,
        role,
        systemPrompt: systemPrompt || `你是${name}，负责${role}。严格按工作目录和验收标准交付真实结果。`,
        soulMd,
        agentsMd,
        userMd,
        engineId,
        workspace: '',
        permissionMode: permissionMode as PermissionMode,
        memoryMode: memoryMode as AgentMemoryMode,
        concurrencyLimit,
        channelIds: []
      });
      const updated = orchestrator.updateAgentPersona(agent.id, { capabilities });
      const addToProjectPool = input.addToProjectPool === true;
      if (addToProjectPool) {
        const current = projectWorkbench.getSettings(projectId);
        projectWorkbench.saveSettings(projectId, {
          workerAgentIds: [...new Set([...current.workerAgentIds, updated.id])]
        });
      }
      hermesServices?.refreshProjectContext(projectId);
      db.audit({
        id: randomUUID(), actor: 'hermes', action: 'hermes.employee.create', target: updated.id,
        result: `${updated.name}:${updated.engineId}:${updated.memoryMode}:pool=${addToProjectPool}`, source: 'hermes'
      });
      pushSnapshot();
      return {
        id: updated.id,
        name: updated.name,
        role: updated.role,
        engineId: updated.engineId,
        memoryMode: updated.memoryMode,
        permissionMode: updated.permissionMode,
        capabilities: updated.capabilities,
        addedToProjectPool: addToProjectPool
      };
    }
    if (hermesToolBridge) {
      const hermesToolOperations = new Set([
        'web-search', 'web-search-aggregate', 'research-search', 'http-request', 'browser-navigate', 'browser-snapshot', 'browser-get-content',
        'browser-click', 'browser-type', 'browser-screenshot', 'browser-evaluate',
        'computer-screenshot', 'computer-click', 'computer-type', 'computer-key',
        'audio-synthesize', 'video-probe', 'video-trim', 'video-concat',
        'video-extract-audio', 'video-thumbnail', 'image-generate'
      ]);
      if (hermesToolOperations.has(operation)) {
        return hermesToolBridge.execute(projectId, operation, payload);
      }
    }
    if (operation === 'delegate') return hermesEmployeeDispatcher.dispatch(projectId, payload);
    if (operation === 'task-status') return hermesEmployeeDispatcher.status(projectId, payload);
    if (operation === 'mcp-call') return hermesProjectPlugins.call(projectId, payload);
    return hermesGovernance.handleHostRequest(projectId, operation, payload);
  };
  hermesServices.setProjectWorkspaceResolver((projectId) => projectWorkbench.getExplicitWorkspacePath(projectId));
  hermesServices.setProjectWorkerPoolResolver((projectId) => (
    projectWorkbench.getWorkerSelection(projectId).workerAgentIds
  ));
  hermesServices.setProjectSkillResolver((projectId) => {
    const selected = new Set(projectWorkbench.getSettings(projectId).pluginIds);
    return skillManager.list().filter((skill) => skill.enabled && selected.has(`skill:${skill.id}`));
  });
  const projectArtifacts = new ProjectArtifactService({
    getProjectRoot: (projectId) => projectWorkbench.getExplicitWorkspacePath(projectId),
    audit: (event) => db.audit({
      id: randomUUID(),
      actor: 'system',
      action: `project.artifact.${event.action}`,
      target: event.projectId,
      result: event.result
    })
  });
  registerProjectArtifactProtocol(protocol, projectArtifacts);
  orchestrator.setProjectWorkspaceResolver((projectId) => projectWorkbench.getExplicitWorkspacePath(projectId));
  orchestrator.setProjectArtifactCompletionValidator(new ProjectArtifactManifestService({
    getProjectRoot: (projectId) => projectWorkbench.getExplicitWorkspacePath(projectId),
    audit: (event) => db.audit({
      id: randomUUID(),
      actor: 'system',
      action: 'project.artifact.validateCompletion',
      target: event.taskId,
      result: `${event.result}:${event.detail}`
    })
  }));
  const taskArtifactWorkspace = (taskId: string): string | null => {
    const row = db.raw.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as
      | { project_id?: string | null }
      | undefined;
    return row?.project_id ? projectWorkbench.getExplicitWorkspacePath(row.project_id) : null;
  };
  const artifactRuntime = new ArtifactRuntimeManager({
    db,
    resolveManifest: (taskId) => readTaskArtifactManifest(db, taskId),
    resolveWorkspace: taskArtifactWorkspace,
    captureScreenshots: captureArtifactPreviewScreenshots
  });
  artifactRuntimeRef = artifactRuntime;
  // Hermes is the Quest scheduling kernel. Plan admission remains host-owned
  // and dispatches through the authoritative Orchestrator execution layer.
  hermesGovernance.attachPlanProjector({
    project: async (draft, admission) => {
      if (!projectWorkbench.getExplicitWorkspacePath(draft.projectId)) {
        throw new Error('Project working directory is not configured');
      }
      const project = db.raw.prepare(`
        SELECT organization_id FROM projects WHERE id = ? AND status <> 'archived'
      `).get(draft.projectId) as { organization_id?: string } | undefined;
      if (!project?.organization_id) throw new Error('Hermes project is unavailable');
      const selection = projectWorkbench.getWorkerSelection(draft.projectId);
      const allowed = new Set(selection.workerAgentIds);
      const workerIds = [...new Set([
        ...draft.team.map((member) => member.workerAgentId),
        ...draft.dag.map((node) => node.workerAgentId)
      ])];
      for (const workerId of workerIds) {
        const worker = db.raw.prepare(`
          SELECT id, engine_id, lifecycle FROM agents
          WHERE id = ? AND organization_id = ? AND archived = 0
        `).get(workerId, project.organization_id) as {
          id?: string;
          engine_id?: string;
          lifecycle?: string;
        } | undefined;
        if (worker?.id !== workerId || worker.lifecycle !== 'READY') {
          throw new Error(`Hermes plan employee ${workerId} is unavailable`);
        }
        if (selection.mode === 'restricted' && !allowed.has(workerId)) {
          throw new Error(`Hermes plan employee ${workerId} is outside the project fixed employee pool`);
        }
      }
      const budget = db.raw.prepare(`
        SELECT token_limit, cost_limit FROM project_budgets WHERE project_id = ?
      `).get(draft.projectId) as { token_limit?: number; cost_limit?: number } | undefined;
      if (budget && Number(budget.token_limit) > 0 && draft.budget.maxTokens > Number(budget.token_limit)) {
        throw new Error('Hermes plan exceeds the project token budget');
      }
      if (budget && Number(budget.cost_limit) > 0 && draft.budget.maxCost > Number(budget.cost_limit)) {
        throw new Error('Hermes plan exceeds the project cost budget');
      }
      const binding = db.raw.prepare(`
        SELECT hermes_session_id FROM hermes_session_bindings
        WHERE project_id = ? AND conversation_id = ?
      `).get(draft.projectId, draft.conversationId) as { hermes_session_id?: string } | undefined;
      if (!binding?.hermes_session_id) throw new Error('Hermes plan conversation has no active session binding');
      const versionRow = db.raw.prepare(`
        SELECT COUNT(*) AS count FROM hermes_plan_projections p
        JOIN hermes_plan_drafts d ON d.draft_id = p.draft_id
        WHERE p.project_id = ? AND d.conversation_id = ?
      `).get(draft.projectId, draft.conversationId) as { count?: number } | undefined;
      const version = Number(versionRow?.count ?? 0) + 1;
      return {
        governanceSessionId: `hermes-governance-${createHash('sha256')
          .update(`${draft.projectId}\u0000${draft.conversationId}`, 'utf8').digest('hex').slice(0, 32)}`,
        sessionId: binding.hermes_session_id,
        planId: `hermes-plan-${admission.draftId}`,
        version,
        hash: admission.hash
      };
    },
    approve: async (projection, principalId) => {
      const owner = db.raw.prepare(`
        SELECT pr.id FROM principals pr
        JOIN projects p ON p.organization_id = pr.organization_id
        WHERE pr.id = ? AND p.id = ? AND p.status <> 'archived'
      `).get(principalId, projection.projectId) as { id?: string } | undefined;
      if (owner?.id !== principalId) throw new Error('Only the project owner may approve this Hermes plan');
    },
    dispatch: async (projection, principalId) => {
      const row = db.raw.prepare(`
        SELECT d.payload_json, d.conversation_id, p.organization_id
        FROM hermes_plan_drafts d
        JOIN projects p ON p.id = d.project_id AND p.status <> 'archived'
        WHERE d.draft_id = ? AND d.project_id = ?
      `).get(projection.draftId, projection.projectId) as {
        payload_json?: string;
        conversation_id?: string;
        organization_id?: string;
      } | undefined;
      if (!row?.payload_json || !row.conversation_id || !row.organization_id) {
        throw new Error('Hermes plan draft is unavailable for dispatch');
      }
      const draft = assertHermesPlanDraft(JSON.parse(row.payload_json));
      const workspace = projectWorkbench.getExplicitWorkspacePath(projection.projectId);
      if (!workspace) throw new Error('Project working directory is not configured');
      const nodeById = new Map(draft.dag.map((node) => [node.id, node]));
      const pending = new Set(nodeById.keys());
      const taskIds = new Map<string, string>();
      while (pending.size > 0) {
        let progressed = false;
        for (const nodeId of [...pending]) {
          const node = nodeById.get(nodeId)!;
          if (!node.dependsOn.every((dependency) => taskIds.has(dependency))) continue;
          const task = orchestrator.createTask(node.workerAgentId, node.title, 'team', {
            projectId: projection.projectId,
            conversationId: row.conversation_id,
            workspaceOverride: workspace,
            sourceKey: `hermes-plan:${projection.draftId}:${node.id}`,
            dependencyTaskIds: node.dependsOn.map((dependency) => taskIds.get(dependency)!),
            content: [
              `Objective: ${draft.objective}`,
              `Work order: ${node.title}`,
              `Acceptance criteria:\n${node.acceptanceCriteria.join('\n')}`,
              node.expectedArtifacts.length > 0
                ? `Expected artifacts owned by this work order:\n${node.expectedArtifacts.join('\n')}`
                : 'This work order does not own a new file artifact. Return its factual result in the task response.'
            ].join('\n\n'),
            requiresArtifacts: node.expectedArtifacts.length > 0
          });
          taskIds.set(nodeId, task.id);
          db.raw.prepare(`
            INSERT INTO hermes_plan_jobs(draft_id, node_id, task_id, created_at)
            VALUES(?, ?, ?, ?) ON CONFLICT(draft_id, node_id) DO NOTHING
          `).run(projection.draftId, node.id, task.id, Date.now());
          pending.delete(nodeId);
          progressed = true;
        }
        if (!progressed) throw new Error('Hermes plan DAG could not be dispatched');
      }
      if (taskIds.size !== draft.dag.length) throw new Error('Hermes plan dispatch did not create every task');
      db.audit({
        id: randomUUID(), actor: principalId, action: 'hermes.plan.tasks.commit',
        target: projection.draftId, result: [...taskIds.values()].join(','), source: 'hermes'
      });
    }
  });
  hermesGovernance.attachDelegationProjector({
    project: (request) => {
      const binding = db.raw.prepare(`
        SELECT conversation_id FROM hermes_session_bindings
        WHERE project_id = ? AND hermes_session_id = ?
      `).get(request.projectId, request.parentSessionId) as { conversation_id?: string } | undefined;
      if (!binding?.conversation_id) throw new Error('Hermes delegation parent is not bound to this project');
      const plans = db.raw.prepare(`
        SELECT p.draft_id, p.plan_hash, d.payload_json
        FROM hermes_plan_projections p
        JOIN hermes_plan_drafts d ON d.draft_id = p.draft_id
        WHERE p.project_id = ? AND d.conversation_id = ? AND p.status = 'DISPATCHED'
        ORDER BY p.updated_at DESC
      `).all(request.projectId, binding.conversation_id) as Array<{
        draft_id: string;
        plan_hash: string;
        payload_json: string;
      }>;
      const matching = plans.find((candidate) => {
        const draft = assertHermesPlanDraft(JSON.parse(candidate.payload_json));
        const nodes = new Map(draft.dag.map((node) => [node.id, node]));
        return request.tasks.every((task) => nodes.get(task.id)?.workerAgentId === request.workerAgentId);
      });
      if (!matching) throw new Error('Hermes delegation does not match a dispatched plan');
      const jobs = request.tasks.map((task) => db.raw.prepare(`
        SELECT task_id FROM hermes_plan_jobs WHERE draft_id = ? AND node_id = ?
      `).get(matching.draft_id, task.id) as { task_id?: string } | undefined);
      if (jobs.some((job) => !job?.task_id)) throw new Error('Hermes delegation plan tasks are incomplete');
      return {
        jobIds: jobs.map((job) => job!.task_id!),
        runIds: jobs.map(() => null),
        planHash: matching.plan_hash
      };
    }
  });
  handleHermesProjectRequest = async (projectId, operation, payload, audience) => {
    if (operation === 'state') {
      const rows = db.raw.prepare(`
        SELECT t.id, t.title, t.status, t.progress, t.agent_id, t.content, t.result,
               a.name AS agent_name, a.role AS agent_role, a.engine_id
        FROM tasks t
        LEFT JOIN agents a ON a.id = t.agent_id
        WHERE t.project_id = ? AND t.deleted_at IS NULL
        ORDER BY t.created_at DESC, t.id DESC LIMIT 100
      `).all(projectId) as Array<{
        id: string;
        title: string;
        status: import('../shared/types.js').TaskStatus;
        progress: number;
        agent_id: string;
        content: string | null;
        result: string | null;
        agent_name: string | null;
        agent_role: string | null;
        engine_id: string | null;
      }>;
      const workbenchView = projectWorkbench.get(projectId);
      const workerSelection = projectWorkbench.getWorkerSelection(projectId);
      return {
        projectId,
        runtimeState: hermesServices.getStatus(projectId).state,
        orchestration: {
          scheduler: 'Hermes',
          workerSelectionMode: workerSelection.mode,
          workerAgentIds: workerSelection.workerAgentIds,
          maxParallel: workbenchView.settings.maxParallel,
          permissionMode: workbenchView.settings.permissionMode,
          sandbox: workbenchView.settings.sandbox
        },
        employees: agentMentions.listEligible(projectId),
        plugins: hermesProjectPlugins.list(projectId),
        clarifications: hermesGovernance.listOpen(projectId),
        plans: hermesGovernance.listPlanProjections(projectId),
        tasks: rows.map((task) => {
          const manifest = readTaskArtifactManifest(db, task.id);
          const intentMatch = /^Task intent: (execution|status_inquiry|validation)$/m.exec(task.content ?? '');
          const intent = (intentMatch?.[1] ?? 'execution') as import('../shared/types.js').HermesEmployeeTaskIntent;
          const relatedMarker = 'Related project tasks:';
          const relatedStart = (task.content ?? '').indexOf(relatedMarker);
          const relatedBlock = relatedStart >= 0
            ? (task.content ?? '').slice(relatedStart + relatedMarker.length).split(/\r?\n\s*\r?\n/, 1)[0] ?? ''
            : '';
          const relatedTaskIds = relatedBlock
            .split(/\r?\n/)
            .map((value) => value.trim())
            .filter((value) => /^[A-Za-z0-9._:-]{1,128}$/.test(value));
          return {
            taskId: task.id,
            title: task.title,
            status: task.status,
            progress: Math.max(0, Math.min(100, Number(task.progress) || 0)),
            intent,
            validationVerdict: intent === 'validation'
              ? parseHermesValidationVerdict(task.status, task.result)
              : null,
            relatedTaskIds,
            worker: {
              id: task.agent_id,
              name: task.agent_name ?? task.agent_id,
              role: task.agent_role ?? '',
              engineId: task.engine_id ?? ''
            },
            files: (manifest?.entries ?? []).map((entry) => ({
              relativePath: entry.relativePath,
              mediaType: entry.mediaType,
              sha256: entry.sha256
            }))
          };
        }),
        updatedAt: Date.now()
      };
    }
    if (operation === 'chat-history') {
      const input = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown> : {};
      const conversationId = typeof input.conversationId === 'string' ? input.conversationId.trim() : '';
      return hermesServices.projectChatHistory(projectId, conversationId || undefined);
    }
    if (operation === 'conversations') {
      return hermesGovernance.listConversations(projectId);
    }
    if (operation === 'chat-queue') {
      return hermesServices.listProjectChatQueue(projectId);
    }
    const input = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    if (operation === 'chat-turn' || operation === 'enqueue-chat-turn') {
      const message = typeof input.message === 'string' ? input.message.trim() : '';
      let conversationId = typeof input.conversationId === 'string' ? input.conversationId.trim() : '';
      if (!message || message.length > 128_000) throw new Error('Hermes project message is invalid');
      if (operation === 'enqueue-chat-turn' && !conversationId) {
        conversationId = hermesGovernance.createConversation(projectId).conversationId;
      }
      const slashCommand = parseQuestSlashCommand(message);
      const slashResolution = slashCommand
        ? resolveQuestSlashCommand(slashCommand, {
            employees: agentMentions.listEligible(projectId),
            plugins: hermesProjectPlugins.list(projectId)
          })
        : null;
      const turnMessage = slashResolution?.turnMessage ?? message;
      const commandDirective = slashResolution?.systemDirective ?? '';
      const mentions = agentMentions.resolve(projectId, turnMessage);
      let principalId: string | undefined;
      if (conversationId) {
        const conversation = db.raw.prepare(`
          SELECT principal_id FROM conversations WHERE id = ? AND project_id = ?
        `).get(conversationId, projectId) as { principal_id?: string | null } | undefined;
        if (!conversation?.principal_id) throw new Error('Hermes project conversation is unavailable');
        principalId = conversation.principal_id;
      }
      const pinnedEmployee = conversationId
        ? hermesGovernance.getConversationEmployee(projectId, conversationId)
        : null;
      if (pinnedEmployee && !agentMentions.listEligible(projectId).some((employee) => employee.id === pinnedEmployee.id)) {
        throw new Error(`员工 ${pinnedEmployee.name} 已不在当前项目授权范围内`);
      }
      const attachmentContext = hermesAttachments.promptContext(projectId, conversationId, input.attachmentIds);
      if (slashResolution) {
        db.audit({
          id: randomUUID(),
          actor: principalId ?? 'principal-local-admin',
          action: 'hermes.quest.command',
          target: `${projectId}:${slashResolution.auditTarget}`,
          result: 'accepted',
          source: 'hermes'
        });
      }
      const visibleAttachments = attachmentContext.attachments.map((attachment) => {
        if (attachment.mediaType.startsWith('image/')) return `![${attachment.name}](${attachment.url})`;
        if (attachment.mediaType.startsWith('video/')) return `<video controls preload="metadata" src="${attachment.url}"></video>`;
        return `[${attachment.name}](${attachment.url})`;
      });
      const turn = {
        message: visibleAttachments.length > 0
          ? `${turnMessage}\n\n[Attached files]\n${visibleAttachments.join('\n')}`
          : turnMessage,
        systemMessage: [mentions.systemMessage, commandDirective, hermesProjectPlugins.systemMessage(projectId), attachmentContext.systemMessage]
          .filter(Boolean).join('\n\n'),
        ...(conversationId && principalId ? { conversationId, principalId } : {}),
        title: 'Hermes Workbench'
      };
      if (operation === 'enqueue-chat-turn') {
        if (!conversationId || !principalId) throw new Error('Hermes project conversation is unavailable');
        return hermesServices.enqueueProjectTurn(projectId, {
          ...turn,
          conversationId,
          principalId
        });
      }
      return hermesServices.runProjectTurn(projectId, turn);
    }
    if (operation === 'upload-attachment') {
      const conversationId = typeof input.conversationId === 'string' ? input.conversationId.trim() : '';
      const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : null;
      const name = typeof input.name === 'string' ? input.name : '';
      const mediaType = typeof input.mediaType === 'string' ? input.mediaType : 'application/octet-stream';
      if (!conversationId || !bytes) throw new Error('附件上传缺少会话或文件内容');
      return hermesAttachments.upload({ projectId, conversationId, name, mediaType, bytes });
    }
    if (operation === 'read-attachment') {
      const attachmentId = payload && typeof payload === 'object' && !Array.isArray(payload)
        && typeof (payload as Record<string, unknown>).attachmentId === 'string'
        ? String((payload as Record<string, unknown>).attachmentId) : '';
      return hermesAttachments.read(projectId, attachmentId);
    }
    if (operation === 'retry-chat-message') {
      const queueId = typeof input.queueId === 'string' ? input.queueId.trim() : '';
      const confirmation = input.confirmation === 'retry-failed-turn'
        ? 'retry-failed-turn'
        : null;
      if (!confirmation) throw new Error('重试失败任务前必须由老板明确确认');
      debugLogs.record('info', 'hermes.retry.request', 'explicit retry requested', {
        projectId,
        queueId,
        audience
      });
      db.audit({
        id: randomUUID(),
        actor: audience === 'desktop' ? 'local-admin' : 'mobile-operator',
        action: 'hermes.chat.queue.retry.request',
        target: projectId,
        result: `queue=${queueId};audience=${audience}`,
        source: audience
      });
      return hermesServices.retryProjectTurn(projectId, queueId, confirmation);
    }
    if (operation === 'cancel-chat-message') {
      const queueId = typeof input.queueId === 'string' ? input.queueId.trim() : '';
      return hermesServices.cancelProjectTurn(projectId, queueId);
    }
    if (operation === 'create-conversation') {
      const employeeId = typeof input.employeeId === 'string' ? input.employeeId.trim() : '';
      if (employeeId && !agentMentions.listEligible(projectId).some((employee) => employee.id === employeeId)) {
        throw new Error('所选数字员工不在当前项目授权范围内');
      }
      return hermesGovernance.createConversation(projectId, employeeId ? { employeeId } : {});
    }
    if (operation === 'popout-conversation') {
      const conversationId = typeof input.conversationId === 'string' ? input.conversationId.trim() : '';
      if (!conversationId || !hermesGovernance.listConversations(projectId)
        .some((conversation) => conversation.conversationId === conversationId)) {
        throw new Error('Hermes project conversation is unavailable');
      }
      const theme = db.getSetting<'dark' | 'light'>('theme', 'dark');
      await hermesWindows.openConversation(projectId, conversationId, theme === 'light' ? 'light' : 'dark');
      return { opened: true };
    }
    if (operation === 'answer-clarify') {
      const clarifyId = typeof input.clarifyId === 'string' ? input.clarifyId.trim() : '';
      if (!clarifyId) throw new Error('Hermes clarification identity is invalid');
      const principalId = audience === 'desktop'
        ? 'principal-local-admin'
        : (() => {
            const conversationId = payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).conversationId === 'string' ? String((payload as Record<string, unknown>).conversationId) : '';
            return (db.raw.prepare('SELECT principal_id FROM conversations WHERE id = ? AND project_id = ?').get(conversationId, projectId) as { principal_id?: string } | undefined)?.principal_id
              ?? 'principal-mobile-operator';
          })();
      return hermesGovernance.answerClarify({
        clarifyId,
        projectId,
        principalId,
        answer: input.answer
      });
    }
    if (operation === 'approve-plan' || operation === 'dispatch-plan') {
      const draftId = typeof input.draftId === 'string' ? input.draftId : '';
      if (!/^hermes-draft-[A-Za-z0-9-]{1,80}$/.test(draftId)) throw new Error('Hermes draft identity is invalid');
      const principalId = audience === 'desktop'
        ? 'principal-local-admin'
        : (() => {
            const conversationId = payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).conversationId === 'string' ? String((payload as Record<string, unknown>).conversationId) : '';
            return (db.raw.prepare('SELECT principal_id FROM conversations WHERE id = ? AND project_id = ?').get(conversationId, projectId) as { principal_id?: string } | undefined)?.principal_id
              ?? 'principal-mobile-operator';
          })();
      return operation === 'approve-plan'
        ? hermesGovernance.approvePlan(draftId, projectId, principalId)
        : hermesGovernance.dispatchPlan(draftId, projectId, principalId);
    }
    if (operation === 'open-project-directory') {
      const workspace = projectWorkbench.getExplicitWorkspacePath(projectId);
      if (!workspace) throw new Error('Project working directory is not configured');
      const error = await shell.openPath(workspace);
      if (error) throw new Error(error);
      db.audit({
        id: randomUUID(), actor: 'admin', action: 'hermes.project.open-directory',
        target: projectId, result: 'ok', source: 'hermes'
      });
      return { opened: true };
    }
    throw new Error(`Unsupported Hermes project operation: ${operation}`);
  };
  // Authenticated OA/business-platform contract over the local API Bridge.
  // Every command is project-scoped and enters the same Hermes queue and
  // governance path as desktop/mobile; no external caller writes SQLite.
  apiBridge.setBusinessGatewayHandlers({
    command: async (command, payload) => {
      const projectId = typeof payload.projectId === 'string' ? payload.projectId.trim() : '';
      if (!projectId) throw new Error('business gateway projectId is required');
      projectWorkbench.get(projectId); // validates existence and archived state
      if (command === 'snapshot') {
        return handleHermesProjectRequest(projectId, 'state', null, 'desktop');
      }
      if (command === 'cancel') {
        const queueId = typeof payload.queueId === 'string' ? payload.queueId.trim() : '';
        const taskId = typeof payload.taskId === 'string' ? payload.taskId.trim() : '';
        if (queueId) return hermesServices.cancelProjectTurn(projectId, queueId);
        if (taskId) {
          const task = orchestrator.listTasks({ includeResult: false }).find((item) => item.id === taskId && item.projectId === projectId);
          if (!task) throw new Error('business gateway task is unavailable');
          orchestrator.cancelTask(taskId, '业务中台请求取消');
          return { taskId, status: 'CANCELLED' };
        }
        throw new Error('business gateway cancel requires queueId or taskId');
      }
      if (command !== 'submit') throw new Error(`Unsupported business gateway command: ${command}`);
      const message = typeof payload.message === 'string' ? payload.message.trim() : '';
      if (!message || message.length > 128_000) throw new Error('business gateway message is invalid');
      let conversationId = typeof payload.conversationId === 'string' ? payload.conversationId.trim() : '';
      if (!conversationId) conversationId = hermesGovernance.createConversation(projectId).conversationId;
      const conversation = db.raw.prepare(
        'SELECT principal_id FROM conversations WHERE id = ? AND project_id = ?'
      ).get(conversationId, projectId) as { principal_id?: string | null } | undefined;
      if (!conversation?.principal_id) throw new Error('business gateway conversation is unavailable');
      const item = hermesServices.enqueueProjectTurn(projectId, {
        conversationId,
        principalId: conversation.principal_id,
        message,
        title: typeof payload.title === 'string' ? payload.title : 'Business gateway task',
        systemMessage: typeof payload.systemMessage === 'string' ? payload.systemMessage : undefined
      });
      db.audit({ id: randomUUID(), actor: 'business-gateway', action: 'business.task.submit', target: projectId, result: item.id, source: 'business-gateway' });
      return { projectId, queueId: item.id, conversationId, status: item.status };
    }
  });
  const businessSnapshotTimer = new Map<string, NodeJS.Timeout>();
  const publishBusinessSnapshot = (projectId: string) => {
    if (businessSnapshotTimer.has(projectId)) return;
    const timer = setTimeout(() => {
      businessSnapshotTimer.delete(projectId);
      try {
        const tasks = orchestrator.listTasks({ includeResult: true })
          .filter((task) => task.projectId === projectId)
          .slice(0, 200)
          .map((task) => ({
            id: task.id, title: task.title, status: task.status, progress: task.progress, stage: task.stage,
            error: task.error, result: task.result?.slice(0, 16_000) ?? null,
            manifest: readTaskArtifactManifest(db, task.id)
          }));
        apiBridge.publishBusinessEvent({ type: 'project.snapshot', projectId, tasks, updatedAt: Date.now() });
      } catch { /* external telemetry must never affect task execution */ }
    }, 100);
    timer.unref();
    businessSnapshotTimer.set(projectId, timer);
  };
  orchestrator.onChange(() => {
    for (const project of projectManager.list().filter((item) => item.status !== 'archived')) publishBusinessSnapshot(project.id);
  });
  orchestrator.onTaskFinished((info) => {
    const task = orchestrator.listTasks({ includeResult: true }).find((item) => item.id === info.taskId);
    if (!task?.projectId) return;
    apiBridge.publishBusinessEvent({
      type: 'task.finished', projectId: task.projectId, taskId: task.id, status: info.status,
      result: info.result?.slice(0, 16_000) ?? null, error: info.error, manifest: readTaskArtifactManifest(db, task.id),
      finishedAt: Date.now()
    });
  });
  const knowledgeManager = new KnowledgeManager(db);
  const automationManager = new AutomationManager(db, { projects: projectManager, deliverables: deliverableManager });
  scheduler.setAutomationHandler((kind, projectId, scheduleId) => {
    automationManager.run(kind, projectId, 'scheduled', scheduleId);
  });
  const teamEngine = new TeamEngine(db, orchestrator, knowledgeManager);
  teamEngine.setProjectWorkspaceResolver((projectId) => projectWorkbench.getExplicitWorkspacePath(projectId));
  const discoveryManager = new DiscoveryManager(db, {
    projects: projectManager, deliverables: deliverableManager, knowledge: knowledgeManager, teams: teamEngine, automation: automationManager
  });
  const collabManager = new CollabManager(db);
  const hermesChannelRouter = new HermesChannelRouter(db, hermesServices, hermesGovernance, orchestrator);
  const feishu = new FeishuChannel(db, orchestrator, hermesChannelRouter);
  feishuRef = feishu;
  const wecom = new WecomChannel(db, orchestrator, hermesChannelRouter);
  const weixin = new WeixinChannel(db, orchestrator, { taskPlanner: hermesChannelRouter });
  weixinRef = weixin;

  // 工具循环的委派能力（P3b）与调度保护门禁（11.2）注入
  executors.setToolHost(orchestrator.toolHost());
  executors.setMcpManager(mcpManager);
  // 浏览器自动化管理器（Playwright/CDP）注入
  const { BrowserManager } = await import('./services/browserManager.js');
  const browserMgr = new BrowserManager();
  browserRef = browserMgr;
  executors.setBrowserManager(browserMgr);
  hermesToolBridge = new HermesToolBridge({
    browserManager: browserMgr,
    resolveRuntime: resolveHermesRuntimeLaunch,
    getHermesHome: (projectId) => hermesServices.getStatus(projectId).homePath,
    getWorkspace: (projectId) => projectWorkbench.getExplicitWorkspacePath(projectId),
    getImageProvider: (projectId) => resolveHermesProjectProvider(projectId),
    getPolicy: (projectId) => {
      const settings = projectWorkbench.getSettings(projectId);
      return { permissionMode: settings.permissionMode, sandbox: settings.sandbox };
    },
    audit: ({ projectId, operation, result }) => db.audit({
      id: randomUUID(), actor: 'hermes', action: `hermes.tool.${operation}`,
      target: projectId, result, source: 'hermes'
    })
  });
  // OCR 服务（PaddleOCR WASM）注入
  const { OcrService } = await import('./services/ocrService.js');
  const ocrService = new OcrService(db);
  ocrRef = ocrService;
  executors.setOcrService(ocrService);
  // 语音任务下达服务（仅开放已实现的云端 NLS；凭据留在主进程）
  const { VoiceService } = await import('./services/voiceService.js');
  const voiceService = new VoiceService(db);
  voiceRef = voiceService;
  orchestrator.setDispatchGuard(() => monitor.getGuardReason());
  monitor.onGuardChange((current, previous) => {
    if (!previous || current !== null) return;
    const awakenedAgents = orchestrator.wakeQueuedAgentQueues(previous);
    db.audit({
      id: randomUUID(), actor: 'system', action: 'resource.dispatchGuard.released',
      target: 'resource-monitor', result: `awakened-agents:${awakenedAgents}`
    });
  });
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
  seedMcpServers(db);
  purgeDemoData(db);
  purgeRetiredProductState(db);
  const retiredRuntimeCleanup = purgeRetiredRuntimeDirectories(join(app.getPath('userData'), 'aibox-data'));
  if (retiredRuntimeCleanup.removed.length > 0 || retiredRuntimeCleanup.failed.length > 0) {
    const failed = retiredRuntimeCleanup.failed.map((item) => `${item.name}:${item.error}`).join('; ');
    db.audit({
      id: randomUUID(),
      actor: 'system',
      action: 'legacy.runtimeDirectories.remove',
      target: 'deepseek-harness,deepseek-harness-managed',
      result: failed || `retired:${retiredRuntimeCleanup.removed.length}`,
      source: 'migration'
    });
    if (failed) console.error('[LegacyCleanup] 旧 DSH 运行时目录清理失败:', failed);
  }
  ensureBuiltinSkills(db);
  skillManager.ensureVisionUnderstanding();
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
    hermesAcceptanceCoordinator?.onTaskFinished(info);
    if (info.status !== 'COMPLETED') return;
    const agent = db.raw.prepare('SELECT name FROM agents WHERE id = ?').get(info.agentId) as { name: string } | undefined;
    webhookNotifier.notifyTaskCompleted(info.title, agent?.name ?? '数字员工', info.result);
  });

  // 本地 API Bridge（反向代理，供 Claude Code/Codex 等引擎使用）。
  // A managed Claude binding cannot work against an OpenAI-only upstream
  // unless this local Anthropic adapter is listening. Start it automatically
  // for that explicit binding; native Claude login remains untouched.
  let bridgeShouldStart = db.getSetting<string>('bridge_enabled', 'false') === 'true';
  let bridgeAutoStarted = false;
  if (!bridgeShouldStart) {
    try {
      const row = db.raw.prepare('SELECT config_json FROM engines WHERE id = ?').get('eng-claude') as { config_json?: string | null } | undefined;
      const config = row?.config_json ? JSON.parse(row.config_json) as { providerMode?: string } : null;
      if (config?.providerMode === 'managed' && resolveEngineProvider(db, 'eng-claude')) {
        bridgeShouldStart = true;
        bridgeAutoStarted = true;
      }
    } catch {
      // A malformed or incomplete Claude binding must not block application startup.
    }
  }
  if (bridgeShouldStart) {
    try {
      await apiBridge.start();
      if (bridgeAutoStarted) db.setSetting('bridge_enabled', 'true');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ApiBridge] 自动启动失败，服务保持关闭: ${message}`);
      db.audit({ id: randomUUID(), actor: 'system', action: 'bridge.start', target: 'api-bridge', result: 'start-error' });
    }
  }

  const { pushSnapshot } = registerIpc({ db, orchestrator, desktopControlPlane, executors, engines, channels, feishu, wecom, weixin, scheduler, broker, monitor, mcp: mcpManager, skills: skillManager, providers: providerManager, workflows: workflowEngine, projects: projectManager, deliverables: deliverableManager, knowledge: knowledgeManager, automation: automationManager, discovery: discoveryManager, teams: teamEngine, wfPlatforms: wfPlatformMgr, collab: collabManager, ocr: ocrService, vision, visionPluginHost: pluginHost, voice: voiceService, apiBridge, mobile, mobileAdb, memory, memoryProposals, taskScheduleProposals, pluginCatalog, environmentDiagnostics, projectWorkbench, projectArtifacts, artifactRuntime, questWindows, hermesServices, hermesWindows, hermesEmbedded, hermesGovernance, hermesMobile, debugLogs, openMainSurface: requestMainSurface, getMainWindow: () => mainWindow });

  // Detect installed execution adapters before exposing the first Renderer.
  // Hermes is the only scheduler and no employee is created implicitly.
  try {
    await engines.detect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Engine] 启动探测失败: ${message}`);
    db.audit({
      id: randomUUID(), actor: 'system', action: 'engine.bootstrap',
      target: 'engine-catalog', result: 'failed'
    });
  } finally {
    pushSnapshot();
    orchestrator.startScheduler();
    teamEngine.recoverOrResume(); // 引擎就绪后续跑中断的专家团流水线（可恢复状态机）
  }

  desktopSurfaceReady = true;
  if (!startupQuestLaunch || pendingMainWindowRequest) {
    createWindow();
    pendingMainWindowRequest = false;
  }
  await questLaunchCoordinator.attach((projectId) => (
    questWindows.open(resolveQuestLaunchProject(projectId))
  ));
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length > 0) return;
    if (startupQuestLaunch) {
      void questLaunchCoordinator.request(lastQuestProjectId);
    } else {
      createWindow();
    }
  });
});

let quitCleanupStarted = false;
const QUIT_CLEANUP_BUDGET_MS = Math.max(ILINK_QUIT_CLEANUP_BUDGET_MS, 12_000);

function waitForQuitCleanup(cleanup: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, QUIT_CLEANUP_BUDGET_MS);
    void cleanup.then(finish, finish);
  });
}

app.on('before-quit', (event) => {
  isQuitting = true;
  if (!quitCleanupStarted) {
    event.preventDefault();
    quitCleanupStarted = true;
    const cleanup = (async () => {
      try { await hermesMobileRef?.shutdown(); } catch { /* continue shutdown */ }
      try { await hermesRef?.shutdown(); } catch { /* continue shutdown */ }
      try { await artifactRuntimeRef?.shutdown(); } catch { /* continue shutdown */ }
      try { await weixinRef?.dispose(); } catch { /* continue shutdown */ }
    })();
    void waitForQuitCleanup(cleanup).finally(() => {
      try { dbRef?.flush(); } catch { /* 退出前尽力落盘 */ }
      debugLogRef?.dispose();
      app.quit();
    });
  }
  try {
    mcpRef?.dispose();
    browserRef?.dispose();
    mobileRef?.dispose();
    feishuRef?.dispose();
    ocrRef?.dispose();
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
