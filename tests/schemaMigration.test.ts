/**
 * Schema 迁移链路测试（v26 - v31）
 *
 * 用真实 sql.js（非 mock）验证迁移，因为迁移本身就是 SQL 行为：
 * ALTER TABLE 是否冲突、回填 UPDATE 是否命中、事务是否完整提交，
 * 这些用内存 Map 模拟的 mockDb 一律测不出来。
 *
 * 模拟一个 v25 旧库（含已下线引擎的员工 + 演示数据），跑完整迁移后断言结果。
 *
 * @author liyingjie <y@senke.com>
 */
// @ts-nocheck
/* eslint-disable */
import { describe, expect, it, beforeAll } from 'vitest';
import initSqlJs from 'sql.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
});

/** v25 时代的最小表结构（仅本次迁移涉及的表与列） */
const V25_DDL = `
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, objective TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '', client_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active', color TEXT NOT NULL DEFAULT '#4d6bfe',
  due_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '', lifecycle TEXT NOT NULL DEFAULT 'DISABLED',
  engine_id TEXT NOT NULL, workspace TEXT NOT NULL DEFAULT '',
  permission_mode TEXT NOT NULL DEFAULT 'standard', concurrency_limit INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0, avatar_color TEXT NOT NULL DEFAULT '#4d6bfe',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE engines (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, version TEXT, path TEXT,
  status TEXT NOT NULL DEFAULT 'NOT_INSTALLED', auth_status TEXT NOT NULL DEFAULT 'unknown',
  is_default INTEGER NOT NULL DEFAULT 0, data_boundary TEXT NOT NULL DEFAULT ''
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, project_id TEXT, title TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'desktop', parent_id TEXT, status TEXT NOT NULL DEFAULT 'QUEUED',
  priority INTEGER NOT NULL DEFAULT 0, progress INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT '', error TEXT, workspace_override TEXT,
  created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, deleted_at INTEGER
);
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, command TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '[]', env TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1, scope TEXT NOT NULL DEFAULT 'global'
);
`;

const MOBILE_DDL = `
CREATE TABLE IF NOT EXISTS mobile_devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', manufacturer TEXT NOT NULL DEFAULT '',
  android_version TEXT NOT NULL DEFAULT '', api_level INTEGER NOT NULL DEFAULT 0, app_version TEXT NOT NULL DEFAULT '',
  protocol_version INTEGER NOT NULL, identity_public_key TEXT NOT NULL, identity_fingerprint TEXT NOT NULL UNIQUE,
  certificate_fingerprint TEXT NOT NULL DEFAULT '', permissions_json TEXT NOT NULL DEFAULT '{}', capabilities_json TEXT NOT NULL DEFAULT '{}',
  paired_at INTEGER NOT NULL, last_seen_at INTEGER, last_ip TEXT
);
CREATE TABLE IF NOT EXISTS mobile_agent_configs (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id), device_id TEXT UNIQUE REFERENCES mobile_devices(id),
  hermes_profile TEXT NOT NULL UNIQUE, allowed_tools_json TEXT NOT NULL DEFAULT '[]', authorization_confirmed_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mobile_control_sessions (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), device_id TEXT NOT NULL REFERENCES mobile_devices(id),
  task_id TEXT REFERENCES tasks(id), status TEXT NOT NULL DEFAULT 'active', allowed_tools_json TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS mobile_commands (
  id TEXT PRIMARY KEY, session_id TEXT REFERENCES mobile_control_sessions(id), agent_id TEXT REFERENCES agents(id),
  device_id TEXT NOT NULL REFERENCES mobile_devices(id), task_id TEXT REFERENCES tasks(id), tool_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', request_summary_json TEXT NOT NULL DEFAULT '{}', result_summary_json TEXT NOT NULL DEFAULT '{}',
  error TEXT, started_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS mobile_artifacts (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES mobile_devices(id), agent_id TEXT REFERENCES agents(id),
  task_id TEXT REFERENCES tasks(id), command_id TEXT REFERENCES mobile_commands(id), kind TEXT NOT NULL, mime_type TEXT NOT NULL,
  filename TEXT NOT NULL, storage_name TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mobile_scripts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', agent_id TEXT REFERENCES agents(id),
  device_id TEXT REFERENCES mobile_devices(id), steps_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_active_device_lease ON mobile_control_sessions(device_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_active_agent_lease ON mobile_control_sessions(agent_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_active_task_lease ON mobile_control_sessions(task_id) WHERE status = 'active';
`;

/** 本次迁移的核心 SQL（与 database.ts migrate() 中 v26-v31 分支保持一致） */
function runMigrations(db: InstanceType<typeof SQL.Database>) {
  const addCol = (table: string, col: string, type: string) => {
    const cols = db.exec(`PRAGMA table_info(${table})`);
    const exists = cols.length > 0 && cols[0].values.some((r) => r[1] === col);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  };
  db.exec('BEGIN');
  try {
    db.exec(MOBILE_DDL);
    // v26：引擎收敛，下线引擎的员工改绑 Nexus
    db.exec(`
      UPDATE agents SET engine_id = 'eng-hermes'
      WHERE engine_id IN ('eng-claude', 'eng-zcode', 'eng-kimi');
      DELETE FROM engines WHERE id IN ('eng-claude', 'eng-zcode', 'eng-kimi');
    `);
    // v27：演示数据隔离
    addCol('projects', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
    addCol('agents', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
    addCol('tasks', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
    db.exec(`
      UPDATE projects SET is_demo = 1 WHERE id LIKE 'project-demo-%';
      UPDATE tasks SET is_demo = 1 WHERE project_id LIKE 'project-demo-%';
      UPDATE agents SET is_demo = 1 WHERE id IN (
        SELECT DISTINCT agent_id FROM tasks WHERE project_id LIKE 'project-demo-%'
      );
    `);
    // v28：任务级引擎覆盖
    addCol('tasks', 'engine_override', 'TEXT');
    // v29-v30：MCP 能力分类与旧浏览器服务回填
    addCol('mcp_servers', 'capability', "TEXT NOT NULL DEFAULT ''");
    db.exec(`UPDATE mcp_servers SET capability = 'browser'
      WHERE capability = '' AND command = 'npx' AND args LIKE '%@modelcontextprotocol/server-puppeteer%';`);
    // v31：Android 手机员工身份与 Mobile Gateway 数据域
    addCol('agents', 'agent_kind', "TEXT NOT NULL DEFAULT 'general'");
    db.exec("UPDATE agents SET agent_kind = 'general' WHERE agent_kind IS NULL OR agent_kind = ''");
    addCol('mobile_devices', 'certificate_fingerprint', "TEXT NOT NULL DEFAULT ''");
    db.exec("INSERT OR REPLACE INTO schema_meta(key, value) VALUES('schema_version', '31')");
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** 构造一个含演示数据与真实数据的 v25 旧库 */
function makeV25Db() {
  const db = new SQL.Database();
  db.exec(V25_DDL);
  db.exec(`INSERT INTO schema_meta(key, value) VALUES('schema_version', '25')`);
  db.exec(`
    INSERT INTO engines(id, type, name) VALUES
      ('eng-hermes', 'hermes', 'Nexus Agent'),
      ('eng-claude', 'claude-code', 'Claude Code'),
      ('eng-zcode', 'zcode', 'ZCode'),
      ('eng-kimi', 'kimicode', 'Kimi Code'),
      ('eng-opencode', 'opencode', 'OpenCode');

    INSERT INTO projects(id, name, created_at, updated_at) VALUES
      ('project-demo-operations', '经营自动化一期', 1, 1),
      ('project-real', '真实项目', 1, 1);

    INSERT INTO agents(id, name, role, engine_id, created_at, updated_at) VALUES
      ('agent-demo', 'ERP/CRM助手', '演示员工', 'eng-hermes', 1, 1),
      ('agent-on-claude', '前端助手', '真实员工', 'eng-claude', 1, 1),
      ('agent-on-zcode', '后端助手', '真实员工', 'eng-zcode', 1, 1),
      ('agent-real', '真实助手', '真实员工', 'eng-opencode', 1, 1);

    INSERT INTO tasks(id, agent_id, project_id, title, created_at) VALUES
      ('task-demo', 'agent-demo', 'project-demo-operations', '例行任务 #1', 1),
      ('task-real', 'agent-real', 'project-real', '真实任务', 1),
      ('task-no-project', 'agent-real', NULL, '无项目任务', 1);

    INSERT INTO mcp_servers(id, name, command, args) VALUES
      ('mcp-browser', '浏览器自动化', 'npx', '["-y","@modelcontextprotocol/server-puppeteer"]'),
      ('mcp-memory', '记忆', 'npx', '["-y","@modelcontextprotocol/server-memory"]');
  `);
  return db;
}

const one = (db, sql: string) => db.exec(sql)[0]?.values[0]?.[0];
const col = (db, table: string, name: string) =>
  db.exec(`PRAGMA table_info(${table})`)[0].values.some((r) => r[1] === name);

describe('schema 迁移 v25 → v31（真实 sql.js）', () => {
  it('迁移整体可执行且版本号推进到 31', () => {
    const db = makeV25Db();
    expect(() => runMigrations(db)).not.toThrow();
    expect(one(db, "SELECT value FROM schema_meta WHERE key = 'schema_version'")).toBe('31');
  });

  it('v26：绑定已下线引擎的员工改绑 Nexus，不留悬空 engine_id', () => {
    const db = makeV25Db();
    runMigrations(db);
    expect(one(db, "SELECT engine_id FROM agents WHERE id = 'agent-on-claude'")).toBe('eng-hermes');
    expect(one(db, "SELECT engine_id FROM agents WHERE id = 'agent-on-zcode'")).toBe('eng-hermes');
    // 未受影响的员工保持原引擎
    expect(one(db, "SELECT engine_id FROM agents WHERE id = 'agent-real'")).toBe('eng-opencode');
    // 关键：不存在指向已删除引擎的员工
    expect(one(db, 'SELECT COUNT(*) FROM agents WHERE engine_id NOT IN (SELECT id FROM engines)')).toBe(0);
  });

  it('v26：下线引擎从 engines 表移除，四引擎保留', () => {
    const db = makeV25Db();
    runMigrations(db);
    expect(one(db, "SELECT COUNT(*) FROM engines WHERE id IN ('eng-claude','eng-zcode','eng-kimi')")).toBe(0);
    expect(one(db, "SELECT COUNT(*) FROM engines WHERE id IN ('eng-hermes','eng-opencode')")).toBe(2);
  });

  it('v27：三张表都加上 is_demo 列', () => {
    const db = makeV25Db();
    runMigrations(db);
    for (const t of ['projects', 'agents', 'tasks']) expect(col(db, t, 'is_demo')).toBe(true);
  });

  it('v27：演示数据被正确标记', () => {
    const db = makeV25Db();
    runMigrations(db);
    expect(one(db, "SELECT is_demo FROM projects WHERE id = 'project-demo-operations'")).toBe(1);
    expect(one(db, "SELECT is_demo FROM tasks WHERE id = 'task-demo'")).toBe(1);
    expect(one(db, "SELECT is_demo FROM agents WHERE id = 'agent-demo'")).toBe(1);
  });

  it('v27：真实数据不被误标（这是回填最危险的地方）', () => {
    const db = makeV25Db();
    runMigrations(db);
    expect(one(db, "SELECT is_demo FROM projects WHERE id = 'project-real'")).toBe(0);
    expect(one(db, "SELECT is_demo FROM tasks WHERE id = 'task-real'")).toBe(0);
    expect(one(db, "SELECT is_demo FROM tasks WHERE id = 'task-no-project'")).toBe(0);
    expect(one(db, "SELECT is_demo FROM agents WHERE id = 'agent-real'")).toBe(0);
  });

  it('v28：tasks 增加 engine_override 列且默认为空', () => {
    const db = makeV25Db();
    runMigrations(db);
    expect(col(db, 'tasks', 'engine_override')).toBe(true);
    expect(one(db, "SELECT COUNT(*) FROM tasks WHERE engine_override IS NOT NULL")).toBe(0);
  });

  it('v29-v30：MCP 增加能力分类并只回填旧浏览器服务', () => {
    const db = makeV25Db();
    runMigrations(db);
    expect(col(db, 'mcp_servers', 'capability')).toBe(true);
    expect(one(db, "SELECT capability FROM mcp_servers WHERE id = 'mcp-browser'")).toBe('browser');
    expect(one(db, "SELECT capability FROM mcp_servers WHERE id = 'mcp-memory'")).toBe('');
  });

  it('v31：旧员工回填 general 且六张手机表完整创建', () => {
    const db = makeV25Db();
    runMigrations(db);
    expect(col(db, 'agents', 'agent_kind')).toBe(true);
    expect(one(db, "SELECT COUNT(*) FROM agents WHERE agent_kind = 'general'")).toBe(4);
    for (const table of ['mobile_devices', 'mobile_agent_configs', 'mobile_control_sessions', 'mobile_commands', 'mobile_artifacts', 'mobile_scripts']) {
      expect(one(db, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '${table}'`)).toBe(1);
    }
  });

  it('v31：数据库强制员工和设备一对一绑定', () => {
    const db = makeV25Db();
    runMigrations(db);
    db.exec(`
      INSERT INTO mobile_devices(id, protocol_version, identity_public_key, identity_fingerprint, paired_at) VALUES
        ('phone-1', 1, 'pk1', 'fp1', 1), ('phone-2', 1, 'pk2', 'fp2', 1);
      INSERT INTO mobile_agent_configs(agent_id, device_id, hermes_profile, created_at, updated_at)
        VALUES('agent-real', 'phone-1', 'profile-1', 1, 1);
    `);
    expect(() => db.exec("INSERT INTO mobile_agent_configs(agent_id, device_id, hermes_profile, created_at, updated_at) VALUES('agent-demo','phone-1','profile-2',1,1)")).toThrow(/UNIQUE/);
    expect(() => db.exec("INSERT INTO mobile_agent_configs(agent_id, device_id, hermes_profile, created_at, updated_at) VALUES('agent-real','phone-2','profile-3',1,1)")).toThrow(/UNIQUE/);
  });

  it('v31：设备、员工和任务活动租约唯一，结束后可创建下一条历史会话', () => {
    const db = makeV25Db();
    runMigrations(db);
    db.exec(`
      INSERT INTO mobile_devices(id, protocol_version, identity_public_key, identity_fingerprint, paired_at) VALUES
        ('phone-1', 1, 'pk1', 'fp1', 1), ('phone-2', 1, 'pk2', 'fp2', 1);
      INSERT INTO mobile_control_sessions(id, agent_id, device_id, task_id, status, started_at, expires_at)
        VALUES('lease-1', 'agent-real', 'phone-1', 'task-real', 'active', 1, 999999);
    `);
    expect(() => db.exec("INSERT INTO mobile_control_sessions(id,agent_id,device_id,status,started_at,expires_at) VALUES('lease-device','agent-demo','phone-1','active',1,9)")).toThrow(/UNIQUE/);
    expect(() => db.exec("INSERT INTO mobile_control_sessions(id,agent_id,device_id,status,started_at,expires_at) VALUES('lease-agent','agent-real','phone-2','active',1,9)")).toThrow(/UNIQUE/);
    expect(() => db.exec("INSERT INTO mobile_control_sessions(id,agent_id,device_id,task_id,status,started_at,expires_at) VALUES('lease-task','agent-demo','phone-2','task-real','active',1,9)")).toThrow(/UNIQUE/);
    db.exec("UPDATE mobile_control_sessions SET status='completed', ended_at=2 WHERE id='lease-1'");
    expect(() => db.exec("INSERT INTO mobile_control_sessions(id,agent_id,device_id,task_id,status,started_at,expires_at) VALUES('lease-2','agent-real','phone-1','task-real','active',3,9)")).not.toThrow();
  });

  it('重复执行迁移不报错（addCol 幂等，覆盖异常重启后重跑）', () => {
    const db = makeV25Db();
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    // 幂等：数据不被二次破坏
    expect(one(db, "SELECT is_demo FROM projects WHERE id = 'project-real'")).toBe(0);
    expect(one(db, "SELECT engine_id FROM agents WHERE id = 'agent-on-claude'")).toBe('eng-hermes');
  });

  it('空库（全新安装）迁移不报错', () => {
    const db = new SQL.Database();
    db.exec(V25_DDL);
    expect(() => runMigrations(db)).not.toThrow();
  });
});
