/**
 * Preload：Renderer 唯一入口（contextIsolation 开启）
 * 只暴露白名单方法，不暴露 ipcRenderer 本体。
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  Agent, AgentCardView, AgentPersonaPatch, AppConfig, Approval, Channel, Conversation, CreateAgentInput, DashboardStats,
  Engine, EngineInstallGuide, EngineInstallResult, ProviderConfig, ProviderTestResult,
  ResourceSample, Schedule, ScheduleInput, ServiceHealth, SystemInfo, Task, TaskEvent, TodoItem,
  WfNode, WfEdge, WorkflowDef, WfPlatformConfig, WfNodeEvent,
  CollabWorkspace, CollabTask, CollabAgent, CollabConnectInfo,
  TeamRun
} from '../shared/types.js';

export interface Snapshot {
  /** 单调递增版本号，供渲染层判断快照新旧 / 跳过冗余渲染 */
  version: number;
  stats: DashboardStats;
  agentCards: AgentCardView[];
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

const api = {
  // 查询
  getSnapshot: (): Promise<Snapshot> => ipcRenderer.invoke('aibox:getSnapshot'),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('aibox:getAppVersion'),
  getResourceHistory: (): Promise<ResourcePayload> => ipcRenderer.invoke('aibox:getResourceHistory'),
  getSystemInfo: (): Promise<SystemInfo> => ipcRenderer.invoke('aibox:getSystemInfo'),

  // 数字员工
  createAgent: (input: CreateAgentInput): Promise<Agent> => ipcRenderer.invoke('aibox:createAgent', input),
  startAgent: (id: string): Promise<void> => ipcRenderer.invoke('aibox:startAgent', id),
  stopAgent: (id: string): Promise<void> => ipcRenderer.invoke('aibox:stopAgent', id),
  /** 助手人设编辑（soul.md / agents.md / user.md / 权限模式） */
  updateAgentPersona: (id: string, patch: AgentPersonaPatch): Promise<Agent> => ipcRenderer.invoke('aibox:updateAgentPersona', id, patch),
  /** AI 辅助生成人设（输入描述，返回生成的配置） */
  generatePersona: (description: string): Promise<{ name: string; role: string; soulMd: string; agentsMd: string; systemPrompt: string; permissionMode: string }> => ipcRenderer.invoke('aibox:generatePersona', description),
  /** 会话列表（按助手） */
  listConversations: (agentId: string): Promise<Conversation[]> => ipcRenderer.invoke('aibox:listConversations', agentId),
  /** 发送消息给助手（创建/继续会话） */
  chatWithAgent: (agentId: string, message: string, conversationId?: string): Promise<{ conversationId: string; task: Task }> =>
    ipcRenderer.invoke('aibox:chatWithAgent', agentId, message, conversationId),
  /** 会话重命名 */
  renameConversation: (id: string, title: string): Promise<void> => ipcRenderer.invoke('aibox:renameConversation', id, title),
  /** 删除会话 */
  deleteConversation: (id: string): Promise<void> => ipcRenderer.invoke('aibox:deleteConversation', id),
  /** Token / 模型调用统计 */
  getUsageStats: (): Promise<{ total: { input: number; output: number; total: number }; byModel: { model: string; input: number; output: number; total: number; count: number }[]; recent: { id: string; agentId: string; model: string; input: number; output: number; total: number; createdAt: number }[] }> =>
    ipcRenderer.invoke('aibox:getUsageStats'),
  getUsageStatsEnhanced: (since: number | null): Promise<{ total: { input: number; output: number; total: number }; byModel: { model: string; input: number; output: number; total: number; count: number }[]; byAgent: { agent_id: string; total: number; count: number }[]; trend: { date: string; total: number }[]; recent: { id: string; agentId: string; model: string; input: number; output: number; total: number; createdAt: number }[] }> =>
    ipcRenderer.invoke('aibox:getUsageStatsEnhanced', since),

  // MCP 服务器管理
  listMcpServers: (): Promise<{ id: string; name: string; command: string; args: string[]; env: Record<string, string>; enabled: boolean; scope: string }[]> => ipcRenderer.invoke('aibox:listMcpServers'),
  createMcpServer: (input: { name: string; command: string; args?: string[]; env?: Record<string, string> }): Promise<unknown> => ipcRenderer.invoke('aibox:createMcpServer', input),
  removeMcpServer: (id: string): Promise<void> => ipcRenderer.invoke('aibox:removeMcpServer', id),
  toggleMcpServer: (id: string, enabled: boolean): Promise<void> => ipcRenderer.invoke('aibox:toggleMcpServer', id, enabled),
  startMcpServer: (id: string): Promise<{ ok: boolean; message: string; tools?: { name: string; description: string }[] }> => ipcRenderer.invoke('aibox:startMcpServer', id),
  stopMcpServer: (id: string): Promise<void> => ipcRenderer.invoke('aibox:stopMcpServer', id),
  getMcpTools: (): Promise<{ name: string; description: string; serverId: string; serverName: string }[]> => ipcRenderer.invoke('aibox:getMcpTools'),

  // Skills 管理
  listSkills: (): Promise<{ id: string; name: string; description: string; content: string; enabled: boolean; createdAt: number }[]> => ipcRenderer.invoke('aibox:listSkills'),
  createSkill: (input: { name: string; description?: string; content?: string }): Promise<unknown> => ipcRenderer.invoke('aibox:createSkill', input),
  updateSkill: (id: string, patch: { name?: string; description?: string; content?: string; enabled?: boolean }): Promise<void> => ipcRenderer.invoke('aibox:updateSkill', id, patch),
  removeSkill: (id: string): Promise<void> => ipcRenderer.invoke('aibox:removeSkill', id),
  bindSkill: (agentId: string, skillId: string): Promise<void> => ipcRenderer.invoke('aibox:bindSkill', agentId, skillId),
  unbindSkill: (agentId: string, skillId: string): Promise<void> => ipcRenderer.invoke('aibox:unbindSkill', agentId, skillId),
  getAgentSkills: (agentId: string): Promise<{ id: string; name: string }[]> => ipcRenderer.invoke('aibox:getAgentSkills', agentId),

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
  getBridgeStatus: (): Promise<{ running: boolean; port: number; bridgeKey: string; enabled: boolean }> => ipcRenderer.invoke('aibox:getBridgeStatus'),
  toggleBridge: (enabled: boolean): Promise<{ running: boolean; port: number; bridgeKey: string; enabled: boolean }> => ipcRenderer.invoke('aibox:toggleBridge', enabled),
  regenerateBridgeKey: (): Promise<{ running: boolean; port: number; bridgeKey: string; enabled: boolean }> => ipcRenderer.invoke('aibox:regenerateBridgeKey'),

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
  triggerTeam: (id: string, task: string): Promise<{ ok: boolean; message: string; runId?: string }> => ipcRenderer.invoke('aibox:triggerTeam', id, task),
  getTeamRuns: (teamId: string): Promise<TeamRun[]> => ipcRenderer.invoke('aibox:getTeamRuns', teamId),
  getTeamConfig: (teamId: string): Promise<{ timeout: number; maxRetries: number; concurrency: number }> => ipcRenderer.invoke('aibox:getTeamConfig', teamId),
  saveTeamConfig: (teamId: string, config: { timeout: number; maxRetries: number; concurrency: number }): Promise<{ ok: boolean }> => ipcRenderer.invoke('aibox:saveTeamConfig', teamId, config),
  getTeamStats: (teamId: string): Promise<{ totalRuns: number; avgDurationMs: number; successRate: number }> => ipcRenderer.invoke('aibox:getTeamStats', teamId),
  getSubtaskOutput: (taskId: string): Promise<string | null> => ipcRenderer.invoke('aibox:getSubtaskOutput', taskId),
  retryTeamSubtask: (runId: string, subtaskIndex: number): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('aibox:retryTeamSubtask', runId, subtaskIndex),
  saveTeamAsTemplate: (teamId: string, name?: string): Promise<{ ok: boolean; message: string; id?: string }> => ipcRenderer.invoke('aibox:saveTeamAsTemplate', teamId, name),
  listTeamTemplates: (): Promise<{ id: string; name: string; description: string; mode: string; members: unknown[]; createdAt: number }[]> => ipcRenderer.invoke('aibox:listTeamTemplates'),
  removeTeamTemplate: (id: string): Promise<void> => ipcRenderer.invoke('aibox:removeTeamTemplate', id),

  // 任务
  createTask: (agentId: string, title: string): Promise<Task> => ipcRenderer.invoke('aibox:createTask', agentId, title),
  cancelTask: (id: string): Promise<void> => ipcRenderer.invoke('aibox:cancelTask', id),
  pauseTask: (id: string): Promise<void> => ipcRenderer.invoke('aibox:pauseTask', id),
  resumeTask: (id: string): Promise<void> => ipcRenderer.invoke('aibox:resumeTask', id),
  decideApproval: (id: string, approve: boolean): Promise<void> => ipcRenderer.invoke('aibox:decideApproval', id, approve),
  createFollowUpTask: (parentTaskId: string, title: string): Promise<Task> => ipcRenderer.invoke('aibox:createFollowUpTask', parentTaskId, title),
  getTaskEvents: (taskId: string): Promise<TaskEvent[]> => ipcRenderer.invoke('aibox:getTaskEvents', taskId),
  getTaskResult: (taskId: string): Promise<string | null> => ipcRenderer.invoke('aibox:getTaskResult', taskId),

  // 定时任务（P3a）
  createSchedule: (input: ScheduleInput): Promise<Schedule> => ipcRenderer.invoke('aibox:createSchedule', input),
  toggleSchedule: (id: string, enabled: boolean): Promise<void> => ipcRenderer.invoke('aibox:toggleSchedule', id, enabled),
  deleteSchedule: (id: string): Promise<void> => ipcRenderer.invoke('aibox:deleteSchedule', id),
  updateSchedule: (id: string, patch: { title?: string; content?: string; cronKind?: string; cronValue?: string }): Promise<void> => ipcRenderer.invoke('aibox:updateSchedule', id, patch),
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
  authEngine: (id: string): Promise<void> => ipcRenderer.invoke('aibox:authEngine', id),
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
  /** 个人微信：本地 Bot 桥接接口（回环 WebSocket 地址 + 可选令牌） */
  configureWeixin: (bridgeUrl: string, token: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('aibox:configureWeixin', bridgeUrl, token),
  setupChannel: (id: string, accountName: string): Promise<void> => ipcRenderer.invoke('aibox:setupChannel', id, accountName),
  disconnectChannel: (id: string): Promise<void> => ipcRenderer.invoke('aibox:disconnectChannel', id),
  bindChannel: (channelId: string, agentId: string): Promise<void> => ipcRenderer.invoke('aibox:bindChannel', channelId, agentId),
  unbindChannel: (channelId: string, agentId: string): Promise<void> => ipcRenderer.invoke('aibox:unbindChannel', channelId, agentId),

  // 设置 / 目录 / 凭据
  getSetting: (key: string): Promise<unknown> => ipcRenderer.invoke('aibox:getSetting', key),
  setSetting: (key: string, value: unknown): Promise<void> => ipcRenderer.invoke('aibox:setSetting', key, value),

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
  reportError: (payload: { message: string; stack?: string; componentStack?: string }): Promise<void> => ipcRenderer.invoke('aibox:reportError', payload),
  storeSecret: (ref: string, secret: string): Promise<void> => ipcRenderer.invoke('aibox:storeSecret', ref, secret),
  hasSecret: (ref: string): Promise<boolean> => ipcRenderer.invoke('aibox:hasSecret', ref),

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
  onResources: (fn: (r: ResourcePayload) => void): (() => void) => {
    const handler = (_: unknown, r: ResourcePayload) => fn(r);
    ipcRenderer.on('aibox:resources', handler);
    return () => ipcRenderer.removeListener('aibox:resources', handler);
  },
  /** 任务输出流式推送（逐字显示） */
  onTaskOutput: (fn: (p: { taskId: string; chunk: string }) => void): (() => void) => {
    const handler = (_: unknown, p: { taskId: string; chunk: string }) => fn(p);
    ipcRenderer.on('aibox:taskOutput', handler);
    return () => ipcRenderer.removeListener('aibox:taskOutput', handler);
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
