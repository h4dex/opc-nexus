/** 通用小组件：弹窗 / 状态点 / 机器人头像 / 状态标签 */
import type { ReactNode } from 'react';
import type { DerivedAgentStatus, TaskStatus } from '@shared/types';
import { IconRobot, IconX } from './icons';

export function Modal({
  title, onClose, children, footer, width
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  return (
    <div className="modal-mask" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width } : undefined} role="dialog" aria-label={title}>
        <div className="modal-head">
          <div className="t">{title}</div>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="关闭">
            <IconX size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export const STATUS_META: Record<DerivedAgentStatus, { label: string; dot: string }> = {
  running: { label: '执行中', dot: 'blue' },
  idle: { label: '待命', dot: 'green' },
  paused: { label: '已暂停', dot: 'orange' },
  starting: { label: '启动中', dot: 'orange' },
  error: { label: '需要关注', dot: 'red' }
};

export const TASK_STATUS_META: Record<TaskStatus, { label: string; tag: string }> = {
  QUEUED: { label: '排队中', tag: 'gray' },
  RUNNING: { label: '执行中', tag: 'blue' },
  WAITING_APPROVAL: { label: '待审批', tag: 'orange' },
  PAUSED: { label: '已暂停', tag: 'orange' },
  COMPLETED: { label: '已完成', tag: 'green' },
  FAILED: { label: '失败', tag: 'red' },
  CANCELLED: { label: '已取消', tag: 'gray' },
  INTERRUPTED: { label: '已中断', tag: 'red' }
};

export function AgentAvatar({ color, size = 64 }: { color: string; size?: number }) {
  return (
    <div
      className="agent-avatar"
      style={{ width: size, height: size, background: `${color}22`, color, fontSize: size * 0.46 }}
    >
      <IconRobot size={size * 0.55} />
    </div>
  );
}

export function ProgressBar({ percent, color = 'var(--success)' }: { percent: number; color?: string }) {
  return (
    <div className="progress-track">
      <div className="progress-fill" style={{ width: `${Math.min(100, Math.max(0, percent))}%`, background: color }} />
    </div>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10));
  return `${(bytes / 2 ** (i * 10)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}天 ${h}小时 ${m}分钟`;
  if (h > 0) return `${h}小时 ${m}分钟`;
  return `${m}分钟`;
}

export function todayText(): string {
  const d = new Date();
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${week}`;
}
