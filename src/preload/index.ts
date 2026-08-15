/**
 * Preload：Renderer 唯一入口（contextIsolation 开启）
 * 只暴露白名单方法，不暴露 ipcRenderer 本体。
 */
import { contextBridge, ipcRenderer } from 'electron';
import { randomUUID } from 'node:crypto';
import type {
  Agent, AgentCardView, AgentPersonaPatch, AppConfig, AppMemorySnapshot, Approval, Channel, Conversation, CreateAgentInput, DashboardStats,
  Engine, EngineInstallGuide, EngineInstallResult, ProviderConfig, ProviderTestResult,
  ApiBridgeStatus, RendererSettingKey, RendererSettingMap, WebAdminStatus,
  DeliverableDetail, DeliverableMetaPatch, DeliverableReviewEvent, DeliverableReviewInput, DeliverableSummary, DeliverableVersionInput,
  KnowledgeDetail, KnowledgeInput, KnowledgePatch, KnowledgeQuery, KnowledgeSummary, KnowledgeVersionInput,
  ActionCenterOverview, GlobalSearchResult,
  AssigneeRecommendation, AutomationOverview, AutomationReport, AutomationReportKind,
  CustomerDelivery, CustomerDeliveryInput, CustomerDeliveryStatus, ProjectBudget, ProjectBudgetInput,
  AcceptedMemoryProposal, MemoryForgetInput, MemoryItem, MemoryListInput, MemoryProposalDecisionInput,
  MemoryProposalListInput, MemoryProposalRecord, MemoryRecallInput, MemoryRememberInput, MemoryUpdateInput,
  AcceptedTaskScheduleProposal, TaskScheduleProposalDecisionInput, TaskScheduleProposalListInput,
  TaskScheduleProposalRecord,
  RecalledMemory,
  Project, ProjectDeliverablePackage, ProjectInput, ProjectOperationsOverview, ProjectPatch, ResourceSample, Schedule, ScheduleInput, ServiceHealth, SystemInfo, Task, TaskEvent, TodoItem,
  WfNode, WfEdge, WorkflowDef, WfPlatformConfig, WfNodeEvent,
  CollabWorkspace, CollabTask, CollabAgent, CollabConnectInfo,
  TeamCollaborationOverview, TeamRun,
  VoiceConfig, VoiceConfigInput, VoiceCommandDraft, VoiceTestResult,
  MobileAdbDevice, MobileAgentConfig, MobileApkInfo, MobileArtifact, MobileCommandLog, MobileDevice, MobileEvent,
  MobileGatewayStatus, MobilePairingOffer, MobileScriptDefinition, MobileToolCatalog, MobileToolName, Utf8TextPayload,
  WeixinLoginState
} from '../shared/types.js';

export interface Snapshot {
  /** 单调递增版本号，供渲染层判断快照新旧 / 跳过冗余渲染 */
  version: number;
  stats: DashboardStats;
  agentCards: AgentCardView[];
  projects: Project[];
  tasks: Task[];
  todos: TodoItem[];
  approvals: Approval[];
  engines: Engine[];
  channels: Channel[];
  schedules: Schedule[];
  /** 至少一个可用执行器（CLI 健康或 Hermes 已配置）才能支持系统正常运行 */
  executorAvailable: boolean;
}

export interface ResourcePayload {
  history: ResourceSample[];
  health: ServiceHealth;
}

export interface ResourceUpdatePayload {
  sample: ResourceSample;
  health: ServiceHealth;
}

/** Explicit UTF-8 transport for text entered in Renderer forms. */
function encodeText(value: string): Utf8TextPayload {
  const bytes = new TextEncoder().encode(value.normalize('NFC'));
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return { encoding: 'utf8-base64', data: btoa(binary) };
}

function encodeOptionalText(value: string | undefined): Utf8TextPayload | undefined {
  return value === undefined ? undefined : encodeText(value);
}

function encodeAgentInput(input: CreateAgentInput): CreateAgentInput & Record<string, unknown> {
  return {
    ...input,
    name: encodeText(input.name),
    role: encodeText(input.role),
    systemPrompt: encodeText(input.systemPrompt),
    soulMd: encodeText(input.soulMd ?? ''),
    agentsMd: encodeText(input.agentsMd ?? ''),
    userMd: encodeText(input.userMd ?? ''),
    workspace: encodeText(input.workspace)
  } as unknown as CreateAgentInput & Record<string, unknown>;
}

function encodePersonaPatch(patch: AgentPersonaPatch): AgentPersonaPatch & Record<string, unknown> {
  return {
    ...patch,
    name: encodeOptionalText(patch.name),
    role: encodeOptionalText(patch.role),
    systemPrompt: encodeOptionalText(patch.systemPrompt),
    soulMd: encodeOptionalText(patch.soulMd),
    agentsMd: encodeOptionalText(patch.agentsMd),
    userMd: encodeOptionalText(patch.userMd),
    modelOverride: encodeOptionalText(patch.modelOverride)
  } as unknown as AgentPersonaPatch & Record<string, unknown>;
}

function encodeMemoryRecall(input: MemoryRecallInput): MemoryRecallInput & Record<string, unknown> {
  return { ...input, query: encodeOptionalText(input.query) } as unknown as MemoryRecallInput & Record<string, unknown>;
}

function encodeMemoryRemember(input: MemoryRememberInput): MemoryRememberInput & Record<string, unknown> {
  return {
    ...input,
    kind: encodeText(input.kind),
    content: encodeText(input.content)
  } as unknown as MemoryRememberInput & Record<string, unknown>;
}

function encodeMemoryUpdate(input: MemoryUpdateInput): MemoryUpdateInput & Record<string, unknown> {
  return {
    ...input,
    content: encodeOptionalText(input.content),
    reason: encodeOptionalText(input.reason)
  } as unknown as MemoryUpdateInput & Record<string, unknown>;
}

function encodeMemoryReason<T extends MemoryForgetInput | MemoryProposalDecisionInput | TaskScheduleProposalDecisionInput>(input: T): T & Record<string, unknown> {
  return { ...input, reason: encodeOptionalText(input.reason) } as unknown as T & Record<string, unknown>;
}

const api = {
  // 查询
  getSnapshot: (): Promise<Snapshot> => ipcRenderer.invoke('aibox:getSnapshot'),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('aibox:getAppVersion'),
  getResourceHistory: (): Promise<ResourcePayload> => ipcRenderer.invoke('aibox:getResourceHistory'),
  getSystemInfo: (): Promise<SystemInfo> => ipcRenderer.invoke('aibox:getSystemInfo'),
  getAppMemory: (): Promise<AppMemorySnapshot> => ipcRenderer.invoke('aibox:getAppMemory'),
  globalSearch: (query: string): Promise<GlobalSearchResult[]> => ipcRenderer.invoke('aibox:globalSearch', query),
  getActionCenter: (): Promise<ActionCenterOverview> => ipcRenderer.invoke('aibox:getActionCenter'),
  dismissAction: (actionKey: string, fingerprint: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('aibox:dismissAction', actionKey, fingerprint),

  // 项目
  createProject: (input: ProjectInput): Promise<Project> => ipcRenderer.invoke('aibox:createProject', input),
  updateProject: (id: string, patch: ProjectPatch): Promise<Project | null> => ipcRenderer.invoke('aibox:updateProject', id, patch),
  archiveProject: (id: string): Promise<Project | null> => ipcRenderer.invoke('aibox:archiveProject', id),
  getProjectOperations: (): Promise<ProjectOperationsOverview> => ipcRenderer.invoke('aibox:getProjectOperations'),

  getAutomationOverview: (projectId?: string): Promise<AutomationOverview> => ipcRenderer.invoke('aibox:getAutomationOverview', projectId),
  runAutomationReport: (kind: AutomationReportKind, projectId: string): Promise<AutomationReport> => ipcRenderer.invoke('aibox:runAutomationReport', kind, projectId),
  setProjectBudget: (projectId: string, input: ProjectBudgetInput): Promise<ProjectBudget> => ipcRenderer.invoke('aibox:setProjectBudget', projectId, input),
  recommendAssignees: (projectId: string, brief: string): Promise<AssigneeRecommendation[]> => ipcRenderer.invoke('aibox:recommendAssignees', projectId, brief),
  createCustomerDelivery: (input: CustomerDeliveryInput): Promise<CustomerDelivery> => ipcRenderer.invoke('aibox:createCustomerDelivery', input),
  updateCustomerDeliveryStatus: (id: string, status: CustomerDeliveryStatus): Promise<CustomerDelivery> => ipcRenderer.invoke('aibox:updateCustomerDeliveryStatus', id, status),

  // 成果验收
  listDeliverables: (): Promise<DeliverableSummary[]> => ipcRenderer.invoke('aibox:listDeliverables'),
  getDeliverable: (id: string): Promise<DeliverableDetail | null> => ipcRenderer.invoke('aibox:getDeliverable', id),
  updateDeliverableMeta: (id: string, patch: DeliverableMetaPatch): Promise<DeliverableDetail | null> => ipcRenderer.invoke('aibox:updateDeliverableMeta', id, patch),
  addDeliverableVersion: (id: string, input: DeliverableVersionInput): Promise<DeliverableDetail | null> => ipcRenderer.invoke('aibox:addDeliverableVersion', id, input),
  reviewDeliverable: (id: string, input: DeliverableReviewInput): Promise<{ deliverable: DeliverableDetail; review: DeliverableReviewEvent; reworkRef: string | null; reworkMessage: string | null }> => ipcRenderer.invoke('aibox:reviewDeliverable', id, input),
  getProjectDeliverablePackage: (projectId: string): Promise<ProjectDeliverablePackage> => ipcRenderer.invoke('aibox:getProjectDeliverablePackage', projectId),
  exportDeliverable: (id: string, format: 'markdown' | 'json'): Promise<{ ok: boolean; canceled: boolean; message: string; path?: string }> => ipcRenderer.invoke('aibox:exportDeliverable', id, format),
  exportProjectDeliverablePackage: (projectId: string): Promise<{ ok: boolean; canceled: boolean; message: string; path?: string }> => ipcRenderer.invoke('aibox:exportProjectDeliverablePackage', projectId),

  // 项目知识库
  listKnowledge: (query?: KnowledgeQuery): Promise<KnowledgeSummary[]> => ipcRenderer.invoke('aibox:listKnowledge', query),
  getKnowledge: (id: string): Promise<KnowledgeDetail | null> => ipcRenderer.invoke('aibox:getKnowledge', id),
  createKnowledge: (input: KnowledgeInput): Promise<KnowledgeDetail> => ipcRenderer.invoke('aibox:createKnowledge', input),
  updateKnowledge: (id: string, patch: KnowledgePatch): Promise<KnowledgeDetail | null> => ipcRenderer.invoke('aibox:updateKnowledge', id, patch),
  addKnowledgeVersion: (id: string, input: KnowledgeVersionInput): Promise<KnowledgeDetail | null> => ipcRenderer.invoke('aibox:addKnowledgeVersion', id, input),

  // 数字员工
  createAgent: (input: CreateAgentInput): Promise<Agent> => ipcRenderer.invoke('aibox:createAgent', encodeAgentInput(input)),
  startAgent: (id: string): Promise<void> => ipcRenderer.invoke('aibox:startAgent', id),
  stopAgent: (id: string): Promise<void> => ipcRenderer.invoke('aibox:stopAgent', id),
  /** 助手人设编辑（soul.md / agents.md / user.md / 权限模式） */
  updateAgentPersona: (id: string, patch: AgentPersonaPatch): Promise<Agent> => ipcRenderer.invoke('aibox:updateAgentPersona', id, encodePersonaPatch(patch)),
  // Android 手机员工
  getMobileStatus: (): Promise<MobileGatewayStatus> => ipcRenderer.invoke('aibox:mobile:getStatus'),
  listMobileLanAddresses: (): Promise<string[]> => ipcRenderer.invoke('aibox:mobile:listLanAddresses'),
  startMobileGateway: (host: string, port?: number): Promise<MobileGatewayStatus> => ipcRenderer.invoke('aibox:mobile:startGateway', host, port),
  stopMobileGateway: (): Promise<void> => ipcRenderer.invoke('aibox:mobile:stopGateway'),
  resetMobileCertificate: (): Promise<void> => ipcRenderer.invoke('aibox:mobile:resetCertificate'),
  createMobilePairing: (): Promise<MobilePairingOffer> => ipcRenderer.invoke('aibox:mobile:createPairing'),
  copyMobilePairingConfig: (pairingId: string): Promise<{ ok: true }> => ipcRenderer.invoke('aibox:mobile:copyPairingConfig', pairingId),
  getMobileToolCatalog: (): Promise<MobileToolCatalog> => ipcRenderer.invoke('aibox:mobile:getToolCatalog'),
  listMobileDevices: (): Promise<MobileDevice[]> => ipcRenderer.invoke('aibox:mobile:listDevices'),
  getMobileAgentConfig: (agentId: string): Promise<MobileAgentConfig | null> => ipcRenderer.invoke('aibox:mobile:getAgentConfig', agentId),
  bindMobileAgent: (input: { agentId: string; deviceId: string; allowedTools: MobileToolName[]; confirmAuthorization: boolean }): Promise<MobileAgentConfig> => ipcRenderer.invoke('aibox:mobile:bindAgent', input),
  unbindMobileAgent: (agentId: string): Promise<void> => ipcRenderer.invoke('aibox:mobile:unbindAgent', agentId),
  updateMobileToolPolicy: (input: { agentId: string; allowedTools: MobileToolName[]; confirmAuthorization: boolean }): Promise<MobileAgentConfig> => ipcRenderer.invoke('aibox:mobile:updateToolPolicy', input),
  refreshMobilePreview: (deviceId: string): Promise<string> => ipcRenderer.invoke('aibox:mobile:refreshPreview', deviceId),
  readMobileUiTree: (deviceId: string): Promise<Record<string, unknown>> => ipcRenderer.invoke('aibox:mobile:readUiTree', deviceId),
  executeMobileTool: (input: { deviceId: string; toolName: MobileToolName; args: Record<string, unknown> }): Promise<Record<string, unknown>> => ipcRenderer.invoke('aibox:mobile:execute', input),
  listMobileCommands: (deviceId?: string): Promise<MobileCommandLog[]> => ipcRenderer.invoke('aibox:mobile:listCommands', deviceId),
  listMobileArtifacts: (deviceId?: string): Promise<MobileArtifact[]> => ipcRenderer.invoke('aibox:mobile:listArtifacts', deviceId),
  listMobileScripts: (): Promise<MobileScriptDefinition[]> => ipcRenderer.invoke('aibox:mobile:listScripts'),
  saveMobileScript: (input: Omit<MobileScriptDefinition, 'id' | 'createdAt' | 'updatedAt'>, id?: string): Promise<MobileScriptDefinition> => ipcRenderer.invoke('aibox:mobile:saveScript', input, id),
  deleteMobileScript: (id: string): Promise<void> => ipcRenderer.invoke('aibox:mobile:deleteScript', id),
  runMobileScript: (id: string): Promise<{ completed: number; results: Record<string, unknown>[] }> => ipcRenderer.invoke('aibox:mobile:runScript', id),
  emergencyStopMobile: (deviceId: string): Promise<void> => ipcRenderer.invoke('aibox:mobile:emergencyStop', deviceId),
  getMobileApkInfo: (): Promise<MobileApkInfo> => ipcRenderer.invoke('aibox:mobile:getApkInfo'),
  listMobileAdbDevices: (): Promise<MobileAdbDevice[]> => ipcRenderer.invoke('aibox:mobile:listAdbDevices'),
  installMobileApk: (serial: string): Promise<{ ok: true; message: string }> => ipcRenderer.invoke('aibox:mobile:installApk', serial),
  exportMobileApk: (): Promise<{ ok: boolean; canceled: boolean; message: string }> => ipcRenderer.invoke('aibox:mobile:exportApk'),
  /** AI 辅助生成人设（输入描述，返回生成的配置） */
  generatePersona: (description: string): Promise<{ name: string; role: string; soulMd: string; agentsMd: string; systemPrompt: string; permissionMode: string }> => ipcRenderer.invoke('aibox:generatePersona', description),
  /** 会话列表（按助手） */
  listConversations: (agentId: string): Promise<Conversation[]> => ipcRenderer.invoke('aibox:listConversations', agentId),
  /** 发送消息给助手（创建/继续会话） */
  chatWithAgent: (agentId: string, message: string, conversationId?: string): Promise<{ conversationId: string; task: Task }> =>
    ipcRenderer.invoke('aibox:chatWithAgent', agentId, encodeText(message), conversationId, randomUUID()),
  /** 会话重命名 */
  renameConversation: (id: string, title: string): Promise<void> => ipcRenderer.invoke('aibox:renameConversation', id, encodeText(title)),
  /** 删除会话 */
  deleteConversation: (id: string): Promise<void> => ipcRenderer.invoke('aibox:deleteConversation', id),
  // Canonical memory and its human-review queue.
  listMemories: (input?: MemoryListInput): Promise<MemoryItem[]> => ipcRenderer.invoke('aibox:listMemories', input),
  recallMemories: (input?: MemoryRecallInput): Promise<RecalledMemory[]> =>
    ipcRenderer.invoke('aibox:recallMemories', encodeMemoryRecall(input ?? {})),
  rememberMemory: (input: MemoryRememberInput): Promise<MemoryItem> =>
    ipcRenderer.invoke('aibox:rememberMemory', encodeMemoryRemember(input)),
  updateMemory: (input: MemoryUpdateInput): Promise<MemoryItem> =>
    ipcRenderer.invoke('aibox:updateMemory', encodeMemoryUpdate(input)),
  forgetMemory: (input: MemoryForgetInput): Promise<MemoryItem> =>
    ipcRenderer.invoke('aibox:forgetMemory', encodeMemoryReason(input)),
  listMemoryProposals: (input?: MemoryProposalListInput): Promise<MemoryProposalRecord[]> =>
    ipcRenderer.invoke('aibox:listMemoryProposals', input),
  acceptMemoryProposal: (input: MemoryProposalDecisionInput): Promise<AcceptedMemoryProposal> =>
    ipcRenderer.invoke('aibox:acceptMemoryProposal', encodeMemoryReason(input)),
  rejectMemoryProposal: (input: MemoryProposalDecisionInput): Promise<MemoryProposalRecord> =>
    ipcRenderer.invoke('aibox:rejectMemoryProposal', encodeMemoryReason(input)),
  listTaskScheduleProposals: (input?: TaskScheduleProposalListInput): Promise<TaskScheduleProposalRecord[]> =>
    ipcRenderer.invoke('aibox:listTaskScheduleProposals', input),
  acceptTaskScheduleProposal: (input: TaskScheduleProposalDecisionInput): Promise<AcceptedTaskScheduleProposal> =>
    ipcRenderer.invoke('aibox:acceptTaskScheduleProposal', encodeMemoryReason(input)),
  rejectTaskScheduleProposal: (input: TaskScheduleProposalDecisionInput): Promise<TaskScheduleProposalRecord> =>
    ipcRenderer.invoke('aibox:rejectTaskScheduleProposal', encodeMemoryReason(input)),
  /** Token / 模型调用统计 */
  getUsageStats: (): Promise<{ total: { input: number; output: number; total: number }; byModel: { model: string; input: number; output: number; total: number; count: number }[]; recent: { id: string; agentId: string; model: string; input: number; output: number; total: number; createdAt: number }[] }> =>
    ipcRenderer.invoke('aibox:getUsageStats'),
  getUsageStatsEnhanced: (since: number | null): Promise<{ total: { input: number; output: number; total: number }; byModel: { model: string; input: number; output: number; total: number; count: number }[]; byAgent: { agent_id: string; total: number; count: number }[]; trend: { date: string; total: number }[]; recent: { id: string; agentId: string; model: string; input: number; output: number; total: number; createdAt: number }[] }> =>
    ipcRenderer.invoke('aibox:getUsageStatsEnhanced', since),

  // MCP 服务器管理
  listMcpServers: (): Promise<{ id: string; name: string; command: string; args: string[]; env: Record<string, string>; enabled: boolean; scope: string; capability: 'browser' | ''; running: boolean; hasSecrets: boolean }[]> => ipcRenderer.invoke('aibox:listMcpServers'),
  createMcpServer: (input: { name: string; command: string; args?: string[]; env?: Record<string, string>; scope?: string; capability?: 'browser' | '' }): Promise<unknown> => ipcRenderer.invoke('aibox:createMcpServer', input),
  createPlaywrightBrowser: (input: { agentId: string; extensionToken?: string }): Promise<{ server: { id: string }; connection: { ok: boolean; message: string } }> => ipcRenderer.invoke('aibox:createPlaywrightBrowser', input),
  removeMcpServer: (id: string): Promise<void> => ipcRenderer.invoke('aibox:removeMcpServer', id),
  toggleMcpServer: (id: string, enabled: boolean): Promise<void> => ipcRenderer.invoke('aibox:toggleMcpServer', id, enabled),
  startMcpServer: (id: string): Promise<{ ok: boolean; message: string; tools?: { name: string; description: string }[] }> => ipcRenderer.invoke('aibox:startMcpServer', id),
  stopMcpServer: (id: string): Promise<void> => ipcRenderer.invoke('aibox:stopMcpServer', id),
  getMcpTools: (): Promise<{ name: string; description: string; serverId: string; serverName: string; capability: 'browser' | '' }[]> => ipcRenderer.invoke('aibox:getMcpTools'),

  // Skills 管理
  listSkills: (): Promise<{ id: string; name: string; description: string; content: string; enabled: boolean; createdAt: number }[]> => ipcRenderer.invoke('aibox:listSkills'),
  createSkill: (input: { name: string; description?: string; content?: string }): Promise<unknown> => ipcRenderer.invoke('aibox:createSkill', input),
  updateSkill: (id: string, patch: { name?: string; description?: string; content?: string; enabled?: boolean }): Promise<void> => ipcRenderer.invoke('aibox:updateSkill', id, patch),
  removeSkill: (id: string): Promise<void> => ipcRenderer.invoke('aibox:removeSkill', id),
  bindSkill: (agentId: string, skillId: string): Promise<void> => ipcRenderer.invoke('aibox:bindSkill', agentId, skillId),
  unbindSkill: (agentId: string, skillId: string): Promise<void> => ipcRenderer.invoke('aibox:unbindSkill', agentId, skillId),
  getAgentSkills: (agentId: string): Promise<{ id: string; name: string }[]> => ipcRenderer.invoke('aibox:getAgentSkills', agentId),
  /** Skills 组合 → 数字员工：一键把单/多个技能组合成可真实执行任务的员工 */
  createAgentFromSkills: (input: { skillIds: string[]; name?: string; engineId?: string }): Promise<Agent> =>
    ipcRenderer.invoke('aibox:createAgentFromSkills', input),

  // Hermes 同步
  importFromHermes: (): Promise<{ mcp: number; skills: number; errors: string[] }> => ipcRenderer.invoke('aibox:importFromHermes'),
  exportToHermes: (): Promise<{ mcp: number; skills: number; errors: string[] }> => ipcRenderer.invoke('aibox:exportToHermes'),

  // 多供应商管理
  listProviders: (): Promise<{ id: string; name: string; baseUrl: string; model: string; isDefault: boolean; hasKey: boolean }[]> => ipcRenderer.invoke('aibox:listProviders'),
  createProvider: (input: { name: string; baseUrl: string; model: string; apiKey?: string; isDefault?: boolean }): Promise<unknown> => ipcRenderer.invoke('aibox:createProvider', input),
  updateProvider: (id: string, patch: { name?: string; baseUrl?: string; model?: string; apiKey?: string; isDefault?: boolean }): Promise<void> => ipcRenderer.invoke('aibox:updateProvider', id, patch),
  removeProvider: (id: string): Promise<void> => ipcRenderer.invoke('aibox:removeProvider', id),
  testProviderById: (id: string): Promise<{ ok: boolean; latencyMs: number; error: string | null }> => ipcRenderer.invoke('aibox:testProviderById', id),
  fetchProviderModels: (id: string): Promise<{ ok: boolean; models: string[]; error?: string }> => ipcRenderer.invoke('aibox:fetchProviderModels', id),
  // API Bridge
  getBridgeStatus: (): Promise<ApiBridgeStatus> => ipcRenderer.invoke('aibox:getBridgeStatus'),
  toggleBridge: (enabled: boolean): Promise<ApiBridgeStatus> => ipcRenderer.invoke('aibox:toggleBridge', enabled),
  regenerateBridgeKey: (): Promise<ApiBridgeStatus> => ipcRenderer.invoke('aibox:regenerateBridgeKey'),
  copyBridgeKey: (): Promise<{ ok: true }> => ipcRenderer.invoke('aibox:copyBridgeKey'),

  // Prompt 模板
  listTemplates: (): Promise<{ id: string; name: string; content: string; category: string }[]> => ipcRenderer.invoke('aibox:listTemplates'),
  createTemplate: (input: { name: string; content: string; category?: string }): Promise<unknown> => ipcRenderer.invoke('aibox:createTemplate', input),
  removeTemplate: (id: string): Promise<void> => ipcRenderer.invoke('aibox:removeTemplate', id),

  // Agent 克隆/导出/导入/批量
  cloneAgent: (id: string, newName: string): Promise<Agent> => ipcRenderer.invoke('aibox:cloneAgent', id, newName),
  exportAgent: (id: string): Promise<string> => ipcRenderer.invoke('aibox:exportAgent', id),
  importAgent: (json: string): Promise<{ ok: boolean; message: string; agent?: Agent }> => ipcRenderer.invoke('aibox:importAgent', json),
  batchAgentAction: (ids: string[], action: 'start' | 'stop' | 'delete'): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('aibox:batchAgentAction', ids, action),
  getAgentDetail: (agentId: string): Promise<{ tasks: { id: string; title: string; status: string; progress: number; createdAt: number }[]; usage: { totalTokens: number; inputTokens: number; outputTokens: number; calls: number }; events: { id: string; eventType: string; createdAt: number }[] }> => ipcRenderer.invoke('aibox:getAgentDetail', agentId),

  // 可视化工作流引擎
  listWorkflows: (): Promise<WorkflowDef[]> => ipcRenderer.invoke('aibox:listWorkflows'),
  createWorkflow: (input: { name: string; description?: string; nodes: WfNode[]; edges: WfEdge[] }): Promise<WorkflowDef> => ipcRenderer.invoke('aibox:createWorkflow', input),
  updateWorkflow: (id: string, patch: { name?: string; description?: string; nodes?: WfNode[]; edges?: WfEdge[] }): Promise<void> => ipcRenderer.invoke('aibox:updateWorkflow', id, patch),
  removeWorkflow: (id: string): Promise<void> => ipcRenderer.invoke('aibox:removeWorkflow', id),
  triggerWorkflow: (id: string, inputs?: Record<string, string>): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('aibox:triggerWorkflow', id, inputs),
  getWorkflowRunState: (id: string): Promise<{ nodeId: string; status: string }[] | null> => ipcRenderer.invoke('aibox:getWorkflowRunState', id),
  publishWorkflowAsSkill: (id: string): Promise<{ ok: boolean; message: string; skillId?: string }> => ipcRenderer.invoke('aibox:publishWorkflowAsSkill', id),
  unpublishWorkflowSkill: (id: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('aibox:unpublishWorkflowSkill', id),
  listWorkflowRuns: (id: string): Promise<{ id: string; workflowId: string; status: string; error: string | null; nodeResults: Record<string, { status: string; output?: string; error?: string }>; startedAt: number; endedAt: number | null; durationMs: number | null }[]> => ipcRenderer.invoke('aibox:listWorkflowRuns', id),
  exportWorkflow: (id: string): Promise<string | null> => ipcRenderer.invoke('aibox:exportWorkflow', id),
  importWorkflow: (json: string): Promise<{ ok: boolean; message: string; workflow?: WorkflowDef }> => ipcRenderer.invoke('aibox:importWorkflow', json),
  validateWorkflow: (wf: { nodes: unknown[]; edges: unknown[] }): Promise<{ valid: boolean; errors: string[]; warnings: string[] }> => ipcRenderer.invoke('aibox:validateWorkflow', wf),
  saveWfVariables: (wfId: string, variables: { name: string; defaultValue: string; description?: string }[]): Promise<void> => ipcRenderer.invoke('aibox:saveWfVariables', wfId, variables),
  // 外部工作流平台（Coze / Dify）
  listWfPlatforms: (): Promise<WfPlatformConfig[]> => ipcRenderer.invoke('aibox:listWfPlatforms'),
  saveWfPlatform: (input: { id?: string; name: string; baseUrl: string; token?: string }): Promise<WfPlatformConfig> => ipcRenderer.invoke('aibox:saveWfPlatform', input),
  removeWfPlatform: (id: string): Promise<void> => ipcRenderer.invoke('aibox:removeWfPlatform', id),
  testWfPlatform: (id: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('aibox:testWfPlatform', id),

  // 专家团
  listTeams: (): Promise<{ id: string; name: string; coordinatorId: string; memberIds: string[]; mode: string; workspace: string; createdAt: number }[]> => ipcRenderer.invoke('aibox:listTeams'),
  createTeam: (input: { name: string; coordinatorId: string; memberIds: string[]; mode?: 'coordinate' | 'roundtable'; workspace?: string }): Promise<unknown> => ipcRenderer.invoke('aibox:createTeam', input),
  updateTeam: (id: string, patch: { name?: string; coordinatorId?: string; memberIds?: string[]; mode?: 'coordinate' | 'roundtable'; workspace?: string }): Promise<void> => ipcRenderer.invoke('aibox:updateTeam', id, patch),
  removeTeam: (id: string): Promise<void> => ipcRenderer.invoke('aibox:removeTeam', id),
  triggerTeam: (id: string, task: string, projectId?: string): Promise<{ ok: boolean; message: string; runId?: string }> => ipcRenderer.invoke('aibox:triggerTeam', id, task, projectId),
  getTeamRuns: (teamId: string): Promise<TeamRun[]> => ipcRenderer.invoke('aibox:getTeamRuns', teamId),
  getTeamCollaborationOverview: (teamId: string): Promise<TeamCollaborationOverview> => ipcRenderer.invoke('aibox:getTeamCollaborationOverview', teamId),
  listAttentionRuns: (): Promise<(TeamRun & { teamName: string })[]> => ipcRenderer.invoke('aibox:listAttentionRuns'),
  getTeamConfig: (teamId: string): Promise<{ timeout: number; maxRetries: number; concurrency: number }> => ipcRenderer.invoke('aibox:getTeamConfig', teamId),
  saveTeamConfig: (teamId: string, config: { timeout: number; maxRetries: number; concurrency: number }): Promise<{ ok: boolean }> => ipcRenderer.invoke('aibox:saveTeamConfig', teamId, config),
  getTeamStats: (teamId: string): Promise<{ totalRuns: number; avgDurationMs: number; successRate: number }> => ipcRenderer.invoke('aibox:getTeamStats', teamId),
  getSubtaskOutput: (taskId: string): Promise<string | null> => ipcRenderer.invoke('aibox:getSubtaskOutput', taskId),
  retryTeamSubtask: (runId: string, subtaskIndex: number): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('aibox:retryTeamSubtask', runId, subtaskIndex),
  cancelTeamRun: (runId: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('aibox:cancelTeamRun', runId),
  skipTeamSubtask: (runId: string, subtaskIndex: number): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('aibox:skipTeamSubtask', runId, subtaskIndex),
  forceRetryTeamSubtask: (runId: string, subtaskIndex: number): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('aibox:forceRetryTeamSubtask', runId, subtaskIndex),
  injectTeamGuidance: (runId: string, message: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('aibox:injectTeamGuidance', runId, message),
  saveTeamAsTemplate: (teamId: string, name?: string): Promise<{ ok: boolean; message: string; id?: string }> => ipcRenderer.invoke('aibox:saveTeamAsTemplate', teamId, name),
  listTeamTemplates: (): Promise<{ id: string; name: string; description: string; mode: string; members: unknown[]; createdAt: number }[]> => ipcRenderer.invoke('aibox:listTeamTemplates'),
  removeTeamTemplate: (id: string): Promise<void> => ipcRenderer.invoke('aibox:removeTeamTemplate', id),

  // 任务
  createTask: (agentId: string, title: string, projectId?: string): Promise<Task> =>
    ipcRenderer.invoke('aibox:createTask', agentId, encodeText(title), projectId, randomUUID()),
  cancelTask: (id: string): Promise<void> => ipcRenderer.invoke('aibox:cancelTask', id),
  retryTask: (id: string): Promise<Task> => ipcRenderer.invoke('aibox:retryTask', id),
  deleteTask: (id: string): Promise<void> => ipcRenderer.invoke('aibox:deleteTask', id),
  pauseTask: (id: string): Promise<void> => ipcRenderer.invoke('aibox:pauseTask', id),
  resumeTask: (id: string): Promise<void> => ipcRenderer.invoke('aibox:resumeTask', id),
  decideApproval: (id: string, approve: boolean): Promise<void> => ipcRenderer.invoke('aibox:decideApproval', id, approve),
  createFollowUpTask: (parentTaskId: string, title: string): Promise<Task> => ipcRenderer.invoke('aibox:createFollowUpTask', parentTaskId, encodeText(title)),
  getTaskEvents: (taskId: string): Promise<TaskEvent[]> => ipcRenderer.invoke('aibox:getTaskEvents', taskId),
  getTaskResult: (taskId: string): Promise<string | null> => ipcRenderer.invoke('aibox:getTaskResult', taskId),
  setTaskQuality: (taskId: string, quality: 'accepted' | 'rejected' | 'rework' | null): Promise<Task | null> => ipcRenderer.invoke('aibox:setTaskQuality', taskId, quality),

  // 定时任务（P3a）
  createSchedule: (input: ScheduleInput): Promise<Schedule> => ipcRenderer.invoke('aibox:createSchedule', input),
  toggleSchedule: (id: string, enabled: boolean): Promise<void> => ipcRenderer.invoke('aibox:toggleSchedule', id, enabled),
  deleteSchedule: (id: string): Promise<void> => ipcRenderer.invoke('aibox:deleteSchedule', id),
  updateSchedule: (id: string, patch: Partial<ScheduleInput>): Promise<void> => ipcRenderer.invoke('aibox:updateSchedule', id, patch),
  getScheduleHistory: (scheduleId: string): Promise<{ id: string; title: string; status: string; createdAt: number }[]> => ipcRenderer.invoke('aibox:getScheduleHistory', scheduleId),

  // 引擎
  installEngine: (id: string): Promise<EngineInstallResult> => ipcRenderer.invoke('aibox:installEngine', id),
  detectEngines: (): Promise<Engine[]> => ipcRenderer.invoke('aibox:detectEngines'),
  getInstallGuide: (id: string): Promise<EngineInstallGuide | null> => ipcRenderer.invoke('aibox:getInstallGuide', id),
  updateEngine: (id: string): Promise<EngineInstallResult> => ipcRenderer.invoke('aibox:updateEngine', id),
  uninstallEngine: (id: string): Promise<EngineInstallResult> => ipcRenderer.invoke('aibox:uninstallEngine', id),
  getEngineLatestVersion: (id: string): Promise<string | null> => ipcRenderer.invoke('aibox:getEngineLatestVersion', id),
  /** 重启引擎：重新检测/加载配置，无需重启应用 */
  restartEngine: (id: string): Promise<EngineInstallResult> => ipcRenderer.invoke('aibox:restartEngine', id),
  checkRuntime: (): Promise<{ name: string; installed: boolean; version: string | null; path: string | null }[]> => ipcRenderer.invoke('aibox:checkRuntime'),
  installRuntime: (name: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('aibox:installRuntime', name),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('aibox:openExternal', url),
  openTaskWorkspace: (taskId: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('aibox:openTaskWorkspace', taskId),
  openAgentWorkspace: (agentId: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('aibox:openAgentWorkspace', agentId),
  /** 鉴权探测：真实跑一次最小请求验证凭据，返回结果而非静默标记 */
  authEngine: (id: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('aibox:authEngine', id),
  setDefaultEngine: (id: string): Promise<void> => ipcRenderer.invoke('aibox:setDefaultEngine', id),
  getEngineConfig: (id: string): Promise<{ runArgs?: string[]; env?: Record<string, string>; maxConcurrency?: number } | null> => ipcRenderer.invoke('aibox:getEngineConfig', id),
  saveEngineConfig: (id: string, config: { runArgs?: string[]; env?: Record<string, string>; maxConcurrency?: number }): Promise<{ ok: boolean }> => ipcRenderer.invoke('aibox:saveEngineConfig', id, config),
  getEngineLogs: (id: string): Promise<{ id: string; engineId: string; level: string; message: string; timestamp: number }[]> => ipcRenderer.invoke('aibox:getEngineLogs', id),
  getEngineMetrics: (id: string): Promise<{ avgLatencyMs: number; successRate: number; totalRuns: number }> => ipcRenderer.invoke('aibox:getEngineMetrics', id),
  registerCustomEngine: (input: { name: string; command: string; args?: string; dataBoundary?: string }): Promise<{ ok: boolean; message: string; id?: string }> => ipcRenderer.invoke('aibox:registerCustomEngine', input),
  getEngineRouting: (): Promise<Record<string, string>> => ipcRenderer.invoke('aibox:getEngineRouting'),
  saveEngineRouting: (rules: Record<string, string>): Promise<{ ok: boolean }> => ipcRenderer.invoke('aibox:saveEngineRouting', rules),

  // 模型供应商（脱敏视图；密钥仅上行，不回传明文）
  getProviderConfig: (): Promise<ProviderConfig> => ipcRenderer.invoke('aibox:getProviderConfig'),
  saveProviderConfig: (input: { baseUrl: string; model: string; apiKey?: string }): Promise<ProviderConfig> =>
    ipcRenderer.invoke('aibox:saveProviderConfig', input),
  testProvider: (override?: { baseUrl?: string; apiKey?: string }): Promise<ProviderTestResult> =>
    ipcRenderer.invoke('aibox:testProvider', override),

  // 应用配置文件（下载源等）
  getAppConfig: (): Promise<AppConfig> => ipcRenderer.invoke('aibox:getAppConfig'),
  setAppConfig: (patch: Partial<AppConfig>): Promise<AppConfig> => ipcRenderer.invoke('aibox:setAppConfig', patch),

  // 渠道
  configureFeishu: (appId: string, appSecret: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('aibox:configureFeishu', appId, appSecret),
  /** 企业微信智能机器人：官方长连接 API 模式（BotID + Secret） */
  configureWecom: (botId: string, secret: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('aibox:configureWecom', botId, secret),
  /** 微信 iLink Bot：扫码状态可见，凭据始终留在主进程 */
  startWeixinLogin: (agentId?: string): Promise<WeixinLoginState> => ipcRenderer.invoke('aibox:startWeixinLogin', agentId),
  getWeixinLoginState: (): Promise<WeixinLoginState> => ipcRenderer.invoke('aibox:getWeixinLoginState'),
  submitWeixinVerifyCode: (code: string): Promise<WeixinLoginState> => ipcRenderer.invoke('aibox:submitWeixinVerifyCode', code),
  cancelWeixinLogin: (): Promise<void> => ipcRenderer.invoke('aibox:cancelWeixinLogin'),
  setupChannel: (id: string, accountName: string): Promise<void> => ipcRenderer.invoke('aibox:setupChannel', id, accountName),
  disconnectChannel: (id: string): Promise<void> => ipcRenderer.invoke('aibox:disconnectChannel', id),
  bindChannel: (channelId: string, agentId: string): Promise<void> => ipcRenderer.invoke('aibox:bindChannel', channelId, agentId),
  unbindChannel: (channelId: string, agentId: string): Promise<void> => ipcRenderer.invoke('aibox:unbindChannel', channelId, agentId),

  // 设置 / 目录
  getSetting: <K extends RendererSettingKey>(key: K): Promise<RendererSettingMap[K] | null> =>
    ipcRenderer.invoke('aibox:getSetting', key),
  setSetting: <K extends RendererSettingKey>(key: K, value: RendererSettingMap[K]): Promise<void> =>
    ipcRenderer.invoke('aibox:setSetting', key, value),
  /** 演示数据残留量（H-3：演示与真实数据同表，需可查可清） */
  getDemoDataStats: (): Promise<{ agents: number; tasks: number; projects: number }> => ipcRenderer.invoke('aibox:getDemoDataStats'),
  /** 清空演示数据：只删 is_demo=1 行，真实数据不受影响 */
  purgeDemoData: (): Promise<{ agents: number; tasks: number; projects: number }> => ipcRenderer.invoke('aibox:purgeDemoData'),
  getWebAdminStatus: (): Promise<WebAdminStatus> => ipcRenderer.invoke('aibox:getWebAdminStatus'),
  regenerateWebToken: (): Promise<WebAdminStatus> => ipcRenderer.invoke('aibox:regenerateWebToken'),
  copyWebToken: (): Promise<{ ok: true }> => ipcRenderer.invoke('aibox:copyWebToken'),

  // OCR 文字识别服务
  getOcrStatus: (): Promise<{ enabled: boolean; ready: boolean; modelsExist: boolean; modelSize: string; version: string }> => ipcRenderer.invoke('aibox:getOcrStatus'),
  toggleOcr: (enabled: boolean): Promise<{ enabled: boolean; ready: boolean; modelsExist: boolean; modelSize: string; version: string }> => ipcRenderer.invoke('aibox:toggleOcr', enabled),
  downloadOcrModels: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('aibox:downloadOcrModels'),
  ocrRecognize: (imagePath: string): Promise<{ ok: boolean; text: string; boxes: { box: [number, number][]; text: string; confidence: number }[]; elapsed: number; error?: string }> => ipcRenderer.invoke('aibox:ocrRecognize', imagePath),
  /** 数据库完整性检查 */
  integrityCheck: (): Promise<{ ok: boolean; message: string; repaired: number }> => ipcRenderer.invoke('aibox:integrityCheck'),
  /** 手动数据清理 */
  manualCleanup: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('aibox:manualCleanup'),
  toggleFullscreen: (): Promise<boolean> => ipcRenderer.invoke('aibox:toggleFullscreen'),
  isFullscreen: (): Promise<boolean> => ipcRenderer.invoke('aibox:isFullscreen'),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('aibox:pickDirectory'),
  exportData: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('aibox:exportData'),
  restoreData: (): Promise<{ ok: boolean; message: string; restartRequired: boolean }> => ipcRenderer.invoke('aibox:restoreData'),
  restartApp: (): Promise<void> => ipcRenderer.invoke('aibox:restartApp'),
  reportError: (payload: { message: string; stack?: string; componentStack?: string }): Promise<void> => ipcRenderer.invoke('aibox:reportError', payload),
  // 多机协同
  collabCheckGit: (): Promise<{ name: string; installed: boolean; version: string | null; path: string | null }> => ipcRenderer.invoke('aibox:collab:checkGit'),
  collabInstallGit: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('aibox:collab:installGit'),
  collabListWorkspaces: (): Promise<CollabWorkspace[]> => ipcRenderer.invoke('aibox:collab:listWorkspaces'),
  collabCreateWorkspace: (input: { name: string; repoPath: string; conventions?: string; gitRules?: string; mcpPort?: number; gitPort?: number }): Promise<CollabWorkspace> => ipcRenderer.invoke('aibox:collab:createWorkspace', input),
  collabRemoveWorkspace: (id: string): Promise<void> => ipcRenderer.invoke('aibox:collab:removeWorkspace', id),
  collabStartWorkspace: (id: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('aibox:collab:startWorkspace', id),
  collabStopWorkspace: (id: string): Promise<void> => ipcRenderer.invoke('aibox:collab:stopWorkspace', id),
  collabListTasks: (workspaceId: string): Promise<CollabTask[]> => ipcRenderer.invoke('aibox:collab:listTasks', workspaceId),
  collabCreateTask: (workspaceId: string, input: { title: string; description?: string; branchName?: string }): Promise<CollabTask> => ipcRenderer.invoke('aibox:collab:createTask', workspaceId, input),
  collabReviewTask: (taskId: string, result: 'accept' | 'reject', comment: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('aibox:collab:reviewTask', taskId, result, comment),
  collabListAgents: (workspaceId: string): Promise<CollabAgent[]> => ipcRenderer.invoke('aibox:collab:listAgents', workspaceId),
  collabGetConnectInfo: (workspaceId: string): Promise<CollabConnectInfo | null> => ipcRenderer.invoke('aibox:collab:getConnectInfo', workspaceId),
  collabUpdateRules: (id: string, patch: { conventions?: string; gitRules?: string }): Promise<void> => ipcRenderer.invoke('aibox:collab:updateRules', id, patch),

  // 事件订阅
  onSnapshot: (fn: (s: Snapshot) => void): (() => void) => {
    const handler = (_: unknown, s: Snapshot) => fn(s);
    ipcRenderer.on('aibox:snapshot', handler);
    return () => ipcRenderer.removeListener('aibox:snapshot', handler);
  },
  onResources: (fn: (r: ResourceUpdatePayload) => void): (() => void) => {
    const handler = (_: unknown, r: ResourceUpdatePayload) => fn(r);
    ipcRenderer.on('aibox:resources', handler);
    return () => ipcRenderer.removeListener('aibox:resources', handler);
  },
  /** 任务输出流式推送（逐字显示） */
  onTaskOutput: (fn: (p: { taskId: string; chunk: string }) => void): (() => void) => {
    const handler = (_: unknown, p: { taskId: string; chunk: string }) => fn(p);
    ipcRenderer.on('aibox:taskOutput', handler);
    return () => ipcRenderer.removeListener('aibox:taskOutput', handler);
  },
  onMobileEvent: (fn: (event: MobileEvent) => void): (() => void) => {
    const handler = (_: unknown, event: MobileEvent) => fn(event);
    ipcRenderer.on('aibox:mobileEvent', handler);
    return () => ipcRenderer.removeListener('aibox:mobileEvent', handler);
  },

  // ---------- 语音任务下达 ----------
  getVoiceConfig: (): Promise<VoiceConfig> => ipcRenderer.invoke('aibox:getVoiceConfig'),
  saveVoiceConfig: (input: VoiceConfigInput): Promise<VoiceConfig> => ipcRenderer.invoke('aibox:saveVoiceConfig', input),
  testVoice: (): Promise<VoiceTestResult> => ipcRenderer.invoke('aibox:testVoice'),
  startVoiceSession: (): Promise<{ ok: boolean; sessionId: string | null; provider: 'cloud' | 'local' | null; message: string }> =>
    ipcRenderer.invoke('aibox:startVoiceSession'),
  /** 推送麦克风 PCM 分片（16kHz/16bit/单声道） */
  pushVoiceAudio: (sessionId: string, chunk: ArrayBuffer): Promise<void> =>
    ipcRenderer.invoke('aibox:pushVoiceAudio', sessionId, chunk),
  stopVoiceSession: (sessionId: string): Promise<void> => ipcRenderer.invoke('aibox:stopVoiceSession', sessionId),
  /** 解析语音文本为任务草稿（不派发） */
  parseVoiceCommand: (text: string): Promise<VoiceCommandDraft> => ipcRenderer.invoke('aibox:parseVoiceCommand', encodeText(text)),
  /** 用户确认后派发（source='voice'）；messageKey 在一次确认 attempt 内保持稳定。 */
  dispatchVoiceTask: (agentId: string, title: string, messageKey: string): Promise<Task> =>
    ipcRenderer.invoke('aibox:dispatchVoiceTask', agentId, encodeText(title), messageKey),
  /** 识别结果流式订阅（边说边出字） */
  onVoiceTranscript: (fn: (p: { sessionId: string; text: string; isFinal: boolean; timestamp: number }) => void): (() => void) => {
    const handler = (_: unknown, p: { sessionId: string; text: string; isFinal: boolean; timestamp: number }) => fn(p);
    ipcRenderer.on('aibox:voiceTranscript', handler);
    return () => ipcRenderer.removeListener('aibox:voiceTranscript', handler);
  },
  onVoiceError: (fn: (p: { sessionId: string; message: string }) => void): (() => void) => {
    const handler = (_: unknown, p: { sessionId: string; message: string }) => fn(p);
    ipcRenderer.on('aibox:voiceError', handler);
    return () => ipcRenderer.removeListener('aibox:voiceError', handler);
  },
  /** 工作流节点执行事件（实时变色） */
  onWfNodeEvent: (fn: (e: WfNodeEvent) => void): (() => void) => {
    const handler = (_: unknown, e: WfNodeEvent) => fn(e);
    ipcRenderer.on('aibox:wfNodeEvent', handler);
    return () => ipcRenderer.removeListener('aibox:wfNodeEvent', handler);
  },
};

export type AiBoxApi = typeof api;

contextBridge.exposeInMainWorld('aibox', api);
