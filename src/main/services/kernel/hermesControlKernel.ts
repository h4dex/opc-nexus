import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from '../database.js';
import { runCli } from '../cliLauncher.js';
import { childProcessEnv, redactSensitiveText } from '../engineEnv.js';
import { HermesRuntimeProfileService } from '../hermesRuntimeProfile.js';
import { parseHermesQuietSessionId } from '../hermesCliProtocol.js';
import { buildPlanningPrompt, parseDispatchPlanDraft } from './planningPrompt.js';
import type { AdvisorAdvice, ControlKernel, DispatchPlanDraft, KernelRequest, KernelSessionStore } from './types.js';

type RunCliResult = Awaited<ReturnType<typeof runCli>>;
type KernelRunner = (binPath: string, args: string[], opts: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<RunCliResult>;

const NO_SESSIONS: KernelSessionStore = { get: () => null, set: () => {} };
const HERMES_FAILURE_RE = /HTTP\s+(?:400|401|403|408|409|422|429|5\d\d)\b|missing authentication|unauthorized|forbidden|invalid.*key|no usable credentials|api call failed/i;
const HERMES_AUTH_FAILURE_RE = /HTTP\s+(?:401|403)\b|missing authentication|unauthorized|forbidden|invalid.*key|no usable credentials/i;

export interface HermesEngineHealthReporter {
  reportAuthenticationFailure(engineId: string, detail: string): void;
}

const NO_HEALTH_REPORTER: HermesEngineHealthReporter = { reportAuthenticationFailure: () => {} };

interface HermesControlUsage {
  session_id?: unknown;
  failed?: unknown;
  failure?: unknown;
}

export class HermesControlKernel implements ControlKernel {
  readonly id = 'hermes' as const;
  private readonly profileTails = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Database,
    private readonly profiles = new HermesRuntimeProfileService(db),
    private readonly sessions: KernelSessionStore = NO_SESSIONS,
    private readonly runner: KernelRunner = runCli,
    private readonly health: HermesEngineHealthReporter = NO_HEALTH_REPORTER
  ) {}

  isReady(): boolean {
    const row = this.db.raw.prepare('SELECT status FROM engines WHERE id = ?').get('eng-hermes-cli') as { status: string } | undefined;
    return row?.status === 'HEALTHY';
  }

  async plan(request: KernelRequest, advice: AdvisorAdvice[]): Promise<DispatchPlanDraft> {
    const runtime = this.profiles.ensureController(
      request.organizationId,
      request.principalId,
      request.conversationId
    );
    const prompt = buildPlanningPrompt(request, advice);
    const usageFile = join(tmpdir(), `opc-hermes-control-${randomUUID()}.json`);
    const previousSession = this.sessions.get(request.conversationId, this.id);
    const args = previousSession
      ? [
          'chat', '-Q', '-q', prompt,
          '-t', 'todo',
          '-m', runtime.model,
          '--provider', runtime.provider,
          '--resume', previousSession,
          '--no-restore-cwd'
        ]
      : [
          '-z', prompt,
          '--usage-file', usageFile,
          '-t', 'todo',
          '-m', runtime.model,
          '--provider', runtime.provider
        ];

    const engine = this.db.raw.prepare('SELECT path FROM engines WHERE id = ?').get('eng-hermes-cli') as
      | { path: string | null }
      | undefined;
    const env = childProcessEnv(runtime.env);
    const { run, usage } = await this.withProfileLock(runtime.home, async () => {
      try {
        const result = await this.runner(engine?.path || 'hermes', args, {
        timeoutMs: 120_000,
        cwd: runtime.home,
          env
        });
        return { run: result, usage: this.readUsage(usageFile) };
      } finally {
        rmSync(usageFile, { force: true });
      }
    });

    const sessionId = typeof usage?.session_id === 'string' && /^[^\s]{1,200}$/.test(usage.session_id)
      ? usage.session_id
      : parseHermesQuietSessionId(run.stderr);
    const usageFailure = typeof usage?.failure === 'string' ? usage.failure.trim() : '';
    const diagnostic = redactSensitiveText(
      [usageFailure, run.stderr, run.error].filter(Boolean).join('\n'),
      env
    ).trim();
    const explicitFailure = run.code !== 0 || usage?.failed === true;
    if (explicitFailure) {
      const stdoutDetail = redactSensitiveText(run.stdout || '', env).trim();
      const detail = diagnostic || stdoutDetail;
      this.reportAuthenticationFailure(diagnostic, stdoutDetail);
      throw new Error(`Hermes planning failed${run.code === null ? '' : ` (${run.code})`}: ${detail.slice(0, 500) || 'no output'}`);
    }

    let plan: DispatchPlanDraft;
    try {
      plan = parseDispatchPlanDraft(run.stdout);
    } catch (error) {
      // Hermes can occasionally return an upstream error body with exit code 0.
      // Inspect stdout only after it has failed the DispatchPlan contract, so a
      // valid objective mentioning an HTTP/auth error is never rejected.
      const detail = [diagnostic, redactSensitiveText(run.stdout || '', env).trim()].filter(Boolean).join('\n');
      if (HERMES_FAILURE_RE.test(detail)) {
        this.reportAuthenticationFailure(diagnostic, redactSensitiveText(run.stdout || '', env).trim());
        throw new Error(`Hermes planning failed${run.code === null ? '' : ` (${run.code})`}: ${detail.slice(0, 500) || 'no output'}`);
      }
      throw error;
    }
    if (sessionId) this.sessions.set(request.conversationId, this.id, sessionId);
    return plan;
  }

  private reportAuthenticationFailure(...candidates: string[]): void {
    const detail = candidates.find((candidate) => HERMES_AUTH_FAILURE_RE.test(candidate));
    if (!detail) return;
    this.health.reportAuthenticationFailure('eng-hermes-cli', detail.slice(0, 2_000));
  }

  private readUsage(path: string): HermesControlUsage | null {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return value && typeof value === 'object' && !Array.isArray(value)
        ? value as HermesControlUsage
        : null;
    } catch {
      return null;
    }
  }

  private async withProfileLock<T>(profileHome: string, run: () => Promise<T>): Promise<T> {
    const previous = this.profileTails.get(profileHome) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    this.profileTails.set(profileHome, tail);
    await previous.catch(() => {});
    try {
      return await run();
    } finally {
      release();
      if (this.profileTails.get(profileHome) === tail) this.profileTails.delete(profileHome);
    }
  }
}
