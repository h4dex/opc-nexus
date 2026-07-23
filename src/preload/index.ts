/**
 * Preload：Renderer 唯一入口（contextIsolation 开启）
 * 只暴露白名单方法，不暴露 ipcRenderer 本体。
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  Agent, AgentCardView, AgentPersonaPatch, AppConfig, Approval, Channel, Conversation, CreateAgentInput, DashboardStats,
  Engine, EngineInstallGuide, EngineInstallResult, ProviderConfig, ProviderTestResult,
  ResourceSample, Schedule, ScheduleInput, ServiceHealth, SystemInfo, Task, TaskEvent, TodoItem,
  WfNode, WfEdge, WorkflowDef, WfPlatformConfig, WfNodeEvent
} from '../shared/types.js';

export interface Snapshot {
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
  /** Token / 模型调用统计 */
  getUsageStats: (): Promise<{ total: { input: number; output: number; total: number }; byModel: { model: string; input: number; output: number; total: number; count: number }[]; recent: { id: string; agentId: string; model: string; input: number; output: number; total: number; createdAt: number }[] }> =>
    ipcRenderer.invoke('aibox:getUsageStats'),

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

  // Prompt 模板
  listTemplates: (): Promise<{ id: string; name: string; content: string; category: string }[]> => ipcRenderer.invoke('aibox:listTemplates'),
  createTemplate: (input: { name: string; content: string; category?: string }): Promise<unknown> => ipcRenderer.invoke('aibox:createTemplate', input),
  removeTemplate: (id: string): Promise<void> => ipcRenderer.invoke('aibox:removeTemplate', id),

  // Agent 克隆/导出
  cloneAgent: (id: string, newName: string): Promise<Agent> => ipcRenderer.invoke('aibox:cloneAgent', id, newName),
  exportAgent: (id: string): Promise<string> => ipcRenderer.invoke('aibox:exportAgent', id),

  // 可视化工作流引擎
  listWorkflows: (): Promise<WorkflowDef[]> => ipcRenderer.invoke('aibox:listWorkflows'),
  createWorkflow: (input: { name: string; description?: string; nodes: WfNode[]; edges: WfEdge[] }): Promise<WorkflowDef> => ipcRenderer.invoke('aibox:createWorkflow', input),
  updateWorkflow: (id: string, patch: { name?: string; description?: string; nodes?: WfNode[]; edges?: WfEdge[] }): Promise<void> => ipcRenderer.invoke('aibox:updateWorkflow', id, patch),
  removeWorkflow: (id: string): Promise<void> => ipcRenderer.invoke('aibox:removeWorkflow', id),
  triggerWorkflow: (id: string, inputs?: Record<string, string>): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('aibox:triggerWorkflow', id, inputs),
  getWorkflowRunState: (id: string): Promise<{ nodeId: string; status: string }[] | null> => ipcRenderer.invoke('aibox:getWorkflowRunState', id),
  publishWorkflowAsSkill: (id: string): Promise<{ ok: boolean; message: string; skillId?: string }> => ipcRenderer.invoke('aibox:publishWorkflowAsSkill', id),
  unpublishWorkflowSkill: (id: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('aibox:unpublishWorkflowSkill', id),
  // 外部工作流平台（Coze / Dify）
  listWfPlatforms: (): Promise<WfPlatformConfig[]> => ipcRenderer.invoke('aibox:listWfPlatforms'),
  saveWfPlatform: (input: { id?: string; name: string; baseUrl: string; token?: string }): Promise<WfPlatformConfig> => ipcRenderer.invoke('aibox:saveWfPlatform', input),
  removeWfPlatform: (id: string): Promise<void> => ipcRenderer.invoke('aibox:removeWfPlatform', id),
  testWfPlatform: (id: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('aibox:testWfPlatform', id),

  // 专家团
  listTeams: (): Promise<{ id: string; name: string; coordinatorId: string; memberIds: string[]; mode: string; createdAt: number }[]> => ipcRenderer.invoke('aibox:listTeams'),
  createTeam: (input: { name: string; coordinatorId: string; memberIds: string[]; mode?: 'coordinate' | 'roundtable' }): Promise<unknown> => ipcRenderer.invoke('aibox:createTeam', input),
  updateTeam: (id: string, patch: { name?: string; coordinatorId?: string; memberIds?: string[]; mode?: 'coordinate' | 'roundtable' }): Promise<void> => ipcRenderer.invoke('aibox:updateTeam', id, patch),
  removeTeam: (id: string): Promise<void> => ipcRenderer.invoke('aibox:removeTeam', id),
  triggerTeam: (id: string, task: string): Promise<{ ok: boolean; message: string; finalTaskId?: string }> => ipcRenderer.invoke('aibox:triggerTeam', id, task),

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

  // 引擎
  installEngine: (id: string): Promise<EngineInstallResult> => ipcRenderer.invoke('aibox:installEngine', id),
  detectEngines: (): Promise<Engine[]> => ipcRenderer.invoke('aibox:detectEngines'),
  getInstallGuide: (id: string): Promise<EngineInstallGuide | null> => ipcRenderer.invoke('aibox:getInstallGuide', id),
  updateEngine: (id: string): Promise<EngineInstallResult> => ipcRenderer.invoke('aibox:updateEngine', id),
  uninstallEngine: (id: string): Promise<EngineInstallResult> => ipcRenderer.invoke('aibox:uninstallEngine', id),
  getEngineLatestVersion: (id: string): Promise<string | null> => ipcRenderer.invoke('aibox:getEngineLatestVersion', id),
  checkRuntime: (): Promise<{ name: string; installed: boolean; version: string | null; path: string | null }[]> => ipcRenderer.invoke('aibox:checkRuntime'),
  installRuntime: (name: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('aibox:installRuntime', name),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('aibox:openExternal', url),
  authEngine: (id: string): Promise<void> => ipcRenderer.invoke('aibox:authEngine', id),
  setDefaultEngine: (id: string): Promise<void> => ipcRenderer.invoke('aibox:setDefaultEngine', id),

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
  toggleFullscreen: (): Promise<boolean> => ipcRenderer.invoke('aibox:toggleFullscreen'),
  isFullscreen: (): Promise<boolean> => ipcRenderer.invoke('aibox:isFullscreen'),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('aibox:pickDirectory'),
  storeSecret: (ref: string, secret: string): Promise<void> => ipcRenderer.invoke('aibox:storeSecret', ref, secret),
  hasSecret: (ref: string): Promise<boolean> => ipcRenderer.invoke('aibox:hasSecret', ref),

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
