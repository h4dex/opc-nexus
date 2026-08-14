/**
 * 凭据引导（开发/部署便利）：启动时检测 userData/aibox-data/credentials.bootstrap.json，
 * 若存在则将凭据导入 safeStorage + settings，完成后重命名为 .imported（避免重复导入）。
 * 文件格式：
 * {
 *   "provider": { "baseUrl": "https://api.deepseek.com", "model": "deepseek-v4-flash", "apiKey": "sk-xxx" },
 *   "channels": {
 *     "wecom": { "botId": "...", "secret": "..." },
 *     "feishu": { "appId": "...", "appSecret": "..." }
 *   }
 * }
 * 安全说明：文件导入后自动重命名，明文不长期留存；密钥最终仅存于系统密钥库（15.1）。
 */
import { app, safeStorage } from 'electron';
import { join } from 'node:path';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import type { Database } from './database.js';
import { getProviderSettings, readProviderKey, saveProviderConfig } from './provider.js';
import { loadUserConfig } from './userConfig.js';
import { WECOM_BOTID_SETTING, WECOM_SECRET_REF } from './channels/wecomChannel.js';
import { FEISHU_APPID_SETTING, FEISHU_SECRET_REF } from './channels/feishuChannel.js';
import { randomUUID } from 'node:crypto';

interface BootstrapFile {
  provider?: { baseUrl?: string; model?: string; apiKey?: string };
  channels?: {
    wecom?: { botId?: string; secret?: string };
    feishu?: { appId?: string; appSecret?: string };
  };
}

function bootstrapPath(): string {
  return join(app.getPath('userData'), 'aibox-data', 'credentials.bootstrap.json');
}

/**
 * 从 user/config.yaml 的 provider 段导入供应商配置（每次启动执行，幂等）。
 *
 * 设计意图：让「软件同目录的一个文件」成为个人部署的唯一配置入口 —— 填一次
 * 即同时供内置 Nexus Agent 与第三方 CLI 引擎（Hermes / OpenCode / Codex）使用，
 * 不必再去逐个修改各引擎自己的配置文件（那些文件动辄数万行且含用户自有设置）。
 *
 * 幂等与安全：
 * - 占位符（*** 等）视为「沿用已存密钥」，不覆盖 safeStorage 中的值，
 *   因此用户导入后可把明文换成占位符，避免长期留存
 * - 与库中现有配置一致时跳过写入，不产生冗余审计记录
 * - 明文 key 只在本函数内经过，落地即加密；不回传 Renderer、不进日志
 *
 * @returns 是否实际写入了配置
 */
export function importProviderFromUserConfig(db: Database): boolean {
  const { provider } = loadUserConfig(true);
  if (!provider.baseUrl) return false;
  if (!safeStorage.isEncryptionAvailable()) return false;

  const placeholder = !provider.apiKey || /^\*+$/.test(provider.apiKey);
  const existing = getProviderSettings(db);
  const hasKey = !!readProviderKey(db);

  // 占位符且库中无密钥 → 无从获得凭据，不做半配置状态（baseUrl 有而 key 无会让引擎 401）
  if (placeholder && !hasKey) return false;

  const model = provider.model || existing.model || 'deepseek-chat';
  const sameConfig = existing.baseUrl === provider.baseUrl && existing.model === model;
  if (placeholder && sameConfig) return false; // 无变化，跳过

  saveProviderConfig(db, {
    baseUrl: provider.baseUrl,
    model,
    // 占位符时传空，saveProviderConfig 会保留已存密钥
    apiKey: placeholder ? '' : provider.apiKey
  });
  db.audit({
    id: randomUUID(),
    actor: 'system',
    action: 'bootstrap.providerFromUserConfig',
    target: provider.baseUrl,
    result: 'ok'
  });
  return true;
}

/** 启动时调用：检测并导入凭据引导文件（幂等，导入后重命名） */
export function importCredentialsBootstrap(db: Database): boolean {
  const file = bootstrapPath();
  if (!existsSync(file)) return false;

  let data: BootstrapFile;
  try {
    // PowerShell 5 写 UTF-8 带 BOM，先剥离再解析
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    data = JSON.parse(raw) as BootstrapFile;
  } catch {
    return false;
  }

  if (!safeStorage.isEncryptionAvailable()) return false;

  // 供应商配置
  if (data.provider?.baseUrl && data.provider?.apiKey) {
    saveProviderConfig(db, {
      baseUrl: data.provider.baseUrl,
      model: data.provider.model ?? 'deepseek-chat',
      apiKey: data.provider.apiKey
    });
  }

  // 企业微信
  if (data.channels?.wecom?.botId) {
    db.setSetting(WECOM_BOTID_SETTING, data.channels.wecom.botId);
    if (data.channels.wecom.secret) {
      db.setSetting(WECOM_SECRET_REF, safeStorage.encryptString(data.channels.wecom.secret).toString('base64'));
    }
    db.audit({ id: randomUUID(), actor: 'system', action: 'bootstrap.wecom', target: data.channels.wecom.botId, result: 'ok' });
  }

  // 飞书
  if (data.channels?.feishu?.appId) {
    db.setSetting(FEISHU_APPID_SETTING, data.channels.feishu.appId);
    if (data.channels.feishu.appSecret) {
      db.setSetting(FEISHU_SECRET_REF, safeStorage.encryptString(data.channels.feishu.appSecret).toString('base64'));
    }
  }

  // 导入完成 → 重命名（明文不长期留存）
  try {
    renameSync(file, file + '.imported');
  } catch {
    /* 重命名失败不阻塞启动 */
  }
  return true;
}
