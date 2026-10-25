import { detectorComponentsFallback } from './native-kernels-fallback.js';

let module, instance, loading;
const MAX_BYTES = 128 * 1024 * 1024;
const REUSE_BYTES = 8 * 1024 * 1024;
const modes = { unit: 0, detector: 1, signed: 2 };

// Optional acceleration: load alongside inference, retain the existing JS path on failure.
export function initializeNativeKernels(source = globalThis.chrome?.runtime?.getURL?.('native/kernels.wasm')) {
  if (!source) return Promise.resolve(null);
  if (loading && typeof source === 'string') return loading;
  return loading = (async () => {
    try {
      let bytes = source;
      if (typeof source === 'string') {
        const response = await fetch(source, { signal: AbortSignal.timeout(2000) });
        if (!response.ok) throw new Error('Native kernels unavailable');
        bytes = await response.arrayBuffer();
      }
      module = await WebAssembly.compile(bytes);
      instance = new WebAssembly.Instance(module);
      if (!(instance.exports.memory instanceof WebAssembly.Memory)
          || !['pcm_process', 'rgba_pack', 'detector_components'].every(name => typeof instance.exports[name] === 'function')
          || !(instance.exports.__heap_base instanceof WebAssembly.Global)
          || !Number.isSafeInteger(instance.exports.__heap_base.value)
          || instance.exports.__heap_base.value <= 0 || instance.exports.__heap_base.value % 8 !== 0
          || instance.exports.__heap_base.value >= MAX_BYTES) throw new Error('Invalid native kernels');
      return instance;
    } catch {
      instance = null;
      return null;
    }
  })();
}

function scratch(bytes) {
  if (!instance) return null;
  const start = Number(instance.exports.__heap_base.value);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_BYTES - start) return null;
  const memory = instance.exports.memory;
  try {
    if (memory.buffer.byteLength < start + bytes) memory.grow(Math.ceil((start + bytes - memory.buffer.byteLength) / 65536));
    return { buffer: memory.buffer, start, exports: instance.exports };
  } catch { return null; }
}

function releaseScratch() {
  // ponytail: retain at most 8 MiB of scratch; large PDF pages use disposable instances.
  if (instance?.exports.memory.buffer.byteLength > REUSE_BYTES) instance = new WebAssembly.Instance(module);
}

export function processPcm(pcm, floor, ratio, encode = true) {
  if (!(pcm instanceof Float32Array) || !Number.isFinite(floor) || !Number.isFinite(ratio) || floor < 0 || ratio < 0) return null;
  const count = pcm.length, outputOffset = count * 4;
  const boundsOffset = Math.ceil((outputOffset + (encode ? count * 2 : 0)) / 4) * 4;
  const work = scratch(boundsOffset + 8);
  if (!work) return null;
  try {
    new Float32Array(work.buffer, work.start, count).set(pcm);
    work.exports.pcm_process(work.start, count, encode ? work.start + outputOffset : 0, floor, ratio, work.start + boundsOffset);
    const bounds = new Int32Array(work.buffer, work.start + boundsOffset, 2);
    return { pcm16: encode ? new Uint8Array(work.buffer, work.start + outputOffset, count * 2).slice() : null,
      first: bounds[0], last: bounds[1] };
  } finally { releaseScratch(); }
}

export function packRgba(pixels, width, height, mode = 'unit', outputWidth = width, target = null, offset = 0) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || !Number.isInteger(outputWidth) || outputWidth < width || !Object.hasOwn(modes, mode)
      || pixels.length !== width * height * 4 || !Number.isInteger(offset) || offset < 0
      || (!target && offset !== 0)) throw new Error('Invalid OCR pixel geometry');
  const size = outputWidth * height * 3;
  if (target && (!(target instanceof Float32Array) || target.length < offset + size)) throw new Error('Invalid OCR tensor target');
  const result = target || new Float32Array(size);
  // Bound pixel conversion scratch to 4 MiB even for the 4-million-pixel unwarp input.
  const rows = Math.min(height, Math.max(1, Math.floor(4 * 1024 * 1024 / (width * 4 + outputWidth * 12))));
  const work = (pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray)
    ? scratch(rows * (width * 4 + outputWidth * 12)) : null;
  if (work) {
    try {
      for (let y = 0; y < height; y += rows) {
        const chunkHeight = Math.min(rows, height - y), inputBytes = width * chunkHeight * 4;
        new Uint8Array(work.buffer, work.start, inputBytes).set(pixels.subarray(y * width * 4, y * width * 4 + inputBytes));
        work.exports.rgba_pack(work.start, width, chunkHeight, outputWidth, modes[mode], work.start + inputBytes);
        const chunkStride = outputWidth * chunkHeight;
        for (let c = 0; c < 3; c++) result.set(new Float32Array(work.buffer,
          work.start + inputBytes + c * chunkStride * 4, chunkStride), offset + (c * height + y) * outputWidth);
      }
      return result;
    } finally { releaseScratch(); }
  }
  const mean = [.485, .456, .406], deviation = [.229, .224, .225];
  for (let c = 0; c < 3; c++) for (let y = 0; y < height; y++) {
    const row = offset + (c * height + y) * outputWidth;
    for (let x = 0; x < width; x++) {
      const value = pixels[(y * width + x) * 4 + 2 - c];
      result[row + x] = mode === 'detector' ? (value / 255 - mean[c]) / deviation[c]
        : mode === 'signed' ? value / 127.5 - 1 : value / 255;
    }
    result.fill(0, row + width, row + outputWidth);
  }
  return result;
}

export function unpackRgb(planar, pixels) {
  const count = pixels.length / 4;
  if (!(pixels instanceof Uint8ClampedArray) || !Number.isInteger(count) || planar.length !== count * 3) throw new Error('Invalid OCR output pixels');
  // Native unpacking used more CPU after bridge copies; retain the measured faster JS loop.
  for (let p = 0; p < count; p++) for (let c = 0; c < 3; c++) pixels[p * 4 + c] = Math.round(planar[(2 - c) * count + p] * 255);
  return pixels;
}

export function detectorComponents(probabilities, width, height, imageWidth, imageHeight) {
  if (![width, height].every(value => Number.isInteger(value) && value > 0)
      || probabilities.length !== width * height || ![imageWidth, imageHeight].every(value => Number.isFinite(value) && value > 0)) throw new Error('Invalid detector shape');
  const count = width * height;
  const seenOffset = count * 4, queueOffset = Math.ceil(count * 5 / 4) * 4;
  const boxesOffset = Math.ceil((queueOffset + count * 4) / 8) * 8;
  if (!(probabilities instanceof Float32Array)) return detectorComponentsFallback(probabilities, width, height, imageWidth, imageHeight);
  let capacity = Math.min(256, Math.floor(count / 3));
  try {
    while (true) {
    const work = scratch(boxesOffset + capacity * 64);
    if (!work) return detectorComponentsFallback(probabilities, width, height, imageWidth, imageHeight);
    const input = new Float32Array(work.buffer, work.start, count);
    input.set(probabilities);
    const size = work.exports.detector_components(work.start, width, height, imageWidth, imageHeight,
      work.start + seenOffset, work.start + queueOffset, work.start + boxesOffset, capacity);
    if (size === -2) { capacity = Math.min(Math.floor(count / 3), capacity * 2); continue; }
    if (size < 0) throw new Error('Invalid detector probability');
    probabilities.set(input);
    const data = new Float64Array(work.buffer, work.start + boxesOffset, size * 8), boxes = [];
    for (let i = 0; i < size * 8; i += 8) boxes.push({ x0: data[i], y0: data[i + 1], x1: data[i + 2], y1: data[i + 3], slope: data[i + 4], score: data[i + 5], count: data[i + 6] });
    return boxes;
    }
  } finally { releaseScratch(); }
}
