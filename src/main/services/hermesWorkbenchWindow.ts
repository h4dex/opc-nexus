import { BrowserWindow, shell, type BrowserWindowConstructorOptions } from 'electron';
import { isAllowedExternalUrl } from './navigationPolicy.js';
import type { HermesRuntimeStatus, HermesUiLease } from '../../shared/types.js';
import { HermesServiceManager } from './hermesServiceManager.js';
import { hermesThemeCss } from './hermesEmbeddedWorkbench.js';

export interface HermesWorkbenchWindowStatus {
  open: boolean;
  visible: boolean;
  loading: boolean;
  projectId: string | null;
  runtime: HermesRuntimeStatus | null;
}

export interface HermesWorkbenchWindowOptions {
  createWindow?: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  openExternal?: (url: string) => void | Promise<void>;
}

/** Main-owned BrowserWindow for the unmodified Hermes Web UI. */
export class HermesWorkbenchWindowManager {
  private readonly createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  private readonly openExternal: (url: string) => void | Promise<void>;
  private window: BrowserWindow | null = null;
  private projectId: string | null = null;
  private lease: HermesUiLease | null = null;
  private opening: Promise<HermesWorkbenchWindowStatus> | null = null;
  private readonly conversationWindows = new Map<string, {
    window: BrowserWindow;
    projectId: string;
    lease: HermesUiLease;
  }>();

  constructor(private readonly services: HermesServiceManager, options: HermesWorkbenchWindowOptions = {}) {
    this.createWindow = options.createWindow ?? ((windowOptions) => new BrowserWindow(windowOptions));
    this.openExternal = options.openExternal ?? ((url) => shell.openExternal(url));
  }

  getStatus(): HermesWorkbenchWindowStatus {
    const window = this.liveWindow();
    return {
      open: window !== null,
      visible: window?.isVisible() ?? false,
      loading: this.opening !== null,
      projectId: window ? this.projectId : null,
      runtime: this.projectId ? this.services.getStatus(this.projectId) : null
    };
  }

  async open(projectId: string): Promise<HermesWorkbenchWindowStatus> {
    const existing = this.liveWindow();
    if (existing && this.projectId === projectId) {
      this.focus(existing);
      return this.getStatus();
    }
    if (existing) this.close();
    const opening = this.openInternal(projectId);
    this.opening = opening;
    try { return await opening; }
    finally { if (this.opening === opening) this.opening = null; }
  }

  close(): HermesWorkbenchWindowStatus {
    const window = this.liveWindow();
    if (window) window.close();
    else this.release();
    return this.getStatus();
  }

  async stopProject(projectId: string): Promise<void> {
    if (this.projectId === projectId) this.close();
    for (const [key, entry] of this.conversationWindows) {
      if (entry.projectId !== projectId) continue;
      this.conversationWindows.delete(key);
      this.services.revokeUiLease(entry.projectId, entry.lease.leaseId);
      if (!entry.window.isDestroyed()) entry.window.close();
    }
    await this.services.stop(projectId);
  }

  async openConversation(
    projectId: string,
    conversationId: string,
    theme: 'dark' | 'light'
  ): Promise<void> {
    if (!/^hermes-conversation-[A-Za-z0-9-]{8,100}$/.test(conversationId)) {
      throw new Error('Hermes conversation identity is invalid');
    }
    const key = `${projectId}:${conversationId}`;
    const existing = this.conversationWindows.get(key);
    if (existing && !existing.window.isDestroyed() && !existing.window.webContents.isDestroyed()) {
      this.focus(existing.window);
      return;
    }
    if (existing) this.conversationWindows.delete(key);
    await this.services.start(projectId);
    const lease = this.services.createUiLease(projectId);
    const cookie = this.services.cookieForLease(projectId, lease);
    const url = new URL(lease.url);
    url.searchParams.set('conversationId', conversationId);
    const origin = url.origin;
    const window = this.createWindow({
      width: 1180,
      height: 780,
      minWidth: 720,
      minHeight: 520,
      title: 'Quest · Hermes 会话',
      autoHideMenuBar: true,
      backgroundColor: theme === 'dark' ? '#0b0e14' : '#f7f8fa',
      webPreferences: {
        partition: `persist:aibox-hermes-${projectId}`,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        navigateOnDragDrop: false
      }
    });
    this.conversationWindows.set(key, { window, projectId, lease });
    const contents = window.webContents;
    const guard = (event: Electron.Event, target: string) => {
      try {
        if (new URL(target).origin === origin) return;
      } catch { /* Block malformed navigation below. */ }
      event.preventDefault();
      if (isAllowedExternalUrl(target)) void Promise.resolve(this.openExternal(target)).catch(() => undefined);
    };
    window.webContents.on('will-navigate', guard);
    window.webContents.setWindowOpenHandler(({ url: target }) => {
      try {
        if (new URL(target).origin === origin) void window.loadURL(target).catch(() => undefined);
        else if (isAllowedExternalUrl(target)) void Promise.resolve(this.openExternal(target)).catch(() => undefined);
      } catch { /* Deny malformed target. */ }
      return { action: 'deny' };
    });
    window.once('closed', () => {
      if (!contents.isDestroyed()) contents.removeListener('will-navigate', guard);
      const current = this.conversationWindows.get(key);
      if (current?.window === window) {
        this.conversationWindows.delete(key);
        this.services.revokeUiLease(projectId, lease.leaseId);
      }
    });
    try {
      await window.webContents.session.cookies.set({
        url: lease.url,
        name: cookie.name,
        value: cookie.value,
        httpOnly: true,
        sameSite: 'strict',
        expirationDate: lease.expiresAt / 1_000
      });
      await window.loadURL(url.toString());
      await window.webContents.insertCSS(hermesThemeCss(theme));
      await window.webContents.executeJavaScript(`
        window.__OPC_NEXUS_THEME__ = ${JSON.stringify(theme)};
        document.documentElement.classList.toggle('dark', ${theme === 'dark'});
        document.documentElement.dataset.theme = ${JSON.stringify(theme)};
        document.documentElement.lang = 'zh-CN';
        window.dispatchEvent(new CustomEvent('opc-nexus-theme-change', { detail: ${JSON.stringify(theme)} }));
      `, false);
      this.focus(window);
    } catch (error) {
      const current = this.conversationWindows.get(key);
      if (current?.window === window) this.conversationWindows.delete(key);
      this.services.revokeUiLease(projectId, lease.leaseId);
      if (!window.isDestroyed()) window.close();
      throw error;
    }
  }

  private async openInternal(projectId: string): Promise<HermesWorkbenchWindowStatus> {
    const runtime = await this.services.start(projectId);
    const lease = this.services.createUiLease(projectId);
    const cookie = this.services.cookieForLease(projectId, lease);
    const partition = `persist:aibox-hermes-${projectId}`;
    const window = this.createWindow({
      width: 1440,
      height: 900,
      minWidth: 960,
      minHeight: 640,
      title: `Hermes Workbench · ${projectId}`,
      autoHideMenuBar: true,
      backgroundColor: '#0f1218',
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        navigateOnDragDrop: false
      }
    });
    this.window = window;
    this.projectId = projectId;
    this.lease = lease;
    const origin = new URL(lease.url).origin;
    const contents = window.webContents;
    const guard = (event: Electron.Event, url: string) => {
      if (url === lease.url || url.startsWith(`${origin}/`)) return;
      event.preventDefault();
      if (isAllowedExternalUrl(url)) void Promise.resolve(this.openExternal(url)).catch(() => undefined);
    };
    window.webContents.on('will-navigate', guard);
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(`${origin}/`)) {
        void window.loadURL(url).catch(() => undefined);
      } else if (isAllowedExternalUrl(url)) {
        void Promise.resolve(this.openExternal(url)).catch(() => undefined);
      }
      return { action: 'deny' };
    });
    window.once('closed', () => {
      if (!contents.isDestroyed()) contents.removeListener('will-navigate', guard);
      this.release();
    });
    try {
      await window.webContents.session.cookies.set({
        url: lease.url,
        name: cookie.name,
        value: cookie.value,
        httpOnly: true,
        sameSite: 'strict',
        expirationDate: lease.expiresAt / 1_000
      });
      await window.loadURL(lease.url);
      this.focus(window);
      return this.getStatus();
    } catch (error) {
      if (!window.isDestroyed()) window.close();
      throw error;
    }
  }

  private release(): void {
    if (this.projectId && this.lease) this.services.revokeUiLease(this.projectId, this.lease.leaseId);
    this.window = null;
    this.projectId = null;
    this.lease = null;
  }

  private liveWindow(): BrowserWindow | null {
    if (!this.window || this.window.isDestroyed() || this.window.webContents.isDestroyed()) {
      this.release();
      return null;
    }
    return this.window;
  }

  private focus(window: BrowserWindow): void {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
}
