// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { resolvePdfColorSpace } from './color-spaces.js';
import { decodeFax } from './streams.js';
import { pdfImageSampleBytes } from './image-limits.js';

const aliases = { BPC: 'BitsPerComponent', CS: 'ColorSpace', D: 'Decode', DP: 'DecodeParms', F: 'Filter', H: 'Height', IM: 'ImageMask', I: 'Interpolate', W: 'Width' };
const keys = new Set(['BitsPerComponent', 'ColorSpace', 'Decode', 'DecodeParms', 'Filter', 'Height', 'ImageMask', 'Interpolate', 'Width', 'Intent']);
const spaces = { G: 'DeviceGray', RGB: 'DeviceRGB', CMYK: 'DeviceCMYK', I: 'Indexed' };
const white = byte => [0, 9, 10, 12, 13, 32].includes(byte);
const delimiter = byte => byte === undefined || white(byte) || [40, 41, 60, 62, 91, 93, 123, 125, 47, 37].includes(byte);
const corrupt = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };
const rename = (reader, id, text) => {
  const node = reader.node(id); node.bytes = Uint8Array.from(text, character => character.charCodeAt(0)); node.length = node.bytes.length;
};

function normalize(reader, stream) {
  const dictionary = reader.node(reader.node(stream).first), entries = [], selected = new Map();
  for (let id = dictionary.first; id;) {
    const key = reader.node(id), value = key.next, name = reader.text(key);
    entries.push({ id, value, name }); id = reader.node(value).next;
  }
  for (const entry of entries) if (keys.has(entry.name)) selected.set(entry.name, entry);
  // The abbreviated spelling takes precedence, including when a full key comes later.
  for (const entry of entries) if (Object.hasOwn(aliases, entry.name)) selected.set(aliases[entry.name], entry);
  let previous = null; dictionary.first = 0;
  for (const [name, entry] of selected) {
    const key = reader.node(entry.id), value = reader.node(entry.value); rename(reader, entry.id, name);
    if (previous) previous.next = entry.id; else dictionary.first = entry.id;
    key.next = entry.value; value.next = 0; previous = value;
  }
  const space = reader.field(stream, 'ColorSpace');
  const normalizeSpace = id => { const name = reader.name(id); if (Object.hasOwn(spaces, name)) rename(reader, id, spaces[name]); };
  if (space) {
    if (reader.node(space).kind === 'array') {
      const array = reader.array(space); if (array[0]) normalizeSpace(array[0]);
      if (reader.name(array[0]) !== 'Indexed' || array.length !== 4 || reader.node(array[1]).kind !== 'name' || reader.node(array[3]).kind !== 'string') corrupt('Invalid direct inline image color space.');
      normalizeSpace(array[1]);
      if (!['DeviceGray', 'DeviceRGB', 'DeviceCMYK'].includes(reader.name(array[1]))) corrupt('Inline Indexed color space must use a device base.');
    } else normalizeSpace(space);
  }
}

function encodedEnd(bytes, length) {
  let at = length;
  if (at >= bytes.length || !white(bytes[at])) corrupt('Inline image data has no whitespace before EI.');
  while (at < bytes.length && white(bytes[at])) at++;
  if (bytes[at] !== 69 || bytes[at + 1] !== 73 || !delimiter(bytes[at + 2])) corrupt('Inline image data has no delimited EI terminator.');
  return at + 2;
}

function jpegLength(bytes) {
  if (bytes[0] !== 255 || bytes[1] !== 216) corrupt('Invalid inline JPEG header.');
  let at = 2, entropy = false;
  while (at < bytes.length) {
    if (entropy) { while (at < bytes.length && bytes[at] !== 255) at++; }
    if (bytes[at++] !== 255) corrupt('Invalid inline JPEG marker.');
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (marker === undefined) break;
    if (entropy && (marker === 0 || marker >= 208 && marker <= 215)) continue;
    entropy = false;
    if (marker === 217) return at;
    if (marker === 216 || marker === 0) corrupt('Invalid inline JPEG marker order.');
    if (marker === 1 || marker >= 208 && marker <= 215) continue;
    if (at + 2 > bytes.length) break;
    const length = bytes[at] * 256 + bytes[at + 1];
    if (length < 2 || length > bytes.length - at) corrupt('Truncated inline JPEG segment.');
    at += length; entropy = marker === 218;
  }
  corrupt('Missing inline JPEG end marker.');
}

function nativeLength(reader, bytes, filter, early) {
  reader.check(); reader.api.pn_pdf_mark();
  try {
    const pointer = reader.copy(bytes), address = reader.api.pn_pdf_inline_length(pointer, bytes.length, filter, early);
    const view = new DataView(reader.api.memory.buffer), status = view.getUint32(address, true), length = view.getUint32(address + 4, true);
    if (status === 2) throw new PdfEngineError('Inline image filter work budget exceeded.', 'pdf_limit');
    if (status || !length || length > bytes.length) corrupt('Invalid or unterminated inline image filter.');
    reader.check(); return length;
  } finally { reader.api.pn_pdf_rewind(); }
}

async function frame(reader, id, resources, loadAsset) {
  normalize(reader, id);
  const bytes = reader.bytes(id), filterId = reader.field(id, 'Filter');
  const filters = filterId ? reader.node(filterId).kind === 'array' ? reader.array(filterId) : [filterId] : [];
  const names = filters.map(filter => reader.name(filter));
  if (filters.some(filter => reader.node(filter).kind !== 'name')) corrupt('Inline image filters must be PDF names.');
  if (!reader.node(id).inlineSeparated && !names.some(name => ['ASCIIHexDecode', 'AHx', 'ASCII85Decode', 'A85'].includes(name))) corrupt('Binary inline image ID requires one whitespace byte.');
  if (names.some(name => ['JPXDecode', 'JBIG2Decode', 'Crypt'].includes(name))) corrupt('This filter is not allowed in a PDF inline image.');
  for (const key of ['ImageMask', 'Interpolate']) { const value = reader.field(id, key); if (value && reader.node(value).kind !== 'boolean') corrupt(`Inline image ${key} must be boolean.`); }
  const parametersId = reader.field(id, 'DecodeParms'), parameters = parametersId ? reader.node(parametersId).kind === 'array' ? reader.array(parametersId)[0] : parametersId : 0;
  const params = parameters && reader.node(parameters).kind !== 'null' ? parameters : 0;
  const numeric = (key, fallback) => reader.number(reader.field(params, key), fallback);
  const boolean = (key, fallback) => { const value = reader.field(params, key); if (!value) return fallback; const node = reader.node(value); if (node.kind !== 'boolean') corrupt(`Invalid inline fax ${key}.`); return node.aux !== 0; };
  let length = 0;
  switch (names[0]) {
    case undefined: {
      const mask = reader.field(id, 'ImageMask'), stencil = mask && reader.node(mask).aux !== 0;
      const space = stencil ? { components: 1 } : await resolvePdfColorSpace(reader, resources, reader.field(id, 'ColorSpace'), loadAsset);
      length = pdfImageSampleBytes(reader.number(reader.field(id, 'Width')), reader.number(reader.field(id, 'Height')), space.components, reader.number(reader.field(id, 'BitsPerComponent'), stencil ? 1 : 8));
      break;
    }
    case 'ASCIIHexDecode': case 'AHx': {
      const end = bytes.indexOf(62); if (end < 0) corrupt('Missing inline ASCIIHex end marker.'); length = end + 1; break;
    }
    case 'ASCII85Decode': case 'A85': {
      const end = bytes.indexOf(126); if (end < 0 || bytes[end + 1] !== 62) corrupt('Missing inline ASCII85 end marker.'); length = end + 2; break;
    }
    case 'RunLengthDecode': case 'RL': {
      let at = 0;
      while (at < bytes.length) { const control = bytes[at++]; if (control === 128) { length = at; break; } at += control < 128 ? control + 1 : 1; }
      if (!length) corrupt('Missing inline RunLength end marker.'); break;
    }
    case 'DCTDecode': case 'DCT': length = jpegLength(bytes); break;
    case 'FlateDecode': case 'Fl': length = nativeLength(reader, bytes, 1, 1); break;
    case 'LZWDecode': case 'LZW': length = nativeLength(reader, bytes, 2, numeric('EarlyChange', 1)); break;
    case 'CCITTFaxDecode': case 'CCF': {
      const decoded = decodeFax(reader, bytes, { columns: numeric('Columns', 1728), rows: numeric('Rows', 0), k: numeric('K', 0),
        endOfLine: boolean('EndOfLine', false), encodedByteAlign: boolean('EncodedByteAlign', false), endOfBlock: boolean('EndOfBlock', true),
        blackIs1: boolean('BlackIs1', false), damagedRowsBeforeError: numeric('DamagedRowsBeforeError', 0), withInfo: true });
      length = Math.ceil(decoded.bitsRead / 8); break;
    }
    default: throw new PdfEngineError(`PDF inline filter ${names[0]} is not implemented yet.`);
  }
  const next = encodedEnd(bytes, length), stream = reader.node(id);
  stream.bytes = bytes.subarray(0, length); stream.length = length;
  return stream.inlineDataOffset + next;
}

export async function* iteratePdfContent(reader, bytes, resources, loadAsset) {
  let offset = 0;
  do {
    const tokens = reader.content(bytes.subarray(offset)); let continuation = 0;
    try {
      for (const id of tokens) {
        const node = reader.node(id);
        if (node.kind === 'stream' && node.inlineDataOffset !== undefined) continuation = await frame(reader, id, resources, loadAsset);
      }
      yield tokens;
    } finally { reader.releaseContent(tokens); }
    if (!continuation) return;
    if (continuation <= 0 || continuation > bytes.length - offset) corrupt('Invalid inline content continuation.');
    offset += continuation;
  } while (offset < bytes.length);
}
