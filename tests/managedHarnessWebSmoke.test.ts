// @ts-nocheck
/* eslint-disable */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  EXPECTED_MANAGED_TOOL_NAMES,
  assertDirectoryPickerUnavailable,
  assertManagedToolCatalog,
  parseStartupEndpoint,
  toolNamesFromHistory,
} = require('../scripts/smoke-deepseek-harness-managed-web.cjs');

function historyWithTools(toolNames: string[]) {
  return {
    events: [{
      event: {
        type: 'request/header',
        data: { header: { tools: toolNames.map((name) => ({ name })) } },
      },
    }],
  };
}

describe('managed DSH Web smoke contract', () => {
  it('requires directory selection RPCs to fail closed when Nexus owns the project cwd', () => {
    const unavailable = {
      result: {
        ok: false,
        error: {
          code: 'directory-picker-unavailable',
          details: { capability: 'none' },
        },
      },
    };
    expect(() => assertDirectoryPickerUnavailable(unavailable, 'host.pickDirectory')).not.toThrow();
    expect(() => assertDirectoryPickerUnavailable({
      result: { ok: false, error: { code: 'internal', details: { capability: 'none' } } },
    }, 'host.pickDirectory')).toThrow(/did not fail closed/);
  });

  it('accepts exactly one loopback startup endpoint with a concrete port', () => {
    expect(parseStartupEndpoint('dsh web: http://127.0.0.1:43125\n')).toBe('http://127.0.0.1:43125');
    expect(parseStartupEndpoint('dsh web: http://0.0.0.0:43125\n')).toBeNull();
    expect(parseStartupEndpoint('dsh web: http://127.0.0.1:0\n')).toBeNull();
    expect(parseStartupEndpoint([
      'dsh web: http://127.0.0.1:43125',
      'dsh web: http://127.0.0.1:43126',
    ].join('\n'))).toBeNull();
  });

  it('extracts and accepts the exact governed coordination tool catalog', () => {
    const names = toolNamesFromHistory(historyWithTools([...EXPECTED_MANAGED_TOOL_NAMES].reverse()));
    expect(names).toEqual(EXPECTED_MANAGED_TOOL_NAMES);
    expect(() => assertManagedToolCatalog(names, 'standard')).not.toThrow();
  });

  it('waits for a complete request header and rejects capability drift', () => {
    expect(toolNamesFromHistory({ events: [] })).toBeNull();
    expect(toolNamesFromHistory(historyWithTools(['job_list', undefined as never]))).toBeNull();
    expect(() => assertManagedToolCatalog(
      EXPECTED_MANAGED_TOOL_NAMES.filter((name: string) => name !== 'subagent'),
      'minimal',
    )).toThrow(/tool catalog drifted/);
  });

  it.each([
    'bash',
    'read',
    'web_search',
    'skill',
    'workflow',
    'ralph',
    'cordis_define',
  ])('rejects forbidden managed tool %s', (forbiddenTool) => {
    const names = [...EXPECTED_MANAGED_TOOL_NAMES, forbiddenTool].sort();
    expect(() => assertManagedToolCatalog(names, 'cordis')).toThrow(/exposed forbidden tools/);
  });
});
