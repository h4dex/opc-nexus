/**
 * 阿里云 NLS WebSocket 协议帧处理测试
 *
 * 语音链路依赖真实凭据,无法在 CI 端到端验证;但「收到某种帧应如何反应」
 * 是纯逻辑,可离线锁死。这里直接驱动 voiceService 导出的真实实现
 * (classifyNlsFrame / VoiceSession.startPayload),不复刻逻辑,避免测试与实现脱钩。
 *
 * @author liyingjie <y@senke.com>
 */
// @ts-nocheck
/* eslint-disable */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const { classifyNlsFrame, VoiceService, VoiceSession } = await import('../src/main/services/voiceService.js');

/** 构造 NLS 服务端帧；status 传 null 表示该帧不带 status 字段 */
function frame(name: string, opts: { result?: string; statusText?: string; status?: number | null } = {}) {
  const header: Record<string, unknown> = { name, task_id: 't', message_id: 'm' };
  if (opts.status !== null) header.status = opts.status ?? 20000000;
  if (opts.statusText) header.status_text = opts.statusText;
  return Buffer.from(JSON.stringify({ header, payload: opts.result === undefined ? {} : { result: opts.result } }));
}

describe('NLS 帧分类（真实实现）', () => {
  it('TranscriptionStarted → 就绪', () => {
    expect(classifyNlsFrame(frame('TranscriptionStarted')).kind).toBe('started');
  });

  it('TranscriptionResultChanged → 中间结果（边说边出字）', () => {
    const r = classifyNlsFrame(frame('TranscriptionResultChanged', { result: '今天天' }));
    expect(r).toEqual({ kind: 'partial', text: '今天天' });
  });

  it('SentenceEnd → 最终结果（触发解析与确认）', () => {
    const r = classifyNlsFrame(frame('SentenceEnd', { result: '今天天气不错' }));
    expect(r).toEqual({ kind: 'final', text: '今天天气不错' });
  });

  it('错误状态码如实上报，不静默丢弃', () => {
    const r = classifyNlsFrame(frame('TaskFailed', { status: 40000004, statusText: 'Gateway:ACCESS_DENIED' }));
    expect(r.kind).toBe('error');
    expect(r.error).toContain('40000004');
    expect(r.error).toContain('ACCESS_DENIED');
  });

  it('签名/凭据错误走错误分支 —— 这正是签名写错时的实际表现', () => {
    const r = classifyNlsFrame(frame('TaskFailed', { status: 40000001, statusText: 'SignatureNotMatch' }));
    expect(r.kind).toBe('error');
    expect(r.error).toContain('SignatureNotMatch');
  });

  it('错误帧缺 status_text 时给出兜底文案', () => {
    const r = classifyNlsFrame(frame('TaskFailed', { status: 50000000 }));
    expect(r.kind).toBe('error');
    expect(r.error).toContain('未知原因');
  });

  it('空结果不产生回调（避免把空串推给界面）', () => {
    expect(classifyNlsFrame(frame('SentenceEnd')).kind).toBe('ignored');
    expect(classifyNlsFrame(frame('TranscriptionResultChanged', { result: '' })).kind).toBe('ignored');
  });

  it('非 JSON 帧被忽略而不崩溃', () => {
    expect(classifyNlsFrame(Buffer.from('not json at all')).kind).toBe('ignored');
    expect(classifyNlsFrame(Buffer.from('')).kind).toBe('ignored');
    expect(classifyNlsFrame(Buffer.from('{broken')).kind).toBe('ignored');
  });

  it('未知帧名不误判为错误（SentenceBegin / TranscriptionCompleted 等）', () => {
    expect(classifyNlsFrame(frame('SentenceBegin')).kind).toBe('ignored');
    expect(classifyNlsFrame(frame('TranscriptionCompleted')).kind).toBe('ignored');
  });

  it('不带 status 字段的帧按成功处理（部分帧确实不带）', () => {
    const r = classifyNlsFrame(frame('SentenceEnd', { result: 'x', status: null }));
    expect(r).toEqual({ kind: 'final', text: 'x' });
  });

  it('status 为成功码时正常按帧名分派', () => {
    expect(classifyNlsFrame(frame('TranscriptionStarted', { status: 20000000 })).kind).toBe('started');
  });
});

describe('StartTranscription 载荷（真实实现）', () => {
  const p = VoiceSession.startPayload();

  it('采样率与格式须与 Renderer 采集一致（16kHz / PCM）', () => {
    expect(p.format).toBe('pcm');
    expect(p.sample_rate).toBe(16000);
  });

  it('enable_intermediate_result 必须为 true —— 全双工边说边出字的前提', () => {
    // 若为 false，只在句末出字，交互退化为「录完再识别」
    expect(p.enable_intermediate_result).toBe(true);
  });

  it('开启标点预测与数字规整（任务标题可直接使用）', () => {
    expect(p.enable_punctuation_prediction).toBe(true);
    expect(p.enable_inverse_text_normalization).toBe(true);
  });
});

describe('语音配置与就绪判定', () => {
  function makeDb(settings: Record<string, unknown> = {}) {
    const store = { ...settings };
    return {
      raw: { prepare: () => ({ get: () => undefined, all: () => [], run: () => ({ changes: 1 }) }) },
      transaction: (fn: () => void) => fn(),
      audit: vi.fn(),
      getSetting: (k: string, fb: unknown) => (k in store ? store[k] : fb),
      setSetting: (k: string, v: unknown) => { store[k] = v; }
    } as never;
  }

  it('未启用时 start 拒绝并给出可操作提示', async () => {
    const r = await new VoiceService(makeDb()).start();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('未启用');
  });

  it('已启用但无任何通道时如实报错，不静默失败', async () => {
    const svc = new VoiceService(makeDb({ 'voice:config': { enabled: true, provider: 'cloud', appKey: '', silenceMs: 800 } }));
    const r = await svc.start();
    expect(r.ok).toBe(false);
    expect(r.provider).toBeNull();
    expect(r.message).toMatch(/无可用语音识别通道|凭据/);
  });

  it('配置视图不回传凭据明文（只回是否已配置）', () => {
    const svc = new VoiceService(makeDb({ 'voice:config': { enabled: true, provider: 'cloud', appKey: 'ak-visible', silenceMs: 800 } }));
    const cfg = svc.getConfig();
    expect(cfg.appKey).toBe('ak-visible'); // AppKey 非密钥，可见
    expect(cfg).not.toHaveProperty('accessKeyId');
    expect(cfg).not.toHaveProperty('accessKeySecret');
    expect(typeof cfg.hasAccessKeyId).toBe('boolean');
    expect(typeof cfg.hasAccessKeySecret).toBe('boolean');
  });

  it('test() 在无通道时返回可操作的失败原因', async () => {
    const r = await new VoiceService(makeDb()).test();
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('silenceMs 被夹在合理区间（防误配成 0 或过大）', () => {
    const svc = new VoiceService(makeDb());
    expect(svc.saveConfig({ silenceMs: 10 }).silenceMs).toBeGreaterThanOrEqual(300);
    expect(svc.saveConfig({ silenceMs: 99999 }).silenceMs).toBeLessThanOrEqual(5000);
  });

  it('rejects legacy local provider input instead of exposing an unfinished mode', () => {
    const svc = new VoiceService(makeDb());
    expect(() => svc.saveConfig({ provider: 'local' as never })).toThrow('尚未实现');
  });
});
