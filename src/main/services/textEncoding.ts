/**
 * Renderer -> Main text transport.
 *
 * Electron's structured clone normally preserves strings, but an explicit
 * UTF-8 payload keeps user text intact when it crosses older Windows shells
 * or compatibility layers. Plain strings remain accepted for internal callers
 * and older renderer builds.
 */

import { StringDecoder } from 'node:string_decoder';

/** Keep diagnostic process output bounded. A failed CLI must not be able to
 * grow the Electron main process indefinitely through stderr. */
export const MAX_PROCESS_OUTPUT_BYTES = 512 * 1024;
export const MAX_TASK_OUTPUT_CHARS = 128 * 1024;

export interface Utf8TextPayload {
  encoding: 'utf8-base64';
  data: string;
}

/**
 * Decode a child-process stream incrementally. Node may split a UTF-8 code
 * point across arbitrary Buffer chunks; StringDecoder retains those trailing
 * bytes until the next write instead of emitting U+FFFD.
 */
export function createUtf8StreamDecoder(): StringDecoder {
  return new StringDecoder('utf8');
}

export interface ProcessOutputBuffer {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

export function createProcessOutputBuffer(): ProcessOutputBuffer {
  return { chunks: [], bytes: 0, truncated: false };
}

/** Append raw bytes before decoding so UTF-8/GBK detection remains reliable. */
export function appendProcessOutput(
  target: ProcessOutputBuffer,
  chunk: Buffer,
  maxBytes = MAX_PROCESS_OUTPUT_BYTES
): void {
  if (target.bytes >= maxBytes) {
    target.truncated = true;
    return;
  }
  const remaining = maxBytes - target.bytes;
  const part = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  if (part.length > 0) {
    target.chunks.push(part);
    target.bytes += part.length;
  }
  if (part.length < chunk.length) target.truncated = true;
}

export function finishProcessOutput(target: ProcessOutputBuffer): string {
  const text = decodeProcessOutput(Buffer.concat(target.chunks));
  return target.truncated ? `${text}\n[进程输出已截断]` : text;
}

/** Append text to a bounded string assembled from parts without repeated
 * whole-string copies. The state object is intentionally mutable and local to
 * one process/task stream. */
export function appendBoundedText(
  parts: string[],
  state: { length: number; truncated: boolean },
  text: string,
  maxChars = MAX_TASK_OUTPUT_CHARS
): void {
  if (!text || state.length >= maxChars) {
    if (text) state.truncated = true;
    return;
  }
  const remaining = maxChars - state.length;
  const accepted = text.length <= remaining ? text : text.slice(0, remaining);
  if (accepted) {
    parts.push(accepted);
    state.length += accepted.length;
  }
  if (accepted.length < text.length) state.truncated = true;
}

export function boundedText(parts: string[], state: { length: number; truncated: boolean }): string {
  const text = parts.join('');
  return state.truncated ? `${text}\n[输出已截断]` : text;
}

/** Decode a complete process output buffer, including Chinese Windows cmd output. */
export function decodeProcessOutput(buffer: Buffer): string {
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch {
    return utf8;
  }
}

function isUtf8TextPayload(value: unknown): value is Utf8TextPayload {
  return !!value
    && typeof value === 'object'
    && (value as Record<string, unknown>).encoding === 'utf8-base64'
    && typeof (value as Record<string, unknown>).data === 'string';
}

/** Decode a wire value and apply the same length rules used by IPC validation. */
export function decodeUtf8Text(value: unknown, field: string, min = 0, max = 500): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else if (isUtf8TextPayload(value)) {
    const encoded = value.data;
    if (encoded.length > Math.ceil(max * 4 / 3) + 32_768 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
      throw new Error(`参数 ${field} 的 UTF-8 编码无效`);
    }
    try {
      // fatal=true prevents malformed byte sequences from silently becoming U+FFFD.
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'base64'));
    } catch {
      throw new Error(`参数 ${field} 的 UTF-8 编码无效`);
    }
  } else {
    throw new Error(`参数 ${field} 必须是文本`);
  }

  const normalized = text.normalize('NFC');
  if (normalized.length < min || normalized.length > max) {
    throw new Error(`参数 ${field} 无效（需 ${min}-${max} 字符）`);
  }
  return normalized;
}

export function decodeOptionalUtf8Text(value: unknown, field: string, max = 500): string | undefined {
  return value === undefined || value === null ? undefined : decodeUtf8Text(value, field, 0, max);
}
