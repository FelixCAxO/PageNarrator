import { describe, expect, it } from 'vitest';
import {
  createReadableTabSnapshot,
  getReadableTabTargetFromStorageValue,
  isUnsupportedReadableTab,
  READABLE_TAB_TARGET_KEY,
  resolveReadableTabTarget,
  saveReadableTabTarget,
} from '../../src/lib/readable-tab-target.js';

describe('readable tab target', () => {
  it('keeps the popup tab URL when the toolbar player cannot query active tab metadata', async () => {
    let queriedActiveTab = false;
    const queuedTab = createReadableTabSnapshot({
      id: 14,
      title: 'OpenGenus IQ: Learn Algorithms',
      url: 'https://iq.opengenus.org/add-operation-in-deep-learning/',
      favIconUrl: 'https://iq.opengenus.org/favicon.ico',
    });

    const tab = await resolveReadableTabTarget({
      queuedTab,
      queryActiveTab: async () => {
        queriedActiveTab = true;
        return { id: 99 };
      },
    });

    expect(tab).toEqual({
      id: 14,
      title: 'OpenGenus IQ: Learn Algorithms',
      url: 'https://iq.opengenus.org/add-operation-in-deep-learning/',
    });
    expect(queriedActiveTab).toBe(false);
  });

  it('falls back to querying the active tab when no queued tab exists', async () => {
    await expect(resolveReadableTabTarget({
      queryActiveTab: async () => ({ id: 8, title: 'Article', url: 'https://example.test/article' }),
    })).resolves.toEqual({ id: 8, title: 'Article', url: 'https://example.test/article' });
  });

  it('hydrates active tabs when Chrome only returns their id', async () => {
    const getTabCalls = [];

    const tab = await resolveReadableTabTarget({
      queryActiveTab: async () => ({ id: 8 }),
      getTabById: async (tabId) => {
        getTabCalls.push(tabId);
        return { id: tabId, title: 'Article', url: 'https://example.test/article' };
      },
    });

    expect(tab).toEqual({ id: 8, title: 'Article', url: 'https://example.test/article' });
    expect(getTabCalls).toEqual([8]);
  });

  it('uses a matching cached toolbar-player target when active tab metadata is hidden', async () => {
    const cachedTab = createReadableTabSnapshot({
      id: 14,
      title: 'OpenGenus IQ: Learn Algorithms',
      url: 'https://iq.opengenus.org/add-operation-in-deep-learning/',
    });

    const tab = await resolveReadableTabTarget({
      cachedTab,
      queryActiveTab: async () => ({ id: 14 }),
    });

    expect(tab).toEqual(cachedTab);
  });

  it('never reuses a cached toolbar-player target when hidden active-tab metadata has a different id', async () => {
    const cachedTab = createReadableTabSnapshot({
      id: 14,
      title: 'Old article',
      url: 'https://example.test/old',
    });
    let cachedSelections = 0;

    for (let index = 0; index < 1_000; index += 1) {
      const tab = await resolveReadableTabTarget({
        cachedTab,
        queryActiveTab: async () => ({ id: 22 }),
        getTabById: async () => ({ id: 22 }),
      });
      if (tab.id === cachedTab.id) cachedSelections += 1;
    }

    expect(cachedSelections).toBe(0);
  });

  it('keeps the cached article target when the test toolbar-player tab is active', async () => {
    const cachedTab = createReadableTabSnapshot({
      id: 14,
      title: 'Offline article',
      url: 'http://127.0.0.1:4321/wikipedia-en-Internet.html',
    });

    const tab = await resolveReadableTabTarget({
      cachedTab,
      queryActiveTab: async () => ({
        id: 22,
        title: 'PageNarrator',
        url: 'chrome-extension://abc/src/reader-engine.html',
      }),
    });

    expect(tab).toEqual(cachedTab);
  });

  it.each(['popup', 'reader-engine'])('keeps the reading target when a %s tab activation is queued', async (page) => {
    const cachedTab = { id: 14, url: 'https://example.test/book.pdf' };
    const tab = await resolveReadableTabTarget({
      cachedTab,
      queuedTab: { id: 22 },
      getTabById: async () => ({ id: 22, url: `chrome-extension://abc/src/${page}.html` }),
      queryActiveTab: async () => { throw new Error('The supplied activation must be used.'); },
    });
    expect(tab).toEqual(cachedTab);
  });

  it('retains a cached URL when activation metadata for the same tab is hidden', async () => {
    const cachedTab = { id: 14, url: 'https://example.test/book.pdf' };
    const tab = await resolveReadableTabTarget({
      cachedTab,
      queuedTab: { id: 14 },
      getTabById: async () => ({ id: 14 }),
      queryActiveTab: async () => { throw new Error('The supplied activation must be used.'); },
    });
    expect(tab).toEqual(cachedTab);
  });

  it('ignores a cached toolbar-player target after the active tab id changes', async () => {
    const cachedTab = createReadableTabSnapshot({
      id: 14,
      title: 'Old article',
      url: 'https://example.test/old',
    });

    const tab = await resolveReadableTabTarget({
      cachedTab,
      queryActiveTab: async () => ({ id: 22 }),
      getTabById: async (tabId) => ({ id: tabId, title: 'New article', url: 'https://example.test/new' }),
    });

    expect(tab).toEqual({ id: 22, title: 'New article', url: 'https://example.test/new' });
  });

  it('lets explicit queued popup actions win over cached and active tabs', async () => {
    let queriedActiveTab = false;
    const queuedTab = createReadableTabSnapshot({
      id: 14,
      title: 'Queued article',
      url: 'https://example.test/queued',
    });
    const cachedTab = createReadableTabSnapshot({
      id: 22,
      title: 'Cached article',
      url: 'https://example.test/cached',
    });

    const tab = await resolveReadableTabTarget({
      queuedTab,
      cachedTab,
      queryActiveTab: async () => {
        queriedActiveTab = true;
        return { id: 33, title: 'Active article', url: 'https://example.test/active' };
      },
    });

    expect(tab).toEqual(queuedTab);
    expect(queriedActiveTab).toBe(false);
  });

  it('stores toolbar-player target tab snapshots for later manual reads', async () => {
    const stored = {};
    const storage = {
      async set(values) {
        Object.assign(stored, values);
      },
    };

    await saveReadableTabTarget({
      storage,
      tabId: 14,
      tab: {
        id: 14,
        title: 'OpenGenus IQ: Learn Algorithms',
        url: 'https://iq.opengenus.org/add-operation-in-deep-learning/',
      },
      now: () => 1900,
    });

    expect(stored[READABLE_TAB_TARGET_KEY]).toEqual({
      tabId: 14,
      tabSnapshot: {
        id: 14,
        title: 'OpenGenus IQ: Learn Algorithms',
        url: 'https://iq.opengenus.org/add-operation-in-deep-learning/',
      },
      createdAt: 1900,
    });
  });

  it('restores saved toolbar-player target snapshots when the popup updates an existing session', () => {
    const target = getReadableTabTargetFromStorageValue({
      tabId: 14,
      tabSnapshot: {
        id: 14,
        title: 'OpenGenus IQ: Learn Algorithms',
        url: 'https://iq.opengenus.org/add-operation-in-deep-learning/',
      },
      createdAt: 1900,
    });

    expect(target).toEqual({
      id: 14,
      title: 'OpenGenus IQ: Learn Algorithms',
      url: 'https://iq.opengenus.org/add-operation-in-deep-learning/',
    });
  });

  it('rejects browser extension pages unless they are PDF viewer tabs', () => {
    expect(isUnsupportedReadableTab(
      { id: 1, url: 'chrome-extension://abc/src/reader-engine.html' },
      { isLikelyPdfTab: () => false },
    )).toBe(true);

    expect(isUnsupportedReadableTab(
      { id: 2, url: 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?https%3A%2F%2Fexample.test%2Fbook.pdf' },
      { isLikelyPdfTab: () => true },
    )).toBe(false);
  });
});
