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

const { splitSecretEnv, resolveEngineEnv, engineEnvSecretRef, SECRET_PLACEHOLDER } =
  await import('../src/main/services/engineEnv.js');

/** 最小 Database 桩：engines.config_json + settings 键值 */
function makeDb(configJson?: string, settings: Record<string, string> = {}) {
  return {
    raw: {
      prepare: (sql: string) => ({
        get: () => (sql.includes('engines') ? { config_json: configJson } : undefined),
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

  it('占位符不会作为字面量泄漏进子进程 env', () => {
    const db = makeDb(JSON.stringify({ env: { API_KEY: SECRET_PLACEHOLDER } }));
    const env = resolveEngineEnv(db as never, 'eng-opencode');
    // 无已存密钥时该项应缺失，而不是等于 '***'
    expect(env.API_KEY).toBeUndefined();
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
