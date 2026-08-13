import { create } from 'zustand';
import type { Snapshot, ResourcePayload } from '../../preload/index';
import type { ActionCenterOverview, SearchEntityType, SearchRoute } from '../../shared/types';

export type RouteKey = 'dashboard' | 'projects' | 'office' | 'inbox' | 'deliverables' | 'knowledge' | 'agents' | 'tasks' | 'schedules' | 'workflows' | 'console' | 'mobile' | 'chat' | 'teams' | 'collab' | 'market' | 'engines' | 'channels' | 'mcp' | 'skills' | 'usage' | 'system' | 'settings';

export interface NavigationTarget {
  entityType: SearchEntityType;
  entityId: string;
  nonce: number;
}

interface AppState {
  snapshot: Snapshot | null;
  resources: ResourcePayload;
  theme: 'dark' | 'light';
  route: RouteKey;
  wizardOpen: boolean;
  deviceName: string;
  online: boolean;
  appVersion: string;
  actionCenter: ActionCenterOverview | null;
  navigationTarget: NavigationTarget | null;

  setRoute: (r: RouteKey) => void;
  navigate: (route: SearchRoute, target?: Omit<NavigationTarget, 'nonce'>) => void;
  clearNavigationTarget: () => void;
  refreshActionCenter: () => Promise<void>;
  setTheme: (t: 'dark' | 'light') => void;
  setWizardOpen: (v: boolean) => void;
  init: () => Promise<void>;
}

export const useApp = create<AppState>((set) => ({
  snapshot: null,
  resources: { history: [], health: { runtime: 'healthy', gateway: 'healthy', database: 'healthy' } },
  theme: 'dark',
  route: 'dashboard',
  wizardOpen: false,
  deviceName: 'Senke AI Box-01',
  online: true,
  appVersion: '1.0.0',
  actionCenter: null,
  navigationTarget: null,

  setRoute: (route) => set({ route, navigationTarget: null }),
  navigate: (route, target) => set({
    route,
    navigationTarget: target ? { ...target, nonce: Date.now() } : null
  }),
  clearNavigationTarget: () => set({ navigationTarget: null }),
  refreshActionCenter: async () => {
    try { set({ actionCenter: await window.aibox.getActionCenter() }); } catch { /* 主进程重启期间保留旧值 */ }
  },
  setWizardOpen: (wizardOpen) => set({ wizardOpen }),

  setTheme: (theme) => {
    document.documentElement.dataset.theme = theme;
    void window.aibox.setSetting('theme', theme);
    set({ theme });
  },

  init: async () => {
    // 防止 HMR 重载时重复注册监听器
    if (useApp.getState().snapshot) return;

    const savedTheme = (await window.aibox.getSetting('theme')) as 'dark' | 'light' | null;
    const theme = savedTheme ?? 'dark';
    document.documentElement.dataset.theme = theme;
    set({ theme });

    const info = await window.aibox.getSystemInfo();
    set({ deviceName: info.hostname ? `${info.hostname} Box` : 'AI Box-01' });

    void window.aibox.getAppVersion().then((v) => set({ appVersion: v })).catch(() => {});

    const [snapshot, resources, actionCenter] = await Promise.all([
      window.aibox.getSnapshot(),
      window.aibox.getResourceHistory(),
      window.aibox.getActionCenter()
    ]);
    set({ snapshot, resources, actionCenter, online: true });

    window.aibox.onSnapshot((s) => set({ snapshot: s }));
    window.aibox.onResources((r) => {
      set({ resources: r });
      const last = r.history[r.history.length - 1];
      if (last) set({ online: last.networkOnline });
    });
  }
}));
