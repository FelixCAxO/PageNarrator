// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { decodeJbig2 } from './jbig2.js';
import { decodeJbig2Generic, decodeJbig2Refinement, decodeJbig2GrayPlanes, withJbig2Arithmetic } from './jbig2-arithmetic.js';
import { decodeJpx } from './jpx.js';
import { MAX_IMAGE_SAMPLE_BYTES } from './image-limits.js';
import { jpegForPdfColorTransform } from './jpeg-metadata.js';
const MAX_DECODED = 32 * 1024 * 1024;
function limit(length, maximum = MAX_DECODED) { if (length > maximum) throw new PdfEngineError(`PDF stream exceeds its ${maximum === MAX_DECODED ? '32 MiB' : 'declared image sample'} decoded limit.`, 'pdf_limit'); }
function corrupt(message) { throw new PdfEngineError(message, 'pdf_corrupt'); }
class ByteOutput {
  constructor(maximum) { this.maximum = maximum; this.bytes = new Uint8Array(Math.min(1024, maximum)); this.length = 0; }
  push(...values) { limit(this.length + values.length, this.maximum); if (this.length + values.length > this.bytes.length) { const grown = new Uint8Array(Math.min(this.maximum, Math.max(this.length + values.length, this.bytes.length * 2))); grown.set(this.bytes); this.bytes = grown; } this.bytes.set(values, this.length); this.length += values.length; }
  finish() { return this.bytes.slice(0, this.length); }
}

export function decodeAsciiHex(bytes, maximum = MAX_DECODED) {
  const output = new ByteOutput(maximum), hex = c => c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
  let high = -1;
  for (const c of bytes) {
    if (c === 62) break;
    if ([0, 9, 10, 12, 13, 32].includes(c)) continue;
    const value = hex(c); if (value < 0) corrupt('Invalid ASCIIHex stream.');
    if (high < 0) high = value; else { output.push(high * 16 + value); high = -1; }
  }
  if (high >= 0) output.push(high * 16); return output.finish();
}

export function decodeAscii85(bytes, maximum = MAX_DECODED) {
  const output = new ByteOutput(maximum); let digits = [];
  const flush = count => {
    let value = 0; for (const d of digits) value = value * 85 + d;
    if (value > 0xffffffff) corrupt('ASCII85 group overflows.');
    for (let i = 0; i < count; i++) output.push(Math.floor(value / 2 ** (24 - 8 * i)) & 255);
    digits = [];
  };
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]; if ([0, 9, 10, 12, 13, 32].includes(c)) continue;
    if (c === 126) { if (bytes[++i] !== 62) corrupt('Invalid ASCII85 terminator.'); break; }
    if (c === 122) { if (digits.length) corrupt('ASCII85 zero abbreviation inside a group.'); output.push(0, 0, 0, 0); continue; }
    if (c < 33 || c > 117) corrupt('Invalid ASCII85 digit.'); digits.push(c - 33);
    if (digits.length === 5) flush(4);
  }
  if (digits.length === 1) corrupt('Incomplete ASCII85 group.');
  if (digits.length) { const count = digits.length - 1; while (digits.length < 5) digits.push(84); flush(count); }
  return output.finish();
}

export function decodeRunLength(bytes, maximum = MAX_DECODED) {
  const pieces = new ByteOutput(maximum); let length = 0;
  for (let i = 0; i < bytes.length;) {
    const control = bytes[i++]; if (control === 128) return pieces.finish();
    const n = control < 128 ? control + 1 : 257 - control;
    length += n; limit(length, maximum);
    if (control < 128) { if (i + n > bytes.length) corrupt('Truncated RunLength stream.'); for (let j = 0; j < n; j++) pieces.push(bytes[i++]); }
    else { if (i >= bytes.length) corrupt('Truncated RunLength repetition.'); const value = bytes[i++]; for (let j = 0; j < n; j++) pieces.push(value); }
  }
  corrupt('Missing RunLength stream terminator.');
}

export function applyPredictor(bytes, { predictor = 1, colors = 1, bits = 8, columns = 1, inPlace = false } = {}) {
  if (predictor === 1) return bytes;
  if (![1, 2, 4, 8, 16].includes(bits) || !Number.isInteger(colors) || colors < 1 || colors > 32
    || !Number.isInteger(columns) || columns < 1 || columns > 1_000_000) corrupt('Invalid PDF predictor dimensions.');
  const rowLength = Math.ceil(colors * bits * columns / 8), stride = Math.ceil(colors * bits / 8);
  if (predictor === 2) {
    if (bytes.length % rowLength) corrupt('Truncated TIFF predictor row.');
    const out = inPlace ? bytes : bytes.slice(), mask = 2 ** bits - 1;
    const sample = (row, index) => { const bit = index * bits, offset = row + (bit >> 3); return bits === 16 ? out[offset] * 256 + out[offset + 1] : out[offset] >> (8 - bits - (bit & 7)) & mask; };
    for (let row = 0; row < out.length; row += rowLength) for (let i = colors; i < colors * columns; i++) {
      const value = (sample(row, i) + sample(row, i - colors)) & mask, bit = i * bits, offset = row + (bit >> 3);
      if (bits === 16) { out[offset] = value >> 8; out[offset + 1] = value & 255; }
      else { const shift = 8 - bits - (bit & 7); out[offset] = out[offset] & ~(mask << shift) | value << shift; }
    }
    return out;
  }
  if (predictor < 10 || predictor > 15 || bytes.length % (rowLength + 1)) corrupt('Invalid PNG predictor stream.');
  const length = bytes.length / (rowLength + 1) * rowLength, out = inPlace ? bytes.subarray(0, length) : new Uint8Array(length);
  for (let src = 0, row = 0; src < bytes.length; row += rowLength) {
    const filter = bytes[src++]; if (filter > 4) corrupt('Invalid PNG row filter.');
    for (let x = 0; x < rowLength; x++) {
      const left = x >= stride ? out[row + x - stride] : 0, up = row ? out[row + x - rowLength] : 0;
      const corner = row && x >= stride ? out[row + x - rowLength - stride] : 0;
      const p = left + up - corner, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - corner);
      const prediction = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : a <= b && a <= c ? left : b <= c ? up : corner;
      out[row + x] = bytes[src++] + prediction;
    }
  }
  return out;
}

async function inflate(bytes, signal, maximum = MAX_DECODED, exact = false) {
  try { return await inflateData(bytes, signal, maximum, exact); }
  catch (error) {
    signal?.throwIfAborted();
    if (error?.code === 'pdf_limit') throw error;
    // A few PDF producers include the endstream EOL in Length. Retry only one
    // terminal EOL, and still require a complete zlib stream and valid checksum.
    const ends = bytes.at(-1) === 10 ? [bytes.length - 1, ...(bytes.at(-2) === 13 ? [bytes.length - 2] : [])]
      : bytes.at(-1) === 13 ? [bytes.length - 1] : [];
    for (const end of ends) {
      if (end < 8) continue;
      try { return await inflateData(bytes.subarray(0, end), signal, maximum, exact); }
      catch (retryError) { signal?.throwIfAborted(); if (retryError?.code === 'pdf_limit') throw retryError; }
    }
    throw error;
  }
}

async function inflateData(bytes, signal, maximum, exact) {
  // Some producers leave an empty filtered content stream in a Contents array.
  // It contributes no bytes; nonempty zlib data still requires complete decoding.
  if (!bytes.length) { signal?.throwIfAborted(); return bytes; }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader(), chunks = [], output = exact ? new Uint8Array(maximum) : null; let length = 0;
  try {
    while (true) { signal?.throwIfAborted(); const { value, done } = await reader.read(); if (done) break; limit(length + value.length, maximum); if (output) output.set(value, length); else chunks.push(value); length += value.length; }
  } finally { await reader.cancel(); }
  if (output) return output.subarray(0, length);
  const combined = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; } return combined;
}

export function decodeLzw(reader, bytes, earlyChange = 1, maximum = MAX_DECODED) {
  if (![0, 1].includes(earlyChange) || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_IMAGE_SAMPLE_BYTES + 1_000_000) corrupt('Invalid PDF LZW parameters.');
  for (let capacity = Math.min(maximum, Math.max(1024, bytes.length * 4));;) {
    reader.check(); reader.api.pn_pdf_mark(); let status, result;
    try {
      const source = reader.copy(bytes), output = reader.checked(reader.api.pn_pdf_alloc(capacity)), address = reader.api.pn_pdf_lzw(source, bytes.length, earlyChange, output, capacity), view = new DataView(reader.api.memory.buffer);
      status = view.getUint32(address, true); const length = view.getUint32(address + 4, true);
      if (status === 0) result = new Uint8Array(reader.api.memory.buffer, output, length).slice();
    } finally { reader.api.pn_pdf_rewind(); }
    if (status === 0) return result; if (status !== 2) corrupt('Invalid or unterminated PDF LZW stream.');
    if (capacity === maximum) throw new PdfEngineError('PDF LZW decoded byte limit exceeded.', 'pdf_limit'); capacity = Math.min(maximum, capacity * 2);
  }
}

export function decodeFax(reader, bytes, { columns = 1728, rows = 0, k = 0, endOfLine = false, encodedByteAlign = false, endOfBlock = true, blackIs1 = false, damagedRowsBeforeError = 0, allowExtensions = true, withInfo = false } = {}) {
  if (!Number.isSafeInteger(columns) || columns < 1 || columns > 1_000_000 || !Number.isSafeInteger(rows) || rows < 0 || rows > 1_000_000 || !Number.isSafeInteger(k) || k < -0x80000000 || k > 0x7fffffff || !Number.isSafeInteger(damagedRowsBeforeError) || damagedRowsBeforeError < 0 || damagedRowsBeforeError > 1024) corrupt('Invalid CCITT fax dimensions or parameters.');
  const flags = (endOfLine ? 1 : 0) | (encodedByteAlign ? 2 : 0) | (endOfBlock ? 4 : 0) | (blackIs1 ? 8 : 0) | (allowExtensions ? 0 : 16), stride = Math.ceil(columns / 8);
  for (let capacity = Math.min(MAX_DECODED, Math.max(1024, Math.min(stride * rows, MAX_DECODED), bytes.length * 8));;) {
    reader.check(); reader.api.pn_pdf_mark(); let status, result, damaged, bitsRead;
    try {
      const input = reader.copy(bytes), output = reader.checked(reader.api.pn_pdf_alloc(capacity)), scratch = reader.checked(reader.api.pn_pdf_alloc((columns + 4) * 8));
      const address = reader.api.pn_pdf_fax(input, bytes.length, k, columns, rows, flags, damagedRowsBeforeError, output, capacity, scratch), view = new DataView(reader.api.memory.buffer);
      status = view.getUint32(address, true); const length = view.getUint32(address + 4, true); damaged = view.getUint32(address + 8, true); bitsRead = view.getUint32(address + 12, true);
      if (status === 0) result = new Uint8Array(reader.api.memory.buffer, output, length).slice();
    } finally { reader.api.pn_pdf_rewind(); }
    if (status === 0) { if (damaged) (reader.codecWarnings ||= []).push({ filter: 'CCITTFaxDecode', damagedRows: damaged }); return withInfo ? { bytes: result, bitsRead } : result; }
    if (status === 3) throw new PdfEngineError('This CCITT extension selector is not implemented yet.');
    if (status === 4) throw new PdfEngineError('CCITT fax resource limit exceeded.', 'pdf_limit');
    if (status !== 2) corrupt('Invalid or unterminated CCITT fax stream.');
    if (capacity === MAX_DECODED) throw new PdfEngineError('CCITT fax resource limit exceeded.', 'pdf_limit'); capacity = Math.min(MAX_DECODED, capacity * 2);
  }
}

export async function decodePdfStream(reader, streamId, { image = false, imageSamples = null, ancestors = new Set() } = {}) {
  reader.check(); const n = reader.node(streamId);
  if (ancestors.has(n.id)) corrupt('Cyclic PDF stream decoding dependency.');
  const path = new Set(ancestors); path.add(n.id);
  if (n.kind !== 'stream') throw new PdfEngineError('Expected PDF stream.', 'pdf_corrupt');
  let bytes = reader.bytes(n), filters = reader.field(n.id, 'Filter'), parameters = reader.field(n.id, 'DecodeParms');
  const sequence = filters ? reader.node(filters).kind === 'array' ? reader.array(filters) : [filters] : [];
  const params = parameters ? reader.node(parameters).kind === 'array' ? reader.array(parameters) : [parameters] : [];
  if (imageSamples && (!image || !Number.isSafeInteger(imageSamples.bytes) || imageSamples.bytes < 1 || imageSamples.bytes > MAX_IMAGE_SAMPLE_BYTES
    || !Number.isSafeInteger(imageSamples.rows) || imageSamples.rows < 1 || imageSamples.rows > 1_000_000)) corrupt('Invalid PDF image decoding budget.');
  for (let i = 0; i < sequence.length; i++) {
    const filter = reader.name(sequence[i]), p = params[i], predictor = p && reader.node(p).kind !== 'null' ? reader.number(reader.field(p, 'Predictor'), 1) : 1;
    const finalSamples = imageSamples && i === sequence.length - 1, maximum = finalSamples ? imageSamples.bytes + (predictor >= 10 ? imageSamples.rows : 0) : MAX_DECODED;
    if (image && ['DCTDecode', 'DCT'].includes(filter) && i === sequence.length - 1) {
      const parameter = p && reader.node(p).kind !== 'null' && reader.field(p, 'ColorTransform');
      if (parameter && reader.node(parameter).kind !== 'null') {
        if (reader.node(parameter).kind !== 'number') corrupt('PDF JPEG ColorTransform must be 0 or 1.');
        bytes = jpegForPdfColorTransform(bytes, reader.number(parameter));
      }
      return { bytes, format: 'jpeg' };
    }
    if (filter === 'JPXDecode') {
      if (!image || i !== sequence.length - 1) corrupt('JPXDecode must be the final filter of an image XObject.');
      return { ...decodeJpx(reader, bytes), jpx: true };
    }
    if (filter === 'FlateDecode' || filter === 'Fl') bytes = await inflate(bytes, reader.signal, maximum, !!finalSamples);
    else if (filter === 'ASCIIHexDecode' || filter === 'AHx') bytes = decodeAsciiHex(bytes, maximum);
    else if (filter === 'ASCII85Decode' || filter === 'A85') bytes = decodeAscii85(bytes, maximum);
    else if (filter === 'RunLengthDecode' || filter === 'RL') bytes = decodeRunLength(bytes, maximum);
    else if (filter === 'Crypt') {
      const p = params[i] && reader.node(params[i]).kind !== 'null' ? params[i] : null, name = p && reader.name(reader.field(p, 'Name'));
      if (i !== 0) corrupt('The PDF Crypt filter must be first.');
      if (!reader.security && name && name !== 'Identity') throw new PdfEngineError(`PDF crypt filter /${name} requires a security handler.`);
      // Object resolution already applies the selected native crypt filter.
    }
    else if (filter === 'LZWDecode' || filter === 'LZW') bytes = decodeLzw(reader, bytes, params[i] && reader.node(params[i]).kind !== 'null' ? reader.number(reader.field(params[i], 'EarlyChange'), 1) : 1, maximum);
    else if (filter === 'JBIG2Decode') {
      const p = params[i] && reader.node(params[i]).kind !== 'null' ? params[i] : null, globalsId = p && reader.field(p, 'JBIG2Globals');
      const globals = globalsId ? (await decodePdfStream(reader, globalsId, { ancestors: path })).bytes : null;
      const decoded = decodeJbig2(bytes, { globals, decodeMmr: (data, options) => decodeFax(reader, data, options), decodeArithmetic: (data, options) => decodeJbig2Generic(reader, data, options), decodeRefinement: (data, options) => decodeJbig2Refinement(reader, data, options), decodeGrayPlanes: (data, options) => decodeJbig2GrayPlanes(reader, data, options), withArithmetic: (data, run, retained) => withJbig2Arithmetic(reader, data, run, retained), check: () => reader.check() });
      if (image && (decoded.width !== reader.number(reader.field(n.id, 'Width')) || decoded.height !== reader.number(reader.field(n.id, 'Height')))) corrupt('JBIG2 image dimensions disagree with the PDF image dictionary.');
      bytes = decoded.bytes;
    }
    else if (filter === 'CCITTFaxDecode' || filter === 'CCF') {
      const p = params[i] && reader.node(params[i]).kind !== 'null' ? params[i] : null, numeric = (key, fallback) => p ? reader.number(reader.field(p, key), fallback) : fallback;
      const boolean = (key, fallback) => { const id = p && reader.field(p, key); if (!id) return fallback; const n = reader.node(id); if (n.kind !== 'boolean') corrupt(`Invalid fax ${key} parameter.`); return n.aux !== 0; };
      bytes = decodeFax(reader, bytes, { columns: numeric('Columns', 1728), rows: numeric('Rows', 0), k: numeric('K', 0), endOfLine: boolean('EndOfLine', false), encodedByteAlign: boolean('EncodedByteAlign', false), endOfBlock: boolean('EndOfBlock', true), blackIs1: boolean('BlackIs1', false), damagedRowsBeforeError: numeric('DamagedRowsBeforeError', 0) });
    }
    else throw new PdfEngineError(`PDF stream filter ${filter} is not implemented yet.`);
    if (p && reader.node(p).kind !== 'null') bytes = applyPredictor(bytes, {
      predictor: reader.number(reader.field(p, 'Predictor'), 1), colors: reader.number(reader.field(p, 'Colors'), 1),
      bits: reader.number(reader.field(p, 'BitsPerComponent'), 8), columns: reader.number(reader.field(p, 'Columns'), 1), inPlace: !!imageSamples,
    });
    limit(bytes.length, finalSamples ? imageSamples.bytes : maximum);
  }
  return { bytes, format: 'raw' };
}
