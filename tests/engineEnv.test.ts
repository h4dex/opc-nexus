/**
 * 引擎环境变量密钥隔离测试
 *
 * 覆盖安全基线：引擎自定义 env 中的凭据不得明文落库、不得进入 Renderer 可见的
 * config_json，且主进程 spawn 时必须能还原完整 env。
 *
 * @author liyingjie <y@senke.com>
 */
// @ts-nocheck
/* eslint-disable */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

// 供应商配置由用例控制：验证凭据下发行为
let mockProvider: { baseUrl: string; model: string } = { baseUrl: '', model: '' };
let mockKey: string | null = null;
vi.mock('../src/main/services/provider.js', () => ({
  getProviderSettings: () => mockProvider,
  readProviderKey: () => mockKey
}));

const {
  childProcessEnv,
  createSensitiveTextRedactor,
  engineEnvSecretRef,
  providerEnvFor,
  redactSensitiveText,
  requiredProviderProtocol,
  resolveClaudeEngineEnv,
  resolveConfiguredEngineEnv,
  resolveEngineEnv,
  resolveEngineProvider,
  resolveOpenCodeEngineEnv,
  splitSecretEnv,
  SECRET_PLACEHOLDER
} =
  await import('../src/main/services/engineEnv.js');

beforeEach(() => {
  mockProvider = { baseUrl: '', model: '' };
  mockKey = null;
});

/** 最小 Database 桩：engines.config_json + settings 键值 */
function makeDb(configJson?: string, settings: Record<string, string> = {}, engineType?: string) {
  return {
    raw: {
      prepare: (sql: string) => ({
        get: () => (sql.includes('engines') ? { config_json: configJson, type: engineType } : undefined),
        all: () => [],
        run: () => ({ changes: 1 })
      })
    },
    getSetting: (key: string, fallback: unknown) => settings[key] ?? fallback
  };
}

describe('splitSecretEnv', () => {
  it('把凭据类变量归入 secrets，config_json 中只留占位符', () => {
    const { safe, secrets } = splitSecretEnv({
      API_KEY: 'sk-real-value',
      GITHUB_TOKEN: 'ghp_abc',
      NODE_ENV: 'production'
    });

    expect(secrets).toEqual({ API_KEY: 'sk-real-value', GITHUB_TOKEN: 'ghp_abc' });
    expect(safe.API_KEY).toBe(SECRET_PLACEHOLDER);
    expect(safe.GITHUB_TOKEN).toBe(SECRET_PLACEHOLDER);
    // 非敏感变量保持明文，便于 UI 展示与编辑
    expect(safe.NODE_ENV).toBe('production');
    // 关键断言：明文凭据绝不出现在将写入 config_json 的对象里
    expect(JSON.stringify(safe)).not.toContain('sk-real-value');
    expect(JSON.stringify(safe)).not.toContain('ghp_abc');
  });

  it('识别 SECRET / PASSWORD / CREDENTIAL / AUTH 等命名', () => {
    const { secrets } = splitSecretEnv({
      CLIENT_SECRET: 'a',
      DB_PASSWORD: 'b',
      GCP_CREDENTIAL: 'c',
      AUTH_HEADER: 'd',
      PROXY_URL: 'e'
    });
    expect(Object.keys(secrets).sort()).toEqual(['AUTH_HEADER', 'CLIENT_SECRET', 'DB_PASSWORD', 'GCP_CREDENTIAL']);
  });

  it('回传占位符表示沿用已存密钥，不写入新值', () => {
    const { safe, secrets } = splitSecretEnv({ API_KEY: SECRET_PLACEHOLDER, LOG_LEVEL: 'debug' });
    // 占位符不应被当成真实密钥覆盖已存值
    expect(secrets).toEqual({});
    expect(safe.API_KEY).toBe(SECRET_PLACEHOLDER);
  });

  it('空输入返回空结果', () => {
    expect(splitSecretEnv({})).toEqual({ safe: {}, secrets: {} });
  });
});

describe('resolveEngineEnv', () => {
  it('合并明文变量与解密后的敏感变量', () => {
    const ref = engineEnvSecretRef('eng-opencode');
    const db = makeDb(
      JSON.stringify({ env: { NODE_ENV: 'production', API_KEY: SECRET_PLACEHOLDER } }),
      { [ref]: Buffer.from('enc:' + JSON.stringify({ API_KEY: 'sk-real-value' })).toString('base64') }
    );

    const env = resolveEngineEnv(db as never, 'eng-opencode');
    expect(env).toEqual({ NODE_ENV: 'production', API_KEY: 'sk-real-value' });
  });

  it('占位符缺少对应密文时 fail closed，不会借用默认供应商凭据', () => {
    const db = makeDb(JSON.stringify({ env: { API_KEY: SECRET_PLACEHOLDER } }));
    expect(() => resolveEngineEnv(db as never, 'eng-opencode'))
      .toThrow('Configured engine credential is unavailable: API_KEY');
  });

  it('config_json 损坏时不抛错', () => {
    const db = makeDb('{not-json');
    expect(() => resolveEngineEnv(db as never, 'eng-x')).not.toThrow();
    expect(resolveEngineEnv(db as never, 'eng-x')).toEqual({});
  });

  it('密文损坏时降级为无敏感变量', () => {
    const ref = engineEnvSecretRef('eng-x');
    const db = makeDb(JSON.stringify({ env: { A: '1' } }), { [ref]: '!!!not-base64-json!!!' });
    expect(resolveEngineEnv(db as never, 'eng-x')).toEqual({ A: '1' });
  });

  it('无配置时返回空对象', () => {
    expect(resolveEngineEnv(makeDb() as never, 'eng-none')).toEqual({});
  });

  it('密钥存储键按引擎隔离', () => {
    expect(engineEnvSecretRef('eng-a')).toBe('secret:engine:eng-a:env');
    expect(engineEnvSecretRef('eng-b')).not.toBe(engineEnvSecretRef('eng-a'));
  });
});

describe('供应商凭据下发给第三方引擎', () => {
  // 背景：第三方 CLI 起来了但读不到凭据，一调用就 401
  // （实测 Hermes 报 "HTTP 401: Missing Authentication header"）。
  // 这里验证应用内配好的供应商能以 OpenAI 兼容变量下发给子进程。

  it('未配置供应商时不下发任何变量', () => {
    expect(providerEnvFor(makeDb() as never)).toEqual({});
  });

  it('缺 key 时不下发（只有 baseUrl 无意义）', () => {
    mockProvider = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' };
    mockKey = null;
    expect(providerEnvFor(makeDb() as never)).toEqual({});
  });

  it('配置齐备时下发 OpenAI 兼容变量', () => {
    mockProvider = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' };
    mockKey = 'sk-deepseek-real';
    const env = providerEnvFor(makeDb() as never);
    expect(env.OPENAI_API_KEY).toBe('sk-deepseek-real');
    expect(env.OPENAI_BASE_URL).toBe('https://api.deepseek.com/v1');
    expect(env.OPENAI_API_BASE).toBe('https://api.deepseek.com/v1'); // 旧名兼容
    expect(env.OPENAI_MODEL).toBe('deepseek-chat');
  });

  it('baseUrl 末尾斜杠被规范化（拼接路径时不产生双斜杠）', () => {
    mockProvider = { baseUrl: 'https://api.deepseek.com/v1///', model: 'm' };
    mockKey = 'sk-x';
    expect(providerEnvFor(makeDb() as never).OPENAI_BASE_URL).toBe('https://api.deepseek.com/v1');
  });

  it('managed-only runtime 会带上应用默认供应商凭据', () => {
    mockProvider = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' };
    mockKey = 'sk-injected';
    const env = resolveEngineEnv(makeDb() as never, 'eng-hermes-cli');
    expect(env.OPENAI_API_KEY).toBe('sk-injected');
  });

  it('用户在引擎配置页手填的同名变量优先于自动下发', () => {
    mockProvider = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' };
    mockKey = 'sk-auto-injected';
    const ref = engineEnvSecretRef('eng-opencode');
    const db = makeDb(
      JSON.stringify({ env: { OPENAI_API_KEY: SECRET_PLACEHOLDER } }),
      { [ref]: Buffer.from('enc:' + JSON.stringify({ OPENAI_API_KEY: 'sk-user-explicit' })).toString('base64') }
    );
    // 用户显式配置的值不被自动下发覆盖，否则引擎配置页形同虚设
    expect(resolveEngineEnv(db as never, 'eng-opencode').OPENAI_API_KEY).toBe('sk-user-explicit');
  });

  it('未设置同名变量时才填充（不影响其他自定义变量）', () => {
    mockProvider = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' };
    mockKey = 'sk-auto';
    const db = makeDb(JSON.stringify({ env: { MY_FLAG: '1' } }));
    const env = resolveEngineEnv(db as never, 'eng-hermes-cli');
    expect(env.MY_FLAG).toBe('1');
    expect(env.OPENAI_API_KEY).toBe('sk-auto');
  });

  it('未显式绑定的自定义 ACP 不会继承应用默认 API Key', () => {
    mockProvider = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' };
    mockKey = 'must-not-reach-custom-acp';
    const env = resolveEngineEnv(makeDb(undefined, {}, 'external') as never, 'eng-custom-untrusted');
    const childEnv = childProcessEnv(env, { PATH: 'C:/tools' });
    expect(childEnv.OPENAI_API_KEY).toBeUndefined();
    expect(JSON.stringify(childEnv)).not.toContain('must-not-reach-custom-acp');
  });

  it('自定义 ACP 的员工模型覆盖不构成共享默认凭据的授权', () => {
    mockProvider = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' };
    mockKey = 'must-not-follow-model-override';
    const db = makeDb(undefined, {}, 'external');
    const env = resolveEngineEnv(db as never, 'eng-custom-untrusted', {
      id: 'agent-with-old-model', modelOverride: 'legacy-model-name'
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain('must-not-follow-model-override');
  });

  it.each([
    ['modelOverride', { modelOverride: 'legacy-model-name' }],
    ['protocol', { protocol: 'openai-chat' }]
  ])('自定义 ACP 旧配置只有 %s 时不构成共享默认凭据的授权', (_field, config) => {
    mockProvider = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' };
    mockKey = 'must-not-follow-legacy-field';
    const db = makeDb(JSON.stringify(config), {}, 'external');
    const env = resolveEngineEnv(db as never, 'eng-custom-untrusted');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain('must-not-follow-legacy-field');
  });

  it('自定义 ACP 显式选择 managed 后才解析应用默认 Provider', () => {
    mockProvider = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' };
    mockKey = 'explicit-custom-key';
    const db = makeDb(JSON.stringify({ providerMode: 'managed' }), {}, 'external');
    expect(resolveEngineEnv(db as never, 'eng-custom-opted-in').OPENAI_API_KEY).toBe('explicit-custom-key');
  });

  it('OpenCode managed 路由覆盖旧配置中的冲突 URL 和配置内容', () => {
    mockProvider = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' };
    mockKey = 'managed-opencode-key';
    const db = makeDb(JSON.stringify({
      providerMode: 'managed',
      protocol: 'openai-chat',
      env: {
        OPENAI_BASE_URL: 'https://attacker.invalid/v1',
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { opcnexus: { options: { baseURL: 'https://attacker.invalid/v1' } } } })
      }
    }));

    const env = resolveOpenCodeEngineEnv(db as never, 'eng-opencode');
    expect(env.OPENAI_API_KEY).toBe('managed-opencode-key');
    expect(env.OPENAI_BASE_URL).toBe('https://api.deepseek.com/v1');
    expect(env.OPENCODE_CONFIG_CONTENT).toContain('https://api.deepseek.com/v1');
    expect(env.OPENCODE_CONFIG_CONTENT).not.toContain('attacker.invalid');
  });

  it('Claude managed 路由覆盖旧环境中的冲突 Anthropic 地址', () => {
    mockProvider = { baseUrl: 'https://gateway.example/v1', model: 'claude-compatible' };
    mockKey = 'managed-claude-key';
    const db = makeDb(JSON.stringify({
      providerMode: 'managed',
      protocol: 'anthropic-messages',
      env: { ANTHROPIC_BASE_URL: 'https://attacker.invalid' }
    }));

    const env = resolveClaudeEngineEnv(db as never, 'eng-claude');
    expect(env).toMatchObject({
      ANTHROPIC_API_KEY: 'managed-claude-key',
      ANTHROPIC_BASE_URL: 'https://gateway.example/v1',
      ANTHROPIC_MODEL: 'claude-compatible'
    });
  });
});

describe('引擎 Provider 协议边界', () => {
  const provider = { baseUrl: 'https://provider.test/v1', model: 'test-model', key: 'test-key' };
  const resolver = { resolveForAgent: vi.fn(() => provider) };

  it.each([
    ['eng-hermes-cli', 'openai-chat'],
    ['eng-pi', 'openai-chat'],
    ['eng-deepseek-harness', 'openai-chat'],
    ['eng-deepseek-harness-managed', 'openai-chat'],
    ['eng-opencode', 'openai-chat'],
    ['eng-codex', 'openai-responses'],
    ['eng-claude', 'anthropic-messages']
  ])('%s 只接受 %s 受管协议', (engineId, protocol) => {
    const db = makeDb(JSON.stringify({ providerId: 'provider-1', protocol }));
    expect(requiredProviderProtocol(engineId)).toBe(protocol);
    expect(resolveEngineProvider(db as never, engineId, null, resolver as never)).toEqual(provider);
  });

  it.each([
    ['eng-hermes-cli', 'openai-responses'],
    ['eng-pi', 'anthropic-messages'],
    ['eng-deepseek-harness', 'openai-responses'],
    ['eng-opencode', 'anthropic-messages'],
    ['eng-codex', 'openai-chat'],
    ['eng-claude', 'openai-chat']
  ])('%s 显式绑定不兼容协议时直接失败', (engineId, protocol) => {
    const db = makeDb(JSON.stringify({ providerId: 'provider-1', protocol }));
    expect(() => resolveEngineProvider(db as never, engineId, null, resolver as never))
      .toThrow(/requires/);
  });

  it('未显式绑定的 Codex 和 Claude 保留原生登录，不注入默认 Provider', () => {
    const db = makeDb();
    expect(resolveEngineProvider(db as never, 'eng-codex', null, resolver as never)).toBeNull();
    expect(resolveEngineProvider(db as never, 'eng-claude', null, resolver as never)).toBeNull();
  });

  it('显式 Provider 不可用时不回退默认或原生登录', () => {
    const unavailable = { resolveForAgent: vi.fn(() => null) };
    const db = makeDb(JSON.stringify({ providerId: 'missing', protocol: 'openai-chat' }));
    expect(() => resolveEngineProvider(db as never, 'eng-opencode', null, unavailable as never))
      .toThrow('Configured model Provider is unavailable: missing');
  });

  it('损坏的协议值 fail closed', () => {
    const db = makeDb(JSON.stringify({ protocol: 'auto-detect' }));
    expect(() => resolveEngineProvider(db as never, 'eng-opencode', null, resolver as never))
      .toThrow('Invalid Provider protocol');
  });
});

describe('子进程环境边界', () => {
  it('configured-only 解析不会自动混入默认供应商密钥', () => {
    mockProvider = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' };
    mockKey = 'default-provider-secret';
    const db = makeDb(JSON.stringify({ env: { LOG_LEVEL: 'debug' } }));
    expect(resolveConfiguredEngineEnv(db as never, 'eng-claude')).toEqual({ LOG_LEVEL: 'debug' });
  });

  it('只继承启动所需宿主变量，并由受管运行时覆盖同名值', () => {
    const env = childProcessEnv(
      { OPENAI_API_KEY: 'managed-key', PATH: 'C:/managed-tools' },
      {
        PATH: 'C:/ambient-tools', USERPROFILE: 'C:/Users/test',
        OPENAI_API_KEY: 'ambient-openai', DEEPSEEK_API_KEY: 'ambient-deepseek',
        INTERNAL_SERVICE_TOKEN: 'ambient-service-token'
      }
    );
    expect(env.PATH).toBe('C:/managed-tools');
    expect(env.USERPROFILE).toBe('C:/Users/test');
    expect(env.OPENAI_API_KEY).toBe('managed-key');
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.INTERNAL_SERVICE_TOKEN).toBeUndefined();
  });

  it('脱敏完整文本以及跨 chunk 拆开的凭据', () => {
    const env = { OPENAI_API_KEY: 'provider-secret' };
    expect(redactSensitiveText('Bearer provider-secret', env)).toBe('Bearer [REDACTED]');
    const stream = createSensitiveTextRedactor(env);
    const output = stream.push('Bearer provider-') + stream.push('secret accepted') + stream.finish();
    expect(output).toBe('Bearer [REDACTED] accepted');
    expect(output).not.toContain('provider-secret');
  });
});
