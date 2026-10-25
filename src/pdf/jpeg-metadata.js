// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
const corrupt = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };

/** Read the bounded marker header, without decoding or changing compressed samples. */
export function readJpegHeader(bytes) {
  if (bytes[0] !== 255 || bytes[1] !== 216) corrupt('Invalid JPEG header.');
  let frame = null, adobeTransform = null, markers = 0;
  const jfif = [];
  for (let at = 2; at < bytes.length;) {
    if (++markers > 4096) throw new PdfEngineError('PDF JPEG marker budget exceeded.', 'pdf_limit');
    const start = at;
    if (bytes[at++] !== 255) corrupt('Invalid JPEG marker.');
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (marker === 217 || marker === 218) break;
    if (marker === 1) continue;
    if (marker === 0 || marker === 216 || marker >= 208 && marker <= 215) corrupt('Invalid JPEG marker order.');
    const length = bytes[at] * 256 + bytes[at + 1];
    if (!Number.isInteger(length) || length < 2 || length > bytes.length - at) corrupt('Truncated JPEG segment.');
    if ([192, 193, 194].includes(marker)) {
      const components = bytes[at + 7];
      if (frame || length < 8 || length !== 8 + 3 * components || !components) corrupt('Invalid JPEG sample frame.');
      frame = { bits: bytes[at + 2], height: bytes[at + 3] * 256 + bytes[at + 4], width: bytes[at + 5] * 256 + bytes[at + 6], components };
    } else if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
      throw new PdfEngineError('This JPEG sample frame is not implemented yet.');
    } else if (marker === 224 && length >= 7 && [74, 70, 73, 70, 0].every((byte, i) => bytes[at + 2 + i] === byte)) {
      if (length < 16) corrupt('Truncated JFIF JPEG marker.');
      jfif.push({ start, end: at + length });
    }
    else if (marker === 238 && length >= 7 && [65, 100, 111, 98, 101].every((byte, i) => bytes[at + 2 + i] === byte)) {
      if (length < 14) corrupt('Truncated Adobe JPEG marker.');
      const value = bytes[at + 13];
      if (value > 2 || adobeTransform !== null && adobeTransform !== value) corrupt('Invalid or conflicting Adobe JPEG transforms.');
      adobeTransform = value;
    }
    at += length;
  }
  if (!frame) corrupt('Missing JPEG sample frame.');
  return { ...frame, adobeTransform, jfif };
}

/** ISO 32000-1 Table13: an Adobe marker overrides the PDF dictionary parameter. */
export function jpegForPdfColorTransform(bytes, requested) {
  if (!Number.isInteger(requested) || ![0, 1].includes(requested)) corrupt('PDF JPEG ColorTransform must be 0 or 1.');
  const header = readJpegHeader(bytes);
  if (header.bits !== 8 || ![1, 2, 3, 4].includes(header.components)) throw new PdfEngineError('This PDF JPEG sample format is not implemented yet.');
  if (header.components <= 2) return bytes;
  const effective = header.adobeTransform ?? (requested && header.components === 4 ? 2 : requested);
  if (header.components === 3 && effective === 2 || header.components === 4 && effective === 1) corrupt('Adobe JPEG transform disagrees with its component count.');
  const remove = effective === 0 ? header.jfif : [];
  if (header.adobeTransform !== null && !remove.length) return bytes;
  // Native JPEG decoders prioritize JFIF over Adobe; it must not override PDF's raw RGB interpretation.
  const marker = header.adobeTransform === null ? Uint8Array.of(255, 238, 0, 14, 65, 100, 111, 98, 101, 0, 100, 0, 0, 0, 0, effective) : new Uint8Array();
  const out = new Uint8Array(bytes.length + marker.length - remove.reduce((sum, segment) => sum + segment.end - segment.start, 0));
  out.set(bytes.subarray(0, 2)); out.set(marker, 2);
  let source = 2, destination = 2 + marker.length;
  for (const { start, end } of remove) { out.set(bytes.subarray(source, start), destination); destination += start - source; source = end; }
  out.set(bytes.subarray(source), destination);
  return out;
}
