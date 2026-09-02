import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { Mobile, isMobileCertificateRecoveryError } from '../src/renderer/src/pages/Mobile.js';

describe('Android desktop user flow', () => {
  it('shows owner-visible pairing and certificate recovery entry points', () => {
    const html = renderToStaticMarkup(createElement(Mobile));
    expect(html).toContain('配对 Android Worker');
    expect(html).toContain('连接修复与证书重置');
    expect(html).toContain('手机对话扫码请在 Quest 右上角进行');
  });

  it('recognizes the gateway certificate mismatch errors that require re-pairing', () => {
    expect(isMobileCertificateRecoveryError(new Error(
      'Stored Mobile Gateway certificate does not cover this LAN address; reset the certificate and pair devices again'
    ))).toBe(true);
    expect(isMobileCertificateRecoveryError(new Error(
      'Stored Mobile Gateway TLS identity cannot be used for this address; reset the mobile certificate'
    ))).toBe(true);
    expect(isMobileCertificateRecoveryError(new Error('listen EADDRINUSE'))).toBe(false);
  });
});
