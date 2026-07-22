/**
 * 多供应商管理：支持添加多个 OpenAI 兼容 API 供应商（DeepSeek/OpenAI/Moonshot/Ollama 等），
 * 每个助手可独立选择供应商和模型（provider_id + model_override），未指定则用默认供应商。
 * API Key 经 safeStorage 加密存储（settings 表 secret:provider:{id}）。
 */
import { randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import type { Database } from './database.js';

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

export class ProviderManager {
  constructor(private db: Database) {}

  list(): Provider[] {
    return (this.db.raw.prepare('SELECT * FROM providers ORDER BY is_default DESC, created_at').all() as unknown as {
      id: string; name: string; base_url: string; model: string; api_key_ref: string; is_default: number; created_at: number;
    }[]).map((r) => ({
      id: r.id, name: r.name, baseUrl: r.base_url, model: r.model,
      isDefault: r.is_default === 1, hasKey: !!r.api_key_ref, createdAt: r.created_at
    }));
  }

  create(input: { name: string; baseUrl: string; model: string; apiKey?: string; isDefault?: boolean }): Provider {
    const id = `prov-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    if (input.isDefault) this.db.raw.prepare('UPDATE providers SET is_default = 0').run();
    const keyRef = input.apiKey ? `secret:provider:${id}` : '';
    if (input.apiKey && safeStorage.isEncryptionAvailable()) {
      this.db.setSetting(keyRef, safeStorage.encryptString(input.apiKey).toString('base64'));
    }
    this.db.raw.prepare('INSERT INTO providers(id, name, base_url, model, api_key_ref, is_default, created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, input.name, input.baseUrl.replace(/\/+$/, ''), input.model, keyRef, input.isDefault ? 1 : 0, now);
    return { id, name: input.name, baseUrl: input.baseUrl, model: input.model, isDefault: !!input.isDefault, hasKey: !!input.apiKey, createdAt: now };
  }

  update(id: string, patch: { name?: string; baseUrl?: string; model?: string; apiKey?: string; isDefault?: boolean }) {
    if (patch.isDefault) this.db.raw.prepare('UPDATE providers SET is_default = 0').run();
    const fields: string[] = [];
    const values: (string | number)[] = [];
    if (patch.name !== undefined) { fields.push('name = ?'); values.push(patch.name); }
    if (patch.baseUrl !== undefined) { fields.push('base_url = ?'); values.push(patch.baseUrl.replace(/\/+$/, '')); }
    if (patch.model !== undefined) { fields.push('model = ?'); values.push(patch.model); }
    if (patch.isDefault !== undefined) { fields.push('is_default = ?'); values.push(patch.isDefault ? 1 : 0); }
    if (patch.apiKey && safeStorage.isEncryptionAvailable()) {
      const ref = `secret:provider:${id}`;
      this.db.setSetting(ref, safeStorage.encryptString(patch.apiKey).toString('base64'));
      fields.push('api_key_ref = ?'); values.push(ref);
    }
    if (fields.length > 0) {
      values.push(id);
      this.db.raw.prepare(`UPDATE providers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }
  }

  remove(id: string) {
    this.db.raw.prepare('DELETE FROM providers WHERE id = ?').run(id);
    this.db.raw.prepare(`DELETE FROM settings WHERE key = ?`).run(`secret:provider:${id}`);
  }

  /** 解析助手实际使用的供应商（agent.provider_id > 默认供应商 > 旧 settings 兼容） */
  resolveForAgent(providerId: string | null, modelOverride: string | null): ResolvedProvider | null {
    // 按 provider_id 查找
    if (providerId) {
      const row = this.db.raw.prepare('SELECT * FROM providers WHERE id = ?').get(providerId) as { base_url: string; model: string; api_key_ref: string } | undefined;
      if (row) {
        const key = row.api_key_ref ? this.decryptKey(row.api_key_ref) : '';
        return { baseUrl: row.base_url, model: modelOverride || row.model, key };
      }
    }
    // 默认供应商
    const def = this.db.raw.prepare('SELECT * FROM providers WHERE is_default = 1 LIMIT 1').get() as { base_url: string; model: string; api_key_ref: string } | undefined;
    if (def) {
      const key = def.api_key_ref ? this.decryptKey(def.api_key_ref) : '';
      return { baseUrl: def.base_url, model: modelOverride || def.model, key };
    }
    return null;
  }

  private decryptKey(ref: string): string {
    const b64 = this.db.getSetting<string | null>(ref, null);
    if (!b64 || !safeStorage.isEncryptionAvailable()) return '';
    try { return safeStorage.decryptString(Buffer.from(b64, 'base64')); } catch { return ''; }
  }
}
