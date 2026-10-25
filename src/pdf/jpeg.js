// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { readJpegHeader } from './jpeg-metadata.js';
import { pdfImageSampleBytes } from './image-limits.js';
const corrupt = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };
const sample = value => Math.max(0, Math.min(255, Math.round(value)));

export function decodeFourComponentJpeg(reader, bytes, width, height) {
  const expected = pdfImageSampleBytes(width, height, 4, 8), header = readJpegHeader(bytes);
  if (header.width !== width || header.height !== height) corrupt('JPEG dimensions disagree with the PDF image.');
  if (header.bits !== 8 || header.components !== 4) throw new PdfEngineError('PDF four-component JPEG must contain four eight-bit samples.');
  if (header.adobeTransform !== null && ![0, 2].includes(header.adobeTransform)) corrupt('Adobe JPEG transform disagrees with its component count.');
  if (typeof reader.api.pn_pdf_jpeg !== 'function') throw new PdfEngineError('PDF JPEG decoder is unavailable.', 'pdf_configuration');
  const result = pointer => {
    const view = new DataView(reader.api.memory.buffer, pointer, 28), status = view.getUint32(0, true);
    if (status === 2) throw new PdfEngineError('PDF JPEG resource limit exceeded.', 'pdf_limit');
    if (status === 3) throw new PdfEngineError('This JPEG coding mode is not implemented yet.');
    if (status) corrupt('Invalid baseline PDF JPEG data.');
    return { width: view.getUint32(4, true), height: view.getUint32(8, true), components: view.getUint32(12, true), scratchBytes: view.getUint32(16, true), outputBytes: view.getUint32(20, true) };
  };
  reader.check(); reader.api.pn_pdf_mark();
  let output;
  try {
    const input = reader.copy(bytes), info = result(reader.api.pn_pdf_jpeg(input, bytes.length, 0, 0, 0, 0));
    if (info.width !== width || info.height !== height || info.components !== 4 || info.outputBytes !== expected || !info.scratchBytes || info.scratchBytes > 32 * 1024 * 1024) corrupt('Invalid PDF JPEG sample allocation.');
    const target = reader.checked(reader.api.pn_pdf_alloc(expected)), scratch = reader.checked(reader.api.pn_pdf_alloc(info.scratchBytes));
    result(reader.api.pn_pdf_jpeg(input, bytes.length, target, expected, scratch, info.scratchBytes)); reader.check();
    output = new Uint8Array(reader.api.memory.buffer, target, expected).slice();
  } finally { reader.api.pn_pdf_rewind(); }
  if (header.adobeTransform === 2) for (let i = 0; i < output.length; i += 4) {
    const y = output[i], cb = output[i + 1] - 128, cr = output[i + 2] - 128;
    // Adobe TN5116 section13.1: inverse YCCK, without standalone JPEG polarity normalization.
    output[i] = 255 - sample(y + 1.402 * cr);
    output[i + 1] = 255 - sample(y - .344136 * cb - .714136 * cr);
    output[i + 2] = 255 - sample(y + 1.772 * cb);
  }
  return output;
}
