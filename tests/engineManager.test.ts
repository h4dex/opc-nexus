/**
 * EngineManager 引擎目录与状态机测试(P1 / A-4)
 *
 * CLAUDE.md 要求「状态机变更必须有对应测试覆盖」,而 Engine 状态机作为四层状态模型之一
 * 此前零覆盖。本文件覆盖:
 * - 四引擎收敛后的目录约束(E-1)
 * - 鉴权探测状态迁移(H-4):不再点一下就 HEALTHY
 * - 引擎凭据脱敏(S-4):config_json 不含明文
 *
 * @author liyingjie <y@senke.com>
 */
// @ts-nocheck
/* eslint-disable */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const appCfg: { engines: Record<string, unknown>; npmRegistry: string } = { engines: {}, npmRegistry: 'https://registry.npmmirror.com' };
vi.mock('../src/main/services/config.js', () => ({
  loadConfig: () => appCfg,
  sanitizeRegistry: (v: unknown) => (typeof v === 'string' ? v : null)
}));

// 供应商就绪状态由用例控制(内置 Nexus 的鉴权依据)
let providerIsReady = false;
vi.mock('../src/main/services/provider.js', () => ({
  providerReady: () => providerIsReady
}));

const { EngineManager, ENGINE_CATALOG, RETIRED_ENGINE_IDS, CLI_FAILURE_BODY_PATTERN, cliLaunchProbeTimeoutMs } = await import('../src/main/services/engineManager.js');

/** 内存 engines 表桩:支持状态读写,便于断言状态迁移 */
function makeDb(engines: Record<string, Record<string, unknown>> = {}) {
  const settings: Record<string, unknown> = {};
  return {
    _engines: engines,
    raw: {
      prepare: (sql: string) => ({
        get: (id: string) => {
          const e = engines[id];
          if (!e) return undefined;
          if (/SELECT status FROM engines/.test(sql)) return { status: e.status };
          if (/SELECT path FROM engines/.test(sql)) return { path: e.path ?? null };
          if (/SELECT config_json FROM engines/.test(sql)) return { config_json: e.config_json };
          return e;
        },
        all: () => Object.values(engines),
        run: (...args: unknown[]) => {
          // UPDATE engines SET status = ?, auth_status = ? WHERE id = ?
          if (/UPDATE engines SET status = \?, auth_status = \? WHERE id = \?/.test(sql)) {
            const [status, authStatus, id] = args;
            if (engines[id as string]) Object.assign(engines[id as string], { status, auth_status: authStatus });
            return { changes: 1 };
          }
          if (/UPDATE engines SET config_json = \? WHERE id = \?/.test(sql)) {
            const [json, id] = args;
            if (engines[id as string]) engines[id as string].config_json = json;
            return { changes: 1 };
          }
          return { changes: 1 };
        }
      })
    },
    transaction: (fn: () => void) => fn(),
    audit: vi.fn(),
    getSetting: (k: string, fb: unknown) => (k in settings ? settings[k] : fb),
    setSetting: (k: string, v: unknown) => { settings[k] = v; },
    _settings: settings
  };
}

beforeEach(() => {
  providerIsReady = false;
  appCfg.engines = {};
});

describe('引擎目录收敛(E-1)', () => {
  it('目录恰好四种引擎', () => {
    expect(ENGINE_CATALOG.map((e) => e.id).sort()).toEqual(
      ['eng-codex', 'eng-hermes', 'eng-hermes-cli', 'eng-opencode'].sort()
    );
  });

  it('下线引擎不在目录中', () => {
    const ids = new Set(ENGINE_CATALOG.map((e) => e.id));
    for (const retired of RETIRED_ENGINE_IDS) expect(ids.has(retired)).toBe(false);
  });

  it('Nexus 为内置引擎(无 bin,不做 CLI 检测)', () => {
    expect(ENGINE_CATALOG.find((e) => e.id === 'eng-hermes')?.bin).toBeNull();
  });

  it('Hermes CLI 走 hermes 二进制且无 npm 包(PowerShell 脚本安装)', () => {
    const hermes = ENGINE_CATALOG.find((e) => e.id === 'eng-hermes-cli');
    expect(hermes?.bin).toBe('hermes');
    expect(hermes?.npmPackage).toBeNull();
  });

  it('每个引擎都声明数据边界(15.1 要求外部引擎展示数据发送方)', () => {
    for (const e of ENGINE_CATALOG) expect(e.dataBoundary.length).toBeGreaterThan(0);
  });
});

describe('鉴权探测状态迁移(H-4)', () => {
  it('Hermes 员工 Profile 首次迁移获得更长的启动窗口', () => {
    expect(cliLaunchProbeTimeoutMs('eng-hermes-cli', { HERMES_HOME: 'C:\\profiles\\employee' })).toBe(45_000);
    expect(cliLaunchProbeTimeoutMs('eng-hermes-cli', {})).toBe(15_000);
    expect(cliLaunchProbeTimeoutMs('eng-codex', { HERMES_HOME: 'ignored' })).toBe(15_000);
  });

  it('不把零退出码中的供应商错误正文当作健康结果', () => {
    expect(CLI_FAILURE_BODY_PATTERN.test('HTTP 401: Missing Authentication header')).toBe(true);
    expect(CLI_FAILURE_BODY_PATTERN.test('No usable credentials found for provider')).toBe(true);
    expect(CLI_FAILURE_BODY_PATTERN.test('pong')).toBe(false);
  });

  it('内置 Nexus:供应商就绪 → HEALTHY + authed', async () => {
    providerIsReady = true;
    const db = makeDb({ 'eng-hermes': { id: 'eng-hermes', status: 'SETUP_REQUIRED', auth_status: 'required' } });
    const r = await new EngineManager(db as never).probeAuth('eng-hermes');
    expect(r.ok).toBe(true);
    expect(db._engines['eng-hermes'].status).toBe('HEALTHY');
    expect(db._engines['eng-hermes'].auth_status).toBe('authed');
  });

  it('内置 Nexus:供应商未配置 → SETUP_REQUIRED,不伪装成已登录', async () => {
    providerIsReady = false;
    const db = makeDb({ 'eng-hermes': { id: 'eng-hermes', status: 'SETUP_REQUIRED', auth_status: 'required' } });
    const r = await new EngineManager(db as never).probeAuth('eng-hermes');
    expect(r.ok).toBe(false);
    expect(db._engines['eng-hermes'].status).toBe('SETUP_REQUIRED');
    expect(db._engines['eng-hermes'].auth_status).toBe('required');
  });

  it('未知引擎如实返回失败', async () => {
    const r = await new EngineManager(makeDb() as never).probeAuth('eng-not-exist');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('未知引擎');
  });

  it('CLI 引擎二进制不存在 → 提示先安装,不标记为已登录', async () => {
    // locateBin 依赖 where/which,探测一个绝不存在的可执行名
    appCfg.engines['eng-opencode'] = { bin: 'definitely-not-a-real-binary-xyz' };
    const db = makeDb({ 'eng-opencode': { id: 'eng-opencode', status: 'NOT_INSTALLED', auth_status: 'unknown' } });
    const r = await new EngineManager(db as never).probeAuth('eng-opencode');
    expect(r.ok).toBe(false);
    expect(db._engines['eng-opencode'].auth_status).not.toBe('authed');
  }, 20_000);
});

describe('引擎配置凭据脱敏(S-4)', () => {
  it('敏感 env 不写入 config_json,只留占位符', () => {
    const db = makeDb({ 'eng-opencode': { id: 'eng-opencode', status: 'HEALTHY' } });
    new EngineManager(db as never).saveConfig('eng-opencode', {
      env: { API_KEY: 'sk-secret-value', NODE_ENV: 'production' }
    });
    const persisted = db._engines['eng-opencode'].config_json as string;
    expect(persisted).not.toContain('sk-secret-value');
    expect(persisted).toContain('***');
    expect(persisted).toContain('production');
  });

  it('getConfig 返回给 Renderer 的视图不含明文密钥', () => {
    const db = makeDb({ 'eng-opencode': { id: 'eng-opencode', status: 'HEALTHY' } });
    const mgr = new EngineManager(db as never);
    mgr.saveConfig('eng-opencode', { env: { GITHUB_TOKEN: 'ghp_realtoken' } });
    expect(JSON.stringify(mgr.getConfig('eng-opencode'))).not.toContain('ghp_realtoken');
  });
});
