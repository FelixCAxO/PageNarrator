import { MESSAGE_TYPES } from './message-types.js';
import { isTrustedBackgroundSender, isTrustedExtensionPage } from './extension-message-security.js';
import {
  asyncResponse,
  createRuntimeMessageHandler,
  syncResponse,
} from './runtime-message-handlers.js';

const noop = (...args) => {
  void args;
};
const noopAsync = async (...args) => {
  void args;
};
const defaultPdfChunk = async () => ({ ok: false, error: 'PDF chunking is unavailable.' });

/**
 * @typedef {{
 *   setHighlightSettings?: Function,
 *   highlightChunkByAnchor?: Function,
 *   highlightQueuedChunkByAnchor?: Function,
 *   highlightWord?: Function,
 *   highlightWordPlan?: Function,
 *   resyncWordPlan?: Function,
 *   highlightSyntheticSpeech?: Function,
 *   setPaused?: Function,
 *   clearHighlights?: Function,
 * }} PdfViewerHighlighter
 */

/**
 * @param {{
 *   readyPromise?: Promise<unknown> | (() => Promise<unknown> | unknown),
 *   getReadingStartPosition?: Function,
 *   getPdfSelection?: Function,
 *   getStreamMetadata?: Function,
 *   getPdfChunk?: Function,
 *   closePdfChunkStream?: Function,
 *   teardown?: Function,
 *   highlighter?: PdfViewerHighlighter | (() => PdfViewerHighlighter),
 *   getWordTrailLength?: () => number,
 *   setCurrentHighlightSettings?: Function,
 *   ensureHighlightedPageRendered?: Function,
 *   setActiveHighlight?: Function,
 *   setActiveWordIndex?: Function,
 *   clearActiveHighlight?: Function,
 *   syncProtectedPdfHighlightPages?: Function,
 *   reconcilePdfRenderWindow?: Function,
 *   getCurrentPage?: () => number,
  *   onError?: Function | null,
 * }} options
 */
export function createPdfViewerMessageHandler({
  readyPromise = Promise.resolve(),
  getReadingStartPosition = () => null,
  getPdfSelection = () => null,
  getStreamMetadata = () => ({ ok: true }),
  getPdfChunk = defaultPdfChunk,
  closePdfChunkStream = noopAsync,
  teardown = noop,
  highlighter = {},
  getWordTrailLength = () => 0,
  setCurrentHighlightSettings = noop,
  ensureHighlightedPageRendered = noopAsync,
  setActiveHighlight = noop,
  setActiveWordIndex = noop,
  clearActiveHighlight = noop,
  syncProtectedPdfHighlightPages = noop,
  reconcilePdfRenderWindow = noop,
  getCurrentPage = () => 1,
  onError = null,
} = {}) {
  const waitUntilReady = () => Promise.resolve(typeof readyPromise === 'function' ? readyPromise() : readyPromise);
  const getHighlighter = () => (typeof highlighter === 'function' ? highlighter() : highlighter) || {};

  const handleMessage = createRuntimeMessageHandler({
    onError: onError ? (error, message) => onError(error, message) : null,
    handlers: {
      [MESSAGE_TYPES.PAGENARRATOR_PING]: syncResponse(() => ({ ok: true })),
      [MESSAGE_TYPES.GET_READING_START]: asyncResponse(async (msg) => {
        await waitUntilReady();
        return {
          ok: true,
          startPosition: getReadingStartPosition({
            readSelection: Boolean(msg.readSelection),
            afterFinishedRead: Boolean(msg.afterFinishedRead),
          }),
        };
      }),
      [MESSAGE_TYPES.GET_PDF_SELECTION]: asyncResponse(async () => {
        await waitUntilReady();
        return { ok: true, selection: getPdfSelection() };
      }),
      [MESSAGE_TYPES.GET_PDF_STREAM_METADATA]: asyncResponse(async (msg) => {
        await waitUntilReady();
        return getStreamMetadata(msg);
      }),
      [MESSAGE_TYPES.GET_PDF_CHUNK]: asyncResponse((msg) => getPdfChunk(msg)),
      [MESSAGE_TYPES.CLOSE_PDF_CHUNK_STREAM]: asyncResponse(async (msg) => {
        await closePdfChunkStream(msg.streamId, { instanceToken: msg.instanceToken });
        return { ok: true };
      }),
      [MESSAGE_TYPES.TEAR_DOWN_PDF_VIEWER]: syncResponse(() => {
        teardown();
        return { ok: true };
      }),
      [MESSAGE_TYPES.SET_HIGHLIGHT_SETTINGS]: syncResponse((msg) => {
        const activeHighlighter = getHighlighter();
        setCurrentHighlightSettings(msg.highlightSettings);
        return { ok: true, highlight: activeHighlighter.setHighlightSettings?.(msg.highlightSettings) };
      }),
      [MESSAGE_TYPES.HIGHLIGHT_CHUNK]: asyncResponse(async (msg) => {
        if (msg.highlightSettings) getHighlighter().setHighlightSettings?.(msg.highlightSettings);
        await ensureHighlightedPageRendered(msg.anchorId);
        const activeHighlighter = getHighlighter();
        const highlightRequest = {
          anchorId: msg.anchorId,
          text: msg.text,
          chunkText: msg.chunkText,
          domWordOffset: msg.domWordOffset,
          ...(msg.pdfNarration ? { pdfNarration: msg.pdfNarration } : {}),
          ...(msg.pdfSelection === true ? { pdfSelection: true } : {}),
        };
        const result = activeHighlighter.highlightChunkByAnchor?.(highlightRequest.anchorId, highlightRequest.text, {
          chunkText: highlightRequest.chunkText,
          domWordOffset: highlightRequest.domWordOffset,
          ...(highlightRequest.pdfNarration ? { pdfNarration: highlightRequest.pdfNarration } : {}),
          ...(highlightRequest.pdfSelection ? { pdfSelection: true } : {}),
        });
        if (result?.ok) {
          setActiveHighlight(highlightRequest);
          syncProtectedPdfHighlightPages();
          await reconcilePdfRenderWindow(getCurrentPage());
        }
        return result;
      }),
      [MESSAGE_TYPES.HIGHLIGHT_QUEUED]: asyncResponse(async (msg) => {
        if (msg.highlightSettings) getHighlighter().setHighlightSettings?.(msg.highlightSettings);
        await ensureHighlightedPageRendered(msg.anchorId);
        const activeHighlighter = getHighlighter();
        return activeHighlighter.highlightQueuedChunkByAnchor?.(msg.anchorId, msg.text, {
          chunkText: msg.chunkText,
          domWordOffset: msg.domWordOffset,
        });
      }),
      [MESSAGE_TYPES.HIGHLIGHT_WORD]: syncResponse((msg) => {
        const result = getHighlighter().highlightWord?.(msg.index, getWordTrailLength());
        if (result?.ok) setActiveWordIndex(msg.index);
        return result;
      }),
      [MESSAGE_TYPES.HIGHLIGHT_WORD_PLAN]: syncResponse((msg) => {
        const result = getHighlighter().highlightWordPlan?.(msg.plan, {
          currentTime: msg.currentTime,
          playbackRate: msg.playbackRate,
          paused: msg.paused,
          sentAtEpochMs: msg.sentAtEpochMs,
          leadSeconds: msg.leadSeconds,
          fadeMs: msg.fadeMs,
          trailLength: getWordTrailLength(),
        });
        if (result?.ok) setActiveWordIndex(null);
        return result;
      }),
      [MESSAGE_TYPES.HIGHLIGHT_PLAN_RESYNC]: syncResponse((msg) => getHighlighter().resyncWordPlan?.({
        currentTime: msg.currentTime,
        playbackRate: msg.playbackRate,
        paused: msg.paused,
        sentAtEpochMs: msg.sentAtEpochMs,
      })),
      [MESSAGE_TYPES.HIGHLIGHT_SYNTHETIC_SPEECH]: syncResponse(() => getHighlighter().highlightSyntheticSpeech?.()),
      [MESSAGE_TYPES.SET_HIGHLIGHT_PAUSED]: syncResponse((msg) => getHighlighter().setPaused?.(msg.paused)),
      [MESSAGE_TYPES.CLEAR_HIGHLIGHT]: syncResponse(() => {
        getHighlighter().clearHighlights?.();
        clearActiveHighlight();
        syncProtectedPdfHighlightPages();
        void reconcilePdfRenderWindow(getCurrentPage());
        return { ok: true };
      }),
    },
  });

  return (message, sender, sendResponse) => {
    const runtime = globalThis.chrome?.runtime;
    if (!isTrustedBackgroundSender(sender, runtime)
      && !isTrustedExtensionPage(sender, runtime, 'src/reader-engine.html')) return false;
    return handleMessage(message, sender, sendResponse);
  };
}
