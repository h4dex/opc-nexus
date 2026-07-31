/**
 * 供应商凭据共享测试
 *
 * 背景：三个第三方 CLI 引擎修好启动问题后，仍然一调用就 401 —— 它们读不到
 * 应用内配置的供应商凭据。实测 Hermes v0.19.0 的取值规则（非文档推断）：
 *   - 注入 OPENAI_API_KEY + --provider custom → 仍连 openrouter，报 401
 *   - provider=auto + deepseek 模型 → "No usable credentials found for
 *     provider 'deepseek'. Set DEEPSEEK_API_KEY."
 *   - 注入 DEEPSEEK_API_KEY → 真实打到 DeepSeek（返回 DeepSeek 官方的
 *     "Authentication Fails, Your api key: ****robe is invalid"）
 * 结论：必须按供应商注入其专属变量名，仅 OpenAI 兼容名不够。
 *
 * 本文件锁住：专属变量名映射、用户手填值优先、以及凭据不落 config_json。
 *
 * @author liyingjie <y@senke.com>
 */
// @ts-nocheck
/* eslint-disable */
/**
 * 本地轻量 db stub：只实现被测代码实际用到的查询。
 * 不复用 tests/helpers/mockDb.ts —— 它按 SQL 正则匹配且无 providers 表，
 * 为本文件扩表会影响其他测试文件。
 */
function makeDb(opts: { provider?: { baseUrl: string; model: string; key: string }; engineEnv?: Record<string, string>; engineSecrets?: Record<string, string> } = {}) {
  const settings = new Map<string, unknown>();
  const providers: Record<string, unknown>[] = [];
  const engines = new Map<string, Record<string, unknown>>();

  if (opts.provider) {
    providers.push({
      id: 'prov-1', name: '默认', base_url: opts.provider.baseUrl, model: opts.provider.model,
      api_key_ref: 'secret:provider:prov-1', is_default: 1, created_at: 1
    });
    settings.set('secret:provider:prov-1', Buffer.from(`enc:${opts.provider.key}`).toString('base64'));
  }
  if (opts.engineEnv || opts.engineSecrets) {
    engines.set('eng-hermes-cli', { id: 'eng-hermes-cli', config_json: JSON.stringify({ env: opts.engineEnv ?? {} }) });
    if (opts.engineSecrets) {
      settings.set('secret:engine:eng-hermes-cli:env', Buffer.from(`enc:${JSON.stringify(opts.engineSecrets)}`).toString('base64'));
    }
  }

  return {
    raw: {
      prepare: (sql: string) => ({
        get: (...args: unknown[]) => {
          if (/FROM providers/.test(sql)) return providers.find((p) => p.is_default === 1) ?? providers[0];
          if (/FROM engines/.test(sql)) return engines.get(args[0] as string);
          if (/FROM settings/.test(sql)) {
            const v = settings.get(args[0] as string);
            return v === undefined ? undefined : { value_json: JSON.stringify(v) };
          }
          return undefined;
        },
        all: () => (/FROM providers/.test(sql) ? providers : []),
        run: () => ({ changes: 0 })
      })
    },
    getSetting: <T>(key: string, def: T): T => (settings.has(key) ? (settings.get(key) as T) : def),
    setSetting: (key: string, value: unknown) => { settings.set(key, value); },
    audit: () => {}
  } as never;
}

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '')
  },
  app: { getPath: () => '/tmp', getAppPath: () => '/tmp', isPackaged: false }
}));

import { providerEnvFor, resolveEngineEnv, splitSecretEnv, SECRET_PLACEHOLDER } from '../src/main/services/engineEnv.js';

/** 造一个已配好供应商的库（密钥经 mock 的 safeStorage 加密存放） */
function dbWithProvider(baseUrl: string, model = 'deepseek-chat', key = 'sk-real-key') {
  return makeDb({ provider: { baseUrl, model, key } });
}

describe('供应商专属环境变量映射（按实测规则）', () => {
  it('DeepSeek 注入 DEEPSEEK_API_KEY —— Hermes 只认这个名字', () => {
    const env = providerEnvFor(dbWithProvider('https://api.deepseek.com/v1'));
    expect(env.DEEPSEEK_API_KEY).toBe('sk-real-key');
  });

  it('同时注入 OpenAI 兼容名，覆盖其他 CLI 的取值习惯', () => {
    const env = providerEnvFor(dbWithProvider('https://api.deepseek.com/v1'));
    expect(env.OPENAI_API_KEY).toBe('sk-real-key');
    expect(env.OPENAI_BASE_URL).toBe('https://api.deepseek.com/v1');
  });

  it.each([
    ['https://openrouter.ai/api/v1', 'OPENROUTER_API_KEY'],
    ['https://api.moonshot.cn/v1', 'KIMI_API_KEY'],
    ['https://open.bigmodel.cn/api/paas/v4', 'GLM_API_KEY'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'DASHSCOPE_API_KEY'],
    ['https://api.anthropic.com', 'ANTHROPIC_API_KEY'],
    ['https://api.minimax.chat/v1', 'MINIMAX_API_KEY']
  ])('%s → %s', (baseUrl, expectedVar) => {
    expect(providerEnvFor(dbWithProvider(baseUrl))[expectedVar]).toBe('sk-real-key');
  });

  it('未识别的供应商只给 OpenAI 兼容变量，不乱猜专属名', () => {
    const env = providerEnvFor(dbWithProvider('https://my-private-llm.internal/v1'));
    expect(env.OPENAI_API_KEY).toBe('sk-real-key');
    // 不应出现任何供应商专属名
    expect(Object.keys(env).filter((k) => k.endsWith('_API_KEY'))).toEqual(['OPENAI_API_KEY']);
  });

  it('本地模型服务（http）同样下发', () => {
    const env = providerEnvFor(dbWithProvider('http://127.0.0.1:11434/v1', 'qwen2.5'));
    expect(env.OPENAI_BASE_URL).toBe('http://127.0.0.1:11434/v1');
    expect(env.OPENAI_MODEL).toBe('qwen2.5');
  });

  it('未配置供应商时不注入任何变量（避免半配置导致误判已就绪）', () => {
    expect(providerEnvFor(makeDb())).toEqual({});
  });

  it('baseUrl 尾部斜杠被规范化（拼接路径时避免双斜杠）', () => {
    expect(providerEnvFor(dbWithProvider('https://api.deepseek.com/v1///')).OPENAI_BASE_URL)
      .toBe('https://api.deepseek.com/v1');
  });
});

describe('用户手填的引擎变量优先于自动下发', () => {
  it('引擎配置页填了 DEEPSEEK_API_KEY 时不被供应商值覆盖', () => {
    const db = makeDb({
      provider: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', key: 'sk-real-key' },
      engineSecrets: { DEEPSEEK_API_KEY: 'sk-user-own' }
    });
    expect(resolveEngineEnv(db, 'eng-hermes-cli').DEEPSEEK_API_KEY).toBe('sk-user-own');
  });

  it('用户未填的变量仍由供应商补齐', () => {
    const db = makeDb({
      provider: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', key: 'sk-real-key' },
      engineEnv: { HTTP_PROXY: 'http://127.0.0.1:7890' }
    });
    const env = resolveEngineEnv(db, 'eng-hermes-cli');
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7890'); // 用户自有非敏感变量保留
    expect(env.DEEPSEEK_API_KEY).toBe('sk-real-key');     // 凭据自动补齐
  });
});

describe('凭据不落明文（安全基线 15.1）', () => {
  it('敏感变量在 config_json 中只留占位符', () => {
    const { safe, secrets } = splitSecretEnv({ DEEPSEEK_API_KEY: 'sk-abc', HTTP_PROXY: 'http://x' });
    expect(safe.DEEPSEEK_API_KEY).toBe(SECRET_PLACEHOLDER);
    expect(safe.HTTP_PROXY).toBe('http://x');
    expect(secrets.DEEPSEEK_API_KEY).toBe('sk-abc');
  });

  it('回传占位符不覆盖已存密钥', () => {
    expect(splitSecretEnv({ DEEPSEEK_API_KEY: SECRET_PLACEHOLDER }).secrets).toEqual({});
  });
});
