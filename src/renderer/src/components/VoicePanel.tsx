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
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../store';
import { toast } from './Toast';
import type { VoiceCommandDraft } from '@shared/types';

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

  const sessionRef = useRef<string | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const readyAgents = (snapshot?.agentCards ?? [])
    .filter((c) => c.agent.lifecycle === 'READY')
    .map((c) => ({ id: c.agent.id, name: c.agent.name }));

  /** 释放麦克风与音频上下文；主进程会话另行关闭 */
  const teardownAudio = useCallback(() => {
    if (silenceTimer.current) { clearTimeout(silenceTimer.current); silenceTimer.current = null; }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => { /* 已关闭忽略 */ });
    ctxRef.current = null;
  }, []);

  const stopSession = useCallback(() => {
    teardownAudio();
    const id = sessionRef.current;
    sessionRef.current = null;
    if (id) void window.aibox.stopVoiceSession(id);
  }, [teardownAudio]);

  // 组件卸载必须释放麦克风，否则录音指示灯会一直亮着
  useEffect(() => stopSession, [stopSession]);

  /** 一句话结束 → 解析为任务草稿，进入确认态 */
  const toConfirm = useCallback(async (text: string) => {
    if (!text.trim()) return;
    stopSession();
    const d = await window.aibox.parseVoiceCommand(text);
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
      stopSession();
    });
    return () => { offT(); offE(); };
  }, [toConfirm, stopSession]);

  const start = async () => {
    setError(''); setPartial(''); setFinalText(''); setDraft(null);
    const r = await window.aibox.startVoiceSession();
    if (!r.ok || !r.sessionId) {
      setError(r.message);
      return;
    }
    sessionRef.current = r.sessionId;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
      });
      streamRef.current = stream;
      // 优先让浏览器直接以 16kHz 打开，省去重采样；不支持时退回默认采样率
      const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
      ctxRef.current = ctx;
      const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);

      const node = new AudioWorkletNode(ctx, 'pcm-extractor');
      node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
        const id = sessionRef.current;
        if (id) void window.aibox.pushVoiceAudio(id, ev.data);
      };
      ctx.createMediaStreamSource(stream).connect(node);
      // AudioWorklet 需接入图才会持续拉取；用零增益避免把自己的声音播出来造成回授
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(ctx.destination);
      setPhase('listening');
    } catch (err) {
      stopSession();
      setError(`无法访问麦克风：${err instanceof Error ? err.message : String(err)}`);
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
    try {
      await window.aibox.dispatchVoiceTask(editAgentId, editTitle.trim());
      toast.ok(`已派发：${editTitle.trim()}`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const live = partial || finalText;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200 }}
      onClick={() => { stopSession(); onClose(); }}>
      <div className="card" style={{ width: 520, padding: 22 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>语音下达任务</h3>
          <button className="btn small" onClick={() => { stopSession(); onClose(); }}>关闭</button>
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
              value={editTitle} onChange={(e) => setEditTitle(e.target.value)} autoFocus
            />

            <label style={{ fontSize: 11.5, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>
              派给{draft.matchedBy === 'none' && <span style={{ color: 'var(--warning)' }}>（未识别到目标员工，请选择）</span>}
            </label>
            <select
              style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)', fontSize: 13, marginBottom: 16 }}
              value={editAgentId} onChange={(e) => setEditAgentId(e.target.value)}
            >
              <option value="">请选择数字员工</option>
              {readyAgents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn primary" disabled={!editAgentId || !editTitle.trim()} onClick={() => void dispatch()}>
                确认派发
              </button>
              <button className="btn" onClick={() => { setPhase('idle'); setDraft(null); setPartial(''); setFinalText(''); }}>
                重说
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
