/**
 * 凭据引导（开发/部署便利）：启动时检测 userData/aibox-data/credentials.bootstrap.json，
 * 若存在则将凭据导入 safeStorage + settings，完成后重命名为 .imported（避免重复导入）。
 * 文件格式：
 * {
 *   "provider": { "baseUrl": "https://api.deepseek.com", "model": "deepseek-v4-flash", "apiKey": "sk-xxx" },
 *   "channels": {
 *     "wecom": { "botId": "...", "secret": "..." },
 *     "weixin": { "bridgeUrl": "ws://127.0.0.1:8080/ws", "token": "..." },
 *     "feishu": { "appId": "...", "appSecret": "..." }
 *   }
 * }
 * 安全说明：文件导入后自动重命名，明文不长期留存；密钥最终仅存于系统密钥库（15.1）。
 */
import { app, safeStorage } from 'electron';
import { join } from 'node:path';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import type { Database } from './database.js';
import { saveProviderConfig } from './provider.js';
import { WECOM_BOTID_SETTING, WECOM_SECRET_REF } from './channels/wecomChannel.js';
import { WEIXIN_URL_SETTING, WEIXIN_TOKEN_REF } from './channels/wechatChannel.js';
import { FEISHU_APPID_SETTING, FEISHU_SECRET_REF } from './channels/feishuChannel.js';
import { randomUUID } from 'node:crypto';

interface BootstrapFile {
  provider?: { baseUrl?: string; model?: string; apiKey?: string };
  channels?: {
    wecom?: { botId?: string; secret?: string };
    weixin?: { bridgeUrl?: string; token?: string };
    feishu?: { appId?: string; appSecret?: string };
  };
}

function bootstrapPath(): string {
  return join(app.getPath('userData'), 'aibox-data', 'credentials.bootstrap.json');
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

  // 个人微信
  if (data.channels?.weixin?.bridgeUrl) {
    db.setSetting(WEIXIN_URL_SETTING, data.channels.weixin.bridgeUrl);
    if (data.channels.weixin.token) {
      db.setSetting(WEIXIN_TOKEN_REF, safeStorage.encryptString(data.channels.weixin.token).toString('base64'));
    }
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
