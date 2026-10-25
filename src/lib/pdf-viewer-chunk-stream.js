import { MESSAGE_TYPES } from './message-types.js';
import { PDF_VIEWER_MESSAGE_TIMEOUT_MS } from './timing-config.js';

let nextPdfViewerStreamId = 1;

export async function createPdfViewerStreamingArticle({
  tab,
  sourceUrl = '',
  title = '',
  startPage = 1,
  speechChunkOptions = null,
  sendMessage,
  streamId = createPdfViewerStreamId(),
  messageTimeoutMs = PDF_VIEWER_MESSAGE_TIMEOUT_MS,
} = {}) {
  if (!tab?.id) throw new Error('No PageNarrator PDF viewer tab found.');
  if (typeof sendMessage !== 'function') throw new Error('PDF viewer messaging is unavailable.');

  const firstPage = normalizeStartPage(startPage);
  const metadata = await sendViewerMessage(sendMessage, tab.id, {
    type: MESSAGE_TYPES.GET_PDF_STREAM_METADATA,
    startPage: firstPage,
  }, { timeoutMs: messageTimeoutMs });
  assertViewerResponse(metadata, 'Could not read PDF metadata from the viewer.');

  return {
    source: 'pdf',
    title: metadata.title || title || tab.title || 'PDF document',
    text: '',
    chunks: [],
    url: metadata.url || sourceUrl || tab.url || '',
    pageCount: normalizePageCount(metadata.pageCount),
    totalReadableWordCount: Math.max(0, Math.trunc(Number(metadata.totalReadableWordCount) || 0)),
    streaming: true,
    tabId: tab.id,
    chunkStream: createPdfViewerChunkStream({
      tabId: tab.id,
      streamId,
      instanceToken: metadata.instanceToken,
      startPage: firstPage,
      speechChunkOptions,
      sendMessage,
      messageTimeoutMs: Math.max(messageTimeoutMs, 120_000),
    }),
    ...(firstPage > 1 ? {
      startPosition: {
        source: 'page',
        pageNumber: firstPage,
        anchorId: `pdf-page-${firstPage}`,
      },
    } : {}),
  };
}

export function createPdfViewerChunkStream({
  tabId,
  streamId = createPdfViewerStreamId(),
  instanceToken = null,
  startPage = 1,
  speechChunkOptions = null,
  sendMessage,
  messageTimeoutMs = PDF_VIEWER_MESSAGE_TIMEOUT_MS,
} = {}) {
  if (!tabId) throw new Error('No PageNarrator PDF viewer tab found.');
  if (typeof sendMessage !== 'function') throw new Error('PDF viewer messaging is unavailable.');

  let closed = false;
  const firstPage = normalizeStartPage(startPage);

  return {
    [Symbol.asyncIterator]() {
      return {
        async next(requestedCount = 1) {
          if (closed) return { done: true };
          const count = normalizeChunkRequestCount(requestedCount);

          const response = await sendViewerMessage(sendMessage, tabId, {
            type: MESSAGE_TYPES.GET_PDF_CHUNK,
            streamId,
            instanceToken,
            startPage: firstPage,
            speechChunkOptions,
            count,
            maxChunks: count,
          }, { timeoutMs: messageTimeoutMs });
          assertViewerResponse(response, 'Could not extract PDF text from the viewer.');
          if (response.done) {
            closed = true;
            return { done: true };
          }
          const chunks = Array.isArray(response.chunks) ? response.chunks.filter(Boolean) : [];
          return { done: false, value: chunks.length > 1 ? chunks : chunks[0] || response.value };
        },
        async return() {
          if (!closed) {
            closed = true;
            try {
              await sendViewerMessage(sendMessage, tabId, {
                type: MESSAGE_TYPES.CLOSE_PDF_CHUNK_STREAM,
                streamId,
                instanceToken,
              }, { timeoutMs: messageTimeoutMs });
            } catch {
              // The viewer may already be closed; cleanup messages are best effort.
            }
          }
          return { done: true };
        },
      };
    },
  };
}

function createPdfViewerStreamId() {
  const id = nextPdfViewerStreamId;
  nextPdfViewerStreamId += 1;
  return `pdf-viewer-stream-${id}`;
}

function assertViewerResponse(response, fallbackMessage) {
  if (response?.ok === false) {
    const error = new Error(response.error || fallbackMessage);
    if (response.code) error.code = response.code;
    throw error;
  }
  if (!response) throw new Error(fallbackMessage);
}

function sendViewerMessage(sendMessage, tabId, message, { timeoutMs = PDF_VIEWER_MESSAGE_TIMEOUT_MS } = {}) {
  const timeout = Math.max(0, Math.trunc(Number(timeoutMs) || 0));
  const source = Promise.resolve(sendMessage(tabId, message, { timeoutMs: timeout }));
  void source.catch(() => null);
  if (timeout <= 0) return source;

  let timeoutId = null;
  const deadline = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`PageNarrator PDF viewer did not respond to ${message?.type || 'message'} within ${timeout} ms.`);
      error.code = 'pdf_viewer_message_timeout';
      reject(error);
    }, timeout);
  });

  return Promise.race([source, deadline]).finally(() => {
    if (timeoutId !== null) clearTimeout(timeoutId);
  });
}

function normalizeStartPage(value) {
  const page = Math.trunc(Number(value));
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function normalizeChunkRequestCount(value) {
  const count = Math.trunc(Number(value));
  return Number.isFinite(count) && count > 0 ? count : 1;
}

function normalizePageCount(value) {
  const pageCount = Math.trunc(Number(value));
  return Number.isFinite(pageCount) && pageCount > 0 ? pageCount : 0;
}
