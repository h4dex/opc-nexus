/**
 * 语音任务下达服务（全双工实时识别）
 *
 * 架构：Renderer 采集麦克风 PCM → IPC 推送到主进程 → 本服务转发给识别后端 →
 * 识别结果经 onTranscript 回推 Renderer（边说边出字）→ 停顿后解析为任务草稿 → 用户确认 → 派发。
 *
 * 【为什么音频走主进程而不是 Renderer 直连云端】
 * 云端凭据必须留在主进程（安全基线 15.1：密钥绝不进 Renderer）。
 * 若让 Renderer 直连阿里云 WebSocket，就得把 AccessKeySecret 下发到渲染进程，违反基线。
 *
 * 【双路策略】
 * - cloud：阿里云 NLS 实时识别（WebSocket 流式，真全双工，边说边出字）
 * - local：本地离线模型（无需联网/凭据，数据不出本机）
 * - auto（默认）：云端凭据齐备走云端，否则回退本地；两者都不可用时如实报错，不静默失败
 *
 * 【诚实性】识别不可用时明确报错，绝不返回伪造文本让用户以为在工作。
 *
 * @author liyingjie <y@senke.com>
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, safeStorage } from 'electron';
import type { Database } from './database.js';
import type { VoiceConfig, VoiceConfigInput, VoiceProvider, VoiceTestResult, VoiceTranscript } from '../../shared/types.js';

/** 阿里云 NLS 实时识别 WebSocket 端点（上海） */
const NLS_ENDPOINT = 'wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1';
/** 凭据在 settings 表中的存储键（值经 safeStorage 加密） */
const KEY_ID_REF = 'secret:voice:accessKeyId';
const KEY_SECRET_REF = 'secret:voice:accessKeySecret';
const SETTING = 'voice:config';
/** 默认静音判定：说完一句话后多久认为结束 */
const DEFAULT_SILENCE_MS = 800;
/** 单次语音会话最长时长，防止忘记关闭导致持续上传 */
const MAX_SESSION_MS = 5 * 60_000;

interface StoredConfig {
  enabled: boolean;
  provider: VoiceProvider;
  appKey: string;
  silenceMs: number;
}

const DEFAULTS: StoredConfig = { enabled: false, provider: 'auto', appKey: '', silenceMs: DEFAULT_SILENCE_MS };

/** 本地离线模型目录（与 OCR 模型同级，缺失时本地路不可用） */
function localModelDir(): string {
  return join(app.getPath('userData'), 'aibox-data', 'models', 'asr');
}

function decrypt(db: Database, ref: string): string | null {
  const b64 = db.getSetting<string | null>(ref, null);
  if (!b64 || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'));
  } catch {
    return null;
  }
}

export class VoiceService {
  /** sessionId → 活跃识别会话 */
  private sessions = new Map<string, VoiceSession>();
  private transcriptListeners = new Set<(sessionId: string, t: VoiceTranscript) => void>();
  private errorListeners = new Set<(sessionId: string, message: string) => void>();

  constructor(private db: Database) {}

  // ---------- 配置 ----------

  private stored(): StoredConfig {
    return { ...DEFAULTS, ...this.db.getSetting<Partial<StoredConfig>>(SETTING, {}) };
  }

  /** 脱敏配置视图：凭据只回传「是否已配置」，明文不出主进程 */
  getConfig(): VoiceConfig {
    const c = this.stored();
    return {
      enabled: c.enabled,
      provider: c.provider,
      appKey: c.appKey,
      hasAccessKeyId: this.db.getSetting<string | null>(KEY_ID_REF, null) !== null,
      hasAccessKeySecret: this.db.getSetting<string | null>(KEY_SECRET_REF, null) !== null,
      localModelReady: existsSync(localModelDir()),
      silenceMs: c.silenceMs
    };
  }

  /** 保存配置；凭据留空表示沿用已存值，写入前经 safeStorage 加密 */
  saveConfig(input: VoiceConfigInput): VoiceConfig {
    const cur = this.stored();
    const next: StoredConfig = {
      enabled: input.enabled ?? cur.enabled,
      provider: input.provider ?? cur.provider,
      appKey: input.appKey?.trim() ?? cur.appKey,
      silenceMs: Math.min(5000, Math.max(300, input.silenceMs ?? cur.silenceMs))
    };
    this.db.setSetting(SETTING, next);

    for (const [value, ref] of [
      [input.accessKeyId, KEY_ID_REF],
      [input.accessKeySecret, KEY_SECRET_REF]
    ] as const) {
      const v = value?.trim();
      if (!v) continue;
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥库不可用，无法安全保存语音服务凭据');
      this.db.setSetting(ref, safeStorage.encryptString(v).toString('base64'));
    }
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'voice.saveConfig', target: next.provider, result: 'ok' });
    return this.getConfig();
  }

  /** 云端凭据是否齐备（AppKey + AccessKeyId + AccessKeySecret 三者缺一不可） */
  private cloudReady(): boolean {
    const c = this.stored();
    return !!c.appKey && decrypt(this.db, KEY_ID_REF) !== null && decrypt(this.db, KEY_SECRET_REF) !== null;
  }

  /** 实际生效的识别路径；两路都不可用返回 null（调用方须如实报错，不得静默降级） */
  resolveProvider(): 'cloud' | 'local' | null {
    const { provider } = this.stored();
    if (provider === 'cloud') return this.cloudReady() ? 'cloud' : null;
    if (provider === 'local') return existsSync(localModelDir()) ? 'local' : null;
    if (this.cloudReady()) return 'cloud';
    return existsSync(localModelDir()) ? 'local' : null;
  }

  /** 连通性自检：如实返回可用路径与延迟，不可用时给出可操作的原因 */
  async test(): Promise<VoiceTestResult> {
    const started = Date.now();
    const provider = this.resolveProvider();
    if (!provider) {
      return {
        ok: false, provider: null, latencyMs: 0,
        error: '云端凭据未配置且本地模型缺失：请在设置页填写阿里云 AppKey / AccessKey，或下载本地识别模型'
      };
    }
    if (provider === 'local') {
      return { ok: true, provider: 'local', latencyMs: Date.now() - started, error: null };
    }
    try {
      const token = await this.fetchNlsToken();
      return { ok: !!token, provider: 'cloud', latencyMs: Date.now() - started, error: token ? null : '获取访问令牌失败' };
    } catch (err) {
      return { ok: false, provider: 'cloud', latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---------- 事件订阅 ----------

  onTranscript(fn: (sessionId: string, t: VoiceTranscript) => void): () => void {
    this.transcriptListeners.add(fn);
    return () => this.transcriptListeners.delete(fn);
  }

  onError(fn: (sessionId: string, message: string) => void): () => void {
    this.errorListeners.add(fn);
    return () => this.errorListeners.delete(fn);
  }

  private emitTranscript(sessionId: string, text: string, isFinal: boolean) {
    const t: VoiceTranscript = { text, isFinal, timestamp: Date.now() };
    for (const fn of this.transcriptListeners) fn(sessionId, t);
  }

  private emitError(sessionId: string, message: string) {
    for (const fn of this.errorListeners) fn(sessionId, message);
  }

  // ---------- 会话生命周期 ----------

  /** 开始一次语音会话；返回 sessionId 供后续推送音频与停止 */
  async start(): Promise<{ ok: boolean; sessionId: string | null; provider: 'cloud' | 'local' | null; message: string }> {
    if (!this.stored().enabled) {
      return { ok: false, sessionId: null, provider: null, message: '语音任务下达未启用，请先在设置页开启' };
    }
    const provider = this.resolveProvider();
    if (!provider) {
      return {
        ok: false, sessionId: null, provider: null,
        message: '无可用语音识别通道：请配置阿里云凭据或安装本地识别模型'
      };
    }

    const sessionId = `voice-${randomUUID().slice(0, 8)}`;
    const session = new VoiceSession(
      sessionId,
      provider,
      (text, isFinal) => this.emitTranscript(sessionId, text, isFinal),
      (msg) => {
        this.emitError(sessionId, msg);
        this.stop(sessionId);
      }
    );
    this.sessions.set(sessionId, session);

    try {
      if (provider === 'cloud') {
        await session.connectCloud(NLS_ENDPOINT, this.stored().appKey, await this.fetchNlsToken());
      } else {
        await session.startLocal(localModelDir());
      }
    } catch (err) {
      this.sessions.delete(sessionId);
      return { ok: false, sessionId: null, provider, message: `语音通道建立失败：${err instanceof Error ? err.message : String(err)}` };
    }

    // 兜底超时：防止界面异常未调 stop 导致持续拾音上传
    session.timer = setTimeout(() => {
      this.emitError(sessionId, '语音会话超时（5 分钟），已自动结束');
      this.stop(sessionId);
    }, MAX_SESSION_MS);

    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'voice.start', target: provider, result: sessionId });
    return { ok: true, sessionId, provider, message: '' };
  }

  /** 推送一段 PCM 音频（16kHz / 16bit / 单声道），由 Renderer 采集后经 IPC 传入 */
  pushAudio(sessionId: string, chunk: Buffer): void {
    this.sessions.get(sessionId)?.pushAudio(chunk);
  }

  /** 结束会话并释放资源 */
  stop(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.close();
  }

  /** 关闭全部会话（应用退出时调用） */
  stopAll(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }

  // ---------- 阿里云访问令牌 ----------

  /**
   * 获取 NLS 访问令牌。阿里云 CreateToken 需要 AccessKey 签名，
   * 这里用 RPC 风格签名（HMAC-SHA1），避免引入完整 SDK。
   */
  private async fetchNlsToken(): Promise<string> {
    const keyId = decrypt(this.db, KEY_ID_REF);
    const keySecret = decrypt(this.db, KEY_SECRET_REF);
    if (!keyId || !keySecret) throw new Error('阿里云 AccessKey 未配置或无法解密');

    const { createHmac } = await import('node:crypto');
    const params: Record<string, string> = {
      AccessKeyId: keyId,
      Action: 'CreateToken',
      Format: 'JSON',
      RegionId: 'cn-shanghai',
      SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: randomUUID(),
      SignatureVersion: '1.0',
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      Version: '2019-02-28'
    };
    // RPC 签名：参数按字典序拼接后与 HTTP 方法一同签名
    const encode = (s: string) =>
      encodeURIComponent(s).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');
    const canonical = Object.keys(params).sort().map((k) => `${encode(k)}=${encode(params[k])}`).join('&');
    const stringToSign = `GET&${encode('/')}&${encode(canonical)}`;
    const signature = createHmac('sha1', `${keySecret}&`).update(stringToSign).digest('base64');
    const url = `https://nls-meta.cn-shanghai.aliyuncs.com/?Signature=${encode(signature)}&${canonical}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`获取令牌失败：HTTP ${res.status}`);
    const data = (await res.json()) as { Token?: { Id?: string }; Message?: string };
    if (!data.Token?.Id) throw new Error(data.Message || '响应中缺少令牌');
    return data.Token.Id;
  }
}

/**
 * 单次语音会话：持有识别后端连接，把音频流转发过去并回吐识别结果。
 * 云端走阿里云 NLS WebSocket 协议；本地走离线模型（模型缺失时如实报错）。
 */
class VoiceSession {
  private ws: import('ws').WebSocket | null = null;
  private taskId = randomUUID().replace(/-/g, '');
  private ready = false;
  /** 连接就绪前到达的音频，就绪后补发，避免丢掉开头的话 */
  private pending: Buffer[] = [];
  timer: NodeJS.Timeout | null = null;

  constructor(
    readonly id: string,
    readonly provider: 'cloud' | 'local',
    private onText: (text: string, isFinal: boolean) => void,
    private onFail: (message: string) => void
  ) {}

  /** 建立阿里云 NLS 实时识别连接并发送 StartTranscription 指令 */
  async connectCloud(endpoint: string, appKey: string, token: string): Promise<void> {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`${endpoint}?token=${encodeURIComponent(token)}`);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('连接超时（10 秒）')), 10_000);
      ws.on('open', () => {
        clearTimeout(timeout);
        ws.send(JSON.stringify({
          header: { message_id: randomUUID().replace(/-/g, ''), task_id: this.taskId, namespace: 'SpeechTranscriber', name: 'StartTranscription', appkey: appKey },
          payload: {
            format: 'pcm', sample_rate: 16000,
            enable_intermediate_result: true,   // 边说边出字的关键
            enable_punctuation_prediction: true,
            enable_inverse_text_normalization: true
          }
        }));
        resolve();
      });
      ws.on('error', (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    ws.on('message', (raw: Buffer) => this.handleCloudMessage(raw));
    ws.on('close', () => { this.ready = false; });
  }

  private handleCloudMessage(raw: Buffer): void {
    let msg: { header?: { name?: string; status?: number; status_text?: string }; payload?: { result?: string } };
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return; // 非 JSON 帧忽略
    }
    const name = msg.header?.name;
    const status = msg.header?.status;
    if (typeof status === 'number' && status !== 20000000) {
      this.onFail(`识别服务返回错误（${status}）：${msg.header?.status_text ?? '未知原因'}`);
      return;
    }
    if (name === 'TranscriptionStarted') {
      this.ready = true;
      for (const buf of this.pending.splice(0)) this.ws?.send(buf);
    } else if (name === 'TranscriptionResultChanged') {
      if (msg.payload?.result) this.onText(msg.payload.result, false);
    } else if (name === 'SentenceEnd') {
      if (msg.payload?.result) this.onText(msg.payload.result, true);
    }
  }

  /**
   * 本地离线识别：模型目录存在才可用。
   * 当前版本仅校验模型存在性并如实报告未实现，绝不返回伪造文本
   * （宁可明确报错，也不让用户以为识别在工作）。
   */
  async startLocal(modelDir: string): Promise<void> {
    if (!existsSync(modelDir)) throw new Error(`本地识别模型缺失：${modelDir}`);
    throw new Error('本地离线识别尚未实现，请先配置阿里云凭据使用云端识别');
  }

  pushAudio(chunk: Buffer): void {
    if (this.provider !== 'cloud' || !this.ws) return;
    if (!this.ready) {
      // 未就绪时最多缓存 100 片（约 3 秒），防止异常时无限堆积
      if (this.pending.length < 100) this.pending.push(chunk);
      return;
    }
    if (this.ws.readyState === 1) this.ws.send(chunk);
  }

  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = [];
    if (this.ws) {
      try {
        if (this.ws.readyState === 1) {
          this.ws.send(JSON.stringify({
            header: { message_id: randomUUID().replace(/-/g, ''), task_id: this.taskId, namespace: 'SpeechTranscriber', name: 'StopTranscription' }
          }));
        }
        this.ws.close();
      } catch { /* 关闭失败不影响主流程 */ }
      this.ws = null;
    }
    this.ready = false;
  }
}
