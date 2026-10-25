// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';

export const MAX_IMAGE_PIXELS = 32_000_000;
export const MAX_IMAGE_SAMPLE_BYTES = 96 * 1024 * 1024;
export const MAX_IMAGE_BAND_PIXELS = 4_000_000;

export function pdfImageSampleBytes(width, height, components, bits) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > 1_000_000 || height > 1_000_000 || width * height > MAX_IMAGE_PIXELS) {
    throw new PdfEngineError('PDF image pixel budget exceeded.', 'pdf_limit');
  }
  if (!Number.isSafeInteger(components) || components < 1 || components > 4 || ![1, 2, 4, 8, 16].includes(bits)) {
    throw new PdfEngineError('This PDF sample layout is not implemented yet.');
  }
  const length = Math.ceil(width * components * bits / 8) * height;
  if (length > MAX_IMAGE_SAMPLE_BYTES) throw new PdfEngineError('PDF image sample byte budget exceeded.', 'pdf_limit');
  return length;
}
