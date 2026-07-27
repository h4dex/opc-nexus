/**
 * 模型供应商配置与凭据 — providers 表为唯一数据源（P0 修复）。
 * 历史上 Hermes 供应商配置存 settings（provider:hermes），设置页新版已改用 providers 表，
 * 两处数据源不一致导致「设置页配好供应商但引擎仍 SETUP_REQUIRED」。
 * 现统一：读取一律走 providers 表（默认供应商行），旧 settings 仅作只读兜底；
 * 写入一律落 providers 表；启动时 migrateLegacyProvider 把旧配置迁入 providers 表。
 * API Key 仍仅存 safeStorage（15.1），Renderer 只能拿到脱敏视图（hasKey）。
 */
import { randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import type { Database } from './database.js';
import type { ProviderConfig, ProviderTestResult } from '../../shared/types.js';

export const PROVIDER_SETTING = 'provider:hermes';
export const PROVIDER_KEY_REF = 'provider:hermes:key';

export interface ProviderSettings {
  baseUrl: string;
  model: string;
}

const DEFAULTS: ProviderSettings = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' };

interface ProviderRow {
  id: string;
  base_url: string;
  model: string;
  api_key_ref: string;
}

/** 默认供应商行：is_default=1 优先，否则最早创建的一行 */
function defaultProviderRow(db: Database): ProviderRow | undefined {
  return (db.raw.prepare('SELECT * FROM providers WHERE is_default = 1 LIMIT 1').get() as ProviderRow | undefined)
    ?? (db.raw.prepare('SELECT * FROM providers ORDER BY created_at LIMIT 1').get() as ProviderRow | undefined);
}

function decryptRef(db: Database, ref: string): string | null {
  const b64 = db.getSetting<string | null>(ref, null);
  if (!b64 || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'));
  } catch {
    return null;
  }
}

/** 启动迁移：providers 表为空且旧 settings 配置完整 → 迁入 providers 表（密钥引用原位复用，不重复存储） */
export function migrateLegacyProvider(db: Database): boolean {
  const count = (db.raw.prepare('SELECT COUNT(*) c FROM providers').get() as { c: number }).c;
  if (count > 0) return false;
  const legacy = db.getSetting<ProviderSettings | null>(PROVIDER_SETTING, null);
  const hasKey = db.getSetting<string | null>(`secret:${PROVIDER_KEY_REF}`, null) !== null;
  if (!legacy?.baseUrl || !legacy.model || !hasKey) return false;
  db.raw.prepare('INSERT INTO providers(id, name, base_url, model, api_key_ref, is_default, created_at) VALUES(?,?,?,?,?,1,?)')
    .run(`prov-${randomUUID().slice(0, 8)}`, '默认供应商（迁移）', legacy.baseUrl.replace(/\/+$/, ''), legacy.model, `secret:${PROVIDER_KEY_REF}`, Date.now());
  db.audit({ id: randomUUID(), actor: 'system', action: 'provider.migrateLegacy', target: legacy.baseUrl, result: 'ok' });
  return true;
}

/** 读取生效配置：providers 表默认行 → 旧 settings 兜底 → 内置默认 */
export function getProviderSettings(db: Database): ProviderSettings {
  const row = defaultProviderRow(db);
  if (row) return { baseUrl: row.base_url, model: row.model };
  return db.getSetting<ProviderSettings>(PROVIDER_SETTING, DEFAULTS);
}

/** 读取并解密生效 API Key（仅主进程；Renderer 永远拿不到明文，15.1） */
export function readProviderKey(db: Database): string | null {
  const row = defaultProviderRow(db);
  if (row) return row.api_key_ref ? decryptRef(db, row.api_key_ref) : null;
  return decryptRef(db, `secret:${PROVIDER_KEY_REF}`);
}

/** 内置引擎（Nexus Agent）就绪判定：baseUrl + model + 可解密的 Key 三者齐备 */
export function providerReady(db: Database): boolean {
  const c = getProviderSettings(db);
  return !!c.baseUrl && !!c.model && readProviderKey(db) !== null;
}

/** 脱敏视图：密钥是否存在，不回传明文 */
export function getProviderConfig(db: Database): ProviderConfig {
  const row = defaultProviderRow(db);
  if (row) return { baseUrl: row.base_url, model: row.model, hasKey: !!row.api_key_ref && db.getSetting<string | null>(row.api_key_ref, null) !== null };
  const c = db.getSetting<ProviderSettings>(PROVIDER_SETTING, DEFAULTS);
  return { baseUrl: c.baseUrl, model: c.model, hasKey: db.getSetting<string | null>(`secret:${PROVIDER_KEY_REF}`, null) !== null };
}

/** 保存配置：写穿 providers 表（默认行 upsert）；apiKey 留空表示沿用已存密钥 */
export function saveProviderConfig(db: Database, input: { baseUrl: string; model: string; apiKey?: string }): void {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '') || DEFAULTS.baseUrl;
  const model = input.model.trim() || DEFAULTS.model;
  const key = input.apiKey?.trim();
  if (key && !safeStorage.isEncryptionAvailable()) throw new Error('系统密钥库不可用');

  const row = defaultProviderRow(db);
  if (row) {
    db.raw.prepare('UPDATE providers SET base_url = ?, model = ?, is_default = 1 WHERE id = ?').run(baseUrl, model, row.id);
    if (key) {
      const ref = row.api_key_ref || `secret:provider:${row.id}`;
      db.setSetting(ref, safeStorage.encryptString(key).toString('base64'));
      if (!row.api_key_ref) db.raw.prepare('UPDATE providers SET api_key_ref = ? WHERE id = ?').run(ref, row.id);
    }
    return;
  }
  const id = `prov-${randomUUID().slice(0, 8)}`;
  const ref = key ? `secret:provider:${id}` : '';
  if (key) db.setSetting(ref, safeStorage.encryptString(key).toString('base64'));
  db.raw.prepare('INSERT INTO providers(id, name, base_url, model, api_key_ref, is_default, created_at) VALUES(?,?,?,?,?,1,?)')
    .run(id, '默认供应商', baseUrl, model, ref, Date.now());
}

/** 测试连接：GET {baseUrl}/models 带 Authorization（15s 超时），如实返回延迟与错误 */
export async function testProvider(db: Database, override?: { baseUrl?: string; apiKey?: string }): Promise<ProviderTestResult> {
  const baseUrl = (override?.baseUrl?.trim() || getProviderSettings(db).baseUrl).replace(/\/+$/, '');
  const key = override?.apiKey?.trim() || readProviderKey(db);
  if (!key) return { ok: false, latencyMs: 0, error: '请先填写 API Key' };
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const res = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: ctrl.signal });
    clearTimeout(timer);
    const latencyMs = Date.now() - started;
    if (res.ok) return { ok: true, latencyMs, error: null };
    const body = await res.text().catch(() => '');
    return { ok: false, latencyMs, error: `HTTP ${res.status}：${body.slice(0, 160)}` };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}
