import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Hermes project profile isolation', () => {
  const source = readFileSync(join(
    process.cwd(), 'vendor', 'hermes-agent', 'web', 'src', 'contexts', 'ProfileProvider.tsx'
  ), 'utf8');

  it('does not query or select machine profiles in a Nexus project surface', () => {
    expect(source).toContain('const nexusProjectMode = Boolean(window.__OPC_NEXUS_PROJECT_MODE__);');
    expect(source).toContain('() => nexusProjectMode ? "" : searchParams.get("profile") ?? ""');
    expect(source).toContain('if (nexusProjectMode) return;');
    expect(source).toContain('Promise.all([api.getProfiles(), api.getActiveProfile()])');
  });
});
