/**
 * Controlled community-plugin lifecycle for the managed DSH profile.
 *
 * This service deliberately does not load plugin code. It accepts only entries
 * from a Main-owned allowlist, installs with a fixed npm argv, verifies the
 * resulting package manifest, and leaves activation to a later profile
 * restart/probe. A short-lived confirmation capability prevents a stale UI
 * click from turning into an install request.
 */
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { runCli } from './cliLauncher.js';
import { childProcessEnv } from './engineEnv.js';
import type { DshPluginCatalogService } from './dshPluginCatalog.js';
import type { DshScopedPolicyBroker } from './dshPolicyBroker.js';
import type {
  DshBuiltInCapabilityView,
  DshCommunityPluginCatalogView,
  DshCommunityPluginBoundary,
  DshCommunityPluginCompatibility,
  DshCommunityPluginPackView,
  DshCommunityPluginSourceKind,
  DshCommunityPluginSourceView,
  DshCommunityPluginStatus,
  DshCommunityPluginView,
  DshCommunityPluginHealth,
  DshPluginInstallConfirmationView,
  DshPluginInstallRequest,
  DshPluginInstallResultView,
  DshPluginLifecycleAction,
  DshPluginLifecycleConfirmationView,
  DshPluginLifecycleRequest,
  DshPluginLifecycleResultView,
  DshPluginProfileState
} from '../../shared/types.js';

// Agent IDs are UUIDs in the host database and may begin with a digit.
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,127}|[a-z0-9][a-z0-9._-]{0,127})$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const GITHUB_PART = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const GIT_COMMIT = /^[0-9a-f]{40}$/i;
const MAX_ENTRIES = 256;
const MAX_CAPABILITIES = 32;
const MAX_WARNINGS = 64;
const CONFIRMATION_TTL_MS = 5 * 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const PROFILE_METADATA_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package-lock.json', 'cordis.patch.yml'] as const;
const CORE_PACKAGES = new Set([
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-web-frontend'
]);

export interface DshCommunityPackageSource {
  kind: 'package';
  packageName: string;
  version: string;
}

export interface DshCommunityGithubSource {
  kind: 'github';
  packageName: string;
  owner: string;
  repository: string;
  /** Immutable 40-character commit. Branches and mutable tags are rejected. */
  ref: string;
}

export type DshCommunityPluginSource = DshCommunityPackageSource | DshCommunityGithubSource;

export interface DshCommunityPluginAllowlistEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  source: DshCommunityPluginSource;
  capabilities: string[];
  risk: 'safe' | 'write' | 'native';
  /** Runtime code needing Browser/Workflow/TUI/Vision or other privileged
   * adapters stays visible but cannot be mounted directly into DSH. */
  runtimeBoundary?: DshCommunityPluginBoundary;
  compatibility?: DshCommunityPluginCompatibility;
  questPart?: number;
  defaultEnabled?: boolean;
  reasonCodes?: string[];
  allowScripts?: boolean;
  /** Curated provenance shown to the user; never interpreted as an install source. */
  publisher?: string;
  repositoryUrl?: string;
  articleUrl?: string;
}

export interface DshCommunityPluginPackDefinition {
  id: string;
  name: string;
  description: string;
  risk: 'safe' | 'write' | 'native';
  members: ReadonlyArray<{
    pluginId: string;
    packageName: string;
    version: string;
  }>;
}

export interface DshCommunityPluginProfileController {
  /** Stable DSH profile identity (normally `web`). */
  profileId?: string;
  /** DSH_HOME root for this agent/profile. */
  home?: string;
  /** Mutable profile directory where DSH's plugin command installs packages. */
  profileDirectory?: string;
  /** Optional project/workspace root forwarded to pnpm's `--workspace-root`. */
  workspaceRoot?: string;
  getState?(): DshPluginProfileState | Promise<DshPluginProfileState>;
  stop?(): Promise<void>;
  start?(): Promise<void>;
}

export interface DshCommunityPluginProfileResolution extends DshCommunityPluginProfileController {
  profileId: string;
  home: string;
  profileDirectory: string;
  workspaceRoot?: string;
}

export interface DshCommunityPluginInstallCommand {
  /** Absolute executable used to invoke the managed DSH CLI (normally Node). */
  executable?: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface DshCommunityPluginInstallCommandResult {
  ok: boolean;
  code: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface DshCommunityPluginServiceOptions {
  /** Immutable prepared DSH bundle. It is only read for the CLI entry/catalog. */
  runtimeRoot: string;
  /** Absolute managed DSH launcher entry (`.../@deepseek-ai/dsh/lib/bin.js`). */
  runtimeEntry?: string;
  /** Absolute Node executable used to invoke runtimeEntry. */
  nodeExecutable?: string;
  /** Agent used by legacy single-profile calls when no agentId is supplied. */
  defaultAgentId?: string;
  /** Resolve a mutable DSH profile for one agent. Main owns this mapping. */
  resolveProfile?: (agentId: string) => DshCommunityPluginProfileResolution | null | Promise<DshCommunityPluginProfileResolution | null>;
  /** Optional path/controller for legacy single-profile callers. */
  profileDirectory?: string;
  profileHome?: string;
  profileId?: string;
  /** Explicit Main-side approval for curated packages that execute install scripts. */
  allowInstallScripts?: boolean;
  allowlist?: readonly DshCommunityPluginAllowlistEntry[];
  /** Defaults to the governed Quest inventory pack only when the default allowlist is used. */
  questDefaultPack?: DshCommunityPluginPackDefinition | null;
  dshCatalog?: Pick<DshPluginCatalogService, 'getCatalog'>;
  /** Main-owned capabilities that replace unsafe community implementations. */
  builtInCapabilities?: readonly DshBuiltInCapabilityView[];
  /** Optional package-specific attach/health evidence. Absence is never
   * interpreted as healthy. */
  resolveActivation?: (input: {
    agentId: string;
    profileId: string;
    pluginId: string;
    packageName: string;
    installedVersion: string;
  }) => { attached: boolean; health: DshCommunityPluginHealth } | null;
  profile?: DshCommunityPluginProfileController;
  now?: () => number;
  runInstall?: (command: DshCommunityPluginInstallCommand) => Promise<DshCommunityPluginInstallCommandResult>;
  audit?: (event: DshCommunityPluginAuditEvent) => void | Promise<void>;
  /** Main-owned scope factory. Missing policy keeps installation fail-closed. */
  policyForProfile?: (agentId: string, profileId: string) => DshScopedPolicyBroker | null;
}

export interface DshCommunityPluginAuditEvent {
  operationId: string;
  agentId?: string;
  profileId?: string;
  pluginId: string;
  action:
    | 'confirmation'
    | `${DshPluginLifecycleAction}.start`
    | `${DshPluginLifecycleAction}.stop-profile`
    | `${DshPluginLifecycleAction}.complete`
    | `${DshPluginLifecycleAction}.fail`
    | `${DshPluginLifecycleAction}.resume-profile`;
  result: 'ok' | 'failed' | 'expired' | 'rejected' | 'skipped';
  source: DshCommunityPluginSourceKind;
}

/**
 * The ten community capabilities requested for Quest. Presence in this list
 * is inventory and governance metadata, not execution authority. Every source
 * is pinned, while incompatible or privileged entries remain fail-closed.
 */
export const DEFAULT_DSH_COMMUNITY_PLUGIN_ALLOWLIST: readonly DshCommunityPluginAllowlistEntry[] = Object.freeze([
  {
    id: 'dsh-anchored-standard',
    name: 'DSH Anchored Standard',
    description: 'Anchored agent preset and prefab installer; this is not a Cordis plugin bundle.',
    version: '0.1.0',
    source: {
      kind: 'github',
      packageName: 'dsh-anchored-standard',
      owner: 'xiaobright',
      repository: 'dsh-anchored-standard',
      ref: '25f21aefaf8ddc414da54d2e581e43740d977c6e'
    },
    capabilities: ['preset', 'filesystem', 'shell', 'session-write'],
    risk: 'native',
    runtimeBoundary: 'blocked',
    compatibility: 'incompatible',
    questPart: 1,
    reasonCodes: ['NOT_A_CORDIS_PLUGIN', 'MANAGED_POLICY_CONFLICT', 'PINNED_GITHUB_COMMIT'],
    publisher: 'xiaobright',
    repositoryUrl: 'https://github.com/xiaobright/dsh-anchored-standard'
  },
  {
    id: 'dsh-web-ui',
    name: 'DSH Web UI All',
    description: 'Community enhancement aggregate for the official Web UI; it is not the official Web UI shipped by DSH.',
    version: '0.1.19',
    source: { kind: 'package', packageName: '@linxin666/dsh-web-ui-all', version: '0.1.19' },
    capabilities: ['ui', 'remote-web', 'ssh', 'filesystem', 'task', 'vision'],
    risk: 'native',
    runtimeBoundary: 'blocked',
    compatibility: 'verified',
    questPart: 2,
    reasonCodes: [
      'AGGREGATE_PRIVILEGE_ESCALATION',
      'OFFICIAL_DSH_WEB_UI_ACTIVE',
      'COMMUNITY_ENHANCEMENTS_NOT_BUILT_IN',
      'DSH_RC6_BUNDLE_COMPOSITION_VERIFIED'
    ],
    publisher: 'linxin666',
    repositoryUrl: 'https://github.com/zhu1090093659/dsh-web-ui',
    articleUrl: 'https://mp.weixin.qq.com/s/Kd4xVq4_DrJxRrcvXCzsCg'
  },
  {
    id: 'dsh-better-sidebar',
    name: 'DSH Better Sidebar',
    description: 'Sidebar navigation and workspace organization for DSH.',
    version: '0.12.3',
    source: { kind: 'package', packageName: 'dsh-better-sidebar', version: '0.12.3' },
    capabilities: ['ui', 'filesystem', 'terminal', 'browser', 'native'],
    risk: 'native',
    runtimeBoundary: 'explicit-profile-permission',
    compatibility: 'verified',
    questPart: 3,
    reasonCodes: ['EXPLICIT_PERMISSION_REQUIRED', 'NATIVE_PTY', 'FILESYSTEM_WRITE'],
    publisher: 'omdsh-dev',
    repositoryUrl: 'https://github.com/omdsh-dev/DSH-better-sidebar',
    articleUrl: 'https://mp.weixin.qq.com/s/Kd4xVq4_DrJxRrcvXCzsCg'
  },
  {
    id: 'modlens',
    name: 'ModLens',
    description: 'Multimodal image inspection and model-routing extension.',
    version: '3.18.1',
    source: { kind: 'package', packageName: '@liustack/modlens', version: '3.18.1' },
    capabilities: ['multimodal', 'vision', 'filesystem', 'network', 'secret'],
    risk: 'write',
    runtimeBoundary: 'main-adapter-required',
    compatibility: 'unverified',
    questPart: 4,
    reasonCodes: ['MAIN_ADAPTER_REQUIRED', 'VISION_CREDENTIAL_PROXY_REQUIRED'],
    publisher: 'liustack',
    repositoryUrl: 'https://github.com/liustack/modlens'
  },
  {
    id: 'dsh-vision-toolkit',
    name: 'DSH Vision Toolkit',
    description: 'Vision, screenshot and pixel-diff tools requiring bounded files, subprocesses and a VLM.',
    version: '0.1.26',
    source: { kind: 'package', packageName: '@anionex/dsh-vision-toolkit', version: '0.1.26' },
    capabilities: ['vision', 'artifact', 'filesystem', 'process', 'network'],
    risk: 'native',
    runtimeBoundary: 'main-adapter-required',
    compatibility: 'verified',
    questPart: 5,
    reasonCodes: ['MAIN_ADAPTER_REQUIRED', 'VISION_CREDENTIAL_PROXY_REQUIRED', 'RUNTIME_INSTALL_DISABLED'],
    publisher: 'anionex',
    repositoryUrl: 'https://github.com/Anionex/dsh-vision-toolkit'
  },
  {
    id: 'dsh-tui',
    name: 'DSH TUI',
    description: 'Standalone terminal client; two similarly named packages have conflicting identities.',
    version: '0.2.1',
    source: { kind: 'package', packageName: '@openma/deepseek-harness-tui', version: '0.2.1' },
    capabilities: ['terminal', 'session', 'process', 'loopback'],
    risk: 'native',
    runtimeBoundary: 'standalone-only',
    compatibility: 'identity-conflict',
    questPart: 6,
    reasonCodes: ['STANDALONE_ONLY', 'PACKAGE_IDENTITY_CONFLICT'],
    publisher: 'openma-ai',
    repositoryUrl: 'https://github.com/openma-ai/deepseek-harness-tui'
  },
  {
    id: 'dsh-browser',
    name: 'DSH Browser',
    description: 'Browser capability extension for DSH sessions.',
    version: '0.1.0',
    source: { kind: 'package', packageName: 'dsh-browser', version: '0.1.0' },
    capabilities: ['browser', 'network'],
    risk: 'write',
    runtimeBoundary: 'main-adapter-required',
    compatibility: 'unverified',
    questPart: 7,
    reasonCodes: ['MAIN_ADAPTER_REQUIRED', 'BROWSER_NETWORK_WRITE_PERMISSION'],
    publisher: 'ben7am1n',
    repositoryUrl: 'https://github.com/ben7am1n/dsh-browser',
    articleUrl: 'https://mp.weixin.qq.com/s/Kd4xVq4_DrJxRrcvXCzsCg'
  },
  {
    id: 'dsh-workflow',
    name: 'DSH Workflow',
    description: 'Dynamic QuickJS workflow bundle targeting an older DSH release line.',
    version: '0.1.2',
    source: {
      kind: 'github',
      packageName: '@dsh-external/workflow',
      owner: 'omdsh-dev',
      repository: 'dsh_workflow',
      ref: '44b83c182aa02d1be8a0803e8446cb495f93cd8f'
    },
    capabilities: ['workflow', 'runtime-authoring', 'jobs', 'subagent', 'approval'],
    risk: 'native',
    runtimeBoundary: 'blocked',
    compatibility: 'incompatible',
    questPart: 8,
    reasonCodes: ['DSH_RC6_INCOMPATIBLE', 'RUNTIME_AUTHORING_DISABLED', 'PINNED_GITHUB_COMMIT'],
    publisher: 'omdsh-dev',
    repositoryUrl: 'https://github.com/omdsh-dev/dsh_workflow'
  },
  {
    id: 'dsh-chat-import',
    name: 'DSH Chat Import',
    description: 'Import existing conversations into the DSH workspace.',
    version: '0.5.1',
    source: { kind: 'package', packageName: 'dsh-chat-import', version: '0.5.1' },
    capabilities: ['import', 'filesystem', 'session-write'],
    risk: 'write',
    runtimeBoundary: 'explicit-profile-permission',
    compatibility: 'verified',
    questPart: 9,
    reasonCodes: ['EXPLICIT_PERMISSION_REQUIRED', 'CHAT_HISTORY_SCOPE_REQUIRED', 'SESSION_WRITE'],
    publisher: 'Nwflower',
    repositoryUrl: 'https://github.com/Nwflower/dsh-chat-import',
    articleUrl: 'https://mp.weixin.qq.com/s/Kd4xVq4_DrJxRrcvXCzsCg'
  },
  {
    id: 'dsh-find-plugin',
    name: 'DSH Find Plugin',
    description: 'Discover community plugins from the DSH ecosystem.',
    version: '0.3.6',
    source: { kind: 'package', packageName: 'dsh-find-plugin', version: '0.3.6' },
    capabilities: ['discovery', 'network'],
    risk: 'write',
    runtimeBoundary: 'main-adapter-required',
    compatibility: 'verified',
    questPart: 10,
    reasonCodes: [
      'MAIN_ADAPTER_REQUIRED',
      'NETWORK_PROXY_REQUIRED',
      'UNTRUSTED_INSTALL_COMMAND_OUTPUT',
      'STALE_PEER_RANGE',
      'DSH_RC6_STARTUP_VERIFIED'
    ],
    publisher: 'awesome-dsh-plugin',
    repositoryUrl: 'https://github.com/awesome-dsh-plugin/dsh-find-plugin',
    articleUrl: 'https://mp.weixin.qq.com/s/Kd4xVq4_DrJxRrcvXCzsCg'
  }
]);

/** Inventory pack shown by default in Quest. It never batch-installs or enables
 * third-party code; each member keeps its own compatibility and policy state. */
export const QUEST_DEFAULT_DSH_PLUGIN_PACK: DshCommunityPluginPackDefinition = Object.freeze({
  id: 'quest-default',
  name: 'Quest 默认能力包',
  description: '10 项社区能力已纳入 Quest 治理；第三方代码默认启用 0 项，按兼容性和权限边界逐项开放。',
  risk: 'native',
  members: Object.freeze(DEFAULT_DSH_COMMUNITY_PLUGIN_ALLOWLIST
    .filter((entry) => entry.questPart !== undefined)
    .sort((left, right) => left.questPart! - right.questPart!)
    .map((entry) => Object.freeze({
      pluginId: entry.id,
      packageName: entry.source.packageName,
      version: entry.version
    })))
});

/** Article entries intentionally kept visible as non-installable until their
 * package identity, publisher and immutable source can be verified. */
export const UNRESOLVED_DSH_ARTICLE_PLUGIN_WARNINGS: readonly string[] = Object.freeze([
  'Quest 默认能力包只表示已纳入治理，第三方代码默认启用 0 项。',
  '高权限插件必须经过 Main 适配或显式目录/网络/进程授权；不兼容项不提供安装入口。'
]);

interface ConfirmationRecord {
  agentId: string;
  profileId: string;
  pluginId: string;
  action: DshPluginLifecycleAction;
  token: string;
  expiresAt: number;
}

interface ProfileContext {
  agentId: string;
  profileId: string;
  home: string;
  profileDirectory: string;
  workspaceRoot: string;
  controller: DshCommunityPluginProfileController;
  state: DshPluginProfileState;
}

interface InstalledPackage {
  installed: boolean;
  version: string | null;
  path: string | null;
  manifestValid: boolean;
  bundlePatch: string | null;
  bundleValid: boolean;
}

interface BackupRecord {
  root: string;
  profileDirectory: string;
  files: string[];
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function boundedList(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} is invalid`);
  const result: string[] = [];
  for (const item of value) {
    const text = boundedString(item, label, 80);
    if (!IDENTIFIER.test(text) || result.includes(text)) throw new Error(`${label} is invalid`);
    result.push(text);
  }
  return result;
}

function regularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function regularDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function lexicalRuntimeChild(root: string, child: string): string {
  const target = resolve(root, child);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Managed path escapes profile');
  return target;
}

function safeRuntimeChild(root: string, child: string): string {
  const target = lexicalRuntimeChild(root, child);
  const rel = relative(root, target);
  let current = root;
  for (const segment of rel.split(/[\\/]+/)) {
    if (!segment) continue;
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('Managed path contains a symbolic link');
    } catch (error) {
      if (error instanceof Error && error.message === 'Managed path contains a symbolic link') throw error;
      break;
    }
  }
  return target;
}

function validateProfilePaths(home: string, profileDirectory: string, profileId: string): void {
  if (!IDENTIFIER.test(profileId)) throw new Error('DSH profile id is invalid');
  const normalizedHome = resolve(home);
  const normalizedProfile = resolve(profileDirectory);
  const rel = relative(normalizedHome, normalizedProfile);
  const expected = join('profiles', profileId);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.replaceAll('\\', '/') !== expected.replaceAll('\\', '/')) {
    throw new Error('DSH profile directory is outside the managed profile home');
  }
  // Reject an existing symlink in either the home or profile chain. Missing
  // leaf directories are valid and are created by ensureProfile/install.
  try {
    const homeStat = lstatSync(normalizedHome);
    if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) throw new Error('DSH profile home is not a real directory');
  } catch (error) {
    if (error instanceof Error && error.message === 'DSH profile home is not a real directory') throw error;
    // The supervisor may materialize a brand-new home after this check.
  }
  let cursor = normalizedHome;
  for (const segment of rel.split(/[\\/]+/)) {
    cursor = join(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('DSH profile path contains a symbolic link');
    } catch (error) {
      if (error instanceof Error && error.message === 'DSH profile path contains a symbolic link') throw error;
      break;
    }
  }
}

function normalizeWorkspaceRoot(value: unknown, fallback: string): string {
  const candidate = typeof value === 'string' && value.trim().length > 0 ? resolve(value) : resolve(fallback);
  if (!isAbsolute(candidate) || candidate.includes('\u0000')) throw new Error('DSH workspace root is invalid');
  if (existsSync(candidate) && !regularDirectory(candidate)) throw new Error('DSH workspace root is not a directory');
  return candidate;
}

/** Create a fresh profile path while rejecting symlinked ancestors. */
function ensureProfileDirectory(home: string, profileDirectory: string, profileId: string): void {
  validateProfilePaths(home, profileDirectory, profileId);
  const normalizedHome = resolve(home);
  const normalizedProfile = resolve(profileDirectory);
  mkdirSync(normalizedHome, { recursive: true });
  const homeStat = lstatSync(normalizedHome);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) throw new Error('DSH profile home is not a real directory');
  const relativeProfile = relative(normalizedHome, normalizedProfile);
  let cursor = normalizedHome;
  for (const segment of relativeProfile.split(/[\\/]+/)) {
    if (!segment) continue;
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) mkdirSync(cursor);
    const stat = lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('DSH profile path is not a real directory');
  }
}

function normalizeSource(source: unknown, entryVersion: string): DshCommunityPluginSource {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Plugin source is invalid');
  const input = source as Record<string, unknown>;
  const kind = boundedString(input.kind, 'Plugin source kind', 16);
  const packageName = boundedString(input.packageName, 'Plugin package name', 192);
  if (!PACKAGE_NAME.test(packageName) || CORE_PACKAGES.has(packageName)) throw new Error('Plugin package name is not allowlisted');
  if (kind === 'package') {
    const version = boundedString(input.version, 'Plugin package version', 64);
    if (!SEMVER.test(version) || version !== entryVersion) throw new Error('Plugin package version is invalid or mismatched');
    return { kind: 'package', packageName, version };
  }
  if (kind === 'github') {
    const owner = boundedString(input.owner, 'GitHub owner', 100);
    const repository = boundedString(input.repository, 'GitHub repository', 100);
    const ref = boundedString(input.ref, 'GitHub ref', 64);
    if (!GITHUB_PART.test(owner) || !GITHUB_PART.test(repository) || !GIT_COMMIT.test(ref)) {
      throw new Error('GitHub source must use a pinned commit');
    }
    return { kind: 'github', packageName, owner, repository, ref };
  }
  throw new Error('Unsupported plugin source kind');
}

function normalizeEntry(input: DshCommunityPluginAllowlistEntry): DshCommunityPluginAllowlistEntry {
  if (!input || typeof input !== 'object') throw new Error('Plugin allowlist entry is invalid');
  const id = boundedString(input.id, 'Plugin id', 128);
  if (!IDENTIFIER.test(id)) throw new Error('Plugin id is invalid');
  const name = boundedString(input.name, 'Plugin name', 160);
  const description = boundedString(input.description, 'Plugin description', 2_000);
  const version = boundedString(input.version, 'Plugin version', 64);
  if (!SEMVER.test(version)) throw new Error('Plugin version is invalid');
  const source = normalizeSource(input.source, version);
  const capabilities = boundedList(input.capabilities, 'Plugin capabilities', MAX_CAPABILITIES);
  const risk = input.risk;
  if (risk !== 'safe' && risk !== 'write' && risk !== 'native') throw new Error('Plugin risk is invalid');
  const boundaries = new Set<DshCommunityPluginBoundary>([
    'reviewed-profile',
    'explicit-profile-permission',
    'main-adapter-required',
    'standalone-only',
    'blocked'
  ]);
  const runtimeBoundary = input.runtimeBoundary ?? 'reviewed-profile';
  if (!boundaries.has(runtimeBoundary)) throw new Error('Plugin runtime boundary is invalid');
  const compatibilities = new Set<DshCommunityPluginCompatibility>([
    'verified', 'unverified', 'incompatible', 'identity-conflict'
  ]);
  const compatibility = input.compatibility ?? 'unverified';
  if (!compatibilities.has(compatibility)) throw new Error('Plugin compatibility is invalid');
  const questPart = input.questPart;
  if (questPart !== undefined && (!Number.isSafeInteger(questPart) || questPart < 1 || questPart > 99)) {
    throw new Error('Plugin Quest part is invalid');
  }
  if (input.defaultEnabled !== undefined && typeof input.defaultEnabled !== 'boolean') {
    throw new Error('Plugin default enabled flag is invalid');
  }
  // Curated reason codes are display metadata only; policy decisions remain
  // Main-owned and are independently derived below.
  const reasonCodes = boundedList(input.reasonCodes ?? [], 'Plugin reason codes', MAX_WARNINGS);
  const normalizeUrl = (value: unknown, label: string, allowedHosts: readonly string[]): string | undefined => {
    if (value === undefined) return undefined;
    const text = boundedString(value, label, 512);
    let parsed: URL;
    try { parsed = new URL(text); } catch { throw new Error(`${label} is invalid`); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
      || !allowedHosts.includes(parsed.hostname.toLowerCase())) throw new Error(`${label} is invalid`);
    return parsed.toString();
  };
  const publisher = input.publisher === undefined ? undefined : boundedString(input.publisher, 'Plugin publisher', 120);
  const repositoryUrl = normalizeUrl(input.repositoryUrl, 'Plugin repository URL', ['github.com']);
  const articleUrl = normalizeUrl(input.articleUrl, 'Plugin article URL', ['mp.weixin.qq.com']);
  return {
    id, name, description, version, source, capabilities, risk,
    runtimeBoundary,
    compatibility,
    ...(questPart === undefined ? {} : { questPart }),
    defaultEnabled: input.defaultEnabled === true,
    reasonCodes,
    allowScripts: input.allowScripts === true,
    ...(publisher ? { publisher } : {}),
    ...(repositoryUrl ? { repositoryUrl } : {}),
    ...(articleUrl ? { articleUrl } : {})
  };
}

function normalizeBuiltInCapability(input: DshBuiltInCapabilityView): DshBuiltInCapabilityView {
  if (!input || typeof input !== 'object') throw new Error('Built-in DSH capability is invalid');
  const id = boundedString(input.id, 'Built-in capability id', 128);
  if (!IDENTIFIER.test(id)) throw new Error('Built-in capability id is invalid');
  const name = boundedString(input.name, 'Built-in capability name', 160);
  const description = boundedString(input.description, 'Built-in capability description', 1_000);
  if (input.provider !== 'dsh-core' && input.provider !== 'native-host') {
    throw new Error('Built-in capability provider is invalid');
  }
  if (input.status !== 'integrated' && input.status !== 'available' && input.status !== 'unavailable') {
    throw new Error('Built-in capability status is invalid');
  }
  return {
    id,
    name,
    description,
    provider: input.provider,
    status: input.status,
    capabilities: boundedList(input.capabilities, 'Built-in capability names', MAX_CAPABILITIES)
  };
}

function sourceView(source: DshCommunityPluginSource): DshCommunityPluginSourceView {
  return source.kind === 'package'
    ? { kind: 'package', packageName: source.packageName, version: source.version, github: null }
    : { kind: 'github', packageName: source.packageName, version: null, github: { owner: source.owner, repository: source.repository, ref: source.ref } };
}

function installSpec(source: DshCommunityPluginSource): string {
  return source.kind === 'package'
    ? `${source.packageName}@${source.version}`
    : `github:${source.owner}/${source.repository}#${source.ref}`;
}

function outputSnippet(result: DshCommunityPluginInstallCommandResult): string {
  const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text.slice(-240);
}

function emptyInstalled(path: string | null = null): InstalledPackage {
  return { installed: false, version: null, path, manifestValid: false, bundlePatch: null, bundleValid: false };
}

function lifecycleAction(value: unknown): DshPluginLifecycleAction {
  if (value === 'install' || value === 'update' || value === 'uninstall') return value;
  throw new Error('DSH plugin lifecycle action is invalid');
}

function actionAllowed(action: DshPluginLifecycleAction, plugin: DshCommunityPluginView): boolean {
  switch (action) {
    case 'install': return plugin.runtimeBoundary === 'reviewed-profile'
      && (plugin.status === 'available' || plugin.status === 'installed');
    case 'update': return plugin.installable
      && (plugin.status === 'update-available' || plugin.status === 'broken');
    case 'uninstall': return plugin.installedVersion !== null
      && plugin.status !== 'installing'
      && plugin.status !== 'missing';
  }
}

export class DshCommunityPluginService {
  private readonly runtimeRoot: string;
  private readonly runtimeEntry: string;
  private readonly nodeExecutable: string;
  private readonly defaultAgentId: string;
  private readonly resolveProfile?: DshCommunityPluginServiceOptions['resolveProfile'];
  private readonly legacyProfile: DshCommunityPluginProfileController | undefined;
  private readonly legacyProfileDirectory: string | undefined;
  private readonly legacyProfileHome: string | undefined;
  private readonly legacyProfileId: string;
  private readonly now: () => number;
  private readonly entries: Map<string, DshCommunityPluginAllowlistEntry>;
  private readonly questDefaultPack: DshCommunityPluginPackDefinition | null;
  private readonly confirmations = new Map<string, ConfirmationRecord>();
  private readonly dshCatalog?: Pick<DshPluginCatalogService, 'getCatalog'>;
  private readonly builtInCapabilities: readonly DshBuiltInCapabilityView[];
  private readonly resolveActivation?: DshCommunityPluginServiceOptions['resolveActivation'];
  private readonly audit?: DshCommunityPluginServiceOptions['audit'];
  private readonly policyForProfile?: DshCommunityPluginServiceOptions['policyForProfile'];
  private readonly runInstallCommand: (command: DshCommunityPluginInstallCommand) => Promise<DshCommunityPluginInstallCommandResult>;
  private readonly allowInstallScripts: boolean;
  private readonly profileContexts = new Map<string, ProfileContext>();
  private readonly profileStates = new Map<string, DshPluginProfileState>();
  private readonly activeOperations = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: DshCommunityPluginServiceOptions) {
    if (!options || typeof options.runtimeRoot !== 'string' || options.runtimeRoot.trim().length === 0) throw new Error('Managed runtime root is required');
    this.runtimeRoot = resolve(options.runtimeRoot);
    this.runtimeEntry = resolve(options.runtimeEntry ?? join(this.runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
    this.nodeExecutable = resolve(options.nodeExecutable ?? process.execPath);
    const runtimeEntryRel = relative(this.runtimeRoot, this.runtimeEntry);
    if (!runtimeEntryRel || runtimeEntryRel.startsWith('..') || isAbsolute(runtimeEntryRel)) {
      throw new Error('Managed DSH runtime entry must stay below runtime root');
    }
    if (/[\\/]?(?:\.cmd|\.bat|\.ps1)$/i.test(this.nodeExecutable)) {
      throw new Error('Managed DSH plugin installer must use a native Node executable');
    }
    this.defaultAgentId = options.defaultAgentId ?? 'default';
    if (!IDENTIFIER.test(this.defaultAgentId)) throw new Error('Default DSH agent id is invalid');
    this.resolveProfile = options.resolveProfile;
    this.legacyProfile = options.profile;
    this.legacyProfileDirectory = options.profileDirectory ? resolve(options.profileDirectory) : undefined;
    this.legacyProfileHome = options.profileHome ? resolve(options.profileHome) : undefined;
    this.legacyProfileId = options.profileId ?? 'web';
    if (!IDENTIFIER.test(this.legacyProfileId)) throw new Error('DSH profile id is invalid');
    this.now = options.now ?? Date.now;
    this.allowInstallScripts = options.allowInstallScripts === true;
    this.dshCatalog = options.dshCatalog;
    this.builtInCapabilities = Object.freeze((options.builtInCapabilities ?? []).map(normalizeBuiltInCapability));
    this.resolveActivation = options.resolveActivation;
    this.audit = options.audit;
    this.policyForProfile = options.policyForProfile;
    this.runInstallCommand = options.runInstall ?? ((command) => this.runDshPluginCommand(command));
    const source = options.allowlist ?? DEFAULT_DSH_COMMUNITY_PLUGIN_ALLOWLIST;
    if (source.length > MAX_ENTRIES) throw new Error('Plugin allowlist is too large');
    this.entries = new Map();
    const packages = new Set<string>();
    const questParts = new Set<number>();
    for (const raw of source) {
      const entry = normalizeEntry(raw);
      if (entry.allowScripts && !this.allowInstallScripts) {
        throw new Error(`Plugin ${entry.id} requires explicit install-script approval`);
      }
      if (entry.defaultEnabled) throw new Error('Community plugins cannot be enabled by catalog presence');
      if (entry.questPart !== undefined && questParts.has(entry.questPart)) {
        throw new Error('Plugin allowlist contains duplicate Quest parts');
      }
      if (this.entries.has(entry.id) || packages.has(entry.source.packageName)) throw new Error('Plugin allowlist contains duplicates');
      this.entries.set(entry.id, entry);
      packages.add(entry.source.packageName);
      if (entry.questPart !== undefined) questParts.add(entry.questPart);
    }
    const pack = options.questDefaultPack === undefined
      ? (options.allowlist === undefined ? QUEST_DEFAULT_DSH_PLUGIN_PACK : null)
      : options.questDefaultPack;
    this.questDefaultPack = pack ? this.normalizePack(pack) : null;
  }

  /** Refresh one agent/profile state without exposing runtime details. */
  async refreshProfile(agentId = this.defaultAgentId): Promise<DshPluginProfileState> {
    const context = await this.resolveProfileContext(agentId);
    return context?.state ?? 'unknown';
  }

  /** Renderer-safe catalog for one agent. No profile paths or commands escape. */
  getCatalog(agentId = this.defaultAgentId): DshCommunityPluginCatalogView {
    const context = this.profileContexts.get(agentId) ?? this.resolveProfileContextSync(agentId);
    const warnings: string[] = [...UNRESOLVED_DSH_ARTICLE_PLUGIN_WARNINGS];
    const entries = [...this.entries.values()].map((entry) => this.toView(entry, warnings, context));
    const activeOperationId = this.activeOperations.get(agentId) ?? null;
    return {
      scannedAt: this.now(),
      profile: context?.state ?? this.profileStates.get(agentId) ?? 'unknown',
      busy: activeOperationId !== null,
      activeOperationId,
      builtInCapabilities: this.getBuiltInCapabilities(),
      entries,
      questDefaultPack: this.questDefaultPack ? this.toPackView(entries) : null,
      warnings: warnings.slice(0, MAX_WARNINGS)
    };
  }

  async getCatalogAsync(agentId = this.defaultAgentId): Promise<DshCommunityPluginCatalogView> {
    await this.resolveProfileContext(agentId);
    return this.getCatalog(agentId);
  }

  /** Issue a one-time confirmation for an exact curated package/profile pair. */
  issueConfirmation(input: { agentId?: string; pluginId: string }): DshPluginInstallConfirmationView {
    const agentId = this.normalizeAgentId(input?.agentId);
    const entry = this.requireEntry(input?.pluginId);
    const context = this.resolveProfileContextSync(agentId);
    return this.issueConfirmationForContext(agentId, entry, context, 'install');
  }

  /** Async counterpart for hosts whose profile resolver performs I/O. */
  async issueConfirmationAsync(input: { agentId?: string; pluginId: string }): Promise<DshPluginInstallConfirmationView> {
    const agentId = this.normalizeAgentId(input?.agentId);
    const entry = this.requireEntry(input?.pluginId);
    const context = await this.resolveProfileContext(agentId);
    return this.issueConfirmationForContext(agentId, entry, context, 'install');
  }

  /** Issue a capability bound to one exact lifecycle action. */
  async issueLifecycleConfirmation(input: {
    agentId?: string;
    pluginId: string;
    action: DshPluginLifecycleAction;
  }): Promise<DshPluginLifecycleConfirmationView> {
    const agentId = this.normalizeAgentId(input?.agentId);
    const entry = this.requireEntry(input?.pluginId);
    const action = lifecycleAction(input?.action);
    const context = await this.resolveProfileContext(agentId);
    return this.issueConfirmationForContext(agentId, entry, context, action) as DshPluginLifecycleConfirmationView;
  }

  private issueConfirmationForContext(
    agentId: string,
    entry: DshCommunityPluginAllowlistEntry,
    context: ProfileContext | null,
    action: DshPluginLifecycleAction
  ): DshPluginInstallConfirmationView | DshPluginLifecycleConfirmationView {
    const warnings: string[] = [];
    const view = this.toView(entry, warnings, context);
    if (this.activeOperations.has(agentId)) throw new Error('DSH plugin profile is busy');
    if (!actionAllowed(action, view)) throw new Error(`Plugin action ${action} is unavailable: ${entry.id}`);
    const token = `dshinstall_${randomUUID().replaceAll('-', '')}`;
    const expiresAt = this.now() + CONFIRMATION_TTL_MS;
    this.confirmations.set(token, {
      agentId,
      profileId: context?.profileId ?? 'web',
      pluginId: entry.id,
      action,
      token,
      expiresAt
    });
    this.emitAudit({ operationId: token, agentId, profileId: context?.profileId, pluginId: entry.id, action: 'confirmation', result: 'ok', source: entry.source.kind });
    return {
      pluginId: entry.id,
      token,
      expiresAt,
      summary: `${action}: ${entry.name} ${entry.version} (${entry.source.kind === 'package' ? entry.source.packageName : `${entry.source.owner}/${entry.source.repository}@${entry.source.ref.slice(0, 12)}`})`,
      ...(action === 'install' ? {} : { action })
    };
  }

  /** Backwards-compatible alias for the default agent. */
  prepareInstall(pluginId: string): DshPluginInstallConfirmationView {
    return this.issueConfirmation({ agentId: this.defaultAgentId, pluginId });
  }

  install(request: DshPluginInstallRequest): Promise<DshPluginInstallResultView> {
    const confirmation = this.consumeConfirmation(request, 'install');
    const entry = this.requireEntry(confirmation.pluginId);
    const operationId = `dshop_${randomUUID().replaceAll('-', '')}`;
    this.reserveProfileOperation(confirmation.agentId, operationId);
    const operation = () => this.executeLifecycle(operationId, confirmation, entry);
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  applyLifecycle(request: DshPluginLifecycleRequest): Promise<DshPluginLifecycleResultView> {
    const action = lifecycleAction(request?.action);
    const confirmation = this.consumeConfirmation(request, action);
    const entry = this.requireEntry(confirmation.pluginId);
    const operationId = `dshop_${randomUUID().replaceAll('-', '')}`;
    this.reserveProfileOperation(confirmation.agentId, operationId);
    const operation = async (): Promise<DshPluginLifecycleResultView> => ({
      ...(await this.executeLifecycle(operationId, confirmation, entry)),
      action
    });
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private toView(
    entry: DshCommunityPluginAllowlistEntry,
    warnings: string[],
    context: ProfileContext | null,
    currentOperationId?: string
  ): DshCommunityPluginView {
    const installed = context ? this.inspectInstalled(context.profileDirectory, entry.source.packageName) : emptyInstalled();
    let status: DshCommunityPluginStatus = 'available';
    const reasonCodes: string[] = [];
    const operationInProgress = context
      ? this.activeOperations.get(context.agentId)
      : undefined;
    const profileBusy = operationInProgress !== undefined && operationInProgress !== currentOperationId;
    if (!regularDirectory(this.runtimeRoot)) {
      status = 'missing';
      reasonCodes.push('RUNTIME_ROOT_MISSING');
    } else if (!context) {
      status = 'missing';
      reasonCodes.push('PROFILE_MISSING');
    } else if (!regularDirectory(context.profileDirectory)) {
      // A fresh managed profile is intentionally empty until the first DSH
      // plugin command initializes package.json and pnpm metadata.
      reasonCodes.push('PROFILE_NOT_INITIALIZED');
    } else if (installed.installed && installed.version === entry.version && installed.bundleValid) {
      status = profileBusy ? 'installing' : 'installed';
    } else if (installed.installed && installed.version !== entry.version && installed.bundleValid) {
      status = profileBusy ? 'installing' : 'update-available';
      reasonCodes.push('VERSION_UPDATE_AVAILABLE');
    } else if (installed.installed) {
      status = 'broken';
      reasonCodes.push(installed.version === entry.version ? 'BUNDLE_PATCH_INVALID' : 'VERSION_MISMATCH');
    }
    const overrideWithPolicyBlock = () => {
      // Installation policy and observed package state are different facts.
      // Keep an existing package visible (and removable) even when Main would
      // refuse to install it into a fresh managed profile.
      if (!installed.installed) status = 'blocked';
      else reasonCodes.push('INSTALLED_OUTSIDE_APPROVED_BOUNDARY');
    };
    if (entry.runtimeBoundary === 'main-adapter-required') {
      overrideWithPolicyBlock();
      reasonCodes.push('MAIN_ADAPTER_REQUIRED');
    } else if (entry.runtimeBoundary === 'explicit-profile-permission') {
      overrideWithPolicyBlock();
      reasonCodes.push('EXPLICIT_PERMISSION_REQUIRED');
    } else if (entry.runtimeBoundary === 'standalone-only') {
      overrideWithPolicyBlock();
      reasonCodes.push('STANDALONE_ONLY');
    } else if (entry.runtimeBoundary === 'blocked') {
      overrideWithPolicyBlock();
      reasonCodes.push('BLOCKED_BY_REVIEW');
    } else if (this.isBlockedByManagedCatalog(entry.source.packageName)) {
      overrideWithPolicyBlock();
      reasonCodes.push('BLOCKED_BY_MANAGED_POLICY');
    }
    if (entry.compatibility === 'incompatible') {
      overrideWithPolicyBlock();
      reasonCodes.push('DSH_RC6_INCOMPATIBLE');
    } else if (entry.compatibility === 'identity-conflict') {
      overrideWithPolicyBlock();
      reasonCodes.push('PACKAGE_IDENTITY_CONFLICT');
    }
    if (entry.source.kind === 'github' && !GIT_COMMIT.test(entry.source.ref)) {
      overrideWithPolicyBlock();
      reasonCodes.push('GITHUB_REF_NOT_PINNED');
    }
    if (entry.allowScripts) {
      warnings.push(`${entry.id}:INSTALL_SCRIPTS_REQUIRE_REVIEW`);
      reasonCodes.push('INSTALL_SCRIPTS_ENABLED');
    }
    reasonCodes.push(...(entry.reasonCodes ?? []));
    const installable = entry.runtimeBoundary === 'reviewed-profile'
      && (status === 'available' || status === 'update-available' || status === 'broken');
    const activation = this.activationFor(entry, installed, context);
    return {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      version: entry.version,
      source: sourceView(entry.source),
      publisher: entry.publisher ?? null,
      repositoryUrl: entry.repositoryUrl ?? null,
      articleUrl: entry.articleUrl ?? null,
      capabilities: [...entry.capabilities],
      risk: entry.risk,
      runtimeBoundary: entry.runtimeBoundary ?? 'reviewed-profile',
      compatibility: entry.compatibility ?? 'unverified',
      questPart: entry.questPart ?? null,
      defaultEnabled: entry.defaultEnabled === true,
      installable,
      allowScripts: entry.allowScripts === true,
      status,
      installedVersion: installed.version,
      activation,
      // `restart-required` is returned only as the result of an install; the
      // next catalog scan derives the installed state from the profile
      // manifest and therefore cannot observe that transient result here.
      requiresRestart: status === 'installing',
      reasonCodes: [...new Set(reasonCodes)]
    };
  }

  private activationFor(
    entry: DshCommunityPluginAllowlistEntry,
    installed: InstalledPackage,
    context: ProfileContext | null
  ): DshCommunityPluginView['activation'] {
    if (!context || !installed.installed || !installed.version) {
      return { attached: false, health: 'not-probed', live: false };
    }
    let evidence: { attached: boolean; health: DshCommunityPluginHealth } | null = null;
    try {
      const candidate = this.resolveActivation?.({
        agentId: context.agentId,
        profileId: context.profileId,
        pluginId: entry.id,
        packageName: entry.source.packageName,
        installedVersion: installed.version
      }) ?? null;
      if (candidate && typeof candidate.attached === 'boolean'
        && (candidate.health === 'not-probed' || candidate.health === 'healthy' || candidate.health === 'unhealthy')) {
        evidence = candidate;
      }
    } catch {
      evidence = null;
    }
    const attached = evidence?.attached === true;
    const health = evidence?.health ?? 'not-probed';
    const approved = entry.runtimeBoundary === 'reviewed-profile'
      && entry.compatibility !== 'incompatible'
      && entry.compatibility !== 'identity-conflict'
      && !this.isBlockedByManagedCatalog(entry.source.packageName);
    const live = approved
      && installed.version === entry.version
      && installed.bundleValid
      && attached
      && health === 'healthy';
    return { attached, health, live };
  }

  private getBuiltInCapabilities(): DshBuiltInCapabilityView[] {
    return this.builtInCapabilities.map((capability) => ({
      ...capability,
      capabilities: [...capability.capabilities]
    }));
  }

  private normalizePack(input: DshCommunityPluginPackDefinition): DshCommunityPluginPackDefinition {
    const id = boundedString(input?.id, 'Plugin pack id', 128);
    if (!IDENTIFIER.test(id)) throw new Error('Plugin pack id is invalid');
    const name = boundedString(input?.name, 'Plugin pack name', 160);
    const description = boundedString(input?.description, 'Plugin pack description', 2_000);
    if (input.risk !== 'safe' && input.risk !== 'write' && input.risk !== 'native') {
      throw new Error('Quest default plugin pack risk is invalid');
    }
    if (!Array.isArray(input.members) || input.members.length === 0 || input.members.length > 16) {
      throw new Error('Quest default plugin pack members are invalid');
    }
    const seen = new Set<string>();
    const members = input.members.map((member) => {
      const pluginId = boundedString(member?.pluginId, 'Plugin pack member id', 128);
      const packageName = boundedString(member?.packageName, 'Plugin pack package name', 192);
      const version = boundedString(member?.version, 'Plugin pack package version', 64);
      const entry = this.entries.get(pluginId);
      if (!entry || seen.has(pluginId)
        || entry.source.packageName !== packageName
        || entry.version !== version) {
        throw new Error(`Quest default plugin pack member is not an exact curated source: ${pluginId}`);
      }
      seen.add(pluginId);
      return { pluginId, packageName, version };
    });
    return { id, name, description, risk: input.risk, members };
  }

  private toPackView(entries: DshCommunityPluginView[]): DshCommunityPluginPackView {
    const pack = this.questDefaultPack!;
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const members = pack.members.map((member) => byId.get(member.pluginId)).filter((entry): entry is DshCommunityPluginView => Boolean(entry));
    const statuses = members.map((member) => member.status);
    let status: DshCommunityPluginPackView['status'] = 'available';
    if (members.length !== pack.members.length || statuses.includes('missing')) status = 'missing';
    else if (statuses.includes('blocked')) status = 'blocked';
    else if (statuses.includes('installing')) status = 'installing';
    else if (statuses.includes('broken') || statuses.includes('update-available')) status = 'broken';
    else if (statuses.every((value) => value === 'installed' || value === 'restart-required')) status = 'installed';
    else if (statuses.some((value) => value === 'installed' || value === 'restart-required')) status = 'partial';
    const installedCount = members.filter((member) => member.status === 'installed' || member.status === 'restart-required').length;
    const liveCount = members.filter((member) => member.activation.live).length;
    const installable = members.length === pack.members.length && members.every((member) => member.installable);
    return {
      id: pack.id,
      name: pack.name,
      description: pack.description,
      risk: pack.risk,
      status,
      installable,
      requiresConfirmation: installable && status !== 'installed',
      installedCount,
      liveCount,
      totalCount: pack.members.length,
      members
    };
  }

  private normalizeAgentId(agentId: unknown): string {
    const value = agentId === undefined ? this.defaultAgentId : boundedString(agentId, 'Agent id', 128);
    if (!IDENTIFIER.test(value)) throw new Error('Agent id is invalid');
    return value;
  }

  private resolveProfileController(agentId: string): DshCommunityPluginProfileController | null {
    if (this.resolveProfile) {
      // The synchronous catalog path intentionally does not await a Promise;
      // Main-provided resolvers should return a local profile snapshot here.
      const resolved = this.resolveProfile(agentId);
      if (resolved && typeof (resolved as Promise<unknown>).then !== 'function') return resolved as DshCommunityPluginProfileController;
      if (resolved && typeof (resolved as Promise<unknown>).catch === 'function') {
        void (resolved as Promise<unknown>).catch(() => undefined);
      }
      return null;
    }
    if (agentId !== this.defaultAgentId) return null;
    if (this.legacyProfile) return {
      ...this.legacyProfile,
      profileId: this.legacyProfile.profileId ?? this.legacyProfileId,
      home: this.legacyProfile.home ?? this.legacyProfileHome,
      profileDirectory: this.legacyProfile.profileDirectory ?? this.legacyProfileDirectory,
      workspaceRoot: this.legacyProfile.workspaceRoot
    };
    if (this.legacyProfileDirectory) return {
      profileId: this.legacyProfileId,
      home: this.legacyProfileHome ?? resolve(this.legacyProfileDirectory, '..', '..'),
      profileDirectory: this.legacyProfileDirectory,
      workspaceRoot: this.legacyProfileDirectory
    };
    return null;
  }

  private resolveProfileContextSync(agentIdInput?: string): ProfileContext | null {
    const agentId = this.normalizeAgentId(agentIdInput);
    const cached = this.profileContexts.get(agentId);
    if (cached) return cached;
    let raw: DshCommunityPluginProfileController | null;
    try { raw = this.resolveProfileController(agentId); } catch { raw = null; }
    if (!raw) {
      this.profileStates.set(agentId, 'unavailable');
      return null;
    }
    const profileId = raw.profileId ?? 'web';
    const home = raw.home;
    const profileDirectory = raw.profileDirectory;
    if (typeof home !== 'string' || typeof profileDirectory !== 'string') {
      this.profileStates.set(agentId, 'unavailable');
      return null;
    }
    try { validateProfilePaths(home, profileDirectory, profileId); } catch {
      this.profileStates.set(agentId, 'unavailable');
      return null;
    }
    const state = this.readProfileState(raw);
    const normalizedHome = resolve(home);
    const normalizedProfile = resolve(profileDirectory);
    let workspaceRoot: string;
    try { workspaceRoot = normalizeWorkspaceRoot(raw.workspaceRoot, normalizedProfile); } catch {
      this.profileStates.set(agentId, 'unavailable');
      return null;
    }
    const context: ProfileContext = {
      agentId, profileId, home: normalizedHome, profileDirectory: normalizedProfile,
      workspaceRoot, controller: raw, state
    };
    this.profileContexts.set(agentId, context);
    this.profileStates.set(agentId, state);
    return context;
  }

  private async resolveProfileContext(agentIdInput?: string): Promise<ProfileContext | null> {
    const agentId = this.normalizeAgentId(agentIdInput);
    const cached = this.profileContexts.get(agentId);
    if (cached) {
      cached.state = await this.readProfileStateAsync(cached.controller);
      this.profileStates.set(agentId, cached.state);
      return cached;
    }
    let raw: DshCommunityPluginProfileController | null = null;
    try {
      if (this.resolveProfile) raw = await this.resolveProfile(agentId);
      else raw = this.resolveProfileController(agentId);
    } catch { raw = null; }
    if (!raw || typeof raw.home !== 'string' || typeof raw.profileDirectory !== 'string') {
      this.profileStates.set(agentId, 'unavailable');
      return null;
    }
    const profileId = raw.profileId ?? 'web';
    try { validateProfilePaths(raw.home, raw.profileDirectory, profileId); } catch {
      this.profileStates.set(agentId, 'unavailable');
      return null;
    }
    const normalizedHome = resolve(raw.home);
    const normalizedProfile = resolve(raw.profileDirectory);
    let workspaceRoot: string;
    try { workspaceRoot = normalizeWorkspaceRoot(raw.workspaceRoot, normalizedProfile); } catch {
      this.profileStates.set(agentId, 'unavailable');
      return null;
    }
    const context: ProfileContext = {
      agentId,
      profileId,
      home: normalizedHome,
      profileDirectory: normalizedProfile,
      workspaceRoot,
      controller: raw,
      state: await this.readProfileStateAsync(raw)
    };
    this.profileContexts.set(agentId, context);
    this.profileStates.set(agentId, context.state);
    return context;
  }

  private readProfileState(controller: DshCommunityPluginProfileController): DshPluginProfileState {
    try {
      const value = controller.getState?.();
      return value && typeof (value as Promise<unknown>).then === 'function' ? 'unknown' : this.normalizeProfileState(value);
    } catch { return 'unknown'; }
  }

  private async readProfileStateAsync(controller: DshCommunityPluginProfileController): Promise<DshPluginProfileState> {
    try { return this.normalizeProfileState(await controller.getState?.()); } catch { return 'unknown'; }
  }

  private normalizeProfileState(value: unknown): DshPluginProfileState {
    return value === 'running' || value === 'stopped' || value === 'unavailable' ? value : 'unknown';
  }

  private inspectInstalled(profileDirectory: string, packageName: string): InstalledPackage {
    if (!regularDirectory(profileDirectory)) return emptyInstalled();
    let packageDirectory: string;
    let manifestPath: string;
    try {
      const linkedPackage = lexicalRuntimeChild(profileDirectory, join('node_modules', ...packageName.split('/')));
      const linkedStat = lstatSync(linkedPackage);
      if (!linkedStat.isDirectory() && !linkedStat.isSymbolicLink()) return emptyInstalled();
      const realProfile = realpathSync(profileDirectory);
      packageDirectory = realpathSync(linkedPackage);
      const nodeModulesRoot = resolve(realProfile, 'node_modules');
      const packageRelative = relative(nodeModulesRoot, packageDirectory);
      if (!packageRelative || packageRelative.startsWith('..') || isAbsolute(packageRelative)) return emptyInstalled();
      manifestPath = safeRuntimeChild(packageDirectory, 'package.json');
    } catch {
      return emptyInstalled();
    }
    if (!regularFile(manifestPath)) return emptyInstalled(manifestPath);
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name?: unknown;
        version?: unknown;
        dsh?: { bundle?: { patch?: unknown } };
      };
      const version = typeof parsed.version === 'string' && SEMVER.test(parsed.version) ? parsed.version : null;
      const manifestValid = parsed.name === packageName && version !== null;
      const patch = parsed.dsh?.bundle?.patch;
      const bundlePatch = typeof patch === 'string' && patch.length > 0 && patch.length <= 256 ? patch : null;
      const patchRelative = bundlePatch !== null && !isAbsolute(bundlePatch)
        && !bundlePatch.split(/[\\/]+/).some((segment) => segment === '..' || segment === '')
        && bundlePatch.replaceAll('\\', '/') === bundlePatch;
      let bundleValid = false;
      if (patchRelative) {
        try {
          const patchPath = safeRuntimeChild(packageDirectory, bundlePatch!);
          bundleValid = regularFile(patchPath);
        } catch { bundleValid = false; }
      }
      return {
        installed: manifestValid,
        version: manifestValid ? version : null,
        path: manifestPath,
        manifestValid,
        bundlePatch,
        bundleValid
      };
    } catch {
      return emptyInstalled(manifestPath);
    }
  }

  private isBlockedByManagedCatalog(packageName: string): boolean {
    if (!this.dshCatalog) return false;
    try {
      const item = this.dshCatalog.getCatalog().packages.find((candidate) => candidate.name === packageName);
      return item?.safety === 'blocked' && item.reasonCodes.some((code) => code === 'FORBIDDEN_BY_MANAGED_PROFILE');
    } catch {
      return false;
    }
  }

  private consumeConfirmation(
    request: DshPluginInstallRequest | DshPluginLifecycleRequest,
    expectedAction: DshPluginLifecycleAction
  ): ConfirmationRecord {
    if (!request || typeof request !== 'object') throw new Error('Install confirmation is required');
    const agentId = this.normalizeAgentId(request.agentId);
    const token = boundedString(request.confirmationToken, 'Install confirmation token', 160);
    const record = this.confirmations.get(token);
    this.confirmations.delete(token);
    if (!record
      || record.agentId !== agentId
      || record.pluginId !== request.pluginId
      || record.action !== expectedAction
      || record.expiresAt <= this.now()) {
      if (record) this.emitAudit({ operationId: token, agentId: record.agentId, profileId: record.profileId, pluginId: record.pluginId, action: 'confirmation', result: 'expired', source: this.entries.get(record.pluginId)?.source.kind ?? 'package' });
      throw new Error('Install confirmation is invalid or expired');
    }
    return record;
  }

  private requireEntry(pluginId: string): DshCommunityPluginAllowlistEntry {
    const id = boundedString(pluginId, 'Plugin id', 128);
    if (!IDENTIFIER.test(id)) throw new Error('Plugin id is invalid');
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Plugin is not in the curated allowlist: ${id}`);
    return entry;
  }

  private reserveProfileOperation(agentId: string, operationId: string): void {
    if (this.activeOperations.has(agentId)) throw new Error('DSH plugin profile is busy');
    this.activeOperations.set(agentId, operationId);
  }

  private async executeLifecycle(operationId: string, confirmation: ConfirmationRecord, entry: DshCommunityPluginAllowlistEntry): Promise<DshPluginInstallResultView> {
    let context: ProfileContext | null = null;
    let profileStopped = false;
    let profileResumed = false;
    let packageExistedBefore = false;
    let mutationStarted = false;
    let backup: BackupRecord | null = null;
    const source = entry.source.kind;
    const action = confirmation.action;
    try {
      context = await this.resolveProfileContext(confirmation.agentId);
      if (!regularDirectory(this.runtimeRoot)) throw new Error('Managed runtime is unavailable');
      if (!context) throw new Error('Managed DSH profile is unavailable');
      const current = this.toView(entry, [], context, operationId);
      if (!actionAllowed(action, current)) throw new Error(`Plugin action ${action} is no longer available: ${entry.id}`);
      if (action === 'install' && current.status === 'installed') {
        this.emitAudit({
          operationId,
          agentId: confirmation.agentId,
          profileId: context.profileId,
          pluginId: entry.id,
          action: 'install.complete',
          result: 'skipped',
          source
        });
        return {
          ok: true,
          operationId,
          status: 'installed',
          message: 'Plugin already matches the curated version; no changes were made',
          plugin: current,
          profileStopped: false,
          profileResumed: false,
          requiresRestart: false
        };
      }
      await this.authorizeLifecycle(operationId, context, entry, action);
      this.emitAudit({ operationId, agentId: confirmation.agentId, profileId: context.profileId, pluginId: entry.id, action: `${action}.start`, result: 'ok', source });
      mutationStarted = true;
      if (action === 'install') ensureProfileDirectory(context.home, context.profileDirectory, context.profileId);
      const packageDirectory = lexicalRuntimeChild(context.profileDirectory, join('node_modules', ...entry.source.packageName.split('/')));
      try {
        const packageStat = lstatSync(packageDirectory);
        packageExistedBefore = packageStat.isDirectory() || packageStat.isSymbolicLink() || packageStat.isFile();
      } catch { packageExistedBefore = false; }
      const controller = context.controller;
      const state = await this.readProfileStateAsync(controller);
      context.state = state;
      this.profileStates.set(confirmation.agentId, state);
      const running = state === 'running';
      if (running) {
        const stop = controller.stop;
        const start = controller.start;
        if (typeof stop !== 'function') throw new Error('Running profile requires a stop controller');
        if (typeof start !== 'function') throw new Error('Running profile requires a start controller');
        await stop();
        profileStopped = true;
        context.state = 'stopped';
        this.profileStates.set(confirmation.agentId, 'stopped');
        this.emitAudit({ operationId, agentId: confirmation.agentId, profileId: context.profileId, pluginId: entry.id, action: `${action}.stop-profile`, result: 'ok', source });
      }
      backup = this.createBackup(context.profileDirectory, operationId);
      const commandResult = await this.runInstallCommand({
        args: action === 'uninstall'
          ? [
              this.runtimeEntry,
              'plugin', '--profile', context.profileId,
              'remove', '--workspace-root',
              ...(entry.allowScripts ? [] : ['--ignore-scripts']),
              entry.source.packageName
            ]
          : [
              this.runtimeEntry,
              'plugin', '--profile', context.profileId,
              'add', '--workspace-root', '--save-exact',
              ...(entry.allowScripts ? [] : ['--ignore-scripts']),
              installSpec(entry.source)
            ],
        executable: this.nodeExecutable,
        cwd: context.profileDirectory,
        env: childProcessEnv({ NODE_ENV: 'production', DSH_HOME: context.home }),
        timeoutMs: INSTALL_TIMEOUT_MS
      });
      if (!commandResult.ok) {
        throw new Error(`DSH plugin ${action} failed${commandResult.code === null ? '' : ` (exit ${commandResult.code})`}${outputSnippet(commandResult) ? `: ${outputSnippet(commandResult)}` : ''}`);
      }
      const installed = this.inspectInstalled(context.profileDirectory, entry.source.packageName);
      if (action === 'uninstall') {
        if (installed.installed || this.profileReferencesPackage(context.profileDirectory, entry.source.packageName)) {
          throw new Error('DSH plugin uninstall did not remove the package dependency and bundle layer');
        }
      } else if (!installed.installed || installed.version !== entry.version || !installed.bundleValid) {
        throw new Error('Installed package manifest did not match the curated version or dsh.bundle patch contract');
      }
      this.removeBackup(backup);
      backup = null;
      if (profileStopped) {
        const start = controller.start;
        if (typeof start !== 'function') throw new Error('Stopped DSH profile has no start controller');
        await start();
        profileResumed = true;
        context.state = 'running';
        this.profileStates.set(confirmation.agentId, 'running');
        this.emitAudit({ operationId, agentId: confirmation.agentId, profileId: context.profileId, pluginId: entry.id, action: `${action}.resume-profile`, result: 'ok', source });
      }
      this.emitAudit({ operationId, agentId: confirmation.agentId, profileId: context.profileId, pluginId: entry.id, action: `${action}.complete`, result: 'ok', source });
      const plugin = this.toView(entry, [], context);
      return {
        ok: true,
        operationId,
        status: action === 'uninstall' ? 'available' : 'restart-required',
        message: action === 'uninstall'
          ? 'Plugin uninstalled; managed DSH profile restart is required to unload it'
          : `Plugin ${action === 'install' ? 'installed' : 'updated'}; managed DSH profile restart is required before activation`,
        plugin,
        profileStopped,
        profileResumed,
        requiresRestart: true
      };
    } catch (error) {
      if (backup) this.restoreBackup(backup);
      if (mutationStarted && context && !packageExistedBefore) {
        this.removePackageDirectory(context.profileDirectory, entry.source.packageName);
      }
      let resumeError: string | null = null;
      const activeContext = context;
      const resume = activeContext?.controller.start;
      if (profileStopped && activeContext && typeof resume === 'function' && !profileResumed) {
        try {
          await resume.call(activeContext.controller);
          profileResumed = true;
          activeContext.state = 'running';
          this.profileStates.set(confirmation.agentId, 'running');
          this.emitAudit({ operationId, agentId: confirmation.agentId, profileId: activeContext.profileId, pluginId: entry.id, action: `${action}.resume-profile`, result: 'ok', source });
        } catch (resumeFailure) {
          resumeError = resumeFailure instanceof Error ? resumeFailure.message : String(resumeFailure);
          this.emitAudit({ operationId, agentId: confirmation.agentId, profileId: context?.profileId, pluginId: entry.id, action: `${action}.resume-profile`, result: 'failed', source });
        }
      }
      const detail = error instanceof Error ? error.message : String(error);
      const message = resumeError ? `${detail}; profile resume failed: ${resumeError}` : detail;
      this.emitAudit({ operationId, agentId: confirmation.agentId, profileId: context?.profileId, pluginId: entry.id, action: `${action}.fail`, result: 'failed', source });
      const plugin = this.toView(entry, [], context);
      return { ok: false, operationId, status: 'broken', message: message.slice(0, 500), plugin, profileStopped, profileResumed, requiresRestart: false };
    } finally {
      if (backup) this.removeBackup(backup);
      this.activeOperations.delete(confirmation.agentId);
    }
  }

  private async authorizeLifecycle(
    operationId: string,
    context: ProfileContext,
    entry: DshCommunityPluginAllowlistEntry,
    action: DshPluginLifecycleAction
  ): Promise<void> {
    const policy = this.policyForProfile?.(context.agentId, context.profileId) ?? null;
    const actionLabel = action === 'install' ? 'installation' : action;
    if (!policy) throw new Error(`DSH policy denied plugin ${actionLabel}: policy_unavailable`);
    const target = `community-plugin:${entry.id}`;
    const capabilities = ['package.install', 'process.exec', 'fs.write'] as const;
    const decisions = await Promise.all(capabilities.map((capability) => policy.decide({
      requestId: `${operationId}-${capability}`,
      capability,
      target,
      operation: `community-plugin.${action}`,
      context: {
        boundary: 'community-plugin-install',
        principalConfirmed: true,
        curated: true,
        lifecycleAction: action,
        pluginId: entry.id,
        pluginRisk: entry.risk,
        source: entry.source.kind,
        profileId: context.profileId
      }
    })));
    const denied = decisions.find((decision) => decision.effect !== 'allow');
    if (denied) {
      throw new Error(`DSH policy denied plugin ${actionLabel}: ${denied.reasonCode}`);
    }
  }

  /** Verify that DSH removed both the package-manager dependency and bundle layer. */
  private profileReferencesPackage(profileDirectory: string, packageName: string): boolean {
    let manifestPath: string;
    try {
      manifestPath = safeRuntimeChild(profileDirectory, 'package.json');
    } catch {
      return true;
    }
    if (!regularFile(manifestPath)) return false;
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return true;
      const manifest = parsed as Record<string, unknown>;
      const dependencies = manifest.dependencies;
      if (dependencies !== undefined) {
        if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return true;
        if (Object.prototype.hasOwnProperty.call(dependencies, packageName)) return true;
      }
      const dsh = manifest.dsh;
      if (dsh === undefined) return false;
      if (!dsh || typeof dsh !== 'object' || Array.isArray(dsh)) return true;
      const profile = (dsh as Record<string, unknown>).profile;
      if (profile === undefined) return false;
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return true;
      const bundles = (profile as Record<string, unknown>).bundles;
      if (bundles === undefined) return false;
      if (!Array.isArray(bundles)) return true;
      return bundles.some((bundle) => bundle === packageName);
    } catch {
      return true;
    }
  }

  /** Remove only a newly-created package directory inside the mutable profile. */
  private removePackageDirectory(profileDirectory: string, packageName: string): void {
    try {
      const packageDirectory = lexicalRuntimeChild(profileDirectory, join('node_modules', ...packageName.split('/')));
      // Validate every ancestor but allow the final pnpm symlink/junction.
      safeRuntimeChild(profileDirectory, relative(profileDirectory, dirname(packageDirectory)));
      const stat = lstatSync(packageDirectory);
      rmSync(packageDirectory, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: true });
    } catch {
      // A failed cleanup is reported through the install audit/result; never
      // widen the deletion scope after a path validation failure.
    }
  }

  private createBackup(profileDirectory: string, operationId: string): BackupRecord {
    const backup = safeRuntimeChild(profileDirectory, `.aibox-plugin-backup-${operationId}`);
    mkdirSync(backup, { recursive: false });
    const files: string[] = [];
    // DSH profiles are pnpm workspaces. Keep the legacy npm lock filename in
    // the set so older profiles are also recoverable, but never touch the
    // immutable managed runtime's package files.
    for (const file of PROFILE_METADATA_FILES) {
      const source = safeRuntimeChild(profileDirectory, file);
      if (!regularFile(source)) continue;
      copyFileSync(source, join(backup, file));
      files.push(file);
    }
    return { root: backup, profileDirectory, files };
  }

  private restoreBackup(backup: BackupRecord): void {
    try {
      for (const file of PROFILE_METADATA_FILES) {
        const target = safeRuntimeChild(backup.profileDirectory, file);
        if (backup.files.includes(file)) {
          const source = join(backup.root, file);
          if (regularFile(source)) copyFileSync(source, target);
        } else {
          // The DSH CLI may initialize a fresh profile before failing. Remove
          // only the bounded metadata files it could have created; never
          // recursively delete profile/node_modules state.
          try {
            const stat = lstatSync(target);
            if (stat.isFile() && !stat.isSymbolicLink()) rmSync(target, { force: true });
          } catch { /* absent or unsafe path: leave it for manual repair */ }
        }
      }
    } catch {
      // The install result remains failed; the audit record is the durable
      // signal that manual profile repair may be necessary.
    } finally {
      this.removeBackup(backup);
    }
  }

  private removeBackup(backup: BackupRecord | null): void {
    if (!backup) return;
    try {
      const rel = relative(backup.profileDirectory, resolve(backup.root));
      if (!rel || rel.startsWith('..') || isAbsolute(rel) || !/^\.aibox-plugin-backup-[A-Za-z0-9_-]+$/.test(rel)) return;
      try {
        if (lstatSync(backup.root).isSymbolicLink()) return;
      } catch { return; }
      rmSync(backup.root, { recursive: true, force: true });
    } catch {
      // Best effort cleanup; never turn an otherwise successful install into
      // an IPC exception because a temporary backup could not be removed.
    }
  }

  private async runDshPluginCommand(command: DshCommunityPluginInstallCommand): Promise<DshCommunityPluginInstallCommandResult> {
    return runCli(command.executable ?? this.nodeExecutable, command.args, { cwd: command.cwd, env: command.env, timeoutMs: command.timeoutMs });
  }

  private emitAudit(event: DshCommunityPluginAuditEvent): void {
    try { void this.audit?.(event); } catch { /* audit must not break lifecycle cleanup */ }
  }
}
