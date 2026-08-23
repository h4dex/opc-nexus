import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  parseQuestLaunchRequest,
  QuestLaunchCoordinator
} from '../src/main/services/questLaunch.js';

describe('Quest-only launch arguments', () => {
  it('recognizes the standalone surface and an optional project', () => {
    expect(parseQuestLaunchRequest(['app.exe', '--quest-only'])).toEqual({ projectId: null });
    expect(parseQuestLaunchRequest(['app.exe', '--quest-only=project-1'])).toEqual({ projectId: 'project-1' });
    expect(parseQuestLaunchRequest(['app.exe', '--quest', '--quest-project=project_2']))
      .toEqual({ projectId: 'project_2' });
  });

  it('does not infer Quest mode and never forwards path-shaped values', () => {
    expect(parseQuestLaunchRequest(['app.exe'])).toBeNull();
    expect(parseQuestLaunchRequest(['app.exe', '--quest-only=../secret'])).toEqual({ projectId: null });
    expect(parseQuestLaunchRequest(['app.exe', '--quest', '--quest-project=https://example.com']))
      .toEqual({ projectId: null });
  });

  it('keeps Quest-only mode but clears the project when any supplied value is invalid', () => {
    expect(parseQuestLaunchRequest(['app.exe', '--quest-only=project-ok', '--quest-project=bad/path']))
      .toEqual({ projectId: null });
    expect(parseQuestLaunchRequest(['app.exe', '--quest-project=bad/path', '--quest-only=project-ok']))
      .toEqual({ projectId: null });
  });

  it('forwards Quest mode in Electron argv so an existing single instance can recognize it', () => {
    const launcher = readFileSync(join(process.cwd(), 'scripts', 'run-quest-surface.cjs'), 'utf8');

    expect(launcher).toContain("const electronArgs = [");
    expect(launcher).toContain("'--quest-only'");
    expect(launcher).toContain("[entry, ...command, '--', ...electronArgs]");
  });

  it('restores the last standalone project from tray or OS activation', () => {
    const main = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8');

    expect(main).toContain('let lastQuestProjectId = startupQuestLaunch?.projectId ?? null;');
    expect(main).toContain('lastQuestProjectId = projectId;');
    expect(main.match(/questLaunchCoordinator\.request\(lastQuestProjectId\)/g)).toHaveLength(3);
  });

  it('keeps the desktop console reachable when the primary instance started in Quest-only mode', () => {
    const main = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8');

    expect(main).toContain('let pendingMainWindowRequest = false;');
    expect(main).toContain('function requestMainSurface(): void');
    expect(main).toContain("{ label: '打开控制台', click: requestMainSurface }");
    expect(main).toContain("{ label: '打开 Quest', click: () => { void questLaunchCoordinator.request(lastQuestProjectId); } }");
    expect(main.indexOf('desktopSurfaceReady = true;')).toBeLessThan(
      main.indexOf('if (!startupQuestLaunch || pendingMainWindowRequest)')
    );
  });

  it('keeps the latest early Quest request until the window service is ready', async () => {
    const open = vi.fn<(projectId: string | null) => Promise<void>>().mockResolvedValue(undefined);
    const coordinator = new QuestLaunchCoordinator();

    await expect(coordinator.request('project-a')).resolves.toBe(false);
    await expect(coordinator.request('project-b')).resolves.toBe(false);
    await expect(coordinator.attach(open)).resolves.toBe(true);

    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith('project-b');
  });

  it('contains launch failures and allows a later tray or activation retry', async () => {
    const failure = new Error('renderer unavailable');
    const open = vi.fn<(projectId: string | null) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const onOpenError = vi.fn();
    const coordinator = new QuestLaunchCoordinator(onOpenError);
    await coordinator.request(null);

    await expect(coordinator.attach(open)).resolves.toBe(false);
    expect(onOpenError).toHaveBeenCalledWith(failure, null);
    await expect(coordinator.request('project-a')).resolves.toBe(true);
    expect(open).toHaveBeenLastCalledWith('project-a');
  });
});
