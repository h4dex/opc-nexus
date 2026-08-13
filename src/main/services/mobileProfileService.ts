import { app } from 'electron';
import { existsSync, mkdirSync, cpSync, copyFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCli, spawnCli } from './cliLauncher.js';
import type { Agent } from '../../shared/types.js';
import type { Database } from './database.js';
import { getProviderSettings, providerReady } from './provider.js';
import { appendProcessOutput, createProcessOutputBuffer, finishProcessOutput } from './textEncoding.js';

const PROFILE_PREFIX = 'opcnexus-mobile-';

export interface MobileProfileCheckpoint {
  agentId: string;
  existed: boolean;
  backupPath: string | null;
}

function defaultHermesRoot(): string {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'hermes');
  return join(homedir(), '.hermes');
}

function mobileResourcesRoot(): string {
  const candidates = [
    ...(typeof process.resourcesPath === 'string' ? [join(process.resourcesPath, 'mobile')] : []),
    ...(typeof app.getAppPath === 'function' ? [join(app.getAppPath(), 'mobile')] : []),
    join(import.meta.dirname, '../../../mobile')
  ];
  const found = candidates.find((path) => existsSync(join(path, 'hermes-plugin')));
  if (!found) throw new Error('OPC-Nexus Android plugin resources are missing');
  return found;
}

export class MobileProfileService {
  constructor(private db: Database, private hermesRoot = defaultHermesRoot()) {}

  profileName(agentId: string): string {
    return `${PROFILE_PREFIX}${agentId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 12)}`;
  }

  profileHome(agentId: string): string {
    return join(this.hermesRoot, 'profiles', this.profileName(agentId));
  }

  private profilesRoot(): string {
    return join(this.hermesRoot, 'profiles');
  }

  private assertManagedPath(path: string): void {
    const root = resolve(this.profilesRoot());
    const candidate = resolve(path);
    const rel = relative(root, candidate);
    if (!rel || rel.startsWith('..') || rel.includes(':')) throw new Error('Refusing to modify a Hermes path outside the managed profiles directory');
  }

  checkpoint(agentId: string): MobileProfileCheckpoint {
    const home = this.profileHome(agentId);
    this.assertManagedPath(home);
    if (!existsSync(home)) return { agentId, existed: false, backupPath: null };
    mkdirSync(this.profilesRoot(), { recursive: true });
    const backupPath = join(this.profilesRoot(), `.opcnexus-backup-${this.profileName(agentId)}-${randomUUID()}`);
    this.assertManagedPath(backupPath);
    cpSync(home, backupPath, { recursive: true, force: false, errorOnExist: true });
    return { agentId, existed: true, backupPath };
  }

  commit(checkpoint: MobileProfileCheckpoint): void {
    if (checkpoint.backupPath) {
      this.assertManagedPath(checkpoint.backupPath);
      rmSync(checkpoint.backupPath, { recursive: true, force: true });
      checkpoint.backupPath = null;
    }
  }

  rollback(checkpoint: MobileProfileCheckpoint): void {
    const home = this.profileHome(checkpoint.agentId);
    this.assertManagedPath(home);
    if (checkpoint.existed && (!checkpoint.backupPath || !existsSync(checkpoint.backupPath))) {
      throw new Error('Cannot restore the previous Hermes profile because its compensation backup is missing');
    }
    rmSync(home, { recursive: true, force: true });
    if (checkpoint.existed && checkpoint.backupPath && existsSync(checkpoint.backupPath)) {
      this.assertManagedPath(checkpoint.backupPath);
      renameSync(checkpoint.backupPath, home);
    }
    checkpoint.backupPath = null;
  }

  discard(agentId: string): void {
    const home = this.profileHome(agentId);
    this.assertManagedPath(home);
    rmSync(home, { recursive: true, force: true });
    this.db.raw.prepare('DELETE FROM mobile_agent_configs WHERE agent_id = ?').run(agentId);
  }

  private hermesBin(): string {
    const row = this.db.raw.prepare("SELECT path FROM engines WHERE id = 'eng-hermes-cli'").get() as { path: string | null } | undefined;
    return row?.path || 'hermes';
  }

  private safeBaseUrl(value: unknown): string | null {
    if (typeof value !== 'string' || !value.trim() || value.length > 2048) return null;
    try {
      const url = new URL(value.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
      return url.toString().replace(/\/$/, '');
    } catch {
      return null;
    }
  }

  private safeName(value: unknown, max = 200): string | null {
    return typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : null;
  }

  private async readRootModelConfig(): Promise<Record<string, unknown>> {
    const result = await runCli(this.hermesBin(), ['config', 'get', 'model', '--json'], {
      timeoutMs: 15_000,
      env: { ...process.env, HERMES_HOME: this.hermesRoot }
    });
    if (!result.ok || !result.stdout.trim()) return {};
    try {
      const parsed = JSON.parse(result.stdout) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  private async buildManagedConfig(agent: Agent): Promise<Record<string, unknown>> {
    const root = await this.readRootModelConfig();
    const rootModel = this.safeName(root.default ?? root.model);
    const rootProvider = this.safeName(root.provider, 80);
    const rootBaseUrl = this.safeBaseUrl(root.base_url);

    let injectedBaseUrl: string | null = null;
    let injectedModel: string | null = null;
    if (providerReady(this.db)) {
      const configured = getProviderSettings(this.db);
      injectedBaseUrl = this.safeBaseUrl(configured.baseUrl);
      injectedModel = this.safeName(configured.model);
    } else if (process.env.OPENAI_API_KEY) {
      injectedBaseUrl = this.safeBaseUrl(process.env.OPENAI_BASE_URL ?? process.env.OPENAI_API_BASE);
      injectedModel = this.safeName(process.env.OPENAI_CHAT_MODEL ?? process.env.OPENAI_MODEL);
    }

    const modelOverride = this.safeName(agent.modelOverride);
    const useInjectedProvider = !!injectedBaseUrl && !!injectedModel;
    const config: Record<string, unknown> = {
      model: {
        default: modelOverride ?? injectedModel ?? rootModel ?? 'gpt-4o-mini',
        provider: useInjectedProvider ? 'opcnexus' : rootProvider ?? 'auto',
        ...(!useInjectedProvider && rootBaseUrl ? { base_url: rootBaseUrl } : {})
      },
      plugins: {
        enabled: ['opcnexus-android'],
        disabled: [],
        entries: { 'opcnexus-android': { allow_tool_override: false } }
      }
    };
    if (useInjectedProvider) {
      config.providers = {
        opcnexus: {
          name: 'OPC-Nexus',
          api: injectedBaseUrl,
          key_env: 'OPENAI_API_KEY',
          default_model: modelOverride ?? injectedModel,
          transport: 'chat_completions'
        }
      };
    }
    return config;
  }

  async ensure(agent: Agent): Promise<string> {
    if (agent.kind !== 'android_operator') throw new Error('Only Android operators have a mobile Hermes profile');
    const name = this.profileName(agent.id);
    const home = this.profileHome(agent.id);
    const checkpoint = this.checkpoint(agent.id);
    try {
      if (!existsSync(home)) {
        await new Promise<void>((resolve, reject) => {
          const child = spawnCli(this.hermesBin(), ['profile', 'create', name, '--no-alias', '--no-skills', '--description', `OPC-Nexus Android operator ${agent.name}`], {
            shell: false,
            windowsHide: true,
            env: { ...process.env, HERMES_HOME: this.hermesRoot }
          });
          const stderrOutput = createProcessOutputBuffer();
          let stderr = '';
          child.stderr?.on('data', (chunk: Buffer) => appendProcessOutput(stderrOutput, chunk));
          child.once('error', reject);
          child.once('close', (code) => {
            stderr = finishProcessOutput(stderrOutput);
            code === 0 ? resolve() : reject(new Error(`Hermes profile creation failed (${code}): ${stderr.slice(0, 300)}`));
          });
        });
      }

      mkdirSync(home, { recursive: true });
      mkdirSync(join(home, 'plugins'), { recursive: true });
      mkdirSync(join(home, 'memories'), { recursive: true });
      writeFileSync(join(home, '.no-bundled-skills'), '', 'utf8');
      writeFileSync(join(home, 'SOUL.md'), agent.soulMd || agent.systemPrompt || `You are ${agent.name}.`, 'utf8');
      writeFileSync(join(home, 'AGENTS.md'), agent.agentsMd || 'Operate only the Android device assigned by OPC-Nexus.', 'utf8');
      writeFileSync(join(home, 'USER.md'), agent.userMd || '', 'utf8');
      writeFileSync(join(home, 'memories', 'USER.md'), agent.userMd || '', 'utf8');

      const resources = mobileResourcesRoot();
      const pluginTarget = join(home, 'plugins', 'opcnexus-android');
      cpSync(join(resources, 'hermes-plugin'), pluginTarget, { recursive: true, force: true });
      copyFileSync(join(resources, 'tool-catalog.json'), join(pluginTarget, 'tool-catalog.json'));

      // Hermes creates an empty per-profile .env. OPC-Nexus injects task-scoped
      // credentials into the child process and lets Hermes use global auth.json's
      // native profile fallback, so neither secret file belongs in this profile.
      rmSync(join(home, '.env'), { force: true });
      rmSync(join(home, 'auth.json'), { force: true });

      const managedConfig = await this.buildManagedConfig(agent);
      // JSON is valid YAML. Keep the generated profile structured so arbitrary
      // root config keys such as inline credentials and headers are never copied.
      writeFileSync(
        join(home, 'config.yaml'),
        `# Managed by OPC-Nexus. Credentials are injected into the task process only.\n${JSON.stringify(managedConfig, null, 2)}\n`,
        'utf8'
      );

      const now = Date.now();
      this.db.raw.prepare(
        `INSERT INTO mobile_agent_configs(agent_id, device_id, hermes_profile, allowed_tools_json, authorization_confirmed_at, created_at, updated_at)
         VALUES(?, NULL, ?, '[]', NULL, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET hermes_profile = excluded.hermes_profile, updated_at = excluded.updated_at`
      ).run(agent.id, name, now, now);
      this.commit(checkpoint);
      return home;
    } catch (error) {
      this.rollback(checkpoint);
      throw error;
    }
  }
}
