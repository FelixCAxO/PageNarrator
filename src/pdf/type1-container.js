// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original Type1 design-outline to CFF Type2 data conversion, Adobe 5176/5177.
import { PdfEngineError } from './native-reader.js';
import { buildCffOpenType, privateGlyphCode } from './font-container.js';
export function convertType1Font(program, glyph, aliases = new Map()) {
  const number = value => {
    const rounded = Math.round(value * 65536) / 65536;
    if (!Number.isFinite(rounded) || rounded < -32768 || rounded >= 32768) throw new PdfEngineError('Type1 coordinate exceeds CFF Type2 limits.', 'pdf_limit');
    const n = Math.round(rounded);
    if (n === rounded && n >= -107 && n <= 107) return [n + 139];
    if (n === rounded && n >= 108 && n <= 1131) return [247 + (n - 108 >> 8), n - 108 & 255];
    if (n === rounded && n >= -1131 && n <= -108) return [251 + (-n - 108 >> 8), -n - 108 & 255];
    if (n === rounded) return [28, n >> 8 & 255, n & 255];
    const fixed = Math.round(rounded * 65536); return [255, fixed >>> 24 & 255, fixed >>> 16 & 255, fixed >>> 8 & 255, fixed & 255];
  };
  const int = value => [29, value >>> 24 & 255, value >>> 16 & 255, value >>> 8 & 255, value & 255];
  const concatenate = arrays => { const size = arrays.reduce((n, a) => n + a.length, 0), out = new Uint8Array(size); let at = 0; for (const a of arrays) { out.set(a, at); at += a.length; } return out; };
  const index = arrays => {
    if (arrays.length > 65535) throw new PdfEngineError('CFF glyph count limit exceeded.', 'pdf_limit');
    if (!arrays.length) return Uint8Array.of(0, 0);
    const size = arrays.reduce((sum, a) => sum + a.length, 1), width = size <= 255 ? 1 : size <= 65535 ? 2 : size <= 0xffffff ? 3 : 4;
    const out = new Uint8Array(3 + (arrays.length + 1) * width + size - 1); out[0] = arrays.length >> 8; out[1] = arrays.length & 255; out[2] = width;
    let offset = 1; for (let i = 0; i <= arrays.length; i++) { for (let j = 0; j < width; j++) out[3 + i * width + j] = offset >>> (width - 1 - j) * 8 & 255; if (i < arrays.length) offset += arrays[i].length; }
    let at = 3 + (arrays.length + 1) * width; for (const a of arrays) { out.set(a, at); at += a.length; } return out;
  };
  const [a, b, c, d, e, f] = program.matrix, point = (x, y) => [(a * x + c * y + e) * 1000, (b * x + d * y + f) * 1000];
  if (b !== 0 || a <= 0) throw new PdfEngineError('This Type1 advance matrix is not implemented yet.');
  const names = ['.notdef', ...[...program.glyphs.keys()].filter(n => n !== '.notdef')], byName = new Map(names.map((name, i) => [name, i])), widths = [], outlines = [], bbox = [0, 0, 0, 0];
  let byteCount = 0;
  for (const name of names) {
    const source = program.glyphs.has(name) ? glyph(name) : { path: [], width: 0 }, width = source.width * a * 1000; widths.push(width);
    const encoded = [...number(width)]; let x = 0, y = 0;
    for (const segment of source.path) {
      if (segment.op === 4) continue; // Type2 closes contours at the next move/endchar.
      const points = []; for (let i = 0; i < segment.points.length; i += 2) { const p = point(segment.points[i], segment.points[i + 1]); bbox[0] = Math.min(bbox[0], p[0]); bbox[1] = Math.min(bbox[1], p[1]); bbox[2] = Math.max(bbox[2], p[0]); bbox[3] = Math.max(bbox[3], p[1]); points.push(...number(p[0] - x), ...number(p[1] - y)); x = p[0]; y = p[1]; }
      encoded.push(...points, segment.op === 1 ? 21 : segment.op === 2 ? 5 : 8);
    }
    encoded.push(14); byteCount += encoded.length; if (byteCount > 8 * 1024 * 1024) throw new PdfEngineError('Converted Type1 font exceeds its byte limit.', 'pdf_limit'); outlines.push(Uint8Array.from(encoded));
  }
  const header = Uint8Array.of(1, 0, 4, 4), nameIndex = index([new TextEncoder().encode('PageNarratorType1')]), strings = index(names.slice(1).map(n => new TextEncoder().encode(n))), globals = index([]);
  const charset = new Uint8Array(1 + (names.length - 1) * 2); for (let i = 1; i < names.length; i++) { const sid = 390 + i; if (sid > 65535) throw new PdfEngineError('CFF SID limit exceeded.', 'pdf_limit'); charset[(i - 1) * 2 + 1] = sid >> 8; charset[(i - 1) * 2 + 2] = sid & 255; }
  const dictionary = (charsetOffset, glyphOffset) => Uint8Array.from([...bbox.flatMap(n => int(Math.round(n))), 5, ...int(charsetOffset), 15, ...int(glyphOffset), 17]);
  const dummy = index([dictionary(0, 0)]), start = header.length + nameIndex.length + dummy.length + strings.length + globals.length, top = index([dictionary(start, start + charset.length)]);
  const bytes = concatenate([header, nameIndex, top, strings, globals, charset, index(outlines)]), cmap = new Map();
  for (const [unicode, name] of aliases) { const gid = byName.get(name); if (gid !== undefined) cmap.set(unicode, gid); }
  return { bytes: buildCffOpenType({ bytes, glyphs: outlines, bbox, name: 'PageNarratorType1' }, widths, cmap), byName, widths: new Map(names.map((name, i) => [name, widths[i]])), renderText: name => String.fromCodePoint(privateGlyphCode(byName.get(name) ?? 0)) };
}
