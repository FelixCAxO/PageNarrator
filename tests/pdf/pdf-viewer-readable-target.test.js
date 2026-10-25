import { describe, expect, it } from 'vitest';
import { resolveReadableTabTarget } from '../../src/lib/readable-tab-target.js';
import { rememberPdfViewerReadableTarget } from '../../src/lib/pdf-viewer-readable-target.js';

function createMemoryStorage() {
  const state = {};
  return {
    state,
    async set(values) {
      Object.assign(state, values);
    },
  };
}

describe('PDF viewer readable target handoff', () => {
  it('remembers the opened PageNarrator PDF viewer so id-only active tab reads still resolve to the viewer URL', async () => {
    const storage = createMemoryStorage();
    const viewerTab = {
      id: 77,
      title: 'Book',
      url: 'chrome-extension://pagenarrator-test/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Fbook.pdf#page=50',
    };

    const remembered = await rememberPdfViewerReadableTarget({ storage, viewerTab });
    const resolved = await resolveReadableTabTarget({
      cachedTab: remembered,
      queryActiveTab: async () => ({ id: 77 }),
      getTabById: async () => ({ id: 77 }),
      isLikelyPdfTab: (tab) => String(tab?.url || '').includes('/src/pdf-viewer.html'),
    });

    expect(resolved).toEqual(viewerTab);
    expect(storage.state.readableTabTarget.tabSnapshot).toEqual(viewerTab);
  });

  it('uses the intended viewer URL when chrome.tabs.create returns only the new tab id', async () => {
    const storage = createMemoryStorage();
    const viewerUrl = 'chrome-extension://pagenarrator-test/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Fbook.pdf#page=50';

    const remembered = await rememberPdfViewerReadableTarget({
      storage,
      viewerTab: { id: 77 },
      viewerUrl,
      title: 'Book',
    });

    expect(remembered).toEqual({
      id: 77,
      title: 'Book',
      url: viewerUrl,
    });
    expect(storage.state.readableTabTarget.tabSnapshot).toEqual({
      id: 77,
      title: 'Book',
      url: viewerUrl,
    });
  });
});
