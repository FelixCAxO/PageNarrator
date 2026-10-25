// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { readPdfNativeImageSource } from './native-cmyk-image.js';

/** Call at each Do before looking up shared decoded bytes, including cache hits. */
export function assertPdfNativeRgbPrintDefaults(print) {
  if (!print || typeof print !== 'object' || !Object.hasOwn(print, 'blackGeneration') || !Object.hasOwn(print, 'undercolorRemoval')) throw new PdfEngineError('Invalid native PDF RGB print state.', 'pdf_corrupt');
  if (print.blackGeneration !== null || print.undercolorRemoval !== null) throw new PdfEngineError('Native PDF RGB images with custom black generation or undercolor removal are not implemented yet.');
}

/** Raw encoded RGB is a source; it is never an intermediate reconstructed ink image. */
export function readPdfNativeRgbImage(reader, id, options, plane) {
  return readPdfNativeImageSource(reader, id, options, plane, 'DeviceRGB');
}
