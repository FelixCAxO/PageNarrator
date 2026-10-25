// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { decodePdfStream } from './streams.js';
import { resolvePdfColorSpace } from './color-spaces.js';
import { interpretJpxImage } from './jpx-image.js';
import { pdfImageSampleBytes, MAX_IMAGE_PIXELS, MAX_IMAGE_BAND_PIXELS } from './image-limits.js';
import { convertPdfColor } from './icc-blend.js';
import { readJpegHeader } from './jpeg-metadata.js';
import { decodeFourComponentJpeg } from './jpeg.js';
import { readPdfNativeCmykImage, readPdfNativeIcc4Image } from './native-cmyk-image.js';
import { readPdfNativeRgbImage } from './native-rgb-image.js';
const corrupt = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };
const clamp = n => Math.max(0, Math.min(1, n));

function requireGrayJpeg(bytes, width, height) {
  const header = readJpegHeader(bytes);
  if (header.bits !== 8 || header.components !== 1) throw new PdfEngineError('PDF tint JPEG must contain one eight-bit component.');
  if (header.height !== height || header.width !== width) corrupt('JPEG dimensions disagree with the PDF image.');
}

export async function jpegNativeSamples(reader, bytes, width, height, components) {
  const header = readJpegHeader(bytes);
  if (header.bits !== 8 || header.components !== components) throw new PdfEngineError('PDF JPEG sample components disagree with its color space.');
  if (header.height !== height || header.width !== width) corrupt('JPEG dimensions disagree with the PDF image.');
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') throw new PdfEngineError('PDF JPEG samples require a browser image decoder.');
  let bitmap, surface;
  try {
    reader.check();
    bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' });
    reader.check();
    if (bitmap.width !== width || bitmap.height !== height) corrupt('JPEG dimensions disagree with the PDF image.');
    const samples = new Uint8Array(pdfImageSampleBytes(width, height, components, 8));
    const bandRows = Math.max(1, Math.min(height, Math.floor(MAX_IMAGE_BAND_PIXELS / width)));
    surface = new OffscreenCanvas(width, bandRows);
    for (let top = 0; top < height; top += bandRows) {
      if (top) { await new Promise(resolve => setTimeout(resolve, 0)); reader.check(); }
      const rows = Math.min(bandRows, height - top); if (surface.height !== rows) surface.height = rows;
      const context = surface.getContext('2d', { willReadFrequently: true });
      if (!context) throw new PdfEngineError('Could not allocate PDF sample canvas.', 'pdf_render');
      context.drawImage(bitmap, 0, top, width, rows, 0, 0, width, rows);
      const { data } = context.getImageData(0, 0, width, rows);
      for (let i = 0; i < width * rows; i++) {
        const at = i * 4, value = data[at];
        if (data[at + 3] !== 255 || components === 1 && (data[at + 1] !== value || data[at + 2] !== value)) corrupt('JPEG decoder did not preserve PDF samples.');
        for (let c = 0; c < components; c++) samples[(top * width + i) * components + c] = data[at + c];
      }
    }
    reader.check(); return { format: 'raw', bytes: samples };
  } finally { bitmap?.close?.(); if (surface) surface.width = surface.height = 0; }
}

export async function readPdfImage(reader, id, { resources, loadAsset, fill = [0, 0, 0], outputProfile = null, outputProfileBytes = null, nativeCmyk = false, nativeIcc4 = null, profileMemo = null, sourceBudget } = {}) {
  async function plane(target, mask = false, nativeRgb = false) {
    const width = reader.number(reader.field(target, 'Width')), height = reader.number(reader.field(target, 'Height'));
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS) throw new PdfEngineError('PDF image pixel budget exceeded.', 'pdf_limit');
    const stencilId = reader.field(target, 'ImageMask'), stencil = stencilId && reader.node(stencilId).aux !== 0;
    const colorId = reader.field(target, 'ColorSpace'), filterId = reader.field(target, 'Filter'), filters = filterId ? reader.node(filterId).kind === 'array' ? reader.array(filterId) : [filterId] : [];
    const isJpx = filters.some(filter => reader.name(filter) === 'JPXDecode'), sourceBits = reader.number(reader.field(target, 'BitsPerComponent'), stencil ? 1 : 8);
    const sourceSpace = isJpx ? null : await resolvePdfColorSpace(reader, resources, stencil || mask && !colorId ? 'DeviceGray' : colorId, loadAsset, 0, profileMemo);
    const imageSamples = isJpx ? null : { bytes: pdfImageSampleBytes(width, height, sourceSpace.components, sourceBits), rows: height };
    let decoded = await decodePdfStream(reader, target, { image: true, imageSamples });
    if (mask && decoded.format === 'jpeg') {
      if (mask !== 'soft' || stencil || reader.name(colorId) !== 'DeviceGray' || sourceBits !== 8) throw new PdfEngineError('This PDF JPEG mask format is not implemented yet.');
      decoded = await jpegNativeSamples(reader, decoded.bytes, width, height, 1);
    } else if (!mask && nativeRgb && decoded.format === 'jpeg' && sourceSpace.name === 'DeviceRGB' && sourceSpace.components === 3) {
      if (sourceBits !== 8) throw new PdfEngineError('This native PDF RGB JPEG bit depth is not implemented yet.');
      if (readJpegHeader(decoded.bytes).adobeTransform === 2) corrupt('Adobe JPEG transform disagrees with its component count.');
      decoded = await jpegNativeSamples(reader, decoded.bytes, width, height, 3);
    } else if (!mask && decoded.format === 'jpeg' && sourceSpace.name === 'DeviceN' && sourceSpace.components === 3) {
      if (sourceBits !== 8) throw new PdfEngineError('This PDF DeviceN JPEG bit depth is not implemented yet.');
      // Native three-component JPEG decoding supplies tint inputs, not final display RGB.
      decoded = await jpegNativeSamples(reader, decoded.bytes, width, height, 3);
    } else if (!mask && decoded.format === 'jpeg' && ['DeviceCMYK', 'ICCBased'].includes(sourceSpace.name) && sourceSpace.components === 4) {
      if (sourceBits !== 8) throw new PdfEngineError('This PDF four-component JPEG bit depth is not implemented yet.');
      decoded = { format: 'raw', bytes: decodeFourComponentJpeg(reader, decoded.bytes, width, height) };
    }
    const bits = decoded.jpx ? decoded.bits : sourceBits;
    if (stencil && (decoded.jpx ? decoded.sourcePrecision?.[0] ?? bits : bits) !== 1) corrupt('A PDF stencil mask must use one-bit samples.');
    if (decoded.jpx && (decoded.width !== width || decoded.height !== height)) corrupt('JPEG2000 image dimensions disagree with the PDF image dictionary.');
    const jpx = decoded.jpx ? await interpretJpxImage(reader, target, decoded, { resources, loadAsset, stencil }) : null;
    const space = jpx ? jpx.space : sourceSpace;
    if (![1, 2, 4, 8, 16].includes(bits)) throw new PdfEngineError('This PDF sample bit depth is not implemented yet.');
    const decodeField = !decoded.jpx || stencil ? reader.field(target, 'Decode') : null;
    const decodeId = decodeField && reader.node(decodeField).kind !== 'null' ? decodeField : null;
    const decode = decodeId ? reader.array(decodeId).map(id => reader.number(id, NaN)) : space.decodeRanges || Array.from({ length: space.components }, () => [0, space.indexed ? 2 ** bits - 1 : 1]).flat();
    if (decode.length !== space.components * 2 || decode.some(n => !Number.isFinite(n))) corrupt('Invalid PDF image Decode array.');
    const sourceComponents = decoded.jpx ? decoded.components : space.components, rowLength = Math.ceil(width * sourceComponents * bits / 8), maximum = 2 ** bits - 1;
    if (decoded.format === 'raw' && decoded.bytes.length !== height * rowLength) corrupt('PDF image size does not match decoded samples.');
    const sourceRaw = (x, y, c) => {
      const bit = (x * sourceComponents + c) * bits, offset = y * rowLength + (bit >> 3);
      return bits === 16 ? decoded.bytes[offset] * 256 + decoded.bytes[offset + 1] : decoded.bytes[offset] >> (8 - bits - (bit & 7)) & maximum;
    };
    const raw = jpx ? (x, y, c) => { const channel = jpx.channels[c], precision = decoded.sourcePrecision?.[channel] ?? bits, signed = decoded.sourceSigned?.[channel] || false; return Math.round(sourceRaw(x, y, channel) / maximum * (2 ** precision - 1)) - (signed ? 2 ** (precision - 1) : 0); } : sourceRaw;
    return { ...decoded, width, height, space, stencil, decode, bits, raw,
      embeddedAlpha: jpx?.alphaChannel === null || !jpx ? null : (x, y) => sourceRaw(x, y, jpx.alphaChannel) / maximum, premultiplied: jpx?.premultiplied || false,
      sample: (x, y, c) => jpx && space.indexed ? raw(x, y, c) : decode[c * 2] + (jpx ? sourceRaw(x, y, jpx.channels[c]) : raw(x, y, c)) / maximum * (decode[c * 2 + 1] - decode[c * 2]),
    };
  }
  if (nativeIcc4) return readPdfNativeIcc4Image(reader, id, { resources, sourceBudget, nativeIcc4 }, plane);
  if (nativeCmyk) return (reader.name(reader.field(id, 'ColorSpace')) === 'DeviceRGB' ? readPdfNativeRgbImage : readPdfNativeCmykImage)(reader, id, { resources, sourceBudget }, plane);
  const base = await plane(id), maskId = reader.field(id, 'Mask'), softId = reader.field(id, 'SMask');
  if (maskId && softId) corrupt('PDF image declares both Mask and SMask.');
  let alpha = null, alphaAt = null, alphaBytes = null, matte = null, colorKey = null;
  if (base.embeddedAlpha && (maskId || softId)) corrupt('JPEG2000 embedded opacity cannot be combined with a PDF Mask or SMask.');
  if (maskId && reader.node(maskId).kind === 'array') {
    colorKey = reader.array(maskId).map(id => reader.number(id, NaN));
    if (colorKey.length !== base.space.components * 2 || colorKey.some(n => !Number.isFinite(n))) corrupt('Invalid image color-key mask.');
  } else if (maskId || softId) {
    const target = maskId || softId, source = await plane(target, softId ? 'soft' : 'explicit');
    if (reader.field(target, 'Mask') || reader.field(target, 'SMask')) corrupt('Nested image masks are not allowed.');
    if (source.format !== 'raw' || source.space.components !== 1) throw new PdfEngineError('This PDF mask sample format is not implemented yet.');
    const interpolateId = reader.field(target, 'Interpolate'), interpolate = interpolateId && reader.node(interpolateId).aux !== 0;
    if (source.width === base.width && source.height === base.height && source.bits === 8 && !source.jpx
      && source.decode[0] === 0 && source.decode[1] === 1) alphaBytes = { bytes: source.bytes, inverted: !softId };
    const at = (x, y) => source.sample(Math.max(0, Math.min(source.width - 1, x)), Math.max(0, Math.min(source.height - 1, y)), 0);
    alphaAt = (x, y) => {
      const mx = (x + .5) * source.width / base.width - .5, my = (y + .5) * source.height / base.height - .5;
      let value;
      if (!interpolate) value = at(Math.floor(mx + .5), Math.floor(my + .5));
      else { const left = Math.floor(mx), top = Math.floor(my), fx = mx - left, fy = my - top; value = at(left, top) * (1 - fx) * (1 - fy) + at(left + 1, top) * fx * (1 - fy) + at(left, top + 1) * (1 - fx) * fy + at(left + 1, top + 1) * fx * fy; }
      return clamp(softId ? value : 1 - value);
    };
    const matteId = reader.field(target, 'Matte'); if (softId && matteId) {
      if (source.width !== base.width || source.height !== base.height) corrupt('PDF Matte mask dimensions must match its image.');
      matte = reader.array(matteId).map(id => reader.number(id, NaN)); if (matte.length !== base.space.components || matte.some(n => !Number.isFinite(n))) corrupt('Invalid PDF mask Matte color.');
    }
  }
  if (base.format === 'jpeg') {
    const tint = ['Separation', 'Indexed'].includes(base.space.name);
    if (base.stencil || !['DeviceRGB', 'DeviceGray', 'ICCBased', 'Separation', 'Indexed'].includes(base.space.name) || ![1, 3].includes(base.space.components) || base.bits !== 8) throw new PdfEngineError('This JPEG/PDF color or mask variant is not implemented yet.');
    let colorLookup = null;
    if (tint) {
      // A browser preserves one-component JPEG samples; apply PDF tint/index values ourselves.
      requireGrayJpeg(base.bytes, base.width, base.height);
      if (matte) throw new PdfEngineError('PDF tint JPEG Matte correction is not implemented yet.');
      colorLookup = new Uint8ClampedArray(256 * 3);
      for (let sample = 0; sample < 256; sample++) {
        const value = base.decode[0] + sample / 255 * (base.decode[1] - base.decode[0]);
        const rgb = convertPdfColor(base.space, [value], outputProfile);
        for (let channel = 0; channel < 3; channel++) colorLookup[sample * 3 + channel] = rgb[channel] * 255;
      }
    }
    if (alphaAt) {
      alpha = new Uint8ClampedArray(base.width * base.height);
      for (let y = 0; y < base.height; y++) {
        if (y > 0 && y % Math.max(1, Math.floor(1_000_000 / base.width)) === 0) { reader.check(); await new Promise(resolve => setTimeout(resolve, 0)); reader.check(); }
        for (let x = 0; x < base.width; x++) alpha[y * base.width + x] = alphaAt(x, y) * 255;
      }
    }
    return { format: 'jpeg', bytes: base.bytes, width: base.width, height: base.height, maskAlpha: alpha, matte, decode: base.decode, colorKey, colorLookup, components: base.space.components, colorProfile: base.space.profileBytes || null, outputProfile: outputProfileBytes };
  }
  const pixels = new Uint8ClampedArray(base.width * base.height * 4);
  const directSamples = !base.jpx && base.bits === 8 && ['DeviceRGB', 'DeviceGray'].includes(base.space.name)
    && base.decode.every((n, i) => n === i % 2) && !base.stencil && !base.premultiplied && !matte && !colorKey && !outputProfile;
  const values = new Array(base.space.components);
  for (let y = 0; y < base.height; y++) {
    if (y > 0 && y % Math.max(1, Math.floor(1_000_000 / base.width)) === 0) { reader.check(); await new Promise(resolve => setTimeout(resolve, 0)); reader.check(); }
    for (let x = 0; x < base.width; x++) {
    const index = y * base.width + x;
    if (directSamples) {
      const at = index * base.space.components;
      pixels[index * 4] = base.bytes[at]; pixels[index * 4 + 1] = base.bytes[at + (base.space.components === 1 ? 0 : 1)]; pixels[index * 4 + 2] = base.bytes[at + (base.space.components === 1 ? 0 : 2)];
      pixels[index * 4 + 3] = alphaBytes ? alphaBytes.inverted ? 255 - alphaBytes.bytes[index] : alphaBytes.bytes[index] : alphaAt ? alphaAt(x, y) * 255 : 255;
      continue;
    }
    const opacity = alphaAt ? alphaAt(x, y) : base.embeddedAlpha ? base.embeddedAlpha(x, y) : 1;
    for (let c = 0; c < values.length; c++) values[c] = base.sample(x, y, c);
    if (base.premultiplied && opacity) for (let c = 0; c < values.length; c++) values[c] /= opacity;
    if (matte && opacity) for (let c = 0; c < values.length; c++) values[c] = (values[c] - matte[c] * (1 - opacity)) / opacity;
    const rgb = base.stencil ? fill : convertPdfColor(base.space, values, outputProfile);
    const masked = colorKey && values.every((_, c) => base.raw(x, y, c) >= colorKey[c * 2] && base.raw(x, y, c) <= colorKey[c * 2 + 1]);
    for (let c = 0; c < 3; c++) pixels[index * 4 + c] = clamp(rgb[c]) * 255;
    pixels[index * 4 + 3] = masked ? 0 : base.stencil ? clamp(1 - values[0]) * 255 : opacity * 255;
    }
  }
  return { format: 'raw', pixels, width: base.width, height: base.height };
}
