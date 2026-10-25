import {hasPdfOcrInteriorInk} from './pdf-ocr-detector.js';
import { createPdfOcrUnwarp, findOcrPaperInPixels } from './pdf-ocr-unwarp.js';
import { createPdfOcrWorker } from './pdf-ocr-worker-client.js';
import { getPdfOcrPaperCrop, getPdfOcrPaperSourceCrop } from './pdf-ocr-paper.js';
import { joinPdfOcrLineFragments, getPdfOcrRetryRectangle, orderPdfOcrMarginalLines } from './pdf-ocr-lines.js';
import { getPdfOcrRetryCrop, mapPdfOcrRetryLines, shouldUsePdfOcrRetry,
  preservePdfOcrConfidentWords, needsPdfOcrSourceRetry, preferRetriedPdfOcr, getPdfOcrSourceRetryCrop } from './pdf-ocr-retry.js';

// One English CPU worker per viewer; successful GPU recognition leaves its models unloaded.
export function createPdfOcr({ runtime = chrome.runtime, onStatus = () => {} } = {}) {
  const unwarp = createPdfOcrUnwarp(runtime);
  let workerPromise;
  const cache = new Map();
  const recognizedPages = new Set();
  let closed = false;
  let queue = Promise.resolve();
  let cancelActive;
  let closing;

  function terminateWorker() {
    const pending = workerPromise;
    workerPromise = null;
    return Promise.resolve(pending).catch(() => null).then(worker => worker?.terminate());
  }

  function recognizePage(page) {
    const task = queue.then(async () => {
      if (closed) throw new Error('PDF OCR has been closed.');
      if (cache.has(page.pageNumber)) return cache.get(page.pageNumber);
      onStatus(`Recognizing text on page ${page.pageNumber}...`);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(3, Math.sqrt(4_000_000 / (base.width * base.height)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const paperSourceWidth = canvas.width, paperSourceHeight = canvas.height;
      let renderTask;
      const cancelled = new Promise((_, reject) => { cancelActive = reject; });
      const timer = setTimeout(() => cancelActive(new Error('PDF OCR timed out.')), 90_000);
      try {
        workerPromise ||= createPdfOcrWorker({ runtime });
        // Start fallback loading concurrently; retain rejection for the fallback await.
        void workerPromise.catch(() => null);
        if (closed) throw new Error('PDF OCR has been closed.');
        renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport });
        await Promise.race([renderTask.promise, cancelled]);
        let previewPixels = null;
        let paper = {left:0,top:0,right:1,bottom:1};
        {
          const preview = document.createElement('canvas'); preview.width = preview.height = 240;
          preview.getContext('2d').drawImage(canvas, 0, 0, 240, 240);
          previewPixels = preview.getContext('2d').getImageData(0, 0, 240, 240).data;
          paper = findOcrPaperInPixels(previewPixels);
          preview.width = preview.height = 0;
        }
        const gutters = findOcrGutters(canvas);
        const edges = [0, ...gutters, 1];
        const regions = edges.slice(1).map((right, index) => [edges[index], right]);
        let items = [];
        let nextLine = 0;
        for (const [left, right] of regions) {
          const regionScale = gutters.length
            ? Math.min(3, Math.sqrt(4_000_000 / (base.width * (right - left) * base.height)))
            : scale;
          const regionViewport = page.getViewport({ scale: regionScale });
          const offset = Math.floor(regionViewport.width * left);
          if (gutters.length) {
            canvas.width = Math.floor(regionViewport.width * (right - left));
            canvas.height = Math.floor(regionViewport.height);
            renderTask = page.render({ canvasContext: canvas.getContext('2d'),
              viewport: regionViewport, transform: [1, 0, 0, 1, -offset, 0] });
            await Promise.race([renderTask.promise, cancelled]);
          }
          const ready = Promise.resolve(true);
          const candidateTask = (async () => {
            if (!globalThis.navigator?.gpu || !hasPdfOcrInteriorInk(previewPixels, left, right)) return null;
            const crop = getPdfOcrPaperCrop(paper, canvas.width, canvas.height, regionScale, {
              sourceWidth: paperSourceWidth, sourceHeight: paperSourceHeight, sourceScale: scale, offsetX: offset,
            });
            if (!crop) return null;
            const { factor } = crop;
            const retryCanvas = document.createElement('canvas');
            retryCanvas.width = Math.floor(crop.width * factor); retryCanvas.height = Math.floor(crop.height * factor);
            try {
              renderTask = page.render({ canvasContext: retryCanvas.getContext('2d'),
                viewport: page.getViewport({ scale: regionScale * factor }),
                transform: [1, 0, 0, 1, -(offset + crop.left) * factor, -crop.top * factor] });
              await Promise.race([renderTask.promise, cancelled]);
              const candidate = await unwarp.retry(retryCanvas, workerPromise, { left: 0, top: 0,
                right: retryCanvas.width, bottom: retryCanvas.height }, ready);
              return candidate ? mapPdfOcrRetryLines(candidate, crop, factor) : null;
            } finally { retryCanvas.width = retryCanvas.height = 0; }
          })();
          let candidate = await Promise.race([candidateTask.catch(() => null), cancelled]);
          let sourceRetry = !!candidate && needsPdfOcrSourceRetry(candidate);
          let corrected = !sourceRetry && !!candidate?.some(line => line.words?.some(word => word.text?.trim()));
          const cpuWorkerPromise = workerPromise;
          const retryFailure = error => {
            if (!sourceRetry) throw error;
            if (workerPromise === cpuWorkerPromise) void terminateWorker().catch(() => null);
            return null;
          };
          const worker = corrected ? null : await Promise.race([cpuWorkerPromise.catch(retryFailure), cancelled]);
          const recognizeCpuSource = async () => {
            // Use original page pixels, rather than magnifying the initial whole-page raster.
            // Gutter panels retain their existing independent source/render coordinates.
            const cpuPaper = findOcrPaperInPixels(previewPixels, { photographOnly: true });
            const crop = gutters.length ? null : getPdfOcrPaperSourceCrop(cpuPaper, canvas.width, canvas.height, regionScale);
            if (!crop) return worker.recognize(canvas, { mode: 'page' });
            const source = document.createElement('canvas');
            source.width = Math.floor(crop.width * crop.factor); source.height = Math.floor(crop.height * crop.factor);
            try {
              renderTask = page.render({ canvasContext: source.getContext('2d'),
                viewport: page.getViewport({ scale: regionScale * crop.factor }),
                transform: [1, 0, 0, 1, -(offset + crop.left) * crop.factor, -crop.top * crop.factor] });
              await Promise.race([renderTask.promise, cancelled]);
              const result = await worker.recognize(source, { mode: 'page' });
              const lines = (result?.data.blocks || []).flatMap(block => block.paragraphs || []).flatMap(part => part.lines || []);
              if (!lines.some(line => line.words?.some(word => word.text?.trim()))) return worker.recognize(canvas, { mode: 'page' });
              return { data: { blocks: [{ paragraphs: [{ lines: mapPdfOcrRetryLines(lines, crop, crop.factor) }] }] } };
            } finally { source.width = source.height = 0; }
          };
          const fallbackTask = async () => {
            if (!sourceRetry) {
              const result = await recognizeCpuSource();
              const lines = (result?.data.blocks || []).flatMap(block => block.paragraphs || []).flatMap(part => part.lines || []);
              if (!needsPdfOcrSourceRetry(lines)) return result;
              candidate = lines; sourceRetry = true;
            }
            const crop = getPdfOcrSourceRetryCrop(candidate, canvas.width, canvas.height);
            if (!crop) return null;
            const factor = Math.min(1.5, Math.sqrt(4_000_000 / (crop.width * crop.height)));
            const retryCanvas = document.createElement('canvas');
            retryCanvas.width = Math.floor(crop.width * factor); retryCanvas.height = Math.floor(crop.height * factor);
            try {
              // Render fresh source pixels; resizing the old raster cannot recover a missing letter.
              renderTask = page.render({ canvasContext: retryCanvas.getContext('2d'),
                viewport: page.getViewport({ scale: regionScale * factor }),
                transform: [1, 0, 0, 1, -(offset + crop.left) * factor, -crop.top * factor] });
              await Promise.race([renderTask.promise, cancelled]);
              const retry = await unwarp.recognizeCrop?.(retryCanvas, cpuWorkerPromise)
                || await worker.recognize(retryCanvas, { mode: 'crop' });
              const lines = (retry?.data.blocks || []).flatMap(block => block.paragraphs || []).flatMap(part => part.lines || []);
              const mapped = mapPdfOcrRetryLines(lines, crop, factor);
              const inside = line => (line.words || []).some(word => word.bbox.x1 > crop.left && word.bbox.x0 < crop.left + crop.width
                && word.bbox.y1 > crop.top && word.bbox.y0 < crop.top + crop.height);
              const original = candidate.filter(inside);
              const result = preferRetriedPdfOcr(original, mapped)
                ? orderPdfOcrMarginalLines([...candidate.filter(line => !inside(line)), ...mapped]) : candidate;
              return { data: { blocks: [{ paragraphs: [{ lines: result }] }] } };
            } finally { retryCanvas.width = retryCanvas.height = 0; }
          };
          const fallback = corrected || !worker ? null : await Promise.race([fallbackTask().catch(retryFailure), cancelled]);
          if (sourceRetry && !fallback) corrected = true;
          const lines = corrected ? candidate : (fallback.data.blocks || []).flatMap(block => block.paragraphs || []).flatMap(part => part.lines || []);
          let joined = corrected ? orderPdfOcrMarginalLines(lines) : joinPdfOcrLineFragments(lines);
          const rectangle = corrected || sourceRetry ? null : getPdfOcrRetryRectangle(lines, joined);
          if (rectangle && !corrected) {
            const crop = getPdfOcrRetryCrop(rectangle, lines, canvas.width, canvas.height);
            if (crop) {
              const factor = Math.min(1.5, Math.sqrt(4_000_000 / (crop.width * crop.height)));
              canvas.width = Math.floor(crop.width * factor);
              canvas.height = Math.floor(crop.height * factor);
              renderTask = page.render({ canvasContext: canvas.getContext('2d'),
                viewport: page.getViewport({ scale: regionScale * factor }),
                transform: [1, 0, 0, 1, -(offset + crop.left) * factor, -crop.top * factor] });
              await Promise.race([renderTask.promise, cancelled]);
              const retry = await Promise.race([worker.recognize(canvas, { mode: 'crop' }).catch(retryFailure), cancelled]);
              const retryLines = (retry?.data.blocks || []).flatMap((block) => block.paragraphs || [])
                .flatMap((paragraph) => paragraph.lines || []);
              let body = joinPdfOcrLineFragments(mapPdfOcrRetryLines(retryLines, crop, factor));
              const outside = (word) => word.bbox.x1 <= crop.left || word.bbox.x0 >= crop.left + crop.width
                || word.bbox.y1 <= crop.top || word.bbox.y0 >= crop.top + crop.height;
              const original = lines.map((line) => ({ ...line, words: (line.words || []).filter((word) => !outside(word)) }));
              body = preservePdfOcrConfidentWords(original, body);
              if (shouldUsePdfOcrRetry(original, body)) {
                const margins = lines.map((line) => ({ ...line, words: (line.words || []).filter(outside) }))
                  .filter((line) => line.words.length);
                joined = [...margins, ...body];
              }
            }
          }
          if (sourceRetry && !preferRetriedPdfOcr(candidate, joined)) joined = orderPdfOcrMarginalLines(candidate);
          for (const line of joined) {
            const ocrLine = nextLine++;
            for (const word of line.words || []) {
              if (!word.text?.trim()) continue;
              const { x0, y0, x1, y1 } = word.bbox;
              const [x, y] = regionViewport.convertToPdfPoint(x0 + offset, y1);
              const pixelScale = regionScale * (regionViewport.userUnit ?? 1);
              const height = (y1 - y0) / pixelScale;
              let transform = [height, 0, 0, height, x, y];
              if (page.rotate) {
                const [rightX, rightY] = regionViewport.convertToPdfPoint(x0 + offset + y1 - y0, y1);
                const [topX, topY] = regionViewport.convertToPdfPoint(x0 + offset, y0);
                transform = [rightX - x, rightY - y, topX - x, topY - y, x, y];
              }
              items.push({ ocrLine, ...(gutters.length ? { ocrColumn: left } : {}), str: word.text, transform,
                width: (x1 - x0) / pixelScale, height, hasEOL: false });
            }
          }
        }
        const native = await Promise.race([page.getTextContent?.() || Promise.resolve({ items: [] }), cancelled]);
        if (closed) throw new Error('PDF OCR has been closed.');
        for (const item of native.items || []) {
          if (!item.str?.trim() || !item.transform) continue;
          const [a, b, c, d, x, y] = item.transform, determinant = a * d - b * c;
          const length = item.width / Math.hypot(a, b);
          if (!Number.isFinite(length) || !Number.isFinite(determinant) || !determinant) continue;
          const overlaps = word => {
            const [wa, wb, wc, wd, wx, wy] = word.transform;
            const along = word.width / Math.hypot(wa, wb);
            const dx = wx + wa * along / 2 + wc / 2 - x, dy = wy + wb * along / 2 + wd / 2 - y;
            const u = (d * dx - c * dy) / determinant, v = (-b * dx + a * dy) / determinant;
            return u >= -0.2 && u <= length + 0.2 && v >= -0.2 && v <= 1.2;
          };
          const first = items.findIndex(overlaps);
          const preserved = { ...item, ocrLine: first < 0 ? nextLine++ : items[first].ocrLine };
          if (first >= 0 && Number.isFinite(items[first].ocrColumn)) preserved.ocrColumn = items[first].ocrColumn;
          // Keep selectable source text and its place in the OCR cache used by highlighting.
          if (first < 0) items.push(preserved);
          else items = items.flatMap((word, index) => index === first ? [preserved] : overlaps(word) ? [] : [word]);
        }
        cache.set(page.pageNumber, items);
        recognizedPages.add(page.pageNumber);
        if (cache.size > 12) cache.delete(cache.keys().next().value);
        return items;
      } catch (cause) {
        renderTask?.cancel?.();
        if (!closed) void unwarp.destroy().catch(() => null);
        void terminateWorker().catch(() => null);
        throw new Error(`Could not recognize PDF page ${page.pageNumber}. Try reading again.`, { cause });
      } finally {
        clearTimeout(timer);
        cancelActive = null;
        canvas.width = canvas.height = 0;
        onStatus('');
      }
    });
    queue = task.catch(() => null);
    return task;
  }

  return {
    recognizePage,
    getItems: (pageNumber) => cache.get(pageNumber),
    hasPage: (pageNumber) => recognizedPages.has(pageNumber),
    destroy() {
      closed = true;
      cache.clear();
      recognizedPages.clear();
      cancelActive?.(new Error('PDF OCR has been closed.'));
      return closing ||= (async () => {
        try { await terminateWorker(); }
        finally { await queue; await unwarp.destroy(); }
      })();
    },
  };
}

function findOcrGutters(canvas) {
  if (canvas.width < canvas.height * 1.2) return [];
  const preview = document.createElement('canvas');
  preview.width = preview.height = 240;
  const context = preview.getContext('2d');
  context.drawImage(canvas, 0, 0, 240, 240);
  const { data } = context.getImageData(0, 0, 240, 240);
  preview.width = preview.height = 0;
  const thirds = [80, 160].map(center => findOcrGutterInPixels(data, center));
  if (thirds.every(Boolean)) return thirds;
  const gutter = findOcrGutterInPixels(data);
  return gutter ? [gutter] : [];
}

export function findOcrGutterInPixels(data, preferredCenter = 120) {
  // shortcut: white separators in symmetric landscape panels; add arbitrary columns when original layouts require them.
  const ink = (x, y) => data[(y * 240 + x) * 4] < 180;
  let occupiedRows = 0, firstInkRow = 240, lastInkRow = -1;
  for (let y = 24; y < 216; y++) {
    for (let x = 12; x < 228; x++) {
      if (ink(x, y)) { occupiedRows++; firstInkRow = Math.min(firstInkRow, y); lastInkRow = y; break; }
    }
  }
  // A single large line can fill 40 rows; its letter gaps are not page columns.
  if (occupiedRows < 40 || lastInkRow - firstInkRow + 1 < 96) return 0;
  const paper = [];
  for (let x = 0; x < 240; x++) {
    let dark = 0;
    for (let y = 48; y < 192; y++) if (ink(x, y)) dark++;
    if (dark < 72) paper.push(x);
  }
  const paperCenter = paper.length ? Math.round((paper[0] + paper.at(-1)) / 2) : 120;
  // Fall back to the body when a black scan border obscures the full-height gutter.
  const bands = [[24, 216, preferredCenter], [48, 192, preferredCenter]];
  if (preferredCenter === 120) bands.push([48, 192, paperCenter]);
  for (const [top, bottom, center] of bands) {
    let start = 0;
    let best = [0, 0];
    for (let x = Math.max(1, center - 12); x <= Math.min(239, center + 12); x++) {
      let dark = 0;
      for (let y = top; y < bottom; y++) if (ink(x, y)) dark++;
      if (dark <= 1 && x < Math.min(239, center + 12)) {
        start ||= x;
      } else if (start) {
        if (x - start > best[1] - best[0]) best = [start, x];
        start = 0;
      }
    }
    if (best[1] - best[0] >= 2) {
      const gutter = (best[0] + best[1]) / 480;
      if (preferredCenter === 120 || Math.abs(gutter - preferredCenter / 240) <= 6 / 240) return gutter;
    }
  }
  return 0;
}


