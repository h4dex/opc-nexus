/**
 * 外部工作流平台凭据管理（Coze / Dify）：
 * - 平台元数据（id/name/baseUrl）存 settings 表 `wf_platforms` JSON 数组
 * - Token 经 safeStorage 加密存 settings 表 `secret:platform:{id}`
 * - Renderer 仅可见脱敏视图（hasToken），不可读取明文
 */
import { randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import type { Database } from './database.js';
import type { WfPlatformConfig } from '../../shared/types.js';

interface PlatformMeta {
  id: string;
  name: string;
  baseUrl: string;
}

export class WfPlatformManager {
  constructor(private db: Database) {}

  /** 列出已配置平台（脱敏：仅返回 hasToken 布尔） */
  list(): WfPlatformConfig[] {
    const metas = this.db.getSetting<PlatformMeta[]>('wf_platforms', []);
    return metas.map((m) => ({
      id: m.id,
      name: m.name,
      baseUrl: m.baseUrl,
      hasToken: this.db.getSetting<string | null>(`secret:platform:${m.id}`, null) !== null
    }));
  }

  /** 保存/更新平台凭据 */
  save(input: { id?: string; name: string; baseUrl: string; token?: string }): WfPlatformConfig {
    const metas = this.db.getSetting<PlatformMeta[]>('wf_platforms', []);
    const id = input.id ?? `plat-${randomUUID().slice(0, 8)}`;
    const existing = metas.findIndex((m) => m.id === id);
    const meta: PlatformMeta = { id, name: input.name, baseUrl: input.baseUrl.replace(/\/+$/, '') };

    if (existing >= 0) metas[existing] = meta;
    else metas.push(meta);
    this.db.setSetting('wf_platforms', metas);

    if (input.token && safeStorage.isEncryptionAvailable()) {
      this.db.setSetting(`secret:platform:${id}`, safeStorage.encryptString(input.token).toString('base64'));
    }

    return { id, name: meta.name, baseUrl: meta.baseUrl, hasToken: !!input.token || this.hasToken(id) };
  }

  /** 删除平台 */
  remove(id: string) {
    const metas = this.db.getSetting<PlatformMeta[]>('wf_platforms', []);
    this.db.setSetting('wf_platforms', metas.filter((m) => m.id !== id));
    // 清除密钥（settings 表）
    this.db.raw.prepare('DELETE FROM settings WHERE key = ?').run(`secret:platform:${id}`);
  }

  /** 测试平台连通性 */
  async test(id: string): Promise<{ ok: boolean; message: string }> {
    const meta = this.db.getSetting<PlatformMeta[]>('wf_platforms', []).find((m) => m.id === id);
    if (!meta) return { ok: false, message: '平台不存在' };
    const token = this.decryptToken(id);
    if (!token) return { ok: false, message: '未配置 Token' };

    try {
      if (meta.baseUrl.includes('coze')) {
        // Coze: 尝试获取空间信息验证 Token
        const res = await fetch(`${meta.baseUrl}/v1/workspaces`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
          redirect: 'error'
        });
        if (res.ok) return { ok: true, message: 'Coze 连接成功' };
        return { ok: false, message: `Coze 返回 HTTP ${res.status}` };
      } else {
        // Dify: GET /info
        const res = await fetch(`${meta.baseUrl}/v1/info`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
          redirect: 'error'
        });
        if (res.ok) {
          const data = await res.json() as { name?: string };
          return { ok: true, message: `Dify 连接成功（应用: ${data.name ?? '未知'}）` };
        }
        return { ok: false, message: `Dify 返回 HTTP ${res.status}` };
      }
    } catch (err) {
      return { ok: false, message: `连接失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** 主进程内部：解密 Token 供执行器使用 */
  decryptToken(id: string): string | null {
    const b64 = this.db.getSetting<string | null>(`secret:platform:${id}`, null);
    if (!b64 || !safeStorage.isEncryptionAvailable()) return null;
    try { return safeStorage.decryptString(Buffer.from(b64, 'base64')); } catch { return null; }
  }

  /** 获取平台元数据 */
  getMeta(id: string): PlatformMeta | null {
    return this.db.getSetting<PlatformMeta[]>('wf_platforms', []).find((m) => m.id === id) ?? null;
  }

  private hasToken(id: string): boolean {
    return this.db.getSetting<string | null>(`secret:platform:${id}`, null) !== null;
  }
}
