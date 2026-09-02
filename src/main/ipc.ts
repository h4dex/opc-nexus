/**
 * IPC 白名单（PRD 12.2：不允许 Renderer 透传任意命令）
 * Renderer 仅能调用此处显式注册的方法；密钥操作只通过 safeStorage 句柄。
 */
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions
} from 'electron';
import type { Database } from './services/database.js';
import type { Orchestrator } from './services/orchestrator.js';
import type { ExecutorRegistry } from './services/executor/index.js';
import type { EngineManager } from './services/engineManager.js';
import type { ChannelManager } from './services/channelManager.js';
import type { FeishuChannel } from './services/channels/feishuChannel.js';
import type { WecomChannel } from './services/channels/wecomChannel.js';
import type { WeixinChannel } from './services/channels/wechatChannel.js';
import type { Scheduler } from './services/scheduler.js';
import type { ApprovalBroker } from './services/approvalBroker.js';
import type { DesktopControlPlane } from './services/desktopControlPlane.js';
import type { ResourceMonitor } from './services/resourceMonitor.js';
import type { McpManager } from './services/mcpManager.js';
import type { SkillManager } from './services/skillManager.js';
import type { ProviderManager } from './services/providerManager.js';
import type { WorkflowEngine } from './services/workflowEngine.js';
import type { WfPlatformManager } from './services/wfPlatformManager.js';
import type { TeamEngine } from './services/teamEngine.js';
import type { ProjectManager } from './services/projectManager.js';
import type { DeliverableManager } from './services/deliverableManager.js';
import type { KnowledgeManager } from './services/knowledgeManager.js';
import type { DiscoveryManager } from './services/discoveryManager.js';
import type { AutomationManager } from './services/automationManager.js';
import type { CollabManager } from './services/collabManager.js';
import { listRfc1918Addresses, type MobileGatewayService } from './services/mobileGatewayService.js';
import type { MobileAdbService } from './services/mobileAdbService.js';
import type { MemoryService } from './services/memoryService.js';
import type { MemoryProposalService } from './services/memoryProposalService.js';
import type { TaskScheduleProposalService } from './services/taskScheduleProposalService.js';
import type { PluginCatalogService } from './services/pluginCatalog.js';
import type { EnvironmentDiagnosticsService } from './services/environmentDiagnostics.js';
import type { ProjectWorkbenchService } from './services/projectWorkbench.js';
import type { ProjectArtifactService } from './services/projectArtifactService.js';
import type { ArtifactRuntimeManager } from './services/artifactRuntimeManager.js';
import { readTaskArtifactManifest, resolveManifestPath } from './services/projectArtifactManifest.js';
import type { QuestWindowManager } from './services/questWindowManager.js';
import type { HermesServiceManager } from './services/hermesServiceManager.js';
import type { HermesWorkbenchWindowManager } from './services/hermesWorkbenchWindow.js';
import type { HermesEmbeddedWorkbenchManager } from './services/hermesEmbeddedWorkbench.js';
import type { HermesGovernanceBridge } from './services/hermesGovernanceBridge.js';
import type { HermesMobileGatewayService } from './services/hermesMobileGateway.js';
import type { DebugLogService } from './services/debugLogService.js';
import type { VisionService } from './services/visionService.js';
import {
  NEXUS_VISION_PLUGIN_MANIFEST,
  MAX_VISION_IMAGE_BYTES,
  VISION_OCR_TOOL_CAPABILITY_ID,
  VISION_PLUGIN_ID,
  VISION_TOOL_CAPABILITY_ID,
  VisionServiceError
} from './services/visionService.js';
import type { PluginHost } from './services/pluginHost.js';
import { LOCAL_OWNER_PRINCIPAL_ID } from './services/principalIdentity.js';
import { ChatService, LOCAL_CHAT_ORGANIZATION_ID, LOCAL_CHAT_PRINCIPAL_ID } from './services/chatService.js';
import { getMobileToolCatalog, isMobileToolName, MOBILE_TOOL_NAMES } from './services/mobileCatalog.js';
import { createProvisionedAgent } from './services/mobileAgentProvisioning.js';
import { importFromHermes, exportToHermes } from './services/hermesSync.js';
import { getProviderConfig, saveProviderConfig, testProvider } from './services/provider.js';
import { loadConfig, saveConfig } from './services/config.js';
import { parseVoiceCommand } from './services/voiceCommand.js';
import type {
  AppConfig, CreateAgentInput, DeliverableMetaPatch, DeliverableReviewInput, DeliverableVersionInput,
  KnowledgeInput, KnowledgePatch, KnowledgeQuery, KnowledgeVersionInput,
  ProjectInput, ProjectPatch, ScheduleInput, SystemInfo, TodoItem, AgentPersonaPatch, WfNode, WfEdge,
  AutomationReportKind, CustomerDeliveryInput, CustomerDeliveryStatus, ProjectBudgetInput,
  MemoryForgetInput, MemoryListInput, MemoryProposalDecisionInput, MemoryProposalListInput,
  MemoryRecallInput, MemoryRememberInput, MemoryUpdateInput,
  TaskScheduleProposalDecisionInput, TaskScheduleProposalListInput,
  MobileScriptDefinition, MobileToolName, EngineRuntimeConfig,
  EmbeddedWorkbenchBounds, OpenHermesEmbeddedWorkbenchInput,
  HermesMobileLanConfigInput, QuestSettings,
  ProjectArtifactManifest, HermesMobileAccessStatus, HermesMobileRoute
} from '../shared/types.js';
import { NEXUS_ENGINE_ID } from '../shared/types.js';
import { isQuestVisibleEngine } from '../shared/engineVisibility.js';
import { hostname, release } from 'node:os';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import { decodeOptionalUtf8Text, decodeUtf8Text } from './services/textEncoding.js';
import { readRendererSetting, writeRendererSetting } from './services/rendererSettings.js';
import { BRIDGE_KEY_SECRET_REF } from './services/apiBridge.js';
import { summarizeAppMemory } from './services/appMemory.js';

/** 轻量级运行时参数校验（防御异常/恶意输入穿透） */
function assertString(v: unknown, field: string, min = 1, max = 500): string {
  return decodeUtf8Text(v, field, min, max);
}
function assertId(v: unknown, field = 'id'): string {
  return assertString(v, field, 1, 100);
}

function assertProjectRelativePath(v: unknown, field: string, allowEmpty = false): string {
  const value = assertString(v, field, allowEmpty ? 0 : 1, 4_096);
  if ((!allowEmpty && !value) || /^[A-Za-z]:/.test(value) || /^[\\/]/.test(value)
    || value.split(/[\\/]+/).some((part) => part === '.' || part === '..')) {
    throw new Error(`${field} 必须是项目目录内的相对路径`);
  }
  return value;
}

function optionalId(v: unknown, field: string): string | null {
  return v === undefined || v === null || v === '' ? null : assertId(v, field);
}

function optionalUnitInterval(v: unknown, field: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new Error(`${field} must be between 0 and 1`);
  }
  return v;
}

function positiveInteger(v: unknown, field: string): number {
  if (!Number.isInteger(v) || (v as number) < 1) throw new Error(`${field} must be a positive integer`);
  return v as number;
}

function nonNegativeInteger(v: unknown, field: string): number {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error(`${field} must be a non-negative integer`);
  return v as number;
}

function optionalLimit(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isFinite(v) || (v as number) < 1) throw new Error('limit must be a positive number');
  return Math.trunc(v as number);
}

function assertRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
  return value as Record<string, unknown>;
}

/** Rejects unknown keys, and when `required` is supplied also rejects payloads
 * missing a declared field. Without `required` a validator that reads a field
 * only conditionally cannot tell "absent" from "not applicable", which is how a
 * validator once demanded fields its own input type never carried. */
function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
  required?: readonly string[]
): void {
  const keys = new Set(Object.keys(value));
  for (const key of keys) if (!allowed.includes(key)) throw new Error(`${field} 包含未知字段 ${key}`);
  if (!required) return;
  for (const key of required) {
    if (!allowed.includes(key)) throw new Error(`${field} 校验器错误：必需字段 ${key} 不在允许列表内`);
    if (!keys.has(key) || value[key] === undefined) throw new Error(`${field} 缺少必需字段 ${key}`);
  }
}

function embeddedWorkbenchBounds(value: unknown, host: BrowserWindow): EmbeddedWorkbenchBounds {
  const input = assertRecord(value, 'Hermes 嵌入区域');
  assertKeys(input, ['x', 'y', 'width', 'height'], 'Hermes 嵌入区域');
  const bounds = {
    x: nonNegativeInteger(input.x, 'bounds.x'),
    y: nonNegativeInteger(input.y, 'bounds.y'),
    width: nonNegativeInteger(input.width, 'bounds.width'),
    height: nonNegativeInteger(input.height, 'bounds.height')
  };
  if (bounds.width < 320 || bounds.height < 240) throw new Error('Hermes 嵌入区域不得小于 320x240');
  const [contentWidth, contentHeight] = host.getContentSize();
  if (bounds.x + 320 > contentWidth || bounds.y + 240 > contentHeight) {
    throw new Error(
      `Hermes 嵌入区域超出应用窗口（区域 ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}；窗口内容 ${contentWidth}x${contentHeight}）`
    );
  }
  // Chromium viewport overrides, DPI changes, and a just-resized native
  // window can differ by a few frames. Keep the native View inside Main's
  // actual content area instead of rejecting an otherwise usable surface.
  return {
    ...bounds,
    width: Math.min(bounds.width, contentWidth - bounds.x),
    height: Math.min(bounds.height, contentHeight - bounds.y)
  };
}

function visionMimeForFilename(filename: string): string {
  switch (extname(filename).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    default: throw new VisionServiceError('INVALID_ATTACHMENT', '只支持 PNG、JPEG、WebP 和 GIF 图片');
  }
}

function visionBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new VisionServiceError('INVALID_ATTACHMENT', '图片数据格式无效');
}

function visionUploadInput(value: unknown): { data: Uint8Array; mimeType: string; filename?: string } {
  const input = assertRecord(value, 'vision attachment');
  assertKeys(input, ['data', 'mimeType', 'filename'], 'vision attachment');
  const data = visionBytes(input.data);
  if (data.byteLength < 1 || data.byteLength > MAX_VISION_IMAGE_BYTES) {
    throw new VisionServiceError('ATTACHMENT_LIMIT', '图片超过大小限制');
  }
  const mimeType = assertString(input.mimeType, 'mimeType', 1, 64).toLowerCase();
  const filename = input.filename === undefined ? undefined : assertString(input.filename, 'filename', 1, 160);
  return { data, mimeType, filename };
}

const LOCAL_MEMORY_ORGANIZATION_ID = 'org-local';

export const MAX_VOICE_AUDIO_CHUNK_BYTES = 64 * 1024;

export function assertVoiceAudioChunk(value: unknown): ArrayBuffer {
  if (!(value instanceof ArrayBuffer)) throw new Error('语音音频片段必须为 ArrayBuffer');
  if (value.byteLength === 0 || value.byteLength > MAX_VOICE_AUDIO_CHUNK_BYTES || value.byteLength % 2 !== 0) {
    throw new Error(`语音音频片段必须是 1-${MAX_VOICE_AUDIO_CHUNK_BYTES} 字节的 16-bit PCM`);
  }
  return value;
}

function assertPort(v: unknown): number {
  if (!Number.isInteger(v) || (v as number) < 1024 || (v as number) > 65535) throw new Error('端口必须为 1024-65535 的整数');
  return v as number;
}

function assertHermesMobileLanPort(v: unknown, field: string, allowWellKnown = false): number {
  const minimum = allowWellKnown ? 1 : 1024;
  if (!Number.isSafeInteger(v) || (v as number) < minimum || (v as number) > 65535) {
    throw new Error(`${field} must be an integer between ${minimum} and 65535`);
  }
  return v as number;
}

function assertHermesMobileLanConfigInput(value: unknown): HermesMobileLanConfigInput {
  const input = assertRecord(value, 'Hermes mobile LAN config');
  assertKeys(input, ['bindHost', 'port', 'publicHost', 'publicPort'], 'Hermes mobile LAN config');
  const result: HermesMobileLanConfigInput = {
    bindHost: assertString(input.bindHost, 'bindHost', 1, 64)
  };
  if (input.port !== undefined) result.port = assertHermesMobileLanPort(input.port, 'port');
  if (input.publicHost !== undefined) result.publicHost = assertString(input.publicHost, 'publicHost', 1, 255);
  if (input.publicPort !== undefined) result.publicPort = assertHermesMobileLanPort(input.publicPort, 'publicPort', true);
  return result;
}

function assertMobileTool(v: unknown): MobileToolName {
  if (!isMobileToolName(v)) throw new Error('未知 Android 工具');
  return v;
}

function assertMobileTools(v: unknown): MobileToolName[] {
  if (!Array.isArray(v) || v.length > MOBILE_TOOL_NAMES.length) throw new Error('Android 工具策略无效');
  const tools = [...new Set(v.map(assertMobileTool))];
  if (tools.length !== v.length) throw new Error('Android 工具策略包含重复项');
  return tools;
}

function decodeAgentInput(input: CreateAgentInput): CreateAgentInput {
  if (!input || typeof input !== 'object') throw new Error('员工配置无效');
  if (input.memoryMode !== undefined && !['long_term', 'short_term', 'none'].includes(input.memoryMode)) {
    throw new Error('员工记忆策略无效');
  }
  return {
    ...input,
    name: assertString(input.name, 'name', 2, 30),
    role: assertString(input.role, 'role', 2, 500),
    systemPrompt: assertString(input.systemPrompt ?? '', 'systemPrompt', 0, 20_000),
    soulMd: decodeOptionalUtf8Text(input.soulMd, 'soulMd', 100_000) ?? '',
    agentsMd: decodeOptionalUtf8Text(input.agentsMd, 'agentsMd', 100_000) ?? '',
    userMd: decodeOptionalUtf8Text(input.userMd, 'userMd', 100_000) ?? '',
    workspace: decodeOptionalUtf8Text(input.workspace, 'workspace', 2_000) ?? ''
  };
}

function decodePersonaPatch(patch: AgentPersonaPatch): AgentPersonaPatch {
  if (!patch || typeof patch !== 'object') throw new Error('员工配置更新无效');
  if (patch.memoryMode !== undefined && !['long_term', 'short_term', 'none'].includes(patch.memoryMode)) {
    throw new Error('员工记忆策略无效');
  }
  return {
    ...patch,
    name: decodeOptionalUtf8Text(patch.name, 'name', 30),
    role: decodeOptionalUtf8Text(patch.role, 'role', 500),
    systemPrompt: decodeOptionalUtf8Text(patch.systemPrompt, 'systemPrompt', 20_000),
    soulMd: decodeOptionalUtf8Text(patch.soulMd, 'soulMd', 100_000),
    agentsMd: decodeOptionalUtf8Text(patch.agentsMd, 'agentsMd', 100_000),
    userMd: decodeOptionalUtf8Text(patch.userMd, 'userMd', 100_000),
    modelOverride: decodeOptionalUtf8Text(patch.modelOverride, 'modelOverride', 200)
  };
}

function safeFileSegment(value: string): string {
  const safe = value.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 80);
  return safe || 'deliverable';
}

export interface IpcDeps {
  db: Database;
  orchestrator: Orchestrator;
  desktopControlPlane: DesktopControlPlane;
  executors: ExecutorRegistry;
  engines: EngineManager;
  channels: ChannelManager;
  feishu: FeishuChannel;
  wecom: WecomChannel;
  weixin: WeixinChannel;
  scheduler: Scheduler;
  broker: ApprovalBroker;
  monitor: ResourceMonitor;
  mcp: McpManager;
  skills: SkillManager;
  providers: ProviderManager;
  workflows: WorkflowEngine;
  projects: ProjectManager;
  deliverables: DeliverableManager;
  knowledge: KnowledgeManager;
  automation: AutomationManager;
  discovery: DiscoveryManager;
  teams: TeamEngine;
  wfPlatforms: WfPlatformManager;
  collab: CollabManager;
  ocr: import('./services/ocrService.js').OcrService;
  vision: VisionService;
  visionPluginHost?: PluginHost;
  voice: import('./services/voiceService.js').VoiceService;
  apiBridge: import('./services/apiBridge.js').ApiBridge;
  mobile: MobileGatewayService;
  mobileAdb: MobileAdbService;
  memory: MemoryService;
  memoryProposals: MemoryProposalService;
  taskScheduleProposals: TaskScheduleProposalService;
  /** Unified renderer-safe view over Host, MCP, Skills and execution adapters. */
  pluginCatalog?: PluginCatalogService;
  /** Main-process environment/runtime diagnostics; native libraries are never loaded. */
  environmentDiagnostics?: EnvironmentDiagnosticsService;
  /** Project-centric Quest execution projection. */
  projectWorkbench?: ProjectWorkbenchService;
  /** Project-scoped file listing and short-lived preview authorization. */
  projectArtifacts?: ProjectArtifactService;
  /** Main-owned lifecycle for verified artifact preview processes. */
  artifactRuntime?: ArtifactRuntimeManager;
  /** Trusted renderer shell used for project-scoped Quest-only windows. */
  questWindows?: QuestWindowManager;
  /** Project-scoped Hermes runtime and Main-owned Workbench window. */
  hermesServices?: HermesServiceManager;
  hermesWindows?: HermesWorkbenchWindowManager;
  hermesEmbedded?: HermesEmbeddedWorkbenchManager;
  hermesGovernance?: HermesGovernanceBridge;
  hermesMobile?: HermesMobileGatewayService;
  /** Opt-in diagnostic file logger. */
  debugLogs?: DebugLogService;
  /** Restores or creates the regular desktop control center from a Quest-only launch. */
  openMainSurface: () => void;
  getMainWindow: () => BrowserWindow | null;
}

export function registerIpc(deps: IpcDeps) {
  const { db, orchestrator, desktopControlPlane, executors, engines, channels, feishu, wecom, weixin, scheduler, broker, monitor, mcp, skills, providers, workflows, projects, deliverables, knowledge, automation, discovery, teams, wfPlatforms, collab, ocr, vision, visionPluginHost, voice, mobile, mobileAdb, memory, memoryProposals, taskScheduleProposals, pluginCatalog, environmentDiagnostics, projectWorkbench, projectArtifacts, artifactRuntime, questWindows, hermesServices, hermesWindows, hermesEmbedded, hermesGovernance, hermesMobile, debugLogs, openMainSurface, getMainWindow } = deps;
  const debugLogService = debugLogs && typeof debugLogs === 'object' && typeof debugLogs.record === 'function'
    ? debugLogs : null;
  const registerRaw = ipcMain.handle.bind(ipcMain);
  const handle: typeof ipcMain.handle = (channel, listener) => {
    registerRaw(channel, (event, ...args) => {
      const startedAt = Date.now();
      try {
        const result = listener(event, ...args);
        if (result && typeof result === 'object' && typeof result.then === 'function') {
          return Promise.resolve(result).then((value) => {
            debugLogService?.record('debug', 'ipc', channel, { durationMs: Date.now() - startedAt, result: 'ok' });
            return value;
          }, (error) => {
            debugLogService?.record('error', 'ipc', channel, {
              durationMs: Date.now() - startedAt, result: 'failed', error
            });
            throw error;
          });
        }
        debugLogService?.record('debug', 'ipc', channel, { durationMs: Date.now() - startedAt, result: 'ok' });
        return result;
      } catch (error) {
        debugLogService?.record('error', 'ipc', channel, {
          durationMs: Date.now() - startedAt,
          result: 'failed',
          error
        });
        throw error;
      }
    });
  };
  const questWindowService = questWindows && typeof questWindows === 'object' ? questWindows : null;
  const windowForSender = (event: IpcMainInvokeEvent): BrowserWindow | null => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    return senderWindow && !senderWindow.isDestroyed() ? senderWindow : getMainWindow();
  };
  const usableProjectDirectory = (candidate: unknown): candidate is string => {
    if (typeof candidate !== 'string' || !candidate.trim()) return false;
    try {
      const stat = lstatSync(candidate);
      return stat.isDirectory() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  };
  const ensureProjectWorkspace = async (
    event: IpcMainInvokeEvent,
    projectId: string
  ): Promise<{ workspace: string; changed: boolean } | null> => {
    if (!projectWorkbench) return null;
    const existing = projectWorkbench.getExplicitWorkspacePath(projectId);
    if (usableProjectDirectory(existing)) return { workspace: existing, changed: false };
    const owner = windowForSender(event);
    if (!owner) throw new Error('应用窗口不可用，无法选择项目目录');
    const result = await dialog.showOpenDialog(owner, {
      title: '选择项目工作目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const selected = result.filePaths[0];
    if (!usableProjectDirectory(selected)) throw new Error('选择的路径不是有效目录，或目录是符号链接');
    projectWorkbench.setWorkspacePath(projectId, selected);
    return { workspace: selected, changed: true };
  };
  const automaticProjectWorkspace = (projectName: unknown): string => {
    const root = join(app.getPath('home'), 'opc-nexus', 'projects');
    mkdirSync(root, { recursive: true });
    if (!usableProjectDirectory(root)) throw new Error('系统项目目录不可用或是符号链接');
    const safeName = (typeof projectName === 'string' ? projectName.trim() : '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
      .replace(/[. ]+$/g, '')
      .slice(0, 60) || 'project';
    const target = join(root, `${safeName}-${randomUUID().slice(0, 8)}`);
    mkdirSync(target, { recursive: false });
    if (!usableProjectDirectory(target)) throw new Error('无法创建系统项目目录');
    return target;
  };
  const chatService = new ChatService(db);
  const localChatAgent = (agentId: string) => {
    const listedAgents = orchestrator.listAgents?.();
    // A few isolated IPC tests provide a deliberately minimal orchestrator
    // double. Production always returns an array; keep that test seam narrow
    // without weakening the real database organization check below.
    const agent = Array.isArray(listedAgents)
      ? listedAgents.find((candidate) => candidate.id === agentId)
      : { id: agentId, archived: false, engineId: NEXUS_ENGINE_ID } as ReturnType<Orchestrator['listAgents']>[number];
    const row = db.raw.prepare('SELECT organization_id, archived FROM agents WHERE id = ? LIMIT 1').get(agentId) as { organization_id?: string; archived?: number } | undefined;
    if (!agent || agent.archived || (row && (row.organization_id !== LOCAL_CHAT_ORGANIZATION_ID || Number(row.archived ?? 0) !== 0))) {
      throw new Error('数字员工不存在或无权访问');
    }
    return agent;
  };

  const broadcast = (channel: string, payload: unknown) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };
  // 快照推送节流（trailing）：任务高频状态变化时最多 ~400ms 推一次，降低 IPC 序列化开销
  let snapTimer: NodeJS.Timeout | null = null;
  let snapPending = false;
  const pushSnapshot = () => {
    if (snapTimer) { snapPending = true; return; }
    broadcast('aibox:snapshot', buildSnapshot(deps));
    snapTimer = setTimeout(() => {
      snapTimer = null;
      if (snapPending) { snapPending = false; pushSnapshot(); }
    }, 400);
  };

  // 编排器状态变化 → 推送全量快照（本地事件到 UI ≤ 2 秒）；审批挂起即时可见
  orchestrator.onChange(pushSnapshot);
  // Quest 的 Hermes Workbench 订阅同一项目 WebSocket，任务状态变化时
  // 立即刷新员工、子 Agent 和进度投影，不必等待页面的轮询周期。
  if (hermesServices) {
    orchestrator.onChange(() => {
      for (const binding of hermesServices.listBindings()) {
        hermesServices.publishProjectStateEvent(binding.projectId, 'task');
      }
    });
  }
  broker.onChange(pushSnapshot);
  weixin.onStateChange(pushSnapshot);
  // 任务输出流式推送（逐字显示，无需轮询）
  orchestrator.onOutput((taskId, chunk) => {
    broadcast('aibox:taskOutput', { taskId, chunk });
  });
  // 语音识别结果流式推送（边说边出字）与错误如实上报
  voice.onTranscript((sessionId, transcript) => {
    broadcast('aibox:voiceTranscript', { sessionId, ...transcript });
  });
  voice.onError((sessionId, message) => {
    broadcast('aibox:voiceError', { sessionId, message });
  });
  mobile.onEvent((event) => broadcast('aibox:mobileEvent', event));
  // 资源样本 → 实时推送
  monitor.onSample((sample) => {
    broadcast('aibox:resources', {
      sample,
      health: monitor.getHealth()
    });
  });

  // ---------- 查询 ----------
  handle('aibox:getSnapshot', () => buildSnapshot(deps));
  handle('aibox:getAppVersion', () => app.getVersion());
  handle('aibox:getResourceHistory', () => ({ history: monitor.getHistory(), health: monitor.getHealth() }));
  handle('aibox:getSystemInfo', (): SystemInfo => ({
    platform: process.platform,
    osVersion: release(),
    hostname: hostname(),
    uptimeSec: Math.floor(process.uptime()),
    appVersion: app.getVersion()
  }));
  handle('aibox:getAppMemory', () => summarizeAppMemory(app.getAppMetrics(), process.memoryUsage()));
  handle('aibox:globalSearch', (_e, query: string) => discovery.search(assertString(query ?? '', 'query', 0, 100)));
  handle('aibox:getActionCenter', () => discovery.actions());
  handle('aibox:listMemories', (_e, input: MemoryListInput = {}) => memory.list({
    organizationId: LOCAL_MEMORY_ORGANIZATION_ID,
    status: input?.status,
    limit: optionalLimit(input?.limit)
  }));
  handle('aibox:recallMemories', (_e, input: MemoryRecallInput = {}) => memory.recall({
    organizationId: LOCAL_MEMORY_ORGANIZATION_ID,
    principalId: optionalId(input?.principalId, 'principalId'),
    channelId: optionalId(input?.channelId, 'channelId'),
    conversationId: optionalId(input?.conversationId, 'conversationId'),
    agentId: optionalId(input?.agentId, 'agentId'),
    projectId: optionalId(input?.projectId, 'projectId'),
    query: input?.query === undefined ? undefined : assertString(input.query, 'query', 0, 4_000),
    limit: optionalLimit(input?.limit)
  }));
  handle('aibox:rememberMemory', (_e, input: MemoryRememberInput) => memory.remember({
    organizationId: LOCAL_MEMORY_ORGANIZATION_ID,
    principalId: optionalId(input?.principalId, 'principalId'),
    channelId: optionalId(input?.channelId, 'channelId'),
    conversationId: optionalId(input?.conversationId, 'conversationId'),
    agentId: optionalId(input?.agentId, 'agentId'),
    projectId: optionalId(input?.projectId, 'projectId'),
    kind: assertString(input?.kind, 'kind', 1, 80),
    content: assertString(input?.content, 'content', 1, 8_000),
    importance: optionalUnitInterval(input?.importance, 'importance'),
    actor: 'admin',
    source: 'desktop'
  }));
  handle('aibox:updateMemory', (_e, input: MemoryUpdateInput) => memory.update({
    organizationId: LOCAL_MEMORY_ORGANIZATION_ID,
    memoryId: assertId(input?.memoryId, 'memoryId'),
    expectedRevision: positiveInteger(input?.expectedRevision, 'expectedRevision'),
    content: input?.content === undefined ? undefined : assertString(input.content, 'content', 1, 8_000),
    importance: optionalUnitInterval(input?.importance, 'importance'),
    reason: input?.reason === undefined ? undefined : assertString(input.reason, 'reason', 0, 2_000),
    actor: 'admin',
    source: 'desktop'
  }));
  handle('aibox:forgetMemory', (_e, input: MemoryForgetInput) => memory.forget({
    organizationId: LOCAL_MEMORY_ORGANIZATION_ID,
    memoryId: assertId(input?.memoryId, 'memoryId'),
    expectedRevision: positiveInteger(input?.expectedRevision, 'expectedRevision'),
    reason: input?.reason === undefined ? undefined : assertString(input.reason, 'reason', 0, 2_000),
    actor: 'admin',
    source: 'desktop'
  }));
  handle('aibox:listMemoryProposals', (_e, input: MemoryProposalListInput = {}) => memoryProposals.list({
    organizationId: LOCAL_MEMORY_ORGANIZATION_ID,
    status: input?.status,
    limit: optionalLimit(input?.limit)
  }));
  handle('aibox:acceptMemoryProposal', (_e, input: MemoryProposalDecisionInput) => memoryProposals.accept({
    organizationId: LOCAL_MEMORY_ORGANIZATION_ID,
    proposalId: assertId(input?.proposalId, 'proposalId'),
    reason: input?.reason === undefined ? undefined : assertString(input.reason, 'reason', 0, 2_000),
    actor: 'admin',
    source: 'desktop'
  }));
  handle('aibox:rejectMemoryProposal', (_e, input: MemoryProposalDecisionInput) => memoryProposals.reject({
    organizationId: LOCAL_MEMORY_ORGANIZATION_ID,
    proposalId: assertId(input?.proposalId, 'proposalId'),
    reason: input?.reason === undefined ? undefined : assertString(input.reason, 'reason', 0, 2_000),
    actor: 'admin',
    source: 'desktop'
  }));
  handle('aibox:listTaskScheduleProposals', (_e, input: TaskScheduleProposalListInput = {}) => taskScheduleProposals.list({
    organizationId: LOCAL_MEMORY_ORGANIZATION_ID,
    status: input?.status,
    limit: optionalLimit(input?.limit)
  }));
  handle('aibox:acceptTaskScheduleProposal', (_e, input: TaskScheduleProposalDecisionInput) => {
    const accepted = taskScheduleProposals.accept({
      organizationId: LOCAL_MEMORY_ORGANIZATION_ID,
      proposalId: assertId(input?.proposalId, 'proposalId'),
      reason: input?.reason === undefined ? undefined : assertString(input.reason, 'reason', 0, 2_000),
      actor: 'admin',
      source: 'desktop'
    });
    pushSnapshot();
    return accepted;
  });
  handle('aibox:rejectTaskScheduleProposal', (_e, input: TaskScheduleProposalDecisionInput) => taskScheduleProposals.reject({
    organizationId: LOCAL_MEMORY_ORGANIZATION_ID,
    proposalId: assertId(input?.proposalId, 'proposalId'),
    reason: input?.reason === undefined ? undefined : assertString(input.reason, 'reason', 0, 2_000),
    actor: 'admin',
    source: 'desktop'
  }));
  handle('aibox:dismissAction', (_e, actionKey: string, fingerprint: string) => {
    discovery.dismiss(assertString(actionKey, 'actionKey', 1, 180), assertString(fingerprint, 'fingerprint', 8, 80));
    return { ok: true };
  });

  // ---------- 项目 ----------
  handle('aibox:createProject', async (event, input: ProjectInput) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('项目数据无效');
    const workspaceMode = input.workspaceMode ?? 'automatic';
    if (workspaceMode !== 'automatic' && workspaceMode !== 'custom') throw new Error('项目目录模式无效');
    if (!projectWorkbench) throw new Error('项目工作目录服务不可用');

    let workspace: string;
    let createdAutomaticDirectory = false;
    if (workspaceMode === 'custom') {
      const owner = windowForSender(event);
      if (!owner) throw new Error('应用窗口不可用，无法选择项目目录');
      const result = await dialog.showOpenDialog(owner, {
        title: '选择项目交付目录',
        properties: ['openDirectory', 'createDirectory']
      });
      if (result.canceled || !result.filePaths[0]) throw new Error('已取消创建项目');
      workspace = result.filePaths[0];
      if (!usableProjectDirectory(workspace)) throw new Error('选择的路径不是有效目录，或目录是符号链接');
    } else {
      workspace = automaticProjectWorkspace(input.name);
      createdAutomaticDirectory = true;
    }

    try {
      const project = db.transaction(() => {
        const created = projects.create(input);
        projectWorkbench.setWorkspacePath(created.id, workspace);
        return created;
      });
      pushSnapshot();
      return project;
    } catch (error) {
      if (createdAutomaticDirectory) {
        try { rmSync(workspace, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
      }
      throw error;
    }
  });
  handle('aibox:updateProject', (_e, id: string, patch: ProjectPatch) => {
    const project = projects.update(assertId(id, 'projectId'), patch);
    pushSnapshot();
    return project;
  });
  handle('aibox:archiveProject', (_e, id: string) => {
    const project = projects.archive(assertId(id, 'projectId'));
    pushSnapshot();
    return project;
  });
  handle('aibox:getProjectOperations', () => projects.operations(deliverables.list()));
  if (projectWorkbench) {
    handle('aibox:getProjectWorkbench', (_e, projectId: string) =>
      projectWorkbench.get(assertId(projectId, 'projectId')));
    handle('aibox:saveQuestSettings', async (_e, projectId: string, patch: Partial<QuestSettings>) => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Quest 设置无效');
      const id = assertId(projectId, 'projectId');
      const previous = projectWorkbench.getSettings(id);
      const saved = projectWorkbench.saveSettings(id, patch);
      const hermesRuntimeConfigChanged = previous.model !== saved.model
        || previous.workerAgentIds.join('\u0000') !== saved.workerAgentIds.join('\u0000')
        || previous.pluginIds.join('\u0000') !== saved.pluginIds.join('\u0000');
      if (hermesRuntimeConfigChanged && hermesServices) {
        const runtime = hermesServices.getStatus(id);
        if (!['stopped', 'error'].includes(runtime.state)) {
          await hermesServices.stop(id);
        }
      }
      return saved;
    });
    handle('aibox:openProjectWorkspace', async (event, projectId: string) => {
      const id = assertId(projectId, 'projectId');
      const resolved = await ensureProjectWorkspace(event, id);
      if (!resolved) return { ok: false, message: '已取消选择项目目录', workspaceChanged: false };
      const error = await shell.openPath(resolved.workspace);
      return error
        ? { ok: false, message: error, workspaceChanged: resolved.changed }
        : { ok: true, message: '', workspaceChanged: resolved.changed };
    });
    if (projectArtifacts) {
      handle('aibox:listProjectArtifacts', (_event, projectId: string, relativeDirectory?: string) =>
        projectArtifacts.list(
          assertId(projectId, 'projectId'),
          relativeDirectory === undefined ? '' : assertProjectRelativePath(relativeDirectory, 'relativeDirectory', true)
        ));
      handle('aibox:previewProjectArtifact', (_event, projectId: string, relativePath: string) =>
        projectArtifacts.preview(
          assertId(projectId, 'projectId'),
          assertProjectRelativePath(relativePath, 'relativePath')
        ));
      handle('aibox:hashProjectArtifact', (_event, projectId: string, relativePath: string) =>
        projectArtifacts.hash(
          assertId(projectId, 'projectId'),
          assertProjectRelativePath(relativePath, 'relativePath')
        ));
      handle('aibox:revealProjectArtifact', (_event, projectId: string, relativePath: string) => {
        const target = projectArtifacts.resolveForReveal(
          assertId(projectId, 'projectId'),
          assertProjectRelativePath(relativePath, 'relativePath')
        );
        shell.showItemInFolder(target);
        return { ok: true };
      });
    }
  }

  // ---------- Hermes project runtime ----------
  if (hermesServices) {
    handle('aibox:getHermesRuntimeStatus', (_event, projectId: string) =>
      hermesServices.getStatus(assertId(projectId, 'projectId')));
    handle('aibox:listHermesProjectBindings', () => hermesServices.listBindings());
    handle('aibox:startHermesProject', async (_event, projectId: string) => {
      const id = assertId(projectId, 'projectId');
      const status = await hermesServices.start(id);
      pushSnapshot();
      return status;
    });
    handle('aibox:stopHermesProject', async (_event, projectId: string) => {
      const id = assertId(projectId, 'projectId');
      const status = await hermesServices.stop(id);
      pushSnapshot();
      return status;
    });
    handle('aibox:restartHermesProject', async (_event, projectId: string) => {
      const id = assertId(projectId, 'projectId');
      const status = await hermesServices.restart(id);
      pushSnapshot();
      return status;
    });
    handle('aibox:emergencyStopHermesProject', async (_event, projectId: string) => {
      const id = assertId(projectId, 'projectId');
      const status = await hermesServices.emergencyStop(id);
      pushSnapshot();
      return status;
    });
    handle('aibox:getHermesMemoryIndex', (_event, projectId: string) =>
      hermesServices.memoryIndex(assertId(projectId, 'projectId')));
    if (hermesMobile) {
      handle('aibox:listHermesMobileLanAddresses', () => listRfc1918Addresses());
      handle('aibox:getHermesMobileAccessStatus', (
        _event,
        projectId: string
      ): HermesMobileAccessStatus => hermesMobile.getProjectStatus(assertId(projectId, 'projectId')));
      handle('aibox:createHermesMobilePairing', (
        _event,
        projectId: string,
        input?: unknown
      ): Promise<HermesMobileRoute> => {
        const id = assertId(projectId, 'projectId');
        return input === undefined
          ? hermesMobile.createPairing(id)
          : hermesMobile.createPairing(id, assertHermesMobileLanConfigInput(input));
      });
      handle('aibox:stopHermesMobileAccess', async (_event, projectId: string): Promise<HermesMobileAccessStatus> => {
        const id = assertId(projectId, 'projectId');
        await hermesMobile.stopProject(id);
        return hermesMobile.getProjectStatus(id);
      });
    }
  }
  if (hermesWindows) {
    handle('aibox:openHermesWorkbench', async (event, projectId: string) => {
      const id = assertId(projectId, 'projectId');
      const workspace = await ensureProjectWorkspace(event, id);
      if (!workspace) throw new Error('已取消选择项目工作目录，Hermes Workbench 未启动');
      const status = await hermesWindows.open(id);
      db.audit({ id: randomUUID(), actor: 'admin', action: 'hermes.workbench.open', target: id, result: 'ok', source: 'desktop' });
      return status;
    });
    handle('aibox:closeHermesWorkbench', () => hermesWindows.close());
    handle('aibox:getHermesWorkbenchStatus', () => hermesWindows.getStatus());
  }
  if (hermesGovernance) {
    handle('aibox:listHermesClarifications', (_event, projectId: string, conversationId?: string) =>
      hermesGovernance.listOpen(assertId(projectId, 'projectId'), conversationId === undefined ? undefined : assertId(conversationId, 'conversationId')));
    handle('aibox:answerHermesClarification', (_event, input: unknown) => {
      const value = assertRecord(input, 'Hermes clarification answer');
      assertKeys(value, ['clarifyId', 'projectId', 'principalId', 'answer'], 'Hermes clarification answer', ['clarifyId', 'projectId', 'principalId', 'answer']);
      return hermesGovernance.answerClarify({
        clarifyId: assertId(value.clarifyId, 'clarifyId'),
        projectId: assertId(value.projectId, 'projectId'),
        principalId: assertId(value.principalId, 'principalId'),
        answer: value.answer
      });
    });
    handle('aibox:listHermesPlanProjections', (_event, projectId: string) =>
      hermesGovernance.listPlanProjections(assertId(projectId, 'projectId')));
    handle('aibox:approveHermesPlan', (_event, projectId: string, draftId: string) =>
      hermesGovernance.approvePlan(assertId(draftId, 'draftId'), assertId(projectId, 'projectId'), LOCAL_OWNER_PRINCIPAL_ID));
    handle('aibox:dispatchHermesPlan', (_event, projectId: string, draftId: string) =>
      hermesGovernance.dispatchPlan(assertId(draftId, 'draftId'), assertId(projectId, 'projectId'), LOCAL_OWNER_PRINCIPAL_ID));
    handle('aibox:createHermesProjectConversation', (_event, projectId: string, employeeId?: string) => {
      if (!projectWorkbench) throw new Error('项目工作台不可用');
      const governance = hermesGovernance;
      if (!governance) throw new Error('Hermes 会话治理不可用');
      const safeProjectId = assertId(projectId, 'projectId');
      const project = projectWorkbench.get(safeProjectId).project;
      if (project.status === 'archived') throw new Error('已归档项目不能创建 Hermes 会话');
      const safeEmployeeId = employeeId === undefined || employeeId === null || employeeId === ''
        ? undefined
        : assertId(employeeId, 'employeeId');
      if (safeEmployeeId) {
        const selection = projectWorkbench.getWorkerSelection(safeProjectId);
        if (selection.mode === 'restricted' && !selection.workerAgentIds.includes(safeEmployeeId)) {
          throw new Error('所选数字员工不在该项目的固定员工池中，请选择其他项目或先更新项目员工范围');
        }
      }
      return governance.createConversation(
        safeProjectId,
        safeEmployeeId ? { employeeId: safeEmployeeId } : {}
      );
    });
  }

  // ---------- 项目经营自动化 ----------
  handle('aibox:getAutomationOverview', (_e, projectId?: string) =>
    automation.overview(projectId ? assertId(projectId, 'projectId') : undefined));
  handle('aibox:runAutomationReport', (_e, kind: AutomationReportKind, projectId: string) => {
    if (!['project_inspection', 'weekly_report', 'monthly_report'].includes(kind)) throw new Error('自动化报告类型无效');
    return automation.run(kind, assertId(projectId, 'projectId'));
  });
  handle('aibox:setProjectBudget', (_e, projectId: string, input: ProjectBudgetInput) =>
    automation.setBudget(assertId(projectId, 'projectId'), input));
  handle('aibox:recommendAssignees', (_e, projectId: string, brief: string) =>
    automation.recommendAssignees(assertId(projectId, 'projectId'), assertString(brief ?? '', 'brief', 0, 500)));
  handle('aibox:createCustomerDelivery', (_e, input: CustomerDeliveryInput) => {
    if (!input || !Array.isArray(input.deliverableIds) || input.deliverableIds.some((id) => typeof id !== 'string')) throw new Error('成果列表无效');
    return automation.createDelivery({
      projectId: assertId(input.projectId, 'projectId'),
      customerName: assertString(input.customerName, 'customerName', 2, 100),
      title: assertString(input.title, 'title', 2, 160),
      deliverableIds: input.deliverableIds.map((id) => assertId(id, 'deliverableId')),
      note: input.note ? assertString(input.note, 'note', 1, 1000) : undefined
    });
  });
  handle('aibox:updateCustomerDeliveryStatus', (_e, id: string, status: CustomerDeliveryStatus) => {
    if (!['draft', 'delivered', 'accepted'].includes(status)) throw new Error('交付状态无效');
    return automation.updateDeliveryStatus(assertId(id, 'deliveryId'), status);
  });

  // ---------- 成果验收 ----------
  handle('aibox:listDeliverables', () => deliverables.list());
  handle('aibox:getDeliverable', (_e, id: string) => deliverables.get(assertId(id, 'deliverableId')));
  handle('aibox:updateDeliverableMeta', (_e, id: string, patch: DeliverableMetaPatch) =>
    deliverables.updateMeta(assertId(id, 'deliverableId'), patch));
  handle('aibox:addDeliverableVersion', (_e, id: string, input: DeliverableVersionInput) =>
    deliverables.addVersion(assertId(id, 'deliverableId'), input));
  handle('aibox:reviewDeliverable', (_e, id: string, input: DeliverableReviewInput) => {
    const deliverableId = assertId(id, 'deliverableId');
    const current = deliverables.get(deliverableId);
    if (!current) throw new Error('成果不存在');
    let reworkRef: string | null = null;
    let reworkMessage: string | null = null;
    if (input.status === 'rework' && input.createRework) {
      const instruction = `返工要求：${assertString(input.note, 'note', 2, 1000)}\n原成果：${current.title}`;
      if (current.sourceType === 'task') {
        const task = orchestrator.createFollowUpTask(current.sourceId, instruction);
        reworkRef = task.id;
        reworkMessage = '返工任务已派发给原数字员工';
      } else {
        const result = teams.trigger(current.ownerId, instruction, current.projectId ?? undefined);
        if (!result.ok || !result.runId) throw new Error(result.message);
        reworkRef = result.runId;
        reworkMessage = '专家团返工运行已启动';
      }
    }
    const result = deliverables.review(deliverableId, input, reworkRef);
    if (!result) throw new Error('成果不存在');
    if (result.deliverable.reviewStatus === 'accepted') knowledge.ingestDeliverable(result.deliverable);
    pushSnapshot();
    return { ...result, reworkRef, reworkMessage };
  });
  handle('aibox:getProjectDeliverablePackage', (_e, projectId: string) =>
    deliverables.packageForProject(assertId(projectId, 'projectId')));

  // ---------- 项目知识库 ----------
  handle('aibox:listKnowledge', (_e, query?: KnowledgeQuery) => knowledge.list(query ?? {}));
  handle('aibox:getKnowledge', (_e, id: string) => knowledge.get(assertId(id, 'knowledgeId')));
  handle('aibox:createKnowledge', (_e, input: KnowledgeInput) =>
    knowledge.create(input));
  handle('aibox:updateKnowledge', (_e, id: string, patch: KnowledgePatch) =>
    knowledge.update(assertId(id, 'knowledgeId'), patch));
  handle('aibox:addKnowledgeVersion', (_e, id: string, input: KnowledgeVersionInput) =>
    knowledge.addVersion(assertId(id, 'knowledgeId'), input));
  handle('aibox:exportDeliverable', async (_e, id: string, format: 'markdown' | 'json') => {
    const detail = deliverables.get(assertId(id, 'deliverableId'));
    if (!detail) throw new Error('成果不存在');
    if (!['markdown', 'json'].includes(format)) throw new Error('导出格式无效');
    const win = getMainWindow();
    if (!win) return { ok: false, canceled: false, message: '窗口不存在' };
    const extension = format === 'markdown' ? 'md' : 'json';
    const result = await dialog.showSaveDialog(win, {
      title: format === 'markdown' ? '下载成果正文' : '导出成果详情',
      defaultPath: `${safeFileSegment(detail.title)}-v${detail.latestVersion}.${extension}`,
      filters: [{ name: format === 'markdown' ? 'Markdown 文档' : 'JSON 数据', extensions: [extension] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true, message: '已取消' };
    const content = format === 'markdown' ? deliverables.renderMarkdown(detail) : JSON.stringify(detail, null, 2);
    writeFileSync(result.filePath, content, 'utf8');
    db.audit({ id: randomUUID(), actor: 'admin', action: 'deliverable.export', target: detail.id, result: format });
    return { ok: true, canceled: false, message: `已导出：${result.filePath}`, path: result.filePath };
  });
  handle('aibox:exportProjectDeliverablePackage', async (_e, projectId: string) => {
    const pkg = deliverables.packageForProject(assertId(projectId, 'projectId'));
    const win = getMainWindow();
    if (!win) return { ok: false, canceled: false, message: '窗口不存在' };
    const result = await dialog.showOpenDialog(win, { title: '选择成果包保存位置', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true, message: '已取消' };
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    const baseTarget = join(result.filePaths[0], `${safeFileSegment(pkg.project.name)}-成果包-${stamp}`);
    let target = baseTarget;
    let suffix = 2;
    while (existsSync(target)) target = `${baseTarget}-${suffix++}`;
    const itemsDir = join(target, 'deliverables');
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(join(target, 'README.md'), deliverables.renderPackageReadme(pkg), 'utf8');
    writeFileSync(join(target, 'manifest.json'), JSON.stringify(pkg, null, 2), 'utf8');
    pkg.deliverables.forEach((item, index) => {
      const detail = deliverables.get(item.id);
      if (!detail) return;
      const filename = `${String(index + 1).padStart(2, '0')}-${safeFileSegment(item.title)}-v${item.latestVersion}.md`;
      writeFileSync(join(itemsDir, filename), deliverables.renderMarkdown(detail), 'utf8');
    });
    db.audit({ id: randomUUID(), actor: 'admin', action: 'deliverable.package.export', target: pkg.project.id, result: 'ok' });
    return { ok: true, canceled: false, message: `成果包已导出：${target}`, path: target };
  });

  // ---------- 数字员工 ----------
  handle('aibox:createAgent', async (_e, input: CreateAgentInput) => {
    input = decodeAgentInput(input);
    assertString(input?.name, 'name', 2, 30);
    assertString(input?.role, 'role', 2, 500);
    assertString(input?.engineId, 'engineId', 1, 100);
    const tools = input.kind === 'android_operator'
      ? assertMobileTools(input.mobileAllowedTools ?? [...MOBILE_TOOL_NAMES])
      : null;
    if (input.deviceId) input = { ...input, deviceId: assertId(input.deviceId, 'deviceId') };
    const agent = await createProvisionedAgent(orchestrator, mobile, input, tools);
    pushSnapshot();
    return agent;
  });
  const getActiveAgent = (value: unknown) => {
    const safeId = assertId(value);
    const agent = orchestrator.listAgents().find((candidate) => candidate.id === safeId);
    if (!agent) throw new Error('数字员工不存在');
    return agent;
  };
  const startAgentWithRuntime = async (value: unknown): Promise<void> => {
    const agent = getActiveAgent(value);
    orchestrator.startAgent(agent.id);
  };
  const stopAgentWithRuntime = async (value: unknown): Promise<void> => {
    const agent = getActiveAgent(value);
    orchestrator.stopAgent(agent.id);
  };
  handle('aibox:startAgent', async (_e, id: string) => {
    await startAgentWithRuntime(id);
  });
  handle('aibox:stopAgent', async (_e, id: string) => {
    await stopAgentWithRuntime(id);
  });
  handle('aibox:openQuestWindow', async (_event, value: unknown) => {
    if (!questWindowService) throw new Error('Quest 独立窗口不可用');
    if (!projectWorkbench) throw new Error('项目工作台不可用');
    const input = assertRecord(value, 'Quest 独立窗口请求');
    assertKeys(input, ['projectId'], 'Quest 独立窗口请求');
    const projectId = assertId(input.projectId, 'projectId');
    const projectView = projectWorkbench.get(projectId);
    if (projectView.project.status === 'archived') throw new Error('已归档项目不能打开 Quest');

    // Opening the trusted Quest shell must not depend on Provider credentials
    // or a healthy Hermes process. The renderer opens the embedded workbench next;
    // that guarded IPC owns runtime/session setup and projects failures into the
    // in-window recovery UI.
    const status = await questWindowService.open(projectId);
    db.audit({
      id: randomUUID(), actor: 'admin', action: 'quest.window.open',
      target: projectId, result: 'ok'
    });
    return status;
  });
  handle('aibox:openMainSurface', async (event) => {
    const main = getMainWindow();
    const ownedByMain = Boolean(main && !main.isDestroyed() && event.sender === main.webContents);
    const ownedByQuest = questWindowService?.ownsWebContents(event.sender) ?? false;
    if ((!ownedByMain && !ownedByQuest) || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('主控制台只能由可信的应用窗口打开');
    }
    openMainSurface();
    db.audit({
      id: randomUUID(), actor: 'admin', action: 'desktop.main.open',
      target: ownedByQuest ? 'quest-window' : 'main-window', result: 'ok'
    });
    return { ok: true as const };
  });
  let embeddedWorkbenchRequestRevision = 0;
  let embeddedWorkbenchMutationTail: Promise<void> = Promise.resolve();
  let embeddedWorkbenchOwner: Electron.WebContents | null = null;
  const enqueueEmbeddedWorkbenchMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = embeddedWorkbenchMutationTail.then(operation, operation);
    embeddedWorkbenchMutationTail = run.then(() => undefined, () => undefined);
    return run;
  };
  const assertCurrentEmbeddedWorkbenchRequest = (revision: number): void => {
    if (revision !== embeddedWorkbenchRequestRevision) {
      throw new Error('Quest embedded Workbench request was superseded');
    }
  };
  const embeddedWorkbenchHost = (event: Electron.IpcMainInvokeEvent): {
    host: BrowserWindow;
    surface: 'main' | 'quest';
  } => {
    const main = getMainWindow();
    const quest = questWindowService?.ownsWebContents(event.sender) ? questWindowService.getWindow() : null;
    const host = main && !main.isDestroyed() && event.sender === main.webContents
      ? main
      : quest && !quest.isDestroyed()
        ? quest
        : null;
    if (!host || event.senderFrame !== host.webContents.mainFrame) {
      throw new Error('Quest 嵌入工作台只能由可信的主应用或 Quest 窗口控制');
    }
    return { host, surface: host === main ? 'main' : 'quest' };
  };
  const liveEmbeddedWorkbenchOwner = (): Electron.WebContents | null => {
    if (embeddedWorkbenchOwner
      && typeof embeddedWorkbenchOwner.isDestroyed === 'function'
      && embeddedWorkbenchOwner.isDestroyed()) {
      embeddedWorkbenchOwner = null;
    }
    return embeddedWorkbenchOwner;
  };
  const assertEmbeddedWorkbenchOwner = (event: Electron.IpcMainInvokeEvent): BrowserWindow => {
    const { host } = embeddedWorkbenchHost(event);
    const owner = liveEmbeddedWorkbenchOwner();
    if (owner && owner !== event.sender) throw new Error('Quest 工作区当前由另一个窗口控制');
    if (!owner) embeddedWorkbenchOwner = event.sender;
    return host;
  };
  if (hermesEmbedded && hermesServices && projectWorkbench) {
    handle('aibox:openEmbeddedHermesWorkbench', async (event, value: unknown) => {
      const input = assertRecord(value, 'Hermes 嵌入工作台请求');
      assertKeys(input, ['projectId', 'bounds', 'theme', 'conversationId'], 'Hermes 嵌入工作台请求');
      const projectId = assertId(input.projectId, 'projectId');
      const governance = hermesGovernance;
      if (!governance) throw new Error('Hermes 会话治理不可用');
      const theme = input.theme;
      if (theme !== 'dark' && theme !== 'light') throw new Error('Hermes 主题无效');
      const conversationId = input.conversationId === undefined
        ? undefined
        : assertId(input.conversationId, 'conversationId');
      if (conversationId && !governance.listConversations(projectId).some((item) => item.conversationId === conversationId)) {
        throw new Error('Hermes 会话不属于当前项目');
      }
      const hostContext = embeddedWorkbenchHost(event);
      if (hostContext.surface === 'quest' && questWindowService?.getProjectId() !== projectId) {
        throw new Error('Quest 独立窗口项目上下文不匹配');
      }
      const request: OpenHermesEmbeddedWorkbenchInput = {
        projectId,
        bounds: embeddedWorkbenchBounds(input.bounds, hostContext.host),
        theme,
        ...(conversationId ? { conversationId } : {})
      };
      // Order requests when they enter Main. An async workspace prompt must
      // not let an older request overtake a newer project or conversation.
      const requestRevision = ++embeddedWorkbenchRequestRevision;
      const workspace = await ensureProjectWorkspace(event, projectId);
      assertCurrentEmbeddedWorkbenchRequest(requestRevision);
      if (!workspace) throw new Error('需要先选择项目工作目录才能启动 Quest');
      const previousOwner = liveEmbeddedWorkbenchOwner();
      if (previousOwner && previousOwner !== event.sender) throw new Error('另一个窗口正在使用 Quest 工作区');
      embeddedWorkbenchOwner = event.sender;
      return enqueueEmbeddedWorkbenchMutation(async () => {
        assertCurrentEmbeddedWorkbenchRequest(requestRevision);
        const status = await hermesEmbedded.open(hostContext.host, projectId, request.bounds, theme, conversationId);
        assertCurrentEmbeddedWorkbenchRequest(requestRevision);
        db.audit({
          id: randomUUID(), actor: 'admin', action: 'hermes.workbench.embed.open',
          target: projectId, result: 'ok', source: 'desktop'
        });
        return status;
      });
    });
    handle('aibox:setEmbeddedHermesWorkbenchBounds', (event, value: unknown) => {
      const host = assertEmbeddedWorkbenchOwner(event);
      return hermesEmbedded.setBounds(embeddedWorkbenchBounds(value, host));
    });
    handle('aibox:setEmbeddedHermesWorkbenchVisible', (event, visible: unknown) => {
      assertEmbeddedWorkbenchOwner(event);
      if (typeof visible !== 'boolean') throw new Error('Hermes 嵌入工作台可见性必须是布尔值');
      return hermesEmbedded.setVisible(visible);
    });
    handle('aibox:setEmbeddedHermesWorkbenchTheme', (event, theme: unknown) => {
      assertEmbeddedWorkbenchOwner(event);
      if (theme !== 'dark' && theme !== 'light') throw new Error('Hermes 主题无效');
      return hermesEmbedded.setTheme(theme);
    });
    handle('aibox:closeEmbeddedHermesWorkbench', (event) => {
      assertEmbeddedWorkbenchOwner(event);
      embeddedWorkbenchRequestRevision += 1;
      return enqueueEmbeddedWorkbenchMutation(async () => {
        const status = hermesEmbedded.close();
        if (embeddedWorkbenchOwner === event.sender) embeddedWorkbenchOwner = null;
        return status;
      });
    });
    handle('aibox:getEmbeddedHermesWorkbenchStatus', (event) => {
      assertEmbeddedWorkbenchOwner(event);
      return hermesEmbedded.getStatus();
    });
  }
  if (pluginCatalog) {
    handle('aibox:getPluginCatalog', () => pluginCatalog.getCatalog());
    handle('aibox:setPluginEnabled', (_e, id: string, enabled: boolean) => {
      const pluginId = assertId(id, 'pluginId');
      if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean');
      pluginCatalog.setEnabled(pluginId, enabled);
      db.audit({ id: randomUUID(), actor: 'admin', action: 'plugin.toggle', target: pluginId, result: enabled ? 'enabled' : 'disabled' });
      pushSnapshot();
      return pluginCatalog.getCatalog();
    });
  }
  if (environmentDiagnostics) {
    handle('aibox:getEnvironmentDiagnostics', () => environmentDiagnostics.diagnose());
  }
  // 助手人设编辑（soul.md / agents.md / user.md / 权限模式）
  handle('aibox:updateAgentPersona', async (_e, id: string, patch: AgentPersonaPatch) => {
    patch = decodePersonaPatch(patch);
    const safeAgentId = assertId(id);
    const a = orchestrator.updateAgentPersona(id, patch);
    if (a.kind === 'android_operator') {
      const existing = mobile.getAgentConfig(a.id);
      const tools = assertMobileTools(patch.mobileAllowedTools ?? existing?.allowedTools ?? [...MOBILE_TOOL_NAMES]);
      await mobile.ensureAgentProfile(a, tools);
      if (patch.deviceId === null) mobile.unbindAgent(a.id);
      else if (patch.deviceId !== undefined) await mobile.bindAgent(a.id, assertId(patch.deviceId, 'deviceId'), tools, patch.mobileAuthorizationConfirmed === true);
      else if (patch.mobileAllowedTools) mobile.updateToolPolicy(a.id, tools, patch.mobileAuthorizationConfirmed === true);
    }
    pushSnapshot();
    return a;
  });

  // ---------- Android 手机员工 ----------
  handle('aibox:mobile:getStatus', () => mobile.getStatus());
  handle('aibox:mobile:listLanAddresses', () => mobile.getLanAddresses());
  handle('aibox:mobile:startGateway', (_e, host: string, port?: number) =>
    mobile.start(assertString(host, 'host', 7, 45), assertPort(port ?? 18765)));
  handle('aibox:mobile:stopGateway', () => mobile.stop(true));
  handle('aibox:mobile:resetCertificate', () => mobile.resetCertificate());
  // Android Bridge is an execution-device transport, not a phone Hermes
  // conversation. Keep its pairing namespace explicit so a QR scan cannot be
  // mistaken for the Quest project chat pairing.
  handle('aibox:androidBridge:createPairing', () => mobile.createPairing());
  handle('aibox:androidBridge:copyPairingConfig', async (_e, pairingId: string) => {
    const payload = mobile.getPairingConfigForCopy(assertId(pairingId, 'pairingId'));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt % 2 === 0) {
        clipboard.writeText(payload);
      } else {
        clipboard.clear();
        clipboard.write({ text: payload });
      }
      if (clipboard.readText() === payload) return { ok: true as const };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Android Worker 配对配置未能写入系统剪贴板，请关闭占用剪贴板的程序后重试');
  });
  handle('aibox:mobile:getToolCatalog', () => getMobileToolCatalog());
  handle('aibox:mobile:listDevices', () => mobile.listDevices());
  handle('aibox:mobile:getAgentConfig', (_e, agentId: string) => mobile.getAgentConfig(assertId(agentId, 'agentId')));
  handle('aibox:mobile:bindAgent', (_e, input: { agentId: string; deviceId: string; allowedTools: MobileToolName[]; confirmAuthorization: boolean }) =>
    mobile.bindAgent(assertId(input?.agentId, 'agentId'), assertId(input?.deviceId, 'deviceId'), assertMobileTools(input?.allowedTools), input?.confirmAuthorization === true));
  handle('aibox:mobile:unbindAgent', (_e, agentId: string) => mobile.unbindAgent(assertId(agentId, 'agentId')));
  handle('aibox:mobile:updateToolPolicy', (_e, input: { agentId: string; allowedTools: MobileToolName[]; confirmAuthorization: boolean }) =>
    mobile.updateToolPolicy(assertId(input?.agentId, 'agentId'), assertMobileTools(input?.allowedTools), input?.confirmAuthorization === true));
  handle('aibox:mobile:refreshPreview', (_e, deviceId: string) => mobile.refreshPreview(assertId(deviceId, 'deviceId')));
  handle('aibox:mobile:readUiTree', (_e, deviceId: string) => mobile.readUiTree(assertId(deviceId, 'deviceId')));
  handle('aibox:mobile:execute', (_e, input: { deviceId: string; toolName: MobileToolName; args: Record<string, unknown> }) => {
    const toolName = assertMobileTool(input?.toolName);
    if (!input?.args || typeof input.args !== 'object' || Array.isArray(input.args)) throw new Error('args 必须是对象');
    return mobile.executeManual(assertId(input.deviceId, 'deviceId'), toolName, input.args);
  });
  handle('aibox:mobile:listCommands', (_e, deviceId?: string) => mobile.listCommands(deviceId ? assertId(deviceId, 'deviceId') : undefined));
  handle('aibox:mobile:listArtifacts', (_e, deviceId?: string) => mobile.listArtifacts(deviceId ? assertId(deviceId, 'deviceId') : undefined));
  handle('aibox:mobile:listScripts', () => mobile.listScripts());
  handle('aibox:mobile:saveScript', (_e, input: Omit<MobileScriptDefinition, 'id' | 'createdAt' | 'updatedAt'>, id?: string) =>
    mobile.saveScript(input, id ? assertId(id, 'scriptId') : undefined));
  handle('aibox:mobile:deleteScript', (_e, id: string) => mobile.deleteScript(assertId(id, 'scriptId')));
  handle('aibox:mobile:runScript', (_e, id: string) => mobile.runScript(assertId(id, 'scriptId')));
  handle('aibox:mobile:emergencyStop', (_e, deviceId: string) => mobile.emergencyStop(assertId(deviceId, 'deviceId')));
  handle('aibox:mobile:getApkInfo', () => mobileAdb.getApkInfo());
  handle('aibox:mobile:listAdbDevices', () => mobileAdb.listDevices());
  handle('aibox:mobile:installApk', (_e, serial: string) => mobileAdb.install(assertString(serial, 'serial', 1, 128)));
  handle('aibox:mobile:exportApk', async () => {
    const { apk, info } = await mobileAdb.verifyApk();
    const options = {
      title: '导出 OPC-Nexus 手机桥 APK',
      defaultPath: `OPC-Nexus-Mobile-Bridge-${info.versionName}.apk`,
      filters: [{ name: 'Android APK', extensions: ['apk'] }]
    };
    const parent = getMainWindow();
    const result = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { ok: false, canceled: true, message: '已取消' };
    copyFileSync(apk, result.filePath);
    db.audit({ id: randomUUID(), actor: 'admin', action: 'mobile.apk.export', target: info.sha256, result: 'ok' });
    return { ok: true, canceled: false, message: 'APK 已导出' };
  });
  // AI 辅助生成人设：用已配置的 LLM 供应商生成 soul.md + agents.md + role
  handle('aibox:generatePersona', async (_e, description: string) => {
    const { getProviderSettings, readProviderKey } = await import('./services/provider.js');
    const settings = getProviderSettings(db);
    const key = readProviderKey(db);
    if (!settings || !key) throw new Error('请先在设置页配置模型供应商');
    const prompt = `请根据以下描述生成一个 AI 助手的配置，用 JSON 格式输出：
{"name":"助手名称","role":"职责描述(50-100字)","soulMd":"身份与性格(100-200字)","agentsMd":"行为指令(5条规则)","systemPrompt":"系统提示词(50-100字)","permissionMode":"autonomous"}

描述：${description}

仅输出 JSON，不要其他内容。`;
    const res = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: settings.model, messages: [{ role: 'user', content: prompt }], max_tokens: 1000 }),
      redirect: 'error'
    });
    if (!res.ok) throw new Error(`LLM 请求失败: HTTP ${res.status}`);
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content ?? '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('AI 输出格式异常，请重试');
    return JSON.parse(jsonMatch[0]) as { name: string; role: string; soulMd: string; agentsMd: string; systemPrompt: string; permissionMode: string };
  });
  // 会话（持续多轮对话）
  handle('aibox:listConversations', (_e, agentId: string) => {
    const safeAgentId = assertId(agentId, 'agentId');
    localChatAgent(safeAgentId);
    return orchestrator.listConversations(safeAgentId).filter((conversation) =>
      conversation.organizationId === LOCAL_CHAT_ORGANIZATION_ID
      && conversation.principalId === LOCAL_CHAT_PRINCIPAL_ID
      && conversation.channelId === null
    );
  });
  handle('aibox:getConversationTimeline', (_e, input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('conversation timeline input is invalid');
    const value = input as Record<string, unknown>;
    return chatService.getTimeline({
      agentId: assertId(value.agentId, 'agentId'),
      conversationId: assertId(value.conversationId, 'conversationId'),
      cursor: value.cursor as never,
      limit: value.limit as number | undefined
    });
  });
  handle('aibox:chatWithAgent', async (_e, agentId: string, message: string, conversationId?: string, messageKey?: string, projectId?: string) => {
    const preferredAgentId = assertId(agentId, 'agentId');
    localChatAgent(preferredAgentId);
    assertString(message, 'message', 1, 20_000);
    const target = projectId
      ? assertId(projectId, 'projectId')
      : conversationId
        ? assertId(conversationId, 'conversationId')
        : preferredAgentId;
    if (messageKey) assertId(messageKey, 'messageKey');
    db.audit({
      id: randomUUID(), actor: LOCAL_OWNER_PRINCIPAL_ID, action: 'hermes.entry.required',
      target, result: 'project-workbench-required', source: 'desktop'
    });
    throw new Error('HERMES_PROJECT_REQUIRED: 请从项目中心打开 Hermes Workbench 下达任务');
  });
  // 会话管理：重命名 / 删除
  handle('aibox:renameConversation', (_e, id: string, title: string) => {
    db.raw.prepare(
      'UPDATE conversations SET title = ? WHERE id = ? AND channel_id IS NULL AND organization_id = ? AND principal_id = ?'
    ).run(
      assertString(title, 'title', 1, 100),
      assertId(id, 'conversationId'),
      LOCAL_CHAT_ORGANIZATION_ID,
      LOCAL_CHAT_PRINCIPAL_ID
    );
  });
  handle('aibox:deleteConversation', (_e, id: string) => {
    db.raw.prepare(
      'DELETE FROM conversations WHERE id = ? AND channel_id IS NULL AND organization_id = ? AND principal_id = ?'
    ).run(assertId(id, 'conversationId'), LOCAL_CHAT_ORGANIZATION_ID, LOCAL_CHAT_PRINCIPAL_ID);
  });
  // 用量统计
  handle('aibox:getUsageStats', () => orchestrator.usageStats());
  handle('aibox:getUsageStatsEnhanced', (_e, since: number | null) => {
    const where = since ? 'WHERE created_at >= ?' : '';
    const params = since ? [since] : [];
    const total = db.raw.prepare(`SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(total_tokens),0) t FROM usage_records ${where}`).get(...params) as { i: number; o: number; t: number };
    const byModel = (db.raw.prepare(`SELECT model, SUM(input_tokens) input, SUM(output_tokens) output, SUM(total_tokens) total, COUNT(*) count FROM usage_records ${where} GROUP BY model ORDER BY total DESC`).all(...params) as { model: string; input: number; output: number; total: number; count: number }[]);
    const byAgent = (db.raw.prepare(`SELECT agent_id, SUM(total_tokens) total, COUNT(*) count FROM usage_records ${where} GROUP BY agent_id ORDER BY total DESC`).all(...params) as { agent_id: string; total: number; count: number }[]);
    // 最近 7 天每日趋势
    const sevenDaysAgo = Date.now() - 7 * 86400000;
    const daily = (db.raw.prepare('SELECT created_at, total_tokens FROM usage_records WHERE created_at >= ? ORDER BY created_at').all(sevenDaysAgo) as { created_at: number; total_tokens: number }[]);
    const trend: { date: string; total: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0); dayStart.setDate(dayStart.getDate() - i);
      const dayEnd = dayStart.getTime() + 86400000;
      const dayTotal = daily.filter((r) => r.created_at >= dayStart.getTime() && r.created_at < dayEnd).reduce((s, r) => s + r.total_tokens, 0);
      trend.push({ date: `${dayStart.getMonth() + 1}/${dayStart.getDate()}`, total: dayTotal });
    }
    const recent = (db.raw.prepare(`SELECT * FROM usage_records ${where} ORDER BY created_at DESC LIMIT 50`).all(...params) as { id: string; agent_id: string; model: string; input_tokens: number; output_tokens: number; total_tokens: number; created_at: number }[]).map((r) => ({
      id: r.id, agentId: r.agent_id, model: r.model, input: r.input_tokens, output: r.output_tokens, total: r.total_tokens, createdAt: r.created_at
    }));
    return { total: { input: total.i, output: total.o, total: total.t }, byModel, byAgent, trend, recent };
  });

  // ---------- MCP 服务器管理 ----------
  handle('aibox:listMcpServers', () => mcp.list());
  handle('aibox:createMcpServer', (_e, input: { name: string; command: string; args?: string[]; env?: Record<string, string>; scope?: string; capability?: 'browser' | '' }) => {
    assertString(input?.name, 'name', 2, 80);
    assertString(input?.command, 'command', 1, 500);
    if (/[&|<>^%\r\n]/.test(input.command)) throw new Error('启动命令包含不允许的字符');
    if (input.args?.some((arg) => typeof arg !== 'string' || arg.length > 1000 || /[&|<>^%\r\n]/.test(arg))) throw new Error('启动参数无效');
    return mcp.create(input);
  });
  handle('aibox:createPlaywrightBrowser', async (_e, input: { agentId: string; extensionToken?: string }) => {
    const agentId = assertId(input?.agentId, 'agentId');
    if (input?.extensionToken !== undefined && typeof input.extensionToken !== 'string') throw new Error('扩展 Token 格式无效');
    if (input?.extensionToken !== undefined && input.extensionToken.length > 500) throw new Error('扩展 Token 过长');
    const agent = orchestrator.listAgents().find((item) => item.id === agentId);
    if (!agent) throw new Error('数字员工不存在');
    if (!executors.supportsMcp(agent.engineId)) throw new Error('浏览器 MCP 目前仅支持内置员工执行器');
    const server = mcp.createPlaywrightBrowser({ agentId, extensionToken: input.extensionToken });
    orchestrator.updateAgentPersona(agentId, { capabilities: { browser: true } });
    skills.ensureBrowserOperator(agentId);
    // MCP 子进程只在启动时读取环境变量，更新 Token 后必须重启才能生效。
    if (input.extensionToken?.trim() && mcp.isRunning(server.id)) await mcp.stop(server.id);
    const connection = await mcp.start(server.id);
    pushSnapshot();
    return { server, connection };
  });
  handle('aibox:removeMcpServer', (_e, id: string) => mcp.remove(id));
  handle('aibox:toggleMcpServer', (_e, id: string, enabled: boolean) => mcp.toggle(id, enabled));
  handle('aibox:startMcpServer', (_e, id: string) => mcp.start(id));
  handle('aibox:stopMcpServer', (_e, id: string) => mcp.stop(id));
  handle('aibox:getMcpTools', () => mcp.allTools());
  // 注：aibox:callMcpTool 已移除 —— preload 未暴露、无任何调用方，
  // 保留只是把「任意 MCP 工具调用」暴露成可达攻击面。
  // McpManager.callTool 目前仅供后续执行器接入 MCP 工具时在主进程内调用；
  // 真正接入时应经工具注册表（tools.ts）声明，而非重新开放 IPC 通道。

  // ---------- Skills 管理 ----------
  handle('aibox:listSkills', () => skills.list());
  handle('aibox:createSkill', (_e, input: { name: string; description?: string; content?: string }) => skills.create(input));
  handle('aibox:updateSkill', (_e, id: string, patch: { name?: string; description?: string; content?: string; enabled?: boolean }) => skills.update(id, patch));
  handle('aibox:removeSkill', (_e, id: string) => skills.remove(id));
  handle('aibox:bindSkill', (_e, agentId: string, skillId: string) => skills.bindAgent(agentId, skillId));
  handle('aibox:unbindSkill', (_e, agentId: string, skillId: string) => skills.unbindAgent(agentId, skillId));
  handle('aibox:getAgentSkills', (_e, agentId: string) => skills.forAgent(agentId));
  // Skills 组合 → 数字员工（P4）：单个/多个技能一键生成可真实执行的员工
  handle('aibox:createAgentFromSkills', (_e, input: { skillIds: string[]; name?: string; engineId?: string }) => {
    if (!Array.isArray(input?.skillIds) || input.skillIds.length === 0) throw new Error('请选择至少一个技能');
    for (const id of input.skillIds) assertId(id, 'skillId');
    const draft = skills.composeAgentDraft(input.skillIds, input.name);
    // 引擎优先级：显式指定 > 默认引擎 > 任一可用引擎
    const engineId = input.engineId
      ?? (db.raw.prepare("SELECT id FROM engines WHERE is_default = 1 LIMIT 1").get() as { id: string } | undefined)?.id
      ?? NEXUS_ENGINE_ID;
    const agent = orchestrator.createAgent({
      name: draft.name, role: draft.role, systemPrompt: draft.systemPrompt,
      soulMd: draft.soulMd, agentsMd: draft.agentsMd,
      engineId, workspace: '', permissionMode: 'autonomous', concurrencyLimit: 1, channelIds: []
    });
    for (const skillId of draft.skillIds) skills.bindAgent(agent.id, skillId);
    db.audit({ id: randomUUID(), actor: 'admin', action: 'agent.createFromSkills', target: agent.id, result: draft.skillIds.join(',') });
    pushSnapshot();
    return agent;
  });

  // ---------- Hermes 同步 ----------
  handle('aibox:importFromHermes', () => importFromHermes(mcp, skills));
  handle('aibox:exportToHermes', () => exportToHermes(mcp, skills));

  // ---------- 多供应商管理 ----------
  handle('aibox:listProviders', () => providers.list());
  handle('aibox:createProvider', (_e, input: { name: string; baseUrl: string; model: string; apiKey?: string; isDefault?: boolean }) => {
    const provider = providers.create(input);
    pushSnapshot();
    return provider;
  });
  handle('aibox:updateProvider', (_e, id: string, patch: { name?: string; baseUrl?: string; model?: string; apiKey?: string; isDefault?: boolean }) => {
    providers.update(id, patch);
    pushSnapshot();
  });
  handle('aibox:removeProvider', (_e, id: string) => {
    providers.remove(id);
    pushSnapshot();
  });
  handle('aibox:testProviderById', (_e, id: string) => providers.testById(id));
  handle('aibox:fetchProviderModels', (_e, id: string) => providers.fetchModels(id));
  // ---------- API Bridge ----------
  handle('aibox:getBridgeStatus', () => deps.apiBridge.getStatus());
  handle('aibox:toggleBridge', async (_e, enabled: boolean) => {
    await deps.apiBridge.toggle(enabled);
    return deps.apiBridge.getStatus();
  });
  handle('aibox:regenerateBridgeKey', async () => {
    deps.apiBridge.regenerateKey();
    const status = deps.apiBridge.getStatus();
    if (status.enabled && !status.running) await deps.apiBridge.start();
    return deps.apiBridge.getStatus();
  });
  handle('aibox:copyBridgeKey', () => {
    clipboard.writeText(deps.apiBridge.getBridgeKey());
    db.audit({ id: randomUUID(), actor: 'admin', action: 'bridge.key.copy', target: BRIDGE_KEY_SECRET_REF, result: 'clipboard' });
    return { ok: true as const };
  });

  // ---------- Prompt 模板 ----------
  handle('aibox:listTemplates', () => (db.raw.prepare('SELECT * FROM prompt_templates ORDER BY created_at DESC').all() as unknown as { id: string; name: string; content: string; category: string; created_at: number }[]).map((r) => ({ id: r.id, name: r.name, content: r.content, category: r.category, createdAt: r.created_at })));
  handle('aibox:createTemplate', (_e, input: { name: string; content: string; category?: string }) => {
    const id = `tpl-${randomUUID().slice(0, 8)}`;
    db.raw.prepare('INSERT INTO prompt_templates(id, name, content, category, created_at) VALUES(?,?,?,?,?)').run(id, input.name, input.content, input.category ?? 'general', Date.now());
    return { id, ...input };
  });
  handle('aibox:removeTemplate', (_e, id: string) => db.raw.prepare('DELETE FROM prompt_templates WHERE id = ?').run(id));

  // ---------- Agent 克隆/导入导出 ----------
  handle('aibox:cloneAgent', (_e, id: string, newName: string) => {
    const agent = orchestrator.listAgents().find((a) => a.id === id);
    if (!agent) throw new Error('助手不存在');
    return orchestrator.createAgent({
      name: newName || `${agent.name} (副本)`, role: agent.role, systemPrompt: agent.systemPrompt,
      soulMd: agent.soulMd, agentsMd: agent.agentsMd, userMd: agent.userMd,
      engineId: agent.engineId, workspace: agent.workspace, permissionMode: agent.permissionMode,
      concurrencyLimit: agent.concurrencyLimit, channelIds: []
    });
  });
  handle('aibox:exportAgent', (_e, id: string) => {
    const agent = orchestrator.listAgents().find((a) => a.id === id);
    if (!agent) throw new Error('助手不存在');
    const { id: _id, lifecycle: _l, archived: _a, createdAt: _c, updatedAt: _u, avatarColor: _av, ...exportable } = agent;
    return JSON.stringify(exportable, null, 2);
  });
  handle('aibox:importAgent', (_e, json: string) => {
    try {
      const data = JSON.parse(json) as { name?: string; role?: string; systemPrompt?: string; soulMd?: string; agentsMd?: string; userMd?: string; engineId?: string; workspace?: string; permissionMode?: string; concurrencyLimit?: number };
      if (!data.name) return { ok: false, message: '文件缺少 name 字段' };
      const agent = orchestrator.createAgent({
        name: data.name, role: data.role ?? '', systemPrompt: data.systemPrompt ?? '',
        soulMd: data.soulMd ?? '', agentsMd: data.agentsMd ?? '', userMd: data.userMd ?? '',
        engineId: data.engineId ?? NEXUS_ENGINE_ID, workspace: data.workspace ?? '',
        permissionMode: (data.permissionMode as 'readonly' | 'standard' | 'trusted' | 'autonomous') ?? 'autonomous',
        concurrencyLimit: data.concurrencyLimit ?? 1, channelIds: []
      });
      pushSnapshot();
      return { ok: true, message: `已导入员工「${agent.name}」`, agent };
    } catch (e) {
      return { ok: false, message: `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}` };
    }
  });
  handle('aibox:batchAgentAction', async (_e, ids: string[], action: 'start' | 'stop' | 'delete') => {
    if (!Array.isArray(ids)) throw new Error('数字员工列表无效');
    if (action !== 'start' && action !== 'stop' && action !== 'delete') throw new Error('批量操作无效');
    let count = 0;
    for (const value of new Set(ids)) {
      try {
        const id = assertId(value);
        if (action === 'start') await startAgentWithRuntime(id);
        else if (action === 'stop') await stopAgentWithRuntime(id);
        else {
          await stopAgentWithRuntime(id);
          orchestrator.archiveAgent(id);
        }
        count++;
      } catch { /* 跳过失败的 */ }
    }
    pushSnapshot();
    return { ok: true, message: `已对 ${count} 位员工执行「${action === 'start' ? '启用' : action === 'stop' ? '停用' : '删除'}」操作` };
  });
  handle('aibox:getAgentDetail', (_e, agentId: string) => {
    const tasks = orchestrator.listTasks({ includeResult: false }).filter((t) => t.agentId === agentId).slice(0, 10);
    const usage = db.raw.prepare('SELECT COALESCE(SUM(total_tokens),0) as total, COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(output_tokens),0) as output, COUNT(*) as calls FROM usage_records WHERE agent_id = ?').get(agentId) as { total: number; input: number; output: number; calls: number };
    const events = (db.raw.prepare("SELECT id, event_type, created_at FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE agent_id = ? ORDER BY created_at DESC LIMIT 5) ORDER BY created_at DESC LIMIT 30").all(agentId) as { id: string; event_type: string; created_at: number }[]).map((e) => ({ id: e.id, eventType: e.event_type, createdAt: e.created_at }));
    return { tasks, usage: { totalTokens: usage.total, inputTokens: usage.input, outputTokens: usage.output, calls: usage.calls }, events };
  });

  // ---------- 可视化工作流引擎 ----------
  workflows.onBroadcast(broadcast);
  handle('aibox:listWorkflows', () => workflows.list());
  handle('aibox:createWorkflow', (_e, input: { name: string; description?: string; nodes: WfNode[]; edges: WfEdge[] }) => workflows.create(input));
  handle('aibox:updateWorkflow', (_e, id: string, patch: { name?: string; description?: string; nodes?: WfNode[]; edges?: WfEdge[] }) => workflows.update(id, patch));
  handle('aibox:removeWorkflow', (_e, id: string) => workflows.remove(id));
  handle('aibox:triggerWorkflow', (_e, id: string, inputs?: Record<string, string>) => {
    const r = workflows.trigger(id, inputs);
    pushSnapshot();
    return r;
  });
  handle('aibox:getWorkflowRunState', (_e, id: string) => workflows.getRunState(id));
  handle('aibox:listWorkflowRuns', (_e, id: string) => workflows.listRuns(id));
  handle('aibox:publishWorkflowAsSkill', (_e, id: string) => {
    const r = workflows.publishAsSkill(id);
    pushSnapshot();
    return r;
  });
  handle('aibox:unpublishWorkflowSkill', (_e, id: string) => {
    const r = workflows.unpublishSkill(id);
    pushSnapshot();
    return r;
  });
  handle('aibox:exportWorkflow', (_e, id: string) => workflows.exportWorkflow(id));
  handle('aibox:importWorkflow', (_e, json: string) => {
    const r = workflows.importWorkflow(json);
    if (r.ok) pushSnapshot();
    return r;
  });
  handle('aibox:validateWorkflow', (_e, wf: { nodes: unknown[]; edges: unknown[] }) => workflows.validate(wf as { nodes: never[]; edges: never[] }));
  handle('aibox:saveWfVariables', (_e, wfId: string, variables: unknown[]) => workflows.saveVariables(wfId, variables as never[]));
  // ---------- 外部工作流平台（Coze / Dify） ----------
  handle('aibox:listWfPlatforms', () => wfPlatforms.list());
  handle('aibox:saveWfPlatform', (_e, input: { id?: string; name: string; baseUrl: string; token?: string }) => wfPlatforms.save(input));
  handle('aibox:removeWfPlatform', (_e, id: string) => wfPlatforms.remove(id));
  handle('aibox:testWfPlatform', (_e, id: string) => wfPlatforms.test(id));

  // ---------- 专家团 ----------
  handle('aibox:listTeams', () => teams.list());
  handle('aibox:createTeam', (_e, input: { name: string; coordinatorId: string; memberIds: string[]; mode?: 'coordinate' | 'roundtable'; workspace?: string }) => teams.create(input));
  handle('aibox:updateTeam', (_e, id: string, patch: { name?: string; coordinatorId?: string; memberIds?: string[]; mode?: 'coordinate' | 'roundtable'; workspace?: string }) => teams.update(id, patch));
  handle('aibox:removeTeam', (_e, id: string) => teams.remove(id));
  handle('aibox:triggerTeam', (_e, id: string, task: string, projectId?: string) => {
    const r = teams.trigger(id, task, projectId ? assertId(projectId, 'projectId') : undefined);
    pushSnapshot();
    return r;
  });
  handle('aibox:getTeamRuns', (_e, teamId: string) => {
    deliverables.list();
    return teams.listRuns(assertId(teamId, 'teamId'));
  });
  handle('aibox:getTeamCollaborationOverview', (_e, teamId: string) => {
    deliverables.list();
    return teams.getCollaborationOverview(assertId(teamId, 'teamId'));
  });
  handle('aibox:listAttentionRuns', () => teams.listAttentionRuns());
  handle('aibox:getTeamConfig', (_e, teamId: string) => teams.getConfig(teamId));
  handle('aibox:saveTeamConfig', (_e, teamId: string, config: { timeout: number; maxRetries: number; concurrency: number }) => {
    teams.saveConfig(teamId, config);
    return { ok: true };
  });
  handle('aibox:getTeamStats', (_e, teamId: string) => teams.getStats(teamId));
  handle('aibox:getSubtaskOutput', (_e, taskId: string) => teams.getSubtaskOutput(taskId));
  handle('aibox:retryTeamSubtask', (_e, runId: string, subtaskIndex: number) => teams.retrySubtask(assertId(runId, 'runId'), subtaskIndex));
  handle('aibox:cancelTeamRun', (_e, runId: string) => teams.cancelRun(assertId(runId, 'runId')));
  handle('aibox:skipTeamSubtask', (_e, runId: string, subtaskIndex: number) => teams.skipSubtask(assertId(runId, 'runId'), subtaskIndex));
  handle('aibox:forceRetryTeamSubtask', (_e, runId: string, subtaskIndex: number) => teams.forceRetrySubtask(assertId(runId, 'runId'), subtaskIndex));
  handle('aibox:injectTeamGuidance', (_e, runId: string, message: string) => teams.injectGuidance(assertId(runId, 'runId'), assertString(message, 'message', 1, 500)));
  handle('aibox:saveTeamAsTemplate', (_e, teamId: string, name?: string) => teams.saveAsTemplate(teamId, name));
  handle('aibox:listTeamTemplates', () => teams.listTemplates());
  handle('aibox:removeTeamTemplate', (_e, id: string) => teams.removeTemplate(id));

  // ---------- 任务 ----------
  handle('aibox:createTask', async (
    event,
    agentId: string,
    title: string,
    projectId: string | undefined,
    messageKey: string
  ) => {
    if (projectId) {
      const selected = await ensureProjectWorkspace(event, assertId(projectId, 'projectId'));
      if (!selected) throw new Error('需要先选择项目工作目录才能派发任务');
    }
    const result = await desktopControlPlane.dispatch({
      preferredAgentId: assertId(agentId, 'agentId'),
      message: assertString(title, 'title', 1, 500),
      projectId: projectId ? assertId(projectId, 'projectId') : undefined,
      messageKey: assertId(messageKey, 'messageKey')
    });
    pushSnapshot();
    return result.task;
  });
  handle('aibox:cancelTask', (_e, id: string) => orchestrator.cancelTask(assertId(id)));
  handle('aibox:retryTask', (_e, id: string) => {
    const taskId = assertId(id, 'taskId');
    const action = discovery.actions().items.find((item) => item.key === `failed_task:${taskId}`);
    const retried = orchestrator.retryTask(taskId);
    if (action) discovery.dismiss(action.key, action.fingerprint);
    return retried;
  });
  handle('aibox:deleteTask', (_e, id: string) => orchestrator.deleteTask(assertId(id, 'taskId')));
  handle('aibox:pauseTask', (_e, id: string) => orchestrator.pauseTask(assertId(id)));
  handle('aibox:resumeTask', (_e, id: string) => orchestrator.resumeTask(assertId(id)));
  handle('aibox:decideApproval', (_e, id: string, approve: boolean) => orchestrator.decideApproval(assertId(id), approve === true));
  // 追问/续跑（P2b）：新任务继承会话锚点
  handle('aibox:createFollowUpTask', (_e, parentTaskId: string, title: string) => orchestrator.createFollowUpTask(assertId(parentTaskId, 'parentTaskId'), assertString(title, 'title', 1, 500)));
  // 任务详情：事件时间线 + 产物全文（13.2 审计可追溯）
  handle('aibox:getTaskEvents', (_e, taskId: string) => orchestrator.taskEvents(taskId));
  // Desktop reads must share the Hermes delivery gate used by channels. This
  // keeps unaccepted plan work from appearing as a completed deliverable.
  const deliveryAllowed = (taskId: string): boolean => {
    const gate = hermesGovernance?.getDeliveryGate(taskId);
    return !gate || !gate.required || gate.allowed;
  };
  handle('aibox:getTaskResult', (_e, taskId: string) => {
    const id = assertId(taskId, 'taskId');
    if (!deliveryAllowed(id)) return null;
    return orchestrator.taskResult(id);
  });
  /** B.4/B.5 — 任务绑定的项目 workspace，是产物操作的唯一边界 */
  const manifestWorkspace = (taskId: string): string | null => {
    const taskRow = db.raw.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as { project_id: string | null } | undefined;
    const projectId = taskRow?.project_id;
    if (!projectId || !projectWorkbench) return null;
    return projectWorkbench.getExplicitWorkspacePath(projectId) ?? null;
  };
  // B.5 — 产物 Manifest 提取（从 task_events 取最后一条 artifact_manifest）
  handle('aibox:getTaskManifest', (_e, taskId: string) => {
    const id = assertId(taskId, 'taskId');
    if (!deliveryAllowed(id)) return null;
    return readTaskArtifactManifest(db, id);
  });
  // B.5 — 打开项目产物目录（与任务绑定的项目 workspace）
  handle('aibox:openTaskDeliveryFolder', async (_e, taskId: string) => {
    const id = assertId(taskId, 'taskId');
    if (!deliveryAllowed(id)) return { ok: false, message: '该任务尚未通过独立验收，暂不可打开交付目录' };
    const taskRow = db.raw.prepare('SELECT project_id FROM tasks WHERE id = ?').get(id) as { project_id: string | null } | undefined;
    const projectId = taskRow?.project_id;
    if (projectId && projectWorkbench) {
      const ws = projectWorkbench.getExplicitWorkspacePath(projectId);
      if (ws) {
        const err = await shell.openPath(ws);
        return err ? { ok: false, message: err } : { ok: true, message: '' };
      }
    }
    // Fall back to task's own workspace (executor working directory)
    const fallback = orchestrator.resolveTaskWorkspace(id);
    if (!fallback) return { ok: false, message: '未找到任务产物目录' };
    const err = await shell.openPath(fallback);
    return err ? { ok: false, message: err } : { ok: true, message: '' };
  });
  // B.5 — 打开产物预览：仅允许打开出现在已验证 manifest 中的文件
  handle('aibox:openArtifactPreview', async (_e, taskId: string, relativePath: string) => {
    const id = assertId(taskId, 'taskId');
    if (!deliveryAllowed(id)) return { ok: false, message: '该任务尚未通过独立验收，暂不可预览产物' };
    const target = assertString(relativePath, 'relativePath', 1, 512);
    const manifest = readTaskArtifactManifest(db, id);
    const isVerifiedEntry = manifest?.entries.some((entry) => entry.relativePath === target) === true;
    const isRuntimeScreenshot = manifest?.runtime?.screenshots.some((entry) => entry.relativePath === target) === true;
    if (!isVerifiedEntry && !isRuntimeScreenshot) {
      return { ok: false, message: '该文件不在已验证产物清单内' };
    }
    const ws = manifestWorkspace(id);
    if (!ws) return { ok: false, message: '项目工作目录不存在' };
    const absolutePath = resolveManifestPath(ws, target);
    if (!absolutePath) return { ok: false, message: '路径越界' };
    if (!existsSync(absolutePath)) return { ok: false, message: '文件不存在' };
    const err = await shell.openPath(absolutePath);
    return err ? { ok: false, message: err } : { ok: true, message: '' };
  });
  // B.4 — 启动真实预览进程。命令只从已验证 manifest 读取，Renderer 不得透传。
  handle('aibox:runArtifactCommand', async (_e, taskId: string) => {
    const id = assertId(taskId, 'taskId');
    if (!artifactRuntime) return { ok: false, runtime: null, error: '产物运行服务不可用' };
    return await artifactRuntime.start(id);
  });
  handle('aibox:getArtifactRuntimeStatus', (_e, taskId: string) => (
    artifactRuntime?.status(assertId(taskId, 'taskId')) ?? null
  ));
  handle('aibox:stopArtifactRuntime', async (_e, taskId: string) => {
    const id = assertId(taskId, 'taskId');
    if (!artifactRuntime) return { ok: false, runtime: null, error: '产物运行服务不可用' };
    return await artifactRuntime.stop(id);
  });
  handle('aibox:openArtifactRuntimeUrl', async (_e, taskId: string) => {
    const id = assertId(taskId, 'taskId');
    const runtime = artifactRuntime?.status(id);
    if (!runtime?.url || runtime.state !== 'RUNNING') return { ok: false, message: '产物预览服务未运行' };
    const url = new URL(runtime.url);
    const host = url.hostname.toLowerCase();
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || (host !== 'localhost' && host !== '::1' && !host.startsWith('127.'))) {
      return { ok: false, message: '产物预览地址不是本机回环地址' };
    }
    await shell.openExternal(url.toString());
    return { ok: true, message: '' };
  });
  // B.4 — 复制启动命令：同样只从已验证 manifest 读取，避免 Renderer 透传任意字符串
  handle('aibox:copyArtifactCommand', (_e, taskId: string) => {
    const manifest = readTaskArtifactManifest(db, assertId(taskId, 'taskId'));
    const command = manifest?.entries.find((entry) => entry.run)?.run?.command;
    if (!command) return { ok: false, message: '产物未声明启动命令' };
    clipboard.writeText(command);
    return { ok: true, message: command };
  });
  // 任务产出质量标记（成果管理：采纳/驳回/返工）
  handle('aibox:setTaskQuality', (_e, taskId: string, quality: 'accepted' | 'rejected' | 'rework' | null) => orchestrator.setTaskQuality(assertId(taskId, 'taskId'), quality));

  // ---------- 引擎 ----------
  // 真实自动安装（npm -g，下载地址取配置文件）；完成后重新检测并推送快照
  handle('aibox:installEngine', async (_e, id: string) => {
    pushSnapshot(); // 立即反映 INSTALLING 状态
    const r = await engines.install(id);
    pushSnapshot();
    return r;
  });
  handle('aibox:detectEngines', async () => {
    const list = await engines.detect();
    pushSnapshot();
    return list;
  });
  handle('aibox:getInstallGuide', (_e, id: string) => engines.installGuide(id));
  handle('aibox:updateEngine', async (_e, id: string) => {
    const r = await engines.update(id);
    pushSnapshot();
    return r;
  });
  handle('aibox:uninstallEngine', async (_e, id: string) => {
    const r = await engines.uninstall(id);
    pushSnapshot();
    return r;
  });
  handle('aibox:getEngineLatestVersion', (_e, id: string) => engines.latestVersion(id));
  handle('aibox:restartEngine', async (_e, id: string) => {
    const r = await engines.restart(assertId(id));
    pushSnapshot();
    return r;
  });
  handle('aibox:checkRuntime', () => engines.checkRuntime());
  handle('aibox:installRuntime', async (_e, name: string) => {
    const r = await engines.installRuntime(name);
    pushSnapshot();
    return r;
  });
  handle('aibox:openExternal', (_e, url: string) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url); // 外链一律系统浏览器，仅放行 https
  });
  // 打开产物目录 / 工作目录（系统资源管理器）
  handle('aibox:openTaskWorkspace', async (_e, taskId: string) => {
    const ws = orchestrator.resolveTaskWorkspace(assertId(taskId, 'taskId'));
    if (!ws) return { ok: false, message: '无法定位产物目录' };
    const err = await shell.openPath(ws);
    return err ? { ok: false, message: err } : { ok: true, message: '' };
  });
  handle('aibox:openAgentWorkspace', async (_e, agentId: string) => {
    const ws = orchestrator.resolveAgentWorkspace(assertId(agentId, 'agentId'));
    if (!ws) return { ok: false, message: '无法定位工作目录' };
    const err = await shell.openPath(ws);
    return err ? { ok: false, message: err } : { ok: true, message: '' };
  });
  handle('aibox:authEngine', async (_e, id: string) => {
    const r = await engines.probeAuth(assertId(id));
    pushSnapshot();
    return r;
  });
  handle('aibox:setDefaultEngine', (_e, id: string) => {
    engines.setDefault(id);
    pushSnapshot();
  });
  handle('aibox:getEngineConfig', (_e, id: string) => engines.getConfig(id));
  handle('aibox:saveEngineConfig', (_e, id: string, config: EngineRuntimeConfig) => {
    engines.saveConfig(id, config);
    pushSnapshot();
    return { ok: true };
  });
  handle('aibox:getEngineLogs', (_e, id: string) => engines.getLogs(id));
  handle('aibox:getEngineMetrics', (_e, id: string) => engines.getMetrics(id));
  handle('aibox:registerCustomEngine', (_e, input: { name: string; command: string; args?: string; dataBoundary?: string }) => {
    const r = engines.registerCustom(input);
    if (r.ok) pushSnapshot();
    return r;
  });
  handle('aibox:getEngineRouting', () => {
    return db.getSetting<Record<string, string>>('engine_routing', {});
  });
  handle('aibox:saveEngineRouting', (_e, rules: Record<string, string>) => {
    db.setSetting('engine_routing', rules);
    return { ok: true };
  });

  // ---------- 应用默认模型供应商（密钥仅存 safeStorage，Renderer 只见脱敏视图） ----------
  handle('aibox:getProviderConfig', () => getProviderConfig(db));
  handle('aibox:saveProviderConfig', async (_e, input: { baseUrl: string; model: string; apiKey?: string }) => {
    saveProviderConfig(db, input);
    db.audit({ id: randomUUID(), actor: 'admin', action: 'provider.save', target: input.baseUrl, result: 'ok' });
    await engines.detect(); // 配置齐备后重新计算所有受管引擎状态
    pushSnapshot();
    return getProviderConfig(db);
  });
  handle('aibox:testProvider', (_e, override?: { baseUrl?: string; apiKey?: string }) => testProvider(db, override));

  // ---------- 应用配置文件（下载源等；不含密钥） ----------
  handle('aibox:getAppConfig', () => loadConfig());
  handle('aibox:setAppConfig', (_e, patch: Partial<AppConfig>) => {
    const next = saveConfig(patch);
    db.audit({ id: randomUUID(), actor: 'admin', action: 'config.save', target: 'aibox.config.json', result: 'ok' });
    return next;
  });

  // ---------- 定时任务（P3a） ----------
  handle('aibox:createSchedule', (_e, input: ScheduleInput) => {
    const s = scheduler.create(input);
    pushSnapshot();
    return s;
  });
  handle('aibox:toggleSchedule', (_e, id: string, enabled: boolean) => {
    scheduler.toggle(id, enabled);
    pushSnapshot();
  });
  handle('aibox:deleteSchedule', (_e, id: string) => {
    scheduler.remove(id);
    pushSnapshot();
  });
  handle('aibox:updateSchedule', (_e, id: string, patch: Partial<ScheduleInput>) => {
    scheduler.update(assertId(id, 'scheduleId'), patch);
    pushSnapshot();
  });
  handle('aibox:getScheduleHistory', (_e, scheduleId: string) => scheduler.getHistory(scheduleId));

  // ---------- 渠道 ----------
  // 飞书真实接入（P3c）：保存凭据（secret 走 safeStorage）并建立长连接
  handle('aibox:configureFeishu', async (_e, appId: string, appSecret: string) => {
    feishu.saveCredentials(appId, appSecret);
    const r = await feishu.connect();
    pushSnapshot();
    return r;
  });
  // 企业微信智能机器人真实接入：官方长连接 API 模式（BotID/Secret，Secret 走 safeStorage）
  handle('aibox:configureWecom', async (_e, botId: string, secret: string) => {
    wecom.saveCredentials(botId, secret);
    const r = await wecom.connect();
    pushSnapshot();
    return r;
  });
  // 微信 iLink Bot：二维码、配对码和状态可见；Bot Token 永不返回 Renderer
  handle('aibox:startWeixinLogin', async (_e, agentId?: string) => {
    const selectedAgentId = agentId ? assertId(agentId, 'agentId') : null;
    const r = await weixin.startLogin(() => {
      db.raw.prepare('DELETE FROM channel_routes WHERE channel_id = ?').run('ch-weixin');
      if (selectedAgentId) channels.bindAgent('ch-weixin', selectedAgentId);
    });
    pushSnapshot();
    return r;
  });
  handle('aibox:getWeixinLoginState', () => weixin.getLoginState());
  handle('aibox:submitWeixinVerifyCode', (_e, code: string) =>
    weixin.submitVerifyCode(assertString(code, 'verifyCode', 1, 12)));
  handle('aibox:cancelWeixinLogin', () => weixin.cancelLogin());
  handle('aibox:disconnectChannel', async (_e, id: string) => {
    id = assertId(id, 'channelId');
    if (id === 'ch-weixin') {
      // Revoke local routing synchronously; the remote notifystop call is best-effort and may take seconds.
      channels.disconnect(id);
      await weixin.disconnect();
    } else {
      if (id === 'ch-feishu') feishu.disconnect();
      if (id === 'ch-wecom') wecom.disconnect();
      channels.disconnect(id);
    }
    pushSnapshot();
  });
  handle('aibox:bindChannel', (_e, channelId: string, agentId: string) => {
    channels.bindAgent(assertId(channelId, 'channelId'), assertId(agentId, 'agentId'));
    pushSnapshot();
  });
  handle('aibox:unbindChannel', (_e, channelId: string, agentId: string) => {
    channels.unbindAgent(assertId(channelId, 'channelId'), assertId(agentId, 'agentId'));
    pushSnapshot();
  });
  handle('aibox:bindChannelProject', (_e, channelId: string, projectId: string) => {
    channels.bindProject(assertId(channelId, 'channelId'), assertId(projectId, 'projectId'));
    pushSnapshot();
  });

  // ---------- 设置 ----------
  handle('aibox:getSetting', (_e, key: unknown) => readRendererSetting(db, key));
  handle('aibox:setSetting', (_e, key: unknown, value: unknown) => writeRendererSetting(db, key, value));
  handle('aibox:getDebugLogStatus', () => {
    if (!debugLogService) throw new Error('调试日志服务不可用');
    return debugLogService.getStatus();
  });
  handle('aibox:setDebugMode', (_event, enabled: unknown) => {
    if (!debugLogService) throw new Error('调试日志服务不可用');
    if (typeof enabled !== 'boolean') throw new Error('调试模式开关无效');
    const previous = debugLogService.getStatus().enabled;
    const status = debugLogService.setEnabled(enabled);
    try {
      db.setSetting('debug:enabled', enabled);
      db.audit({
        id: randomUUID(), actor: 'admin', action: 'debug.mode.update',
        target: 'debug-log', result: enabled ? 'enabled' : 'disabled'
      });
      return status;
    } catch (error) {
      debugLogService.setEnabled(previous);
      throw error;
    }
  });
  handle('aibox:openDebugLogDirectory', async () => {
    if (!debugLogService) throw new Error('调试日志服务不可用');
    mkdirSync(debugLogService.logDirectory, { recursive: true });
    const error = await shell.openPath(debugLogService.logDirectory);
    if (error) throw new Error(error);
    return { ok: true as const };
  });
  // ---------- OCR 文字识别服务 ----------
  // ---------- Nexus Vision / typed image attachments ----------
  handle('aibox:getVisionBinding', () => vision.getBinding());
  handle('aibox:configureVisionBinding', (_e, value: unknown) => {
    const input = assertRecord(value, 'vision model binding');
    assertKeys(input, ['providerId', 'model', 'enabled'], 'vision model binding');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('enabled must be boolean');
    return vision.configureBinding({
      providerId: assertId(input.providerId, 'providerId'),
      model: assertString(input.model, 'model', 1, 256),
      enabled: input.enabled as boolean | undefined
    });
  });
  handle('aibox:clearVisionBinding', () => { vision.clearBinding(); return null; });
  handle('aibox:putVisionAttachment', (_e, value: unknown) => vision.putAttachment(visionUploadInput(value)));
  handle('aibox:pickVisionAttachment', async () => {
    const options: OpenDialogOptions = {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
    };
    const owner = getMainWindow();
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length !== 1) return null;
    const selected = result.filePaths[0];
    const stat = lstatSync(selected);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new VisionServiceError('INVALID_ATTACHMENT', '不接受符号链接图片');
    if (stat.size < 1 || stat.size > MAX_VISION_IMAGE_BYTES) throw new VisionServiceError('ATTACHMENT_LIMIT', '图片超过大小限制');
    const filename = basename(selected);
    return vision.putAttachment({ data: readFileSync(selected), mimeType: visionMimeForFilename(filename), filename });
  });
  handle('aibox:describeVision', async (_e, value: unknown) => {
    const input = assertRecord(value, 'vision request');
    assertKeys(input, ['attachmentRef', 'prompt'], 'vision request');
    const request = {
      // VisionService performs the authoritative opaque-ref validation before
      // reading bytes; this cast only carries the validated boundary to TS.
      attachmentRef: input.attachmentRef as import('../shared/types.js').VisionAttachmentRef,
      ...(input.prompt === undefined ? {} : { prompt: assertString(input.prompt, 'prompt', 1, 16_000) })
    };
    if (visionPluginHost) {
      return visionPluginHost.invoke({ pluginId: VISION_PLUGIN_ID, capabilityId: VISION_TOOL_CAPABILITY_ID, input: request });
    }
    return vision.describe(request);
  });

  handle('aibox:getOcrStatus', () => ocr.getStatus());
  handle('aibox:toggleOcr', (_e, enabled: boolean) => { ocr.setEnabled(enabled); return ocr.getStatus(); });
  handle('aibox:downloadOcrModels', () => ocr.downloadModels());
  handle('aibox:ocrRecognize', async (_e, value: unknown) => {
    const request = { attachmentRef: value as import('../shared/types.js').VisionAttachmentRef };
    if (visionPluginHost) {
      return visionPluginHost.invoke({
        pluginId: VISION_PLUGIN_ID,
        capabilityId: VISION_OCR_TOOL_CAPABILITY_ID,
        input: request
      });
    }
    // VisionService remains the authoritative attachment parser and integrity
    // checker when the optional plugin host is unavailable.
    return ocr.recognizeBytes(vision.readAttachment(request.attachmentRef));
  });

  // ---------- 语音任务下达（全双工实时识别） ----------
  // 音频经主进程转发而非 Renderer 直连云端：云端凭据必须留在主进程（安全基线 15.1）
  handle('aibox:getVoiceConfig', () => voice.getConfig());
  handle('aibox:saveVoiceConfig', (_e, input: import('../shared/types.js').VoiceConfigInput) => {
    const r = voice.saveConfig(input ?? {});
    pushSnapshot();
    return r;
  });
  handle('aibox:testVoice', () => voice.test());
  handle('aibox:startVoiceSession', () => voice.start());
  handle('aibox:pushVoiceAudio', (_e, sessionId: string, chunk: ArrayBuffer) => {
    voice.pushAudio(assertId(sessionId, 'sessionId'), Buffer.from(assertVoiceAudioChunk(chunk)));
  });
  handle('aibox:stopVoiceSession', (_e, sessionId: string) => {
    voice.stop(assertId(sessionId, 'sessionId'));
  });
  /** 解析语音文本为任务草稿（不派发；供确认界面展示） */
  handle('aibox:parseVoiceCommand', (_e, text: string) => {
    const agents = orchestrator.listAgents()
      .filter((a) => a.lifecycle === 'READY')
      .map((a) => ({ id: a.id, name: a.name }));
    const defaultAgentId = db.getSetting<string | null>('voice:defaultAgentId', null);
    return parseVoiceCommand(assertString(text, 'text', 0, 2000), agents, defaultAgentId);
  });
  /** 确认后派发：source='voice' 便于审计与统计区分手动派发 */
  handle('aibox:dispatchVoiceTask', async (_e, agentId: string, title: string, messageKey: string) => {
    const result = await desktopControlPlane.dispatch({
      preferredAgentId: assertId(agentId, 'agentId'),
      message: assertString(title, 'title', 1, 200),
      source: 'voice',
      messageKey: assertId(messageKey, 'messageKey')
    });
    db.audit({ id: randomUUID(), actor: 'admin', action: 'voice.dispatch', target: result.task.id, result: 'ok' });
    pushSnapshot();
    return result.task;
  });
  // 数据库维护：完整性检查 + 手动清理
  handle('aibox:integrityCheck', () => db.integrityCheck());
  handle('aibox:manualCleanup', () => { db.cleanupRetention(); return { ok: true, message: '数据清理完成' }; });
  // 窗口控制：全屏切换
  handle('aibox:toggleFullscreen', (event) => {
    const win = windowForSender(event);
    if (win) win.setFullScreen(!win.isFullScreen());
    return win?.isFullScreen() ?? false;
  });
  handle('aibox:isFullscreen', (event) => windowForSender(event)?.isFullScreen() ?? false);

  // ---------- 工作目录选择（7.2：必须由用户选择并进入允许列表） ----------
  handle('aibox:pickDirectory', async (event) => {
    const win = windowForSender(event);
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  // ---------- 数据备份导出（本地优先：用户可备份 SQLite 数据库） ----------
  handle('aibox:exportData', async () => {
    const win = getMainWindow();
    if (!win) return { ok: false, message: '窗口不存在' };
    const stamp = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(win, {
      title: '导出数据库备份',
      defaultPath: `aibox-backup-${stamp}.db`,
      filters: [{ name: 'SQLite 数据库', extensions: ['db'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, message: '已取消' };
    try {
      db.flush(); // 先落盘再复制，保证备份完整
      copyFileSync(join(app.getPath('userData'), 'aibox-data', 'aibox.db'), r.filePath);
      db.audit({ id: randomUUID(), actor: 'admin', action: 'data.export', target: r.filePath, result: 'ok' });
      return { ok: true, message: `备份已导出：${r.filePath}` };
    } catch (err) {
      return { ok: false, message: `导出失败：${err instanceof Error ? err.message : String(err)}` };
    }
  });

  handle('aibox:restoreData', async () => {
    const win = getMainWindow();
    if (!win) return { ok: false, message: '窗口不存在', restartRequired: false };
    const r = await dialog.showOpenDialog(win, {
      title: '选择 AI Box 数据库备份', properties: ['openFile'],
      filters: [{ name: 'SQLite 数据库', extensions: ['db'] }]
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, message: '已取消', restartRequired: false };
    try {
      const result = await db.stageRestore(r.filePaths[0]);
      return { ...result, restartRequired: result.ok };
    } catch (error) {
      db.audit({ id: randomUUID(), actor: 'admin', action: 'data.restore.stage', target: 'backup', result: 'invalid' });
      return { ok: false, message: `恢复失败：${error instanceof Error ? error.message : String(error)}`, restartRequired: false };
    }
  });
  handle('aibox:restartApp', () => {
    db.flush();
    app.relaunch();
    // app.quit() 会经过 before-quit，等待微信长轮询 worker 停止并再次落盘。
    app.quit();
  });

  // ---------- 前端异常上报（ErrorBoundary 捕获的渲染异常写入审计日志） ----------
  handle('aibox:reportError', (_e, payload: { message: string; stack?: string; componentStack?: string }) => {
    db.audit({
      id: randomUUID(), actor: 'renderer', action: 'ui.error',
      target: (payload?.message ?? 'unknown').slice(0, 200),
      result: 'error',
      source: (payload?.stack ?? '').slice(0, 300) || 'renderer'
    });
  });

  // ---------- 多机协同 ----------
  handle('aibox:collab:checkGit', async () => {
    const runtimes = await engines.checkRuntime();
    return runtimes.find((r) => r.name === 'Git') ?? { name: 'Git', installed: false, version: null, path: null };
  });
  handle('aibox:collab:installGit', () => engines.installRuntime('Git'));
  handle('aibox:collab:listWorkspaces', () => collab.listWorkspaces());
  handle('aibox:collab:createWorkspace', (_e, input: { name: string; repoPath: string; conventions?: string; gitRules?: string; mcpPort?: number; gitPort?: number }) => {
    assertString(input?.name, 'name', 1, 50);
    assertString(input?.repoPath, 'repoPath', 1, 500);
    return collab.createWorkspace(input);
  });
  handle('aibox:collab:removeWorkspace', (_e, id: string) => collab.removeWorkspace(assertId(id)));
  handle('aibox:collab:startWorkspace', (_e, id: string) => collab.startWorkspace(assertId(id)));
  handle('aibox:collab:stopWorkspace', (_e, id: string) => { collab.stopWorkspace(assertId(id)); });
  handle('aibox:collab:listTasks', (_e, workspaceId: string) => collab.listTasks(assertId(workspaceId, 'workspaceId')));
  handle('aibox:collab:createTask', (_e, workspaceId: string, input: { title: string; description?: string; branchName?: string }) => {
    assertString(input?.title, 'title', 1, 200);
    return collab.createTask(assertId(workspaceId, 'workspaceId'), input);
  });
  handle('aibox:collab:reviewTask', (_e, taskId: string, result: 'accept' | 'reject', comment: string) => {
    return collab.reviewTask(assertId(taskId, 'taskId'), result, comment ?? '');
  });
  handle('aibox:collab:listAgents', (_e, workspaceId: string) => collab.listAgents(assertId(workspaceId, 'workspaceId')));
  handle('aibox:collab:getConnectInfo', (_e, workspaceId: string) => collab.getConnectInfo(assertId(workspaceId, 'workspaceId')));
  handle('aibox:collab:updateRules', (_e, id: string, patch: { conventions?: string; gitRules?: string }) => {
    collab.updateRules(assertId(id), patch);
  });

  return { pushSnapshot };
}

let snapshotVersion = 0;

function buildSnapshot(deps: IpcDeps) {
  const todos = deps.orchestrator.todos();
  // 系统级待办：无可用执行器提醒 + 资源告警（遗留修复）
  const executorAvailable = deps.engines.hasUsableExecutor();
  const systemTodos: TodoItem[] = [];
  if (!executorAvailable) {
    systemTodos.push({
      id: 'sys-no-executor',
      title: '未检测到可用执行引擎，请到引擎中心安装并验证 CLI，或配置受管模型供应商',
      owner: '引擎中心', dueText: '尽快处理', severity: 'high', kind: 'system'
    });
  }
  for (const [i, msg] of deps.monitor.getAlerts().entries()) {
    systemTodos.push({ id: `sys-alert-${i}`, title: msg, owner: '系统监控', dueText: '资源告警', severity: 'high', kind: 'system' });
  }
  return {
    version: ++snapshotVersion,
    stats: deps.orchestrator.stats(),
    agentCards: deps.orchestrator.agentCards(),
    projects: deps.projects.list(),
    // 结果正文由 getTaskResult 按需读取，避免每次状态变化都通过 IPC
    // 克隆 200 份任务产物到 Renderer。
    tasks: deps.orchestrator.listTasks({ includeResult: false }).filter((task) => {
      if (task.status !== 'COMPLETED') return true;
      const gate = deps.hermesGovernance?.getDeliveryGate(task.id);
      return !gate || !gate.required || gate.allowed;
    }),
    todos: [...systemTodos, ...todos].slice(0, 12),
    approvals: deps.orchestrator.listApprovals(),
    // Retired engine identities remain hidden while historical task rows are
    // retained for audit.
    engines: deps.engines.list().filter(isQuestVisibleEngine),
    channels: deps.channels.list(),
    schedules: deps.scheduler.list(),
    // 至少一个已验证可用的执行器才能支持系统正常运行
    executorAvailable
  };
}
