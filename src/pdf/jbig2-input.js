// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
export function corrupt(message) { throw new PdfEngineError(message, 'pdf_corrupt'); }
export function unsupported(message) { throw new PdfEngineError(message); }
export function boundedPixels(width, height) {
  if (width <= 0 || height <= 0) corrupt('Empty JBIG2 bitmap dimensions.');
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width > 1_000_000 || height > 1_000_000 || width * height > 16_000_000) throw new PdfEngineError('JBIG2 bitmap pixel limit exceeded.', 'pdf_limit');
}
export class Input {
  constructor(bytes) { this.bytes = bytes; this.at = 0; this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  require(count) { if (!Number.isSafeInteger(count) || count < 0 || count > this.bytes.length - this.at) corrupt('Truncated JBIG2 segment.'); }
  u8() { this.require(1); return this.bytes[this.at++]; }
  u16() { this.require(2); const value = this.view.getUint16(this.at); this.at += 2; return value; }
  u32() { this.require(4); const value = this.view.getUint32(this.at); this.at += 4; return value; }
  take(length) { this.require(length); const value = this.bytes.subarray(this.at, this.at + length); this.at += length; return value; }
}
