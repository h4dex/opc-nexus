// @ts-nocheck
/* eslint-disable */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  MIN_NPM_VERSION,
  NPM_CI_ARGS,
  assertSupportedNpmVersion,
  npmEnvironment,
  thirdPartyAuditEnvironment,
  patchAnonymousUserIdSource,
} = require('../scripts/prepare-deepseek-harness.cjs');

describe('DeepSeek Harness prepare policy', () => {
  it('requires the first npm release that enforces allowScripts', () => {
    expect(MIN_NPM_VERSION).toEqual([11, 16, 0]);
    expect(() => assertSupportedNpmVersion('10.99.99')).toThrow(/npm >=11\.16\.0/);
    expect(() => assertSupportedNpmVersion('11.15.9')).toThrow(/npm >=11\.16\.0/);
    expect(() => assertSupportedNpmVersion('11.16.0')).not.toThrow();
    expect(() => assertSupportedNpmVersion('11.16.1')).not.toThrow();
    expect(() => assertSupportedNpmVersion('12.0.0')).not.toThrow();
  });

  it('installs with a strict allow-list and no all-scripts escape hatch', () => {
    expect(NPM_CI_ARGS).toContain('--ignore-scripts=false');
    expect(NPM_CI_ARGS).toContain('--strict-allow-scripts');
    expect(NPM_CI_ARGS).toContain('--dangerously-allow-all-scripts=false');
  });

  it('removes ambient npm script-policy overrides', () => {
    const env = npmEnvironment({
      PATH: 'kept',
      CI: 'true',
      CSC_LINK: 'signing-secret',
      GITHUB_TOKEN: 'github-secret',
      AWS_SECRET_ACCESS_KEY: 'cloud-secret',
      NODE_OPTIONS: '--require malicious-hook.cjs',
      npm_config_userconfig: 'C:\\secrets\\npmrc',
      npm_config_allow_scripts: 'unreviewed-package',
      NPM_CONFIG_DANGEROUSLY_ALLOW_ALL_SCRIPTS: 'true',
      npm_config_ignore_scripts: 'true',
      npm_config_strict_allow_scripts: 'false',
    });

    expect(env.PATH).toBe('kept');
    expect(env.CI).toBe('true');
    expect(env).not.toHaveProperty('CSC_LINK');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(env).not.toHaveProperty('npm_config_userconfig');
    expect(Object.keys(env).map((key) => key.toLowerCase())).not.toEqual(
      expect.arrayContaining([
        'npm_config_allow_scripts',
        'npm_config_dangerously_allow_all_scripts',
        'npm_config_ignore_scripts',
        'npm_config_strict_allow_scripts',
      ]),
    );
  });

  it('uses a minimal allow-list when staged third-party code is executed', () => {
    const env = thirdPartyAuditEnvironment(
      { AIBOX_DSH_PROVIDER: 'deepseek-official' },
      {
        Path: 'C:\\runtime-bin',
        SystemRoot: 'C:\\Windows',
        TEMP: 'C:\\Temp',
        LANG: 'zh_CN.UTF-8',
        NODE_OPTIONS: '--require malicious-hook.cjs',
        GITHUB_TOKEN: 'ghs-secret',
        AWS_SECRET_ACCESS_KEY: 'aws-secret',
        DEEPSEEK_API_KEY: 'real-provider-secret',
        HTTPS_PROXY: 'http://user:password@proxy.example.test',
        npm_config_userconfig: 'C:\\secrets\\npmrc',
      },
    );

    expect(env).toMatchObject({
      Path: 'C:\\runtime-bin',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      LANG: 'zh_CN.UTF-8',
      ELECTRON_RUN_AS_NODE: '1',
      AIBOX_DSH_PROVIDER: 'deepseek-official',
    });
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('DEEPSEEK_API_KEY');
    expect(env).not.toHaveProperty('HTTPS_PROXY');
    expect(env).not.toHaveProperty('npm_config_userconfig');
  });

  it('forces Electron child probes into Node mode', () => {
    expect(thirdPartyAuditEnvironment(
      { ELECTRON_RUN_AS_NODE: '0' },
      { ELECTRON_RUN_AS_NODE: '0', NODE_OPTIONS: '--inspect' },
    )).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('removes the anonymous-id non-exclusive overwrite fallback', () => {
    const unsafe = [
      '\t\t\tif (id === void 0) {',
      '\t\t\t\ttry {',
      '\t\t\t\t\twriteFileSync(file, `${created}\\n`, "utf8");',
      '\t\t\t\t} catch {}',
      '\t\t\t\tid = created;',
      '\t\t\t}',
    ].join('\n');

    const patched = patchAnonymousUserIdSource(`before\n${unsafe}\nafter`);
    expect(patched).toContain('if (id === void 0) id = created;');
    expect(patched).not.toContain('writeFileSync(file');
    expect(() => patchAnonymousUserIdSource('upstream shape changed')).toThrow(/exclusive-write patch/);
  });
});
