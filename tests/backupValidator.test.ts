import { afterEach, describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, writeFileSync } from 'node:fs';
import { validateDatabaseBackup } from '../src/main/services/backupValidator.js';

const require = createRequire(import.meta.url);
const files: string[] = [];

async function backup(version: number, includeCoreTables = true): Promise<string> {
  const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
  const db = new SQL.Database();
  db.exec("CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES('schema_version', '" + version + "');");
  if (includeCoreTables) db.exec('CREATE TABLE projects(id TEXT); CREATE TABLE agents(id TEXT); CREATE TABLE tasks(id TEXT); CREATE TABLE settings(key TEXT);');
  const path = join(tmpdir(), `aibox-backup-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  writeFileSync(path, Buffer.from(db.export())); db.close(); files.push(path); return path;
}

afterEach(() => { while (files.length) rmSync(files.pop()!, { force: true }); });

describe('数据库备份恢复校验', () => {
  it('接受完整且版本兼容的 AI Box 备份', async () => {
    const path = await backup(24);
    const result = await validateDatabaseBackup(path, 25);
    expect(result.schemaVersion).toBe(24);
    expect(result.data.byteLength).toBeGreaterThan(100);
  });

  it('拒绝缺少核心表的 SQLite 文件', async () => {
    const path = await backup(24, false);
    await expect(validateDatabaseBackup(path, 25)).rejects.toThrow('缺少');
  });

  it('拒绝高于当前应用的备份版本', async () => {
    const path = await backup(26);
    await expect(validateDatabaseBackup(path, 25)).rejects.toThrow('高于当前应用');
  });
});
