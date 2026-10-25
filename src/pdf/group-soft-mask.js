// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { decodePdfStream } from './streams.js';
import { iteratePdfContent } from './inline-image.js';
import { resolvePdfColorSpace } from './color-spaces.js';
import { readPdfShading, radialParameter } from './shading.js';
import { compilePdfFunction } from './pdf-functions.js';
import { parseIccProfile } from './icc-color.js';
import { convertPdfColor } from './icc-blend.js';
import { multiply } from './viewport.js';
import { readPdfImageLuminosityArtwork, createPdfImageLuminositySampler } from './image-luminosity-mask.js';

const IDENTITY = [1, 0, 0, 1, 0, 0];
const MAX_MASK_BAND_PIXELS = 262144;
const corrupt = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };
const unsupported = message => { throw new PdfEngineError(message); };
const limit = message => { throw new PdfEngineError(message, 'pdf_limit'); };
const clamp = n => Math.max(0, Math.min(1, n));
const field = (reader, id, key) => { const value = reader.field(id, key); return value && reader.node(value).kind !== 'null' ? value : 0; };
function finiteArray(values, length, label) {
  if (!Array.isArray(values) || values.length !== length || Array.from(values).some(n => typeof n !== 'number' || !Number.isFinite(n))) corrupt(`Invalid PDF soft-mask ${label}.`);
  return values;
}
function numeric(reader, id, key, count, fallback) {
  const value = field(reader, id, key);
  return finiteArray(value ? reader.array(value).map(id => reader.number(id, NaN)) : [...fallback], count, key);
}
function flag(reader, id, key) {
  const value = field(reader, id, key); if (!value) return false;
  const node = reader.node(value); if (node.kind !== 'boolean') corrupt(`Invalid PDF soft-mask ${key} flag.`);
  return node.aux !== 0;
}
function optionalType(reader, id, type) {
  const value = field(reader, id, 'Type'); if (value && reader.name(value) !== type) corrupt(`Invalid PDF soft-mask ${type} Type.`);
}
function restrictFunctions(functions) {
  const pending = [...functions], seen = new Set(); let visits = 0;
  for (let i = 0; i < pending.length; i++) {
    if (++visits > 16384) limit('PDF soft-mask function visit limit exceeded.');
    const fn = pending[i]; if (seen.has(fn)) continue; seen.add(fn);
    if (!fn || ![2, 3].includes(fn.type)) unsupported('This PDF soft-mask function type is not implemented yet.');
    if (fn.functions) pending.push(...fn.functions);
  }
}
function concentricRadial(coords) {
  finiteArray(coords, 6, 'radial coordinates');
  if (coords[2] < 0 || coords[5] < 0) corrupt('Negative PDF soft-mask radial radius.');
  if (coords[0] !== coords[3] || coords[1] !== coords[4] || coords[2] !== 0 || coords[5] <= 0) return false;
  const squared = coords[5] * coords[5];
  if (!Number.isFinite(squared) || squared === 0) limit('PDF soft-mask radial radius exceeds numeric limits.');
  return true;
}
export function createPdfGroupSoftMaskContext(profiles, chargeOperation, admitImage = () => {}) {
  if (!(profiles instanceof Map) || typeof chargeOperation !== 'function' || typeof admitImage !== 'function') corrupt('Invalid PDF soft-mask build context.');
  return { profiles, chargeOperation, admitImage, resources: new Set(), forms: new Map(), images: new Map(), imagePixels: 0, programBytes: 0 };
}
function admit(context, key) {
  if (!context.resources.has(key) && context.resources.size >= 256) limit('PDF soft-mask resource limit exceeded.');
  context.resources.add(key);
}
function maskGraphicsState(reader, id) {
  if (reader.node(id).kind !== 'dictionary') corrupt('Invalid PDF soft-mask ExtGState.');
  optionalType(reader, id, 'ExtGState');
  const allowed = new Set(['Type', 'BM', 'CA', 'ca', 'SMask', 'AIS', 'OP', 'op', 'OPM', 'SA']);
  for (const key of reader.dictionary(id).keys()) if (!allowed.has(key) && field(reader, id, key)) unsupported(`PDF soft-mask ExtGState ${key} is not implemented yet.`);
  for (const key of ['CA', 'ca']) {
    const value = field(reader, id, key); if (!value) continue;
    const n = reader.number(value, NaN); if (!Number.isFinite(n) || n < 0 || n > 1) corrupt('Invalid PDF soft-mask alpha constant.');
    if (n !== 1) unsupported('Non-opaque PDF soft-mask shading is not implemented yet.');
  }
  const blend = field(reader, id, 'BM'); if (blend && !['Normal', 'Compatible'].includes(reader.name(blend))) unsupported('This PDF soft-mask blend mode is not implemented yet.');
  const mask = field(reader, id, 'SMask'); if (mask && reader.name(mask) !== 'None') unsupported('Nested PDF mask artwork is not implemented yet.');
  for (const key of ['AIS', 'OP', 'op', 'SA']) flag(reader, id, key);
  const mode = field(reader, id, 'OPM'); if (mode && ![0, 1].includes(reader.number(mode, NaN))) corrupt('Invalid PDF soft-mask overprint mode.');
}
async function readArtwork(reader, form, resources, loadAsset, context, icc4 = false) {
  const decoded = (await decodePdfStream(reader, form)).bytes;
  if (decoded.length + context.programBytes > 32 * 1024 * 1024) limit('PDF soft-mask program byte limit exceeded.');
  context.programBytes += decoded.length;
  const expected = ['q', 'ri', 'gs', 'cm', 'BX', 'sh', 'EX', 'Q'];
  let step = 0, operands = [], matrix, shading;
  for await (const batch of iteratePdfContent(reader, decoded, resources, loadAsset)) for (const id of batch) {
    reader.check(); context.chargeOperation();
    const node = reader.node(id);
    if (node.kind !== 'operator') {
      if (operands.length >= 6) unsupported('This PDF soft-mask artwork is not implemented yet.');
      operands.push(id); continue;
    }
    const op = reader.text(node);
    if (op !== expected[step++]) unsupported('This PDF soft-mask artwork is not implemented yet.');
    const count = op === 'cm' ? 6 : ['ri', 'gs', 'sh'].includes(op) ? 1 : 0;
    if (operands.length !== count) corrupt('Invalid PDF soft-mask artwork operands.');
    if (op === 'ri' && reader.name(operands[0]) !== 'Perceptual') unsupported('This PDF soft-mask rendering intent is not implemented yet.');
    if (op === 'cm') matrix = finiteArray(operands.map(id => reader.number(id, NaN)), 6, 'shading matrix');
    if (op === 'gs' || op === 'sh') {
      const name = reader.name(operands[0]); if (!name) corrupt('Invalid PDF soft-mask resource name.');
      const dictionary = field(reader, resources, op === 'gs' ? 'ExtGState' : 'Shading');
      const target = dictionary && field(reader, dictionary, name); if (!target) corrupt('Missing PDF soft-mask resource.');
      if (op === 'gs') {
        maskGraphicsState(reader, target);
        if (icc4 && ['AIS', 'OP', 'op'].some(key => flag(reader, target, key))) unsupported('This PDF ICC4 luminosity mask source is not implemented.');
      }
      else shading = await readPdfShading(reader, target, resources, loadAsset, context.profiles);
    }
    operands = [];
  }
  if (step !== expected.length || operands.length) corrupt('Incomplete PDF soft-mask artwork.');
  if (icc4 && (shading.type !== 2 || shading.box || !shading.extend.every(Boolean))) unsupported('PDF ICC4 luminosity masks require extended opaque axial artwork.');
  if (shading.type !== 2 && !(shading.type === 3 && concentricRadial(shading.coords))
    || shading.box || !shading.extend.every(Boolean)) unsupported('This PDF soft-mask shading geometry is not implemented yet.');
  if (!['DeviceGray', 'ICCBased'].includes(shading.colorSpace.name)) unsupported('This PDF soft-mask source colour space is not implemented yet.');
  if (icc4 && shading.colorSpace.name !== 'DeviceGray') unsupported('This PDF ICC4 luminosity mask source is not implemented.');
  if (shading.colorSpace.name === 'ICCBased') {
    const source = [...context.profiles.values()].find(entry => entry.space.profileBytes === shading.colorSpace.profileBytes)?.space;
    if (source?.components !== 3) unsupported('This PDF soft-mask source colour space is not implemented yet.');
  }
  if (icc4) assertIcc4MaskFunctions(shading.functions); else restrictFunctions(shading.functions);
  return { ...shading, matrix };
}

/** Strict single opaque axial/concentric-radial paint, not a general artwork interpreter. */
export async function readPdfGroupSoftMask(reader, id, resources, loadAsset, ctm, context, depth = 0) {
  if (depth > 16) limit('PDF Form nesting limit exceeded.');
  if (reader.node(id).kind !== 'dictionary') corrupt('Invalid PDF soft-mask dictionary.');
  optionalType(reader, id, 'Mask'); admit(context, `mask:${reader.node(id).id}`);
  const subtype = field(reader, id, 'S'); if (!subtype || reader.node(subtype).kind !== 'name') corrupt('Invalid PDF soft-mask subtype.');
  if (reader.name(subtype) !== 'Luminosity') unsupported('This PDF soft-mask subtype is not implemented yet.');
  const transfer = field(reader, id, 'TR'); if (transfer && reader.name(transfer) !== 'Identity') unsupported('PDF soft-mask transfer functions are not implemented yet.');
  const form = field(reader, id, 'G');
  if (!form || reader.node(form).kind !== 'stream' || reader.name(field(reader, form, 'Subtype')) !== 'Form') corrupt('Invalid PDF soft-mask group Form.');
  optionalType(reader, form, 'XObject'); admit(context, `form:${reader.node(form).id}`);
  const formResources = field(reader, form, 'Resources') || resources, key = `${reader.node(form).id}:${formResources ? reader.node(formResources).id : 0}`;
  let cached = context.forms.get(key);
  if (!cached) {
    if (context.forms.size >= 256) limit('PDF soft-mask resource context limit exceeded.');
    const group = field(reader, form, 'Group');
    if (!group || reader.node(group).kind !== 'dictionary') corrupt('Invalid PDF soft-mask transparency group.');
    optionalType(reader, group, 'Group');
    if (reader.name(field(reader, group, 'S')) !== 'Transparency') corrupt('Invalid PDF soft-mask group subtype.');
    flag(reader, group, 'I'); if (flag(reader, group, 'K')) unsupported('Knockout PDF soft-mask groups are not implemented yet.');
    const cs = field(reader, group, 'CS'); if (!cs) corrupt('PDF luminosity mask requires a group colour space.');
    const space = await resolvePdfColorSpace(reader, formResources, cs, loadAsset, 0, context.profiles);
    const bbox = numeric(reader, form, 'BBox', 4, []), matrix = numeric(reader, form, 'Matrix', 6, IDENTITY);
    if (space.name === 'DeviceCMYK' && space.components === 4) {
      numeric(reader, id, 'BC', 4, [0, 0, 0, 1]);
      const deviceImage = await readPdfImageLuminosityArtwork(reader, form, formResources, loadAsset, context, id => {
        maskGraphicsState(reader, id);
        if (!field(reader, id, 'OP') || !field(reader, id, 'op') || flag(reader, id, 'OP') || flag(reader, id, 'op')) unsupported('PDF image-mask artwork must explicitly disable overprinting.');
      });
      cached = { deviceImage, bbox, matrix };
    } else {
      const icc4 = space.name === 'ICCBased' && space.components === 4;
      if (icc4 && typeof space.profile.fromXyz !== 'function') unsupported('PDF ICC4 luminosity masks require an explicit supported profile inverse.');
      if (!icc4 && (space.name !== 'ICCBased' || space.components !== 3 || typeof space.profile.fromXyz !== 'function')) unsupported('This PDF soft-mask blend colour space is not implemented yet.');
      const shading = await readArtwork(reader, form, formResources, loadAsset, context, icc4);
      cached = { profileBytes: space.profileBytes, bbox, matrix, shading, icc4 };
    }
    context.forms.set(key, cached);
  }
  const unresolved = cached.icc4 && !field(reader, id, 'BC');
  const backdrop = unresolved ? null : numeric(reader, id, 'BC', cached.deviceImage || cached.icc4 ? 4 : 3, cached.deviceImage ? [0, 0, 0, 1] : [0, 0, 0]).map(clamp);
  return { type: 'Luminosity', ...(cached.deviceImage ? { deviceImage: cached.deviceImage } : { profileBytes: cached.profileBytes, shading: cached.shading }), backdrop, bbox: cached.bbox,
    ...(cached.icc4 ? { nativeColorSpace: 'ICCBased4', backdropUnresolved: unresolved } : {}),
    matrix: multiply(finiteArray(ctm, 6, 'captured matrix'), cached.matrix) };
}

function inverse(matrix) {
  finiteArray(matrix, 6, 'matrix');
  const [a, b, c, d, e, f] = matrix, determinant = a * d - b * c;
  if (!Number.isFinite(determinant)) limit('PDF soft-mask transform exceeds numeric limits.');
  if (!determinant) unsupported('Singular PDF soft-mask transforms are not implemented yet.');
  const result = [d / determinant, -b / determinant, -c / determinant, a / determinant, (c * f - d * e) / determinant, (b * e - a * f) / determinant];
  if (result.some(n => !Number.isFinite(n))) limit('PDF soft-mask inverse exceeds numeric limits.');
  return result;
}
const point = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
function bboxCoverage(matrix, bbox) {
  const l = Math.min(bbox[0], bbox[2]), r = Math.max(bbox[0], bbox[2]), b = Math.min(bbox[1], bbox[3]), t = Math.max(bbox[1], bbox[3]);
  const polygon = [[l, b], [r, b], [r, t], [l, t]].map(([x, y]) => point(matrix, x, y));
  if (polygon.flat().some(n => !Number.isFinite(n))) limit('PDF soft-mask bounds exceed numeric limits.');
  const sign = Math.sign(matrix[0] * matrix[3] - matrix[1] * matrix[2]), edges = polygon.map((p, i) => {
    const q = polygon[(i + 1) % 4], a = (p[1] - q[1]) * sign, b = (q[0] - p[0]) * sign, c = -a * p[0] - b * p[1];
    if (![a, b, c].every(Number.isFinite)) limit('PDF soft-mask bounds exceed numeric limits.');
    return [a, b, c];
  });
  return (x, y) => {
    let full = true;
    for (const [a, b, c] of edges) {
      const v = a * x + b * y + c; if (!Number.isFinite(v)) limit('PDF soft-mask coverage exceeds numeric limits.');
      if (v + Math.max(0, a) + Math.max(0, b) <= 0) return 0;
      if (v + Math.min(0, a) + Math.min(0, b) < 0) full = false;
    }
    if (full) return l === r || b === t ? 0 : 1;
    let clipped = polygon.map(p => [p[0] - x, p[1] - y]);
    for (const [axis, bound, greater] of [[0, 0, true], [0, 1, false], [1, 0, true], [1, 1, false]]) {
      const next = []; if (!clipped.length) return 0;
      let previous = clipped.at(-1);
      for (const current of clipped) {
        const pi = greater ? previous[axis] >= bound : previous[axis] <= bound, ci = greater ? current[axis] >= bound : current[axis] <= bound;
        if (pi !== ci) { const f = (bound - previous[axis]) / (current[axis] - previous[axis]); next.push(previous.map((n, i) => n + f * (current[i] - n))); }
        if (ci) next.push(current); previous = current;
      }
      clipped = next;
    }
    let area = 0; for (let i = 0; i < clipped.length; i++) { const p = clipped[i], q = clipped[(i + 1) % clipped.length]; area += p[0] * q[1] - p[1] * q[0]; }
    if (!Number.isFinite(area)) limit('PDF soft-mask coverage exceeds numeric limits.');
    return clamp(Math.abs(area) / 2);
  };
}

function luminosityGraySpace(profile) {
  // Device-to-CIE policy for uncalibrated mask artwork only: gray denotes Y.
  // Normalize the group's encoded-white chromaticity; the inverse still clips
  // to the actual profile gamut before encoded BC compositing and final Y.
  const white = finiteArray(profile.toXyz(profile.channels === 4 ? [0, 0, 0, 0] : [1, 1, 1]), 3, 'group white');
  if (white[1] <= 0) corrupt('Invalid PDF soft-mask group white luminance.');
  const direction = finiteArray(white.map(n => n / white[1]), 3, 'neutral direction');
  return { components: 1, toXyz: values => direction.map(n => n * clamp(values[0])) };
}

function assertIcc4MaskFunctions(functions) {
  const active = new Set(); let visits = 0, nodes = 0; const seen = new Set();
  const dense = (array, count) => finiteArray(array, count, 'ICC4 function array');
  const visit = (fn, depth) => {
    if (++visits > 16384 || depth > 16 || !seen.has(fn) && ++nodes > 4096) limit('PDF soft-mask function visit limit exceeded.');
    if (!fn || typeof fn !== 'object' || active.has(fn)) corrupt('Invalid PDF ICC4 luminosity mask descriptor.');
    if (![2, 3].includes(fn.type)) unsupported('PDF ICC4 luminosity masks support only Type 2/3 functions.');
    dense(fn.domain, 2); if (fn.domain[1] < fn.domain[0]) corrupt('Invalid PDF ICC4 luminosity mask descriptor.');
    if (fn.range !== null && fn.range !== undefined) { dense(fn.range, 2); if (fn.range[1] < fn.range[0]) corrupt('Invalid PDF ICC4 luminosity mask descriptor.'); }
    if (fn.inputs !== 1 || fn.outputs !== 1) corrupt('Invalid PDF ICC4 luminosity mask descriptor.');
    if (fn.type === 2) { dense(fn.c0, 1); dense(fn.c1, 1); if (!Number.isFinite(fn.exponent)) corrupt('Invalid PDF ICC4 luminosity mask descriptor.'); }
    else {
      if (!Array.isArray(fn.functions) || !fn.functions.length || fn.functions.length > 256) corrupt('Invalid PDF ICC4 luminosity mask descriptor.');
      dense(fn.bounds, fn.functions.length - 1); dense(fn.encode, fn.functions.length * 2);
      if (fn.functions.length > 1 && fn.domain[0] === fn.domain[1]
        || fn.bounds.some((n, i) => n < fn.domain[0] || n > fn.domain[1] || i > 0 && n <= fn.bounds[i - 1])) corrupt('Invalid PDF ICC4 luminosity mask descriptor.');
      active.add(fn); for (const child of Array.from(fn.functions)) visit(child, depth + 1); active.delete(fn);
    }
    seen.add(fn);
  };
  if (!Array.isArray(functions) || functions.length !== 1) corrupt('Invalid PDF ICC4 luminosity mask descriptor.');
  visit(functions[0], 0);
}

/** Absent BC is unresolved, not replaced with a fabricated device/ICC black.
 * An opaque extended axial paint erases any initial backdrop only when its
 * transformed BBox strictly contains every requested pixel square plus margin.
 */
function icc4MaskExtent(maskMatrix, bbox, extent) {
  const reject = () => unsupported('A PDF ICC4 luminosity mask without BC must cover the complete device extent.');
  if (!Array.isArray(extent) || extent.length !== 4 || Array.from(extent).some(n => !Number.isSafeInteger(n)) || extent[2] <= extent[0] || extent[3] <= extent[1]) reject();
  const local = inverse(maskMatrix), l = Math.min(bbox[0], bbox[2]), r = Math.max(bbox[0], bbox[2]), b = Math.min(bbox[1], bbox[3]), t = Math.max(bbox[1], bbox[3]);
  for (const [x, y] of [[extent[0] - 2, extent[1] - 2], [extent[2] + 2, extent[1] - 2], [extent[2] + 2, extent[3] + 2], [extent[0] - 2, extent[3] + 2]]) {
    const p = point(local, x, y);
    if (!p.every(Number.isFinite) || p[0] <= l || p[0] >= r || p[1] <= b || p[1] >= t) reject();
  }
}

function createIcc4MaskSampler(descriptor, { pageTransform, deviceExtent, profileCache, surfaceBudget, cancellation }) {
  cancellation?.();
  if (descriptor.type !== 'Luminosity' || !(descriptor.profileBytes instanceof Uint8Array) || typeof descriptor.backdropUnresolved !== 'boolean') corrupt('Invalid PDF ICC4 luminosity mask descriptor.');
  if (!profileCache.has(descriptor.profileBytes)) profileCache.set(descriptor.profileBytes, parseIccProfile(descriptor.profileBytes));
  const profile = profileCache.get(descriptor.profileBytes);
  if (profile.channels !== 4 || typeof profile.fromXyz !== 'function') unsupported('PDF ICC4 luminosity masks require an explicit supported profile inverse.');
  const unresolved = descriptor.backdropUnresolved;
  if (unresolved && descriptor.backdrop !== null) corrupt('Invalid PDF ICC4 luminosity mask descriptor.');
  const backdrop = unresolved ? null : finiteArray(descriptor.backdrop, 4, 'ICC4 backdrop').map(clamp);
  const bbox = finiteArray(descriptor.bbox, 4, 'ICC4 bounds');
  const basis = multiply(finiteArray(pageTransform, 6, 'page transform'), finiteArray(descriptor.matrix, 6, 'captured matrix'));
  inverse(basis);
  for (const [x, y] of [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]]) {
    if (!point(basis, x, y).every(Number.isFinite)) corrupt('Invalid PDF ICC4 luminosity mask descriptor.');
  }
  const shading = descriptor.shading;
  if (!shading || shading.type !== 2 || shading.box || !Array.isArray(shading.extend) || shading.extend.length !== 2 || Array.from(shading.extend).some(n => n !== true)) unsupported('PDF ICC4 luminosity masks require extended opaque axial artwork.');
  if (shading.colorSpace?.name !== 'DeviceGray' || shading.colorSpace.components !== undefined && shading.colorSpace.components !== 1) unsupported('This PDF ICC4 luminosity mask source is not implemented.');
  const coords = finiteArray(shading.coords, 4, 'ICC4 shading coordinates'), domain = finiteArray(shading.domain, 2, 'ICC4 shading domain');
  const shadingInverse = inverse(multiply(basis, finiteArray(shading.matrix, 6, 'ICC4 shading matrix')));
  const dx = coords[2] - coords[0], dy = coords[3] - coords[1], denominator = dx * dx + dy * dy;
  if (!denominator || !Number.isFinite(denominator)) corrupt('Invalid PDF ICC4 luminosity mask descriptor.');
  assertIcc4MaskFunctions(shading.functions);
  if (shading.functions[0].domain[0] > Math.min(...domain) || shading.functions[0].domain[1] < Math.max(...domain)) corrupt('Invalid PDF ICC4 luminosity mask descriptor.');
  const fn = compilePdfFunction(shading.functions[0]);
  cancellation?.();
  if (unresolved) icc4MaskExtent(basis, bbox, deviceExtent);
  const coverage = unresolved ? null : bboxCoverage(basis, bbox), space = luminosityGraySpace(profile);
  const backdropY = backdrop ? clamp(finiteArray(profile.toXyz(backdrop), 3, 'ICC4 backdrop PCS')[1]) : null, input = [0], output = [0], mixed = [0, 0, 0, 0];
  return { sampleBand(left, top, width, height) {
    cancellation?.(); const pixels = width * height;
    if (![left, top, width, height, left + width, top + height, pixels].every(Number.isSafeInteger) || width < 1 || height < 1 || pixels > MAX_MASK_BAND_PIXELS) corrupt('Invalid PDF soft-mask sample band.');
    if (unresolved && (left < deviceExtent[0] || top < deviceExtent[1] || left + width > deviceExtent[2] || top + height > deviceExtent[3])) unsupported('A PDF ICC4 luminosity mask without BC must cover the complete device extent.');
    const work = (surfaceBudget.shadingPixels ?? 0) + pixels;
    if (!Number.isSafeInteger(surfaceBudget.shadingPixels ?? 0) || (surfaceBudget.shadingPixels ?? 0) < 0 || !Number.isSafeInteger(work) || work > 64_000_000) limit('PDF shading pixel-work budget exceeded.');
    surfaceBudget.shadingPixels = work;
    // The native group owner reserves and releases2 live units per Float64
    // band before invoking this sampler. No full-page mask plane is retained.
    const result = new Float64Array(pixels);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const at = y * width + x; if (at % 4096 === 0) cancellation?.();
      const q = unresolved ? 1 : coverage(left + x, top + y);
      if (!q) { result[at] = backdropY; continue; }
      const p = point(shadingInverse, left + x + .5, top + y + .5), parameter = ((p[0] - coords[0]) * dx + (p[1] - coords[1]) * dy) / denominator;
      if (!Number.isFinite(parameter)) limit('PDF soft-mask parameter exceeds numeric limits.');
      input[0] = domain[0] + clamp(parameter) * (domain[1] - domain[0]);
      if (!Number.isFinite(input[0])) limit('PDF soft-mask parameter exceeds numeric limits.');
      fn(input, output); if (!Number.isFinite(output[0])) corrupt('Invalid PDF ICC4 luminosity mask descriptor.');
      const encoded = finiteArray(profile.fromXyz(space.toXyz([clamp(output[0])])), 4, 'ICC4 encoded colour').map(clamp);
      for (let c = 0; c < 4; c++) mixed[c] = unresolved ? encoded[c] : q * encoded[c] + (1 - q) * backdrop[c];
      const luminosity = finiteArray(profile.toXyz(mixed), 3, 'ICC4 luminosity PCS')[1];
      result[at] = clamp(luminosity);
    }
    cancellation?.(); return result;
  } };
}

/** Scalar samples remain in native mask ICC/PCS; no display-RGB intermediate. */
export function createPdfGroupSoftMaskSampler(descriptor, { pageTransform = IDENTITY, deviceExtent = null, profileCache = new WeakMap(), surfaceBudget = { pixels: 0 }, cancellation } = {}) {
  if (descriptor?.nativeColorSpace === 'ICCBased4') return createIcc4MaskSampler(descriptor, { pageTransform, deviceExtent, profileCache, surfaceBudget, cancellation });
  if (descriptor?.deviceImage) return createPdfImageLuminositySampler(descriptor, { pageTransform, surfaceBudget, cancellation });
  cancellation?.();
  if (descriptor?.type !== 'Luminosity' || !(descriptor.profileBytes instanceof Uint8Array)) corrupt('Invalid PDF luminosity mask descriptor.');
  const profileOf = bytes => { if (!profileCache.has(bytes)) profileCache.set(bytes, parseIccProfile(bytes)); return profileCache.get(bytes); };
  const profile = profileOf(descriptor.profileBytes);
  if (profile.channels !== 3 || typeof profile.fromXyz !== 'function') unsupported('This PDF soft-mask blend colour space is not implemented yet.');
  const backdrop = finiteArray(descriptor.backdrop, 3, 'backdrop').map(clamp), bbox = finiteArray(descriptor.bbox, 4, 'bounds');
  const maskMatrix = multiply(finiteArray(pageTransform, 6, 'page transform'), finiteArray(descriptor.matrix, 6, 'captured matrix'));
  inverse(maskMatrix);
  const coverage = bboxCoverage(maskMatrix, bbox), shading = descriptor.shading;
  if (!shading || ![2, 3].includes(shading.type) || shading.box || !Array.isArray(shading.extend) || shading.extend.length !== 2 || !shading.extend.every(n => n === true)) corrupt('Invalid PDF soft-mask shading descriptor.');
  const radial = shading.type === 3;
  const coords = finiteArray(shading.coords, radial ? 6 : 4, 'shading coordinates'), domain = finiteArray(shading.domain, 2, 'shading domain');
  if (radial && !concentricRadial(coords)) unsupported('This PDF soft-mask radial geometry is not implemented yet.');
  const shadingInverse = inverse(multiply(maskMatrix, finiteArray(shading.matrix, 6, 'shading matrix')));
  let parameterAt;
  if (radial) parameterAt = radialParameter(coords, shading.extend);
  else {
    const dx = coords[2] - coords[0], dy = coords[3] - coords[1], denominator = dx * dx + dy * dy;
    if (!denominator || !Number.isFinite(denominator)) corrupt('Invalid PDF soft-mask shading axis.');
    parameterAt = (x, y) => ((x - coords[0]) * dx + (y - coords[1]) * dy) / denominator;
  }
  const space = shading.colorSpace?.name === 'DeviceGray' ? luminosityGraySpace(profile)
    : shading.colorSpace?.name === 'ICCBased' && shading.colorSpace.profileBytes instanceof Uint8Array ? profileOf(shading.colorSpace.profileBytes) : null;
  if (!space || shading.colorSpace.name === 'ICCBased' && space.channels !== 3) unsupported('This PDF soft-mask source colour space is not implemented yet.');
  if (!Array.isArray(shading.functions) || !shading.functions.length || shading.functions.length > 3) corrupt('Invalid PDF soft-mask shading functions.');
  restrictFunctions(shading.functions);
  const functions = shading.functions.map(compilePdfFunction), channels = space.channels ?? space.components;
  if (functions.some(fn => fn.inputs !== 1) || (functions.length === 1 ? functions[0].outputs !== channels : functions.length !== channels || functions.some(fn => fn.outputs !== 1))) corrupt('PDF soft-mask shading dimensions disagree.');
  const input = [0], values = new Array(channels), single = [0], mixed = new Array(3);
  const backdropY = clamp(profile.toXyz(backdrop)[1]);
  return { sampleBand(left, top, width, height) {
    cancellation?.();
    if (![left, top, width, height, left + width, top + height].every(Number.isSafeInteger) || width < 1 || height < 1 || width * height > MAX_MASK_BAND_PIXELS) corrupt('Invalid PDF soft-mask sample band.');
    const pixels = width * height;
    if ((surfaceBudget.shadingPixels || 0) + pixels > 64_000_000) limit('PDF shading pixel-work budget exceeded.');
    surfaceBudget.shadingPixels = (surfaceBudget.shadingPixels || 0) + pixels;
    const result = new Float64Array(pixels);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const at = y * width + x; if (at % 4096 === 0) cancellation?.();
      const q = coverage(left + x, top + y);
      if (!q) { result[at] = backdropY; continue; }
      const p = point(shadingInverse, left + x + .5, top + y + .5), parameter = parameterAt(p[0], p[1]);
      if (!Number.isFinite(parameter)) limit('PDF soft-mask parameter exceeds numeric limits.');
      input[0] = domain[0] + clamp(parameter) * (domain[1] - domain[0]);
      if (functions.length === 1) functions[0](input, values); else functions.forEach((fn, i) => { fn(input, single); values[i] = single[0]; });
      const encoded = convertPdfColor(space, values.map(clamp), profile);
      for (let c = 0; c < 3; c++) mixed[c] = q * encoded[c] + (1 - q) * backdrop[c];
      const luminosity = profile.toXyz(mixed)[1]; if (!Number.isFinite(luminosity)) corrupt('Non-finite PDF soft-mask luminosity.');
      result[at] = clamp(luminosity);
    }
    cancellation?.(); return result;
  } };
}
