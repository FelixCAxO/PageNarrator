// @ts-check
import { findBestMatch, normalizeForSearch } from './highlight-search.js';
import { getNoiseSelector } from './dom-selectors.js';
import { normalizeHighlightSettings } from './playback-settings.js';
import { hexToRgbString, isDarkColor, parseCssColor } from './color-utils.js';
import { tokenizeSpokenWords } from './speech-tokenization.js';
import { isReferenceTextElement } from './reading-model.js';
import { createScrollFollower } from './page-highlighter-scroll-follow.js';
import { createLogger } from './logger.js';
import {
  DARK_CODE_BLOCK_ATTRIBUTE,
  PDF_TEXT_LAYER_NARRATED_ATTRIBUTE,
  PDF_TEXT_LAYER_ORDER_ATTRIBUTE,
  getPdfTextNodeOrder,
  PDF_TEXT_LAYER_TEXT_ATTRIBUTE,
} from './page-highlighter-dom-state.js';
import { REGION_OVERLAY_ATTRIBUTE } from './page-highlighter-region-overlay.js';
import {
  MAX_FALLBACK_SEARCH_TEXT_LENGTH,
  PDF_WORD_MATCH_LOOKAHEAD,
  appendNormalizedNode,
  needsTextNodeSeparator,
} from './page-highlighter-search-index.js';
import { normalizeWordPlanEntry, findMergedPdfFragmentMatch, applyPdfNarration, getPdfNarrationChunkRanges } from './page-highlighter-word-plan.js';
import { createPdfWordOverlayRenderer } from './page-highlighter-word-overlays.js';

export const HIGHLIGHT_CHUNK = 'pagenarrator-chunk';
export const HIGHLIGHT_WORD = 'pagenarrator-word';
export const HIGHLIGHT_WORD_TRAIL = [
  'pagenarrator-word-0',
  'pagenarrator-word-1',
  'pagenarrator-word-2',
  'pagenarrator-word-3',
];

const pageHighlighterLogger = createLogger('page-highlighter');

export function createPageHighlighter(documentRef = document, options = {}) {
  const win = documentRef.defaultView || globalThis;
  const highlighterOptions = {
    pdfMode: Boolean(options.pdfMode),
    defaultWordTrailLength: Number.isFinite(Number(options.defaultWordTrailLength))
      ? Math.max(1, Math.trunc(Number(options.defaultWordTrailLength)))
      : HIGHLIGHT_WORD_TRAIL.length,
    showQueuedRegion: options.showQueuedRegion !== false,
    preferCssOnlyRegion: Boolean(options.preferCssOnlyRegion),
    strictWordPlan: options.strictWordPlan ?? isTestLikeWindow(win),
  };
  const wordPlanClock = options.mediaClock || createWordPlanClock(win);
  const flowRecorder = options.flowRecorder || null;
  const noiseSelector = getNoiseSelector({ surface: highlighterOptions.pdfMode ? 'pdf' : 'highlighter' });
  let wordRanges = [];
  let lastWordIndex = -1;
  let recentWordRanges = [];
  let activeBlock = null;
  let searchCursor = 0;
  let regionOverlays = [];
  let queuedRegionOverlays = [];
  let activeRegionTarget = null;
  let queuedRegionTarget = null;
  let cachedSearchIndex = null;
  let searchIndexWidth = win.innerWidth;
  let searchIndexHeight = win.innerHeight;
  let searchIndexMutationObserver = null;
  let highlightStylesEnsured = false;
  let pinningEnsured = false;
  let pinningResizeObserver = null;
  const scrollFollower = createScrollFollower({ win, documentRef });
  let highlightSettings = normalizeHighlightSettings(options.highlightSettings);
  let wordPlanTimers = new Set();
  let wordPlanFrame = null;
  let wordPlanGeneration = 0;
  let timedWordRanges = [];
  let activeWordPlan = null;
  const recordedWordFlowKeys = new Set();
  const pdfWordOverlays = createPdfWordOverlayRenderer({
    enabled: highlighterOptions.pdfMode,
    documentRef,
    flattenRanges,
    getRangeRects,
    ensurePinning,
    maxTrailLength: HIGHLIGHT_WORD_TRAIL.length,
  });

  function highlightChunk(text) {
    ensureHighlightStyles();

    if (!text) {
      return activeBlock || hasRegionOverlay('active') ? { ok: true, retained: true } : { ok: false };
    }

    const index = buildSearchIndex();
    if (index.tooLarge) {
      clearActiveHighlights();
      return { ok: false, reason: 'fallback-index-too-large' };
    }

    const target = normalizeForSearch(text, { normalizeSoftHyphenBreaks: highlighterOptions.pdfMode });
    const match = findBestMatch(index.fullText, target, searchCursor);
    if (!match) {
      searchCursor = Math.min(index.fullText.length, searchCursor + Math.min(120, target.length));
      clearActiveHighlights();
      return { ok: false };
    }

    searchCursor = Math.max(searchCursor, match.end);
    const nextWordRanges = createWordRanges(index.map, match.start, match.end);

    const chunkRange = createRangeFromNormalizedSpan(index.map, match.start, match.end);
    if (!chunkRange) return { ok: false };

    const block = getTextBlockForRange(chunkRange);
    if (block) {
      setActiveChunk({
        block,
        wordRanges: nextWordRanges,
        highlightRange: createElementContentsRange(block),
        primaryRegionTarget: { type: 'range', range: chunkRange },
        fallbackRegionTarget: { type: 'element', element: block },
      });
      scrollElementIntoView(activeBlock);
      return { ok: true };
    }

    const displayRange = expandRangeToTextBlock(chunkRange);
    setActiveChunk({
      block: null,
      wordRanges: nextWordRanges,
      highlightRange: displayRange,
      primaryRegionTarget: { type: 'range', range: displayRange },
    });

    scrollRangeIntoView(displayRange);
    return { ok: true };
  }

  function highlightChunkByAnchor(anchorId, fallbackText, options = {}) {
    ensureHighlightStyles();

    const element = getAnchoredElement(anchorId);
    if (!element) {
      const result = highlightChunk(fallbackText || options.chunkText);
      if (!options.reportGrounding) return result;
      return { ...result, grounded: false, fallback: true };
    }

    const nextWordRanges = options.pdfSelection
      ? createWordRangeEntriesFromElement(element, true).map((entry) => entry.range)
      : createAnchoredWordRanges(element, options.pdfNarration);
    const chunkRanges = getAnchoredTextRanges(element, options.chunkText, options)
      || (highlighterOptions.pdfMode && getPdfNarrationChunkRanges(
        nextWordRanges, options.chunkText, options, normalizeWordToken, flattenRanges,
      ))
      || getAnchoredTextRanges(element, fallbackText, options);
    const primaryRegionTarget = chunkRanges
      ? createRangeRegionTarget(chunkRanges)
      : { type: 'element', element };
    const fallbackRegionTarget = chunkRanges
      ? { type: 'element', element }
      : nextWordRanges.length ? createRangeRegionTarget(flattenRanges(nextWordRanges)) : null;

    // ponytail: only a PDF layout refresh retains the current schedule; a new section resets it.
    const preservedPlan = options.preserveWordPlan && activeWordPlan
      ? { ...activeWordPlan, currentTime: getActiveWordPlanMediaTime(activeWordPlan), anchoredAtClockTime: getWordPlanClockTime() }
      : null;
    setActiveChunk({
      block: element,
      wordRanges: nextWordRanges,
      highlightRange: chunkRanges || createElementContentsRange(element),
      primaryRegionTarget,
      fallbackRegionTarget,
    });
    if (preservedPlan) {
      activeWordPlan = preservedPlan;
      showCurrentPlannedWord(wordPlanGeneration);
      scheduleActiveWordPlan();
    }
    if (chunkRanges) {
      scrollRangeIntoView(chunkRanges);
    } else {
      scrollElementIntoView(element);
    }
    if (options.reportGrounding) {
      return { ok: true, grounded: Boolean(chunkRanges), fallback: !chunkRanges };
    }
    return { ok: true };
  }

  function highlightQueuedChunkByAnchor(anchorId, fallbackText, options = {}) {
    ensureHighlightStyles();

    const element = getAnchoredElement(anchorId);
    if (element) {
      const chunkRanges = getAnchoredTextRanges(element, options.chunkText, options)
        || getAnchoredTextRanges(element, fallbackText, options);
      setQueuedRegionTarget(chunkRanges ? createRangeRegionTarget(chunkRanges) : { type: 'element', element });
      return { ok: true };
    }

    const match = getTextMatch(fallbackText, searchCursor);
    if (!match?.range) {
      removeRegionOverlay('next');
      queuedRegionTarget = null;
      return { ok: false };
    }

    setQueuedRegionTarget({ type: 'range', range: match.range });
    return { ok: true };
  }

  function flashResumeSectionByAnchor(anchorId, fallbackText, options = {}) {
    ensureHighlightStyles();
    const element = getAnchoredElement(anchorId);
    if (element) return flashResumeElement(element, options);

    const result = highlightChunk(fallbackText || options.chunkText);
    if (!result.ok || !activeBlock) return result;
    return flashResumeElement(activeBlock, options);
  }

  function flashResumeElement(element, { durationMs = 1500 } = {}) {
    if (!element) return { ok: false };
    scrollElementIntoView(element, { force: true });
    element.classList?.add('pagenarrator-resume-flash');
    const delay = Math.max(250, Math.min(5000, Math.trunc(Number(durationMs)) || 1500));
    win.setTimeout?.(() => {
      element.classList?.remove('pagenarrator-resume-flash');
    }, delay);
    return { ok: true };
  }

  function highlightWord(index, trailLength = highlighterOptions.defaultWordTrailLength, metadata = {}) {
    if (!supportsCssHighlights() || !wordRanges.length) return { ok: false };
    const numericIndex = Number(index);
    if (!Number.isFinite(numericIndex)) return { ok: false };

    clearScheduledWordPlan({ clearHighlights: false });
    const resolved = resolveWordIndex(numericIndex);
    if (!resolved.ok) return resolved.result;
    const domIndex = resolved.index;
    if (domIndex === lastWordIndex) return { ok: true };
    lastWordIndex = domIndex;
    const safeTrailLength = Math.max(1, Math.min(HIGHLIGHT_WORD_TRAIL.length, Math.trunc(Number(trailLength)) || HIGHLIGHT_WORD_TRAIL.length));
    recentWordRanges = [wordRanges[domIndex], ...recentWordRanges].slice(0, safeTrailLength);
    renderWordTrail();
    recordManualWordFlow(domIndex, metadata);
    return { ok: true };
  }

  /**
   * @param {Array<Record<string, any>>} plan
   * @param {Record<string, any>} options
   */
  function highlightWordPlan(plan, options = {}) {
    if (!supportsCssHighlights() || !wordRanges.length) return { ok: false };
    if (!Array.isArray(plan) || !plan.length) return { ok: false };

    const entries = plan
      .map(normalizeWordPlanEntry)
      .filter(Boolean)
      .filter((entry) => validateWordPlanEntry(entry));
    if (!entries.length) return { ok: false };

    const setTimer = typeof options.setTimer === 'function'
      ? options.setTimer
      : globalThis.setTimeout?.bind(globalThis) || win.setTimeout?.bind(win);
    const requestFrame = typeof options.requestFrame === 'function'
      ? options.requestFrame
      : globalThis.requestAnimationFrame?.bind(globalThis);
    const cancelFrame = typeof options.cancelFrame === 'function'
      ? options.cancelFrame
      : globalThis.cancelAnimationFrame?.bind(globalThis);
    if (typeof setTimer !== 'function' && typeof requestFrame !== 'function') return { ok: false };

    const playbackRate = Number.isFinite(Number(options.playbackRate)) && Number(options.playbackRate) > 0
      ? Number(options.playbackRate)
      : 1;
    const paused = Boolean(options.paused);
    const currentTime = getLatencyAdjustedCurrentTime({
      currentTime: options.currentTime,
      playbackRate,
      paused,
      sentAtEpochMs: options.sentAtEpochMs,
      nowEpochMs: options.nowEpochMs,
    });
    const hasLeadSeconds = Object.prototype.hasOwnProperty.call(options, 'leadSeconds');
    const leadSeconds = hasLeadSeconds && Number.isFinite(Number(options.leadSeconds)) ? Number(options.leadSeconds) : null;
    const fadeMs = Math.max(120, Math.min(250, Number.isFinite(Number(options.fadeMs)) ? Number(options.fadeMs) : 180));
    const trailLength = getSafeWordTrailLength(options.trailLength);
    activeWordPlan = {
      entries,
      currentTime,
      playbackRate,
      leadSeconds,
      fadeMs,
      trailLength,
      setTimer,
      requestFrame,
      cancelFrame,
      paused,
      anchoredAtClockTime: getWordPlanClockTime(),
    };
    if (options.recordImmediately) recordWordPlanEntries(entries);

    return scheduleActiveWordPlan({ clearHighlights: true });
  }

  /**
   * @param {Record<string, any>} options
   */
  function resyncWordPlan(options = {}) {
    if (!activeWordPlan) return { ok: false };

    const currentTime = getActiveWordPlanMediaTime(activeWordPlan);
    activeWordPlan = {
      ...activeWordPlan,
      playbackRate: Number.isFinite(Number(options.playbackRate)) && Number(options.playbackRate) > 0
        ? Number(options.playbackRate)
        : activeWordPlan.playbackRate,
      paused: Object.prototype.hasOwnProperty.call(options, 'paused')
        ? Boolean(options.paused)
        : activeWordPlan.paused,
    };
    activeWordPlan.currentTime = Object.prototype.hasOwnProperty.call(options, 'currentTime')
      ? getLatencyAdjustedCurrentTime({
        currentTime: options.currentTime,
        playbackRate: activeWordPlan.playbackRate,
        paused: activeWordPlan.paused,
        sentAtEpochMs: options.sentAtEpochMs,
        nowEpochMs: options.nowEpochMs,
      })
      : currentTime;
    activeWordPlan.anchoredAtClockTime = getWordPlanClockTime();

    return scheduleActiveWordPlan({ includePaused: true });
  }

  function scheduleActiveWordPlan({ clearHighlights = false, includePaused = false } = {}) {
    if (!activeWordPlan) return { ok: false };

    clearScheduledWordPlan({ clearHighlights, preservePlan: true });
    if (activeWordPlan.paused) {
      return includePaused
        ? { ok: true, paused: true, scheduled: 0 }
        : { ok: true, scheduled: 0 };
    }

    const {
      entries,
      currentTime,
      playbackRate,
      leadSeconds,
      fadeMs,
      trailLength,
      setTimer,
      requestFrame,
    } = activeWordPlan;
    const generation = wordPlanGeneration;
    let scheduled = 0;
    showCurrentPlannedWord(generation, currentTime);

    if (typeof requestFrame === 'function') {
      wordPlanFrame = requestFrame(() => runActiveWordPlanFrame(generation));
      scheduled = typeof setTimer === 'function'
        ? scheduleWordPlanEntryTimers({
          entries,
          currentTime,
          playbackRate,
          leadSeconds,
          fadeMs,
          trailLength,
          setTimer,
          generation,
        })
        : entries.length;
      return includePaused
        ? { ok: true, paused: false, scheduled }
        : { ok: true, scheduled };
    }

    scheduled = scheduleWordPlanEntryTimers({
      entries,
      currentTime,
      playbackRate,
      leadSeconds,
      fadeMs,
      trailLength,
      setTimer,
      generation,
    });

    return includePaused
      ? { ok: true, paused: false, scheduled }
      : { ok: true, scheduled };
  }

  function scheduleWordPlanEntryTimers({
    entries,
    currentTime,
    playbackRate,
    leadSeconds,
    fadeMs,
    trailLength,
    setTimer,
    generation,
  }) {
    let scheduled = 0;
    for (const entry of entries) {
      const endAt = getEntryEndAt(entry, leadSeconds);
      if (endAt < currentTime) {
        // Resync cancels pending fade timers; retire their expired marks too.
        removeTimedWordSlot(entry.key);
        continue;
      }
      const highlightAt = getEntryHighlightAt(entry, leadSeconds);
      scheduleWordPlanTimer(setTimer, generation, getPlanDelayMs(highlightAt, currentTime, playbackRate), () => {
        showCurrentPlannedWord(generation, highlightAt);
      });
      scheduleWordPlanTimer(setTimer, generation, getPlanDelayMs(endAt, currentTime, playbackRate), () => {
        schedulePlannedWordFade(entry, trailLength, fadeMs, generation, setTimer);
      });
      scheduled += 1;
    }
    return scheduled;
  }

  function highlightSyntheticSpeech() {
    if (!supportsCssHighlights() || !activeBlock) return { ok: false };
    clearScheduledWordPlan({ clearHighlights: false });
    getCssHighlights().set(HIGHLIGHT_WORD_TRAIL[3], new globalThis.Highlight(createElementContentsRange(activeBlock)));
    return { ok: true };
  }

  function clearHighlights() {
    clearActiveHighlights();
    searchCursor = 0;
    cachedSearchIndex = null;
  }

  function setHighlightSettings(settings) {
    highlightSettings = normalizeHighlightSettings(settings);
    applyHighlightStyleVariables();
    return highlightSettings;
  }

  function clearActiveHighlights() {
    scrollFollower.cancelPending();
    if (activeBlock) {
      clearActiveBlockState(activeBlock);
      activeBlock = null;
    }

    removeRegionOverlay('active');
    removeRegionOverlay('next');
    activeRegionTarget = null;
    queuedRegionTarget = null;

    if (supportsCssHighlights()) {
      getCssHighlights().delete(HIGHLIGHT_CHUNK);
      clearScheduledWordPlan({ clearHighlights: false });
      clearWordTrailHighlights();
    }

    wordRanges = [];
    lastWordIndex = -1;
    recentWordRanges = [];
  }

  function supportsCssHighlights() {
    return Boolean(getCssHighlights() && globalThis.Highlight);
  }

  function getCssHighlights() {
    return globalThis.CSS?.highlights || win.CSS?.highlights;
  }

  function ensureHighlightStyles() {
    if (highlightStylesEnsured) return;
    if (/jsdom/i.test(win.navigator?.userAgent || '')) {
      highlightStylesEnsured = true;
      return;
    }

    const style = documentRef.createElement('style');
    style.id = 'pagenarrator-highlight-styles';
    style.textContent = `
      .pagenarrator-current-block {
        background: var(--pn-highlight-block-background, rgba(var(--pn-highlight-area-rgb), var(--pn-highlight-area-block-opacity))) !important;
        box-shadow: 0 0 0 1px rgba(var(--pn-highlight-area-rgb), var(--pn-highlight-area-border-opacity)), 0 6px 18px rgba(var(--pn-highlight-area-rgb), var(--pn-highlight-area-shadow-opacity)) !important;
        border-radius: 6px !important;
        transition: background 140ms ease, box-shadow 140ms ease !important;
      }

      .pagenarrator-resume-flash {
        outline: 2px solid rgba(var(--pn-highlight-area-rgb), 0.92) !important;
        outline-offset: 4px !important;
        box-shadow: 0 0 0 6px rgba(var(--pn-highlight-area-rgb), 0.18) !important;
        transition: outline-color 180ms ease, box-shadow 180ms ease !important;
      }

      [${REGION_OVERLAY_ATTRIBUTE}] {
        position: fixed !important;
        z-index: 2147483646 !important;
        pointer-events: none !important;
        background: rgba(var(--pn-highlight-area-rgb), var(--pn-highlight-area-opacity)) !important;
        border: 1px solid rgba(var(--pn-highlight-area-rgb), var(--pn-highlight-area-border-opacity)) !important;
        border-radius: 6px !important;
        box-shadow: 0 6px 18px rgba(var(--pn-highlight-area-rgb), var(--pn-highlight-area-shadow-opacity)) !important;
        box-sizing: border-box !important;
      }

      [${REGION_OVERLAY_ATTRIBUTE}="next"] {
        background: rgba(var(--pn-highlight-area-rgb), var(--pn-highlight-area-next-opacity)) !important;
        border-color: rgba(var(--pn-highlight-area-rgb), var(--pn-highlight-area-next-border-opacity)) !important;
        box-shadow: 0 6px 18px rgba(var(--pn-highlight-area-rgb), var(--pn-highlight-area-next-shadow-opacity)) !important;
      }

      [${REGION_OVERLAY_ATTRIBUTE}][data-pagenarrator-paused="true"] {
        background: rgba(var(--pn-highlight-area-rgb), var(--pn-highlight-area-paused-opacity)) !important;
        border-color: rgba(var(--pn-highlight-area-rgb), var(--pn-highlight-area-paused-border-opacity)) !important;
      }

      ::highlight(${HIGHLIGHT_CHUNK}) {
        background: rgba(var(--pn-highlight-area-rgb), var(--pn-highlight-area-opacity));
      }

      ::highlight(${HIGHLIGHT_WORD_TRAIL[0]}) {
        background: rgba(var(--pn-highlight-word-rgb), var(--pn-highlight-word-opacity-0));
        color: inherit;
      }

      ::highlight(${HIGHLIGHT_WORD_TRAIL[1]}) {
        background: rgba(var(--pn-highlight-word-rgb), var(--pn-highlight-word-opacity-1));
        color: inherit;
      }

      ::highlight(${HIGHLIGHT_WORD_TRAIL[2]}) {
        background: rgba(var(--pn-highlight-word-rgb), var(--pn-highlight-word-opacity-2));
        color: inherit;
      }

      ::highlight(${HIGHLIGHT_WORD_TRAIL[3]}) {
        background: rgba(var(--pn-highlight-word-rgb), var(--pn-highlight-word-opacity-3));
        color: inherit;
      }
    `;
    documentRef.documentElement.appendChild(style);
    applyHighlightStyleVariables();
    highlightStylesEnsured = true;
  }

  function applyHighlightStyleVariables() {
    const rootStyle = documentRef.documentElement?.style;
    if (!rootStyle) return;

    const areaOpacity = highlightSettings.area.opacity;
    const wordOpacity = highlightSettings.word.opacity;
    rootStyle.setProperty('--pn-highlight-area-rgb', hexToRgbString(highlightSettings.area.color));
    rootStyle.setProperty('--pn-highlight-area-opacity', formatOpacity(areaOpacity));
    rootStyle.setProperty('--pn-highlight-area-block-opacity', formatOpacity(areaOpacity * 0.7));
    rootStyle.setProperty('--pn-highlight-area-border-opacity', formatOpacity(Math.max(0.18, Math.min(1, areaOpacity + 0.28))));
    rootStyle.setProperty('--pn-highlight-area-shadow-opacity', formatOpacity(Math.min(0.18, areaOpacity * 0.55)));
    rootStyle.setProperty('--pn-highlight-area-next-opacity', formatOpacity(areaOpacity * 0.45));
    rootStyle.setProperty('--pn-highlight-area-next-border-opacity', formatOpacity(Math.max(0.12, Math.min(1, areaOpacity * 0.75))));
    rootStyle.setProperty('--pn-highlight-area-next-shadow-opacity', formatOpacity(Math.min(0.12, areaOpacity * 0.35)));
    rootStyle.setProperty('--pn-highlight-area-paused-opacity', formatOpacity(areaOpacity * 0.6));
    rootStyle.setProperty('--pn-highlight-area-paused-border-opacity', formatOpacity(Math.max(0.12, Math.min(1, areaOpacity * 0.85))));
    rootStyle.setProperty('--pn-highlight-word-rgb', hexToRgbString(highlightSettings.word.color));
    rootStyle.setProperty('--pn-highlight-word-opacity-0', formatOpacity(wordOpacity));
    rootStyle.setProperty('--pn-highlight-word-opacity-1', formatOpacity(wordOpacity * 0.63));
    rootStyle.setProperty('--pn-highlight-word-opacity-2', formatOpacity(wordOpacity * 0.39));
    rootStyle.setProperty('--pn-highlight-word-opacity-3', formatOpacity(wordOpacity * 0.21));
  }

  function buildSearchIndex() {
    invalidateSearchIndex(searchIndexMutationObserver?.takeRecords() || []);
    // A highlight message can arrive before the queued resize event.
    if (searchIndexWidth !== win.innerWidth || searchIndexHeight !== win.innerHeight) {
      cachedSearchIndex = null;
      searchCursor = 0;
      searchIndexWidth = win.innerWidth;
      searchIndexHeight = win.innerHeight;
    }
    if (cachedSearchIndex) return cachedSearchIndex;
    ensureSearchIndexInvalidation();
    ensurePinning();
    const walker = documentRef.createTreeWalker(documentRef.body, win.NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return win.NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return win.NodeFilter.FILTER_REJECT;
        if (hasExcludedAncestor(parent)) {
          return win.NodeFilter.FILTER_REJECT;
        }
        if (!isVisible(parent)) return win.NodeFilter.FILTER_REJECT;
        return win.NodeFilter.FILTER_ACCEPT;
      },
    });

    let fullText = '';
    const map = [];
    let tooLarge = false;
    let previousNode = null;

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (fullText && !fullText.endsWith(' ') && needsTextNodeSeparator(previousNode, node)) {
        fullText += ' ';
        map.push({ node: previousNode, offset: previousNode.nodeValue.length });
        if (fullText.length >= MAX_FALLBACK_SEARCH_TEXT_LENGTH) {
          tooLarge = true;
          break;
        }
      }
      const completed = appendNormalizedNode(node, (char, point) => {
        if (char === ' ' && fullText.endsWith(' ')) return true;
        if (fullText.length >= MAX_FALLBACK_SEARCH_TEXT_LENGTH) {
          tooLarge = true;
          return false;
        }
        fullText += char;
        map.push(point);
        if (fullText.length >= MAX_FALLBACK_SEARCH_TEXT_LENGTH) {
          tooLarge = true;
          return false;
        }
        return true;
      });
      if (!completed || tooLarge) break;
      previousNode = node;
    }

    cachedSearchIndex = tooLarge
      ? { fullText: '', map: [], tooLarge: true }
      : highlighterOptions.pdfMode ? normalizeSoftHyphenBreaksInIndex({ fullText, map, tooLarge: false })
        : { fullText, map, tooLarge: false };
    return cachedSearchIndex;
  }

  function ensureSearchIndexInvalidation() {
    if (searchIndexMutationObserver || typeof win.MutationObserver !== 'function' || !documentRef.body) return;
    searchIndexMutationObserver = new win.MutationObserver(invalidateSearchIndex);
    searchIndexMutationObserver.observe(documentRef.body, {
      childList: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'role', 'id'],
      subtree: true,
    });
  }

  function invalidateSearchIndex(mutations) {
    // Highlight classes do not change which source text is searchable.
    const sourceClasses = (value) => String(value || '').split(/\s+/u)
      .filter((name) => name && name !== 'pagenarrator-current-block' && name !== 'pagenarrator-resume-flash').join(' ');
    if (!mutations.some((mutation) => mutation.attributeName !== 'class'
      || sourceClasses(mutation.oldValue) !== sourceClasses(mutation.target.getAttribute('class')))) return;
    cachedSearchIndex = null;
    searchCursor = 0;
  }

  function hasExcludedAncestor(element) {
    for (let node = element; node && node !== documentRef.body; node = node.parentElement) {
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|INPUT|SELECT|OPTION)$/.test(node.tagName || '')) return true;
      if (node.matches?.(noiseSelector)) return true;
      if (isReferenceTextElement(node)) return true;
      if (Number.parseFloat(node.style?.opacity || '') === 0) return true;
    }
    return false;
  }

  function getAnchoredElement(anchorId) {
    if (!anchorId) return null;
    return documentRef.querySelector(`[data-pagenarrator-id="${cssEscape(anchorId)}"]`);
  }

  function findNearestByTag(element, tagNames) {
    for (let node = element; node && node !== documentRef.body; node = node.parentElement) {
      if (tagNames.has(node.tagName || '')) return node;
    }
    return null;
  }

  function getTextBlockForRange(range) {
    const element = range.commonAncestorContainer.nodeType === win.Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    let block = findNearestByTag(element, new Set([
      'P',
      'LI',
      'BLOCKQUOTE',
      'FIGCAPTION',
      'DD',
      'DT',
      'H1',
      'H2',
      'H3',
      'H4',
      'H5',
      'H6',
    ]));

    if (!block) {
      const fallback = findNearestByTag(element, new Set(['DIV', 'SECTION', 'ARTICLE']));
      const fallbackText = normalizeForSearch(fallback?.innerText || fallback?.textContent || '');
      if (fallbackText && fallbackText.length <= 900) {
        block = fallback;
      }
    }

    if (!block || block === documentRef.body || block === documentRef.documentElement) return null;

    if (!isVisible(block)) return null;

    const blockText = normalizeForSearch(block.innerText || block.textContent || '');
    if (!blockText || blockText.length > 1800) return null;

    return block;
  }

  function expandRangeToTextBlock(range) {
    const block = getTextBlockForRange(range);
    if (!block) return range;

    const expanded = documentRef.createRange();
    expanded.selectNodeContents(block);
    return expanded;
  }

  function createRangeFromNormalizedSpan(map, start, end) {
    if (!map[start] || !map[end - 1]) return null;

    const startPoint = map[start];
    const endPoint = map[end - 1];
    const range = documentRef.createRange();
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, Math.min(endPoint.node.nodeValue.length, endPoint.offset + 1));
    return range;
  }

  function createRangesFromNormalizedSpan(map, start, end, { splitAtNodeBoundaries = false } = {}) {
    if (!splitAtNodeBoundaries) {
      const range = createRangeFromNormalizedSpan(map, start, end);
      return range ? [range] : [];
    }

    const ranges = [];
    let segmentStart = start;

    for (let position = start + 1; position < end; position += 1) {
      if (map[position - 1]?.node === map[position]?.node) continue;

      const range = createRangeFromNormalizedSpan(map, segmentStart, position);
      if (range) ranges.push(range);
      segmentStart = position;
    }

    const range = createRangeFromNormalizedSpan(map, segmentStart, end);
    if (range) ranges.push(range);
    return ranges;
  }

  function createWordRanges(map, start, end, options = {}) {
    const spanText = map
      .slice(start, end)
      .map((point) => point?.node?.nodeValue?.[point.offset] || ' ')
      .join('');

    return tokenizeSpokenWords(spanText).flatMap((token) => {
      const ranges = createRangesFromNormalizedSpan(map, start + token.start, start + token.end, options);
      if (!ranges.length) return [];
      return /** @type {any[]} */ (ranges.length === 1 ? ranges : [ranges]);
    });
  }

  function createWordRangesFromElement(element) {
    return createWordRangesFromSearchIndex(buildElementSearchIndex(element), {
      splitAtNodeBoundaries: hasPdfTextOrdering(element),
    });
  }

  function createAnchoredWordRanges(element, pdfNarration) {
    const pdfExtractionText = (highlighterOptions.pdfMode ? applyPdfNarration(element, pdfNarration) : null)
      ?? getPdfExtractionText(element);
    return pdfExtractionText
      ? createPdfWordRangesFromExtractionText(element, pdfExtractionText)
      : createWordRangesFromElement(element);
  }

  function createWordRangesFromSearchIndex(index, options = {}) {
    return createWordRanges(index.map, 0, index.map.length, options);
  }

  function createPdfWordRangesFromExtractionText(element, extractionText) {
    const domEntries = createWordRangeEntriesFromElement(element);
    const extractionTokens = tokenizeSpokenWords(extractionText);
    const ranges = [];
    let domIndex = 0;

    for (const token of extractionTokens) {
      const target = normalizeWordToken(token.text);
      const match = findPdfDomTokenMatch(domEntries, domIndex, target);
      if (match) {
        ranges.push(match.range);
        domIndex = match.nextIndex;
        continue;
      }

      ranges.push(null);
    }

    return ranges.some(Boolean) ? ranges : domEntries.map((entry) => entry.range);
  }

  function findPdfDomTokenMatch(domEntries, startIndex, target) {
    if (!target) return null;

    for (let lookahead = 0; lookahead <= PDF_WORD_MATCH_LOOKAHEAD; lookahead += 1) {
      const index = startIndex + lookahead;
      const current = domEntries[index];
      if (!current) return null;

      if (normalizeWordToken(current.text) === target) {
        return {
          range: current.range,
          nextIndex: index + 1,
        };
      }

      const mergedFragmentMatch = findMergedPdfFragmentMatch(domEntries, index, target, normalizeWordToken, mergeRanges);
      if (mergedFragmentMatch) return mergedFragmentMatch;

      const next = domEntries[index + 1];
      const mergedSoftHyphenText = current.text.endsWith('-') && next
        ? `${current.text.slice(0, -1)}${next.text}`
        : '';
      if (mergedSoftHyphenText && normalizeWordToken(mergedSoftHyphenText) === target) {
        return {
          range: mergeRanges([current.range, next.range]),
          nextIndex: index + 2,
        };
      }
    }

    return null;
  }

  function createWordRangeEntriesFromElement(element, includeOmitted = false) {
    const entries = [];
    for (const node of getOrderedTextNodes(element, { sourceOrder: includeOmitted })) {
      if (!includeOmitted && node.parentElement?.closest?.(`[${PDF_TEXT_LAYER_NARRATED_ATTRIBUTE}="false"]`)) continue;
      const text = node.nodeValue || '';
      // Speech filtering needs whole-page context; isolated DOM spans are only match candidates.
      for (const token of tokenizeSpokenWords(text, { includeNonSpoken: true })) {
        const range = documentRef.createRange();
        range.setStart(node, token.start);
        range.setEnd(node, token.end);
        entries.push({ text: token.text, range });
      }
    }

    return entries;
  }

  function getPdfExtractionText(element) {
    if (element.getAttribute?.(PDF_TEXT_LAYER_TEXT_ATTRIBUTE)) {
      return element.getAttribute(PDF_TEXT_LAYER_TEXT_ATTRIBUTE);
    }

    return element.querySelector?.(`[${PDF_TEXT_LAYER_TEXT_ATTRIBUTE}]`)?.getAttribute(PDF_TEXT_LAYER_TEXT_ATTRIBUTE) || '';
  }

  function normalizeWordToken(value) {
    const normalized = normalizeLigatures(String(value || ''))
      .toLowerCase()
      .replace(/[â€œâ€]/g, '"')
      .replace(/[â€˜â€™]/g, "'")
      .replace(/[â€“â€”]/g, '-');
    return normalized.replace(/-/gu, '');
  }

  function normalizeLigatures(value) {
    return String(value || '')
      .replace(/\uFB00/g, 'ff')
      .replace(/\uFB01/g, 'fi')
      .replace(/\uFB02/g, 'fl')
      .replace(/\uFB03/g, 'ffi')
      .replace(/\uFB04/g, 'ffl')
      .replace(/\u00EF\u00AC(?:\u0080|\u20AC)/g, 'ff')
      .replace(/\u00EF\u00AC\u0081/g, 'fi')
      .replace(/\u00EF\u00AC(?:\u0082|\u201A)/g, 'fl')
      .replace(/\u00EF\u00AC(?:\u0083|\u0192)/g, 'ffi')
      .replace(/\u00EF\u00AC(?:\u0084|\u201E)/g, 'ffl');
  }

  function getAnchoredTextRanges(element, text, options = {}) {
    if (!text) return null;
    const index = buildElementSearchIndex(element, { sourceOrder: options.pdfSelection === true });
    const target = normalizeForSearch(text, { normalizeSoftHyphenBreaks: highlighterOptions.pdfMode || hasPdfTextOrdering(element) });
    const startAt = getSearchStartForWordOffset(index.fullText, options.domWordOffset);
    const match = findBestMatch(index.fullText, target, startAt)
      || (startAt > 0 ? findBestMatch(index.fullText, target, 0) : null);
    if (!match) return null;
    const ranges = createRangesFromNormalizedSpan(index.map, match.start, match.end, {
      splitAtNodeBoundaries: hasPdfTextOrdering(element),
    });
    return ranges.length ? ranges : null;
  }

  function getSearchStartForWordOffset(text, wordOffset) {
    const offset = Number(wordOffset);
    if (!Number.isFinite(offset) || offset <= 0) return 0;
    const token = tokenizeSpokenWords(text)[Math.trunc(offset)];
    return token?.start || 0;
  }

  function buildElementSearchIndex(element, { normalizeSoftHyphenBreaks = highlighterOptions.pdfMode || hasPdfTextOrdering(element), sourceOrder = false } = {}) {
    let fullText = '';
    const map = [];
    let previousNode = null;
    const pdfOrder = hasPdfTextOrdering(element);

    for (const node of getOrderedTextNodes(element, { sourceOrder })) {
      if (fullText && !fullText.endsWith(' ') && (pdfOrder || needsTextNodeSeparator(previousNode, node))) {
        fullText += ' ';
        map.push({ node: previousNode, offset: previousNode.nodeValue.length });
      }
      appendNormalizedNode(node, (char, point) => {
        if (char === ' ' && fullText.endsWith(' ')) return;
        fullText += char;
        map.push(point);
      });

      previousNode = node;
    }

    const index = { fullText, map };
    return normalizeSoftHyphenBreaks ? normalizeSoftHyphenBreaksInIndex(index) : index;
  }

  function normalizeSoftHyphenBreaksInIndex(index) {
    let fullText = '';
    const map = [];

    for (let indexPosition = 0; indexPosition < index.fullText.length; indexPosition += 1) {
      const char = index.fullText[indexPosition];
      if (char === '-') {
        let next = indexPosition + 1;
        while (next < index.fullText.length && /\s/.test(index.fullText[next])) {
          next += 1;
        }

        if (next > indexPosition + 1 && /\p{Ll}/u.test(index.fullText[next] || '')) {
          indexPosition = next - 1;
          continue;
        }
      }

      fullText += char;
      map.push(index.map[indexPosition]);
    }

    return { ...index, fullText, map };
  }

  function getOrderedTextNodes(element, { sourceOrder = false } = {}) {
    const nodes = [];
    const walker = documentRef.createTreeWalker(element, win.NodeFilter.SHOW_TEXT | win.NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node.nodeType === win.Node.ELEMENT_NODE) {
          const style = win.getComputedStyle(node);
          return hasExcludedAncestor(node) || style.display === 'none' || style.visibility === 'hidden'
            ? win.NodeFilter.FILTER_REJECT : win.NodeFilter.FILTER_SKIP;
        }
        if (!node.nodeValue) return win.NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || hasExcludedAncestor(parent)) {
          return win.NodeFilter.FILTER_REJECT;
        }
        return win.NodeFilter.FILTER_ACCEPT;
      },
    });

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push(node);
    }

    if (!element.querySelector?.(`[${PDF_TEXT_LAYER_ORDER_ATTRIBUTE}]`)) return nodes;

    return nodes
      .map((node, domIndex) => ({
        node,
        domIndex,
        order: getPdfTextNodeOrder(node, sourceOrder),
      }))
      .sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return a.domIndex - b.domIndex;
      })
      .map((entry) => entry.node);
  }

  function hasPdfTextOrdering(element) {
    return Boolean(element?.querySelector?.(`[${PDF_TEXT_LAYER_ORDER_ATTRIBUTE}]`));
  }

  function mergeRanges(ranges) {
    const flattened = flattenRanges(ranges);
    const merged = documentRef.createRange();
    merged.setStart(flattened[0].startContainer, flattened[0].startOffset);
    const lastRange = flattened.at(-1);
    merged.setEnd(lastRange.endContainer, lastRange.endOffset);
    if (flattened.some(range => !merged.isPointInRange(range.startContainer, range.startOffset)
      || !merged.isPointInRange(range.endContainer, range.endOffset))) return flattened;
    const ancestor = merged.commonAncestorContainer;
    const omitted = ancestor.querySelectorAll?.(`[${PDF_TEXT_LAYER_NARRATED_ATTRIBUTE}="false"]`) || [];
    if ([...omitted].some((node) => merged.intersectsNode(node))) return flattened;
    const compact = text => text.replace(/[\s-]/gu, '');
    if (compact(merged.toString()) !== compact(flattened.map(range => range.toString()).join(''))) return flattened;
    return merged;
  }

  function flattenRanges(ranges) {
    return ranges.flatMap((range) => (Array.isArray(range) ? flattenRanges(range) : [range])).filter(Boolean);
  }

  function createRangeRegionTarget(rangeOrRanges) {
    const ranges = flattenRanges(Array.isArray(rangeOrRanges) ? rangeOrRanges : [rangeOrRanges]);
    if (!ranges.length) return null;
    return ranges.length === 1
      ? { type: 'range', range: ranges[0] }
      : { type: 'ranges', ranges };
  }

  function createElementContentsRange(element) {
    const range = documentRef.createRange();
    range.selectNodeContents(element);
    return range;
  }

  function getTextMatch(text, startAt) {
    if (!text) return null;
    const index = buildSearchIndex();
    if (index.tooLarge) return null;
    const target = normalizeForSearch(text, { normalizeSoftHyphenBreaks: highlighterOptions.pdfMode });
    const match = findBestMatch(index.fullText, target, startAt);
    if (!match) return null;

    return {
      ...match,
      wordRanges: createWordRanges(index.map, match.start, match.end),
      range: createRangeFromNormalizedSpan(index.map, match.start, match.end),
    };
  }

  function setActiveChunk({ block, wordRanges: nextWordRanges, highlightRange, primaryRegionTarget, fallbackRegionTarget = null }) {
    if (activeBlock && activeBlock !== block) {
      clearActiveBlockState(activeBlock);
    }

    clearScheduledWordPlan({ clearHighlights: true });
    clearWordTrailHighlights();
    wordRanges = nextWordRanges;
    lastWordIndex = -1;
    recentWordRanges = [];
    activeBlock = block;
    if (activeBlock) applyActiveBlockState(activeBlock);

    let hasCssChunkHighlight = false;
    if (supportsCssHighlights()) {
      getCssHighlights().delete(HIGHLIGHT_CHUNK);
      const highlightRanges = flattenRanges(Array.isArray(highlightRange) ? highlightRange : [highlightRange]);
      hasCssChunkHighlight = highlightRanges.length > 0;
      if (hasCssChunkHighlight) getCssHighlights().set(HIGHLIGHT_CHUNK, new globalThis.Highlight(...highlightRanges));
    }

    if (highlighterOptions.preferCssOnlyRegion && hasCssChunkHighlight) {
      removeRegionOverlay('active');
      activeRegionTarget = null;
      return;
    }

    activeRegionTarget = primaryRegionTarget;
    if (!positionRegionTarget('active', activeRegionTarget) && fallbackRegionTarget) {
      activeRegionTarget = fallbackRegionTarget;
      positionRegionTarget('active', activeRegionTarget);
    }
  }

  function applyActiveBlockState(block) {
    clearDarkCodeBlockState(block);
    const darkCodeBackground = getDarkCodeBlockBackground(block);
    if (darkCodeBackground) {
      block.setAttribute(DARK_CODE_BLOCK_ATTRIBUTE, 'true');
      block.style.setProperty('--pn-highlight-block-background', darkCodeBackground);
    }
    block.classList.add('pagenarrator-current-block');
  }

  function clearActiveBlockState(block) {
    block.classList.remove('pagenarrator-current-block');
    clearDarkCodeBlockState(block);
  }

  function clearDarkCodeBlockState(block) {
    block.removeAttribute(DARK_CODE_BLOCK_ATTRIBUTE);
    block.style.removeProperty('--pn-highlight-block-background');
  }

  function getDarkCodeBlockBackground(element) {
    if (!isCodeLikeBlock(element)) return '';

    const background = findPaintedBackground(element);
    if (!background || !isDarkColor(background.color)) return '';

    return background.css;
  }

  function isCodeLikeBlock(element) {
    return Boolean(
      element?.matches?.('pre, code')
      || element?.closest?.('pre, code')
      || element?.querySelector?.('pre, code'),
    );
  }

  function findPaintedBackground(element) {
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const backgroundColor = win.getComputedStyle?.(node)?.backgroundColor;
      const color = parseCssColor(backgroundColor);
      if (color && color.alpha > 0.02) {
        return { css: backgroundColor, color };
      }
    }

    return null;
  }

  function setQueuedRegionTarget(target) {
    if (!highlighterOptions.showQueuedRegion) {
      removeRegionOverlay('next');
      queuedRegionTarget = null;
      return;
    }

    queuedRegionTarget = target;
    if (!positionRegionTarget('next', queuedRegionTarget)) {
      removeRegionOverlay('next');
      queuedRegionTarget = null;
    }
  }

  function renderWordTrail() {
    const highlights = getCssHighlights();
    if (highlights) {
      if (recentWordRanges.length > 0) highlights.delete(HIGHLIGHT_WORD_TRAIL[3]);

      for (let index = 0; index < HIGHLIGHT_WORD_TRAIL.length; index += 1) {
        const name = HIGHLIGHT_WORD_TRAIL[index];
        const range = recentWordRanges[index];
        if (range) {
          highlights.set(name, new globalThis.Highlight(...flattenRanges(Array.isArray(range) ? range : [range])));
        } else {
          highlights.delete(name);
        }
      }
    }
    pdfWordOverlays.render(recentWordRanges);
    if (recentWordRanges[0]) scrollRangeIntoView(recentWordRanges[0]);
  }

  function renderTimedWordTrail() {
    const highlights = getCssHighlights();
    if (highlights) {
      for (let index = 0; index < HIGHLIGHT_WORD_TRAIL.length; index += 1) {
        const name = HIGHLIGHT_WORD_TRAIL[index];
        const slot = timedWordRanges[index];
        if (slot?.ranges?.length) {
          highlights.set(name, new globalThis.Highlight(...flattenRanges(slot.ranges)));
        } else {
          highlights.delete(name);
        }
      }
    }
    pdfWordOverlays.render(timedWordRanges.map((slot) => slot?.ranges).filter(Boolean));
    if (timedWordRanges[0]?.ranges?.length) scrollRangeIntoView(timedWordRanges[0].ranges);
  }

  function validateWordPlanEntry(entry) {
    if (!entry || entry.synthetic) return true;
    const resolved = resolveWordIndex(entry.index, { strict: shouldUseStrictWordPlan() });
    return resolved.ok;
  }

  function getEntryEndAt(entry, leadSeconds = 0) {
    if (leadSeconds === null && entry?.endAt != null && Number.isFinite(Number(entry.endAt))) return Number(entry.endAt);
    return Math.max(0, entry.end - (Number.isFinite(Number(leadSeconds)) ? Number(leadSeconds) : 0));
  }

  function getSafeWordTrailLength(trailLength = highlighterOptions.defaultWordTrailLength) {
    return Math.max(1, Math.min(HIGHLIGHT_WORD_TRAIL.length, Math.trunc(Number(trailLength)) || HIGHLIGHT_WORD_TRAIL.length));
  }

  function getPlanDelayMs(targetTime, currentTime, playbackRate) {
    return Math.max(0, Math.round(((targetTime - currentTime) / playbackRate) * 1000));
  }

  function resolveWordIndex(index, { strict = false } = {}) {
    const numericIndex = Number(index);
    const domIndex = Number.isFinite(numericIndex) ? Math.trunc(numericIndex) : Number.NaN;
    if (Number.isInteger(domIndex) && domIndex >= 0 && domIndex < wordRanges.length) {
      return { ok: true, index: domIndex };
    }

    const result = {
      ok: false,
      reason: 'word-index-out-of-range',
      index: Number.isFinite(domIndex) ? domIndex : index,
      wordCount: wordRanges.length,
    };
    const message = `Word highlight index ${result.index} is outside ${result.wordCount} DOM word ranges.`;
    pageHighlighterLogger.warn(message);
    if (strict) throw new Error(message);
    return { ok: false, result };
  }

  function shouldUseStrictWordPlan() {
    return typeof highlighterOptions.strictWordPlan === 'function'
      ? Boolean(highlighterOptions.strictWordPlan())
      : Boolean(highlighterOptions.strictWordPlan);
  }

  function getWordPlanClockTime() {
    const currentTime = typeof wordPlanClock?.currentTime === 'function'
      ? wordPlanClock.currentTime()
      : wordPlanClock?.currentTime;
    const number = Number(currentTime);
    if (Number.isFinite(number)) return number;
    const performanceNow = win.performance?.now?.();
    return Number.isFinite(performanceNow) ? performanceNow / 1000 : Date.now() / 1000;
  }

  function recordWordFlow(entry, range) {
    if (!flowRecorder || typeof flowRecorder.record !== 'function') return;
    const key = getWordFlowKey(entry);
    if (recordedWordFlowKeys.has(key)) return;
    recordedWordFlowKeys.add(key);
    const ranges = Array.isArray(range) ? range : [range];
    flowRecorder.record({
      kind: 'word',
      chunkIndex: entry.chunkIndex,
      wordIndex: entry.speechIndex ?? entry.index,
      mediaTime: entry.start,
      speechText: entry.text ?? null,
      domToken: ranges.map((candidate) => candidate?.toString?.() || '').join(''),
    });
  }

  function recordWordPlanEntries(entries) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry?.synthetic) continue;
      const resolved = resolveWordIndex(entry.index, { strict: false });
      const range = resolved.ok ? wordRanges[resolved.index] : null;
      if (range) recordWordFlow(entry, range);
    }
  }

  function getWordFlowKey(entry = {}) {
    return [
      entry.chunkIndex ?? '',
      entry.speechIndex ?? entry.index ?? '',
      entry.text ?? '',
      entry.start ?? '',
      entry.end ?? '',
    ].join(':');
  }

  function recordManualWordFlow(domIndex, metadata = {}) {
    if (!flowRecorder || typeof flowRecorder.record !== 'function') return;
    const range = wordRanges[domIndex];
    const ranges = Array.isArray(range) ? range : [range];
    flowRecorder.record({
      kind: 'word',
      chunkIndex: metadata.chunkIndex,
      wordIndex: metadata.wordIndex,
      mediaTime: metadata.mediaTime,
      speechText: metadata.speechText,
      domToken: ranges.map((candidate) => candidate?.toString?.() || '').join(''),
    });
  }

  /**
   * @param {Record<string, any>} options
   */
  function getLatencyAdjustedCurrentTime({
    currentTime,
    playbackRate,
    paused = false,
    sentAtEpochMs,
    nowEpochMs,
  } = {}) {
    const baseTime = Number.isFinite(Number(currentTime)) && Number(currentTime) > 0
      ? Number(currentTime)
      : 0;
    if (paused) return baseTime;

    const sentAt = Number(sentAtEpochMs);
    if (!Number.isFinite(sentAt)) return baseTime;

    const receivedAt = Number.isFinite(Number(nowEpochMs))
      ? Number(nowEpochMs)
      : Date.now();
    if (!Number.isFinite(receivedAt)) return baseTime;

    const rate = Number.isFinite(Number(playbackRate)) && Number(playbackRate) > 0
      ? Number(playbackRate)
      : 1;
    return baseTime + (Math.max(0, receivedAt - sentAt) / 1000) * rate;
  }

  function scheduleWordPlanTimer(setTimer, generation, delayMs, callback) {
    const timerId = setTimer(() => {
      wordPlanTimers.delete(timerId);
      if (generation !== wordPlanGeneration) return;
      callback();
    }, delayMs);
    wordPlanTimers.add(timerId);
  }

  function showPlannedWord(entry, trailLength, generation) {
    if (generation !== wordPlanGeneration) return;
    // ponytail: keep the frame clock, but paint each active word only once.
    if (timedWordRanges[0]?.key === entry.key) return;
    const slot = getWordPlanSlot(entry);
    if (!slot) return;

    lastWordIndex = entry.synthetic ? lastWordIndex : entry.index;
    timedWordRanges = timedWordRanges.filter((candidate) => candidate?.key !== slot.key);
    timedWordRanges.unshift(slot);
    timedWordRanges = timedWordRanges.slice(0, trailLength);
    recentWordRanges = timedWordRanges.map((candidate) => candidate?.ranges).filter(Boolean);
    renderTimedWordTrail();
  }

  function showCurrentPlannedWord(generation, minimumMediaTime = null) {
    if (generation !== wordPlanGeneration || !activeWordPlan) return;
    const clockTime = getActiveWordPlanMediaTime(activeWordPlan);
    const fallbackTime = Number(minimumMediaTime);
    const mediaTime = Number.isFinite(fallbackTime) ? Math.max(clockTime, fallbackTime) : clockTime;
    const entry = getCurrentWordPlanEntry(activeWordPlan, mediaTime);
    if (!entry) return;
    showPlannedWord(entry, activeWordPlan.trailLength, generation);
  }

  function getCurrentWordPlanEntry(plan, currentTime) {
    const index = getCurrentWordPlanEntryIndex(plan, currentTime);
    const entry = plan.entries[index];
    return entry && currentTime <= getEntryEndAt(entry, plan.leadSeconds) ? entry : null;
  }

  function getCurrentWordPlanEntryIndex(plan, currentTime) {
    let left = 0;
    let right = plan.entries.length - 1;
    let currentIndex = -1;
    while (left <= right) {
      const index = Math.floor((left + right) / 2);
      const entry = plan.entries[index];
      const highlightAt = getEntryHighlightAt(entry, plan.leadSeconds);
      if (highlightAt <= currentTime) {
        currentIndex = index;
        left = index + 1;
      } else {
        right = index - 1;
      }
    }
    return currentIndex;
  }

  function runActiveWordPlanFrame(generation) {
    if (generation !== wordPlanGeneration || !activeWordPlan) return;
    wordPlanFrame = null;
    if (activeWordPlan.paused) return;

    const mediaTime = getActiveWordPlanMediaTime(activeWordPlan);
    const entry = getCurrentWordPlanEntry(activeWordPlan, mediaTime);
    if (entry) showPlannedWord(entry, activeWordPlan.trailLength, generation);

    if (isWordPlanLoopComplete(activeWordPlan, mediaTime)) return;
    wordPlanFrame = activeWordPlan.requestFrame(() => runActiveWordPlanFrame(generation));
  }

  function isWordPlanLoopComplete(plan, mediaTime) {
    const lastEntry = plan.entries.at(-1);
    if (!lastEntry) return true;
    const fadeSeconds = Math.max(0, Number(plan.fadeMs) || 0) / 1000;
    return mediaTime > getEntryEndAt(lastEntry, plan.leadSeconds) + fadeSeconds;
  }

  function getActiveWordPlanMediaTime(plan) {
    if (!plan || plan.paused) return plan?.currentTime || 0;
    const anchoredAt = Number(plan.anchoredAtClockTime);
    if (!Number.isFinite(anchoredAt)) return plan.currentTime;
    const elapsedSeconds = Math.max(0, getWordPlanClockTime() - anchoredAt);
    return plan.currentTime + (elapsedSeconds * plan.playbackRate);
  }

  function getWordPlanSlot(entry) {
    if (entry.synthetic) {
      if (!activeBlock) return null;
      return {
        key: entry.key,
        ranges: [createElementContentsRange(activeBlock)],
      };
    }

    const resolved = resolveWordIndex(entry.index, { strict: shouldUseStrictWordPlan() });
    if (!resolved.ok) return null;
    const range = wordRanges[resolved.index];
    if (!range) return null;
    recordWordFlow(entry, range);
    return {
      key: entry.key,
      ranges: Array.isArray(range) ? range : [range],
    };
  }

  function getEntryHighlightAt(entry, leadSeconds = 0) {
    if (leadSeconds === null && entry.highlightAt != null && Number.isFinite(Number(entry.highlightAt))) return Number(entry.highlightAt);
    return Math.max(0, entry.start - (Number.isFinite(Number(leadSeconds)) ? Number(leadSeconds) : 0));
  }

  function schedulePlannedWordFade(entry, trailLength, fadeMs, generation, setTimer) {
    if (generation !== wordPlanGeneration) return;
    const stepMs = fadeMs / trailLength;
    for (let slotIndex = 1; slotIndex < trailLength; slotIndex += 1) {
      scheduleWordPlanTimer(setTimer, generation, Math.round(stepMs * slotIndex), () => {
        moveTimedWordSlot(entry.key, slotIndex, trailLength);
      });
    }
    scheduleWordPlanTimer(setTimer, generation, fadeMs, () => {
      removeTimedWordSlot(entry.key);
    });
  }

  function moveTimedWordSlot(key, slotIndex, trailLength) {
    const existing = timedWordRanges.find((slot) => slot?.key === key);
    if (!existing) return;
    timedWordRanges = timedWordRanges.filter((slot) => slot?.key !== key);
    if (slotIndex < trailLength) timedWordRanges[slotIndex] = existing;
    timedWordRanges = timedWordRanges.slice(0, trailLength);
    recentWordRanges = timedWordRanges.map((slot) => slot?.ranges).filter(Boolean);
    renderTimedWordTrail();
  }

  function removeTimedWordSlot(key) {
    timedWordRanges = timedWordRanges.filter((slot) => slot?.key !== key);
    recentWordRanges = timedWordRanges.map((slot) => slot?.ranges).filter(Boolean);
    renderTimedWordTrail();
  }

  function clearScheduledWordPlan({ clearHighlights = false, preservePlan = false } = {}) {
    const clearTimer = globalThis.clearTimeout?.bind(globalThis) || win.clearTimeout?.bind(win);
    for (const timerId of wordPlanTimers) {
      if (typeof clearTimer === 'function') clearTimer(timerId);
    }
    wordPlanTimers.clear();
    if (wordPlanFrame !== null) {
      const cancelFrame = activeWordPlan?.cancelFrame || globalThis.cancelAnimationFrame?.bind(globalThis);
      cancelFrame?.(wordPlanFrame);
      wordPlanFrame = null;
    }
    wordPlanGeneration += 1;
    timedWordRanges = [];
    if (!preservePlan) activeWordPlan = null;
    if (clearHighlights) clearWordTrailHighlights();
  }

  function clearWordTrailHighlights() {
    const highlights = getCssHighlights();
    if (highlights) {
      highlights.delete(HIGHLIGHT_WORD);
      for (const name of HIGHLIGHT_WORD_TRAIL) highlights.delete(name);
    }
    pdfWordOverlays.clear();
  }

  function isVisible(element) {
    const style = win.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number.parseFloat(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function positionRegionTarget(kind, target) {
    if (!target) return false;
    if (target.type === 'element') return showRegionOverlays([target.element.getBoundingClientRect()], kind);
    if (target.type === 'range') return showRegionOverlays(getRangeRects(target.range), kind);
    if (target.type === 'ranges') return showRegionOverlays(target.ranges.flatMap((range) => getRangeRects(range)), kind);
    return false;
  }

  function showRegionOverlays(rects, kind = 'active') {
    const visibleRects = rects.filter((rect) => rect && rect.width > 0 && rect.height > 0);
    if (!visibleRects.length) return false;

    const overlays = getRegionOverlays(kind, visibleRects.length);
    visibleRects.forEach((rect, index) => {
      const overlay = overlays[index];
      const padding = getRegionPadding(rect);
      overlay.style.display = 'block';
      overlay.style.left = `${Math.round(rect.left - padding)}px`;
      overlay.style.top = `${Math.round(rect.top - padding)}px`;
      overlay.style.width = `${Math.round(rect.width + padding * 2)}px`;
      overlay.style.height = `${Math.round(rect.height + padding * 2)}px`;
    });
    ensurePinning();
    return true;
  }

  function getRegionOverlays(kind = 'active', count = 1) {
    const overlays = kind === 'next' ? queuedRegionOverlays : regionOverlays;
    for (let index = overlays.length - 1; index >= 0; index -= 1) {
      if (!overlays[index].isConnected) overlays.splice(index, 1);
    }

    while (overlays.length < count) {
      const overlay = documentRef.createElement('div');
      overlay.setAttribute(REGION_OVERLAY_ATTRIBUTE, kind);
      overlay.setAttribute('aria-hidden', 'true');
      overlay.dataset.pagenarratorRegionIndex = String(overlays.length);
      documentRef.documentElement.appendChild(overlay);
      overlays.push(overlay);
    }

    for (let index = overlays.length - 1; index >= count; index -= 1) {
      overlays[index].remove();
      overlays.pop();
    }

    return overlays;
  }

  function removeRegionOverlay(kind = 'active') {
    if (kind === 'next') {
      for (const overlay of queuedRegionOverlays) overlay.remove();
      queuedRegionOverlays = [];
      return;
    }

    for (const overlay of regionOverlays) overlay.remove();
    regionOverlays = [];
  }

  function hasRegionOverlay(kind = 'active') {
    const overlays = kind === 'next' ? queuedRegionOverlays : regionOverlays;
    return overlays.some((overlay) => overlay.isConnected);
  }

  function ensurePinning() {
    if (pinningEnsured) return;
    // Capture so scrolling inside an inner container (chat apps) also repositions the overlays.
    win.addEventListener?.('scroll', repositionRegionOverlays, { passive: true, capture: true });
    win.addEventListener?.('resize', refreshLayout, { passive: true });
    if (typeof win.ResizeObserver === 'function') {
      pinningResizeObserver = new win.ResizeObserver(refreshLayout);
      pinningResizeObserver.observe(documentRef.documentElement);
    }
    pinningEnsured = true;
  }

  function disposePinning() {
    if (!pinningEnsured) return;
    win.removeEventListener?.('scroll', repositionRegionOverlays, { capture: true });
    win.removeEventListener?.('resize', refreshLayout);
    pinningResizeObserver?.disconnect?.();
    pinningResizeObserver = null;
    pinningEnsured = false;
  }

  function repositionRegionOverlays() {
    if (activeRegionTarget) positionRegionTarget('active', activeRegionTarget);
    if (queuedRegionTarget) positionRegionTarget('next', queuedRegionTarget);
    pdfWordOverlays.reposition();
  }

  function refreshLayout() {
    cachedSearchIndex = null;
    searchCursor = 0;
    repositionRegionOverlays();
  }

  function setPaused(paused) {
    if (paused) scrollFollower.cancelPending();
    if (activeWordPlan) {
      resyncWordPlan({ paused });
    } else if (paused) {
      clearScheduledWordPlan({ clearHighlights: false });
    }
    for (const overlay of regionOverlays) {
      overlay.dataset.pagenarratorPaused = String(Boolean(paused));
    }
    return { ok: true };
  }

  function getRangeRect(range) {
    const rects = flattenRanges(Array.isArray(range) ? range : [range])
      .flatMap((entry) => getRangeRects(entry));
    if (!rects.length) return range.getBoundingClientRect?.() || null;

    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    };
  }

  function getRangeRects(range) {
    const clientRects = Array.from(range.getClientRects?.() || [])
      .filter(isUsableRegionRect)
      .map(copyRect);
    if (clientRects.length) return mergeLineRects(clientRects);

    const fallback = range.getBoundingClientRect?.();
    return isUsableRegionRect(fallback) ? [copyRect(fallback)] : [];
  }

  function getRegionPadding(rect) {
    const height = Number(rect?.height);
    if (highlighterOptions.pdfMode && Number.isFinite(height) && height < 10) {
      return 2;
    }
    return 4;
  }

  function isUsableRegionRect(rect) {
    return Boolean(
      rect
      && Number(rect.width) >= 2
      && Number(rect.height) >= 2
      && Number.isFinite(Number(rect.top))
      && Number.isFinite(Number(rect.left)),
    );
  }

  function mergeLineRects(rects) {
    const sorted = [...rects].sort((a, b) => {
      const topDelta = a.top - b.top;
      if (Math.abs(topDelta) > 2) return topDelta;
      return a.left - b.left;
    });
    const rows = [];

    for (const rect of sorted) {
      const row = rows.find((candidate) => rectsShareLine(candidate, rect));
      if (row) {
        row.rects.push(rect);
        row.top = Math.min(row.top, rect.top);
        row.bottom = Math.max(row.bottom, rect.bottom);
        row.height = row.bottom - row.top;
      } else {
        rows.push({
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
          rects: [rect],
        });
      }
    }

    return rows.flatMap((row) => mergeRowRects(row.rects));
  }

  function mergeRowRects(rects) {
    const sorted = [...rects].sort((a, b) => a.left - b.left);
    const merged = [];
    const medianHeight = median(sorted.map((rect) => rect.height)) || 12;
    const maxInlineGap = Math.max(18, medianHeight * 3);

    for (const rect of sorted) {
      const previous = merged.at(-1);
      if (!previous || rect.left - previous.right > maxInlineGap) {
        merged.push({ ...rect });
        continue;
      }

      previous.left = Math.min(previous.left, rect.left);
      previous.top = Math.min(previous.top, rect.top);
      previous.right = Math.max(previous.right, rect.right);
      previous.bottom = Math.max(previous.bottom, rect.bottom);
      previous.width = previous.right - previous.left;
      previous.height = previous.bottom - previous.top;
    }

    return merged;
  }

  function rectsShareLine(a, b) {
    const centerA = (a.top + a.bottom) / 2;
    const centerB = (b.top + b.bottom) / 2;
    const tolerance = Math.max(3, Math.min(a.height || 0, b.height || 0) * 0.7);
    if (Math.abs(centerA - centerB) <= tolerance) return true;

    const overlap = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const smaller = Math.max(1, Math.min(a.height || 0, b.height || 0));
    return overlap / smaller >= 0.55;
  }

  function copyRect(rect) {
    const left = Number(rect.left) || 0;
    const top = Number(rect.top) || 0;
    const right = Number.isFinite(rect.right) ? rect.right : left + (Number(rect.width) || 0);
    const bottom = Number.isFinite(rect.bottom) ? rect.bottom : top + (Number(rect.height) || 0);
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    };
  }

  function median(values = []) {
    const numeric = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (!numeric.length) return 0;
    const mid = Math.floor(numeric.length / 2);
    return numeric.length % 2 ? numeric[mid] : (numeric[mid - 1] + numeric[mid]) / 2;
  }

  function scrollRangeIntoView(range, options = {}) {
    const node = flattenRanges(Array.isArray(range) ? range : [range])[0]?.startContainer;
    scrollFollower.follow(() => getRangeRect(range), node, 0.35, options);
  }

  function scrollElementIntoView(element, options = {}) {
    scrollFollower.follow(() => element.getBoundingClientRect(), element, 0.32, options);
  }

  return {
    highlightChunk,
    highlightChunkByAnchor,
    highlightQueuedChunkByAnchor,
    flashResumeSectionByAnchor,
    highlightWord,
    highlightWordPlan,
    resyncWordPlan,
    highlightSyntheticSpeech,
    setHighlightSettings,
    setPaused,
    cancelPendingScroll: scrollFollower.cancelPending,
    clearHighlights,
    dispose() {
      clearHighlights();
      disposePinning();
      scrollFollower.dispose();
      searchIndexMutationObserver?.disconnect?.();
      searchIndexMutationObserver = null;
      cachedSearchIndex = null;
    },
  };
}

function createWordPlanClock(win) {
  return {
    currentTime() {
      if (/jsdom/i.test(win.navigator?.userAgent || '')) return Date.now() / 1000;
      const performanceNow = win.performance?.now?.();
      if (Number.isFinite(performanceNow)) return performanceNow / 1000;
      return Date.now() / 1000;
    },
  };
}

function isTestLikeWindow(win) {
  return /jsdom/i.test(win?.navigator?.userAgent || '')
    || win?.location?.href === 'about:blank'
    || /\.test$/i.test(win?.location?.hostname || '')
    || globalThis.process?.env?.NODE_ENV === 'test'
    || Boolean(globalThis.__vitest_worker__);
}

function formatOpacity(value) {
  const opacity = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  return String(Math.round(opacity * 1000) / 1000);
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}
