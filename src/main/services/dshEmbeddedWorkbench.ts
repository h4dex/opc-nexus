import {
  WebContentsView,
  shell,
  type BrowserWindow,
  type DownloadItem,
  type Event,
  type Rectangle,
  type WebContents,
  type WebContentsViewConstructorOptions
} from 'electron';
import {
  isAllowedDshDownloadUrl,
  type DshWindowGateway
} from './dshWindowManager.js';
import { createDshStorageBootstrapUrl } from './dshWebGateway.js';
import { isAllowedExternalUrl } from './navigationPolicy.js';

export const DSH_EMBEDDED_WORKBENCH_PARTITION = 'persist:opc-nexus-dsh-embedded-workbench';
export const DSH_EMBEDDED_WORKBENCH_MIN_WIDTH = 320;
export const DSH_EMBEDDED_WORKBENCH_MIN_HEIGHT = 240;
export const DSH_SESSION_SELECTION_STORAGE_KEY = 'dsh.sessions.current';

export interface DshEmbeddedWorkbenchStatus {
  open: boolean;
  attached: boolean;
  visible: boolean;
  loading: boolean;
  bounds: Rectangle | null;
}

export interface DshEmbeddedWorkbenchOptions {
  partition?: string;
  createView?: (options: WebContentsViewConstructorOptions) => WebContentsView;
  openExternal?: (url: string) => Promise<void>;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validateUpstreamSessionId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 256
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('DSH upstream session selection is invalid');
  }
  return value;
}

/** Validates untrusted Renderer coordinates before they reach Electron's native View API. */
export function isValidDshEmbeddedWorkbenchBounds(value: unknown): value is Rectangle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const bounds = value as Partial<Rectangle>;
  return isNonNegativeInteger(bounds.x)
    && isNonNegativeInteger(bounds.y)
    && isNonNegativeInteger(bounds.width)
    && bounds.width >= DSH_EMBEDDED_WORKBENCH_MIN_WIDTH
    && isNonNegativeInteger(bounds.height)
    && bounds.height >= DSH_EMBEDDED_WORKBENCH_MIN_HEIGHT;
}

export function validateDshEmbeddedWorkbenchBounds(value: unknown): Rectangle {
  if (!isValidDshEmbeddedWorkbenchBounds(value)) {
    throw new Error(
      `DSH embedded Workbench bounds must use non-negative integers and be at least `
      + `${DSH_EMBEDDED_WORKBENCH_MIN_WIDTH}x${DSH_EMBEDDED_WORKBENCH_MIN_HEIGHT}`
    );
  }
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

/** Main-owned, preload-free host for the official DSH Web UI. */
export class DshEmbeddedWorkbenchManager {
  private readonly partition: string;
  private readonly createView: (options: WebContentsViewConstructorOptions) => WebContentsView;
  private readonly openExternal: (url: string) => Promise<void>;
  private view: WebContentsView | null = null;
  private host: BrowserWindow | null = null;
  private desktopSessionId: string | null = null;
  private openPromise: Promise<DshEmbeddedWorkbenchStatus> | null = null;
  private contentCleanup: (() => void) | null = null;
  private hostCleanup: (() => void) | null = null;
  private requestedVisible = true;
  private ready = false;
  private generation = 0;
  private selectionSessionId: string | null | undefined;

  constructor(
    private readonly gateway: DshWindowGateway,
    options: DshEmbeddedWorkbenchOptions = {}
  ) {
    this.partition = options.partition ?? DSH_EMBEDDED_WORKBENCH_PARTITION;
    if (!this.partition.startsWith('persist:') || this.partition.length <= 'persist:'.length) {
      throw new Error('DSH embedded Workbench requires an independent persistent Electron partition');
    }
    this.createView = options.createView ?? ((viewOptions) => new WebContentsView(viewOptions));
    this.openExternal = options.openExternal ?? ((url) => shell.openExternal(url));
  }

  getStatus(): DshEmbeddedWorkbenchStatus {
    const view = this.liveView();
    const attached = view !== null
      && this.host !== null
      && !this.host.isDestroyed()
      && !this.host.webContents.isDestroyed();
    return {
      open: view !== null,
      attached,
      visible: attached ? view.getVisible() : false,
      loading: view !== null && this.openPromise !== null,
      bounds: view ? { ...view.getBounds() } : null
    };
  }

  async open(
    host: BrowserWindow,
    bounds: Rectangle,
    upstreamSessionId: string | null = null
  ): Promise<DshEmbeddedWorkbenchStatus> {
    this.assertLiveHost(host);
    const safeBounds = validateDshEmbeddedWorkbenchBounds(bounds);
    const safeSessionId = validateUpstreamSessionId(upstreamSessionId);
    this.requestedVisible = true;
    const existing = this.liveView();

    if (existing && this.selectionSessionId === safeSessionId) {
      this.attachView(existing, host);
      existing.setBounds(safeBounds);
      if (this.openPromise) return this.openPromise;
      this.applyVisibility(existing);
      return this.getStatus();
    }
    if (existing) this.releaseView(existing, true);

    const generation = ++this.generation;
    let opening!: Promise<DshEmbeddedWorkbenchStatus>;
    const finalized = this.createAndLoad(host, safeBounds, safeSessionId, generation).finally(() => {
      if (this.openPromise === opening) this.openPromise = null;
    });
    opening = finalized.then(() => this.getStatus());
    this.openPromise = opening;
    return opening;
  }

  attach(host: BrowserWindow): DshEmbeddedWorkbenchStatus {
    this.assertLiveHost(host);
    const view = this.liveView();
    if (!view) throw new Error('DSH embedded Workbench is not open');
    this.attachView(view, host);
    return this.getStatus();
  }

  setBounds(bounds: Rectangle): DshEmbeddedWorkbenchStatus {
    const safeBounds = validateDshEmbeddedWorkbenchBounds(bounds);
    const view = this.liveView();
    if (view) view.setBounds(safeBounds);
    return this.getStatus();
  }

  setVisible(visible: boolean): DshEmbeddedWorkbenchStatus {
    this.requestedVisible = visible;
    const view = this.liveView();
    if (view) this.applyVisibility(view);
    return this.getStatus();
  }

  close(): DshEmbeddedWorkbenchStatus {
    const view = this.view;
    this.openPromise = null;
    if (view) this.releaseView(view, true);
    else this.selectionSessionId = undefined;
    return this.getStatus();
  }

  destroy(): DshEmbeddedWorkbenchStatus {
    return this.close();
  }

  private async createAndLoad(
    host: BrowserWindow,
    bounds: Rectangle,
    upstreamSessionId: string | null,
    generation: number
  ): Promise<void> {
    const desktopSession = this.gateway.createDesktopSession(upstreamSessionId === null
      ? null
      : { rootUpstreamSessionId: upstreamSessionId });
    let view: WebContentsView;
    try {
      view = this.createView({
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
    } catch (error) {
      this.gateway.revokeDesktopSession(desktopSession.id);
      throw error;
    }

    try {
      this.view = view;
      this.desktopSessionId = desktopSession.id;
      this.selectionSessionId = upstreamSessionId;
      this.ready = false;
      view.setBounds(bounds);
      view.setVisible(false);
      this.configureSecurity(view);
      this.attachView(view, host);
      const officialUrl = await this.primeSessionSelection(
        view.webContents,
        desktopSession.url,
        upstreamSessionId,
        view,
        generation
      );
      await view.webContents.loadURL(officialUrl);
      this.assertCurrentOpening(view, generation);
      this.ready = true;
      this.applyVisibility(view);
    } catch (error) {
      const closedWhileLoading = generation !== this.generation
        || view.webContents.isDestroyed()
        || this.view !== view;
      this.releaseView(view, true);
      if (closedWhileLoading) throw new Error('DSH embedded Workbench closed while loading');
      throw error;
    }
  }

  /**
   * Seed the official runtime's persisted selection before its first script
   * executes. The one-time desktop grant first loads an inert same-origin
   * document; only then can this isolated WebContentsView write localStorage
   * and navigate to the official app. No preload or Nexus Renderer bridge
   * receives the upstream session id.
   */
  private async primeSessionSelection(
    contents: WebContents,
    targetUrl: string,
    upstreamSessionId: string | null,
    view: WebContentsView,
    generation: number
  ): Promise<string> {
    let target: URL;
    try { target = new URL(targetUrl); } catch { throw new Error('DSH gateway URL is invalid'); }
    if (!this.gateway.isGatewayUrl(target.href) || target.protocol !== 'http:') {
      throw new Error('DSH session selection requires the active gateway origin');
    }
    this.assertCurrentOpening(view, generation);

    await contents.loadURL(createDshStorageBootstrapUrl(target.href));
    this.assertCurrentOpening(view, generation);
    const key = JSON.stringify(DSH_SESSION_SELECTION_STORAGE_KEY);
    const script = upstreamSessionId === null
      ? `localStorage.removeItem(${key})`
      : `localStorage.setItem(${key}, ${JSON.stringify(JSON.stringify({ sessionId: upstreamSessionId }))})`;
    await contents.executeJavaScript(script, false);
    this.assertCurrentOpening(view, generation);
    return `${target.origin}/`;
  }

  private assertCurrentOpening(view: WebContentsView, generation: number): void {
    if (generation !== this.generation || this.view !== view || view.webContents.isDestroyed()) {
      throw new Error('DSH embedded Workbench closed while loading');
    }
  }

  private configureSecurity(view: WebContentsView): void {
    const contents = view.webContents;
    const guardNavigation = (event: Event, legacyUrl?: string) => {
      const url = legacyUrl ?? (event as Event & { url?: string }).url ?? '';
      if (this.gateway.isGatewayUrl(url)) return;
      event.preventDefault();
      if ((event as Event & { isMainFrame?: boolean }).isMainFrame !== false) {
        this.openInSystemBrowser(url);
      }
    };
    const guardFrameNavigation = (event: Event & { url: string; isMainFrame: boolean }) => {
      if (this.gateway.isGatewayUrl(event.url)) return;
      event.preventDefault();
    };
    const guardWebview = (event: Event) => event.preventDefault();
    const onDestroyed = () => this.releaseView(view, false);
    const electronSession = contents.session;
    const downloadListener = (event: Event, item: DownloadItem, source: WebContents) => {
      if (source !== contents) return;
      if (!isAllowedDshDownloadUrl(item.getURL(), this.gateway)) event.preventDefault();
    };

    this.contentCleanup = () => {
      contents.removeListener('will-navigate', guardNavigation);
      contents.removeListener('will-redirect', guardNavigation);
      contents.removeListener('will-frame-navigate', guardFrameNavigation);
      contents.removeListener('will-attach-webview', guardWebview);
      contents.removeListener('destroyed', onDestroyed);
      electronSession.removeListener('will-download', downloadListener);
      electronSession.setPermissionRequestHandler(null);
    };

    contents.on('will-navigate', guardNavigation);
    contents.on('will-redirect', guardNavigation);
    contents.on('will-frame-navigate', guardFrameNavigation);
    contents.on('will-attach-webview', guardWebview);
    contents.setWindowOpenHandler(({ url }) => {
      if (this.gateway.isGatewayUrl(url)) {
        void contents.loadURL(url).catch(() => undefined);
      } else {
        this.openInSystemBrowser(url);
      }
      return { action: 'deny' };
    });

    electronSession.setPermissionRequestHandler((_requestingContents, _permission, callback) => callback(false));
    electronSession.on('will-download', downloadListener);
    contents.once('destroyed', onDestroyed);
  }

  private attachView(view: WebContentsView, host: BrowserWindow): void {
    if (this.host === host) {
      this.applyVisibility(view);
      return;
    }
    this.detachHost(view);
    host.contentView.addChildView(view);
    this.host = host;
    const onClosed = () => this.releaseView(view, true);
    const onVisibilityChanged = () => this.applyVisibility(view);
    const onNavigation = (
      details: Event & { isMainFrame?: boolean; isSameDocument?: boolean },
      _url?: string,
      legacyIsInPlace?: boolean,
      legacyIsMainFrame?: boolean
    ) => {
      const isMainFrame = details.isMainFrame ?? legacyIsMainFrame ?? false;
      const isSameDocument = details.isSameDocument ?? legacyIsInPlace ?? false;
      if (isMainFrame && !isSameDocument) this.releaseView(view, true);
    };
    const onRendererGone = () => this.releaseView(view, true);
    const onRendererDestroyed = () => this.releaseView(view, true);
    const hostContents = host.webContents;

    this.hostCleanup = () => {
      host.removeListener('closed', onClosed);
      host.removeListener('hide', onVisibilityChanged);
      host.removeListener('show', onVisibilityChanged);
      hostContents.removeListener('did-start-navigation', onNavigation);
      hostContents.removeListener('render-process-gone', onRendererGone);
      hostContents.removeListener('destroyed', onRendererDestroyed);
    };
    host.once('closed', onClosed);
    host.on('hide', onVisibilityChanged);
    host.on('show', onVisibilityChanged);
    hostContents.on('did-start-navigation', onNavigation);
    hostContents.on('render-process-gone', onRendererGone);
    hostContents.once('destroyed', onRendererDestroyed);
    this.applyVisibility(view);
  }

  private detachHost(view: WebContentsView): void {
    const host = this.host;
    const cleanup = this.hostCleanup;
    this.host = null;
    this.hostCleanup = null;
    cleanup?.();
    if (!host) return;
    if (!host.isDestroyed()) host.contentView.removeChildView(view);
  }

  private liveView(): WebContentsView | null {
    const view = this.view;
    if (!view) return null;
    if (
      view.webContents.isDestroyed()
      || this.host?.isDestroyed()
      || this.host?.webContents.isDestroyed()
    ) {
      this.releaseView(view, !view.webContents.isDestroyed());
      return null;
    }
    return view;
  }

  private releaseView(view: WebContentsView, destroyContents: boolean): void {
    if (this.view !== view) return;
    this.generation += 1;
    this.openPromise = null;
    this.ready = false;
    this.detachHost(view);
    this.contentCleanup?.();
    this.contentCleanup = null;
    this.view = null;
    this.selectionSessionId = undefined;
    if (this.desktopSessionId) this.gateway.revokeDesktopSession(this.desktopSessionId);
    this.desktopSessionId = null;
    if (destroyContents && !view.webContents.isDestroyed()) {
      view.webContents.close({ waitForBeforeUnload: false });
    }
  }

  private assertLiveHost(host: BrowserWindow): void {
    if (host.isDestroyed() || host.webContents.isDestroyed()) {
      throw new Error('Cannot attach DSH embedded Workbench to a destroyed window');
    }
  }

  private applyVisibility(view: WebContentsView): void {
    if (this.view !== view) return;
    const host = this.host;
    const visible = this.ready
      && this.requestedVisible
      && host !== null
      && !host.isDestroyed()
      && !host.webContents.isDestroyed()
      && host.isVisible();
    view.setVisible(visible);
  }

  private openInSystemBrowser(url: string): void {
    if (!isAllowedExternalUrl(url) || this.gateway.isGatewayUrl(url)) return;
    void this.openExternal(url).catch(() => undefined);
  }
}

export { DshEmbeddedWorkbenchManager as DshEmbeddedWorkbench };
