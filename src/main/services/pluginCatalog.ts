/**
 * Unified, read-only view of the plugin boundary.
 *
 * MCP servers and database-backed Skills are managed by their existing Nexus
 * owners, but this projection lets the UI
 * present them as one catalog without exposing commands, environment values,
 * skill bodies, or package internals to Renderer.
 */
import type {
  PluginCatalogItemView,
  PluginCatalogKind,
  PluginLifecycleStatus,
  PluginCatalogSafety,
  PluginCatalogSource,
  PluginCatalogStatus,
  PluginCatalogView,
  Engine
} from '../../shared/types.js';
import { isRetiredExecutionEngine } from '../../shared/engineVisibility.js';
import type { McpManager, McpServerConfig } from './mcpManager.js';
import type { CapabilityRegistry, RegisteredPlugin, PluginCapability, PluginHost } from './pluginHost.js';
import type { Skill, SkillManager } from './skillManager.js';

const MAX_ITEMS = 512;
const MAX_WARNINGS = 64;
const MAX_REASON_CODES = 24;

function publicOwner(owner: string): 'nexus-governance' | 'legacy' {
  return owner === 'nexus-governance' ? 'nexus-governance' : 'legacy';
}

export interface PluginCatalogOptions {
  registry?: CapabilityRegistry;
  host?: Pick<PluginHost, 'isAttached'>;
  /** `toggle`/`update` are optional so read-only diagnostics fixtures remain lightweight. */
  mcp?: Pick<McpManager, 'list'> & Partial<Pick<McpManager, 'toggle'>>;
  skills?: Pick<SkillManager, 'list'> & Partial<Pick<SkillManager, 'update'>>;
  /** Existing engine manager remains authoritative; this is a redacted worker-adapter projection. */
  engines?: { list(): Engine[] };
  /** A healthy local engine is only a governed Worker after its invocation
   * bridge is registered. Omitted means declaration-only and fails closed. */
  workerBridgeAvailable?: (engineId: string) => boolean;
  now?: () => number;
}

function uniqueBounded(values: Iterable<string>, maximum = MAX_REASON_CODES): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 160) continue;
    if (!result.includes(value)) result.push(value);
    if (result.length >= maximum) break;
  }
  return result;
}

function kindForCapabilities(capabilities: readonly PluginCapability[]): PluginCatalogKind {
  const kinds = new Set(capabilities.map((capability) => capability.kind));
  if (kinds.has('engine')) return 'engine';
  if (kinds.has('tool')) return 'tool';
  if (kinds.has('skill')) return 'skill';
  if (kinds.has('artifact')) return 'artifact';
  if (kinds.has('channel')) return 'channel';
  return 'integration';
}

function safetyForPermissions(permissions: readonly string[]): PluginCatalogSafety {
  if (permissions.some((permission) => permission === 'process.exec' || permission === 'filesystem.write')) return 'review';
  return 'trusted';
}

function hostItem(plugin: RegisteredPlugin, host?: Pick<PluginHost, 'isAttached'>): PluginCatalogItemView {
  const capabilities = plugin.manifest.capabilities;
  const permissions = uniqueBounded(capabilities.flatMap((capability) => capability.permissions ?? []));
  const disabled = !plugin.enabled;
  const attachedCount = capabilities.filter((capability) => host?.isAttached(plugin.manifest.id, capability.id) === true).length;
  const fullyAttached = capabilities.length > 0 && attachedCount === capabilities.length;
  const partiallyAttached = attachedCount > 0 && !fullyAttached;
  return {
    id: `host:${plugin.manifest.id}`,
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    source: 'host',
    kind: kindForCapabilities(capabilities),
    owner: publicOwner(plugin.manifest.owner),
    status: disabled ? 'disabled' : partiallyAttached ? 'degraded' : 'ready',
    lifecycle: disabled ? 'disabled' : fullyAttached ? 'live' : partiallyAttached ? 'review' : 'installed',
    safety: safetyForPermissions(permissions),
    enabled: plugin.enabled,
    installed: true,
    configured: fullyAttached,
    capabilities: uniqueBounded(capabilities.map((capability) => capability.id), 64),
    permissions,
    reasonCodes: disabled ? ['DISABLED_BY_HOST'] : partiallyAttached ? ['PARTIAL_CAPABILITY_BINDING'] : [],
    updatedAt: plugin.registeredAt
  };
}

function mcpItem(server: McpServerConfig): PluginCatalogItemView {
  const status: PluginCatalogStatus = !server.enabled
    ? 'disabled'
    : server.running
      ? 'ready'
      : 'degraded';
  const reasonCodes = !server.enabled
    ? ['DISABLED_BY_USER']
    : server.running
      ? []
      : ['NOT_RUNNING'];
  return {
    id: `mcp:${server.id}`,
    name: server.name,
    version: null,
    source: 'mcp',
    kind: 'integration',
    owner: 'legacy',
    status,
    lifecycle: !server.enabled ? 'disabled' : server.running ? 'live' : 'installed',
    // An MCP process is an executable integration and therefore requires a
    // review decision even though this projection cannot grant permissions.
    safety: 'review',
    enabled: server.enabled,
    installed: true,
    configured: true,
    capabilities: uniqueBounded([
      'mcp',
      ...(server.capability ? [server.capability] : [])
    ], 16),
    permissions: ['process.exec'],
    reasonCodes: uniqueBounded(reasonCodes),
    updatedAt: null
  };
}

function skillItem(skill: Skill): PluginCatalogItemView {
  const builtIn = skill.id.startsWith('skill-browser-') || skill.id.startsWith('skill-vision-');
  return {
    id: `skill:${skill.id}`,
    name: skill.name,
    version: '1.0.0',
    source: 'skill',
    kind: 'skill',
    owner: builtIn ? 'nexus-governance' : 'legacy',
    status: skill.enabled ? 'ready' : 'disabled',
    lifecycle: skill.enabled ? 'live' : 'disabled',
    safety: builtIn ? 'trusted' : 'review',
    enabled: skill.enabled,
    installed: true,
    configured: true,
    capabilities: ['skill', skill.id],
    permissions: ['skill.read'],
    reasonCodes: skill.enabled ? [] : ['DISABLED_BY_USER'],
    updatedAt: skill.createdAt
  };
}

const CLI_ENGINE_TYPES = new Set<Engine['type']>(['hermes-cli', 'codex', 'claude', 'pi', 'opencode']);

function engineAdapterItem(engine: Engine, workerBridgeAvailable?: (engineId: string) => boolean): PluginCatalogItemView | null {
  // These runtimes remain available to historical/governed workers, but are
  // not user-installable plugins and must not reappear in the shared catalog.
  if (isRetiredExecutionEngine(engine)) return null;
  const source: PluginCatalogSource | null = CLI_ENGINE_TYPES.has(engine.type)
    ? 'cli'
    : engine.type === 'external'
      ? 'acp'
      : null;
  if (!source) return null;
  const installed = engine.status !== 'NOT_INSTALLED';
  let bridgeReady = false;
  try { bridgeReady = workerBridgeAvailable?.(engine.id) === true; } catch { bridgeReady = false; }
  const engineReady = engine.status === 'HEALTHY';
  const live = engineReady && bridgeReady;
  const broken = engine.status === 'ERROR';
  const lifecycle: PluginLifecycleStatus = !installed
    ? 'missing'
    : live
      ? 'live'
      : broken
        ? 'broken'
        : 'review';
  const status: PluginCatalogStatus = !installed
    ? 'missing'
    : live
      ? 'ready'
      : broken
        ? 'blocked'
        : 'degraded';
  return {
    id: `${source}:${engine.id}`,
    name: engine.name,
    version: engine.version,
    source,
    kind: source === 'cli' ? 'cli-adapter' : 'acp-adapter',
    owner: 'nexus-governance',
    status,
    lifecycle,
    safety: 'review',
    enabled: live,
    installed,
    configured: live && engine.authStatus === 'authed' && engine.healthSignals?.taskVerified === true,
    capabilities: uniqueBounded(['worker', engine.type, engine.id], 16),
    permissions: ['process.exec'],
    reasonCodes: uniqueBounded([
      ...(engineReady ? [] : [engine.status]),
      ...(bridgeReady ? [] : ['WORKER_BRIDGE_UNAVAILABLE'])
    ]),
    updatedAt: engine.healthSignals?.checkedAt ?? null
  };
}

/**
 * ACP/A2A capabilities remain declarations until a handler is attached. This
 * extra row makes the transport visible without promoting its host plugin to
 * the Quest/Hermes orchestration role.
 */
function registryAdapterItems(
  plugin: RegisteredPlugin,
  host?: Pick<PluginHost, 'isAttached'>
): PluginCatalogItemView[] {
  return plugin.manifest.capabilities.flatMap((capability): PluginCatalogItemView[] => {
    if (capability.kind !== 'a2a') return [];
    const source: 'acp' | 'a2a' = capability.protocol === 'acp' || capability.executionAdapter === 'acp' ? 'acp' : 'a2a';
    const attached = host?.isAttached(plugin.manifest.id, capability.id) === true;
    const disabled = !plugin.enabled;
    return [{
      id: `${source}:${plugin.manifest.id}.${capability.id}`,
      name: capability.description || `${plugin.manifest.name} ${source.toUpperCase()} adapter`,
      version: capability.version,
      source,
      kind: source === 'acp' ? 'acp-adapter' : 'a2a-adapter',
      owner: publicOwner(plugin.manifest.owner),
      status: disabled ? 'disabled' : attached ? 'ready' : 'degraded',
      lifecycle: disabled ? 'disabled' : attached ? 'live' : 'review',
      safety: 'review',
      enabled: plugin.enabled && attached,
      installed: true,
      configured: attached,
      capabilities: uniqueBounded([capability.id, ...(capability.operations ?? [])], 32),
      permissions: uniqueBounded(capability.permissions ?? []),
      reasonCodes: disabled ? ['DISABLED_BY_HOST'] : attached ? [] : ['DECLARATION_ONLY'],
      updatedAt: plugin.registeredAt
    }];
  });
}

/** Build a bounded, deterministic catalog snapshot. */
export class PluginCatalogService {
  private readonly now: () => number;

  constructor(private readonly options: PluginCatalogOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Attach managers after the main-process dependency graph is built. */
  setSources(sources: Pick<PluginCatalogOptions, 'mcp' | 'skills' | 'engines'>): void {
    if (sources.mcp) this.options.mcp = sources.mcp;
    if (sources.skills) this.options.skills = sources.skills;
    if (sources.engines) this.options.engines = sources.engines;
  }

  /**
   * Toggle only database-backed sources and in-memory Host plugins.
   * Worker runtime enablement is derived from its engine health and cannot be
   * changed by this generic plugin action.
   */
  setEnabled(id: string, enabled: boolean): void {
    if (typeof id !== 'string' || !/^(?:host|mcp|skill|cli|acp|a2a):[A-Za-z0-9._-]{1,200}$/.test(id)) {
      throw new Error('Invalid plugin id');
    }
    if (typeof enabled !== 'boolean') throw new Error('Plugin enabled flag is invalid');
    const separator = id.indexOf(':');
    const source = id.slice(0, separator);
    const sourceId = id.slice(separator + 1);
    if (source === 'host') {
      if (!this.options.registry) throw new Error('Plugin host is unavailable');
      this.options.registry.setEnabled(sourceId, enabled);
      return;
    }
    if (source === 'mcp') {
      if (!this.options.mcp || !this.options.mcp.list().some((item) => item.id === sourceId)) throw new Error('MCP plugin not found');
      if (!this.options.mcp.toggle) throw new Error('MCP plugin manager is read-only');
      this.options.mcp.toggle(sourceId, enabled);
      return;
    }
    if (source === 'skill') {
      if (!this.options.skills || !this.options.skills.list().some((item) => item.id === sourceId)) throw new Error('Skill plugin not found');
      if (!this.options.skills.update) throw new Error('Skill plugin manager is read-only');
      this.options.skills.update(sourceId, { enabled });
      return;
    }
    throw new Error('Worker adapter enablement is controlled by the engine health check');
  }

  getCatalog(): PluginCatalogView {
    const scannedAt = this.now();
    const items: PluginCatalogItemView[] = [];
    const warnings: string[] = [];
    const warn = (message: string) => {
      if (warnings.length < MAX_WARNINGS && !warnings.includes(message)) warnings.push(message);
    };

    if (this.options.registry) {
      try {
        for (const plugin of this.options.registry.list()) {
          if (items.length >= MAX_ITEMS) break;
          items.push(hostItem(plugin, this.options.host));
          for (const adapter of registryAdapterItems(plugin, this.options.host)) {
            if (items.length >= MAX_ITEMS) break;
            items.push(adapter);
          }
        }
      } catch (error) {
        warn(`HOST_CATALOG_ERROR:${error instanceof Error ? error.message : String(error)}`.slice(0, 240));
      }
    }

    if (this.options.mcp) {
      try {
        for (const server of this.options.mcp.list()) {
          if (items.length >= MAX_ITEMS) break;
          items.push(mcpItem(server));
        }
      } catch (error) {
        warn(`MCP_CATALOG_ERROR:${error instanceof Error ? error.message : String(error)}`.slice(0, 240));
      }
    }

    if (this.options.skills) {
      try {
        for (const skill of this.options.skills.list()) {
          if (items.length >= MAX_ITEMS) break;
          items.push(skillItem(skill));
        }
      } catch (error) {
        warn(`SKILL_CATALOG_ERROR:${error instanceof Error ? error.message : String(error)}`.slice(0, 240));
      }
    }

    if (this.options.engines) {
      try {
        for (const engine of this.options.engines.list()) {
          if (items.length >= MAX_ITEMS) break;
          const item = engineAdapterItem(engine, this.options.workerBridgeAvailable);
          if (item) items.push(item);
        }
      } catch (error) {
        warn(`ENGINE_ADAPTER_CATALOG_ERROR:${error instanceof Error ? error.message : String(error)}`.slice(0, 240));
      }
    }

    items.sort((left, right) => `${left.source}:${left.name}`.localeCompare(`${right.source}:${right.name}`));
    const counts: Record<PluginCatalogStatus, number> = {
      ready: 0, disabled: 0, blocked: 0, missing: 0, degraded: 0
    };
    const sourceCounts: Record<PluginCatalogSource, number> = {
      host: 0, mcp: 0, skill: 0, cli: 0, acp: 0, a2a: 0
    };
    for (const item of items) {
      counts[item.status] += 1;
      sourceCounts[item.source] += 1;
    }
    if (items.length >= MAX_ITEMS) warn('PLUGIN_CATALOG_TRUNCATED');
    return { scannedAt, items, counts, sourceCounts, warnings };
  }
}

export function scanPluginCatalog(options: PluginCatalogOptions = {}): PluginCatalogView {
  return new PluginCatalogService(options).getCatalog();
}
