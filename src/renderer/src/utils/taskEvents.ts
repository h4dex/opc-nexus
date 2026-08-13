import type { TaskEvent } from '@shared/types';

/** Keep the renderer's event tree bounded even when the main process is busy. */
export const MAX_RENDER_TASK_EVENTS = 240;
export const MAX_RENDER_OUTPUT_CHARS = 96 * 1024;
const OUTPUT_TRUNCATED_MARKER = '\n[输出已截断]';

function outputText(event: TaskEvent): string {
  return String(event.payload.chunk ?? event.payload.text ?? '');
}

function outputChars(events: TaskEvent[], taskId: string): number {
  let total = 0;
  for (const event of events) {
    if (event.eventType === 'output' && event.taskId === taskId) {
      total += outputText(event).replace(OUTPUT_TRUNCATED_MARKER, '').length;
    }
  }
  return total;
}

function hasTruncationMarker(events: TaskEvent[], taskId: string): boolean {
  return events.some((event) =>
    event.eventType === 'output'
    && event.taskId === taskId
    && outputText(event).includes(OUTPUT_TRUNCATED_MARKER)
  );
}

function markOutputTruncated(events: TaskEvent[], taskId: string): TaskEvent[] {
  if (hasTruncationMarker(events, taskId)) return events;
  const next = events.slice();
  for (let index = next.length - 1; index >= 0; index--) {
    const event = next[index];
    if (event.eventType !== 'output' || event.taskId !== taskId) continue;
    next[index] = {
      ...event,
      payload: { ...event.payload, chunk: `${outputText(event)}${OUTPUT_TRUNCATED_MARKER}` }
    };
    break;
  }
  return next;
}

/**
 * Merge adjacent output events before React renders them. CLI/LLM streams can
 * produce hundreds of small chunks; one Markdown node per chunk is both costly
 * and visually noisy.
 */
export function compactTaskEvents(input: TaskEvent[]): TaskEvent[] {
  const result: TaskEvent[] = [];
  const outputCharsByTask = new Map<string, number>();
  const truncatedTasks = new Set<string>();

  for (const event of input) {
    if (event.eventType !== 'output') {
      result.push(event);
      continue;
    }

    const text = outputText(event);
    if (!text) continue;
    const currentChars = outputCharsByTask.get(event.taskId) ?? 0;
    const remaining = MAX_RENDER_OUTPUT_CHARS - currentChars;
    if (remaining <= 0) {
      truncatedTasks.add(event.taskId);
      continue;
    }
    const accepted = text.slice(0, remaining);
    outputCharsByTask.set(event.taskId, currentChars + accepted.length);
    const previous = result[result.length - 1];
    if (previous?.eventType === 'output' && previous.taskId === event.taskId) {
      result[result.length - 1] = {
        ...previous,
        createdAt: event.createdAt,
        payload: { ...previous.payload, chunk: outputText(previous) + accepted }
      };
    } else {
      result.push({ ...event, payload: { ...event.payload, chunk: accepted } });
    }
    if (accepted.length < text.length) truncatedTasks.add(event.taskId);
  }

  let bounded = result;
  for (const taskId of truncatedTasks) {
    bounded = markOutputTruncated(bounded, taskId);
  }

  return bounded.length > MAX_RENDER_TASK_EVENTS
    ? bounded.slice(-MAX_RENDER_TASK_EVENTS)
    : bounded;
}

/** Fast path for the high-frequency live stream. */
export function appendTaskOutput(events: TaskEvent[], taskId: string, chunk: string): TaskEvent[] {
  if (!chunk) return events;
  const remaining = MAX_RENDER_OUTPUT_CHARS - outputChars(events, taskId);
  if (remaining <= 0) return markOutputTruncated(events, taskId);

  let next = events.slice();
  const previous = next[next.length - 1];
  const accepted = chunk.slice(0, remaining);
  if (previous?.eventType === 'output' && previous.taskId === taskId) {
    const current = outputText(previous);
    next[next.length - 1] = {
      ...previous,
      createdAt: Date.now(),
      payload: { ...previous.payload, chunk: current + accepted }
    };
  } else {
    next.push({
      id: `stream-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      taskId,
      eventType: 'output',
      payload: { chunk: accepted },
      createdAt: Date.now()
    });
  }
  if (accepted.length < chunk.length) next = markOutputTruncated(next, taskId);
  return next.length > MAX_RENDER_TASK_EVENTS ? next.slice(-MAX_RENDER_TASK_EVENTS) : next;
}
