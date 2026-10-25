import { beforeAll, afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { initializeNativeKernels, packRgba, unpackRgb, detectorComponents } from '../../src/lib/native-kernels.js';
import { detectorComponentsFallback } from '../../src/lib/native-kernels-fallback.js';
import { detectPdfOcrLines } from '../../src/lib/pdf-ocr-detector.js';
import { recognizePdfOcrNeuralLines } from '../../src/lib/pdf-ocr-neural-batch.js';

beforeAll(async () => {
  const instance = await initializeNativeKernels(await readFile(new URL('../../public/native/kernels.wasm', import.meta.url)));
  expect(typeof instance?.exports.rgba_pack).toBe('function');
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function referencePack(pixels, width, height, mode, outputWidth = width) {
  const output = new Float32Array(3 * height * outputWidth);
  for (let c = 0; c < 3; c++) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const byte = pixels[(y * width + x) * 4 + 2 - c];
    output[c * height * outputWidth + y * outputWidth + x] = mode === 'detector'
      ? (byte / 255 - [.485, .456, .406][c]) / [.229, .224, .225][c]
      : mode === 'signed' ? byte / 127.5 - 1 : byte / 255;
  }
  return output;
}

function expectSameBytes(actual, expected) {
  expect(actual.byteLength).toBe(expected.byteLength);
  expect(Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength)
    .equals(Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength))).toBe(true);
}

function mockCanvases(pixelsForCanvas) {
  const canvases = [];
  vi.stubGlobal('document', { createElement: () => {
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {},
      getImageData: () => ({ data: pixelsForCanvas(canvas) }) }) };
    canvases.push(canvas);
    return canvas;
  } });
  return canvases;
}

it('packs authored complex pixels byte-exactly with all modes and direct padded batch writes', async () => {
  const { data, info } = await sharp(await readFile(new URL('../fixtures/ocr/authored-packing.png', import.meta.url)))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (const mode of ['unit', 'detector', 'signed']) {
    const expected = referencePack(data, info.width, info.height, mode);
    expectSameBytes(packRgba(data, info.width, info.height, mode), expected);
    const padded = referencePack(data, info.width, info.height, mode, info.width + 3);
    const target = new Float32Array(padded.length + 4).fill(17);
    packRgba(data, info.width, info.height, mode, info.width + 3, target, 2);
    expectSameBytes(target.subarray(2, -2), padded);
    expect([...target.subarray(0, 2), ...target.subarray(-2)]).toEqual([17, 17, 17, 17]);
  }
});

it('preserves every input byte, clamping, rounding, nonfinite values and alpha', () => {
  const pixels = Uint8ClampedArray.from({ length: 256 * 4 }, (_, index) => index % 4 === 3 ? 43 : Math.floor(index / 4));
  for (const mode of ['unit', 'detector', 'signed'])
    expectSameBytes(packRgba(pixels, 256, 1, mode), referencePack(pixels, 256, 1, mode));
  const values = Float32Array.from([NaN, Infinity, -Infinity, -.5, 0, .5 / 255, 1.5 / 255,
    127.5 / 255, 254.5 / 255, 1, 2, -0]);
  const planar = Float32Array.from({ length: values.length * 3 }, (_, index) => values[index % values.length]);
  const actual = new Uint8ClampedArray(values.length * 4).fill(43), expected = actual.slice();
  for (let p = 0; p < values.length; p++) for (let c = 0; c < 3; c++)
    expected[p * 4 + c] = Math.round(planar[(2 - c) * values.length + p] * 255);
  unpackRgb(planar, actual);
  expectSameBytes(actual, expected);
});

it('matches component geometry, traversal, thresholds and sigmoid validation exactly', () => {
  const width = 128, height = 96, probabilities = new Float32Array(width * height);
  probabilities[0] = -(2 ** -24); probabilities[width - 1] = 1 + 2 ** -23;
  for (let y = 10; y < 15; y++) for (let x = 0; x < 40; x++) probabilities[y * width + x] = .41 + (x % 3) * .1;
  for (let x = 50; x < 110; x++) for (let dy = 0; dy < 3; dy++) probabilities[(30 + Math.floor(x / 10) + dy) * width + x] = .9;
  for (let x = 60; x < 70; x++) probabilities[80 * width + x] = .2;
  probabilities[90 * width + 30] = probabilities[90 * width + 31] = .99;
  const legacy = probabilities.slice(), native = probabilities.slice();
  expect(detectorComponents(native, width, height, 973, 751))
    .toEqual(detectorComponentsFallback(legacy, width, height, 973, 751));
  expectSameBytes(native, legacy);
  for (const value of [NaN, Infinity, -(2 ** -22), 1 + 2 ** -22]) {
    const invalid = probabilities.slice(); invalid[15] = value;
    expect(() => detectorComponents(invalid, width, height, 973, 751)).toThrow('Invalid detector probability');
  }
});

it('sanitizes signed-zero probabilities to exactly the legacy positive-zero bytes', () => {
  const native = Float32Array.of(-0, -(2 ** -24), 1 + 2 ** -23, .9, .9, .9), legacy = native.slice();
  expect(detectorComponents(native, 3, 2, 99, 73)).toEqual(detectorComponentsFallback(legacy, 3, 2, 99, 73));
  expectSameBytes(native, legacy);
  expect(Object.is(native[0], 0)).toBe(true);
});

it('retries detector output capacity without losing or reordering more than 256 components', () => {
  const width = 128, height = 80, probabilities = new Float32Array(width * height);
  for (let y = 0; y < height; y += 4) for (let x = 0; x < width; x += 4)
    probabilities.fill(.9, y * width + x, y * width + x + 3);
  const legacy = probabilities.slice(), native = probabilities.slice();
  const expected = detectorComponentsFallback(legacy, width, height, 937, 673);
  const actual = detectorComponents(native, width, height, 937, 673);
  expect(actual.length).toBe(640);
  const numericBoxes = boxes => Float64Array.from(boxes.flatMap(box =>
    [box.x0, box.y0, box.x1, box.y1, box.slope, box.score, box.count]));
  expectSameBytes(numericBoxes(actual), numericBoxes(expected));
  expectSameBytes(native, legacy);
});

it('packs four million pixels in stripes and retains earlier outputs after scratch reuse and reset', () => {
  const firstPixels = Uint8ClampedArray.from({ length: 64 * 64 * 4 }, (_, index) => index % 251);
  const first = packRgba(firstPixels, 64, 64, 'detector'), firstExpected = first.slice();
  const width = 2000, height = 2000, pixels = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const row = Math.floor(p / width), i = p * 4;
    pixels[i] = p * 17 % 256; pixels[i + 1] = row % 256;
    pixels[i + 2] = (p * 29 + row) % 256; pixels[i + 3] = p * 37 % 256;
  }
  const expected = referencePack(pixels, width, height, 'unit', width + 3);
  const actual = packRgba(pixels, width, height, 'unit', width + 3);
  expectSameBytes(actual, expected);
  // The detector needs over 8 MiB of scratch and resets the reusable Wasm instance.
  const probabilities = new Float32Array(1000 * 1000);
  probabilities.fill(.9, 1001, 1004);
  expect(detectorComponents(probabilities, 1000, 1000, 1000, 1000)).toHaveLength(1);
  expectSameBytes(packRgba(firstPixels, 64, 64, 'signed'), referencePack(firstPixels, 64, 64, 'signed'));
  expectSameBytes(first, firstExpected);
  expectSameBytes(actual, expected);
});

it('rejects inherited conversion modes and offsets without an explicit output target', () => {
  const pixels = new Uint8ClampedArray(4);
  for (const mode of ['invalid', 'toString', '__proto__'])
    expect(() => packRgba(pixels, 1, 1, mode)).toThrow('Invalid OCR pixel geometry');
  expect(() => packRgba(pixels, 1, 1, 'unit', 1, null, 1)).toThrow('Invalid OCR pixel geometry');
});

it('passes exact detector tensors and component boxes through the complete detector call', async () => {
  const pixels = Uint8ClampedArray.from({ length: 64 * 64 * 4 }, (_, index) => index % 251);
  const canvases = mockCanvases(() => pixels);
  const probabilities = new Float32Array(64 * 64);
  for (let x = 8; x < 30; x++) probabilities[20 * 64 + x] = .9;
  const expected = detectorComponentsFallback(probabilities.slice(), 64, 64, 64, 64);
  const ort = { Tensor: class { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } } };
  const session = { inputNames: ['x'], outputNames: ['y'], run: async ({ x }) => {
    expect(x.dims).toEqual([1, 3, 64, 64]);
    expectSameBytes(x.data, referencePack(pixels, 64, 64, 'detector'));
    return { y: { dims: [1, 1, 64, 64], data: probabilities } };
  } };
  expect(await detectPdfOcrLines({ width: 64, height: 64 }, ort, session)).toEqual(expected);
  expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
});

it('keeps distinct crop geometry, batch offsets and zero padding in recognition tensors', async () => {
  const pixelRows = new Map();
  const canvases = mockCanvases(canvas => {
    const pixels = Uint8ClampedArray.from({ length: canvas.width * canvas.height * 4 }, (_, index) => (index * 31 + canvas.width) % 256);
    pixelRows.set(canvas.width, pixels);
    return pixels;
  });
  const ort = { Tensor: class { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } } };
  const session = { inputNames: ['x'], run: async ({ x }) => {
    expect(x.dims).toEqual([2, 3, 48, 320]);
    const stride = 3 * 48 * 320;
    expectSameBytes(x.data.subarray(0, stride), referencePack(pixelRows.get(48), 48, 48, 'signed', 320));
    expectSameBytes(x.data.subarray(stride), referencePack(pixelRows.get(24), 24, 48, 'signed', 320));
    return { ocr_labels: { dims: [2, 2], data: BigInt64Array.from([1n, 0n, 2n, 0n]) },
      ocr_scores: { dims: [2, 2], data: Float32Array.from([.9, 1, .8, 1]) },
      ocr_spaces: { dims: [2, 2], data: new Float32Array(4) } };
  } };
  const sources = [68, 44].map(width => ({ width, height: 68, getContext: () => ({
    getImageData: () => ({ width, height: 68, data: new Uint8ClampedArray(width * 68 * 4).fill(255) }),
  }) }));
  const output = await recognizePdfOcrNeuralLines(sources, ort, session, ['', 'a', 'b', ' ']);
  const lines = output.map(row => row.blocks[0].paragraphs[0].lines[0]);
  expect(lines.map(line => line.words[0].text)).toEqual(['a', 'b']);
  expect(lines.map(line => line.bbox.x1)).toEqual([58, 34]);
  expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
});

it('keeps production detector and pixel conversions working when the native loader fails', async () => {
  vi.resetModules();
  vi.stubGlobal('chrome', { runtime: { getURL: () => 'chrome-extension://native-unavailable/kernels.wasm' } });
  const fetch = vi.fn().mockRejectedValue(new Error('Native asset unavailable'));
  vi.stubGlobal('fetch', fetch);
  const fallback = await import('../../src/lib/native-kernels.js');
  expect(await fallback.initializeNativeKernels()).toBeNull();
  const pixels = Uint8ClampedArray.from({ length: 64 * 64 * 4 }, (_, index) => index % 251);
  for (const mode of ['unit', 'detector', 'signed'])
    expectSameBytes(fallback.packRgba(pixels, 64, 64, mode), referencePack(pixels, 64, 64, mode));
  const restored = pixels.slice(), expected = pixels.slice(), planar = fallback.packRgba(pixels, 64, 64);
  for (let p = 0; p < 64 * 64; p++) for (let c = 0; c < 3; c++)
    expected[p * 4 + c] = Math.round(planar[(2 - c) * 64 * 64 + p] * 255);
  fallback.unpackRgb(planar, restored);
  expectSameBytes(restored, expected);
  const canvases = mockCanvases(() => pixels), probabilities = new Float32Array(64 * 64);
  for (let x = 8; x < 30; x++) probabilities[20 * 64 + x] = .9;
  const freshDetector = await import('../../src/lib/pdf-ocr-detector.js');
  const session = { inputNames: ['x'], outputNames: ['y'], run: async ({ x }) => {
    expectSameBytes(x.data, referencePack(pixels, 64, 64, 'detector'));
    return { y: { dims: [1, 1, 64, 64], data: probabilities } };
  } };
  const ort = { Tensor: class { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } } };
  expect(await freshDetector.detectPdfOcrLines({ width: 64, height: 64 }, ort, session))
    .toEqual(detectorComponentsFallback(probabilities.slice(), 64, 64, 64, 64));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
});

it('retains exact fallback conversions when a malformed native module omits its heap export', async () => {
  vi.resetModules();
  const malformed = { exports: { memory: new WebAssembly.Memory({ initial: 1 }),
    pcm_process: vi.fn(), rgba_pack: vi.fn(), detector_components: vi.fn() } };
  vi.spyOn(WebAssembly, 'Instance').mockImplementation(function () { return malformed; });
  const fallback = await import('../../src/lib/native-kernels.js');
  expect(await fallback.initializeNativeKernels(await readFile(new URL('../../public/native/kernels.wasm', import.meta.url)))).toBeNull();
  const pixels = Uint8ClampedArray.from({ length: 64 * 64 * 4 }, (_, index) => index % 251);
  expectSameBytes(fallback.packRgba(pixels, 64, 64, 'detector'), referencePack(pixels, 64, 64, 'detector'));
  expect(malformed.exports.rgba_pack).not.toHaveBeenCalled();
});
