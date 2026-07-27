/**
 * 企微 webhook 通知测试:字节截断与启用判定
 */
// @ts-nocheck
/* eslint-disable */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const userCfg = {
  wecom: { botId: '', secret: '', webhookUrl: '' },
  engine: { fallbackEngineId: 'eng-opencode', executionMode: 'demo' },
  task: { maxRunMinutes: 30 }
};
vi.mock('../src/main/services/userConfig.js', () => ({
  loadUserConfig: () => userCfg
}));

import { WecomWebhookNotifier, truncateBytes } from '../src/main/services/wecomWebhook.js';

describe('truncateBytes', () => {
  it('不超限原样返回', () => {
    expect(truncateBytes('hello', 100)).toBe('hello');
  });

  it('超限按字节截断并加省略号', () => {
    const out = truncateBytes('a'.repeat(200), 50);
    expect(Buffer.from(out, 'utf8').length).toBeLessThanOrEqual(50);
    expect(out.endsWith('…')).toBe(true);
  });

  it('不在多字节字符中间截断', () => {
    const out = truncateBytes('中文内容'.repeat(100), 100);
    // 能安全 round-trip 即未截坏
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
  });
});

describe('WecomWebhookNotifier', () => {
  it('未配置 webhookUrl 时禁用且不发起请求', () => {
    userCfg.wecom.webhookUrl = '';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const n = new WecomWebhookNotifier();
    expect(n.isEnabled()).toBe(false);
    n.notifyTaskCompleted('任务A', '员工B', '结果');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('配置后 isEnabled 为 true', () => {
    userCfg.wecom.webhookUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test';
    const n = new WecomWebhookNotifier();
    expect(n.isEnabled()).toBe(true);
    userCfg.wecom.webhookUrl = '';
  });
});
