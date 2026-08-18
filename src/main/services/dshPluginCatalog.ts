/**
 * Read-only inventory for the pinned managed DSH bundle.
 *
 * This service only parses bounded files below the prepared runtime root. It
 * never imports package code, attaches PluginHost handlers, or treats package
 * presence as execution authorization.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type {
  DshPluginCatalogView,
  DshPluginEnablement,
  DshPluginPackageView,
  DshPluginSafetyLevel
} from '../../shared/types.js';

const MAX_FIXTURE_BYTES = 1024 * 1024;
const MAX_LOCK_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PATCH_BYTES = 1024 * 1024;
const MAX_CAPABILITY_GROUPS = 32;
const MAX_PACKAGES_PER_GROUP = 128;
const MAX_CATALOG_PACKAGES = 256;
const MAX_WARNINGS = 64;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,127}|[a-z0-9][a-z0-9._-]{0,127})$/;
const CAPABILITY_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

interface JsonRecord { [key: string]: unknown }

interface NormalizedFixture {
  schemaVersion: number;
  runtimePackage: string;
  runtimeVersion: string;
  runtimeIntegrity: string;
  policyPatch: string;
  requiredPatchTokens: string[];
  forbiddenPackages: Set<string>;
  authorizedPackages: Set<string>;
  capabilityPackages: Map<string, string[]>;
}

interface LockPackage {
  version: string | null;
  integrity: string | null;
}

interface LockSnapshot {
  packages: Map<string, LockPackage>;
  rootDependencies: Map<string, string>;
}

interface PackageInspection {
  installed: boolean;
  version: string | null;
  lockIntegrity: string | null;
  versionMatchesLock: boolean;
}

export interface DshPluginCatalogOptions {
  runtimeRoot: string;
  now?: () => number;
}

export class DshPluginCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DshPluginCatalogError';
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, label: string, maximum = 1024): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value !== value.trim()
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new DshPluginCatalogError(`${label} is invalid`);
  }
  return value;
}

function packageName(value: unknown, label: string): string {
  const result = boundedString(value, label, 192);
  if (!PACKAGE_NAME.test(result)) throw new DshPluginCatalogError(`${label} is invalid`);
  return result;
}

function stringArray(value: unknown, label: string, maximumItems: number, maximumLength = 2048): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new DshPluginCatalogError(`${label} must be a bounded array`);
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = boundedString(value[index], `${label}[${index}]`, maximumLength);
    if (!result.includes(item)) result.push(item);
  }
  return result;
}

function normalizeFixture(value: unknown): NormalizedFixture {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new DshPluginCatalogError('Unsupported managed capability fixture');
  }
  if (!isRecord(value.runtime) || !isRecord(value.managedPolicy) || !isRecord(value.capabilityPackages)) {
    throw new DshPluginCatalogError('Managed capability fixture is incomplete');
  }
  const runtimePackage = packageName(value.runtime.package, 'runtime.package');
  const runtimeVersion = boundedString(value.runtime.version, 'runtime.version', 128);
  const runtimeIntegrity = boundedString(value.runtime.integrity, 'runtime.integrity', 1024);
  const policyPatch = boundedString(value.runtime.managedPolicyPatch, 'runtime.managedPolicyPatch', 512);
  const requiredPatchTokens = stringArray(
    value.managedPolicy.requiredPatchTokens,
    'managedPolicy.requiredPatchTokens',
    128,
    4096
  );
  const forbiddenPackages = new Set(
    stringArray(value.managedPolicy.forbiddenPresetPackages, 'managedPolicy.forbiddenPresetPackages', 128, 192)
      .map((item, index) => packageName(item, `managedPolicy.forbiddenPresetPackages[${index}]`))
  );
  const authorizedPackages = new Set(
    (value.managedPolicy.authorizedPresetPackages === undefined
      ? []
      : stringArray(value.managedPolicy.authorizedPresetPackages, 'managedPolicy.authorizedPresetPackages', 128, 192))
      .map((item, index) => packageName(item, `managedPolicy.authorizedPresetPackages[${index}]`))
  );
  for (const name of authorizedPackages) {
    if (forbiddenPackages.has(name)) {
      throw new DshPluginCatalogError(`Managed package cannot be both authorized and forbidden: ${name}`);
    }
  }
  const capabilityEntries = Object.entries(value.capabilityPackages);
  if (capabilityEntries.length === 0 || capabilityEntries.length > MAX_CAPABILITY_GROUPS) {
    throw new DshPluginCatalogError('capabilityPackages must be a non-empty bounded object');
  }
  const capabilityPackages = new Map<string, string[]>();
  for (const [rawCategory, rawPackages] of capabilityEntries) {
    if (!CAPABILITY_NAME.test(rawCategory)) throw new DshPluginCatalogError('Capability category is invalid');
    const names = stringArray(rawPackages, `capabilityPackages.${rawCategory}`, MAX_PACKAGES_PER_GROUP, 192)
      .map((item, index) => packageName(item, `capabilityPackages.${rawCategory}[${index}]`));
    capabilityPackages.set(rawCategory, names);
  }
  return {
    schemaVersion: 1,
    runtimePackage,
    runtimeVersion,
    runtimeIntegrity,
    policyPatch,
    requiredPatchTokens,
    forbiddenPackages,
    authorizedPackages,
    capabilityPackages
  };
}

function safeRuntimePath(root: string, child: string, label: string): string {
  if (!child || isAbsolute(child)) throw new DshPluginCatalogError(`${label} must be relative to the runtime`);
  const target = resolve(root, child);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new DshPluginCatalogError(`${label} is outside the managed runtime`);
  }
  // A lexical containment check is not enough when a prepared directory is
  // replaced with a symlink. Reject any existing symlink in the path chain;
  // missing files are handled by the caller as an ordinary unavailable state.
  let current = root;
  for (const segment of rel.split(/[\\/]+/)) {
    if (!segment) continue;
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new DshPluginCatalogError(`${label} contains a symbolic link`);
      }
    } catch (error) {
      if (error instanceof DshPluginCatalogError) throw error;
      break;
    }
  }
  return target;
}

function isRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function readBoundedText(path: string, maximumBytes: number, label: string): string {
  if (!isRegularFile(path)) throw new DshPluginCatalogError(`${label} is missing or is not a regular file`);
  const data = readFileSync(path);
  if (data.byteLength === 0 || data.byteLength > maximumBytes) {
    throw new DshPluginCatalogError(`${label} exceeds its size boundary`);
  }
  return data.toString('utf8');
}

function readBoundedJson(path: string, maximumBytes: number, label: string): unknown {
  const source = readBoundedText(path, maximumBytes, label);
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new DshPluginCatalogError(`${label} is not valid JSON`);
  }
}

function lockPackages(value: unknown): LockSnapshot {
  if (!isRecord(value) || value.lockfileVersion !== 3 || !isRecord(value.packages)) {
    throw new DshPluginCatalogError('Managed runtime requires package-lock v3');
  }
  const entries = Object.entries(value.packages);
  if (entries.length > 20_000) throw new DshPluginCatalogError('Managed package lock exceeds its entry boundary');
  const result = new Map<string, LockPackage>();
  const root = isRecord(value.packages['']) ? value.packages[''] : null;
  const rootDependencies = new Map<string, string>();
  if (root && isRecord(root.dependencies)) {
    for (const [name, version] of Object.entries(root.dependencies)) {
      if (typeof version === 'string' && PACKAGE_NAME.test(name) && version.length <= 128) {
        rootDependencies.set(name, version);
      }
    }
  }
  for (const [path, metadata] of entries) {
    if (!isRecord(metadata)) continue;
    result.set(path, {
      version: typeof metadata.version === 'string' ? metadata.version : null,
      integrity: typeof metadata.integrity === 'string' ? metadata.integrity : null
    });
  }
  return { packages: result, rootDependencies };
}

function manifestVersion(value: unknown): string | null {
  if (!isRecord(value) || typeof value.version !== 'string' || value.version.length === 0 || value.version.length > 128) {
    return null;
  }
  return value.version;
}

function lockKeyForPackage(name: string): string {
  return `node_modules/${name}`;
}

function packageNameFromTopLevelLockPath(path: string): string | null {
  if (!path.startsWith('node_modules/')) return null;
  const suffix = path.slice('node_modules/'.length);
  if (suffix.includes('/node_modules/')) return null;
  const parts = suffix.split('/');
  if (parts[0]?.startsWith('@')) {
    if (parts.length !== 2) return null;
  } else if (parts.length !== 1) return null;
  return PACKAGE_NAME.test(suffix) ? suffix : null;
}

function isDshPluginPackage(name: string): boolean {
  return name.startsWith('@deepseek-ai/dsh-') || name.startsWith('@deepseek-ai/cordis-plugin-');
}

function reasonCode(value: string): string {
  return value.replace(/[^A-Z0-9_]/g, '_').slice(0, 80);
}

function packageEnablement(safety: DshPluginSafetyLevel, installed: boolean, enabled: boolean): DshPluginEnablement {
  if (!installed) return 'missing';
  if (safety === 'blocked') return 'blocked';
  return enabled ? 'enabled' : 'disabled';
}

function emptyCatalog(scannedAt: number, warning: string): DshPluginCatalogView {
  return {
    available: false,
    scannedAt,
    runtime: {
      packageName: null,
      expectedVersion: null,
      installedVersion: null,
      integrityVerified: false
    },
    policy: {
      valid: false,
      relativePath: null,
      sha256: null,
      requiredTokenCount: 0,
      matchedTokenCount: 0
    },
    packages: [],
    counts: { enabled: 0, disabled: 0, blocked: 0, missing: 0 },
    warnings: [warning]
  };
}

export class DshPluginCatalogService {
  private readonly runtimeRoot: string;
  private readonly now: () => number;

  constructor(options: DshPluginCatalogOptions) {
    if (!options || typeof options.runtimeRoot !== 'string' || options.runtimeRoot.length === 0) {
      throw new DshPluginCatalogError('Managed runtime root is required');
    }
    this.runtimeRoot = resolve(options.runtimeRoot);
    this.now = options.now ?? Date.now;
  }

  /** Alias used by callers that treat the inventory as a runtime profile. */
  getProfile(): DshPluginCatalogView {
    return this.getCatalog();
  }

  getCatalog(): DshPluginCatalogView {
    const scannedAt = this.now();
    if (!isDirectory(this.runtimeRoot)) return emptyCatalog(scannedAt, 'Managed DSH runtime is not prepared');

    let fixture: NormalizedFixture;
    let lock: LockSnapshot;
    try {
      fixture = normalizeFixture(readBoundedJson(
        safeRuntimePath(this.runtimeRoot, 'capabilities.expected.json', 'capability fixture'),
        MAX_FIXTURE_BYTES,
        'Managed capability fixture'
      ));
      lock = lockPackages(readBoundedJson(
        safeRuntimePath(this.runtimeRoot, 'package-lock.json', 'package lock'),
        MAX_LOCK_BYTES,
        'Managed package lock'
      ));
    } catch (error) {
      return emptyCatalog(scannedAt, error instanceof Error ? error.message : 'Managed runtime catalog could not be read');
    }

    const warnings: string[] = [];
    const warn = (message: string) => {
      if (warnings.length < MAX_WARNINGS && !warnings.includes(message)) warnings.push(message);
    };

    let policyPath: string | null = null;
    let policyHash: string | null = null;
    let matchedPatchTokens = 0;
    let policyValid = false;
    try {
      const absolutePolicyPath = safeRuntimePath(this.runtimeRoot, fixture.policyPatch, 'Managed policy patch');
      const policySource = readBoundedText(absolutePolicyPath, MAX_PATCH_BYTES, 'Managed policy patch');
      matchedPatchTokens = fixture.requiredPatchTokens.filter((token) => policySource.includes(token)).length;
      policyValid = matchedPatchTokens === fixture.requiredPatchTokens.length;
      policyPath = relative(this.runtimeRoot, absolutePolicyPath).replaceAll('\\', '/');
      policyHash = createHash('sha256').update(policySource).digest('hex');
      if (!policyValid) warn('Managed policy patch is missing reviewed controls');
    } catch (error) {
      warn(error instanceof Error ? error.message : 'Managed policy patch could not be read');
    }

    const rootManifestPath = safeRuntimePath(this.runtimeRoot, 'package.json', 'runtime manifest');
    let rootDependencyPinned = false;
    try {
      const rootManifest = readBoundedJson(rootManifestPath, MAX_MANIFEST_BYTES, 'Managed runtime manifest');
      rootDependencyPinned = isRecord(rootManifest)
        && isRecord(rootManifest.dependencies)
        && rootManifest.dependencies[fixture.runtimePackage] === fixture.runtimeVersion;
    } catch (error) {
      warn(error instanceof Error ? error.message : 'Managed runtime manifest could not be read');
    }

    const runtimeLock = lock.packages.get(lockKeyForPackage(fixture.runtimePackage));
    const runtimeInspection = this.inspectPackage(fixture.runtimePackage, runtimeLock);
    const integrityVerified = rootDependencyPinned
      && lock.rootDependencies.get(fixture.runtimePackage) === fixture.runtimeVersion
      && runtimeInspection.installed
      && runtimeInspection.version === fixture.runtimeVersion
      && runtimeInspection.versionMatchesLock
      && runtimeLock?.version === fixture.runtimeVersion
      && runtimeLock.integrity === fixture.runtimeIntegrity;
    if (!integrityVerified) warn('Managed DSH runtime version or integrity does not match the reviewed fixture');

    const categoriesByPackage = new Map<string, Set<string>>();
    const addCategory = (name: string, category: string) => {
      const categories = categoriesByPackage.get(name) ?? new Set<string>();
      categories.add(category);
      categoriesByPackage.set(name, categories);
    };
    addCategory(fixture.runtimePackage, 'runtime');
    for (const [category, names] of fixture.capabilityPackages) {
      for (const name of names) addCategory(name, category);
    }

    for (const path of lock.packages.keys()) {
      const name = packageNameFromTopLevelLockPath(path);
      if (name && isDshPluginPackage(name) && !categoriesByPackage.has(name)) addCategory(name, 'unreviewed');
    }

    const packageNames = [...categoriesByPackage.keys()].sort((left, right) => left.localeCompare(right));
    if (packageNames.length > MAX_CATALOG_PACKAGES) warn('Managed plugin catalog was truncated at its package boundary');
    const packages = packageNames.slice(0, MAX_CATALOG_PACKAGES).map((name) => {
      const categories = [...(categoriesByPackage.get(name) ?? [])].sort();
      const lockEntry = lock.packages.get(lockKeyForPackage(name));
      const inspection = this.inspectPackage(name, lockEntry);
      const explicitForbidden = fixture.forbiddenPackages.has(name);
      const reviewed = !categories.includes('unreviewed');
      const isTrustedCore = categories.includes('runtime')
        || categories.includes('web')
        || fixture.authorizedPackages.has(name);
      const reasons: string[] = [];
      if (!lockEntry) reasons.push('LOCK_ENTRY_MISSING');
      else if (!lockEntry.integrity) reasons.push('LOCK_INTEGRITY_MISSING');
      if (!inspection.installed) reasons.push('PACKAGE_MISSING');
      else if (!inspection.versionMatchesLock) reasons.push('VERSION_MISMATCH');
      if (!policyValid) reasons.push('POLICY_INVALID');
      if (explicitForbidden) reasons.push('FORBIDDEN_BY_MANAGED_PROFILE');
      if (!reviewed) reasons.push('UNLISTED_IN_CAPABILITY_FIXTURE');
      if (reviewed && !isTrustedCore && !explicitForbidden) reasons.push('CAPABILITY_REQUIRES_POLICY_APPROVAL');

      let safety: DshPluginSafetyLevel = 'review';
      if (!lockEntry || !lockEntry.integrity || !inspection.installed || !inspection.versionMatchesLock
        || !policyValid || explicitForbidden) safety = 'blocked';
      else if (isTrustedCore && reviewed) safety = 'trusted';
      const enabled = safety === 'trusted' && integrityVerified;
      return {
        name,
        version: inspection.version ?? lockEntry?.version ?? null,
        categories,
        safety,
        enablement: packageEnablement(safety, inspection.installed, enabled),
        installed: inspection.installed,
        reviewed,
        reasonCodes: reasons.map(reasonCode)
      } satisfies DshPluginPackageView;
    });

    const counts: Record<DshPluginEnablement, number> = { enabled: 0, disabled: 0, blocked: 0, missing: 0 };
    for (const item of packages) counts[item.enablement] += 1;
    return {
      available: integrityVerified && policyValid,
      scannedAt,
      runtime: {
        packageName: fixture.runtimePackage,
        expectedVersion: fixture.runtimeVersion,
        installedVersion: runtimeInspection.version,
        integrityVerified
      },
      policy: {
        valid: policyValid,
        relativePath: policyPath,
        sha256: policyHash,
        requiredTokenCount: fixture.requiredPatchTokens.length,
        matchedTokenCount: matchedPatchTokens
      },
      packages,
      counts,
      warnings
    };
  }

  private inspectPackage(name: string, locked: LockPackage | undefined): PackageInspection {
    const manifestPath = safeRuntimePath(
      this.runtimeRoot,
      join('node_modules', ...name.split('/'), 'package.json'),
      `Package ${name}`
    );
    if (!isRegularFile(manifestPath)) {
      return { installed: false, version: null, lockIntegrity: locked?.integrity ?? null, versionMatchesLock: false };
    }
    let version: string | null = null;
    try {
      version = manifestVersion(readBoundedJson(manifestPath, MAX_MANIFEST_BYTES, `Package ${name} manifest`));
    } catch {
      version = null;
    }
    return {
      installed: version !== null,
      version,
      lockIntegrity: locked?.integrity ?? null,
      versionMatchesLock: version !== null && locked?.version === version
    };
  }
}

/** Small functional entry point for diagnostics and contract tests. */
export function scanDshPluginCatalog(options: DshPluginCatalogOptions): DshPluginCatalogView {
  return new DshPluginCatalogService(options).getCatalog();
}
