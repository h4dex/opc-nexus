/**
 * 用户配置文件（user/config.yaml）解析测试
 * 覆盖：YAML 子集解析、注释剥离、类型合并、webhook 地址校验
 */
// @ts-nocheck
/* eslint-disable */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

import { parseSimpleYaml, mergeUserConfig, sanitizeWebhookUrl, USER_CONFIG_DEFAULTS } from '../src/main/services/userConfig.js';

describe('parseSimpleYaml', () => {
  it('解析两级映射与标量', () => {
    const r = parseSimpleYaml(`
wecom:
  botId: "abc-123"
  secret: 'sec-456'
  webhookUrl: https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
task:
  maxRunMinutes: 45
`);
    expect((r.wecom as Record<string, unknown>).botId).toBe('abc-123');
    expect((r.wecom as Record<string, unknown>).secret).toBe('sec-456');
    expect((r.wecom as Record<string, unknown>).webhookUrl).toBe('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx');
    expect((r.task as Record<string, unknown>).maxRunMinutes).toBe(45);
  });

  it('剥离行内注释但保留引号内的 #', () => {
    const r = parseSimpleYaml(`
wecom:
  botId: "id#with#hash"   # 这里是注释
  secret: ""              # secret 注释
task:
  maxRunMinutes: 30       # 分钟
`);
    expect((r.wecom as Record<string, unknown>).botId).toBe('id#with#hash');
    expect((r.wecom as Record<string, unknown>).secret).toBe('');
    expect((r.task as Record<string, unknown>).maxRunMinutes).toBe(30);
  });

  it('布尔与数字标量', () => {
    const r = parseSimpleYaml(`a:\n  flag: true\n  neg: false\n  num: -3.5\n`);
    const a = r.a as Record<string, unknown>;
    expect(a.flag).toBe(true);
    expect(a.neg).toBe(false);
    expect(a.num).toBe(-3.5);
  });

  it('空文件与纯注释返回空对象', () => {
    expect(parseSimpleYaml('')).toEqual({});
    expect(parseSimpleYaml('# only comment\n\n')).toEqual({});
  });
});

describe('mergeUserConfig', () => {
  it('缺失字段回退默认值', () => {
    const cfg = mergeUserConfig({});
    expect(cfg).toEqual(USER_CONFIG_DEFAULTS);
  });

  it('忽略旧版 executionMode，不恢复模拟执行', () => {
    const cfg = mergeUserConfig({ engine: { executionMode: 'demo' } });
    expect(cfg.engine).toEqual(USER_CONFIG_DEFAULTS.engine);
  });

  it('负数 maxRunMinutes 回退默认', () => {
    const cfg = mergeUserConfig({ task: { maxRunMinutes: -5 } });
    expect(cfg.task.maxRunMinutes).toBe(USER_CONFIG_DEFAULTS.task.maxRunMinutes);
  });

  it('0 = 不限制被接受', () => {
    const cfg = mergeUserConfig({ task: { maxRunMinutes: 0 } });
    expect(cfg.task.maxRunMinutes).toBe(0);
  });

  it('升级后不保留已退役 DSH fallback', () => {
    const cfg = mergeUserConfig({ engine: { fallbackEngineId: 'eng-deepseek-harness-managed' } });
    expect(cfg.engine.fallbackEngineId).toBe(USER_CONFIG_DEFAULTS.engine.fallbackEngineId);
  });
});

describe('sanitizeWebhookUrl', () => {
  it('接受 https 企微 webhook', () => {
    const url = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=487802b9';
    expect(sanitizeWebhookUrl(url)).toBe(url);
  });

  it('拒绝 http 与非法地址', () => {
    expect(sanitizeWebhookUrl('http://evil.com/hook')).toBe('');
    expect(sanitizeWebhookUrl('not-a-url')).toBe('');
    expect(sanitizeWebhookUrl('')).toBe('');
  });
});
