/**
 * SQLite 本地数据层（PRD 13.x）
 * 实现：sql.js（SQLite WASM 构建）——Windows / Ubuntu 零原生编译，打包分发可靠。
 * 持久化：WAL 语义无 WAL 文件需求；变更后防抖导出到 userData/aibox-data/aibox.db。
 * 密钥/Token 不写入 SQLite（15.1），表内仅保存系统密钥库引用。
 */
import initSqlJs, { type Database as SqlJsDatabase, type SqlValue } from 'sql.js';
import { createRequire } from 'node:module';
import { app } from 'electron';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
/** v2：tasks.result；v3：session_id + task_messages + schedules；
 *  v4：人设三文件 + conversations + mcp_servers + skills + agent_skills + usage_records；
 *  v5：多供应商 providers 表 + agents.provider_id/model_override + 窗口状态 + 模板 */
const SCHEMA_VERSION = 24;

const DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
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
  project_id TEXT REFERENCES projects(id),
  title TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'desktop',
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
  agent_id TEXT NOT NULL REFERENCES agents(id),
  title TEXT NOT NULL,
  cron_kind TEXT NOT NULL,
  cron_value TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  account_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'UNCONFIGURED',
  credential_ref TEXT,
  last_connected_at INTEGER,
  limitation TEXT NOT NULL DEFAULT ''
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
  title TEXT NOT NULL DEFAULT '',
  last_message_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '[]',
  env TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  scope TEXT NOT NULL DEFAULT 'global'
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
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
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

    d.inner = existsSync(d.file)
      ? new SQL.Database(new Uint8Array(readFileSync(d.file)))
      : new SQL.Database();
    d.migrate();
    return d;
  }

  private migrate() {
    // 13.1：migration 在事务中执行，失败回滚；按版本号增量迁移
    this.inner.exec('BEGIN');
    try {
      this.inner.exec(DDL);
      const prev = Number(this.getMeta('schema_version') ?? '0');
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
      this.setMeta('schema_version', String(SCHEMA_VERSION));
      this.inner.exec('COMMIT');
    } catch (err) {
      this.inner.exec('ROLLBACK');
      throw err;
    }
    this.flush();
  }

  scheduleSave() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 400);
  }

  /** 立即落盘（退出前必须调用） */
  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty && existsSync(this.file)) return;
    const data = this.inner.export();
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, Buffer.from(data));
    this.dirty = false;
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
    this.transaction(() => {
      // 已结束任务超保留期：级联清理事件/消息/运行记录后删除任务本身
      const sub = "SELECT id FROM tasks WHERE ended_at IS NOT NULL AND ended_at < ?";
      this.raw.prepare(`DELETE FROM task_events WHERE task_id IN (${sub})`).run(d90);
      this.raw.prepare(`DELETE FROM task_messages WHERE task_id IN (${sub})`).run(d90);
      this.raw.prepare(`DELETE FROM agent_runs WHERE task_id IN (${sub})`).run(d90);
      this.raw.prepare(`DELETE FROM approvals WHERE task_id IN (${sub})`).run(d90);
      this.raw.prepare('DELETE FROM tasks WHERE ended_at IS NOT NULL AND ended_at < ?').run(d90);
      this.raw.prepare('DELETE FROM resource_samples WHERE created_at < ?').run(d7);
      this.raw.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(d365);
    });
  }

  /** 数据库完整性检查：PRAGMA integrity_check + 孤立记录修复（设置页可手动触发） */
  integrityCheck(): { ok: boolean; message: string; repaired: number } {
    let repaired = 0;
    // 1. SQLite 完整性检查
    const result = this.raw.prepare('PRAGMA integrity_check').get() as { integrity_check: string } | undefined;
    const integrityOk = result?.integrity_check === 'ok';
    // 2. 修复孤立记录（引用已删除任务的残留数据）
    this.transaction(() => {
      const orphanEvents = this.raw.prepare('DELETE FROM task_events WHERE task_id NOT IN (SELECT id FROM tasks)').run().changes;
      const orphanMsgs = this.raw.prepare('DELETE FROM task_messages WHERE task_id NOT IN (SELECT id FROM tasks)').run().changes;
      const orphanRuns = this.raw.prepare('DELETE FROM agent_runs WHERE task_id NOT IN (SELECT id FROM tasks)').run().changes;
      const orphanApprovals = this.raw.prepare('DELETE FROM approvals WHERE task_id NOT IN (SELECT id FROM tasks)').run().changes;
      const orphanSkills = this.raw.prepare('DELETE FROM agent_skills WHERE agent_id NOT IN (SELECT id FROM agents)').run().changes;
      repaired = orphanEvents + orphanMsgs + orphanRuns + orphanApprovals + orphanSkills;
    });
    const msg = integrityOk
      ? repaired > 0 ? `数据库结构完整，已清理 ${repaired} 条孤立记录` : '数据库结构完整，无异常'
      : `数据库完整性检查异常：${result?.integrity_check ?? '未知错误'}`;
    return { ok: integrityOk, message: msg, repaired };
  }
}
