/**
 * Hermes Agent 执行器测试(P1)
 *
 * 覆盖真实 hermes-agent CLI 的接入语义(接口事实经本机 v0.19.0 实测核实):
 * - headless 参数构造与 --usage-file 会话锚点
 * - 四级权限 → --accept-hooks / -t 的映射,以及渠道任务的 trusted 降级
 * - 会话续接 -r 与 --no-restore-cwd(工作目录由本应用托管)
 * - 就绪判定与配置文件参数覆写
 *
 * 不测子进程真实执行(依赖本机安装),只测命令构造与判定逻辑 —— 这是接入正确性的关键面。
 *
 * @author liyingjie <y@senke.com>
 */
// @ts-nocheck
/* eslint-disable */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

// 配置文件 mock:默认无覆写,单个用例内改写以验证 runArgs 覆写路径
const appCfg: { engines: Record<string, { runArgs?: string[] }> } = { engines: {} };
vi.mock('../src/main/services/config.js', () => ({
  loadConfig: () => appCfg
}));

const { HermesAgentExecutor } = await import('../src/main/services/executor/hermesAgentExecutor.js');

function makeDb(status = 'HEALTHY', path: string | null = null) {
  return {
    raw: {
      prepare: (sql: string) => ({
        get: () => {
          if (/SELECT status FROM engines/.test(sql)) return { status };
          if (/SELECT path FROM engines/.test(sql)) return { path };
          if (/SELECT config_json FROM engines/.test(sql)) return undefined;
          return undefined;
        },
        all: () => [],
        run: () => ({ changes: 1 })
      })
    },
    getSetting: (_k: string, fb: unknown) => fb,
    audit: vi.fn()
  };
}

/** 直接调用私有 buildArgs,避免真实 spawn */
function buildArgs(exec, task, agent, usageFile = '/tmp/u.json') {
  return exec['buildArgs'](exec['resolveBin']() && 'PROMPT', task, agent, usageFile);
}

const baseTask = { id: 't1', title: '任务', source: 'desktop', sessionId: null, workspaceOverride: null };
const baseAgent = { id: 'a1', permissionMode: 'standard', workspace: '/ws', systemPrompt: '', modelOverride: undefined };

beforeEach(() => {
  appCfg.engines = {};
});

describe('HermesAgentExecutor 就绪判定', () => {
  it('引擎表 HEALTHY 才算就绪', () => {
    expect(new HermesAgentExecutor(makeDb('HEALTHY')).isReady()).toBe(true);
    expect(new HermesAgentExecutor(makeDb('NOT_INSTALLED')).isReady()).toBe(false);
    expect(new HermesAgentExecutor(makeDb('AUTH_REQUIRED')).isReady()).toBe(false);
  });

  it('优先使用 detect 解析到的真实路径,否则回退 PATH 中的 hermes', () => {
    expect(new HermesAgentExecutor(makeDb('HEALTHY', 'C:/hermes/hermes.exe'))['resolveBin']())
      .toBe('C:/hermes/hermes.exe');
    expect(new HermesAgentExecutor(makeDb('HEALTHY', null))['resolveBin']()).toBe('hermes');
  });
});

describe('HermesAgentExecutor headless 参数构造', () => {
  it('使用 -z 一次性模式并写出 usage-file(session_id 的唯一来源)', () => {
    const args = buildArgs(new HermesAgentExecutor(makeDb()), baseTask, baseAgent, '/tmp/u.json');
    expect(args[0]).toBe('-z');
    expect(args).toContain('--usage-file');
    expect(args[args.indexOf('--usage-file') + 1]).toBe('/tmp/u.json');
  });

  it('绝不传 --yolo(它绕过全部危险命令审批,不映射任一权限级别)', () => {
    for (const mode of ['readonly', 'standard', 'trusted', 'autonomous']) {
      const args = buildArgs(new HermesAgentExecutor(makeDb()), baseTask, { ...baseAgent, permissionMode: mode });
      expect(args).not.toContain('--yolo');
    }
  });

  it('modelOverride 映射为 -m', () => {
    const args = buildArgs(new HermesAgentExecutor(makeDb()), baseTask, { ...baseAgent, modelOverride: 'anthropic/claude-sonnet-4.6' });
    expect(args[args.indexOf('-m') + 1]).toBe('anthropic/claude-sonnet-4.6');
  });

  it('配置文件 runArgs 覆写时完全接管参数模板', () => {
    appCfg.engines['eng-hermes-cli'] = { runArgs: ['--custom', '{prompt}'] };
    const args = buildArgs(new HermesAgentExecutor(makeDb()), baseTask, baseAgent);
    expect(args).toEqual(['--custom', 'PROMPT']);
    // 覆写后不再叠加本应用默认策略
    expect(args).not.toContain('--usage-file');
  });

  it('runArgs 覆写未含 {prompt} 占位时追加到末尾', () => {
    appCfg.engines['eng-hermes-cli'] = { runArgs: ['--flag'] };
    const args = buildArgs(new HermesAgentExecutor(makeDb()), baseTask, baseAgent);
    expect(args).toEqual(['--flag', 'PROMPT']);
  });
});

describe('HermesAgentExecutor 权限映射', () => {
  const argsFor = (permissionMode: string, source = 'desktop') =>
    buildArgs(new HermesAgentExecutor(makeDb()), { ...baseTask, source }, { ...baseAgent, permissionMode });

  it('trusted / autonomous 传 --accept-hooks', () => {
    expect(argsFor('trusted')).toContain('--accept-hooks');
    expect(argsFor('autonomous')).toContain('--accept-hooks');
  });

  it('standard 不传 --accept-hooks(保留 hook 审批)', () => {
    expect(argsFor('standard')).not.toContain('--accept-hooks');
  });

  it('readonly 不免审批且用 -t 限制为只读工具集', () => {
    const args = argsFor('readonly');
    expect(args).not.toContain('--accept-hooks');
    const sets = args[args.indexOf('-t') + 1].split(',');
    // 名称必须是 hermes 内置 toolset 的真实名（单数 file）；
    // 曾误写复数 files，hermes 直接以退出码 2 拒绝执行整个任务。
    expect(sets).toContain('file');
    expect(sets).not.toContain('files');
    // 只读集合不得包含可写副作用的工具集
    for (const forbidden of ['terminal', 'code_execution', 'browser', 'computer_use']) {
      expect(sets).not.toContain(forbidden);
    }
  });

  it('渠道来源任务的 trusted 降级为 standard(10.5)', () => {
    expect(argsFor('trusted', 'channel')).not.toContain('--accept-hooks');
  });

  it('渠道来源的 autonomous 不降级', () => {
    expect(argsFor('autonomous', 'channel')).toContain('--accept-hooks');
  });

  it('专家团任务(source=team)提升为 autonomous', () => {
    expect(argsFor('standard', 'team')).toContain('--accept-hooks');
  });
});

describe('HermesAgentExecutor 会话续接', () => {
  it('hermes- 前缀的 sessionId 续接并阻止 cd 回旧目录', () => {
    const args = buildArgs(
      new HermesAgentExecutor(makeDb()),
      { ...baseTask, sessionId: 'hermes-abc123' },
      baseAgent
    );
    expect(args[args.indexOf('-r') + 1]).toBe('abc123');
    // 工作目录由本应用按员工 workspace 托管,不能被会话记录覆盖
    expect(args).toContain('--no-restore-cwd');
  });

  it('非 hermes- 前缀的 sessionId 不误用于续接', () => {
    const args = buildArgs(
      new HermesAgentExecutor(makeDb()),
      { ...baseTask, sessionId: 'llm-xyz' },
      baseAgent
    );
    expect(args).not.toContain('-r');
  });

  it('无 sessionId 时不传续接参数', () => {
    expect(buildArgs(new HermesAgentExecutor(makeDb()), baseTask, baseAgent)).not.toContain('-r');
  });
});
