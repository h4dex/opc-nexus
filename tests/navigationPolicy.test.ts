import { describe, expect, it } from 'vitest';
import { isAllowedExternalUrl, isAllowedMainNavigation } from '../src/main/services/navigationPolicy.js';

describe('main window navigation policy', () => {
  it('only opens explicitly allowed external protocols', () => {
    for (const url of ['https://example.com/a', 'http://127.0.0.1:3080/', 'mailto:owner@example.com']) {
      expect(isAllowedExternalUrl(url), url).toBe(true);
    }
    for (const url of [
      'javascript:alert(1)', 'data:text/html,boom', 'file:///C:/secret.txt',
      'shell:AppsFolder', 'https://user:pass@example.com/', ' https://example.com/',
      'https://example.com/\n@evil.example/'
    ]) {
      expect(isAllowedExternalUrl(url), url).toBe(false);
    }
  });

  it('allows the development Renderer origin but no other authority', () => {
    const entry = 'http://127.0.0.1:5173/';
    expect(isAllowedMainNavigation('http://127.0.0.1:5173/chat?x=1#tail', entry)).toBe(true);
    expect(isAllowedMainNavigation('http://localhost:5173/', entry)).toBe(false);
    expect(isAllowedMainNavigation('https://127.0.0.1:5173/', entry)).toBe(false);
    expect(isAllowedMainNavigation('http://127.0.0.1:3080/', entry)).toBe(false);
  });

  it('allows only the packaged Renderer entry file', () => {
    const entry = 'file:///E:/Develop/AiBoxDash/out/renderer/index.html';
    expect(isAllowedMainNavigation(`${entry}?route=chat#latest`, entry)).toBe(true);
    expect(isAllowedMainNavigation('file:///E:/Develop/AiBoxDash/out/renderer/other.html', entry)).toBe(false);
    expect(isAllowedMainNavigation('https://example.com/', entry)).toBe(false);
  });
});
