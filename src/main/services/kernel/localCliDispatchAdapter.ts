import { DSH_MANAGED_ENGINE_ID } from '../../../shared/types.js';
import type { AdvisorAdvice, ControlKernel, DispatchPlanDraft, KernelRequest } from './types.js';

const HIGH_RISK_RE = /(?:删除|清空|覆盖|格式化|付款|转账|采购|下单|发布|部署|安装|卸载|上传|导出|外发|授权|提权|管理员|发信|群发|delete|remove|overwrite|truncate|drop\s+(?:table|database)|format\s+(?:disk|drive)|diskpart|pay|transfer|purchase|deploy|publish|install|uninstall|upload|exfiltrat|export|grant|chmod|chown|admin|send\s+(?:an?\s+)?(?:email|message))/i;
const LOW_RISK_RE = /(?:总结|摘要|分析|解释|翻译|分类|提取|整理|草拟|起草|检查|审查|比较|列出|查询|阅读|summari[sz]e|analy[sz]e|explain|translate|classify|extract|organize|draft|review|compare|list|query|read|inspect)/i;

function titleFor(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0].trim().replace(/\s+/g, ' ');
  return (firstLine || '员工任务').slice(0, 200);
}

/**
 * Deterministic adapter for a user-selected Local CLI employee. It does not
 * choose a worker, clarify an objective, split work, or take over when Cordis
 * fails. Those responsibilities belong exclusively to DSH/Cordis.
 */
export class LocalCliDispatchAdapter implements ControlKernel {
  readonly id = 'local-cli' as const;

  isReady(): boolean {
    return true;
  }

  async plan(request: KernelRequest, _advice: AdvisorAdvice[]): Promise<DispatchPlanDraft> {
    if (request.routingMode !== 'direct-worker') {
      throw new Error('Local CLI dispatch requires an explicit direct-worker route');
    }
    if (!request.preferredAgentId) {
      throw new Error('Local CLI dispatch requires an explicitly selected employee');
    }
    const worker = request.workers.find((candidate) => candidate.agentId === request.preferredAgentId);
    if (!worker) throw new Error('The selected Local CLI employee is not eligible');
    if (worker.engineId === DSH_MANAGED_ENGINE_ID) {
      throw new Error('Managed DSH employees must use the Cordis route');
    }

    return {
      workerAgentId: worker.agentId,
      title: titleFor(request.message),
      objective: request.message.trim(),
      rationale: '用户明确选择该员工；治理插件仅执行直达适配，不参与规划或选人。',
      priority: 0,
      expectedOutputs: ['所选员工返回的可核验结果'],
      requiresHumanApproval: HIGH_RISK_RE.test(request.message) || !LOW_RISK_RE.test(request.message),
      memoryProposals: [],
      taskScheduleProposals: []
    };
  }
}
