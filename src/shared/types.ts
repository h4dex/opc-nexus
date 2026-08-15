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

/** 数字员工身份。Android 操作员由 Hermes CLI + Mobile Gateway 专用执行链路驱动。 */
export type AgentKind = 'general' | 'android_operator';

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
  /** 允许使用经 OPC-Nexus Mobile Gateway 授权的 Android 工具。 */
  mobile: boolean;
}

// ---------- Android 手机员工 ----------

export type MobileToolGroup = 'management' | 'interface' | 'privacy' | 'communication' | 'media';

/** 与 mobile/tool-catalog.json 一一对应；Catalog 是运行时注册与 Schema 的唯一来源。 */
export type MobileToolName =
  | 'android_setup' | 'android_ping' | 'android_read_screen' | 'android_screenshot'
  | 'android_tap' | 'android_tap_text' | 'android_type' | 'android_swipe'
  | 'android_scroll' | 'android_open_app' | 'android_press_key' | 'android_wait'
  | 'android_get_apps' | 'android_current_app' | 'android_long_press' | 'android_drag'
  | 'android_pinch' | 'android_find_nodes' | 'android_describe_node' | 'android_screen_hash'
  | 'android_diff_screen' | 'android_location' | 'android_search_contacts' | 'android_send_sms'
  | 'android_call' | 'android_media' | 'android_send_intent' | 'android_broadcast'
  | 'android_clipboard_read' | 'android_clipboard_write' | 'android_notifications' | 'android_events'
  | 'android_event_stream' | 'android_screen_record' | 'android_mic_record' | 'android_mic_stop'
  | 'android_mic_status' | 'android_mic_fetch' | 'android_read_widgets' | 'android_speak'
  | 'android_speak_stop' | 'android_macro';

export type MobilePermissionName =
  | 'accessibility' | 'screen_capture' | 'media_projection' | 'notification_access'
  | 'location' | 'contacts' | 'sms' | 'phone' | 'microphone' | 'clipboard' | 'tts';

export type MobilePermissionState = 'granted' | 'denied' | 'restricted' | 'not_available' | 'unknown';
export type MobileDeviceStatus = 'offline' | 'pairing' | 'authenticating' | 'online' | 'busy' | 'error';

export interface MobileToolCatalogEntry {
  name: MobileToolName;
  description: string;
  group: MobileToolGroup;
  parameters: Record<string, unknown>;
  permissions: MobilePermissionName[];
  sensitiveFields: string[];
  nonIdempotent: boolean;
  artifactKind?: MobileArtifactKind;
}

export interface MobileToolCatalog {
  protocolVersion: number;
  upstreamCommit: string;
  tools: MobileToolCatalogEntry[];
}

export interface MobileDevice {
  id: string;
  name: string;
  model: string;
  manufacturer: string;
  androidVersion: string;
  apiLevel: number;
  appVersion: string;
  protocolVersion: number;
  identityPublicKey: string;
  identityFingerprint: string;
  status: MobileDeviceStatus;
  permissions: Partial<Record<MobilePermissionName, MobilePermissionState>>;
  capabilities: Record<string, boolean>;
  pairedAt: number;
  lastSeenAt: number | null;
  lastIp: string | null;
  boundAgentId: string | null;
  activeTaskId: string | null;
}

export interface MobileAgentConfig {
  agentId: string;
  deviceId: string | null;
  hermesProfile: string;
  allowedTools: MobileToolName[];
  authorizationConfirmedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type MobileControlSessionStatus = 'active' | 'completed' | 'failed' | 'cancelled' | 'expired' | 'disconnected';

export interface MobileControlSession {
  id: string;
  agentId: string;
  deviceId: string;
  /** 控制台和脚本会话不属于 Hermes 任务，因此允许为空。 */
  taskId: string | null;
  status: MobileControlSessionStatus;
  allowedTools: MobileToolName[];
  startedAt: number;
  expiresAt: number;
  endedAt: number | null;
}

export type MobileCommandStatus = 'queued' | 'running' | 'completed' | 'failed' | 'restricted' | 'not_available' | 'permission_denied' | 'unknown_after_disconnect';

export interface MobileCommandLog {
  id: string;
  sessionId: string | null;
  agentId: string | null;
  deviceId: string;
  taskId: string | null;
  toolName: MobileToolName;
  status: MobileCommandStatus;
  requestSummary: Record<string, unknown>;
  resultSummary: Record<string, unknown>;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
}

export type MobileArtifactKind = 'screenshot' | 'screen_recording' | 'audio';

export interface MobileArtifact {
  id: string;
  deviceId: string;
  agentId: string | null;
  taskId: string | null;
  commandId: string | null;
  kind: MobileArtifactKind;
  mimeType: string;
  filename: string;
  size: number;
  sha256: string;
  uri: string;
  createdAt: number;
}

export type MobileScriptFailurePolicy = 'stop' | 'continue';

export interface MobileScriptStep {
  tool: Exclude<MobileToolName, 'android_macro' | 'android_setup'>;
  args: Record<string, unknown>;
  delayAfterMs?: number;
  onFailure?: MobileScriptFailurePolicy;
}

export interface MobileScriptDefinition {
  id: string;
  name: string;
  description: string;
  agentId: string | null;
  deviceId: string | null;
  steps: MobileScriptStep[];
  createdAt: number;
  updatedAt: number;
}

export interface MobilePairingOffer {
  id: string;
  protocolVersion: number;
  host: string;
  port: number;
  certificateFingerprint: string;
  expiresAt: number;
  qrUri: string;
}

export type MobileEventType =
  | 'gateway_started' | 'gateway_stopped' | 'pairing_created' | 'device_paired'
  | 'device_connected' | 'device_disconnected' | 'device_updated' | 'binding_changed'
  | 'session_started' | 'session_ended' | 'command_started' | 'command_finished'
  | 'preview_updated' | 'artifact_created' | 'emergency_stop';

export interface MobileEvent {
  type: MobileEventType;
  deviceId?: string;
  agentId?: string;
  taskId?: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

export interface MobileGatewayStatus {
  running: boolean;
  host: string | null;
  wssPort: number | null;
  pluginPort: number | null;
  certificateFingerprint: string | null;
  error: string | null;
}

export interface MobileAdbDevice {
  serial: string;
  state: 'device' | 'offline' | 'unauthorized' | 'unknown';
  model: string;
  product: string;
  transportId: string | null;
}

export interface MobileApkInfo {
  available: boolean;
  packageName: string;
  versionName: string;
  sha256: string;
  signerSha256: string;
  releaseSigned: boolean;
  error: string | null;
}

/** Runtime types: Nexus/Hermes are control-capable runtimes; Codex, Claude,
 * Pi and OpenCode are Worker CLIs; external is an ACP adapter. */
export type EngineType = 'hermes' | 'hermes-cli' | 'codex' | 'claude' | 'pi' | 'opencode' | 'external';

export type ChannelType = 'weixin' | 'wecom' | 'feishu' | 'qq';

/** voice = 语音下达（经确认后派发，审计与统计可与手动派发区分） */
export type TaskSource = 'desktop' | 'channel' | 'schedule' | 'webhook' | 'delegated' | 'team' | 'voice';

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
  kind: AgentKind;
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

/**
 * 引擎四级探活信号（发布要求）：把「健康」拆成可解释的独立维度，逐级递进。
 * 只有四项全通过才应显示 HEALTHY —— 仅 detected 就标健康会让用户以为能用，
 * 实际一跑就 ENOENT / EPERM / 参数错。
 */
export interface EngineHealthSignals {
  /** 已定位到可执行文件（where/which 命中） */
  detected: boolean;
  /** 进程能真正启动（Windows 上 npm shim / .cmd / Store 应用各有坑） */
  launchable: boolean;
  /** 凭据有效（非 401 / 未登录） */
  authenticated: boolean;
  /** 最小任务真的产出了结果 */
  taskVerified: boolean;
  /** 最近一次探活的原始输出片段，供用户自查 */
  detail: string;
  /** 探活时间戳 */
  checkedAt?: number;
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
  /** 四级探活信号（未探活过则为 undefined） */
  healthSignals?: EngineHealthSignals;
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
  conversationId: string | null;
  inputMessageId: string | null;
  title: string;
  /** Full execution instruction. title is only the bounded display label. */
  content: string;
  source: TaskSource;
  parentId: string | null;
  status: TaskStatus;
  priority: number;
  progress: number;         // 0-100
  stage: string;            // 当前阶段描述
  error: string | null;
  result: string | null;    // 执行产物全文（截断 16KB）
  /** 列表快照不携带结果正文时，用此标记保留“已有产物”语义。 */
  hasResult?: boolean;
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
export type ExecutorKind = 'llm-api' | 'codex-cli' | 'claude-cli' | 'pi-cli' | 'generic-cli' | 'acp' | 'simulated' | 'unavailable';

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

/** Renderer-visible preferences. Internal settings and secret:* entries are excluded. */
export interface RendererSettingMap {
  theme: 'dark' | 'light';
  thresholds: { cpu: number; mem: number; gpuTemp: number };
  notifications: boolean;
  demoAutoTasks: boolean;
  'memory:autoAcceptConversationProposals': boolean;
}

export type RendererSettingKey = keyof RendererSettingMap;

export interface ApiBridgeStatus {
  running: boolean;
  port: number;
  keyConfigured: boolean;
  enabled: boolean;
}

export interface WebAdminStatus {
  port: number;
  tokenConfigured: boolean;
  weakToken: boolean;
}

export interface AgentRun {
  id: string;
  agentId: string;
  taskId: string;
  pid: number | null;
  sessionId: string;
  /** Engine selected by the task/agent before infrastructure fallback. */
  requestedEngineId: string | null;
  /** Engine that actually executed the run; null for legacy/simulated/unavailable runs. */
  resolvedEngineId: string | null;
  executorKind: ExecutorKind | null;
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

/** 微信 iLink Bot 扫码授权状态。二维码只在内存中短期存在，不含任何 Bot Token。 */
export type WeixinLoginPhase =
  | 'IDLE'
  | 'WAITING_SCAN'
  | 'SCANNED'
  | 'VERIFY_REQUIRED'
  | 'VERIFYING'
  | 'CONNECTED'
  | 'EXPIRED'
  | 'ERROR';

export interface WeixinLoginState {
  phase: WeixinLoginPhase;
  qrDataUrl: string | null;
  message: string;
  updatedAt: number;
}

export type ApprovalScope = 'dispatch_plan' | 'runtime_tool';

export type ApprovalType =
  | 'dispatch_plan'
  | 'write_workspace'
  | 'outside_workspace'
  | 'delete'
  | 'network'
  | 'install'
  | 'admin';

export interface Approval {
  id: string;
  taskId: string;
  agentId: string;
  scope: ApprovalScope;
  type: ApprovalType;
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

// ---------- 全双工语音任务下达 ----------

/** 语音识别提供方：cloud = 阿里云 NLS 实时识别；local = 本地离线模型；auto = 云端优先、未配置回退本地 */
export type VoiceProvider = 'auto' | 'cloud' | 'local';

/** 语音会话状态机（与四层状态模型独立，仅描述一次语音输入的生命周期）
 *  IDLE → LISTENING（拾音中，边说边出字）→ CONFIRMING（等待用户确认）→ DISPATCHED
 *  任意态可 → ERROR；用户取消回到 IDLE */
export type VoiceSessionStatus = 'IDLE' | 'LISTENING' | 'CONFIRMING' | 'DISPATCHED' | 'ERROR';

/** 语音配置（脱敏视图：凭据只回传是否已配置，明文不出主进程） */
export interface VoiceConfig {
  enabled: boolean;
  provider: VoiceProvider;
  /** 阿里云 NLS AppKey（非密钥，可明文展示） */
  appKey: string;
  /** AccessKeyId / AccessKeySecret 是否已配置（走 safeStorage，不回传明文） */
  hasAccessKeyId: boolean;
  hasAccessKeySecret: boolean;
  /** 本地模型是否就绪（模型文件存在） */
  localModelReady: boolean;
  /** 静音多久判定一句话结束（毫秒） */
  silenceMs: number;
}

export interface VoiceConfigInput {
  enabled?: boolean;
  provider?: VoiceProvider;
  appKey?: string;
  /** 留空表示沿用已存凭据 */
  accessKeyId?: string;
  accessKeySecret?: string;
  silenceMs?: number;
}

/** 识别结果分片：partial = 中间结果（会被后续覆盖），final = 一句话最终结果 */
export interface VoiceTranscript {
  text: string;
  isFinal: boolean;
  timestamp: number;
}

/** 语音指令解析结果：把一句话映射为「派给谁、做什么」，供用户确认 */
export interface VoiceCommandDraft {
  /** 原始识别文本 */
  rawText: string;
  /** 解析出的任务标题 */
  title: string;
  /** 目标员工（未能解析出时为 null，由用户在确认界面选择） */
  agentId: string | null;
  agentName: string | null;
  /** 命中的解析方式：mention = 话中点名；default = 回落默认员工 */
  matchedBy: 'mention' | 'default' | 'none';
}

export interface VoiceTestResult {
  ok: boolean;
  provider: 'cloud' | 'local' | null;
  latencyMs: number;
  error: string | null;
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

/** Electron 子进程的内存快照。数值统一为 bytes，避免 Renderer 依赖 Electron 类型。 */
export interface AppProcessMemory {
  pid: number;
  type: string;
  name: string | null;
  memoryBytes: number;
  workingSetBytes: number;
  peakWorkingSetBytes: number;
}

/** 当前应用自身的内存，而非整机内存。 */
export interface AppMemorySnapshot {
  timestamp: number;
  basis: 'private' | 'working-set';
  totalBytes: number;
  mainHeapUsedBytes: number;
  mainHeapTotalBytes: number;
  mainExternalBytes: number;
  processes: AppProcessMemory[];
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
  kind?: AgentKind;
  deviceId?: string | null;
  mobileAllowedTools?: MobileToolName[];
  mobileAuthorizationConfirmed?: boolean;
}

/** Renderer -> Main 的显式 UTF-8 文本载荷。普通字符串仍兼容内部调用。 */
export interface Utf8TextPayload {
  encoding: 'utf8-base64';
  data: string;
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
  kind?: AgentKind;
  deviceId?: string | null;
  mobileAllowedTools?: MobileToolName[];
  mobileAuthorizationConfirmed?: boolean;
}

/** 会话（每个助手可持续多轮对话，上下文跨任务保持） */
export interface Conversation {
  id: string;
  agentId: string;
  organizationId: string | null;
  principalId: string | null;
  channelId: string | null;
  channelIdentityId: string | null;
  externalConversationKey: string | null;
  title: string;
  lastMessageAt: number;
  messageCount: number;
  createdAt: number | null;
  updatedAt: number | null;
}

// ---------- Canonical long-term memory ----------

export type MemoryScopeType = 'organization' | 'principal' | 'channel' | 'conversation' | 'agent' | 'project';
export type MemoryStatus = 'active' | 'forgotten';
export type MemoryProposalStatus = 'pending' | 'accepted' | 'rejected';

export interface MemoryScopeInput {
  principalId?: string | null;
  channelId?: string | null;
  conversationId?: string | null;
  agentId?: string | null;
  projectId?: string | null;
}

export interface MemoryItem {
  id: string;
  organizationId: string;
  kind: string;
  content: string;
  importance: number;
  status: MemoryStatus;
  revision: number;
  scopes: Array<{ type: MemoryScopeType; id: string }>;
  createdAt: number;
  updatedAt: number;
  forgottenAt: number | null;
}

export interface RecalledMemory extends MemoryItem {
  score: number;
}

export interface MemoryListInput {
  status?: MemoryStatus | 'all';
  limit?: number;
}

export interface MemoryRecallInput extends MemoryScopeInput {
  query?: string;
  limit?: number;
}

export interface MemoryRememberInput extends MemoryScopeInput {
  kind: string;
  content: string;
  importance?: number;
}

export interface MemoryUpdateInput {
  memoryId: string;
  expectedRevision: number;
  content?: string;
  importance?: number;
  reason?: string;
}

export interface MemoryForgetInput {
  memoryId: string;
  expectedRevision: number;
  reason?: string;
}

export interface MemoryProposalRecord {
  id: string;
  requestId: string;
  proposalIndex: number;
  organizationId: string;
  principalId: string | null;
  channelId: string | null;
  conversationId: string | null;
  agentId: string | null;
  projectId: string | null;
  operation: 'remember';
  kind: string;
  content: string;
  importance: number;
  scopeType: Exclude<MemoryScopeType, 'organization'>;
  scopeId: string;
  status: MemoryProposalStatus;
  proposedBy: string;
  decidedBy: string | null;
  decisionReason: string | null;
  memoryId: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface MemoryProposalListInput {
  status?: MemoryProposalStatus | 'all';
  limit?: number;
}

export interface MemoryProposalDecisionInput {
  proposalId: string;
  reason?: string;
}

export interface AcceptedMemoryProposal {
  proposal: MemoryProposalRecord;
  memory: MemoryItem;
}

export type TaskScheduleProposalStatus = 'pending' | 'accepted' | 'rejected';

export interface TaskScheduleProposalRecord {
  id: string;
  requestId: string;
  proposalIndex: number;
  organizationId: string;
  principalId: string | null;
  channelId: string | null;
  conversationId: string;
  agentId: string;
  projectId: string | null;
  operation: 'create_task_schedule';
  title: string;
  content: string;
  cronKind: Schedule['cronKind'];
  cronValue: string;
  status: TaskScheduleProposalStatus;
  proposedBy: string;
  decidedBy: string | null;
  decisionReason: string | null;
  scheduleId: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface TaskScheduleProposalListInput {
  status?: TaskScheduleProposalStatus | 'all';
  limit?: number;
}

export interface TaskScheduleProposalDecisionInput {
  proposalId: string;
  reason?: string;
}

export interface AcceptedTaskScheduleProposal {
  proposal: TaskScheduleProposalRecord;
  schedule: Schedule;
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
