import { describe, expect, it } from 'vitest';
import { parseHermesChannelCommand } from '../src/main/services/hermesChannelRouter.js';

describe('Hermes channel project commands', () => {
  it('recognizes project governance and task-control commands', () => {
    expect(parseHermesChannelCommand('/状态')).toEqual({ kind: 'status' });
    expect(parseHermesChannelCommand('/取消 全部')).toEqual({ kind: 'cancel', all: true });
    expect(parseHermesChannelCommand('/暂停')).toEqual({ kind: 'pause' });
    expect(parseHermesChannelCommand('/继续')).toEqual({ kind: 'resume' });
    expect(parseHermesChannelCommand('批准计划')).toEqual({ kind: 'approve-plan', dispatch: false });
    expect(parseHermesChannelCommand('批准并派工')).toEqual({ kind: 'approve-plan', dispatch: true });
    expect(parseHermesChannelCommand('派工')).toEqual({ kind: 'dispatch-plan' });
  });

  it('does not reinterpret ordinary owner work as a control command', () => {
    expect(parseHermesChannelCommand('帮我分析本周客户反馈')).toBeNull();
    expect(parseHermesChannelCommand('写一份状态报告')).toBeNull();
  });
});
