import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { preferredDshLanQuickConfig } from '../src/renderer/src/pages/QuestMobileAccess.js';
import { isUsableDshEmbeddedBounds } from '../src/renderer/src/pages/QuestWorkbench.js';
import type { DshLanGatewayCompositionStatusView } from '../src/shared/types.js';

function status(bindHost = '127.0.0.1'): DshLanGatewayCompositionStatusView {
  return {
    desiredEnabled: false,
    configured: { bindHost, port: 18_766, publicHost: bindHost, publicPort: 18_766 },
    gateway: {
      state: 'stopped', enabled: false, running: false, bindHost: null, port: null,
      authority: null, origin: null, trustedAuthorities: [], runtimeId: 'runtime-1',
      activeSessions: 0, activeRequests: 0, activeWebSockets: 0,
      certificateFingerprint: null, lastError: null
    },
    lastError: null,
    boundRuntime: null,
    eligibleRuntimeCount: 1
  };
}

describe('Quest mobile Web access', () => {
  it('replaces a loopback-only configuration with a detected LAN address', () => {
    expect(preferredDshLanQuickConfig(status(), ['192.168.10.20'])).toEqual({
      bindHost: '192.168.10.20', port: 18_766,
      publicHost: '192.168.10.20', publicPort: 18_766
    });
  });

  it('preserves an existing non-loopback LAN configuration', () => {
    expect(preferredDshLanQuickConfig(status('10.0.0.8'), ['192.168.10.20'])).toEqual({
      bindHost: '10.0.0.8', port: 18_766, publicHost: '10.0.0.8', publicPort: 18_766
    });
  });

  it('hides the native DSH view instead of submitting drawer-collapsed bounds', () => {
    expect(isUsableDshEmbeddedBounds({ x: 0, y: 44, width: 320, height: 240 })).toBe(true);
    expect(isUsableDshEmbeddedBounds({ x: 0, y: 44, width: 319, height: 240 })).toBe(false);
    expect(isUsableDshEmbeddedBounds({ x: 0, y: 44, width: 900, height: 239 })).toBe(false);

    const workbench = readFileSync(
      join(process.cwd(), 'src', 'renderer', 'src', 'pages', 'QuestWorkbench.tsx'),
      'utf8'
    );
    expect(workbench).toContain('if (visible && !sameBounds(lastBoundsRef.current, bounds))');
  });

  it('renders a bottom-left phone trigger and a secret-free pairing QR', () => {
    const root = join(process.cwd(), 'src', 'renderer', 'src', 'pages');
    const workbench = readFileSync(join(root, 'QuestWorkbench.tsx'), 'utf8');
    const access = readFileSync(join(root, 'QuestMobileAccess.tsx'), 'utf8');
    const styles = readFileSync(join(root, 'questWorkbench.css'), 'utf8');

    expect(workbench).toContain('className="quest-embedded-footer"');
    expect(workbench).toContain('aria-label={mobileOpen ? \'收起 Quest 手机 Web\' : \'连接 Quest 手机 Web\'}');
    expect(workbench).toContain('data-running={mobileRunning}');
    expect(workbench).toContain('className="quest-mobile-indicator"');
    expect(workbench).toContain('<QuestMobileAccess projectName={project.name} onRunningChange={setMobileRunning} />');
    expect(access).toContain('QRCode.toDataURL(offer.pairingUrl');
    expect(access).not.toContain('QRCode.toDataURL(offer.code');
    expect(access).toContain('window.aibox.startDshLanGateway');
    expect(access).toContain('window.aibox.createDshLanPairing');
    expect(styles).toContain('.quest-embedded-footer');
    expect(styles).toContain("button[data-running='true'] .quest-mobile-indicator");
  });
});
