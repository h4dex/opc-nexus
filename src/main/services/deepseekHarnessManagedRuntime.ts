import { app } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DSH_MANAGED_ENGINE_ID } from '../../shared/types.js';
import { harnessNodeSupported } from './deepseekHarnessRuntime.js';
import { DSH_MANAGED_ENTRY, DSH_MANAGED_POLICY_PATCH } from './dshSupervisor.js';

export { DSH_MANAGED_ENGINE_ID };
export const DSH_MANAGED_VERSION = '0.1.0-rc.6';
export const DSH_MANAGED_PROFILE_ID = 'opc-nexus-managed-web-v1';
const DSH_MANAGED_PROJECT_PROFILE_PREFIX = `${DSH_MANAGED_PROFILE_ID}-project-`;

/** One immutable DSH process profile per project prevents workspace crossover. */
export function dshManagedProjectProfileId(
  projectId: string,
  baseProfileId = DSH_MANAGED_PROFILE_ID
): string {
  if (!projectId || projectId.length > 200 || /[\u0000-\u001f\u007f]/.test(projectId)) {
    throw new Error('Project id is invalid for the managed DSH profile');
  }
  const digest = createHash('sha256')
    .update(`${baseProfileId}\u0000${projectId}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `${baseProfileId}-project-${digest}`;
}

export function isDshManagedProfileId(profileId: string): boolean {
  return profileId === DSH_MANAGED_PROFILE_ID
    || profileId.startsWith(DSH_MANAGED_PROJECT_PROFILE_PREFIX);
}

export const DSH_MANAGED_CAPABILITIES_DISABLED = Object.freeze({
  sessionEvents: false,
  history: false,
  goals: false,
  jobs: false,
  subagents: false,
  planMode: false,
  askUser: false,
  shell: false,
  filesystem: false,
  network: false,
  runtimeAuthoring: false
}) satisfies Readonly<Record<string, boolean>>;

export interface ManagedHarnessRuntimePaths {
  root: string;
  entry: string;
  capabilityFixture: string;
}

export function deepseekHarnessManagedRuntimePaths(): ManagedHarnessRuntimePaths {
  const root = app.isPackaged
    ? join(process.resourcesPath, 'runtime', 'deepseek-harness-managed')
    : resolve(app.getAppPath(), 'runtime', 'deepseek-harness-managed', 'dist');
  return {
    root,
    entry: join(root, DSH_MANAGED_ENTRY),
    capabilityFixture: join(root, 'capabilities.expected.json')
  };
}

function isRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export function deepseekHarnessManagedAvailable(): boolean {
  const paths = deepseekHarnessManagedRuntimePaths();
  const policyPatch = join(paths.root, ...DSH_MANAGED_POLICY_PATCH.split('/'));
  return harnessNodeSupported()
    && existsSync(process.execPath)
    && isRegularFile(paths.entry)
    && isRegularFile(paths.capabilityFixture)
    && isRegularFile(policyPatch);
}

/** Read the prepare-time verified capability projection without loading DSH code. */
export function readDeepseekHarnessManagedCapabilities(
  fixturePath = deepseekHarnessManagedRuntimePaths().capabilityFixture
): Readonly<Record<string, boolean>> {
  try {
    if (!isRegularFile(fixturePath)) return DSH_MANAGED_CAPABILITIES_DISABLED;
    const source = readFileSync(fixturePath);
    if (source.byteLength === 0 || source.byteLength > 1024 * 1024) return DSH_MANAGED_CAPABILITIES_DISABLED;
    const fixture = JSON.parse(source.toString('utf8')) as unknown;
    if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) return DSH_MANAGED_CAPABILITIES_DISABLED;
    const capabilities = (fixture as Record<string, unknown>).runtimeCapabilities;
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
      return DSH_MANAGED_CAPABILITIES_DISABLED;
    }
    const normalized: Record<string, boolean> = {};
    for (const [name, enabled] of Object.entries(capabilities)) {
      if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(name) || typeof enabled !== 'boolean') {
        return DSH_MANAGED_CAPABILITIES_DISABLED;
      }
      normalized[name] = enabled;
    }
    return Object.keys(normalized).length === 0
      ? DSH_MANAGED_CAPABILITIES_DISABLED
      : Object.freeze(normalized);
  } catch {
    return DSH_MANAGED_CAPABILITIES_DISABLED;
  }
}
