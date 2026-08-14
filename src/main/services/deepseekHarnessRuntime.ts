/** Managed DeepSeek Harness sidecar paths, environment and OPC-Nexus Skill sync. */
import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Agent } from '../../shared/types.js';
import type { Database } from './database.js';
import { ProviderManager, type ResolvedProvider } from './providerManager.js';
import { getProviderSettings, readProviderKey } from './provider.js';

export const DEEPSEEK_HARNESS_ENGINE_ID = 'eng-deepseek-harness';
export const DEEPSEEK_HARNESS_VERSION = '0.1.0-rc.6';
const RUNTIME_DIR = 'deepseek-harness';
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 19;
const STALE_SNAPSHOT_AGE_MS = 24 * 60 * 60_000;
const SNAPSHOT_NAME = /^snapshot-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_NAME = /^session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const activeSkillSnapshots = new Set<string>();
const activeSessionRoots = new Set<string>();

export interface HarnessRuntimePaths {
  root: string;
  entry: string;
  config: string;
}

const HOST_ENV_ALLOWLIST = new Set([
  'ALL_PROXY',
  'APPDATA',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'COMSPEC',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_ARCHITEW6432',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TZ',
  'USERPROFILE',
  'WINDIR'
]);

function runtimeRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'runtime', RUNTIME_DIR)
    : resolve(app.getAppPath(), 'runtime', RUNTIME_DIR, 'dist');
}

export function deepseekHarnessRuntimePaths(): HarnessRuntimePaths {
  const root = runtimeRoot();
  return {
    root,
    entry: join(root, 'opc-acp-entry.mjs'),
    config: join(root, 'config', 'cordis.yml')
  };
}

export function harnessNodeSupported(version = process.versions.node): boolean {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR) || major >= 24;
}

/** Build a minimal host environment without forwarding unrelated API keys. */
export function deepseekHarnessProcessEnv(runtimeEnv: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && HOST_ENV_ALLOWLIST.has(key.toUpperCase())) env[key] = value;
  }
  return { ...env, ...runtimeEnv };
}

export function deepseekHarnessCommand(): string[] | null {
  const paths = deepseekHarnessRuntimePaths();
  if (!harnessNodeSupported() || !existsSync(process.execPath) || !existsSync(paths.entry) || !existsSync(paths.config)) return null;
  return [process.execPath, paths.entry, '--config', paths.config];
}

function safeSkillId(id: string, name: string): string {
  const source = `${id}-${name}`.toLowerCase();
  const ascii = source
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return ascii || `opc-skill-${Buffer.from(id).toString('hex').slice(0, 16)}`;
}

function yamlString(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/g, ' ').trim());
}

function pathPartsBelow(anchor: string, target: string): { anchor: string; target: string; parts: string[] } {
  const resolvedAnchor = resolve(anchor);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedAnchor, resolvedTarget);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../')) {
    throw new Error(`Harness managed path escapes userData: ${resolvedTarget}`);
  }
  return { anchor: resolvedAnchor, target: resolvedTarget, parts: rel.split(/[\\/]+/) };
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function assertRealDirectory(path: string, stat = lstatIfPresent(path)): void {
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Harness managed path must be a real directory: ${path}`);
  }
}

function assertManagedDescendant(anchor: string, target: string): void {
  const managed = pathPartsBelow(anchor, target);
  assertRealDirectory(managed.anchor);
  let cursor = managed.anchor;
  for (const segment of managed.parts) {
    cursor = join(cursor, segment);
    const stat = lstatIfPresent(cursor);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
      throw new Error(`Harness managed path must be a real directory: ${cursor}`);
    }
  }
}

/** Create each component only after validating the existing parent chain. */
function ensureManagedDirectory(anchor: string, target: string): void {
  const managed = pathPartsBelow(anchor, target);
  assertRealDirectory(managed.anchor);
  let cursor = managed.anchor;
  for (const segment of managed.parts) {
    cursor = join(cursor, segment);
    const existing = lstatIfPresent(cursor);
    if (existing) {
      assertRealDirectory(cursor, existing);
      continue;
    }
    mkdirSync(cursor);
    assertRealDirectory(cursor);
  }
  assertManagedDescendant(managed.anchor, managed.target);
}

function removeManagedDirectory(anchor: string, target: string): void {
  assertManagedDescendant(anchor, target);
  const stat = lstatIfPresent(target);
  if (!stat) return;
  assertRealDirectory(target, stat);
  rmSync(target, { recursive: true, force: true });
}

function cleanupStaleDirectories(
  anchor: string,
  root: string,
  namePattern: RegExp,
  active: ReadonlySet<string>
): void {
  const cutoff = Date.now() - STALE_SNAPSHOT_AGE_MS;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!namePattern.test(entry.name)) continue;
    const candidate = resolve(root, entry.name);
    if (active.has(candidate)) continue;
    const stat = lstatIfPresent(candidate);
    if (stat?.isDirectory() && !stat.isSymbolicLink() && stat.mtimeMs < cutoff) {
      removeManagedDirectory(anchor, candidate);
    }
  }
}

function assertGeneratedSkillRoot(snapshotRoot: string, expectedNames: string[]): void {
  const rootStat = lstatSync(snapshotRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Harness Skill snapshot root is invalid');
  const actualNames = readdirSync(snapshotRoot).sort();
  if (actualNames.join('\0') !== [...expectedNames].sort().join('\0')) {
    throw new Error('Harness Skill snapshot root contains unexpected entries');
  }
  for (const name of actualNames) {
    const dir = join(snapshotRoot, name);
    const file = join(dir, 'SKILL.md');
    const dirStat = lstatSync(dir);
    const fileStat = lstatSync(file);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory() || fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new Error(`Harness Skill bundle is invalid: ${name}`);
    }
  }
}

function managedSkillRows(db: Database, agentId: string): { id: string; name: string; description: string; content: string }[] {
  return db.raw.prepare(
    `SELECT s.id, s.name, s.description, s.content
     FROM skills s JOIN agent_skills a ON a.skill_id = s.id
     WHERE a.agent_id = ? AND s.enabled = 1
     ORDER BY s.id`
  ).all(agentId) as unknown as { id: string; name: string; description: string; content: string }[];
}

function publishSkillSnapshot(
  anchor: string,
  snapshotsRoot: string,
  rows: { id: string; name: string; description: string; content: string }[]
): string {
  ensureManagedDirectory(anchor, snapshotsRoot);
  cleanupStaleDirectories(anchor, snapshotsRoot, SNAPSHOT_NAME, activeSkillSnapshots);

  const snapshotRoot = join(snapshotsRoot, `snapshot-${randomUUID()}`);
  const expectedNames: string[] = [];
  mkdirSync(snapshotRoot);
  try {
    for (const row of rows) {
      const name = `opc-${safeSkillId(row.id, row.name)}`;
      if (expectedNames.includes(name)) throw new Error(`Duplicate managed Harness Skill id: ${name}`);
      expectedNames.push(name);
      const dir = join(snapshotRoot, name);
      mkdirSync(dir);
      const description = row.description.trim() || `OPC-Nexus skill: ${row.name}`;
      const body = row.content.trim() || `# ${row.name}\n`;
      writeFileSync(
        join(dir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${yamlString(description)}\n---\n\n${body}\n`,
        { encoding: 'utf8', flag: 'wx' }
      );
    }
    assertGeneratedSkillRoot(snapshotRoot, expectedNames);
    activeSkillSnapshots.add(resolve(snapshotRoot));
    return snapshotRoot;
  } catch (err) {
    removeManagedDirectory(anchor, snapshotRoot);
    throw err;
  }
}

function isOfficialDeepSeekEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.deepseek.com';
  } catch {
    return false;
  }
}

function baseRuntimeEnv(dshHome: string, sessionsRoot: string, skillsRoot: string): Record<string, string> {
  return {
    AIBOX_DSH_HOME: dshHome,
    AIBOX_DSH_MANAGED_SKILLS_DIR: skillsRoot,
    AIBOX_DSH_SESSIONS_ROOT: sessionsRoot,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    ELECTRON_RUN_AS_NODE: '1'
  };
}

function providerEnv(provider: ResolvedProvider | null, fallbackModel: string): Record<string, string> {
  const model = provider?.model || fallbackModel;
  if (!provider?.key.trim()) return { AIBOX_DSH_MODEL: model };

  if (isOfficialDeepSeekEndpoint(provider.baseUrl)) {
    return {
      AIBOX_DSH_PROVIDER: 'deepseek-official',
      AIBOX_DSH_MODEL: model,
      DEEPSEEK_API_KEY: provider.key,
      DEEPSEEK_BASE_URL: provider.baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '')
    };
  }

  return {
    AIBOX_DSH_PROVIDER: 'aibox-openai',
    AIBOX_DSH_MODEL: model,
    OPENAI_API_KEY: provider.key,
    OPENAI_BASE_URL: provider.baseUrl.replace(/\/+$/, ''),
    OPENAI_MODEL: model
  };
}

function resolveAgentProvider(db: Database, agent: Agent): ResolvedProvider | null {
  const row = db.raw.prepare('SELECT provider_id, model_override FROM agents WHERE id = ?').get(agent.id) as
    | { provider_id: string | null; model_override: string | null }
    | undefined;
  const modelOverride = agent.modelOverride ?? row?.model_override ?? null;
  const providerId = row?.provider_id ?? null;
  const resolved = new ProviderManager(db).resolveForAgent(providerId, modelOverride);
  if (resolved) return resolved;

  // An explicit binding must fail closed; never substitute another Provider.
  if (providerId) return null;
  const count = (db.raw.prepare('SELECT COUNT(*) c FROM providers').get() as { c?: number } | undefined)?.c ?? 0;
  if (count > 0) return null;

  const legacy = getProviderSettings(db);
  const key = readProviderKey(db)?.trim() || null;
  return legacy.baseUrl.trim() && legacy.model.trim() && key
    ? { baseUrl: legacy.baseUrl.trim().replace(/\/+$/, ''), model: modelOverride || legacy.model.trim(), key }
    : null;
}

export function deepseekHarnessProviderReady(db: Database, agent: Agent): boolean {
  return resolveAgentProvider(db, agent) !== null;
}

function assertSnapshotCleanupPath(userData: string, target: string): void {
  const harnessRoot = join(userData, 'aibox-data', 'deepseek-harness');
  const { parts } = pathPartsBelow(harnessRoot, target);
  const agentSnapshot = parts.length === 4
    && parts[0] === 'agents'
    && AGENT_ID.test(parts[1] ?? '')
    && parts[2] === 'skill-snapshots'
    && SNAPSHOT_NAME.test(parts[3] ?? '');
  const probeSnapshot = parts.length === 3
    && parts[0] === 'probe'
    && parts[1] === 'skill-snapshots'
    && SNAPSHOT_NAME.test(parts[2] ?? '');
  if (!agentSnapshot && !probeSnapshot) {
    throw new Error(`Invalid Harness Skill snapshot cleanup path: ${resolve(target)}`);
  }
}

function assertSessionCleanupPath(userData: string, target: string): void {
  const harnessRoot = join(userData, 'aibox-data', 'deepseek-harness');
  const { parts } = pathPartsBelow(harnessRoot, target);
  const agentSession = parts.length === 3
    && parts[0] === 'sessions'
    && AGENT_ID.test(parts[1] ?? '')
    && SESSION_NAME.test(parts[2] ?? '');
  const probeSession = parts.length === 2
    && parts[0] === 'probe-sessions'
    && SESSION_NAME.test(parts[1] ?? '');
  if (!agentSession && !probeSession) {
    throw new Error(`Invalid Harness Session cleanup path: ${resolve(target)}`);
  }
}

function buildHarnessEnv(db: Database, agent: Agent, provider: ResolvedProvider | null): Record<string, string> {
  if (!AGENT_ID.test(agent.id)) throw new Error('Invalid Agent id for Harness runtime');
  const userData = app.getPath('userData');
  const root = join(userData, 'aibox-data', 'deepseek-harness');
  const dshHome = join(root, 'agents', agent.id);
  const sessionsRoot = join(root, 'sessions', agent.id, `session-${randomUUID()}`);
  let skillsRoot: string | null = null;
  try {
    ensureManagedDirectory(userData, dshHome);
    const sessionsParent = join(root, 'sessions', agent.id);
    ensureManagedDirectory(userData, sessionsParent);
    cleanupStaleDirectories(userData, sessionsParent, SESSION_NAME, activeSessionRoots);
    ensureManagedDirectory(userData, sessionsRoot);
    activeSessionRoots.add(resolve(sessionsRoot));
    skillsRoot = publishSkillSnapshot(userData, join(dshHome, 'skill-snapshots'), managedSkillRows(db, agent.id));
    return {
      ...baseRuntimeEnv(dshHome, sessionsRoot, skillsRoot),
      ...providerEnv(provider, agent.modelOverride || 'deepseek-chat')
    };
  } catch (err) {
    if (skillsRoot) {
      activeSkillSnapshots.delete(resolve(skillsRoot));
      removeManagedDirectory(userData, skillsRoot);
    }
    activeSessionRoots.delete(resolve(sessionsRoot));
    if (lstatIfPresent(sessionsRoot)) removeManagedDirectory(userData, sessionsRoot);
    throw err;
  }
}

/** Secrets remain process-local and are never persisted in Harness files. */
export function deepseekHarnessEnv(db: Database, agent: Agent): Record<string, string> {
  return buildHarnessEnv(db, agent, resolveAgentProvider(db, agent));
}

/** Test/support entry that publishes a snapshot without resolving credentials. */
export function deepseekHarnessSnapshotEnv(db: Database, agent: Agent): Record<string, string> {
  return buildHarnessEnv(db, agent, null);
}

export function deepseekHarnessProbeEnv(db: Database): Record<string, string> {
  const provider = new ProviderManager(db).resolveForAgent(null, null);
  const count = (db.raw.prepare('SELECT COUNT(*) c FROM providers').get() as { c?: number } | undefined)?.c ?? 0;
  const legacy = provider || count > 0 ? null : getProviderSettings(db);
  const legacyKey = provider || count > 0 ? null : (readProviderKey(db)?.trim() || null);
  const effectiveProvider = provider ?? (legacy?.baseUrl.trim() && legacy.model.trim() && legacyKey
    ? { baseUrl: legacy.baseUrl.trim().replace(/\/+$/, ''), model: legacy.model.trim(), key: legacyKey }
    : null);

  const userData = app.getPath('userData');
  const root = join(userData, 'aibox-data', 'deepseek-harness');
  const dshHome = join(root, 'probe');
  const sessionsRoot = join(root, 'probe-sessions', `session-${randomUUID()}`);
  let skillsRoot: string | null = null;
  try {
    ensureManagedDirectory(userData, dshHome);
    const sessionsParent = join(root, 'probe-sessions');
    ensureManagedDirectory(userData, sessionsParent);
    cleanupStaleDirectories(userData, sessionsParent, SESSION_NAME, activeSessionRoots);
    ensureManagedDirectory(userData, sessionsRoot);
    activeSessionRoots.add(resolve(sessionsRoot));
    skillsRoot = publishSkillSnapshot(userData, join(dshHome, 'skill-snapshots'), []);
    return {
      ...baseRuntimeEnv(dshHome, sessionsRoot, skillsRoot),
      AIBOX_DSH_EPHEMERAL_SESSIONS: '1',
      ...providerEnv(effectiveProvider, 'deepseek-chat')
    };
  } catch (err) {
    if (skillsRoot) {
      activeSkillSnapshots.delete(resolve(skillsRoot));
      removeManagedDirectory(userData, skillsRoot);
    }
    activeSessionRoots.delete(resolve(sessionsRoot));
    if (lstatIfPresent(sessionsRoot)) removeManagedDirectory(userData, sessionsRoot);
    throw err;
  }
}

/** Release one process-owned Skill snapshot after its child has closed. */
export function cleanupHarnessEnv(env: Record<string, string>, removeSessions = false): void {
  const userData = app.getPath('userData');
  const skillsRoot = env.AIBOX_DSH_MANAGED_SKILLS_DIR;
  const resolvedSkillsRoot = skillsRoot ? resolve(skillsRoot) : null;
  const sessionsRoot = env.AIBOX_DSH_SESSIONS_ROOT;
  const removeSessionLease = !!sessionsRoot
    && (removeSessions || env.AIBOX_DSH_EPHEMERAL_SESSIONS === '1');
  const resolvedSessionsRoot = removeSessionLease && sessionsRoot ? resolve(sessionsRoot) : null;

  // Validate the complete cleanup request before deleting either lease. The
  // environment is child-process input, not proof that this process issued it.
  if (skillsRoot) {
    assertSnapshotCleanupPath(userData, skillsRoot);
    if (!resolvedSkillsRoot || !activeSkillSnapshots.has(resolvedSkillsRoot)) {
      throw new Error(`Harness Skill snapshot is not an active process lease: ${resolvedSkillsRoot}`);
    }
  }
  if (removeSessionLease && sessionsRoot) {
    assertSessionCleanupPath(userData, sessionsRoot);
    if (!resolvedSessionsRoot || !activeSessionRoots.has(resolvedSessionsRoot)) {
      throw new Error(`Harness Session root is not an active process lease: ${resolvedSessionsRoot}`);
    }
  }

  let firstError: unknown;
  if (skillsRoot && resolvedSkillsRoot) {
    try {
      removeManagedDirectory(userData, skillsRoot);
    } catch (err) {
      firstError = err;
    } finally {
      activeSkillSnapshots.delete(resolvedSkillsRoot);
    }
  }

  if (removeSessionLease && sessionsRoot && resolvedSessionsRoot) {
    try {
      removeManagedDirectory(userData, sessionsRoot);
    } catch (err) {
      firstError ??= err;
    } finally {
      activeSessionRoots.delete(resolvedSessionsRoot);
    }
  }
  if (firstError) throw firstError;
}
