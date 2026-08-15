/**
 * SQLite 本地数据层（PRD 13.x）
 * 实现：sql.js（SQLite WASM 构建）——Windows / Ubuntu 零原生编译，打包分发可靠。
 * 持久化：WAL 语义无 WAL 文件需求；变更后防抖导出到 userData/aibox-data/aibox.db。
 * 密钥/Token 不写入 SQLite（15.1），表内仅保存系统密钥库引用。
 */
import initSqlJs, { type Database as SqlJsDatabase, type SqlValue } from 'sql.js';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import { basename, dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { validateDatabaseBackup } from './backupValidator.js';

const require = createRequire(import.meta.url);
/** v2：tasks.result；v3：session_id + task_messages + schedules；
 *  v4：人设三文件 + conversations + mcp_servers + skills + agent_skills + usage_records；
 *  v5：多供应商 providers 表 + agents.provider_id/model_override + 窗口状态 + 模板；
 *  v33：agent_runs 记录请求引擎、实际引擎与执行器类型；
 *  v34：组织、渠道身份与 canonical conversation/message 主链；
 *  v36：canonical task/message/plan 外键语义、输入消息 exactly-once 与外键强制；
 *  v37：组织化 project/agent/channel 与待审批 memory proposal 持久化。 */
// v38: durable task schedule proposals reviewed through OPC-Nexus Scheduler.
// v39: rename the legacy built-in `eng-hermes` runtime identity to Nexus.
const SCHEMA_VERSION = 39;

const DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL DEFAULT 'org-local' REFERENCES organizations(id),
  name TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  client_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  color TEXT NOT NULL DEFAULT '#4d6bfe',
  due_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL DEFAULT 'org-local' REFERENCES organizations(id),
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  soul_md TEXT NOT NULL DEFAULT '',
  agents_md TEXT NOT NULL DEFAULT '',
  user_md TEXT NOT NULL DEFAULT '',
  lifecycle TEXT NOT NULL DEFAULT 'DISABLED',
  engine_id TEXT NOT NULL,
  workspace TEXT NOT NULL DEFAULT '',
  permission_mode TEXT NOT NULL DEFAULT 'standard',
  concurrency_limit INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  avatar_color TEXT NOT NULL DEFAULT '#4d6bfe',
  provider_id TEXT,
  model_override TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS engines (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT,
  path TEXT,
  status TEXT NOT NULL DEFAULT 'NOT_INSTALLED',
  auth_status TEXT NOT NULL DEFAULT 'unknown',
  is_default INTEGER NOT NULL DEFAULT 0,
  data_boundary TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  input_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'desktop',
  source_key TEXT,
  parent_id TEXT,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  priority INTEGER NOT NULL DEFAULT 0,
  progress INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT '',
  error TEXT,
  workspace_override TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  pid INTEGER,
  session_id TEXT NOT NULL,
  requested_engine_id TEXT,
  resolved_engine_id TEXT,
  executor_kind TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  tool_calls_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id),
  project_id TEXT REFERENCES projects(id),
  automation_kind TEXT NOT NULL DEFAULT 'task',
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  cron_kind TEXT NOT NULL,
  cron_value TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL DEFAULT 'org-local' REFERENCES organizations(id),
  type TEXT NOT NULL,
  account_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'UNCONFIGURED',
  credential_ref TEXT,
  last_connected_at INTEGER,
  limitation TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  kind TEXT NOT NULL DEFAULT 'person',
  display_name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_identities (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  external_identity_key TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_routes (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  conversation_key TEXT NOT NULL DEFAULT '*',
  agent_id TEXT NOT NULL REFERENCES agents(id),
  policy TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  type TEXT NOT NULL,
  request TEXT NOT NULL,
  risk TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);

CREATE TABLE IF NOT EXISTS resource_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'system',
  scope_id TEXT NOT NULL DEFAULT '',
  cpu REAL, memory REAL, gpu REAL, vram REAL, temp REAL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  result TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'desktop',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  organization_id TEXT REFERENCES organizations(id),
  principal_id TEXT REFERENCES principals(id),
  channel_id TEXT REFERENCES channels(id),
  channel_identity_id TEXT REFERENCES channel_identities(id),
  external_conversation_key TEXT,
  title TEXT NOT NULL DEFAULT '',
  last_message_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  principal_id TEXT REFERENCES principals(id) ON DELETE SET NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
  channel_identity_id TEXT REFERENCES channel_identities(id) ON DELETE SET NULL,
  external_message_key TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kernel_attempts (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  component_id TEXT NOT NULL,
  role TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  error TEXT,
  UNIQUE(request_id, sequence)
);

CREATE TABLE IF NOT EXISTS kernel_sessions (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kernel_id TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(conversation_id, kernel_id)
);

CREATE TABLE IF NOT EXISTS dispatch_plans (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  input_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  leader_kernel TEXT NOT NULL,
  worker_agent_id TEXT NOT NULL REFERENCES agents(id),
  worker_engine_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  plan_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  committed_at INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  importance REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  forgotten_at INTEGER
);

CREATE TABLE IF NOT EXISTS memory_scopes (
  memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  PRIMARY KEY(memory_id, scope_type)
);

CREATE TABLE IF NOT EXISTS memory_versions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  content TEXT NOT NULL,
  importance REAL NOT NULL,
  status TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  change_kind TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(memory_id, revision)
);

CREATE TABLE IF NOT EXISTS memory_terms (
  memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  term TEXT NOT NULL,
  weight REAL NOT NULL,
  PRIMARY KEY(memory_id, term)
);

CREATE TABLE IF NOT EXISTS memory_proposals (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  proposal_index INTEGER NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  principal_id TEXT REFERENCES principals(id) ON DELETE SET NULL,
  channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  operation TEXT NOT NULL CHECK(operation = 'remember'),
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  importance REAL NOT NULL CHECK(importance >= 0 AND importance <= 1),
  scope_type TEXT NOT NULL CHECK(scope_type IN ('principal', 'channel', 'conversation', 'agent', 'project')),
  scope_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected')),
  proposed_by TEXT NOT NULL,
  decided_by TEXT,
  decision_reason TEXT,
  memory_id TEXT REFERENCES memory_items(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  UNIQUE(request_id, proposal_index)
);

CREATE TABLE IF NOT EXISTS task_schedule_proposals (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES dispatch_plans(request_id) ON DELETE CASCADE,
  proposal_index INTEGER NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  principal_id TEXT REFERENCES principals(id) ON DELETE SET NULL,
  channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  operation TEXT NOT NULL CHECK(operation = 'create_task_schedule'),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  cron_kind TEXT NOT NULL CHECK(cron_kind IN ('interval', 'daily', 'weekly', 'monthly')),
  cron_value TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected')),
  proposed_by TEXT NOT NULL,
  decided_by TEXT,
  decision_reason TEXT,
  schedule_id TEXT REFERENCES schedules(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  UNIQUE(request_id, proposal_index)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_plans_input_message ON dispatch_plans(input_message_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_plans_conversation ON dispatch_plans(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_kernel_attempts_request ON kernel_attempts(request_id, sequence);
CREATE INDEX IF NOT EXISTS idx_memory_scopes_lookup ON memory_scopes(scope_type, scope_id, memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_terms_lookup ON memory_terms(term, memory_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_active_dedupe
  ON memory_items(organization_id, content_hash, scope_key) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_task_schedule_proposals_status
  ON task_schedule_proposals(organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_schedule_proposals_request
  ON task_schedule_proposals(request_id);
CREATE INDEX IF NOT EXISTS idx_task_schedule_proposals_conversation
  ON task_schedule_proposals(conversation_id);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '[]',
  env TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  scope TEXT NOT NULL DEFAULT 'global',
  capability TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_skills (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  skill_id TEXT NOT NULL REFERENCES skills(id),
  PRIMARY KEY (agent_id, skill_id)
);

CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  agent_id TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  api_key_ref TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'general',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  steps_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'idle',
  created_at INTEGER NOT NULL,
  last_run_at INTEGER
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'running',
  node_results TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  coordinator_id TEXT NOT NULL,
  member_ids TEXT NOT NULL DEFAULT '[]',
  mode TEXT NOT NULL DEFAULT 'coordinate',
  workspace TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS team_runs (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  project_id TEXT REFERENCES projects(id),
  task_text TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'decompose',
  current_step INTEGER NOT NULL DEFAULT 0,
  total_steps INTEGER NOT NULL DEFAULT 0,
  subtasks_json TEXT NOT NULL DEFAULT '[]',
  events_json TEXT NOT NULL DEFAULT '[]',
  final_result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS deliverables (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  owner_role TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'document',
  tags_json TEXT NOT NULL DEFAULT '[]',
  review_status TEXT NOT NULL DEFAULT 'unmarked',
  review_note TEXT NOT NULL DEFAULT '',
  source_hash TEXT NOT NULL,
  source_updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(source_type, source_id)
);

CREATE TABLE IF NOT EXISTS deliverable_versions (
  id TEXT PRIMARY KEY,
  deliverable_id TEXT NOT NULL REFERENCES deliverables(id),
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  change_note TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'manual',
  created_by TEXT NOT NULL DEFAULT 'admin',
  created_at INTEGER NOT NULL,
  UNIQUE(deliverable_id, version)
);

CREATE TABLE IF NOT EXISTS deliverable_reviews (
  id TEXT PRIMARY KEY,
  deliverable_id TEXT NOT NULL REFERENCES deliverables(id),
  status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  reviewer TEXT NOT NULL DEFAULT 'admin',
  rework_ref TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  source_type TEXT NOT NULL DEFAULT 'manual',
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  tags_json TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  source_updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(source_type, source_id)
);

CREATE TABLE IF NOT EXISTS knowledge_versions (
  id TEXT PRIMARY KEY,
  knowledge_id TEXT NOT NULL REFERENCES knowledge_entries(id),
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  change_note TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'manual',
  created_by TEXT NOT NULL DEFAULT 'admin',
  created_at INTEGER NOT NULL,
  UNIQUE(knowledge_id, version)
);

CREATE TABLE IF NOT EXISTS action_dismissals (
  action_key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  dismissed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_budgets (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  token_limit INTEGER NOT NULL DEFAULT 0,
  cost_limit REAL NOT NULL DEFAULT 0,
  warning_percent INTEGER NOT NULL DEFAULT 80,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_reports (
  id TEXT PRIMARY KEY,
  schedule_id TEXT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  findings_json TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS customer_deliveries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  customer_name TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  deliverable_ids_json TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  delivered_at INTEGER,
  accepted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collab_workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  conventions TEXT NOT NULL DEFAULT '',
  git_rules TEXT NOT NULL DEFAULT '',
  mcp_port INTEGER NOT NULL DEFAULT 28890,
  git_port INTEGER NOT NULL DEFAULT 28891,
  invite_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collab_tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES collab_workspaces(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  branch_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  assigned_agent TEXT,
  assigned_at INTEGER,
  submitted_at INTEGER,
  review_result TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collab_agents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES collab_workspaces(id),
  name TEXT NOT NULL,
  endpoint TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'online',
  last_heartbeat INTEGER NOT NULL,
  connected_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mobile_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  manufacturer TEXT NOT NULL DEFAULT '',
  android_version TEXT NOT NULL DEFAULT '',
  api_level INTEGER NOT NULL DEFAULT 0,
  app_version TEXT NOT NULL DEFAULT '',
  protocol_version INTEGER NOT NULL,
  identity_public_key TEXT NOT NULL,
  identity_fingerprint TEXT NOT NULL UNIQUE,
  certificate_fingerprint TEXT NOT NULL,
  permissions_json TEXT NOT NULL DEFAULT '{}',
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  paired_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  last_ip TEXT
);

CREATE TABLE IF NOT EXISTS mobile_agent_configs (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  device_id TEXT UNIQUE REFERENCES mobile_devices(id),
  hermes_profile TEXT NOT NULL UNIQUE,
  allowed_tools_json TEXT NOT NULL DEFAULT '[]',
  authorization_confirmed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mobile_control_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  device_id TEXT NOT NULL REFERENCES mobile_devices(id),
  task_id TEXT REFERENCES tasks(id),
  status TEXT NOT NULL DEFAULT 'active',
  allowed_tools_json TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS mobile_commands (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES mobile_control_sessions(id),
  agent_id TEXT REFERENCES agents(id),
  device_id TEXT NOT NULL REFERENCES mobile_devices(id),
  task_id TEXT REFERENCES tasks(id),
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  request_summary_json TEXT NOT NULL DEFAULT '{}',
  result_summary_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS mobile_artifacts (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES mobile_devices(id),
  agent_id TEXT REFERENCES agents(id),
  task_id TEXT REFERENCES tasks(id),
  command_id TEXT REFERENCES mobile_commands(id),
  kind TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  filename TEXT NOT NULL,
  storage_name TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mobile_scripts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  agent_id TEXT REFERENCES agents(id),
  device_id TEXT REFERENCES mobile_devices(id),
  steps_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_messages_task ON task_messages(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_schedules_next ON schedules(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_resource_samples_time ON resource_samples(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_deliverables_project ON deliverables(project_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_deliverable_versions_parent ON deliverable_versions(deliverable_id, version);
CREATE INDEX IF NOT EXISTS idx_deliverable_reviews_parent ON deliverable_reviews(deliverable_id, created_at);
CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge_entries(project_id, status, pinned, updated_at);
CREATE INDEX IF NOT EXISTS idx_knowledge_versions_parent ON knowledge_versions(knowledge_id, version);
CREATE INDEX IF NOT EXISTS idx_action_dismissed_at ON action_dismissals(dismissed_at);
CREATE INDEX IF NOT EXISTS idx_automation_reports_project ON automation_reports(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_customer_deliveries_project ON customer_deliveries(project_id, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_active_device_lease ON mobile_control_sessions(device_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_active_agent_lease ON mobile_control_sessions(agent_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_active_task_lease ON mobile_control_sessions(task_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_mobile_commands_device_time ON mobile_commands(device_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_mobile_artifacts_device_time ON mobile_artifacts(device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mobile_scripts_agent ON mobile_scripts(agent_id, updated_at DESC);
`;

type Row = Record<string, SqlValue>;
type Params = (SqlValue | undefined)[];

/** 对齐 node:sqlite 语义的薄封装，保证上层调用无需感知 WASM 差异 */
class Statement {
  constructor(private db: SqlJsDatabase, private sql: string, private afterWrite: () => void) {}

  private isWrite(): boolean {
    return /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)/i.test(this.sql);
  }

  run(...params: Params): { changes: number } {
    const stmt = this.db.prepare(this.sql);
    try {
      stmt.bind(params.filter((p): p is SqlValue => p !== undefined));
      while (stmt.step()) { /* 消费所有行 */ }
    } finally {
      stmt.free();
    }
    const changes = this.db.getRowsModified();
    if (this.isWrite()) this.afterWrite();
    return { changes };
  }

  get(...params: Params): Row | undefined {
    const rows = this.all(...params);
    return rows[0];
  }

  all(...params: Params): Row[] {
    const stmt = this.db.prepare(this.sql);
    const rows: Row[] = [];
    try {
      stmt.bind(params.filter((p): p is SqlValue => p !== undefined));
      while (stmt.step()) rows.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return rows;
  }
}

class RawFacade {
  constructor(private owner: Database) {}
  prepare(sql: string): Statement {
    return new Statement(this.owner.inner, sql, () => this.owner.scheduleSave());
  }
}

export class Database {
  inner!: SqlJsDatabase;
  raw = new RawFacade(this);
  private file = '';
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  private constructor() {}

  static async create(): Promise<Database> {
    const d = new Database();
    const dir = join(app.getPath('userData'), 'aibox-data');
    mkdirSync(dir, { recursive: true });
    d.file = join(dir, 'aibox.db');

    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    const SQL = await initSqlJs({
      locateFile: () => wasmPath
    });

    const pendingRestore = join(dir, 'aibox.restore.pending.db');
    const sourceFile = existsSync(pendingRestore) ? pendingRestore : d.file;
    // 损坏容错：直接 new SQL.Database(损坏字节) 会抛 "file is not a database"，
    // 且异常发生在启动路径上会导致整个应用打不开、用户无任何自救手段。
    // 因此这里捕获并把损坏文件改名留存（不删除，便于事后取证/人工抢救），以空库继续启动。
    d.inner = Database.openOrRecover(SQL, sourceFile);
    if (sourceFile === pendingRestore) d.dirty = true;
    d.migrate();
    if (sourceFile === pendingRestore) rmSync(pendingRestore, { force: true });
    return d;
  }

  /** 打开数据库文件；损坏时留存原文件并返回空库，保证应用始终能启动 */
  private static openOrRecover(SQL: Awaited<ReturnType<typeof initSqlJs>>, sourceFile: string): SqlJsDatabase {
    if (!existsSync(sourceFile)) return new SQL.Database();
    try {
      const bytes = readFileSync(sourceFile);
      if (bytes.length === 0) throw new Error('数据库文件为空');
      // 先校验 SQLite 魔数（"SQLite format 3\0"）：sql.js 的构造函数是惰性的，
      // 传入损坏字节不会立刻抛错，而是等到第一次 exec（即 migrate）才抛，
      // 那时异常已脱离本函数的 try/catch，会直接冒泡成启动崩溃。
      const MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
      if (bytes.length < MAGIC.length || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error('缺少 SQLite 文件头，内容已损坏');
      }
      const db = new SQL.Database(new Uint8Array(bytes));
      db.exec('PRAGMA quick_check'); // 触发一次真实读取，确认可用
      return db;
    } catch (err) {
      const salvaged = `${sourceFile}.corrupt-${Date.now()}`;
      try {
        renameSync(sourceFile, salvaged);
        console.error(`[Database] 数据库文件损坏（${err instanceof Error ? err.message : String(err)}），已留存为 ${salvaged}，以空库启动`);
      } catch (renameErr) {
        console.error(`[Database] 数据库文件损坏且无法留存：${renameErr instanceof Error ? renameErr.message : String(renameErr)}`);
      }
      return new SQL.Database();
    }
  }

  /** Read the version before running any DDL so an incompatible database is never mutated. */
  private storedSchemaVersion(): number {
    const metaTable = this.inner.exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta' LIMIT 1"
    );
    if ((metaTable[0]?.values.length ?? 0) === 0) {
      const userTables = this.inner.exec(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      );
      const count = Number(userTables[0]?.values[0]?.[0] ?? 0);
      if (count === 0) return 0;
      throw new Error('数据库缺少 schema_version，已拒绝按全新数据库迁移');
    }

    const rows = this.inner.exec("SELECT value FROM schema_meta WHERE key = 'schema_version' LIMIT 1");
    const raw = rows[0]?.values[0]?.[0];
    const encoded = raw === null || raw === undefined ? '' : String(raw).trim();
    if (!/^[1-9]\d*$/.test(encoded)) {
      throw new Error(`数据库版本非法：${encoded || '缺失'}`);
    }
    const version = Number(encoded);
    if (!Number.isSafeInteger(version)) throw new Error(`数据库版本非法：${encoded}`);
    if (version > SCHEMA_VERSION) {
      throw new Error(`数据库版本 v${version} 高于当前应用支持的 v${SCHEMA_VERSION}，已拒绝打开以防止数据损坏`);
    }
    return version;
  }

  private assertForeignKeyIntegrity(): void {
    const violations = this.inner.exec('PRAGMA foreign_key_check')
      .flatMap((result) => result.values);
    if (violations.length === 0) return;
    const detail = violations.slice(0, 5)
      .map((row) => `${String(row[0])}[rowid=${String(row[1])}] -> ${String(row[2])}`)
      .join(', ');
    throw new Error(`数据库外键检查失败（${violations.length} 条）：${detail}`);
  }

  private enableForeignKeys(): void {
    this.inner.exec('PRAGMA foreign_keys = ON');
    const enabled = Number(this.inner.exec('PRAGMA foreign_keys')[0]?.values[0]?.[0] ?? 0);
    if (enabled !== 1) throw new Error('无法启用 SQLite 外键约束');
  }

  private migrationRows(sql: string, params: SqlValue[] = []): Row[] {
    const statement = this.inner.prepare(sql);
    try {
      statement.bind(params);
      const rows: Row[] = [];
      while (statement.step()) rows.push(statement.getAsObject() as Row);
      return rows;
    } finally {
      statement.free();
    }
  }

  private migrationValue(sql: string, params: SqlValue[] = []): SqlValue | undefined {
    return this.migrationRows(sql, params)[0]?.value;
  }

  private migrationFailure(version: number, message: string): never {
    throw new Error(`数据库 v${version} 迁移失败：${message}`);
  }

  /** Reconcile the v35 bidirectional execution receipt without discarding
   * messages or dispatch plans. Ambiguous evidence aborts the transaction. */
  private reconcileCanonicalTaskReceipts(): void {
    const committedWithoutTask = this.migrationRows(
      "SELECT id FROM dispatch_plans WHERE status = 'committed' AND task_id IS NULL LIMIT 1"
    )[0];
    if (committedWithoutTask) {
      this.migrationFailure(36, `已提交计划 ${String(committedWithoutTask.id)} 缺少 task_id`);
    }

    const staleRefs = this.migrationRows(`
      SELECT task_id, id AS message_id
      FROM messages
      WHERE direction = 'inbound' AND task_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = messages.task_id)
      UNION ALL
      SELECT task_id, input_message_id AS message_id
      FROM dispatch_plans
      WHERE status = 'committed' AND task_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = dispatch_plans.task_id)
    `);
    const staleTaskMessages = new Map<string, Set<string>>();
    for (const row of staleRefs) {
      const taskId = String(row.task_id ?? '');
      const messageId = String(row.message_id ?? '');
      if (!taskId || !messageId) this.migrationFailure(36, '发现无法识别的历史 task/message 引用');
      const messages = staleTaskMessages.get(taskId) ?? new Set<string>();
      messages.add(messageId);
      staleTaskMessages.set(taskId, messages);
    }

    const staleMessageOwners = new Map<string, string>();
    for (const [taskId, messageIds] of staleTaskMessages) {
      if (messageIds.size !== 1) {
        this.migrationFailure(36, `已删除任务 ${taskId} 对应 ${messageIds.size} 条输入消息，无法恢复唯一收据`);
      }
      const messageId = [...messageIds][0];
      const prior = staleMessageOwners.get(messageId);
      if (prior && prior !== taskId) {
        this.migrationFailure(36, `输入消息 ${messageId} 同时指向已删除任务 ${prior} 与 ${taskId}`);
      }
      staleMessageOwners.set(messageId, taskId);
    }

    for (const [taskId, messageIds] of staleTaskMessages) {
      const messageId = [...messageIds][0];
      const message = this.migrationRows(`
        SELECT m.id, m.organization_id, m.conversation_id, m.channel_id, m.created_at,
               m.direction, m.task_id, c.agent_id AS conversation_agent_id
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.id = ?
      `, [messageId])[0];
      if (!message || message.direction !== 'inbound') {
        this.migrationFailure(36, `已删除任务 ${taskId} 缺少可验证的 inbound message`);
      }
      if (message.task_id !== null && message.task_id !== undefined && String(message.task_id) !== taskId) {
        this.migrationFailure(36, `输入消息 ${messageId} 的历史 task_id 与计划冲突`);
      }
      const plans = this.migrationRows(`
        SELECT id, task_id, worker_agent_id, worker_engine_id, created_at, committed_at
        FROM dispatch_plans
        WHERE status = 'committed' AND input_message_id = ?
      `, [messageId]);
      if (plans.some((plan) => String(plan.task_id ?? '') !== taskId)) {
        this.migrationFailure(36, `输入消息 ${messageId} 的已提交计划指向不同任务`);
      }
      const workerIds = new Set(plans.map((plan) => String(plan.worker_agent_id ?? '')).filter(Boolean));
      if (workerIds.size > 1) this.migrationFailure(36, `已删除任务 ${taskId} 有多个执行员工`);
      const agentId = workerIds.size === 1 ? [...workerIds][0] : String(message.conversation_agent_id ?? '');
      if (!agentId || this.migrationRows('SELECT id FROM agents WHERE id = ?', [agentId]).length !== 1) {
        this.migrationFailure(36, `已删除任务 ${taskId} 缺少可验证的执行员工`);
      }
      const plan = plans[0];
      const createdAt = Math.min(
        Number(message.created_at ?? Date.now()),
        Number(plan?.created_at ?? message.created_at ?? Date.now())
      );
      const endedAt = Number(plan?.committed_at ?? plan?.created_at ?? message.created_at ?? createdAt);
      this.inner.run(`
        INSERT INTO tasks(
          id, agent_id, conversation_id, input_message_id, title, content, source,
          status, priority, progress, stage, error, engine_override, is_demo,
          created_at, ended_at, deleted_at
        ) VALUES(?, ?, ?, ?, '', '', ?, 'INTERRUPTED', 0, 0, '',
          'Recovered durable receipt for a missing historical task', ?, 0, ?, ?, ?)
      `, [
        taskId,
        agentId,
        String(message.conversation_id),
        messageId,
        message.channel_id === null || message.channel_id === undefined ? 'desktop' : 'channel',
        plan?.worker_engine_id === null || plan?.worker_engine_id === undefined
          ? null
          : String(plan.worker_engine_id),
        createdAt,
        endedAt,
        endedAt
      ]);
      this.inner.run('UPDATE messages SET task_id = ? WHERE id = ?', [taskId, messageId]);
    }

    const invalidTaskInputs = this.migrationRows(`
      SELECT t.id, t.input_message_id
      FROM tasks t
      LEFT JOIN messages m ON m.id = t.input_message_id
      WHERE t.input_message_id IS NOT NULL AND (m.id IS NULL OR m.direction <> 'inbound')
      ORDER BY t.id
    `);
    for (const task of invalidTaskInputs) {
      const taskId = String(task.id);
      const replacement = this.migrationRows(`
        SELECT id FROM messages
        WHERE direction = 'inbound' AND task_id = ?
        ORDER BY created_at ASC, id ASC LIMIT 1
      `, [taskId])[0];
      if (!replacement) {
        this.migrationFailure(36, `任务 ${taskId} 的 input_message_id 无效且没有可验证的入站消息`);
      }
      this.inner.run('UPDATE tasks SET input_message_id = ? WHERE id = ?', [String(replacement.id), taskId]);
    }

    const unclaimedTasks = this.migrationRows('SELECT id FROM tasks WHERE input_message_id IS NULL ORDER BY id');
    for (const task of unclaimedTasks) {
      const message = this.migrationRows(`
        SELECT id FROM messages
        WHERE direction = 'inbound' AND task_id = ?
        ORDER BY created_at ASC, id ASC LIMIT 1
      `, [String(task.id)])[0];
      if (message) this.inner.run('UPDATE tasks SET input_message_id = ? WHERE id = ?', [String(message.id), String(task.id)]);
    }

    const duplicateClaims = this.migrationRows(`
      SELECT input_message_id AS message_id
      FROM tasks
      WHERE input_message_id IS NOT NULL
      GROUP BY input_message_id HAVING COUNT(*) > 1
      ORDER BY input_message_id
    `);
    for (const duplicate of duplicateClaims) {
      const messageId = String(duplicate.message_id);
      const message = this.migrationRows('SELECT task_id FROM messages WHERE id = ?', [messageId])[0];
      const candidates = this.migrationRows(`
        SELECT id FROM tasks WHERE input_message_id = ? ORDER BY created_at ASC, id ASC
      `, [messageId]);
      const reciprocal = message?.task_id === null || message?.task_id === undefined
        ? undefined
        : candidates.find((candidate) => String(candidate.id) === String(message.task_id));
      const winner = String((reciprocal ?? candidates[0])?.id ?? '');
      if (!winner) this.migrationFailure(36, `输入消息 ${messageId} 没有可选的 canonical task`);
      this.inner.run('UPDATE tasks SET input_message_id = NULL WHERE input_message_id = ? AND id <> ?', [messageId, winner]);
    }

    this.inner.exec(`
      UPDATE messages
      SET task_id = (SELECT t.id FROM tasks t WHERE t.input_message_id = messages.id LIMIT 1)
      WHERE direction = 'inbound';
    `);

    const plans = this.migrationRows('SELECT id, status, task_id, input_message_id FROM dispatch_plans ORDER BY id');
    for (const plan of plans) {
      const planId = String(plan.id);
      const messageId = String(plan.input_message_id ?? '');
      const message = this.migrationRows('SELECT id, direction FROM messages WHERE id = ?', [messageId])[0];
      if (!message || message.direction !== 'inbound') {
        this.migrationFailure(36, `调度计划 ${planId} 缺少可验证的 inbound message`);
      }
      let canonical = this.migrationRows('SELECT id FROM tasks WHERE input_message_id = ? LIMIT 1', [messageId])[0];
      const referencedTaskId = plan.task_id === null || plan.task_id === undefined ? null : String(plan.task_id);
      if (!canonical && referencedTaskId) {
        const referenced = this.migrationRows('SELECT input_message_id FROM tasks WHERE id = ?', [referencedTaskId])[0];
        if (!referenced) this.migrationFailure(36, `调度计划 ${planId} 指向不存在的任务 ${referencedTaskId}`);
        if (referenced.input_message_id !== null && referenced.input_message_id !== undefined) {
          this.migrationFailure(36, `调度计划 ${planId} 的任务已归属于另一输入消息`);
        }
        this.inner.run('UPDATE tasks SET input_message_id = ? WHERE id = ?', [messageId, referencedTaskId]);
        this.inner.run('UPDATE messages SET task_id = ? WHERE id = ?', [referencedTaskId, messageId]);
        canonical = { id: referencedTaskId };
      }
      if (plan.status === 'committed' && !canonical) {
        this.migrationFailure(36, `已提交计划 ${planId} 无法确定 canonical task`);
      }
      if (referencedTaskId && canonical && referencedTaskId !== String(canonical.id)) {
        this.inner.run('UPDATE dispatch_plans SET task_id = ? WHERE id = ?', [String(canonical.id), planId]);
      }
    }

    const asymmetric = this.migrationRows(`
      SELECT t.id
      FROM tasks t JOIN messages m ON m.id = t.input_message_id
      WHERE t.input_message_id IS NOT NULL AND (m.direction <> 'inbound' OR m.task_id <> t.id)
      UNION ALL
      SELECT m.id
      FROM messages m JOIN tasks t ON t.id = m.task_id
      WHERE m.direction = 'inbound' AND t.input_message_id <> m.id
      LIMIT 1
    `)[0];
    if (asymmetric) this.migrationFailure(36, 'task/message 双向执行收据仍不一致');

    const taskConversationConflict = this.migrationRows(`
      SELECT t.id
      FROM tasks t JOIN messages m ON m.id = t.input_message_id
      WHERE t.conversation_id IS NOT NULL AND t.conversation_id <> m.conversation_id
      LIMIT 1
    `)[0];
    if (taskConversationConflict) {
      this.migrationFailure(36, `任务 ${String(taskConversationConflict.id)} 与输入消息不属于同一会话`);
    }
    this.inner.exec(`
      UPDATE tasks
      SET conversation_id = (SELECT m.conversation_id FROM messages m WHERE m.id = tasks.input_message_id)
      WHERE input_message_id IS NOT NULL AND conversation_id IS NULL;
    `);

    const planTaskConflict = this.migrationRows(`
      SELECT dp.id
      FROM dispatch_plans dp
      JOIN tasks t ON t.id = dp.task_id
      JOIN messages m ON m.id = dp.input_message_id
      WHERE dp.task_id IS NOT NULL
        AND (t.input_message_id <> dp.input_message_id
          OR t.conversation_id <> dp.conversation_id
          OR m.conversation_id <> dp.conversation_id
          OR (dp.status = 'committed' AND t.agent_id <> dp.worker_agent_id))
      LIMIT 1
    `)[0];
    if (planTaskConflict) {
      this.migrationFailure(36, `调度计划 ${String(planTaskConflict.id)} 与 canonical task/message 冲突`);
    }
  }

  private assignEntityOrganizations(
    table: 'agents' | 'channels' | 'projects',
    candidateSql: string
  ): void {
    const entities = this.migrationRows(`SELECT id FROM ${table} ORDER BY id`);
    for (const entity of entities) {
      const id = String(entity.id);
      const candidates = new Set(
        this.migrationRows(candidateSql, [id, id, id, id])
          .map((row) => String(row.organization_id ?? '').trim())
          .filter(Boolean)
      );
      if (candidates.size > 1) {
        this.migrationFailure(37, `${table}.${id} 同时属于多个组织：${[...candidates].join(', ')}`);
      }
      if (candidates.size === 1) {
        this.inner.run(`UPDATE ${table} SET organization_id = ? WHERE id = ?`, [[...candidates][0], id]);
      }
    }
  }

  private validateOrganizationScopes(): void {
    const checks: Array<[string, string]> = [
      ['principal 组织不存在', `SELECT p.id FROM principals p LEFT JOIN organizations o ON o.id = p.organization_id WHERE o.id IS NULL LIMIT 1`],
      ['agent 组织不存在', `SELECT a.id FROM agents a LEFT JOIN organizations o ON o.id = a.organization_id WHERE o.id IS NULL LIMIT 1`],
      ['project 组织不存在', `SELECT p.id FROM projects p LEFT JOIN organizations o ON o.id = p.organization_id WHERE o.id IS NULL LIMIT 1`],
      ['channel 组织不存在', `SELECT c.id FROM channels c LEFT JOIN organizations o ON o.id = c.organization_id WHERE o.id IS NULL LIMIT 1`],
      ['渠道身份跨组织', `
        SELECT ci.id FROM channel_identities ci
        JOIN principals p ON p.id = ci.principal_id
        JOIN channels c ON c.id = ci.channel_id
        WHERE ci.organization_id <> p.organization_id OR ci.organization_id <> c.organization_id
        LIMIT 1`],
      ['会话跨组织', `
        SELECT c.id FROM conversations c
        JOIN agents a ON a.id = c.agent_id
        LEFT JOIN principals p ON p.id = c.principal_id
        LEFT JOIN channels ch ON ch.id = c.channel_id
        LEFT JOIN channel_identities ci ON ci.id = c.channel_identity_id
        WHERE c.organization_id IS NULL OR c.organization_id <> a.organization_id
          OR (p.id IS NOT NULL AND p.organization_id <> c.organization_id)
          OR (ch.id IS NOT NULL AND ch.organization_id <> c.organization_id)
          OR (ci.id IS NOT NULL AND ci.organization_id <> c.organization_id)
        LIMIT 1`],
      ['消息跨组织', `
        SELECT m.id FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        LEFT JOIN principals p ON p.id = m.principal_id
        LEFT JOIN channels ch ON ch.id = m.channel_id
        LEFT JOIN channel_identities ci ON ci.id = m.channel_identity_id
        WHERE m.organization_id <> c.organization_id
          OR (p.id IS NOT NULL AND p.organization_id <> m.organization_id)
          OR (ch.id IS NOT NULL AND ch.organization_id <> m.organization_id)
          OR (ci.id IS NOT NULL AND ci.organization_id <> m.organization_id)
        LIMIT 1`],
      ['任务跨组织', `
        SELECT t.id FROM tasks t
        JOIN agents a ON a.id = t.agent_id
        LEFT JOIN projects p ON p.id = t.project_id
        LEFT JOIN conversations c ON c.id = t.conversation_id
        LEFT JOIN messages m ON m.id = t.input_message_id
        WHERE (p.id IS NOT NULL AND p.organization_id <> a.organization_id)
          OR (c.id IS NOT NULL AND c.organization_id <> a.organization_id)
          OR (m.id IS NOT NULL AND m.organization_id <> a.organization_id)
        LIMIT 1`],
      ['渠道路由跨组织', `
        SELECT r.id FROM channel_routes r
        JOIN channels c ON c.id = r.channel_id
        JOIN agents a ON a.id = r.agent_id
        WHERE c.organization_id <> a.organization_id LIMIT 1`],
      ['调度计划跨组织或主链不一致', `
        SELECT dp.id FROM dispatch_plans dp
        JOIN principals p ON p.id = dp.principal_id
        JOIN conversations c ON c.id = dp.conversation_id
        JOIN messages m ON m.id = dp.input_message_id
        JOIN agents a ON a.id = dp.worker_agent_id
        LEFT JOIN channels ch ON ch.id = dp.channel_id
        WHERE dp.organization_id <> p.organization_id
          OR dp.organization_id <> c.organization_id
          OR dp.organization_id <> m.organization_id
          OR dp.organization_id <> a.organization_id
          OR (ch.id IS NOT NULL AND dp.organization_id <> ch.organization_id)
          OR dp.conversation_id <> m.conversation_id
          OR NOT (dp.channel_id IS m.channel_id)
          OR (m.principal_id IS NOT NULL AND dp.principal_id <> m.principal_id)
        LIMIT 1`]
    ];
    for (const [label, sql] of checks) {
      const row = this.migrationRows(sql)[0];
      if (row) this.migrationFailure(37, `${label}：${String(row.id)}`);
    }
  }

  private migrateOrganizationOwnership(): void {
    this.assignEntityOrganizations('agents', `
      SELECT organization_id FROM conversations WHERE agent_id = ? AND organization_id IS NOT NULL
      UNION SELECT m.organization_id FROM tasks t JOIN messages m ON m.id = t.input_message_id WHERE t.agent_id = ?
      UNION SELECT organization_id FROM dispatch_plans WHERE worker_agent_id = ?
      UNION SELECT mi.organization_id FROM memory_items mi JOIN memory_scopes ms ON ms.memory_id = mi.id
        WHERE ms.scope_type = 'agent' AND ms.scope_id = ?
    `);
    this.assignEntityOrganizations('channels', `
      SELECT organization_id FROM channel_identities WHERE channel_id = ?
      UNION SELECT organization_id FROM conversations WHERE channel_id = ? AND organization_id IS NOT NULL
      UNION SELECT organization_id FROM messages WHERE channel_id = ?
      UNION SELECT organization_id FROM dispatch_plans WHERE channel_id = ?
    `);
    this.assignEntityOrganizations('projects', `
      SELECT c.organization_id FROM tasks t JOIN conversations c ON c.id = t.conversation_id WHERE t.project_id = ? AND c.organization_id IS NOT NULL
      UNION SELECT m.organization_id FROM tasks t JOIN messages m ON m.id = t.input_message_id WHERE t.project_id = ?
      UNION SELECT a.organization_id FROM tasks t JOIN agents a ON a.id = t.agent_id WHERE t.project_id = ?
      UNION SELECT mi.organization_id FROM memory_items mi JOIN memory_scopes ms ON ms.memory_id = mi.id
        WHERE ms.scope_type = 'project' AND ms.scope_id = ?
    `);
    this.inner.exec(`
      UPDATE conversations
      SET organization_id = (SELECT a.organization_id FROM agents a WHERE a.id = conversations.agent_id)
      WHERE organization_id IS NULL;
    `);
    this.validateOrganizationScopes();
  }

  private makeDispatchPlanChannelNullable(): void {
    const channel = this.migrationRows('PRAGMA table_info(dispatch_plans)')
      .find((row) => row.name === 'channel_id');
    if (!channel || Number(channel.notnull) === 0) return;
    this.inner.exec(`
      CREATE TABLE dispatch_plans_v37 (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        principal_id TEXT NOT NULL REFERENCES principals(id),
        channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        input_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        leader_kernel TEXT NOT NULL,
        worker_agent_id TEXT NOT NULL REFERENCES agents(id),
        worker_engine_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planned',
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        plan_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        committed_at INTEGER,
        error TEXT
      );
      INSERT INTO dispatch_plans_v37(
        id, request_id, organization_id, principal_id, channel_id, conversation_id,
        input_message_id, leader_kernel, worker_agent_id, worker_engine_id, status,
        task_id, plan_json, created_at, committed_at, error
      ) SELECT
        id, request_id, organization_id, principal_id, channel_id, conversation_id,
        input_message_id, leader_kernel, worker_agent_id, worker_engine_id, status,
        task_id, plan_json, created_at, committed_at, error
      FROM dispatch_plans;
      DROP TABLE dispatch_plans;
      ALTER TABLE dispatch_plans_v37 RENAME TO dispatch_plans;
      CREATE UNIQUE INDEX idx_dispatch_plans_input_message ON dispatch_plans(input_message_id);
      CREATE INDEX idx_dispatch_plans_conversation ON dispatch_plans(conversation_id, created_at);
    `);
  }

  private migrate() {
    // 13.1：migration 在事务中执行，失败回滚；按版本号增量迁移
    const prev = this.storedSchemaVersion();
    // Table rebuilds in v36 require foreign key enforcement to be disabled until
    // the copied data has passed foreign_key_check. The setting is per connection.
    this.inner.exec('PRAGMA foreign_keys = OFF');
    this.inner.exec('BEGIN');
    try {
      this.inner.exec(DDL);
      // 辅助：安全添加列（已存在则跳过，避免 DDL 与 ALTER 冲突）
      const addCol = (table: string, col: string, type: string) => {
        const cols = this.inner.exec(`PRAGMA table_info(${table})`);
        const exists = cols.length > 0 && cols[0].values.some((row) => row[1] === col);
        if (!exists) this.inner.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
      };
      if (prev < 2) {
        addCol('tasks', 'result', 'TEXT');
      }
      if (prev < 3) {
        addCol('tasks', 'session_id', 'TEXT');
      }
      if (prev < 4) {
        addCol('agents', 'soul_md', "TEXT NOT NULL DEFAULT ''");
        addCol('agents', 'agents_md', "TEXT NOT NULL DEFAULT ''");
        addCol('agents', 'user_md', "TEXT NOT NULL DEFAULT ''");
        this.inner.exec(`CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agents(id),
          title TEXT NOT NULL DEFAULT '',
          last_message_at INTEGER NOT NULL,
          message_count INTEGER NOT NULL DEFAULT 0
        )`);
        this.inner.exec(`CREATE TABLE IF NOT EXISTS mcp_servers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          command TEXT NOT NULL,
          args TEXT NOT NULL DEFAULT '[]',
          env TEXT NOT NULL DEFAULT '{}',
          enabled INTEGER NOT NULL DEFAULT 1,
          scope TEXT NOT NULL DEFAULT 'global'
        )`);
        this.inner.exec(`CREATE TABLE IF NOT EXISTS skills (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL
        )`);
        this.inner.exec(`CREATE TABLE IF NOT EXISTS agent_skills (
          agent_id TEXT NOT NULL REFERENCES agents(id),
          skill_id TEXT NOT NULL REFERENCES skills(id),
          PRIMARY KEY (agent_id, skill_id)
        )`);
        this.inner.exec(`CREATE TABLE IF NOT EXISTS usage_records (
          id TEXT PRIMARY KEY,
          task_id TEXT,
          agent_id TEXT NOT NULL,
          model TEXT NOT NULL DEFAULT '',
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        )`);
      }
      if (prev < 5) {
        // v5：多供应商 + 助手模型覆写 + Prompt 模板 + 工作流 + 专家团
        this.inner.exec(`CREATE TABLE IF NOT EXISTS providers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          base_url TEXT NOT NULL,
          model TEXT NOT NULL DEFAULT '',
          api_key_ref TEXT NOT NULL DEFAULT '',
          is_default INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        )`);
        addCol('agents', 'provider_id', 'TEXT');
        addCol('agents', 'model_override', 'TEXT');
        this.inner.exec(`CREATE TABLE IF NOT EXISTS prompt_templates (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          category TEXT NOT NULL DEFAULT 'general',
          created_at INTEGER NOT NULL
        )`);
        this.inner.exec(`CREATE TABLE IF NOT EXISTS workflows (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          steps_json TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'idle',
          created_at INTEGER NOT NULL,
          last_run_at INTEGER
        )`);
        this.inner.exec(`CREATE TABLE IF NOT EXISTS teams (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          coordinator_id TEXT NOT NULL,
          member_ids TEXT NOT NULL DEFAULT '[]',
          mode TEXT NOT NULL DEFAULT 'coordinate',
          created_at INTEGER NOT NULL
        )`);
      }
      if (prev < 6) {
        // v6：可视化工作流引擎（节点/边/发布为 Skill/外部平台）
        addCol('workflows', 'description', "TEXT NOT NULL DEFAULT ''");
        addCol('workflows', 'nodes_json', "TEXT NOT NULL DEFAULT '[]'");
        addCol('workflows', 'edges_json', "TEXT NOT NULL DEFAULT '[]'");
        addCol('workflows', 'published_as_skill', 'INTEGER NOT NULL DEFAULT 0');
        addCol('workflows', 'skill_id', 'TEXT');
      }
      if (prev < 7) {
        // v7：多机协同
      }
      if (prev < 8) {
        // v8：数字员工能力开关（网络/命令/安装）
        addCol('agents', 'capabilities_json', "TEXT NOT NULL DEFAULT '{}'");
      }
      if (prev < 9) {
        // v9：专家团流水线（团队共享工作空间 + 执行记录 + 任务级工作空间覆盖）
        addCol('teams', 'workspace', "TEXT NOT NULL DEFAULT ''");
        addCol('tasks', 'workspace_override', 'TEXT');
        this.inner.exec(`CREATE TABLE IF NOT EXISTS team_runs (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL REFERENCES teams(id),
          task_text TEXT NOT NULL,
          phase TEXT NOT NULL DEFAULT 'decompose',
          current_step INTEGER NOT NULL DEFAULT 0,
          total_steps INTEGER NOT NULL DEFAULT 0,
          subtasks_json TEXT NOT NULL DEFAULT '[]',
          final_result TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          ended_at INTEGER
        )`);
      }
      if (prev < 10) {
        // v10：工作流增强（全局变量 + 版本号）
        addCol('workflows', 'variables_json', "TEXT NOT NULL DEFAULT '[]'");
        addCol('workflows', 'version', 'INTEGER NOT NULL DEFAULT 1');
      }
      if (prev < 11) {
        // v11：数字员工增强（标签 + 模型参数覆盖）
        addCol('agents', 'tags_json', "TEXT NOT NULL DEFAULT '[]'");
        addCol('agents', 'model_overrides_json', 'TEXT');
      }
      if (prev < 12) {
        // v12：引擎中心增强（配置 + 日志）
        addCol('engines', 'config_json', 'TEXT');
        this.inner.exec(`CREATE TABLE IF NOT EXISTS engine_logs (
          id TEXT PRIMARY KEY,
          engine_id TEXT NOT NULL,
          level TEXT NOT NULL DEFAULT 'info',
          message TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        )`);
      }
      if (prev < 13) {
        // v13：专家团增强（团队配置）
        addCol('teams', 'config_json', 'TEXT');
      }
      if (prev < 14) {
        // v14：自定义团队模板
        this.inner.exec(`CREATE TABLE IF NOT EXISTS team_templates (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          mode TEXT NOT NULL DEFAULT 'coordinate',
          members_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL
        )`);
      }
      if (prev < 15) {
        // v15：定时任务增强（任务内容字段）
        addCol('schedules', 'content', "TEXT NOT NULL DEFAULT ''");
      }
      if (prev < 16) {
        // v16：专家团执行时间线（事件流持久化，供可视化）
        addCol('team_runs', 'events_json', "TEXT NOT NULL DEFAULT '[]'");
      }
      if (prev < 17) {
        // v17：任务产出质量标记（成果管理：采纳/驳回/返工）
        addCol('tasks', 'quality', 'TEXT');
      }
      if (prev < 18) {
        // v18：项目经营层，任务与专家团运行可选归属项目
        addCol('tasks', 'project_id', 'TEXT REFERENCES projects(id)');
        addCol('team_runs', 'project_id', 'TEXT REFERENCES projects(id)');
        this.inner.exec('CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, created_at)');
      }
      if (prev < 19) {
        // v19：成果实体、版本序列与人工验收事件
        this.inner.exec('CREATE INDEX IF NOT EXISTS idx_deliverables_project ON deliverables(project_id, updated_at)');
        this.inner.exec('CREATE INDEX IF NOT EXISTS idx_deliverable_versions_parent ON deliverable_versions(deliverable_id, version)');
        this.inner.exec('CREATE INDEX IF NOT EXISTS idx_deliverable_reviews_parent ON deliverable_reviews(deliverable_id, created_at)');
      }
      if (prev < 20) {
        // v20：为历史默认演示任务补齐成果正文，让升级后的成果库可直接体验。
        this.inner.exec(`
          UPDATE tasks
          SET result = '# ' || title || char(10) || char(10) ||
            '## 完成摘要' || char(10) || char(10) ||
            '系统例行任务已完成，执行结果、异常项与后续事项已整理。' || char(10) || char(10) ||
            '## 后续事项' || char(10) || char(10) ||
            '- 结果已归档，等待验收' || char(10) ||
            '- 异常项进入下一轮跟进' || char(10)
          WHERE status = 'COMPLETED'
            AND result IS NULL
            AND source = 'desktop'
            AND title GLOB '例行任务 #[0-9]*'
            AND agent_id IN (
              SELECT id FROM agents WHERE name IN (
                'ERP/CRM助手', 'MES助手', '测试验证助手', '文档助手', '人事招聘助手', '品质管理助手',
                '采购比价助手', 'IT运维助手', '销售外勤助手', '合同审核助手', '数据分析助手', '会议纪要助手'
              )
            )
        `);
      }
      if (prev < 21) {
        // v21：仅为空的默认演示环境补充项目组合，并建立演示任务归属。
        this.inner.exec(`
          INSERT INTO projects(id, name, objective, description, client_name, status, color, due_at, created_at, updated_at)
          SELECT id, name, objective, description, client_name, status, color, due_at, created_at, updated_at
          FROM (
            SELECT 'project-demo-operations' AS id, '经营自动化一期' AS name,
              '打通财务、生产、采购与经营数据的例行自动化' AS objective, '优先覆盖高频、可量化、可复用的经营流程。' AS description,
              '内部运营' AS client_name, 'active' AS status, '#4d6bfe' AS color,
              (strftime('%s','now') * 1000 + 1209600000) AS due_at, (strftime('%s','now') * 1000 - 604800000) AS created_at, (strftime('%s','now') * 1000) AS updated_at
            UNION ALL
            SELECT 'project-demo-quality', '交付质量提升', '建立测试、文档、品质与运维的交付检查闭环', '统一质量记录、异常跟进和验收标准。',
              '交付中心', 'active', '#22c1a3', (strftime('%s','now') * 1000 + 432000000), (strftime('%s','now') * 1000 - 604800000), (strftime('%s','now') * 1000)
            UNION ALL
            SELECT 'project-demo-customer', '客户协同标准化', '沉淀招聘、销售、合同与会议协同标准流程', '形成可复用的客户与组织协同模板。',
              '业务团队', 'completed', '#f59e0b', (strftime('%s','now') * 1000 - 172800000), (strftime('%s','now') * 1000 - 604800000), (strftime('%s','now') * 1000)
          ) AS demo_projects
          WHERE NOT EXISTS (SELECT 1 FROM projects)
            AND EXISTS (SELECT 1 FROM agents WHERE name = 'ERP/CRM助手')
            AND EXISTS (SELECT 1 FROM agents WHERE name = '会议纪要助手');

          UPDATE tasks
          SET project_id = CASE
            WHEN agent_id IN (SELECT id FROM agents WHERE name IN ('ERP/CRM助手', 'MES助手', '采购比价助手', '数据分析助手')) THEN 'project-demo-operations'
            WHEN agent_id IN (SELECT id FROM agents WHERE name IN ('测试验证助手', '文档助手', '品质管理助手', 'IT运维助手')) THEN 'project-demo-quality'
            ELSE 'project-demo-customer'
          END
          WHERE project_id IS NULL
            AND source = 'desktop'
            AND (
              title GLOB '例行任务 #[0-9]*' OR title IN (
                '财务红冲发票提醒', '生产流程看板', '文档整理与归档', '企业内部线上学习平台',
                '品质记录本替代A4表单', '供应商季度比价分析', '服务器例行巡检', '客户拜访纪要归档'
              )
            )
            AND EXISTS (SELECT 1 FROM projects WHERE id = 'project-demo-operations')
            AND EXISTS (SELECT 1 FROM projects WHERE id = 'project-demo-quality')
            AND EXISTS (SELECT 1 FROM projects WHERE id = 'project-demo-customer');
        `);
      }
      if (prev < 22) {
        // v22：项目知识库、不可变知识版本与成果来源追溯。
        this.inner.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge_entries(project_id, status, pinned, updated_at)');
        this.inner.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_versions_parent ON knowledge_versions(knowledge_id, version)');
      }
      if (prev < 23) {
        // v23：行动中心派生事项的版本化忽略记录。
        this.inner.exec('CREATE INDEX IF NOT EXISTS idx_action_dismissed_at ON action_dismissals(dismissed_at)');
      }
      if (prev < 24) {
        // v24：终态任务软删除，保留执行记录与成果来源追溯。
        addCol('tasks', 'deleted_at', 'INTEGER');
      }
      if (prev < 25) {
        // v25：项目经营自动化、成本预算、客户交付与周期报告。
        this.inner.exec(`
          CREATE TABLE schedules_v25 (
            id TEXT PRIMARY KEY,
            agent_id TEXT REFERENCES agents(id),
            project_id TEXT REFERENCES projects(id),
            automation_kind TEXT NOT NULL DEFAULT 'task',
            title TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            cron_kind TEXT NOT NULL,
            cron_value TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            last_run_at INTEGER,
            next_run_at INTEGER NOT NULL
          );
          INSERT INTO schedules_v25(id, agent_id, project_id, automation_kind, title, content, cron_kind, cron_value, enabled, last_run_at, next_run_at)
          SELECT id, agent_id, NULL, 'task', title, content, cron_kind, cron_value, enabled, last_run_at, next_run_at FROM schedules;
          DROP TABLE schedules;
          ALTER TABLE schedules_v25 RENAME TO schedules;
          CREATE INDEX IF NOT EXISTS idx_schedules_next ON schedules(enabled, next_run_at);
        `);
        this.inner.exec('CREATE INDEX IF NOT EXISTS idx_automation_reports_project ON automation_reports(project_id, created_at)');
        this.inner.exec('CREATE INDEX IF NOT EXISTS idx_customer_deliveries_project ON customer_deliveries(project_id, updated_at)');
      }
      if (prev < 26) {
        // v26：引擎清单收敛为四种（Nexus / Hermes / OpenCode / Codex CLI）。
        // 下线 Claude Code / ZCode / Kimi Code：把绑定它们的员工改绑内置 Nexus，
        // 避免 engine_id 指向不存在的引擎导致派发时无执行器可用。
        this.inner.exec(`
          UPDATE agents SET engine_id = 'eng-hermes'
          WHERE engine_id IN ('eng-claude', 'eng-zcode', 'eng-kimi');
          DELETE FROM engines WHERE id IN ('eng-claude', 'eng-zcode', 'eng-kimi');
        `);
      }
      if (prev < 27) {
        // v27：演示数据隔离（H-3）。演示种子与真实数据此前共用同一张表且无标记，
        // 用户无法区分「23 条今日完成」哪些是真的，统计口径被永久污染。
        // 增加 is_demo 标记列，并按已知的演示数据特征回填历史库。
        addCol('projects', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
        addCol('agents', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
        addCol('tasks', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
        // 演示项目 id 固定为 project-demo-*，据此回填项目及其关联的员工与任务
        this.inner.exec(`
          UPDATE projects SET is_demo = 1 WHERE id LIKE 'project-demo-%';
          UPDATE tasks SET is_demo = 1 WHERE project_id LIKE 'project-demo-%';
          UPDATE agents SET is_demo = 1 WHERE id IN (
            SELECT DISTINCT agent_id FROM tasks WHERE project_id LIKE 'project-demo-%'
          );
        `);
      }
      if (prev < 28) {
        // v28：任务级引擎覆盖（E-2 编码委派）。主引擎把编码类子任务委派给 OpenCode 执行时，
        // 子任务仍归属原员工（保留归属与审计链路），仅执行引擎不同。
        addCol('tasks', 'engine_override', 'TEXT');
      }
      if (prev < 29) {
        // v29：MCP 能力分类，用于按数字员工能力开关过滤浏览器等高权限工具。
        addCol('mcp_servers', 'capability', "TEXT NOT NULL DEFAULT ''");
      }
      if (prev < 30) {
        // v30：为旧版预置 Puppeteer 服务补齐浏览器权限分类，防止绕过员工能力开关。
        this.inner.exec(`
          UPDATE mcp_servers SET capability = 'browser'
          WHERE capability = '' AND command = 'npx' AND args LIKE '%@modelcontextprotocol/server-puppeteer%';
        `);
      }
      if (prev < 31) {
        // v31：Android 手机员工身份与 Mobile Gateway 数据域。
        addCol('agents', 'agent_kind', "TEXT NOT NULL DEFAULT 'general'");
        addCol('mobile_devices', 'certificate_fingerprint', "TEXT NOT NULL DEFAULT ''");
        this.inner.exec("UPDATE agents SET agent_kind = 'general' WHERE agent_kind IS NULL OR agent_kind = ''");
      }
      if (prev < 32) {
        // v32：外部来源消息幂等键。NULL 不参与唯一约束，桌面等既有任务不受影响。
        addCol('tasks', 'source_key', 'TEXT');
        this.inner.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_key
          ON tasks(source, source_key) WHERE source_key IS NOT NULL`);
      }
      if (prev < 33) {
        // v33：基础设施回退后的真实执行引擎归因。历史运行无法证明是否发生过回退，
        // 因此只回填 requested_engine_id，resolved_engine_id 保持 NULL。
        addCol('agent_runs', 'requested_engine_id', 'TEXT');
        addCol('agent_runs', 'resolved_engine_id', 'TEXT');
        addCol('agent_runs', 'executor_kind', 'TEXT');
        this.inner.exec(`
          UPDATE agent_runs
          SET requested_engine_id = (
            SELECT COALESCE(t.engine_override, a.engine_id)
            FROM tasks t JOIN agents a ON a.id = t.agent_id
            WHERE t.id = agent_runs.task_id
          )
          WHERE requested_engine_id IS NULL;
        `);
        this.inner.exec('CREATE INDEX IF NOT EXISTS idx_agent_runs_resolved_engine ON agent_runs(resolved_engine_id, started_at)');
      }
      if (prev < 34) {
        // v34：渠道入口的租户、主体、外部身份、会话和消息形成可追溯主链。
        // 旧桌面会话可确定归属本地组织；没有渠道证据的身份字段不做推断。
        this.inner.exec(`CREATE TABLE IF NOT EXISTS organizations (
          id TEXT PRIMARY KEY,
          slug TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`);
        this.inner.exec(`CREATE TABLE IF NOT EXISTS principals (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          kind TEXT NOT NULL DEFAULT 'person',
          display_name TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`);
        this.inner.exec(`CREATE TABLE IF NOT EXISTS channel_identities (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          channel_id TEXT NOT NULL REFERENCES channels(id),
          principal_id TEXT NOT NULL REFERENCES principals(id),
          external_identity_key TEXT NOT NULL,
          display_name TEXT NOT NULL DEFAULT '',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`);
        addCol('conversations', 'organization_id', 'TEXT REFERENCES organizations(id)');
        addCol('conversations', 'principal_id', 'TEXT REFERENCES principals(id)');
        addCol('conversations', 'channel_id', 'TEXT REFERENCES channels(id)');
        addCol('conversations', 'channel_identity_id', 'TEXT REFERENCES channel_identities(id)');
        addCol('conversations', 'external_conversation_key', 'TEXT');
        addCol('conversations', 'created_at', 'INTEGER');
        addCol('conversations', 'updated_at', 'INTEGER');
        addCol('tasks', 'conversation_id', 'TEXT REFERENCES conversations(id)');
        this.inner.exec(`CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          principal_id TEXT REFERENCES principals(id),
          conversation_id TEXT NOT NULL REFERENCES conversations(id),
          channel_id TEXT REFERENCES channels(id),
          channel_identity_id TEXT REFERENCES channel_identities(id),
          external_message_key TEXT,
          dedupe_key TEXT NOT NULL UNIQUE,
          direction TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          task_id TEXT REFERENCES tasks(id),
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL
        )`);
        const now = Date.now();
        this.inner.run(
          `INSERT OR IGNORE INTO organizations(id, slug, name, created_at, updated_at)
           VALUES(?, ?, ?, ?, ?)`,
          ['org-local', 'local', '本地组织', now, now]
        );
        this.inner.exec(`
          UPDATE conversations
          SET organization_id = COALESCE(organization_id, 'org-local'),
              created_at = COALESCE(created_at, last_message_at),
              updated_at = COALESCE(updated_at, last_message_at);
          UPDATE tasks
          SET conversation_id = substr(session_id, 6)
          WHERE conversation_id IS NULL
            AND session_id LIKE 'conv-%'
            AND EXISTS (
              SELECT 1 FROM conversations c
              WHERE c.id = substr(tasks.session_id, 6)
            );
        `);
        this.inner.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_identities_scope
          ON channel_identities(organization_id, channel_id, external_identity_key)`);
        this.inner.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_channel_scope
          ON conversations(organization_id, channel_id, channel_identity_id, external_conversation_key)
          WHERE organization_id IS NOT NULL AND channel_id IS NOT NULL
            AND channel_identity_id IS NOT NULL AND external_conversation_key IS NOT NULL`);
        this.inner.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_channel_scope
          ON messages(organization_id, channel_id, channel_identity_id, conversation_id, direction, external_message_key)
          WHERE channel_id IS NOT NULL AND channel_identity_id IS NOT NULL AND external_message_key IS NOT NULL`);
        this.inner.exec('CREATE INDEX IF NOT EXISTS idx_principals_organization ON principals(organization_id, updated_at)');
        this.inner.exec('CREATE INDEX IF NOT EXISTS idx_channel_identities_principal ON channel_identities(principal_id)');
        this.inner.exec('CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at)');
        this.inner.exec('CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id)');
        this.inner.exec('CREATE INDEX IF NOT EXISTS idx_tasks_conversation ON tasks(conversation_id, created_at)');
      }
      if (prev < 35) {
        // v35: durable kernel routing, canonical scoped memory and full task
        // instructions. The title remains a bounded display label.
        addCol('tasks', 'input_message_id', 'TEXT REFERENCES messages(id)');
        addCol('tasks', 'content', "TEXT NOT NULL DEFAULT ''");
        this.inner.exec(`
          UPDATE tasks SET content = title WHERE content IS NULL OR content = '';
          UPDATE tasks SET input_message_id = (
            SELECT m.id FROM messages m
            WHERE m.task_id = tasks.id AND m.direction = 'inbound'
            ORDER BY m.created_at ASC LIMIT 1
          ) WHERE input_message_id IS NULL;
        `);
        this.inner.exec(`CREATE TABLE IF NOT EXISTS kernel_attempts (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL REFERENCES conversations(id),
          component_id TEXT NOT NULL,
          role TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          status TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER NOT NULL,
          error TEXT,
          UNIQUE(request_id, sequence)
        )`);
        this.inner.exec(`CREATE TABLE IF NOT EXISTS kernel_sessions (
          conversation_id TEXT NOT NULL REFERENCES conversations(id),
          kernel_id TEXT NOT NULL,
          native_session_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(conversation_id, kernel_id)
        )`);
        this.inner.exec(`CREATE TABLE IF NOT EXISTS dispatch_plans (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL UNIQUE,
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          principal_id TEXT NOT NULL REFERENCES principals(id),
          channel_id TEXT NOT NULL REFERENCES channels(id),
          conversation_id TEXT NOT NULL REFERENCES conversations(id),
          input_message_id TEXT NOT NULL REFERENCES messages(id),
          leader_kernel TEXT NOT NULL,
          worker_agent_id TEXT NOT NULL REFERENCES agents(id),
          worker_engine_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'planned',
          task_id TEXT,
          plan_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          committed_at INTEGER,
          error TEXT
        )`);
        this.inner.exec(`CREATE TABLE IF NOT EXISTS memory_items (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          scope_key TEXT NOT NULL,
          importance REAL NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          revision INTEGER NOT NULL DEFAULT 1,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          forgotten_at INTEGER
        )`);
        this.inner.exec(`CREATE TABLE IF NOT EXISTS memory_scopes (
          memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
          scope_type TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          PRIMARY KEY(memory_id, scope_type)
        )`);
        this.inner.exec(`CREATE TABLE IF NOT EXISTS memory_versions (
          id TEXT PRIMARY KEY,
          memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL,
          content TEXT NOT NULL,
          importance REAL NOT NULL,
          status TEXT NOT NULL,
          changed_by TEXT NOT NULL,
          change_kind TEXT NOT NULL,
          reason TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE(memory_id, revision)
        )`);
        this.inner.exec(`CREATE TABLE IF NOT EXISTS memory_terms (
          memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
          term TEXT NOT NULL,
          weight REAL NOT NULL,
          PRIMARY KEY(memory_id, term)
        )`);
        this.inner.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_plans_input_message ON dispatch_plans(input_message_id)');
        this.inner.exec('CREATE INDEX IF NOT EXISTS idx_dispatch_plans_conversation ON dispatch_plans(conversation_id, created_at)');
        this.inner.exec('CREATE INDEX IF NOT EXISTS idx_kernel_attempts_request ON kernel_attempts(request_id, sequence)');
        this.inner.exec('CREATE INDEX IF NOT EXISTS idx_memory_scopes_lookup ON memory_scopes(scope_type, scope_id, memory_id)');
        this.inner.exec('CREATE INDEX IF NOT EXISTS idx_memory_terms_lookup ON memory_terms(term, memory_id)');
        this.inner.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_active_dedupe
          ON memory_items(organization_id, content_hash, scope_key) WHERE status = 'active'`);
        this.inner.exec('CREATE INDEX IF NOT EXISTS idx_tasks_input_message ON tasks(input_message_id)');
      }
      if (prev < 36) {
        // v36: make the canonical message -> plan -> task chain enforceable before
        // turning foreign_keys on for the connection. Derived orphan rows can be
        // discarded; user-authored task/message content is retained and invalid
        // nullable links are detached instead of deleting the owning row.
        // A few early v35 snapshots (and the deliberately minimal compatibility
        // fixtures) predate the originally required engine_id column. Repair
        // those snapshots while their version history is still being replayed;
        // a database stamped v38 or later must remain fail-closed in v39 rather
        // than silently inventing a missing legacy reference.
        addCol('agents', 'engine_id', "TEXT NOT NULL DEFAULT 'eng-hermes'");
        this.inner.exec(`
          UPDATE tasks SET project_id = NULL
          WHERE project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = tasks.project_id);
          UPDATE tasks SET conversation_id = NULL
          WHERE conversation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = tasks.conversation_id);
          UPDATE messages SET principal_id = NULL
          WHERE principal_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM principals p WHERE p.id = messages.principal_id);
          UPDATE messages SET channel_id = NULL
          WHERE channel_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM channels c WHERE c.id = messages.channel_id);
          UPDATE messages SET channel_identity_id = NULL
          WHERE channel_identity_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM channel_identities ci WHERE ci.id = messages.channel_identity_id
          );
          UPDATE messages SET task_id = NULL
          WHERE direction <> 'inbound' AND task_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = messages.task_id);

          DELETE FROM task_events WHERE task_id NOT IN (SELECT id FROM tasks);
          DELETE FROM task_messages WHERE task_id NOT IN (SELECT id FROM tasks);
          DELETE FROM agent_runs
          WHERE task_id NOT IN (SELECT id FROM tasks) OR agent_id NOT IN (SELECT id FROM agents);
          DELETE FROM approvals
          WHERE task_id NOT IN (SELECT id FROM tasks) OR agent_id NOT IN (SELECT id FROM agents);
          DELETE FROM agent_skills
          WHERE agent_id NOT IN (SELECT id FROM agents) OR skill_id NOT IN (SELECT id FROM skills);
          DELETE FROM workflow_runs WHERE workflow_id NOT IN (SELECT id FROM workflows);
          DELETE FROM kernel_attempts WHERE conversation_id NOT IN (SELECT id FROM conversations);
          DELETE FROM kernel_sessions WHERE conversation_id NOT IN (SELECT id FROM conversations);
          DELETE FROM memory_scopes WHERE memory_id NOT IN (SELECT id FROM memory_items);
          DELETE FROM memory_versions WHERE memory_id NOT IN (SELECT id FROM memory_items);
          DELETE FROM memory_terms WHERE memory_id NOT IN (SELECT id FROM memory_items);
          UPDATE schedules SET agent_id = NULL
          WHERE agent_id IS NOT NULL AND agent_id NOT IN (SELECT id FROM agents);
          UPDATE schedules SET project_id = NULL
          WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects);
          UPDATE team_runs SET project_id = NULL
          WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects);
          UPDATE deliverables SET project_id = NULL
          WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects);
          UPDATE mobile_control_sessions SET task_id = NULL
          WHERE task_id IS NOT NULL AND task_id NOT IN (SELECT id FROM tasks);
          UPDATE mobile_commands SET task_id = NULL
          WHERE task_id IS NOT NULL AND task_id NOT IN (SELECT id FROM tasks);
          UPDATE mobile_artifacts SET task_id = NULL
          WHERE task_id IS NOT NULL AND task_id NOT IN (SELECT id FROM tasks);
        `);

        this.reconcileCanonicalTaskReceipts();

        this.inner.exec(`
          CREATE TABLE tasks_v36 (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL REFERENCES agents(id),
            project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
            conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
            input_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT 'desktop',
            source_key TEXT,
            parent_id TEXT,
            status TEXT NOT NULL DEFAULT 'QUEUED',
            priority INTEGER NOT NULL DEFAULT 0,
            progress INTEGER NOT NULL DEFAULT 0,
            stage TEXT NOT NULL DEFAULT '',
            error TEXT,
            result TEXT,
            quality TEXT,
            session_id TEXT,
            workspace_override TEXT,
            engine_override TEXT,
            is_demo INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            started_at INTEGER,
            ended_at INTEGER,
            deleted_at INTEGER
          );
          INSERT INTO tasks_v36(
            id, agent_id, project_id, conversation_id, input_message_id, title, content,
            source, source_key, parent_id, status, priority, progress, stage, error,
            result, quality, session_id, workspace_override, engine_override, is_demo,
            created_at, started_at, ended_at, deleted_at
          ) SELECT
            id, agent_id, project_id, conversation_id, input_message_id, title, content,
            source, source_key, parent_id, status, priority, progress, stage, error,
            result, quality, session_id, workspace_override, engine_override, is_demo,
            created_at, started_at, ended_at, deleted_at
          FROM tasks;
          DROP TABLE tasks;
          ALTER TABLE tasks_v36 RENAME TO tasks;
          CREATE INDEX idx_tasks_agent ON tasks(agent_id, status);
          CREATE INDEX idx_tasks_status ON tasks(status);
          CREATE INDEX idx_tasks_project ON tasks(project_id, created_at);
          CREATE UNIQUE INDEX idx_tasks_source_key
            ON tasks(source, source_key) WHERE source_key IS NOT NULL;
          CREATE INDEX idx_tasks_conversation ON tasks(conversation_id, created_at);
          CREATE UNIQUE INDEX idx_tasks_input_message_exactly_once
            ON tasks(input_message_id) WHERE input_message_id IS NOT NULL;
        `);

        this.inner.exec(`
          CREATE TABLE messages_v36 (
            id TEXT PRIMARY KEY,
            organization_id TEXT NOT NULL REFERENCES organizations(id),
            principal_id TEXT REFERENCES principals(id) ON DELETE SET NULL,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
            channel_identity_id TEXT REFERENCES channel_identities(id) ON DELETE SET NULL,
            external_message_key TEXT,
            dedupe_key TEXT NOT NULL UNIQUE,
            direction TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL
          );
          INSERT INTO messages_v36(
            id, organization_id, principal_id, conversation_id, channel_id,
            channel_identity_id, external_message_key, dedupe_key, direction,
            role, content, task_id, metadata_json, created_at
          ) SELECT
            id, organization_id, principal_id, conversation_id, channel_id,
            channel_identity_id, external_message_key, dedupe_key, direction,
            role, content, task_id, metadata_json, created_at
          FROM messages;
          DROP TABLE messages;
          ALTER TABLE messages_v36 RENAME TO messages;
          CREATE UNIQUE INDEX idx_messages_channel_scope
            ON messages(organization_id, channel_id, channel_identity_id, conversation_id, direction, external_message_key)
            WHERE channel_id IS NOT NULL AND channel_identity_id IS NOT NULL AND external_message_key IS NOT NULL;
          CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
          CREATE INDEX idx_messages_task ON messages(task_id);
        `);

        this.inner.exec(`
          CREATE TABLE dispatch_plans_v36 (
            id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL UNIQUE,
            organization_id TEXT NOT NULL REFERENCES organizations(id),
            principal_id TEXT NOT NULL REFERENCES principals(id),
            channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            input_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            leader_kernel TEXT NOT NULL,
            worker_agent_id TEXT NOT NULL REFERENCES agents(id),
            worker_engine_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'planned',
            task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
            plan_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            committed_at INTEGER,
            error TEXT
          );
          INSERT INTO dispatch_plans_v36(
            id, request_id, organization_id, principal_id, channel_id, conversation_id,
            input_message_id, leader_kernel, worker_agent_id, worker_engine_id, status,
            task_id, plan_json, created_at, committed_at, error
          ) SELECT
            id, request_id, organization_id, principal_id, channel_id, conversation_id,
            input_message_id, leader_kernel, worker_agent_id, worker_engine_id, status,
            task_id, plan_json, created_at, committed_at, error
          FROM dispatch_plans;
          DROP TABLE dispatch_plans;
          ALTER TABLE dispatch_plans_v36 RENAME TO dispatch_plans;
          CREATE UNIQUE INDEX idx_dispatch_plans_input_message ON dispatch_plans(input_message_id);
          CREATE INDEX idx_dispatch_plans_conversation ON dispatch_plans(conversation_id, created_at);
        `);

        this.inner.exec(`
          CREATE TABLE kernel_attempts_v36 (
            id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            component_id TEXT NOT NULL,
            role TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            status TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            ended_at INTEGER NOT NULL,
            error TEXT,
            UNIQUE(request_id, sequence)
          );
          INSERT INTO kernel_attempts_v36 SELECT * FROM kernel_attempts;
          DROP TABLE kernel_attempts;
          ALTER TABLE kernel_attempts_v36 RENAME TO kernel_attempts;
          CREATE INDEX idx_kernel_attempts_request ON kernel_attempts(request_id, sequence);

          CREATE TABLE kernel_sessions_v36 (
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            kernel_id TEXT NOT NULL,
            native_session_id TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(conversation_id, kernel_id)
          );
          INSERT INTO kernel_sessions_v36 SELECT * FROM kernel_sessions;
          DROP TABLE kernel_sessions;
          ALTER TABLE kernel_sessions_v36 RENAME TO kernel_sessions;

          CREATE TABLE workflow_runs_v36 (
            id TEXT PRIMARY KEY,
            workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'running',
            node_results TEXT NOT NULL DEFAULT '{}',
            error TEXT,
            started_at INTEGER NOT NULL,
            ended_at INTEGER
          );
          INSERT INTO workflow_runs_v36 SELECT * FROM workflow_runs;
          DROP TABLE workflow_runs;
          ALTER TABLE workflow_runs_v36 RENAME TO workflow_runs;
        `);
      }
      if (prev < 37) {
        // v37: every routable entity has an organization owner; desktop plans
        // use the local principal and intentionally carry no channel.
        const now = Date.now();
        this.inner.run(
          `INSERT OR IGNORE INTO organizations(id, slug, name, created_at, updated_at)
           VALUES('org-local', 'local', '本地组织', ?, ?)`,
          [now, now]
        );
        this.inner.run(
          `INSERT OR IGNORE INTO principals(
             id, organization_id, kind, display_name, created_at, updated_at
           ) VALUES('principal-local-admin', 'org-local', 'person', '本地管理员', ?, ?)`,
          [now, now]
        );
        const localPrincipal = this.migrationRows(
          "SELECT organization_id FROM principals WHERE id = 'principal-local-admin'"
        )[0];
        if (localPrincipal?.organization_id !== 'org-local') {
          this.migrationFailure(37, 'principal-local-admin 已存在但不属于 org-local');
        }

        addCol('projects', 'organization_id', "TEXT NOT NULL DEFAULT 'org-local' REFERENCES organizations(id)");
        addCol('agents', 'organization_id', "TEXT NOT NULL DEFAULT 'org-local' REFERENCES organizations(id)");
        addCol('channels', 'organization_id', "TEXT NOT NULL DEFAULT 'org-local' REFERENCES organizations(id)");
        this.inner.exec(`
          UPDATE projects SET organization_id = 'org-local' WHERE organization_id IS NULL OR organization_id = '';
          UPDATE agents SET organization_id = 'org-local' WHERE organization_id IS NULL OR organization_id = '';
          UPDATE channels SET organization_id = 'org-local' WHERE organization_id IS NULL OR organization_id = '';
        `);
        this.migrateOrganizationOwnership();
        this.makeDispatchPlanChannelNullable();

        this.inner.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_organization_entity
            ON projects(organization_id, id);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_organization_entity
            ON agents(organization_id, id);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_organization_entity
            ON channels(organization_id, id);
          CREATE INDEX IF NOT EXISTS idx_principals_organization_entity
            ON principals(organization_id, id);
          CREATE INDEX IF NOT EXISTS idx_channel_identities_organization_lookup
            ON channel_identities(organization_id, channel_id, external_identity_key);
          CREATE INDEX IF NOT EXISTS idx_conversations_organization_lookup
            ON conversations(organization_id, principal_id, updated_at DESC);
          CREATE INDEX IF NOT EXISTS idx_messages_organization_lookup
            ON messages(organization_id, conversation_id, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_memory_proposals_status
            ON memory_proposals(organization_id, status, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_memory_proposals_request
            ON memory_proposals(request_id);
          CREATE INDEX IF NOT EXISTS idx_memory_proposals_conversation
            ON memory_proposals(conversation_id);
        `);
      }
      if (prev < 38) {
        this.inner.exec(`
          CREATE TABLE IF NOT EXISTS task_schedule_proposals (
            id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL REFERENCES dispatch_plans(request_id) ON DELETE CASCADE,
            proposal_index INTEGER NOT NULL,
            organization_id TEXT NOT NULL REFERENCES organizations(id),
            principal_id TEXT REFERENCES principals(id) ON DELETE SET NULL,
            channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
            project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
            operation TEXT NOT NULL CHECK(operation = 'create_task_schedule'),
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            cron_kind TEXT NOT NULL CHECK(cron_kind IN ('interval', 'daily', 'weekly', 'monthly')),
            cron_value TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected')),
            proposed_by TEXT NOT NULL,
            decided_by TEXT,
            decision_reason TEXT,
            schedule_id TEXT REFERENCES schedules(id) ON DELETE SET NULL,
            created_at INTEGER NOT NULL,
            decided_at INTEGER,
            UNIQUE(request_id, proposal_index)
          );
          CREATE INDEX IF NOT EXISTS idx_task_schedule_proposals_status
            ON task_schedule_proposals(organization_id, status, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_task_schedule_proposals_request
            ON task_schedule_proposals(request_id);
          CREATE INDEX IF NOT EXISTS idx_task_schedule_proposals_conversation
            ON task_schedule_proposals(conversation_id);
        `);
      }
      if (prev < 39) {
        // The built-in LLM/tool-loop runtime was historically called Hermes,
        // before the real Hermes Agent CLI was integrated as eng-hermes-cli.
        // Move every live engine reference to an unambiguous Nexus identity.
        // Some early schema snapshots were stamped with a later version while
        // still missing additive columns. Bring the engine table to the
        // canonical shape before copying the legacy row.
        addCol('engines', 'config_json', 'TEXT');
        addCol('agents', 'agent_kind', "TEXT NOT NULL DEFAULT 'general'");

        // INSERT OR IGNORE makes this safe if eng-nexus was already created by
        // an interrupted migration. When both rows exist, the canonical Nexus
        // row wins and only missing metadata is filled from the legacy row.
        this.inner.exec(`
          INSERT OR IGNORE INTO engines(
            id, type, name, version, path, status, auth_status, is_default,
            data_boundary, config_json
          )
          SELECT
            'eng-nexus', 'nexus', 'Nexus Agent', version, path, status,
            auth_status, is_default, data_boundary, config_json
          FROM engines WHERE id = 'eng-hermes';

          UPDATE engines
          SET type = 'nexus', name = 'Nexus Agent',
              version = COALESCE(version, (
                SELECT version FROM engines legacy WHERE legacy.id = 'eng-hermes'
              )),
              path = COALESCE(path, (
                SELECT path FROM engines legacy WHERE legacy.id = 'eng-hermes'
              )),
              is_default = MAX(is_default, COALESCE((
                SELECT is_default FROM engines legacy WHERE legacy.id = 'eng-hermes'
              ), 0)),
              data_boundary = CASE WHEN data_boundary = '' THEN COALESCE((
                SELECT data_boundary FROM engines legacy WHERE legacy.id = 'eng-hermes'
              ), '') ELSE data_boundary END,
              config_json = COALESCE(config_json, (
                SELECT config_json FROM engines legacy WHERE legacy.id = 'eng-hermes'
              ))
          WHERE id = 'eng-nexus';
        `);

        const hasColumn = (table: string, column: string): boolean => {
          const info = this.inner.exec(`PRAGMA table_info(${table})`);
          return info.length > 0 && info[0].values.some((row) => row[1] === column);
        };
        const hasTable = (table: string): boolean => {
          const info = this.inner.exec(`PRAGMA table_info(${table})`);
          return info.length > 0;
        };
        const requireColumn = (table: string, column: string): void => {
          // A table introduced by an older optional migration may be absent
          // from a deliberately minimal snapshot. There can be no references
          // to migrate in a table that does not exist. Conversely, if the
          // table is present, a missing reference column means the stamped
          // schema is malformed and must fail closed.
          if (!hasTable(table)) return;
          if (!hasColumn(table, column)) {
            this.migrationFailure(39, `cannot migrate legacy engine references because ${table}.${column} is missing`);
          }
        };
        // These columns exist in every supported pre-v39 schema after the
        // additive migrations above. Treat a stamped-but-malformed database
        // as unrecoverable instead of deleting eng-hermes and leaving opaque
        // engine references behind.
        for (const [table, column] of [
          ['agents', 'engine_id'],
          ['agents', 'agent_kind'],
          ['tasks', 'engine_override'],
          ['tasks', 'status'],
          ['agent_runs', 'requested_engine_id'],
          ['agent_runs', 'resolved_engine_id'],
          ['dispatch_plans', 'worker_agent_id'],
          ['dispatch_plans', 'worker_engine_id'],
          ['dispatch_plans', 'plan_json'],
          ['dispatch_plans', 'status'],
          ['task_events', 'payload'],
          ['engine_logs', 'engine_id'],
          ['settings', 'key'],
          ['settings', 'value_json'],
          ['settings', 'updated_at'],
          ['providers', 'api_key_ref']
        ] as const) requireColumn(table, column);
        const migrateReference = (table: string, column: string): void => {
          if (!hasTable(table)) return;
          this.inner.exec(`UPDATE ${table} SET ${column} = 'eng-nexus' WHERE ${column} = 'eng-hermes'`);
        };
        const migrateJsonReference = (table: string, column: string): void => {
          if (!hasTable(table)) return;
          this.inner.exec(`
            UPDATE ${table}
            SET ${column} = REPLACE(${column}, '"eng-hermes"', '"eng-nexus"')
            WHERE INSTR(${column}, '"eng-hermes"') > 0
          `);
        };

        migrateReference('agents', 'engine_id');
        this.inner.exec(`
          UPDATE agents
          SET engine_id = 'eng-hermes-cli'
          WHERE agent_kind = 'android_operator' AND engine_id <> 'eng-hermes-cli'
        `);
        migrateReference('tasks', 'engine_override');
        migrateReference('agent_runs', 'requested_engine_id');
        migrateReference('agent_runs', 'resolved_engine_id');
        migrateReference('dispatch_plans', 'worker_engine_id');
        migrateJsonReference('dispatch_plans', 'plan_json');
        migrateJsonReference('task_events', 'payload');
        migrateReference('engine_logs', 'engine_id');

        // Old builds could bind an Android employee or a task-level override
        // to DSH/another runtime. Only active work is repaired; terminal task
        // and run rows remain historical evidence of what actually executed.
        this.inner.exec(`
          UPDATE tasks
          SET engine_override = NULL
          WHERE status IN ('QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'PAUSED')
            AND agent_id IN (
              SELECT id FROM agents WHERE agent_kind = 'android_operator'
            )
        `);
        {
          const plans = this.migrationRows(`
            SELECT id, plan_json FROM dispatch_plans
            WHERE worker_agent_id IN (
              SELECT id FROM agents WHERE agent_kind = 'android_operator'
            ) AND (
              status = 'planned'
              OR (status = 'committed' AND (
                task_id IS NULL OR task_id IN (
                  SELECT id FROM tasks
                  WHERE status IN ('QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'PAUSED')
                )
              ))
            )
          `);
          for (const plan of plans) {
            let parsed: Record<string, unknown>;
            try {
              const value = JSON.parse(String(plan.plan_json));
              if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
              parsed = value as Record<string, unknown>;
            } catch {
              this.migrationFailure(39, `Android dispatch plan ${String(plan.id)} contains invalid JSON`);
            }
            parsed.workerEngineId = 'eng-hermes-cli';
            this.raw.prepare(
              "UPDATE dispatch_plans SET worker_engine_id = 'eng-hermes-cli', plan_json = ? WHERE id = ?"
            ).run(JSON.stringify(parsed), String(plan.id));
          }
        }

        {
          this.inner.exec(`
            INSERT OR IGNORE INTO settings(key, value_json, updated_at)
            SELECT REPLACE(key, 'eng-hermes', 'eng-nexus'), value_json, updated_at
            FROM settings
            WHERE key IN ('engine:health:eng-hermes', 'secret:engine:eng-hermes:env');
            DELETE FROM settings
            WHERE key IN ('engine:health:eng-hermes', 'secret:engine:eng-hermes:env');
            UPDATE settings
            SET value_json = REPLACE(value_json, '"eng-hermes"', '"eng-nexus"')
            WHERE INSTR(value_json, '"eng-hermes"') > 0;

            INSERT OR IGNORE INTO settings(key, value_json, updated_at)
            SELECT 'provider:nexus', value_json, updated_at
            FROM settings WHERE key = 'provider:hermes';
          `);

          const legacySecret = this.migrationRows(
            "SELECT value_json, updated_at FROM settings WHERE key = 'secret:provider:hermes:key'"
          )[0];
          const canonicalSecret = this.migrationRows(
            "SELECT value_json, updated_at FROM settings WHERE key = 'secret:provider:nexus:key'"
          )[0];
          let migratedSecretRef = 'secret:provider:nexus:key';
          if (legacySecret) {
            if (canonicalSecret && canonicalSecret.value_json !== legacySecret.value_json) {
              migratedSecretRef = 'secret:provider:nexus:migrated-v39-key';
              const existingMigrated = this.migrationRows(
                'SELECT value_json FROM settings WHERE key = ?', [migratedSecretRef]
              )[0];
              if (existingMigrated && existingMigrated.value_json !== legacySecret.value_json) {
                this.migrationFailure(39, 'cannot preserve two distinct legacy Nexus Provider credentials');
              }
              this.raw.prepare(
                'INSERT OR REPLACE INTO settings(key, value_json, updated_at) VALUES(?, ?, ?)'
              ).run(migratedSecretRef, legacySecret.value_json, legacySecret.updated_at);
            } else if (!canonicalSecret) {
              this.raw.prepare(
                'INSERT INTO settings(key, value_json, updated_at) VALUES(?, ?, ?)'
              ).run(migratedSecretRef, legacySecret.value_json, legacySecret.updated_at);
            }
          }

          this.raw.prepare(
            "UPDATE providers SET api_key_ref = ? WHERE api_key_ref = 'secret:provider:hermes:key'"
          ).run(migratedSecretRef);
          this.inner.exec(`
            DELETE FROM settings
            WHERE key IN ('provider:hermes', 'secret:provider:hermes:key')
          `);
        }

        this.inner.exec("DELETE FROM engines WHERE id = 'eng-hermes'");
      }
      this.inner.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_input_message_exactly_once
        ON tasks(input_message_id) WHERE input_message_id IS NOT NULL`);
      this.assertForeignKeyIntegrity();
      this.setMeta('schema_version', String(SCHEMA_VERSION));
      this.inner.exec('COMMIT');
    } catch (err) {
      this.inner.exec('ROLLBACK');
      this.enableForeignKeys();
      throw err;
    }
    this.enableForeignKeys();
    this.flush();
  }

  scheduleSave() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 400);
  }

  /** 立即落盘（退出前必须调用）。
   *  原子写：先写临时文件并 fsync，再 rename 覆盖目标。
   *  直接 writeFileSync 覆盖live 库时若进程被杀/断电，会留下截断或全零文件，
   *  下次启动 sql.js 直接抛 "file is not a database" 且无法恢复（已实际发生过）。 */
  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty && existsSync(this.file)) return;
    const data = Buffer.from(this.inner.export());
    // 导出为空视为异常，宁可不写也不要用空内容覆盖已有数据
    if (data.length === 0) {
      console.error('[Database] 导出结果为空，已跳过本次落盘以避免破坏现有数据库');
      return;
    }
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    let fd: number | null = null;
    try {
      fd = openSync(tmp, 'w');
      writeFileSync(fd, data);
      fsyncSync(fd); // 确保数据真正落盘后再 rename，避免 rename 成功但内容仍在页缓存
      closeSync(fd);
      fd = null;
      renameSync(tmp, this.file); // 同目录 rename 在 Windows/POSIX 上均为原子替换
      this.dirty = false;
    } catch (err) {
      if (fd !== null) { try { closeSync(fd); } catch { /* 忽略 */ } }
      try { rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
      throw err;
    }
  }

  /** 校验外部备份并暂存；下次启动时先加载该文件，迁移成功后才覆盖当前数据库。 */
  async stageRestore(sourcePath: string): Promise<{ ok: boolean; message: string }> {
    const { data, schemaVersion } = await validateDatabaseBackup(sourcePath, SCHEMA_VERSION);
    const pending = join(dirname(this.file), 'aibox.restore.pending.db');
    writeFileSync(pending, data);
    this.audit({ id: randomUUID(), actor: 'admin', action: 'data.restore.stage', target: `schema-v${schemaVersion}`, result: 'restart-required' });
    return { ok: true, message: `备份校验通过（v${schemaVersion}），重启应用后恢复生效` };
  }

  getMeta(key: string): string | null {
    const row = this.raw.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key);
    return (row?.value as string) ?? null;
  }

  setMeta(key: string, value: string) {
    this.raw
      .prepare('INSERT INTO schema_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.raw.prepare('SELECT value_json FROM settings WHERE key = ?').get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value_json as string) as T;
    } catch {
      return fallback;
    }
  }

  setSetting(key: string, value: unknown) {
    this.raw
      .prepare(
        'INSERT INTO settings(key, value_json, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at'
      )
      .run(key, JSON.stringify(value), Date.now());
  }

  /** 任务状态更新 + 事件写入在同一事务内完成（13.2） */
  transaction(fn: () => void) {
    this.inner.exec('BEGIN');
    try {
      fn();
      this.inner.exec('COMMIT');
    } catch (err) {
      this.inner.exec('ROLLBACK');
      throw err;
    }
    this.scheduleSave();
  }

  audit(entry: { id: string; actor: string; action: string; target: string; result: string; source?: string }) {
    this.raw
      .prepare('INSERT INTO audit_logs(id, actor, action, target, result, source, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(entry.id, entry.actor, entry.action, entry.target, entry.result, entry.source ?? 'desktop', Date.now());
  }

  /** 数据保留策略（设置页承诺）：任务日志 90 天 / 资源明细 7 天 / 审计 1 年；启动及每 24h 执行 */
  cleanupRetention() {
    const now = Date.now();
    const d90 = now - 90 * 86_400_000;
    const d7 = now - 7 * 86_400_000;
    const d365 = now - 365 * 86_400_000;
    const expiredArtifacts = this.raw.prepare('SELECT storage_name FROM mobile_artifacts WHERE created_at < ?')
      .all(now - 30 * 86_400_000) as { storage_name: string }[];
    this.transaction(() => {
      // Canonical inbound tasks are permanent idempotency receipts. Purge their
      // payload after 90 days, but retain task/message/plan identity forever.
      const expired = "SELECT id FROM tasks WHERE ended_at IS NOT NULL AND ended_at < ?";
      const removable = `${expired} AND input_message_id IS NULL`;
      this.raw.prepare(`DELETE FROM dispatch_plans WHERE task_id IN (${removable})`).run(d90);
      this.raw.prepare(`UPDATE messages SET task_id = NULL WHERE task_id IN (${removable})`).run(d90);
      this.raw.prepare(`UPDATE mobile_control_sessions SET task_id = NULL WHERE task_id IN (${expired})`).run(d90);
      this.raw.prepare(`UPDATE mobile_commands SET task_id = NULL WHERE task_id IN (${expired})`).run(d90);
      this.raw.prepare(`UPDATE mobile_artifacts SET task_id = NULL WHERE task_id IN (${expired})`).run(d90);
      this.raw.prepare(`DELETE FROM task_events WHERE task_id IN (${expired})`).run(d90);
      this.raw.prepare(`DELETE FROM task_messages WHERE task_id IN (${expired})`).run(d90);
      this.raw.prepare(`DELETE FROM agent_runs WHERE task_id IN (${expired})`).run(d90);
      this.raw.prepare(`DELETE FROM approvals WHERE task_id IN (${expired})`).run(d90);
      this.raw.prepare(`
        UPDATE tasks
        SET title = '', content = '', stage = '', error = NULL, result = NULL,
            quality = NULL, session_id = NULL, workspace_override = NULL,
            engine_override = NULL, deleted_at = COALESCE(deleted_at, ?)
        WHERE ended_at IS NOT NULL AND ended_at < ? AND input_message_id IS NOT NULL
      `).run(now, d90);
      this.raw.prepare('DELETE FROM tasks WHERE ended_at IS NOT NULL AND ended_at < ? AND input_message_id IS NULL').run(d90);
      this.raw.prepare('DELETE FROM resource_samples WHERE created_at < ?').run(d7);
      this.raw.prepare('DELETE FROM mobile_artifacts WHERE created_at < ?').run(now - 30 * 86_400_000);
      this.raw.prepare('UPDATE mobile_artifacts SET command_id = NULL WHERE command_id IN (SELECT id FROM mobile_commands WHERE started_at < ?)').run(d90);
      this.raw.prepare('DELETE FROM mobile_commands WHERE started_at < ?').run(d90);
      this.raw.prepare("UPDATE mobile_control_sessions SET status = 'expired', ended_at = COALESCE(ended_at, ?) WHERE status = 'active' AND expires_at < ?").run(now, now);
      this.raw.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(d365);
    });
    const artifactDir = join(app.getPath('userData'), 'aibox-data', 'mobile-artifacts');
    for (const row of expiredArtifacts) {
      if (basename(row.storage_name) !== row.storage_name) continue;
      try { rmSync(join(artifactDir, row.storage_name), { force: true }); } catch { /* 下次清理重试孤立文件 */ }
    }
  }

  /** 数据库完整性检查：PRAGMA integrity_check + 孤立记录修复（设置页可手动触发） */
  integrityCheck(): { ok: boolean; message: string; repaired: number } {
    let repaired = 0;
    // 1. SQLite 完整性检查
    const result = this.raw.prepare('PRAGMA integrity_check').get() as { integrity_check: string } | undefined;
    const integrityOk = result?.integrity_check === 'ok';
    // 2. 修复可安全丢弃的派生记录与可置空的历史链接。
    this.transaction(() => {
      const orphanEvents = this.raw.prepare('DELETE FROM task_events WHERE task_id NOT IN (SELECT id FROM tasks)').run().changes;
      const orphanMsgs = this.raw.prepare('DELETE FROM task_messages WHERE task_id NOT IN (SELECT id FROM tasks)').run().changes;
      const orphanRuns = this.raw.prepare('DELETE FROM agent_runs WHERE task_id NOT IN (SELECT id FROM tasks)').run().changes;
      const orphanApprovals = this.raw.prepare('DELETE FROM approvals WHERE task_id NOT IN (SELECT id FROM tasks)').run().changes;
      const orphanSkills = this.raw.prepare('DELETE FROM agent_skills WHERE agent_id NOT IN (SELECT id FROM agents)').run().changes;
      // Only detach non-input message references automatically. Canonical
      // inbound/task/plan evidence is reported by foreign_key_check and must be
      // repaired by a deterministic migration or explicit recovery workflow.
      const detachedMessages = this.raw.prepare(`UPDATE messages SET task_id = NULL
        WHERE direction <> 'inbound' AND task_id IS NOT NULL
          AND task_id NOT IN (SELECT id FROM tasks)`).run().changes;
      const detachedSessions = this.raw.prepare('UPDATE mobile_control_sessions SET task_id = NULL WHERE task_id IS NOT NULL AND task_id NOT IN (SELECT id FROM tasks)').run().changes;
      const detachedCommands = this.raw.prepare('UPDATE mobile_commands SET task_id = NULL WHERE task_id IS NOT NULL AND task_id NOT IN (SELECT id FROM tasks)').run().changes;
      const detachedArtifacts = this.raw.prepare('UPDATE mobile_artifacts SET task_id = NULL WHERE task_id IS NOT NULL AND task_id NOT IN (SELECT id FROM tasks)').run().changes;
      repaired = orphanEvents + orphanMsgs + orphanRuns + orphanApprovals + orphanSkills
        + detachedMessages + detachedSessions + detachedCommands + detachedArtifacts;
    });
    const foreignKeyViolations = this.raw.prepare('PRAGMA foreign_key_check').all();
    const ok = integrityOk && foreignKeyViolations.length === 0;
    const msg = !integrityOk
      ? `数据库完整性检查异常：${result?.integrity_check ?? '未知错误'}`
      : foreignKeyViolations.length > 0
        ? `数据库存在 ${foreignKeyViolations.length} 条无法自动修复的外键异常`
        : repaired > 0
          ? `数据库结构完整，已清理 ${repaired} 条孤立记录`
          : '数据库结构完整，无异常';
    return { ok, message: msg, repaired };
  }
}
