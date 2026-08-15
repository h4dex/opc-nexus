/**
 * 模型供应商配置与凭据 — providers 表为唯一数据源（P0 修复）。
 * 历史上内置 Nexus 被误称为 Hermes，供应商配置因此存入 provider:hermes。
 * v39 已将该兼容键迁移为 provider:nexus；设置页新版使用 providers 表，
 * 两处数据源不一致导致「设置页配好供应商但引擎仍 SETUP_REQUIRED」。
 * 现统一：读取一律走 providers 表（默认供应商行），旧 settings 仅作只读兜底；
 * 写入一律落 providers 表；启动时 migrateLegacyProvider 把旧配置迁入 providers 表。
 * API Key 仍仅存 safeStorage（15.1），Renderer 只能拿到脱敏视图（hasKey）。
 */
import { randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import type { Database } from './database.js';
import type { ProviderConfig, ProviderTestResult } from '../../shared/types.js';
import {
  normalizeProviderBaseUrl,
  providerOriginsMatch,
  providerResourceUrl,
  tryNormalizeProviderBaseUrl
} from './providerEndpoint.js';

export const PROVIDER_SETTING = 'provider:nexus';
export const PROVIDER_KEY_REF = 'provider:nexus:key';
export const LEGACY_PROVIDER_SETTING = 'provider:hermes';
export const LEGACY_PROVIDER_KEY_REF = 'provider:hermes:key';

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

function providerCount(db: Database): number {
  return (db.raw.prepare('SELECT COUNT(*) c FROM providers').get() as { c?: number } | undefined)?.c ?? 0;
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
  const baseUrl = tryNormalizeProviderBaseUrl(legacy.baseUrl);
  const model = legacy.model.trim();
  if (!baseUrl || !model) return false;
  db.raw.prepare('INSERT INTO providers(id, name, base_url, model, api_key_ref, is_default, created_at) VALUES(?,?,?,?,?,1,?)')
    .run(`prov-${randomUUID().slice(0, 8)}`, '默认供应商（迁移）', baseUrl, model, `secret:${PROVIDER_KEY_REF}`, Date.now());
  db.audit({ id: randomUUID(), actor: 'system', action: 'provider.migrateLegacy', target: baseUrl, result: 'ok' });
  return true;
}

/** 读取生效配置：providers 表默认行 → 旧 settings 兜底 → 内置默认 */
export function getProviderSettings(db: Database): ProviderSettings {
  const row = defaultProviderRow(db);
  if (row) return { baseUrl: row.base_url, model: row.model };
  if (providerCount(db) > 0) return { baseUrl: '', model: '' };
  return db.getSetting<ProviderSettings>(PROVIDER_SETTING, DEFAULTS);
}

/** 读取并解密生效 API Key（仅主进程；Renderer 永远拿不到明文，15.1） */
export function readProviderKey(db: Database): string | null {
  const row = defaultProviderRow(db);
  if (row) {
    if (!tryNormalizeProviderBaseUrl(row.base_url) || !row.model.trim()) return null;
    return (row.api_key_ref ? decryptRef(db, row.api_key_ref) : null)?.trim() || null;
  }
  if (providerCount(db) > 0) return null;
  const legacy = db.getSetting<ProviderSettings | null>(PROVIDER_SETTING, null);
  if (!legacy || !tryNormalizeProviderBaseUrl(legacy.baseUrl) || !legacy.model.trim()) return null;
  const key = decryptRef(db, `secret:${PROVIDER_KEY_REF}`);
  return key?.trim() || null;
}

/** 内置引擎（Nexus Agent）就绪判定：baseUrl + model + 可解密的 Key 三者齐备 */
export function providerReady(db: Database): boolean {
  const c = getProviderSettings(db);
  return tryNormalizeProviderBaseUrl(c.baseUrl) !== null && !!c.model.trim() && readProviderKey(db) !== null;
}

/** 脱敏视图：密钥是否存在，不回传明文 */
export function getProviderConfig(db: Database): ProviderConfig {
  const row = defaultProviderRow(db);
  if (row) return { baseUrl: row.base_url, model: row.model, hasKey: readProviderKey(db) !== null };
  if (providerCount(db) > 0) return { baseUrl: '', model: '', hasKey: false };
  const c = db.getSetting<ProviderSettings>(PROVIDER_SETTING, DEFAULTS);
  return { baseUrl: c.baseUrl, model: c.model, hasKey: readProviderKey(db) !== null };
}

/** 保存配置：写穿 providers 表（默认行 upsert）；apiKey 留空表示沿用已存密钥 */
export function saveProviderConfig(db: Database, input: { baseUrl: string; model: string; apiKey?: string }): void {
  const baseUrl = normalizeProviderBaseUrl(input.baseUrl);
  const model = input.model.trim() || DEFAULTS.model;
  const key = input.apiKey?.trim();
  if (key && !safeStorage.isEncryptionAvailable()) throw new Error('系统密钥库不可用');
  const encryptedKey = key ? safeStorage.encryptString(key).toString('base64') : null;

  const row = defaultProviderRow(db);
  if (row) {
    const originChanged = !providerOriginsMatch(row.base_url, baseUrl);
    if (originChanged && !key) throw new Error('Changing Provider origin requires a new API Key');
    const ref = encryptedKey
      ? (originChanged ? `secret:provider:${row.id}:${randomUUID()}` : (row.api_key_ref || `secret:provider:${row.id}`))
      : '';
    db.transaction(() => {
      db.raw.prepare('UPDATE providers SET base_url = ?, model = ?, is_default = 1 WHERE id = ?').run(baseUrl, model, row.id);
      if (encryptedKey) {
        db.setSetting(ref, encryptedKey);
        if (!row.api_key_ref || originChanged) db.raw.prepare('UPDATE providers SET api_key_ref = ? WHERE id = ?').run(ref, row.id);
        if (originChanged && row.api_key_ref && row.api_key_ref !== ref) {
          const shared = db.raw.prepare('SELECT COUNT(*) c FROM providers WHERE api_key_ref = ?').get(row.api_key_ref) as { c: number };
          if (shared.c === 0) {
            db.raw.prepare('DELETE FROM settings WHERE key = ?').run(row.api_key_ref);
            if (row.api_key_ref === `secret:${PROVIDER_KEY_REF}`) {
              db.raw.prepare('DELETE FROM settings WHERE key = ?').run(PROVIDER_SETTING);
            }
            db.audit({
              id: randomUUID(), actor: 'admin', action: 'provider.secret.delete', target: row.id, result: 'rotated'
            });
          }
        }
        db.audit({
          id: randomUUID(), actor: 'admin', action: 'provider.secret.store', target: row.id,
          result: row.api_key_ref ? 'replaced' : 'ok'
        });
      }
    });
    return;
  }
  const id = `prov-${randomUUID().slice(0, 8)}`;
  const legacyRef = `secret:${PROVIDER_KEY_REF}`;
  const legacy = db.getSetting<ProviderSettings | null>(PROVIDER_SETTING, null);
  const hasLegacyKey = db.getSetting<string | null>(legacyRef, null) !== null;
  const reusableLegacyKey = hasLegacyKey
    && legacy !== null
    && !!legacy.model.trim()
    && providerOriginsMatch(legacy.baseUrl, baseUrl);
  const legacyOriginChanged = hasLegacyKey && !reusableLegacyKey;
  if (legacyOriginChanged && !key) throw new Error('Changing Provider origin requires a new API Key');
  const ref = encryptedKey
    ? (reusableLegacyKey ? legacyRef : `secret:provider:${id}`)
    : (reusableLegacyKey ? legacyRef : '');
  db.transaction(() => {
    if (encryptedKey) db.setSetting(ref, encryptedKey);
    db.raw.prepare('INSERT INTO providers(id, name, base_url, model, api_key_ref, is_default, created_at) VALUES(?,?,?,?,?,1,?)')
      .run(id, '默认供应商', baseUrl, model, ref, Date.now());
    if (legacyOriginChanged) {
      db.raw.prepare('DELETE FROM settings WHERE key = ?').run(legacyRef);
      db.raw.prepare('DELETE FROM settings WHERE key = ?').run(PROVIDER_SETTING);
      db.audit({ id: randomUUID(), actor: 'admin', action: 'provider.secret.delete', target: id, result: 'rotated' });
    }
    if (encryptedKey) {
      db.audit({ id: randomUUID(), actor: 'admin', action: 'provider.secret.store', target: id, result: 'ok' });
    }
  });
}

/** 测试连接：GET {baseUrl}/models 带 Authorization（15s 超时），如实返回延迟与错误 */
export async function testProvider(db: Database, override?: { baseUrl?: string; apiKey?: string }): Promise<ProviderTestResult> {
  const configuredBaseUrl = getProviderSettings(db).baseUrl;
  const candidateBaseUrl = override?.baseUrl === undefined ? configuredBaseUrl : override.baseUrl;
  const baseUrl = tryNormalizeProviderBaseUrl(candidateBaseUrl);
  if (!baseUrl) return { ok: false, latencyMs: 0, error: 'Invalid Provider Base URL' };
  const overrideKey = override?.apiKey?.trim() || null;
  if (override?.baseUrl && !overrideKey && !providerOriginsMatch(configuredBaseUrl, baseUrl)) {
    return { ok: false, latencyMs: 0, error: 'Testing a different Provider origin requires an API Key' };
  }
  const key = overrideKey || readProviderKey(db);
  if (!key) return { ok: false, latencyMs: 0, error: '请先填写 API Key' };
  const started = Date.now();
  try {
    const res = await fetch(providerResourceUrl(baseUrl, 'models'), {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
      redirect: 'error'
    });
    const latencyMs = Date.now() - started;
    if (res.ok) return { ok: true, latencyMs, error: null };
    return { ok: false, latencyMs, error: `HTTP ${res.status}` };
  } catch {
    return { ok: false, latencyMs: Date.now() - started, error: 'Provider connection failed' };
  }
}
