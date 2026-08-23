import { describe, expect, it } from 'vitest';
import {
  parseQuestSlashCommand,
  resolveQuestSlashCommand,
  type QuestSlashCommandContext
} from '../src/main/services/questSlashCommand.js';

const context: QuestSlashCommandContext = {
  employees: [
    { id: 'agent-frontend', name: '前端工程师', role: '实现界面', engineId: 'eng-codex', memoryMode: 'short_term' },
    { id: 'agent-reviewer', name: '验收专家', role: '独立验收', engineId: 'eng-claude', memoryMode: 'none' }
  ],
  plugins: [
    { id: 'skill:copywriter', name: '品牌写作', kind: 'skill', status: 'ready', tools: [] },
    { id: 'skill:disabled', name: '禁用技能', kind: 'skill', status: 'blocked', tools: [] },
    {
      id: 'mcp:web-search', name: '联网搜索', kind: 'mcp', status: 'ready',
      tools: [
        { name: 'search/run', description: 'Search the web' },
        { name: 'page/read', description: 'Read a page' }
      ]
    },
    { id: 'mcp:empty', name: '空服务', kind: 'mcp', status: 'ready', tools: [] },
    {
      id: 'mcp:offline', name: '离线服务', kind: 'mcp', status: 'blocked',
      tools: [{ name: 'fake/run', description: 'Unavailable' }]
    }
  ]
};

describe('Quest slash command protocol', () => {
  it('keeps the complete task body for one-argument execution modes', () => {
    expect(parseQuestSlashCommand('/plan 创建官网并提供预览')).toEqual({
      kind: 'mode', mode: 'plan', task: '创建官网并提供预览'
    });
    expect(parseQuestSlashCommand('/execute 修复顶部标签')).toEqual({
      kind: 'mode', mode: 'execute', task: '修复顶部标签'
    });
    expect(parseQuestSlashCommand('/research 对比三家竞品\n附上来源')).toEqual({
      kind: 'mode', mode: 'research', task: '对比三家竞品\n附上来源'
    });
  });

  it('parses explicit modes and quoted targets without losing the task', () => {
    expect(parseQuestSlashCommand('/mode auto 判断是否需要组建团队')).toEqual({
      kind: 'mode', mode: 'auto', task: '判断是否需要组建团队'
    });
    expect(parseQuestSlashCommand('/agent "前端 工程师" 完成响应式页面')).toEqual({
      kind: 'agent', target: '前端 工程师', task: '完成响应式页面'
    });
    expect(parseQuestSlashCommand('/mcp web-search/search/run 查询 OPC-Nexus')).toEqual({
      kind: 'mcp', target: 'web-search/search/run', task: '查询 OPC-Nexus'
    });
    expect(parseQuestSlashCommand('普通老板指令')).toBeNull();
  });

  it('rejects unknown, incomplete, malformed, and client-only commands before Hermes', () => {
    for (const message of ['/', '/plan', '/execute   ', '/research', '/mode', '/mode auto', '/agent 前端工程师', '/skill copywriter', '/mcp web-search']) {
      expect(() => parseQuestSlashCommand(message), message).toThrow('Quest 命令无效');
    }
    expect(() => parseQuestSlashCommand('/mode unsafe 删除文件')).toThrow('只支持 auto、plan、execute 或 research');
    expect(() => parseQuestSlashCommand('/unknown 做点什么')).toThrow('不支持 /unknown');
    expect(() => parseQuestSlashCommand('/help')).toThrow('界面命令');
    expect(() => parseQuestSlashCommand('/new')).toThrow('界面命令');
    expect(() => parseQuestSlashCommand('/agent "未闭合 任务')).toThrow('引号未闭合');
  });

  it('resolves only an authorized employee and pins its real id', () => {
    const command = parseQuestSlashCommand('/agent agent-frontend 实现官网');
    expect(command).not.toBeNull();
    const resolved = resolveQuestSlashCommand(command!, context);
    expect(resolved.turnMessage).toBe('@前端工程师 实现官网');
    expect(resolved.systemDirective).toContain('agent-frontend');
    expect(resolved.systemDirective).toContain('do not substitute another worker');
    expect(resolved.auditTarget).toBe('agent:agent-frontend');
    expect(() => resolveQuestSlashCommand(
      parseQuestSlashCommand('/agent 未授权员工 执行任务')!, context
    )).toThrow('未在当前项目授权或不可用');
  });

  it('resolves only ready project skills by id or name', () => {
    const byId = resolveQuestSlashCommand(parseQuestSlashCommand('/skill copywriter 优化文案')!, context);
    const byName = resolveQuestSlashCommand(parseQuestSlashCommand('/skill 品牌写作 优化文案')!, context);
    expect(byId.auditTarget).toBe('skill:copywriter');
    expect(byName.auditTarget).toBe('skill:copywriter');
    expect(byId.systemDirective).toContain('real synchronized skill context');
    expect(() => resolveQuestSlashCommand(
      parseQuestSlashCommand('/skill disabled 执行任务')!, context
    )).toThrow('当前不可用');
  });

  it('pins an exact ready MCP tool or lets Hermes choose only from real server tools', () => {
    const exact = resolveQuestSlashCommand(
      parseQuestSlashCommand('/mcp web-search/search/run 查询官网')!, context
    );
    expect(exact.auditTarget).toBe('mcp:web-search/search/run');
    expect(exact.systemDirective).toContain('exact tool');
    expect(exact.systemDirective).toContain('never simulate');

    const server = resolveQuestSlashCommand(
      parseQuestSlashCommand('/mcp web-search 查询官网')!, context
    );
    expect(server.auditTarget).toBe('mcp:web-search');
    expect(server.systemDirective).toContain('search/run, page/read');
    expect(() => resolveQuestSlashCommand(
      parseQuestSlashCommand('/mcp web-search/missing 查询官网')!, context
    )).toThrow('未在当前项目授权或不可用');
    expect(() => resolveQuestSlashCommand(
      parseQuestSlashCommand('/mcp empty 查询官网')!, context
    )).toThrow('没有可调用的真实工具');
    expect(() => resolveQuestSlashCommand(
      parseQuestSlashCommand('/mcp offline/fake/run 查询官网')!, context
    )).toThrow('当前不可用');
  });
});
