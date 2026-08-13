import { describe, expect, it } from 'vitest';
import type { TaskEvent } from '../src/shared/types.js';
import {
  appendTaskOutput,
  compactTaskEvents,
  MAX_RENDER_OUTPUT_CHARS,
  MAX_RENDER_TASK_EVENTS
} from '../src/renderer/src/utils/taskEvents.js';

function event(id: string, eventType: string, payload: Record<string, unknown>, taskId = 'task-1'): TaskEvent {
  return { id, taskId, eventType, payload, createdAt: Number(id.replace(/\D/g, '')) || 1 };
}

function renderedOutput(events: TaskEvent[], taskId = 'task-1'): string {
  return events
    .filter((item) => item.eventType === 'output' && item.taskId === taskId)
    .map((item) => String(item.payload.chunk ?? item.payload.text ?? ''))
    .join('');
}

describe('renderer task-event bounds', () => {
  it('merges adjacent output events and preserves non-output events', () => {
    const compacted = compactTaskEvents([
      event('1', 'output', { chunk: '今天' }),
      event('2', 'output', { chunk: '热点' }),
      event('3', 'stage', { stage: '搜索' }),
      event('4', 'output', { chunk: '完成' })
    ]);

    expect(compacted).toHaveLength(3);
    expect(compacted[0].payload.chunk).toBe('今天热点');
    expect(compacted[1].eventType).toBe('stage');
    expect(compacted[2].payload.chunk).toBe('完成');
  });

  it('keeps a global output budget even when stage and tool events interleave', () => {
    let events: TaskEvent[] = [event('1', 'output', { chunk: 'a'.repeat(MAX_RENDER_OUTPUT_CHARS - 2) })];
    events.push(event('2', 'tool_call', { name: 'android_click' }));
    events = appendTaskOutput(events, 'task-1', 'bcdef');
    events.push(event('3', 'stage', { stage: '校验结果' }));
    events = appendTaskOutput(events, 'task-1', 'more output must be dropped');

    const output = renderedOutput(events);
    expect(output.replace('\n[输出已截断]', '')).toHaveLength(MAX_RENDER_OUTPUT_CHARS);
    expect(output.match(/\[输出已截断\]/g)).toHaveLength(1);
    expect(events.some((item) => item.eventType === 'tool_call')).toBe(true);
    expect(events.some((item) => item.eventType === 'stage')).toBe(true);
  });

  it('limits compacted event count and output text', () => {
    const input = Array.from({ length: MAX_RENDER_TASK_EVENTS + 50 }, (_, index) =>
      event(String(index + 1), index % 2 === 0 ? 'output' : 'progress', index % 2 === 0
        ? { chunk: 'x'.repeat(1_000) }
        : { progress: index })
    );
    const compacted = compactTaskEvents(input);
    expect(compacted.length).toBeLessThanOrEqual(MAX_RENDER_TASK_EVENTS);
    expect(renderedOutput(compacted).replace('\n[输出已截断]', '').length).toBeLessThanOrEqual(MAX_RENDER_OUTPUT_CHARS);
  });

  it('tracks independent output budgets for different tasks', () => {
    const compacted = compactTaskEvents([
      event('1', 'output', { chunk: 'a'.repeat(MAX_RENDER_OUTPUT_CHARS) }, 'task-1'),
      event('2', 'output', { chunk: 'b'.repeat(MAX_RENDER_OUTPUT_CHARS) }, 'task-2')
    ]);
    expect(renderedOutput(compacted, 'task-1')).toHaveLength(MAX_RENDER_OUTPUT_CHARS);
    expect(renderedOutput(compacted, 'task-2')).toHaveLength(MAX_RENDER_OUTPUT_CHARS);
  });
});
