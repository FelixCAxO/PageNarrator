// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original sfnt writer using the public OpenType table specifications.
import { PdfEngineError } from './native-reader.js';
const table = size => { const bytes = new Uint8Array(size); return { bytes, view: new DataView(bytes.buffer) }; };
function checksum(bytes) {
  let sum = 0; for (let i = 0; i < bytes.length; i += 4) sum = (sum + ((bytes[i] || 0) * 2 ** 24 + (bytes[i + 1] || 0) * 65536 + (bytes[i + 2] || 0) * 256 + (bytes[i + 3] || 0))) >>> 0; return sum;
}
export const privateGlyphCode = gid => 0xf0000 + gid;

function cmapTable(glyphCount, aliases = new Map()) {
  const mappings = new Map();
  for (let gid = 0; gid < glyphCount; gid++) mappings.set(privateGlyphCode(gid), gid);
  for (const [code, gid] of aliases) if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff && Number.isInteger(gid) && gid >= 0 && gid < glyphCount && !mappings.has(code)) mappings.set(code, gid);
  const entries = [...mappings].sort((a, b) => a[0] - b[0]), groups = [];
  for (const [code, gid] of entries) {
    const last = groups.at(-1); if (last && code === last[1] + 1 && gid === last[2] + code - last[0]) last[1] = code; else groups.push([code, code, gid]);
  }
  const out = table(28 + groups.length * 12), v = out.view;
  v.setUint16(2, 1); v.setUint16(4, 3); v.setUint16(6, 10); v.setUint32(8, 12);
  v.setUint16(12, 12); v.setUint32(16, out.bytes.length - 12); v.setUint32(24, groups.length);
  groups.forEach((group, i) => group.forEach((value, j) => v.setUint32(28 + i * 12 + j * 4, value)));
  return out.bytes;
}
function writeSfnt(tables, type) {
  const entries = [...tables].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  let length = 12 + entries.length * 16; for (const [, bytes] of entries) length += Math.ceil(bytes.length / 4) * 4;
  if (length > 32 * 1024 * 1024) throw new PdfEngineError('Converted PDF font exceeds its 32 MiB limit.', 'pdf_limit');
  const out = table(length), v = out.view, power = 2 ** Math.floor(Math.log2(entries.length));
  v.setUint32(0, type); v.setUint16(4, entries.length); v.setUint16(6, power * 16); v.setUint16(8, Math.log2(power)); v.setUint16(10, entries.length * 16 - power * 16);
  let offset = 12 + entries.length * 16, headOffset = 0;
  entries.forEach(([tag, bytes], i) => {
    const row = 12 + i * 16; for (let j = 0; j < 4; j++) v.setUint8(row + j, tag.charCodeAt(j));
    if (tag === 'head') { bytes = bytes.slice(); new DataView(bytes.buffer).setUint32(8, 0); headOffset = offset; }
    v.setUint32(row + 4, checksum(bytes)); v.setUint32(row + 8, offset); v.setUint32(row + 12, bytes.length); out.bytes.set(bytes, offset); offset += Math.ceil(bytes.length / 4) * 4;
  });
  if (!headOffset) throw new PdfEngineError('Converted font has no head table.', 'pdf_corrupt');
  v.setUint32(headOffset + 8, (0xb1b0afba - checksum(out.bytes)) >>> 0); return out.bytes;
}
function nameTable(name) {
  name = name.replace(/[^A-Za-z0-9-]/g, '').slice(0, 63) || 'PageNarratorFont';
  const ids = [1, 2, 4, 6], strings = [name, 'Regular', name, name], total = strings.reduce((sum, value) => sum + value.length * 2, 0), start = 6 + ids.length * 12;
  const out = table(start + total), v = out.view; v.setUint16(2, ids.length); v.setUint16(4, start); let offset = 0;
  strings.forEach((text, i) => { const row = 6 + i * 12; v.setUint16(row, 3); v.setUint16(row + 2, 1); v.setUint16(row + 4, 0x409); v.setUint16(row + 6, ids[i]); v.setUint16(row + 8, text.length * 2); v.setUint16(row + 10, offset); for (const char of text) { v.setUint16(start + offset, char.charCodeAt(0)); offset += 2; } }); return out.bytes;
}
export function buildCffOpenType(font, widths, aliases = new Map()) {
  if (widths.length !== font.glyphs.length || widths.length > 65535) throw new PdfEngineError('Invalid CFF metric count.', 'pdf_corrupt');
  if (widths.some(width => !Number.isFinite(width) || Math.abs(width) > 65535)) throw new PdfEngineError('Invalid CFF advance width.', 'pdf_corrupt');
  let cff = font.bytes;
  if (font.nameRepairs?.length) { cff = cff.slice(); for (const at of font.nameRepairs) cff[at] = 45; }
  const head = table(54), hhea = table(36), hmtx = table(widths.length * 4), maxp = table(6), os2 = table(78), post = table(32);
  head.view.setUint32(0, 0x10000); head.view.setUint32(4, 0x10000); head.view.setUint32(12, 0x5f0f3cf5); head.view.setUint16(16, 3); head.view.setUint16(18, 1000);
  font.bbox.forEach((n, i) => head.view.setInt16(36 + i * 2, Math.max(-32768, Math.min(32767, Math.round(n))))); head.view.setUint16(46, 8); head.view.setInt16(48, 2);
  hhea.view.setUint32(0, 0x10000); hhea.view.setInt16(4, 1000); hhea.view.setInt16(6, -250); hhea.view.setUint16(10, Math.min(65535, Math.ceil(widths.reduce((maximum, width) => Math.max(maximum, width), 0)))); hhea.view.setInt16(18, 1); hhea.view.setUint16(34, widths.length);
  // OpenType hmtx is unsigned; PDF glyph positions retain their signed advances.
  widths.forEach((width, gid) => hmtx.view.setUint16(gid * 4, Math.max(0, Math.round(width))));
  maxp.view.setUint32(0, 0x5000); maxp.view.setUint16(4, widths.length);
  os2.view.setInt16(2, 500); os2.view.setUint16(4, 400); os2.view.setUint16(6, 5); os2.view.setUint16(62, 0x40); os2.view.setUint16(64, 32); os2.view.setUint16(66, 65535); os2.view.setInt16(68, 1000); os2.view.setInt16(70, -250); os2.view.setUint16(74, 1000); os2.view.setUint16(76, 250);
  post.view.setUint32(0, 0x30000); post.view.setInt16(8, -100); post.view.setInt16(10, 50);
  return writeSfnt(new Map([['CFF ', cff], ['head', head.bytes], ['hhea', hhea.bytes], ['hmtx', hmtx.bytes], ['maxp', maxp.bytes], ['OS/2', os2.bytes], ['post', post.bytes], ['name', nameTable(font.name)], ['cmap', cmapTable(widths.length, aliases)]]), 0x4f54544f);
}
function completeTrueTypeMetrics(tables, glyphCount, aliases) {
  // PDF subsets may omit this table, but browser OpenType sanitizers require it.
  // Derive rendering metrics from the retained font; never replace an existing table.
  // https://learn.microsoft.com/en-us/typography/opentype/spec/os2
  if (tables.has('OS/2')) return;
  const get = (tag, minimum) => {
    const bytes = tables.get(tag);
    if (!bytes || bytes.length < minimum) throw new PdfEngineError(`Missing font ${tag} table.`, 'pdf_corrupt');
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  };
  const head = get('head', 54), hhea = get('hhea', 36), maxp = get('maxp', 6), count = hhea.getUint16(34), hmtx = get('hmtx', 4);
  if (!glyphCount || maxp.getUint16(4) !== glyphCount || !count || count > glyphCount || hmtx.byteLength < count * 4 + (glyphCount - count) * 2) throw new PdfEngineError('Invalid subset font metrics.', 'pdf_corrupt');
  let total = 0, nonzero = 0;
  for (let gid = 0; gid < glyphCount; gid++) { const width = hmtx.getUint16(Math.min(gid, count - 1) * 4); if (width) { total += width; nonzero++; } }
  const out = table(78), v = out.view, style = head.getUint16(44), bold = !!(style & 1), italic = !!(style & 2);
  v.setInt16(2, Math.min(32767, Math.round(nonzero ? total / nonzero : 0))); v.setUint16(4, bold ? 700 : 400); v.setUint16(6, 5);
  v.setUint32(58, 0x504e4152); v.setUint16(62, (italic ? 1 : 0) | (bold ? 32 : 0) | (!bold && !italic ? 64 : 0));
  let first = 65535;
  for (const [code, gid] of aliases) if (Number.isInteger(code) && code >= 0 && code < first && Number.isInteger(gid) && gid >= 0 && gid < glyphCount) first = code;
  // The generated cmap always includes supplementary private glyph codes.
  v.setUint16(64, first); v.setUint16(66, 65535);
  v.setInt16(68, hhea.getInt16(4)); v.setInt16(70, hhea.getInt16(6)); v.setInt16(72, hhea.getInt16(8));
  v.setUint16(74, Math.max(0, head.getInt16(42))); v.setUint16(76, Math.max(0, -head.getInt16(38)));
  tables.set('OS/2', out.bytes);
}
export function remapTrueTypeCmap(bytes, glyphCount, aliases = new Map()) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length), count = view.getUint16(4), tables = new Map();
  if (count > 256 || 12 + count * 16 > bytes.length) throw new PdfEngineError('Invalid sfnt table directory.', 'pdf_corrupt');
  for (let i = 0; i < count; i++) {
    const row = 12 + i * 16, tag = String.fromCharCode(...bytes.subarray(row, row + 4)), offset = view.getUint32(row + 8), length = view.getUint32(row + 12);
    if (offset + length > bytes.length) throw new PdfEngineError('Font table exceeds its input.', 'pdf_corrupt');
    if (tag !== 'DSIG') tables.set(tag, bytes.subarray(offset, offset + length));
  }
  completeTrueTypeMetrics(tables, glyphCount, aliases);
  if (!tables.has('post')) {
    // PDF subsets may omit printer metadata that browser sanitizers require.
    // OpenType post v3 carries no glyph names; cmap retains every glyph mapping.
    // https://learn.microsoft.com/en-us/typography/opentype/spec/post
    const post = table(32); post.view.setUint32(0, 0x30000); tables.set('post', post.bytes);
  }
  // Complete missing browser naming metadata without changing glyph selection.
  // Preserve every present table, including malformed metadata for the sanitizer to reject.
  // https://learn.microsoft.com/en-us/typography/opentype/spec/name
  if (!tables.has('name')) tables.set('name', nameTable('PageNarratorPdfSubset'));
  tables.set('cmap', cmapTable(glyphCount, aliases)); return writeSfnt(tables, view.getUint32(0) === 0x74727565 ? 0x10000 : view.getUint32(0));
}
