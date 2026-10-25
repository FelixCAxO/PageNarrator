// @ts-check
import { isTrustedBackgroundSender, isTrustedExtensionPage } from './lib/extension-message-security.js';

const handlerCache = new Map();

const handlerRoutes = [
  {
    types: new Set(['extract', 'getArticleChunk', 'closeArticleChunkStream']),
    modulePath: './reader/extraction/content-extraction.js',
    exportName: 'handleExtractMessage',
  },
  {
    types: new Set([
      'setHighlightSettings',
      'highlightChunk',
      'highlightQueued',
      'highlightWord',
      'highlightWordPlan',
      'highlightPlanResync',
      'getFlowLog',
      'highlightSyntheticSpeech',
      'flashResumeSection',
      'setHighlightPaused',
      'clearHighlight',
    ]),
    modulePath: './reader/highlighting/content-highlight.js',
    exportName: 'handleHighlightMessage',
  },
];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isTrustedBackgroundSender(sender, chrome.runtime)
    && !isTrustedExtensionPage(sender, chrome.runtime, 'src/reader-engine.html')) return false;
  try {
    if (msg?.type === 'pagenarratorPing') {
      sendResponse({ ok: true });
      return false;
    }

    const route = findHandlerRoute(msg?.type);
    if (!route) return false;

    loadHandler(route.modulePath)
      .then((module) => module[route.exportName](msg))
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ error: error?.message ?? String(error) }));
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendResponse({ error: message });
    return false;
  }
});

function findHandlerRoute(type) {
  return handlerRoutes.find((route) => route.types.has(type));
}

function loadHandler(modulePath) {
  if (!handlerCache.has(modulePath)) {
    if (modulePath === './reader/extraction/content-extraction.js') {
      handlerCache.set(modulePath, import('./reader/extraction/content-extraction.js'));
    } else if (modulePath === './reader/highlighting/content-highlight.js') {
      handlerCache.set(modulePath, import('./reader/highlighting/content-highlight.js'));
    } else {
      handlerCache.set(modulePath, Promise.reject(new Error(`Unknown content handler: ${modulePath}`)));
    }
  }
  return handlerCache.get(modulePath);
}
