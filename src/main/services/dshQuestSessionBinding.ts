import { createHash } from 'node:crypto';
import type { Agent } from '../../shared/types.js';
import { DSH_MANAGED_ENGINE_ID } from '../../shared/types.js';
import type { Database } from './database.js';
import {
  DSH_MANAGED_CAPABILITIES_DISABLED,
  DSH_MANAGED_PROFILE_ID,
  dshManagedProjectProfileId
} from './deepseekHarnessManagedRuntime.js';
import {
  DshAmbiguousTransportError,
  DshControlClient,
  type DshControlPort,
  type DshSessionSummary,
  type DshWorkspaceSummary
} from './dshControlClient.js';
import type { DshSessionRecord, DshSessionService } from './dshSessionService.js';
import type { DshRuntimeStatus } from './dshSupervisor.js';
import type { ProjectWorkbenchService } from './projectWorkbench.js';

const PROFILE_VERSION = 1;
const PROTOCOL_VERSION = 'dsh-web/0.1.0-rc.6';
const EXPECTED_AGENT_PRESET = 'cordis';

export interface DshQuestRuntimeAuthority {
  start(request: {
    agentId: string;
    profileId: string;
    workspace?: string;
  }): Promise<DshRuntimeStatus>;
}

export interface DshQuestSessionBindingOptions {
  profileId?: string;
  runtimeCapabilities?: Readonly<Record<string, boolean>>;
  clientFactory?: (endpoint: string) => DshControlPort;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface DshQuestSessionBinding {
  /** Main-only Nexus projection. Never include this object in an IPC response. */
  localSessionId: string;
  /** Main-only upstream identity used to select the official DSH UI session. */
  upstreamSessionId: string;
  /** Main-only project-scoped runtime identity. */
  profileId: string;
  /** Main-only directory selected for this project. */
  runtimeWorkspace: string;
}

export interface ResolveDshQuestSessionInput {
  projectId: string;
  agent: Pick<Agent, 'id' | 'engineId' | 'workspace'>;
  requestedSessionId?: string | null;
}

function boundedId(value: unknown, label: string, maximum = 200): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function boundedUpstreamSessionId(value: unknown): string {
  return boundedId(value, 'DSH upstream session id', 256);
}

function boundedWorkspacePath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4_096
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Project Quest requires a valid workspace directory');
  }
  return value;
}

function comparableWorkspacePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/g, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function questSessionId(projectId: string, agentId: string): string {
  const digest = createHash('sha256').update(`${projectId}\u0000${agentId}`, 'utf8').digest('hex');
  return `dsh-quest-${digest.slice(0, 40)}`;
}

function workspaceQuestSessionId(
  projectId: string,
  agentId: string,
  workspacePath: string,
  profileId: string
): string {
  const digest = createHash('sha256')
    .update(`workspace-v2\u0000${projectId}\u0000${agentId}\u0000${profileId}\u0000${comparableWorkspacePath(workspacePath)}`, 'utf8')
    .digest('hex');
  return `dsh-quest-${digest.slice(0, 40)}`;
}

// Keep this identity compatible with DshManagedExecutor so a later project
// task reuses the same UNIQUE(agent_id, profile_id) projection.
function defaultRuntimeInstanceId(agentId: string, profileId: string): string {
  return `dsh-runtime-${agentId}-${profileId}`.slice(0, 120);
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Creates or recovers the one durable Cordis root selected by a project Quest.
 * Remote mutation is reconciled before the local session and project binding
 * commit, so restarting after any partial failure remains idempotent.
 */
export class DshQuestSessionBindingService {
  private readonly baseProfileId: string;
  private readonly runtimeCapabilities: Readonly<Record<string, boolean>>;
  private readonly clientFactory: (endpoint: string) => DshControlPort;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Database,
    private readonly sessions: DshSessionService,
    private readonly supervisor: DshQuestRuntimeAuthority,
    private readonly workbench: ProjectWorkbenchService,
    options: DshQuestSessionBindingOptions = {}
  ) {
    this.baseProfileId = boundedId(options.profileId ?? DSH_MANAGED_PROFILE_ID, 'DSH profile id');
    this.runtimeCapabilities = options.runtimeCapabilities ?? DSH_MANAGED_CAPABILITIES_DISABLED;
    this.clientFactory = options.clientFactory ?? ((endpoint) => new DshControlClient(endpoint));
    this.sleep = options.sleep ?? defaultSleep;
  }

  resolveOrCreate(input: ResolveDshQuestSessionInput): Promise<DshQuestSessionBinding> {
    const run = this.mutationTail.then(
      () => this.resolveOrCreateNow(input),
      () => this.resolveOrCreateNow(input)
    );
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async resolveOrCreateNow(input: ResolveDshQuestSessionInput): Promise<DshQuestSessionBinding> {
    const projectId = boundedId(input.projectId, 'project id');
    const agentId = boundedId(input.agent?.id, 'DSH agent id');
    const profileId = dshManagedProjectProfileId(projectId, this.baseProfileId);
    if (input.agent.engineId !== DSH_MANAGED_ENGINE_ID) {
      throw new Error('Project Quest requires a managed DSH employee');
    }
    const requestedSessionId = input.requestedSessionId === null || input.requestedSessionId === undefined
      ? null
      : boundedId(input.requestedSessionId, 'requested DSH session id');

    const projectView = this.workbench.get(projectId);
    const projectedRootId = projectView.rootSession?.sessionId ?? null;
    if (requestedSessionId !== null && requestedSessionId !== projectedRootId) {
      throw new Error('Requested DSH session is not the current project root');
    }

    const deterministicId = questSessionId(projectId, agentId);
    const localSession = projectedRootId
      ? this.requireSession(projectedRootId)
      : this.sessions.findSession(deterministicId);
    if (localSession) this.assertSessionOwnership(localSession, agentId);

    // This verifies project/organization ownership and rejects a deterministic
    // orphan that was already linked or bound to another project.
    this.workbench.resolveExecutionContext(projectId, agentId, localSession?.sessionId ?? null);

    const projectWorkspace = boundedWorkspacePath(
      this.workbench.getExplicitWorkspacePath(projectId) ?? localSession?.workspace ?? ''
    );
    const workspaceChanged = localSession !== null
      && comparableWorkspacePath(localSession.workspace) !== comparableWorkspacePath(projectWorkspace);
    const runtimeProfileChanged = localSession !== null
      && this.runtimeProfileForSession(localSession.sessionId) !== profileId;
    const targetSessionId = workspaceChanged || runtimeProfileChanged
      ? workspaceQuestSessionId(projectId, agentId, projectWorkspace, profileId)
      : localSession?.sessionId ?? deterministicId;
    const targetSession = workspaceChanged
      ? this.sessions.findSession(targetSessionId)
      : localSession;
    if (targetSession) {
      this.assertSessionOwnership(targetSession, agentId);
      if (comparableWorkspacePath(targetSession.workspace) !== comparableWorkspacePath(projectWorkspace)) {
        throw new Error('Project DSH workspace root belongs to another directory');
      }
    }
    const runtimeWorkspace = projectWorkspace;
    this.sessions.upsertProfile({
      id: profileId,
      engineId: input.agent.engineId,
      providerProfile: 'managed-proxy',
      policy: {
        mode: 'workspace-write',
        capabilities: Object.entries(this.runtimeCapabilities)
          .filter(([, enabled]) => enabled)
          .map(([name]) => name)
      },
      version: PROFILE_VERSION
    });

    const runtimeInstanceId = targetSession?.runtimeInstanceId
      ?? this.runtimeInstanceIdFor(agentId, profileId);
    this.assertRuntimeOwnership(runtimeInstanceId, agentId, profileId);
    if (targetSession && targetSession.runtimeInstanceId !== runtimeInstanceId) {
      throw new Error('Project DSH workspace root crosses its managed runtime boundary');
    }
    const runtime = await this.supervisor.start({
      agentId,
      profileId,
      workspace: runtimeWorkspace
    });
    if (runtime.processState !== 'READY' || !runtime.endpoint) {
      throw new Error('DSH runtime is not ready for project Quest');
    }
    this.sessions.upsertRuntimeInstance({
      id: runtimeInstanceId,
      agentId,
      profileId,
      processState: runtime.processState,
      endpoint: runtime.endpoint,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { ...this.runtimeCapabilities },
      heartbeatAt: runtime.lastHealthAt,
      crashCount: runtime.crashCount
    });

    const upstreamSessionId = boundedUpstreamSessionId(
      targetSession?.upstreamSessionId ?? targetSessionId
    );
    const client = this.clientFactory(runtime.endpoint);
    const upstreamWorkspace = await this.ensureUpstreamWorkspace(client, projectWorkspace);
    await this.ensureUpstreamCordisSession(client, upstreamSessionId, upstreamWorkspace);

    const localSessionId = targetSession?.sessionId ?? targetSessionId;
    this.db.transaction(() => {
      if (!targetSession) {
        this.sessions.upsertSession({
          id: localSessionId,
          upstreamSessionId,
          runtimeInstanceId,
          agentId,
          workspace: projectWorkspace,
          controlMode: 'NEXUS_MANAGED'
        });
      }
      this.workbench.bindRootSession(projectId, localSessionId);
    });

    return {
      localSessionId,
      upstreamSessionId,
      profileId,
      runtimeWorkspace
    };
  }

  private requireSession(sessionId: string): DshSessionRecord {
    const session = this.sessions.findSession(sessionId);
    if (!session) throw new Error('Project DSH root session does not exist');
    return session;
  }

  private assertSessionOwnership(session: DshSessionRecord, agentId: string): void {
    if (session.agentId !== agentId) throw new Error('Project DSH root belongs to another employee');
    if (session.parentSessionId !== null || session.delegationDepth !== 0) {
      throw new Error('Project DSH selection must be a root session');
    }
    boundedUpstreamSessionId(session.upstreamSessionId);
  }

  private runtimeInstanceIdFor(agentId: string, profileId: string): string {
    const rows = this.db.raw.prepare(
      `SELECT id FROM dsh_runtime_instances
       WHERE agent_id = ? AND profile_id = ? LIMIT 2`
    ).all(agentId, profileId) as Array<{ id?: unknown }>;
    if (rows.length > 1) throw new Error('DSH runtime projection is ambiguous');
    return rows.length === 1
      ? boundedId(rows[0]?.id, 'DSH runtime instance id')
      : defaultRuntimeInstanceId(agentId, profileId);
  }

  private assertRuntimeOwnership(runtimeInstanceId: string, agentId: string, profileId: string): void {
    const row = this.db.raw.prepare(
      'SELECT agent_id, profile_id FROM dsh_runtime_instances WHERE id = ?'
    ).get(runtimeInstanceId) as { agent_id?: unknown; profile_id?: unknown } | undefined;
    if (!row) return;
    if (row.agent_id !== agentId || row.profile_id !== profileId) {
      throw new Error('Project DSH root crosses its managed runtime boundary');
    }
  }

  private runtimeProfileForSession(sessionId: string): string | null {
    const row = this.db.raw.prepare(`
      SELECT r.profile_id
      FROM dsh_sessions s
      JOIN dsh_runtime_instances r ON r.id = s.runtime_instance_id
      WHERE s.id = ?
    `).get(sessionId) as { profile_id?: unknown } | undefined;
    return typeof row?.profile_id === 'string' ? row.profile_id : null;
  }

  private async ensureUpstreamCordisSession(
    client: DshControlPort,
    upstreamSessionId: string,
    workspace: DshWorkspaceSummary
  ): Promise<void> {
    const matches = (await client.listSessions())
      .filter((session) => session.sessionId === upstreamSessionId);
    if (matches.length > 1) throw new Error('DSH upstream session is ambiguous');
    if (matches.length === 1) {
      this.assertCordisPreset(matches[0]!);
      this.assertSessionWorkspace(matches[0]!, workspace);
      if (workspace.sessionIds.includes(upstreamSessionId)) return;
    }

    const rpcId = `dsh-quest-create-${createHash('sha256')
      .update(upstreamSessionId, 'utf8').digest('hex').slice(0, 32)}`;
    try {
      const created = await client.createSession({
        workspaceId: workspace.workspaceId,
        sessionId: upstreamSessionId,
        agentPreset: EXPECTED_AGENT_PRESET
      }, rpcId);
      if (created.sessionId !== upstreamSessionId) {
        throw new DshAmbiguousTransportError(
          'session.create', rpcId, new Error('DSH created an unexpected project session')
        );
      }
      if (created.agentPreset !== EXPECTED_AGENT_PRESET) {
        throw new DshAmbiguousTransportError(
          'session.create', rpcId, new Error('DSH did not confirm the Cordis preset')
        );
      }
    } catch (error) {
      if (!(error instanceof DshAmbiguousTransportError)) throw error;
      const recovered = await this.confirmUpstreamSession(
        client,
        upstreamSessionId,
        workspace.workspaceId
      );
      if (!recovered) throw error;
      this.assertCordisPreset(recovered);
      this.assertSessionWorkspace(recovered, workspace);
    }
  }

  private async ensureUpstreamWorkspace(
    client: DshControlPort,
    workspacePath: string
  ): Promise<DshWorkspaceSummary> {
    const rpcId = `dsh-quest-workspace-${createHash('sha256')
      .update(workspacePath, 'utf8').digest('hex').slice(0, 32)}`;
    try {
      return (await client.createWorkspace({ path: workspacePath }, rpcId)).workspace;
    } catch (error) {
      if (!(error instanceof DshAmbiguousTransportError)) throw error;
      const recovered = await this.confirmUpstreamWorkspace(client, workspacePath);
      if (!recovered) throw error;
      return recovered;
    }
  }

  private async confirmUpstreamWorkspace(
    client: DshControlPort,
    workspacePath: string
  ): Promise<DshWorkspaceSummary | null> {
    const expected = comparableWorkspacePath(workspacePath);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const matches = (await client.listWorkspaces()).items.filter((workspace) => (
          comparableWorkspacePath(workspace.path) === expected
        ));
        if (matches.length > 1) throw new Error('DSH upstream workspace is ambiguous');
        if (matches[0]) return matches[0];
      } catch (error) {
        if (error instanceof Error && error.message === 'DSH upstream workspace is ambiguous') throw error;
      }
      if (attempt < 2) await this.sleep(100 * (attempt + 1));
    }
    return null;
  }

  private async confirmUpstreamSession(
    client: DshControlPort,
    upstreamSessionId: string,
    workspaceId: string
  ): Promise<DshSessionSummary | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const [sessions, workspaces] = await Promise.all([
          client.listSessions(),
          client.listWorkspaces()
        ]);
        const matches = sessions
          .filter((session) => session.sessionId === upstreamSessionId);
        if (matches.length > 1) throw new Error('DSH upstream session is ambiguous');
        const workspaceMatches = workspaces.items.filter((workspace) => workspace.workspaceId === workspaceId);
        if (workspaceMatches.length > 1) throw new Error('DSH upstream workspace is ambiguous');
        if (matches[0] && workspaceMatches[0]?.sessionIds.includes(upstreamSessionId)) return matches[0];
      } catch (error) {
        if (error instanceof Error && (
          error.message === 'DSH upstream session is ambiguous'
          || error.message === 'DSH upstream workspace is ambiguous'
        )) throw error;
      }
      if (attempt < 2) await this.sleep(100 * (attempt + 1));
    }
    return null;
  }

  private assertCordisPreset(session: DshSessionSummary): void {
    if (session.agentPreset !== EXPECTED_AGENT_PRESET) {
      throw new Error('Project DSH root does not use the Cordis preset');
    }
  }

  private assertSessionWorkspace(session: DshSessionSummary, workspace: DshWorkspaceSummary): void {
    if (!session.cwd
      || comparableWorkspacePath(session.cwd) !== comparableWorkspacePath(workspace.path)) {
      throw new Error('Project DSH root belongs to another workspace');
    }
  }
}
