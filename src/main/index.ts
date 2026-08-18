/**
 * Electron 主进程入口
 * 跨平台：Windows 10/11 + Ubuntu 22.04+（PRD 4.1 首发 Windows，Linux 同架构兼容）
 */
import { app, BrowserWindow, Menu, nativeImage, protocol, screen, shell, Tray } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
import { seedMcpServers, seedSkills } from './services/seed.js';
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
import { DatabaseKernelState } from './services/kernel/databaseKernelState.js';
import { CordisControlKernel } from './services/kernel/cordisControlKernel.js';
import { KernelRouter } from './services/kernel/kernelRouter.js';
import { LocalCliDispatchAdapter } from './services/kernel/localCliDispatchAdapter.js';
import { registerIpc } from './ipc.js';
import { isAllowedExternalUrl, isAllowedMainNavigation } from './services/navigationPolicy.js';
import { DshSupervisor } from './services/dshSupervisor.js';
import { DshWebGateway } from './services/dshWebGateway.js';
import { DshIntegrationService } from './services/dshIntegrationService.js';
import { DshSessionService } from './services/dshSessionService.js';
import { DshSessionWriteCoordinator } from './services/dshSessionWriteCoordinator.js';
import {
  deepseekHarnessManagedRuntimePaths,
  DSH_MANAGED_PROFILE_ID,
  readDeepseekHarnessManagedCapabilities
} from './services/deepseekHarnessManagedRuntime.js';
import { DshPluginCatalogService } from './services/dshPluginCatalog.js';
import { PluginCatalogService } from './services/pluginCatalog.js';
import { EnvironmentDiagnosticsService } from './services/environmentDiagnostics.js';
import { ProjectWorkbenchService } from './services/projectWorkbench.js';
import { DshQuestSessionBindingService } from './services/dshQuestSessionBinding.js';
import {
  createDshQuestGovernanceAdmissionHandler,
  DshQuestGovernanceService,
  resolveDshQuestProjectId
} from './services/dshQuestGovernance.js';
import { DshTypedQuestBridge } from './services/dshTypedQuestBridge.js';
import {
  OrchestratorPlanningDispatchPort,
  SecretaryPlanningRepository as DurablePlanningRepository
} from './services/secretaryPlanningAdapters.js';
import { DshDelegationService } from './services/dshDelegationService.js';
import { DshDelegationSyncService } from './services/dshDelegationSyncService.js';
import { DshCommunityPluginService } from './services/dshCommunityPluginService.js';
import {
  PROVIDER_CREDENTIAL_PROXY_MAX_REQUEST_BYTES,
  ProviderCredentialProxy
} from './services/providerCredentialProxy.js';
import type { DshRuntimeCredentialLease } from './services/dshSupervisor.js';
import { DSH_MANAGED_ENGINE_ID } from '../shared/types.js';
import { DshLanGatewayComposition } from './services/dshLanGatewayComposition.js';
import { readPersistedDshLanTrustedAuthorities } from './services/dshLanGatewayController.js';
import { resolveDshProviderBinding, resolveDshProviderCredential } from './services/dshProviderBinding.js';
import {
  DSH_VISION_PLUGIN_MANIFEST,
  VISION_OCR_TOOL_CAPABILITY_ID,
  VISION_TOOL_CAPABILITY_ID,
  VisionService
} from './services/visionService.js';
import { CapabilityRegistry, PluginHost } from './services/pluginHost.js';
import { DshPolicyBroker } from './services/dshPolicyBroker.js';
import {
  createDshPluginPermissionResolver,
  resolveBuiltinDshHostPolicy
} from './services/dshPluginPolicy.js';
import {
  DSH_QUEST_GOVERNANCE_CAPABILITY_ID,
  OPC_NEXUS_GOVERNANCE_PLUGIN_ID,
  OPC_NEXUS_GOVERNANCE_PLUGIN_MANIFEST
} from './services/opcNexusGovernancePlugin.js';
import { ARTIFACT_PROTOCOL_SCHEME, ArtifactRefService } from './services/artifactRef.js';
import { registerArtifactProtocol } from './services/artifactProtocol.js';
import {
  PROJECT_ARTIFACT_PROTOCOL_SCHEME,
  ProjectArtifactService,
  registerProjectArtifactProtocol
} from './services/projectArtifactService.js';
import { ProjectArtifactManifestService } from './services/projectArtifactManifest.js';
import { ensureCordisAgent } from './services/cordisBootstrap.js';
import { QuestWindowManager } from './services/questWindowManager.js';
import { parseQuestLaunchRequest, QuestLaunchCoordinator } from './services/questLaunch.js';

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
let webServerRef: WebServer | null = null;
let monitorRef: ResourceMonitor | null = null;
let weixinRef: WeixinChannel | null = null;
let feishuRef: FeishuChannel | null = null;
let ocrRef: import('./services/ocrService.js').OcrService | null = null;
/** 语音服务引用：退出时需关闭活跃会话，避免麦克风与云端连接残留 */
let voiceRef: import('./services/voiceService.js').VoiceService | null = null;
let dshRef: DshIntegrationService | null = null;
let providerCredentialProxyRef: ProviderCredentialProxy | null = null;
let dshLanRef: DshLanGatewayComposition | null = null;

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
  const db = await Database.create();
  dbRef = db;
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
  const engines = new EngineManager(db, {
    managedDshProxyReady: () => providerCredentialProxyRef?.getStatus().running === true
  });
  const channels = new ChannelManager(db);
  const providerManager = new ProviderManager(db, (change) => {
    engines.invalidateProviderVerification(change);
    // Any credential, endpoint, model, or default-route mutation invalidates
    // active managed-runtime capabilities. The proxy only stores token hashes,
    // so revocation does not expose the old Provider key.
    providerCredentialProxyRef?.revokeProvider(change.providerId, 'provider_config_changed');
    if (change.defaultRouteChanged) providerCredentialProxyRef?.revokeAll('provider_route_changed');
  });
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
  pluginRegistry.register(OPC_NEXUS_GOVERNANCE_PLUGIN_MANIFEST);
  pluginRegistry.register(DSH_VISION_PLUGIN_MANIFEST);
  const dshPolicyBroker = new DshPolicyBroker({
    resolve: resolveBuiltinDshHostPolicy,
    audit: (event) => db.audit({
      id: event.decisionId,
      actor: event.agentId,
      action: event.action,
      target: `${event.runtimeId}:${event.capability ?? 'invalid'}`,
      result: `${event.result}:${event.reasonCode}`,
      source: 'dsh'
    })
  });
  const pluginHost = new PluginHost(pluginRegistry, createDshPluginPermissionResolver(dshPolicyBroker, {
    // The current desktop vision IPC is a trusted local Main invocation. DSH
    // transports must supply their authenticated runtime/session policyContext.
    resolveAuthority: (request) => {
      if (request.pluginId === DSH_VISION_PLUGIN_MANIFEST.id
        && request.owner === 'dsh-cordis'
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
      if (request.pluginId === OPC_NEXUS_GOVERNANCE_PLUGIN_ID
        && request.owner === 'nexus-governance'
        && request.capabilityId === DSH_QUEST_GOVERNANCE_CAPABILITY_ID
        && request.input && typeof request.input === 'object' && !Array.isArray(request.input)) {
        const envelope = request.input as Record<string, unknown>;
        if (typeof envelope.runtimeInstanceId !== 'string'
          || typeof envelope.dshSessionId !== 'string'
          || typeof envelope.requestId !== 'string') return null;
        const row = db.raw.prepare(
          `SELECT s.agent_id, a.organization_id
           FROM dsh_sessions s
           JOIN agents a ON a.id = s.agent_id
           WHERE s.id = ? AND s.runtime_instance_id = ? AND s.parent_session_id IS NULL`
        ).get(envelope.dshSessionId, envelope.runtimeInstanceId) as {
          agent_id?: string;
          organization_id?: string;
        } | undefined;
        if (!row?.agent_id || !row.organization_id) return null;
        return {
          requestId: envelope.requestId,
          organizationId: row.organization_id,
          runtimeId: envelope.runtimeInstanceId,
          agentId: row.agent_id,
          sessionId: envelope.dshSessionId,
          target: `plugin:${request.pluginId}/${request.capabilityId}`,
          operation: 'dsh.quest.admission'
        };
      }
      return null;
    }
  }));
  pluginHost.attach(DSH_VISION_PLUGIN_MANIFEST.id, {
    [VISION_TOOL_CAPABILITY_ID]: vision.createToolHandler(),
    [VISION_OCR_TOOL_CAPABILITY_ID]: vision.createOcrToolHandler({
      recognizeBytes: (data) => {
        if (!ocrRef) throw new Error('Local OCR runtime is unavailable');
        return ocrRef.recognizeBytes(data);
      }
    })
  });
  const providerCredentialProxy = new ProviderCredentialProxy({
    resolveProvider: async (binding) => {
      const route = resolveDshProviderBinding(db, providerManager, { agentId: binding.agentId });
      if (!route || route.organizationId !== binding.organizationId
        || route.providerId !== binding.providerId) return null;
      // The live agent binding fixes Provider identity and organization. A
      // Quest may select another model only inside that same Provider route;
      // the credential proxy separately fences the original base URL.
      const resolved = resolveDshProviderCredential(providerManager, {
        providerId: binding.providerId,
        model: binding.model
      });
      return resolved ? { ...resolved, organizationId: route.organizationId } : null;
    },
    audit: (event) => {
      db.audit({
        id: randomUUID(),
        actor: 'system',
        action: `provider.proxy.${event.action}`,
        target: event.providerId ?? event.runtimeId ?? 'managed-dsh',
        result: event.result
      });
    },
    maxGrantTtlMs: 4 * 60 * 60_000,
    upstreamTimeoutMs: 5 * 60_000
  });
  providerCredentialProxyRef = providerCredentialProxy;
  try {
    await providerCredentialProxy.start(0);
  } catch {
    // Keep explicitly selected Local CLI workers available. Managed DSH
    // remains fail-closed because its Supervisor requires a live proxy.
    db.audit({ id: randomUUID(), actor: 'system', action: 'provider.proxy.start', target: 'managed-dsh', result: 'failed' });
  }
  const managedHarnessPaths = deepseekHarnessManagedRuntimePaths();
  const managedHarnessCapabilities = readDeepseekHarnessManagedCapabilities(
    managedHarnessPaths.capabilityFixture
  );
  const dshPluginCatalog = new DshPluginCatalogService({
    runtimeRoot: managedHarnessPaths.root
  });
  // One read-only projection for the Plugins surface. Existing MCP/Skill
  // managers remain authoritative and are intentionally not replaced here.
  const pluginCatalog = new PluginCatalogService({
    registry: pluginRegistry,
    host: pluginHost,
    dsh: dshPluginCatalog,
    // Managers are initialized a little later; the service receives them at
    // registration time below after their construction.
  });
  const environmentDiagnostics = new EnvironmentDiagnosticsService({
    managedRuntimeRoot: managedHarnessPaths.root,
    nativeRoots: [app.getAppPath(), process.resourcesPath].filter((value): value is string => typeof value === 'string'),
    audit: (event) => db.audit({
      id: randomUUID(), actor: 'system', action: `environment.${event.action}`,
      target: event.target, result: event.reason ? `${event.result}:${event.reason}` : event.result
    })
  });
  const dshSupervisor = new DshSupervisor({
    dataRoot: join(app.getPath('userData'), 'aibox-data', 'deepseek-harness-managed'),
    runtimeRoot: managedHarnessPaths.root,
    requireCredentialLease: true,
    resolveCredentialLease: async (context): Promise<DshRuntimeCredentialLease | null> => {
      const route = resolveDshProviderBinding(db, providerManager, context);
      if (!route || !providerCredentialProxy.getStatus().running) return null;
      const issued = await providerCredentialProxy.issueGrant({
        organizationId: route.organizationId,
        runtimeId: context.runtimeId,
        agentId: context.agentId,
        providerId: route.providerId,
        model: route.model,
        ttlMs: 4 * 60 * 60_000,
        maxRequests: 10_000,
        maxConcurrentRequests: 8,
        maxRequestBytes: PROVIDER_CREDENTIAL_PROXY_MAX_REQUEST_BYTES,
        maxResponseBytes: 128 * 1024 * 1024,
        maxRequestsPerMinute: 2_000
      });
      return {
        token: issued.token,
        baseUrl: issued.baseUrl,
        model: issued.model,
        providerId: route.providerId,
        expiresAt: issued.expiresAt,
        renew: async () => (await providerCredentialProxy.renewGrant(issued.grantId, 4 * 60 * 60_000)).expiresAt,
        authorizeModel: (model) => providerCredentialProxy.authorizeGrantModel(issued.grantId, model),
        revoke: (reason) => { providerCredentialProxy.revokeGrant(issued.grantId, reason ?? 'runtime_release'); }
      };
    },
    // DSH receives only the currently persisted, user-approved LAN authority
    // at process launch. Credentials and the LAN private key stay in Main.
    resolveTrustedAuthorities: () => readPersistedDshLanTrustedAuthorities(db)
  });
  // The same durable session projection is shared by the internal executor,
  // isolated desktop Workbench, and LAN edge. Each surface still gets its own
  // coordinator/principal and therefore cannot reuse another surface's lease.
  const dshSessions = new DshSessionService(db, {
    // Human takeover is a trusted Main-side operation, but only at an idle
    // session or a durable DSH turn boundary. Never let a browser interrupt a
    // live Cordis-managed turn merely because it owns a valid desktop cookie.
    authorizeTakeover: ({ requested, current }) => {
      if (requested.controller !== 'HUMAN' || requested.surface !== 'DESKTOP') return false;
      if (!current.lease || current.lease.controller !== 'NEXUS' || current.lease.surface !== 'INTERNAL') return false;
      if (current.lastEventCursor < 0) return true;
      const latest = db.raw.prepare(
        'SELECT type FROM dsh_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1'
      ).get(current.sessionId) as { type?: string } | undefined;
      return latest?.type === 'turn/end';
    }
  });
  // DSH remains the owner of delegation. The governance plugin only projects
  // bounded child sessions into its durable task/workbench view.
  const dshDelegation = new DshDelegationService(db, dshSessions);
  const dshDelegationSync = new DshDelegationSyncService(dshSessions, dshDelegation);
  const dshLan = new DshLanGatewayComposition(db, dshSupervisor, { sessions: dshSessions });
  dshLanRef = dshLan;
  const dsh = new DshIntegrationService(dshSupervisor, new DshWebGateway(), {
    enabled: db.getSetting<boolean>('feature:dshManagedRuntime', true),
    writeGuard: new DshSessionWriteCoordinator(dshSessions, 'DESKTOP')
  });
  dshRef = dsh;
  const executors = new ExecutorRegistry(db, broker, providerManager);
  const orchestrator = new Orchestrator(db, executors, broker);
  executors.setDshRuntime(
    dshSessions,
    dshSupervisor,
    dshDelegationSync,
    managedHarnessCapabilities
  );
  const scheduler = new Scheduler(db, orchestrator);
  const kernelState = new DatabaseKernelState(db);
  const memory = new MemoryService(db);
  const memoryProposals = new MemoryProposalService(db, memory);
  memoryProposals.recoverCommitted();
  const taskScheduleProposals = new TaskScheduleProposalService(db, scheduler);
  taskScheduleProposals.recoverCommitted();
  const kernelRouter = new KernelRouter(
    new CordisControlKernel(),
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
    listDeliverables: () => deliverableManager.list()
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
  const dshQuestSessions = new DshQuestSessionBindingService(
    db,
    dshSessions,
    dshSupervisor,
    projectWorkbench,
    { runtimeCapabilities: managedHarnessCapabilities }
  );
  const dshQuestGovernance = new DshQuestGovernanceService({
    db,
    repository: new DurablePlanningRepository(db),
    dispatchPort: new OrchestratorPlanningDispatchPort(orchestrator, {
      resolveProjectId: (planningSessionId) => resolveDshQuestProjectId(db, planningSessionId)
    }),
    workbench: projectWorkbench
  });
  const dshTypedQuestBridge = new DshTypedQuestBridge({
    governance: dshQuestGovernance,
    policyForContext: (context) => {
      const row = db.raw.prepare(
        `SELECT s.agent_id, a.organization_id
         FROM dsh_sessions s
         JOIN agents a ON a.id = s.agent_id
         JOIN dsh_quest_governance_bindings b ON b.dsh_session_id = s.id
         WHERE s.id = ? AND s.runtime_instance_id = ? AND s.parent_session_id IS NULL
           AND b.planning_session_id = ? AND b.project_id = ?
           AND b.principal_id = ? AND b.organization_id = a.organization_id`
      ).get(
        context.dshSessionId,
        context.runtimeInstanceId,
        context.planningSessionId,
        context.projectId,
        context.principalId
      ) as { agent_id?: string; organization_id?: string } | undefined;
      if (!row?.agent_id || !row.organization_id) return null;
      return dshPolicyBroker.scopeRuntime({
        organizationId: row.organization_id,
        runtimeId: context.runtimeInstanceId,
        agentId: row.agent_id
      });
    },
    resolveContext: (upstreamSessionId) => {
      const rows = db.raw.prepare(
        `SELECT b.planning_session_id, b.project_id, b.principal_id,
                s.id AS dsh_session_id, s.upstream_session_id, s.runtime_instance_id
         FROM dsh_quest_governance_bindings b
         JOIN planning_sessions p ON p.id = b.planning_session_id
         JOIN dsh_sessions s ON s.id = b.dsh_session_id
         WHERE (s.id = ? OR s.upstream_session_id = ?)
           AND s.parent_session_id IS NULL
           AND p.status IN ('DRAFT', 'NEEDS_INPUT', 'PROPOSED', 'APPROVED')
         ORDER BY b.updated_at DESC, b.planning_session_id DESC
         LIMIT 2`
      ).all(upstreamSessionId, upstreamSessionId) as Array<{
        planning_session_id: string;
        project_id: string;
        principal_id: string;
        dsh_session_id: string;
        upstream_session_id: string;
        runtime_instance_id: string;
      }>;
      // rc.6 question frames carry only session identity. Never guess which
      // project owns a frame when more than one active Quest is bound.
      if (rows.length !== 1) return null;
      const row = rows[0]!;
      const quest = dshQuestGovernance.getQuest(row.planning_session_id);
      if (!quest.session.signals) return null;
      return {
        runtimeInstanceId: row.runtime_instance_id,
        upstreamSessionId: row.upstream_session_id,
        dshSessionId: row.dsh_session_id,
        planningSessionId: row.planning_session_id,
        projectId: row.project_id,
        principalId: row.principal_id,
        request: quest.session.request,
        signals: quest.session.signals
      };
    }
  });
  executors.setDshTypedQuestBridge(dshTypedQuestBridge);
  pluginHost.attach(OPC_NEXUS_GOVERNANCE_PLUGIN_ID, {
    [DSH_QUEST_GOVERNANCE_CAPABILITY_ID]: createDshQuestGovernanceAdmissionHandler(dshQuestGovernance, {
      verifySource: ({ runtimeInstanceId, dshSessionId }) => Boolean(db.raw.prepare(
        `SELECT s.id FROM dsh_sessions s
         JOIN dsh_runtime_instances r ON r.id = s.runtime_instance_id
         WHERE s.id = ? AND r.id = ? AND s.parent_session_id IS NULL`
      ).get(dshSessionId, runtimeInstanceId))
    })
  });
  // DSH/Cordis owns planning and execution. AiBox contributes a governed
  // profile-scoped plugin surface; it never becomes a second planner.
  const dshCommunityPlugins = new DshCommunityPluginService({
    runtimeRoot: managedHarnessPaths.root,
    runtimeEntry: managedHarnessPaths.entry,
    nodeExecutable: process.execPath,
    defaultAgentId: 'default',
    resolveProfile: (agentId) => {
      const agent = orchestrator.listAgents().find((candidate) => candidate.id === agentId);
      if (!agent || agent.archived || agent.engineId !== DSH_MANAGED_ENGINE_ID) return null;
      let status;
      try {
        status = dshSupervisor.ensureProfile({
          agentId: agent.id,
          profileId: DSH_MANAGED_PROFILE_ID,
          workspace: agent.workspace || undefined
        });
      } catch {
        return null;
      }
      const state = (): 'running' | 'stopped' | 'unavailable' | 'unknown' => {
        const current = dshSupervisor.getStatus(agent.id, DSH_MANAGED_PROFILE_ID) ?? status;
        switch (current.processState) {
          case 'READY':
          case 'STARTING':
            return 'running';
          case 'STOPPED':
          case 'STOPPING':
            return 'stopped';
          case 'UNHEALTHY':
          case 'BACKOFF':
          case 'STOP_FAILED':
          case 'CRASH_LOOP':
            return 'unavailable';
          default:
            return 'unknown';
        }
      };
      return {
        // The upstream CLI profile is deliberately fixed to `web`; the
        // supervisor profile id remains the per-agent policy identity.
        profileId: 'web',
        home: status.home,
        profileDirectory: status.profileDirectory,
        workspaceRoot: status.workspace,
        getState: state,
        stop: () => dshSupervisor.stop(agent.id, DSH_MANAGED_PROFILE_ID),
        start: async () => {
          await dshSupervisor.start({
            agentId: agent.id,
            profileId: DSH_MANAGED_PROFILE_ID,
            workspace: agent.workspace || undefined
          });
        }
      };
    },
    dshCatalog: dshPluginCatalog,
    builtInCapabilities: [
      {
        id: 'official-dsh-web-ui',
        name: 'DSH 官方 Web UI',
        description: '官方会话、工作区和交付界面已接入独立 Quest Workbench。',
        provider: 'dsh-core',
        status: 'integrated',
        capabilities: ['ui', 'workspace', 'deliverables']
      },
      {
        id: 'dsh-lan-mobile-web',
        name: 'LAN 与手机 Web',
        description: '配对、TLS 网关和官方 DSH Web 代理已由受控 LAN Gateway 接入。',
        provider: 'native-host',
        status: 'integrated',
        capabilities: ['lan', 'mobile-web', 'pairing']
      },
      {
        id: 'host-vision-ocr',
        name: '视觉与 OCR 宿主',
        description: '图片理解和本地 OCR 通过 Main 的凭据、附件与权限代理执行。',
        provider: 'native-host',
        status: 'integrated',
        capabilities: ['vision', 'ocr', 'artifact']
      },
      {
        id: 'quest-project-governance',
        name: '项目治理与工作流投影',
        description: '项目身份、任务投影、Artifact admission 和审批审计已接入内置治理插件。',
        provider: 'native-host',
        status: 'integrated',
        capabilities: ['project', 'workflow', 'approval', 'audit']
      },
      {
        id: 'dsh-multi-agent-delegation',
        name: '多 Agent 委派',
        description: 'DSH 子 Agent、控制指令和项目任务投影已接入委派服务。',
        provider: 'dsh-core',
        status: 'integrated',
        capabilities: ['subagents', 'delegation', 'projection']
      },
      {
        id: 'dsh-durable-work',
        name: '长任务与后台作业',
        description: 'Goal、Job 和会话历史能力已固定在 managed rc.6 Runtime。',
        provider: 'dsh-core',
        status: 'integrated',
        capabilities: ['goals', 'jobs', 'history']
      },
      {
        id: 'dsh-planning',
        name: '规划与老板确认',
        description: 'Plan Mode、Ask User 和 Todo 已固定在 managed rc.6 Runtime。',
        provider: 'dsh-core',
        status: 'integrated',
        capabilities: ['planning', 'ask-user', 'todo']
      }
    ],
    policyForProfile: (agentId, profileId) => {
      const row = db.raw.prepare(
        'SELECT organization_id FROM agents WHERE id = ? AND archived = 0'
      ).get(agentId) as { organization_id?: string } | undefined;
      if (!row?.organization_id) return null;
      return dshPolicyBroker.scopeRuntime({
        organizationId: row.organization_id,
        runtimeId: `dsh-profile:${agentId}:${profileId}`,
        agentId
      });
    },
    audit: (event) => {
      db.audit({
        id: randomUUID(),
        actor: 'admin',
        action: `dsh.community-plugin.${event.action}`,
        target: `${event.agentId ?? 'unknown'}:${event.pluginId}`,
        result: event.result
      });
    }
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
  seedMcpServers(db);
  seedSkills(db);
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

  // Legacy v1 Web admin remains available only for migration tooling. The
  // user-facing desktop/LAN/mobile surface is the managed DSH Web UI.
  const webServer = new WebServer({ db, orchestrator, engines, channels, providers: providerManager, mcp: mcpManager, skills: skillManager, teams: teamEngine, desktopControlPlane });
  webServerRef = webServer;

  const { pushSnapshot } = registerIpc({ db, orchestrator, desktopControlPlane, executors, engines, channels, feishu, wecom, weixin, scheduler, broker, monitor, mcp: mcpManager, skills: skillManager, providers: providerManager, workflows: workflowEngine, projects: projectManager, deliverables: deliverableManager, knowledge: knowledgeManager, automation: automationManager, discovery: discoveryManager, teams: teamEngine, wfPlatforms: wfPlatformMgr, collab: collabManager, ocr: ocrService, vision, visionPluginHost: pluginHost, voice: voiceService, apiBridge, webServer, mobile, mobileAdb, memory, memoryProposals, taskScheduleProposals, dsh, dshSessions, dshDelegation, dshLan, dshPluginCatalog, dshCommunityPlugins, pluginCatalog, environmentDiagnostics, projectWorkbench, projectArtifacts, dshQuestSessions, dshQuestGovernance, questWindows, openMainSurface: requestMainSurface, getMainWindow: () => mainWindow });

  // Restore the persisted LAN intent after all Main services exist. If there
  // is no unique READY managed runtime yet, the composition keeps the intent
  // and waits for the supervisor status callback before opening a listener.
  await dshLan.restoreOnStartup();

  // Finish the authoritative engine/Cordis projection before exposing the
  // first Renderer. This prevents a transient "0 employees / ready" snapshot.
  try {
    await engines.detect();
    try {
      const cordis = ensureCordisAgent(
        orchestrator,
        join(app.getPath('userData'), 'aibox-data', 'workspaces', 'Cordis')
      );
      if (cordis.created) {
        db.audit({
          id: randomUUID(), actor: 'system', action: 'cordis.bootstrap',
          target: cordis.agent.id, result: 'created'
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Cordis] 启动引导失败: ${message}`);
      db.audit({
        id: randomUUID(), actor: 'system', action: 'cordis.bootstrap',
        target: 'managed-dsh', result: 'failed'
      });
    }
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

  if (db.getSetting<boolean>('legacyWebAdminEnabled', false)) {
    try {
      await webServer.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[WebServer] 兼容服务启动失败，服务保持关闭: ${message}`);
      db.audit({ id: randomUUID(), actor: 'system', action: 'webserver.start', target: 'legacy-web-admin', result: 'failed' });
    }
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
      // Stop the authenticated edge first so no LAN request can race a DSH
      // runtime shutdown. DshIntegrationService then drains every runtime.
      try { await dshLanRef?.shutdown(); } catch { /* continue shutdown */ }
      try { await dshRef?.shutdown(); } catch { /* continue shutdown */ }
      try { await providerCredentialProxyRef?.stop(); } catch { /* continue shutdown */ }
      try { await weixinRef?.dispose(); } catch { /* continue shutdown */ }
    })();
    void waitForQuitCleanup(cleanup).finally(() => {
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
