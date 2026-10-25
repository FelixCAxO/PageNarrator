import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createContentScriptAccessError,
  injectContentScript,
  isContentScriptInjectableUrl,
  requestContentScriptAccess,
} from '../../src/lib/content-script-injection.js';

describe('content script injection', () => {
  it('keeps the injected content script as a tiny dynamic-import dispatcher', () => {
    const contentScript = readFileSync(new URL('../../src/content.js', import.meta.url), 'utf8');

    expect(contentScript.match(/^import\s.+/gm)).toEqual([
      "import { isTrustedBackgroundSender, isTrustedExtensionPage } from './lib/extension-message-security.js';",
    ]);
    expect(contentScript).not.toContain('createPageHighlighter(document)');
    expect(contentScript).toContain("import('./reader/extraction/content-extraction.js')");
    expect(contentScript).toContain("import('./reader/highlighting/content-highlight.js')");
    expect(contentScript).toContain("'getFlowLog'");
    expect(contentScript).toContain("'flashResumeSection'");
    expect(contentScript.indexOf("msg?.type === 'pagenarratorPing'")).toBeLessThan(contentScript.indexOf('import('));
  });

  it('receives diagnostic settings without exposing extension storage to content scripts', () => {
    const highlightScript = readFileSync(new URL('../../src/reader/highlighting/content-highlight.js', import.meta.url), 'utf8');

    expect(highlightScript).not.toContain('chrome.storage');
    expect(highlightScript).toContain('msg.contentDiagnostics.recordFlow');
    expect(highlightScript).toContain('export async function handleHighlightMessage(msg)');
  });

  it('only treats web and local-file pages as scriptable targets', () => {
    expect(isContentScriptInjectableUrl('https://example.com/article')).toBe(true);
    expect(isContentScriptInjectableUrl('http://localhost:5173')).toBe(true);
    expect(isContentScriptInjectableUrl('file:///C:/tmp/article.html')).toBe(true);
    expect(isContentScriptInjectableUrl('chrome://extensions')).toBe(false);
    expect(isContentScriptInjectableUrl('chrome-extension://abc/src/setup.html')).toBe(false);
  });

  it('explains Chrome file URL access when local-file permission is unavailable', async () => {
    const permissionRequests = [];

    await expect(injectContentScript({
      tab: { id: 4, url: 'file:///C:/tmp/article.html' },
      scripting: {
        executeScript: async () => {
          throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.');
        },
      },
      permissions: {
        request: async (request) => {
          permissionRequests.push(request);
          return false;
        },
      },
      getContentScriptFile: () => 'src/content.js',
    })).rejects.toThrow('enable "Allow access to file URLs"');

    expect(permissionRequests).toEqual([
      { origins: ['file:///*'] },
    ]);
  });

  it('requests the exact current web origin and retries injection after access is granted', async () => {
    const calls = [];

    await injectContentScript({
      tab: { id: 14, url: 'https://iq.opengenus.org/bias-machine-learning/' },
      scripting: {
        executeScript: async (options) => {
          calls.push(['executeScript', options]);
          if (calls.filter(([name]) => name === 'executeScript').length === 1) {
            throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.');
          }
        },
      },
      permissions: {
        request: async (request) => {
          calls.push(['permissions.request', request]);
          return true;
        },
      },
      getContentScriptFile: () => 'src/content.js',
    });

    expect(calls).toEqual([
      ['executeScript', { target: { tabId: 14 }, files: ['src/content.js'] }],
      ['permissions.request', { origins: ['https://iq.opengenus.org/*'] }],
      ['executeScript', { target: { tabId: 14 }, files: ['src/content.js'] }],
    ]);
  });

  it('does not request broad web-page access when Chrome hides the tab URL', async () => {
    const permissionRequests = [];

    const granted = await requestContentScriptAccess({
      tab: { id: 8 },
      permissions: {
        request: async (request) => {
          permissionRequests.push(request);
          return true;
        },
      },
    });

    expect(granted).toBe(false);
    expect(permissionRequests).toEqual([]);
  });

  it('uses extension-icon guidance when Chrome hides the active tab URL', () => {
    const error = createContentScriptAccessError({ id: 8 });

    expect(error.code).toBe('PAGENARRATOR_TAB_URL_HIDDEN');
    expect(error.message).toContain('PageNarrator extension icon');
    expect(error.message).not.toContain('toolbar button on the page you want to read');
  });

  it('uses extension-icon guidance when exact host access is needed', () => {
    const error = createContentScriptAccessError({ id: 8, url: 'https://iq.opengenus.org/article' });

    expect(error.message).toContain('PageNarrator extension icon while iq.opengenus.org is active');
    expect(error.code).toBe('host_permission_required');
    expect(error.message).not.toContain('toolbar button');
  });

  it('does not ask for all-websites access after injection fails for a hidden-URL tab', async () => {
    const calls = [];

    await expect(injectContentScript({
      tab: { id: 9 },
      scripting: {
        executeScript: async (options) => {
          calls.push(['executeScript', options]);
          if (calls.filter(([name]) => name === 'executeScript').length === 1) {
            throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.');
          }
        },
      },
      permissions: {
        request: async (request) => {
          calls.push(['permissions.request', request]);
          return true;
        },
      },
      getContentScriptFile: () => 'src/content.js',
    })).rejects.toThrow('Click the PageNarrator extension icon while the page you want to read is active');

    expect(calls).toEqual([
      ['executeScript', { target: { tabId: 9 }, files: ['src/content.js'] }],
    ]);
  });
});
