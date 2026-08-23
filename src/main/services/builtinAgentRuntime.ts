import { app } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BuiltinAgentRuntimeSpec {
  engineId: 'eng-codex' | 'eng-pi';
  directory: 'codex' | 'pi';
  packageName: string;
  version: string;
  entry: string;
  license: string;
}

export interface BuiltinAgentRuntimeLocation {
  engineId: BuiltinAgentRuntimeSpec['engineId'];
  root: string;
  entryPath: string;
  version: string;
  source: 'resources' | 'app' | 'userData';
}

export const BUILTIN_AGENT_RUNTIME_SPECS: readonly BuiltinAgentRuntimeSpec[] = [
  {
    engineId: 'eng-codex',
    directory: 'codex',
    packageName: '@openai/codex',
    version: '0.149.0',
    entry: 'node_modules/@openai/codex/bin/codex.js',
    license: 'Apache-2.0'
  },
  {
    engineId: 'eng-pi',
    directory: 'pi',
    packageName: '@earendil-works/pi-coding-agent',
    version: '0.84.2',
    entry: 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
    license: 'MIT'
  }
] as const;

function specFor(engineId: string): BuiltinAgentRuntimeSpec | null {
  return BUILTIN_AGENT_RUNTIME_SPECS.find((spec) => spec.engineId === engineId) ?? null;
}

function candidateRoots(): { root: string; source: BuiltinAgentRuntimeLocation['source'] }[] {
  const candidates: { root: string; source: BuiltinAgentRuntimeLocation['source'] }[] = [];
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.trim()) {
    candidates.push({ root: join(process.resourcesPath, 'agent-runtimes'), source: 'resources' });
  }
  candidates.push({ root: join(app.getAppPath(), 'runtime', 'agent-clis'), source: 'app' });
  candidates.push({ root: join(app.getPath('userData'), 'aibox-data', 'agent-runtimes'), source: 'userData' });
  return candidates;
}

/**
 * Finds an application-owned Codex/Pi entry point. The caller may still fall
 * back to PATH, but a bundled runtime always wins so a packaged app does not
 * silently run a different user-global version.
 */
export function locateBuiltinAgentRuntime(engineId: string): BuiltinAgentRuntimeLocation | null {
  const spec = specFor(engineId);
  if (!spec) return null;
  for (const candidate of candidateRoots()) {
    const root = join(candidate.root, spec.directory);
    const entryPath = join(root, ...spec.entry.split('/'));
    if (!existsSync(entryPath)) continue;
    let version = spec.version;
    try {
      const packageJson = JSON.parse(readFileSync(join(root, 'node_modules', ...spec.packageName.split('/'), 'package.json'), 'utf8')) as { version?: unknown };
      if (typeof packageJson.version === 'string' && packageJson.version.trim()) version = packageJson.version.trim();
    } catch {
      // The pinned manifest remains the source of truth when package metadata
      // is unavailable; entry existence is still required above.
    }
    return { engineId: spec.engineId, root, entryPath, version, source: candidate.source };
  }
  return null;
}

export function builtinAgentRuntimeRoots(): string[] {
  return candidateRoots().map(({ root }) => root);
}

export function builtinAgentRuntimeSpec(engineId: string): BuiltinAgentRuntimeSpec | null {
  return specFor(engineId);
}
