/**
 * 语音指令解析：把一句自然语言映射为「派给谁、做什么」。
 *
 * 设计取舍：这里刻意**不调用 LLM**。
 * 语音下达要求即时反馈（说完就要看到解析结果），走一次模型请求会引入秒级延迟与额外成本，
 * 且解析结果还要用户确认，规则解析的偏差用户能当场纠正。
 * 复杂指令仍可由目标员工的引擎在执行时理解——这里只负责路由与标题提取。
 *
 * @author liyingjie <y@senke.com>
 */
import type { VoiceCommandDraft } from '../../shared/types.js';

/** 点名动词前缀：让/叫/请/派/安排 + 员工名 + 任务
 *  注意不用通用字符类去「猜」名字边界——中文没有分词空格，
 *  `([^\s]{2,20})` 这类贪婪模式会把整句吞掉只剩最后一个字。
 *  正确做法是以**已知员工名**为锚点切分。 */
const CALL_VERB = /^(?:请|让|叫|派|安排)\s*/;
/** 员工名之后、任务内容之前的连接词与标点 */
const AFTER_NAME = /^\s*(?:[，,：:、]\s*)?(?:去|来|帮我|帮忙|负责)?\s*/;

/** 需要从任务标题里剥掉的礼貌性前缀 */
const POLITE_PREFIX = /^(?:麻烦|帮我|帮忙|请|你|去|来)\s*/;

/** 语音转写常见的口头语与结尾语气词 */
const FILLER = /^(?:那个|然后|就是|嗯+|呃+|额+)\s*/;

export interface AgentRef {
  id: string;
  name: string;
}

/** 规范化：去空白、全角标点转半角，便于匹配 */
function normalize(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[［【]/g, '[')
    .replace(/[］】]/g, ']')
    .trim();
}

/** 清理任务标题：剥掉口头语与礼貌前缀，去掉句末标点 */
function cleanTitle(raw: string): string {
  let s = raw.trim();
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(FILLER, '').replace(POLITE_PREFIX, '');
    if (s === before) break;
  }
  return s.replace(/[。.！!？?，,、；;]+$/, '').trim();
}

/**
 * 以员工名为锚点在文本中定位。返回命中的员工、匹配到的字面量与位置。
 * 优先精确匹配长名（避免「测试」抢掉「测试验证助手」），
 * 再退到去掉「助手/员工」等通用后缀的核心词（语音常把名字说短）。
 */
function locateAgent(
  text: string,
  agents: AgentRef[]
): { agent: AgentRef; matched: string; index: number } | null {
  const sorted = [...agents].sort((a, b) => b.name.length - a.name.length);
  for (const a of sorted) {
    const i = text.indexOf(a.name);
    if (i >= 0) return { agent: a, matched: a.name, index: i };
  }
  for (const a of sorted) {
    const core = a.name.replace(/(助手|员工|专家|机器人)$/, '');
    if (core.length < 2) continue;
    const i = text.indexOf(core);
    if (i >= 0) return { agent: a, matched: core, index: i };
  }
  return null;
}

/**
 * 解析一句语音指令。
 * @param rawText  识别到的原始文本
 * @param agents   可派发的在岗员工
 * @param defaultAgentId 未点名时的默认员工（无则返回 null 由用户在确认界面选择）
 */
export function parseVoiceCommand(
  rawText: string,
  agents: AgentRef[],
  defaultAgentId: string | null = null
): VoiceCommandDraft {
  // 先剥掉句首口头语（「那个，」「然后，」），否则点名动词不在句首会漏判
  let text = normalize(rawText);
  for (let i = 0; i < 3; i++) {
    const before = text;
    text = text.replace(FILLER, '').replace(/^[，,、]\s*/, '');
    if (text === before) break;
  }
  const empty: VoiceCommandDraft = {
    rawText, title: '', agentId: null, agentName: null, matchedBy: 'none'
  };
  if (!text) return empty;

  // 1) 以员工名为锚点：名字前只允许点名动词/@/空白，名字后即任务内容
  const hit = locateAgent(text, agents);
  if (hit) {
    const before = text.slice(0, hit.index);
    const after = text.slice(hit.index + hit.matched.length);
    // 名字前若只有点名动词、@ 或空白，视为标准点名句式
    const prefixOk = /^\s*(?:@\s*)?$/.test(before.replace(CALL_VERB, ''));
    const title = cleanTitle(after.replace(AFTER_NAME, ''));
    if (prefixOk && title) {
      return { rawText, title, agentId: hit.agent.id, agentName: hit.agent.name, matchedBy: 'mention' };
    }
    // 名字出现在句中（如「这周报表让文档助手做」）：剥离名字与点名动词后取余下内容
    if (title || before.trim()) {
      const merged = cleanTitle(`${before.replace(CALL_VERB, '')} ${after.replace(AFTER_NAME, '')}`.replace(/\s+/g, ' '));
      if (merged) {
        return { rawText, title: merged, agentId: hit.agent.id, agentName: hit.agent.name, matchedBy: 'mention' };
      }
    }
    // 只说了名字没说事情：不产出空任务，交由确认界面补充
    return { ...empty, agentId: hit.agent.id, agentName: hit.agent.name, matchedBy: 'mention' };
  }

  // 2) 未点名：回落默认员工，任务内容取整句
  const title = cleanTitle(text);
  if (!title) return empty;
  const fallback = defaultAgentId ? agents.find((a) => a.id === defaultAgentId) ?? null : null;
  return {
    rawText,
    title,
    agentId: fallback?.id ?? null,
    agentName: fallback?.name ?? null,
    matchedBy: fallback ? 'default' : 'none'
  };
}
