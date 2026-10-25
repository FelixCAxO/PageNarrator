import { describe, expect, it, vi } from 'vitest';
import { openPdfViewerForSourceTab } from '../../src/lib/pdf-viewer-handoff.js';

function createMemoryStorage() {
  const state = {};
  return {
    state,
    async set(values) {
      Object.assign(state, values);
    },
  };
}

describe('PDF viewer tab handoff', () => {
  it('replaces the source PDF tab with the PageNarrator viewer to avoid keeping Chrome PDF alive', async () => {
    const storage = createMemoryStorage();
    const viewerUrl = 'chrome-extension://test/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Fpaper.pdf';
    const calls = [];
    const tabs = {
      update: vi.fn(async (tabId, update) => {
        calls.push(['update', tabId, update]);
        return { id: tabId };
      }),
      create: vi.fn(async (create) => {
        calls.push(['create', create]);
        return { id: 44 };
      }),
    };

    const remembered = await openPdfViewerForSourceTab({
      tabs,
      storage,
      sourceTab: { id: 33, title: 'Original PDF', url: 'https://example.test/paper.pdf' },
      viewerUrl,
      title: 'Readable PDF',
      waitForReaderTabReady: async (tabId) => {
        calls.push(['wait', tabId]);
        return true;
      },
    });

    expect(remembered).toEqual({
      id: 33,
      title: 'Readable PDF',
      url: viewerUrl,
    });
    expect(tabs.create).not.toHaveBeenCalled();
    expect(calls).toEqual([
      ['update', 33, { url: viewerUrl, active: true }],
      ['wait', 33],
    ]);
    expect(storage.state.readableTabTarget.tabSnapshot).toEqual({
      id: 33,
      title: 'Readable PDF',
      url: viewerUrl,
    });
  });

  it('opens a new viewer tab when there is no source tab id to replace', async () => {
    const storage = createMemoryStorage();
    const viewerUrl = 'chrome-extension://test/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Fpaper.pdf';
    const tabs = {
      update: vi.fn(),
      create: vi.fn(async () => ({ id: 44 })),
    };

    const remembered = await openPdfViewerForSourceTab({
      tabs,
      storage,
      sourceTab: { title: 'Original PDF' },
      viewerUrl,
      title: 'Readable PDF',
      waitForReaderTabReady: async () => true,
    });

    expect(tabs.update).not.toHaveBeenCalled();
    expect(tabs.create).toHaveBeenCalledWith({ url: viewerUrl, active: true });
    expect(remembered).toEqual({
      id: 44,
      title: 'Readable PDF',
      url: viewerUrl,
    });
  });

  it('falls back to opening a new viewer tab if replacing the source tab fails', async () => {
    const storage = createMemoryStorage();
    const viewerUrl = 'chrome-extension://test/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Fpaper.pdf';
    const tabs = {
      update: vi.fn(async () => {
        throw new Error('Tab no longer exists');
      }),
      create: vi.fn(async () => ({ id: 45 })),
    };

    const remembered = await openPdfViewerForSourceTab({
      tabs,
      storage,
      sourceTab: { id: 33, title: 'Original PDF' },
      viewerUrl,
      title: 'Readable PDF',
      waitForReaderTabReady: async () => true,
    });

    expect(tabs.update).toHaveBeenCalledWith(33, { url: viewerUrl, active: true });
    expect(tabs.create).toHaveBeenCalledWith({ url: viewerUrl, active: true });
    expect(remembered).toEqual({
      id: 45,
      title: 'Readable PDF',
      url: viewerUrl,
    });
  });
});
