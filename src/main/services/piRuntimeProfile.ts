import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { Agent } from '../../shared/types.js';
import type { Database } from './database.js';
import { ProviderManager, type ResolvedProvider } from './providerManager.js';
import { resolveEngineProvider } from './engineEnv.js';

export const PI_ENGINE_ID = 'eng-pi';
export const PI_MANAGED_PROVIDER = 'opcnexus';

export interface PreparedPiRuntime {
  home: string;
  sessionsDir: string;
  workspaceGuardExtension: string;
  provider: typeof PI_MANAGED_PROVIDER;
  model: string;
  env: Record<string, string>;
}

interface PiProviderResolver {
  resolveForAgent(providerId: string | null, modelOverride: string | null): ResolvedProvider | null;
}

function profileKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function writeJsonAtomic(path: string, value: unknown): void {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextAtomic(path: string, body: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

const PI_WORKSPACE_GUARD_EXTENSION = `import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path';

const GUARDED_TOOLS = new Set(['read', 'grep', 'find', 'ls']);

function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

function canonicalCandidate(candidate) {
  let cursor = candidate;
  const suffix = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...suffix);
}

function guardedPath(event) {
  const supplied = event.input?.path ?? event.input?.file_path;
  if (supplied === undefined && event.toolName !== 'read') return '.';
  if (typeof supplied !== 'string') return null;
  return supplied.startsWith('@') ? supplied.slice(1) : supplied;
}

export default function registerWorkspaceGuard(pi) {
  pi.on('tool_call', (event, ctx) => {
    if (!GUARDED_TOOLS.has(event.toolName)) return undefined;
    const raw = guardedPath(event);
    const invalid = raw === null || raw.includes('\\0') || isAbsolute(raw)
      || win32.isAbsolute(raw) || posix.isAbsolute(raw)
      || raw.split(/[\\\\/]+/).includes('..');
    if (invalid) {
      return { block: true, reason: 'OPC-Nexus only permits relative paths inside the assigned workspace.' };
    }

    try {
      const root = realpathSync(ctx.cwd);
      const candidate = canonicalCandidate(resolve(root, raw || '.'));
      if (!isWithin(root, candidate)) {
        return { block: true, reason: 'OPC-Nexus blocked a path outside the assigned workspace.' };
      }
    } catch {
      return { block: true, reason: 'OPC-Nexus could not validate this workspace path.' };
    }
    return undefined;
  });
}
`;

/**
 * Creates an isolated Pi configuration for each OPC-Nexus employee. The API
 * key is referenced through an environment variable and is never written to
 * models.json or settings.json.
 */
export class PiRuntimeProfileService {
  private readonly providers: PiProviderResolver;
  private readonly root: string;

  constructor(
    private readonly db: Database,
    providers: PiProviderResolver = new ProviderManager(db),
    root = join(app.getPath('userData'), 'runtimes', 'pi', 'profiles')
  ) {
    this.providers = providers;
    this.root = root;
  }

  ensure(agent: Pick<Agent, 'id' | 'modelOverride'>): PreparedPiRuntime {
    const resolved = resolveEngineProvider(this.db, PI_ENGINE_ID, agent, this.providers);
    if (!resolved) throw new Error('No usable model provider is configured for this employee');
    return this.prepare(`agent:${agent.id}`, resolved);
  }

  ensureProbe(): PreparedPiRuntime {
    const resolved = resolveEngineProvider(this.db, PI_ENGINE_ID, null, this.providers);
    if (!resolved) throw new Error('No usable default model provider is configured');
    return this.prepare('engine-probe', resolved);
  }

  private prepare(scope: string, resolved: ResolvedProvider): PreparedPiRuntime {
    const home = join(this.root, profileKey(scope));
    const sessionsDir = join(home, 'sessions');
    const workspaceGuardExtension = join(home, 'opc-workspace-guard.mjs');
    mkdirSync(sessionsDir, { recursive: true });

    writeJsonAtomic(join(home, 'models.json'), {
      providers: {
        [PI_MANAGED_PROVIDER]: {
          baseUrl: resolved.baseUrl,
          api: 'openai-completions',
          apiKey: '$OPENAI_API_KEY',
          authHeader: true,
          models: [{ id: resolved.model }]
        }
      }
    });
    writeJsonAtomic(join(home, 'settings.json'), {
      defaultProjectTrust: 'never',
      enableInstallTelemetry: false,
      quietStartup: true
    });
    writeTextAtomic(workspaceGuardExtension, PI_WORKSPACE_GUARD_EXTENSION);

    return {
      home,
      sessionsDir,
      workspaceGuardExtension,
      provider: PI_MANAGED_PROVIDER,
      model: resolved.model,
      env: {
        PI_CODING_AGENT_DIR: home,
        PI_CODING_AGENT_SESSION_DIR: sessionsDir,
        PI_SKIP_VERSION_CHECK: '1',
        PI_TELEMETRY: '0',
        OPENAI_API_KEY: resolved.key
      }
    };
  }
}
