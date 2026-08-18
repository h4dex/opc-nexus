import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DshPluginCatalogService } from '../src/main/services/dshPluginCatalog.js';

const roots: string[] = [];

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

function runtimeFixture(policyPatch = 'opc-managed/managed-web.patch.yml', authorizeJobs = false) {
  return {
    schemaVersion: 1,
    runtime: {
      package: '@deepseek-ai/dsh',
      version: '0.1.0-rc.6',
      integrity: 'sha512-runtime-reviewed',
      managedPolicyPatch: policyPatch
    },
    managedPolicy: {
      requiredPatchTokens: ['settings-disabled', 'workspace-read-only'],
      forbiddenPresetPackages: authorizeJobs ? [] : ['@deepseek-ai/dsh-tool-jobs'],
      authorizedPresetPackages: authorizeJobs ? ['@deepseek-ai/dsh-tool-jobs'] : []
    },
    capabilityPackages: {
      web: ['@deepseek-ai/dsh-web-app'],
      durableWork: ['@deepseek-ai/dsh-tool-jobs'],
      interaction: ['@deepseek-ai/dsh-tool-ask-user']
    }
  };
}

function createRuntime(policyPatch = 'opc-managed/managed-web.patch.yml', authorizeJobs = false): string {
  const root = mkdtempSync(join(tmpdir(), 'aibox-dsh-catalog-'));
  roots.push(root);
  mkdirSync(join(root, 'opc-managed'), { recursive: true });
  writeJson(join(root, 'capabilities.expected.json'), runtimeFixture(policyPatch, authorizeJobs));
  writeJson(join(root, 'package.json'), {
    dependencies: { '@deepseek-ai/dsh': '0.1.0-rc.6' }
  });
  writeFileSync(join(root, 'opc-managed', 'managed-web.patch.yml'), 'settings-disabled\nworkspace-read-only\n', 'utf8');

  const packages: Record<string, unknown> = {
    '': {
      version: '0.1.0',
      dependencies: { '@deepseek-ai/dsh': '0.1.0-rc.6' }
    }
  };
  const definitions = [
    ['@deepseek-ai/dsh', 'sha512-runtime-reviewed'],
    ['@deepseek-ai/dsh-web-app', 'sha512-web'],
    ['@deepseek-ai/dsh-tool-jobs', 'sha512-jobs'],
    ['@deepseek-ai/dsh-tool-ask-user', 'sha512-ask'],
    ['@deepseek-ai/dsh-tool-unreviewed', 'sha512-unreviewed']
  ] as const;
  for (const [name, integrity] of definitions) {
    packages[`node_modules/${name}`] = { version: '0.1.0-rc.6', integrity };
    const packageRoot = join(root, 'node_modules', ...name.split('/'));
    mkdirSync(packageRoot, { recursive: true });
    writeJson(join(packageRoot, 'package.json'), {
      name,
      version: '0.1.0-rc.6',
      main: 'untrusted-entry.js'
    });
    writeFileSync(join(packageRoot, 'untrusted-entry.js'), 'globalThis.__dshCatalogExecuted = true;\n', 'utf8');
  }
  writeJson(join(root, 'package-lock.json'), { lockfileVersion: 3, packages });
  return root;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__dshCatalogExecuted;
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('DshPluginCatalogService', () => {
  it('projects reviewed, approval-gated, forbidden, and unreviewed packages without loading code', () => {
    const root = createRuntime();
    const service = new DshPluginCatalogService({ runtimeRoot: root, now: () => 1234 });
    const catalog = service.getCatalog();

    expect(catalog.available).toBe(true);
    expect(catalog.scannedAt).toBe(1234);
    expect(catalog.runtime).toEqual({
      packageName: '@deepseek-ai/dsh',
      expectedVersion: '0.1.0-rc.6',
      installedVersion: '0.1.0-rc.6',
      integrityVerified: true
    });
    expect(catalog.policy).toMatchObject({ valid: true, matchedTokenCount: 2, requiredTokenCount: 2 });

    const byName = new Map(catalog.packages.map((item) => [item.name, item]));
    expect(byName.get('@deepseek-ai/dsh')).toMatchObject({ safety: 'trusted', enablement: 'enabled', reviewed: true });
    expect(byName.get('@deepseek-ai/dsh-web-app')).toMatchObject({ safety: 'trusted', enablement: 'enabled' });
    expect(byName.get('@deepseek-ai/dsh-tool-ask-user')).toMatchObject({
      safety: 'review',
      enablement: 'disabled',
      reasonCodes: ['CAPABILITY_REQUIRES_POLICY_APPROVAL']
    });
    expect(byName.get('@deepseek-ai/dsh-tool-jobs')).toMatchObject({
      safety: 'blocked',
      enablement: 'blocked',
      reasonCodes: ['FORBIDDEN_BY_MANAGED_PROFILE']
    });
    expect(byName.get('@deepseek-ai/dsh-tool-unreviewed')).toMatchObject({
      safety: 'review',
      enablement: 'disabled',
      reviewed: false,
      reasonCodes: ['UNLISTED_IN_CAPABILITY_FIXTURE']
    });
    expect((globalThis as Record<string, unknown>).__dshCatalogExecuted).toBeUndefined();
  });

  it('fails closed when the reviewed policy path escapes the runtime root', () => {
    const root = createRuntime('../outside.patch.yml');
    const catalog = new DshPluginCatalogService({ runtimeRoot: root }).getCatalog();

    expect(catalog.available).toBe(false);
    expect(catalog.policy).toMatchObject({ valid: false, relativePath: null, sha256: null });
    expect(catalog.warnings.join(' ')).toMatch(/outside the managed runtime/);
    expect(catalog.packages.every((item) => item.enablement === 'blocked' || item.enablement === 'missing')).toBe(true);
  });

  it('marks a reviewed package enabled only when the managed preset explicitly authorizes it', () => {
    const root = createRuntime('opc-managed/managed-web.patch.yml', true);
    const catalog = new DshPluginCatalogService({ runtimeRoot: root }).getCatalog();
    const jobs = catalog.packages.find((item) => item.name === '@deepseek-ai/dsh-tool-jobs');

    expect(jobs).toMatchObject({
      safety: 'trusted',
      enablement: 'enabled',
      reviewed: true,
      reasonCodes: []
    });
  });

  it('reports an unavailable catalog for a missing or malformed prepared runtime', () => {
    const missing = new DshPluginCatalogService({ runtimeRoot: join(tmpdir(), `missing-${Date.now()}`) }).getCatalog();
    expect(missing).toMatchObject({ available: false, packages: [] });

    const root = createRuntime();
    writeFileSync(join(root, 'package-lock.json'), '{not-json', 'utf8');
    const malformed = new DshPluginCatalogService({ runtimeRoot: root }).getCatalog();
    expect(malformed.available).toBe(false);
    expect(malformed.packages).toEqual([]);
    expect(malformed.warnings[0]).toMatch(/not valid JSON/);
  });
});
