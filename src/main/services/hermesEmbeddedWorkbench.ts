import {
  WebContentsView,
  shell,
  type BrowserWindow,
  type Event,
  type Rectangle,
  type WebContentsViewConstructorOptions
} from 'electron';
import type { HermesEmbeddedWorkbenchStatus, HermesUiLease } from '../../shared/types.js';
import { isAllowedExternalUrl } from './navigationPolicy.js';
import { HermesServiceManager } from './hermesServiceManager.js';

const MIN_WORKBENCH_WIDTH = 320;
const MIN_WORKBENCH_HEIGHT = 240;

function validateWorkbenchBounds(value: Rectangle): Rectangle {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)
    || !Number.isFinite(value.width) || !Number.isFinite(value.height)
    || value.x < 0 || value.y < 0 || value.width < MIN_WORKBENCH_WIDTH
    || value.height < MIN_WORKBENCH_HEIGHT) {
    throw new Error(`Hermes 嵌入区域不得小于 ${MIN_WORKBENCH_WIDTH}x${MIN_WORKBENCH_HEIGHT}`);
  }
  return { x: Math.trunc(value.x), y: Math.trunc(value.y), width: Math.trunc(value.width), height: Math.trunc(value.height) };
}

export interface HermesEmbeddedWorkbenchOptions {
  createView?: (options: WebContentsViewConstructorOptions) => WebContentsView;
  openExternal?: (url: string) => void | Promise<void>;
}

export function hermesThemeCss(theme: 'dark' | 'light'): string {
  const dark = theme === 'dark';
  return `
    :root {
      color-scheme: ${theme};
      --background: ${dark ? '#0b0e14' : '#f7f8fa'} !important;
      --background-base: ${dark ? '#0b0e14' : '#f7f8fa'} !important;
      --midground: ${dark ? '#eef2fc' : '#182033'} !important;
      --midground-base: ${dark ? '#eef2fc' : '#182033'} !important;
      --foreground: #4d6bfe !important;
      --foreground-base: #4d6bfe !important;
      --color-primary: #4d6bfe !important;
      --color-primary-foreground: #ffffff !important;
      --color-ring: #4d6bfe !important;
      --theme-font-sans: Inter, "Microsoft YaHei UI", "Segoe UI", sans-serif !important;
      --theme-font-mono: "Cascadia Mono", Consolas, monospace !important;
      --theme-letter-spacing: 0 !important;
      --theme-radius: 0.5rem !important;
    }
    html, body, #root { background: var(--background-base) !important; letter-spacing: 0 !important; }
    button, input, textarea, select { letter-spacing: 0 !important; }
  `;
}

/** Secure, Main-owned embedded surface for one project-scoped Hermes Web UI. */
export class HermesEmbeddedWorkbenchManager {
  private readonly createView: (options: WebContentsViewConstructorOptions) => WebContentsView;
  private readonly openExternal: (url: string) => void | Promise<void>;
  private view: WebContentsView | null = null;
  private host: BrowserWindow | null = null;
  private projectId: string | null = null;
  private lease: HermesUiLease | null = null;
  private origin: string | null = null;
  private opening: Promise<HermesEmbeddedWorkbenchStatus> | null = null;
  private requestedVisible = true;
  private ready = false;
  private generation = 0;
  private cleanup: (() => void) | null = null;
  private theme: 'dark' | 'light' = 'dark';
  private conversationId: string | null = null;
  private insertedCssKey: string | null = null;

  constructor(
    private readonly services: HermesServiceManager,
    options: HermesEmbeddedWorkbenchOptions = {}
  ) {
    this.createView = options.createView ?? ((viewOptions) => new WebContentsView(viewOptions));
    this.openExternal = options.openExternal ?? ((url) => shell.openExternal(url));
  }

  getStatus(): HermesEmbeddedWorkbenchStatus {
    const view = this.liveView();
    const attached = Boolean(view && this.host && !this.host.isDestroyed() && !this.host.webContents.isDestroyed());
    return {
      open: view !== null,
      attached,
      visible: attached && view ? view.getVisible() : false,
      loading: this.opening !== null,
      bounds: view ? { ...view.getBounds() } : null,
      projectId: view ? this.projectId : null,
      runtime: this.projectId ? this.services.getStatus(this.projectId) : null
    };
  }

  async open(
    host: BrowserWindow,
    projectId: string,
    bounds: Rectangle,
    theme: 'dark' | 'light',
    conversationId?: string
  ): Promise<HermesEmbeddedWorkbenchStatus> {
    this.assertHost(host);
    const safeBounds = validateWorkbenchBounds(bounds);
    this.theme = theme;
    const existing = this.liveView();
    if (existing && this.projectId === projectId) {
      this.attach(existing, host);
      existing.setBounds(safeBounds);
      if (conversationId && this.conversationId !== conversationId) {
        if (this.opening) await this.opening;
        const current = this.liveView();
        if (!current || this.projectId !== projectId) throw new Error('Hermes embedded Workbench closed while selecting a conversation');
        await this.selectConversation(current, conversationId);
        this.conversationId = conversationId;
      }
      await this.applyTheme(existing);
      this.applyVisibility(existing);
      return this.opening ?? this.getStatus();
    }
    this.close();
    const generation = ++this.generation;
    let pending!: Promise<HermesEmbeddedWorkbenchStatus>;
    pending = this.createAndLoad(host, projectId, safeBounds, generation, conversationId)
      .then(() => this.getStatus())
      .finally(() => { if (this.opening === pending) this.opening = null; });
    this.opening = pending;
    return pending;
  }

  setBounds(bounds: Rectangle): HermesEmbeddedWorkbenchStatus {
    this.liveView()?.setBounds(validateWorkbenchBounds(bounds));
    return this.getStatus();
  }

  setVisible(visible: boolean): HermesEmbeddedWorkbenchStatus {
    this.requestedVisible = visible;
    const view = this.liveView();
    if (view) this.applyVisibility(view);
    return this.getStatus();
  }

  async setTheme(theme: 'dark' | 'light'): Promise<HermesEmbeddedWorkbenchStatus> {
    this.theme = theme;
    const view = this.liveView();
    if (view) await this.applyTheme(view);
    return this.getStatus();
  }

  close(): HermesEmbeddedWorkbenchStatus {
    const view = this.view;
    this.generation += 1;
    this.opening = null;
    if (view) this.release(view, true);
    return this.getStatus();
  }

  private async createAndLoad(host: BrowserWindow, projectId: string, bounds: Rectangle, generation: number, conversationId?: string): Promise<void> {
    await this.services.startForUi(projectId);
    const lease = this.services.createUiLease(projectId);
    const cookie = this.services.cookieForLease(projectId, lease);
    const view = this.createView({
      webPreferences: {
        partition: `persist:aibox-hermes-embedded-${projectId}`,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        navigateOnDragDrop: false
      }
    });
    this.view = view;
    this.projectId = projectId;
    this.conversationId = conversationId ?? null;
    this.lease = lease;
    this.origin = new URL(lease.url).origin;
    this.ready = false;
    view.setBounds(bounds);
    view.setVisible(false);
    this.configureSecurity(view);
    this.attach(view, host);
    try {
      await view.webContents.session.cookies.set({
        url: lease.url,
        name: cookie.name,
        value: cookie.value,
        httpOnly: true,
        sameSite: 'strict',
        expirationDate: lease.expiresAt / 1_000
      });
      const workbenchUrl = new URL(lease.url);
      workbenchUrl.pathname = '/chat';
      if (conversationId) workbenchUrl.searchParams.set('conversationId', conversationId);
      await view.webContents.loadURL(workbenchUrl.toString());
      this.assertCurrent(view, generation);
      await this.applyTheme(view);
      this.assertCurrent(view, generation);
      this.ready = true;
      this.applyVisibility(view);
    } catch (error) {
      this.release(view, true);
      throw error;
    }
  }

  private configureSecurity(view: WebContentsView): void {
    const contents = view.webContents;
    const guard = (event: Event, legacyUrl?: string) => {
      const url = legacyUrl ?? (event as Event & { url?: string }).url ?? '';
      if (this.isAllowed(url)) return;
      event.preventDefault();
      if (isAllowedExternalUrl(url)) void Promise.resolve(this.openExternal(url)).catch(() => undefined);
    };
    const blockPermission = (_contents: Electron.WebContents, _permission: string, callback: (allowed: boolean) => void) => callback(false);
    const destroyed = () => this.release(view, false);
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (this.isAllowed(url)) void contents.loadURL(url).catch(() => undefined);
      else if (isAllowedExternalUrl(url)) void Promise.resolve(this.openExternal(url)).catch(() => undefined);
      return { action: 'deny' };
    });
    contents.session.setPermissionRequestHandler(blockPermission);
    contents.once('destroyed', destroyed);
    this.cleanup = () => {
      contents.removeListener('will-navigate', guard);
      contents.removeListener('will-redirect', guard);
      contents.removeListener('destroyed', destroyed);
      contents.session.setPermissionRequestHandler(null);
    };
  }

  private attach(view: WebContentsView, host: BrowserWindow): void {
    if (this.host === host) return;
    if (this.host && !this.host.isDestroyed()) this.host.contentView.removeChildView(view);
    host.contentView.addChildView(view);
    this.host = host;
    host.once('closed', () => this.release(view, true));
  }

  private async applyTheme(view: WebContentsView): Promise<void> {
    if (view.webContents.isDestroyed()) return;
    if (this.insertedCssKey) {
      await view.webContents.removeInsertedCSS(this.insertedCssKey).catch(() => undefined);
      this.insertedCssKey = null;
    }
    this.insertedCssKey = await view.webContents.insertCSS(hermesThemeCss(this.theme));
    await view.webContents.executeJavaScript(`
      window.__OPC_NEXUS_THEME__ = ${JSON.stringify(this.theme)};
      document.documentElement.classList.toggle('dark', ${this.theme === 'dark'});
      document.documentElement.dataset.theme = ${JSON.stringify(this.theme)};
      document.documentElement.lang = 'zh-CN';
      window.dispatchEvent(new CustomEvent('opc-nexus-theme-change', { detail: ${JSON.stringify(this.theme)} }));
    `, false);
  }

  private async selectConversation(view: WebContentsView, conversationId: string): Promise<void> {
    if (view.webContents.isDestroyed()) throw new Error('Hermes embedded Workbench is unavailable');
    const acknowledged = await view.webContents.executeJavaScript(`
      window.dispatchEvent(new CustomEvent('opc-nexus-conversation-change', {
        detail: { conversationId: ${JSON.stringify(conversationId)} }
      }));
      document.documentElement.dataset.nexusConversationId === ${JSON.stringify(conversationId)};
    `, false);
    if (acknowledged !== true) throw new Error('Hermes Web UI did not acknowledge the employee conversation');
  }

  private isAllowed(url: string): boolean {
    if (!this.origin) return false;
    try { return new URL(url).origin === this.origin; }
    catch { return false; }
  }

  private liveView(): WebContentsView | null {
    const view = this.view;
    if (!view) return null;
    if (view.webContents.isDestroyed() || this.host?.isDestroyed() || this.host?.webContents.isDestroyed()) {
      this.release(view, !view.webContents.isDestroyed());
      return null;
    }
    return view;
  }

  private release(view: WebContentsView, destroy: boolean): void {
    if (this.view !== view) return;
    this.ready = false;
    this.opening = null;
    this.cleanup?.();
    this.cleanup = null;
    if (this.host && !this.host.isDestroyed()) this.host.contentView.removeChildView(view);
    this.host = null;
    if (this.projectId && this.lease) this.services.revokeUiLease(this.projectId, this.lease.leaseId);
    this.projectId = null;
    this.conversationId = null;
    this.lease = null;
    this.origin = null;
    this.view = null;
    this.insertedCssKey = null;
    if (destroy && !view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
  }

  private assertCurrent(view: WebContentsView, generation: number): void {
    if (generation !== this.generation || this.view !== view || view.webContents.isDestroyed()) {
      throw new Error('Hermes embedded Workbench closed while loading');
    }
  }

  private assertHost(host: BrowserWindow): void {
    if (host.isDestroyed() || host.webContents.isDestroyed()) throw new Error('Quest host window is unavailable');
  }

  private applyVisibility(view: WebContentsView): void {
    const visible = this.ready && this.requestedVisible && Boolean(this.host?.isVisible());
    view.setVisible(visible);
  }
}
