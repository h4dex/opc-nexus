/**
 * 语音指令解析测试
 *
 * 语音转写的文本形态与打字差异很大（口头语、缺标点、名字被截断），
 * 解析错了会把任务派给错误的员工并真实执行，因此这里覆盖各种口语句式。
 *
 * @author liyingjie <y@senke.com>
 */
// @ts-nocheck
/* eslint-disable */
import { describe, expect, it } from 'vitest';
import { parseVoiceCommand } from '../src/main/services/voiceCommand.js';

const AGENTS = [
  { id: 'a1', name: '文档助手' },
  { id: 'a2', name: '测试验证助手' },
  { id: 'a3', name: 'IT运维助手' }
];

describe('点名句式解析', () => {
  it('「让X做Y」提取员工与任务', () => {
    const r = parseVoiceCommand('让文档助手整理这周的会议纪要', AGENTS);
    expect(r.agentId).toBe('a1');
    expect(r.title).toBe('整理这周的会议纪要');
    expect(r.matchedBy).toBe('mention');
  });

  it('「请X帮我Y」剥掉礼貌前缀', () => {
    const r = parseVoiceCommand('请IT运维助手帮我检查服务器状态', AGENTS);
    expect(r.agentId).toBe('a3');
    expect(r.title).toBe('检查服务器状态');
  });

  it('「叫X去Y」', () => {
    const r = parseVoiceCommand('叫测试验证助手去跑一遍回归测试', AGENTS);
    expect(r.agentId).toBe('a2');
    expect(r.title).toBe('跑一遍回归测试');
  });

  it('@ 句式', () => {
    const r = parseVoiceCommand('@文档助手 归档上个月的合同', AGENTS);
    expect(r.agentId).toBe('a1');
    expect(r.title).toBe('归档上个月的合同');
  });

  it('「X，Y」逗号分隔句式', () => {
    const r = parseVoiceCommand('文档助手，把报告导出成 PDF', AGENTS);
    expect(r.agentId).toBe('a1');
    expect(r.title).toBe('把报告导出成 PDF');
  });
});

describe('语音转写特有形态', () => {
  it('省略通用后缀（「文档」→「文档助手」）', () => {
    const r = parseVoiceCommand('让文档整理会议纪要', AGENTS);
    expect(r.agentId).toBe('a1');
  });

  it('剥掉口头语前缀', () => {
    const r = parseVoiceCommand('那个，让文档助手写个周报', AGENTS);
    expect(r.agentId).toBe('a1');
    expect(r.title).toBe('写个周报');
  });

  it('去掉句末语气标点', () => {
    expect(parseVoiceCommand('让文档助手写周报。', AGENTS).title).toBe('写周报');
  });

  it('名字更长的员工优先匹配，避免误派', () => {
    const agents = [{ id: 'x', name: '测试' }, { id: 'y', name: '测试验证助手' }];
    expect(parseVoiceCommand('让测试验证助手跑用例', agents).agentId).toBe('y');
  });
});

describe('未点名与默认员工', () => {
  it('未点名时回落默认员工', () => {
    const r = parseVoiceCommand('整理一下这周的数据', AGENTS, 'a1');
    expect(r.agentId).toBe('a1');
    expect(r.matchedBy).toBe('default');
    expect(r.title).toBe('整理一下这周的数据');
  });

  it('未点名且无默认员工时不臆测目标（交由用户在确认界面选择）', () => {
    const r = parseVoiceCommand('整理一下这周的数据', AGENTS);
    expect(r.agentId).toBeNull();
    expect(r.matchedBy).toBe('none');
    expect(r.title).toBe('整理一下这周的数据');
  });

  it('提到不存在的员工时不乱派，按未点名处理', () => {
    const r = parseVoiceCommand('让财务助手核对账目', AGENTS);
    expect(r.agentId).toBeNull();
  });
});

describe('边界输入', () => {
  it('空文本返回空草稿', () => {
    const r = parseVoiceCommand('', AGENTS);
    expect(r.title).toBe('');
    expect(r.matchedBy).toBe('none');
  });

  it('纯空白返回空草稿', () => {
    expect(parseVoiceCommand('   ', AGENTS).title).toBe('');
  });

  it('只有员工名没有任务内容时不产出空任务', () => {
    const r = parseVoiceCommand('文档助手', AGENTS);
    expect(r.title).toBe('');
  });

  it('原始文本始终保留，便于确认界面对照', () => {
    const raw = '让文档助手写周报';
    expect(parseVoiceCommand(raw, AGENTS).rawText).toBe(raw);
  });

  it('无可用员工时不报错', () => {
    const r = parseVoiceCommand('整理数据', []);
    expect(r.agentId).toBeNull();
    expect(r.title).toBe('整理数据');
  });
});
