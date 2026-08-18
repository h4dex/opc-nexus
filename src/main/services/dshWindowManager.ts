import {
  BrowserWindow,
  shell,
  type BrowserWindowConstructorOptions,
  type DownloadItem,
  type Event,
  type Session,
  type WebContents
} from 'electron';
import type { DshDesktopSession } from './dshWebGateway.js';
import type { DshBrowserSessionScope } from './dshSessionWriteCoordinator.js';
import { isAllowedExternalUrl } from './navigationPolicy.js';

export const DSH_WORKBENCH_PARTITION = 'persist:opc-nexus-dsh-workbench';

export interface DshWindowGateway {
  createDesktopSession(scope?: DshBrowserSessionScope | null): DshDesktopSession;
  revokeDesktopSession(id: string): boolean;
  isGatewayUrl(value: string): boolean;
}

export interface DshWindowManagerOptions {
  partition?: string;
  title?: string;
  createWindow?: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  openExternal?: (url: string) => Promise<void>;
}

export interface DshWindowStatus {
  open: boolean;
  visible: boolean;
  loading: boolean;
}

interface DownloadGuard {
  session: Session;
  listener: (event: Event, item: DownloadItem, webContents: WebContents) => void;
}

export function isAllowedDshDownloadUrl(value: string, gateway: Pick<DshWindowGateway, 'isGatewayUrl'>): boolean {
  if (gateway.isGatewayUrl(value)) return true;
  if (!value.startsWith('blob:')) return false;
  try { return gateway.isGatewayUrl(value.slice('blob:'.length)); }
  catch { return false; }
}

/** Isolated shell for the official DSH Web UI. It never receives the Nexus preload. */
export class DshWindowManager {
  private readonly partition: string;
  private readonly title: string;
  private readonly createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  private readonly openExternal: (url: string) => Promise<void>;
  private window: BrowserWindow | null = null;
  private desktopSessionId: string | null = null;
  private downloadGuard: DownloadGuard | null = null;
  private openPromise: Promise<DshWindowStatus> | null = null;

  constructor(
    private readonly gateway: DshWindowGateway,
    options: DshWindowManagerOptions = {}
  ) {
    this.partition = options.partition ?? DSH_WORKBENCH_PARTITION;
    if (!this.partition.startsWith('persist:') || this.partition.length <= 'persist:'.length) {
      throw new Error('DSH Workbench requires an independent persistent Electron partition');
    }
    this.title = options.title ?? 'DeepSeek Harness Workbench';
    this.createWindow = options.createWindow ?? ((windowOptions) => new BrowserWindow(windowOptions));
    this.openExternal = options.openExternal ?? ((url) => shell.openExternal(url));
  }

  getStatus(): DshWindowStatus {
    const window = this.liveWindow();
    return {
      open: window !== null,
      visible: window?.isVisible() ?? false,
      loading: this.openPromise !== null
    };
  }

  async open(): Promise<DshWindowStatus> {
    const existing = this.liveWindow();
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return this.getStatus();
    }
    if (this.openPromise) return this.openPromise;

    let opening!: Promise<DshWindowStatus>;
    const finalized = this.createAndLoadWindow().finally(() => {
      if (this.openPromise === opening) this.openPromise = null;
    });
    opening = finalized.then(() => this.getStatus());
    this.openPromise = opening;
    return opening;
  }

  close(): void {
    const window = this.liveWindow();
    if (!window) return;
    window.close();
  }

  private liveWindow(): BrowserWindow | null {
    if (this.window?.isDestroyed()) {
      this.releaseWindow(this.window);
      return null;
    }
    return this.window;
  }

  private async createAndLoadWindow(): Promise<void> {
    const desktopSession = this.gateway.createDesktopSession();
    const window = this.createWindow({
      width: 1320,
      height: 860,
      minWidth: 960,
      minHeight: 640,
      show: false,
      autoHideMenuBar: true,
      title: this.title,
      backgroundColor: '#101214',
      webPreferences: {
        partition: this.partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        navigateOnDragDrop: false
      }
    });
    this.window = window;
    this.desktopSessionId = desktopSession.id;
    this.configureSecurity(window);

    try {
      await window.loadURL(desktopSession.url);
      if (window.isDestroyed()) throw new Error('DSH Workbench closed while loading');
      window.show();
      window.focus();
    } catch (error) {
      this.releaseWindow(window);
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
  }

  private configureSecurity(window: BrowserWindow): void {
    const contents = window.webContents;
    const guardNavigation = (event: Event, legacyUrl?: string) => {
      const url = legacyUrl ?? (event as Event & { url?: string }).url ?? '';
      if (this.gateway.isGatewayUrl(url)) return;
      event.preventDefault();
      if ((event as Event & { isMainFrame?: boolean }).isMainFrame !== false) this.openInSystemBrowser(url);
    };
    contents.on('will-navigate', guardNavigation);
    contents.on('will-redirect', guardNavigation);
    contents.on('will-frame-navigate', (event) => {
      if (event.isMainFrame || this.gateway.isGatewayUrl(event.url)) return;
      event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (this.gateway.isGatewayUrl(url)) {
        void contents.loadURL(url).catch(() => undefined);
      } else {
        this.openInSystemBrowser(url);
      }
      return { action: 'deny' };
    });

    const electronSession = contents.session;
    electronSession.setPermissionRequestHandler((_requestingContents, _permission, callback) => callback(false));
    const downloadListener = (event: Event, item: DownloadItem, source: WebContents) => {
      if (source !== contents) return;
      if (!isAllowedDshDownloadUrl(item.getURL(), this.gateway)) event.preventDefault();
    };
    electronSession.on('will-download', downloadListener);
    this.downloadGuard = { session: electronSession, listener: downloadListener };

    window.once('closed', () => this.releaseWindow(window));
  }

  private openInSystemBrowser(url: string): void {
    if (!isAllowedExternalUrl(url) || this.gateway.isGatewayUrl(url)) return;
    void this.openExternal(url).catch(() => undefined);
  }

  private releaseWindow(window: BrowserWindow): void {
    if (this.window !== window) return;
    if (this.downloadGuard) {
      this.downloadGuard.session.removeListener('will-download', this.downloadGuard.listener);
      this.downloadGuard.session.setPermissionRequestHandler(null);
      this.downloadGuard = null;
    }
    this.window = null;
    if (this.desktopSessionId) this.gateway.revokeDesktopSession(this.desktopSessionId);
    this.desktopSessionId = null;
  }
}
