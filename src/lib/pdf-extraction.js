// @ts-check
export * from './pdf-url-parsing.js';
export * from './pdf-viewer-detection.js';
export * from './pdf-stream-chunking.js';

import { chunkText } from './speech-chunks.js';
import { TUNING_CONFIG } from './tuning-config.js';
import { createLogger } from './logger.js';
import { createPdfPageModel, renderPdfPageModel } from './pdf-page-model.js';
import { PDF_WASM_ASSET_PATH } from '../pdf/assets.js';
import { binaryResource, MAX_SOURCE_BYTES } from '../pdf/binary-resource.js';
export { PDF_WASM_ASSET_PATH } from '../pdf/assets.js';

const PDF_VIEWER_SRC_PARAM = 'src';
export const PDF_WORKER_ASSET_PATH = 'assets/pdf.worker.js';
export const PDF_CMAPS_ASSET_PATH = 'assets/pdf-cmaps/';
export const PDF_STANDARD_FONTS_ASSET_PATH = 'assets/pdf-data/standard_fonts/';
export const PDF_ICCS_ASSET_PATH = 'assets/pdf-data/iccs/';
export const PDF_VIEWER_PATH = 'src/pdf-viewer.html';
export const CHROMIUM_PDF_VIEWER_EXTENSION_ID = 'mhjfbmdgcfjbbpaeojofohoefgiehjai';
export const PDF_TEXT_LAYER_ORDER_ATTRIBUTE = 'data-pagenarrator-pdf-order';
export const PDF_TEXT_LAYER_TEXT_ATTRIBUTE = 'data-pagenarrator-pdf-text';
export const PDF_TEXT_LAYER_NARRATED_ATTRIBUTE = 'data-pagenarrator-pdf-narrated';
export const PDF_TEXT_LAYER_SOURCE_ATTRIBUTE = 'data-pagenarrator-pdf-source-index';
export const PDF_RANGE_CHUNK_SIZE = 64 * 1024;
export const PDF_SCANNED_UNSUPPORTED_ERROR_CODE = 'scanned_pdf_unsupported';
const FETCHABLE_PDF_SOURCE_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'blob:', 'data:']);
const RANGE_LOADABLE_PDF_SOURCE_PROTOCOLS = new Set(['http:', 'https:']);
const DEFAULT_PDF_IMAGE_OPERATOR_CODES = new Set([83, 84, 85, 86, 87, 88, 89, 90]);
const RUNNING_CONTENT_SAMPLE_PAGE_LIMIT = 20;
const RUNNING_CONTENT_IMMEDIATE_PAGE_LIMIT = 1;
// Books alternate left/right headers and change section titles every few
// pages, so each page is also compared with its nearby pages.
const RUNNING_CONTENT_NEIGHBOR_PAGES = 4;
const RUNNING_CONTENT_BAND_RATIO = 0.10;
const RUNNING_CONTENT_REPEAT_SHARE = 0.6;
const PAGE_NUMBER_SIGNATURE = '__page_number__';
const DEFAULT_PDF_SPEECH_CHUNK_MAX_LEN = TUNING_CONFIG.speechChunking.defaultMaxLength;
const DEFAULT_PDF_SPEECH_CHUNK_TARGET_MIN_LEN = TUNING_CONFIG.speechChunking.defaultTargetMinLength;
const pdfExtractionLogger = createLogger('pdf-extraction');

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function hasPdfName(value = '') {
  const url = parseUrl(value);
  if (url && (url.hostname === 'arxiv.org' || url.hostname.endsWith('.arxiv.org')) && url.pathname.startsWith('/pdf/')) return true;
  const path = url ? url.pathname : value.split(/[?#]/, 1)[0];
  return safeDecodeURIComponent(path || '').toLowerCase().endsWith('.pdf');
}

function safeDecodeURIComponent(value = '') {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    pdfExtractionLogger.warn('Could not decode PDF URL component.', error);
    return value;
  }
}

function isUsableSourceUrl(value = '') {
  const parsed = parseUrl(value);
  return Boolean(parsed && FETCHABLE_PDF_SOURCE_PROTOCOLS.has(parsed.protocol));
}

function isChromiumPdfViewerParsedUrl(parsed) {
  return parsed?.protocol === 'chrome-extension:'
    && parsed.hostname === CHROMIUM_PDF_VIEWER_EXTENSION_ID
    && parsed.pathname.endsWith('/index.html');
}

export function isChromiumPdfViewerUrl(value = '') {
  return isChromiumPdfViewerParsedUrl(parseUrl(value));
}

function isPageNarratorPdfViewerParsedUrl(parsed) {
  return parsed?.protocol === 'chrome-extension:' && parsed.pathname.endsWith(`/${PDF_VIEWER_PATH}`);
}

function getExtensionPdfViewerSource(parsed) {
  if (parsed?.protocol !== 'chrome-extension:') return null;

  const isKnownPdfViewer = isChromiumPdfViewerParsedUrl(parsed) || isPageNarratorPdfViewerParsedUrl(parsed);
  const namedSource = isKnownPdfViewer ? parsed.searchParams.get(PDF_VIEWER_SRC_PARAM) : null;
  if (namedSource) return namedSource;

  if (!isChromiumPdfViewerParsedUrl(parsed)) return null;

  const rawQuery = parsed.search.startsWith('?') ? parsed.search.slice(1) : '';
  const decodedQuery = safeDecodeURIComponent(rawQuery);
  return isUsableSourceUrl(decodedQuery) ? decodedQuery : null;
}

export function getPdfSourceUrl(tab = {}) {
  const tabUrl = tab.url || '';
  const parsed = parseUrl(tabUrl);
  const viewerSource = getExtensionPdfViewerSource(parsed);

  if (viewerSource) return viewerSource;
  if (isChromiumPdfViewerParsedUrl(parsed) && tab.pendingUrl) return tab.pendingUrl;
  return tabUrl || tab.pendingUrl || '';
}

export function getPdfStartPageFromTab(tab = {}) {
  const candidates = [
    tab.url,
    tab.pendingUrl,
    getPdfSourceUrl(tab),
  ];

  for (const candidate of candidates) {
    const pageNumber = getPdfStartPageFromUrl(candidate);
    if (pageNumber > 1) return pageNumber;
  }

  return 1;
}

export function getPdfStartPageFromUrl(value = '') {
  const parsed = parseUrl(value);
  if (!parsed) return 1;

  const hashPage = parsePageNumberFromFragment(parsed.hash);
  if (hashPage > 0) return hashPage;

  const pageParam = Number.parseInt(parsed.searchParams.get('page') || '', 10);
  if (Number.isFinite(pageParam) && pageParam > 0) return pageParam;

  const source = getExtensionPdfViewerSource(parsed);
  if (source && source !== value) {
    const sourcePage = getPdfStartPageFromUrl(source);
    if (sourcePage > 0) return sourcePage;
  }

  return 1;
}

function parsePageNumberFromFragment(hash = '') {
  const fragment = String(hash || '').replace(/^#/, '');
  if (!fragment) return 0;

  const params = new URLSearchParams(fragment);
  const pageFromParams = Number.parseInt(params.get('page') || '', 10);
  if (Number.isFinite(pageFromParams) && pageFromParams > 0) return pageFromParams;

  const match = fragment.match(/(?:^|[&#])page=(\d+)/i);
  const pageFromMatch = Number.parseInt(match?.[1] || '', 10);
  return Number.isFinite(pageFromMatch) && pageFromMatch > 0 ? pageFromMatch : 0;
}

export function isPageNarratorPdfViewerUrl(value = '') {
  return isPageNarratorPdfViewerParsedUrl(parseUrl(value));
}

export function getPdfViewerUrl(sourceUrl, runtime = globalThis.chrome?.runtime) {
  if (!sourceUrl) return '';
  const base = typeof runtime?.getURL === 'function'
    ? runtime.getURL(PDF_VIEWER_PATH)
    : PDF_VIEWER_PATH;
  const url = new URL(base, globalThis.location?.href || 'http://localhost/');
  url.searchParams.set(PDF_VIEWER_SRC_PARAM, sourceUrl);
  return url.href;
}

export function isLikelyPdfTab(tab = {}) {
  const tabUrl = tab.url || '';
  const parsedTabUrl = parseUrl(tabUrl);
  const sourceUrl = getPdfSourceUrl(tab);
  if (isChromiumPdfViewerParsedUrl(parsedTabUrl) || isPageNarratorPdfViewerParsedUrl(parsedTabUrl)) return true;
  if (!sourceUrl) return false;
  if (getExtensionPdfViewerSource(parsedTabUrl)) return true;
  return hasPdfName(sourceUrl) || hasPdfName(tab.title || '');
}

export function canFetchPdfSourceUrl(tab = {}) {
  return isUsableSourceUrl(getPdfSourceUrl(tab));
}

function hasPdfMagic(bytes) {
  const signature = [37, 80, 68, 70, 45]; // %PDF-
  const limit = Math.min(bytes?.length || 0, 1024);
  for (let offset = 0; offset <= limit - signature.length; offset += 1) {
    if (signature.every((value, index) => bytes[offset + index] === value)) return true;
  }
  return false;
}

function createPdfDetectionMiss() {
  return new Error('Current tab did not return PDF data.');
}

function createScannedPdfUnsupportedError() {
  const error = new Error('This PDF needs text recognition before its visible text can be read reliably.');
  error.code = PDF_SCANNED_UNSUPPORTED_ERROR_CODE;
  return error;
}

function normalizeTextItemText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function renderTextItems(items = [], options = {}) {
  return createPdfPageModel(items, options).anchorText
    .replace(/-\n\n(?=\p{Ll})/gu, '')
    .trim();
}

export function getReadingOrderedTextItems(items = [], options = {}) {
  return createPdfPageModel(items, options).orderedItems;
}

export function annotatePdfTextLayer(textLayerEl, items = [], options = {}) {
  if (!textLayerEl?.querySelectorAll) return [];

  const model = createPdfPageModel(items, options);
  const orderByOriginalIndex = new Map(
    model.orderedItems.map((item, order) => [item.originalIndex, order]),
  );
  const narratedOriginalIndices = new Set(model.narratedOriginalIndices);
  const spans = [...textLayerEl.querySelectorAll('span')]
    .filter((span) => normalizeTextItemText(span.textContent));
  const annotated = [];
  let itemIndex = 0;

  for (const span of spans) {
    const sourceIndex = span.getAttribute(PDF_TEXT_LAYER_SOURCE_ATTRIBUTE);
    const explicitIndex = sourceIndex !== null && /^\d+$/u.test(sourceIndex) ? Number(sourceIndex) : null;
    if (Number.isSafeInteger(explicitIndex)) itemIndex = explicitIndex;
    while (itemIndex < items.length && !normalizeTextItemText(items[itemIndex]?.str)) {
      itemIndex += 1;
    }
    if (itemIndex >= items.length) break;

    const order = orderByOriginalIndex.get(itemIndex);
    if (Number.isFinite(order)) {
      span.setAttribute(PDF_TEXT_LAYER_ORDER_ATTRIBUTE, String(order));
      span.setAttribute(
        PDF_TEXT_LAYER_NARRATED_ATTRIBUTE,
        String(narratedOriginalIndices.has(itemIndex)),
      );
      annotated.push({ span, order, originalIndex: itemIndex });
    }
    itemIndex += 1;
  }

  textLayerEl.dataset.pagenarratorPdfOrder = annotated.length ? 'true' : 'false';
  textLayerEl.setAttribute(PDF_TEXT_LAYER_TEXT_ATTRIBUTE, model.speech);
  return annotated;
}

export function getPdfWorkerUrl(runtime) {
  const resolvedRuntime = runtime ?? globalThis.chrome?.runtime;


  if (typeof resolvedRuntime?.getURL === 'function') {
    return resolvedRuntime.getURL(PDF_WORKER_ASSET_PATH);
  }

  return PDF_WORKER_ASSET_PATH;
}

export function getPdfWasmUrl(runtime) {
  const resolvedRuntime = runtime ?? globalThis.chrome?.runtime;


  if (typeof resolvedRuntime?.getURL === 'function') {
    return resolvedRuntime.getURL(PDF_WASM_ASSET_PATH);
  }

  return PDF_WASM_ASSET_PATH;
}

export function getPdfCMapUrl(runtime) {
  const resolvedRuntime = runtime ?? globalThis.chrome?.runtime;


  if (typeof resolvedRuntime?.getURL === 'function') {
    return resolvedRuntime.getURL(PDF_CMAPS_ASSET_PATH);
  }

  return PDF_CMAPS_ASSET_PATH;
}

export function getPdfStandardFontDataUrl(runtime) {
  const resolvedRuntime = runtime ?? globalThis.chrome?.runtime;


  if (typeof resolvedRuntime?.getURL === 'function') {
    return resolvedRuntime.getURL(PDF_STANDARD_FONTS_ASSET_PATH);
  }

  return PDF_STANDARD_FONTS_ASSET_PATH;
}

export function getPdfIccUrl(runtime) {
  const resolvedRuntime = runtime ?? globalThis.chrome?.runtime;


  if (typeof resolvedRuntime?.getURL === 'function') {
    return resolvedRuntime.getURL(PDF_ICCS_ASSET_PATH);
  }

  return PDF_ICCS_ASSET_PATH;
}

export function configurePdfWorker(pdfjs, { runtime } = {}) {
  if (!pdfjs?.GlobalWorkerOptions) return '';
  // Injected development oracles retain their own already configured Node worker.
  if (!runtime && globalThis.process?.versions?.node && Object.hasOwn(pdfjs, 'version') && pdfjs.GlobalWorkerOptions.workerSrc) return pdfjs.GlobalWorkerOptions.workerSrc;

  const workerSrc = runtime ? getPdfWorkerUrl(runtime) : getPdfWorkerUrl();
  if (pdfjs.GlobalWorkerOptions.workerSrc !== workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  }

  return workerSrc;
}

export function getPdfDocumentParams(sourceUrl, options = {}) {
  const parsed = parseUrl(sourceUrl);
  if (!parsed || !RANGE_LOADABLE_PDF_SOURCE_PROTOCOLS.has(parsed.protocol)) return null;

  const wasmUrl = options.wasmUrl ?? (options.runtime ? getPdfWasmUrl(options.runtime) : null);
  const cMapUrl = options.cMapUrl ?? (options.runtime ? getPdfCMapUrl(options.runtime) : null);
  const standardFontDataUrl = options.standardFontDataUrl ?? (options.runtime ? getPdfStandardFontDataUrl(options.runtime) : null);

  return {
    url: sourceUrl,
    withCredentials: false,
    useSystemFonts: true,
    rangeChunkSize: PDF_RANGE_CHUNK_SIZE,
    enableScripting: false,
    ...(wasmUrl ? { wasmUrl } : {}),
    ...(cMapUrl ? { cMapUrl, cMapPacked: options.cMapPacked !== false } : {}),
    ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
  };
}

async function loadPdfjs(pdfjsImpl) {
  return pdfjsImpl || import('../pdf/pdf-engine.js');
}

export async function extractPdfTextFromData(data, {
  title = '',
  url = '',
  runtime,
  pdfjs: pdfjsImpl,
  startPage = 1,
  wasmUrl,
  cMapUrl,
  standardFontDataUrl,
  signal = null,
} = {}) {
  const pdfjs = await loadPdfjs(pdfjsImpl);
  configurePdfWorker(pdfjs, { runtime });
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const { document, loadingTask } = await loadPdfDocumentFromData(pdfjs, bytes, {
    runtime,
    wasmUrl,
    cMapUrl,
    standardFontDataUrl,
    signal,
  });

  try {
    return await extractPdfTextFromDocument(document, { title, url, startPage, pdfjs });
  } finally {
    await destroyPdfLoad(document, loadingTask);
  }
}

export async function extractPdfTextFromDocument(document, {
  title = '',
  url = '',
  startPage = 1,
  pdfjs = null,
} = {}) {
  const firstPage = clampPdfPage(startPage, document.numPages);
  const pageRecords = [];
  let imageOnlyPageCount = 0;
  let inspectionFailure = null;

  for (let pageNumber = firstPage; pageNumber <= document.numPages; pageNumber += 1) {
    const record = await readPdfPageRecord(document, pageNumber, { pdfjs });
    if (record.hasOutlinedText || record.hasUnknownType3Text) throw createScannedPdfUnsupportedError();
    pageRecords.push(record);
  }

  const sampleRunningContent = createRunningContentDetector(pageRecords);
  const chunks = [];
  let textPageChunkCount = 0;

  for (const record of pageRecords) {
    const runningContent = combineRunningContentDetectors(
      sampleRunningContent,
      createNearbyRunningContentDetector(record, pageRecords),
    );
    const pageChunk = createPdfPageChunk(record, { runningContent });
    if (pageChunk) {
      textPageChunkCount += 1;
      chunks.push(pageChunk);
    } else if (record.contentKind === 'raster-image') {
      imageOnlyPageCount += 1;
    } else if (record.contentKind === 'inspection-failed') {
      inspectionFailure ||= record.inspectionError;
    }
  }

  if (textPageChunkCount === 0 && inspectionFailure) throw inspectionFailure;
  if (textPageChunkCount === 0 && imageOnlyPageCount > 0) throw createScannedPdfUnsupportedError();

  const text = chunks.map((chunk) => chunk.text).join('\n\n').trim();
  return {
    source: 'pdf',
    title: title || 'PDF document',
    text,
    chunks,
    url,
    pageCount: document.numPages,
    ...(firstPage > 1 ? {
      startPosition: {
        source: 'page',
        pageNumber: firstPage,
        anchorId: `pdf-page-${firstPage}`,
      },
    } : {}),
  };
}

export async function* iteratePdfSpeechChunks(document, {
  maxLen = DEFAULT_PDF_SPEECH_CHUNK_MAX_LEN,
  targetMinLen = DEFAULT_PDF_SPEECH_CHUNK_TARGET_MIN_LEN,
  startPage = 1,
  pdfjs = null,
  recognizePage = null,
  stopOnRasterImage = false,
} = {}) {
  const firstPage = clampPdfPage(startPage, document.numPages);
  let yieldedChunks = false;
  let imageOnlyPageCount = 0;
  let inspectionFailure = null;
  const remainingPageCount = document.numPages - firstPage + 1;
  const emitRecord = function* emitRecord(record, { filterRunningContent = true, runningContent = null } = {}) {
    if ((record.hasOutlinedText || record.hasUnknownType3Text) && record.needsOcr) throw createScannedPdfUnsupportedError();
    const pageChunk = createPdfPageChunk(record, {
      runningContent: filterRunningContent ? runningContent : null,
    });
    if (!pageChunk) {
      // A native-text total cannot describe an OCR document; stop counting early.
      if (stopOnRasterImage && record.contentKind === 'raster-image') throw createScannedPdfUnsupportedError();
      if (record.contentKind === 'raster-image') imageOnlyPageCount += 1;
      if (record.contentKind === 'inspection-failed') inspectionFailure ||= record.inspectionError;
      return;
    }

    yieldedChunks = true;
    yield* chunkText([pageChunk], maxLen, { targetMinLen });
  };

  if (!recognizePage && remainingPageCount <= RUNNING_CONTENT_IMMEDIATE_PAGE_LIMIT) {
    const records = [];
    for (let pageNumber = firstPage; pageNumber <= document.numPages; pageNumber += 1) {
      records.push(await readPdfPageRecord(document, pageNumber, { pdfjs }));
    }
    const runningContent = createRunningContentDetector(records);
    for (const record of records) {
      yield* emitRecord(record, { runningContent });
    }
    if (!yieldedChunks && inspectionFailure) throw inspectionFailure;
    if (!yieldedChunks && imageOnlyPageCount > 0) throw createScannedPdfUnsupportedError();
    return;
  }

  const immediateEndPage = Math.min(document.numPages, firstPage + RUNNING_CONTENT_IMMEDIATE_PAGE_LIMIT - 1);
  const sampleRecords = [];
  let runningContent = null;
  const nearbyRecords = new Map();
  const recognizedPages = new Set();
  let nextPageToRead = firstPage;
  const readNearbyRecord = async (pageNumber, { recognize = false } = {}) => {
    if (recognize && recognizePage) recognizedPages.add(pageNumber);
    const record = await readPdfPageRecord(document, pageNumber, {
      pdfjs,
      recognizePage: recognize ? recognizePage : null,
    });
    nearbyRecords.set(pageNumber, record);
    return record;
  };

  for (let pageNumber = firstPage; pageNumber <= document.numPages; pageNumber += 1) {
    const shouldYieldImmediately = pageNumber <= immediateEndPage;
    // Read-ahead uses text only; OCR still runs when a scanned page is reached.
    const readAheadEndPage = shouldYieldImmediately
      ? pageNumber
      : Math.min(document.numPages, pageNumber + RUNNING_CONTENT_NEIGHBOR_PAGES);
    while (nextPageToRead <= readAheadEndPage) {
      await readNearbyRecord(nextPageToRead, { recognize: nextPageToRead === pageNumber });
      nextPageToRead += 1;
    }
    let record = nearbyRecords.get(pageNumber);
    if (recognizePage && !recognizedPages.has(pageNumber) && record.needsOcr) {
      record = await readNearbyRecord(pageNumber, { recognize: true });
    }
    for (const nearbyPageNumber of nearbyRecords.keys()) {
      if (nearbyPageNumber < pageNumber - RUNNING_CONTENT_NEIGHBOR_PAGES) nearbyRecords.delete(nearbyPageNumber);
    }

    if (sampleRecords.length < RUNNING_CONTENT_SAMPLE_PAGE_LIMIT) {
      sampleRecords.push(record);
      if (!shouldYieldImmediately) runningContent = createRunningContentDetector(sampleRecords);
    }

    yield* emitRecord(record, {
      filterRunningContent: !shouldYieldImmediately,
      runningContent: combineRunningContentDetectors(
        runningContent,
        createNearbyRunningContentDetector(record, [...nearbyRecords.values()]),
      ),
    });
  }

  if (!yieldedChunks && inspectionFailure) throw inspectionFailure;
  if (!yieldedChunks && imageOnlyPageCount > 0) throw createScannedPdfUnsupportedError();
}

export async function getPdfReadableWordCount(document, options = {}) {
  let total = 0;
  for await (const chunk of iteratePdfSpeechChunks(document, options)) {
    total += String(chunk?.speech || '').split(/\s+/).filter(Boolean).length;
  }
  return total;
}

export async function readPdfPageRecord(document, pageNumber, { pdfjs = null, recognizePage = null } = {}) {
  const page = await document.getPage(pageNumber);

  try {
    const content = await page.getTextContent();
    const hasUnknownType3Text = content?.unknownType3Glyphs > 0;
    let items = Array.isArray(content?.items) ? content.items : [];
    const sourcePageView = getPdfPageView(page);
    const pageRotation = page.rotate || 0;
    let model = createPdfPageModel(items, { pageView: sourcePageView, pageRotation });
    const nativeSpeech = model.speech;
    let hasMeaningfulText = Boolean(model.speech.trim());
    const operatorInspection = model.speech.trim().length >= 500
      ? { hasRasterImage: false, hasRenderableNonText: false, inspectionFailed: false, error: null }
      : await inspectPdfPageOperators(page, { pdfjs });
    let needsOcr = Boolean(hasUnknownType3Text || operatorInspection.hasOutlinedText || (!hasMeaningfulText && operatorInspection.hasRasterImage));
    if (needsOcr && recognizePage) {
      items = await recognizePage(page);
      model = createPdfPageModel(items, { pageView: sourcePageView, pageRotation });
      hasMeaningfulText = Boolean(model.speech.trim());
      needsOcr = !hasMeaningfulText || Boolean((hasUnknownType3Text || operatorInspection.hasOutlinedText) && model.speech === nativeSpeech);
    }
    const contentKind = hasMeaningfulText
      ? 'text'
      : operatorInspection.hasRasterImage
        ? 'raster-image'
        : operatorInspection.hasRenderableNonText
          ? 'renderable-nontext'
          : operatorInspection.inspectionFailed
            ? 'inspection-failed'
            : 'blank';
    return {
      pageNumber,
      items,
      model,
      lines: model.lines,
      pageView: model.pageView,
      contentKind,
      hasOutlinedText: Boolean(operatorInspection.hasOutlinedText),
      hasUnknownType3Text,
      needsOcr,
      inspectionError: operatorInspection.error,
      hasImages: contentKind === 'raster-image',
    };
  } finally {
    page.cleanup?.();
  }
}

function createPdfPageChunk(record, { runningContent = null } = {}) {
  const lines = (record.lines || []).filter((line) => !runningContent?.shouldDrop?.(line, record));
  const { anchorText, speech, narratedOriginalIndices } = renderPdfPageModel(lines, { pageView: record.pageView });
  if (!anchorText || !speech) return null;
  const itemOrders = new Map(record.model.orderedItems.map((item, order) => [item.originalIndex, order]));

  return {
    type: 'pdf-page',
    speech,
    text: anchorText,
    anchorText,
    anchorId: `pdf-page-${record.pageNumber}`,
    speechPrefixWords: 0,
    pageNumber: record.pageNumber,
    pdfNarration: {
      speech,
      narratedItemOrders: narratedOriginalIndices.map(index => itemOrders.get(index)),
    },
  };
}

function createRunningContentDetector(records = []) {
  const sample = records
    .slice(0, RUNNING_CONTENT_SAMPLE_PAGE_LIMIT)
    .filter((record) => Array.isArray(record.lines) && record.lines.length);
  if (sample.length < 2) return null;

  const threshold = Math.max(2, Math.ceil(sample.length * RUNNING_CONTENT_REPEAT_SHARE));
  const topCounts = new Map();
  const bottomCounts = new Map();

  for (const record of sample) {
    const seenTop = new Set();
    const seenBottom = new Set();

    for (const line of record.lines) {
      const band = getRunningLineBand(line, record.pageView);
      if (!band) continue;

      const signature = getRunningLineSignature(line.text);
      if (!signature) continue;

      const seen = band === 'top' ? seenTop : seenBottom;
      if (seen.has(signature)) continue;

      seen.add(signature);
      const counts = band === 'top' ? topCounts : bottomCounts;
      counts.set(signature, (counts.get(signature) || 0) + 1);
    }
  }

  const topSignatures = getRepeatedSignatures(topCounts, threshold);
  const bottomSignatures = getRepeatedSignatures(bottomCounts, threshold);
  if (!topSignatures.size && !bottomSignatures.size) return null;

  return {
    shouldDrop(line, record) {
      const band = getRunningLineBand(line, record.pageView);
      if (!band) return false;
      const signature = getRunningLineSignature(line.text);
      if (!signature) return false;
      return band === 'top' ? topSignatures.has(signature) : bottomSignatures.has(signature);
    },
  };
}

function combineRunningContentDetectors(...detectors) {
  const active = detectors.filter(Boolean);
  if (!active.length) return null;
  if (active.length === 1) return active[0];
  return {
    shouldDrop: (line, record) => active.some((detector) => detector.shouldDrop(line, record)),
  };
}

// Learns header/footer slots from nearby pages: text that recurs at the same
// edge position, or an isolated edge line typeset in a slot that recurs.
function createNearbyRunningContentDetector(record, records = []) {
  const neighbors = records.filter((other) => (
    other
    && other.pageNumber !== record?.pageNumber
    && Math.abs(other.pageNumber - record?.pageNumber) <= RUNNING_CONTENT_NEIGHBOR_PAGES
    && other.lines?.length
  ));
  if (!neighbors.length || !record?.lines?.length) return null;

  const pages = [record, ...neighbors].map((page) => ({
    pageNumber: page.pageNumber,
    edges: page.lines.map((line) => getRunningEdge(line, page)).filter(Boolean),
  }));
  const slots = pages.flatMap((page) => page.edges
    .filter((edge) => pages.some((other) => other !== page && other.edges.some((candidate) => (
      candidate.signature === edge.signature && sameRunningPlace(edge, candidate)
    ))))
    .map((edge) => ({ ...edge, pageNumber: page.pageNumber })));
  if (!slots.length) return null;

  const otherSlots = slots.filter((slot) => slot.pageNumber !== record.pageNumber);
  const droppedLines = new Set(record.lines.filter((line) => {
    const edge = getRunningEdge(line, record);
    return edge && otherSlots.some((slot) => (
      (slot.signature === edge.signature && sameRunningPlace(edge, slot))
      || (edge.isolated && sameRunningSlot(edge, slot))
      || (edge.signature === PAGE_NUMBER_SIGNATURE && edge.band === slot.band
        && Math.abs(edge.y - slot.y) <= Math.max(edge.height, slot.height) * 0.6)
    ));
  }));
  // A repeated block (multi-line header, index legend) continues inward
  // only while each next line recurs verbatim at the same place nearby.
  for (const band of ['top', 'bottom']) {
    const inward = [...record.lines].sort((a, b) => (band === 'top' ? b.y - a.y : a.y - b.y));
    for (const [index, line] of inward.entries()) {
      if (droppedLines.has(line)) continue;
      if (!index || !inward.slice(0, index).every((outer) => droppedLines.has(outer))) break;
      const height = getRunningPlace(line, '').height;
      if (Math.abs(inward[index - 1].y - line.y) > height * 2.5) break;
      if (!repeatsAtSamePlace(line, neighbors)) break;
      droppedLines.add(line);
    }
  }
  if (!droppedLines.size) return null;
  return {
    shouldDrop: (line, lineRecord) => lineRecord === record && droppedLines.has(line),
  };
}

function repeatsAtSamePlace(line, neighbors) {
  const text = normalizeTextItemText(line.text).toLowerCase();
  if (!/\p{L}/u.test(text)) return false;
  const place = getRunningPlace(line, '');
  return neighbors.some((neighbor) => neighbor.lines.some((candidate) => (
    normalizeTextItemText(candidate.text).toLowerCase() === text
    && sameRunningPlace(place, getRunningPlace(candidate, ''))
  )));
}

function getRunningPlace(line, band) {
  return {
    band,
    height: Math.max(1, ...(line.parts || []).map((part) => Number(part.height) || 0)),
    y: Number(line.y),
    left: Number(line.left ?? line.parts?.[0]?.x ?? 0),
    right: Number(line.right ?? line.left ?? 0),
  };
}

// Page boxes can carry wide margins, so the outermost text row near a page
// edge also counts as an edge even when it sits outside the fixed band.
function getOuterRowBand(line, record) {
  const lines = record.lines || [];
  const [, rawBottom = 0,, rawTop = 792] = Array.isArray(record.pageView) ? record.pageView : [];
  const pageBottom = Math.min(rawBottom, rawTop);
  const pageHeight = Math.max(1, Math.abs(rawTop - rawBottom));
  const height = Math.max(1, ...(line.parts || []).map((part) => Number(part.height) || 0));
  const y = Number(line.y);
  if (y >= pageBottom + pageHeight * 0.8 && y >= Math.max(...lines.map((other) => other.y)) - height * 0.5) return 'top';
  if (y <= pageBottom + pageHeight * 0.2 && y <= Math.min(...lines.map((other) => other.y)) + height * 0.5) return 'bottom';
  return '';
}

function getRunningEdge(line, record) {
  const band = getRunningLineBand(line, record.pageView) || getOuterRowBand(line, record);
  if (!band) return null;
  const signature = getRunningLineSignature(line.text);
  if (!signature) return null;
  const place = getRunningPlace(line, band);
  const inward = (record.lines || []).filter((other) => (
    band === 'top' ? other.y < place.y - place.height * 0.5 : other.y > place.y + place.height * 0.5
  ));
  const nearestGap = inward.length
    ? Math.min(...inward.map((other) => Math.abs(place.y - other.y)))
    : Infinity;
  return {
    ...place,
    signature,
    // Headers and footers sit apart from the text block; body lines do not.
    isolated: nearestGap >= place.height * 1.8,
  };
}

function sameRunningPlace(a, b) {
  const height = Math.max(a.height, b.height);
  if (a.band !== b.band || Math.abs(a.y - b.y) > Math.max(2, Math.min(a.height, b.height) * 0.6)) return false;
  return sameRunningHorizontalPlace(a, b, height * 2);
}

function sameRunningSlot(a, b) {
  return a.band === b.band
    && Math.abs(a.y - b.y) <= Math.max(1, a.height * 0.15)
    && Math.abs(a.height - b.height) <= Math.max(0.3, a.height * 0.05)
    && sameRunningHorizontalPlace(a, b, Math.max(a.height, b.height) * 2);
}

function sameRunningHorizontalPlace(a, b, tolerance) {
  const overlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const smaller = Math.max(1, Math.min(a.right - a.left, b.right - b.left));
  return Math.abs(a.left - b.left) <= tolerance
    || Math.abs(a.right - b.right) <= tolerance
    || overlap / smaller >= 0.5;
}

function getRepeatedSignatures(counts, threshold) {
  return new Set(
    [...counts.entries()]
      .filter(([, count]) => count >= threshold)
      .map(([signature]) => signature),
  );
}

function getRunningLineBand(line, pageView = [0, 0, 612, 792]) {
  const [, rawBottom = 0,, rawTop = 792] = Array.isArray(pageView) ? pageView : [];
  const bottom = Math.min(rawBottom, rawTop);
  const top = Math.max(rawBottom, rawTop);
  const height = Math.max(1, top - bottom);
  const bandHeight = Math.max(24, height * RUNNING_CONTENT_BAND_RATIO);
  const y = Number(line?.y);
  if (!Number.isFinite(y)) return '';
  if (y >= top - bandHeight) return 'top';
  if (y <= bottom + bandHeight) return 'bottom';
  return '';
}

function getRunningLineSignature(text) {
  const value = normalizeTextItemText(text).toLowerCase();
  if (!value) return '';
  if (isLikelyPageNumber(value)) return PAGE_NUMBER_SIGNATURE;
  const structuralNumbers = [...value.matchAll(/\b(?:chapter|part|section)\s+(?:\d+(?:\.\d+)*|[ivxlcdm]+)\b/gu)]
    .map(match => match[0]).join('|');

  const withoutDigits = value
    .replace(/\d+/g, '')
    .replace(/[^\p{L}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (withoutDigits) return structuralNumbers ? `${withoutDigits}|${structuralNumbers}` : withoutDigits;
  return '';
}

function isLikelyPageNumber(value) {
  return /^(?:page\s*)?(?:\d+|[il]\d{1,3}|[ivxlcdm]+)$/i.test(String(value || '').replace(/[.\-\u2013\u2014]/g, '').trim());
}

function getPdfPageView(page) {
  return Array.isArray(page?.view) && page.view.length >= 4 ? page.view : [0, 0, 612, 792];
}

async function inspectPdfPageOperators(page, { pdfjs = null } = {}) {
  if (typeof page?.inspect === 'function') {
    try { return await page.inspect(); }
    catch (error) { pdfExtractionLogger.warn('Could not inspect original PDF page for OCR routing.', error); return { hasRasterImage: false, hasRenderableNonText: false, inspectionFailed: true, error }; }
  }
  if (typeof page?.getOperatorList !== 'function') {
    return { hasRasterImage: false, hasRenderableNonText: false, inspectionFailed: false, error: null };
  }

  try {
    const operatorList = await page.getOperatorList();
    const imageOperators = getPdfImageOperatorCodes(pdfjs);
    const renderableOperators = getPdfRenderableNonTextOperatorCodes(pdfjs);
    const functions = operatorList?.fnArray || [];
    const ops = pdfjs?.OPS || {};
    const fills = new Set([ops.fill, ops.eoFill, ops.fillStroke, ops.eoFillStroke,
      ops.closeFillStroke, ops.closeEOFillStroke].filter(Number.isFinite));
    const [left, bottom, right, top] = getPdfPageView(page);
    const pageWidth = Math.abs(right - left), pageHeight = Math.abs(top - bottom);
    // shortcut: detects grouped word outlines; add glyph-row detection for individually outlined letters.
    let outlinedWords = 0;
    for (let i = 0; i < functions.length && outlinedWords < 50; i++) {
      if (functions[i] !== ops.constructPath) continue;
      const [paint, , bounds] = operatorList.argsArray?.[i] || [];
      if (!fills.has(paint) || !bounds || bounds.length !== 4) continue;
      const width = bounds[2] - bounds[0], height = bounds[3] - bounds[1];
      if (height >= pageHeight * 0.002 && height <= pageHeight * 0.05
        && width >= height * 2 && width <= pageWidth * 0.15) outlinedWords++;
    }
    return {
      hasRasterImage: functions.some((fn) => imageOperators.has(fn)),
      hasRenderableNonText: functions.some((fn) => renderableOperators.has(fn)),
      hasOutlinedText: outlinedWords >= 50,
      inspectionFailed: false,
      error: null,
    };
  } catch (error) {
    pdfExtractionLogger.warn('Could not inspect PDF page operators for image detection.', error);
    return { hasRasterImage: false, hasRenderableNonText: false, inspectionFailed: true, error };
  }
}

function getPdfRenderableNonTextOperatorCodes(pdfjs = null) {
  const ops = pdfjs?.OPS || {};
  return new Set([
    ops.constructPath,
    ops.stroke,
    ops.closeStroke,
    ops.fill,
    ops.eoFill,
    ops.fillStroke,
    ops.eoFillStroke,
    ops.closeFillStroke,
    ops.closeEOFillStroke,
    ops.shadingFill,
  ].filter(Number.isFinite));
}

function getPdfImageOperatorCodes(pdfjs = null) {
  const ops = pdfjs?.OPS || {};
  const codes = [
    ops.paintImageMaskXObject,
    ops.paintImageMaskXObjectGroup,
    ops.paintImageXObject,
    ops.paintInlineImageXObject,
    ops.paintInlineImageXObjectGroup,
    ops.paintImageXObjectRepeat,
    ops.paintImageMaskXObjectRepeat,
    ops.paintSolidColorImageMask,
  ].filter(Number.isFinite);

  return codes.length ? new Set(codes) : DEFAULT_PDF_IMAGE_OPERATOR_CODES;
}

export async function extractPdfArticle(options = {}) {
  const {
    tab,
    requirePdfData = false,
    pdfjs: pdfjsImpl,
    streamChunks = false,
    speechChunkOptions = null,
    startPage = 1,
    runtime = globalThis.process?.versions?.node ? undefined : globalThis.chrome?.runtime,
    wasmUrl,
    cMapUrl,
    standardFontDataUrl,
    signal = null,
  } = options;
  signal?.throwIfAborted();
  const hasInjectedFetch = Object.hasOwn(options, 'fetch');
  const fetchImpl = hasInjectedFetch ? options.fetch : globalThis.fetch;
  const sourceUrl = getPdfSourceUrl(tab);
  if (!sourceUrl) throw new Error('No PDF URL found.');

  const documentParams = !requirePdfData && (!hasInjectedFetch || pdfjsImpl)
    ? getPdfDocumentParams(sourceUrl, {
      runtime: options.runtime,
      wasmUrl,
      cMapUrl,
      standardFontDataUrl,
    })
    : null;
  if (documentParams) {
    const pdfjs = await loadPdfjs(pdfjsImpl);
    configurePdfWorker(pdfjs, { runtime });
    signal?.throwIfAborted();
    const loadingTask = pdfjs.getDocument({ ...documentParams, ...(signal ? { signal } : {}) });
    const document = await loadingTask.promise;

    if (streamChunks) {
      return createStreamingPdfArticle(document, {
        title: tab?.title || 'PDF document',
        url: sourceUrl,
        startPage,
        speechChunkOptions,
        pdfjs,
        loadingTask,
      });
    }

    try {
      return await extractPdfTextFromDocument(document, {
        title: tab?.title || 'PDF document',
        url: sourceUrl,
        startPage,
        pdfjs,
      });
    } finally {
      await destroyPdfLoad(document, loadingTask);
    }
  }

  if (typeof fetchImpl !== 'function') throw new Error('PDF download is not available in this browser.');

  const bytes = await binaryResource(sourceUrl, { signal: signal || new AbortController().signal,
    maxBytes: MAX_SOURCE_BYTES, fetchImpl, credentials: 'include',
    validatePrefix: requirePdfData ? prefix => { if (!hasPdfMagic(prefix)) throw createPdfDetectionMiss(); } : null });

  if (streamChunks) {
    const pdfjs = await loadPdfjs(pdfjsImpl);
    configurePdfWorker(pdfjs, { runtime });
    const { document, loadingTask } = await loadPdfDocumentFromData(pdfjs, bytes, {
      runtime,
      wasmUrl,
      cMapUrl,
      standardFontDataUrl,
      signal,
    });
    return createStreamingPdfArticle(document, {
      title: tab?.title || 'PDF document',
      url: sourceUrl,
      startPage,
      speechChunkOptions,
      pdfjs,
      loadingTask,
    });
  }

  return extractPdfTextFromData(bytes, {
    title: tab?.title || 'PDF document',
    url: sourceUrl,
    runtime,
    pdfjs: pdfjsImpl,
    startPage,
    wasmUrl,
    cMapUrl,
    standardFontDataUrl,
    signal,
  });
}

async function loadPdfDocumentFromData(pdfjs, bytes, options = {}) {
  const wasmUrl = options.wasmUrl ?? (options.runtime ? getPdfWasmUrl(options.runtime) : null);
  const cMapUrl = options.cMapUrl ?? (options.runtime ? getPdfCMapUrl(options.runtime) : null);
  const standardFontDataUrl = options.standardFontDataUrl ?? (options.runtime ? getPdfStandardFontDataUrl(options.runtime) : null);

  const loadingTask = pdfjs.getDocument({
    data: bytes,
    disableWorker: Boolean(globalThis.process?.versions?.node),
    useSystemFonts: true,
    enableScripting: false,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(wasmUrl ? { wasmUrl } : {}),
    ...(cMapUrl ? { cMapUrl, cMapPacked: true } : {}),
    ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
  });
  return { document: await loadingTask.promise, loadingTask };
}

function createStreamingPdfArticle(document, {
  title = '',
  url = '',
  startPage = 1,
  speechChunkOptions = null,
  pdfjs = null,
  loadingTask = null,
} = {}) {
  const firstPage = clampPdfPage(startPage, document.numPages);
  const chunkOptions = normalizeSpeechChunkOptions(speechChunkOptions);
  return {
    source: 'pdf',
    title: title || 'PDF document',
    text: '',
    chunks: [],
    url,
    pageCount: document.numPages,
    streaming: true,
    chunkStream: streamPdfDocumentChunks(document, { startPage: firstPage, ...chunkOptions, pdfjs, loadingTask }),
    ...(firstPage > 1 ? {
      startPosition: {
        source: 'page',
        pageNumber: firstPage,
        anchorId: `pdf-page-${firstPage}`,
      },
    } : {}),
  };
}

async function* streamPdfDocumentChunks(document, {
  startPage = 1,
  maxLen = DEFAULT_PDF_SPEECH_CHUNK_MAX_LEN,
  targetMinLen = DEFAULT_PDF_SPEECH_CHUNK_TARGET_MIN_LEN,
  pdfjs = null,
  loadingTask = null,
} = {}) {
  try {
    yield* iteratePdfSpeechChunks(document, { startPage, maxLen, targetMinLen, pdfjs });
  } finally {
    await destroyPdfLoad(document, loadingTask);
  }
}

async function destroyPdfLoad(document, loadingTask) {
  if (typeof loadingTask?.destroy === 'function') return loadingTask.destroy();
  return document?.destroy?.();
}

function normalizeSpeechChunkOptions(options = {}) {
  const maxLen = Number(options?.maxLen);
  const targetMinLen = Number(options?.targetMinLen);
  return {
    maxLen: Number.isFinite(maxLen) && maxLen > 0 ? Math.trunc(maxLen) : DEFAULT_PDF_SPEECH_CHUNK_MAX_LEN,
    targetMinLen: Number.isFinite(targetMinLen) && targetMinLen >= 0 ? Math.trunc(targetMinLen) : DEFAULT_PDF_SPEECH_CHUNK_TARGET_MIN_LEN,
  };
}

function clampPdfPage(pageNumber, pageCount) {
  const page = Math.trunc(Number(pageNumber));
  if (!Number.isFinite(page) || page < 1) return 1;
  const count = Math.trunc(Number(pageCount));
  return Number.isFinite(count) && count > 0 ? Math.min(page, count) : page;
}
