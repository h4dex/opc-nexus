// @ts-nocheck
/* eslint-disable */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const {
  assertPackagedMainDependencyEntries,
  REQUIRED_MAIN_DEPENDENCY_PACKAGES,
} = require('../scripts/after-pack.cjs');

function resolvedProductionClosure(rootPackages: string[]): string[] {
  const projectRoot = process.cwd();
  const resolved = new Set<string>();
  const resolvePackage = (from: string, packageName: string): string => {
    let current = from;
    while (true) {
      const candidate = join(current, 'node_modules', ...packageName.split('/'));
      if (existsSync(join(candidate, 'package.json'))) return candidate;
      const parent = dirname(current);
      if (parent === current) throw new Error(`Unable to resolve production dependency ${packageName} from ${from}`);
      current = parent;
    }
  };
  const visit = (packageDirectory: string) => {
    const entry = relative(projectRoot, join(packageDirectory, 'package.json')).split(sep).join('/');
    if (resolved.has(entry)) return;
    resolved.add(entry);
    const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
      visit(resolvePackage(packageDirectory, dependency));
    }
  };
  for (const packageName of rootPackages) visit(resolvePackage(projectRoot, packageName));
  return [...resolved].sort();
}

describe('Electron Main production dependency closure', () => {
  it('fails when a direct or transitive runtime package is absent from app.asar', () => {
    const withoutSelfsignedTransitive = REQUIRED_MAIN_DEPENDENCY_PACKAGES.filter(
      (entry: string) => entry !== 'node_modules/@peculiar/x509/package.json'
    );
    expect(() => assertPackagedMainDependencyEntries(withoutSelfsignedTransitive)).toThrow(/@peculiar\/x509/);

    const withoutQrTransitive = REQUIRED_MAIN_DEPENDENCY_PACKAGES.filter(
      (entry: string) => entry !== 'node_modules/pngjs/package.json'
    );
    expect(() => assertPackagedMainDependencyEntries(withoutQrTransitive)).toThrow(/pngjs/);

    const withoutAjvTransitive = REQUIRED_MAIN_DEPENDENCY_PACKAGES.filter(
      (entry: string) => entry !== 'node_modules/fast-uri/package.json'
    );
    expect(() => assertPackagedMainDependencyEntries(withoutAjvTransitive)).toThrow(/fast-uri/);
  });

  it('accepts the reviewed physical package closure with either asar path separator', () => {
    const entries = REQUIRED_MAIN_DEPENDENCY_PACKAGES.map((entry: string, index: number) =>
      index % 2 === 0 ? `/${entry}` : `\\${entry.replaceAll('/', '\\')}`
    );
    expect(assertPackagedMainDependencyEntries(entries)).toEqual({
      packages: REQUIRED_MAIN_DEPENDENCY_PACKAGES.length,
    });
  });

  it('keeps every reviewed package reachable from the electron-builder files allowlist', () => {
    const config = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8');
    const prefixes = [
      ...[...config.matchAll(/^\s*-\s+(node_modules\/[^*\r\n]+)\/\*\*\/?\*?\s*$/gm)]
        .map((match) => match[1]!.replace(/\/$/, '')),
      ...[...config.matchAll(/^\s+to:\s+(node_modules\/[^\r\n]+)\s*$/gm)]
        .map((match) => match[1]!.replace(/\/$/, '')),
    ];
    const uncovered = REQUIRED_MAIN_DEPENDENCY_PACKAGES.filter((entry: string) => {
      const packageDirectory = entry.slice(0, -'/package.json'.length);
      return !prefixes.some((prefix) => {
        if (packageDirectory === prefix) return true;
        if (!packageDirectory.startsWith(`${prefix}/`)) return false;
        return !packageDirectory.slice(prefix.length + 1).split('/').includes('node_modules');
      });
    });
    expect(uncovered).toEqual([]);
  });

  it('tracks the complete installed production graph for selfsigned, qrcode, and ajv', () => {
    expect([...REQUIRED_MAIN_DEPENDENCY_PACKAGES].sort()).toEqual(
      resolvedProductionClosure(['selfsigned', 'qrcode', 'ajv'])
    );
  });
});
