import { mapPdfOcrGridBox, mapPdfOcrGridBaseline } from './pdf-ocr-grid.js';
import { recognizePdfOcrDetectedLines, detectPdfOcrLines } from './pdf-ocr-detector.js';
import { packRgba, unpackRgb } from './native-kernels.js';
import { boundedPdfOcrVerifier } from './pdf-ocr-independent.js';
import { orderPdfOcrMarginalLines } from './pdf-ocr-lines.js';
import { defaultLogger } from './logger.js';

// One session per serialized PDF viewer; unsupported GPUs retain ordinary OCR.
export function createPdfOcrUnwarp(runtime) {
  let engine, correction, detector, recognizer, dictionary, active, closing, releasing, closed = false, disabled = false;
  function releaseSessions() {
    return releasing ||= (async () => {
      // Attempt every release even if one runtime session fails to close.
      const sessions = [correction, detector, recognizer];
      const browserEngine = engine;
      engine = correction = detector = recognizer = dictionary = null;
      const results = await Promise.allSettled(sessions.map(async session =>
        (await session?.catch(() => null))?.release()));
      await (await browserEngine?.catch(() => null))?.dispose();
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    })();
  }
  const createVerifier = worker => worker ? boundedPdfOcrVerifier(async line => {
    const client = await worker;
    if (!client?.recognizeLine) throw new Error('Independent OCR line worker is unavailable.');
    return client.recognizeLine(line);
  }, () => closed, error => defaultLogger.warn('Independent OCR verification unavailable; primary GPU text retained.', error)) : null;
  async function recognizeCrop(source, worker) {
    // Reuse live primary sessions; this source retry has no UVDoc or recursive retry.
    if (closed || disabled || !globalThis.navigator?.gpu || !engine || !detector || !recognizer || !dictionary) return null;
    if (!Number.isInteger(source.width) || !Number.isInteger(source.height) || source.width < 1 || source.height < 1
      || source.width * source.height > 4_000_000) throw new RangeError('Invalid OCR image or retry mode.');
    try {
      const [ort, det, rec, alphabet] = await Promise.all([engine, detector, recognizer, dictionary]);
      if (closed || disabled) return null;
      const boxes = await detectPdfOcrLines(source, ort, det, 1280);
      if (closed) return null;
      const lines = await recognizePdfOcrDetectedLines(source, ort, det, rec, alphabet, () => closed, boxes, createVerifier(worker));
      if (closed || !lines) return null;
      return { data: { blocks: [{ paragraphs: [{ lines: orderPdfOcrMarginalLines(lines) }] }] } };
    } catch {
      disabled = true;
      void releaseSessions().catch(() => null);
      return null;
    }
  }
  async function recognize(source, worker, bounds, ready) {
    if (closed || disabled || !globalThis.navigator?.gpu) return null;
    const canvas = document.createElement('canvas');
    try {
      engine ||= (async () => {
        if (!await navigator.gpu.requestAdapter()) throw new Error('No OCR GPU adapter');
        const { createBrowserInferenceEngine } = await import('../engines/browser-inference.js');
        return createBrowserInferenceEngine();
      })();
      const ort = await engine;
      const verify = createVerifier(worker);
      detector ||= ort.InferenceSession.create(runtime.getURL('assets/ocr/tiny-det.onnx'), { executionProviders: ['webgpu'] });
      const boxes = await detectPdfOcrLines(source, ort, await detector);
      if (!boxes.length) return null;
      recognizer ||= ort.InferenceSession.create(runtime.getURL('assets/ocr/small-rec.onnx'), { executionProviders: ['webgpu'] });
      dictionary ||= fetch(runtime.getURL('assets/ocr/small-rec-alphabet.json')).then(response => { if (!response.ok) throw new Error('OCR dictionary unavailable'); return response.json(); });
      void recognizer.catch(() => null);
      void dictionary.catch(() => null);
      if (boxes.length < 20 || boxes.highResolutionRetry) {
        if (!await ready || closed) return null;
        return await recognizePdfOcrDetectedLines(source, ort, await detector, await recognizer, await dictionary, () => closed, boxes, verify);
      }
      if (closed) return null;
      const left = Math.max(0, Math.floor(bounds.left)), top = Math.max(0, Math.floor(bounds.top));
      const width = Math.min(source.width - left, Math.ceil(bounds.right) - left);
      const height = Math.min(source.height - top, Math.ceil(bounds.bottom) - top);
      if (width < 2 || height < 2) return null;
      correction ||= ort.InferenceSession.create(runtime.getURL('assets/ocr/uvdoc.onnx'), { executionProviders: ['webgpu'] });
      void correction.catch(() => null);
      const border = Math.ceil(Math.max(width, height) * 0.15);
      const pw = width + 2 * border, ph = height + 2 * border;
      const scale = Math.min(1, Math.sqrt(4_000_000 / (pw * ph)));
      canvas.width = Math.floor(pw * scale); canvas.height = Math.floor(ph * scale);
      const sx = canvas.width / pw, sy = canvas.height / ph;
      const context = canvas.getContext('2d');
      context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source, left, top, width, height, border * sx, border * sy, width * sx, height * sy);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height), count = canvas.width * canvas.height;
      const input = packRgba(pixels.data, canvas.width, canvas.height);
      const output = await (await correction).run({ image: new ort.Tensor('float32', input, [1, 3, canvas.height, canvas.width]) });
      if (closed) return null;
      const image = output.fetch_name_0, raw = output['p2o.pd_op.add.41.0'];
      if (image.data.length !== count * 3 || raw.dims.join(',') !== '1,2,45,31') throw new Error('Invalid OCR unwarp output');
      const grid = { data: raw.data, width: 31, height: 45, sourceWidth: canvas.width, sourceHeight: canvas.height,
        outputWidth: canvas.width, outputHeight: canvas.height };
      unpackRgb(image.data, pixels.data);
      context.putImageData(pixels, 0, 0);
      if (!await ready || closed) return null;
      detector ||= ort.InferenceSession.create(runtime.getURL('assets/ocr/tiny-det.onnx'), { executionProviders: ['webgpu'] });
      const lines = await recognizePdfOcrDetectedLines(canvas, ort, await detector, await recognizer, await dictionary, () => closed, null, verify);
      if (!lines) return null;
      const map = (box, baseline = false) => {
        const b = baseline ? mapPdfOcrGridBaseline(box, grid) : mapPdfOcrGridBox(box, grid);
        return { x0: Math.max(0, b.x0 / sx - border + left), y0: Math.max(0, b.y0 / sy - border + top),
          x1: Math.min(source.width, b.x1 / sx - border + left), y1: Math.min(source.height, b.y1 / sy - border + top) };
      };
      return lines
        .map((line) => ({ ...line, bbox: map(line.bbox), ...(line.baseline ? { baseline: map(line.baseline, true) } : {}),
          words: (line.words || []).map((word) => ({ ...word, bbox: map(word.bbox) })) }));
    } catch {
      disabled = true;
      void releaseSessions().catch(() => null);
      return null;
    } finally { canvas.width = canvas.height = 0; }
  }
  return {
    retry(source, worker, bounds, ready = Promise.resolve(true)) { active = recognize(source, worker, bounds, ready); return active; },
    recognizeCrop(source, worker) { active = recognizeCrop(source, worker); return active; },
    destroy() {
      closed = true;
      return closing ||= (async () => {
      await active?.catch(() => null);
      await engine?.catch(() => null);
      active = null;
      await releaseSessions();
      })();
    },
  };
}

export function findOcrPaperInPixels(data, { photographOnly = false } = {}) {
  const full = { left: 0, top: 0, right: 1, bottom: 1 };
  const photographed = findNeutralPaper(data, photographOnly);
  if (photographed) return photographed;
  if (photographOnly) return full;
  const columns = [];
  for (let x = 0; x < 240; x++) {
    let white = 0;
    for (let y = 48; y < 192; y++) if (data[(y * 240 + x) * 4] >= 180) white++;
    if (white > 72) columns.push(x);
  }
  if (!columns.length || columns.at(-1) - columns[0] < 120) return full;
  const rows = [];
  for (let y = 0; y < 240; y++) {
    let white = 0;
    for (let x = columns[0]; x <= columns.at(-1); x++) if (data[(y * 240 + x) * 4] >= 180) white++;
    if (white > (columns.at(-1) - columns[0] + 1) / 2) rows.push(y);
  }
  if (!rows.length || rows.at(-1) - rows[0] < 120) return full;
  // ponytail: only remove substantial dark framing; retain four preview pixels of padding.
  if (columns[0] < 12 && columns.at(-1) > 227 && rows[0] < 12 && rows.at(-1) > 227) return full;
  return { left: Math.max(0, columns[0] - 4) / 240, right: Math.min(240, columns.at(-1) + 5) / 240,
    top: Math.max(0, rows[0] - 4) / 240, bottom: Math.min(240, rows.at(-1) + 5) / 240 };
}

function findNeutralPaper(data, rejectAmbiguous) {
  const mask = new Uint8Array(240 * 240);
  let colored = 0;
  for (let p = 0; p < mask.length; p++) {
    const channels = [data[p * 4], data[p * 4 + 1], data[p * 4 + 2]];
    const low = Math.min(...channels), spread = Math.max(...channels) - low;
    if (spread > 30) colored++;
    if (low >= 140 && spread <= 30) mask[p] = 1;
  }
  // ponytail: neutral paper on colored framing only; ambiguous scenes retain full-page OCR.
  if (colored < mask.length / 10) return null;
  const queue = new Int32Array(mask.length);
  let best = null, second = 0;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    let head = 0, count = 1, left = 240, top = 240, right = 0, bottom = 0;
    queue[0] = p; mask[p] = 0;
    while (head < count) {
      const q = queue[head++], x = q % 240, y = Math.floor(q / 240);
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = x + dx, ny = y + dy, index = ny * 240 + nx;
        if (nx >= 0 && nx < 240 && ny >= 0 && ny < 240 && mask[index]) {
          mask[index] = 0; queue[count++] = index;
        }
      }
    }
    if (!best || count > best.count) { second = best?.count || second; best = { count, left, top, right, bottom }; }
    else second = Math.max(second, count);
  }
  if (!best) return null;
  const { count, left, top, right, bottom } = best;
  const area = (right - left + 1) * (bottom - top + 1);
  if ((rejectAmbiguous && second > count / 2) || count < mask.length * 0.05 || area > mask.length * 0.8 || count < area / 2
    || left < 4 || top < 4 || right > 235 || bottom > 235) return null;
  return { left: (left - 4) / 240, top: (top - 4) / 240,
    right: (right + 5) / 240, bottom: (bottom + 5) / 240 };
}

