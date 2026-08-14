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
  providerReady: () => providerIsReady,
  getProviderSettings: () => ({ baseUrl: '', model: '' }),
  readProviderKey: () => null
}));

const acpProbeMocks = vi.hoisted(() => ({
  handshake: vi.fn(),
  task: vi.fn()
}));
vi.mock('../src/main/services/executor/acpExecutor.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/main/services/executor/acpExecutor.js')>(),
  probeAcpEngine: acpProbeMocks.handshake,
  probeAcpTask: acpProbeMocks.task
}));

const { EngineManager, ENGINE_CATALOG, RETIRED_ENGINE_IDS, CLI_FAILURE_BODY_PATTERN, cliLaunchProbeTimeoutMs } = await import('../src/main/services/engineManager.js');
const {
  HARNESS_PROVIDER_FINGERPRINT_SETTING,
  harnessProviderFingerprint
} = await import('../src/main/services/harnessProviderVerification.js');

/** 内存 engines 表桩:支持状态读写,便于断言状态迁移 */
function makeDb(
  engines: Record<string, Record<string, unknown>> = {},
  providers: Record<string, unknown>[] = []
) {
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
        all: () => /FROM providers/.test(sql) ? providers : Object.values(engines),
        run: (...args: unknown[]) => {
          if (/INSERT INTO engines/.test(sql) && /ON CONFLICT\(id\) DO UPDATE/.test(sql)) {
            const [id, type, name, status, isDefault, dataBoundary] = args;
            const existing = engines[id as string];
            if (existing) Object.assign(existing, { name, data_boundary: dataBoundary });
            else {
              engines[id as string] = {
                id,
                type,
                name,
                version: null,
                path: null,
                status,
                auth_status: 'required',
                is_default: isDefault,
                data_boundary: dataBoundary,
                config_json: null
              };
            }
            return { changes: 1 };
          }
          if (/INSERT INTO engines/.test(sql) && /ON CONFLICT\(id\) DO NOTHING/.test(sql)) {
            const [id, name, path, dataBoundary, configJson] = args;
            if (!engines[id as string]) {
              engines[id as string] = {
                id,
                type: 'external',
                name,
                version: null,
                path,
                status: 'NOT_INSTALLED',
                auth_status: 'unknown',
                is_default: 0,
                data_boundary: dataBoundary,
                config_json: configJson
              };
            }
            return { changes: 1 };
          }
          if (/INSERT INTO engines/.test(sql)) {
            const [id, name, path, dataBoundary] = args;
            engines[id as string] = {
              id,
              type: 'external',
              name,
              version: null,
              path,
              status: 'NOT_INSTALLED',
              auth_status: 'unknown',
              is_default: 0,
              data_boundary: dataBoundary,
              config_json: null
            };
            return { changes: 1 };
          }
          // UPDATE engines SET status = ?, auth_status = ? WHERE id = ?
          if (/UPDATE engines SET status = \?, auth_status = \? WHERE id = \?/.test(sql)) {
            const [status, authStatus, id] = args;
            if (engines[id as string]) Object.assign(engines[id as string], { status, auth_status: authStatus });
            return { changes: 1 };
          }
          if (/UPDATE engines SET status = \?, auth_status = \?, version = \?, path = \? WHERE id = \?/.test(sql)) {
            const [status, authStatus, version, path, id] = args;
            if (engines[id as string]) Object.assign(engines[id as string], {
              status,
              auth_status: authStatus,
              version,
              path
            });
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
  acpProbeMocks.handshake.mockReset();
  acpProbeMocks.task.mockReset();
  acpProbeMocks.handshake.mockResolvedValue({ ok: true, message: 'ok' });
  acpProbeMocks.task.mockResolvedValue({
    ok: true,
    message: '最小 ACP 任务已返回模型文本',
    initialized: true,
    sessionCreated: true,
    output: 'OPC_HARNESS_OK'
  });
});

describe('引擎目录收敛(E-1)', () => {
  it('目录包含四个原有引擎和受管 DeepSeek Harness runtime', () => {
    expect(ENGINE_CATALOG.map((e) => e.id).sort()).toEqual(
      ['eng-codex', 'eng-deepseek-harness', 'eng-hermes', 'eng-hermes-cli', 'eng-opencode'].sort()
    );
    expect(ENGINE_CATALOG.find((e) => e.id === 'eng-deepseek-harness')).toMatchObject({
      type: 'external',
      bin: null,
      npmPackage: null
    });
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

  it('Harness 重新检测只有握手时保持 AUTH_REQUIRED', async () => {
    providerIsReady = true;
    const db = makeDb({
      'eng-deepseek-harness': {
        id: 'eng-deepseek-harness',
        status: 'NOT_INSTALLED',
        auth_status: 'required'
      }
    });

    const result = await new EngineManager(db as never).restart('eng-deepseek-harness');

    expect(result.ok).toBe(true);
    expect(acpProbeMocks.handshake).toHaveBeenCalledOnce();
    expect(acpProbeMocks.task).not.toHaveBeenCalled();
    expect(db._engines['eng-deepseek-harness']).toMatchObject({
      status: 'AUTH_REQUIRED',
      auth_status: 'required'
    });
    expect(db._settings['engine:health:eng-deepseek-harness']).toMatchObject({
      launchable: true,
      authenticated: false,
      taskVerified: false
    });
  });

  it('自动检测只保留与当前 Provider 指纹匹配的 Harness 验证', async () => {
    providerIsReady = true;
    const db = makeDb({
      'eng-deepseek-harness': {
        id: 'eng-deepseek-harness',
        type: 'external',
        name: 'DeepSeek Harness',
        status: 'HEALTHY',
        auth_status: 'authed',
        data_boundary: 'local'
      }
    });
    db.setSetting('engine:health:eng-deepseek-harness', {
      detected: true,
      launchable: true,
      authenticated: true,
      taskVerified: true,
      detail: 'OPC_HARNESS_OK',
      checkedAt: 1
    });
    db.setSetting(HARNESS_PROVIDER_FINGERPRINT_SETTING, harnessProviderFingerprint(db as never));
    for (const id of ['eng-hermes-cli', 'eng-opencode', 'eng-codex']) {
      appCfg.engines[id] = { bin: `missing-${id}` };
    }

    await new EngineManager(db as never).detect();

    expect(db._engines['eng-deepseek-harness']).toMatchObject({
      status: 'HEALTHY',
      auth_status: 'authed'
    });
    expect(db._settings['engine:health:eng-deepseek-harness']).toMatchObject({
      authenticated: true,
      taskVerified: true,
      detail: 'OPC_HARNESS_OK'
    });
  });

  it('自动检测会让缺少当前 Provider 指纹的旧 Harness 验证失效', async () => {
    providerIsReady = true;
    const db = makeDb({
      'eng-deepseek-harness': {
        id: 'eng-deepseek-harness', type: 'external', name: 'DeepSeek Harness',
        status: 'HEALTHY', auth_status: 'authed', data_boundary: 'local'
      }
    });
    db.setSetting('engine:health:eng-deepseek-harness', {
      detected: true, launchable: true, authenticated: true, taskVerified: true,
      detail: 'OPC_HARNESS_OK', checkedAt: 1
    });
    for (const id of ['eng-hermes-cli', 'eng-opencode', 'eng-codex']) {
      appCfg.engines[id] = { bin: `missing-${id}` };
    }

    await new EngineManager(db as never).detect();

    expect(db._engines['eng-deepseek-harness']).toMatchObject({
      status: 'AUTH_REQUIRED', auth_status: 'required'
    });
    expect(db._settings['engine:health:eng-deepseek-harness']).toMatchObject({
      authenticated: false, taskVerified: false
    });
  });

  it('Provider 配置变更会立即清除 Harness 真实任务验证状态', () => {
    providerIsReady = true;
    const db = makeDb({
      'eng-deepseek-harness': {
        id: 'eng-deepseek-harness', type: 'external', name: 'DeepSeek Harness',
        status: 'HEALTHY', auth_status: 'authed', data_boundary: 'local'
      }
    });
    db.setSetting('engine:health:eng-deepseek-harness', {
      detected: true, launchable: true, authenticated: true, taskVerified: true,
      detail: 'OPC_HARNESS_OK', checkedAt: 1
    });
    db.setSetting(HARNESS_PROVIDER_FINGERPRINT_SETTING, 'verified-provider');

    new EngineManager(db as never).invalidateHarnessProviderVerification();

    expect(db._engines['eng-deepseek-harness']).toMatchObject({
      status: 'AUTH_REQUIRED', auth_status: 'required'
    });
    expect(db._settings['engine:health:eng-deepseek-harness']).toMatchObject({
      authenticated: false, taskVerified: false
    });
    expect(db._settings[HARNESS_PROVIDER_FINGERPRINT_SETTING]).toBeNull();
  });

  it('Harness 只有真实最小任务返回文本后才标记 HEALTHY', async () => {
    providerIsReady = true;
    const db = makeDb({
      'eng-deepseek-harness': {
        id: 'eng-deepseek-harness',
        status: 'AUTH_REQUIRED',
        auth_status: 'required'
      }
    });

    const result = await new EngineManager(db as never).probeAuth('eng-deepseek-harness');

    expect(result.ok).toBe(true);
    expect(acpProbeMocks.task).toHaveBeenCalledOnce();
    expect(db._engines['eng-deepseek-harness']).toMatchObject({
      status: 'HEALTHY',
      auth_status: 'authed'
    });
    expect(db._settings['engine:health:eng-deepseek-harness']).toMatchObject({
      launchable: true,
      authenticated: true,
      taskVerified: true,
      detail: 'OPC_HARNESS_OK'
    });
  });

  it('Harness 最小任务失败时不会伪装成 HEALTHY', async () => {
    providerIsReady = true;
    acpProbeMocks.task.mockResolvedValue({
      ok: false,
      message: 'session/prompt 失败：HTTP 401 unauthorized',
      initialized: true,
      sessionCreated: true,
      output: ''
    });
    const db = makeDb({
      'eng-deepseek-harness': {
        id: 'eng-deepseek-harness',
        status: 'AUTH_REQUIRED',
        auth_status: 'required'
      }
    });

    const result = await new EngineManager(db as never).probeAuth('eng-deepseek-harness');

    expect(result.ok).toBe(false);
    expect(db._engines['eng-deepseek-harness']).toMatchObject({
      status: 'AUTH_REQUIRED',
      auth_status: 'required'
    });
    expect(db._settings['engine:health:eng-deepseek-harness']).toMatchObject({
      authenticated: false,
      taskVerified: false
    });
  });

  it('Harness 验证过程中 Provider 指纹变化时拒绝旧探测结果', async () => {
    providerIsReady = true;
    const providerRows = [{
      id: 'provider-row', base_url: 'https://provider.test/v1', model: 'initial-model',
      api_key_ref: 'secret:provider:key', is_default: 1
    }];
    const db = makeDb({
      'eng-deepseek-harness': {
        id: 'eng-deepseek-harness', status: 'AUTH_REQUIRED', auth_status: 'required'
      }
    }, providerRows);
    db.setSetting('secret:provider:key', 'initial-encrypted-key');
    acpProbeMocks.task.mockImplementation(async () => {
      providerRows[0].model = 'changed-model';
      return {
        ok: true, message: '最小 ACP 任务已返回模型文本', initialized: true,
        sessionCreated: true, output: 'STALE_RESULT'
      };
    });

    const result = await new EngineManager(db as never).probeAuth('eng-deepseek-harness');

    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain('配置在验证过程中发生变化');
    expect(db._engines['eng-deepseek-harness']).toMatchObject({
      status: 'AUTH_REQUIRED', auth_status: 'required'
    });
    expect(db._settings['engine:health:eng-deepseek-harness']).toMatchObject({
      authenticated: false, taskVerified: false
    });
  });
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

describe('自定义 ACP 引擎注册', () => {
  it('把启动命令和参数作为 acpCommand 持久化到数据库', () => {
    const db = makeDb();
    const result = new EngineManager(db as never).registerCustom({
      name: 'DeepSeek Harness',
      command: 'dsh',
      args: 'acp --profile opc-nexus',
      dataBoundary: '仅发送给用户配置的模型供应商'
    });

    expect(result.ok).toBe(true);
    expect(result.id).toMatch(/^eng-custom-/);
    const persisted = JSON.parse(db._engines[result.id!].config_json as string);
    expect(persisted.acpCommand).toEqual(['dsh', 'acp', '--profile', 'opc-nexus']);
  });
});
