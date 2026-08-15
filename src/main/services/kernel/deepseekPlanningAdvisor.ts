import type { Database } from '../database.js';
import {
  deepseekHarnessCommand,
  deepseekHarnessProbeEnv,
  deepseekHarnessRuntimePaths
} from '../deepseekHarnessRuntime.js';
import { harnessProviderVerificationIsCurrent } from '../harnessProviderVerification.js';
import { probeAcpTask } from '../executor/acpExecutor.js';
import { defaultShouldUsePlanningAdvisor } from './kernelRouter.js';
import { parseKernelJsonObject } from './planningPrompt.js';
import type {
  AdvisorAdvice,
  AdvisorReview,
  DispatchPlanDraft,
  KernelRequest,
  PlanningAdvisor
} from './types.js';

type Probe = typeof probeAcpTask;
const ADVISOR_TIMEOUT_MS = 45_000;

export class DeepSeekPlanningAdvisor implements PlanningAdvisor {
  readonly id = 'deepseek-harness' as const;

  constructor(
    private readonly db: Database,
    private readonly probe: Probe = probeAcpTask,
    private readonly command: () => string[] | null = deepseekHarnessCommand,
    private readonly env: (db: Database) => Record<string, string> = deepseekHarnessProbeEnv,
    private readonly cwd: () => string = () => deepseekHarnessRuntimePaths().root
  ) {}

  isReady(): boolean {
    const row = this.db.raw.prepare('SELECT status FROM engines WHERE id = ?').get('eng-deepseek-harness') as { status: string } | undefined;
    return row?.status === 'HEALTHY' && harnessProviderVerificationIsCurrent(this.db) && this.command() !== null;
  }

  shouldAdvise(request: KernelRequest): boolean {
    return defaultShouldUsePlanningAdvisor(request);
  }

  async advise(request: KernelRequest): Promise<AdvisorAdvice> {
    const prompt = [
      'Act only as a planning advisor for OPC-Nexus. Do not execute work and do not call tools.',
      'Analyze decomposition, risks, dependencies, and acceptance checks. Your text is advisory and cannot dispatch workers.',
      'REQUEST_JSON:',
      JSON.stringify({ message: request.message, workers: request.workers, memories: request.memories, projectId: request.projectId })
    ].join('\n');
    return { advisorId: this.id, summary: await this.run(prompt) };
  }

  async review(request: KernelRequest, plan: DispatchPlanDraft): Promise<AdvisorReview> {
    const prompt = [
      'Review this proposed OPC-Nexus dispatch plan. Do not execute work and do not call tools.',
      'Return JSON only: {"accepted":true,"summary":"concise risks or improvements"}. Your review is non-authoritative.',
      'REVIEW_JSON:',
      JSON.stringify({ message: request.message, eligibleWorkerIds: request.workers.map((worker) => worker.agentId), plan })
    ].join('\n');
    const parsed = parseKernelJsonObject(await this.run(prompt));
    return {
      advisorId: this.id,
      accepted: parsed.accepted === true,
      summary: String(parsed.summary ?? '').trim()
    };
  }

  private async run(prompt: string): Promise<string> {
    const command = this.command();
    if (!command) throw new Error('DeepSeek Harness sidecar is unavailable');
    const result = await this.probe(command, this.env(this.db), this.cwd(), ADVISOR_TIMEOUT_MS, {
      managedHarness: true,
      prompt,
      maxOutputChars: 8_000
    });
    if (!result.ok) throw new Error(result.message);
    const output = result.output.trim();
    if (!output) throw new Error('DeepSeek Harness returned empty advice');
    return output;
  }
}
