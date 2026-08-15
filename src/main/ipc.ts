/**
 * IPC 白名单（PRD 12.2：不允许 Renderer 透传任意命令）
 * Renderer 仅能调用此处显式注册的方法；密钥操作只通过 safeStorage 句柄。
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
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
import type { MobileGatewayService } from './services/mobileGatewayService.js';
import type { MobileAdbService } from './services/mobileAdbService.js';
import type { MemoryService } from './services/memoryService.js';
import type { MemoryProposalService } from './services/memoryProposalService.js';
import type { TaskScheduleProposalService } from './services/taskScheduleProposalService.js';
import { getMobileToolCatalog, isMobileToolName, MOBILE_TOOL_NAMES } from './services/mobileCatalog.js';
import { createProvisionedAgent } from './services/mobileAgentProvisioning.js';
import { importFromHermes, exportToHermes } from './services/hermesSync.js';
import { getProviderConfig, saveProviderConfig, testProvider } from './services/provider.js';
import { loadConfig, saveConfig } from './services/config.js';
import { demoDataStats, purgeDemoData } from './services/seed.js';
import { parseVoiceCommand } from './services/voiceCommand.js';
import type {
  AppConfig, CreateAgentInput, DeliverableMetaPatch, DeliverableReviewInput, DeliverableVersionInput,
  KnowledgeInput, KnowledgePatch, KnowledgeQuery, KnowledgeVersionInput,
  ProjectInput, ProjectPatch, ScheduleInput, SystemInfo, TodoItem, AgentPersonaPatch, WfNode, WfEdge,
  AutomationReportKind, CustomerDeliveryInput, CustomerDeliveryStatus, ProjectBudgetInput,
  MemoryForgetInput, MemoryListInput, MemoryProposalDecisionInput, MemoryProposalListInput,
  MemoryRecallInput, MemoryRememberInput, MemoryUpdateInput,
  TaskScheduleProposalDecisionInput, TaskScheduleProposalListInput,
  MobileScriptDefinition, MobileToolName, EngineRuntimeConfig
} from '../shared/types.js';
import { NEXUS_ENGINE_ID } from '../shared/types.js';
import { hostname, release } from 'node:os';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeOptionalUtf8Text, decodeUtf8Text } from './services/textEncoding.js';
import { readRendererSetting, writeRendererSetting } from './services/rendererSettings.js';
import { BRIDGE_KEY_SECRET_REF } from './services/apiBridge.js';
import { WEB_TOKEN_SECRET_REF } from './services/webServer.js';
import { summarizeAppMemory } from './services/appMemory.js';

/** 轻量级运行时参数校验（防御异常/恶意输入穿透） */
function assertString(v: unknown, field: string, min = 1, max = 500): string {
  return decodeUtf8Text(v, field, min, max);
}
function assertId(v: unknown, field = 'id'): string {
  return assertString(v, field, 1, 100);
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

function optionalLimit(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isFinite(v) || (v as number) < 1) throw new Error('limit must be a positive number');
  return Math.trunc(v as number);
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
  voice: import('./services/voiceService.js').VoiceService;
  apiBridge: import('./services/apiBridge.js').ApiBridge;
  webServer: import('./services/webServer.js').WebServer;
  mobile: MobileGatewayService;
  mobileAdb: MobileAdbService;
  memory: MemoryService;
  memoryProposals: MemoryProposalService;
  taskScheduleProposals: TaskScheduleProposalService;
  getMainWindow: () => BrowserWindow | null;
}

export function registerIpc(deps: IpcDeps) {
  const { db, orchestrator, desktopControlPlane, executors, engines, channels, feishu, wecom, weixin, scheduler, broker, monitor, mcp, skills, providers, workflows, projects, deliverables, knowledge, automation, discovery, teams, wfPlatforms, collab, ocr, voice, webServer, mobile, mobileAdb, memory, memoryProposals, taskScheduleProposals, getMainWindow } = deps;

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
  ipcMain.handle('aibox:getSnapshot', () => buildSnapshot(deps));
  ipcMain.handle('aibox:getAppVersion', () => app.getVersion());
  ipcMain.handle('aibox:getResourceHistory', () => ({ history: monitor.getHistory(), health: monitor.getHealth() }));
  ipcMain.handle('aibox:getSystemInfo', (): SystemInfo => ({
    platform: process.platform,
    osVersion: release(),
    hostname: hostname(),
    uptimeSec: Math.floor(process.uptime()),
    appVersion: app.getVersion()
  }));
  ipcMain.handle('aibox:getAppMemory', () => summarizeAppMemory(app.getAppMetrics(), process.memoryUsage()));
  ipcMain.handle('aibox:globalSearch', (_e, query: string) => discovery.search(assertString(query ?? '', 'query', 0, 100)));
  ipcMain.handle('aibox:getActionCenter', () => discovery.actions());
  ipcMain.handle('aibox:listMemories', (_e, input: MemoryListInput = {}) => memory.list({
    organizationId: LOCAL_MEMORY_ORGANIZATION_ID,
    status: input?.status,
    limit: optionalLimit(input?.limit)
  }));
  ipcMain.handle('aibox:recallMemories', (_e, input: MemoryRecallInput = {}) => memory.recall({
    organizationId: LOCAL_MEMORY_ORGANIZATION_ID,
    principalId: optionalId(input?.principalId, 'principalId'),
    channelId: optionalId(input?.channelId, 'channelId'),
    conversationId: optionalId(input?.conversationId, 'conversationId'),
    agentId: optionalId(input?.agentId, 'agentId'),
    projectId: optionalId(input?.projectId, 'projectId'),
    query: input?.query === undefined ? undefined : assertString(input.query, 'query', 0, 4_000),
    limit: optionalLimit(input?.limit)
  }));
  ipcMain.handle('aibox:rememberMemory', (_e, input: MemoryRememberInput) => memory.remember({
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
  ipcMain.handle('aibox:updateMemory', (_e, input: MemoryUpdateInput) => memory.update({
    organizationId: LOCAL_MEMORY_ORGANIZATION_ID,
    memoryId: assertId(input?.memoryId, 'memoryId'),
    expectedRevision: positiveInteger(input?.expectedRevision, 'expectedRevision'),
    content: input?.content === undefined ? undefined : assertString(input.content, 'content', 1, 8_000),
    importance: optionalUnitInterval(input?.importance, 'importance'),
    reason: input?.reason === undefined ? undefined : assertString(input.reason, 'reason', 0, 2_000),
    actor: 'admin',
    source: 'desktop'
  }));
  ipcMain.handle('aibox:forgetMemory', (_e, input: MemoryForgetInput) => memory.forget({
    organizationId: LOCAL_MEMORY_ORGANIZATION_ID,
    memoryId: assertId(input?.memoryId, 'memoryId'),
    expectedRevision: positiveInteger(input?.expectedRevision, 'expectedRevision'),
    reason: input?.reason === undefined ? undefined : assertString(input.reason, 'reason', 0, 2_000),
    actor: 'admin',
    source: 'desktop'
  }));
  ipcMain.handle('aibox:listMemoryProposals', (_e, input: MemoryProposalListInput = {}) => memoryProposals.list({
    organizationId: LOCAL_MEMORY_ORGANIZATION_ID,
    status: input?.status,
    limit: optionalLimit(input?.limit)
  }));
  ipcMain.handle('aibox:acceptMemoryProposal', (_e, input: MemoryProposalDecisionInput) => memoryProposals.accept({
    organizationId: LOCAL_MEMORY_ORGANIZATION_ID,
    proposalId: assertId(input?.proposalId, 'proposalId'),
    reason: input?.reason === undefined ? undefined : assertString(input.reason, 'reason', 0, 2_000),
    actor: 'admin',
    source: 'desktop'
  }));
  ipcMain.handle('aibox:rejectMemoryProposal', (_e, input: MemoryProposalDecisionInput) => memoryProposals.reject({
    organizationId: LOCAL_MEMORY_ORGANIZATION_ID,
    proposalId: assertId(input?.proposalId, 'proposalId'),
    reason: input?.reason === undefined ? undefined : assertString(input.reason, 'reason', 0, 2_000),
    actor: 'admin',
    source: 'desktop'
  }));
  ipcMain.handle('aibox:listTaskScheduleProposals', (_e, input: TaskScheduleProposalListInput = {}) => taskScheduleProposals.list({
    organizationId: LOCAL_MEMORY_ORGANIZATION_ID,
    status: input?.status,
    limit: optionalLimit(input?.limit)
  }));
  ipcMain.handle('aibox:acceptTaskScheduleProposal', (_e, input: TaskScheduleProposalDecisionInput) => {
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
  ipcMain.handle('aibox:rejectTaskScheduleProposal', (_e, input: TaskScheduleProposalDecisionInput) => taskScheduleProposals.reject({
    organizationId: LOCAL_MEMORY_ORGANIZATION_ID,
    proposalId: assertId(input?.proposalId, 'proposalId'),
    reason: input?.reason === undefined ? undefined : assertString(input.reason, 'reason', 0, 2_000),
    actor: 'admin',
    source: 'desktop'
  }));
  ipcMain.handle('aibox:dismissAction', (_e, actionKey: string, fingerprint: string) => {
    discovery.dismiss(assertString(actionKey, 'actionKey', 1, 180), assertString(fingerprint, 'fingerprint', 8, 80));
    return { ok: true };
  });

  // ---------- 项目 ----------
  ipcMain.handle('aibox:createProject', (_e, input: ProjectInput) => {
    const project = projects.create(input);
    pushSnapshot();
    return project;
  });
  ipcMain.handle('aibox:updateProject', (_e, id: string, patch: ProjectPatch) => {
    const project = projects.update(assertId(id, 'projectId'), patch);
    pushSnapshot();
    return project;
  });
  ipcMain.handle('aibox:archiveProject', (_e, id: string) => {
    const project = projects.archive(assertId(id, 'projectId'));
    pushSnapshot();
    return project;
  });
  ipcMain.handle('aibox:getProjectOperations', () => projects.operations(deliverables.list()));

  // ---------- 项目经营自动化 ----------
  ipcMain.handle('aibox:getAutomationOverview', (_e, projectId?: string) =>
    automation.overview(projectId ? assertId(projectId, 'projectId') : undefined));
  ipcMain.handle('aibox:runAutomationReport', (_e, kind: AutomationReportKind, projectId: string) => {
    if (!['project_inspection', 'weekly_report', 'monthly_report'].includes(kind)) throw new Error('自动化报告类型无效');
    return automation.run(kind, assertId(projectId, 'projectId'));
  });
  ipcMain.handle('aibox:setProjectBudget', (_e, projectId: string, input: ProjectBudgetInput) =>
    automation.setBudget(assertId(projectId, 'projectId'), input));
  ipcMain.handle('aibox:recommendAssignees', (_e, projectId: string, brief: string) =>
    automation.recommendAssignees(assertId(projectId, 'projectId'), assertString(brief ?? '', 'brief', 0, 500)));
  ipcMain.handle('aibox:createCustomerDelivery', (_e, input: CustomerDeliveryInput) => {
    if (!input || !Array.isArray(input.deliverableIds) || input.deliverableIds.some((id) => typeof id !== 'string')) throw new Error('成果列表无效');
    return automation.createDelivery({
      projectId: assertId(input.projectId, 'projectId'),
      customerName: assertString(input.customerName, 'customerName', 2, 100),
      title: assertString(input.title, 'title', 2, 160),
      deliverableIds: input.deliverableIds.map((id) => assertId(id, 'deliverableId')),
      note: input.note ? assertString(input.note, 'note', 1, 1000) : undefined
    });
  });
  ipcMain.handle('aibox:updateCustomerDeliveryStatus', (_e, id: string, status: CustomerDeliveryStatus) => {
    if (!['draft', 'delivered', 'accepted'].includes(status)) throw new Error('交付状态无效');
    return automation.updateDeliveryStatus(assertId(id, 'deliveryId'), status);
  });

  // ---------- 成果验收 ----------
  ipcMain.handle('aibox:listDeliverables', () => deliverables.list());
  ipcMain.handle('aibox:getDeliverable', (_e, id: string) => deliverables.get(assertId(id, 'deliverableId')));
  ipcMain.handle('aibox:updateDeliverableMeta', (_e, id: string, patch: DeliverableMetaPatch) =>
    deliverables.updateMeta(assertId(id, 'deliverableId'), patch));
  ipcMain.handle('aibox:addDeliverableVersion', (_e, id: string, input: DeliverableVersionInput) =>
    deliverables.addVersion(assertId(id, 'deliverableId'), input));
  ipcMain.handle('aibox:reviewDeliverable', (_e, id: string, input: DeliverableReviewInput) => {
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
  ipcMain.handle('aibox:getProjectDeliverablePackage', (_e, projectId: string) =>
    deliverables.packageForProject(assertId(projectId, 'projectId')));

  // ---------- 项目知识库 ----------
  ipcMain.handle('aibox:listKnowledge', (_e, query?: KnowledgeQuery) => knowledge.list(query ?? {}));
  ipcMain.handle('aibox:getKnowledge', (_e, id: string) => knowledge.get(assertId(id, 'knowledgeId')));
  ipcMain.handle('aibox:createKnowledge', (_e, input: KnowledgeInput) =>
    knowledge.create(input));
  ipcMain.handle('aibox:updateKnowledge', (_e, id: string, patch: KnowledgePatch) =>
    knowledge.update(assertId(id, 'knowledgeId'), patch));
  ipcMain.handle('aibox:addKnowledgeVersion', (_e, id: string, input: KnowledgeVersionInput) =>
    knowledge.addVersion(assertId(id, 'knowledgeId'), input));
  ipcMain.handle('aibox:exportDeliverable', async (_e, id: string, format: 'markdown' | 'json') => {
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
  ipcMain.handle('aibox:exportProjectDeliverablePackage', async (_e, projectId: string) => {
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
  ipcMain.handle('aibox:createAgent', async (_e, input: CreateAgentInput) => {
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
  ipcMain.handle('aibox:startAgent', (_e, id: string) => orchestrator.startAgent(assertId(id)));
  ipcMain.handle('aibox:stopAgent', (_e, id: string) => orchestrator.stopAgent(assertId(id)));
  // 助手人设编辑（soul.md / agents.md / user.md / 权限模式）
  ipcMain.handle('aibox:updateAgentPersona', async (_e, id: string, patch: AgentPersonaPatch) => {
    patch = decodePersonaPatch(patch);
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
  ipcMain.handle('aibox:mobile:getStatus', () => mobile.getStatus());
  ipcMain.handle('aibox:mobile:listLanAddresses', () => mobile.getLanAddresses());
  ipcMain.handle('aibox:mobile:startGateway', (_e, host: string, port?: number) =>
    mobile.start(assertString(host, 'host', 7, 45), assertPort(port ?? 18765)));
  ipcMain.handle('aibox:mobile:stopGateway', () => mobile.stop(true));
  ipcMain.handle('aibox:mobile:resetCertificate', () => mobile.resetCertificate());
  ipcMain.handle('aibox:mobile:createPairing', () => mobile.createPairing());
  ipcMain.handle('aibox:mobile:copyPairingConfig', (_e, pairingId: string) => {
    clipboard.writeText(mobile.getPairingConfigForCopy(assertId(pairingId, 'pairingId')));
    return { ok: true as const };
  });
  ipcMain.handle('aibox:mobile:getToolCatalog', () => getMobileToolCatalog());
  ipcMain.handle('aibox:mobile:listDevices', () => mobile.listDevices());
  ipcMain.handle('aibox:mobile:getAgentConfig', (_e, agentId: string) => mobile.getAgentConfig(assertId(agentId, 'agentId')));
  ipcMain.handle('aibox:mobile:bindAgent', (_e, input: { agentId: string; deviceId: string; allowedTools: MobileToolName[]; confirmAuthorization: boolean }) =>
    mobile.bindAgent(assertId(input?.agentId, 'agentId'), assertId(input?.deviceId, 'deviceId'), assertMobileTools(input?.allowedTools), input?.confirmAuthorization === true));
  ipcMain.handle('aibox:mobile:unbindAgent', (_e, agentId: string) => mobile.unbindAgent(assertId(agentId, 'agentId')));
  ipcMain.handle('aibox:mobile:updateToolPolicy', (_e, input: { agentId: string; allowedTools: MobileToolName[]; confirmAuthorization: boolean }) =>
    mobile.updateToolPolicy(assertId(input?.agentId, 'agentId'), assertMobileTools(input?.allowedTools), input?.confirmAuthorization === true));
  ipcMain.handle('aibox:mobile:refreshPreview', (_e, deviceId: string) => mobile.refreshPreview(assertId(deviceId, 'deviceId')));
  ipcMain.handle('aibox:mobile:readUiTree', (_e, deviceId: string) => mobile.readUiTree(assertId(deviceId, 'deviceId')));
  ipcMain.handle('aibox:mobile:execute', (_e, input: { deviceId: string; toolName: MobileToolName; args: Record<string, unknown> }) => {
    const toolName = assertMobileTool(input?.toolName);
    if (!input?.args || typeof input.args !== 'object' || Array.isArray(input.args)) throw new Error('args 必须是对象');
    return mobile.executeManual(assertId(input.deviceId, 'deviceId'), toolName, input.args);
  });
  ipcMain.handle('aibox:mobile:listCommands', (_e, deviceId?: string) => mobile.listCommands(deviceId ? assertId(deviceId, 'deviceId') : undefined));
  ipcMain.handle('aibox:mobile:listArtifacts', (_e, deviceId?: string) => mobile.listArtifacts(deviceId ? assertId(deviceId, 'deviceId') : undefined));
  ipcMain.handle('aibox:mobile:listScripts', () => mobile.listScripts());
  ipcMain.handle('aibox:mobile:saveScript', (_e, input: Omit<MobileScriptDefinition, 'id' | 'createdAt' | 'updatedAt'>, id?: string) =>
    mobile.saveScript(input, id ? assertId(id, 'scriptId') : undefined));
  ipcMain.handle('aibox:mobile:deleteScript', (_e, id: string) => mobile.deleteScript(assertId(id, 'scriptId')));
  ipcMain.handle('aibox:mobile:runScript', (_e, id: string) => mobile.runScript(assertId(id, 'scriptId')));
  ipcMain.handle('aibox:mobile:emergencyStop', (_e, deviceId: string) => mobile.emergencyStop(assertId(deviceId, 'deviceId')));
  ipcMain.handle('aibox:mobile:getApkInfo', () => mobileAdb.getApkInfo());
  ipcMain.handle('aibox:mobile:listAdbDevices', () => mobileAdb.listDevices());
  ipcMain.handle('aibox:mobile:installApk', (_e, serial: string) => mobileAdb.install(assertString(serial, 'serial', 1, 128)));
  ipcMain.handle('aibox:mobile:exportApk', async () => {
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
  ipcMain.handle('aibox:generatePersona', async (_e, description: string) => {
    const { getProviderSettings, readProviderKey } = await import('./services/provider.js');
    const settings = getProviderSettings(db);
    const key = readProviderKey(db);
    if (!settings || !key) throw new Error('请先在设置页配置模型供应商');
    const prompt = `请根据以下描述生成一个 AI 助手的配置，用 JSON 格式输出：
{"name":"助手名称","role":"职责描述(50-100字)","soulMd":"身份与性格(100-200字)","agentsMd":"行为指令(5条规则)","systemPrompt":"系统提示词(50-100字)","permissionMode":"readonly或standard"}

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
  ipcMain.handle('aibox:listConversations', (_e, agentId: string) => orchestrator.listConversations(agentId));
  ipcMain.handle('aibox:chatWithAgent', async (_e, agentId: string, message: string, conversationId?: string, messageKey?: string) => {
    const r = await desktopControlPlane.dispatch({
      preferredAgentId: assertId(agentId, 'agentId'),
      message: assertString(message, 'message', 1, 20_000),
      conversationId: conversationId ? assertId(conversationId, 'conversationId') : undefined,
      messageKey: messageKey ? assertId(messageKey, 'messageKey') : undefined
    });
    pushSnapshot();
    return r;
  });
  // 会话管理：重命名 / 删除
  ipcMain.handle('aibox:renameConversation', (_e, id: string, title: string) => {
    db.raw.prepare("UPDATE conversations SET title = ? WHERE id = ? AND channel_id IS NULL AND organization_id = 'org-local'")
      .run(assertString(title, 'title', 1, 100), assertId(id, 'conversationId'));
  });
  ipcMain.handle('aibox:deleteConversation', (_e, id: string) => {
    db.raw.prepare("DELETE FROM conversations WHERE id = ? AND channel_id IS NULL AND organization_id = 'org-local'")
      .run(assertId(id, 'conversationId'));
  });
  // 用量统计
  ipcMain.handle('aibox:getUsageStats', () => orchestrator.usageStats());
  ipcMain.handle('aibox:getUsageStatsEnhanced', (_e, since: number | null) => {
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
  ipcMain.handle('aibox:listMcpServers', () => mcp.list());
  ipcMain.handle('aibox:createMcpServer', (_e, input: { name: string; command: string; args?: string[]; env?: Record<string, string>; scope?: string; capability?: 'browser' | '' }) => {
    assertString(input?.name, 'name', 2, 80);
    assertString(input?.command, 'command', 1, 500);
    if (/[&|<>^%\r\n]/.test(input.command)) throw new Error('启动命令包含不允许的字符');
    if (input.args?.some((arg) => typeof arg !== 'string' || arg.length > 1000 || /[&|<>^%\r\n]/.test(arg))) throw new Error('启动参数无效');
    return mcp.create(input);
  });
  ipcMain.handle('aibox:createPlaywrightBrowser', async (_e, input: { agentId: string; extensionToken?: string }) => {
    const agentId = assertId(input?.agentId, 'agentId');
    if (input?.extensionToken !== undefined && typeof input.extensionToken !== 'string') throw new Error('扩展 Token 格式无效');
    if (input?.extensionToken !== undefined && input.extensionToken.length > 500) throw new Error('扩展 Token 过长');
    const agent = orchestrator.listAgents().find((item) => item.id === agentId);
    if (!agent) throw new Error('数字员工不存在');
    if (!executors.supportsMcp(agent.engineId)) throw new Error('浏览器 MCP 目前仅支持 Nexus Agent 数字员工');
    const server = mcp.createPlaywrightBrowser({ agentId, extensionToken: input.extensionToken });
    orchestrator.updateAgentPersona(agentId, { capabilities: { browser: true } });
    skills.ensureBrowserOperator(agentId);
    // MCP 子进程只在启动时读取环境变量，更新 Token 后必须重启才能生效。
    if (input.extensionToken?.trim() && mcp.isRunning(server.id)) await mcp.stop(server.id);
    const connection = await mcp.start(server.id);
    pushSnapshot();
    return { server, connection };
  });
  ipcMain.handle('aibox:removeMcpServer', (_e, id: string) => mcp.remove(id));
  ipcMain.handle('aibox:toggleMcpServer', (_e, id: string, enabled: boolean) => mcp.toggle(id, enabled));
  ipcMain.handle('aibox:startMcpServer', (_e, id: string) => mcp.start(id));
  ipcMain.handle('aibox:stopMcpServer', (_e, id: string) => mcp.stop(id));
  ipcMain.handle('aibox:getMcpTools', () => mcp.allTools());
  // 注：aibox:callMcpTool 已移除 —— preload 未暴露、无任何调用方，
  // 保留只是把「任意 MCP 工具调用」暴露成可达攻击面。
  // McpManager.callTool 目前仅供后续执行器接入 MCP 工具时在主进程内调用；
  // 真正接入时应经工具注册表（tools.ts）声明，而非重新开放 IPC 通道。

  // ---------- Skills 管理 ----------
  ipcMain.handle('aibox:listSkills', () => skills.list());
  ipcMain.handle('aibox:createSkill', (_e, input: { name: string; description?: string; content?: string }) => skills.create(input));
  ipcMain.handle('aibox:updateSkill', (_e, id: string, patch: { name?: string; description?: string; content?: string; enabled?: boolean }) => skills.update(id, patch));
  ipcMain.handle('aibox:removeSkill', (_e, id: string) => skills.remove(id));
  ipcMain.handle('aibox:bindSkill', (_e, agentId: string, skillId: string) => skills.bindAgent(agentId, skillId));
  ipcMain.handle('aibox:unbindSkill', (_e, agentId: string, skillId: string) => skills.unbindAgent(agentId, skillId));
  ipcMain.handle('aibox:getAgentSkills', (_e, agentId: string) => skills.forAgent(agentId));
  // Skills 组合 → 数字员工（P4）：单个/多个技能一键生成可真实执行的员工
  ipcMain.handle('aibox:createAgentFromSkills', (_e, input: { skillIds: string[]; name?: string; engineId?: string }) => {
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
      engineId, workspace: '', permissionMode: 'standard', concurrencyLimit: 1, channelIds: []
    });
    for (const skillId of draft.skillIds) skills.bindAgent(agent.id, skillId);
    db.audit({ id: randomUUID(), actor: 'admin', action: 'agent.createFromSkills', target: agent.id, result: draft.skillIds.join(',') });
    pushSnapshot();
    return agent;
  });

  // ---------- Hermes 同步 ----------
  ipcMain.handle('aibox:importFromHermes', () => importFromHermes(mcp, skills));
  ipcMain.handle('aibox:exportToHermes', () => exportToHermes(mcp, skills));

  // ---------- 多供应商管理 ----------
  ipcMain.handle('aibox:listProviders', () => providers.list());
  ipcMain.handle('aibox:createProvider', (_e, input: { name: string; baseUrl: string; model: string; apiKey?: string; isDefault?: boolean }) => {
    const provider = providers.create(input);
    pushSnapshot();
    return provider;
  });
  ipcMain.handle('aibox:updateProvider', (_e, id: string, patch: { name?: string; baseUrl?: string; model?: string; apiKey?: string; isDefault?: boolean }) => {
    providers.update(id, patch);
    pushSnapshot();
  });
  ipcMain.handle('aibox:removeProvider', (_e, id: string) => {
    providers.remove(id);
    pushSnapshot();
  });
  ipcMain.handle('aibox:testProviderById', (_e, id: string) => providers.testById(id));
  ipcMain.handle('aibox:fetchProviderModels', (_e, id: string) => providers.fetchModels(id));
  // ---------- API Bridge ----------
  ipcMain.handle('aibox:getBridgeStatus', () => deps.apiBridge.getStatus());
  ipcMain.handle('aibox:toggleBridge', async (_e, enabled: boolean) => {
    await deps.apiBridge.toggle(enabled);
    return deps.apiBridge.getStatus();
  });
  ipcMain.handle('aibox:regenerateBridgeKey', async () => {
    deps.apiBridge.regenerateKey();
    const status = deps.apiBridge.getStatus();
    if (status.enabled && !status.running) await deps.apiBridge.start();
    return deps.apiBridge.getStatus();
  });
  ipcMain.handle('aibox:copyBridgeKey', () => {
    clipboard.writeText(deps.apiBridge.getBridgeKey());
    db.audit({ id: randomUUID(), actor: 'admin', action: 'bridge.key.copy', target: BRIDGE_KEY_SECRET_REF, result: 'clipboard' });
    return { ok: true as const };
  });

  // ---------- Prompt 模板 ----------
  ipcMain.handle('aibox:listTemplates', () => (db.raw.prepare('SELECT * FROM prompt_templates ORDER BY created_at DESC').all() as unknown as { id: string; name: string; content: string; category: string; created_at: number }[]).map((r) => ({ id: r.id, name: r.name, content: r.content, category: r.category, createdAt: r.created_at })));
  ipcMain.handle('aibox:createTemplate', (_e, input: { name: string; content: string; category?: string }) => {
    const id = `tpl-${randomUUID().slice(0, 8)}`;
    db.raw.prepare('INSERT INTO prompt_templates(id, name, content, category, created_at) VALUES(?,?,?,?,?)').run(id, input.name, input.content, input.category ?? 'general', Date.now());
    return { id, ...input };
  });
  ipcMain.handle('aibox:removeTemplate', (_e, id: string) => db.raw.prepare('DELETE FROM prompt_templates WHERE id = ?').run(id));

  // ---------- Agent 克隆/导入导出 ----------
  ipcMain.handle('aibox:cloneAgent', (_e, id: string, newName: string) => {
    const agent = orchestrator.listAgents().find((a) => a.id === id);
    if (!agent) throw new Error('助手不存在');
    return orchestrator.createAgent({
      name: newName || `${agent.name} (副本)`, role: agent.role, systemPrompt: agent.systemPrompt,
      soulMd: agent.soulMd, agentsMd: agent.agentsMd, userMd: agent.userMd,
      engineId: agent.engineId, workspace: agent.workspace, permissionMode: agent.permissionMode,
      concurrencyLimit: agent.concurrencyLimit, channelIds: []
    });
  });
  ipcMain.handle('aibox:exportAgent', (_e, id: string) => {
    const agent = orchestrator.listAgents().find((a) => a.id === id);
    if (!agent) throw new Error('助手不存在');
    const { id: _id, lifecycle: _l, archived: _a, createdAt: _c, updatedAt: _u, avatarColor: _av, ...exportable } = agent;
    return JSON.stringify(exportable, null, 2);
  });
  ipcMain.handle('aibox:importAgent', (_e, json: string) => {
    try {
      const data = JSON.parse(json) as { name?: string; role?: string; systemPrompt?: string; soulMd?: string; agentsMd?: string; userMd?: string; engineId?: string; workspace?: string; permissionMode?: string; concurrencyLimit?: number };
      if (!data.name) return { ok: false, message: '文件缺少 name 字段' };
      const agent = orchestrator.createAgent({
        name: data.name, role: data.role ?? '', systemPrompt: data.systemPrompt ?? '',
        soulMd: data.soulMd ?? '', agentsMd: data.agentsMd ?? '', userMd: data.userMd ?? '',
        engineId: data.engineId ?? NEXUS_ENGINE_ID, workspace: data.workspace ?? '',
        permissionMode: (data.permissionMode as 'readonly' | 'standard' | 'trusted' | 'autonomous') ?? 'standard',
        concurrencyLimit: data.concurrencyLimit ?? 1, channelIds: []
      });
      pushSnapshot();
      return { ok: true, message: `已导入员工「${agent.name}」`, agent };
    } catch (e) {
      return { ok: false, message: `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}` };
    }
  });
  ipcMain.handle('aibox:batchAgentAction', (_e, ids: string[], action: 'start' | 'stop' | 'delete') => {
    let count = 0;
    for (const id of ids) {
      try {
        if (action === 'start') { orchestrator.startAgent(id); count++; }
        else if (action === 'stop') { orchestrator.stopAgent(id); count++; }
        else if (action === 'delete') { orchestrator.archiveAgent(id); count++; }
      } catch { /* 跳过失败的 */ }
    }
    pushSnapshot();
    return { ok: true, message: `已对 ${count} 位员工执行「${action === 'start' ? '启用' : action === 'stop' ? '停用' : '删除'}」操作` };
  });
  ipcMain.handle('aibox:getAgentDetail', (_e, agentId: string) => {
    const tasks = orchestrator.listTasks({ includeResult: false }).filter((t) => t.agentId === agentId).slice(0, 10);
    const usage = db.raw.prepare('SELECT COALESCE(SUM(total_tokens),0) as total, COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(output_tokens),0) as output, COUNT(*) as calls FROM usage_records WHERE agent_id = ?').get(agentId) as { total: number; input: number; output: number; calls: number };
    const events = (db.raw.prepare("SELECT id, event_type, created_at FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE agent_id = ? ORDER BY created_at DESC LIMIT 5) ORDER BY created_at DESC LIMIT 30").all(agentId) as { id: string; event_type: string; created_at: number }[]).map((e) => ({ id: e.id, eventType: e.event_type, createdAt: e.created_at }));
    return { tasks, usage: { totalTokens: usage.total, inputTokens: usage.input, outputTokens: usage.output, calls: usage.calls }, events };
  });

  // ---------- 可视化工作流引擎 ----------
  workflows.onBroadcast(broadcast);
  ipcMain.handle('aibox:listWorkflows', () => workflows.list());
  ipcMain.handle('aibox:createWorkflow', (_e, input: { name: string; description?: string; nodes: WfNode[]; edges: WfEdge[] }) => workflows.create(input));
  ipcMain.handle('aibox:updateWorkflow', (_e, id: string, patch: { name?: string; description?: string; nodes?: WfNode[]; edges?: WfEdge[] }) => workflows.update(id, patch));
  ipcMain.handle('aibox:removeWorkflow', (_e, id: string) => workflows.remove(id));
  ipcMain.handle('aibox:triggerWorkflow', (_e, id: string, inputs?: Record<string, string>) => {
    const r = workflows.trigger(id, inputs);
    pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:getWorkflowRunState', (_e, id: string) => workflows.getRunState(id));
  ipcMain.handle('aibox:listWorkflowRuns', (_e, id: string) => workflows.listRuns(id));
  ipcMain.handle('aibox:publishWorkflowAsSkill', (_e, id: string) => {
    const r = workflows.publishAsSkill(id);
    pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:unpublishWorkflowSkill', (_e, id: string) => {
    const r = workflows.unpublishSkill(id);
    pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:exportWorkflow', (_e, id: string) => workflows.exportWorkflow(id));
  ipcMain.handle('aibox:importWorkflow', (_e, json: string) => {
    const r = workflows.importWorkflow(json);
    if (r.ok) pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:validateWorkflow', (_e, wf: { nodes: unknown[]; edges: unknown[] }) => workflows.validate(wf as { nodes: never[]; edges: never[] }));
  ipcMain.handle('aibox:saveWfVariables', (_e, wfId: string, variables: unknown[]) => workflows.saveVariables(wfId, variables as never[]));
  // ---------- 外部工作流平台（Coze / Dify） ----------
  ipcMain.handle('aibox:listWfPlatforms', () => wfPlatforms.list());
  ipcMain.handle('aibox:saveWfPlatform', (_e, input: { id?: string; name: string; baseUrl: string; token?: string }) => wfPlatforms.save(input));
  ipcMain.handle('aibox:removeWfPlatform', (_e, id: string) => wfPlatforms.remove(id));
  ipcMain.handle('aibox:testWfPlatform', (_e, id: string) => wfPlatforms.test(id));

  // ---------- 专家团 ----------
  ipcMain.handle('aibox:listTeams', () => teams.list());
  ipcMain.handle('aibox:createTeam', (_e, input: { name: string; coordinatorId: string; memberIds: string[]; mode?: 'coordinate' | 'roundtable'; workspace?: string }) => teams.create(input));
  ipcMain.handle('aibox:updateTeam', (_e, id: string, patch: { name?: string; coordinatorId?: string; memberIds?: string[]; mode?: 'coordinate' | 'roundtable'; workspace?: string }) => teams.update(id, patch));
  ipcMain.handle('aibox:removeTeam', (_e, id: string) => teams.remove(id));
  ipcMain.handle('aibox:triggerTeam', (_e, id: string, task: string, projectId?: string) => {
    const r = teams.trigger(id, task, projectId ? assertId(projectId, 'projectId') : undefined);
    pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:getTeamRuns', (_e, teamId: string) => {
    deliverables.list();
    return teams.listRuns(assertId(teamId, 'teamId'));
  });
  ipcMain.handle('aibox:getTeamCollaborationOverview', (_e, teamId: string) => {
    deliverables.list();
    return teams.getCollaborationOverview(assertId(teamId, 'teamId'));
  });
  ipcMain.handle('aibox:listAttentionRuns', () => teams.listAttentionRuns());
  ipcMain.handle('aibox:getTeamConfig', (_e, teamId: string) => teams.getConfig(teamId));
  ipcMain.handle('aibox:saveTeamConfig', (_e, teamId: string, config: { timeout: number; maxRetries: number; concurrency: number }) => {
    teams.saveConfig(teamId, config);
    return { ok: true };
  });
  ipcMain.handle('aibox:getTeamStats', (_e, teamId: string) => teams.getStats(teamId));
  ipcMain.handle('aibox:getSubtaskOutput', (_e, taskId: string) => teams.getSubtaskOutput(taskId));
  ipcMain.handle('aibox:retryTeamSubtask', (_e, runId: string, subtaskIndex: number) => teams.retrySubtask(assertId(runId, 'runId'), subtaskIndex));
  ipcMain.handle('aibox:cancelTeamRun', (_e, runId: string) => teams.cancelRun(assertId(runId, 'runId')));
  ipcMain.handle('aibox:skipTeamSubtask', (_e, runId: string, subtaskIndex: number) => teams.skipSubtask(assertId(runId, 'runId'), subtaskIndex));
  ipcMain.handle('aibox:forceRetryTeamSubtask', (_e, runId: string, subtaskIndex: number) => teams.forceRetrySubtask(assertId(runId, 'runId'), subtaskIndex));
  ipcMain.handle('aibox:injectTeamGuidance', (_e, runId: string, message: string) => teams.injectGuidance(assertId(runId, 'runId'), assertString(message, 'message', 1, 500)));
  ipcMain.handle('aibox:saveTeamAsTemplate', (_e, teamId: string, name?: string) => teams.saveAsTemplate(teamId, name));
  ipcMain.handle('aibox:listTeamTemplates', () => teams.listTemplates());
  ipcMain.handle('aibox:removeTeamTemplate', (_e, id: string) => teams.removeTemplate(id));

  // ---------- 任务 ----------
  ipcMain.handle('aibox:createTask', async (
    _e,
    agentId: string,
    title: string,
    projectId: string | undefined,
    messageKey: string
  ) => {
    const result = await desktopControlPlane.dispatch({
      preferredAgentId: assertId(agentId, 'agentId'),
      message: assertString(title, 'title', 1, 500),
      projectId: projectId ? assertId(projectId, 'projectId') : undefined,
      messageKey: assertId(messageKey, 'messageKey')
    });
    pushSnapshot();
    return result.task;
  });
  ipcMain.handle('aibox:cancelTask', (_e, id: string) => orchestrator.cancelTask(assertId(id)));
  ipcMain.handle('aibox:retryTask', (_e, id: string) => {
    const taskId = assertId(id, 'taskId');
    const action = discovery.actions().items.find((item) => item.key === `failed_task:${taskId}`);
    const retried = orchestrator.retryTask(taskId);
    if (action) discovery.dismiss(action.key, action.fingerprint);
    return retried;
  });
  ipcMain.handle('aibox:deleteTask', (_e, id: string) => orchestrator.deleteTask(assertId(id, 'taskId')));
  ipcMain.handle('aibox:pauseTask', (_e, id: string) => orchestrator.pauseTask(assertId(id)));
  ipcMain.handle('aibox:resumeTask', (_e, id: string) => orchestrator.resumeTask(assertId(id)));
  ipcMain.handle('aibox:decideApproval', (_e, id: string, approve: boolean) => orchestrator.decideApproval(assertId(id), approve === true));
  // 追问/续跑（P2b）：新任务继承会话锚点
  ipcMain.handle('aibox:createFollowUpTask', (_e, parentTaskId: string, title: string) => orchestrator.createFollowUpTask(assertId(parentTaskId, 'parentTaskId'), assertString(title, 'title', 1, 500)));
  // 任务详情：事件时间线 + 产物全文（13.2 审计可追溯）
  ipcMain.handle('aibox:getTaskEvents', (_e, taskId: string) => orchestrator.taskEvents(taskId));
  ipcMain.handle('aibox:getTaskResult', (_e, taskId: string) => orchestrator.taskResult(taskId));
  // 任务产出质量标记（成果管理：采纳/驳回/返工）
  ipcMain.handle('aibox:setTaskQuality', (_e, taskId: string, quality: 'accepted' | 'rejected' | 'rework' | null) => orchestrator.setTaskQuality(assertId(taskId, 'taskId'), quality));

  // ---------- 引擎 ----------
  // 真实自动安装（npm -g，下载地址取配置文件）；完成后重新检测并推送快照
  ipcMain.handle('aibox:installEngine', async (_e, id: string) => {
    pushSnapshot(); // 立即反映 INSTALLING 状态
    const r = await engines.install(id);
    pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:detectEngines', async () => {
    const list = await engines.detect();
    pushSnapshot();
    return list;
  });
  ipcMain.handle('aibox:getInstallGuide', (_e, id: string) => engines.installGuide(id));
  ipcMain.handle('aibox:updateEngine', async (_e, id: string) => {
    const r = await engines.update(id);
    pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:uninstallEngine', async (_e, id: string) => {
    const r = await engines.uninstall(id);
    pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:getEngineLatestVersion', (_e, id: string) => engines.latestVersion(id));
  ipcMain.handle('aibox:restartEngine', async (_e, id: string) => {
    const r = await engines.restart(assertId(id));
    pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:checkRuntime', () => engines.checkRuntime());
  ipcMain.handle('aibox:installRuntime', async (_e, name: string) => {
    const r = await engines.installRuntime(name);
    pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:openExternal', (_e, url: string) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url); // 外链一律系统浏览器，仅放行 https
  });
  // 打开产物目录 / 工作目录（系统资源管理器）
  ipcMain.handle('aibox:openTaskWorkspace', async (_e, taskId: string) => {
    const ws = orchestrator.resolveTaskWorkspace(assertId(taskId, 'taskId'));
    if (!ws) return { ok: false, message: '无法定位产物目录' };
    const err = await shell.openPath(ws);
    return err ? { ok: false, message: err } : { ok: true, message: '' };
  });
  ipcMain.handle('aibox:openAgentWorkspace', async (_e, agentId: string) => {
    const ws = orchestrator.resolveAgentWorkspace(assertId(agentId, 'agentId'));
    if (!ws) return { ok: false, message: '无法定位工作目录' };
    const err = await shell.openPath(ws);
    return err ? { ok: false, message: err } : { ok: true, message: '' };
  });
  ipcMain.handle('aibox:authEngine', async (_e, id: string) => {
    const r = await engines.probeAuth(assertId(id));
    pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:setDefaultEngine', (_e, id: string) => {
    engines.setDefault(id);
    pushSnapshot();
  });
  ipcMain.handle('aibox:getEngineConfig', (_e, id: string) => engines.getConfig(id));
  ipcMain.handle('aibox:saveEngineConfig', (_e, id: string, config: EngineRuntimeConfig) => {
    engines.saveConfig(id, config);
    pushSnapshot();
    return { ok: true };
  });
  ipcMain.handle('aibox:getEngineLogs', (_e, id: string) => engines.getLogs(id));
  ipcMain.handle('aibox:getEngineMetrics', (_e, id: string) => engines.getMetrics(id));
  ipcMain.handle('aibox:registerCustomEngine', (_e, input: { name: string; command: string; args?: string; dataBoundary?: string }) => {
    const r = engines.registerCustom(input);
    if (r.ok) pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:getEngineRouting', () => {
    return db.getSetting<Record<string, string>>('engine_routing', {});
  });
  ipcMain.handle('aibox:saveEngineRouting', (_e, rules: Record<string, string>) => {
    db.setSetting('engine_routing', rules);
    return { ok: true };
  });

  // ---------- 应用默认模型供应商（密钥仅存 safeStorage，Renderer 只见脱敏视图） ----------
  ipcMain.handle('aibox:getProviderConfig', () => getProviderConfig(db));
  ipcMain.handle('aibox:saveProviderConfig', async (_e, input: { baseUrl: string; model: string; apiKey?: string }) => {
    saveProviderConfig(db, input);
    db.audit({ id: randomUUID(), actor: 'admin', action: 'provider.save', target: input.baseUrl, result: 'ok' });
    await engines.detect(); // 配置齐备后重新计算所有受管引擎状态
    pushSnapshot();
    return getProviderConfig(db);
  });
  ipcMain.handle('aibox:testProvider', (_e, override?: { baseUrl?: string; apiKey?: string }) => testProvider(db, override));

  // ---------- 应用配置文件（下载源等；不含密钥） ----------
  ipcMain.handle('aibox:getAppConfig', () => loadConfig());
  ipcMain.handle('aibox:setAppConfig', (_e, patch: Partial<AppConfig>) => {
    const next = saveConfig(patch);
    db.audit({ id: randomUUID(), actor: 'admin', action: 'config.save', target: 'aibox.config.json', result: 'ok' });
    return next;
  });

  // ---------- 定时任务（P3a） ----------
  ipcMain.handle('aibox:createSchedule', (_e, input: ScheduleInput) => {
    const s = scheduler.create(input);
    pushSnapshot();
    return s;
  });
  ipcMain.handle('aibox:toggleSchedule', (_e, id: string, enabled: boolean) => {
    scheduler.toggle(id, enabled);
    pushSnapshot();
  });
  ipcMain.handle('aibox:deleteSchedule', (_e, id: string) => {
    scheduler.remove(id);
    pushSnapshot();
  });
  ipcMain.handle('aibox:updateSchedule', (_e, id: string, patch: Partial<ScheduleInput>) => {
    scheduler.update(assertId(id, 'scheduleId'), patch);
    pushSnapshot();
  });
  ipcMain.handle('aibox:getScheduleHistory', (_e, scheduleId: string) => scheduler.getHistory(scheduleId));

  // ---------- 渠道 ----------
  // 飞书真实接入（P3c）：保存凭据（secret 走 safeStorage）并建立长连接
  ipcMain.handle('aibox:configureFeishu', async (_e, appId: string, appSecret: string) => {
    feishu.saveCredentials(appId, appSecret);
    const r = await feishu.connect();
    pushSnapshot();
    return r;
  });
  // 企业微信智能机器人真实接入：官方长连接 API 模式（BotID/Secret，Secret 走 safeStorage）
  ipcMain.handle('aibox:configureWecom', async (_e, botId: string, secret: string) => {
    wecom.saveCredentials(botId, secret);
    const r = await wecom.connect();
    pushSnapshot();
    return r;
  });
  // 微信 iLink Bot：二维码、配对码和状态可见；Bot Token 永不返回 Renderer
  ipcMain.handle('aibox:startWeixinLogin', async (_e, agentId?: string) => {
    const selectedAgentId = agentId ? assertId(agentId, 'agentId') : null;
    const r = await weixin.startLogin(() => {
      db.raw.prepare('DELETE FROM channel_routes WHERE channel_id = ?').run('ch-weixin');
      if (selectedAgentId) channels.bindAgent('ch-weixin', selectedAgentId);
    });
    pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:getWeixinLoginState', () => weixin.getLoginState());
  ipcMain.handle('aibox:submitWeixinVerifyCode', (_e, code: string) =>
    weixin.submitVerifyCode(assertString(code, 'verifyCode', 1, 12)));
  ipcMain.handle('aibox:cancelWeixinLogin', () => weixin.cancelLogin());
  ipcMain.handle('aibox:setupChannel', (_e, id: string, accountName: string) => {
    channels.setup(assertId(id, 'channelId'), assertString(accountName, 'accountName', 1, 100));
    setTimeout(pushSnapshot, 1500);
  });
  ipcMain.handle('aibox:disconnectChannel', async (_e, id: string) => {
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
  ipcMain.handle('aibox:bindChannel', (_e, channelId: string, agentId: string) => {
    channels.bindAgent(assertId(channelId, 'channelId'), assertId(agentId, 'agentId'));
    pushSnapshot();
  });
  ipcMain.handle('aibox:unbindChannel', (_e, channelId: string, agentId: string) => {
    channels.unbindAgent(assertId(channelId, 'channelId'), assertId(agentId, 'agentId'));
    pushSnapshot();
  });

  // ---------- 设置 ----------
  ipcMain.handle('aibox:getSetting', (_e, key: unknown) => readRendererSetting(db, key));
  ipcMain.handle('aibox:setSetting', (_e, key: unknown, value: unknown) => writeRendererSetting(db, key, value));
  // 演示数据（H-3）：查询库中残留量 / 一键清空（只删 is_demo=1 行，真实数据不受影响）
  ipcMain.handle('aibox:getDemoDataStats', () => demoDataStats(db));
  ipcMain.handle('aibox:purgeDemoData', () => {
    const removed = purgeDemoData(db);
    pushSnapshot();
    return removed;
  });
  // Web token remains in Main; Renderer can inspect state and request a clipboard copy.
  ipcMain.handle('aibox:getWebAdminStatus', () => webServer.getStatus());
  ipcMain.handle('aibox:regenerateWebToken', async () => {
    webServer.regenerateToken();
    await webServer.start();
    return webServer.getStatus();
  });
  ipcMain.handle('aibox:copyWebToken', () => {
    clipboard.writeText(webServer.token);
    db.audit({ id: randomUUID(), actor: 'admin', action: 'webserver.token.copy', target: WEB_TOKEN_SECRET_REF, result: 'clipboard' });
    return { ok: true as const };
  });

  // ---------- OCR 文字识别服务 ----------
  ipcMain.handle('aibox:getOcrStatus', () => ocr.getStatus());
  ipcMain.handle('aibox:toggleOcr', (_e, enabled: boolean) => { ocr.setEnabled(enabled); return ocr.getStatus(); });
  ipcMain.handle('aibox:downloadOcrModels', () => ocr.downloadModels());
  ipcMain.handle('aibox:ocrRecognize', (_e, imagePath: string) => ocr.recognize(imagePath));

  // ---------- 语音任务下达（全双工实时识别） ----------
  // 音频经主进程转发而非 Renderer 直连云端：云端凭据必须留在主进程（安全基线 15.1）
  ipcMain.handle('aibox:getVoiceConfig', () => voice.getConfig());
  ipcMain.handle('aibox:saveVoiceConfig', (_e, input: import('../shared/types.js').VoiceConfigInput) => {
    const r = voice.saveConfig(input ?? {});
    pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:testVoice', () => voice.test());
  ipcMain.handle('aibox:startVoiceSession', () => voice.start());
  ipcMain.handle('aibox:pushVoiceAudio', (_e, sessionId: string, chunk: ArrayBuffer) => {
    voice.pushAudio(assertId(sessionId, 'sessionId'), Buffer.from(assertVoiceAudioChunk(chunk)));
  });
  ipcMain.handle('aibox:stopVoiceSession', (_e, sessionId: string) => {
    voice.stop(assertId(sessionId, 'sessionId'));
  });
  /** 解析语音文本为任务草稿（不派发；供确认界面展示） */
  ipcMain.handle('aibox:parseVoiceCommand', (_e, text: string) => {
    const agents = orchestrator.listAgents()
      .filter((a) => a.lifecycle === 'READY')
      .map((a) => ({ id: a.id, name: a.name }));
    const defaultAgentId = db.getSetting<string | null>('voice:defaultAgentId', null);
    return parseVoiceCommand(assertString(text, 'text', 0, 2000), agents, defaultAgentId);
  });
  /** 确认后派发：source='voice' 便于审计与统计区分手动派发 */
  ipcMain.handle('aibox:dispatchVoiceTask', async (_e, agentId: string, title: string, messageKey: string) => {
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
  ipcMain.handle('aibox:integrityCheck', () => db.integrityCheck());
  ipcMain.handle('aibox:manualCleanup', () => { db.cleanupRetention(); return { ok: true, message: '数据清理完成' }; });
  // 窗口控制：全屏切换
  ipcMain.handle('aibox:toggleFullscreen', () => {
    const win = getMainWindow();
    if (win) win.setFullScreen(!win.isFullScreen());
    return win?.isFullScreen() ?? false;
  });
  ipcMain.handle('aibox:isFullscreen', () => getMainWindow()?.isFullScreen() ?? false);

  // ---------- 工作目录选择（7.2：必须由用户选择并进入允许列表） ----------
  ipcMain.handle('aibox:pickDirectory', async () => {
    const win = getMainWindow();
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  // ---------- 数据备份导出（本地优先：用户可备份 SQLite 数据库） ----------
  ipcMain.handle('aibox:exportData', async () => {
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

  ipcMain.handle('aibox:restoreData', async () => {
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
  ipcMain.handle('aibox:restartApp', () => {
    db.flush();
    app.relaunch();
    // app.quit() 会经过 before-quit，等待微信长轮询 worker 停止并再次落盘。
    app.quit();
  });

  // ---------- 前端异常上报（ErrorBoundary 捕获的渲染异常写入审计日志） ----------
  ipcMain.handle('aibox:reportError', (_e, payload: { message: string; stack?: string; componentStack?: string }) => {
    db.audit({
      id: randomUUID(), actor: 'renderer', action: 'ui.error',
      target: (payload?.message ?? 'unknown').slice(0, 200),
      result: 'error',
      source: (payload?.stack ?? '').slice(0, 300) || 'renderer'
    });
  });

  // ---------- 多机协同 ----------
  ipcMain.handle('aibox:collab:checkGit', async () => {
    const runtimes = await engines.checkRuntime();
    return runtimes.find((r) => r.name === 'Git') ?? { name: 'Git', installed: false, version: null, path: null };
  });
  ipcMain.handle('aibox:collab:installGit', () => engines.installRuntime('Git'));
  ipcMain.handle('aibox:collab:listWorkspaces', () => collab.listWorkspaces());
  ipcMain.handle('aibox:collab:createWorkspace', (_e, input: { name: string; repoPath: string; conventions?: string; gitRules?: string; mcpPort?: number; gitPort?: number }) => {
    assertString(input?.name, 'name', 1, 50);
    assertString(input?.repoPath, 'repoPath', 1, 500);
    return collab.createWorkspace(input);
  });
  ipcMain.handle('aibox:collab:removeWorkspace', (_e, id: string) => collab.removeWorkspace(assertId(id)));
  ipcMain.handle('aibox:collab:startWorkspace', (_e, id: string) => collab.startWorkspace(assertId(id)));
  ipcMain.handle('aibox:collab:stopWorkspace', (_e, id: string) => { collab.stopWorkspace(assertId(id)); });
  ipcMain.handle('aibox:collab:listTasks', (_e, workspaceId: string) => collab.listTasks(assertId(workspaceId, 'workspaceId')));
  ipcMain.handle('aibox:collab:createTask', (_e, workspaceId: string, input: { title: string; description?: string; branchName?: string }) => {
    assertString(input?.title, 'title', 1, 200);
    return collab.createTask(assertId(workspaceId, 'workspaceId'), input);
  });
  ipcMain.handle('aibox:collab:reviewTask', (_e, taskId: string, result: 'accept' | 'reject', comment: string) => {
    return collab.reviewTask(assertId(taskId, 'taskId'), result, comment ?? '');
  });
  ipcMain.handle('aibox:collab:listAgents', (_e, workspaceId: string) => collab.listAgents(assertId(workspaceId, 'workspaceId')));
  ipcMain.handle('aibox:collab:getConnectInfo', (_e, workspaceId: string) => collab.getConnectInfo(assertId(workspaceId, 'workspaceId')));
  ipcMain.handle('aibox:collab:updateRules', (_e, id: string, patch: { conventions?: string; gitRules?: string }) => {
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
    tasks: deps.orchestrator.listTasks({ includeResult: false }),
    todos: [...systemTodos, ...todos].slice(0, 12),
    approvals: deps.orchestrator.listApprovals(),
    engines: deps.engines.list(),
    channels: deps.channels.list(),
    schedules: deps.scheduler.list(),
    // 至少一个已验证可用的执行器才能支持系统正常运行
    executorAvailable
  };
}
