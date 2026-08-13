import { describe, expect, it } from 'vitest';
import {
  appendBoundedText,
  appendProcessOutput,
  boundedText,
  createProcessOutputBuffer,
  createUtf8StreamDecoder,
  decodeProcessOutput,
  decodeUtf8Text,
  finishProcessOutput
} from '../src/main/services/textEncoding.js';

function utf8Payload(value: string) {
  return { encoding: 'utf8-base64' as const, data: Buffer.from(value, 'utf8').toString('base64') };
}

describe('UTF-8 text transport', () => {
  it('round-trips Chinese task text and normalizes NFC', () => {
    expect(decodeUtf8Text(utf8Payload('打开 baidu.com 搜索今天的热点信息'), 'title', 1, 100))
      .toBe('打开 baidu.com 搜索今天的热点信息');
    expect(decodeUtf8Text(utf8Payload('e\u0301'), 'title', 1, 10)).toBe('\u00e9');
  });

  it('rejects malformed UTF-8, malformed base64, and oversized text', () => {
    const malformedUtf8 = { encoding: 'utf8-base64', data: Buffer.from([0xc3, 0x28]).toString('base64') };
    expect(() => decodeUtf8Text(malformedUtf8, 'title', 1, 100)).toThrow('UTF-8 编码无效');
    expect(() => decodeUtf8Text({ encoding: 'utf8-base64', data: '***=' }, 'title', 1, 100)).toThrow('UTF-8 编码无效');
    expect(() => decodeUtf8Text(utf8Payload('123456'), 'title', 1, 5)).toThrow('1-5 字符');
  });

  it('decodes UTF-8 characters split across arbitrary process chunks', () => {
    const bytes = Buffer.from('任务执行完成', 'utf8');
    const decoder = createUtf8StreamDecoder();
    const decoded = decoder.write(bytes.subarray(0, 2))
      + decoder.write(bytes.subarray(2, 7))
      + decoder.write(bytes.subarray(7))
      + decoder.end();
    expect(decoded).toBe('任务执行完成');
  });

  it('falls back to GBK for Windows process output', () => {
    const gbk = Buffer.from([0xc8, 0xce, 0xce, 0xf1]);
    expect(decodeProcessOutput(gbk)).toBe('任务');
  });
});

describe('bounded process and task output', () => {
  it('limits raw process output before decoding', () => {
    const output = createProcessOutputBuffer();
    appendProcessOutput(output, Buffer.from('abcdef'), 4);
    appendProcessOutput(output, Buffer.from('ghij'), 4);
    expect(output.bytes).toBe(4);
    expect(finishProcessOutput(output)).toBe('abcd\n[进程输出已截断]');
  });

  it('limits accumulated task output and marks truncation once', () => {
    const parts: string[] = [];
    const state = { length: 0, truncated: false };
    appendBoundedText(parts, state, 'abc', 5);
    appendBoundedText(parts, state, 'def', 5);
    appendBoundedText(parts, state, 'ghi', 5);
    expect(state.length).toBe(5);
    expect(boundedText(parts, state)).toBe('abcde\n[输出已截断]');
  });
});
