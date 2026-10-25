// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original T.88 segment/container execution. Normative format: ITU-T T.88
// clauses 6.2.6, 7.2, 7.4 and Annex D. No implementation is incorporated.
import { PdfEngineError } from './native-reader.js';
import { Input, corrupt, unsupported, boundedPixels } from './jbig2-input.js';
import { readJbig2SymbolDictionary, readJbig2TextRegion } from './jbig2-symbols.js';
import { customHuffmanTable } from './jbig2-huffman.js';
const SIGNATURE = [0x97, 0x4a, 0x42, 0x32, 13, 10, 26, 10];
const TYPES = new Set([0, 4, 6, 7, 16, 20, 22, 23, 36, 38, 39, 40, 42, 43, 48, 49, 50, 51, 52, 53, 62]);
const NO_REFERENCES = new Set([16, 36, 38, 39, 48, 49, 50, 51, 52, 53]);
const REGIONS = new Set([4, 6, 7, 20, 22, 23, 36, 38, 39, 40, 42, 43]);
const IMMEDIATE = new Set([6, 7, 22, 23, 38, 39, 42, 43]);
function header(input) {
  const number = input.u32(), flags = input.u8(), type = flags & 63, first = input.u8(); let count = first >> 5, retention;
  if (!TYPES.has(type)) unsupported(`JBIG2 reserved segment type ${type} is not implemented.`);
  if (count === 5 || count === 6) corrupt('Invalid JBIG2 referred-to segment count.');
  if (count === 7) {
    input.at--; count = input.u32() & 0x1fffffff;
    if (count < 5) corrupt('Noncanonical JBIG2 referred-to segment count.');
    if (count > 4096) throw new PdfEngineError('JBIG2 segment reference limit exceeded.', 'pdf_limit');
    retention = input.take(Math.ceil((count + 1) / 8));
    const used = (count + 1) & 7; if (used && retention.at(-1) >> used) corrupt('Nonzero unused JBIG2 retention flags.');
  } else {
    if ((first & 31) >> (count + 1)) corrupt('Nonzero unused JBIG2 retention flags.');
    retention = Uint8Array.of(first & 31);
  }
  if (NO_REFERENCES.has(type) && count) corrupt('JBIG2 segment has forbidden references.');
  const refs = [], seen = new Set(), width = number <= 256 ? 1 : number <= 65536 ? 2 : 4;
  for (let i = 0; i < count; i++) { const ref = width === 1 ? input.u8() : width === 2 ? input.u16() : input.u32(); if (ref >= number || seen.has(ref)) corrupt('Invalid JBIG2 segment reference.'); refs.push(ref); seen.add(ref); }
  const page = flags & 64 ? input.u32() : input.u8(), length = input.u32();
  if (REGIONS.has(type) && !page || [48, 49, 50].includes(type) && !page || type === 51 && page) corrupt('Invalid JBIG2 segment page association.');
  if (length === 0xffffffff && type !== 38) corrupt('Unknown-length JBIG2 segment has an invalid type.');
  if ([49, 51].includes(type) && length) corrupt('JBIG2 terminator contains unexpected data.');
  return { number, flags, type, page, length, refs, retention };
}
function segmentData(input, segment, check) {
  if (segment.length !== 0xffffffff) return input.take(segment.length);
  input.require(18); const start = input.at, flags = input.bytes[start + 17], arithmetic = !(flags & 1), template = flags >> 1 & 3;
  if (flags & 0xe0 || !arithmetic && flags !== 1) corrupt('Invalid unknown-length JBIG2 generic region flags.');
  if (flags & 16) unsupported('JBIG2 extended adaptive templates are not implemented yet.');
  const headerLength = 18 + (arithmetic ? template ? 2 : 8 : 0); input.require(headerLength);
  for (let at = start + headerLength; at + 6 <= input.bytes.length; at++) {
    if (!(at & 65535)) check();
    if (input.bytes[at] !== (arithmetic ? 255 : 0) || input.bytes[at + 1] !== (arithmetic ? 172 : 0)) continue;
    segment.rowCount = input.view.getUint32(at + 2); segment.unknownLength = true; segment.length = at + 6 - start;
    input.at = at + 6; return input.bytes.subarray(start, at + (arithmetic ? 2 : 0));
  }
  corrupt('Unterminated unknown-length JBIG2 generic region.');
}
export function readJbig2Segments(bytes, { globals = false, check = () => {} } = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 128 * 1024 * 1024) throw new PdfEngineError('JBIG2 input byte limit exceeded.', 'pdf_limit');
  const input = new Input(bytes), segments = []; let sequential = true, standalone = false, pages = null, ended = false, previous = -1;
  if (SIGNATURE.every((value, i) => bytes[i] === value)) {
    standalone = true; input.at = 8; const flags = input.u8(); if (flags & 252 || globals) corrupt('Invalid embedded JBIG2 file header.');
    sequential = !!(flags & 1); pages = flags & 2 ? null : input.u32();
    if (pages !== null && pages !== 1) unsupported('Multi-page standalone JBIG2 images are not implemented.');
  }
  while (input.at < bytes.length) {
    check(); if (segments.length >= 100_000) throw new PdfEngineError('JBIG2 segment count limit exceeded.', 'pdf_limit');
    if (ended) corrupt('JBIG2 data follows its end-of-file segment.');
    const segment = header(input);
    if (standalone && segment.number <= previous) corrupt('Standalone JBIG2 segment numbers are not increasing.'); previous = segment.number;
    if (globals && segment.page) corrupt('JBIG2Globals contains a page-specific segment.');
    if (sequential) segment.data = segmentData(input, segment, check);
    segments.push(segment); ended = segment.type === 51;
    if (!sequential && ended) break;
  }
  if (!sequential) {
    if (!ended) corrupt('Random-access JBIG2 has no end-of-file header.');
    for (const segment of segments) segment.data = segmentData(input, segment, check);
    if (input.at !== bytes.length) corrupt('Unexpected bytes after random-access JBIG2 data.');
  }
  return { segments, standalone, pages };
}
function regionInfo(segment) {
  const input = new Input(segment.data), width = input.u32(), declaredHeight = input.u32(), x = input.u32(), y = input.u32(), flags = input.u8(), height = segment.unknownLength ? segment.rowCount : declaredHeight;
  if (segment.unknownLength && height > declaredHeight) corrupt('JBIG2 actual row count exceeds its declared region height.');
  boundedPixels(width, height); if (flags > 4) corrupt('Invalid JBIG2 external combination operator.');
  return { input, width, height, x, y, operator: flags };
}
function combine(page, region, bitmap, operator, check, { sourceX = 0, sourceStride = Math.ceil(region.width / 8) } = {}) {
  const firstX = Math.max(0, -region.x), firstY = Math.max(0, -region.y), lastX = Math.min(region.width, page.width - region.x), lastY = Math.min(region.height, page.height - region.y);
  if (page.lastStripe !== undefined && firstX < lastX && firstY < lastY) page.stripeTouched = Math.max(page.stripeTouched, region.y + lastY - 1);
  page.work += Math.max(0, lastX - firstX) * Math.max(0, lastY - firstY); if (page.work > 64_000_000) throw new PdfEngineError('JBIG2 composition work limit exceeded.', 'pdf_limit');
  for (let y = firstY; y < lastY; y++) {
    if (!(y & 255)) check();
    for (let x = firstX; x < lastX; x++) {
      const sx = x + sourceX, value = bitmap[y * sourceStride + (sx >> 3)] >> (7 - (sx & 7)) & 1, dx = region.x + x, offset = (region.y + y) * page.stride + (dx >> 3), mask = 128 >> (dx & 7), old = page.bytes[offset] & mask ? 1 : 0;
      const result = operator === 0 ? old | value : operator === 1 ? old & value : operator === 2 ? old ^ value : operator === 3 ? 1 ^ old ^ value : value;
      page.bytes[offset] = page.bytes[offset] & ~mask | (result ? mask : 0);
    }
  }
}
function pageRegion(page, region) {
  const stride = Math.ceil(region.width / 8), result = new Uint8Array(stride * region.height);
  for (let y = 0; y < region.height && region.y + y < page.height; y++) for (let x = 0; x < region.width && region.x + x < page.width; x++) {
    const value = page.bytes[(region.y + y) * page.stride + ((region.x + x) >> 3)] >> (7 - ((region.x + x) & 7)) & 1;
    result[y * stride + (x >> 3)] |= value << (7 - (x & 7));
  }
  return result;
}
function countDecoded(page, region) { page.decodeWork += region.width * region.height; if (page.decodeWork > 64_000_000) throw new PdfEngineError('JBIG2 decoded pixel work limit exceeded.', 'pdf_limit'); }
function deliver(page, auxiliary, segment, region, bitmap, check) {
  if (IMMEDIATE.has(segment.type)) combine(page, region, bitmap, page.flags & 64 ? region.operator : page.flags >> 3 & 3, check);
  else {
    if (!(page.flags & 32)) corrupt('JBIG2 intermediate region requires an auxiliary buffer.');
    page.auxiliaryBytes += bitmap.length; if (page.auxiliaryBytes > 32 * 1024 * 1024) throw new PdfEngineError('JBIG2 auxiliary buffer byte limit exceeded.', 'pdf_limit');
    auxiliary.set(segment.number, { region, bytes: bitmap });
  }
}
export function decodeJbig2(bytes, { globals, decodeMmr, decodeArithmetic, decodeRefinement, decodeGrayPlanes, withArithmetic, check = () => {} } = {}) {
  const main = readJbig2Segments(bytes, { check }), globalSegments = globals ? readJbig2Segments(globals, { globals: true, check }).segments : [], all = [...globalSegments, ...main.segments], registry = new Map();
  for (const segment of all) { if (registry.has(segment.number)) corrupt('Duplicate JBIG2 segment number.'); registry.set(segment.number, segment); }
  for (const segment of all) for (const ref of segment.refs) {
    const target = registry.get(ref); if (!target || target.page && target.page !== segment.page) corrupt('Missing or cross-page JBIG2 reference.');
  }
  let page = null, ended = false, symbolBytes = 0, contextBytes = 0, tableLines = 0, symbolReferences = 0, symbolInstances = 0; const auxiliary = new Map(), patterns = new Map(), dictionaries = new Map(), tables = new Map();
  function countWork(work) { page.work += work; if (page.work > 64_000_000) throw new PdfEngineError('JBIG2 composition work limit exceeded.', 'pdf_limit'); }
  function countInstances(count) { symbolInstances += count; if (symbolInstances > 1_000_000) throw new PdfEngineError('JBIG2 cumulative text instance limit exceeded.', 'pdf_limit'); }
  function appendSymbols(target, symbols) { if (symbols.length > 65536 - target.length) throw new PdfEngineError('JBIG2 imported symbol count limit exceeded.', 'pdf_limit'); for (const symbol of symbols) target.push(symbol); }
  function table(segment) {
    if (!tables.has(segment.number)) { const decoded = customHuffmanTable(segment.data); tableLines += decoded.lineCount; if (tableLines > 65536) throw new PdfEngineError('JBIG2 cumulative Huffman table line limit exceeded.', 'pdf_limit'); tables.set(segment.number, decoded); }
    return tables.get(segment.number);
  }
  function symbolDictionary(segment, depth = 0) {
    if (depth > 64) throw new PdfEngineError('JBIG2 symbol dictionary reference depth limit exceeded.', 'pdf_limit');
    if (dictionaries.has(segment.number)) return dictionaries.get(segment.number);
    const imported = [], customTables = []; let previous = null;
    for (const ref of segment.refs) { const target = registry.get(ref); if (target.type === 0) { previous = symbolDictionary(target, depth + 1); appendSymbols(imported, previous.symbols); } else if (target.type === 53) customTables.push(table(target)); else corrupt('JBIG2 symbol dictionary references a non-symbol/table segment.'); }
    const dictionary = readJbig2SymbolDictionary(segment.data, { imported, previous, customTables, decodeMmr, withArithmetic, check, combine, countWork, countInstances, countDecoded: region => countDecoded(page, region), countBytes(length) { symbolBytes += length; if (symbolBytes > 32 * 1024 * 1024) throw new PdfEngineError('JBIG2 symbol bitmap byte limit exceeded.', 'pdf_limit'); } });
    symbolReferences += dictionary.symbols.length; if (symbolReferences > 1_000_000) throw new PdfEngineError('JBIG2 cumulative symbol reference limit exceeded.', 'pdf_limit');
    contextBytes += Object.values(dictionary.retained || {}).reduce((sum, value) => sum + value.byteLength, 0); if (contextBytes > 32 * 1024 * 1024) throw new PdfEngineError('JBIG2 retained coding context byte limit exceeded.', 'pdf_limit');
    dictionaries.set(segment.number, dictionary); return dictionary;
  }
  function patternDictionary(segment) {
    if (patterns.has(segment.number)) return patterns.get(segment.number);
    if (segment.type !== 16) corrupt('JBIG2 halftone references a non-pattern dictionary.');
    const input = new Input(segment.data), flags = input.u8(), width = input.u8(), height = input.u8(), count = input.u32() + 1, template = flags >> 1 & 3;
    if (flags & 248 || flags & 1 && template) corrupt('Invalid JBIG2 pattern dictionary flags.');
    if (count > 65536) throw new PdfEngineError('JBIG2 pattern count limit exceeded.', 'pdf_limit'); const totalWidth = width * count;
    boundedPixels(totalWidth, height); if (!width) corrupt('Empty JBIG2 pattern width.'); countDecoded(page, { width: totalWidth, height });
    if (!(flags & 1) && typeof decodeArithmetic !== 'function') unsupported('This JBIG2 arithmetic pattern decoder is unavailable.');
    const encoded = input.take(segment.data.length - input.at), bitmap = flags & 1 ? decodeMmr(encoded, { columns: totalWidth, rows: height, k: -1, endOfBlock: false, blackIs1: true, allowExtensions: false }) : decodeArithmetic(encoded, { width: totalWidth, height, template, typical: false, adaptive: template ? [-width, 0] : [-width, 0, -3, -1, 2, -2, -2, -2] });
    if (bitmap.length !== Math.ceil(totalWidth / 8) * height) corrupt('JBIG2 pattern dictionary bitmap has an invalid size.');
    page.patternBytes += bitmap.length; if (page.patternBytes > 32 * 1024 * 1024) throw new PdfEngineError('JBIG2 pattern bitmap byte limit exceeded.', 'pdf_limit');
    const result = { width, height, count, bytes: bitmap, stride: Math.ceil(totalWidth / 8) }; patterns.set(segment.number, result); return result;
  }
  for (const segment of all) {
    check(); const { type } = segment;
    if (!segment.page) {
      if (type === 62) { const extension = new Input(segment.data).u32(); if (extension & 0x80000000) unsupported('This necessary JBIG2 extension is not implemented.'); }
      else if (type === 52) { const input = new Input(segment.data), count = input.u32(); if (count * 4 !== segment.data.length - 4) corrupt('Invalid JBIG2 profiles segment length.'); }
      continue; // Unused global dictionaries/tables do not affect the page bitmap.
    }
    if (ended) corrupt('JBIG2 page segment follows end-of-page.');
    if (type === 48) {
      if (page) unsupported('Multiple JBIG2 image pages are not implemented.');
      const input = new Input(segment.data), width = input.u32(); let height = input.u32(); input.u32(); input.u32(); const flags = input.u8(), striping = input.u16(), unknownHeight = height === 0xffffffff;
      if (input.at !== segment.data.length || flags & 128) corrupt('Invalid JBIG2 page information.');
      if (unknownHeight) {
        if (!(striping & 0x8000)) corrupt('Unknown-height JBIG2 page is not striped.');
        let finalStripe = null, afterFinalStripe = false, foundEnd = false;
        for (const next of all.slice(all.indexOf(segment) + 1)) {
          if (next.page !== segment.page) continue;
          if (next.type === 50) { const stripe = new Input(next.data); finalStripe = stripe.u32(); if (stripe.at !== next.data.length) corrupt('Invalid JBIG2 stripe end.'); afterFinalStripe = false; }
          else if (REGIONS.has(next.type)) afterFinalStripe = true;
          else if (next.type === 49) { foundEnd = true; break; }
        }
        if (finalStripe === null || afterFinalStripe || !foundEnd) corrupt('Unknown-height JBIG2 page requires a final stripe followed by end-of-page.');
        height = finalStripe + 1;
      }
      boundedPixels(width, height); const stride = Math.ceil(width / 8), canvas = new Uint8Array(stride * height); if (flags & 4) canvas.fill(255);
      page = { number: segment.page, width, height, stride, bytes: canvas, flags, striping, unknownHeight, lastStripe: -1, stripeTouched: -1, work: 0, decodeWork: 0, auxiliaryBytes: 0, patternBytes: 0 }; continue;
    }
    if (!page || segment.page !== page.number) corrupt('JBIG2 region precedes its page information.');
    if (type === 49) { if (auxiliary.size) corrupt('JBIG2 page ends with unconsumed auxiliary regions.'); ended = true; continue; }
    if (type === 50) {
      const input = new Input(segment.data), end = input.u32(); if (input.at !== segment.data.length || !(page.striping & 0x8000) || end <= page.lastStripe || end >= page.height || end < page.stripeTouched || end - page.lastStripe > (page.striping & 0x7fff)) corrupt('Invalid JBIG2 stripe end.'); page.lastStripe = end; continue;
    }
    if ([4, 6, 7].includes(type)) {
      const region = regionInfo(segment), symbols = [], customTables = [];
      if (region.y <= page.lastStripe) corrupt('JBIG2 text revisits a completed stripe.'); countDecoded(page, region);
      for (const ref of segment.refs) { const target = registry.get(ref); if (target.type === 0) appendSymbols(symbols, symbolDictionary(target).symbols); else if (target.type === 53) customTables.push(table(target)); else corrupt('JBIG2 text references a non-symbol/table segment.'); }
      const bitmap = readJbig2TextRegion(region.input, region, { symbols, customTables, withArithmetic, combine, check, countWork, countInstances, countDecoded: region => countDecoded(page, region) }); deliver(page, auxiliary, segment, region, bitmap, check); continue;
    }
    if ([36, 38, 39].includes(type)) {
      const region = regionInfo(segment), flags = region.input.u8();
      countDecoded(page, region);
      if (flags & 0xe0) corrupt('Reserved JBIG2 generic region flags are set.');
      if (flags & 16) unsupported('JBIG2 extended adaptive templates are not implemented yet.');
      if (flags & 1 && flags !== 1) corrupt('MMR JBIG2 region has arithmetic template flags.');
      if (region.y <= page.lastStripe) corrupt('JBIG2 region revisits a completed stripe.');
      let bitmap;
      if (flags & 1) bitmap = decodeMmr(region.input.take(segment.data.length - region.input.at), { columns: region.width, rows: region.height, k: -1, endOfBlock: !!segment.unknownLength, blackIs1: true, allowExtensions: false });
      else {
        const template = flags >> 1 & 3, adaptive = Array.from(region.input.take(template ? 2 : 8), byte => byte >= 128 ? byte - 256 : byte);
        if (typeof decodeArithmetic !== 'function') unsupported('This JBIG2 arithmetic decoder is unavailable.');
        bitmap = decodeArithmetic(region.input.take(segment.data.length - region.input.at), { width: region.width, height: region.height, template, typical: !!(flags & 8), adaptive });
      }
      if (bitmap.length !== Math.ceil(region.width / 8) * region.height) corrupt('JBIG2 MMR bitmap ended before its declared height.');
      deliver(page, auxiliary, segment, region, bitmap, check);
      continue;
    }
    if ([20, 22, 23].includes(type)) {
      if (segment.refs.length !== 1) corrupt('JBIG2 halftone requires one pattern dictionary.');
      const region = regionInfo(segment), flags = region.input.u8(), operator = flags >> 4 & 7, template = flags >> 1 & 3;
      if (operator > 4 || flags & 1 && (template || flags & 8)) corrupt('Invalid JBIG2 halftone flags.');
      if (!(flags & 1) && typeof decodeGrayPlanes !== 'function') unsupported('This JBIG2 arithmetic gray-plane decoder is unavailable.');
      if (region.y <= page.lastStripe) corrupt('JBIG2 halftone revisits a completed stripe.'); countDecoded(page, region);
      const width = region.input.u32(), height = region.input.u32(), gx = region.input.u32() | 0, gy = region.input.u32() | 0, rx = region.input.u16(), ry = region.input.u16(); boundedPixels(width, height);
      const dictionary = patternDictionary(registry.get(segment.refs[0])), bits = Math.ceil(Math.log2(dictionary.count)), values = new Uint16Array(width * height), planeSize = Math.ceil(width / 8) * height;
      const position = (x, y) => ({ width: dictionary.width, height: dictionary.height, x: Math.floor((gx + y * ry + x * rx) / 256), y: Math.floor((gy + y * rx - x * ry) / 256) });
      let previous = null, arithmeticPlanes = null;
      if (!(flags & 1) && bits) {
        let skip = null;
        if (flags & 8) {
          skip = new Uint8Array(planeSize); const stride = Math.ceil(width / 8);
          for (let y = 0; y < height; y++) { check(); for (let x = 0; x < width; x++) { const p = position(x, y); if (p.x + p.width <= 0 || p.x >= region.width || p.y + p.height <= 0 || p.y >= region.height) skip[y * stride + (x >> 3)] |= 128 >> (x & 7); } }
        }
        arithmeticPlanes = decodeGrayPlanes(region.input.take(segment.data.length - region.input.at), { width, height, template, planes: bits, skip });
        if (arithmeticPlanes.length !== planeSize * bits) corrupt('JBIG2 arithmetic gray-plane size differs from its grid.');
      }
      for (let plane = bits - 1; plane >= 0; plane--) {
        countDecoded(page, { width, height });
        let bitmap;
        if (arithmeticPlanes) bitmap = arithmeticPlanes.subarray((bits - 1 - plane) * planeSize, (bits - plane) * planeSize);
        else { const result = decodeMmr(segment.data.subarray(region.input.at), { columns: width, rows: height, k: -1, endOfBlock: true, blackIs1: true, allowExtensions: false, withInfo: true }); bitmap = result.bytes; region.input.take(Math.ceil(result.bitsRead / 8)); }
        if (bitmap.length !== planeSize) corrupt('JBIG2 halftone bitplane has an invalid size.');
        if (previous) for (let i = 0; i < bitmap.length; i++) bitmap[i] ^= previous[i]; previous = bitmap;
        const stride = Math.ceil(width / 8); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) values[y * width + x] |= (bitmap[y * stride + (x >> 3)] >> (7 - (x & 7)) & 1) << plane;
      }
      if (region.input.at !== segment.data.length) corrupt('Unexpected bytes after JBIG2 halftone bitplanes.');
      const stride = Math.ceil(region.width / 8), canvas = { width: region.width, height: region.height, stride, bytes: new Uint8Array(stride * region.height), work: 0 }; if (flags & 128) canvas.bytes.fill(255);
      for (let y = 0; y < height; y++) { check(); for (let x = 0; x < width; x++) {
        const index = values[y * width + x]; if (index >= dictionary.count) corrupt('JBIG2 halftone pattern index exceeds its dictionary.');
        combine(canvas, position(x, y), dictionary.bytes, operator, check, { sourceX: index * dictionary.width, sourceStride: dictionary.stride });
      } }
      page.work += canvas.work; if (page.work > 64_000_000) throw new PdfEngineError('JBIG2 halftone composition work limit exceeded.', 'pdf_limit');
      deliver(page, auxiliary, segment, region, canvas.bytes, check); continue;
    }
    if ([40, 42, 43].includes(type)) {
      if (!(page.flags & 2)) corrupt('JBIG2 refinement is forbidden by page information.');
      if (segment.refs.length > 1 || type === 40 && segment.refs.length !== 1) corrupt('Invalid JBIG2 refinement region reference count.');
      const region = regionInfo(segment), flags = region.input.u8(), template = flags & 1;
      countDecoded(page, region); if (flags & 252) corrupt('Reserved JBIG2 refinement flags are set.');
      if (region.y <= page.lastStripe) corrupt('JBIG2 refinement revisits a completed stripe.');
      const adaptive = template ? [] : Array.from(region.input.take(4), byte => byte >= 128 ? byte - 256 : byte), previous = segment.refs.length ? auxiliary.get(segment.refs[0]) : null;
      if (segment.refs.length && !previous) corrupt('JBIG2 refinement references an unavailable intermediate region.');
      if (previous && ['width', 'height', 'x', 'y', 'operator'].some(key => region[key] !== previous.region[key])) corrupt('JBIG2 refinement geometry differs from its intermediate region.');
      if (!previous && region.operator !== 4) corrupt('JBIG2 page refinement must use REPLACE.');
      if (typeof decodeRefinement !== 'function') unsupported('This JBIG2 refinement decoder is unavailable.');
      const bitmap = decodeRefinement(region.input.take(segment.data.length - region.input.at), { width: region.width, height: region.height, template, typical: !!(flags & 2), adaptive,
        reference: previous?.bytes || pageRegion(page, region), referenceWidth: region.width, referenceHeight: region.height });
      if (bitmap.length !== Math.ceil(region.width / 8) * region.height) corrupt('JBIG2 refinement bitmap has an invalid size.');
      if (previous) { auxiliary.delete(segment.refs[0]); page.auxiliaryBytes -= previous.bytes.length; }
      if (IMMEDIATE.has(type)) combine(page, region, bitmap, region.operator, check);
      else { auxiliary.set(segment.number, { region, bytes: bitmap }); page.auxiliaryBytes += bitmap.length; }
      continue;
    }
    if (type === 62) { const extension = new Input(segment.data).u32(); if (extension & 0x80000000) unsupported('This necessary JBIG2 extension is not implemented.'); continue; }
    if ([0, 16, 53].includes(type)) continue; // Executed only by a region that refers to this data.
    unsupported(`JBIG2 segment type ${type} execution is not implemented yet.`);
  }
  if (!page) corrupt('JBIG2 image has no page information.');
  if (auxiliary.size) corrupt('JBIG2 image has unconsumed auxiliary regions.');
  if (main.standalone && !ended) corrupt('Standalone JBIG2 image has no end-of-page segment.');
  // PDF samples use zero for black and one for white; JBIG2 bitmaps use the reverse.
  for (let i = 0; i < page.bytes.length; i++) page.bytes[i] ^= 255;
  return { bytes: page.bytes, width: page.width, height: page.height };
}
