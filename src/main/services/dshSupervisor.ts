/**
 * Persistent supervisor for the managed DeepSeek Harness Web runtime.
 *
 * A runtime belongs to one (Agent, security profile) pair. Browser windows are
 * deliberately absent from this service: opening or closing a Workbench must
 * never acquire or release the process lifetime.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  SECRET_ENV_PATTERN,
  childProcessEnv,
  createSensitiveTextRedactor,
  redactSensitiveText,
  type SensitiveTextRedactor
} from './engineEnv.js';
import { createLogger, type Logger } from './logger.js';
import { normalizeProviderBaseUrl } from './providerEndpoint.js';

export const DSH_LOOPBACK_HOST = '127.0.0.1';
export const DSH_MANAGED_ENTRY = 'node_modules/@deepseek-ai/dsh/lib/bin.js';
export const DSH_MANAGED_POLICY_PATCH = 'opc-managed/managed-web.patch.yml';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const CONTROL_CHAR = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const DSH_PROXY_TOKEN_PATTERN = /^dshp_[A-Za-z0-9_-]{40,64}$/;
const DSH_PROXY_ENV_KEYS = new Set([
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENAI_BASE_URL',
  'DEEPSEEK_BASE_URL',
  'AIBOX_DSH_MODEL',
  'AIBOX_DSH_PROVIDER'
]);

export type DshProcessState =
  | 'STOPPED'
  | 'STARTING'
  | 'READY'
  | 'UNHEALTHY'
  | 'BACKOFF'
  | 'STOPPING'
  | 'STOP_FAILED'
  | 'CRASH_LOOP';

export interface DshRuntimeRequest {
  agentId: string;
  /** Nexus policy/profile id. The upstream DSH profile remains the reviewed Web profile. */
  profileId: string;
  /** An existing directory selected through the trusted Main-process flow. */
  workspace?: string;
}

export interface DshRuntimeLogEntry {
  at: number;
  source: 'stdout' | 'stderr';
  message: string;
}

export interface DshRuntimeExit {
  at: number;
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Renderer-safe snapshot. It intentionally contains no argv or environment. */
export interface DshRuntimeStatus {
  agentId: string;
  profileId: string;
  /** Monotonic process generation used by Main-process clients to fence stale endpoints. */
  generation: number;
  processState: DshProcessState;
  endpoint: string | null;
  pid: number | null;
  home: string;
  profileDirectory: string;
  workspace: string;
  startedAt: number | null;
  readyAt: number | null;
  lastHealthAt: number | null;
  nextRestartAt: number | null;
  restartCount: number;
  crashCount: number;
  consecutiveFailures: number;
  lastExit: DshRuntimeExit | null;
  lastError: string | null;
  recentLogs: DshRuntimeLogEntry[];
}

export interface DshRuntimeEnvironmentContext {
  agentId: string;
  profileId: string;
  /** Stable identity used to scope a ProviderCredentialProxy grant. */
  runtimeId: string;
  home: string;
  profileDirectory: string;
  workspace: string;
}

export type DshTrustedAuthorityResolver = (
  context: DshRuntimeEnvironmentContext
) => readonly string[];

/** Short-lived, scoped Provider capability for one managed runtime. */
export interface DshRuntimeCredentialLease {
  token: string;
  baseUrl: string;
  model: string;
  providerId?: string;
  /** Absolute expiry for the opaque proxy capability. */
  expiresAt: number;
  /** Renew the same opaque token and return its new absolute expiry. */
  renew: () => number | Promise<number>;
  /** Main-only scope expansion for another model on the same Provider grant. */
  authorizeModel?: (model: string) => void | Promise<void>;
  revoke: (reason?: string) => void | Promise<void>;
}

export type DshRuntimeCredentialResolver = (
  context: DshRuntimeEnvironmentContext
) => DshRuntimeCredentialLease | null | Promise<DshRuntimeCredentialLease | null>;

export interface DshClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type DshSpawn = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export type DshFetch = (
  input: string,
  init: { method: 'GET'; redirect: 'manual'; signal: AbortSignal }
) => Promise<{ status: number }>;

export interface DshSupervisorOptions {
  /** Persistent root below Electron userData, e.g. aibox-data/deepseek-harness-managed. */
  dataRoot: string;
  /** Prepared dist in development, or resources/runtime/deepseek-harness-managed when packaged. */
  runtimeRoot: string;
  runtimeEntry?: string;
  nodeExecutable?: string;
  /** Non-secret process settings only. Provider credentials require the Phase 2 scoped proxy. */
  resolveEnvironment?: (
    context: DshRuntimeEnvironmentContext
  ) => Promise<Record<string, string | undefined>> | Record<string, string | undefined>;
  /** Public proxy authorities reviewed by Main and passed to DSH's browser-trust fence at spawn time. */
  resolveTrustedAuthorities?: DshTrustedAuthorityResolver;
  /** Acquire a short-lived Provider proxy capability for this runtime. */
  resolveCredentialLease?: DshRuntimeCredentialResolver;
  /** Production managed DSH requires a Provider capability before spawning. */
  requireCredentialLease?: boolean;
  spawn?: DshSpawn;
  fetch?: DshFetch;
  allocatePort?: (host: typeof DSH_LOOPBACK_HOST) => Promise<number>;
  clock?: DshClock;
  logger?: Logger;
  startupTimeoutMs?: number;
  startupPollMs?: number;
  probeTimeoutMs?: number;
  healthIntervalMs?: number;
  unhealthyThreshold?: number;
  restartBaseDelayMs?: number;
  restartMaxDelayMs?: number;
  maxRestartAttempts?: number;
  stableRuntimeMs?: number;
  stopTimeoutMs?: number;
  forceKillWaitMs?: number;
  maxLogEntries?: number;
  maxLogLineChars?: number;
}

export type DshRuntimeStatusListener = (status: DshRuntimeStatus) => void;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
  settled: boolean;
}

interface LogStreamState {
  decoder: StringDecoder;
  redactor: SensitiveTextRedactor;
  pending: string;
  finished: boolean;
}

interface RuntimeInstance {
  key: string;
  agentId: string;
  profileId: string;
  home: string;
  profileDirectory: string;
  workspace: string;
  processState: DshProcessState;
  endpoint: string | null;
  child: ChildProcess | null;
  desiredRunning: boolean;
  generation: number;
  startedAt: number | null;
  readyAt: number | null;
  lastHealthAt: number | null;
  nextRestartAt: number | null;
  launchCount: number;
  crashCount: number;
  consecutiveFailures: number;
  lastExit: DshRuntimeExit | null;
  lastError: string | null;
  unhealthyCount: number;
  recentLogs: DshRuntimeLogEntry[];
  redactionEnvironment: Record<string, string>;
  trustedAuthorities: string[];
  streams: Partial<Record<'stdout' | 'stderr', LogStreamState>>;
  activation: Deferred<DshRuntimeStatus> | null;
  stopping: Deferred<void> | null;
  readinessTimer: unknown | null;
  healthTimer: unknown | null;
  restartTimer: unknown | null;
  terminateTimer: unknown | null;
  forceWaitTimer: unknown | null;
  credentialRenewTimer: unknown | null;
  credentialLease: DshRuntimeCredentialLease | null;
  credentialRelease: Promise<void> | null;
}

interface ResolvedOptions {
  dataRoot: string;
  runtimeRoot: string;
  runtimeEntry: string;
  nodeExecutable: string;
  resolveEnvironment: NonNullable<DshSupervisorOptions['resolveEnvironment']>;
  resolveTrustedAuthorities: DshTrustedAuthorityResolver;
  resolveCredentialLease: DshRuntimeCredentialResolver | null;
  requireCredentialLease: boolean;
  spawn: DshSpawn;
  fetch: DshFetch;
  allocatePort: NonNullable<DshSupervisorOptions['allocatePort']>;
  clock: DshClock;
  logger: Logger;
  startupTimeoutMs: number;
  startupPollMs: number;
  probeTimeoutMs: number;
  healthIntervalMs: number;
  unhealthyThreshold: number;
  restartBaseDelayMs: number;
  restartMaxDelayMs: number;
  maxRestartAttempts: number;
  stableRuntimeMs: number;
  stopTimeoutMs: number;
  forceKillWaitMs: number;
  maxLogEntries: number;
  maxLogLineChars: number;
}

const defaultClock: DshClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const result: Deferred<T> = {
    promise: new Promise<T>((resolveValue, rejectValue) => {
      resolvePromise = resolveValue;
      rejectPromise = rejectValue;
    }),
    resolve(value) {
      if (result.settled) return;
      result.settled = true;
      resolvePromise(value);
    },
    reject(error) {
      if (result.settled) return;
      result.settled = true;
      rejectPromise(error);
    },
    settled: false
  };
  return result;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolvedValue = value ?? fallback;
  if (!Number.isSafeInteger(resolvedValue) || resolvedValue <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolvedValue;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolvedValue = value ?? fallback;
  if (!Number.isSafeInteger(resolvedValue) || resolvedValue < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return resolvedValue;
}

function safeId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`Invalid DSH ${label}`);
  return value;
}

export function normalizeDshTrustedAuthority(value: string): string {
  if (!value || value !== value.trim() || value.length > 255 || /[\s/@?#]/.test(value)) {
    throw new Error('Invalid DSH trusted authority');
  }
  let parsed: URL;
  // Lowercase before parsing because WHATWG URL leaves host casing intact for
  // non-standard schemes.  The custom scheme also preserves an explicit port
  // such as 443, which is part of the DSH authority contract.
  try { parsed = new URL(`opc-dsh://${value.toLowerCase()}/`); } catch { throw new Error('Invalid DSH trusted authority'); }
  // Keep the value to an authority only; paths and credentials must never
  // reach the DSH browser trust fence.
  if (!parsed.hostname || !parsed.port || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.host !== value.toLowerCase()) {
    throw new Error('Invalid DSH trusted authority');
  }
  const port = Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid DSH trusted authority');
  return parsed.host;
}

function normalizeTrustedAuthorities(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 16) throw new Error('Invalid DSH trusted authorities');
  return [...new Set(values.map(normalizeDshTrustedAuthority))].sort();
}

function normalizeCredentialModel(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256
    || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Invalid DSH Provider model');
  }
  return value;
}

function normalizeCredentialBaseUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid DSH Provider proxy URL');
  const normalized = normalizeProviderBaseUrl(value);
  let parsed: URL;
  try { parsed = new URL(normalized); } catch { throw new Error('Invalid DSH Provider proxy URL'); }
  if (parsed.protocol !== 'http:' || parsed.hostname !== DSH_LOOPBACK_HOST || !parsed.port
    || parsed.pathname !== '/v1' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error('DSH Provider credentials must use the loopback proxy');
  }
  return normalized;
}

function normalizeCredentialToken(value: unknown): string {
  if (typeof value !== 'string' || !DSH_PROXY_TOKEN_PATTERN.test(value)) {
    throw new Error('Invalid DSH Provider capability token');
  }
  return value;
}

function instanceKey(agentId: string, profileId: string): string {
  return `${agentId}\u0000${profileId}`;
}

function runtimeCredentialId(agentId: string, profileId: string): string {
  return `dsh-runtime-${createHash('sha256').update(`${agentId}\u0000${profileId}`).digest('hex').slice(0, 32)}`;
}

function pathName(value: string): string {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 12);
  const readable = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 48);
  return `${readable || 'profile'}-${digest}`;
}

function assertAbsolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || value.includes('\u0000')) throw new Error(`${label} must be an absolute path`);
  return resolve(value);
}

function assertBelow(root: string, target: string, label: string): void {
  const rel = relative(root, target);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../')) {
    throw new Error(`${label} must stay below its managed root`);
  }
}

function ensureRealDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Managed DSH path is not a real directory: ${path}`);
}

function ensureManagedDirectory(root: string, target: string): void {
  assertBelow(root, target, 'DSH directory');
  ensureRealDirectory(root);
  let cursor = root;
  for (const part of relative(root, target).split(/[\\/]+/)) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) mkdirSync(cursor);
    const stat = lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Managed DSH path is not a real directory: ${cursor}`);
    }
  }
}

function assertWorkspace(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) throw new Error('DSH workspace must be an existing directory');
}

function assertSafeNodeCommand(executable: string): void {
  if (!isAbsolute(executable) || executable.includes('\u0000')) {
    throw new Error('Managed DSH Node executable must be an absolute path');
  }
  if (/\.(?:cmd|bat|ps1)$/i.test(executable)) {
    throw new Error('Managed DSH must not use a shell command shim');
  }
}

async function allocateLoopbackPort(host: typeof DSH_LOOPBACK_HOST): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.once('error', rejectPort);
    server.listen({ host, port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        rejectPort(new Error('Could not allocate a DSH loopback port'));
        return;
      }
      const port = address.port;
      server.close((error) => error ? rejectPort(error) : resolvePort(port));
    });
  });
}

function unrefTimer(timer: unknown): void {
  if (timer && typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') timer.unref();
}

/**
 * Supervise managed Web runtimes without coupling their lifetime to any UI.
 * Call shutdownAll exactly once during the Electron before-quit sequence.
 */
export class DshSupervisor {
  private readonly options: ResolvedOptions;
  private readonly instances = new Map<string, RuntimeInstance>();
  private readonly listeners = new Set<DshRuntimeStatusListener>();
  private closed = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: DshSupervisorOptions) {
    const dataRoot = assertAbsolutePath(options.dataRoot, 'DSH dataRoot');
    const runtimeRoot = assertAbsolutePath(options.runtimeRoot, 'DSH runtimeRoot');
    const runtimeEntry = options.runtimeEntry
      ? assertAbsolutePath(options.runtimeEntry, 'DSH runtimeEntry')
      : resolve(runtimeRoot, DSH_MANAGED_ENTRY);
    assertBelow(runtimeRoot, runtimeEntry, 'DSH runtime entry');
    const nodeExecutable = options.nodeExecutable ?? process.execPath;
    assertSafeNodeCommand(nodeExecutable);
    ensureRealDirectory(dataRoot);

    this.options = {
      dataRoot,
      runtimeRoot,
      runtimeEntry,
      nodeExecutable,
      resolveEnvironment: options.resolveEnvironment ?? (() => ({})),
      resolveTrustedAuthorities: options.resolveTrustedAuthorities ?? (() => []),
      resolveCredentialLease: options.resolveCredentialLease ?? null,
      requireCredentialLease: options.requireCredentialLease ?? false,
      spawn: options.spawn ?? ((executable, args, spawnOptions) => nodeSpawn(executable, [...args], spawnOptions)),
      fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      allocatePort: options.allocatePort ?? allocateLoopbackPort,
      clock: options.clock ?? defaultClock,
      logger: options.logger ?? createLogger('dshSupervisor'),
      startupTimeoutMs: positiveInteger(options.startupTimeoutMs, 30_000, 'startupTimeoutMs'),
      startupPollMs: positiveInteger(options.startupPollMs, 250, 'startupPollMs'),
      probeTimeoutMs: positiveInteger(options.probeTimeoutMs, 2_000, 'probeTimeoutMs'),
      healthIntervalMs: positiveInteger(options.healthIntervalMs, 10_000, 'healthIntervalMs'),
      unhealthyThreshold: positiveInteger(options.unhealthyThreshold, 3, 'unhealthyThreshold'),
      restartBaseDelayMs: positiveInteger(options.restartBaseDelayMs, 1_000, 'restartBaseDelayMs'),
      restartMaxDelayMs: positiveInteger(options.restartMaxDelayMs, 30_000, 'restartMaxDelayMs'),
      maxRestartAttempts: nonNegativeInteger(options.maxRestartAttempts, 5, 'maxRestartAttempts'),
      stableRuntimeMs: positiveInteger(options.stableRuntimeMs, 60_000, 'stableRuntimeMs'),
      stopTimeoutMs: positiveInteger(options.stopTimeoutMs, 10_000, 'stopTimeoutMs'),
      forceKillWaitMs: positiveInteger(options.forceKillWaitMs, 1_000, 'forceKillWaitMs'),
      maxLogEntries: positiveInteger(options.maxLogEntries, 200, 'maxLogEntries'),
      maxLogLineChars: positiveInteger(options.maxLogLineChars, 2_000, 'maxLogLineChars')
    };
    if (this.options.restartBaseDelayMs > this.options.restartMaxDelayMs) {
      throw new Error('restartBaseDelayMs must not exceed restartMaxDelayMs');
    }
  }

  start(request: DshRuntimeRequest): Promise<DshRuntimeStatus> {
    if (this.closed) return Promise.reject(new Error('DSH Supervisor is shut down'));
    // Preserve the historical synchronous validation for malformed IDs while
    // reporting an existing-profile workspace conflict as a rejected start
    // promise (callers commonly use `await expect(start()).rejects`).
    const agentId = safeId(request.agentId, 'Agent id');
    const profileId = safeId(request.profileId, 'profile id');
    let instance: RuntimeInstance;
    try {
      instance = this.ensureInstance({ ...request, agentId, profileId });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }

    if (instance.processState === 'READY') return Promise.resolve(this.snapshot(instance));
    if (instance.processState === 'STOPPING' || instance.processState === 'STOP_FAILED') {
      return Promise.reject(new Error(`DSH runtime cannot start while ${instance.processState.toLowerCase()}`));
    }
    if (instance.activation) return instance.activation.promise;

    if (instance.processState === 'CRASH_LOOP') {
      // A force-killed child that never emitted `close` is intentionally kept
      // referenced so we never spawn a duplicate process. Surface the hard
      // fence to callers instead of returning an activation that can never
      // settle; a later close event (or an explicit app restart) is required.
      if (instance.child) {
        return Promise.reject(new Error('DSH runtime process death could not be verified'));
      }
      return Promise.reject(new Error('DSH runtime crash-loop protection must be reset by stopping it first'));
    }
    instance.desiredRunning = true;
    instance.activation = deferred<DshRuntimeStatus>();
    if (!instance.child && !instance.restartTimer) this.launch(instance);
    return instance.activation.promise;
  }

  /**
   * Materialize a managed profile without starting DSH.
   *
   * Profile homes are persistent state and may be needed by maintenance
   * operations (for example a curated plugin install) before the Web runtime
   * has ever been launched.  Keeping this operation separate from `start`
   * guarantees that it never resolves credentials, allocates a port, spawns a
   * child process, or changes the desired-running flag.
   */
  ensureProfile(request: DshRuntimeRequest): DshRuntimeStatus {
    if (this.closed) throw new Error('DSH Supervisor is shut down');
    const instance = this.ensureInstance(request);
    // The DSH plugin command initializes package.json and its workspace on
    // first use. Materialize only the bounded profile directory here so a
    // Quest can install a plugin before the Web process has ever started.
    ensureManagedDirectory(this.options.dataRoot, instance.profileDirectory);
    return this.snapshot(instance);
  }

  stop(agentId: string, profileId: string): Promise<void> {
    const instance = this.instances.get(instanceKey(safeId(agentId, 'Agent id'), safeId(profileId, 'profile id')));
    if (!instance) return Promise.resolve();
    if (instance.stopping) return instance.stopping.promise;

    instance.desiredRunning = false;
    instance.consecutiveFailures = 0;
    instance.unhealthyCount = 0;
    this.clearTimer(instance, 'readinessTimer');
    this.clearTimer(instance, 'healthTimer');
    this.clearTimer(instance, 'restartTimer');
    instance.nextRestartAt = null;
    if (instance.activation) {
      instance.activation.reject(new Error('DSH runtime stopped before it became ready'));
      instance.activation = null;
    }
    if (!instance.child) {
      instance.generation += 1;
      this.setState(instance, 'STOPPED');
      instance.endpoint = null;
      return this.releaseCredentialLease(instance, 'runtime_stop');
    }

    instance.stopping = deferred<void>();
    this.setState(instance, 'STOPPING');
    this.requestExit(instance);
    return instance.stopping.promise;
  }

  getStatus(agentId: string, profileId: string): DshRuntimeStatus | null {
    const instance = this.instances.get(instanceKey(agentId, profileId));
    return instance ? this.snapshot(instance) : null;
  }

  /**
   * Expand the live runtime's opaque Provider grant without exposing its
   * grant id or credentials to DSH. A runtime restart fences the callback.
   */
  async authorizeModel(agentId: string, profileId: string, model: string): Promise<void> {
    if (this.closed) throw new Error('DSH Supervisor is shut down');
    const normalizedAgentId = safeId(agentId, 'Agent id');
    const normalizedProfileId = safeId(profileId, 'profile id');
    const normalizedModel = normalizeCredentialModel(model);
    const instance = this.instances.get(instanceKey(normalizedAgentId, normalizedProfileId));
    if (!instance || instance.processState !== 'READY' || !instance.credentialLease) {
      throw new Error('Managed DSH Provider capability is unavailable');
    }
    const lease = instance.credentialLease;
    const generation = instance.generation;
    if (!lease.authorizeModel) {
      if (lease.model === normalizedModel) return;
      throw new Error('Managed DSH Provider model authorization is unavailable');
    }
    try {
      await lease.authorizeModel(normalizedModel);
    } catch {
      throw new Error('Managed DSH Provider model authorization failed');
    }
    if (instance.processState !== 'READY' || instance.credentialLease !== lease
      || !this.isLiveChild(instance, generation)) {
      throw new Error('Managed DSH runtime changed during model authorization');
    }
  }

  listStatuses(): DshRuntimeStatus[] {
    return [...this.instances.values()]
      .map((instance) => this.snapshot(instance))
      .sort((a, b) => a.agentId.localeCompare(b.agentId) || a.profileId.localeCompare(b.profileId));
  }

  getTrustedAuthorities(agentId: string, profileId: string): readonly string[] {
    const instance = this.instances.get(instanceKey(safeId(agentId, 'Agent id'), safeId(profileId, 'profile id')));
    return instance ? [...instance.trustedAuthorities] : [];
  }

  hasTrustedAuthority(agentId: string, profileId: string, authority: string): boolean {
    const normalized = normalizeDshTrustedAuthority(authority);
    return this.getTrustedAuthorities(agentId, profileId).includes(normalized);
  }

  subscribe(listener: DshRuntimeStatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async shutdownAll(): Promise<void> {
    if (this.shutdownPromise) return await this.shutdownPromise;
    this.closed = true;
    this.shutdownPromise = (async () => {
      const results = await Promise.allSettled(
        [...this.instances.values()].map((instance) => this.stop(instance.agentId, instance.profileId))
      );
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, 'One or more DSH runtimes did not stop cleanly');
    })();
    return await this.shutdownPromise;
  }

  private createInstance(agentId: string, profileId: string, requestedWorkspace?: string): RuntimeInstance {
    const instanceRoot = join(
      this.options.dataRoot,
      'agents',
      pathName(agentId),
      'profiles',
      pathName(profileId)
    );
    const home = join(instanceRoot, 'home');
    ensureManagedDirectory(this.options.dataRoot, home);
    const profileDirectory = join(home, 'profiles', 'web');
    ensureManagedDirectory(this.options.dataRoot, profileDirectory);
    const workspace = requestedWorkspace
      ? assertAbsolutePath(requestedWorkspace, 'DSH workspace')
      : join(instanceRoot, 'workspace');
    if (requestedWorkspace) assertWorkspace(workspace);
    else ensureManagedDirectory(this.options.dataRoot, workspace);

    return {
      key: instanceKey(agentId, profileId),
      agentId,
      profileId,
      home,
      profileDirectory,
      workspace,
      processState: 'STOPPED',
      endpoint: null,
      child: null,
      desiredRunning: false,
      generation: 0,
      startedAt: null,
      readyAt: null,
      lastHealthAt: null,
      nextRestartAt: null,
      launchCount: 0,
      crashCount: 0,
      consecutiveFailures: 0,
      lastExit: null,
      lastError: null,
      unhealthyCount: 0,
      recentLogs: [],
      redactionEnvironment: {},
      trustedAuthorities: [],
      streams: {},
      activation: null,
      stopping: null,
      readinessTimer: null,
      healthTimer: null,
      restartTimer: null,
      terminateTimer: null,
      forceWaitTimer: null,
      credentialRenewTimer: null,
      credentialLease: null,
      credentialRelease: null
    };
  }

  /** Resolve or create one instance while keeping workspace identity stable. */
  private ensureInstance(request: DshRuntimeRequest): RuntimeInstance {
    if (!request || typeof request !== 'object') throw new Error('DSH runtime request is required');
    const agentId = safeId(request.agentId, 'Agent id');
    const profileId = safeId(request.profileId, 'profile id');
    const key = instanceKey(agentId, profileId);
    let instance = this.instances.get(key);
    if (!instance) {
      instance = this.createInstance(agentId, profileId, request.workspace);
      this.instances.set(key, instance);
    } else if (request.workspace && resolve(request.workspace) !== instance.workspace) {
      throw new Error('A running DSH profile cannot change workspace');
    }
    return instance;
  }

  private launch(instance: RuntimeInstance): void {
    if (!instance.desiredRunning || this.closed) return;
    const generation = ++instance.generation;
    instance.endpoint = null;
    instance.nextRestartAt = null;
    instance.startedAt = this.options.clock.now();
    instance.readyAt = null;
    instance.lastHealthAt = null;
    instance.lastError = null;
    instance.unhealthyCount = 0;
    instance.streams = {};
    this.setState(instance, 'STARTING');
    void this.prepareAndSpawn(instance, generation).catch((error: unknown) => {
      if (!this.isCurrent(instance, generation) || instance.child) return;
      // Preparation failures are deterministic policy/configuration errors,
      // rather than an exited runtime. Retrying them would leave callers
      // waiting on a backoff timer and could repeatedly re-evaluate unsafe
      // configuration. A later explicit start may re-resolve the inputs.
      this.failWithoutChild(instance, this.safeError(instance, error, 'Managed DSH failed to start'));
    });
  }

  private async prepareAndSpawn(instance: RuntimeInstance, generation: number): Promise<void> {
    let pendingLease: DshRuntimeCredentialLease | null = null;
    try {
      const port = await this.options.allocatePort(DSH_LOOPBACK_HOST);
      if (!this.isCurrent(instance, generation) || !instance.desiredRunning) return;
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error('DSH port allocator returned an invalid port');
      }
      this.assertRuntimeEntry();
      const policyPatch = resolve(this.options.runtimeRoot, DSH_MANAGED_POLICY_PATCH);
      this.assertManagedPolicy(policyPatch);

      const context: DshRuntimeEnvironmentContext = {
        agentId: instance.agentId,
        profileId: instance.profileId,
        runtimeId: runtimeCredentialId(instance.agentId, instance.profileId),
        home: instance.home,
        profileDirectory: instance.profileDirectory,
        workspace: instance.workspace
      };
      let resolvedEnvironment: Record<string, string | undefined>;
      try {
        resolvedEnvironment = await this.options.resolveEnvironment(context);
      } catch {
        throw new Error('Managed DSH environment resolution failed');
      }
      let trustedAuthorities: string[];
      try {
        trustedAuthorities = normalizeTrustedAuthorities(this.options.resolveTrustedAuthorities(context));
      } catch {
        throw new Error('Managed DSH trusted authority resolution failed');
      }
      if (Object.entries(resolvedEnvironment).some(([key, value]) =>
        value !== undefined && value !== '' && SECRET_ENV_PATTERN.test(key)
      )) {
        throw new Error('Managed DSH environment must not contain long-lived credentials');
      }
      if (Object.entries(resolvedEnvironment).some(([key, value]) =>
        value !== undefined && value !== ''
        && DSH_PROXY_ENV_KEYS.has(key)
        && (key.endsWith('_API_KEY') || key.endsWith('_BASE_URL'))
      )) {
        throw new Error('Managed DSH Provider endpoints must come from the credential proxy');
      }

      // A restart gets a fresh capability. Awaiting the previous revocation
      // prevents a slow async revoke implementation from racing a new spawn.
      await this.releaseCredentialLease(instance, 'runtime_restart');
      if (this.options.resolveCredentialLease) {
        try {
          pendingLease = await this.options.resolveCredentialLease(context);
        } catch {
          throw new Error('Managed DSH Provider credential resolution failed');
        }
        if (pendingLease) pendingLease = this.normalizeCredentialLease(pendingLease);
      }
      if (this.options.requireCredentialLease && !pendingLease) {
        throw new Error('Managed DSH Provider credential is unavailable');
      }
      if (!this.isCurrent(instance, generation) || !instance.desiredRunning) return;

      const credentialEnvironment = pendingLease ? {
        // Upstream DSH presets use both conventions. These values are the
        // same short-lived opaque proxy capability, never a Provider key.
        OPENAI_API_KEY: pendingLease.token,
        DEEPSEEK_API_KEY: pendingLease.token,
        OPENAI_BASE_URL: pendingLease.baseUrl,
        DEEPSEEK_BASE_URL: pendingLease.baseUrl,
        AIBOX_DSH_MODEL: pendingLease.model,
        AIBOX_DSH_PROVIDER: 'aibox-managed-proxy'
      } : {};
      const enforcedEnvironment: Record<string, string | undefined> = {
        ...resolvedEnvironment,
        ...credentialEnvironment,
        AIBOX_DSH_RUNTIME_MODE: 'MANAGED_WEB',
        AIBOX_DSH_PROFILE_ID: instance.profileId,
        DSH_HOME: instance.home,
        DSH_AGENTS_HOME: join(instance.home, 'agents'),
        DSH_TELEMETRY_DISABLED: '1',
        ELECTRON_RUN_AS_NODE: '1'
      };
      instance.redactionEnvironment = Object.fromEntries(
        Object.entries(enforcedEnvironment)
          .filter(([key, value]) => SECRET_ENV_PATTERN.test(key) && typeof value === 'string') as [string, string][]
      );
      const processEnvironment = childProcessEnv(enforcedEnvironment);
      const endpoint = `http://${DSH_LOOPBACK_HOST}:${port}`;
      instance.trustedAuthorities = trustedAuthorities;
      const args = [
        this.options.runtimeEntry,
        '--profile', 'web',
        '--patch', policyPatch,
        '--host', DSH_LOOPBACK_HOST,
        '--port', String(port),
        ...(trustedAuthorities.length > 0 ? ['--trusted-host', ...trustedAuthorities] : [])
      ];
      let child: ChildProcess;
      try {
        child = this.options.spawn(this.options.nodeExecutable, args, {
          cwd: instance.workspace,
          env: processEnvironment,
          shell: false,
          windowsHide: true,
          detached: false,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        throw new Error(this.safeError(instance, error, 'Managed DSH process could not be spawned'));
      }
      if (!this.isCurrent(instance, generation) || !instance.desiredRunning) {
        try { child.kill('SIGTERM'); } catch { /* process already exited */ }
        return;
      }

      instance.credentialLease = pendingLease;
      pendingLease = null;
      instance.child = child;
      instance.endpoint = endpoint;
      instance.launchCount += 1;
      this.attachProcess(instance, child, generation);
      this.scheduleCredentialRenewal(instance, generation);
      this.emit(instance);
      this.pollUntilReady(instance, generation, this.options.clock.now() + this.options.startupTimeoutMs);
    } finally {
      if (pendingLease) await this.revokeLeaseValue(pendingLease, 'launch_aborted');
    }
  }

  private normalizeCredentialLease(lease: DshRuntimeCredentialLease): DshRuntimeCredentialLease {
    if (!lease || typeof lease !== 'object' || typeof lease.revoke !== 'function' || typeof lease.renew !== 'function') {
      throw new Error('Invalid DSH Provider credential lease');
    }
    if (lease.authorizeModel !== undefined && typeof lease.authorizeModel !== 'function') {
      throw new Error('Invalid DSH Provider model authorization');
    }
    if (!Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= this.options.clock.now()) {
      throw new Error('Invalid DSH Provider credential expiry');
    }
    const providerId = lease.providerId;
    if (providerId !== undefined && !SAFE_ID.test(providerId)) {
      throw new Error('Invalid DSH Provider identity');
    }
    return {
      token: normalizeCredentialToken(lease.token),
      baseUrl: normalizeCredentialBaseUrl(lease.baseUrl),
      model: normalizeCredentialModel(lease.model),
      ...(providerId !== undefined ? { providerId } : {}),
      expiresAt: lease.expiresAt,
      renew: lease.renew,
      ...(lease.authorizeModel ? { authorizeModel: lease.authorizeModel } : {}),
      revoke: lease.revoke
    };
  }

  private scheduleCredentialRenewal(instance: RuntimeInstance, generation: number): void {
    this.clearTimer(instance, 'credentialRenewTimer');
    const lease = instance.credentialLease;
    if (!lease || !this.isLiveChild(instance, generation)) return;
    const remaining = lease.expiresAt - this.options.clock.now();
    const renewalLead = Math.min(5 * 60_000, Math.max(1_000, Math.floor(remaining / 5)));
    const delay = Math.max(1, remaining - renewalLead);
    instance.credentialRenewTimer = this.schedule(async () => {
      instance.credentialRenewTimer = null;
      if (!this.isLiveChild(instance, generation) || instance.credentialLease !== lease) return;
      try {
        const expiresAt = await lease.renew();
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.options.clock.now()) {
          throw new Error('invalid expiry');
        }
        if (!this.isLiveChild(instance, generation) || instance.credentialLease !== lease) return;
        lease.expiresAt = expiresAt;
        this.scheduleCredentialRenewal(instance, generation);
      } catch {
        if (!this.isLiveChild(instance, generation) || instance.credentialLease !== lease) return;
        instance.lastError = 'Managed DSH Provider capability renewal failed';
        this.pushLog(instance, 'stderr', instance.lastError);
        this.setState(instance, 'UNHEALTHY');
        this.requestExit(instance);
      }
    }, delay);
  }

  private async revokeLeaseValue(lease: DshRuntimeCredentialLease, reason: string): Promise<void> {
    try {
      await lease.revoke(reason);
    } catch {
      // Revocation is best effort at process teardown. Never log the callback
      // error because an implementation could accidentally include a token.
      this.options.logger.warn('DSH Provider credential revoke failed', { reason });
    }
  }

  private releaseCredentialLease(instance: RuntimeInstance, reason: string): Promise<void> {
    this.clearTimer(instance, 'credentialRenewTimer');
    if (!instance.credentialLease) return instance.credentialRelease ?? Promise.resolve();
    const lease = instance.credentialLease;
    instance.credentialLease = null;
    const pending = this.revokeLeaseValue(lease, reason);
    instance.credentialRelease = pending;
    void pending.finally(() => {
      if (instance.credentialRelease === pending) instance.credentialRelease = null;
    });
    return pending;
  }

  private assertRuntimeEntry(): void {
    assertBelow(this.options.runtimeRoot, this.options.runtimeEntry, 'DSH runtime entry');
    if (!existsSync(this.options.runtimeEntry)) throw new Error('Managed DSH runtime is not prepared');
    const stat = lstatSync(this.options.runtimeEntry);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Managed DSH runtime entry is invalid');
  }

  private assertManagedPolicy(policyPatch: string): void {
    assertBelow(this.options.runtimeRoot, policyPatch, 'DSH managed policy patch');
    if (!existsSync(policyPatch)) throw new Error('Managed DSH policy patch is missing');
    const stat = lstatSync(policyPatch);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Managed DSH policy patch is invalid');
  }

  private attachProcess(instance: RuntimeInstance, child: ChildProcess, generation: number): void {
    this.attachOutput(instance, child, 'stdout');
    this.attachOutput(instance, child, 'stderr');
    child.once('error', (error) => {
      if (!this.isCurrent(instance, generation) || instance.child !== child) return;
      instance.lastError = this.safeError(instance, error, 'Managed DSH process error');
      this.pushLog(instance, 'stderr', instance.lastError);
      // A failed spawn has no pid. Errors from kill()/IPC after a successful
      // spawn do not prove process death; only close may release that lease.
      if (child.pid === undefined) this.handleClose(instance, child, generation, null, null);
    });
    child.once('close', (code, signal) => this.handleClose(instance, child, generation, code, signal));
  }

  private attachOutput(instance: RuntimeInstance, child: ChildProcess, source: 'stdout' | 'stderr'): void {
    const stream = child[source];
    if (!stream) return;
    const state: LogStreamState = {
      decoder: new StringDecoder('utf8'),
      redactor: createSensitiveTextRedactor(instance.redactionEnvironment),
      pending: '',
      finished: false
    };
    instance.streams[source] = state;
    stream.on('data', (chunk: string | Buffer) => {
      if (state.finished) return;
      const decoded = typeof chunk === 'string' ? chunk : state.decoder.write(chunk);
      this.consumeLogText(instance, source, state, state.redactor.push(decoded));
    });
    stream.once('end', () => this.finishLogStream(instance, source));
  }

  private consumeLogText(
    instance: RuntimeInstance,
    source: 'stdout' | 'stderr',
    state: LogStreamState,
    text: string
  ): void {
    state.pending += text;
    while (true) {
      const newline = state.pending.search(/\r?\n/);
      if (newline < 0) break;
      const skip = state.pending[newline] === '\r' && state.pending[newline + 1] === '\n' ? 2 : 1;
      this.pushLog(instance, source, state.pending.slice(0, newline));
      state.pending = state.pending.slice(newline + skip);
    }
    if (state.pending.length > this.options.maxLogLineChars * 2) {
      this.pushLog(instance, source, state.pending.slice(0, this.options.maxLogLineChars));
      state.pending = state.pending.slice(-this.options.maxLogLineChars);
    }
  }

  private finishLogStream(instance: RuntimeInstance, source: 'stdout' | 'stderr'): void {
    const state = instance.streams[source];
    if (!state || state.finished) return;
    state.finished = true;
    const tail = state.redactor.push(state.decoder.end()) + state.redactor.finish();
    this.consumeLogText(instance, source, state, tail);
    if (state.pending) this.pushLog(instance, source, state.pending);
    state.pending = '';
  }

  private pushLog(instance: RuntimeInstance, source: 'stdout' | 'stderr', rawMessage: string): void {
    const normalized = this.redactGeneric(
      redactSensitiveText(rawMessage, instance.redactionEnvironment)
        .replace(ANSI_ESCAPE, '')
        .replace(CONTROL_CHAR, '')
        .trimEnd()
    );
    if (!normalized) return;
    const marker = ' ...[truncated]';
    const message = normalized.length <= this.options.maxLogLineChars
      ? normalized
      : `${normalized.slice(0, Math.max(0, this.options.maxLogLineChars - marker.length))}${marker}`;
    instance.recentLogs.push({ at: this.options.clock.now(), source, message });
    if (instance.recentLogs.length > this.options.maxLogEntries) {
      instance.recentLogs.splice(0, instance.recentLogs.length - this.options.maxLogEntries);
    }
  }

  private redactGeneric(text: string): string {
    return text
      .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@')
      .replace(/([?&](?:api[_-]?key|token|secret|password)=)[^&\s]+/gi, '$1[REDACTED]')
      .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]')
      .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*["']?\s*[:=]\s*["']?)[^"',\s]+/gi, '$1[REDACTED]')
      .replace(/\b(?:sk|ds|key)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
  }

  private pollUntilReady(instance: RuntimeInstance, generation: number, deadline: number): void {
    const poll = async () => {
      if (!this.isLiveChild(instance, generation)) return;
      const healthy = await this.probe(instance.endpoint as string);
      if (!this.isLiveChild(instance, generation)) return;
      if (healthy) {
        const now = this.options.clock.now();
        instance.readyAt = now;
        instance.lastHealthAt = now;
        instance.unhealthyCount = 0;
        this.setState(instance, 'READY');
        const activation = instance.activation;
        instance.activation = null;
        activation?.resolve(this.snapshot(instance));
        this.scheduleHealth(instance, generation);
        return;
      }
      if (this.options.clock.now() >= deadline) {
        instance.lastError = 'Managed DSH readiness probe timed out';
        this.pushLog(instance, 'stderr', instance.lastError);
        this.requestExit(instance);
        return;
      }
      instance.readinessTimer = this.schedule(poll, this.options.startupPollMs);
    };
    void poll();
  }

  private scheduleHealth(instance: RuntimeInstance, generation: number): void {
    instance.healthTimer = this.schedule(async () => {
      if (!this.isLiveChild(instance, generation) || instance.processState !== 'READY') return;
      const healthy = await this.probe(instance.endpoint as string);
      if (!this.isLiveChild(instance, generation)) return;
      if (healthy) {
        instance.lastHealthAt = this.options.clock.now();
        instance.unhealthyCount = 0;
        this.emit(instance);
        this.scheduleHealth(instance, generation);
        return;
      }
      instance.unhealthyCount += 1;
      if (instance.unhealthyCount < this.options.unhealthyThreshold) {
        this.scheduleHealth(instance, generation);
        return;
      }
      instance.lastError = 'Managed DSH health probe failed';
      this.setState(instance, 'UNHEALTHY');
      this.requestExit(instance);
    }, this.options.healthIntervalMs);
  }

  private async probe(endpoint: string): Promise<boolean> {
    const controller = new AbortController();
    let timeout: unknown;
    const timedOut = new Promise<boolean>((resolveProbe) => {
      timeout = this.schedule(() => {
        controller.abort();
        resolveProbe(false);
      }, this.options.probeTimeoutMs);
    });
    const request = this.options.fetch(`${endpoint}/`, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal
    }).then(
      (response) => response.status >= 200 && response.status < 400,
      () => false
    );
    try {
      return await Promise.race([request, timedOut]);
    } finally {
      this.options.clock.clearTimeout(timeout);
    }
  }

  private handleClose(
    instance: RuntimeInstance,
    child: ChildProcess,
    generation: number,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (!this.isCurrent(instance, generation) || instance.child !== child) return;
    this.clearTimer(instance, 'readinessTimer');
    this.clearTimer(instance, 'healthTimer');
    this.clearTimer(instance, 'terminateTimer');
    this.clearTimer(instance, 'forceWaitTimer');
    this.clearTimer(instance, 'credentialRenewTimer');
    this.finishLogStream(instance, 'stdout');
    this.finishLogStream(instance, 'stderr');
    instance.child = null;
    instance.endpoint = null;
    instance.lastExit = { at: this.options.clock.now(), code, signal };
    instance.redactionEnvironment = {};
    const credentialRelease = this.releaseCredentialLease(instance, 'runtime_exit');

    if (!instance.desiredRunning) {
      this.setState(instance, 'STOPPED');
      const stopping = instance.stopping;
      instance.stopping = null;
      void credentialRelease.then(() => stopping?.resolve());
      return;
    }
    this.recordFailureAndRestart(instance);
  }

  private failWithoutChild(instance: RuntimeInstance, message: string): void {
    void this.releaseCredentialLease(instance, 'launch_failed');
    instance.endpoint = null;
    instance.lastError = message;
    this.pushLog(instance, 'stderr', message);
    instance.crashCount += 1;
    instance.consecutiveFailures += 1;
    instance.nextRestartAt = null;
    this.setState(instance, 'CRASH_LOOP');
    const activation = instance.activation;
    instance.activation = null;
    activation?.reject(new Error(message));
  }

  private recordFailureAndRestart(instance: RuntimeInstance): void {
    const now = this.options.clock.now();
    if (instance.readyAt !== null && now - instance.readyAt >= this.options.stableRuntimeMs) {
      instance.consecutiveFailures = 0;
    }
    instance.crashCount += 1;
    instance.consecutiveFailures += 1;
    if (!instance.desiredRunning || this.closed) {
      this.setState(instance, 'STOPPED');
      return;
    }
    if (instance.consecutiveFailures > this.options.maxRestartAttempts) {
      instance.nextRestartAt = null;
      instance.lastError ??= 'Managed DSH entered crash-loop protection';
      this.setState(instance, 'CRASH_LOOP');
      const activation = instance.activation;
      instance.activation = null;
      activation?.reject(new Error(instance.lastError));
      return;
    }

    const exponent = Math.max(0, instance.consecutiveFailures - 1);
    const delay = Math.min(
      this.options.restartMaxDelayMs,
      this.options.restartBaseDelayMs * (2 ** Math.min(exponent, 30))
    );
    instance.nextRestartAt = now + delay;
    this.setState(instance, 'BACKOFF');
    instance.restartTimer = this.schedule(() => {
      instance.restartTimer = null;
      if (instance.desiredRunning && !this.closed) this.launch(instance);
    }, delay);
  }

  private requestExit(instance: RuntimeInstance): void {
    const child = instance.child;
    if (!child) return;
    try { child.kill('SIGTERM'); } catch { /* close/error handlers own the outcome */ }
    instance.terminateTimer = this.schedule(() => {
      if (instance.child !== child) return;
      try { child.kill('SIGKILL'); } catch { /* verified below */ }
      instance.forceWaitTimer = this.schedule(() => {
        if (instance.child !== child) return;
        this.clearTimer(instance, 'readinessTimer');
        this.clearTimer(instance, 'healthTimer');
        void this.releaseCredentialLease(instance, 'force_kill');
        instance.lastError = 'Managed DSH process did not exit after force kill';
        this.setState(instance, instance.desiredRunning ? 'CRASH_LOOP' : 'STOP_FAILED');
        if (instance.activation) {
          instance.activation.reject(new Error(instance.lastError));
          instance.activation = null;
        }
        if (instance.stopping) {
          instance.stopping.reject(new Error(instance.lastError));
          instance.stopping = null;
        }
      }, this.options.forceKillWaitMs);
    }, this.options.stopTimeoutMs);
  }

  private safeError(instance: RuntimeInstance, error: unknown, fallback: string): string {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;
    const safe = this.redactGeneric(redactSensitiveText(message, instance.redactionEnvironment));
    return safe.trim() || fallback;
  }

  private snapshot(instance: RuntimeInstance): DshRuntimeStatus {
    return {
      agentId: instance.agentId,
      profileId: instance.profileId,
      generation: instance.generation,
      processState: instance.processState,
      endpoint: instance.endpoint,
      pid: instance.child?.pid ?? null,
      home: instance.home,
      profileDirectory: instance.profileDirectory,
      workspace: instance.workspace,
      startedAt: instance.startedAt,
      readyAt: instance.readyAt,
      lastHealthAt: instance.lastHealthAt,
      nextRestartAt: instance.nextRestartAt,
      restartCount: Math.max(0, instance.launchCount - 1),
      crashCount: instance.crashCount,
      consecutiveFailures: instance.consecutiveFailures,
      lastExit: instance.lastExit ? { ...instance.lastExit } : null,
      lastError: instance.lastError,
      recentLogs: instance.recentLogs.map((entry) => ({ ...entry }))
    };
  }

  private setState(instance: RuntimeInstance, state: DshProcessState): void {
    instance.processState = state;
    this.emit(instance);
    const meta = { agentId: instance.agentId, profileId: instance.profileId, state };
    if (state === 'CRASH_LOOP' || state === 'STOP_FAILED') this.options.logger.error('DSH runtime state changed', meta);
    else if (state === 'BACKOFF' || state === 'UNHEALTHY') this.options.logger.warn('DSH runtime state changed', meta);
    else this.options.logger.debug('DSH runtime state changed', meta);
  }

  private emit(instance: RuntimeInstance): void {
    const status = this.snapshot(instance);
    for (const listener of this.listeners) {
      try { listener(status); } catch { /* observers cannot own runtime health */ }
    }
  }

  private isCurrent(instance: RuntimeInstance, generation: number): boolean {
    return instance.generation === generation;
  }

  private isLiveChild(instance: RuntimeInstance, generation: number): boolean {
    return this.isCurrent(instance, generation) && instance.child !== null && instance.desiredRunning;
  }

  private schedule(callback: () => void | Promise<void>, delayMs: number): unknown {
    const timer = this.options.clock.setTimeout(() => { void callback(); }, delayMs);
    unrefTimer(timer);
    return timer;
  }

  private clearTimer(
    instance: RuntimeInstance,
    key: 'readinessTimer' | 'healthTimer' | 'restartTimer' | 'terminateTimer' | 'forceWaitTimer' | 'credentialRenewTimer'
  ): void {
    const timer = instance[key];
    if (timer !== null) this.options.clock.clearTimeout(timer);
    instance[key] = null;
  }
}
