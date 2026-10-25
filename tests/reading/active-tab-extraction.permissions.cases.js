import { createDeps } from './active-tab-extraction.fixtures.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractReadableTab } from "../../src/lib/active-tab-extraction.js";

describe('active tab extraction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requests exact web host access and retries injection when activeTab is not available from the toolbar player', async () => {
    const { deps, calls } = createDeps({
      tabs: {
        sendMessage: async (tabId, message) => {
          calls.push(['sendMessage', tabId, message]);
          if (calls.filter(([name]) => name === 'sendMessage').length === 1) {
            throw new Error('Receiving end does not exist.');
          }
          return { source: 'reading-model', title: 'Article', text: 'Article text', url: 'https://iq.opengenus.org/bias-machine-learning/' };
        },
      },
      scripting: {
        executeScript: async (options) => {
          calls.push(['executeScript', options]);
          if (calls.filter(([name]) => name === 'executeScript').length === 1) {
            throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.');
          }
        },
      },
    });

    const article = await extractReadableTab({
      tab: { id: 14, title: 'Bias in Machine learning', url: 'https://iq.opengenus.org/bias-machine-learning/' },
      ...deps,
    });

    expect(article).toMatchObject({
      source: 'reading-model',
      text: 'Article text',
      tabId: 14,
    });
    expect(calls).toEqual([
      ['sendMessage', 14, { type: 'extract' }],
      ['executeScript', { target: { tabId: 14 }, files: ['src/content.js'] }],
      ['permissions.request', { origins: ['https://iq.opengenus.org/*'] }],
      ['executeScript', { target: { tabId: 14 }, files: ['src/content.js'] }],
      ['sendMessage', 14, { type: 'extract' }],
    ]);
  });

  it('surfaces toolbar-click guidance when optional web host access is denied', async () => {
    const calls = [];
    const { deps } = createDeps({
      tabs: {
        sendMessage: async (tabId, message) => {
          calls.push(['sendMessage', tabId, message]);
          throw new Error('Receiving end does not exist.');
        },
      },
      scripting: {
        executeScript: async (options) => {
          calls.push(['executeScript', options]);
          throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.');
        },
      },
      permissions: {
        request: async (request) => {
          calls.push(['permissions.request', request]);
          return false;
        },
      },
    });

    await expect(extractReadableTab({
      tab: { id: 14, title: 'Article', url: 'https://iq.opengenus.org/bias-machine-learning/' },
      ...deps,
    })).rejects.toThrow('Click the PageNarrator extension icon while iq.opengenus.org is active');
    expect(calls).toEqual([
      ['sendMessage', 14, { type: 'extract' }],
      ['executeScript', { target: { tabId: 14 }, files: ['src/content.js'] }],
      ['permissions.request', { origins: ['https://iq.opengenus.org/*'] }],
    ]);
  });

  it('does not attempt injection when Chrome hides the active tab URL', async () => {
    const calls = [];
    const { deps } = createDeps({
      tabs: {
        sendMessage: async (tabId, message) => {
          calls.push(['sendMessage', tabId, message]);
          throw new Error('Receiving end does not exist.');
        },
      },
      scripting: {
        executeScript: async (options) => {
          calls.push(['executeScript', options]);
        },
      },
    });

    await expect(extractReadableTab({
      tab: { id: 16, title: 'Introduction to Java Programming and Data Structures' },
      ...deps,
    })).rejects.toThrow('Click the PageNarrator extension icon while the page you want to read is active');
    expect(calls).toEqual([
      ['sendMessage', 16, { type: 'extract' }],
    ]);
  });

  it('rejects browser-internal pages that are not PDF viewer tabs', async () => {
    const { deps } = createDeps();

    await expect(extractReadableTab({
      tab: { id: 4, title: 'Extensions', url: 'chrome://extensions' },
      ...deps,
    })).rejects.toThrow('Open a normal web page or PDF first.');
  });
});
