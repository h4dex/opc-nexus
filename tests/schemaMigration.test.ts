/**
 * Schema 迁移链路测试（v26 / v27 / v28）
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
`;

/** 本次三个迁移的核心 SQL（与 database.ts migrate() 中 prev<26/27/28 分支保持一致） */
function runMigrations(db: InstanceType<typeof SQL.Database>) {
  const addCol = (table: string, col: string, type: string) => {
    const cols = db.exec(`PRAGMA table_info(${table})`);
    const exists = cols.length > 0 && cols[0].values.some((r) => r[1] === col);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  };
  db.exec('BEGIN');
  try {
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
    db.exec("INSERT OR REPLACE INTO schema_meta(key, value) VALUES('schema_version', '28')");
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
  `);
  return db;
}

const one = (db, sql: string) => db.exec(sql)[0]?.values[0]?.[0];
const col = (db, table: string, name: string) =>
  db.exec(`PRAGMA table_info(${table})`)[0].values.some((r) => r[1] === name);

describe('schema 迁移 v25 → v28（真实 sql.js）', () => {
  it('迁移整体可执行且版本号推进到 28', () => {
    const db = makeV25Db();
    expect(() => runMigrations(db)).not.toThrow();
    expect(one(db, "SELECT value FROM schema_meta WHERE key = 'schema_version'")).toBe('28');
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
