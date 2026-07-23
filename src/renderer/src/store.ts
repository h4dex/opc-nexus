import { create } from 'zustand';
import type { Snapshot, ResourcePayload } from '../../preload/index';

export type RouteKey = 'dashboard' | 'office' | 'agents' | 'tasks' | 'schedules' | 'workflows' | 'console' | 'chat' | 'teams' | 'market' | 'engines' | 'channels' | 'usage' | 'system' | 'settings';

interface AppState {
  snapshot: Snapshot | null;
  resources: ResourcePayload;
  theme: 'dark' | 'light';
  route: RouteKey;
  wizardOpen: boolean;
  deviceName: string;
  online: boolean;

  setRoute: (r: RouteKey) => void;
  setTheme: (t: 'dark' | 'light') => void;
  setWizardOpen: (v: boolean) => void;
  init: () => Promise<void>;
}

export const useApp = create<AppState>((set, get) => ({
  snapshot: null,
  resources: { history: [], health: { runtime: 'healthy', gateway: 'healthy', database: 'healthy' } },
  theme: 'dark',
  route: 'dashboard',
  wizardOpen: false,
  deviceName: 'Senke AI Box-01',
  online: true,

  setRoute: (route) => set({ route }),
  setWizardOpen: (wizardOpen) => set({ wizardOpen }),

  setTheme: (theme) => {
    document.documentElement.dataset.theme = theme;
    void window.aibox.setSetting('theme', theme);
    set({ theme });
  },

  init: async () => {
    const savedTheme = (await window.aibox.getSetting('theme')) as 'dark' | 'light' | null;
    const theme = savedTheme ?? 'dark';
    document.documentElement.dataset.theme = theme;
    set({ theme });

    const info = await window.aibox.getSystemInfo();
    set({ deviceName: info.hostname ? `${info.hostname} Box` : 'AI Box-01' });

    const [snapshot, resources] = await Promise.all([
      window.aibox.getSnapshot(),
      window.aibox.getResourceHistory()
    ]);
    set({ snapshot, resources, online: true });

    window.aibox.onSnapshot((s) => set({ snapshot: s }));
    window.aibox.onResources((r) => {
      set({ resources: r });
      const last = r.history[r.history.length - 1];
      if (last) set({ online: last.networkOnline });
    });

    void get;
  }
}));
