/** 轻量内联 SVG 图标（stroke 风格，与截图线性图标一致） */
import type { CSSProperties } from 'react';

interface IconProps {
  size?: number;
  color?: string;
  style?: CSSProperties;
}

function svg(path: string, extra?: string) {
  return function Icon({ size = 18, color = 'currentColor', style }: IconProps) {
    return (
      <svg
        width={size} height={size} viewBox="0 0 24 24" fill="none"
        stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
        style={style} aria-hidden="true"
      >
        <path d={path} />
        {extra ? <path d={extra} /> : null}
      </svg>
    );
  };
}

export const IconHome = svg('M3 10.5 12 3l9 7.5M5 9.5V21h5v-6h4v6h5V9.5');
export const IconTask = svg('M9 6h11M9 12h11M9 18h11M4 5.5l1 1 2-2M4 11.5l1 1 2-2M4 17.5l1 1 2-2');
export const IconChip = svg('M8 8h8v8H8z', 'M4 10v4M20 10v4M10 4h4M10 20h4M6 3v3M18 3v3M6 18v3M18 18v3');
export const IconPlug = svg('M9 7V3m6 4V3M7 7h10v4a5 5 0 0 1-5 5 5 5 0 0 1-5-5zM12 16v5');
export const IconMonitor = svg('M3 4h18v12H3zM8 20h8m-4-4v4');
export const IconSettings = svg('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z');
export const IconRobot = svg('M12 8V4m0 0H8m4 0h4M5 12a7 7 0 0 1 14 0v5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z', 'M9 14h.01M15 14h.01');
export const IconCpu = svg('M6 6h12v12H6z', 'M9 1v3m6-3v3M9 20v3m6-3v3M1 9h3m-3 6h3M20 9h3m-3 6h3M9.5 9.5h5v5h-5z');
export const IconMemory = svg('M4 7h16v10H4z', 'M8 7V4m4 3V4m4 3V4M8 20v-3m4 3v-3m4 3v-3M7 10v4m5-4v4m5-4v4');
export const IconGpu = svg('M3 7h13v10H3zM16 9l5-2v10l-5-2', 'M6 10.5h4v3H6z');
export const IconWifi = svg('M2.5 9a15 15 0 0 1 19 0M5.5 12.5a10.5 10.5 0 0 1 13 0M8.6 16a6 6 0 0 1 6.8 0M12 19.5h.01');
export const IconClock = svg('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3.5 2');
export const IconLayers = svg('M12 3 3 8l9 5 9-5z', 'M3 12.5l9 5 9-5M3 17l9 5 9-5');
export const IconUser = svg('M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0');
export const IconCalendar = svg('M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M8 3v4m8-4v4M4 10h16');
export const IconPlus = svg('M12 5v14M5 12h14');
export const IconCheck = svg('M5 12.5l4.5 4.5L19 7.5');
export const IconX = svg('M6 6l12 12M18 6 6 18');
export const IconPause = svg('M8 5v14M16 5v14');
export const IconPlay = svg('M7 4.5v15l12-7.5z');
export const IconStop = svg('M6 6h12v12H6z');
export const IconLog = svg('M6 3h9l5 5v13H6z', 'M14 3v6h6M9 13h6m-6 4h6');
export const IconMore = svg('M5 12h.01M12 12h.01M19 12h.01');
export const IconSun = svg('M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z', 'M12 1v3m0 16v3M4.2 4.2l2.1 2.1m11.4 11.4 2.1 2.1M1 12h3m16 0h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1');
export const IconMoon = svg('M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z');
export const IconRefresh = svg('M20 11A8 8 0 0 0 5.6 5.6L4 7m0-4v4h4M4 13a8 8 0 0 0 14.4 5.4L20 17m0 4v-4h-4');
export const IconAlert = svg('M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z');
export const IconCoffee = svg('M4 8h13v7a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zM17 9h2a2.5 2.5 0 0 1 0 5h-2M8 3.5c0 1-1 1-1 2s1 1 1 2m4-4c0 1-1 1-1 2s1 1 1 2');
export const IconSend = svg('M22 2 11 13M22 2l-7 20-4-9-9-4z');
export const IconShield = svg('M12 2 4 5.5V11c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5.5z', 'M9 11.5l2 2 4-4');
export const IconFolder = svg('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z');
export const IconDb = svg('M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3z', 'M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3');
export const IconMessage = svg('M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z');
export const IconThermo = svg('M10 13.6V4a2 2 0 1 1 4 0v9.6a4.5 4.5 0 1 1-4 0z');
export const IconFlow = svg('M5 5h4v4H5zM15 15h4v4h-4zM15 5h4v4h-4z', 'M9 7h6M7 9v6a2 2 0 0 0 2 2h6M17 13v-2');
export const IconDownload = svg('M12 3v12m0 0 5-5m-5 5-5-5', 'M5 20h14');
export const IconHistory = svg('M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5M12 7v5l3 2');
export const IconTag = svg('M3 12V4h8l10 10-8 8z', 'M7.5 8h.01');
export const IconFile = svg('M6 2h8l4 4v16H6z', 'M14 2v5h5M9 12h6m-6 4h6');
export const IconSearch = svg('M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16z', 'M17 17l4 4');
export const IconBook = svg('M4 4.5A2.5 2.5 0 0 1 6.5 2H11v18H6.5A2.5 2.5 0 0 0 4 22z', 'M20 4.5A2.5 2.5 0 0 0 17.5 2H13v18h4.5A2.5 2.5 0 0 1 20 22z');
export const IconPin = svg('M9 3h6l-1 5 3 3v2H7v-2l3-3z', 'M12 13v8');
export const IconArchive = svg('M4 7h16v13H4zM3 3h18v4H3z', 'M9 11h6');
export const IconTrash = svg('M4 7h16M9 7V4h6v3m-9 0 1 14h10l1-14', 'M10 11v6m4-6v6');
export const IconEdit = svg('M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4M4 20h16');
