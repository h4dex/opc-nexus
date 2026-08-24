import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { preferredHermesLanQuickConfig } from '../src/renderer/src/pages/QuestMobileAccess.js';
import {
  isSupersededHermesWorkbenchError,
  isUsableHermesEmbeddedBounds
} from '../src/renderer/src/pages/QuestWorkbench.js';
import type { HermesMobileAccessStatus } from '../src/shared/types.js';

function status(bindHost = '127.0.0.1'): HermesMobileAccessStatus {
  return {
    projectId: 'project-1',
    configured: { bindHost, port: 18_766, publicHost: bindHost, publicPort: 18_766 },
    running: false,
    activeRoutes: [],
    lastError: null
  };
}

describe('Quest mobile Web access', () => {
  it('replaces a loopback-only configuration with a detected LAN address', () => {
    expect(preferredHermesLanQuickConfig(status(), ['192.168.10.20'])).toEqual({
      bindHost: '192.168.10.20', port: 18_766,
      publicHost: '192.168.10.20', publicPort: 18_766
    });
  });

  it('preserves an existing non-loopback LAN configuration', () => {
    expect(preferredHermesLanQuickConfig(status('10.0.0.8'), ['10.0.0.8', '192.168.10.20'])).toEqual({
      bindHost: '10.0.0.8', port: 18_766, publicHost: '10.0.0.8', publicPort: 18_766
    });
  });

  it('replaces a persisted LAN address after that adapter disappears', () => {
    expect(preferredHermesLanQuickConfig(status('192.168.121.103'), ['192.168.10.20'])).toEqual({
      bindHost: '192.168.10.20', port: 18_766,
      publicHost: '192.168.10.20', publicPort: 18_766
    });
  });

  it('does not surface a normal superseded Workbench request as a connection failure', () => {
    expect(isSupersededHermesWorkbenchError(
      new Error("Error invoking remote method 'aibox:openEmbeddedHermesWorkbench': Error: Quest embedded Workbench request was superseded")
    )).toBe(true);
    expect(isSupersededHermesWorkbenchError(new Error('Hermes runtime unavailable'))).toBe(false);
  });

  it('hides the embedded Hermes view instead of submitting drawer-collapsed bounds', () => {
    expect(isUsableHermesEmbeddedBounds({ x: 0, y: 44, width: 320, height: 240 })).toBe(true);
    expect(isUsableHermesEmbeddedBounds({ x: 0, y: 44, width: 319, height: 240 })).toBe(false);
    expect(isUsableHermesEmbeddedBounds({ x: 0, y: 44, width: 900, height: 239 })).toBe(false);

    const workbench = readFileSync(
      join(process.cwd(), 'src', 'renderer', 'src', 'pages', 'QuestWorkbench.tsx'),
      'utf8'
    ).replace(/\r\n/g, '\n');
    expect(workbench).toContain('if (visible && !sameBounds(lastBoundsRef.current, bounds))');
  });

  it('renders a top-toolbar phone trigger and a secret-free Hermes pairing modal', () => {
    const root = join(process.cwd(), 'src', 'renderer', 'src', 'pages');
    const workbench = readFileSync(join(root, 'QuestWorkbench.tsx'), 'utf8').replace(/\r\n/g, '\n');
    const access = readFileSync(join(root, 'QuestMobileAccess.tsx'), 'utf8').replace(/\r\n/g, '\n');
    const styles = readFileSync(join(root, 'questWorkbench.css'), 'utf8').replace(/\r\n/g, '\n');

    expect(workbench).toContain('className={`quest-toolbar-icon${mobileOpen ? \' active\' : \'\'}`}');
    expect(workbench).toContain('aria-label={mobileOpen ? \'关闭手机 Hermes 对话\' : \'连接手机 Hermes 对话\'}');
    expect(workbench).toContain('data-running={mobileRunning}');
    expect(workbench).toContain('className="quest-mobile-indicator"');
    expect(workbench).toContain('<QuestMobileAccess');
    expect(workbench).toContain('className="quest-mobile-modal-backdrop"');
    expect(workbench).toContain('&& !mobileOpenRef.current');
    expect(workbench).toContain('reportEmbeddedGeometry();\n  }, [mobileOpen, reportEmbeddedGeometry]);');
    expect(workbench).not.toContain("${mobileOpen ? ' mobile-open' : ''}");
    expect(workbench).toContain('window.aibox.getHermesMobileAccessStatus(project.id)');
    expect(workbench).not.toContain('window.aibox.getDshLanGatewayStatus()');
    expect(access).toContain('QRCode.toDataURL(offer.pairingUrl');
    expect(access).not.toContain('QRCode.toDataURL(offer.code');
    expect(access).toContain('window.aibox.createHermesMobilePairing(projectId');
    expect(access).not.toContain("createHermesMobilePairing(projectId, 'operator'");
    expect(access).not.toContain('HermesMobileRole');
    expect(access).not.toContain('<option value="viewer">');
    expect(access).toContain('window.aibox.listHermesMobileLanAddresses()');
    expect(access).toContain('window.aibox.stopHermesMobileAccess(projectId)');
    expect(access).not.toContain('window.aibox.listMobileLanAddresses()');
    expect(access).not.toContain('window.aibox.startDshLanGateway');
    expect(access).not.toContain('window.aibox.createDshLanPairing');
    expect(access).not.toContain('window.aibox.emergencyStopDshLanGateway');
    expect(styles).toContain('.quest-mobile-modal-backdrop');
    expect(styles).toContain("button[data-running='true'] .quest-mobile-indicator");
  });
});
