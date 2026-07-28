/**
 * 共享领域模型 —— 依据《数字员工 AI Box 控制中心 PRD V1.0》
 * 第 3 章术语模型、7.3 分层状态模型、9.x 引擎、10.x 渠道、11.x 资源监控
 */

// ---------- 7.3 分层状态模型（四层不得混用） ----------

/** Agent 生命周期: DISABLED → STARTING → READY → STOPPING，异常进入 ERROR */
export type AgentLifecycle = 'DISABLED' | 'STARTING' | 'READY' | 'STOPPING' | 'ERROR';

/** 任务状态机 */
export type TaskStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'INTERRUPTED';

/** 引擎状态（SETUP_REQUIRED：内置 Hermes 未配置供应商，处于演示模式） */
export type EngineStatus =
  | 'NOT_INSTALLED'
  | 'INSTALLING'
  | 'SETUP_REQUIRED'
  | 'AUTH_REQUIRED'
  | 'HEALTHY'
  | 'DEGRADED'
  | 'ERROR';

/** 渠道状态 */
export type ChannelStatus =
  | 'UNCONFIGURED'
  | 'CONNECTING'
  | 'ONLINE'
  | 'RECONNECTING'
  | 'AUTH_EXPIRED'
  | 'DISABLED'
  | 'ERROR';

/** 首页派生状态（6.2 互斥归类: 异常/离线 > 执行中/待审批 > 暂停 > 排队/启动中 > 空闲） */
export type DerivedAgentStatus = 'error' | 'running' | 'paused' | 'starting' | 'idle';

/** readonly=只读 / standard=写入需审批 / trusted=全信任 / autonomous=完全自主（无需任何审批） */
export type PermissionMode = 'readonly' | 'standard' | 'trusted' | 'autonomous';

/** 数字员工能力开关（独立于权限模式，控制是否注册对应工具） */
export interface AgentCapabilities {
  /** 允许发起 HTTP/HTTPS 网络请求（web_search / http_request / MCP 远程调用） */
  network: boolean;
  /** 允许执行系统命令（run_command 工具） */
  shell: boolean;
  /** 允许安装软件包（install_package 工具：npm/pip/apt 等） */
  install: boolean;
  /** 允许浏览器自动化（Playwright / CDP：网页导航、点击、截图、JS执行） */
  browser: boolean;
  /** 允许桌面操控（Computer Use：屏幕截图、鼠标点击、键盘输入、滚动） */
  computer: boolean;
}

/** 引擎类型（四引擎收敛）：hermes = 内置 Nexus Agent 自研 Runtime；hermes-cli = 真实 Hermes Agent CLI；
 *  opencode = 编码专家；codex = 备选编码引擎；external = 配置文件接入的 ACP 引擎。
 *  claude-code / zcode / kimicode 已于 v26 下线。 */
export type EngineType = 'hermes' | 'hermes-cli' | 'codex' | 'opencode' | 'external';

export type ChannelType = 'weixin' | 'wecom' | 'feishu' | 'qq';

export type TaskSource = 'desktop' | 'channel' | 'schedule' | 'webhook' | 'delegated' | 'team';

// ---------- 核心实体（13.1 核心表） ----------

export type ProjectStatus = 'planning' | 'active' | 'paused' | 'completed' | 'archived';

/** 经营项目：承接目标，并统一关联任务、专家团运行与成果。 */
export interface Project {
  id: string;
  name: string;
  objective: string;
  description: string;
  clientName: string;
  status: ProjectStatus;
  color: string;
  dueAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectInput {
  name: string;
  objective?: string;
  description?: string;
  clientName?: string;
  status?: Exclude<ProjectStatus, 'archived'>;
  color?: string;
  dueAt?: number | null;
}

export type ProjectPatch = Partial<Omit<ProjectInput, 'status'>> & { status?: ProjectStatus };

export type ProjectHealth = 'on_track' | 'attention' | 'at_risk' | 'completed' | 'inactive';
export type ProjectRiskKind =
  | 'overdue' | 'due_soon' | 'empty_plan' | 'paused_project'
  | 'failed_task' | 'waiting_approval' | 'paused_task'
  | 'rejected_deliverable' | 'rework_deliverable' | 'pending_acceptance';

export interface ProjectRiskItem {
  id: string;
  projectId: string;
  projectName: string;
  kind: ProjectRiskKind;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  count: number;
}

export interface ProjectOperationsOwner {
  agentId: string;
  name: string;
  role: string;
  totalTasks: number;
  completedTasks: number;
  activeTasks: number;
  failedTasks: number;
}

export interface ProjectOperationsItem {
  project: Project;
  health: ProjectHealth;
  progress: number;
  acceptanceRate: number;
  recentActivityAt: number;
  tasks: {
    total: number;
    completed: number;
    active: number;
    failed: number;
    waitingApproval: number;
    paused: number;
  };
  deliverables: {
    total: number;
    accepted: number;
    rejected: number;
    rework: number;
    unmarked: number;
  };
  owners: ProjectOperationsOwner[];
  risks: ProjectRiskItem[];
}

export interface ProjectOperationsOverview {
  generatedAt: number;
  summary: {
    totalProjects: number;
    openProjects: number;
    atRiskProjects: number;
    overdueProjects: number;
    taskCompletionRate: number;
    acceptedDeliverables: number;
    pendingAcceptance: number;
  };
  statusDistribution: Record<ProjectStatus, number>;
  projects: ProjectOperationsItem[];
  risks: ProjectRiskItem[];
}

export interface Agent {
  id: string;
  name: string;
  role: string;             // 职责描述
  systemPrompt: string;
  /** 人设配置（结构化，组合为完整 system prompt） */
  soulMd: string;           // soul.md：身份/性格/语气/价值观
  agentsMd: string;         // agents.md：行为指令/工具使用规则/约束
  userMd: string;           // user.md：用户画像/偏好/背景信息
  lifecycle: AgentLifecycle;
  engineId: string;
  workspace: string;
  permissionMode: PermissionMode;
  /** 能力开关（网络/命令/安装），未配置时默认全关 */
  capabilities: AgentCapabilities;
  /** 标签分组（如"前端组"/"运营组"） */
  tags: string[];
  /** 模型参数覆盖（每个员工可独立设置） */
  modelOverrides?: { temperature?: number; topP?: number; maxTokens?: number };
  /** 模型名覆盖（留空则用供应商默认模型） */
  modelOverride?: string;
  concurrencyLimit: number;
  archived: boolean;
  avatarColor: string;      // 卡片主题色
  createdAt: number;
  updatedAt: number;
}

export interface Engine {
  id: string;
  type: EngineType;
  name: string;
  version: string | null;
  path: string | null;
  status: EngineStatus;
  authStatus: 'unknown' | 'authed' | 'expired' | 'required';
  isDefault: boolean;
  runningInstances: number;
  dataBoundary: string;     // 数据发送目标（15.1：外部引擎必须展示数据发送方）
  installable: boolean;     // 是否支持客户端内自动安装（存在可用 npm 包）
  /** 引擎运行配置 */
  config?: { runArgs?: string[]; env?: Record<string, string>; maxConcurrency?: number };
  /** 引擎性能指标 */
  metrics?: { avgLatencyMs?: number; successRate?: number; totalRuns?: number };
}

/** 引擎日志条目 */
export interface EngineLogEntry {
  id: string;
  engineId: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  timestamp: number;
}

/** 引擎自动安装结果 */
export interface EngineInstallResult {
  ok: boolean;
  message: string;
}

/** 引擎安装指引（无法自动安装时展示官方手工步骤） */
export interface EngineInstallGuide {
  guide: string;
  url: string | null;
}

/** 应用配置文件（userData/aibox-data/aibox.config.json） */
export interface AppConfig {
  /** npm 全局安装默认下载地址（registry） */
  npmRegistry: string;
  /** 按引擎覆写：可执行名 / npm 包名 / 非交互运行参数（{prompt} 占位）；
   *  外部 ACP 引擎：新增条目提供 name + acpCommand 即可接入引擎中心 */
  engines: Record<string, { bin?: string; npmPackage?: string; runArgs?: string[]; name?: string; acpCommand?: string[] }>;
}

/** 定时任务（P3a：到期自动创建 source='schedule' 的任务） */
export interface Schedule {
  id: string;
  agentId: string | null;
  projectId: string | null;
  automationKind: AutomationScheduleKind;
  title: string;
  /** 任务详细指令/prompt（作为任务内容派发） */
  content: string;
  cronKind: 'interval' | 'daily' | 'weekly' | 'monthly';
  /** interval: 小时数；daily: "HH:mm"；weekly: "星期(0-6)|HH:mm"；monthly: "日(1-28)|HH:mm" */
  cronValue: string;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number;
}

export interface ScheduleInput {
  agentId?: string;
  projectId?: string;
  automationKind?: AutomationScheduleKind;
  title: string;
  content?: string;
  cronKind: Schedule['cronKind'];
  cronValue: string;
}

// ---------- 经营自动化 ----------

export type AutomationScheduleKind = 'task' | 'project_inspection' | 'weekly_report' | 'monthly_report';
export type AutomationReportKind = Exclude<AutomationScheduleKind, 'task'>;
export type AutomationFindingKind = 'overdue' | 'low_quality' | 'duplicate_work' | 'budget';

export interface AutomationFinding {
  id: string;
  kind: AutomationFindingKind;
  projectId: string;
  projectName: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  count: number;
  detectedAt: number;
}

export interface AutomationReportMetrics {
  taskTotal: number;
  taskCompleted: number;
  deliverableTotal: number;
  acceptedDeliverables: number;
  totalTokens: number;
  estimatedCost: number;
  runtimeMs: number;
}

export interface AutomationReport {
  id: string;
  scheduleId: string | null;
  projectId: string;
  projectName: string;
  kind: AutomationReportKind;
  title: string;
  periodStart: number;
  periodEnd: number;
  metrics: AutomationReportMetrics;
  findings: AutomationFinding[];
  content: string;
  trigger: 'manual' | 'scheduled';
  createdAt: number;
}

export interface ProjectBudget {
  projectId: string;
  projectName: string;
  tokenLimit: number;
  costLimit: number;
  warningPercent: number;
  spentTokens: number;
  spentCost: number;
  runtimeMs: number;
  usagePercent: number;
  status: 'unset' | 'normal' | 'warning' | 'exceeded';
  updatedAt: number | null;
}

export interface ProjectBudgetInput {
  tokenLimit: number;
  costLimit: number;
  warningPercent: number;
}

export interface AssigneeRecommendation {
  agentId: string;
  agentName: string;
  role: string;
  score: number;
  activeTasks: number;
  completedTasks: number;
  projectExperience: number;
  successRate: number;
  reason: string;
}

export type CustomerDeliveryStatus = 'draft' | 'delivered' | 'accepted';

export interface CustomerDelivery {
  id: string;
  projectId: string;
  projectName: string;
  customerName: string;
  title: string;
  status: CustomerDeliveryStatus;
  deliverableIds: string[];
  note: string;
  deliveredAt: number | null;
  acceptedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CustomerDeliveryInput {
  projectId: string;
  customerName: string;
  title: string;
  deliverableIds: string[];
  note?: string;
}

export interface AutomationAuditItem {
  id: string;
  actor: string;
  action: string;
  target: string;
  result: string;
  source: string;
  createdAt: number;
}

export interface AutomationOverview {
  generatedAt: number;
  summary: {
    activePlans: number;
    highRiskFindings: number;
    reportsThisMonth: number;
    overBudgetProjects: number;
    pendingDeliveries: number;
  };
  findings: AutomationFinding[];
  reports: AutomationReport[];
  budgets: ProjectBudget[];
  deliveries: CustomerDelivery[];
  auditLogs: AutomationAuditItem[];
}

export interface Task {
  id: string;
  agentId: string;
  projectId: string | null;
  title: string;
  source: TaskSource;
  parentId: string | null;
  status: TaskStatus;
  priority: number;
  progress: number;         // 0-100
  stage: string;            // 当前阶段描述
  error: string | null;
  result: string | null;    // 执行产物全文（截断 16KB）
  quality: TaskQuality;     // 人工质量标记（成果管理）
  sessionId: string | null; // 会话锚点（CLI resume / LLM 上下文重建，追问时继承）
  workspaceOverride: string | null; // 任务级工作空间覆盖（团队共享工作空间）
  /** 任务级引擎覆盖（E-2 编码委派：主引擎把编码类子任务交给 OpenCode 执行，员工归属不变） */
  engineOverride: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

/** 任务产出的人工质量标记 */
export type TaskQuality = 'accepted' | 'rejected' | 'rework' | null;

// ---------- 成果验收闭环 ----------

export type DeliverableSourceType = 'task' | 'team_run';
export type DeliverableOwnerType = 'agent' | 'team';
export type DeliverableType = 'document' | 'report' | 'code' | 'data' | 'design' | 'other';
export type DeliverableReviewStatus = 'unmarked' | 'accepted' | 'rejected' | 'rework';
export type DeliverableVersionOrigin = 'source' | 'manual' | 'rework';

export interface DeliverableSummary {
  id: string;
  sourceType: DeliverableSourceType;
  sourceId: string;
  projectId: string | null;
  projectName: string | null;
  ownerType: DeliverableOwnerType;
  ownerId: string;
  ownerName: string;
  ownerRole: string;
  title: string;
  type: DeliverableType;
  tags: string[];
  reviewStatus: DeliverableReviewStatus;
  reviewNote: string;
  latestVersion: number;
  versionCount: number;
  preview: string;
  createdAt: number;
  updatedAt: number;
  sourceUpdatedAt: number;
}

export interface DeliverableVersion {
  id: string;
  deliverableId: string;
  version: number;
  content: string;
  changeNote: string;
  origin: DeliverableVersionOrigin;
  createdBy: string;
  createdAt: number;
}

export interface DeliverableReviewEvent {
  id: string;
  deliverableId: string;
  status: DeliverableReviewStatus;
  note: string;
  reviewer: string;
  reworkRef: string | null;
  createdAt: number;
}

export interface DeliverableTrace {
  project: { id: string; name: string; status: ProjectStatus } | null;
  source: { type: DeliverableSourceType; id: string; title: string; status: string; createdAt: number };
  owner: { type: DeliverableOwnerType; id: string; name: string; role: string };
}

export interface DeliverableDetail extends DeliverableSummary {
  latestContent: string;
  versions: DeliverableVersion[];
  reviews: DeliverableReviewEvent[];
  trace: DeliverableTrace;
}

export interface DeliverableMetaPatch {
  type?: DeliverableType;
  tags?: string[];
}

export interface DeliverableVersionInput {
  content: string;
  changeNote: string;
  origin?: Exclude<DeliverableVersionOrigin, 'source'>;
}

export interface DeliverableReviewInput {
  status: DeliverableReviewStatus;
  note: string;
  createRework?: boolean;
}

export interface ProjectDeliverablePackage {
  project: Project;
  generatedAt: number;
  summary: {
    total: number;
    accepted: number;
    rejected: number;
    rework: number;
    unmarked: number;
  };
  deliverables: Array<DeliverableSummary & { latestContent: string }>;
}

// ---------- 项目知识库 ----------

export type KnowledgeSourceType = 'manual' | 'deliverable';
export type KnowledgeCategory = 'decision' | 'playbook' | 'research' | 'reference' | 'lesson' | 'other';
export type KnowledgeStatus = 'active' | 'archived';
export type KnowledgeVersionOrigin = 'manual' | 'deliverable';

export interface KnowledgeSummary {
  id: string;
  projectId: string;
  projectName: string;
  sourceType: KnowledgeSourceType;
  sourceId: string;
  title: string;
  category: KnowledgeCategory;
  tags: string[];
  pinned: boolean;
  status: KnowledgeStatus;
  latestVersion: number;
  versionCount: number;
  preview: string;
  usageCount: number;
  lastUsedAt: number | null;
  sourceUpdatedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeVersion {
  id: string;
  knowledgeId: string;
  version: number;
  content: string;
  changeNote: string;
  origin: KnowledgeVersionOrigin;
  createdBy: string;
  createdAt: number;
}

export interface KnowledgeTrace {
  project: { id: string; name: string; status: ProjectStatus };
  source: { type: KnowledgeSourceType; id: string; title: string; deliverableId: string | null };
}

export interface KnowledgeDetail extends KnowledgeSummary {
  latestContent: string;
  versions: KnowledgeVersion[];
  trace: KnowledgeTrace;
}

export interface KnowledgeInput {
  projectId: string;
  title: string;
  content: string;
  category?: KnowledgeCategory;
  tags?: string[];
  pinned?: boolean;
}

export interface KnowledgePatch {
  title?: string;
  category?: KnowledgeCategory;
  tags?: string[];
  pinned?: boolean;
  status?: KnowledgeStatus;
}

export interface KnowledgeVersionInput {
  content: string;
  changeNote: string;
}

export interface KnowledgeQuery {
  projectId?: string;
  category?: KnowledgeCategory;
  sourceType?: KnowledgeSourceType;
  status?: KnowledgeStatus | 'all';
  search?: string;
}

// ---------- 全局检索与行动中心 ----------

export type SearchEntityType = 'project' | 'agent' | 'task' | 'team' | 'deliverable' | 'knowledge';
export type SearchRoute = 'projects' | 'agents' | 'tasks' | 'teams' | 'deliverables' | 'knowledge';

export interface GlobalSearchResult {
  key: string;
  entityType: SearchEntityType;
  entityId: string;
  route: SearchRoute;
  title: string;
  subtitle: string;
  status: string;
  projectId: string | null;
  updatedAt: number;
}

export type ActionCenterKind = 'approval' | 'failed_task' | 'team_run' | 'deliverable' | 'project_risk';

export interface ActionCenterItem {
  key: string;
  fingerprint: string;
  kind: ActionCenterKind;
  title: string;
  owner: string;
  reason: string;
  suggestion: string;
  severity: 'info' | 'warn' | 'danger';
  createdAt: number;
  target: { route: SearchRoute; entityType: SearchEntityType; entityId: string };
  approvalId: string | null;
}

export interface ActionCenterOverview {
  generatedAt: number;
  total: number;
  counts: Record<ActionCenterKind, number>;
  items: ActionCenterItem[];
}

/** 任务执行事件（13.2 审计可追溯；详情页时间线） */
export interface TaskEvent {
  id: string;
  taskId: string;
  eventType: string;        // started/progress/output/result/completed/failed/...
  payload: Record<string, unknown>;
  createdAt: number;
}

/** 执行器类型：真实 LLM API / 真实 CLI（含泛化 CLI）/ ACP 协议 / 演示模拟 */
export type ExecutorKind = 'llm-api' | 'codex-cli' | 'claude-cli' | 'generic-cli' | 'acp' | 'simulated';

/** 模型供应商配置（脱敏视图：密钥不离开主进程，15.1） */
export interface ProviderConfig {
  baseUrl: string;
  model: string;
  hasKey: boolean;
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  error: string | null;
}

export interface AgentRun {
  id: string;
  agentId: string;
  taskId: string;
  pid: number | null;
  sessionId: string;
  status: TaskStatus;
  startedAt: number;
  endedAt: number | null;
}

export interface Channel {
  id: string;
  type: ChannelType;
  accountName: string;
  status: ChannelStatus;
  boundAgentIds: string[];
  lastConnectedAt: number | null;
  limitation: string;       // 已知限制/风险（10.2，例如微信普通群不可用）
}

export interface Approval {
  id: string;
  taskId: string;
  agentId: string;
  type: 'write_workspace' | 'outside_workspace' | 'delete' | 'network' | 'install' | 'admin';
  request: string;          // 请求描述（命令、路径、预期影响）
  risk: 'low' | 'medium' | 'high';
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  decidedAt: number | null;
}

export interface AuditLog {
  id: string;
  actor: string;
  action: string;
  target: string;
  result: string;
  source: string;
  createdAt: number;
}

// ---------- 11.x 资源监控 ----------

export interface ResourceSample {
  timestamp: number;
  cpu: number | null;          // 总利用率 %，采集失败为 null（显示未知，不伪造 0）
  cpuCores: number;
  memoryUsed: number;          // bytes
  memoryTotal: number;
  memoryPercent: number | null;
  gpu: GpuSample | null;       // 无 GPU 显示"未检测到"
  diskFree: number;            // 数据目录剩余 bytes
  diskTotal: number;
  networkOnline: boolean;
}

export interface GpuSample {
  name: string;
  utilization: number | null;  // %
  vramUsed: number | null;     // bytes
  vramTotal: number | null;
  temperature: number | null;  // ℃
}

export interface ServiceHealth {
  runtime: 'healthy' | 'degraded' | 'offline';
  gateway: 'healthy' | 'degraded' | 'offline';
  database: 'healthy' | 'degraded' | 'offline';
}

// ---------- 6.2 首页统计 ----------

export interface DashboardStats {
  totalAgents: number;
  running: number;
  idle: number;
  pausedOrStarting: number;
  errorOrOffline: number;
  activeTasks: number;      // RUNNING+QUEUED+WAITING_APPROVAL+PAUSED
  pendingTodos: number;     // 待确认/待审批/待补充
  todayCompleted: number;
}

/** 待办事项（6.2 待处理事项列表） */
export interface TodoItem {
  id: string;
  title: string;
  owner: string;
  dueText: string;
  severity: 'high' | 'medium' | 'low' | 'info';
  kind: 'approval' | 'task' | 'channel' | 'system';
}

// ---------- IPC 事件负载 ----------

export interface AgentCardView {
  agent: Agent;
  derivedStatus: DerivedAgentStatus;
  currentTask: { id: string; title: string; progress: number; stage: string; executor: ExecutorKind } | null;
  uptimeText: string;
  channels: ChannelType[];
  engineName: string;
  /** 该助手当前使用的模型名称（provider 解析后） */
  modelName: string;
  needsAttention: boolean;
  /** 该助手绑定的 Skills 名称列表 */
  skills: string[];
  /** 该助手可用的 MCP 服务器名称列表（含 global + 专属） */
  mcpServers: string[];
}

export interface CreateAgentInput {
  name: string;
  role: string;
  systemPrompt: string;
  soulMd?: string;
  agentsMd?: string;
  userMd?: string;
  engineId: string;
  workspace: string;
  permissionMode: PermissionMode;
  concurrencyLimit: number;
  channelIds: string[];
}

/** 助手人设更新载荷 */
export interface AgentPersonaPatch {
  name?: string;
  role?: string;
  systemPrompt?: string;
  soulMd?: string;
  agentsMd?: string;
  userMd?: string;
  permissionMode?: PermissionMode;
  /** 能力开关（网络/命令/安装） */
  capabilities?: Partial<AgentCapabilities>;
  /** 标签分组 */
  tags?: string[];
  /** 模型参数覆盖 */
  modelOverrides?: { temperature?: number; topP?: number; maxTokens?: number };
  /** 执行引擎 ID */
  engineId?: string;
  /** 模型名覆盖 */
  modelOverride?: string;
}

/** 会话（每个助手可持续多轮对话，上下文跨任务保持） */
export interface Conversation {
  id: string;
  agentId: string;
  title: string;
  lastMessageAt: number;
  messageCount: number;
}

export interface SystemInfo {
  platform: string;
  osVersion: string;
  hostname: string;
  uptimeSec: number;
  appVersion: string;
}

// ---------- 统一执行事件（9.4） ----------

export type ExecutionEventType =
  | 'started' | 'message_delta' | 'tool_call' | 'tool_result'
  | 'approval_required' | 'progress' | 'artifact' | 'usage'
  | 'completed' | 'failed' | 'cancelled' | 'heartbeat';

export interface ExecutionEvent {
  type: ExecutionEventType;
  runId: string;
  taskId: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

// ---------- 可视化工作流引擎 ----------

/** 工作流节点类型 */
export type WfNodeType = 'ai' | 'cli' | 'python' | 'http' | 'coze' | 'dify' | 'condition' | 'loop' | 'delay' | 'subflow' | 'start' | 'end';

/** 工作流节点配置（按类型不同字段不同） */
export interface WfNodeConfig {
  // AI 节点
  prompt?: string;
  model?: string;
  temperature?: number;
  // CLI 节点
  command?: string;
  args?: string[];
  cwd?: string;
  // Python 节点
  script?: string;
  scriptPath?: string;
  pythonArgs?: string[];
  // HTTP 节点
  url?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  // Coze 工作流节点
  cozeWorkflowId?: string;
  cozeInputs?: Record<string, string>;
  // Dify 工作流节点
  difyWorkflowId?: string;
  difyInputs?: Record<string, string>;
  // 条件分支节点
  condition?: string;           // 条件表达式，如 "{{node1}} != ''"
  trueTarget?: string;          // 条件为真时的目标节点 ID
  falseTarget?: string;         // 条件为假时的目标节点 ID
  // 循环节点
  loopVariable?: string;        // 循环变量名（引用上下文中的列表）
  loopItems?: string;           // 循环项（逗号分隔或变量引用）
  loopBody?: string;            // 循环体内执行的节点 ID 列表（逗号分隔）
  // 延时节点
  delaySeconds?: number;        // 延时秒数
  // 子工作流节点
  subflowId?: string;           // 引用的子工作流 ID
  subflowInputs?: Record<string, string>; // 传入子工作流的参数
  // 错误处理（通用）
  retryCount?: number;          // 失败重试次数（0=不重试）
  retryDelay?: number;          // 重试间隔（秒）
  fallbackNodeId?: string;      // 失败降级目标节点 ID
  // 通用
  platformRef?: string;
  outputVar?: string;
  timeout?: number;
}

/** 外部工作流平台凭据配置（存 settings 表，Token 走 safeStorage） */
export interface WfPlatformConfig {
  id: string;
  name: string;
  baseUrl: string;
  hasToken: boolean;
}

export interface WfNode {
  id: string;
  type: WfNodeType;
  label: string;
  position: { x: number; y: number };
  config: WfNodeConfig;
}

export interface WfEdge {
  id: string;
  source: string;
  target: string;
}

/** 工作流全局变量定义 */
export interface WfVariable {
  name: string;
  defaultValue: string;
  description?: string;
}

export interface WorkflowDef {
  id: string;
  name: string;
  description: string;
  nodes: WfNode[];
  edges: WfEdge[];
  variables?: WfVariable[];    // 全局变量
  version?: number;            // 版本号
  status: 'idle' | 'running' | 'completed' | 'failed';
  publishedAsSkill: boolean;
  skillId: string | null;
  createdAt: number;
  lastRunAt: number | null;
}

/** 工作流执行历史记录 */
export interface WfRunRecord {
  id: string;
  workflowId: string;
  status: 'running' | 'completed' | 'failed';
  error: string | null;
  nodeResults: Record<string, { status: string; output?: string; error?: string }>;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
}

/** 工作流校验结果 */
export interface WfValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** 工作流节点执行事件（实时推送到前端） */
export interface WfNodeEvent {
  workflowId: string;
  nodeId: string;
  status: 'running' | 'completed' | 'failed';
  output?: string;
  error?: string;
  timestamp: number;
}

// ---------- 多机协同 ----------

/** 协同工作区状态 */
export type CollabWorkspaceStatus = 'idle' | 'active' | 'stopped';

/** 协同子任务状态 */
export type CollabTaskStatus = 'pending' | 'claimed' | 'in_progress' | 'submitted' | 'accepted' | 'rejected';

/** 远程 Agent 状态 */
export type CollabAgentStatus = 'online' | 'offline';

export interface CollabWorkspace {
  id: string;
  name: string;
  repoPath: string;
  conventions: string;
  gitRules: string;
  mcpPort: number;
  gitPort: number;
  status: CollabWorkspaceStatus;
  createdAt: number;
}

export interface CollabTask {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  branchName: string;
  status: CollabTaskStatus;
  assignedAgent: string | null;
  assignedAt: number | null;
  submittedAt: number | null;
  reviewResult: string | null;
  createdAt: number;
}

export interface CollabAgent {
  id: string;
  workspaceId: string;
  name: string;
  endpoint: string;
  status: CollabAgentStatus;
  lastHeartbeat: number;
  connectedAt: number;
}

/** 协同连接信息（供远程 Agent 配置） */
export interface CollabConnectInfo {
  mcpUrl: string;
  gitUrl: string;
  token: string;
  workspaceName: string;
}

// ---------- 专家团流水线 ----------

/** 团队执行子任务状态（retrying = 重试中；skipped = 被人工跳过） */
export type TeamRunSubtaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'retrying' | 'skipped';

/** 团队执行流水线阶段（cancelled = 人工取消） */
export type TeamRunPhase = 'clarify' | 'decompose' | 'execute' | 'review' | 'done' | 'failed' | 'cancelled';

export interface TeamRunSubtask {
  agent: string;          // 成员名
  agentId: string;
  subtask: string;
  taskId: string | null;
  status: TeamRunSubtaskStatus;
  output?: string;        // 子任务执行输出
  round?: number;         // 调度轮次（主Agent第几轮分派）
  retryCount?: number;    // 已重试次数
}

export interface TeamRun {
  id: string;
  teamId: string;
  projectId: string | null;
  taskText: string;
  phase: TeamRunPhase;
  currentStep: number;
  totalSteps: number;
  subtasks: TeamRunSubtask[];
  /** 时间线事件流（阶段/轮次/子任务完成/主Agent决策），供执行时间线可视化 */
  events: TeamTimelineEvent[];
  /** 从团队运行到项目、内部任务与最终成果的可追溯链路 */
  trace: TeamRunTrace;
  finalResult: string | null;
  error: string | null;
  createdAt: number;
  endedAt: number | null;
  durationMs: number | null;
}

/** 专家团执行时间线事件（主Agent调度循环的每个关键节点 + 人工干预标记） */
export type TeamTimelineEvent =
  | { type: 'phase'; phase: 'clarify' | 'decompose' | 'review'; ts: number }
  | { type: 'round_start'; round: number; count: number; ts: number }
  | { type: 'subtask_done'; round: number; agent: string; agentId: string; status: 'done' | 'failed'; durationMs: number; ts: number }
  | { type: 'decision'; round: number; action: 'finish' | 'continue'; summary: string; reasoning?: string; ts: number }
  | { type: 'cancelled'; ts: number }
  | { type: 'skipped'; round: number; agent: string; ts: number }
  | { type: 'guidance'; message: string; ts: number }
  | { type: 'intervention'; action: 'guidance' | 'skip' | 'force_retry' | 'manual_retry' | 'cancel'; message: string; agent?: string; ts: number }
  | { type: 'review'; status: 'passed' | 'partial' | 'failed'; summary: string; ts: number };

export interface TeamRunTrace {
  project: { id: string; name: string } | null;
  tasks: { id: string; agentId: string; agentName: string }[];
  deliverable: { id: string; title: string; reviewStatus: DeliverableReviewStatus } | null;
}

export interface TeamMemberContribution {
  agentId: string;
  name: string;
  role: string;
  teamRole: 'coordinator' | 'expert';
  assigned: number;
  completed: number;
  failed: number;
  skipped: number;
  retries: number;
  decisions: number;
  completionRate: number;
  avgDurationMs: number;
}

export interface TeamProjectContribution {
  projectId: string;
  projectName: string;
  runCount: number;
  deliverableCount: number;
  acceptedDeliverables: number;
  lastRunAt: number;
}

export interface TeamDecisionRecord {
  runId: string;
  taskText: string;
  round: number;
  action: 'finish' | 'continue';
  summary: string;
  reasoning?: string;
  createdAt: number;
}

export interface TeamCollaborationOverview {
  teamId: string;
  metrics: {
    totalRuns: number;
    activeRuns: number;
    successRate: number;
    avgDurationMs: number;
    projectCount: number;
    deliverableCount: number;
    acceptedDeliverables: number;
    interventionCount: number;
  };
  members: TeamMemberContribution[];
  projects: TeamProjectContribution[];
  recentDecisions: TeamDecisionRecord[];
}

/** 团队配置 */
export interface TeamConfig {
  timeout: number;        // 单步超时（秒）
  maxRetries: number;     // 失败重试次数
  concurrency: number;    // 并行执行数
}
