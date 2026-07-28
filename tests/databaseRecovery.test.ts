/**
 * 数据库损坏容错与原子落盘测试
 *
 * 背景：真机启动时发现 aibox.db 变成 41MB 全零文件，应用直接崩溃且无自救手段。
 * 成因是 flush() 用 writeFileSync 就地覆盖 live 库——进程在写入中途被杀即留下截断/全零文件；
 * 而启动路径没有任何容错，sql.js 抛 "file is not a database" 后整个应用打不开。
 *
 * 这两个行为都必须有回归测试锁死。
 *
 * @author liyingjie <y@senke.com>
 */
// @ts-nocheck
/* eslint-disable */
import { describe, expect, it, beforeAll } from 'vitest';
import initSqlJs from 'sql.js';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
let SQL;
beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
});

const MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

/** 复刻 database.ts openOrRecover 的判定逻辑 */
function openOrRecover(sourceFile: string) {
  if (!existsSync(sourceFile)) return { db: new SQL.Database(), recovered: false };
  try {
    const bytes = readFileSync(sourceFile);
    if (bytes.length === 0) throw new Error('数据库文件为空');
    if (bytes.length < MAGIC.length || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('缺少 SQLite 文件头，内容已损坏');
    }
    const db = new SQL.Database(new Uint8Array(bytes));
    db.exec('PRAGMA quick_check');
    return { db, recovered: false };
  } catch {
    renameSync(sourceFile, `${sourceFile}.corrupt-${Date.now()}`);
    return { db: new SQL.Database(), recovered: true };
  }
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'aibox-db-test-'));
}

function validDbBytes() {
  const db = new SQL.Database();
  db.exec('CREATE TABLE t(x TEXT); INSERT INTO t VALUES(\'real-data\')');
  return Buffer.from(db.export());
}

describe('数据库损坏容错', () => {
  it('全零文件（实际发生过的损坏形态）不导致启动崩溃', () => {
    const dir = tmpDir();
    const file = join(dir, 'aibox.db');
    writeFileSync(file, Buffer.alloc(4096)); // 41MB 全零的最小复现
    const { db, recovered } = openOrRecover(file);
    expect(recovered).toBe(true);
    expect(() => db.exec('CREATE TABLE ok(x)')).not.toThrow();
  });

  it('损坏文件被留存而非删除（保留事后取证/人工抢救的可能）', () => {
    const dir = tmpDir();
    const file = join(dir, 'aibox.db');
    writeFileSync(file, Buffer.alloc(1024));
    openOrRecover(file);
    expect(existsSync(file)).toBe(false); // 原路径让位给新库
    expect(readdirSync(dir).some((f) => f.includes('.corrupt-'))).toBe(true);
  });

  it('空文件同样被识别为损坏', () => {
    const dir = tmpDir();
    const file = join(dir, 'aibox.db');
    writeFileSync(file, Buffer.alloc(0));
    expect(openOrRecover(file).recovered).toBe(true);
  });

  it('截断的文件（写到一半被杀）被识别为损坏', () => {
    const dir = tmpDir();
    const file = join(dir, 'aibox.db');
    writeFileSync(file, validDbBytes().subarray(0, 8)); // 连魔数都不完整
    expect(openOrRecover(file).recovered).toBe(true);
  });

  it('合法数据库正常打开，数据完好', () => {
    const dir = tmpDir();
    const file = join(dir, 'aibox.db');
    writeFileSync(file, validDbBytes());
    const { db, recovered } = openOrRecover(file);
    expect(recovered).toBe(false);
    expect(db.exec("SELECT x FROM t")[0].values[0][0]).toBe('real-data');
  });

  it('文件不存在时以空库启动（全新安装）', () => {
    const { recovered } = openOrRecover(join(tmpDir(), 'nonexistent.db'));
    expect(recovered).toBe(false);
  });
});

describe('原子落盘', () => {
  /** 复刻 flush() 的原子写：临时文件 → rename */
  const atomicWrite = (file: string, data: Buffer) => {
    if (data.length === 0) return false; // 空导出不覆盖既有数据
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, file);
    return true;
  };

  it('写入后不留临时文件', () => {
    const dir = tmpDir();
    const file = join(dir, 'aibox.db');
    atomicWrite(file, validDbBytes());
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('空导出被拒绝，不覆盖既有数据库（防止把好库写成空文件）', () => {
    const dir = tmpDir();
    const file = join(dir, 'aibox.db');
    const original = validDbBytes();
    writeFileSync(file, original);
    expect(atomicWrite(file, Buffer.alloc(0))).toBe(false);
    expect(readFileSync(file).equals(original)).toBe(true);
  });

  it('覆盖写入后文件仍是合法数据库', () => {
    const dir = tmpDir();
    const file = join(dir, 'aibox.db');
    writeFileSync(file, validDbBytes());
    atomicWrite(file, validDbBytes());
    expect(openOrRecover(file).recovered).toBe(false);
  });
});
