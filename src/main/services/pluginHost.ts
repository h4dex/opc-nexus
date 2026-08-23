/**
 * Declarative capability registry for optional Main-process plugins.
 *
 * This layer intentionally does not load npm packages, own Agent/Task state,
 * read secrets, or write audit records. Existing managers remain the source of
 * truth; adapters can use this registry as a narrow declaration and dispatch
 * seam while they are introduced incrementally.
 */

export const PLUGIN_MANIFEST_SCHEMA_VERSION = 1 as const;
export const PLUGIN_HOST_API_VERSION = '1.0.0' as const;

/**
 * Ownership is deliberately explicit at the plugin boundary. Quest/Hermes
 * is the orchestrator; Nexus remains the host governance boundary.
 */
export const PLUGIN_OWNERS = ['nexus-governance'] as const;
export const DEFAULT_PLUGIN_OWNER = 'nexus-governance' as const;
export type PluginOwner = typeof PLUGIN_OWNERS[number];

/** Execution adapters are workers selected by Quest/Hermes, not orchestrators. */
export const PLUGIN_EXECUTION_ADAPTERS = [
  'local-cli',
  'hermes-cli',
  'codex-cli',
  'pi-cli',
  'claude-cli',
  'acp',
  'a2a',
  'mcp'
] as const;
export type PluginExecutionAdapter = typeof PLUGIN_EXECUTION_ADAPTERS[number];

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_METADATA_ENTRIES = 32;
const MAX_METADATA_VALUE_LENGTH = 512;

/** Permissions understood by the host. Secret, audit, and state ownership is deliberately absent. */
export const PLUGIN_PERMISSIONS = [
  'engine.use',
  'tool.execute',
  'skill.read',
  'artifact.read',
  'artifact.write',
  'channel.receive',
  'channel.send',
  'a2a.invoke',
  'network.request',
  'filesystem.read',
  'filesystem.write',
  'process.exec'
] as const;

export type PluginPermission = typeof PLUGIN_PERMISSIONS[number];
export type PluginCapabilityKind = 'engine' | 'tool' | 'skill' | 'artifact' | 'channel' | 'a2a';

export interface PluginCapabilityBase {
  /** Capability id is unique within a plugin and addressed with pluginId. */
  id: string;
  kind: PluginCapabilityKind;
  version: string;
  /** Inherited from the manifest and immutable for the life of a plugin. */
  owner: PluginOwner;
  /** Optional worker transport selected by the Quest/Hermes orchestrator. */
  executionAdapter?: PluginExecutionAdapter;
  description?: string;
  permissions?: readonly string[];
  metadata?: Readonly<Record<string, string>>;
}

export interface PluginEngineCapability extends PluginCapabilityBase {
  kind: 'engine';
  /** Host engine identity this adapter describes, when it already exists. */
  engineId?: string;
  protocols?: readonly string[];
}

export interface PluginToolCapability extends PluginCapabilityBase {
  kind: 'tool';
  toolName?: string;
  risk?: 'safe' | 'write' | 'danger';
  inputSchema?: Readonly<Record<string, unknown>>;
}

export interface PluginSkillCapability extends PluginCapabilityBase {
  kind: 'skill';
  skillId?: string;
  contentRef?: string;
}

export interface PluginArtifactCapability extends PluginCapabilityBase {
  kind: 'artifact';
  artifactKind?: string;
  mediaTypes?: readonly string[];
}

export interface PluginChannelCapability extends PluginCapabilityBase {
  kind: 'channel';
  channelType?: string;
  direction?: 'inbound' | 'outbound' | 'bidirectional';
}

export interface PluginA2aCapability extends PluginCapabilityBase {
  kind: 'a2a';
  protocol?: 'a2a' | 'acp';
  operations?: readonly string[];
}

export type PluginCapability =
  | PluginEngineCapability
  | PluginToolCapability
  | PluginSkillCapability
  | PluginArtifactCapability
  | PluginChannelCapability
  | PluginA2aCapability;

export interface PluginManifest {
  schemaVersion: number;
  id: string;
  name: string;
  version: string;
  /** Defaults to the Nexus host policy boundary. */
  owner: PluginOwner;
  /** Default worker adapter for capabilities that do not override it. */
  executionAdapter?: PluginExecutionAdapter;
  /** Semver range accepted by the plugin. Omitted means any 1.x host. */
  hostApiVersion?: string;
  /** Alias accepted for manifests that call the field apiVersion. */
  apiVersion?: string;
  description?: string;
  /** Union is intentionally an array: registration is deterministic and auditable by callers. */
  capabilities: readonly PluginCapability[];
  /** Optional union of capability permissions; capability entries must be a subset when present. */
  permissions?: readonly string[];
}

export interface RegisteredPlugin {
  manifest: Readonly<PluginManifest>;
  registeredAt: number;
  enabled: boolean;
}

export interface PluginRegistryOptions {
  hostApiVersion?: string;
  now?: () => number;
}

export type PluginErrorCode =
  | 'INVALID_MANIFEST'
  | 'INCOMPATIBLE_HOST'
  | 'DUPLICATE_PLUGIN'
  | 'DUPLICATE_CAPABILITY'
  | 'PLUGIN_NOT_FOUND'
  | 'CAPABILITY_NOT_FOUND'
  | 'PLUGIN_DISABLED'
  | 'HANDLER_NOT_FOUND'
  | 'HANDLER_ALREADY_ATTACHED'
  | 'PERMISSION_DENIED'
  | 'HANDLER_FAILED';

export class PluginHostError extends Error {
  constructor(
    readonly code: PluginErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'PluginHostError';
  }
}

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const KNOWN_PERMISSIONS = new Set<string>(PLUGIN_PERMISSIONS);
const KNOWN_OWNERS = new Set<string>(PLUGIN_OWNERS);
const KNOWN_EXECUTION_ADAPTERS = new Set<string>(PLUGIN_EXECUTION_ADAPTERS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, label: string, maximum: number, required = true): string {
  if (typeof value !== 'string') {
    if (!required && (value === undefined || value === null)) return '';
    throw new PluginHostError('INVALID_MANIFEST', `${label} must be a string`);
  }
  if (required && value.trim().length === 0) throw new PluginHostError('INVALID_MANIFEST', `${label} is required`);
  if (value !== value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new PluginHostError('INVALID_MANIFEST', `${label} is invalid`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  const normalized = boundedString(value, label, 128);
  if (!IDENTIFIER.test(normalized)) throw new PluginHostError('INVALID_MANIFEST', `${label} is invalid`);
  return normalized;
}

function normalizeOwner(value: unknown, label: string, fallback: PluginOwner = DEFAULT_PLUGIN_OWNER): PluginOwner {
  const candidate = value === undefined ? fallback : boundedString(value, label, 64);
  if (!KNOWN_OWNERS.has(candidate)) {
    throw new PluginHostError('INVALID_MANIFEST', `${label} must be nexus-governance`);
  }
  return candidate as PluginOwner;
}

function normalizeExecutionAdapter(value: unknown, label: string): PluginExecutionAdapter | undefined {
  if (value === undefined || value === null) return undefined;
  const candidate = boundedString(value, label, 64);
  if (!KNOWN_EXECUTION_ADAPTERS.has(candidate)) {
    throw new PluginHostError('INVALID_MANIFEST', `${label} is not a supported execution adapter`);
  }
  return candidate as PluginExecutionAdapter;
}

function parseSemver(value: unknown, label: string): SemVer {
  const text = boundedString(value, label, 64);
  const match = SEMVER.exec(text);
  if (!match) throw new PluginHostError('INVALID_MANIFEST', `${label} must be a semantic version`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : []
  };
}

function compareSemver(left: SemVer, right: SemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length > 0) return 1;
  if (left.prerelease.length > 0 && right.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumber = /^\d+$/.test(a);
    const bNumber = /^\d+$/.test(b);
    if (aNumber && bNumber) return Number(a) < Number(b) ? -1 : 1;
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function comparator(version: SemVer, operator: string, target: SemVer): boolean {
  const result = compareSemver(version, target);
  if (operator === '>') return result > 0;
  if (operator === '>=') return result >= 0;
  if (operator === '<') return result < 0;
  if (operator === '<=') return result <= 0;
  return result === 0;
}

/** Small, deterministic semver-range subset sufficient for manifest compatibility. */
export function satisfiesPluginHostVersion(version: string, range: string): boolean {
  const current = parseSemver(version, 'hostApiVersion');
  const normalized = range.trim();
  if (!normalized || normalized === '*' || normalized.toLowerCase() === 'x') return true;

  if (normalized.startsWith('^') || normalized.startsWith('~')) {
    const operator = normalized[0];
    const target = parseSemver(normalized.slice(1), 'hostApiVersion range');
    if (compareSemver(current, target) < 0) return false;
    if (operator === '~') return current.major === target.major && current.minor === target.minor;
    if (target.major > 0) return current.major === target.major;
    if (target.minor > 0) return current.major === 0 && current.minor === target.minor;
    return current.major === 0 && current.minor === 0 && current.patch === target.patch;
  }

  const parts = normalized.split(/\s+/).filter(Boolean);
  return parts.every((part) => {
    const match = /^(>=|<=|>|<|=)?(.+)$/.exec(part);
    if (!match) return false;
    let target: SemVer;
    try { target = parseSemver(match[2], 'hostApiVersion range'); } catch { return false; }
    return comparator(current, match[1] ?? '=', target);
  });
}

function normalizePermissions(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > PLUGIN_PERMISSIONS.length) {
    throw new PluginHostError('INVALID_MANIFEST', `${label} must be a bounded array`);
  }
  const result: string[] = [];
  for (const item of value) {
    const permission = boundedString(item, `${label} entry`, 80);
    if (!KNOWN_PERMISSIONS.has(permission)) {
      // These are called out separately to make the ownership boundary clear.
      if (/^(?:secret|audit|state)\./.test(permission)) {
        throw new PluginHostError('INVALID_MANIFEST', `${label} cannot claim ${permission}`);
      }
      throw new PluginHostError('INVALID_MANIFEST', `Unknown plugin permission: ${permission}`);
    }
    if (!result.includes(permission)) result.push(permission);
  }
  return result;
}

function normalizeMetadata(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).length > MAX_METADATA_ENTRIES) {
    throw new PluginHostError('INVALID_MANIFEST', 'capability metadata is invalid');
  }
  const metadata: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = identifier(key, 'capability metadata key');
    metadata[normalizedKey] = boundedString(item, `capability metadata ${normalizedKey}`, MAX_METADATA_VALUE_LENGTH);
  }
  return metadata;
}

function normalizeCapability(
  input: unknown,
  index: number,
  manifestOwner: PluginOwner,
  manifestAdapter?: PluginExecutionAdapter
): PluginCapability {
  if (!isRecord(input)) throw new PluginHostError('INVALID_MANIFEST', `capability[${index}] must be an object`);
  const kind = boundedString(input.kind, `capability[${index}].kind`, 32) as PluginCapabilityKind;
  if (!['engine', 'tool', 'skill', 'artifact', 'channel', 'a2a'].includes(kind)) {
    throw new PluginHostError('INVALID_MANIFEST', `Unsupported capability kind: ${kind}`);
  }
  const base = {
    id: identifier(input.id, `capability[${index}].id`),
    kind,
    version: boundedString(input.version, `capability[${index}].version`, 64),
    owner: normalizeOwner(input.owner, `capability[${index}].owner`, manifestOwner),
    executionAdapter: normalizeExecutionAdapter(
      input.executionAdapter ?? manifestAdapter,
      `capability[${index}].executionAdapter`
    ),
    ...(input.description === undefined ? {} : { description: boundedString(input.description, `capability[${index}].description`, MAX_DESCRIPTION_LENGTH, false) }),
    permissions: normalizePermissions(input.permissions, `capability[${index}].permissions`),
    metadata: normalizeMetadata(input.metadata)
  } as PluginCapabilityBase;
  if (base.owner !== manifestOwner) {
    throw new PluginHostError('INVALID_MANIFEST', `capability[${index}].owner must match plugin owner`);
  }
  parseSemver(base.version, `capability[${index}].version`);

  if (kind === 'engine') {
    return {
      ...base,
      kind,
      ...(input.engineId === undefined ? {} : { engineId: identifier(input.engineId, `capability[${index}].engineId`) }),
      ...(input.protocols === undefined ? {} : { protocols: normalizeStringList(input.protocols, `capability[${index}].protocols`, 32) })
    } as PluginEngineCapability;
  }
  if (kind === 'tool') {
    const risk = input.risk === undefined ? undefined : boundedString(input.risk, `capability[${index}].risk`, 16);
    if (risk !== undefined && !['safe', 'write', 'danger'].includes(risk)) {
      throw new PluginHostError('INVALID_MANIFEST', `capability[${index}].risk is invalid`);
    }
    return {
      ...base,
      kind,
      ...(input.toolName === undefined ? {} : { toolName: identifier(input.toolName, `capability[${index}].toolName`) }),
      ...(risk === undefined ? {} : { risk: risk as PluginToolCapability['risk'] }),
      ...(input.inputSchema === undefined ? {} : { inputSchema: cloneRecord(input.inputSchema, `capability[${index}].inputSchema`) })
    } as PluginToolCapability;
  }
  if (kind === 'skill') {
    return {
      ...base,
      kind,
      ...(input.skillId === undefined ? {} : { skillId: identifier(input.skillId, `capability[${index}].skillId`) }),
      ...(input.contentRef === undefined ? {} : { contentRef: boundedString(input.contentRef, `capability[${index}].contentRef`, 512) })
    } as PluginSkillCapability;
  }
  if (kind === 'artifact') {
    return {
      ...base,
      kind,
      ...(input.artifactKind === undefined ? {} : { artifactKind: identifier(input.artifactKind, `capability[${index}].artifactKind`) }),
      ...(input.mediaTypes === undefined ? {} : { mediaTypes: normalizeStringList(input.mediaTypes, `capability[${index}].mediaTypes`, 128) })
    } as PluginArtifactCapability;
  }
  if (kind === 'channel') {
    const direction = input.direction === undefined ? undefined : boundedString(input.direction, `capability[${index}].direction`, 32);
    if (direction !== undefined && !['inbound', 'outbound', 'bidirectional'].includes(direction)) {
      throw new PluginHostError('INVALID_MANIFEST', `capability[${index}].direction is invalid`);
    }
    return {
      ...base,
      kind,
      ...(input.channelType === undefined ? {} : { channelType: identifier(input.channelType, `capability[${index}].channelType`) }),
      ...(direction === undefined ? {} : { direction: direction as PluginChannelCapability['direction'] })
    } as PluginChannelCapability;
  }
  const protocol = input.protocol === undefined ? undefined : boundedString(input.protocol, `capability[${index}].protocol`, 16);
  if (protocol !== undefined && protocol !== 'a2a' && protocol !== 'acp') {
    throw new PluginHostError('INVALID_MANIFEST', `capability[${index}].protocol is invalid`);
  }
  return {
    ...base,
    kind,
    ...(protocol === undefined ? {} : { protocol: protocol as PluginA2aCapability['protocol'] }),
    ...(input.operations === undefined ? {} : { operations: normalizeStringList(input.operations, `capability[${index}].operations`, 128) })
  } as PluginA2aCapability;
}

function normalizeStringList(value: unknown, label: string, maximumItemLength: number): string[] {
  if (!Array.isArray(value) || value.length > 128) throw new PluginHostError('INVALID_MANIFEST', `${label} must be a bounded array`);
  const result: string[] = [];
  for (const item of value) {
    const text = boundedString(item, `${label} entry`, maximumItemLength);
    if (!result.includes(text)) result.push(text);
  }
  return result;
}

function cloneRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new PluginHostError('INVALID_MANIFEST', `${label} must be an object`);
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    throw new PluginHostError('INVALID_MANIFEST', `${label} is not serializable`);
  }
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return Object.freeze(value);
}

/** Validate and normalize one manifest without registering it. */
export function validatePluginManifest(input: unknown, hostApiVersion: string = PLUGIN_HOST_API_VERSION): Readonly<PluginManifest> {
  if (!isRecord(input)) throw new PluginHostError('INVALID_MANIFEST', 'Plugin manifest must be an object');
  if (input.schemaVersion !== PLUGIN_MANIFEST_SCHEMA_VERSION) {
    throw new PluginHostError('INVALID_MANIFEST', `Unsupported plugin manifest schema: ${String(input.schemaVersion)}`);
  }
  const id = identifier(input.id, 'plugin id');
  const name = boundedString(input.name, 'plugin name', MAX_NAME_LENGTH);
  const version = boundedString(input.version, 'plugin version', 64);
  parseSemver(version, 'plugin version');
  const owner = normalizeOwner(input.owner, 'plugin owner');
  const executionAdapter = normalizeExecutionAdapter(input.executionAdapter, 'plugin executionAdapter');
  const requestedHost = boundedString(input.hostApiVersion ?? input.apiVersion ?? '*', 'hostApiVersion', 128);
  if (input.hostApiVersion !== undefined && input.apiVersion !== undefined && input.hostApiVersion !== input.apiVersion) {
    throw new PluginHostError('INVALID_MANIFEST', 'hostApiVersion and apiVersion disagree');
  }
  if (!satisfiesPluginHostVersion(hostApiVersion, requestedHost)) {
    throw new PluginHostError('INCOMPATIBLE_HOST', `Plugin ${id} requires host ${requestedHost}, current host is ${hostApiVersion}`);
  }
  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0 || input.capabilities.length > 128) {
    throw new PluginHostError('INVALID_MANIFEST', 'Plugin capabilities must be a non-empty bounded array');
  }
  const permissions = normalizePermissions(input.permissions, 'plugin permissions');
  const capabilityIds = new Set<string>();
  const capabilities = input.capabilities.map((capability, index) => {
    const normalized = normalizeCapability(capability, index, owner, executionAdapter);
    if (capabilityIds.has(normalized.id)) throw new PluginHostError('DUPLICATE_CAPABILITY', `Duplicate capability id: ${normalized.id}`);
    capabilityIds.add(normalized.id);
    if (input.permissions !== undefined && normalized.permissions?.some((permission) => !permissions.includes(permission))) {
      throw new PluginHostError('INVALID_MANIFEST', `Capability ${normalized.id} claims an undeclared permission`);
    }
    return normalized;
  });
  const manifest: PluginManifest = {
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    id,
    name,
    version,
    owner,
    ...(executionAdapter === undefined ? {} : { executionAdapter }),
    ...(input.hostApiVersion === undefined && input.apiVersion === undefined ? {} : { hostApiVersion: String(requestedHost) }),
    ...(input.apiVersion === undefined ? {} : { apiVersion: String(input.apiVersion) }),
    ...(input.description === undefined ? {} : { description: boundedString(input.description, 'plugin description', MAX_DESCRIPTION_LENGTH, false) }),
    capabilities,
    permissions
  };
  return freezeDeep(manifest);
}

export interface CapabilityFilter {
  pluginId?: string;
  kind?: PluginCapabilityKind;
  enabledOnly?: boolean;
}

export class CapabilityRegistry {
  private readonly plugins = new Map<string, RegisteredPlugin>();
  private readonly capabilityKeys = new Set<string>();
  private readonly hostApiVersion: string;
  private readonly now: () => number;

  constructor(options: PluginRegistryOptions = {}) {
    this.hostApiVersion = options.hostApiVersion ?? PLUGIN_HOST_API_VERSION;
    parseSemver(this.hostApiVersion, 'hostApiVersion');
    this.now = options.now ?? Date.now;
  }

  register(input: unknown): RegisteredPlugin {
    const manifest = validatePluginManifest(input, this.hostApiVersion);
    if (this.plugins.has(manifest.id)) throw new PluginHostError('DUPLICATE_PLUGIN', `Plugin already registered: ${manifest.id}`);
    for (const capability of manifest.capabilities) {
      const key = this.capabilityKey(manifest.id, capability.id);
      if (this.capabilityKeys.has(key)) throw new PluginHostError('DUPLICATE_CAPABILITY', `Capability already registered: ${key}`);
    }
    const registered = freezeDeep({ manifest, registeredAt: this.now(), enabled: true });
    this.plugins.set(manifest.id, registered);
    for (const capability of manifest.capabilities) this.capabilityKeys.add(this.capabilityKey(manifest.id, capability.id));
    return registered;
  }

  replace(pluginId: string, input: unknown): RegisteredPlugin {
    const current = this.requirePlugin(pluginId);
    const manifest = validatePluginManifest(input, this.hostApiVersion);
    if (manifest.id !== pluginId) throw new PluginHostError('INVALID_MANIFEST', 'Replacement plugin id does not match the registered plugin');
    for (const capability of manifest.capabilities) {
      const key = this.capabilityKey(pluginId, capability.id);
      if (this.capabilityKeys.has(key) && !current.manifest.capabilities.some((item) => item.id === capability.id)) {
        throw new PluginHostError('DUPLICATE_CAPABILITY', `Capability already registered: ${key}`);
      }
    }
    for (const capability of current.manifest.capabilities) this.capabilityKeys.delete(this.capabilityKey(pluginId, capability.id));
    const replacement = freezeDeep({ manifest, registeredAt: this.now(), enabled: current.enabled });
    this.plugins.set(pluginId, replacement);
    for (const capability of manifest.capabilities) this.capabilityKeys.add(this.capabilityKey(pluginId, capability.id));
    return replacement;
  }

  unregister(pluginId: string): boolean {
    const current = this.plugins.get(pluginId);
    if (!current) return false;
    this.plugins.delete(pluginId);
    for (const capability of current.manifest.capabilities) this.capabilityKeys.delete(this.capabilityKey(pluginId, capability.id));
    return true;
  }

  setEnabled(pluginId: string, enabled: boolean): RegisteredPlugin {
    const current = this.requirePlugin(pluginId);
    const next = freezeDeep({ ...current, enabled: Boolean(enabled) });
    this.plugins.set(pluginId, next);
    return next;
  }

  get(pluginId: string): RegisteredPlugin | null {
    return this.plugins.get(pluginId) ?? null;
  }

  list(): RegisteredPlugin[] {
    return [...this.plugins.values()].sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
  }

  listCapabilities(filter: CapabilityFilter = {}): Array<{ plugin: RegisteredPlugin; capability: PluginCapability }> {
    const result: Array<{ plugin: RegisteredPlugin; capability: PluginCapability }> = [];
    for (const plugin of this.list()) {
      if (filter.pluginId !== undefined && plugin.manifest.id !== filter.pluginId) continue;
      if (filter.enabledOnly !== false && !plugin.enabled) continue;
      for (const capability of plugin.manifest.capabilities) {
        if (filter.kind !== undefined && capability.kind !== filter.kind) continue;
        result.push({ plugin, capability });
      }
    }
    return result;
  }

  resolve(pluginId: string, capabilityId: string): { plugin: RegisteredPlugin; capability: PluginCapability } {
    const plugin = this.requirePlugin(pluginId);
    const capability = plugin.manifest.capabilities.find((item) => item.id === capabilityId);
    if (!capability) throw new PluginHostError('CAPABILITY_NOT_FOUND', `Capability not found: ${pluginId}/${capabilityId}`);
    return { plugin, capability };
  }

  private requirePlugin(pluginId: string): RegisteredPlugin {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new PluginHostError('PLUGIN_NOT_FOUND', `Plugin not found: ${pluginId}`);
    return plugin;
  }

  private capabilityKey(pluginId: string, capabilityId: string): string {
    return `${pluginId}/${capabilityId}`;
  }
}

export interface PluginPermissionRequest {
  pluginId: string;
  pluginVersion: string;
  owner: PluginOwner;
  capabilityId: string;
  capabilityKind: PluginCapabilityKind;
  executionAdapter?: PluginExecutionAdapter;
  permission: string;
  input: unknown;
  /**
   * Main-authenticated caller identity. Plugin input must never be copied into
   * this object; transports construct it only after authenticating the caller.
   */
  policyContext?: Readonly<PluginInvocationPolicyContext>;
}

export type PluginPermissionResolver = (
  request: Readonly<PluginPermissionRequest>,
  signal: AbortSignal
) => boolean | Promise<boolean>;

export interface PluginInvocationContext {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly owner: PluginOwner;
  readonly capabilityId: string;
  readonly capabilityKind: PluginCapabilityKind;
  readonly executionAdapter?: PluginExecutionAdapter;
  readonly signal: AbortSignal;
}

export type PluginCapabilityHandler = (
  input: unknown,
  context: Readonly<PluginInvocationContext>
) => unknown | Promise<unknown>;

export interface PluginInvokeRequest {
  pluginId: string;
  capabilityId: string;
  input?: unknown;
  signal?: AbortSignal;
  /** Trusted Main-side identity used by the Nexus policy broker. */
  policyContext?: PluginInvocationPolicyContext;
}

export interface PluginInvocationPolicyContext {
  requestId: string;
  organizationId: string;
  runtimeId: string;
  agentId: string;
  target: string;
  operation?: string;
  sessionId?: string;
  taskId?: string;
}

export interface PluginBinding {
  readonly pluginId: string;
  detach(): void;
}

/**
 * Narrow execution host. It only invokes handlers explicitly attached by an
 * adapter and checks every manifest permission through the injected resolver.
 * There is intentionally no Database, secret, state-machine, or audit API here.
 */
export class PluginHost {
  private readonly handlers = new Map<string, Map<string, PluginCapabilityHandler>>();

  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly authorize?: PluginPermissionResolver
  ) {}

  attach(pluginId: string, handlers: Readonly<Record<string, PluginCapabilityHandler>>): PluginBinding {
    const plugin = this.registry.get(pluginId);
    if (!plugin) throw new PluginHostError('PLUGIN_NOT_FOUND', `Plugin not found: ${pluginId}`);
    if (!plugin.enabled) throw new PluginHostError('PLUGIN_DISABLED', `Plugin is disabled: ${pluginId}`);
    if (!isRecord(handlers)) throw new PluginHostError('HANDLER_NOT_FOUND', 'Plugin handlers must be an object');
    if (this.handlers.has(pluginId)) throw new PluginHostError('HANDLER_ALREADY_ATTACHED', `Handlers already attached: ${pluginId}`);
    const map = new Map<string, PluginCapabilityHandler>();
    for (const [capabilityId, handler] of Object.entries(handlers)) {
      if (typeof handler !== 'function') throw new PluginHostError('HANDLER_NOT_FOUND', `Handler is not callable: ${capabilityId}`);
      this.registry.resolve(pluginId, capabilityId);
      map.set(capabilityId, handler);
    }
    this.handlers.set(pluginId, map);
    let attached = true;
    return {
      pluginId,
      detach: () => {
        if (!attached) return;
        attached = false;
        this.handlers.delete(pluginId);
      }
    };
  }

  detach(pluginId: string): boolean {
    return this.handlers.delete(pluginId);
  }

  /** Read-only execution fact used by the catalog; registration alone is never execution readiness. */
  isAttached(pluginId: string, capabilityId?: string): boolean {
    const handlers = this.handlers.get(pluginId);
    if (!handlers) return false;
    return capabilityId === undefined ? handlers.size > 0 : handlers.has(capabilityId);
  }

  async invoke(request: PluginInvokeRequest): Promise<unknown> {
    const resolved = this.registry.resolve(request.pluginId, request.capabilityId);
    if (!resolved.plugin.enabled) throw new PluginHostError('PLUGIN_DISABLED', `Plugin is disabled: ${request.pluginId}`);
    const handler = this.handlers.get(request.pluginId)?.get(request.capabilityId);
    if (!handler) throw new PluginHostError('HANDLER_NOT_FOUND', `No handler attached: ${request.pluginId}/${request.capabilityId}`);
    const signal = request.signal ?? new AbortController().signal;
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Plugin invocation aborted');

    for (const permission of resolved.capability.permissions ?? []) {
      if (!this.authorize) throw new PluginHostError('PERMISSION_DENIED', `Permission resolver is unavailable: ${permission}`);
      let allowed = false;
      try {
        allowed = await this.authorize({
          pluginId: resolved.plugin.manifest.id,
          pluginVersion: resolved.plugin.manifest.version,
          owner: resolved.plugin.manifest.owner,
          capabilityId: resolved.capability.id,
          capabilityKind: resolved.capability.kind,
          executionAdapter: resolved.capability.executionAdapter,
          permission,
          input: request.input,
          ...(request.policyContext === undefined
            ? {}
            : { policyContext: Object.freeze({ ...request.policyContext }) })
        }, signal);
      } catch {
        allowed = false;
      }
      if (!allowed) throw new PluginHostError('PERMISSION_DENIED', `Permission denied: ${permission}`);
    }

    const context: PluginInvocationContext = Object.freeze({
      pluginId: resolved.plugin.manifest.id,
      pluginVersion: resolved.plugin.manifest.version,
      owner: resolved.plugin.manifest.owner,
      capabilityId: resolved.capability.id,
      capabilityKind: resolved.capability.kind,
      executionAdapter: resolved.capability.executionAdapter,
      signal
    });
    try {
      return await handler(request.input, context);
    } catch (error) {
      if (error instanceof PluginHostError) throw error;
      throw new PluginHostError(
        'HANDLER_FAILED',
        error instanceof Error ? error.message : 'Plugin handler failed',
        { cause: error }
      );
    }
  }
}
