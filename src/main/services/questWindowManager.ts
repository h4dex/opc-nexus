import {
  BrowserWindow,
  shell,
  type BrowserWindowConstructorOptions,
  type Event,
  type WebContents
} from 'electron';
import { isAllowedExternalUrl, isAllowedMainNavigation } from './navigationPolicy.js';
import { isAuthorizedProjectArtifactUrl } from './projectArtifactService.js';

const QUEST_PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

export interface QuestWindowStatus {
  open: boolean;
  visible: boolean;
  loading: boolean;
  projectId: string | null;
}

export interface QuestWindowManagerOptions {
  rendererEntry: string;
  preloadPath: string;
  onClosed?: (projectId: string | null) => void | Promise<void>;
  createWindow?: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  openExternal?: (url: string) => void | Promise<void>;
}

export function isValidQuestProjectId(value: unknown): value is string {
  return typeof value === 'string' && QUEST_PROJECT_ID_PATTERN.test(value);
}

export function validateQuestProjectId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (!isValidQuestProjectId(value)) throw new Error('Quest projectId is invalid');
  return value;
}

function validatedRendererEntry(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4_096
    || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error('Quest renderer entry is invalid');
  }

  let entry: URL;
  try { entry = new URL(value); }
  catch { throw new Error('Quest renderer entry is invalid'); }

  if (!['file:', 'http:', 'https:'].includes(entry.protocol)
    || entry.username || entry.password
    || ((entry.protocol === 'http:' || entry.protocol === 'https:') && !entry.hostname)) {
    throw new Error('Quest renderer entry is invalid');
  }

  // The caller supplies an entry document, not state. Quest owns the complete query.
  entry.search = '';
  entry.hash = '';
  return entry.href;
}

function validatedPreloadPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4_096
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Quest preload path is invalid');
  }
  return value;
}

/** Trusted, single-window shell for the internal Quest renderer surface. */
export class QuestWindowManager {
  private readonly rendererEntry: string;
  private readonly preloadPath: string;
  private readonly onClosed?: (projectId: string | null) => void | Promise<void>;
  private readonly createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  private readonly openExternal: (url: string) => void | Promise<void>;
  private window: BrowserWindow | null = null;
  private projectId: string | null = null;
  private targetProjectId: string | null = null;
  private openPromise: Promise<QuestWindowStatus> | null = null;
  private generation = 0;

  constructor(options: QuestWindowManagerOptions) {
    this.rendererEntry = validatedRendererEntry(options.rendererEntry);
    this.preloadPath = validatedPreloadPath(options.preloadPath);
    this.onClosed = options.onClosed;
    this.createWindow = options.createWindow ?? ((windowOptions) => new BrowserWindow(windowOptions));
    this.openExternal = options.openExternal ?? ((url) => shell.openExternal(url));
  }

  getStatus(): QuestWindowStatus {
    const window = this.liveWindow();
    return {
      open: window !== null,
      visible: window?.isVisible() ?? false,
      loading: this.openPromise !== null,
      projectId: window ? this.projectId : null
    };
  }

  getWindow(): BrowserWindow | null {
    return this.liveWindow();
  }

  getProjectId(): string | null {
    return this.liveWindow() ? this.projectId : null;
  }

  ownsWebContents(contents: WebContents | null | undefined): boolean {
    const window = this.liveWindow();
    return window !== null && window.webContents === contents;
  }

  async open(projectId: string | null = null): Promise<QuestWindowStatus> {
    const safeProjectId = validateQuestProjectId(projectId);
    const existing = this.liveWindow();

    if (existing && this.targetProjectId === safeProjectId) {
      this.focus(existing);
      return this.openPromise ?? this.getStatus();
    }

    const pending = this.openPromise;
    if (pending) {
      try { await pending; } catch { /* A later request may recover with a fresh window. */ }
      return this.open(safeProjectId);
    }

    let opening!: Promise<QuestWindowStatus>;
    const finalized = this.createOrReload(existing, safeProjectId).finally(() => {
      if (this.openPromise === opening) this.openPromise = null;
    });
    opening = finalized.then(() => this.getStatus());
    this.openPromise = opening;
    return opening;
  }

  close(): void {
    const window = this.liveWindow();
    if (window) window.close();
  }

  private liveWindow(): BrowserWindow | null {
    if (this.window?.isDestroyed()) {
      this.releaseWindow(this.window);
      return null;
    }
    return this.window;
  }

  private async createOrReload(
    existing: BrowserWindow | null,
    projectId: string | null
  ): Promise<void> {
    let window = existing;
    const previousProjectId = this.projectId;
    const canRestorePreviousProject = window !== null;
    if (!window) {
      window = this.createWindow({
        width: 1440,
        height: 900,
        minWidth: 900,
        minHeight: 600,
        show: false,
        autoHideMenuBar: true,
        title: 'Quest',
        backgroundColor: '#0f1218',
        webPreferences: {
          preload: this.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          webviewTag: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          navigateOnDragDrop: false
        }
      });
      this.window = window;
      this.configureSecurity(window);
    }

    const generation = ++this.generation;
    this.targetProjectId = projectId;
    this.projectId = null;

    try {
      // loadURL starts the navigation synchronously. Bind the new project only
      // after that point so the outgoing document cannot inherit its identity.
      const loading = window.loadURL(this.questUrl(projectId));
      this.projectId = projectId;
      await loading;
      if (this.window !== window || window.isDestroyed() || this.generation !== generation) {
        throw new Error('Quest window closed while loading');
      }
      window.webContents.navigationHistory.clear();
      this.focus(window);
    } catch (error) {
      if (canRestorePreviousProject
        && this.window === window
        && !window.isDestroyed()
        && this.generation === generation) {
        let restored = false;
        try {
          this.targetProjectId = previousProjectId;
          this.projectId = null;
          const restoring = window.loadURL(this.questUrl(previousProjectId));
          this.projectId = previousProjectId;
          await restoring;
          if (this.window !== window || window.isDestroyed() || this.generation !== generation) {
            throw new Error('Quest window closed while restoring the previous project');
          }
          window.webContents.navigationHistory.clear();
          this.focus(window);
          restored = true;
        } catch { /* A failed rollback falls through to deterministic cleanup. */ }

        if (restored) throw error;
      }

      if (this.window === window) this.releaseWindow(window);
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
  }

  private questUrl(projectId: string | null): string {
    const target = new URL(this.rendererEntry);
    target.searchParams.set('surface', 'quest');
    if (projectId !== null) target.searchParams.set('projectId', projectId);
    return target.href;
  }

  private configureSecurity(window: BrowserWindow): void {
    const contents = window.webContents;
    const guardNavigation = (event: Event, legacyUrl?: string) => {
      const url = legacyUrl ?? (event as Event & { url?: string }).url ?? '';
      if ((event as Event & { isMainFrame?: boolean }).isMainFrame === false
        && (isAuthorizedProjectArtifactUrl(url) || this.isRendererBlobNavigation(url))) return;
      if (this.isRendererNavigation(url)) return;
      event.preventDefault();
      if ((event as Event & { isMainFrame?: boolean }).isMainFrame !== false) {
        this.openInSystemBrowser(url);
      }
    };

    contents.on('will-navigate', guardNavigation);
    contents.on('will-redirect', guardNavigation);
    contents.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame && (event.url === 'about:srcdoc'
        || isAuthorizedProjectArtifactUrl(event.url)
        || this.isRendererBlobNavigation(event.url))) return;
      if (this.isRendererNavigation(event.url)) return;
      event.preventDefault();
      if (event.isMainFrame) this.openInSystemBrowser(event.url);
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (!this.isRendererNavigation(url)) this.openInSystemBrowser(url);
      return { action: 'deny' };
    });
    window.once('closed', () => this.releaseWindow(window));
  }

  private focus(window: BrowserWindow): void {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  private openInSystemBrowser(url: string): void {
    if (this.isRendererOrigin(url) || !isAllowedExternalUrl(url)) return;
    try {
      void Promise.resolve(this.openExternal(url)).catch(() => undefined);
    } catch { /* Opening an external application must not destabilize Quest. */ }
  }

  private isRendererNavigation(url: string): boolean {
    if (!this.isRendererOrigin(url)) return false;
    try {
      const target = new URL(url);
      const expected = new URL(this.questUrl(this.targetProjectId));
      return !target.username && !target.password && target.href === expected.href;
    } catch {
      return false;
    }
  }

  private isRendererOrigin(url: string): boolean {
    return isAllowedMainNavigation(url, this.rendererEntry);
  }

  private isRendererBlobNavigation(value: string): boolean {
    if (!value || value.length > 4_096 || /[\u0000-\u0020\u007f]/.test(value)) return false;
    try {
      const blob = new URL(value);
      const renderer = new URL(this.rendererEntry);
      if (blob.protocol !== 'blob:') return false;
      if (renderer.protocol === 'http:' || renderer.protocol === 'https:') {
        return blob.origin === renderer.origin;
      }
      if (renderer.protocol !== 'file:' || !blob.pathname.startsWith('file:///')) return false;
      const embedded = new URL(blob.pathname);
      return embedded.protocol === 'file:' && !embedded.hostname;
    } catch {
      return false;
    }
  }

  private releaseWindow(window: BrowserWindow): void {
    if (this.window !== window) return;
    const closedProjectId = this.targetProjectId;
    this.window = null;
    this.projectId = null;
    this.targetProjectId = null;
    this.openPromise = null;
    this.generation += 1;
    if (!this.onClosed) return;
    try {
      void Promise.resolve(this.onClosed(closedProjectId)).catch(() => undefined);
    } catch { /* Window cleanup must remain deterministic if notification fails. */ }
  }
}
