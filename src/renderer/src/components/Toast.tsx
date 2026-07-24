/** 全局 Toast 通知：成功/失败/警告，自动消失，支持手动关闭 */
import { create } from 'zustand';

export type ToastKind = 'success' | 'error' | 'info';
interface ToastItem { id: number; kind: ToastKind; message: string }

interface ToastState {
  toasts: ToastItem[];
  push: (kind: ToastKind, message: string) => void;
  remove: (id: number) => void;
}

let nextId = 1;

export const useToast = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, message) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, message }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 6000 : 3500);
  },
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}));

/** 快捷调用（非组件上下文也可用） */
export const toast = {
  ok: (msg: string) => useToast.getState().push('success', msg),
  err: (msg: string) => useToast.getState().push('error', msg),
  info: (msg: string) => useToast.getState().push('info', msg)
};

const KIND_STYLE: Record<ToastKind, { icon: string; border: string }> = {
  success: { icon: '✓', border: 'var(--success, #4ade80)' },
  error: { icon: '✕', border: 'var(--danger, #f87171)' },
  info: { icon: 'ℹ', border: 'var(--accent, #4d6bfe)' }
};

export function ToastContainer() {
  const { toasts, remove } = useToast();
  if (toasts.length === 0) return null;

  return (
    <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 360 }}>
      {toasts.map((t) => {
        const ks = KIND_STYLE[t.kind];
        return (
          <div key={t.id} style={{
            display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px',
            background: 'var(--card, #1c1f26)', border: `1px solid ${ks.border}`, borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,.35)', fontSize: 12.5, lineHeight: 1.5,
            color: 'var(--text-1, #e4e4e7)', animation: 'toast-in .2s ease-out'
          }}>
            <span style={{ color: ks.border, fontWeight: 700, flexShrink: 0 }}>{ks.icon}</span>
            <span style={{ flex: 1, wordBreak: 'break-all' }}>{t.message}</span>
            <button onClick={() => remove(t.id)} style={{ border: 'none', background: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 0, fontSize: 13, lineHeight: 1 }}>×</button>
          </div>
        );
      })}
    </div>
  );
}
