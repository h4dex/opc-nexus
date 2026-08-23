import type {
  HermesChatActivity,
  HermesProjectChatMessage
} from '../../shared/types.js';

const SENSITIVE_KEY = /api.?key|access.?token|auth(?:orization)?|cookie|credential|lease.?token|pass(?:word|phrase)|private.?key|secret/i;
const MAX_DETAIL_CHARS = 12_000;

function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gi, '[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret|credential|private[_-]?key)\s*[:=]\s*["']?)[^\s"',;]{4,}/gi, '$1[REDACTED]');
}

function safeValue(value: unknown, depth = 0): unknown {
  if (depth >= 8) return '[TRUNCATED]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeValue(item, depth + 1));
  if (!value || typeof value !== 'object') return String(value);
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : safeValue(child, depth + 1);
  }
  return output;
}

export function safeHermesActivityDetail(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  let safe: unknown = value;
  if (typeof value === 'string') {
    try { safe = safeValue(JSON.parse(value) as unknown); }
    catch { safe = redactText(value); }
  } else {
    safe = safeValue(value);
  }
  let encoded: string;
  try {
    encoded = typeof safe === 'string' ? safe : JSON.stringify(safe, null, 2);
  } catch {
    encoded = '[无法安全显示执行详情]';
  }
  if (encoded.length <= MAX_DETAIL_CHARS) return encoded;
  return `${encoded.slice(0, MAX_DETAIL_CHARS)}\n...[TRUNCATED]`;
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value < 10_000_000_000 ? value * 1_000 : value;
}

function toolNameFromCall(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '未知工具';
  const call = value as Record<string, unknown>;
  const fn = call.function && typeof call.function === 'object' && !Array.isArray(call.function)
    ? call.function as Record<string, unknown>
    : {};
  const name = String(fn.name ?? call.name ?? '').trim();
  return name && name.length <= 160 ? name : '未知工具';
}

function activityId(messageId: string, suffix: string): string {
  return `${messageId}:${suffix}`.slice(0, 320);
}

/** Convert the rich Hermes transcript into a bounded, credential-safe Renderer projection. */
export function projectHermesChatMessages(
  data: readonly unknown[],
  sessionId: string
): HermesProjectChatMessage[] {
  return data.slice(-500).flatMap((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const role = String(record.role ?? '');
    if (!['user', 'assistant', 'system', 'tool'].includes(role)) return [];
    const id = typeof record.id === 'string' && record.id.trim()
      ? record.id.trim()
      : `${sessionId}-${index}`;
    const timestamp = timestampMs(record.timestamp);
    const rawContent = typeof record.content === 'string' ? record.content.trim() : '';
    const activities: HermesChatActivity[] = [];
    const calls = Array.isArray(record.tool_calls) ? record.tool_calls : [];

    const reasoning = [record.reasoning_content, record.reasoning]
      .find((value) => typeof value === 'string' && value.trim());
    if (typeof reasoning === 'string') {
      const toolNames = calls.map(toolNameFromCall).filter((name) => name !== '未知工具');
      activities.push({
        id: activityId(id, 'reasoning'),
        kind: 'reasoning',
        title: '已完成分析',
        status: 'completed',
        toolName: null,
        detail: toolNames.length > 0
          ? `已分析任务边界并决定调用：${[...new Set(toolNames)].join('、')}`
          : '已分析任务边界并形成本轮响应。',
        startedAt: timestamp,
        updatedAt: timestamp
      });
    }

    calls.forEach((call, callIndex) => {
      const callRecord = call && typeof call === 'object' && !Array.isArray(call)
        ? call as Record<string, unknown>
        : {};
      const fn = callRecord.function && typeof callRecord.function === 'object' && !Array.isArray(callRecord.function)
        ? callRecord.function as Record<string, unknown>
        : {};
      const toolName = toolNameFromCall(call);
      activities.push({
        id: activityId(id, `tool-call-${callIndex}`),
        kind: 'tool_call',
        title: `调用工具 · ${toolName}`,
        status: 'completed',
        toolName,
        detail: safeHermesActivityDetail(fn.arguments ?? callRecord.arguments),
        startedAt: timestamp,
        updatedAt: timestamp
      });
    });

    if (role === 'tool') {
      const toolName = String(record.tool_name ?? record.name ?? '工具').trim().slice(0, 160) || '工具';
      const failed = /(?:^|\b)(?:error|failed|exception|traceback)(?:\b|:)|错误|失败|异常/i.test(rawContent);
      activities.push({
        id: activityId(id, 'tool-result'),
        kind: 'tool_result',
        title: `${failed ? '工具失败' : '工具返回'} · ${toolName}`,
        status: failed ? 'failed' : 'completed',
        toolName,
        detail: safeHermesActivityDetail(rawContent),
        startedAt: timestamp,
        updatedAt: timestamp
      });
    }

    if (role === 'system') {
      activities.push({
        id: activityId(id, 'system'),
        kind: 'system',
        title: '系统上下文已应用',
        status: 'completed',
        toolName: null,
        detail: null,
        startedAt: timestamp,
        updatedAt: timestamp
      });
    }

    const content = role === 'system' || role === 'tool' ? '' : rawContent;
    if (!content && activities.length === 0) return [];
    return [{
      id,
      role: role as HermesProjectChatMessage['role'],
      content,
      timestamp,
      activities
    }];
  });
}
