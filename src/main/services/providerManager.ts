/** Main-process management for OpenAI-compatible model Providers. */
import { randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import type { Database } from './database.js';
import { PROVIDER_KEY_REF, PROVIDER_SETTING } from './provider.js';
import {
  normalizeProviderBaseUrl,
  providerOriginsMatch,
  providerResourceUrl,
  tryNormalizeProviderBaseUrl
} from './providerEndpoint.js';

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  isDefault: boolean;
  hasKey: boolean;
  createdAt: number;
}

export interface ResolvedProvider {
  baseUrl: string;
  model: string;
  key: string;
}

interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  model: string;
  api_key_ref: string;
  is_default: number;
  created_at: number;
}

export class ProviderManager {
  constructor(private db: Database, private onRuntimeConfigChanged: () => void = () => {}) {}

  list(): Provider[] {
    return (this.db.raw.prepare('SELECT * FROM providers ORDER BY is_default DESC, created_at').all() as unknown as ProviderRow[])
      .map((row) => ({
        id: row.id,
        name: row.name,
        baseUrl: row.base_url,
        model: row.model,
        isDefault: row.is_default === 1,
        hasKey: tryNormalizeProviderBaseUrl(row.base_url) !== null
          && !!(row.api_key_ref ? this.decryptKey(row.api_key_ref).trim() : ''),
        createdAt: row.created_at
      }));
  }

  create(input: { name: string; baseUrl: string; model: string; apiKey?: string; isDefault?: boolean }): Provider {
    const id = `prov-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const name = input.name.trim();
    const baseUrl = normalizeProviderBaseUrl(input.baseUrl);
    const model = input.model.trim();
    const key = input.apiKey?.trim() ?? '';
    if (!name || !baseUrl || !model) throw new Error('供应商名称、Base URL 和模型不能为空');
    if (key && !safeStorage.isEncryptionAvailable()) throw new Error('系统密钥库不可用');

    const count = (this.db.raw.prepare('SELECT COUNT(*) c FROM providers').get() as { c: number }).c;
    const isDefault = count === 0 || input.isDefault === true;
    const keyRef = key ? `secret:provider:${id}` : '';
    const encryptedKey = key ? safeStorage.encryptString(key).toString('base64') : null;

    this.db.transaction(() => {
      if (encryptedKey) this.db.setSetting(keyRef, encryptedKey);
      if (isDefault) this.db.raw.prepare('UPDATE providers SET is_default = 0').run();
      this.db.raw.prepare('INSERT INTO providers(id, name, base_url, model, api_key_ref, is_default, created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id, name, baseUrl, model, keyRef, isDefault ? 1 : 0, now);
      this.audit('provider.create', id, isDefault ? 'default' : 'ok');
      if (encryptedKey) this.audit('provider.secret.store', id, 'ok');
    });
    this.onRuntimeConfigChanged();

    return { id, name, baseUrl, model, isDefault, hasKey: !!key, createdAt: now };
  }

  update(id: string, patch: { name?: string; baseUrl?: string; model?: string; apiKey?: string; isDefault?: boolean }): void {
    const existing = this.db.raw.prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow | undefined;
    if (!existing) throw new Error('供应商不存在');

    const fields: string[] = [];
    const values: (string | number)[] = [];
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new Error('供应商名称不能为空');
      fields.push('name = ?');
      values.push(name);
    }
    if (patch.baseUrl !== undefined) {
      const baseUrl = normalizeProviderBaseUrl(patch.baseUrl);
      fields.push('base_url = ?');
      values.push(baseUrl);
    }
    if (patch.model !== undefined) {
      const model = patch.model.trim();
      if (!model) throw new Error('供应商模型不能为空');
      fields.push('model = ?');
      values.push(model);
    }

    const successor = patch.isDefault === false && existing.is_default === 1
      ? this.db.raw.prepare('SELECT id FROM providers WHERE id != ? ORDER BY created_at LIMIT 1').get(id) as { id: string } | undefined
      : undefined;
    const effectiveDefault = patch.isDefault === true
      ? true
      : patch.isDefault === false
        ? (existing.is_default === 1 && !successor)
        : undefined;
    if (effectiveDefault !== undefined) {
      fields.push('is_default = ?');
      values.push(effectiveDefault ? 1 : 0);
    }

    const key = patch.apiKey?.trim() ?? '';
    const nextBaseUrl = patch.baseUrl === undefined ? existing.base_url : normalizeProviderBaseUrl(patch.baseUrl);
    const originChanged = patch.baseUrl !== undefined && !providerOriginsMatch(existing.base_url, nextBaseUrl);
    if (originChanged && !key) throw new Error('Changing Provider origin requires a new API Key');
    if (key && !safeStorage.isEncryptionAvailable()) throw new Error('系统密钥库不可用');
    const encryptedKey = key ? safeStorage.encryptString(key).toString('base64') : null;
    const keyRef = key
      ? (originChanged ? `secret:provider:${id}:${randomUUID()}` : (existing.api_key_ref || `secret:provider:${id}`))
      : '';
    if (key) {
      fields.push('api_key_ref = ?');
      values.push(keyRef);
    }
    if (fields.length === 0) return;

    values.push(id);
    const runtimeConfigChanged = patch.baseUrl !== undefined || patch.model !== undefined
      || patch.apiKey !== undefined || patch.isDefault !== undefined;
    this.db.transaction(() => {
      if (encryptedKey) this.db.setSetting(keyRef, encryptedKey);
      if (effectiveDefault === true) this.db.raw.prepare('UPDATE providers SET is_default = 0').run();
      this.db.raw.prepare(`UPDATE providers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      if (successor) this.db.raw.prepare('UPDATE providers SET is_default = 1 WHERE id = ?').run(successor.id);
      if (originChanged && existing.api_key_ref && existing.api_key_ref !== keyRef) {
        const shared = this.db.raw.prepare('SELECT COUNT(*) c FROM providers WHERE api_key_ref = ?').get(existing.api_key_ref) as { c: number };
        if (shared.c === 0) {
          this.db.raw.prepare('DELETE FROM settings WHERE key = ?').run(existing.api_key_ref);
          if (existing.api_key_ref === `secret:${PROVIDER_KEY_REF}`) {
            this.db.raw.prepare('DELETE FROM settings WHERE key = ?').run(PROVIDER_SETTING);
          }
          this.audit('provider.secret.delete', id, 'rotated');
        }
      }
      this.audit('provider.update', id, 'ok');
      if (encryptedKey) this.audit('provider.secret.store', id, 'replaced');
    });
    if (runtimeConfigChanged) this.onRuntimeConfigChanged();
  }

  remove(id: string): void {
    const existing = this.db.raw.prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow | undefined;
    if (!existing) throw new Error('供应商不存在');

    this.db.transaction(() => {
      this.db.raw.prepare('UPDATE agents SET provider_id = NULL WHERE provider_id = ?').run(id);
      this.db.raw.prepare('DELETE FROM providers WHERE id = ?').run(id);
      if (existing.is_default === 1) {
        const successor = this.db.raw.prepare('SELECT id FROM providers ORDER BY created_at LIMIT 1').get() as { id: string } | undefined;
        if (successor) this.db.raw.prepare('UPDATE providers SET is_default = 1 WHERE id = ?').run(successor.id);
      }

      if (existing.api_key_ref) {
        const shared = this.db.raw.prepare('SELECT COUNT(*) c FROM providers WHERE api_key_ref = ?').get(existing.api_key_ref) as { c: number };
        if (shared.c === 0) this.db.raw.prepare('DELETE FROM settings WHERE key = ?').run(existing.api_key_ref);
        if (existing.api_key_ref === `secret:${PROVIDER_KEY_REF}`) {
          this.db.raw.prepare('DELETE FROM settings WHERE key = ?').run(PROVIDER_SETTING);
        }
        this.audit('provider.secret.delete', id, 'ok');
      }
      this.audit('provider.remove', id, 'ok');
    });
    this.onRuntimeConfigChanged();
  }

  /** Resolve Agent binding, then the default Provider. Explicit bindings fail closed. */
  resolveForAgent(providerId: string | null, modelOverride: string | null): ResolvedProvider | null {
    if (providerId) {
      const row = this.db.raw.prepare('SELECT * FROM providers WHERE id = ?').get(providerId) as ProviderRow | undefined;
      return row ? this.resolveRow(row, modelOverride) : null;
    }
    const row = (this.db.raw.prepare('SELECT * FROM providers WHERE is_default = 1 LIMIT 1').get() as ProviderRow | undefined)
      ?? (this.db.raw.prepare('SELECT * FROM providers ORDER BY created_at LIMIT 1').get() as ProviderRow | undefined);
    return row ? this.resolveRow(row, modelOverride) : null;
  }

  private resolveRow(row: ProviderRow, modelOverride: string | null): ResolvedProvider | null {
    const baseUrl = tryNormalizeProviderBaseUrl(row.base_url);
    const model = (modelOverride || row.model).trim();
    const key = row.api_key_ref ? this.decryptKey(row.api_key_ref).trim() : '';
    return baseUrl && model && key ? { baseUrl, model, key } : null;
  }

  private decryptKey(ref: string): string {
    const b64 = this.db.getSetting<string | null>(ref, null);
    if (!b64 || !safeStorage.isEncryptionAvailable()) return '';
    try {
      return safeStorage.decryptString(Buffer.from(b64, 'base64'));
    } catch {
      return '';
    }
  }

  private audit(action: string, target: string, result: string): void {
    this.db.audit({ id: randomUUID(), actor: 'admin', action, target, result });
  }

  async testById(id: string): Promise<{ ok: boolean; latencyMs: number; error: string | null }> {
    const row = this.db.raw.prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow | undefined;
    if (!row) return { ok: false, latencyMs: 0, error: '供应商不存在' };
    const key = row.api_key_ref ? this.decryptKey(row.api_key_ref).trim() : '';
    const baseUrl = tryNormalizeProviderBaseUrl(row.base_url);
    if (!baseUrl || !row.model.trim()) return { ok: false, latencyMs: 0, error: '供应商 Base URL 或模型未配置' };
    if (!key) return { ok: false, latencyMs: 0, error: '该供应商未配置 API Key' };
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

  async fetchModels(id: string): Promise<{ ok: boolean; models: string[]; error?: string }> {
    const row = this.db.raw.prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow | undefined;
    if (!row) return { ok: false, models: [], error: '供应商不存在' };
    const key = row.api_key_ref ? this.decryptKey(row.api_key_ref).trim() : '';
    const baseUrl = tryNormalizeProviderBaseUrl(row.base_url);
    if (!baseUrl) return { ok: false, models: [], error: '未配置 Base URL' };
    if (!key) return { ok: false, models: [], error: '未配置 API Key' };
    try {
      const res = await fetch(providerResourceUrl(baseUrl, 'models'), {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
        redirect: 'error'
      });
      if (!res.ok) return { ok: false, models: [], error: `HTTP ${res.status}` };
      const data = await res.json() as { data?: { id: string }[] };
      return { ok: true, models: (data.data ?? []).map((model) => model.id).sort() };
    } catch (err) {
      return { ok: false, models: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  resolveByModel(model: string): ResolvedProvider | null {
    const providers = this.db.raw.prepare('SELECT * FROM providers').all() as unknown as ProviderRow[];
    const match = providers.find((provider) => provider.model === model);
    return match ? this.resolveRow(match, null) : this.resolveForAgent(null, model);
  }
}
