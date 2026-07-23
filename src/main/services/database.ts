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
const SCHEMA_VERSION = 11;

const DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
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
  ended_at INTEGER
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
  task_text TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'decompose',
  current_step INTEGER NOT NULL DEFAULT 0,
  total_steps INTEGER NOT NULL DEFAULT 0,
  subtasks_json TEXT NOT NULL DEFAULT '[]',
  final_result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
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
    const prev = Number(this.getMeta('schema_version') ?? '0');
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
