/**
 * 人性化工具：把技术性的任务错误翻译成人话 + 建议动作。
 * 用于收件箱、任务详情、失败体验，让用户看得懂"为什么失败、该怎么办"。
 */

export interface HumanizedError {
  /** 人话原因（一句话） */
  reason: string;
  /** 建议动作（可选，引导用户下一步） */
  suggestion: string;
  /** 严重度（用于配色） */
  severity: 'info' | 'warn' | 'danger';
}

interface ErrorPattern {
  test: (err: string, stage: string) => boolean;
  reason: string;
  suggestion: string;
  severity: HumanizedError['severity'];
}

const PATTERNS: ErrorPattern[] = [
  {
    test: (e) => /轮次超限|轮次|round limit|max.*rounds|工具调用轮次/i.test(e),
    reason: '执行轮次超限：这个任务太复杂，助手来回调用工具的次数超过了上限被终止。',
    suggestion: '把任务拆小一些，或分步交代清楚，减少助手反复试探。',
    severity: 'warn'
  },
  {
    test: (e) => /超时|timeout|timed out|ETIMEDOUT/i.test(e),
    reason: '执行超时：这次任务花的时间超出了上限，被强制中断了。',
    suggestion: '可以把任务拆小一些，或在团队配置里调大单步超时后重试。',
    severity: 'warn'
  },
  {
    test: (e) => /审批被拒绝|approval.*reject|rejected/i.test(e),
    reason: '审批被拒绝：这个操作需要人工批准，但被拒绝了，任务随之终止。',
    suggestion: '如果这是误操作，可以重新发起任务并在审批弹出时批准。',
    severity: 'info'
  },
  {
    test: (e) => /未就绪|未配置|not ready|not configured|AUTH_REQUIRED|未安装|not installed|no engine|引擎/i.test(e),
    reason: '引擎未就绪：负责干活的引擎还没装好或没登录，没法执行。',
    suggestion: '到「引擎中心」完成引擎安装 / 登录，或为该员工换一个可用引擎。',
    severity: 'danger'
  },
  {
    test: (e) => /401|403|invalid.*key|api key|unauthorized|密钥|凭据|authentication/i.test(e),
    reason: '认证失败：模型的 API Key 无效或已过期。',
    suggestion: '到「设置 → 模型供应商」检查并更新对应供应商的 API Key。',
    severity: 'danger'
  },
  {
    test: (e) => /429|rate limit|限流|quota|too many requests|频率/i.test(e),
    reason: '被限流：请求太频繁或额度用尽，被供应商暂时拒绝了。',
    suggestion: '稍等片刻再重试，或检查供应商账户额度。',
    severity: 'warn'
  },
  {
    test: (e) => /网络|network|ECONNREFUSED|ENOTFOUND|fetch failed|connection/i.test(e),
    reason: '网络问题：连不上模型服务或相关资源。',
    suggestion: '检查网络连接 / 代理设置后重试。',
    severity: 'warn'
  },
  {
    test: (e) => /客户端异常退出|中断|interrupt|crash/i.test(e),
    reason: '意外中断：应用在执行期间被关闭或崩溃，任务没跑完。',
    suggestion: '重新发起任务即可；系统会尽量从断点续跑。',
    severity: 'warn'
  },
  {
    test: (e) => /不存在|not found|no such|missing/i.test(e),
    reason: '找不到所需资源：任务依赖的某个对象（员工 / 文件 / 配置）不存在。',
    suggestion: '检查任务依赖的员工和配置是否完整。',
    severity: 'warn'
  }
];

/** 将任务错误翻译为人话 + 建议。无错误时返回 null。 */
export function humanizeTaskError(error: string | null | undefined, stage = ''): HumanizedError | null {
  if (!error) return null;
  const err = String(error);
  for (const p of PATTERNS) {
    if (p.test(err, stage)) {
      return { reason: p.reason, suggestion: p.suggestion, severity: p.severity };
    }
  }
  // 兜底：保留原始错误，给出通用建议
  return {
    reason: `执行出错：${err.slice(0, 120)}`,
    suggestion: '可以重试一次；若反复失败，请检查引擎与任务配置。',
    severity: 'danger'
  };
}
