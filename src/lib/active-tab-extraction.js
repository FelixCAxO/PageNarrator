import { createLogger } from './logger.js';
import {
  createContentScriptAccessError,
  getHostPermissionOrigin,
  injectContentScript,
} from './content-script-injection.js';
import { isBrowserInternalUrl } from './readable-tab-target.js';
import { PDF_VIEWER_MESSAGE_TIMEOUT_MS } from './timing-config.js';
export { isBrowserInternalUrl };

const activeTabExtractionLogger = createLogger('active-tab-extraction');
const DEFAULT_CONTENT_SCRIPT_MESSAGE_TIMEOUT_MS = PDF_VIEWER_MESSAGE_TIMEOUT_MS;
const CONTENT_SCRIPT_MESSAGE_TIMEOUT_ERROR_CODE = 'content_script_message_timeout';

function hasReadableText(article) {
  return !article?.error && (
    Boolean(String(article?.text || '').trim())
    || typeof article?.chunkStream?.[Symbol.asyncIterator] === 'function'
  );
}

import { MESSAGE_TYPES } from './message-types.js';

const POST_INJECTION_EXTRACTION_ATTEMPTS = 5;
const POST_INJECTION_RETRY_DELAY_MS = 80;

function getExtractionMessage(readSelection, startMode, {
  streamArticleChunks = false,
  speechChunkOptions = null,
} = {}) {
  const message = readSelection ? { type: MESSAGE_TYPES.EXTRACT, readSelection: true } : { type: MESSAGE_TYPES.EXTRACT };
  if (startMode === 'top') message.startMode = 'top';
  if (streamArticleChunks && !readSelection) {
    message.streamChunks = true;
    if (speechChunkOptions) message.speechChunkOptions = speechChunkOptions;
  }
  return message;
}

async function extractFromContentScript({
  tab,
  tabs,
  scripting,
  getContentScriptFile,
  permissions,
  readSelection = false,
  startMode,
  streamArticleChunks = false,
  speechChunkOptions = null,
  signal = null,
  messageTimeoutMs = DEFAULT_CONTENT_SCRIPT_MESSAGE_TIMEOUT_MS,
}) {
  try {
    return await sendExtractionMessage({
      tab,
      tabs,
      readSelection,
      startMode,
      streamArticleChunks,
      speechChunkOptions,
      signal,
      messageTimeoutMs,
    });
  } catch (firstError) {
    if (signal?.aborted || isAbortError(firstError)) throw createAbortError();
    if (!tab.url && !tab.pendingUrl) {
      throw createContentScriptAccessError(tab);
    }

    await injectContentScript({ tab, scripting, getContentScriptFile, permissions });
    try {
      return await sendExtractionMessageWithRetry({
        tab,
        tabs,
        readSelection,
        startMode,
        streamArticleChunks,
        speechChunkOptions,
        signal,
        messageTimeoutMs,
        attempts: POST_INJECTION_EXTRACTION_ATTEMPTS,
        delayMs: POST_INJECTION_RETRY_DELAY_MS,
      });
    } catch (secondError) {
      activeTabExtractionLogger.warn('Content script extraction failed after injection retry.', {
        firstError,
        secondError,
      });
      throw secondError;
    }
  }
}

function sendExtractionMessage({
  tab,
  tabs,
  readSelection,
  startMode,
  streamArticleChunks,
  speechChunkOptions,
  signal = null,
  messageTimeoutMs = DEFAULT_CONTENT_SCRIPT_MESSAGE_TIMEOUT_MS,
}) {
  return sendContentScriptMessage(
    (tabId, message) => tabs.sendMessage(tabId, message),
    tab.id,
    getExtractionMessage(readSelection, startMode, {
      streamArticleChunks,
      speechChunkOptions,
    }),
    { signal, timeoutMs: messageTimeoutMs },
  );
}

async function sendExtractionMessageWithRetry({
  attempts = 1,
  delayMs = 0,
  delay = defaultDelay,
  signal = null,
  messageTimeoutMs = DEFAULT_CONTENT_SCRIPT_MESSAGE_TIMEOUT_MS,
  ...options
}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await sendExtractionMessage({ ...options, signal, messageTimeoutMs });
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw createAbortError();
      if (attempt === attempts - 1) break;
      await delay(delayMs, signal);
    }
  }
  throw lastError;
}

function defaultDelay(ms, signal = null) {
  const timeout = Math.max(0, Math.trunc(Number(ms) || 0));
  throwIfAborted(signal);
  if (timeout <= 0) return Promise.resolve();
  if (!signal || typeof signal.addEventListener !== 'function') {
    return new Promise((resolve) => setTimeout(resolve, timeout));
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener?.('abort', abort);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener?.('abort', abort);
      resolve();
    }, timeout);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function ensurePdfSourceAccess({ tab, permissions, getPdfSourceUrl }) {
  const sourceUrl = getPdfSourceUrl?.(tab);
  if (getHostPermissionOrigin(sourceUrl) !== 'file:///*') return;

  const request = { origins: ['file:///*'] };
  const hasAccess = typeof permissions?.contains === 'function'
    ? await permissions.contains(request).catch(() => false)
    : false;
  if (hasAccess) return;

  const granted = typeof permissions?.request === 'function'
    ? await permissions.request(request).catch(() => false)
    : false;
  if (!granted) throw createContentScriptAccessError({ url: sourceUrl });
}

async function tryExtractPdfFallback({
  tab,
  extractPdfArticle,
  canFetchPdfSourceUrl,
  getPdfSourceUrl,
  permissions,
  streamPdfChunks,
  speechChunkOptions,
  pdfStartPage,
  signal,
}) {
  throwIfAborted(signal);
  if (!canFetchPdfSourceUrl?.(tab)) return null;

  await ensurePdfSourceAccess({ tab, permissions, getPdfSourceUrl });

  try {
    const article = await extractPdfArticle({
      tab,
      requirePdfData: true,
      streamChunks: streamPdfChunks,
      speechChunkOptions,
      startPage: pdfStartPage,
      signal,
    });
    return hasReadableText(article) ? article : null;
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw createAbortError();
    activeTabExtractionLogger.warn('PDF fallback extraction failed.', error);
    return null;
  }
}

export async function extractReadableTab({
  tab,
  tabs,
  scripting,
  getContentScriptFile,
  permissions,
  extractPdfArticle,
  streamPdfChunks = false,
  streamArticleChunks = false,
  speechChunkOptions = null,
  readSelection = false,
  pdfStartPage,
  startMode = 'viewport',
  signal = null,
  messageTimeoutMs = DEFAULT_CONTENT_SCRIPT_MESSAGE_TIMEOUT_MS,
} = {}) {
  if (!tab?.id) throw new Error('No active tab found.');
  throwIfAborted(signal);

  let pdfFallback = null;
  let resolvedPdfStartPage = pdfStartPage;
  const {
    canFetchPdfSourceUrl,
    extractPdfArticle: defaultExtractPdf,
    getPdfSourceUrl,
    getPdfStartPageFromTab,
    isLikelyPdfTab,
  } = await import('./pdf-extraction.js');

  const extract = extractPdfArticle || defaultExtractPdf;
  pdfFallback = { canFetchPdfSourceUrl, extractPdfArticle: extract };
  resolvedPdfStartPage = startMode === 'top'
    ? 1
    : Number.isFinite(Number(pdfStartPage))
      ? Number(pdfStartPage)
      : getPdfStartPageFromTab(tab);

  if (isLikelyPdfTab(tab)) {
    await ensurePdfSourceAccess({ tab, permissions, getPdfSourceUrl });
    const article = await extract({
      tab,
      streamChunks: streamPdfChunks,
      speechChunkOptions,
      startPage: resolvedPdfStartPage,
      signal,
    });
    return { ...article, tabId: tab.id };
  }

  if (isBrowserInternalUrl(tab.url || '')) {
    throw new Error('Open a normal web page or PDF first.');
  }

  try {
    const article = await extractFromContentScript({
      tab,
      tabs,
      scripting,
      getContentScriptFile,
      permissions,
      readSelection,
      startMode,
      streamArticleChunks,
      speechChunkOptions,
      signal,
      messageTimeoutMs,
    });
    const hydratedArticle = attachContentArticleChunkStream(article, {
      tab,
      tabs,
      signal,
      messageTimeoutMs,
    });
    if (!hasReadableText(hydratedArticle) && pdfFallback) {
      const pdfArticle = await tryExtractPdfFallback({
        tab,
        ...pdfFallback,
        permissions,
        streamPdfChunks,
        speechChunkOptions,
        pdfStartPage: resolvedPdfStartPage,
        signal,
      });
      if (pdfArticle) return { ...pdfArticle, tabId: tab.id };
    }
    return { ...hydratedArticle, tabId: tab.id };
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw createAbortError();
    if (pdfFallback) {
      const pdfArticle = await tryExtractPdfFallback({
        tab,
        ...pdfFallback,
        permissions,
        streamPdfChunks,
        speechChunkOptions,
        pdfStartPage: resolvedPdfStartPage,
        signal,
      });
      if (pdfArticle) return { ...pdfArticle, tabId: tab.id };
    }
    throw error;
  }
}

function attachContentArticleChunkStream(article, {
  tab,
  tabs,
  signal = null,
  messageTimeoutMs = DEFAULT_CONTENT_SCRIPT_MESSAGE_TIMEOUT_MS,
} = {}) {
  const streamId = article?.chunkStreamId;
  if (!streamId || typeof article?.chunkStream?.[Symbol.asyncIterator] === 'function') return article;
  return {
    ...article,
    chunkStream: createContentArticleChunkStream({
      tabId: tab?.id,
      streamId,
      sendMessage: (tabId, message) => tabs.sendMessage(tabId, message),
      signal,
      messageTimeoutMs,
    }),
  };
}

function createContentArticleChunkStream({
  tabId,
  streamId,
  sendMessage,
  signal = null,
  messageTimeoutMs = DEFAULT_CONTENT_SCRIPT_MESSAGE_TIMEOUT_MS,
} = {}) {
  const sendChunkMessage = (message) => sendContentScriptMessage(sendMessage, tabId, message, {
    signal,
    timeoutMs: messageTimeoutMs,
  });
  const sendCloseMessage = (message) => sendContentScriptMessage(sendMessage, tabId, message, {
    timeoutMs: messageTimeoutMs,
  });

  return {
    [Symbol.asyncIterator]() {
      let closed = false;
      let bufferedChunks = [];
      return {
        async next(requestedCount = 1) {
          if (closed) return { done: true, value: undefined };
          if (bufferedChunks.length) {
            return { done: false, value: bufferedChunks.shift() };
          }
          const count = Math.max(1, Math.trunc(Number(requestedCount) || 1));
          const response = await sendChunkMessage({
            type: MESSAGE_TYPES.GET_ARTICLE_CHUNK,
            streamId,
            count,
            maxChunks: count,
          });
          if (response?.error) throw new Error(response.error);
          if (response?.done) {
            closed = true;
            return { done: true, value: undefined };
          }
          const chunks = Array.isArray(response?.chunks) ? response.chunks.filter(Boolean) : [];
          if (chunks.length > 1) {
            bufferedChunks = chunks.slice(1);
            return { done: false, value: chunks[0] };
          }
          if (chunks.length === 1) {
            return { done: false, value: chunks[0] };
          }
          return { done: false, value: response?.chunk };
        },
        async return() {
          if (!closed && tabId && streamId) {
            closed = true;
            try {
              await sendCloseMessage({
                type: MESSAGE_TYPES.CLOSE_ARTICLE_CHUNK_STREAM,
                streamId,
              });
            } catch (error) {
              activeTabExtractionLogger.warn('Could not close streamed article chunk.', error);
            }
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function sendContentScriptMessage(sendMessage, tabId, message, {
  signal = null,
  timeoutMs = DEFAULT_CONTENT_SCRIPT_MESSAGE_TIMEOUT_MS,
} = {}) {
  throwIfAborted(signal);
  const timeout = Math.max(0, Math.trunc(Number(timeoutMs) || 0));
  const source = Promise.resolve(sendMessage(tabId, message));
  void source.catch(() => null);
  let timeoutId = null;
  const pending = timeout > 0
    ? Promise.race([
      source,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          if (signal?.aborted) return;
          reject(createContentScriptMessageTimeoutError(message?.type, timeout));
        }, timeout);
      }),
    ])
    : source;

  return withAbortSignal(pending, signal).finally(() => {
    if (timeoutId !== null) clearTimeout(timeoutId);
  });
}

function withAbortSignal(promise, signal) {
  throwIfAborted(signal);
  const source = Promise.resolve(promise);
  void source.catch(() => null);
  if (!signal || typeof signal.addEventListener !== 'function') return source;

  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener?.('abort', abort);
      reject(createAbortError());
    };
    signal.addEventListener('abort', abort, { once: true });
    source.then(
      (value) => {
        signal.removeEventListener?.('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener?.('abort', abort);
        reject(error);
      },
    );
  });
}

function createContentScriptMessageTimeoutError(messageType, timeoutMs) {
  const error = new Error(`PageNarrator content script did not respond to ${messageType || 'message'} within ${timeoutMs} ms.`);
  error.code = CONTENT_SCRIPT_MESSAGE_TIMEOUT_ERROR_CODE;
  return error;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw createAbortError();
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function createAbortError() {
  if (typeof DOMException === 'function') return new DOMException('Content script request was aborted.', 'AbortError');
  const error = new Error('Content script request was aborted.');
  error.name = 'AbortError';
  return error;
}
