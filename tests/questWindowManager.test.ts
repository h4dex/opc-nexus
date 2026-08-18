import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: class {},
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) }
}));

import {
  QuestWindowManager,
  isValidQuestProjectId
} from '../src/main/services/questWindowManager.js';

class FakeWebContents extends EventEmitter {
  windowOpenHandler: ((details: { url: string }) => { action: string }) | null = null;
  navigationHistory = { clear: vi.fn() };

  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void {
    this.windowOpenHandler = handler;
  }
}

class FakeBrowserWindow extends EventEmitter {
  readonly webContents = new FakeWebContents();
  readonly loadURL = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
  readonly show = vi.fn(() => { this.visible = true; });
  readonly focus = vi.fn();
  readonly restore = vi.fn(() => { this.minimized = false; });
  destroyed = false;
  visible = false;
  minimized = false;

  constructor(readonly options: Record<string, any>) {
    super();
  }

  isDestroyed(): boolean { return this.destroyed; }
  isVisible(): boolean { return this.visible; }
  isMinimized(): boolean { return this.minimized; }

  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.visible = false;
    this.emit('closed');
  }

  destroy(): void { this.close(); }
}

function fakeEvent(extra: Record<string, unknown> = {}) {
  return { preventDefault: vi.fn(), ...extra };
}

function fixture(
  rendererEntry = 'http://127.0.0.1:5173/app?discard=secret#old',
  loadFailure: Error | null = null
) {
  const windows: FakeBrowserWindow[] = [];
  const openedExternal = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
  const onClosed = vi.fn();
  const manager = new QuestWindowManager({
    rendererEntry,
    preloadPath: 'E:\\Develop\\AiBoxDash\\out\\preload\\index.mjs',
    createWindow: (options) => {
      const window = new FakeBrowserWindow(options as Record<string, any>);
      if (loadFailure) window.loadURL.mockRejectedValueOnce(loadFailure);
      windows.push(window);
      return window as never;
    },
    openExternal: openedExternal,
    onClosed
  });
  return { manager, windows, openedExternal, onClosed };
}

describe('QuestWindowManager', () => {
  it('creates a trusted internal renderer window with only Quest context in its query', async () => {
    const { manager, windows } = fixture();

    await expect(manager.open('project-alpha_1')).resolves.toEqual({
      open: true,
      visible: true,
      loading: false,
      projectId: 'project-alpha_1'
    });

    expect(windows).toHaveLength(1);
    const window = windows[0];
    expect(window.options.webPreferences).toMatchObject({
      preload: 'E:\\Develop\\AiBoxDash\\out\\preload\\index.mjs',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    });

    const loaded = new URL(window.loadURL.mock.calls[0][0]);
    expect(loaded.pathname).toBe('/app');
    expect([...loaded.searchParams.entries()]).toEqual([
      ['surface', 'quest'],
      ['projectId', 'project-alpha_1']
    ]);
    expect(loaded.hash).toBe('');
    expect(manager.getWindow()).toBe(window);
    expect(manager.getProjectId()).toBe('project-alpha_1');
    expect(manager.ownsWebContents(window.webContents as never)).toBe(true);
    expect(manager.ownsWebContents(new FakeWebContents() as never)).toBe(false);
  });

  it('supports a Quest-only window without project context', async () => {
    const { manager, windows } = fixture();

    await manager.open();
    const loaded = new URL(windows[0].loadURL.mock.calls[0][0]);
    expect([...loaded.searchParams.entries()]).toEqual([['surface', 'quest']]);
    expect(manager.getProjectId()).toBeNull();

    windows[0].minimized = true;
    await manager.open(null);
    expect(windows).toHaveLength(1);
    expect(windows[0].loadURL).toHaveBeenCalledOnce();
    expect(windows[0].restore).toHaveBeenCalledOnce();
    expect(windows[0].focus).toHaveBeenCalledTimes(2);
  });

  it('focuses the same project and safely reloads another project in the same window', async () => {
    const { manager, windows } = fixture();
    await manager.open('project-a');
    const window = windows[0];

    window.minimized = true;
    await manager.open('project-a');
    expect(window.loadURL).toHaveBeenCalledOnce();
    expect(window.restore).toHaveBeenCalledOnce();

    await manager.open('project-b');
    expect(windows).toHaveLength(1);
    expect(window.loadURL).toHaveBeenCalledTimes(2);
    const reloaded = new URL(window.loadURL.mock.calls[1][0]);
    expect([...reloaded.searchParams.entries()]).toEqual([
      ['surface', 'quest'],
      ['projectId', 'project-b']
    ]);
    expect(manager.getProjectId()).toBe('project-b');
    expect(window.webContents.navigationHistory.clear).toHaveBeenCalledTimes(2);
  });

  it('restores the committed project when switching to another project fails', async () => {
    const { manager, windows, onClosed } = fixture();
    await manager.open('project-a');
    const window = windows[0];
    window.loadURL.mockRejectedValueOnce(new Error('project-b failed'));

    await expect(manager.open('project-b')).rejects.toThrow('project-b failed');

    expect(window.loadURL).toHaveBeenCalledTimes(3);
    expect(window.loadURL.mock.calls.map(([url]) => new URL(url).searchParams.get('projectId')))
      .toEqual(['project-a', 'project-b', 'project-a']);
    expect(window.isDestroyed()).toBe(false);
    expect(onClosed).not.toHaveBeenCalled();
    expect(manager.getStatus()).toEqual({
      open: true,
      visible: true,
      loading: false,
      projectId: 'project-a'
    });
    expect(window.webContents.navigationHistory.clear).toHaveBeenCalledTimes(2);
  });

  it('strictly rejects project values that could carry paths, sessions, or credentials', async () => {
    const { manager, windows } = fixture();
    const invalid = [
      '', ' project-a', 'project a', '../project-a', 'project/a', 'project\\a',
      'project%2Fa', 'project?a=1', 'project&a=1', 'project:a', '项目-a',
      `project-${'a'.repeat(100)}`
    ];

    for (const projectId of invalid) {
      expect(isValidQuestProjectId(projectId), projectId).toBe(false);
      await expect(manager.open(projectId)).rejects.toThrow('projectId is invalid');
    }
    expect(windows).toHaveLength(0);
  });

  it('blocks foreign navigation and delegates only safe external URLs to the OS', async () => {
    const { manager, windows, openedExternal } = fixture();
    await manager.open('project-a');
    const contents = windows[0].webContents;

    const current = fakeEvent();
    contents.emit('will-navigate', current, 'http://127.0.0.1:5173/app?surface=quest&projectId=project-a');
    expect(current.preventDefault).not.toHaveBeenCalled();

    const staleInternal = fakeEvent();
    contents.emit('will-navigate', staleInternal, 'http://127.0.0.1:5173/app?surface=quest&projectId=project-b');
    expect(staleInternal.preventDefault).toHaveBeenCalledOnce();
    expect(openedExternal).not.toHaveBeenCalled();

    const fullMainUi = fakeEvent();
    contents.emit('will-navigate', fullMainUi, 'http://127.0.0.1:5173/app');
    expect(fullMainUi.preventDefault).toHaveBeenCalledOnce();
    expect(openedExternal).not.toHaveBeenCalled();

    const external = fakeEvent();
    contents.emit('will-navigate', external, 'https://docs.deepseek.com/');
    expect(external.preventDefault).toHaveBeenCalledOnce();
    expect(openedExternal).toHaveBeenCalledWith('https://docs.deepseek.com/');

    const unsafe = fakeEvent();
    contents.emit('will-redirect', unsafe, 'javascript:alert(1)');
    expect(unsafe.preventDefault).toHaveBeenCalledOnce();
    expect(openedExternal).toHaveBeenCalledTimes(1);

    const frame = fakeEvent({ url: 'https://embed.invalid/', isMainFrame: false });
    contents.emit('will-frame-navigate', frame);
    expect(frame.preventDefault).toHaveBeenCalledOnce();
    expect(openedExternal).toHaveBeenCalledTimes(1);

    const artifactFrame = fakeEvent({
      url: `aibox-project://preview/${'T'.repeat(43)}/deliverables/index.html`,
      isMainFrame: false
    });
    contents.emit('will-frame-navigate', artifactFrame);
    expect(artifactFrame.preventDefault).not.toHaveBeenCalled();

    const artifactSrcDoc = fakeEvent({ url: 'about:srcdoc', isMainFrame: false });
    contents.emit('will-frame-navigate', artifactSrcDoc);
    expect(artifactSrcDoc.preventDefault).not.toHaveBeenCalled();

    const artifactBlob = fakeEvent({ url: 'blob:http://127.0.0.1:5173/72f9d20d-87ee-489f-bad5-96df97a7ce2e', isMainFrame: false });
    contents.emit('will-frame-navigate', artifactBlob);
    expect(artifactBlob.preventDefault).not.toHaveBeenCalled();

    const foreignBlob = fakeEvent({ url: 'blob:https://untrusted.invalid/72f9d20d-87ee-489f-bad5-96df97a7ce2e', isMainFrame: false });
    contents.emit('will-frame-navigate', foreignBlob);
    expect(foreignBlob.preventDefault).toHaveBeenCalledOnce();

    const artifactLegacyFrame = fakeEvent({ isMainFrame: false });
    contents.emit('will-navigate', artifactLegacyFrame, `aibox-project://preview/${'T'.repeat(43)}/deliverables/index.html`);
    expect(artifactLegacyFrame.preventDefault).not.toHaveBeenCalled();

    const artifactMainFrame = fakeEvent({
      url: `aibox-project://preview/${'T'.repeat(43)}/deliverables/index.html`,
      isMainFrame: true
    });
    contents.emit('will-frame-navigate', artifactMainFrame);
    expect(artifactMainFrame.preventDefault).toHaveBeenCalledOnce();

    const malformedArtifactFrame = fakeEvent({
      url: 'aibox-project://preview/not-a-token/../outside.html',
      isMainFrame: false
    });
    contents.emit('will-frame-navigate', malformedArtifactFrame);
    expect(malformedArtifactFrame.preventDefault).toHaveBeenCalledOnce();

    expect(contents.windowOpenHandler?.({ url: 'mailto:owner@example.com' })).toEqual({ action: 'deny' });
    expect(openedExternal).toHaveBeenCalledWith('mailto:owner@example.com');
    expect(contents.windowOpenHandler?.({ url: 'http://127.0.0.1:5173/quest' })).toEqual({ action: 'deny' });
    expect(openedExternal).toHaveBeenCalledTimes(2);
  });

  it('cleans ownership and reports project context when the window closes', async () => {
    const { manager, windows, onClosed } = fixture();
    await manager.open('project-a');
    const contents = windows[0].webContents;

    manager.close();

    expect(manager.getStatus()).toEqual({
      open: false,
      visible: false,
      loading: false,
      projectId: null
    });
    expect(manager.getWindow()).toBeNull();
    expect(manager.getProjectId()).toBeNull();
    expect(manager.ownsWebContents(contents as never)).toBe(false);
    expect(onClosed).toHaveBeenCalledOnce();
    expect(onClosed).toHaveBeenCalledWith('project-a');
  });

  it('destroys and releases a window whose renderer load fails', async () => {
    const failure = new Error('renderer failed');
    const { manager, windows, onClosed } = fixture(
      'http://127.0.0.1:5173/app',
      failure
    );

    await expect(manager.open('project-a')).rejects.toThrow('renderer failed');
    expect(windows[0].isDestroyed()).toBe(true);
    expect(manager.getStatus()).toEqual({ open: false, visible: false, loading: false, projectId: null });
    expect(onClosed).toHaveBeenCalledWith('project-a');
  });
});
