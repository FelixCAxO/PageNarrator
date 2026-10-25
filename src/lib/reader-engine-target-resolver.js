import { extractReadableTab } from './active-tab-extraction.js';
import {
  HIDDEN_TAB_URL_ACCESS_ERROR_CODE,
  injectContentScript,
  isContentScriptInjectableUrl,
} from './content-script-injection.js';
import {
  getPdfStartPageFromTab,
  getPdfViewerUrl,
  getPdfSourceUrl,
  isPageNarratorPdfViewerUrl,
  isLikelyPdfTab,
} from './pdf-extraction.js';
import { getPdfReadingStartFromViewer, resolvePdfReadStartPage } from './pdf-reading-start.js';
import { openPdfViewerForSourceTab } from './pdf-viewer-handoff.js';
import { createPdfViewerStreamingArticle } from './pdf-viewer-chunk-stream.js';
import { createPdfSelectionArticle } from './pdf-selection.js';
import { getReadableTabTargetFromStorageValue, resolveReadableTabTarget } from './readable-tab-target.js';
import { READABLE_TAB_TARGET_KEY } from './readable-tab-target.js';
import { MESSAGE_TYPES } from './message-types.js';

export function createReaderEngineTargetResolver({
  tabs,
  scripting,
  permissions,
  runtime,
  storage,
  messageRouter,
  state,
  getActiveTtsProfileConfig = () => ({ maxChunkLength: 320, targetMinLength: 180 }),
  getContentDiagnosticFlags = () => null,
} = {}) {
  function getContentScriptFile() {
    return 'src/content.js';
  }

  async function queryActiveTab() {
    const [tab] = await tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function getActiveReadableTab({ queuedTab = null } = {}) {
    const tab = await resolveReadableTabTarget({
      queuedTab,
      cachedTab: state.getPanelTargetTab(),
      queryActiveTab,
      getTabById: (tabId) => tabs.get(tabId),
      isLikelyPdfTab,
    });
    if (queuedTab?.id && hasTabUrlData(tab)) state.setPanelTargetTab(tab);
    return tab;
  }

  function getTabContextKey(tab) {
    if (!tab?.id) return '';
    const url = tab.url || tab.pendingUrl || '';
    // Match the read loop's source URL, independent of the viewer's page hash.
    return `${tab.id}:${isPageNarratorPdfViewerUrl(url) ? getPdfSourceUrl({ url }) : url}`;
  }

  async function extractActiveTab({
    tab = null,
    readSelection = false,
    startMode = 'viewport',
    signal = null,
    messageTimeoutMs = undefined,
  } = {}) {
    const activeTab = await getActiveReadableTab({ queuedTab: tab });
    const afterFinishedRead = startMode === 'restart';
    const shouldUseViewportStart = startMode !== 'top' && !afterFinishedRead;
    const isPdfTab = isLikelyPdfTab(activeTab);

    if (readSelection && isPdfTab) {
      const pdfSelection = await getPdfSelection(activeTab);
      return createPdfSelectionArticle(activeTab, pdfSelection, {
        sourceUrl: getPdfSourceUrl(activeTab) || activeTab?.url || '',
      });
    }

    const pdfReadingStart = isPdfTab && (shouldUseViewportStart || afterFinishedRead)
      ? await getPdfReadingStart(activeTab, { afterFinishedRead })
      : null;

    if (isPdfTab) {
      return createPdfViewerReadArticle(activeTab, {
        startPage: getPdfReadStartPage(activeTab, pdfReadingStart, shouldUseViewportStart, afterFinishedRead),
      });
    }

    const speechChunkOptions = getSpeechChunkOptions();
    const article = await extractReadableTab({
      tab: activeTab,
      tabs,
      scripting,
      permissions,
      getContentScriptFile,
      streamPdfChunks: true,
      streamArticleChunks: true,
      speechChunkOptions,
      readSelection,
      pdfStartPage: shouldUseViewportStart ? pdfReadingStart?.pageNumber : 1,
      startMode: afterFinishedRead ? 'top' : startMode,
      signal,
      messageTimeoutMs,
    });
    if (!isPdfTab && article?.source === 'pdf') {
      return createPdfViewerReadArticle(activeTab, {
        startPage: getPdfReadStartPage(activeTab, article.startPosition, shouldUseViewportStart),
      });
    }
    return shouldUseViewportStart && article?.source === 'pdf' && pdfReadingStart
      ? { ...article, startPosition: pdfReadingStart }
      : article;
  }

  async function createPdfViewerReadArticle(activeTab, { startPage = 1 } = {}) {
    const sourceUrl = getPdfSourceUrl(activeTab);
    const title = activeTab?.title || 'PDF document';
    let viewerTab = activeTab;

    if (isPageNarratorPdfViewerUrl(activeTab?.url || '')) {
      await waitForReaderTabReady(activeTab.id);
    } else {
      const viewerUrl = getPdfViewerUrlWithStartPage(sourceUrl, startPage);
      const nextPanelTarget = await openPdfViewerForSourceTab({
        tabs,
        storage,
        sourceTab: activeTab,
        viewerUrl,
        title,
        waitForReaderTabReady,
      }) || state.getPanelTargetTab();
      state.setPanelTargetTab(nextPanelTarget);
      viewerTab = nextPanelTarget || activeTab;
    }

    return createPdfViewerStreamingArticle({
      tab: viewerTab,
      sourceUrl,
      title,
      startPage,
      speechChunkOptions: getSpeechChunkOptions(),
      sendMessage: sendPdfViewerMessage,
    });
  }

  function getPdfReadStartPage(activeTab, pdfReadingStart, shouldUseViewportStart, afterFinishedRead = false) {
    return resolvePdfReadStartPage({
      activeTab,
      pdfReadingStart,
      shouldUseViewportStart,
      afterFinishedRead,
      getPdfStartPageFromTab,
    });
  }

  function sendPdfViewerMessage(tabId, message) {
    return messageRouter.sendPdfViewerMessage(tabId, message);
  }

  async function getPdfReadingStart(tab, { afterFinishedRead = false } = {}) {
    return getPdfReadingStartFromViewer(tab, {
      isPdfViewerUrl: isPageNarratorPdfViewerUrl,
      sendPageMessage,
      afterFinishedRead,
    });
  }

  async function getPdfSelection(tab) {
    if (!tab?.id || !isPageNarratorPdfViewerUrl(tab.url || '')) return null;
    const response = await sendPageMessage(tab.id, { type: MESSAGE_TYPES.GET_PDF_SELECTION }, { attempts: 1, delayMs: 0 });
    return response?.selection || null;
  }

  function getPdfViewerUrlWithStartPage(sourceUrl, pageNumber) {
    const viewerUrl = getPdfViewerUrl(sourceUrl, runtime);
    const page = Math.trunc(Number(pageNumber));
    if (!Number.isFinite(page) || page <= 1) return viewerUrl;
    return `${viewerUrl}#page=${page}`;
  }

  async function waitForReaderTabReady(tabId, { attempts = 30, delayMs = 100 } = {}) {
    if (!tabId) return false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await tabs.sendMessage(tabId, { type: MESSAGE_TYPES.PAGENARRATOR_PING });
        return true;
      } catch {
        await delay(delayMs);
      }
    }
    return false;
  }

  async function getFullTabInfo(tab) {
    const tabInfo = typeof tab === 'number' ? { id: tab } : tab;
    if (!tabInfo?.id || tabInfo.url) return tabInfo;

    try {
      return await tabs.get(tabInfo.id);
    } catch {
      return tabInfo;
    }
  }

  async function ensureContentScript(tab) {
    const tabInfo = await getFullTabInfo(tab);
    try {
      await tabs.sendMessage(tabInfo.id, { type: MESSAGE_TYPES.PAGENARRATOR_PING });
    } catch {
      const tabUrl = tabInfo.url || tabInfo.pendingUrl || '';
      if (tabUrl && !isContentScriptInjectableUrl(tabUrl)) {
        const error = new Error('Open a normal web page or PDF first.');
        error.code = HIDDEN_TAB_URL_ACCESS_ERROR_CODE;
        throw error;
      }
      await injectContentScript({
        tab: tabInfo,
        scripting,
        permissions,
        getContentScriptFile,
      });
    }
  }

  async function warmActiveTabContentScriptAccess(tab = null) {
    const activeTab = await getActiveReadableTab({ queuedTab: tab });
    const tabUrl = activeTab.url || activeTab.pendingUrl || '';
    if (!tabUrl) return;
    if (isLikelyPdfTab(activeTab) || (tabUrl && !isContentScriptInjectableUrl(tabUrl))) return;
    await ensureContentScript(activeTab);
  }

  function sendPageMessage(tabId, message, { attempts = 3, delayMs = 80 } = {}) {
    return messageRouter.sendPageMessage(tabId, withContentDiagnostics(message), { attempts, delayMs });
  }

  async function sendActivePageMessage(message) {
    const tab = state.getActiveReadTabId() ? { id: state.getActiveReadTabId() } : await getActiveReadableTab();
    await ensureContentScript(tab);
    return tabs.sendMessage(tab.id, withContentDiagnostics(message));
  }

  function withContentDiagnostics(message) {
    const flags = getContentDiagnosticFlags();
    return flags ? { ...message, contentDiagnostics: { recordFlow: flags.recordFlow === true } } : message;
  }

  function updatePanelTargetTabFromStorageValue(target) {
    state.setPanelTargetTab(getReadableTabTargetFromStorageValue(target));
  }

  function getSpeechChunkOptions() {
    const profile = getActiveTtsProfileConfig();
    return {
      maxLen: profile.maxChunkLength,
      targetMinLen: profile.targetMinLength,
    };
  }

  return {
    extractActiveTab,
    getActiveReadableTab,
    getTabContextKey,
    sendActivePageMessage,
    sendPageMessage,
    sendPdfViewerMessage,
    updatePanelTargetTabFromStorageValue,
    warmActiveTabContentScriptAccess,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasTabUrlData(tab = {}) {
  return Boolean(String(tab?.url || tab?.pendingUrl || '').trim());
}

export { READABLE_TAB_TARGET_KEY, isPageNarratorPdfViewerUrl };
