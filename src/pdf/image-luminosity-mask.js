// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { decodePdfStream } from './streams.js';
import { iteratePdfContent } from './inline-image.js';
import { resolvePdfColorSpace } from './color-spaces.js';
import { jpegNativeSamples } from './image-data.js';
import { pdfImageSampleBytes, MAX_IMAGE_PIXELS } from './image-limits.js';
import { multiply } from './viewport.js';

const IDENTITY = [1, 0, 0, 1, 0, 0], MAX_BYTES = 32 * 1024 * 1024;
const corrupt = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };
const unsupported = message => { throw new PdfEngineError(message); };
const limit = message => { throw new PdfEngineError(message, 'pdf_limit'); };
const field = (reader, id, key) => { const value = reader.field(id, key); return value && reader.node(value).kind !== 'null' ? value : 0; };
const clamp = n => Math.max(0, Math.min(1, n));
function finite(values, length) {
  if (!Array.isArray(values) || values.length !== length || values.some(n => !Number.isFinite(n))) corrupt('Invalid PDF image-mask geometry.');
  return values;
}
function inverse(matrix) {
  finite(matrix, 6); const [a, b, c, d, e, f] = matrix, determinant = a * d - b * c;
  if (!Number.isFinite(determinant)) limit('PDF image-mask transform exceeds numeric limits.');
  if (!determinant) unsupported('Singular PDF image-mask transforms are not implemented.');
  const result = [d / determinant, -b / determinant, -c / determinant, a / determinant, (c * f - d * e) / determinant, (b * e - a * f) / determinant];
  if (result.some(n => !Number.isFinite(n))) limit('PDF image-mask inverse exceeds numeric limits.');
  return result;
}

/** Only a single opaque Gray JPEG in native DeviceCMYK mask artwork. */
export async function readPdfImageLuminosityArtwork(reader, form, resources, loadAsset, context, validateState) {
  const source = reader.node(form), remaining = MAX_BYTES - context.programBytes;
  if (remaining < 0 || source.length > MAX_BYTES || !field(reader, form, 'Filter') && source.length > remaining) limit('PDF soft-mask resource byte limit exceeded.');
  const decoded = (await decodePdfStream(reader, form)).bytes;
  if (context.programBytes + decoded.length > MAX_BYTES) limit('PDF soft-mask resource byte limit exceeded.');
  context.programBytes += decoded.length;
  const expected = ['q', 'gs', 'cm', 'Do', 'Q']; let step = 0, operands = [], matrix, image;
  for await (const batch of iteratePdfContent(reader, decoded, resources, loadAsset)) for (const id of batch) {
    reader.check(); context.chargeOperation(); const token = reader.node(id);
    if (token.kind !== 'operator') { if (operands.length >= 6) unsupported('This PDF image-mask artwork is not implemented.'); operands.push(id); continue; }
    const op = reader.text(token);
    if (op !== expected[step++]) unsupported('This PDF image-mask artwork is not implemented.');
    const count = op === 'cm' ? 6 : ['gs', 'Do'].includes(op) ? 1 : 0;
    if (operands.length !== count) corrupt('Invalid PDF image-mask artwork operands.');
    if (op === 'cm') { matrix = finite(operands.map(id => reader.number(id, NaN)), 6); inverse(matrix); }
    if (op === 'gs' || op === 'Do') {
      const name = reader.name(operands[0]); if (!name) corrupt('Invalid PDF image-mask resource name.');
      const dictionary = field(reader, resources, op === 'gs' ? 'ExtGState' : 'XObject'), target = dictionary && field(reader, dictionary, name);
      if (!target) corrupt('Missing PDF image-mask resource.');
      if (op === 'gs') validateState(target); else image = target;
    }
    operands = [];
  }
  if (step !== expected.length || operands.length) corrupt('Incomplete PDF image-mask artwork.');
  const node = reader.node(image);
  if (node.kind !== 'stream' || reader.name(field(reader, image, 'Subtype')) !== 'Image') unsupported('PDF luminosity masks require a single image.');
  const type = field(reader, image, 'Type'); if (type && reader.name(type) !== 'XObject') corrupt('Invalid PDF image-mask image Type.');
  const interpolation = field(reader, image, 'Interpolate');
  if (interpolation && reader.node(interpolation).kind !== 'boolean') corrupt('PDF image-mask Interpolate must be boolean.');
  if (interpolation && reader.node(interpolation).aux) unsupported('Interpolated PDF image masks are not implemented.');
  for (const key of ['Decode', 'DecodeParms', 'Mask', 'SMask', 'Matte', 'SMaskInData']) if (field(reader, image, key)) unsupported(`PDF image-mask ${key} is not implemented.`);
  const stencil = field(reader, image, 'ImageMask');
  if (stencil && (reader.node(stencil).kind !== 'boolean' || reader.node(stencil).aux)) unsupported('Stencil luminosity-mask artwork is not implemented.');
  const filter = field(reader, image, 'Filter'), filters = filter && reader.node(filter).kind === 'array' ? reader.array(filter) : [filter];
  if (filters.length !== 1 || !['DCTDecode', 'DCT'].includes(reader.name(filters[0])) || reader.number(field(reader, image, 'BitsPerComponent')) !== 8) unsupported('PDF image masks require an eight-bit DCT source.');
  const space = await resolvePdfColorSpace(reader, resources, field(reader, image, 'ColorSpace'), loadAsset, 0, context.profiles);
  if (space.name !== 'DeviceGray' || space.components !== 1) unsupported('This PDF image-mask source colour space is not implemented.');
  const width = reader.number(field(reader, image, 'Width')), height = reader.number(field(reader, image, 'Height')), bytes = pdfImageSampleBytes(width, height, 1, 8);
  const identity = node.id, key = `image:${identity}`;
  if (!context.resources.has(key) && context.resources.size >= 256) limit('PDF soft-mask resource limit exceeded.');
  context.resources.add(key);
  let cached = context.images.get(identity);
  if (!cached) {
    if (context.imagePixels + width * height > MAX_IMAGE_PIXELS || context.programBytes + bytes > MAX_BYTES || node.length > MAX_BYTES) limit('PDF soft-mask image budget exceeded.');
    context.admitImage(width * height); context.imagePixels += width * height;
    const samples = (await jpegNativeSamples(reader, reader.bytes(node), width, height, 1)).bytes;
    context.programBytes += samples.byteLength;
    cached = { samples, width, height }; context.images.set(identity, cached);
  }
  return { ...cached, matrix };
}

const point = (m, x, y) => {
  const result = [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  if (result.some(n => !Number.isFinite(n))) limit('PDF image-mask geometry exceeds numeric limits.');
  return result;
};
const area = polygon => {
  let value = 0; for (let i = 0; i < polygon.length; i++) { const next = polygon[(i + 1) % polygon.length]; value += polygon[i][0] * next[1] - polygon[i][1] * next[0]; }
  if (!Number.isFinite(value)) limit('PDF image-mask coverage exceeds numeric limits.');
  return value / 2;
};
function clip(polygon, distance) {
  if (!polygon.length) return polygon;
  const result = []; let previous = polygon.at(-1), before = distance(previous);
  for (const current of polygon) {
    const after = distance(current);
    if (![before, after].every(Number.isFinite)) limit('PDF image-mask clipping exceeds numeric limits.');
    if ((before >= 0) !== (after >= 0)) { const f = before / (before - after); result.push(previous.map((n, i) => n + f * (current[i] - n))); }
    if (after >= 0) result.push(current); previous = current; before = after;
  }
  return result;
}
function regionCoverage(imageMatrix, maskMatrix, bbox) {
  let polygon = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => point(imageMatrix, x, y));
  const l = Math.min(bbox[0], bbox[2]), r = Math.max(bbox[0], bbox[2]), b = Math.min(bbox[1], bbox[3]), t = Math.max(bbox[1], bbox[3]);
  const box = [[l, b], [r, b], [r, t], [l, t]].map(([x, y]) => point(maskMatrix, x, y)), sign = Math.sign(area(box));
  if (!sign) return () => 0;
  for (let i = 0; i < 4; i++) {
    const a = box[i], z = box[(i + 1) % 4];
    polygon = clip(polygon, p => sign * ((z[0] - a[0]) * (p[1] - a[1]) - (z[1] - a[1]) * (p[0] - a[0])));
  }
  if (!polygon.length) return () => 0;
  const left = Math.min(...polygon.map(p => p[0])), right = Math.max(...polygon.map(p => p[0])), bottom = Math.min(...polygon.map(p => p[1])), top = Math.max(...polygon.map(p => p[1]));
  return (x, y) => {
    if (x >= right || x + 1 <= left || y >= top || y + 1 <= bottom) return 0;
    let local = polygon.map(p => [p[0] - x, p[1] - y]);
    for (const distance of [p => p[0], p => 1 - p[0], p => p[1], p => 1 - p[1]]) local = clip(local, distance);
    return clamp(Math.abs(area(local)));
  };
}

/** Device luminosity policy from ISO32000-1 11.5.3; no ICC/gamma conversion. */
export function createPdfImageLuminositySampler(descriptor, { pageTransform = IDENTITY, surfaceBudget = { pixels: 0 }, cancellation } = {}) {
  cancellation?.();
  const image = descriptor?.deviceImage;
  if (descriptor?.type !== 'Luminosity' || descriptor.profileBytes || descriptor.shading || !image || !(image.samples instanceof Uint8Array)) corrupt('Invalid PDF device image-mask descriptor.');
  const { width, height, samples } = image;
  if (pdfImageSampleBytes(width, height, 1, 8) !== samples.length) corrupt('Invalid PDF image-mask sample dimensions.');
  const backdrop = finite(descriptor.backdrop, 4).map(clamp), bbox = finite(descriptor.bbox, 4);
  const maskMatrix = multiply(finite(pageTransform, 6), finite(descriptor.matrix, 6)); inverse(maskMatrix);
  const imageMatrix = multiply(maskMatrix, finite(image.matrix, 6)), coverage = regionCoverage(imageMatrix, maskMatrix, bbox);
  inverse(imageMatrix); // Retain finite, invertibility and inverse-range checks.
  const [a, b, c, d, e, f] = imageMatrix, determinant = a * d - b * c;
  const imagePoint = (x, y) => {
    // Subtract the origin before division. Predivided inverse coefficients can
    // bias an exact nearest-cell boundary below its half-open sample interval.
    const dx = x - e, dy = y - f, result = [(d * dx - c * dy) / determinant, (a * dy - b * dx) / determinant];
    if (result.some(n => !Number.isFinite(n))) limit('PDF image-mask geometry exceeds numeric limits.');
    return result;
  };
  const luminosity = values => (1 - values[3]) * (.30 * (1 - values[0]) + .59 * (1 - values[1]) + .11 * (1 - values[2]));
  const outside = clamp(luminosity(backdrop)), mixed = new Array(4);
  return { sampleBand(left, top, columns, rows) {
    cancellation?.();
    if (![left, top, columns, rows, left + columns, top + rows].every(Number.isSafeInteger) || columns < 1 || rows < 1 || columns * rows > 262144) corrupt('Invalid PDF soft-mask sample band.');
    const pixels = columns * rows, work = (surfaceBudget.shadingPixels || 0) + pixels;
    if (!Number.isSafeInteger(work) || work > 64_000_000) limit('PDF shading pixel-work budget exceeded.');
    surfaceBudget.shadingPixels = work; const result = new Float64Array(pixels);
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
      const at = y * columns + x; if (at % 4096 === 0) cancellation?.();
      const q = coverage(left + x, top + y); if (!q) { result[at] = outside; continue; }
      const p = imagePoint(left + x + .5, top + y + .5), sx = Math.max(0, Math.min(width - 1, Math.floor(p[0] * width))), sy = Math.max(0, Math.min(height - 1, Math.floor((1 - p[1]) * height))), gray = samples[sy * width + sx] / 255;
      for (let c = 0; c < 4; c++) mixed[c] = q * (c === 3 ? 1 - gray : 0) + (1 - q) * backdrop[c];
      result[at] = clamp(luminosity(mixed));
    }
    cancellation?.(); return result;
  } };
}
