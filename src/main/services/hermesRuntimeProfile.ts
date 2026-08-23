import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { app } from 'electron';
import type { Agent } from '../../shared/types.js';
import type { Database } from './database.js';
import { ProviderManager, type ResolvedProvider } from './providerManager.js';
import { resolveEngineProvider } from './engineEnv.js';

export const HERMES_AGENT_ENGINE_ID = 'eng-hermes-cli';
const HERMES_MAX_OUTPUT_TOKENS = 16_384;

export interface PreparedHermesRuntime {
  home: string;
  model: string;
  provider: 'opcnexus';
  env: Record<string, string>;
}

interface HermesProfileIdentity {
  name: string;
  systemPrompt: string;
  soulMd: string;
  agentsMd: string;
  userMd: string;
  memoryMode?: Agent['memoryMode'];
}

function defaultManagedRoot(): string {
  return join(app.getPath('userData'), 'aibox-data', 'hermes-agent', 'profiles');
}

function atomicWrite(path: string, content: string): void {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' });
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function seedFile(path: string, content: string): void {
  try {
    writeFileSync(path, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/**
 * Creates one durable, application-owned Hermes home per Agent. The profile
 * contains only non-secret routing data; credentials are returned for the
 * child-process environment and are never written to the profile.
 */
export class HermesRuntimeProfileService {
  private readonly providers: ProviderManager;

  constructor(
    private readonly db: Database,
    providers?: ProviderManager,
    private readonly root = defaultManagedRoot()
  ) {
    this.providers = providers ?? new ProviderManager(db);
  }

  profileHome(agentId: string): string {
    const key = createHash('sha256').update(agentId).digest('hex').slice(0, 24);
    return join(this.root, `agent-${key}`);
  }

  private assertManagedPath(path: string): void {
    const root = resolve(this.root);
    const candidate = resolve(path);
    const rel = relative(root, candidate);
    if (!rel || rel.startsWith('..') || rel.includes(':')) {
      throw new Error('Refusing to modify a Hermes path outside the OPC-Nexus profile root');
    }
  }

  private resolveProvider(agent: Agent): ResolvedProvider | null {
    return resolveEngineProvider(this.db, HERMES_AGENT_ENGINE_ID, agent, this.providers);
  }

  private prepare(profileKey: string, identity: HermesProfileIdentity, provider: ResolvedProvider | null): PreparedHermesRuntime {
    if (!provider) throw new Error('该员工没有可用的模型供应商或密钥');

    const home = this.profileHome(profileKey);
    this.assertManagedPath(home);
    mkdirSync(join(home, 'memories'), { recursive: true });

    const config = {
      model: {
        default: provider.model,
        provider: 'opcnexus',
        max_tokens: HERMES_MAX_OUTPUT_TOKENS
      },
      providers: {
        opcnexus: {
          name: 'OPC-Nexus',
          api: provider.baseUrl,
          key_env: 'OPENAI_API_KEY',
          default_model: provider.model,
          transport: 'chat_completions',
          max_tokens: HERMES_MAX_OUTPUT_TOKENS
        }
      },
      memory: {
        memory_enabled: identity.memoryMode === 'long_term'
      }
    };

    atomicWrite(
      join(home, 'config.yaml'),
      `# Managed by OPC-Nexus. Credentials are injected into the task process only.\n${JSON.stringify(config, null, 2)}\n`
    );
    atomicWrite(join(home, 'SOUL.md'), identity.soulMd || identity.systemPrompt || `You are ${identity.name}.`);
    atomicWrite(join(home, 'AGENTS.md'), identity.agentsMd || identity.systemPrompt || `Work as ${identity.name}.`);
    // Root USER.md is an OPC-managed profile mirror. Hermes owns and mutates
    // memories/USER.md, so only seed that file when the profile is first made.
    atomicWrite(join(home, 'USER.md'), identity.userMd || '');
    seedFile(join(home, 'memories', 'USER.md'), identity.userMd || '');

    // Hermes may seed these files during initialization. OPC-Nexus credentials
    // are task-scoped, so a managed profile must never retain a secret mirror.
    rmSync(join(home, '.env'), { force: true });
    rmSync(join(home, 'auth.json'), { force: true });

    return {
      home,
      model: provider.model,
      provider: 'opcnexus',
      env: {
        HERMES_HOME: home,
        HERMES_INFERENCE_MODEL: provider.model,
        HERMES_INFERENCE_PROVIDER: 'opcnexus',
        OPENAI_API_KEY: provider.key,
        OPENAI_BASE_URL: provider.baseUrl,
        OPENAI_API_BASE: provider.baseUrl
      }
    };
  }

  ensure(agent: Agent): PreparedHermesRuntime {
    return this.prepare(agent.id, agent, this.resolveProvider(agent));
  }

  /** Dedicated controller profile scoped to one canonical conversation. */
  ensureController(organizationId: string, principalId: string, conversationId: string): PreparedHermesRuntime {
    return this.prepare(`controller:${organizationId}:${principalId}:${conversationId}`, {
      name: 'OPC-Nexus control kernel',
      systemPrompt: 'Plan and route work. Never execute the requested work yourself.',
      soulMd: 'You are the planning and routing kernel for OPC-Nexus.',
      agentsMd: [
        'Return only the requested structured dispatch plan.',
        'Do not modify files, run commands, contact external systems, or create schedules.',
        'OPC-Nexus owns task state, approvals, memory, scheduling, and auditing.'
      ].join('\n'),
      userMd: ''
    }, resolveEngineProvider(this.db, HERMES_AGENT_ENGINE_ID, null, this.providers));
  }

  /** A fixed profile is recreated before each probe so health checks cannot
   * consume a user's global Hermes config or accumulate unbounded sessions. */
  ensureProbe(): PreparedHermesRuntime {
    const home = this.profileHome('__engine_probe__');
    this.assertManagedPath(home);
    rmSync(home, { recursive: true, force: true });
    return this.prepare('__engine_probe__', {
      name: 'OPC-Nexus Hermes probe',
      systemPrompt: 'Return a short response without using tools.',
      soulMd: '',
      agentsMd: 'Do not use tools during the engine health probe.',
      userMd: ''
    }, resolveEngineProvider(this.db, HERMES_AGENT_ENGINE_ID, null, this.providers));
  }
}
