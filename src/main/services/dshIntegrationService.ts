import { createHash } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type {
  Agent,
  DshEmbeddedWorkbenchBounds,
  DshEmbeddedWorkbenchStatus,
  DshRuntimeStatusView,
  DshWorkbenchStatus
} from '../../shared/types.js';
import { DSH_MANAGED_PROFILE_ID } from './deepseekHarnessManagedRuntime.js';
import { DshEmbeddedWorkbenchManager } from './dshEmbeddedWorkbench.js';
import { DshSupervisor, type DshRuntimeStatus } from './dshSupervisor.js';
import { DshWebGateway } from './dshWebGateway.js';
import { DshWindowManager } from './dshWindowManager.js';
import type { DshBrowserWriteGuard } from './dshSessionWriteCoordinator.js';
import type { DshLeaseGrant } from './dshSessionService.js';

type WindowFactory = (gateway: DshWebGateway, partition: string) => DshWindowManager;
type EmbeddedWorkbenchFactory = (gateway: DshWebGateway, partition: string) => DshEmbeddedWorkbenchManager;

export interface DshIntegrationOptions {
  enabled?: boolean;
  createWindowManager?: WindowFactory;
  createEmbeddedWorkbench?: EmbeddedWorkbenchFactory;
  /** Main-process-only guard; the isolated Workbench never receives its token. */
  writeGuard?: DshBrowserWriteGuard;
}

export interface DshWorkbenchRuntimeBinding {
  profileId: string;
  workspace: string;
}

function partitionFor(agentId: string): string {
  const digest = createHash('sha256').update(agentId).digest('hex').slice(0, 20);
  return `persist:opc-nexus-dsh-${digest}`;
}

function embeddedPartitionFor(agentId: string): string {
  const digest = createHash('sha256').update(agentId).digest('hex').slice(0, 20);
  return `persist:opc-nexus-dsh-embedded-${digest}`;
}

const CLOSED_EMBEDDED_WORKBENCH: DshEmbeddedWorkbenchStatus = {
  open: false,
  attached: false,
  visible: false,
  loading: false,
  bounds: null
};

function runtimeView(status: DshRuntimeStatus | null): DshRuntimeStatusView | null {
  if (!status) return null;
  return {
    agentId: status.agentId,
    processState: status.processState,
    pid: status.pid,
    startedAt: status.startedAt,
    readyAt: status.readyAt,
    lastHealthAt: status.lastHealthAt,
    nextRestartAt: status.nextRestartAt,
    restartCount: status.restartCount,
    crashCount: status.crashCount,
    lastError: status.lastError
  };
}

/** Coordinates one isolated Workbench with independently persistent per-Agent runtimes. */
export class DshIntegrationService {
  private readonly enabled: boolean;
  private readonly createWindowManager: WindowFactory;
  private readonly createEmbeddedWorkbench: EmbeddedWorkbenchFactory;
  private readonly writeGuard: DshBrowserWriteGuard | null;
  private windowManager: DshWindowManager | null = null;
  private embeddedWorkbench: DshEmbeddedWorkbenchManager | null = null;
  private activeAgentId: string | null = null;
  private activeProfileId: string | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private shuttingDown = false;

  constructor(
    private readonly supervisor: DshSupervisor,
    private readonly gateway: DshWebGateway,
    options: DshIntegrationOptions = {}
  ) {
    this.enabled = options.enabled ?? true;
    this.writeGuard = options.writeGuard ?? null;
    this.createWindowManager = options.createWindowManager
      ?? ((targetGateway, partition) => new DshWindowManager(targetGateway, { partition }));
    this.createEmbeddedWorkbench = options.createEmbeddedWorkbench
      ?? ((targetGateway, partition) => new DshEmbeddedWorkbenchManager(targetGateway, { partition }));
    this.gateway.setWriteGuard?.(this.writeGuard, () => this.activeAgentId);
  }

  getStatus(agentId: string): DshWorkbenchStatus {
    const gatewayStatus = this.gateway.getStatus();
    const ownsWindow = this.activeAgentId === agentId;
    return {
      runtime: runtimeView(this.supervisor.getStatus(agentId, DSH_MANAGED_PROFILE_ID)),
      gateway: {
        state: gatewayStatus.state,
        running: gatewayStatus.running,
        activeDesktopSessions: gatewayStatus.activeDesktopSessions,
        lastError: gatewayStatus.lastError
      },
      window: ownsWindow && this.windowManager
        ? this.windowManager.getStatus()
        : { open: false, visible: false, loading: false }
    };
  }

  getEmbeddedWorkbenchStatus(): DshEmbeddedWorkbenchStatus {
    return this.embeddedWorkbench?.getStatus() ?? { ...CLOSED_EMBEDDED_WORKBENCH };
  }

  /**
   * Handoff an IPC-approved human takeover to the isolated desktop gateway.
   * The bearer grant remains in Main and is consumed by the write coordinator
   * on the first projected browser command.
   */
  adoptDesktopTakeover(sessionId: string, grant: DshLeaseGrant): void {
    this.writeGuard?.adoptLease?.(sessionId, grant);
  }

  async start(agent: Pick<Agent, 'id' | 'workspace'>): Promise<DshWorkbenchStatus> {
    return this.enqueue(async () => {
      this.assertAvailable();
      await this.supervisor.start({
        agentId: agent.id,
        profileId: DSH_MANAGED_PROFILE_ID,
        workspace: agent.workspace || undefined
      });
      return this.getStatus(agent.id);
    });
  }

  async stop(agentId: string): Promise<DshWorkbenchStatus> {
    return this.enqueue(async () => {
      if (this.activeAgentId === agentId) await this.releaseWorkbench();
      await this.supervisor.stop(agentId, DSH_MANAGED_PROFILE_ID);
      return this.getStatus(agentId);
    });
  }

  async openWorkbench(agent: Pick<Agent, 'id' | 'workspace'>): Promise<DshWorkbenchStatus> {
    return this.enqueue(async () => {
      await this.prepareWorkbench(agent);
      await this.windowManager!.open();
      return this.getStatus(agent.id);
    });
  }

  async openEmbeddedWorkbench(
    agent: Pick<Agent, 'id' | 'workspace'>,
    host: BrowserWindow,
    bounds: DshEmbeddedWorkbenchBounds,
    upstreamSessionId: string | null = null,
    runtimeBinding?: DshWorkbenchRuntimeBinding
  ): Promise<DshEmbeddedWorkbenchStatus> {
    return this.enqueue(async () => {
      await this.prepareWorkbench(agent, runtimeBinding);
      return this.embeddedWorkbench!.open(host, bounds, upstreamSessionId);
    });
  }

  setEmbeddedWorkbenchBounds(bounds: DshEmbeddedWorkbenchBounds): DshEmbeddedWorkbenchStatus {
    return this.embeddedWorkbench?.setBounds(bounds) ?? { ...CLOSED_EMBEDDED_WORKBENCH };
  }

  setEmbeddedWorkbenchVisible(visible: boolean): DshEmbeddedWorkbenchStatus {
    return this.embeddedWorkbench?.setVisible(visible) ?? { ...CLOSED_EMBEDDED_WORKBENCH };
  }

  closeEmbeddedWorkbench(): Promise<DshEmbeddedWorkbenchStatus> {
    return this.enqueue(async () => (
      this.embeddedWorkbench?.close() ?? { ...CLOSED_EMBEDDED_WORKBENCH }
    ));
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.enqueue(async () => {
      await this.releaseWorkbench();
      await this.supervisor.shutdownAll();
    });
  }

  private async releaseWorkbench(): Promise<void> {
    this.windowManager?.close();
    this.embeddedWorkbench?.close();
    this.windowManager = null;
    this.embeddedWorkbench = null;
    this.activeAgentId = null;
    this.activeProfileId = null;
    await this.gateway.stop();
  }

  private async prepareWorkbench(
    agent: Pick<Agent, 'id' | 'workspace'>,
    runtimeBinding?: DshWorkbenchRuntimeBinding
  ): Promise<void> {
    this.assertAvailable();
    const profileId = runtimeBinding?.profileId ?? DSH_MANAGED_PROFILE_ID;
    const workspace = runtimeBinding?.workspace ?? agent.workspace;
    const runtime = await this.supervisor.start({
      agentId: agent.id,
      profileId,
      workspace: workspace || undefined
    });
    if (!runtime.endpoint || runtime.processState !== 'READY') {
      throw new Error('DSH Runtime 尚未就绪');
    }

    if (this.activeAgentId !== agent.id || this.activeProfileId !== profileId) {
      // A resolver switch revokes every authenticated desktop session before
      // the shared gateway is rebound to another employee runtime.
      await this.releaseWorkbench();
      this.gateway.setUpstreamResolver(() => {
        const current = this.supervisor.getStatus(agent.id, profileId);
        return current?.processState === 'READY' ? current.endpoint : null;
      });
      this.gateway.setWriteGuard?.(this.writeGuard, () => this.activeAgentId);
      await this.gateway.start();
      const runtimeIdentity = `${agent.id}\u0000${profileId}`;
      this.windowManager = this.createWindowManager(this.gateway, partitionFor(runtimeIdentity));
      this.embeddedWorkbench = this.createEmbeddedWorkbench(this.gateway, embeddedPartitionFor(runtimeIdentity));
      this.activeAgentId = agent.id;
      this.activeProfileId = profileId;
    } else if (!this.gateway.getStatus().running) {
      await this.gateway.start();
    }
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new Error('DSH managed runtime feature is disabled');
  }

  private assertAvailable(): void {
    this.assertEnabled();
    if (this.shuttingDown) throw new Error('DSH integration is shutting down');
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(operation, operation);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }
}
