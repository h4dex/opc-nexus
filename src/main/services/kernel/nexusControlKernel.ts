import type { AdvisorAdvice, ControlKernel, DispatchPlanDraft, KernelRequest, WorkerCandidate } from './types.js';

const HIGH_RISK_RE = /(?:删除|清空|覆盖|格式化|付款|转账|采购|下单|发布|部署|安装|卸载|上传|导出|外发|授权|提权|管理员|发信|群发|delete|remove|overwrite|truncate|drop\s+(?:table|database)|format\s+(?:disk|drive)|diskpart|pay|transfer|purchase|deploy|publish|install|uninstall|upload|exfiltrat|export|grant|chmod|chown|admin|send\s+(?:an?\s+)?(?:email|message))/i;
const LOW_RISK_RE = /(?:总结|摘要|分析|解释|翻译|分类|提取|整理|草拟|起草|检查|审查|比较|列出|查询|阅读|summari[sz]e|analy[sz]e|explain|translate|classify|extract|organize|draft|review|compare|list|query|read|inspect)/i;

function titleFor(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0].trim().replace(/\s+/g, ' ');
  return (firstLine || '渠道任务').slice(0, 200);
}

function searchableTerms(value: string): string[] {
  const normalized = value.normalize('NFKC').toLowerCase();
  const terms: string[] = [...(normalized.match(/[a-z0-9][a-z0-9_-]+/g) ?? [])];
  for (const sequence of normalized.match(/\p{Script=Han}{2,}/gu) ?? []) {
    const chars = [...sequence];
    for (let width = 2; width <= Math.min(4, chars.length); width += 1) {
      for (let index = 0; index + width <= chars.length; index += 1) {
        terms.push(chars.slice(index, index + width).join(''));
      }
    }
  }
  return [...new Set(terms)].filter((term) => term.length <= 80);
}

function workerScore(worker: WorkerCandidate, message: string): number {
  const haystack = `${worker.name} ${worker.role} ${worker.capabilities.join(' ')}`.normalize('NFKC').toLowerCase();
  return searchableTerms(message).reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function chooseWorker(request: KernelRequest): WorkerCandidate {
  const preferred = request.preferredAgentId
    ? request.workers.find((worker) => worker.agentId === request.preferredAgentId)
    : undefined;
  if (preferred) return preferred;

  // Stable sort preserves the eligible-worker order as the final tie breaker.
  return request.workers
    .map((worker, index) => ({ worker, index, score: workerScore(worker, request.message) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0].worker;
}

/**
 * Local, dependency-free fallback control kernel. It deliberately does not
 * call an LLM: a provider outage that disables Hermes must not also disable
 * the final routing path. Worker execution still goes through the selected
 * employee's configured runtime and all Orchestrator gates.
 */
export class NexusControlKernel implements ControlKernel {
  readonly id = 'nexus' as const;

  isReady(): boolean {
    return true;
  }

  async plan(request: KernelRequest, _advice: AdvisorAdvice[]): Promise<DispatchPlanDraft> {
    const worker = chooseWorker(request);
    const usedPreferred = request.preferredAgentId === worker.agentId;
    const requiresHumanApproval = HIGH_RISK_RE.test(request.message) || !LOW_RISK_RE.test(request.message);
    return {
      workerAgentId: worker.agentId,
      title: titleFor(request.message),
      objective: request.message.trim(),
      rationale: usedPreferred
        ? 'Hermes 不可用，Nexus 按渠道绑定选择员工。'
        : 'Hermes 不可用，Nexus 按员工角色与能力进行确定性匹配。',
      priority: 0,
      expectedOutputs: ['返回可核验的任务结果'],
      requiresHumanApproval,
      memoryProposals: [],
      taskScheduleProposals: []
    };
  }
}
