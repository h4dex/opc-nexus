import { describe, expect, it } from 'vitest';
import {
  getMobileTool,
  getMobileToolCatalog,
  MOBILE_TOOL_NAMES,
  redactMobileValue,
  validateMobileScriptSteps,
  validateMobileToolArgs
} from '../src/main/services/mobileCatalog.js';

describe('Android tool catalog', () => {
  it('contains exactly 42 unique tools in the required group distribution', () => {
    const catalog = getMobileToolCatalog();
    expect(catalog.protocolVersion).toBe(1);
    expect(catalog.upstreamCommit).toBe('5f2f8ab6a42b8b88a6588f5cda178af8b89f8311');
    expect(MOBILE_TOOL_NAMES).toHaveLength(42);
    expect(new Set(MOBILE_TOOL_NAMES)).toHaveProperty('size', 42);
    const counts = Object.fromEntries(['management', 'interface', 'privacy', 'communication', 'media'].map((group) => [
      group,
      catalog.tools.filter((tool) => tool.group === group).length
    ]));
    expect(counts).toEqual({ management: 12, interface: 11, privacy: 7, communication: 5, media: 7 });
  });

  it('validates tool arguments from catalog JSON Schema', () => {
    expect(validateMobileToolArgs('android_tap', { node_id: 'node-1' })).toEqual({ node_id: 'node-1' });
    expect(() => validateMobileToolArgs('android_type', {})).toThrow(/required/);
    expect(() => validateMobileToolArgs('android_swipe', { direction: 'diagonal' })).toThrow(/allowed values/);
    expect(() => validateMobileToolArgs('android_mic_record', { duration: 1801 })).toThrow(/must be <= 1800/);
  });

  it('enforces the restricted macro DSL boundaries', () => {
    expect(() => validateMobileScriptSteps([{ tool: 'android_macro', args: { steps: [] } }])).toThrow('forbidden tool');
    expect(() => validateMobileScriptSteps([{ tool: 'android_setup', args: {} }])).toThrow('forbidden tool');
    expect(() => validateMobileScriptSteps(Array.from({ length: 101 }, () => ({ tool: 'android_ping', args: {} })))).toThrow('1-100');
    expect(() => validateMobileScriptSteps([{ tool: 'android_ping', args: {}, delayAfterMs: 30_001 }])).toThrow('0-30000');
    expect(() => validateMobileScriptSteps(Array.from({ length: 11 }, () => ({ tool: 'android_ping', args: {}, delayAfterMs: 30_000 })))).toThrow('5 minutes');
    expect(() => validateMobileScriptSteps([{ tool: 'android_ping', args: {}, onFailure: 'retry' }])).toThrow('failure policy');
  });

  it('redacts text, message bodies, clipboard and complete UI trees', () => {
    expect(redactMobileValue(getMobileTool('android_type'), { text: 'private', clear_first: true })).toEqual({ text: '[redacted]', clear_first: true });
    expect(redactMobileValue(getMobileTool('android_send_sms'), { to: '+8613800000000', body: 'hello' })).toEqual({ to: '[redacted]', body: '[redacted]' });
    expect(redactMobileValue(getMobileTool('android_read_screen'), { tree: [{ text: 'secret' }] }, true)).toEqual({ redacted: true, nodeCount: 1 });
    expect(redactMobileValue(getMobileTool('android_clipboard_read'), { text: 'secret' }, true)).toEqual({ redacted: true, count: undefined });
    const screenshot = redactMobileValue(getMobileTool('android_screenshot'), {
      success: true,
      data: { image: 'a'.repeat(400), mimeType: 'image/png' },
      artifact: { id: 'artifact-1', filename: 'screen.png' }
    }, true);
    expect(screenshot).toEqual({
      success: true,
      data: { image: '[binary redacted]', mimeType: 'image/png' },
      artifact: { id: 'artifact-1', filename: 'screen.png' }
    });
  });
});
