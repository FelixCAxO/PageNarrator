import { describe, expect, it } from 'vitest';
import { isTrustedBackgroundSender, isTrustedExtensionPage } from '../../src/lib/extension-message-security.js';

const id = 'hneopkjdnhmdbbgnefihfnaomcnajaob';
const origin = `chrome-extension://${id}`;
const runtime = {
  id,
  getURL: (path) => `${origin}/${path}`,
  getManifest: () => ({ background: { service_worker: 'service-worker-loader.js' } }),
};
const popup = { id, url: `${origin}/src/popup.html`, origin, frameId: 0 };

describe('Chrome-provided extension sender identity', () => {
  it.each([
    ['toolbar popup', popup],
    ['reader engine with query', { id, url: `${origin}/src/reader-engine.html?engine=1` }],
    ['extension document outside a frame', { ...popup, frameId: -1 }],
  ])('accepts the %s only on an explicitly allowed page', (_name, sender) => {
    expect(isTrustedExtensionPage(sender, runtime, ['src/popup.html', 'src/reader-engine.html'])).toBe(true);
    expect(isTrustedExtensionPage(sender, runtime, 'src/pdf-viewer.html')).toBe(false);
  });

  it.each([
    ['missing sender', undefined],
    ['missing extension identity', { url: popup.url }],
    ['another extension ID', { ...popup, id: 'foreign' }],
    ['another extension URL', { ...popup, url: 'chrome-extension://foreign/src/popup.html' }],
    ['web content script', { ...popup, url: 'https://attacker.test/src/popup.html', origin: 'https://attacker.test' }],
    ['opaque origin', { ...popup, origin: 'null' }],
    ['mismatched origin', { ...popup, origin: 'https://attacker.test' }],
    ['child frame', { ...popup, frameId: 3 }],
    ['path prefix spoof', { ...popup, url: `${popup.url}.attacker` }],
    ['encoded path spoof', { ...popup, url: `${origin}/src%2fpopup.html` }],
    ['URL credentials', { ...popup, url: `chrome-extension://user@${id}/src/popup.html` }],
    ['malformed URL', { ...popup, url: 'invalid URL' }],
  ])('denies %s', (_name, sender) => {
    expect(isTrustedExtensionPage(sender, runtime, 'src/popup.html')).toBe(false);
  });

  it('accepts the native service worker sender without document-only metadata', () => {
    // Shape captured from native Chromium in tmp/security-1.1.2-2026-09-28/sender-probe.json.
    const worker = { id, url: `${origin}/service-worker-loader.js` };
    expect(isTrustedBackgroundSender(worker, runtime)).toBe(true);
    expect(isTrustedBackgroundSender(popup, runtime)).toBe(false);
    expect(isTrustedBackgroundSender({ ...worker, url: `${origin}/assets/background.js` }, runtime)).toBe(false);
  });

  it('accepts only the emitted loader when the offscreen runtime omits getManifest', () => {
    const offscreenRuntime = { id, getURL: runtime.getURL };
    expect(isTrustedBackgroundSender({ id, url: `${origin}/service-worker-loader.js` }, offscreenRuntime)).toBe(true);
    for (const path of ['service-worker-loader.js.attacker', 'assets/background.js', 'src/popup.html', 'src/reader-engine.html']) {
      expect(isTrustedBackgroundSender({ id, url: `${origin}/${path}` }, offscreenRuntime), path).toBe(false);
    }
  });

  it('fails closed without a known runtime identity, extension origin, or a declared worker path', () => {
    expect(isTrustedExtensionPage(popup, undefined, 'src/popup.html')).toBe(false);
    expect(isTrustedExtensionPage(popup, { ...runtime, getURL: () => 'https://attacker.test/' }, 'src/popup.html')).toBe(false);
    expect(isTrustedExtensionPage(popup, runtime, undefined)).toBe(false);
    expect(isTrustedBackgroundSender({ id, url: `${origin}/service-worker-loader.js` }, { ...runtime, getManifest: () => ({}) })).toBe(false);
  });
});
