// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { MAX_IMAGE_PIXELS, MAX_IMAGE_SAMPLE_BYTES, MAX_IMAGE_BAND_PIXELS, pdfImageSampleBytes } from './image-limits.js';
import { multiply } from './viewport.js';
const corrupt = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };
const unsupported = message => { throw new PdfEngineError(message); };
const limit = message => { throw new PdfEngineError(message, 'pdf_limit'); };
const sourceBudgets = new WeakSet();

/** One build owns all retained native image sources, including decoder copy peaks. */
export function createPdfNativeImageSourceBudget() {
  let bytes = 0, pixels = 0, peakBytes = 0, closed = false;
  const pending = new Set(), images = new Map(), buffers = new Map();
  const budget = {
    get bytes() { return bytes; }, get pixels() { return pixels; }, get peakBytes() { return peakBytes; },
    reserve(retained, peak, count) {
      if (closed) throw new PdfEngineError('Native PDF image source owner has been released.', 'pdf_closed');
      if (![retained, peak, count].every(Number.isSafeInteger) || retained < 0 || peak < retained || count < 1) corrupt('Invalid native PDF image source reservation.');
      if (bytes + peak > MAX_IMAGE_SAMPLE_BYTES || pixels + count > MAX_IMAGE_PIXELS) limit('PDF native image source budget exceeded.');
      bytes += peak; pixels += count; peakBytes = Math.max(peakBytes, bytes); let active = true;
      const lease = {
        rollback() { if (active) { active = false; bytes -= peak; pixels -= count; pending.delete(lease); } },
        commit(image) {
          if (!active || !image || typeof image !== 'object' || images.has(image)) corrupt('Invalid native PDF image source commit.');
          const owned = new Set([image.bytes?.buffer, image.softMask?.bytes?.buffer].filter(Boolean));
          let added = 0; for (const buffer of owned) { if (!(buffer instanceof ArrayBuffer)) corrupt('Native PDF image samples must be owned buffers.'); if (!buffers.has(buffer)) added += buffer.byteLength; }
          if (added > retained) corrupt('Native PDF image source exceeded its reservation.');
          bytes -= peak - added; active = false; pending.delete(lease);
          for (const buffer of owned) { const entry = buffers.get(buffer); if (entry) entry.references++; else buffers.set(buffer, { references: 1, bytes: buffer.byteLength }); }
          images.set(image, { owned, count }); return image;
        },
      };
      pending.add(lease); return lease;
    },
    release(image) {
      const entry = images.get(image); if (!entry) return;
      for (const buffer of entry.owned) { const owned = buffers.get(buffer); if (!--owned.references) { buffers.delete(buffer); bytes -= owned.bytes; } }
      pixels -= entry.count; images.delete(image);
    },
    destroy() { for (const lease of [...pending]) lease.rollback(); for (const image of [...images.keys()]) budget.release(image); closed = true; },
  };
  sourceBudgets.add(budget); return budget;
}

const optional = (reader, id, name) => { const value = reader.field(id, name); return value && reader.node(value).kind !== 'null' ? value : 0; };
function flag(reader, id, name) {
  const value = optional(reader, id, name); if (!value) return false;
  const node = reader.node(value); if (node.kind !== 'boolean') corrupt(`Invalid native PDF image ${name}.`); return !!node.aux;
}
function defaultDecode(reader, id, components) {
  const value = optional(reader, id, 'Decode'); if (!value) return;
  const values = reader.array(value).map(value => reader.number(value, NaN));
  if (values.length !== components * 2 || values.some(value => !Number.isFinite(value))) corrupt('Invalid PDF image Decode array.');
  if (values.some((value, i) => value !== i % 2)) unsupported('Native PDF images with nondefault Decode are not implemented yet.');
}
function imageHeader(reader, id, components, filters, resolvedIcc4 = false) {
  if (reader.node(id).kind !== 'stream') corrupt('Native PDF image must be a stream.');
  const type = optional(reader, id, 'Type'); if (type && reader.name(type) !== 'XObject') corrupt('Invalid native PDF image Type.');
  if (reader.name(reader.field(id, 'Subtype')) !== 'Image') corrupt('Invalid native PDF image Subtype.');
  const width = reader.number(reader.field(id, 'Width'), NaN), height = reader.number(reader.field(id, 'Height'), NaN);
  const bytes = pdfImageSampleBytes(width, height, components, 8);
  const filter = reader.name(reader.field(id, 'Filter'));
  if (reader.number(reader.field(id, 'BitsPerComponent'), NaN) !== 8 || !resolvedIcc4 && reader.name(reader.field(id, 'ColorSpace')) !== ({ 4: 'DeviceCMYK', 3: 'DeviceRGB', 1: 'DeviceGray' })[components]
    || !filters.includes(filter)) unsupported('This native PDF image source format is not implemented yet.');
  if (flag(reader, id, 'ImageMask') || flag(reader, id, 'Interpolate') || optional(reader, id, 'Matte') || optional(reader, id, 'SMaskInData')) unsupported('This native PDF image opacity or interpolation format is not implemented yet.');
  defaultDecode(reader, id, components);
  let parameters = optional(reader, id, 'DecodeParms');
  if (parameters && reader.node(parameters).kind === 'array') parameters = reader.array(parameters)[0];
  const transform = parameters && reader.node(parameters).kind !== 'null' && optional(reader, parameters, 'ColorTransform');
  // A PDF ColorTransform may insert one16-byte APP14 marker before RGB decoding.
  const expansion = components === 3 && filter === 'DCTDecode' && transform ? 16 : 0;
  return { width, height, bytes, encodedBytes: reader.node(id).length, filter, components, expansion };
}

/** Reuse the validated image-data plane decoder; no second codec or RGB image exists. */
export function readPdfNativeCmykImage(reader, id, options, plane) {
  return readPdfNativeImageSource(reader, id, options, plane, 'DeviceCMYK');
}

export function readPdfNativeIcc4Image(reader, id, options, plane) {
  return readPdfNativeImageSource(reader, id, options, plane, 'ICCBased');
}

/** Fixed source layouts share one ownership/plane pipeline; arbitrary spaces stay closed. */
export async function readPdfNativeImageSource(reader, id, { resources, sourceBudget, nativeIcc4 }, plane, name) {
  if (!sourceBudgets.has(sourceBudget)) throw new PdfEngineError('Native PDF images require a shared source owner.', 'pdf_configuration');
  const calibrated = name === 'ICCBased';
  if (calibrated && (nativeIcc4?.name !== 'ICCBased' || nativeIcc4.components !== 4 || !(nativeIcc4.profileBytes instanceof Uint8Array))) corrupt('Invalid native PDF ICC4 image target.');
  const components = name === 'DeviceCMYK' || calibrated ? 4 : name === 'DeviceRGB' ? 3 : 0;
  if (!components) unsupported('This native PDF image source colour space is not implemented yet.');
  const spaces = optional(reader, resources, 'ColorSpace');
  if (!calibrated && spaces && ['DefaultCMYK', 'DefaultGray', 'DefaultRGB'].some(name => optional(reader, spaces, name))) unsupported('Native PDF image default colour-space overrides are not implemented yet.');
  const baseInfo = imageHeader(reader, id, components, calibrated ? ['FlateDecode'] : ['DCTDecode', 'FlateDecode'], calibrated), maskId = optional(reader, id, 'Mask'), softId = optional(reader, id, 'SMask');
  if (calibrated && softId) unsupported('Elementary ICC4 image soft masks are not implemented.');
  if (maskId && softId) corrupt('PDF image declares both Mask and SMask.');
  if (maskId) unsupported('Native PDF image masks other than gray soft masks are not implemented yet.');
  let maskInfo = null;
  if (softId) {
    maskInfo = imageHeader(reader, softId, 1, ['FlateDecode']);
    if (optional(reader, softId, 'Mask') || optional(reader, softId, 'SMask')) corrupt('Nested image masks are not allowed.');
    if (maskInfo.width !== baseInfo.width || maskInfo.height !== baseInfo.height) unsupported('Native PDF image soft masks must have matching dimensions.');
  }
  const retained = baseInfo.bytes + (maskInfo?.bytes || 0);
  // Flate owns the encoded copy and Blob snapshot, an exact-capacity inflate
  // output plus one bounded read/copy overlap. PNG predictors use at most one
  // extra byte per row; reserve that capacity before inspecting the stream.
  // Native JPEG scratch keeps its existing separate bounded WASM contract.
  const overlap = info => {
    if (info.filter === 'FlateDecode') return 2 * info.encodedBytes + 2 * (info.bytes + info.height);
    if (info.components === 3) {
      const pixels = info.width * info.height, rows = Math.max(1, Math.min(info.height, Math.floor(MAX_IMAGE_BAND_PIXELS / info.width)));
      // Browser RGB decoding owns an RGBA bitmap, RGBA band Canvas and its
      // readback, plus encoded reader/Blob copies. RGB samples are in retained.
      return pixels * 4 + info.width * rows * 8 + (info.encodedBytes + info.expansion) * 2;
    }
    return info.bytes + info.encodedBytes;
  };
  const peak = retained + Math.max(overlap(baseInfo), maskInfo ? overlap(maskInfo) : 0);
  const lease = sourceBudget.reserve(retained, peak, baseInfo.width * baseInfo.height);
  try {
    const base = await plane(id, false, components === 3), mask = softId ? await plane(softId, 'soft') : null; reader.check();
    if (calibrated && (base.space.name !== 'ICCBased' || base.space.profileBytes !== nativeIcc4.profileBytes)) unsupported('Native ICC4 image source and target profiles must match exactly.');
    for (const [value, info, channels] of [[base, baseInfo, components], ...(mask ? [[mask, maskInfo, 1]] : [])]) {
      if (value.format !== 'raw' || value.bits !== 8 || value.space.components !== channels || value.bytes.length !== info.bytes
        || !(value.bytes instanceof Uint8Array) || value.bytes.buffer === reader.api.memory.buffer) corrupt('Invalid owned native PDF image samples.');
      // PNG predictors compact in place and return a subarray. Retain exactly
      // the validated samples, with no hidden predictor rows in its owner.
      if (value.bytes.byteOffset || value.bytes.buffer.byteLength !== info.bytes) value.bytes = value.bytes.slice();
    }
    return lease.commit({ format: calibrated ? 'native-icc4' : components === 3 ? 'native-rgb' : 'native-cmyk', width: baseInfo.width, height: baseInfo.height, bits: 8, components,
      colorSpace: { name, components, ...(calibrated ? { profileBytes: nativeIcc4.profileBytes } : {}) }, bytes: base.bytes, interpolate: false,
      softMask: mask ? { width: maskInfo.width, height: maskInfo.height, bits: 8, components: 1, bytes: mask.bytes } : null });
  } finally { lease.rollback(); }
}

function descriptor(image) {
  const calibrated = image?.format === 'native-icc4';
  const components = image?.format === 'native-rgb' ? 3 : image?.format === 'native-cmyk' || calibrated ? 4 : 0;
  if (!components || image.bits !== 8 || image.components !== components || image.colorSpace?.name !== (calibrated ? 'ICCBased' : components === 3 ? 'DeviceRGB' : 'DeviceCMYK') || image.colorSpace.components !== components
    || calibrated && (!(image.colorSpace.profileBytes instanceof Uint8Array) || !image.colorSpace.profileBytes.byteLength || image.softMask)
    || image.interpolate !== false || !(image.bytes instanceof Uint8Array) || !(image.bytes.buffer instanceof ArrayBuffer)
    || image.bytes.length !== pdfImageSampleBytes(image.width, image.height, components, 8)) corrupt('Invalid native PDF image descriptor.');
  if (image.softMask !== null && image.softMask !== undefined && (!image.softMask || typeof image.softMask !== 'object')) corrupt('Invalid native PDF image soft-mask descriptor.');
  if (image.softMask) {
    const mask = image.softMask;
    if (mask.width !== image.width || mask.height !== image.height || mask.bits !== 8 || mask.components !== 1 || !(mask.bytes instanceof Uint8Array) || !(mask.bytes.buffer instanceof ArrayBuffer)
      || mask.bytes.length !== image.width * image.height) corrupt('Invalid native PDF image soft-mask descriptor.');
  }
  return components;
}
function matrix(values) { if (!Array.isArray(values) || values.length !== 6 || Array.from(values).some(value => !Number.isFinite(value))) corrupt('Invalid native PDF image transform.'); }

/** Native encoded samples are edge-padded; caller applies the image-quad coverage once. */
export function createPdfNativeCmykImageSampler(image, { imageMatrix, pageTransform, surfaceBudget, cancellation = () => {} } = {}) {
  const components = descriptor(image);
  matrix(imageMatrix); matrix(pageTransform);
  if (!surfaceBudget || !Number.isSafeInteger(surfaceBudget.pixels) || surfaceBudget.pixels < 0 || typeof cancellation !== 'function') corrupt('Invalid native PDF image sampling owner.');
  const basis = multiply(pageTransform, imageMatrix), [a, b, c, d, e, f] = basis, determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || determinant === 0 || basis.some(value => !Number.isFinite(value))) corrupt('Invalid native PDF image transform.');
  const inverse = [d / determinant, -b / determinant, -c / determinant, a / determinant];
  if (inverse.some(value => !Number.isFinite(value))) corrupt('Invalid native PDF image inverse transform.');
  let band = null, closed = false;
  return {
    sampleBand(left, top, width, height) {
      if (closed) throw new PdfEngineError('Native PDF image sampler has been released.', 'pdf_closed');
      if (band) corrupt('Release the previous native PDF image band before sampling.');
      const pixels = width * height, units = pixels * 5, work = (surfaceBudget.shadingPixels ?? 0) + pixels;
      if (![left, top, width, height, pixels, units].every(Number.isSafeInteger) || left < 0 || top < 0 || width < 1 || height < 1) corrupt('Invalid native PDF image band.');
      if (pixels > 262144 || surfaceBudget.pixels + units > 16_000_000 || !Number.isSafeInteger(work) || work > 64_000_000
        || !Number.isSafeInteger(surfaceBudget.shadingPixels ?? 0) || (surfaceBudget.shadingPixels ?? 0) < 0) limit('PDF native image projection budget exceeded.');
      cancellation();
      surfaceBudget.pixels += units; surfaceBudget.shadingPixels = work;
      try {
        const data = new Float32Array(units); let sample = 0;
        for (let row = 0; row < height; row++) for (let column = 0; column < width; column++, sample++) {
          if (sample % 4096 === 0) cancellation();
          const x = left + column + .5 - e, y = top + row + .5 - f;
          const u = inverse[0] * x + inverse[2] * y, v = inverse[1] * x + inverse[3] * y;
          if (!Number.isFinite(u) || !Number.isFinite(v)) corrupt('Non-finite native PDF image coordinates.');
          const sx = Math.max(0, Math.min(image.width - 1, Math.floor(u * image.width))), sy = Math.max(0, Math.min(image.height - 1, Math.floor((1 - v) * image.height)));
          const source = sy * image.width + sx, opacity = image.softMask ? image.softMask.bytes[source] / 255 : 1;
          if (components === 3) {
            // Fixed default BG(k)=UCR(k)=k on RGB8: exact integer inks,
            // with no per-pixel arrays or round trip through display RGB.
            const at = source * 3, maximum = Math.max(image.bytes[at], image.bytes[at + 1], image.bytes[at + 2]);
            for (let channel = 0; channel < 3; channel++) data[sample * 5 + channel] = (maximum - image.bytes[at + channel]) / 255 * opacity;
            data[sample * 5 + 3] = (255 - maximum) / 255 * opacity;
          } else for (let channel = 0; channel < 4; channel++) data[sample * 5 + channel] = image.bytes[source * 4 + channel] / 255 * opacity;
          data[sample * 5 + 4] = opacity;
        }
        const result = { data, width, height, release() { if (band === result) { band = null; surfaceBudget.pixels -= units; result.data = null; } } };
        band = result; return result;
      } catch (error) { surfaceBudget.pixels -= units; throw error; }
    },
    destroy() { band?.release(); closed = true; },
  };
}
