/** 纯 SVG 图形组件：圆环进度 / 迷你趋势曲线（零图表库依赖） */
import { useId } from 'react';

export function RingGauge({
  percent, size = 130, stroke = 11, color = 'var(--accent)',
  trackColor = 'var(--ring-track)', children
}: {
  percent: number | null;
  size?: number;
  stroke?: number;
  color?: string;
  trackColor?: string;
  children?: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const offset = c - (p / 100) * c;
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={trackColor} strokeWidth={stroke} />
        {percent !== null && (
          <circle
            cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke={color} strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={c} strokeDashoffset={offset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            style={{ transition: 'stroke-dashoffset 0.6s ease' }}
          />
        )}
      </svg>
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', textAlign: 'center'
      }}>
        {children}
      </div>
    </div>
  );
}

/** 最近10分钟趋势曲线（面积渐变 + 线） */
export function Sparkline({
  data, width = 240, height = 64, color = '#4d6bfe', max = 100
}: {
  data: (number | null)[];
  width?: number;
  height?: number;
  color?: string;
  max?: number;
}) {
  const gid = useId();
  const valid = data.filter((v): v is number => v !== null);
  if (valid.length < 2) {
    return <div style={{ width, height, display: 'grid', placeItems: 'center', color: 'var(--text-3)', fontSize: 11 }}>采集中…</div>;
  }
  const pad = 4;
  const stepX = (width - pad * 2) / (valid.length - 1);
  const pts = valid.map((v, i) => {
    const x = pad + i * stepX;
    const y = height - pad - (Math.min(max, v) / max) * (height - pad * 2);
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${height - pad} L${pts[0][0].toFixed(1)},${height - pad} Z`;
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {/* 50% / 100% 参考线 */}
      {[0.5, 1].map((f) => (
        <line key={f} x1={pad} x2={width - pad} y1={height - pad - f * (height - pad * 2)} y2={height - pad - f * (height - pad * 2)}
          stroke="var(--divider)" strokeDasharray="3 4" strokeWidth="1" />
      ))}
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="3" fill={color} />
    </svg>
  );
}
