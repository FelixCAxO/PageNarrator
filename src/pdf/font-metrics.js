// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original sfnt metrics reader: OpenType head/hhea/hmtx/maxp/cmap tables.
import { PdfEngineError } from './native-reader.js';

export function readTrueTypeMetrics(bytes, { requireCmap = true } = {}) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const range = (offset, size) => { if (!Number.isSafeInteger(offset) || offset < 0 || size < 0 || offset + size > bytes.length) throw new PdfEngineError('Truncated TrueType metrics.', 'pdf_corrupt'); return offset; };
  const u16 = offset => data.getUint16(range(offset, 2)), i16 = offset => data.getInt16(range(offset, 2)), u32 = offset => data.getUint32(range(offset, 4));
  if (![0x00010000, 0x4f54544f, 0x74727565].includes(u32(0))) throw new PdfEngineError('Unsupported embedded font container.');
  const tables = new Map(), count = u16(4); if (count > 256) throw new PdfEngineError('Too many font tables.', 'pdf_limit');
  for (let i = 0; i < count; i++) {
    const offset = 12 + 16 * i, tag = String.fromCharCode(...bytes.subarray(range(offset, 16), offset + 4));
    const start = u32(offset + 8), length = u32(offset + 12); range(start, length); tables.set(tag, { start, length });
  }
  const table = (name, minimum) => { const t = tables.get(name); if (!t || t.length < minimum) throw new PdfEngineError(`Missing font ${name} table.`, 'pdf_corrupt'); return t.start; };
  const head = table('head', 54), hhea = table('hhea', 36), maxp = table('maxp', 6), hmtx = table('hmtx', 4);
  const units = u16(head + 18), metricCount = u16(hhea + 34), glyphCount = u16(maxp + 4);
  if (!units || !metricCount || metricCount > glyphCount || tables.get('hmtx').length < metricCount * 4 + (glyphCount - metricCount) * 2) throw new PdfEngineError('Invalid font metrics.', 'pdf_corrupt');
  const widthByGlyph = id => { if (!Number.isInteger(id) || id < 0 || id >= glyphCount) throw new PdfEngineError('Invalid font glyph index.', 'pdf_corrupt'); return u16(hmtx + Math.min(id, metricCount - 1) * 4) * 1000 / units; };
  const metrics = { units, glyphCount, widthByGlyph, ascent: i16(hhea + 4) / units, descent: i16(hhea + 6) / units };
  // ISO 32000-1 9.9: embedded CID TrueType programs map CIDs directly to
  // glyph indices and may omit cmap. Never infer Unicode from those indices.
  if (!requireCmap && !tables.has('cmap')) return { ...metrics, isUnicode: false,
    glyphId: () => 0, unicodeForGlyph: () => undefined, width: () => widthByGlyph(0) };
  const cmap = table('cmap', 4);
  let selected = 0, score = -1, selectedPlatform = 0, selectedEncoding = 0;
  const encodingCount = u16(cmap + 2); if (encodingCount > 256) throw new PdfEngineError('Too many font encodings.', 'pdf_limit');
  if (4 + encodingCount * 8 > tables.get('cmap').length) throw new PdfEngineError('Truncated font cmap records.', 'pdf_corrupt');
  for (let i = 0; i < encodingCount; i++) {
    const record = cmap + 4 + i * 8, platform = u16(record), encoding = u16(record + 2), subtable = cmap + u32(record + 4), format = u16(subtable);
    if (subtable < cmap || subtable >= cmap + tables.get('cmap').length) throw new PdfEngineError('Invalid font cmap offset.', 'pdf_corrupt');
    const unicode = platform === 0 || platform === 3 && [1, 10].includes(encoding), supported = [0, 4, 6, 10, 12, 13].includes(format);
    const rank = supported ? (unicode ? 100 : platform === 3 && encoding === 0 ? 20 : platform === 1 && encoding === 0 ? 10 : -100) + (format >= 10 ? 5 : format === 4 ? 3 : 0) : -100;
    if (rank > score) { score = rank; selected = subtable; selectedPlatform = platform; selectedEncoding = encoding; }
  }
  if (!selected) throw new PdfEngineError('No supported font cmap.');
  const format = u16(selected), length = format >= 10 ? u32(selected + 4) : u16(selected + 2); range(selected, length);
  if (selected + length > cmap + tables.get('cmap').length) throw new PdfEngineError('Font cmap exceeds its table.', 'pdf_corrupt');
  const requireLength = minimum => { if (length < minimum) throw new PdfEngineError('Truncated font cmap subtable.', 'pdf_corrupt'); };
  let entries = 0, firstCode = 0;
  if (format === 0) requireLength(262);
  if (format === 6 || format === 10) {
    requireLength(format === 6 ? 10 : 20); firstCode = format === 6 ? u16(selected + 6) : u32(selected + 12); entries = format === 6 ? u16(selected + 8) : u32(selected + 16);
    if (entries > 0x110000 || firstCode + entries > (format === 6 ? 65536 : 0x110000)) throw new PdfEngineError('Invalid font cmap trimmed range.', 'pdf_corrupt');
    requireLength((format === 6 ? 10 : 20) + entries * 2);
  }
  if (format === 12 || format === 13) {
    requireLength(16); entries = u32(selected + 12); if (entries > 100000) throw new PdfEngineError('Excessive font cmap groups.', 'pdf_limit'); requireLength(16 + entries * 12);
    let previous = -1;
    for (let i = 0; i < entries; i++) { const at = selected + 16 + i * 12, first = u32(at), last = u32(at + 4), gid = u32(at + 8); if (first <= previous || last < first || last > 0x10ffff || gid + (format === 12 ? last - first : 0) >= glyphCount) throw new PdfEngineError('Invalid font cmap groups.', 'pdf_corrupt'); previous = last; }
  }
  if (format === 4) {
    requireLength(16); entries = u16(selected + 6) / 2;
    if (!Number.isInteger(entries) || !entries) throw new PdfEngineError('Invalid font cmap segment count.', 'pdf_corrupt'); requireLength(16 + entries * 8);
  }
  const glyph = code => {
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return 0;
    if (format === 0) return code < 256 ? bytes[selected + 6 + code] : 0;
    if (format === 6 || format === 10) return code >= firstCode && code < firstCode + entries ? u16(selected + (format === 6 ? 10 : 20) + (code - firstCode) * 2) : 0;
    if (format === 12 || format === 13) {
      let left = 0, right = entries - 1;
      while (left <= right) { const middle = left + right >>> 1, row = selected + 16 + middle * 12, first = u32(row), last = u32(row + 4); if (code < first) right = middle - 1; else if (code > last) left = middle + 1; else return u32(row + 8) + (format === 12 ? code - first : 0); } return 0;
    }
    if (code > 65535) return 0;
    const segments = entries;
    for (let i = 0; i < segments; i++) {
      const end = u16(selected + 14 + i * 2); if (code > end) continue;
      const start = u16(selected + 16 + segments * 2 + i * 2); if (code < start) return 0;
      const delta = i16(selected + 16 + segments * 4 + i * 2), at = selected + 16 + segments * 6 + i * 2, offset = u16(at);
      if (!offset) return code + delta & 65535;
      const address = at + offset + (code - start) * 2; if (address + 2 > selected + length) throw new PdfEngineError('Invalid font glyph offset.', 'pdf_corrupt');
      const id = u16(address); return id ? id + delta & 65535 : 0;
    }
    return 0;
  };
  const isUnicode = selectedPlatform === 0 || selectedPlatform === 3 && [1, 10].includes(selectedEncoding);
  let textByGlyph;
  function unicodeForGlyph(id) {
    if (!isUnicode || !id || id >= glyphCount) return undefined;
    if (!textByGlyph) {
      textByGlyph = new Map();
      const consider = (code, gid) => {
        if (!gid || gid >= glyphCount || textByGlyph.has(gid) || code < 32 || code >= 127 && code < 160
          || code >= 0xd800 && code <= 0xdfff || code >= 0xe000 && code <= 0xf8ff || code >= 0xf0000 || (code & 65535) >= 65534) return;
        textByGlyph.set(gid, String.fromCodePoint(code));
      };
      if (format === 12 || format === 13) for (let i = 0; i < entries; i++) {
        const at = selected + 16 + i * 12, first = u32(at), last = u32(at + 4), gid = u32(at + 8);
        if (format === 13) { const code = Math.max(first, 32); if (code <= last) consider(code, gid); }
        else for (let code = first; code <= last; code++) consider(code, gid + code - first);
      }
      else if (format === 4) { let previous = -1; for (let i = 0; i < entries; i++) {
        const first = u16(selected + 16 + entries * 2 + i * 2), last = u16(selected + 14 + i * 2);
        if (last < first || first <= previous) throw new PdfEngineError('Invalid Unicode font segment.', 'pdf_corrupt'); previous = last;
        const delta = i16(selected + 16 + entries * 4 + i * 2), at = selected + 16 + entries * 6 + i * 2, offset = u16(at);
        for (let code = first; code <= last; code++) {
          if (!offset) consider(code, code + delta & 65535);
          else {
            const address = at + offset + (code - first) * 2;
            if (address + 2 > selected + length) throw new PdfEngineError('Invalid Unicode font glyph offset.', 'pdf_corrupt');
            const gid = u16(address); if (gid) consider(code, gid + delta & 65535);
          }
        }
      } }
      else {
        const count = format === 0 ? 256 : entries, first = format === 0 ? 0 : firstCode;
        for (let code = first; code < first + count; code++) consider(code, glyph(code));
      }
    }
    return textByGlyph.get(id);
  }
  return { ...metrics, glyphId: glyph, unicodeForGlyph, isUnicode,
    platform: selectedPlatform, encoding: selectedEncoding,
    width(code) { return widthByGlyph(glyph(code)); } };
}
