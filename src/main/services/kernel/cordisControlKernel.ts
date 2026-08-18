import { DSH_MANAGED_ENGINE_ID } from '../../../shared/types.js';
import type { AdvisorAdvice, ControlKernel, DispatchPlanDraft, KernelRequest, WorkerCandidate } from './types.js';

function titleFor(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0].trim().replace(/\s+/g, ' ');
  return (firstLine || 'Cordis Quest').slice(0, 200);
}

function selectCordisWorker(request: KernelRequest): WorkerCandidate {
  if (request.routingMode === 'direct-worker') {
    throw new Error('Direct employee conversations must use the Local CLI dispatch adapter');
  }
  const managed = request.workers.filter((worker) => worker.engineId === DSH_MANAGED_ENGINE_ID);
  if (managed.length === 0) throw new Error('No READY DSH/Cordis root worker is available');
  if (request.preferredAgentId) {
    const preferred = request.workers.find((worker) => worker.agentId === request.preferredAgentId);
    if (preferred?.engineId === DSH_MANAGED_ENGINE_ID) return preferred;
  }
  return managed[0];
}

/**
 * Routes the owner's request into one managed DSH root session without doing
 * business planning in the host. Cordis performs clarification, planning and
 * delegation after the durable host dispatch has established project scope.
 */
export class CordisControlKernel implements ControlKernel {
  readonly id = 'cordis' as const;

  isReady(): boolean {
    return true;
  }

  async plan(request: KernelRequest, _advice: AdvisorAdvice[]): Promise<DispatchPlanDraft> {
    const worker = selectCordisWorker(request);
    return {
      workerAgentId: worker.agentId,
      title: titleFor(request.message),
      objective: request.message.trim(),
      rationale: '交给 DSH/Cordis 根会话，由 Cordis 负责澄清、计划和多 Agent 派工。',
      priority: 0,
      expectedOutputs: ['DSH/Cordis 会话中的可验收成果与项目制品'],
      // Tool-level and irreversible actions are approved later by the host
      // policy broker. Blocking this ingress would prevent Cordis from asking
      // its own clarification questions.
      requiresHumanApproval: false,
      memoryProposals: [],
      taskScheduleProposals: []
    };
  }
}
