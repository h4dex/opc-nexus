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
const { safeStorage } = await import('electron');

const appCfg: { engines: Record<string, unknown>; npmRegistry: string } = { engines: {}, npmRegistry: 'https://registry.npmmirror.com' };
vi.mock('../src/main/services/config.js', () => ({
  loadConfig: () => appCfg,
  sanitizeRegistry: (v: unknown) => (typeof v === 'string' ? v : null)
}));

// 供应商就绪状态由用例控制(内置 Nexus 的鉴权依据)
let providerIsReady = false;
vi.mock('../src/main/services/provider.js', () => ({
  providerReady: () => providerIsReady,
  getProviderSettings: () => providerIsReady
    ? { baseUrl: 'https://provider.test/v1', model: 'test-model' }
    : { baseUrl: '', model: '' },
  readProviderKey: () => providerIsReady ? 'test-provider-key' : null
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

const {
  EngineManager,
  ENGINE_CATALOG,
  RETIRED_ENGINE_IDS,
  CLI_FAILURE_BODY_PATTERN,
  cliInstallWasDetected,
  cliLaunchProbeTimeoutMs
} = await import('../src/main/services/engineManager.js');
const {
  HARNESS_PROVIDER_FINGERPRINT_SETTING,
  harnessProviderFingerprint
} = await import('../src/main/services/harnessProviderVerification.js');

/** 内存 engines 表桩:支持状态读写,便于断言状态迁移 */
function makeDb(
  engines: Record<string, Record<string, unknown>> = {},
  providers: Record<string, unknown>[] = [],
  agents: Record<string, unknown>[] = []
) {
  const settings: Record<string, unknown> = {};
  return {
    _engines: engines,
    raw: {
      prepare: (sql: string) => ({
        get: (id: string) => {
          if (/FROM providers/.test(sql)) {
            if (/COUNT\(\*\)/.test(sql)) return { c: providers.length };
            if (/WHERE id = \?/.test(sql)) return providers.find((provider) => provider.id === id);
            if (/is_default = 1/.test(sql)) return providers.find((provider) => provider.is_default === 1);
            return providers[0];
          }
          const e = engines[id];
          if (!e) return undefined;
          if (/SELECT status FROM engines/.test(sql)) return { status: e.status };
          if (/SELECT path FROM engines/.test(sql)) return { path: e.path ?? null };
          if (/SELECT config_json FROM engines/.test(sql)) return { config_json: e.config_json };
          return e;
        },
        all: (...args: unknown[]) => {
          if (/FROM providers/.test(sql)) return providers;
          if (/FROM agents/.test(sql)) {
            return agents.filter((agent) => agent.engine_id === args[0]
              && agent.archived === 0
              && (agent.provider_id != null || String(agent.model_override ?? '').trim() !== ''));
          }
          return Object.values(engines);
        },
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
            if (/AND status = 'HEALTHY'/.test(sql) && engines[id as string]?.status !== 'HEALTHY') {
              return { changes: 0 };
            }
            if (engines[id as string]) Object.assign(engines[id as string], { status, auth_status: authStatus });
            return { changes: 1 };
          }
          if (/UPDATE engines SET status = 'AUTH_REQUIRED', auth_status = 'required' WHERE id = \?/.test(sql)) {
            const [id] = args;
            if (/AND status = 'HEALTHY'/.test(sql) && engines[id as string]?.status !== 'HEALTHY') {
              return { changes: 0 };
            }
            if (engines[id as string]) Object.assign(engines[id as string], { status: 'AUTH_REQUIRED', auth_status: 'required' });
            return { changes: engines[id as string] ? 1 : 0 };
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
          if (/UPDATE engines SET status = 'AUTH_REQUIRED', auth_status = 'required', version = \?, path = \? WHERE id = \?/.test(sql)) {
            const [version, path, id] = args;
            if (engines[id as string]) Object.assign(engines[id as string], {
              status: 'AUTH_REQUIRED',
              auth_status: 'required',
              version,
              path
            });
            return { changes: engines[id as string] ? 1 : 0 };
          }
          if (/UPDATE engines SET config_json = \? WHERE id = \?/.test(sql)) {
            const [json, id] = args;
            if (engines[id as string]) engines[id as string].config_json = json;
            return { changes: 1 };
          }
          if (/DELETE FROM settings WHERE key = \?/.test(sql)) {
            const [key] = args;
            const existed = key as string in settings;
            delete settings[key as string];
            return { changes: existed ? 1 : 0 };
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
  it('CLI 安装成功后允许处于待真实验证状态', () => {
    expect(cliInstallWasDetected('AUTH_REQUIRED')).toBe(true);
    expect(cliInstallWasDetected('HEALTHY')).toBe(true);
    expect(cliInstallWasDetected('NOT_INSTALLED')).toBe(false);
    expect(cliInstallWasDetected('ERROR')).toBe(false);
  });

  it('目录包含控制内核与已验证的 Worker runtime', () => {
    expect(ENGINE_CATALOG.map((e) => e.id).sort()).toEqual(
      ['eng-claude', 'eng-codex', 'eng-deepseek-harness', 'eng-deepseek-harness-managed', 'eng-hermes-cli', 'eng-nexus', 'eng-opencode', 'eng-pi'].sort()
    );
    expect(ENGINE_CATALOG.find((e) => e.id === 'eng-deepseek-harness')).toMatchObject({
      type: 'external',
      bin: null,
      npmPackage: null
    });
    expect(ENGINE_CATALOG.find((e) => e.id === 'eng-deepseek-harness-managed')).toMatchObject({
      type: 'dsh-managed',
      name: 'DSH / Cordis',
      bin: null,
      npmPackage: null
    });
  });

  it('下线引擎不在目录中', () => {
    const ids = new Set(ENGINE_CATALOG.map((e) => e.id));
    for (const retired of RETIRED_ENGINE_IDS) expect(ids.has(retired)).toBe(false);
  });

  it('Nexus 为内置引擎(无 bin,不做 CLI 检测)', () => {
    expect(ENGINE_CATALOG.find((e) => e.id === 'eng-nexus')?.bin).toBeNull();
  });

  it('Hermes CLI 走 hermes 二进制且无 npm 包(PowerShell 脚本安装)', () => {
    const hermes = ENGINE_CATALOG.find((e) => e.id === 'eng-hermes-cli');
    expect(hermes?.bin).toBe('hermes');
    expect(hermes?.npmPackage).toBeNull();
  });

  it('Claude Code uses the official CLI package as a Worker', () => {
    expect(ENGINE_CATALOG.find((e) => e.id === 'eng-claude')).toMatchObject({
      type: 'claude',
      bin: 'claude',
      npmPackage: '@anthropic-ai/claude-code'
    });
    expect(RETIRED_ENGINE_IDS).not.toContain('eng-claude');
  });

  it('每个引擎都声明数据边界(15.1 要求外部引擎展示数据发送方)', () => {
    for (const e of ENGINE_CATALOG) expect(e.dataBoundary.length).toBeGreaterThan(0);
  });
});

describe('鉴权探测状态迁移(H-4)', () => {
  it('Hermes 员工 Profile 首次迁移获得更长的启动窗口', () => {
    expect(cliLaunchProbeTimeoutMs('eng-hermes-cli', { HERMES_HOME: 'C:\\profiles\\employee' })).toBe(45_000);
    expect(cliLaunchProbeTimeoutMs('eng-hermes-cli', {})).toBe(15_000);
    expect(cliLaunchProbeTimeoutMs('eng-pi', { PI_CODING_AGENT_DIR: 'C:\\profiles\\pi' })).toBe(45_000);
    expect(cliLaunchProbeTimeoutMs('eng-pi', {})).toBe(45_000);
    expect(cliLaunchProbeTimeoutMs('eng-claude', {})).toBe(15_000);
    expect(cliLaunchProbeTimeoutMs('eng-codex', { HERMES_HOME: 'ignored' })).toBe(15_000);
  });

  it('不把零退出码中的供应商错误正文当作健康结果', () => {
    expect(CLI_FAILURE_BODY_PATTERN.test('HTTP 401: Missing Authentication header')).toBe(true);
    expect(CLI_FAILURE_BODY_PATTERN.test('No usable credentials found for provider')).toBe(true);
    expect(CLI_FAILURE_BODY_PATTERN.test('pong')).toBe(false);
  });

  it('detect 让 runtime、Provider 与安全代理均就绪的 Cordis 成为 HEALTHY', async () => {
    const provider = {
      id: 'provider-default', base_url: 'https://provider.test/v1', model: 'cordis-model',
      api_key_ref: 'secret:provider:cordis', is_default: 1
    };
    const db = makeDb({}, [provider]);
    db._settings[provider.api_key_ref] = Buffer.from('enc:cordis-key').toString('base64');
    for (const id of ['eng-hermes-cli', 'eng-opencode', 'eng-codex', 'eng-claude', 'eng-pi']) {
      appCfg.engines[id] = { bin: `missing-${id}` };
    }
    const manager = new EngineManager(db as never, {
      managedDshRuntimeAvailable: () => true,
      managedDshProxyReady: () => true
    });

    await manager.detect();

    expect(db._engines['eng-deepseek-harness-managed']).toMatchObject({
      status: 'HEALTHY', auth_status: 'authed', version: '0.1.0-rc.6'
    });
    expect(db._settings['engine:health:eng-deepseek-harness-managed']).toMatchObject({
      detected: true, launchable: true, authenticated: true, taskVerified: false
    });
  });

  it('probeAuth 对缺少 Provider proxy 的 Cordis 保持 DEGRADED', async () => {
    const provider = {
      id: 'provider-default', base_url: 'https://provider.test/v1', model: 'cordis-model',
      api_key_ref: 'secret:provider:cordis', is_default: 1
    };
    const db = makeDb({
      'eng-deepseek-harness-managed': {
        id: 'eng-deepseek-harness-managed', type: 'dsh-managed', status: 'AUTH_REQUIRED', auth_status: 'required'
      }
    }, [provider]);
    db._settings[provider.api_key_ref] = Buffer.from('enc:cordis-key').toString('base64');

    const result = await new EngineManager(db as never, {
      managedDshRuntimeAvailable: () => true,
      managedDshProxyReady: () => false
    }).probeAuth('eng-deepseek-harness-managed');

    expect(result.ok).toBe(false);
    expect(db._engines['eng-deepseek-harness-managed']).toMatchObject({
      status: 'DEGRADED', auth_status: 'authed'
    });
  });

  it('restart 在 managed runtime 缺失时将 Cordis 收敛为 NOT_INSTALLED', async () => {
    const db = makeDb({
      'eng-deepseek-harness-managed': {
        id: 'eng-deepseek-harness-managed', type: 'dsh-managed', status: 'HEALTHY', auth_status: 'authed'
      }
    });

    const result = await new EngineManager(db as never, {
      managedDshRuntimeAvailable: () => false,
      managedDshProxyReady: () => true
    }).restart('eng-deepseek-harness-managed');

    expect(result.ok).toBe(false);
    expect(db._engines['eng-deepseek-harness-managed']).toMatchObject({
      status: 'NOT_INSTALLED', auth_status: 'unknown', version: null, path: null
    });
  });

  it('Provider 默认路由变更后仍按真实 proxy readiness 保持 Cordis HEALTHY', () => {
    const provider = {
      id: 'provider-default', base_url: 'https://provider.test/v1', model: 'cordis-model',
      api_key_ref: 'secret:provider:cordis', is_default: 1
    };
    const db = makeDb({
      'eng-deepseek-harness-managed': {
        id: 'eng-deepseek-harness-managed', type: 'dsh-managed', status: 'HEALTHY', auth_status: 'authed'
      }
    }, [provider]);
    db._settings[provider.api_key_ref] = Buffer.from('enc:cordis-key').toString('base64');

    new EngineManager(db as never, {
      managedDshRuntimeAvailable: () => true,
      managedDshProxyReady: () => true
    }).invalidateProviderVerification({
      providerId: provider.id, providerUpdated: false, defaultRouteChanged: true
    });

    expect(db._engines['eng-deepseek-harness-managed']).toMatchObject({
      status: 'HEALTHY', auth_status: 'authed'
    });
    expect(db._settings['engine:health:eng-deepseek-harness-managed']).toMatchObject({
      taskVerified: false, authenticated: true
    });
  });

  it('运行时鉴权失败会撤销 HEALTHY 证明并要求重新验证', () => {
    const db = makeDb({
      'eng-hermes-cli': { id: 'eng-hermes-cli', status: 'HEALTHY', auth_status: 'authed' }
    });
    const manager = new EngineManager(db as never);

    manager.reportAuthenticationFailure('eng-hermes-cli', 'HTTP 403 Forbidden');
    manager.reportAuthenticationFailure('eng-hermes-cli', 'HTTP 403 Forbidden');

    expect(db._engines['eng-hermes-cli']).toMatchObject({ status: 'AUTH_REQUIRED', auth_status: 'required' });
    expect(manager.getHealthSignals('eng-hermes-cli')).toMatchObject({
      detected: true, launchable: true, authenticated: false, taskVerified: false,
      detail: 'HTTP 403 Forbidden'
    });
    expect(db.audit).toHaveBeenCalledTimes(1);
    expect(db.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'engine.runtimeAuthFailure', target: 'eng-hermes-cli', result: 'AUTH_REQUIRED'
    }));
  });

  it('本地 Runtime 准备失败会降级但保留已验证的 Provider 鉴权', () => {
    const db = makeDb({
      'eng-hermes-cli': { id: 'eng-hermes-cli', status: 'HEALTHY', auth_status: 'authed' }
    });
    const manager = new EngineManager(db as never);

    manager.reportRuntimeFailure('eng-hermes-cli', 'EACCES: profile is not writable');
    manager.reportRuntimeFailure('eng-hermes-cli', 'EACCES: profile is not writable');

    expect(db._engines['eng-hermes-cli']).toMatchObject({ status: 'DEGRADED', auth_status: 'authed' });
    expect(manager.getHealthSignals('eng-hermes-cli')).toMatchObject({
      detected: true, launchable: true, authenticated: true, taskVerified: false,
      detail: 'EACCES: profile is not writable'
    });
    expect(db.audit).toHaveBeenCalledTimes(1);
    expect(db.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'engine.runtimeFailure', target: 'eng-hermes-cli', result: 'DEGRADED'
    }));
  });

  it('内置 Nexus:供应商就绪 → HEALTHY + authed', async () => {
    providerIsReady = true;
    const db = makeDb({ 'eng-nexus': { id: 'eng-nexus', status: 'SETUP_REQUIRED', auth_status: 'required' } });
    const r = await new EngineManager(db as never).probeAuth('eng-nexus');
    expect(r.ok).toBe(true);
    expect(db._engines['eng-nexus'].status).toBe('HEALTHY');
    expect(db._engines['eng-nexus'].auth_status).toBe('authed');
  });

  it('内置 Nexus:供应商未配置 → SETUP_REQUIRED,不伪装成已登录', async () => {
    providerIsReady = false;
    const db = makeDb({ 'eng-nexus': { id: 'eng-nexus', status: 'SETUP_REQUIRED', auth_status: 'required' } });
    const r = await new EngineManager(db as never).probeAuth('eng-nexus');
    expect(r.ok).toBe(false);
    expect(db._engines['eng-nexus'].status).toBe('SETUP_REQUIRED');
    expect(db._engines['eng-nexus'].auth_status).toBe('required');
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

  it('CLI 重启只证明可启动，必须回到 AUTH_REQUIRED 等待真实探活', async () => {
    appCfg.engines['eng-opencode'] = { bin: 'node' };
    const db = makeDb({
      'eng-opencode': { id: 'eng-opencode', status: 'HEALTHY', auth_status: 'authed' }
    });
    const r = await new EngineManager(db as never).restart('eng-opencode');
    expect(r.ok).toBe(true);
    expect(db._engines['eng-opencode']).toMatchObject({ status: 'AUTH_REQUIRED', auth_status: 'required' });
    expect(db._settings['engine:health:eng-opencode']).toMatchObject({
      detected: true, launchable: true, authenticated: false, taskVerified: false
    });
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
    for (const id of ['eng-hermes-cli', 'eng-opencode', 'eng-codex', 'eng-claude', 'eng-pi']) {
      appCfg.engines[id] = { bin: `missing-${id}` };
    }

    await new EngineManager(db as never).detect();

    expect(db._engines['eng-deepseek-harness']).toMatchObject({
      status: 'HEALTHY',
      auth_status: 'authed'
    });
    expect(db._engines['eng-nexus']).toMatchObject({
      status: 'HEALTHY',
      auth_status: 'authed'
    });
    expect(db._settings['engine:health:eng-deepseek-harness']).toMatchObject({
      authenticated: true,
      taskVerified: true,
      detail: 'OPC_HARNESS_OK'
    });
  });

  it('Harness 指纹包含引擎级 Provider/模型配置', () => {
    const db = makeDb({
      'eng-deepseek-harness': {
        id: 'eng-deepseek-harness',
        config_json: JSON.stringify({ providerId: 'provider-a', modelOverride: 'model-a' })
      }
    });
    const before = harnessProviderFingerprint(db as never);
    db._engines['eng-deepseek-harness'].config_json = JSON.stringify({
      providerId: 'provider-a',
      modelOverride: 'model-b'
    });
    expect(harnessProviderFingerprint(db as never)).not.toBe(before);
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
    for (const id of ['eng-hermes-cli', 'eng-opencode', 'eng-codex', 'eng-claude', 'eng-pi']) {
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

  it('Provider 配置变更会清除 Nexus 与显式受管 CLI 的健康证明', () => {
    const db = makeDb({
      'eng-nexus': { id: 'eng-nexus', type: 'nexus', status: 'HEALTHY', auth_status: 'authed' },
      'eng-codex': {
        id: 'eng-codex', type: 'codex', status: 'HEALTHY', auth_status: 'authed',
        config_json: JSON.stringify({ providerId: 'provider-missing', protocol: 'openai-responses' })
      },
      'eng-claude': { id: 'eng-claude', type: 'claude', status: 'HEALTHY', auth_status: 'authed' }
    });
    new EngineManager(db as never).invalidateProviderVerification();

    expect(db._engines['eng-nexus']).toMatchObject({ status: 'SETUP_REQUIRED', auth_status: 'required' });
    expect(db._engines['eng-codex']).toMatchObject({ status: 'AUTH_REQUIRED', auth_status: 'required' });
    // No managed Provider or engine binding: native Claude login remains valid.
    expect(db._engines['eng-claude']).toMatchObject({ status: 'HEALTHY', auth_status: 'authed' });
  });

  it('首个完整默认 Provider 让已启动的 managed runtime 进入待真实验证状态', () => {
    const provider = {
      id: 'provider-default', base_url: 'https://provider.test/v1', model: 'model',
      api_key_ref: 'secret:provider:default', is_default: 1
    };
    const db = makeDb({
      'eng-nexus': { id: 'eng-nexus', type: 'nexus', status: 'SETUP_REQUIRED', auth_status: 'required' },
      'eng-deepseek-harness': { id: 'eng-deepseek-harness', type: 'external', status: 'SETUP_REQUIRED', auth_status: 'required' },
      'eng-hermes-cli': { id: 'eng-hermes-cli', type: 'hermes-cli', status: 'SETUP_REQUIRED', auth_status: 'required' },
      'eng-pi': { id: 'eng-pi', type: 'pi', status: 'SETUP_REQUIRED', auth_status: 'required' }
    }, [provider]);
    db._settings['secret:provider:default'] = Buffer.from('enc:provider-key').toString('base64');
    for (const id of ['eng-deepseek-harness', 'eng-hermes-cli', 'eng-pi']) {
      db._settings[`engine:health:${id}`] = {
        detected: true, launchable: true, authenticated: false, taskVerified: false, detail: 'provider missing'
      };
    }

    new EngineManager(db as never).invalidateProviderVerification({
      providerId: provider.id,
      providerUpdated: false,
      defaultRouteChanged: true
    });

    expect(db._engines['eng-nexus']).toMatchObject({ status: 'HEALTHY', auth_status: 'authed' });
    for (const id of ['eng-deepseek-harness', 'eng-hermes-cli', 'eng-pi']) {
      expect(db._engines[id]).toMatchObject({ status: 'AUTH_REQUIRED', auth_status: 'required' });
    }
  });

  it('员工级 Provider 变更会失效对应 CLI，但不影响未绑定的外部 ACP', () => {
    const db = makeDb({
      'eng-codex': {
        id: 'eng-codex', type: 'codex', status: 'HEALTHY', auth_status: 'authed',
        config_json: JSON.stringify({ providerMode: 'native' })
      },
      'eng-hermes-cli': {
        id: 'eng-hermes-cli', type: 'hermes-cli', status: 'HEALTHY', auth_status: 'authed'
      },
      'eng-custom-local': {
        id: 'eng-custom-local', type: 'external', status: 'HEALTHY', auth_status: 'authed',
        config_json: JSON.stringify({ providerMode: 'native' })
      }
    }, [{
      id: 'provider-default', base_url: 'https://default.test/v1', model: 'default-model',
      api_key_ref: 'secret:provider:default', is_default: 1
    }, {
      id: 'provider-agent', base_url: 'https://agent.test/v1', model: 'agent-model',
      api_key_ref: 'secret:provider:agent', is_default: 0
    }], [{
      id: 'agent-codex', engine_id: 'eng-codex', provider_id: 'provider-agent', model_override: null, archived: 0
    }, {
      id: 'agent-hermes', engine_id: 'eng-hermes-cli', provider_id: 'provider-agent', model_override: null, archived: 0
    }]);
    db._settings['secret:provider:default'] = Buffer.from('enc:default-key').toString('base64');
    db._settings['engine:health:eng-hermes-cli'] = {
      detected: true, launchable: true, authenticated: true, taskVerified: true, detail: 'ok'
    };

    new EngineManager(db as never).invalidateProviderVerification({
      providerId: 'provider-agent',
      providerUpdated: true,
      defaultRouteChanged: false
    });

    expect(db._engines['eng-codex']).toMatchObject({ status: 'AUTH_REQUIRED', auth_status: 'required' });
    expect(db._engines['eng-hermes-cli']).toMatchObject({ status: 'AUTH_REQUIRED', auth_status: 'required' });
    expect(db._settings['engine:health:eng-hermes-cli']).toMatchObject({
      authenticated: false, taskVerified: false
    });
    expect(db._engines['eng-custom-local']).toMatchObject({ status: 'HEALTHY', auth_status: 'authed' });
  });

  it('keeps a native custom ACP healthy when only its employee model preference exists', () => {
    const db = makeDb({
      'eng-custom-local': {
        id: 'eng-custom-local', type: 'external', status: 'HEALTHY', auth_status: 'authed',
        config_json: JSON.stringify({ providerMode: 'native' })
      }
    }, [{
      id: 'provider-default', base_url: 'https://default.test/v1', model: 'default-model',
      api_key_ref: 'secret:provider:default', is_default: 1
    }], [{
      id: 'agent-custom', engine_id: 'eng-custom-local', provider_id: null,
      model_override: 'runtime-owned-model', archived: 0
    }]);

    new EngineManager(db as never).invalidateProviderVerification({
      providerId: 'provider-default',
      providerUpdated: true,
      defaultRouteChanged: true
    });

    expect(db._engines['eng-custom-local']).toMatchObject({ status: 'HEALTHY', auth_status: 'authed' });
  });
});

describe('引擎配置凭据脱敏(S-4)', () => {
  it('持久化 Provider、模型和协议，并保留外部 ACP 启动命令', () => {
    const db = makeDb({
      'eng-codex': {
        id: 'eng-codex', status: 'HEALTHY', auth_status: 'authed',
        config_json: JSON.stringify({ acpCommand: ['adapter', '--stdio'] })
      }
    }, [{
      id: 'provider-responses', base_url: 'https://provider.test/v1', model: 'base-model',
      api_key_ref: 'secret:provider:responses', is_default: 1
    }]);
    const manager = new EngineManager(db as never);

    manager.saveConfig('eng-codex', {
      providerId: 'provider-responses',
      modelOverride: 'worker-model',
      protocol: 'openai-responses'
    });

    expect(manager.getConfig('eng-codex')).toMatchObject({
      providerId: 'provider-responses',
      modelOverride: 'worker-model',
      protocol: 'openai-responses',
      acpCommand: ['adapter', '--stdio']
    });
    expect(db._engines['eng-codex']).toMatchObject({ status: 'AUTH_REQUIRED', auth_status: 'required' });
  });

  it('拒绝不存在的 Provider 和不兼容协议且不修改旧配置', () => {
    const original = JSON.stringify({ runArgs: ['exec'] });
    const db = makeDb({
      'eng-codex': { id: 'eng-codex', status: 'HEALTHY', config_json: original }
    });
    const manager = new EngineManager(db as never);

    expect(() => manager.saveConfig('eng-codex', {
      providerId: 'missing', protocol: 'openai-responses'
    })).toThrow('does not exist');
    expect(() => manager.saveConfig('eng-codex', {
      protocol: 'openai-chat'
    })).toThrow(/requires openai-responses/);
    expect(db._engines['eng-codex'].config_json).toBe(original);
  });

  it('保存配置前拒绝不存在的引擎，且不写入任何配置或密钥', () => {
    const db = makeDb();
    const manager = new EngineManager(db as never);
    expect(() => manager.saveConfig('eng-missing', {
      env: { OPENAI_API_KEY: 'must-not-persist' },
      modelOverride: 'model'
    })).toThrow(/Engine does not exist/);
    expect(db._engines['eng-missing']).toBeUndefined();
    expect(JSON.stringify(db._settings)).not.toContain('must-not-persist');
  });

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

  it('只替换一个敏感变量时保留其他占位符对应的已加密值', () => {
    const db = makeDb({ 'eng-opencode': { id: 'eng-opencode', type: 'opencode', status: 'HEALTHY' } });
    const manager = new EngineManager(db as never);
    manager.saveConfig('eng-opencode', {
      env: { OPENAI_API_KEY: 'first-key', SERVICE_TOKEN: 'retained-token' }
    });

    manager.saveConfig('eng-opencode', {
      env: { OPENAI_API_KEY: 'replacement-key', SERVICE_TOKEN: '***' }
    });

    expect(manager.resolveEnv('eng-opencode')).toMatchObject({
      OPENAI_API_KEY: 'replacement-key',
      SERVICE_TOKEN: 'retained-token'
    });
  });

  it('占位符对应密文缺失时拒绝保存，不会借用默认 Provider 凭据', () => {
    providerIsReady = true;
    const original = JSON.stringify({ providerMode: 'native', env: { API_KEY: '***' } });
    const db = makeDb({
      'eng-opencode': { id: 'eng-opencode', type: 'opencode', status: 'HEALTHY', config_json: original }
    });

    expect(() => new EngineManager(db as never).saveConfig('eng-opencode', {
      providerMode: 'native', env: { API_KEY: '***' }
    })).toThrow('Configured engine credential is unavailable: API_KEY');
    expect(db._engines['eng-opencode'].config_json).toBe(original);
  });

  it('提交空 env 会删除旧密文及配置中的占位符', () => {
    const db = makeDb({ 'eng-opencode': { id: 'eng-opencode', type: 'opencode', status: 'HEALTHY' } });
    const manager = new EngineManager(db as never);
    manager.saveConfig('eng-opencode', { env: { API_KEY: 'remove-me' } });
    expect(db._settings['secret:engine:eng-opencode:env']).toBeTruthy();

    manager.saveConfig('eng-opencode', { env: {} });

    expect(db._settings['secret:engine:eng-opencode:env']).toBeUndefined();
    expect(manager.getConfig('eng-opencode')?.env).toEqual({});
  });

  it('系统加密不可用时在任何数据库写入前拒绝新密钥', () => {
    const original = JSON.stringify({ providerMode: 'native', runArgs: ['run'] });
    const db = makeDb({
      'eng-opencode': { id: 'eng-opencode', type: 'opencode', status: 'HEALTHY', config_json: original }
    });
    const unavailable = vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(false);
    try {
      expect(() => new EngineManager(db as never).saveConfig('eng-opencode', {
        env: { API_KEY: 'must-not-persist' }
      })).toThrow('系统加密不可用');
      expect(db._engines['eng-opencode'].config_json).toBe(original);
      expect(JSON.stringify(db._settings)).not.toContain('must-not-persist');
    } finally {
      unavailable.mockRestore();
    }
  });

  it('保存无关字段时保留 Codex 的原生登录模式', () => {
    const db = makeDb({
      'eng-codex': {
        id: 'eng-codex', type: 'codex', status: 'HEALTHY',
        config_json: JSON.stringify({ runArgs: ['exec'] })
      }
    });
    const manager = new EngineManager(db as never);

    manager.saveConfig('eng-codex', { maxConcurrency: 4 });

    expect(manager.getConfig('eng-codex')).toMatchObject({ providerMode: 'native', maxConcurrency: 4 });
    expect(manager.getConfig('eng-codex')).not.toHaveProperty('providerId');
    expect(manager.getConfig('eng-codex')).not.toHaveProperty('protocol');
  });

  it('managed 模式可显式使用应用默认 Provider', () => {
    const db = makeDb({
      'eng-codex': { id: 'eng-codex', type: 'codex', status: 'HEALTHY' }
    });
    const manager = new EngineManager(db as never);

    manager.saveConfig('eng-codex', {
      providerMode: 'managed', providerId: '', modelOverride: '', protocol: 'openai-responses'
    });

    expect(manager.getConfig('eng-codex')).toMatchObject({
      providerMode: 'managed', protocol: 'openai-responses'
    });
    expect(manager.getConfig('eng-codex')).not.toHaveProperty('providerId');
  });

  it('自定义 ACP 保存无关字段时默认保持 Runtime 自主管理', () => {
    const db = makeDb({
      'eng-custom-local': {
        id: 'eng-custom-local', type: 'external', status: 'HEALTHY',
        config_json: JSON.stringify({ acpCommand: ['local-acp'] })
      }
    });
    const manager = new EngineManager(db as never);

    manager.saveConfig('eng-custom-local', { maxConcurrency: 1 });

    expect(manager.getConfig('eng-custom-local')).toMatchObject({ providerMode: 'native', maxConcurrency: 1 });
  });

  it.each([
    ['model override', { modelOverride: 'legacy-model' }],
    ['protocol', { protocol: 'openai-chat' as const }]
  ])('cleans a legacy custom ACP %s when saving an unrelated field', (_label, legacyFields) => {
    const db = makeDb({
      'eng-custom-local': {
        id: 'eng-custom-local', type: 'external', status: 'HEALTHY',
        config_json: JSON.stringify({ acpCommand: ['local-acp'], ...legacyFields })
      }
    });
    const manager = new EngineManager(db as never);

    manager.saveConfig('eng-custom-local', { maxConcurrency: 2 });

    expect(manager.getConfig('eng-custom-local')).toMatchObject({
      acpCommand: ['local-acp'], providerMode: 'native', maxConcurrency: 2
    });
    expect(manager.getConfig('eng-custom-local')).not.toHaveProperty('providerId');
    expect(manager.getConfig('eng-custom-local')).not.toHaveProperty('modelOverride');
    expect(manager.getConfig('eng-custom-local')).not.toHaveProperty('protocol');
  });

  it.each([
    ['separate API key flag', ['--api-key', 'sk-must-not-persist']],
    ['uppercase underscore assignment', ['--API_KEY=sk-must-not-persist']],
    ['camel-case access token', ['--accessToken', 'must-not-persist']],
    ['environment-style assignment', ['OPENAI_API_KEY=must-not-persist']],
    ['Windows-style client secret', ['/Client_Secret:must-not-persist']],
    ['authorization header', ['--header', 'Authorization: Bearer must-not-persist']],
    ['quoted API key header', ['--header', '"X-API-Key: must-not-persist"']],
    ['secret key variant', ['--SECRET_KEY', 'must-not-persist']],
    ['passphrase variant', ['--PassPhrase=must-not-persist']]
  ])('rejects credential-bearing runArgs before persistence: %s', (_label, runArgs) => {
    const original = JSON.stringify({ runArgs: ['--model', 'safe-model'] });
    const db = makeDb({
      'eng-opencode': { id: 'eng-opencode', status: 'HEALTHY', config_json: original }
    });
    const mgr = new EngineManager(db as never);

    expect(() => mgr.saveConfig('eng-opencode', { runArgs })).toThrow(/credential/i);
    expect(db._engines['eng-opencode'].config_json).toBe(original);
    expect(JSON.stringify(db._engines)).not.toContain('must-not-persist');
  });

  it('preserves safe token-related arguments', () => {
    const db = makeDb({ 'eng-opencode': { id: 'eng-opencode', status: 'HEALTHY' } });
    const mgr = new EngineManager(db as never);
    const runArgs = [
      '--model', 'deepseek-chat', '--max-tokens', '4096', '--token-budget', '8192',
      '--api-key-env', 'OPENAI_API_KEY', '--secret-file', 'C:\\secrets\\provider.txt'
    ];

    mgr.saveConfig('eng-opencode', { runArgs });

    expect(mgr.getConfig('eng-opencode')?.runArgs).toEqual(runArgs);
  });

  it.each([
    ['runArgs', { runArgs: ['--TOKEN=legacy-secret'] }],
    ['ACP arguments', { acpCommand: ['dsh', 'acp', '--Api_Key', 'legacy-secret'] }]
  ])('refuses to expose legacy config containing sensitive %s', (_label, config) => {
    const db = makeDb({
      'eng-custom-old': {
        id: 'eng-custom-old',
        status: 'HEALTHY',
        config_json: JSON.stringify(config)
      }
    });

    expect(() => new EngineManager(db as never).getConfig('eng-custom-old')).toThrow(/credential/i);
  });
});

describe('自定义 ACP 引擎注册', () => {
  it.each([
    '--token plain-secret',
    '--API_KEY=inline-secret',
    '--clientSecret inline-secret',
    'OPENAI_ACCESS_TOKEN=inline-secret'
  ])('rejects credential arguments before inserting an engine: %s', (args) => {
    const db = makeDb();
    const result = new EngineManager(db as never).registerCustom({
      name: 'Unsafe ACP',
      command: 'dsh',
      args
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.message).toMatch(/credential/i);
    expect(Object.keys(db._engines)).toHaveLength(0);
    expect(JSON.stringify(db._engines)).not.toContain('secret');
  });

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
