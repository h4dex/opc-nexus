const QUEST_PROJECT_ARGUMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

export interface QuestLaunchRequest {
  projectId: string | null;
}

export type QuestLaunchOpener = (projectId: string | null) => Promise<unknown>;

/** Queues early single-instance requests and contains window-open failures. */
export class QuestLaunchCoordinator {
  private opener: QuestLaunchOpener | null = null;
  private pendingProjectId: string | null | undefined;

  constructor(
    private readonly onOpenError: (error: unknown, projectId: string | null) => void = () => undefined
  ) {}

  request(projectId: string | null): Promise<boolean> {
    if (!this.opener) {
      this.pendingProjectId = projectId;
      return Promise.resolve(false);
    }
    return this.dispatch(projectId);
  }

  async attach(opener: QuestLaunchOpener): Promise<boolean> {
    this.opener = opener;
    if (this.pendingProjectId === undefined) return true;
    const projectId = this.pendingProjectId;
    this.pendingProjectId = undefined;
    return this.dispatch(projectId);
  }

  private async dispatch(projectId: string | null): Promise<boolean> {
    try {
      await this.opener!(projectId);
      return true;
    } catch (error) {
      try { this.onOpenError(error, projectId); } catch { /* Diagnostics cannot escape the launcher. */ }
      return false;
    }
  }
}

/** Parses the packaged/development Quest-only launch contract without accepting paths or URLs. */
export function parseQuestLaunchRequest(argv: readonly string[]): QuestLaunchRequest | null {
  let requested = false;
  let projectId: string | null = null;
  let invalidProject = false;

  for (const argument of argv) {
    if (argument === '--quest' || argument === '--quest-only') {
      requested = true;
      continue;
    }
    if (argument.startsWith('--quest-only=')) {
      requested = true;
      const value = argument.slice('--quest-only='.length);
      if (QUEST_PROJECT_ARGUMENT.test(value)) projectId = value;
      else invalidProject = true;
      continue;
    }
    if (argument.startsWith('--quest-project=')) {
      const value = argument.slice('--quest-project='.length);
      if (QUEST_PROJECT_ARGUMENT.test(value)) projectId = value;
      else invalidProject = true;
    }
  }

  // Preserve the requested surface, but never forward an untrusted project
  // value to the window manager or let it fall back to the full console.
  return requested ? { projectId: invalidProject ? null : projectId } : null;
}
