/**
 * 语音任务下达面板（全双工）
 *
 * 交互链路：
 *   点击麦克风 → 主进程建立识别通道 → 浏览器采集 PCM 经 IPC 上送 →
 *   识别结果流式回推（边说边出字）→ 停顿后解析为任务草稿 →
 *   **用户确认**（可改标题、换员工）→ 派发（source='voice'）
 *
 * 为什么要确认这一步：语音识别必然有误差，而任务会真实执行（改文件、发消息、跑命令）。
 * 识别错一个字就直接派发，代价是不可逆的真实操作。
 *
 * 音频采集用 AudioWorklet 而非已废弃的 ScriptProcessorNode；
 * 云端要求 16kHz/16bit/单声道 PCM，这里做重采样与 Float32→Int16 转换。
 *
 * @author liyingjie <y@senke.com>
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { toast } from './Toast';
import type { VoiceCommandDraft } from '@shared/types';
import { VoiceAudioPump } from '../utils/voiceAudioPump';
import { VoiceDispatchAttempt } from '../utils/voiceDispatchAttempt';

/** 云端识别要求的采样率 */
const TARGET_SAMPLE_RATE = 16000;

/** AudioWorklet 处理器：把 Float32 帧转 Int16 PCM 后交回主线程 */
const WORKLET_CODE = `
class PcmExtractor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      const pcm = new Int16Array(ch.length);
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-extractor', PcmExtractor);
`;

type Phase = 'idle' | 'listening' | 'confirming';

export function VoicePanel({ onClose }: { onClose: () => void }) {
  const { snapshot } = useApp();
  const [phase, setPhase] = useState<Phase>('idle');
  const [partial, setPartial] = useState('');
  const [finalText, setFinalText] = useState('');
  const [draft, setDraft] = useState<VoiceCommandDraft | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editAgentId, setEditAgentId] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const sessionRef = useRef<string | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const muteRef = useRef<GainNode | null>(null);
  const audioPumpRef = useRef<VoiceAudioPump | null>(null);
  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startGenerationRef = useRef(0);
  const startInFlightRef = useRef(false);
  const dispatchAttemptRef = useRef<VoiceDispatchAttempt | null>(null);
  const mountedRef = useRef(true);

  const readyAgents = useMemo(() => (snapshot?.agentCards ?? [])
    .filter((c) => c.agent.lifecycle === 'READY')
    .map((c) => ({ id: c.agent.id, name: c.agent.name })), [snapshot?.agentCards]);

  /** 释放麦克风与音频上下文；主进程会话另行关闭 */
  const teardownAudio = useCallback(() => {
    if (silenceTimer.current) { clearTimeout(silenceTimer.current); silenceTimer.current = null; }
    audioPumpRef.current?.dispose();
    audioPumpRef.current = null;
    if (workletRef.current) workletRef.current.port.onmessage = null;
    try { workletRef.current?.disconnect(); } catch { /* 已断开忽略 */ }
    try { sourceRef.current?.disconnect(); } catch { /* 已断开忽略 */ }
    try { muteRef.current?.disconnect(); } catch { /* 已断开忽略 */ }
    workletRef.current = null;
    sourceRef.current = null;
    muteRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => { /* 已关闭忽略 */ });
    ctxRef.current = null;
  }, []);

  const stopSession = useCallback(() => {
    startGenerationRef.current++;
    startInFlightRef.current = false;
    teardownAudio();
    const id = sessionRef.current;
    sessionRef.current = null;
    if (id) void window.aibox.stopVoiceSession(id).catch(() => { /* 主进程可能正在退出 */ });
  }, [teardownAudio]);

  // 组件卸载必须释放麦克风，否则录音指示灯会一直亮着
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopSession();
    };
  }, [stopSession]);

  /** 一句话结束 → 解析为任务草稿，进入确认态 */
  const toConfirm = useCallback(async (text: string) => {
    if (!text.trim()) return;
    stopSession();
    const generation = startGenerationRef.current;
    const d = await window.aibox.parseVoiceCommand(text);
    if (!mountedRef.current || startGenerationRef.current !== generation) return;
    dispatchAttemptRef.current = new VoiceDispatchAttempt();
    setSubmitting(false);
    setDraft(d);
    setEditTitle(d.title);
    setEditAgentId(d.agentId ?? readyAgents[0]?.id ?? '');
    setPhase('confirming');
  }, [stopSession, readyAgents]);

  // 识别结果订阅：partial 持续覆盖，final 落定后进入确认
  useEffect(() => {
    const offT = window.aibox.onVoiceTranscript((p) => {
      if (p.sessionId !== sessionRef.current) return;
      if (p.isFinal) {
        setFinalText(p.text);
        setPartial('');
        void toConfirm(p.text);
      } else {
        setPartial(p.text);
      }
    });
    const offE = window.aibox.onVoiceError((p) => {
      if (p.sessionId !== sessionRef.current) return;
      setError(p.message);
      setPhase('idle');
      dispatchAttemptRef.current = null;
      setSubmitting(false);
      stopSession();
    });
    return () => { offT(); offE(); };
  }, [toConfirm, stopSession]);

  const start = async () => {
    if (startInFlightRef.current || sessionRef.current) return;
    startInFlightRef.current = true;
    const generation = ++startGenerationRef.current;
    let attemptSessionId: string | null = null;
    let attemptStream: MediaStream | null = null;
    let attemptContext: AudioContext | null = null;

    const isCurrent = () => mountedRef.current && startGenerationRef.current === generation;
    const stopAttemptSession = () => {
      if (attemptSessionId) {
        void window.aibox.stopVoiceSession(attemptSessionId).catch(() => { /* 主进程可能正在退出 */ });
        if (sessionRef.current === attemptSessionId) sessionRef.current = null;
        attemptSessionId = null;
      }
    };
    const releaseAttempt = () => {
      attemptStream?.getTracks().forEach((track) => track.stop());
      if (attemptStream === streamRef.current) streamRef.current = null;
      if (attemptContext === ctxRef.current) ctxRef.current = null;
      void attemptContext?.close().catch(() => { /* 已关闭忽略 */ });
      stopAttemptSession();
    };

    dispatchAttemptRef.current = null;
    setSubmitting(false);
    setError(''); setPartial(''); setFinalText(''); setDraft(null);

    try {
      const r = await window.aibox.startVoiceSession();
      if (!isCurrent()) {
        if (r.sessionId) {
          attemptSessionId = r.sessionId;
          stopAttemptSession();
        }
        return;
      }
      if (!r.ok || !r.sessionId) {
        if (r.sessionId) {
          attemptSessionId = r.sessionId;
          stopAttemptSession();
        }
        setError(r.message);
        return;
      }
      attemptSessionId = r.sessionId;
      sessionRef.current = attemptSessionId;

      attemptStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
      });
      if (!isCurrent()) { releaseAttempt(); return; }
      streamRef.current = attemptStream;

      // 优先让浏览器直接以 16kHz 打开，省去重采样；不支持时退回默认采样率
      attemptContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
      ctxRef.current = attemptContext;
      const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      try {
        await attemptContext.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      if (!isCurrent()) { releaseAttempt(); return; }

      const sessionId = attemptSessionId;
      const pump = new VoiceAudioPump(sessionId, (id, chunk) => window.aibox.pushVoiceAudio(id, chunk), {
        onError: (cause) => {
          if (!mountedRef.current || startGenerationRef.current !== generation || sessionRef.current !== sessionId) return;
          stopSession();
          setPhase('idle');
          setError(`语音上传失败：${cause instanceof Error ? cause.message : String(cause)}`);
        }
      });
      audioPumpRef.current = pump;

      const node = new AudioWorkletNode(attemptContext, 'pcm-extractor');
      workletRef.current = node;
      node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
        pump.push(ev.data);
      };
      const source = attemptContext.createMediaStreamSource(attemptStream);
      sourceRef.current = source;
      source.connect(node);
      // AudioWorklet 需接入图才会持续拉取；用零增益避免把自己的声音播出来造成回授
      const mute = attemptContext.createGain();
      muteRef.current = mute;
      mute.gain.value = 0;
      node.connect(mute).connect(attemptContext.destination);
      setPhase('listening');
    } catch (err) {
      if (isCurrent()) {
        stopSession();
        if (mountedRef.current) setError(`无法访问麦克风：${err instanceof Error ? err.message : String(err)}`);
      } else {
        releaseAttempt();
      }
    } finally {
      if (startGenerationRef.current === generation) startInFlightRef.current = false;
    }
  };

  /** 手动结束拾音：用当前已识别文本进入确认 */
  const finish = () => {
    const text = finalText || partial;
    if (text.trim()) void toConfirm(text);
    else { stopSession(); setPhase('idle'); }
  };

  const dispatch = async () => {
    if (!editAgentId || !editTitle.trim()) return;
    const attempt = dispatchAttemptRef.current;
    const messageKey = attempt?.tryStart();
    if (!attempt || !messageKey) return;
    setSubmitting(true);
    setError('');
    try {
      await window.aibox.dispatchVoiceTask(editAgentId, editTitle.trim(), messageKey);
      toast.ok(`已派发：${editTitle.trim()}`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      attempt.finish();
      if (mountedRef.current && dispatchAttemptRef.current === attempt) setSubmitting(false);
    }
  };

  const live = partial || finalText;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200 }}
      onClick={() => { if (!submitting) { stopSession(); onClose(); } }}>
      <div className="card" style={{ width: 520, padding: 22 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>语音下达任务</h3>
          <button className="btn small" disabled={submitting} onClick={() => { stopSession(); onClose(); }}>关闭</button>
        </div>

        {error && (
          <div style={{ fontSize: 12.5, color: 'var(--danger)', background: 'var(--input-bg)', borderRadius: 8, padding: '10px 12px', marginBottom: 14, lineHeight: 1.7 }}>
            {error}
          </div>
        )}

        {phase !== 'confirming' && (
          <>
            <div style={{
              minHeight: 90, background: 'var(--input-bg)', borderRadius: 10, padding: '14px 16px', marginBottom: 16,
              fontSize: 14, lineHeight: 1.8, color: live ? 'var(--text-1)' : 'var(--text-3)'
            }}>
              {live || (phase === 'listening' ? '正在聆听，请说出要安排的任务…' : '点击下方按钮开始说话')}
              {phase === 'listening' && partial && <span style={{ color: 'var(--text-3)' }}> ▍</span>}
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              {phase === 'idle' && <button className="btn primary" onClick={() => void start()}>开始说话</button>}
              {phase === 'listening' && (
                <>
                  <button className="btn primary" onClick={finish}>说完了</button>
                  <button className="btn" onClick={() => { stopSession(); setPhase('idle'); }}>取消</button>
                  <span style={{ fontSize: 12, color: 'var(--success)' }}>● 拾音中</span>
                </>
              )}
            </div>
          </>
        )}

        {phase === 'confirming' && draft && (
          <>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 4 }}>识别原文</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-2)', background: 'var(--input-bg)', borderRadius: 8, padding: '8px 12px', marginBottom: 14 }}>
              {draft.rawText}
            </div>

            <label style={{ fontSize: 11.5, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>任务内容（可修改）</label>
            <input
              style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)', fontSize: 13, outline: 'none', marginBottom: 12 }}
              value={editTitle} disabled={submitting} onChange={(e) => setEditTitle(e.target.value)} autoFocus
            />

            <label style={{ fontSize: 11.5, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>
              派给{draft.matchedBy === 'none' && <span style={{ color: 'var(--warning)' }}>（未识别到目标员工，请选择）</span>}
            </label>
            <select
              style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)', fontSize: 13, marginBottom: 16 }}
              value={editAgentId} disabled={submitting} onChange={(e) => setEditAgentId(e.target.value)}
            >
              <option value="">请选择数字员工</option>
              {readyAgents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn primary" disabled={submitting || !editAgentId || !editTitle.trim()} onClick={() => void dispatch()}>
                {submitting ? '派发中...' : '确认派发'}
              </button>
              <button className="btn" disabled={submitting} onClick={() => {
                dispatchAttemptRef.current = null;
                setPhase('idle'); setDraft(null); setPartial(''); setFinalText('');
              }}>
                重说
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
