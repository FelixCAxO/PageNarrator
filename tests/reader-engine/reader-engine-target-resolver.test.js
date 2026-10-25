import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGE_TYPES } from '../../src/lib/message-types.js';

const mocks = vi.hoisted(() => ({
  extractReadableTab: vi.fn(),
}));

vi.mock('../../src/lib/active-tab-extraction.js', () => ({
  extractReadableTab: mocks.extractReadableTab,
}));

const SOURCE_URL = 'https://example.test/books/intro-java#page=4';

describe('toolbar player target resolver', () => {
  beforeEach(() => {
    mocks.extractReadableTab.mockReset();
  });

  it('keeps a finished PDF document context across page navigation without merging documents or article routes', async () => {
    const { createReaderEngineTargetResolver } = await import('../../src/lib/reader-engine-target-resolver.js');
    const { getTabContextKey } = createReaderEngineTargetResolver();
    const url = 'chrome-extension://pagenarrator/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Fbook.pdf';
    const key = getTabContextKey({ id: 7, url });
    expect(key).toBe(getTabContextKey({ id: 7, url: 'https://example.test/book.pdf' }));
    expect(getTabContextKey({ id: 7, url: `${url}#page=1` })).toBe(key);
    expect(getTabContextKey({ id: 7, url: `${url}#page=4` })).toBe(key);
    expect(getTabContextKey({ id: 7, pendingUrl: `${url}#page=4` })).toBe(key);
    expect(getTabContextKey({ id: 8, url })).not.toBe(key);
    expect(getTabContextKey({ id: 7, url: url.replace('book.pdf', 'other.pdf') })).not.toBe(key);
    expect(getTabContextKey({ id: 7, url: 'https://example.test/#route-a' }))
      .not.toBe(getTabContextKey({ id: 7, url: 'https://example.test/#route-b' }));
    expect(getTabContextKey({})).toBe('');
  });

  it('pushes only the current diagnostic recording flag with trusted page commands', async () => {
    const { createReaderEngineTargetResolver } = await import('../../src/lib/reader-engine-target-resolver.js');
    const messageRouter = { sendPageMessage: vi.fn() };
    let recordFlow = true;
    const resolver = createReaderEngineTargetResolver({
      messageRouter,
      getContentDiagnosticFlags: () => ({ recordFlow, unrelatedPrivateSetting: 'secret' }),
    });
    const message = { type: MESSAGE_TYPES.HIGHLIGHT_WORD, index: 0, contentDiagnostics: { recordFlow: false } };
    resolver.sendPageMessage(4, message);
    expect(messageRouter.sendPageMessage).toHaveBeenLastCalledWith(4, {
      ...message, contentDiagnostics: { recordFlow: true },
    }, { attempts: 3, delayMs: 80 });
    recordFlow = false;
    resolver.sendPageMessage(4, { type: MESSAGE_TYPES.CLEAR_HIGHLIGHT });
    expect(messageRouter.sendPageMessage).toHaveBeenLastCalledWith(4, {
      type: MESSAGE_TYPES.CLEAR_HIGHLIGHT, contentDiagnostics: { recordFlow: false },
    }, { attempts: 3, delayMs: 80 });
    expect(message.contentDiagnostics).toEqual({ recordFlow: false });
  });

  it('replaces a cached PDF viewer target when tab activation supplies a new article tab', async () => {
    const { createReaderEngineTargetResolver } = await import('../../src/lib/reader-engine-target-resolver.js');
    const oldViewerTab = {
      id: 7,
      title: 'Old PDF',
      url: 'chrome-extension://pagenarrator/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Fold.pdf',
    };
    const newArticleTab = {
      id: 22,
      title: 'New article',
      url: 'https://example.test/new-article',
    };
    let panelTargetTab = oldViewerTab;
    const state = {
      getPanelTargetTab: () => panelTargetTab,
      setPanelTargetTab: (tab) => {
        panelTargetTab = tab;
      },
      getActiveReadTabId: () => null,
    };
    const tabs = {
      query: async () => [{
        id: 99,
        title: 'PageNarrator',
        url: 'chrome-extension://pagenarrator/src/reader-engine.html',
      }],
      get: async (id) => (id === newArticleTab.id ? newArticleTab : { id }),
      sendMessage: vi.fn(),
    };
    const messageRouter = {
      sendPageMessage: vi.fn(),
      sendPdfViewerMessage: vi.fn(),
    };
    mocks.extractReadableTab.mockResolvedValue({
      tabId: newArticleTab.id,
      url: newArticleTab.url,
      title: newArticleTab.title,
      source: 'reading-model',
      text: 'The new article is now active.',
      chunks: [{ speech: 'The new article is now active.' }],
    });

    const resolver = createReaderEngineTargetResolver({
      tabs,
      scripting: {},
      permissions: {},
      runtime: { getURL: (path) => `chrome-extension://pagenarrator/${path}` },
      storage: { set: async () => {} },
      messageRouter,
      state,
      getPro: async () => true,
    });

    await resolver.getActiveReadableTab({ queuedTab: { id: newArticleTab.id } });
    const article = await resolver.extractActiveTab();

    expect(panelTargetTab).toEqual(newArticleTab);
    expect(mocks.extractReadableTab).toHaveBeenCalledWith(expect.objectContaining({
      tab: newArticleTab,
    }));
    expect(article).toMatchObject({
      tabId: newArticleTab.id,
      url: newArticleTab.url,
    });
  });

  it('does not replace a URL-bearing target with a tab-id-only activation', async () => {
    const { createReaderEngineTargetResolver } = await import('../../src/lib/reader-engine-target-resolver.js');
    const cachedArticleTab = {
      id: 14,
      title: 'Cached article',
      url: 'https://example.test/cached-article',
    };
    let panelTargetTab = cachedArticleTab;
    const resolver = createReaderEngineTargetResolver({
      tabs: {
        query: async () => [],
        get: async (id) => ({ id }),
      },
      scripting: {},
      permissions: {},
      runtime: { getURL: (path) => `chrome-extension://pagenarrator/${path}` },
      storage: { set: async () => {} },
      messageRouter: {
        sendPageMessage: vi.fn(),
        sendPdfViewerMessage: vi.fn(),
      },
      state: {
        getPanelTargetTab: () => panelTargetTab,
        setPanelTargetTab: (tab) => {
          panelTargetTab = tab;
        },
        getActiveReadTabId: () => null,
      },
      getPro: async () => true,
    });

    await resolver.getActiveReadableTab({ queuedTab: { id: 99 } });

    expect(panelTargetTab).toEqual(cachedArticleTab);
  });

  it('routes an early extensionless arXiv PDF snapshot while Chrome hides its current URL', async () => {
    const { createReaderEngineTargetResolver } = await import('../../src/lib/reader-engine-target-resolver.js');
    const earlySnapshot = {
      id: 31,
      title: 'AI in Finance',
      url: 'https://arxiv.org/pdf/2107.09051',
    };
    const tabs = {
      query: vi.fn(),
      get: vi.fn(async () => ({ id: earlySnapshot.id })),
      update: vi.fn(async (id, update) => ({ id, title: earlySnapshot.title, url: update.url })),
      sendMessage: vi.fn(async () => ({ ok: true })),
    };
    const resolver = createReaderEngineTargetResolver({
      tabs,
      scripting: {},
      permissions: {},
      runtime: { getURL: (path) => `chrome-extension://pagenarrator/${path}` },
      storage: { set: vi.fn(async () => {}) },
      messageRouter: {
        sendPageMessage: vi.fn(),
        sendPdfViewerMessage: vi.fn(async (_tabId, message) => message.type === MESSAGE_TYPES.GET_PDF_STREAM_METADATA
          ? { ok: true, title: earlySnapshot.title, url: earlySnapshot.url, pageCount: 38, instanceToken: 'viewer-1' }
          : { ok: true }),
      },
      state: {
        getPanelTargetTab: () => null,
        setPanelTargetTab: vi.fn(),
        getActiveReadTabId: () => null,
      },
      getPro: async () => true,
    });

    const article = await resolver.extractActiveTab({ tab: earlySnapshot });

    expect(mocks.extractReadableTab).not.toHaveBeenCalled();
    expect(article).toMatchObject({ source: 'pdf', streaming: true, tabId: earlySnapshot.id, pageCount: 38 });
  });

  it('routes extensionless PDFs proven by fallback sniffing into the PageNarrator viewer', async () => {
    const { createReaderEngineTargetResolver } = await import('../../src/lib/reader-engine-target-resolver.js');
    const calls = [];
    const state = {
      getPanelTargetTab: () => null,
      setPanelTargetTab: (tab) => calls.push(['state.setPanelTargetTab', tab]),
      getActiveReadTabId: () => null,
    };
    const tabs = {
      query: async () => [],
      get: async (id) => ({ id }),
      update: async (id, update) => {
        calls.push(['tabs.update', id, update]);
        return { id, title: 'Intro', url: update.url };
      },
      sendMessage: vi.fn(),
    };
    const messageRouter = {
      sendPageMessage: vi.fn(),
      sendPdfViewerMessage: async (tabId, message) => {
        calls.push(['sendPdfViewerMessage', tabId, message]);
        if (message.type === MESSAGE_TYPES.GET_PDF_STREAM_METADATA) {
          return {
            ok: true,
            title: 'Introduction',
            url: SOURCE_URL,
            pageCount: 17,
            instanceToken: 'viewer-1',
          };
        }
        return { ok: true };
      },
    };

    mocks.extractReadableTab.mockResolvedValue({
      source: 'pdf',
      title: 'Introduction',
      text: 'PDF text',
      url: SOURCE_URL,
      startPosition: {
        source: 'page',
        pageNumber: 4,
        anchorId: 'pdf-page-4',
      },
    });

    const resolver = createReaderEngineTargetResolver({
      tabs,
      scripting: {},
      permissions: {},
      runtime: { getURL: (path) => `chrome-extension://pagenarrator/${path}` },
      storage: { set: async (value) => calls.push(['storage.set', value]) },
      messageRouter,
      state,
      getPro: async () => true,
    });

    const article = await resolver.extractActiveTab({
      tab: { id: 7, title: 'Introduction', url: SOURCE_URL },
    });

    expect(article).toMatchObject({
      source: 'pdf',
      streaming: true,
      tabId: 7,
      pageCount: 17,
      startPosition: {
        pageNumber: 4,
        anchorId: 'pdf-page-4',
      },
    });
    expect(calls).toContainEqual([
      'tabs.update',
      7,
      {
        url: 'chrome-extension://pagenarrator/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Fbooks%2Fintro-java%23page%3D4#page=4',
        active: true,
      },
    ]);
    expect(calls.some(([name]) => name === 'sendPdfViewerMessage')).toBe(true);
  });

  it('uses viewer-owned streaming for known PageNarrator PDF tabs without extracting the page first', async () => {
    const { createReaderEngineTargetResolver } = await import('../../src/lib/reader-engine-target-resolver.js');
    const viewerTab = {
      id: 12,
      title: 'Viewer PDF',
      url: 'chrome-extension://pagenarrator/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Fviewer.pdf#page=3',
    };
    const sentMessages = [];
    const resolver = createReaderEngineTargetResolver({
      tabs: {
        query: async () => [viewerTab],
        get: async () => viewerTab,
        sendMessage: async () => ({ ok: true }),
      },
      scripting: {},
      permissions: {},
      runtime: { getURL: (path) => `chrome-extension://pagenarrator/${path}` },
      storage: { set: async () => {} },
      messageRouter: {
        sendPageMessage: vi.fn(),
        sendPdfViewerMessage: async (tabId, message) => {
          sentMessages.push([tabId, message]);
          if (message.type === MESSAGE_TYPES.GET_PDF_STREAM_METADATA) {
            return {
              ok: true,
              title: 'Viewer PDF',
              url: 'https://example.test/viewer.pdf',
              pageCount: 8,
              instanceToken: 'viewer-owned-stream',
            };
          }
          return { ok: true };
        },
      },
      state: {
        getPanelTargetTab: () => viewerTab,
        setPanelTargetTab: vi.fn(),
        getActiveReadTabId: () => null,
      },
      getPro: async () => true,
    });

    const article = await resolver.extractActiveTab();

    expect(article).toMatchObject({
      source: 'pdf',
      streaming: true,
      tabId: viewerTab.id,
      pageCount: 8,
      startPosition: {
        pageNumber: 3,
        anchorId: 'pdf-page-3',
      },
    });
    expect(mocks.extractReadableTab).not.toHaveBeenCalled();
    expect(sentMessages).toContainEqual([
      viewerTab.id,
      { type: MESSAGE_TYPES.GET_PDF_STREAM_METADATA, startPage: 3 },
    ]);
  });

  describe('restarting a finished read', () => {
    const viewerTab = {
      id: 12,
      title: 'Viewer PDF',
      url: 'chrome-extension://pagenarrator/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Fviewer.pdf#page=8',
    };

    async function restartFinishedPdfRead(viewerStartPosition) {
      const { createReaderEngineTargetResolver } = await import('../../src/lib/reader-engine-target-resolver.js');
      const pageMessages = [];
      const metadataRequests = [];
      const resolver = createReaderEngineTargetResolver({
        tabs: {
          query: async () => [viewerTab],
          get: async () => viewerTab,
          sendMessage: async () => ({ ok: true }),
        },
        scripting: {},
        permissions: {},
        runtime: { getURL: (path) => `chrome-extension://pagenarrator/${path}` },
        storage: { set: async () => {} },
        messageRouter: {
          sendPageMessage: async (tabId, message) => {
            pageMessages.push([tabId, message]);
            return { ok: true, startPosition: viewerStartPosition };
          },
          sendPdfViewerMessage: async (_tabId, message) => {
            if (message.type !== MESSAGE_TYPES.GET_PDF_STREAM_METADATA) return { ok: true };
            metadataRequests.push(message);
            return { ok: true, url: 'https://example.test/viewer.pdf', pageCount: 8, instanceToken: 'restart' };
          },
        },
        state: {
          getPanelTargetTab: () => viewerTab,
          setPanelTargetTab: vi.fn(),
          getActiveReadTabId: () => null,
        },
      });
      const article = await resolver.extractActiveTab({ startMode: 'restart' });
      return { article, pageMessages, metadataRequests };
    }

    it('starts on the page the reader scrolled to after the read finished', async () => {
      const { article, pageMessages, metadataRequests } = await restartFinishedPdfRead({
        source: 'viewport',
        pageNumber: 5,
        anchorId: 'pdf-page-5',
      });

      expect(pageMessages).toEqual([[viewerTab.id, { type: MESSAGE_TYPES.GET_READING_START, afterFinishedRead: true }]]);
      expect(metadataRequests).toEqual([{ type: MESSAGE_TYPES.GET_PDF_STREAM_METADATA, startPage: 5 }]);
      expect(article.startPosition).toMatchObject({ pageNumber: 5 });
    });

    it('starts from page one while the viewer still rests on the last narrated page', async () => {
      const { article, metadataRequests } = await restartFinishedPdfRead(null);

      expect(metadataRequests).toEqual([{ type: MESSAGE_TYPES.GET_PDF_STREAM_METADATA, startPage: 1 }]);
      expect(article.startPosition).toBeUndefined();
    });

    it('restarts a finished webpage read from the top', async () => {
      const { createReaderEngineTargetResolver } = await import('../../src/lib/reader-engine-target-resolver.js');
      const articleTab = { id: 22, title: 'Article', url: 'https://example.test/article' };
      mocks.extractReadableTab.mockResolvedValue({
        tabId: articleTab.id,
        url: articleTab.url,
        source: 'reading-model',
        text: 'Article text.',
        chunks: [{ speech: 'Article text.' }],
      });
      const resolver = createReaderEngineTargetResolver({
        tabs: { query: async () => [articleTab], get: async () => articleTab, sendMessage: vi.fn() },
        scripting: {},
        permissions: {},
        runtime: { getURL: (path) => `chrome-extension://pagenarrator/${path}` },
        storage: { set: async () => {} },
        messageRouter: { sendPageMessage: vi.fn(), sendPdfViewerMessage: vi.fn() },
        state: {
          getPanelTargetTab: () => articleTab,
          setPanelTargetTab: vi.fn(),
          getActiveReadTabId: () => null,
        },
      });

      await resolver.extractActiveTab({ startMode: 'restart' });

      expect(mocks.extractReadableTab).toHaveBeenCalledWith(expect.objectContaining({ startMode: 'top', pdfStartPage: 1 }));
    });
  });
});
