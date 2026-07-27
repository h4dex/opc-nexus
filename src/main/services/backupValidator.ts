/** AI Box 数据库备份校验，不依赖 Electron，便于恢复前独立验证。 */
import initSqlJs from 'sql.js';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const REQUIRED_TABLES = ['schema_meta', 'projects', 'agents', 'tasks', 'settings'];

export interface ValidatedBackup {
  data: Buffer;
  schemaVersion: number;
}

export async function validateDatabaseBackup(sourcePath: string, supportedVersion: number): Promise<ValidatedBackup> {
  const data = readFileSync(sourcePath);
  if (data.byteLength < 100 || data.byteLength > 2_000_000_000) throw new Error('备份文件大小异常');
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const candidate = new SQL.Database(new Uint8Array(data));
  try {
    const integrity = candidate.exec('PRAGMA integrity_check');
    const integrityValue = String(integrity[0]?.values[0]?.[0] ?? '');
    if (integrityValue !== 'ok') throw new Error(`数据库完整性检查失败：${integrityValue || '未知错误'}`);
    const tableRows = candidate.exec("SELECT name FROM sqlite_master WHERE type = 'table'");
    const tables = new Set((tableRows[0]?.values ?? []).map((row) => String(row[0])));
    const missing = REQUIRED_TABLES.filter((table) => !tables.has(table));
    if (missing.length > 0) throw new Error(`不是有效的 AI Box 备份，缺少：${missing.join('、')}`);
    const versionRows = candidate.exec("SELECT value FROM schema_meta WHERE key = 'schema_version'");
    const schemaVersion = Number(versionRows[0]?.values[0]?.[0] ?? 0);
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1) throw new Error('备份缺少有效的数据库版本');
    if (schemaVersion > supportedVersion) throw new Error(`备份版本 v${schemaVersion} 高于当前应用支持的 v${supportedVersion}`);
    return { data, schemaVersion };
  } finally {
    candidate.close();
  }
}
