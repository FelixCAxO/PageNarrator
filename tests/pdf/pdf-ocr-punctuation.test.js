import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { analyzePunctuationSource, mergePunctuationSource } from '../../src/lib/pdf-ocr-punctuation.js';
import { boundedPdfOcrVerifier } from '../../src/lib/pdf-ocr-independent.js';
import { normalizeTesseractLine } from '../../src/engines/tesseract-line-recognizer.js';

const copies = [];
class PixelCanvas {
  constructor(width, height) {
    this.width = width; this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
    this.context = { fillStyle: '', fillRect: vi.fn(() => this.data.fill(255)),
      drawImage: vi.fn((source, x, y) => {
        const pixels = source.getContext('2d').getImageData(0, 0, source.width, source.height).data;
        for (let row = 0; row < source.height; row++) this.data.set(pixels.subarray(row * source.width * 4, (row + 1) * source.width * 4),
          ((row + y) * this.width + x) * 4);
      }), getImageData: () => ({ data: this.data, width: this.width, height: this.height }) };
    copies.push(this);
  }
  getContext() { return this.context; }
}
beforeEach(() => { copies.length = 0; vi.stubGlobal('OffscreenCanvas', PixelCanvas); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture(mark = 'period', light = false) {
  const width = 120, height = 50, data = new Uint8ClampedArray(width * height * 4);
  const background = light ? 20 : 255, foreground = light ? 235 : 0;
  for (let p = 0; p < width * height; p++) data.set([background, background, background, 255], p * 4);
  const rect = (left, top, right, bottom) => {
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) data.set([foreground, foreground, foreground, 255], (y * width + x) * 4);
  };
  rect(15, 18, 25, 33); rect(45, 18, 52, 33); rect(55, 18, 62, 33);
  if (mark === 'period') rect(66, 31, 68, 33);
  if (mark === 'comma') { rect(66, 31, 68, 33); rect(65, 33, 67, 35); }
  if (mark === 'border') rect(66, 10, 68, 40);
  if (mark === 'far') rect(100, 31, 102, 33);
  const words = [{ text: 'First', confidence: 99, bbox: { x0: 14, y0: 17, x1: 26, y1: 34 } },
    { text: 'last', confidence: 99, bbox: { x0: 44, y0: 17, x1: 63, y1: 34 } }];
  const primary = { blocks: [{ paragraphs: [{ lines: [{ words }] }] }] };
  const independent = suffix => ({ blocks: [{ paragraphs: [{ lines: [{ words: [words[0],
    { text: `last${suffix}`, confidence: 97, bbox: { x0: 44, y0: 17, x1: 69, y1: mark === 'comma' ? 36 : 34 } }] }] }] }] });
  return { source: { width, height, data }, primary, independent };
}
const words = data => data.blocks[0].paragraphs[0].lines[0].words;

it('uses the existing four-attempt quota for deferred terminal punctuation', async () => {
  const f = fixture(), recognize = vi.fn(async () => f.independent('.'));
  const canvas = { width: f.source.width, height: f.source.height,
    getContext: () => ({ getImageData: () => f.source }) };
  const verify = boundedPdfOcrVerifier(recognize);
  expect(verify.spacingCandidate(canvas, f.primary)).toBe(true);
  expect(await verify(canvas, f.primary)).toBe(f.primary);
  expect(recognize).not.toHaveBeenCalled();
  for (let i = 0; i < 4; i++) expect(words(await verify.verifySpacing(canvas, f.primary))[1].text).toBe('last.');
  expect(await verify.verifySpacing(canvas, f.primary)).toBe(f.primary);
  expect(verify.spacingCandidate(canvas, f.primary)).toBe(false);
  expect(recognize).toHaveBeenCalledTimes(4);
});

it('shares one independent read between uncertain letters and terminal punctuation', async () => {
  const f = fixture(), last = words(f.primary)[1];
  last.symbols = Array.from(last.text, text => ({ text, confidence: 70 }));
  const recognize = vi.fn(async () => f.independent('.'));
  const canvas = { width: f.source.width, height: f.source.height,
    getContext: () => ({ getImageData: () => f.source }) };
  const verify = boundedPdfOcrVerifier(recognize);
  expect(verify.uncertainCandidate(canvas, f.primary)).toBe(true);
  const result = await verify.verifyUncertain(canvas, f.primary,
    { left: 10, top: 10, originX: 0, slope: 0, sourceWidth: 200, sourceHeight: 100 });
  expect(words(result)[1].text).toBe('last.');
  expect(words(result)[1]).not.toHaveProperty('symbols');
  expect(recognize).toHaveBeenCalledTimes(1);
});

it.each([false, true])('recovers observed terminal period only after independent agreement (light=%s)', light => {
  const f = fixture('period', light), before = structuredClone(f.primary), result = mergePunctuationSource(f.source, f.primary, f.independent('.'));
  expect(analyzePunctuationSource(f.source, f.primary)).toEqual({ index: 1, bbox: { x0: 44, y0: 17, x1: 69, y1: 34 } });
  expect(words(result)[0]).toBe(words(f.primary)[0]);
  expect(words(result)[1]).toEqual({ text: 'last.', confidence: 97, bbox: { x0: 44, y0: 17, x1: 69, y1: 34 } });
  expect(f.primary).toEqual(before);
});

it('preserves a comma descender without changing preceding boxes', () => {
  const f = fixture('comma'), result = mergePunctuationSource(f.source, f.primary, f.independent(','));
  expect(words(result)[1].text).toBe('last,');
  expect(words(result)[1].bbox).toEqual({ x0: 44, y0: 17, x1: 69, y1: 36 });
});

it('removes stale primary character symbols from a corrected word without mutating the original', () => {
  const f = fixture(), original = words(f.primary)[1];
  original.symbols = Array.from(original.text, text => ({ text, confidence: 99 }));
  const saved = structuredClone(original.symbols);
  const result = mergePunctuationSource(f.source, f.primary, f.independent('.'));
  expect(words(result)[1].text).toBe('last.');
  expect(words(result)[1]).not.toHaveProperty('symbols');
  expect(original.symbols).toEqual(saved);
});

it.each(['none', 'border', 'far'])('does not request verification from %s source evidence', mark => {
  const f = fixture(mark);
  expect(analyzePunctuationSource(f.source, f.primary)).toBeNull();
  expect(mergePunctuationSource(f.source, f.primary, f.independent('.'))).toBe(f.primary);
});

it.each(['', '..', '.x', 'X', ' .'])('retains specks when the independent model emits %j', suffix => {
  const f = fixture();
  expect(mergePunctuationSource(f.source, f.primary, f.independent(suffix))).toBe(f.primary);
});

it('rejects changed letters, low confidence, wrong ownership and unsupported extra words', () => {
  const f = fixture();
  const edits = [checked => { words(checked)[0] = { ...words(checked)[0], text: 'Other' }; },
    checked => { words(checked)[1].confidence = 84.99; },
    checked => { words(checked)[1].bbox.x0 = 20; },
    checked => { words(checked)[1].bbox.x1 = 63; },
    checked => { words(checked)[1].bbox.x1 = 110; },
    checked => { words(checked)[1].bbox.y1 = 20; },
    checked => { words(checked).push(words(checked)[1]); }];
  for (const edit of edits) {
    const checked = structuredClone(f.independent('.')); edit(checked);
    expect(mergePunctuationSource(f.source, f.primary, checked)).toBe(f.primary);
  }
});

it.each(['last.', '3.14', 'variable_1', 'AaBb', 'someValue', 'Ord\u00e4'])('does not change an existing mark, decimal, identifier or unsupported script: %s', text => {
  const f = fixture(); words(f.primary)[1].text = text;
  expect(analyzePunctuationSource(f.source, f.primary)).toBeNull();
});

it.each(['x =', '\u65e5\u672c\u8a9e', 'value_2'])('keeps unsupported source-line context %s out of English punctuation verification', text => {
  const f = fixture(); words(f.primary)[0].text = text;
  expect(analyzePunctuationSource(f.source, f.primary)).toBeNull();
});

it('fails closed on malformed source, geometry and line cardinality', () => {
  const f = fixture();
  expect(analyzePunctuationSource({ ...f.source, data: new Uint8Array(1) }, f.primary)).toBeNull();
  words(f.primary)[1].bbox.x1 = Infinity;
  expect(analyzePunctuationSource(f.source, f.primary)).toBeNull();
  const primary = fixture().primary;
  expect(mergePunctuationSource(f.source, primary, { blocks: [] })).toBe(primary);
});

it.each([true, false])('uses retained horizontal source context in a 414 by 43 line crop (mark=%s)', mark => {
  const width = 414, height = 43, data = new Uint8ClampedArray(width * height * 4).fill(255);
  const rect = (left, top, right, bottom) => {
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) data.set([0, 0, 0, 255], (y * width + x) * 4);
  };
  for (const left of [282, 292, 309, 318, 328, 338, 348, 358, 368, 378, 388, 398]) rect(left, 12, left + 4, 27);
  if (mark) rect(404, 25, 406, 27); // Real source inside the ten-pixel model border.
  rect(404, 3, 406, 5); rect(404, 38, 406, 40); // Adjacent lines outside the vertical core.
  const primary = { blocks: [{ paragraphs: [{ lines: [{ words: [
    { text: 'some', confidence: 99, bbox: { x0: 281, y0: 11, x1: 314, y1: 28 } },
    { text: 'terminal', confidence: 99, bbox: { x0: 317, y0: 11, x1: 403, y1: 28 } },
  ] }] }] }] };
  const independent = structuredClone(primary);
  words(independent)[1] = { text: 'terminal.', confidence: 97, bbox: { x0: 317, y0: 11, x1: 407, y1: 28 } };
  const source = { width, height, data }, result = mergePunctuationSource(source, primary, independent);
  if (!mark) {
    expect(analyzePunctuationSource(source, primary)).toBeNull();
    expect(result).toBe(primary);
    return;
  }
  expect(analyzePunctuationSource(source, primary)).toEqual({ index: 1, bbox: { x0: 317, y0: 11, x1: 407, y1: 28 } });
  expect(words(result)[1].text).toBe('terminal.');
  expect(words(result)[1].bbox).toEqual(words(independent)[1].bbox);
  expect(words(result)[0]).toBe(words(primary)[0]);
});

it('copies source pixels without moving coordinates and exposes real right context to unchanged English normalization', async () => {
  const f = fixture(), saved = Uint8ClampedArray.from(f.source.data);
  // Put the entire mark in retained source context, outside the English ten-pixel trim.
  for (let y = 31; y < 33; y++) for (let x = 66; x < 68; x++) f.source.data.set([255, 255, 255, 255], (y * 120 + x) * 4);
  for (let y = 31; y < 33; y++) for (let x = 111; x < 113; x++) f.source.data.set([0, 0, 0, 255], (y * 120 + x) * 4);
  for (const [oldLeft, newLeft] of [[45, 90], [55, 100]]) for (let y = 18; y < 33; y++) for (let x = 0; x < 7; x++) {
    f.source.data.set([255, 255, 255, 255], (y * 120 + oldLeft + x) * 4);
    f.source.data.set([0, 0, 0, 255], (y * 120 + newLeft + x) * 4);
  }
  words(f.primary)[1].bbox = { x0: 89, y0: 17, x1: 108, y1: 34 };
  const checked = f.independent('.'); words(checked)[1].bbox = { x0: 89, y0: 17, x1: 114, y1: 34 };
  const canvas = { ...f.source, getContext: () => ({ getImageData: () => f.source }) }, original = Uint8ClampedArray.from(f.source.data);
  const recognize = vi.fn(async input => {
    expect(input.width).toBe(130); expect(input.height).toBe(50);
    expect(copies[0].context.fillRect).toHaveBeenCalledExactlyOnceWith(0, 0, 130, 50);
    expect(copies[0].context.drawImage).toHaveBeenCalledExactlyOnceWith(canvas, 0, 0);
    for (let y = 0; y < input.height; y++) {
      expect(input.data.subarray(y * 130 * 4, (y * 130 + 120) * 4)).toEqual(original.subarray(y * 120 * 4, (y + 1) * 120 * 4));
      expect(input.data.subarray((y * 130 + 120) * 4, (y + 1) * 130 * 4)).toEqual(new Uint8ClampedArray(40).fill(255));
    }
    const unmarked = { data: Uint8Array.from(input.data), width: 130, height: 50 };
    for (let y = 31; y < 33; y++) for (let x = 111; x < 113; x++) unmarked.data.set([255, 255, 255, 255], (y * 130 + x) * 4);
    const region = { left: 10, top: 10, cropWidth: 110, cropHeight: 30 };
    expect(normalizeTesseractLine({ data: input.data, width: 130, height: 50 }, region).data)
      .not.toEqual(normalizeTesseractLine(unmarked, region).data);
    return checked;
  });
  const result = await boundedPdfOcrVerifier(recognize).verifySpacing(canvas, f.primary);
  expect(words(result)[1].text).toBe('last.'); expect(words(result)[1].bbox.x1).toBe(114);
  expect(f.source.data).toEqual(original); expect(f.source.data).not.toEqual(saved);
  expect(copies[0].width).toBe(0); expect(copies[0].height).toBe(0);
});

it.each(['recognition-error', 'cancelled-result', 'cancelled-copy', 'copy-error'])('clears temporary punctuation context and preserves primary on %s', async reason => {
  const f = fixture(), error = new Error('context failure'); let cancelled = false;
  const canvas = { width: 120, height: 50, getContext: () => ({ getImageData: () => f.source }) };
  if (reason === 'copy-error') vi.spyOn(PixelCanvas.prototype, 'getContext').mockImplementation(() => { throw error; });
  if (reason === 'cancelled-copy') {
    const getContext = PixelCanvas.prototype.getContext;
    vi.spyOn(PixelCanvas.prototype, 'getContext').mockImplementation(function () { cancelled = true; return getContext.call(this); });
  }
  const recognize = vi.fn(async () => { if (reason === 'recognition-error') throw error; cancelled = true; return f.independent('.'); });
  const onError = vi.fn(), verify = boundedPdfOcrVerifier(recognize, () => cancelled, onError);
  expect(await verify.verifySpacing(canvas, f.primary)).toBe(f.primary);
  expect(copies).toHaveLength(1); expect(copies[0].width).toBe(0); expect(copies[0].height).toBe(0);
  expect(recognize).toHaveBeenCalledTimes(reason === 'copy-error' || reason === 'cancelled-copy' ? 0 : 1);
  expect(onError).toHaveBeenCalledTimes(reason.endsWith('error') ? 1 : 0);
});

it('rejects padded punctuation context beyond the existing pixel cap without allocating or recognizing', async () => {
  const f = fixture(), width = 20970, height = 50, data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let row = 0; row < 50; row++) data.set(f.source.data.subarray(row * 120 * 4, (row + 1) * 120 * 4), row * width * 4);
  const source = { width, height, data }, canvas = { width, height, getContext: () => ({ getImageData: () => source }) };
  expect(analyzePunctuationSource(source, f.primary)).not.toBeNull();
  const recognize = vi.fn(), verify = boundedPdfOcrVerifier(recognize);
  expect(await verify.verifySpacing(canvas, f.primary)).toBe(f.primary);
  expect(recognize).not.toHaveBeenCalled(); expect(copies).toHaveLength(0);
});
