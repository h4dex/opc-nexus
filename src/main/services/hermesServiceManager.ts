import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { delimiter, join, relative, resolve } from 'node:path';
import { app } from 'electron';
import type {
  HermesChatActivity,
  HermesChatQueueEvent,
  HermesChatQueueItem,
  HermesChatQueueStatus,
  HermesProjectChatHistory,
  HermesProjectBinding,
  HermesProjectTurnResult,
  HermesRuntimeStatus,
  HermesUiLease
} from '../../shared/types.js';
import type { Database } from './database.js';
import {
  projectHermesChatMessages,
  safeHermesActivityDetail
} from './hermesChatProjection.js';
import { HERMES_RUNTIME_VERSION, runtimeStatusError } from './hermesProtocol.js';
import { HermesProxy } from './hermesProxy.js';

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HOST = '127.0.0.1' as const;
// Leave room for the project governance prompt and tool schemas on
// OpenAI-compatible gateways that reject max_tokens + prompt > context.
const HERMES_MAX_OUTPUT_TOKENS = 16_384;
const START_TIMEOUT_MS = 45_000;
const HEALTH_INTERVAL_MS = 15_000;
const MAX_LOG_CHARS = 32_000;

const HERMES_PROFILE_DDL = [
  `CREATE TABLE IF NOT EXISTS hermes_project_profiles (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
    home_path TEXT NOT NULL,
    runtime_version TEXT NOT NULL DEFAULT '0.19.0',
    service_port INTEGER,
    proxy_port INTEGER,
    auth_secret_ref TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'stopped',
    last_health_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_hermes_project_profiles_status ON hermes_project_profiles(status, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS hermes_session_bindings (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    principal_id TEXT NOT NULL REFERENCES principals(id),
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    hermes_session_id TEXT NOT NULL,
    identity_key TEXT,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY(project_id, conversation_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_hermes_session_bindings_hermes ON hermes_session_bindings(hermes_session_id, last_seen_at DESC)`,
  `CREATE TABLE IF NOT EXISTS hermes_conversation_profiles (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    employee_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS hermes_run_bindings (
    hermes_run_id TEXT PRIMARY KEY,
    nexus_task_id TEXT,
    worker_run_id TEXT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    plan_hash TEXT,
    status TEXT NOT NULL DEFAULT 'observed',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_hermes_run_bindings_project ON hermes_run_bindings(project_id, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS hermes_chat_queue (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    principal_id TEXT NOT NULL REFERENCES principals(id),
    message TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    system_message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'QUEUED'
      CHECK(status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
    stream_text TEXT NOT NULL DEFAULT '',
    activity_json TEXT NOT NULL DEFAULT '[]',
    result_json TEXT,
    last_error TEXT,
    cancel_requested_at INTEGER,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_hermes_chat_queue_conversation
    ON hermes_chat_queue(project_id, conversation_id, status, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_hermes_chat_queue_project
    ON hermes_chat_queue(project_id, updated_at DESC)`
] as const;

export interface HermesRuntimeLaunch {
  pythonPath: string;
  sourcePath: string;
  webDistPath: string;
}

export interface HermesServiceManagerOptions {
  root?: string;
  resolveLaunch?: () => HermesRuntimeLaunch;
  resolveProviderEnvironment?: (projectId: string) => Record<string, string>;
  resolveProjectWorkspace?: (projectId: string) => string | null;
  onUpstreamMessage?: (projectId: string, message: unknown) => void;
  onClientMessage?: (projectId: string, message: unknown) => Promise<{ handled: boolean; result?: unknown }>;
  onHostRequest?: (projectId: string, operation: string, payload: unknown) => Promise<unknown>;
  onProjectRequest?: (
    projectId: string,
    operation: string,
    payload: unknown,
    audience: 'desktop' | 'mobile-operator'
  ) => Promise<unknown>;
  bindSession?: (
    projectId: string,
    hermesSessionId: string,
    requested?: { conversationId: string; principalId: string }
  ) => { conversationId: string; principalId: string };
  resolveConversationContext?: (projectId: string, conversationId: string) => string;
  now?: () => number;
  startTimeoutMs?: number;
  onDiagnostic?: (event: {
    projectId: string;
    component: 'runtime' | 'proxy' | 'dashboard' | 'gateway';
    phase: string;
    elapsedMs: number;
    detail?: string;
  }) => void;
  /** Project-scoped event sink for external OA integrations. */
  onProjectEvent?: (projectId: string, event: HermesChatQueueEvent | Record<string, unknown>) => void;
}

interface ManagedInstance {
  projectId: string;
  homePath: string;
  runtimeModel: string;
  process: ChildProcess;
  gatewayProcess: ChildProcess;
  gatewayUrl: string;
  gatewayToken: string;
  proxy: HermesProxy;
  status: HermesRuntimeStatus;
  log: string;
  dashboardLog: string;
  gatewayLog: string;
  dashboardReady: boolean;
  gatewayReady: boolean;
  healthTimer: NodeJS.Timeout | null;
  expectedStop: boolean;
  crashCleanup: Promise<void> | null;
}

interface ConversationMemoryPolicy {
  mode: 'long_term' | 'short_term' | 'none';
  scope: string;
}

interface ProfileRow {
  project_id: string;
  home_path: string;
  runtime_version: string;
  service_port: number | null;
  proxy_port: number | null;
  status: string;
  last_health_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface ChatQueueRow {
  id: string;
  project_id: string;
  conversation_id: string;
  principal_id: string;
  message: string;
  title: string;
  system_message: string;
  status: HermesChatQueueStatus;
  attempts: number;
  stream_text: string;
  activity_json: string;
  result_json: string | null;
  last_error: string | null;
  cancel_requested_at: number | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  updated_at: number;
}

export interface HermesProjectTurnStreamHandlers {
  onStarted?: () => void;
  onDelta?: (delta: string) => void;
  onActivity?: (activity: {
    kind: 'reasoning' | 'tool';
    phase: 'running' | 'completed' | 'failed';
    toolName: string | null;
    detail: string | null;
  }) => void;
  signal?: AbortSignal;
}

function parseChatActivities(value: unknown): HermesChatActivity[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, 200).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const kind = String(record.kind ?? '');
    const status = String(record.status ?? '');
    if (!['reasoning', 'tool_call', 'tool_result', 'system'].includes(kind)
      || !['running', 'completed', 'failed', 'cancelled'].includes(status)) return [];
    const id = typeof record.id === 'string' ? record.id.trim().slice(0, 320) : '';
    const title = typeof record.title === 'string' ? record.title.trim().slice(0, 240) : '';
    if (!id || !title) return [];
    return [{
      id,
      kind: kind as HermesChatActivity['kind'],
      title,
      status: status as HermesChatActivity['status'],
      toolName: typeof record.toolName === 'string' ? record.toolName.trim().slice(0, 160) || null : null,
      detail: safeHermesActivityDetail(record.detail),
      startedAt: typeof record.startedAt === 'number' && Number.isFinite(record.startedAt) ? record.startedAt : null,
      updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : null
    }];
  });
}

function safeToolName(value: unknown): string {
  if (typeof value !== 'string') return '工具';
  const clean = value.trim().replace(/[\r\n\u0000]/g, '').slice(0, 160);
  return clean || '工具';
}

function defaultRoot(): string {
  return join(app.getPath('userData'), 'aibox-data', 'hermes', 'projects');
}

export interface HermesRuntimeCandidateOptions {
  appPath: string;
  resourcesPath?: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  sourceOverride?: string;
  pythonOverride?: string;
}

export function hermesRuntimeLaunchCandidates(options: HermesRuntimeCandidateOptions): HermesRuntimeLaunch[] {
  const pythonExecutable = options.platform === 'win32' ? 'python.exe' : 'bin/python3';
  const roots = [
    options.sourceOverride,
    options.resourcesPath ? join(options.resourcesPath, 'hermes', 'hermes-agent') : null,
    join(options.appPath, 'vendor', 'hermes-agent'),
    !options.isPackaged && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'hermes', 'hermes-agent')
      : null
  ].filter((value): value is string => Boolean(value));
  const results: HermesRuntimeLaunch[] = [];
  for (const sourcePath of roots) {
    const pythonPaths = [
      options.pythonOverride,
      options.resourcesPath ? join(options.resourcesPath, 'hermes', 'python', pythonExecutable) : null,
      !options.isPackaged ? join(options.appPath, 'runtime', 'hermes', 'python', pythonExecutable) : null,
      join(sourcePath, 'venv', options.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3')
    ].filter((value): value is string => Boolean(value));
    for (const pythonPath of pythonPaths) {
      results.push({ pythonPath, sourcePath, webDistPath: join(sourcePath, 'hermes_cli', 'web_dist') });
    }
  }
  return results;
}

function launchCandidates(): HermesRuntimeLaunch[] {
  return hermesRuntimeLaunchCandidates({
    appPath: app.getAppPath(),
    resourcesPath: typeof process.resourcesPath === 'string' ? process.resourcesPath : undefined,
    isPackaged: app.isPackaged,
    platform: process.platform,
    sourceOverride: process.env.AIBOX_HERMES_SOURCE?.trim(),
    pythonOverride: process.env.AIBOX_HERMES_PYTHON?.trim()
  });
}

export function resolveHermesRuntimeLaunch(): HermesRuntimeLaunch {
  const candidate = launchCandidates().find((item) =>
    existsSync(item.pythonPath)
    && existsSync(join(item.sourcePath, 'hermes_cli', 'main.py'))
    && existsSync(join(item.webDistPath, 'index.html'))
  );
  if (!candidate) {
    throw new Error(app.isPackaged
      ? 'Quest 核心运行时缺失或不完整，请重新安装包含 Hermes Runtime 的完整版本'
      : 'Quest 核心运行时尚未准备，请在开发目录执行 npm run hermes:prepare 后重试');
  }
  return candidate;
}

/** Owns one real Hermes dashboard process and proxy per active project. */
export class HermesServiceManager {
  private readonly root: string;
  private readonly now: () => number;
  private readonly resolveLaunch: () => HermesRuntimeLaunch;
  private readonly resolveProviderEnvironment: (projectId: string) => Record<string, string>;
  private resolveProjectWorkspace: (projectId: string) => string | null;
  private resolveProjectWorkerPool: (projectId: string) => readonly string[];
  private resolveProjectSkills: (projectId: string) => ReadonlyArray<{
    id: string;
    name: string;
    description: string;
    content: string;
  }>;
  private readonly onUpstreamMessage?: (projectId: string, message: unknown) => void;
  private readonly onClientMessage?: (projectId: string, message: unknown) => Promise<{ handled: boolean; result?: unknown }>;
  private readonly onHostRequest?: (projectId: string, operation: string, payload: unknown) => Promise<unknown>;
  private readonly onProjectRequest?: HermesServiceManagerOptions['onProjectRequest'];
  private readonly onDiagnostic?: HermesServiceManagerOptions['onDiagnostic'];
  private readonly onProjectEvent?: HermesServiceManagerOptions['onProjectEvent'];
  private bindSession?: HermesServiceManagerOptions['bindSession'];
  private resolveConversationContext?: HermesServiceManagerOptions['resolveConversationContext'];
  private onProjectHealthy?: (projectId: string) => Promise<void>;
  private readonly startTimeoutMs: number;
  private readonly instances = new Map<string, ManagedInstance>();
  private readonly startOperations = new Map<string, Promise<HermesRuntimeStatus>>();
  private readonly queueDrains = new Map<string, Promise<void>>();
  private readonly runningQueueTurns = new Map<string, AbortController>();
  // A Workbench can be rendered on desktop and mobile at the same time. Keep
  // one upstream history read per session so refresh timers cannot pile up
  // several identical Hermes API requests behind the LAN gateway.
  private readonly projectHistoryReads = new Map<string, Promise<HermesProjectChatHistory>>();

  constructor(private readonly db: Database, options: HermesServiceManagerOptions = {}) {
    this.root = resolve(options.root ?? defaultRoot());
    this.now = options.now ?? Date.now;
    this.resolveLaunch = options.resolveLaunch ?? resolveHermesRuntimeLaunch;
    this.resolveProviderEnvironment = options.resolveProviderEnvironment ?? (() => ({}));
    this.resolveProjectWorkspace = options.resolveProjectWorkspace ?? (() => null);
    this.resolveProjectWorkerPool = () => [];
    this.resolveProjectSkills = () => [];
    this.onUpstreamMessage = options.onUpstreamMessage;
    this.onClientMessage = options.onClientMessage;
    this.onHostRequest = options.onHostRequest;
    this.onProjectRequest = options.onProjectRequest;
    this.onDiagnostic = options.onDiagnostic;
    this.onProjectEvent = options.onProjectEvent;
    this.bindSession = options.bindSession;
    this.resolveConversationContext = options.resolveConversationContext;
    this.startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
    for (const statement of HERMES_PROFILE_DDL) this.db.raw.prepare(statement).run();
    // Older databases predate identity isolation. Keep their rows usable, but
    // let the first resumed turn rotate them to a clean employee-scoped session.
    this.ensureSessionBindingIdentityColumn();
    this.migrateLegacyHermesBindingColumns();
    this.ensureChatQueueCancellationColumn();
    this.ensureChatQueueActivityColumn();
    this.reconcileStaleQueueItems();
    mkdirSync(this.root, { recursive: true });
    this.assertDirectoryNotSymlink(this.root);
    this.reconcileStaleProfiles();
  }

  projectHome(projectId: string): string {
    this.assertProject(projectId);
    const home = resolve(this.root, projectId);
    const rel = relative(this.root, home);
    if (!rel || rel.startsWith('..') || rel.includes(':')) throw new Error('Hermes project home escaped its managed root');
    return home;
  }

  getStatus(projectId: string): HermesRuntimeStatus {
    this.assertProject(projectId);
    const live = this.instances.get(projectId);
    if (live) return structuredClone(live.status);
    const row = this.profileRow(projectId);
    const homePath = row?.home_path ?? this.projectHome(projectId);
    return {
      projectId,
      state: row?.status === 'error' ? 'error' : 'stopped',
      startupPhase: row?.status === 'error' ? 'error' : 'idle',
      startupElapsedMs: null,
      version: row?.runtime_version ?? HERMES_RUNTIME_VERSION,
      host: HOST,
      port: null,
      proxyPort: null,
      homePath,
      serviceUrl: null,
      uiUrl: null,
      pid: null,
      lastHealthAt: row?.last_health_at ?? null,
      lastError: row?.last_error ?? null,
      startedAt: null
    };
  }

  listBindings(): HermesProjectBinding[] {
    return (this.db.raw.prepare(
      'SELECT * FROM hermes_project_profiles ORDER BY updated_at DESC'
    ).all() as unknown as ProfileRow[]).map((row) => ({
      projectId: row.project_id,
      homePath: row.home_path,
      runtimeVersion: row.runtime_version,
      servicePort: row.service_port,
      proxyPort: row.proxy_port,
      status: this.runtimeState(row.status),
      lastHealthAt: row.last_health_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  setProjectWorkspaceResolver(resolveWorkspace: (projectId: string) => string | null): void {
    this.resolveProjectWorkspace = resolveWorkspace;
  }

  setProjectWorkerPoolResolver(resolveWorkerPool: (projectId: string) => readonly string[]): void {
    this.resolveProjectWorkerPool = resolveWorkerPool;
  }

  setProjectSkillResolver(resolveSkills: HermesServiceManager['resolveProjectSkills']): void {
    this.resolveProjectSkills = resolveSkills;
  }

  setSessionBinder(bindSession: NonNullable<HermesServiceManagerOptions['bindSession']>): void {
    this.bindSession = bindSession;
  }

  setConversationContextResolver(
    resolver: NonNullable<HermesServiceManagerOptions['resolveConversationContext']>
  ): void {
    this.resolveConversationContext = resolver;
  }

  setProjectHealthyHandler(handler: (projectId: string) => Promise<void>): void {
    this.onProjectHealthy = handler;
  }

  async start(projectId: string): Promise<HermesRuntimeStatus> {
    this.assertProject(projectId);
    const live = this.instances.get(projectId);
    // A stale healthy status must not keep a dead Main-owned proxy alive. This
    // is especially important after a dashboard/gateway crash, where the
    // process status can briefly outlive proxy cleanup.
    if (live && ['healthy', 'degraded'].includes(live.status.state) && this.uiAvailable(live)) {
      return structuredClone(live.status);
    }
    const existing = this.startOperations.get(projectId);
    if (existing) return structuredClone(await existing);

    let operation!: Promise<HermesRuntimeStatus>;
    operation = this.startOnce(projectId).finally(() => {
      if (this.startOperations.get(projectId) === operation) this.startOperations.delete(projectId);
    });
    this.startOperations.set(projectId, operation);
    return structuredClone(await operation);
  }

  async startForUi(projectId: string): Promise<HermesRuntimeStatus> {
    const startup = this.start(projectId);
    // The full startup continues until the API Gateway is healthy. The UI only
    // needs the authenticated dashboard; keep the rejection observed after
    // returning so a later Gateway failure becomes runtime state, not an
    // unhandled rejection.
    void startup.catch(() => undefined);
    const deadline = this.now() + this.startTimeoutMs;
    while (this.now() < deadline) {
      const instance = this.instances.get(projectId);
      if (instance && this.uiAvailable(instance)) return structuredClone(instance.status);
      // During crash recovery the old instance remains in ERROR while
      // startOnce is still awaiting its cleanup. Do not surface that stale
      // error before the replacement instance has had a chance to start.
      if (instance?.status.state === 'error' && !this.startOperations.has(projectId)) {
        throw new Error(instance.status.lastError ?? 'Hermes dashboard failed to start');
      }
      const settled = await Promise.race([
        startup.then(() => true),
        new Promise<false>((resolveWait) => setTimeout(() => resolveWait(false), 100))
      ]);
      if (settled) {
        const current = this.instances.get(projectId);
        if (current && this.uiAvailable(current)) return structuredClone(current.status);
        throw new Error('Hermes dashboard or proxy did not become available');
      }
    }
    throw new Error('Hermes dashboard startup timed out');
  }

  private async startOnce(projectId: string): Promise<HermesRuntimeStatus> {
    this.assertProject(projectId);
    const existing = this.instances.get(projectId);
    if (existing && ['healthy', 'degraded'].includes(existing.status.state)) {
      return structuredClone(existing.status);
    }
    if (existing) await this.stop(projectId);

    const operationStartedAt = this.now();
    this.diagnostic(projectId, 'runtime', 'preparing', operationStartedAt);
    let workspacePath: string;
    let launch: HermesRuntimeLaunch;
    let providerEnvironment: Record<string, string>;
    try {
      workspacePath = this.requireProjectWorkspace(projectId);
      launch = this.resolveLaunch();
      providerEnvironment = this.resolveProviderEnvironment(projectId);
      const missingProviderFields = [
        !providerEnvironment.OPENAI_API_KEY?.trim() ? 'API Key' : null,
        !providerEnvironment.OPENAI_BASE_URL?.trim() ? 'Base URL' : null,
        !providerEnvironment.HERMES_INFERENCE_MODEL?.trim() ? '模型' : null
      ].filter((value): value is string => value !== null);
      if (missingProviderFields.length > 0) {
        throw new Error(
          `Hermes 无法启动：当前 Provider 缺少 ${missingProviderFields.join('、')}。`
          + '请打开 Quest「连接设置」，保存并测试 Provider 后重试。'
        );
      }
    } catch (error) {
      throw this.persistStartupFailure(projectId, error, operationStartedAt);
    }
    const runtimeModel = providerEnvironment.HERMES_INFERENCE_MODEL.trim();
    const homePath = this.prepareProjectHome(projectId, workspacePath);
    const port = await this.reservePort();
    const gatewayPort = await this.reservePort();
    const serviceToken = randomBytes(32).toString('base64url');
    const hostToken = randomBytes(32).toString('base64url');
    const gatewayToken = randomBytes(32).toString('base64url');
    const proxy = new HermesProxy({
      projectId,
      resolveServiceToken: () => serviceToken,
      hostToken,
      onHostRequest: this.onHostRequest
        ? (operation, payload) => this.onHostRequest!(projectId, operation, payload)
        : undefined,
      onProjectRequest: this.onProjectRequest
        ? (operation, payload, audience) => this.onProjectRequest!(projectId, operation, payload, audience)
        : undefined,
      resolveUpstream: () => {
        const instance = this.instances.get(projectId);
        return instance && this.dashboardAvailable(instance)
          ? instance.status.serviceUrl
          : null;
      },
      audit: (event) => this.db.audit({
        id: randomUUID(), actor: 'system', action: 'hermes.proxy.request',
        target: projectId,
        result: `${event.method} ${event.status} ${event.path}${event.detail ? `: ${event.detail}` : ''}`.slice(0, 2_000),
         source: 'hermes'
      }),
      trace: (event) => this.diagnostic(
        projectId,
        'proxy',
        event.phase,
        operationStartedAt,
        [event.method, event.pathname, event.detail].filter(Boolean).join(' ')
      ),
      onUpstreamMessage: (message) => this.onUpstreamMessage?.(projectId, message),
      onClientMessage: this.onClientMessage
        ? (message) => this.onClientMessage!(projectId, message)
        : undefined
    });
    await proxy.start();
    const proxyStatus = proxy.getStatus();
    const startedAt = operationStartedAt;
    this.diagnostic(projectId, 'proxy', 'ready', operationStartedAt, `port=${proxyStatus.port}`);
    const env = {
      ...process.env,
      ...providerEnvironment,
      HERMES_INFERENCE_PROVIDER: 'custom:opcnexus',
      HERMES_HOME: homePath,
      HERMES_DESKTOP: '1',
      HERMES_DASHBOARD_SESSION_TOKEN: serviceToken,
      HERMES_NEXUS_HOST_URL: `${proxyStatus.origin}/__opc_nexus/host`,
      HERMES_NEXUS_HOST_TOKEN: hostToken,
      HERMES_NEXUS_PROJECT_ID: projectId,
      HERMES_WEB_DIST: launch.webDistPath,
      HERMES_CWD: workspacePath,
      TERMINAL_CWD: workspacePath,
      PYTHONPATH: [launch.sourcePath, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
      HERMES_QUIET: '1',
      API_SERVER_ENABLED: 'true',
      API_SERVER_KEY: gatewayToken,
      API_SERVER_HOST: HOST,
      API_SERVER_PORT: String(gatewayPort),
      API_SERVER_MODEL_NAME: providerEnvironment.HERMES_INFERENCE_MODEL,
      PYTHONUTF8: '1',
      PYTHONUNBUFFERED: '1'
    };
    const child = spawn(launch.pythonPath, [
      '-m', 'hermes_cli.main', 'dashboard',
      '--host', HOST,
      '--port', String(port),
      '--no-open',
      '--skip-build',
      '--isolated'
    ], {
      cwd: workspacePath,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const gatewayChild = spawn(launch.pythonPath, [
      '-m', 'hermes_cli.main', 'gateway', 'run'
    ], {
      cwd: workspacePath,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (!child.stdout || !child.stderr || !gatewayChild.stdout || !gatewayChild.stderr) {
      child.kill('SIGKILL');
      gatewayChild.kill('SIGKILL');
      await proxy.stop();
      throw new Error('Hermes runtime process streams are unavailable');
    }
    const status: HermesRuntimeStatus = {
      projectId,
      state: 'starting',
      startupPhase: 'starting-dashboard',
      startupElapsedMs: Math.max(0, this.now() - startedAt),
      version: null,
      host: HOST,
      port,
      proxyPort: proxyStatus.port,
      homePath,
      serviceUrl: `http://${HOST}:${port}`,
      uiUrl: proxyStatus.origin ? `${proxyStatus.origin}/` : null,
      pid: child.pid ?? null,
      lastHealthAt: null,
      lastError: null,
      startedAt
    };
    const instance: ManagedInstance = {
      projectId,
      homePath,
      runtimeModel,
      process: child,
      gatewayProcess: gatewayChild,
      gatewayUrl: `http://${HOST}:${gatewayPort}`,
      gatewayToken,
      proxy,
      status,
      log: '',
      dashboardLog: '',
      gatewayLog: '',
      dashboardReady: false,
      gatewayReady: false,
      healthTimer: null,
      expectedStop: false,
      crashCleanup: null
    };
    this.instances.set(projectId, instance);
    this.diagnostic(projectId, 'dashboard', 'spawned', startedAt, `pid=${child.pid ?? 'unknown'};port=${port}`);
    this.diagnostic(projectId, 'gateway', 'spawned', startedAt, `pid=${gatewayChild.pid ?? 'unknown'};port=${gatewayPort}`);
    const collect = (component: 'dashboard' | 'gateway', chunk: Buffer) => {
      const text = chunk.toString('utf8');
      instance.log = `${instance.log}${text}`.slice(-MAX_LOG_CHARS);
      if (component === 'dashboard') {
        instance.dashboardLog = `${instance.dashboardLog}${text}`.slice(-MAX_LOG_CHARS);
      } else {
        instance.gatewayLog = `${instance.gatewayLog}${text}`.slice(-MAX_LOG_CHARS);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => collect('dashboard', chunk));
    child.stderr.on('data', (chunk: Buffer) => collect('dashboard', chunk));
    gatewayChild.stdout.on('data', (chunk: Buffer) => collect('gateway', chunk));
    gatewayChild.stderr.on('data', (chunk: Buffer) => collect('gateway', chunk));
    child.once('exit', (code, signal) => this.onProcessExit(instance, 'dashboard', code, signal));
    gatewayChild.once('exit', (code, signal) => this.onProcessExit(instance, 'gateway', code, signal));
    child.once('error', (error) => this.onProcessError(instance, 'dashboard', error));
    gatewayChild.once('error', (error) => this.onProcessError(instance, 'gateway', error));
    this.persist(instance.status);

    try {
      await this.waitUntilHealthy(instance);
      instance.healthTimer = setInterval(() => void this.refreshHealth(instance), HEALTH_INTERVAL_MS);
      instance.healthTimer.unref();
      if (this.onProjectHealthy) {
        void this.onProjectHealthy(projectId).catch((error: unknown) => {
          this.audit('hermes.project.resume-pending', projectId, error instanceof Error ? error.message : String(error));
        });
      }
      this.resumeQueuedProjectTurns(projectId);
      return structuredClone(instance.status);
    } catch (error) {
      instance.status = runtimeStatusError(
        projectId,
        homePath,
        this.withComponentLogs(error, instance),
        instance.status
      );
      this.persist(instance.status);
      this.diagnostic(projectId, 'runtime', 'error', startedAt, instance.status.lastError ?? undefined);
      if (instance.crashCleanup) await instance.crashCleanup;
      else {
        await this.stopProcess(instance);
        await proxy.stop();
      }
      this.instances.delete(projectId);
      throw new Error(instance.status.lastError ?? 'Hermes failed to start');
    }
  }

  async stop(projectId: string): Promise<HermesRuntimeStatus> {
    this.assertProject(projectId);
    const instance = this.instances.get(projectId);
    if (!instance) {
      const status = this.getStatus(projectId);
      const stopped = {
        ...status,
        state: 'stopped' as const,
        startupPhase: 'idle' as const,
        startupElapsedMs: null,
        port: null,
        proxyPort: null,
        serviceUrl: null,
        uiUrl: null,
        pid: null
      };
      this.persist(stopped);
      return stopped;
    }
    if (instance.crashCleanup) await instance.crashCleanup;
    instance.expectedStop = true;
    instance.status = { ...instance.status, state: 'stopping', startupPhase: 'stopping' };
    this.persist(instance.status);
    if (instance.healthTimer) clearInterval(instance.healthTimer);
    instance.healthTimer = null;
    await instance.proxy.stop();
    await this.stopProcess(instance);
    this.instances.delete(projectId);
    const stopped: HermesRuntimeStatus = {
      ...instance.status,
      state: 'stopped',
      startupPhase: 'idle',
      startupElapsedMs: null,
      port: null,
      proxyPort: null,
      serviceUrl: null,
      uiUrl: null,
      pid: null,
      lastError: null
    };
    this.persist(stopped);
    this.audit('hermes.project.stop', projectId, 'ok');
    return stopped;
  }

  async restart(projectId: string): Promise<HermesRuntimeStatus> {
    await this.stop(projectId);
    return this.start(projectId);
  }

  async emergencyStop(projectId: string): Promise<HermesRuntimeStatus> {
    const instance = this.instances.get(projectId);
    if (instance && instance.process.exitCode === null) instance.process.kill('SIGKILL');
    if (instance && instance.gatewayProcess.exitCode === null) instance.gatewayProcess.kill('SIGKILL');
    this.audit('hermes.project.emergencyStop', projectId, instance ? 'terminated' : 'not-running');
    return this.stop(projectId);
  }

  createUiLease(projectId: string): HermesUiLease {
    const instance = this.instances.get(projectId);
    if (!instance || !this.uiAvailable(instance)) throw new Error('Hermes dashboard or proxy is not ready');
    return instance.proxy.createLease();
  }

  createMobileLease(projectId: string, role: 'operator'): HermesUiLease {
    const instance = this.instances.get(projectId);
    if (!instance || instance.status.state !== 'healthy' || !this.uiAvailable(instance)) {
      throw new Error('Hermes project service or proxy is not healthy');
    }
    return instance.proxy.createLease(8 * 60 * 60_000, `mobile-${role}`);
  }

  /** True only while the project dashboard and its Main-owned proxy are usable. */
  isUiAvailable(projectId: string): boolean {
    this.assertProject(projectId);
    const instance = this.instances.get(projectId);
    return instance ? this.uiAvailable(instance) : false;
  }

  cookieForLease(projectId: string, lease: HermesUiLease): { name: string; value: string; url: string } {
    const instance = this.instances.get(projectId);
    if (!instance) throw new Error('Hermes project service is not running');
    return instance.proxy.cookieForLease(lease);
  }

  revokeUiLease(projectId: string, leaseId: string): void {
    this.instances.get(projectId)?.proxy.revokeLease(leaseId);
  }

  enqueueProjectTurn(projectId: string, input: {
    conversationId: string;
    principalId: string;
    message: string;
    title?: string;
    systemMessage?: string;
  }): HermesChatQueueItem {
    this.assertProject(projectId);
    const instance = this.instances.get(projectId);
    if (!instance || instance.status.state !== 'healthy') throw new Error('Hermes project service is not healthy');
    const message = input.message?.trim();
    if (!message || message.length > 128_000) throw new Error('Hermes project message is invalid');
    const conversationId = input.conversationId?.trim();
    const principalId = input.principalId?.trim();
    const conversation = this.db.raw.prepare(`
      SELECT c.id, c.principal_id
      FROM conversations c
      JOIN projects p ON p.id = c.project_id AND p.status <> 'archived'
      WHERE c.id = ? AND c.project_id = ? AND c.principal_id = ?
    `).get(conversationId, projectId, principalId) as { id?: string; principal_id?: string } | undefined;
    if (conversation?.id !== conversationId || conversation.principal_id !== principalId) {
      throw new Error('Hermes project conversation is unavailable');
    }
    const now = this.nextQueueCreatedAt(projectId, conversationId);
    const id = `hermes-chat-${randomUUID()}`;
    this.db.raw.prepare(`
      INSERT INTO hermes_chat_queue(
        id, project_id, conversation_id, principal_id, message, title, system_message,
        status, attempts, stream_text, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 'QUEUED', 0, '', ?, ?)
    `).run(
      id,
      projectId,
      conversationId,
      principalId,
      message,
      input.title?.trim().slice(0, 160) ?? '',
      input.systemMessage?.trim().slice(0, 256_000) ?? '',
      now,
      now
    );
    const item = this.requireQueueItem(projectId, id);
    this.audit('hermes.chat.queue.enqueue', projectId, `queue=${id};conversation=${conversationId}`);
    this.publishQueueEvent(projectId, {
      type: 'chat.queue.updated', projectId, queueId: id, conversationId,
      timestamp: now, item
    });
    this.scheduleConversationDrain(projectId, conversationId);
    return item;
  }

  listProjectChatQueue(projectId: string): HermesChatQueueItem[] {
    this.assertProject(projectId);
    const activeRows = this.db.raw.prepare(`
      SELECT * FROM hermes_chat_queue
      WHERE project_id = ? AND status IN ('QUEUED', 'RUNNING', 'FAILED')
      ORDER BY created_at, id
      LIMIT 500
    `).all(projectId) as unknown as ChatQueueRow[];
    const cancelledRows = this.db.raw.prepare(`
      SELECT * FROM hermes_chat_queue
      WHERE project_id = ? AND status = 'CANCELLED'
      ORDER BY completed_at DESC, created_at DESC, id DESC
      LIMIT 100
    `).all(projectId) as unknown as ChatQueueRow[];
    const rows = [...activeRows, ...cancelledRows]
      .sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id));
    const positions = new Map<string, number>();
    return rows.map((row) => {
      let position: number | null = null;
      if (row.status === 'QUEUED') {
        position = (positions.get(row.conversation_id) ?? 0) + 1;
        positions.set(row.conversation_id, position);
      }
      return this.toQueueItem(row, position);
    });
  }

  retryProjectTurn(
    projectId: string,
    queueId: string,
    confirmation: 'retry-failed-turn'
  ): HermesChatQueueItem {
    this.assertProject(projectId);
    if (confirmation !== 'retry-failed-turn') {
      throw new Error('Retry requires explicit owner confirmation');
    }
    const id = queueId?.trim();
    if (!/^hermes-chat-[A-Za-z0-9-]{1,80}$/.test(id)) throw new Error('Hermes queue identity is invalid');
    const existing = this.requireQueueItem(projectId, id);
    if (existing.status !== 'FAILED') throw new Error('Only a failed Hermes queue item can be retried');
    const now = this.nextQueueCreatedAt(projectId, existing.conversationId);
    const updated = this.db.raw.prepare(`
      UPDATE hermes_chat_queue
      SET status = 'QUEUED', stream_text = '', activity_json = '[]', result_json = NULL, last_error = NULL,
          cancel_requested_at = NULL, created_at = ?, started_at = NULL,
          completed_at = NULL, updated_at = ?
      WHERE id = ? AND project_id = ? AND status = 'FAILED'
    `).run(now, now, id, projectId);
    if (updated.changes !== 1) throw new Error('Only a failed Hermes queue item can be retried');
    const item = this.requireQueueItem(projectId, id);
    this.audit('hermes.chat.queue.retry', projectId, `queue=${id}`);
    this.publishQueueEvent(projectId, {
      type: 'chat.queue.updated', projectId, queueId: id,
      conversationId: item.conversationId, timestamp: now, item
    });
    this.scheduleConversationDrain(projectId, item.conversationId);
    return item;
  }

  cancelProjectTurn(projectId: string, queueId: string): HermesChatQueueItem {
    this.assertProject(projectId);
    const id = queueId?.trim();
    if (!/^hermes-chat-[A-Za-z0-9-]{1,80}$/.test(id)) throw new Error('Hermes queue identity is invalid');
    const existing = this.requireQueueItem(projectId, id);
    if (existing.status !== 'QUEUED' && existing.status !== 'RUNNING') {
      throw new Error('Only a queued or running Hermes turn can be cancelled');
    }
    if (existing.status === 'RUNNING' && existing.cancelRequestedAt !== null) {
      return existing;
    }
    const requestedAt = this.now();
    const updated = existing.status === 'QUEUED'
      ? this.db.raw.prepare(`
          UPDATE hermes_chat_queue
          SET status = 'CANCELLED', cancel_requested_at = ?, last_error = NULL,
              completed_at = ?, updated_at = ?
          WHERE id = ? AND project_id = ? AND status = 'QUEUED'
        `).run(requestedAt, requestedAt, requestedAt, id, projectId)
      : this.db.raw.prepare(`
          UPDATE hermes_chat_queue
          SET cancel_requested_at = ?, last_error = NULL, updated_at = ?
          WHERE id = ? AND project_id = ? AND status = 'RUNNING'
            AND cancel_requested_at IS NULL
        `).run(requestedAt, requestedAt, id, projectId);
    if (updated.changes !== 1) throw new Error('Hermes turn is no longer cancellable');

    const item = this.requireQueueItem(projectId, id);
    this.runningQueueTurns.get(id)?.abort(new Error('Cancelled by the project owner'));
    this.audit('hermes.chat.queue.cancel', projectId,
      `queue=${id};conversation=${item.conversationId};previous=${existing.status}`);
    this.publishQueueEvent(projectId, {
      type: 'chat.queue.updated', projectId, queueId: id,
      conversationId: item.conversationId, timestamp: requestedAt, item
    });
    this.scheduleConversationDrain(projectId, item.conversationId);
    return item;
  }

  async runProjectTurn(projectId: string, input: {
    conversationId?: string;
    principalId?: string;
    message: string;
    title?: string;
    systemMessage?: string;
  }, stream?: HermesProjectTurnStreamHandlers): Promise<HermesProjectTurnResult> {
    this.assertProject(projectId);
    const instance = this.instances.get(projectId);
    if (!instance || instance.status.state !== 'healthy') throw new Error('Hermes project service is not healthy');
    const message = input.message?.trim();
    if (!message || message.length > 128_000) throw new Error('Hermes project message is invalid');
    if ((input.conversationId && !input.principalId) || (!input.conversationId && input.principalId)) {
      throw new Error('Hermes conversation and principal must be supplied together');
    }
    let binding = input.conversationId
      ? this.db.raw.prepare(`
          SELECT conversation_id, principal_id, hermes_session_id, identity_key
          FROM hermes_session_bindings WHERE project_id = ? AND conversation_id = ?
        `).get(projectId, input.conversationId) as {
          conversation_id?: string;
          principal_id?: string;
          hermes_session_id?: string;
          identity_key?: string | null;
        } | undefined
      : undefined;
    if (binding && binding.principal_id !== input.principalId) throw new Error('Hermes session principal does not match the conversation binding');

    let fixedContext = binding?.conversation_id
      ? this.resolveConversationContext?.(projectId, binding.conversation_id).trim() ?? ''
      : '';
    let identityKey = fixedContext ? this.identityKey(fixedContext) : null;
    // Upgraded installations can have a Hermes session with a missing
    // identity_key. A `nexus_` session is already owned by Hermes, so filling
    // the projection metadata must not rotate it and silently erase the
    // visible conversation history. Only clearly legacy DSH/Cordis session
    // ids are rotated when their fixed employee context is first materialized.
    const legacySession = Boolean(binding?.hermes_session_id && /(?:cordis|dsh)/i.test(binding.hermes_session_id));
    const identityChanged = Boolean(
      binding && identityKey && binding.identity_key !== identityKey
        && (binding.identity_key !== null || legacySession)
    );
    let hermesSessionId = !binding || identityChanged
      ? `nexus_${randomUUID().replace(/-/g, '')}`
      : binding.hermes_session_id!;
    const runtimeLock = {
      model: instance.runtimeModel,
      provider: 'custom:opcnexus',
      require_model_lock: true
    } as const;
    const requestedMemoryPolicy = input.conversationId
      ? this.conversationMemoryPolicy(projectId, input.conversationId)
      : { mode: 'long_term', scope: 'project' } satisfies ConversationMemoryPolicy;
    if (!binding || identityChanged) {
      const sessionTitle = `${input.title?.trim() || 'OPC-Nexus project'} · ${hermesSessionId.slice(-8)}`.slice(0, 160);
      await this.gatewayJson(instance, 'POST', '/api/sessions', {
        id: hermesSessionId,
        source: 'nexus',
        title: sessionTitle,
        nexus_memory_mode: requestedMemoryPolicy.mode,
        nexus_memory_scope: requestedMemoryPolicy.scope,
        ...runtimeLock
      });
      if (!binding) {
        if (!this.bindSession) throw new Error('Hermes project session binder is unavailable');
        const canonical = this.bindSession(
          projectId,
          hermesSessionId,
          input.conversationId && input.principalId
            ? { conversationId: input.conversationId, principalId: input.principalId }
            : undefined
        );
        binding = {
          conversation_id: canonical.conversationId,
          principal_id: canonical.principalId,
          hermes_session_id: hermesSessionId,
          identity_key: null
        };
        const canonicalConversationId = binding.conversation_id;
        if (!canonicalConversationId) throw new Error('Hermes canonical session binding is incomplete');
        fixedContext = this.resolveConversationContext?.(projectId, canonicalConversationId).trim() ?? '';
        identityKey = fixedContext ? this.identityKey(fixedContext) : null;
      } else {
        // Keep the canonical conversation, principal and UI tab while replacing
        // only the contaminated Hermes runtime session.
        const conversationId = binding.conversation_id;
        if (!conversationId) throw new Error('Hermes canonical session binding is incomplete');
        this.db.raw.prepare(`
          UPDATE hermes_session_bindings
          SET hermes_session_id = ?, identity_key = ?, last_seen_at = ?
          WHERE project_id = ? AND conversation_id = ?
        `).run(hermesSessionId, identityKey, this.now(), projectId, conversationId);
        binding = { ...binding, hermes_session_id: hermesSessionId, identity_key: identityKey };
      }
    } else {
      try {
        await this.gatewayJson(
          instance,
          'POST',
          `/api/sessions/${encodeURIComponent(hermesSessionId)}/model`,
          runtimeLock
        );
      } catch (error) {
        // A restored Nexus database can outlive a removed or corrupted Hermes
        // home. Reusing that stale binding would make the next owner message
        // fail with an opaque "Session not found" response forever.
        if (!this.isMissingHermesSessionError(error)) throw error;
        hermesSessionId = await this.recreateBoundProjectSession(
          instance,
          projectId,
          binding,
          requestedMemoryPolicy,
          runtimeLock
        );
        binding = { ...binding, hermes_session_id: hermesSessionId };
      }
    }
    if (!binding.conversation_id || !binding.principal_id) throw new Error('Hermes canonical session binding is incomplete');
    const memoryPolicy = this.conversationMemoryPolicy(projectId, binding.conversation_id);

    const chatPath = `/api/sessions/${encodeURIComponent(hermesSessionId)}/chat`;
    fixedContext = fixedContext || (this.resolveConversationContext?.(projectId, binding.conversation_id).trim() ?? '');
    identityKey = identityKey || (fixedContext ? this.identityKey(fixedContext) : null);
    if (identityKey) {
      this.db.raw.prepare(`
        UPDATE hermes_session_bindings SET identity_key = ?, last_seen_at = ?
        WHERE project_id = ? AND conversation_id = ?
      `).run(identityKey, this.now(), projectId, binding.conversation_id);
    }
    const turnContext = input.systemMessage?.trim() ?? '';
    const systemMessage = [fixedContext, turnContext].filter(Boolean).join('\n\n');
    const chatBody = {
      message,
      nexus_memory_mode: memoryPolicy.mode,
      nexus_memory_scope: memoryPolicy.scope,
      ...(systemMessage ? { system_message: systemMessage } : {})
    };
    const chatHeaders = { 'x-hermes-session-key': `${projectId}:${binding.conversation_id}` };
    const response = stream
      ? await this.gatewaySse(
          instance,
          `${chatPath}/stream`,
          chatBody,
          15 * 60_000,
          chatHeaders,
          stream
        )
      : await this.gatewayJson(instance, 'POST', chatPath, chatBody, 15 * 60_000, chatHeaders) as Record<string, unknown>;
    const responseSessionId = typeof response.session_id === 'string' ? response.session_id.trim() : '';
    const responseMessage = response.message && typeof response.message === 'object' && !Array.isArray(response.message)
      ? response.message as Record<string, unknown>
      : null;
    const content = typeof responseMessage?.content === 'string' ? responseMessage.content.trim() : '';
    if (!responseSessionId || responseSessionId.length > 256 || !content) {
      throw new Error('Hermes returned an invalid project turn response');
    }
    if (/^(?:API call failed(?: after \d+ retries)?:|HTTP\s+[45]\d\d\s*:|Request payload too large\b)/i.test(content)) {
      throw new Error(content);
    }
    if (responseSessionId !== hermesSessionId) {
      this.db.raw.prepare(`
        UPDATE hermes_session_bindings SET hermes_session_id = ?, last_seen_at = ?
        WHERE project_id = ? AND conversation_id = ? AND hermes_session_id = ?
      `).run(responseSessionId, this.now(), projectId, binding.conversation_id, hermesSessionId);
      hermesSessionId = responseSessionId;
    } else {
      this.db.raw.prepare(`
        UPDATE hermes_session_bindings SET last_seen_at = ?
        WHERE project_id = ? AND conversation_id = ?
      `).run(this.now(), projectId, binding.conversation_id);
    }
    const usage = response.usage && typeof response.usage === 'object' && !Array.isArray(response.usage)
      ? response.usage as Record<string, unknown>
      : {};
    const runtime = response.runtime && typeof response.runtime === 'object' && !Array.isArray(response.runtime)
      ? response.runtime as Record<string, unknown>
      : {};
    const result: HermesProjectTurnResult = {
      projectId,
      conversationId: binding.conversation_id,
      hermesSessionId,
      content,
      usage: {
        inputTokens: this.nonnegativeInteger(usage.input_tokens),
        outputTokens: this.nonnegativeInteger(usage.output_tokens),
        totalTokens: this.nonnegativeInteger(usage.total_tokens)
      },
      runtime: {
        provider: typeof runtime.provider === 'string' ? runtime.provider : null,
        model: typeof runtime.model === 'string' ? runtime.model : null,
        memoryMode: memoryPolicy.mode,
        memoryScope: memoryPolicy.scope
      },
      createdAt: this.now()
    };
    this.db.raw.prepare(`
      UPDATE conversations
      SET last_message_at = ?, updated_at = ?, message_count = message_count + 2
      WHERE id = ? AND project_id = ?
    `).run(result.createdAt, result.createdAt, result.conversationId, projectId);
    this.audit('hermes.project.turn', projectId, `conversation=${result.conversationId};session=${result.hermesSessionId}`);
    return result;
  }

  async projectChatHistory(projectId: string, conversationId?: string): Promise<HermesProjectChatHistory> {
    this.assertProject(projectId);
    const instance = this.instances.get(projectId);
    if (!instance || instance.status.state !== 'healthy') throw new Error('Hermes project service is not healthy');
    const binding = conversationId
      ? this.db.raw.prepare(`
          SELECT conversation_id, hermes_session_id FROM hermes_session_bindings
          WHERE project_id = ? AND conversation_id = ?
        `).get(projectId, conversationId) as { conversation_id?: string; hermes_session_id?: string } | undefined
      : this.db.raw.prepare(`
          SELECT conversation_id, hermes_session_id FROM hermes_session_bindings
          WHERE project_id = ? ORDER BY last_seen_at DESC LIMIT 1
        `).get(projectId) as { conversation_id?: string; hermes_session_id?: string } | undefined;
    if (!binding?.conversation_id || !binding.hermes_session_id) {
      return { projectId, conversationId: null, hermesSessionId: null, messages: [] };
    }
    const readKey = `${projectId}:${binding.conversation_id}:${binding.hermes_session_id}`;
    const pending = this.projectHistoryReads.get(readKey);
    if (pending) return pending;
    const read = (async (): Promise<HermesProjectChatHistory> => {
      // History is a read-only UI request. A stalled upstream must become a
      // visible error before the mobile gateway's request budget expires.
      let sessionId = binding.hermes_session_id!;
      let payload: Record<string, unknown>;
      try {
        payload = await this.gatewayJson(
          instance,
          'GET',
          `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
          undefined,
          10_000
        ) as Record<string, unknown>;
      } catch (error) {
        if (!this.isMissingHermesSessionError(error)) throw error;
        const memoryPolicy = this.conversationMemoryPolicy(projectId, binding.conversation_id!);
        sessionId = await this.recreateBoundProjectSession(
          instance,
          projectId,
          binding,
          memoryPolicy,
          {
            model: instance.runtimeModel,
            provider: 'custom:opcnexus',
            require_model_lock: true
          }
        );
        return {
          projectId,
          conversationId: binding.conversation_id!,
          hermesSessionId: sessionId,
          messages: []
        };
      }
      const data = Array.isArray(payload.data) ? payload.data : [];
      const messages = projectHermesChatMessages(data, sessionId);
      return {
        projectId,
        conversationId: binding.conversation_id!,
        hermesSessionId: typeof payload.session_id === 'string' ? payload.session_id : sessionId,
        messages
      };
    })();
    this.projectHistoryReads.set(readKey, read);
    try {
      return await read;
    } finally {
      if (this.projectHistoryReads.get(readKey) === read) this.projectHistoryReads.delete(readKey);
    }
  }

  async answerClarification(projectId: string, clarifyId: string, answer: unknown): Promise<HermesProjectTurnResult> {
    const instance = this.instances.get(projectId);
    if (!instance || instance.status.state !== 'healthy') throw new Error('Hermes project service is not healthy');
    const encoded = typeof answer === 'string' ? answer : JSON.stringify(answer);
    if (typeof encoded !== 'string' || encoded.length > 64_000) throw new Error('Hermes clarification answer is invalid');
    const request = this.db.raw.prepare(`
      SELECT conversation_id, prompt FROM hermes_clarify_requests
      WHERE clarify_id = ? AND project_id = ? AND status = 'ANSWERED'
    `).get(clarifyId, projectId) as { conversation_id?: string; prompt?: string } | undefined;
    if (!request?.conversation_id || !request.prompt) throw new Error('Hermes clarification has no resumable project conversation');
    const binding = this.db.raw.prepare(`
      SELECT principal_id FROM hermes_session_bindings
      WHERE project_id = ? AND conversation_id = ?
    `).get(projectId, request.conversation_id) as { principal_id?: string } | undefined;
    if (!binding?.principal_id) throw new Error('Hermes clarification has no principal binding');
    return await this.runProjectTurn(projectId, {
      conversationId: request.conversation_id,
      principalId: binding.principal_id,
      message: [
        `The owner answered pending clarification ${clarifyId}.`,
        `Question: ${request.prompt}`,
        `Answer: ${encoded}`,
        'Continue the original request with this answer. Do not ask the same question again.'
      ].join('\n'),
      title: 'OPC-Nexus clarification'
    });
  }

  memoryIndex(projectId: string): Array<{ name: string; relativePath: string; updatedAt: number }> {
    const home = this.projectHome(projectId);
    const names = ['MEMORY.md', 'USER.md', 'SOUL.md', 'AGENTS.md'];
    const rootEntries = names.flatMap((name) => {
      const path = join(home, name);
      if (!existsSync(path)) return [];
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) return [];
      return [{ name, relativePath: name, updatedAt: stat.mtimeMs }];
    });
    const project = this.db.raw.prepare('SELECT organization_id FROM projects WHERE id = ?')
      .get(projectId) as { organization_id?: string } | undefined;
    if (!project?.organization_id) return rootEntries;
    const employees = this.db.raw.prepare(`
      SELECT id, name FROM agents
      WHERE organization_id = ? AND archived = 0 AND memory_mode = 'long_term'
      ORDER BY name, id
    `).all(project.organization_id) as Array<{ id: string; name: string }>;
    const employeeEntries = employees.flatMap((employee) => {
      const scope = this.employeeMemoryScope(employee.id);
      return ['MEMORY.md', 'USER.md'].flatMap((filename) => {
        const relativePath = join('memories', 'employees', scope, filename);
        const path = join(home, relativePath);
        if (!existsSync(path)) return [];
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) return [];
        return [{
          name: `${employee.name} · ${filename}`,
          relativePath: relativePath.replace(/\\/g, '/'),
          updatedAt: stat.mtimeMs
        }];
      });
    });
    return [...rootEntries, ...employeeEntries];
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.instances.keys()].map((projectId) => this.stop(projectId).then(() => undefined)));
  }

  private async waitUntilHealthy(instance: ManagedInstance): Promise<void> {
    const deadline = this.now() + this.startTimeoutMs;
    let lastError: unknown = new Error('Hermes health check timed out');
    while (this.now() < deadline) {
      if (instance.process.exitCode !== null) throw new Error(`Hermes dashboard exited with code ${instance.process.exitCode}`);
      if (instance.gatewayProcess.exitCode !== null) throw new Error(`Hermes API gateway exited with code ${instance.gatewayProcess.exitCode}`);
      try {
        await this.refreshHealth(instance, true);
        if (instance.status.state === 'healthy') return;
      } catch (error) { lastError = error; }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw lastError;
  }

  private async refreshHealth(instance: ManagedInstance, throwOnFailure = false): Promise<void> {
    const runtimeWasReady = instance.status.startupPhase === 'ready';
    const [dashboard, gateway] = await Promise.allSettled([
      this.dashboardHealth(instance),
      this.gatewayHealth(instance)
    ]);
    const now = this.now();
    const dashboardWasReady = instance.dashboardReady;
    const gatewayWasReady = instance.gatewayReady;
    instance.dashboardReady = dashboard.status === 'fulfilled';
    instance.gatewayReady = gateway.status === 'fulfilled';

    if (instance.dashboardReady && !dashboardWasReady) {
      this.diagnostic(instance.projectId, 'dashboard', 'healthy', instance.status.startedAt ?? now);
    }
    if (instance.gatewayReady && !gatewayWasReady) {
      this.diagnostic(instance.projectId, 'gateway', 'healthy', instance.status.startedAt ?? now);
    }

    if (dashboard.status === 'fulfilled' && gateway.status === 'fulfilled') {
      instance.status = {
        ...instance.status,
        state: 'healthy',
        startupPhase: 'ready',
        startupElapsedMs: instance.status.startedAt === null ? null : Math.max(0, now - instance.status.startedAt),
        version: dashboard.value,
        lastHealthAt: now,
        lastError: null
      };
      this.persist(instance.status);
      if (!runtimeWasReady) {
        this.diagnostic(instance.projectId, 'runtime', 'ready', instance.status.startedAt ?? now);
      }
      return;
    }

    const failures = [
      dashboard.status === 'rejected'
        ? `dashboard: ${dashboard.reason instanceof Error ? dashboard.reason.message : String(dashboard.reason)}`
        : null,
      gateway.status === 'rejected'
        ? `gateway: ${gateway.reason instanceof Error ? gateway.reason.message : String(gateway.reason)}`
        : null
    ].filter((value): value is string => value !== null);
    const message = failures.join('; ') || 'Hermes health check is incomplete';
    const starting = instance.status.state === 'starting';
    instance.status = {
      ...instance.status,
      state: starting ? 'starting' : 'degraded',
      startupPhase: instance.dashboardReady ? 'starting-gateway' : 'starting-dashboard',
      startupElapsedMs: instance.status.startedAt === null ? null : Math.max(0, now - instance.status.startedAt),
      lastError: starting ? null : message
    };
    this.persist(instance.status);
    if (throwOnFailure) throw new Error(message);
  }

  private async dashboardHealth(instance: ManagedInstance): Promise<string> {
    const response = await fetch(`${instance.status.serviceUrl}/api/health`, {
      signal: AbortSignal.timeout(2_500),
      headers: { host: `${HOST}:${instance.status.port}` }
    });
    const body = await response.json() as { ok?: unknown; version?: unknown };
    if (!response.ok || body.ok !== true || typeof body.version !== 'string') {
      throw new Error(`HTTP ${response.status}`);
    }
    if (!body.version.startsWith('0.19.')) {
      throw new Error(`version ${body.version} is not compatible with 0.19.x`);
    }
    return body.version;
  }

  private async gatewayHealth(instance: ManagedInstance): Promise<string> {
    const response = await fetch(`${instance.gatewayUrl}/health`, { signal: AbortSignal.timeout(2_500) });
    const body = await response.json() as { status?: unknown; version?: unknown };
    if (!response.ok || body.status !== 'ok' || typeof body.version !== 'string') {
      throw new Error(`HTTP ${response.status}`);
    }
    if (!body.version.startsWith('0.19.')) {
      throw new Error(`version ${body.version} is not compatible with 0.19.x`);
    }
    return body.version;
  }

  private onProcessExit(instance: ManagedInstance, component: 'dashboard' | 'gateway', code: number | null, signal: NodeJS.Signals | null): void {
    this.handleUnexpectedProcessFailure(
      instance,
      component,
      new Error(`Hermes ${component} stopped unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'none'})`)
    );
  }

  private onProcessError(instance: ManagedInstance, component: 'dashboard' | 'gateway', error: Error): void {
    this.handleUnexpectedProcessFailure(instance, component, new Error(`${component}: ${error.message}`));
  }

  private handleUnexpectedProcessFailure(
    instance: ManagedInstance,
    component: 'dashboard' | 'gateway',
    error: Error
  ): void {
    if (instance.expectedStop || instance.crashCleanup) return;
    if (instance.healthTimer) clearInterval(instance.healthTimer);
    instance.healthTimer = null;
    instance.status = runtimeStatusError(
      instance.projectId,
      instance.homePath,
      this.withComponentLogs(error, instance),
      instance.status
    );
    this.persist(instance.status);
    this.diagnostic(
      instance.projectId,
      component,
      'error',
      instance.status.startedAt ?? this.now(),
      instance.status.lastError ?? undefined
    );
    const failure = instance.status.lastError ?? `Hermes ${component} stopped unexpectedly`;
    this.failProjectRunningQueueTurns(instance.projectId, failure);
    this.audit(`hermes.project.${component}.crash`, instance.projectId, failure);

    // A dashboard + gateway + proxy is one project runtime lease. Once any
    // member dies, keeping the siblings alive risks orphaned tools or stale UI.
    instance.expectedStop = true;
    instance.crashCleanup = (async () => {
      await instance.proxy.stop();
      await this.stopProcess(instance);
    })().catch((cleanupError: unknown) => {
      this.audit(
        'hermes.project.crash-cleanup-error',
        instance.projectId,
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      );
    });
  }

  private async stopProcess(instance: ManagedInstance): Promise<void> {
    await Promise.all([instance.process, instance.gatewayProcess].map(async (child) => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const exited = await Promise.race([
        new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000))
      ]);
      if (!exited && child.exitCode === null) child.kill('SIGKILL');
    }));
  }

  private prepareProjectHome(projectId: string, workspacePath: string): string {
    const home = this.projectHome(projectId);
    if (existsSync(home)) this.assertDirectoryNotSymlink(home);
    mkdirSync(home, { recursive: true });
    this.assertDirectoryNotSymlink(home);
    for (const directory of ['memories', 'skills', 'sessions']) {
      const path = join(home, directory);
      mkdirSync(path, { recursive: true });
      this.assertDirectoryNotSymlink(path);
    }
    const managedSkills = join(home, 'skills', 'opc-nexus');
    const managedRelative = relative(home, managedSkills);
    if (!managedRelative || managedRelative.startsWith('..') || managedRelative.includes(':')) {
      throw new Error('Hermes managed skill directory escaped the project home');
    }
    if (existsSync(managedSkills)) {
      this.assertDirectoryNotSymlink(managedSkills);
      rmSync(managedSkills, { recursive: true, force: true });
    }
    mkdirSync(managedSkills, { recursive: true });
    this.assertDirectoryNotSymlink(managedSkills);
    for (const skill of this.resolveProjectSkills(projectId)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(skill.id)) {
        throw new Error(`Selected project skill ${skill.id} has an invalid identity`);
      }
      const directory = join(managedSkills, skill.id);
      mkdirSync(directory, { recursive: true });
      this.assertDirectoryNotSymlink(directory);
      const frontmatterName = skill.name.replace(/[\r\n]/g, ' ').slice(0, 120);
      const description = skill.description.replace(/[\r\n]/g, ' ').slice(0, 500);
      this.atomicWrite(join(directory, 'SKILL.md'), [
        '---',
        `name: ${JSON.stringify(frontmatterName)}`,
        `description: ${JSON.stringify(description)}`,
        'allowed-tools: []',
        '---',
        '',
        skill.content,
        ''
      ].join('\n'));
    }
    const seeds: Record<string, string> = {
      'MEMORY.md': '# Project Memory\n',
      'USER.md': '# Owner Context\n',
      'SOUL.md': '# Hermes Project Orchestrator\n\nUnderstand the owner request, clarify material ambiguity, and propose bounded work.\n',
      'AGENTS.md': [
        '# OPC-Nexus Governance Contract',
        '',
        '- Read NEXUS-CONTEXT.md before selecting any employee, permission, or project path.',
        '- Answer genuinely simple requests directly without forcing a planning ceremony.',
        '- For complex or materially ambiguous work, use clarify before proposing a plan.',
        '- When clarify returns OPC_NEXUS_CLARIFY_PENDING, stop the current turn and tell the owner that the question is waiting for an answer.',
        '- Never call nexus_submit_plan in the same turn after a clarification becomes pending.',
        '- After clarification, call nexus_submit_plan and wait for the owner approval.',
        '- In every complex plan, assign each plan-level expected artifact to exactly one DAG node through that node expectedArtifacts. Never give every worker the whole delivery list.',
        '- When the owner explicitly @mentions an employee, use nexus_delegate_task with the exact validated employee id.',
        '- For a simple delegated task, use nexus_delegate_task without forcing a multi-step plan.',
        '- Classify each employee request as execution, status_inquiry, or validation. A progress/status inquiry must use status_inquiry with no expected artifacts.',
        '- For independent acceptance, assign a different qualified employee with intent validation and include related task ids when known.',
        '- A validation task returns a factual verdict in its task result. Require a new file only when the owner explicitly requested a report artifact.',
        '- After dispatch, use nexus_task_status to obtain the real terminal state and result before summarizing. Accepted, queued, and running are not completion.',
        '- Do not use native delegate_task for OPC-Nexus business delegation.',
        '- OPC-Nexus Main owns approval, task state, execution state, permissions, budget, and audit facts.',
        '- Never claim approval or completion, create fictional employees, or bypass the approved project workspace.'
      ].join('\n')
    };
    for (const [name, content] of Object.entries(seeds)) this.seedFile(join(home, name), content);
    this.prepareEmployeeMemoryScopes(projectId, home);
    this.atomicWrite(join(home, 'NEXUS-CONTEXT.md'), this.projectContext(projectId, workspacePath));
    const provider = this.resolveProviderEnvironment(projectId);
    const model = provider.HERMES_INFERENCE_MODEL ?? provider.OPENAI_MODEL ?? '';
    const baseUrl = provider.OPENAI_BASE_URL ?? provider.OPENAI_API_BASE ?? '';
    const config = {
      model: {
        default: model,
        provider: 'custom:opcnexus',
        base_url: baseUrl,
        api_mode: 'chat_completions',
        max_tokens: HERMES_MAX_OUTPUT_TOKENS
      },
      providers: {
        opcnexus: {
          name: 'OPC-Nexus',
          base_url: baseUrl,
          key_env: 'OPENAI_API_KEY',
          default_model: model,
          model,
          api_mode: 'chat_completions',
          max_tokens: HERMES_MAX_OUTPUT_TOKENS
        }
      },
      dashboard: { host: HOST },
      platforms: { api_server: { enabled: true } },
      platform_toolsets: { api_server: ['hermes-api-server', 'planning'] },
      // Main supplies a fail-closed per-conversation policy on every turn.
      // Keeping the process default disabled prevents accidental project-wide
      // memory sharing if a non-Nexus API route is called.
      memory: { memory_enabled: false, user_profile_enabled: false, provider: '' }
    };
    this.atomicWrite(join(home, 'config.yaml'), `${JSON.stringify(config, null, 2)}\n`);
    rmSync(join(home, '.env'), { force: true });
    rmSync(join(home, 'auth.json'), { force: true });
    return home;
  }

  private requireProjectWorkspace(projectId: string): string {
    const configured = this.resolveProjectWorkspace(projectId)?.trim() ?? '';
    if (!configured) {
      throw new Error('Hermes requires an approved project working directory. Reopen Workbench and select the delivery directory.');
    }
    const workspace = resolve(configured);
    try { this.assertDirectoryNotSymlink(workspace); }
    catch { throw new Error('The approved Hermes project working directory is missing or is a symbolic link. Select it again.'); }
    return workspace;
  }

  /**
   * Persist failures that happen before a child process exists. Without this
   * record the UI only receives a rejected IPC promise and a stale `stopped`
   * profile, which makes a missing credential indistinguishable from a crash
   * after restart. The error is intentionally limited to the preflight reason
   * and never includes the provider environment or secret.
   */
  private persistStartupFailure(projectId: string, error: unknown, startedAt: number): Error {
    const message = error instanceof Error ? error.message : String(error);
    const previous = this.getStatus(projectId);
    const failure = runtimeStatusError(projectId, this.projectHome(projectId), message, {
      ...previous,
      startedAt
    });
    this.persist(failure);
    this.diagnostic(projectId, 'runtime', 'error', startedAt, failure.lastError ?? undefined);
    this.audit('hermes.project.start-preflight-failed', projectId, failure.lastError ?? 'unknown error');
    return new Error(failure.lastError ?? 'Hermes failed its startup checks');
  }

  private projectContext(projectId: string, workspacePath: string): string {
    const project = this.db.raw.prepare(`
      SELECT id, organization_id, name, objective, description, client_name, status, due_at
      FROM projects WHERE id = ? AND status <> 'archived'
    `).get(projectId) as Record<string, unknown> | undefined;
    if (!project || project.id !== projectId || typeof project.organization_id !== 'string') {
      throw new Error('Hermes project context is unavailable');
    }
    const employees = this.db.raw.prepare(`
      SELECT id, name, role, engine_id, lifecycle, permission_mode, memory_mode, capabilities_json, concurrency_limit
      FROM agents
      WHERE organization_id = ? AND archived = 0 AND lifecycle = 'READY'
      ORDER BY created_at, id
    `).all(project.organization_id) as Array<Record<string, unknown>>;
    const configuredWorkerIds = [...new Set(this.resolveProjectWorkerPool(projectId))];
    const restrictedWorkerIds = new Set(configuredWorkerIds);
    const eligibleEmployees = configuredWorkerIds.length > 0
      ? employees.filter((employee) => restrictedWorkerIds.has(String(employee.id)))
      : employees;
    const safeEmployees = eligibleEmployees.map((employee) => {
      let capabilities: unknown = {};
      try {
        const parsed = JSON.parse(String(employee.capabilities_json ?? '{}')) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) capabilities = parsed;
      } catch { /* corrupt capabilities remain unavailable */ }
      return {
        id: String(employee.id),
        name: String(employee.name),
        role: String(employee.role),
        engineId: String(employee.engine_id),
        lifecycle: 'READY',
        permissionMode: String(employee.permission_mode),
        memoryMode: ['long_term', 'short_term', 'none'].includes(String(employee.memory_mode))
          ? String(employee.memory_mode)
          : 'short_term',
        capabilities,
        concurrencyLimit: Number(employee.concurrency_limit)
      };
    });
    return [
      '# OPC-Nexus Project Context',
      '',
      'This file is generated by OPC-Nexus Main. Treat it as read-only host policy.',
      '',
      '```json',
      JSON.stringify({
        project: {
          id: String(project.id),
          name: String(project.name),
          objective: String(project.objective ?? ''),
          description: String(project.description ?? ''),
          clientName: String(project.client_name ?? ''),
          status: String(project.status),
          dueAt: project.due_at ?? null,
          workspace: workspacePath
        },
        employees: safeEmployees,
        governance: {
          planAuthority: 'OPC-Nexus host governance',
          memoryAuthority: 'Hermes project files',
          workerSelectionMode: configuredWorkerIds.length > 0 ? 'restricted' : 'dynamic',
          allowedWorkerIds: safeEmployees.map((employee) => employee.id),
          nativeDelegationAllowed: false,
          acceptanceWorkflow: {
            owner: 'Hermes primary coordinator',
            validatorMustDifferFromImplementationWorker: true,
            verdicts: ['PASS', 'FAIL', 'BLOCKED'],
            completionRequiresPass: true
          }
        }
      }, null, 2),
      '```',
      '',
      '## Mandatory acceptance workflow',
      '',
      'After executable project work finishes, the primary Hermes coordinator must:',
      '1. Read every implementation task to a real terminal state with nexus_task_status.',
      '2. Select a qualified READY employee who did not implement any related task.',
      '3. Dispatch that employee with nexus_delegate_task intent validation and the implementation task ids in relatedTaskIds.',
      '4. Read the validation task to a real terminal state with nexus_task_status.',
      '5. Report delivery complete only when validationVerdict is PASS. Keep FAIL unaccepted and propose bounded rework; report BLOCKED honestly.',
      ''
    ].join('\n');
  }

  private seedFile(path: string, content: string): void {
    try { writeFileSync(path, content, { encoding: 'utf8', flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }

  private atomicWrite(path: string, content: string): void {
    const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' });
    try { renameSync(temp, path); }
    catch (error) { rmSync(temp, { force: true }); throw error; }
  }

  private assertProject(projectId: string): void {
    if (!PROJECT_ID.test(projectId)) throw new Error('Hermes projectId is invalid');
    const row = this.db.raw.prepare(
      "SELECT id FROM projects WHERE id = ? AND status <> 'archived'"
    ).get(projectId) as { id?: string } | undefined;
    if (row?.id !== projectId) throw new Error('Hermes project does not exist or is archived');
  }

  private ensureSessionBindingIdentityColumn(): void {
    const columns = this.db.raw.prepare('PRAGMA table_info(hermes_session_bindings)').all() as Array<{ name?: string }>;
    if (columns.some((column) => column.name === 'identity_key')) return;
    this.db.raw.prepare('ALTER TABLE hermes_session_bindings ADD COLUMN identity_key TEXT').run();
  }

  private migrateLegacyHermesBindingColumns(): void {
    let migrated = false;
    this.db.transaction(() => {
      const sessionColumns = new Set(
        (this.db.raw.prepare('PRAGMA table_info(hermes_session_bindings)').all() as Array<{ name?: string }>)
          .map((column) => column.name)
          .filter((name): name is string => typeof name === 'string')
      );
      if (sessionColumns.has('dsh_session_id')) {
        this.db.raw.prepare('ALTER TABLE hermes_session_bindings DROP COLUMN dsh_session_id').run();
        migrated = true;
      }

      const runColumns = new Set(
        (this.db.raw.prepare('PRAGMA table_info(hermes_run_bindings)').all() as Array<{ name?: string }>)
          .map((column) => column.name)
          .filter((name): name is string => typeof name === 'string')
      );
      if (runColumns.has('dsh_job_id') && !runColumns.has('nexus_task_id')) {
        this.db.raw.prepare('ALTER TABLE hermes_run_bindings RENAME COLUMN dsh_job_id TO nexus_task_id').run();
        runColumns.delete('dsh_job_id');
        runColumns.add('nexus_task_id');
        migrated = true;
      }
      if (runColumns.has('dsh_run_id') && !runColumns.has('worker_run_id')) {
        this.db.raw.prepare('ALTER TABLE hermes_run_bindings RENAME COLUMN dsh_run_id TO worker_run_id').run();
        migrated = true;
      }
    });
    if (migrated) {
      this.db.audit({
        id: randomUUID(), actor: 'system', action: 'hermes.binding.schema.migrate',
        target: 'hermes-bindings', result: 'legacy-dsh-columns-removed'
      });
    }
  }

  private ensureChatQueueCancellationColumn(): void {
    const columns = this.db.raw.prepare('PRAGMA table_info(hermes_chat_queue)').all() as Array<{ name?: string }>;
    if (columns.some((column) => column.name === 'cancel_requested_at')) return;
    this.db.raw.prepare('ALTER TABLE hermes_chat_queue ADD COLUMN cancel_requested_at INTEGER').run();
  }

  private ensureChatQueueActivityColumn(): void {
    const columns = this.db.raw.prepare('PRAGMA table_info(hermes_chat_queue)').all() as Array<{ name?: string }>;
    if (columns.some((column) => column.name === 'activity_json')) return;
    this.db.raw.prepare("ALTER TABLE hermes_chat_queue ADD COLUMN activity_json TEXT NOT NULL DEFAULT '[]'").run();
  }

  private identityKey(context: string): string {
    return createHash('sha256').update(`quest-identity-v2-memory\n${context}`, 'utf8').digest('hex');
  }

  private employeeMemoryScope(employeeId: string): string {
    return `employee-${createHash('sha256').update(employeeId, 'utf8').digest('hex').slice(0, 32)}`;
  }

  private conversationMemoryPolicy(projectId: string, conversationId: string): ConversationMemoryPolicy {
    const row = this.db.raw.prepare(`
      SELECT p.employee_id, a.memory_mode
      FROM conversations c
      LEFT JOIN hermes_conversation_profiles p
        ON p.project_id = c.project_id AND p.conversation_id = c.id
      LEFT JOIN agents a
        ON a.id = p.employee_id
       AND a.organization_id = c.organization_id
       AND a.archived = 0
       AND a.lifecycle = 'READY'
      WHERE c.id = ? AND c.project_id = ?
    `).get(conversationId, projectId) as { employee_id?: string | null; memory_mode?: string | null } | undefined;
    if (!row) throw new Error('Hermes project conversation is unavailable');
    if (!row.employee_id) return { mode: 'long_term', scope: 'project' };
    if (!row.memory_mode) throw new Error('The digital employee memory policy is unavailable');
    const mode = ['long_term', 'short_term', 'none'].includes(row.memory_mode)
      ? row.memory_mode as ConversationMemoryPolicy['mode']
      : 'short_term';
    return { mode, scope: this.employeeMemoryScope(row.employee_id) };
  }

  private prepareEmployeeMemoryScopes(projectId: string, home: string): void {
    const project = this.db.raw.prepare('SELECT organization_id FROM projects WHERE id = ?')
      .get(projectId) as { organization_id?: string } | undefined;
    if (!project?.organization_id) throw new Error('Hermes project memory scope is unavailable');
    const employees = this.db.raw.prepare(`
      SELECT id FROM agents
      WHERE organization_id = ? AND archived = 0 AND memory_mode = 'long_term'
      ORDER BY id
    `).all(project.organization_id) as Array<{ id: string }>;
    for (const employee of employees) {
      const directory = join(home, 'memories', 'employees', this.employeeMemoryScope(employee.id));
      const child = relative(home, directory);
      if (!child || child.startsWith('..') || child.includes(':')) {
        throw new Error('Hermes employee memory directory escaped the project home');
      }
      mkdirSync(directory, { recursive: true });
      this.assertDirectoryNotSymlink(directory);
      this.seedFile(join(directory, 'MEMORY.md'), '');
      this.seedFile(join(directory, 'USER.md'), '');
    }
  }

  private assertDirectoryNotSymlink(path: string): void {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Hermes managed root cannot be a symbolic link');
  }

  private profileRow(projectId: string): ProfileRow | null {
    return (this.db.raw.prepare(
      'SELECT * FROM hermes_project_profiles WHERE project_id = ?'
    ).get(projectId) as unknown as ProfileRow | undefined) ?? null;
  }

  private persist(status: HermesRuntimeStatus): void {
    const project = this.db.raw.prepare('SELECT organization_id FROM projects WHERE id = ?').get(status.projectId) as { organization_id?: string } | undefined;
    if (!project?.organization_id) return;
    const existing = this.profileRow(status.projectId);
    const now = this.now();
    this.db.raw.prepare(`
      INSERT INTO hermes_project_profiles(
        id, organization_id, project_id, home_path, runtime_version, service_port, proxy_port,
        auth_secret_ref, status, last_health_at, last_error, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        home_path = excluded.home_path,
        runtime_version = excluded.runtime_version,
        service_port = excluded.service_port,
        proxy_port = excluded.proxy_port,
        status = excluded.status,
        last_health_at = excluded.last_health_at,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(
      existing ? `hermes-${status.projectId}` : `hermes-${status.projectId}`,
      project.organization_id,
      status.projectId,
      status.homePath,
      status.version ?? HERMES_RUNTIME_VERSION,
      status.port,
      status.proxyPort,
      `ephemeral:hermes:${status.projectId}`,
      status.state,
      status.lastHealthAt,
      status.lastError,
      existing?.created_at ?? now,
      now
    );
  }

  private reconcileStaleQueueItems(): void {
    const now = this.now();
    this.db.raw.prepare(`
      UPDATE hermes_chat_queue
      SET status = 'FAILED',
          last_error = 'OPC-Nexus restarted while this turn was running. Check the conversation before retrying to avoid duplicate execution.',
          completed_at = ?, updated_at = ?
      WHERE status = 'RUNNING'
    `).run(now, now);
  }

  private resumeQueuedProjectTurns(projectId: string): void {
    const conversations = this.db.raw.prepare(`
      SELECT DISTINCT conversation_id FROM hermes_chat_queue
      WHERE project_id = ? AND status = 'QUEUED'
      ORDER BY conversation_id
    `).all(projectId) as Array<{ conversation_id?: string }>;
    for (const row of conversations) {
      if (row.conversation_id) this.scheduleConversationDrain(projectId, row.conversation_id);
    }
  }

  private scheduleConversationDrain(projectId: string, conversationId: string): void {
    const key = `${projectId}\u0000${conversationId}`;
    if (this.queueDrains.has(key)) return;
    const drain = Promise.resolve()
      .then(() => this.drainConversationQueue(projectId, conversationId))
      .catch((error: unknown) => {
        this.audit('hermes.chat.queue.drain-error', projectId, error instanceof Error ? error.message : String(error));
      })
      .finally(() => this.queueDrains.delete(key));
    this.queueDrains.set(key, drain);
  }

  private async drainConversationQueue(projectId: string, conversationId: string): Promise<void> {
    while (this.instances.get(projectId)?.status.state === 'healthy') {
      const row = this.db.raw.prepare(`
        SELECT * FROM hermes_chat_queue
        WHERE project_id = ? AND conversation_id = ? AND status = 'QUEUED'
        ORDER BY created_at, id LIMIT 1
      `).get(projectId, conversationId) as unknown as ChatQueueRow | undefined;
      if (!row) return;
      const startedAt = this.now();
      const claimed = this.db.raw.prepare(`
        UPDATE hermes_chat_queue
        SET status = 'RUNNING', attempts = attempts + 1, stream_text = '', activity_json = '[]',
            last_error = NULL, cancel_requested_at = NULL, started_at = ?,
            completed_at = NULL, updated_at = ?
        WHERE id = ? AND project_id = ? AND status = 'QUEUED'
      `).run(startedAt, startedAt, row.id, projectId);
      if (claimed.changes !== 1) continue;
      let item = this.requireQueueItem(projectId, row.id);
      const abortController = new AbortController();
      this.runningQueueTurns.set(row.id, abortController);
      this.publishQueueEvent(projectId, {
        type: 'chat.queue.updated', projectId, queueId: row.id, conversationId,
        timestamp: startedAt, item
      });

      let partialContent = '';
      let activities: HermesChatActivity[] = [];
      let activitySerial = 0;
      let lastPersistAt = 0;
      const publishActivities = () => {
        this.db.raw.prepare(`
          UPDATE hermes_chat_queue
          SET stream_text = ?, activity_json = ?, updated_at = ?
          WHERE id = ? AND project_id = ? AND status = 'RUNNING'
        `).run(partialContent, JSON.stringify(activities), this.now(), row.id, projectId);
        const current = this.requireQueueItem(projectId, row.id);
        this.publishQueueEvent(projectId, {
          type: 'chat.queue.updated', projectId, queueId: row.id, conversationId,
          timestamp: this.now(), item: current
        });
      };
      const updateActivity = (event: {
        kind: 'reasoning' | 'tool';
        phase: 'running' | 'completed' | 'failed';
        toolName: string | null;
        detail: string | null;
      }) => {
        const timestamp = this.now();
        if (event.kind === 'reasoning') {
          if (activities.some((activity) => activity.kind === 'reasoning' && activity.status === 'running')) return;
          activities.push({
            id: `${row.id}:activity:${++activitySerial}`,
            kind: 'reasoning',
            title: '正在分析任务与下一步操作',
            status: 'running',
            toolName: null,
            detail: 'Hermes 正在分析任务边界并选择下一步操作。内部私密推理不会直接展示。',
            startedAt: timestamp,
            updatedAt: timestamp
          });
        } else if (event.phase === 'running') {
          activities = activities.map((activity) => activity.kind === 'reasoning' && activity.status === 'running'
            ? { ...activity, title: '分析完成', status: 'completed', updatedAt: timestamp }
            : activity);
          const toolName = safeToolName(event.toolName);
          activities.push({
            id: `${row.id}:activity:${++activitySerial}`,
            kind: 'tool_call',
            title: `正在调用工具 · ${toolName}`,
            status: 'running',
            toolName,
            detail: event.detail,
            startedAt: timestamp,
            updatedAt: timestamp
          });
        } else {
          const toolName = safeToolName(event.toolName);
          let targetIndex = -1;
          for (let index = activities.length - 1; index >= 0; index -= 1) {
            const activity = activities[index]!;
            if (activity.kind === 'tool_call'
              && activity.status === 'running'
              && activity.toolName === toolName) {
              targetIndex = index;
              break;
            }
          }
          if (targetIndex >= 0) {
            const current = activities[targetIndex]!;
            activities[targetIndex] = {
              ...current,
              title: `${event.phase === 'failed' ? '工具失败' : '工具完成'} · ${toolName}`,
              status: event.phase === 'failed' ? 'failed' : 'completed',
              detail: event.detail ?? current.detail,
              updatedAt: timestamp
            };
          } else {
            activities.push({
              id: `${row.id}:activity:${++activitySerial}`,
              kind: 'tool_result',
              title: `${event.phase === 'failed' ? '工具失败' : '工具返回'} · ${toolName}`,
              status: event.phase === 'failed' ? 'failed' : 'completed',
              toolName,
              detail: event.detail,
              startedAt: timestamp,
              updatedAt: timestamp
            });
          }
        }
        publishActivities();
      };
      try {
        const result = await this.runProjectTurn(projectId, {
          conversationId,
          principalId: row.principal_id,
          message: row.message,
          title: row.title || undefined,
          systemMessage: row.system_message || undefined
        }, {
          signal: abortController.signal,
          onDelta: (delta) => {
            if (abortController.signal.aborted) return;
            partialContent += delta;
            const wallNow = Date.now();
            if (wallNow - lastPersistAt >= 250) {
              lastPersistAt = wallNow;
              this.db.raw.prepare(`
                UPDATE hermes_chat_queue SET stream_text = ?, updated_at = ?
                WHERE id = ? AND project_id = ? AND status = 'RUNNING'
              `).run(partialContent, this.now(), row.id, projectId);
            }
            this.publishQueueEvent(projectId, {
              type: 'chat.queue.delta', projectId, queueId: row.id, conversationId,
              timestamp: this.now(), delta
            });
          },
          onActivity: updateActivity
        });
        const completedAt = this.now();
        activities = activities.map((activity) => activity.status === 'running'
          ? { ...activity, title: activity.kind === 'reasoning' ? '分析完成' : activity.title, status: 'completed', updatedAt: completedAt }
          : activity);
        const completed = this.db.raw.prepare(`
          UPDATE hermes_chat_queue
          SET status = 'COMPLETED', stream_text = ?, activity_json = ?, result_json = ?, last_error = NULL,
              completed_at = ?, updated_at = ?
          WHERE id = ? AND project_id = ? AND status = 'RUNNING'
            AND cancel_requested_at IS NULL
        `).run(
          result.content,
          JSON.stringify(activities),
          JSON.stringify({
            hermesSessionId: result.hermesSessionId,
            usage: result.usage,
            runtime: result.runtime,
            createdAt: result.createdAt
          }),
          completedAt,
          completedAt,
          row.id,
          projectId
        );
        item = this.requireQueueItem(projectId, row.id);
        if (completed.changes === 1) {
          this.audit('hermes.chat.queue.complete', projectId, `queue=${row.id};conversation=${conversationId}`);
          this.publishQueueEvent(projectId, {
            type: 'chat.queue.updated', projectId, queueId: row.id, conversationId,
            timestamp: completedAt, item
          });
        } else if (item.status === 'RUNNING' && item.cancelRequestedAt !== null) {
          item = this.settleCancelledQueueTurn(projectId, row.id, conversationId);
        }
      } catch (error) {
        const current = this.requireQueueItem(projectId, row.id);
        if (current.status === 'CANCELLED') continue;
        if (current.status === 'RUNNING' && current.cancelRequestedAt !== null) {
          this.settleCancelledQueueTurn(projectId, row.id, conversationId);
          continue;
        }
        const failedAt = this.now();
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
        activities = activities.map((activity) => activity.status === 'running'
          ? { ...activity, status: 'failed', updatedAt: failedAt }
          : activity);
        this.db.raw.prepare(`
          UPDATE hermes_chat_queue
          SET status = 'FAILED', stream_text = ?, activity_json = ?, last_error = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND project_id = ? AND status = 'RUNNING'
        `).run(partialContent, JSON.stringify(activities), message, failedAt, failedAt, row.id, projectId);
        item = this.requireQueueItem(projectId, row.id);
        this.audit('hermes.chat.queue.failed', projectId, `queue=${row.id};error=${message}`);
        this.publishQueueEvent(projectId, {
          type: 'chat.queue.updated', projectId, queueId: row.id, conversationId,
          timestamp: failedAt, item
        });
        if (this.instances.get(projectId)?.status.state !== 'healthy') return;
      } finally {
        if (this.runningQueueTurns.get(row.id) === abortController) {
          this.runningQueueTurns.delete(row.id);
        }
      }
    }
  }

  /** Notify the embedded Quest surface that durable scheduling facts changed. */
  publishProjectStateEvent(
    projectId: string,
    reason: 'task' | 'session' | 'plan' | 'clarification' = 'task'
  ): void {
    const event = {
      type: 'project.state.updated',
      projectId,
      timestamp: this.now(),
      reason
    } as const;
    this.instances.get(projectId)?.proxy.publishProjectEvent(event);
    this.onProjectEvent?.(projectId, event);
  }

  private publishQueueEvent(projectId: string, event: HermesChatQueueEvent): void {
    this.instances.get(projectId)?.proxy.publishProjectEvent(event);
    this.onProjectEvent?.(projectId, event);
  }

  private nextQueueCreatedAt(projectId: string, conversationId: string): number {
    const latest = this.db.raw.prepare(`
      SELECT MAX(created_at) AS created_at FROM hermes_chat_queue
      WHERE project_id = ? AND conversation_id = ?
    `).get(projectId, conversationId) as { created_at?: number | null } | undefined;
    return Math.max(this.now(), Number(latest?.created_at ?? 0) + 1);
  }

  private settleCancelledQueueTurn(
    projectId: string,
    queueId: string,
    conversationId: string
  ): HermesChatQueueItem {
    const settledAt = this.now();
    const current = this.requireQueueItem(projectId, queueId);
    const activities = current.activities.map((activity) => activity.status === 'running'
      ? { ...activity, status: 'cancelled' as const, updatedAt: settledAt }
      : activity);
    const updated = this.db.raw.prepare(`
      UPDATE hermes_chat_queue
      SET status = 'CANCELLED', activity_json = ?, last_error = NULL, completed_at = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND status = 'RUNNING'
        AND cancel_requested_at IS NOT NULL
    `).run(JSON.stringify(activities), settledAt, settledAt, queueId, projectId);
    const item = this.requireQueueItem(projectId, queueId);
    if (updated.changes === 1) {
      this.audit(
        'hermes.chat.queue.cancelled',
        projectId,
        `queue=${queueId};conversation=${conversationId};executor=settled`
      );
      this.publishQueueEvent(projectId, {
        type: 'chat.queue.updated', projectId, queueId, conversationId,
        timestamp: settledAt, item
      });
    }
    return item;
  }

  private failProjectRunningQueueTurns(projectId: string, failure: string): void {
    const rows = this.db.raw.prepare(`
      SELECT id, conversation_id FROM hermes_chat_queue
      WHERE project_id = ? AND status = 'RUNNING'
      ORDER BY created_at, id
    `).all(projectId) as Array<{ id?: string; conversation_id?: string }>;
    const failedAt = this.now();
    const message = `Hermes project runtime stopped before this instruction completed: ${failure}`.slice(0, 4_000);
    for (const row of rows) {
      if (!row.id || !row.conversation_id) continue;
      this.runningQueueTurns.get(row.id)?.abort(new Error(message));
      const updated = this.db.raw.prepare(`
        UPDATE hermes_chat_queue
        SET status = 'FAILED', last_error = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND project_id = ? AND status = 'RUNNING'
      `).run(message, failedAt, failedAt, row.id, projectId);
      if (updated.changes !== 1) continue;
      const item = this.requireQueueItem(projectId, row.id);
      this.audit('hermes.chat.queue.failed', projectId, `queue=${row.id};runtime=crashed`);
      this.publishQueueEvent(projectId, {
        type: 'chat.queue.updated', projectId, queueId: row.id,
        conversationId: row.conversation_id, timestamp: failedAt, item
      });
    }
  }

  private requireQueueItem(projectId: string, queueId: string): HermesChatQueueItem {
    const row = this.db.raw.prepare(`
      SELECT * FROM hermes_chat_queue WHERE id = ? AND project_id = ?
    `).get(queueId, projectId) as unknown as ChatQueueRow | undefined;
    if (!row) throw new Error('Hermes queue item is unavailable');
    let position: number | null = null;
    if (row.status === 'QUEUED') {
      const ahead = this.db.raw.prepare(`
        SELECT COUNT(*) AS count FROM hermes_chat_queue
        WHERE project_id = ? AND conversation_id = ? AND status = 'QUEUED'
          AND (created_at < ? OR (created_at = ? AND id <= ?))
      `).get(projectId, row.conversation_id, row.created_at, row.created_at, row.id) as { count?: number } | undefined;
      position = Number(ahead?.count ?? 1);
    }
    return this.toQueueItem(row, position);
  }

  private toQueueItem(row: ChatQueueRow, queuePosition: number | null): HermesChatQueueItem {
    return {
      id: row.id,
      projectId: row.project_id,
      conversationId: row.conversation_id,
      message: row.message,
      status: row.status,
      queuePosition,
      attempts: Number(row.attempts),
      partialContent: row.stream_text ?? '',
      activities: parseChatActivities(row.activity_json),
      error: row.last_error ?? null,
      cancelRequestedAt: row.cancel_requested_at === null ? null : Number(row.cancel_requested_at),
      createdAt: Number(row.created_at),
      startedAt: row.started_at === null ? null : Number(row.started_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
      updatedAt: Number(row.updated_at)
    };
  }

  private reconcileStaleProfiles(): void {
    this.db.raw.prepare(`
      UPDATE hermes_project_profiles
      SET status = 'stopped', service_port = NULL, proxy_port = NULL,
          last_error = CASE WHEN status IN ('starting', 'healthy', 'degraded', 'stopping')
            THEN 'OPC-Nexus restarted; the prior Hermes process lease was released' ELSE last_error END,
          updated_at = ?
      WHERE status IN ('starting', 'healthy', 'degraded', 'stopping')
    `).run(this.now());
  }

  private runtimeState(value: string): HermesProjectBinding['status'] {
    return ['stopped', 'starting', 'healthy', 'degraded', 'error', 'stopping'].includes(value)
      ? value as HermesProjectBinding['status']
      : 'error';
  }

  private async gatewaySse(
    instance: ManagedInstance,
    path: string,
    body: unknown,
    timeoutMs: number,
    extraHeaders: Record<string, string>,
    handlers: HermesProjectTurnStreamHandlers
  ): Promise<Record<string, unknown>> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Hermes API path is invalid');
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = handlers.signal
      ? AbortSignal.any([timeoutSignal, handlers.signal])
      : timeoutSignal;
    const response = await fetch(new URL(path, instance.gatewayUrl), {
      method: 'POST',
      signal,
      headers: {
        authorization: `Bearer ${instance.gatewayToken}`,
        accept: 'text/event-stream',
        'content-type': 'application/json',
        ...extraHeaders
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const raw = await response.text();
      let message = `Hermes API request failed with HTTP ${response.status}`;
      try {
        const payload = JSON.parse(raw) as Record<string, unknown>;
        const error = payload.error && typeof payload.error === 'object' && !Array.isArray(payload.error)
          ? payload.error as Record<string, unknown>
          : {};
        if (typeof error.message === 'string') message = error.message;
        else if (typeof payload.message === 'string') message = payload.message;
      } catch { /* retain the HTTP status without reflecting an arbitrary body */ }
      throw new Error(message.slice(0, 4_000));
    }
    if (!String(response.headers.get('content-type') ?? '').includes('text/event-stream') || !response.body) {
      throw new Error('Hermes streaming API returned an invalid response');
    }

    let buffer = '';
    let responseBytes = 0;
    let content = '';
    let responseSessionId = '';
    let usage: Record<string, unknown> = {};
    let runtime: Record<string, unknown> = {};
    let terminalError = '';
    let runId = String(response.headers.get('x-hermes-run-id') ?? '').trim();
    const consume = (frame: string) => {
      let event = 'message';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length === 0) return;
      let payload: Record<string, unknown>;
      try {
        const parsed = JSON.parse(data.join('\n')) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        payload = parsed as Record<string, unknown>;
      } catch { return; }
      if (event === 'run.started') {
        if (typeof payload.run_id === 'string') runId = payload.run_id.trim();
        handlers.onStarted?.();
      }
      if (event === 'assistant.delta' && typeof payload.delta === 'string' && payload.delta) {
        content += payload.delta;
        handlers.onDelta?.(payload.delta);
      }
      if (event === 'tool.progress' && payload.tool_name === '_thinking') {
        handlers.onActivity?.({
          kind: 'reasoning',
          phase: 'running',
          toolName: null,
          // Do not project raw chain-of-thought. The event itself is useful
          // as a truthful progress signal; private reasoning remains in Main.
          detail: null
        });
      }
      if (event === 'tool.started' || event === 'tool.completed' || event === 'tool.failed') {
        handlers.onActivity?.({
          kind: 'tool',
          phase: event === 'tool.started' ? 'running' : event === 'tool.failed' ? 'failed' : 'completed',
          toolName: typeof payload.tool_name === 'string' ? payload.tool_name : null,
          detail: safeHermesActivityDetail(payload.args ?? payload.preview)
        });
      }
      if (event === 'assistant.completed') {
        if (typeof payload.content === 'string') content = payload.content;
        if (typeof payload.session_id === 'string') responseSessionId = payload.session_id;
        if (payload.runtime && typeof payload.runtime === 'object' && !Array.isArray(payload.runtime)) {
          runtime = payload.runtime as Record<string, unknown>;
        }
      }
      if (event === 'run.completed') {
        if (typeof payload.session_id === 'string') responseSessionId = payload.session_id;
        if (payload.usage && typeof payload.usage === 'object' && !Array.isArray(payload.usage)) {
          usage = payload.usage as Record<string, unknown>;
        }
        if (payload.runtime && typeof payload.runtime === 'object' && !Array.isArray(payload.runtime)) {
          runtime = payload.runtime as Record<string, unknown>;
        }
      }
      if (event === 'error') {
        terminalError = typeof payload.message === 'string' ? payload.message : 'Hermes streaming turn failed';
      }
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        responseBytes += chunk.value.byteLength;
        if (responseBytes > 32 * 1024 * 1024) {
          await reader.cancel();
          throw new Error('Hermes streaming response exceeded 32 MiB');
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          consume(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch (error) {
      if (handlers.signal?.aborted && runId) {
        await this.acknowledgeHermesSessionCancellation(instance, path, runId);
      }
      throw error;
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    if (terminalError) throw new Error(terminalError.slice(0, 4_000));
    return {
      session_id: responseSessionId,
      message: { role: 'assistant', content },
      usage,
      runtime
    };
  }

  private async acknowledgeHermesSessionCancellation(
    instance: ManagedInstance,
    streamPath: string,
    runId: string
  ): Promise<void> {
    const match = /^\/api\/sessions\/([^/]+)\/chat\/stream$/.exec(streamPath);
    if (!match || !/^run_[A-Za-z0-9]+$/.test(runId)) return;
    const response = await fetch(
      new URL(`/api/sessions/${match[1]}/interrupt`, instance.gatewayUrl),
      {
        method: 'POST',
        signal: AbortSignal.timeout(35_000),
        headers: {
          authorization: `Bearer ${instance.gatewayToken}`,
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ run_id: runId, reason: 'Cancelled by the OPC-Nexus project owner' })
      }
    );
    if (response.ok || response.status === 404 || response.status === 409) return;
    throw new Error(`Hermes cancellation acknowledgement failed with HTTP ${response.status}`);
  }

  private async gatewayJson(
    instance: ManagedInstance,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    timeoutMs = 30_000,
    extraHeaders: Record<string, string> = {}
  ): Promise<unknown> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Hermes API path is invalid');
    const response = await fetch(new URL(path, instance.gatewayUrl), {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: `Bearer ${instance.gatewayToken}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extraHeaders
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try { payload = JSON.parse(text) as unknown; }
      catch { throw new Error(`Hermes API returned non-JSON HTTP ${response.status}`); }
    }
    if (!response.ok) {
      const record = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {};
      const error = record.error && typeof record.error === 'object' && !Array.isArray(record.error)
        ? record.error as Record<string, unknown>
        : {};
      const message = typeof error.message === 'string'
        ? error.message
        : typeof record.message === 'string'
          ? record.message
          : `Hermes API request failed with HTTP ${response.status}`;
      throw new Error(message.slice(0, 4_000));
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Hermes API returned an invalid JSON response');
    }
    return payload;
  }

  private nonnegativeInteger(value: unknown): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  private isMissingHermesSessionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return /(?:session|conversation)\s+(?:not found|does not exist|unknown)/i.test(message);
  }

  private async recreateBoundProjectSession(
    instance: ManagedInstance,
    projectId: string,
    binding: { conversation_id?: string; principal_id?: string; hermes_session_id?: string },
    memoryPolicy: ConversationMemoryPolicy,
    runtimeLock: { model: string; provider: string; require_model_lock: true }
  ): Promise<string> {
    const conversationId = binding.conversation_id?.trim() ?? '';
    const previousSessionId = binding.hermes_session_id?.trim() ?? '';
    if (!conversationId || !previousSessionId) throw new Error('Hermes session binding is incomplete');
    const nextSessionId = `nexus_${randomUUID().replace(/-/g, '')}`;
    await this.gatewayJson(instance, 'POST', '/api/sessions', {
      id: nextSessionId,
      source: 'nexus-recovery',
      title: 'OPC-Nexus recovered project conversation',
      nexus_memory_mode: memoryPolicy.mode,
      nexus_memory_scope: memoryPolicy.scope,
      ...runtimeLock
    });
    const updated = this.db.raw.prepare(`
      UPDATE hermes_session_bindings
      SET hermes_session_id = ?, last_seen_at = ?
      WHERE project_id = ? AND conversation_id = ? AND hermes_session_id = ?
    `).run(nextSessionId, this.now(), projectId, conversationId, previousSessionId);
    if (Number(updated.changes ?? 0) !== 1) {
      const current = this.db.raw.prepare(`
        SELECT hermes_session_id FROM hermes_session_bindings
        WHERE project_id = ? AND conversation_id = ?
      `).get(projectId, conversationId) as { hermes_session_id?: string } | undefined;
      if (current?.hermes_session_id && current.hermes_session_id !== previousSessionId) {
        return current.hermes_session_id;
      }
      throw new Error('Hermes session binding changed during recovery');
    }
    this.audit(
      'hermes.project.session.recover',
      projectId,
      `conversation=${conversationId};previous=${previousSessionId};current=${nextSessionId}`
    );
    return nextSessionId;
  }

  private reservePort(): Promise<number> {
    return new Promise((resolvePort, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, HOST, () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          reject(new Error('Could not reserve a Hermes loopback port'));
          return;
        }
        const port = address.port;
        server.close((error) => error ? reject(error) : resolvePort(port));
      });
    });
  }

  private withComponentLogs(error: unknown, instance: ManagedInstance): Error {
    const message = error instanceof Error ? error.message : String(error);
    const dashboard = (instance.dashboardLog ?? '').trim().slice(-2_000);
    const gateway = (instance.gatewayLog ?? '').trim().slice(-2_000);
    const details = [
      dashboard ? `[dashboard]\n${dashboard}` : '',
      gateway ? `[gateway]\n${gateway}` : ''
    ].filter(Boolean).join('\n');
    return new Error(details ? `${message}\n${details}` : message);
  }

  private dashboardAvailable(instance: ManagedInstance): boolean {
    return instance.dashboardReady === true
      || instance.status.state === 'healthy'
      || instance.status.state === 'degraded';
  }

  private uiAvailable(instance: ManagedInstance): boolean {
    if (!this.dashboardAvailable(instance)) return false;
    // Keep this fallback for older test doubles and restored instances; every
    // real HermesProxy exposes getStatus and must report its listener state.
    const proxyStatus = instance.proxy && typeof instance.proxy.getStatus === 'function'
      ? instance.proxy.getStatus()
      : null;
    return proxyStatus ? proxyStatus.running === true : true;
  }

  private diagnostic(
    projectId: string,
    component: 'runtime' | 'proxy' | 'dashboard' | 'gateway',
    phase: string,
    startedAt: number,
    detail?: string
  ): void {
    this.onDiagnostic?.({
      projectId,
      component,
      phase,
      elapsedMs: Math.max(0, this.now() - startedAt),
      ...(detail ? { detail } : {})
    });
  }

  private audit(action: string, projectId: string, result: string): void {
    this.db.audit({ id: randomUUID(), actor: 'system', action, target: projectId, result, source: 'hermes' });
  }
}
