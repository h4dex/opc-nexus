import { create } from 'zustand';
import type { Snapshot, ResourcePayload } from '../../preload/index';
import type { ActionCenterOverview, SearchEntityType, SearchRoute } from '../../shared/types';
import { appendResourceUpdate, mergeResourceHistory } from './utils/resourceHistory';

export type RouteKey = 'dashboard' | 'quest' | 'projects' | 'office' | 'inbox' | 'deliverables' | 'knowledge' | 'agents' | 'tasks' | 'schedules' | 'workflows' | 'console' | 'mobile' | 'teams' | 'collab' | 'market' | 'engines' | 'channels' | 'mcp' | 'skills' | 'plugins' | 'usage' | 'system' | 'settings';

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
  questProjectId: string | null;
  questEmployeeId: string | null;

  setRoute: (r: RouteKey) => void;
  openQuest: (projectId?: string | null, employeeId?: string | null) => void;
  clearQuestEmployee: () => void;
  navigate: (route: SearchRoute, target?: Omit<NavigationTarget, 'nonce'>) => void;
  clearNavigationTarget: () => void;
  refreshActionCenter: () => Promise<void>;
  setTheme: (t: 'dark' | 'light') => void;
  setWizardOpen: (v: boolean) => void;
  init: () => Promise<void>;
}

let initPromise: Promise<void> | null = null;
let unsubscribeSnapshot: (() => void) | null = null;
let unsubscribeResources: (() => void) | null = null;

export function disposeAppSubscriptions(): void {
  unsubscribeSnapshot?.();
  unsubscribeResources?.();
  unsubscribeSnapshot = null;
  unsubscribeResources = null;
  initPromise = null;
}

export const useApp = create<AppState>((set) => ({
  snapshot: null,
  resources: { history: [], health: { runtime: 'offline', gateway: 'offline', database: 'offline' } },
  theme: 'dark',
  route: 'projects',
  wizardOpen: false,
  deviceName: 'Senke AI Box-01',
  online: false,
  appVersion: '2.0.0',
  actionCenter: null,
  navigationTarget: null,
  questProjectId: null,
  questEmployeeId: null,

  setRoute: (route) => set({ route, navigationTarget: null }),
  openQuest: (questProjectId = null, questEmployeeId = null) => set({ route: 'quest', questProjectId, questEmployeeId, navigationTarget: null }),
  clearQuestEmployee: () => set({ questEmployeeId: null }),
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

  init: () => {
    if (initPromise) return initPromise;

    initPromise = (async () => {
      unsubscribeSnapshot ??= window.aibox.onSnapshot((snapshot) => {
        set((state) => state.snapshot && state.snapshot.version >= snapshot.version ? state : { snapshot });
      });
      unsubscribeResources ??= window.aibox.onResources((update) => {
        set((state) => ({
          resources: appendResourceUpdate(state.resources, update),
          online: update.sample.networkOnline
        }));
      });

      const [savedTheme, info, appVersion, snapshot, resources, actionCenter] = await Promise.all([
        window.aibox.getSetting('theme') as Promise<'dark' | 'light' | null>,
        window.aibox.getSystemInfo(),
        window.aibox.getAppVersion(),
        window.aibox.getSnapshot(),
        window.aibox.getResourceHistory(),
        window.aibox.getActionCenter()
      ]);
      const theme = savedTheme ?? 'dark';
      document.documentElement.dataset.theme = theme;
      set((state) => {
        const mergedResources = mergeResourceHistory(resources, state.resources);
        return {
          theme,
          deviceName: info.hostname ? `${info.hostname} Box` : 'AI Box-01',
          appVersion,
          snapshot: state.snapshot && state.snapshot.version > snapshot.version ? state.snapshot : snapshot,
          resources: mergedResources,
          actionCenter,
          online: mergedResources.history.at(-1)?.networkOnline ?? false
        };
      });
    })().catch((error) => {
      disposeAppSubscriptions();
      throw error;
    });

    return initPromise;
  }
}));

if (import.meta.hot) import.meta.hot.dispose(disposeAppSubscriptions);
