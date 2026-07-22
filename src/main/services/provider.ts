/**
 * 模型供应商配置与凭据（Cherry Studio 式：Base URL/Model 存 settings，API Key 仅存 safeStorage）
 * 主进程内唯一读写供应商配置的入口；Renderer 只能拿到脱敏视图（hasKey）。
 */
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

export function getProviderSettings(db: Database): ProviderSettings {
  return db.getSetting<ProviderSettings>(PROVIDER_SETTING, DEFAULTS);
}

/** 读取并解密 API Key（仅主进程；Renderer 永远拿不到明文，15.1） */
export function readProviderKey(db: Database): string | null {
  const b64 = db.getSetting<string | null>(`secret:${PROVIDER_KEY_REF}`, null);
  if (!b64 || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'));
  } catch {
    return null;
  }
}

/** Hermes 就绪判定：baseUrl + model + 可解密的 Key 三者齐备 */
export function providerReady(db: Database): boolean {
  const c = getProviderSettings(db);
  return !!c.baseUrl && !!c.model && readProviderKey(db) !== null;
}

/** 脱敏视图：密钥是否存在，不回传明文 */
export function getProviderConfig(db: Database): ProviderConfig {
  const c = getProviderSettings(db);
  return {
    baseUrl: c.baseUrl,
    model: c.model,
    hasKey: db.getSetting<string | null>(`secret:${PROVIDER_KEY_REF}`, null) !== null
  };
}

/** 保存配置；apiKey 留空表示沿用已存密钥 */
export function saveProviderConfig(db: Database, input: { baseUrl: string; model: string; apiKey?: string }): void {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '') || DEFAULTS.baseUrl;
  const model = input.model.trim() || DEFAULTS.model;
  db.setSetting(PROVIDER_SETTING, { baseUrl, model });
  if (input.apiKey && input.apiKey.trim()) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥库不可用');
    db.setSetting(`secret:${PROVIDER_KEY_REF}`, safeStorage.encryptString(input.apiKey.trim()).toString('base64'));
  }
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
