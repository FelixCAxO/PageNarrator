// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original CFF INDEX/DICT/charset reader, Adobe Technical Note 5176.
import { PdfEngineError } from './native-reader.js';
import { asciiGlyphName, standardGlyphName } from './type1-font.js';
import { cffExpertEncodingSids, extendedCffStandardStrings } from './cff-encodings.js';
const corrupt = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };
const unsupported = message => { throw new PdfEngineError(message); };
const standardStrings = ['.notdef', ...Array.from({ length: 95 }, (_, i) => i === 7 ? 'quoteright' : i === 64 ? 'quoteleft' : asciiGlyphName(i + 32)),
  ...'exclamdown cent sterling fraction yen florin section currency quotesingle quotedblleft guillemotleft guilsinglleft guilsinglright fi fl endash dagger daggerdbl periodcentered paragraph bullet quotesinglbase quotedblbase quotedblright guillemotright ellipsis perthousand questiondown grave acute circumflex tilde macron breve dotaccent dieresis ring cedilla hungarumlaut ogonek caron emdash AE ordfeminine Lslash Oslash OE ordmasculine ae dotlessi lslash oslash oe germandbls onesuperior logicalnot mu trademark Eth onehalf plusminus Thorn onequarter divide brokenbar degree thorn threequarters twosuperior registered minus eth multiply threesuperior copyright Aacute Acircumflex Adieresis Agrave Aring Atilde Ccedilla Eacute Ecircumflex Edieresis Egrave Iacute Icircumflex Idieresis Igrave Ntilde Oacute Ocircumflex Odieresis Ograve Otilde Scaron Uacute Ucircumflex Udieresis Ugrave Yacute Ydieresis Zcaron aacute acircumflex adieresis agrave aring atilde ccedilla eacute ecircumflex edieresis egrave iacute icircumflex idieresis igrave ntilde oacute ocircumflex odieresis ograve otilde scaron uacute ucircumflex udieresis ugrave yacute ydieresis zcaron'.split(' '), ...extendedCffStandardStrings];

export function parseCffFont(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const range = (offset, length) => { if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > bytes.length) corrupt('CFF range exceeds its font.'); return offset; };
  const u8 = offset => bytes[range(offset, 1)], u16 = offset => view.getUint16(range(offset, 2));
  if (u8(0) !== 1 || u8(2) < 4) unsupported('This CFF version is not implemented yet.');
  function index(offset) {
    const count = u16(offset); offset += 2; if (!count) return { items: [], next: offset };
    const size = u8(offset++); if (size < 1 || size > 4) corrupt('Invalid CFF INDEX offset width.');
    const numbers = []; for (let i = 0; i <= count; i++) { let value = 0; for (let j = 0; j < size; j++) value = value * 256 + u8(offset++); numbers.push(value); }
    if (numbers[0] !== 1) corrupt('CFF INDEX must begin at offset one.');
    const items = []; for (let i = 0; i < count; i++) { if (numbers[i + 1] < numbers[i]) corrupt('Unsorted CFF INDEX offsets.'); const start = offset + numbers[i] - 1, length = numbers[i + 1] - numbers[i]; range(start, length); items.push(bytes.subarray(start, start + length)); }
    return { items, next: offset + numbers[count] - 1 };
  }
  function dictionary(data) {
    const out = new Map(), values = []; let at = 0;
    const byte = () => { if (at >= data.length) corrupt('Truncated CFF DICT operand.'); return data[at++]; };
    while (at < data.length) {
      const op = byte();
      if (op <= 21) { const key = op === 12 ? 1200 + byte() : op; out.set(key, values.splice(0)); continue; }
      let value;
      if (op === 28) value = (byte() * 256 + byte() << 16) >> 16;
      else if (op === 29) value = (byte() * 2 ** 24 + byte() * 65536 + byte() * 256 + byte()) | 0;
      else if (op === 30) {
        let text = '', ended = false;
        while (!ended) { const pair = byte(); for (const nibble of [pair >> 4, pair & 15]) { if (nibble === 15) { ended = true; break; } if (nibble === 13) corrupt('Reserved CFF real nibble.'); text += nibble < 10 ? String(nibble) : ({ 10: '.', 11: 'e', 12: 'e-', 14: '-' })[nibble]; if (text.length > 64) corrupt('CFF real is too long.'); } }
        value = Number(text);
      } else if (op >= 32 && op <= 246) value = op - 139;
      else if (op >= 247 && op <= 250) value = (op - 247) * 256 + byte() + 108;
      else if (op >= 251 && op <= 254) value = -(op - 251) * 256 - byte() - 108;
      else corrupt('Reserved CFF DICT operand.');
      if (!Number.isFinite(value) || values.length >= 48) corrupt('Invalid CFF DICT number.'); values.push(value);
    }
    if (values.length) corrupt('Unterminated CFF DICT operands.'); return out;
  }
  const nameIndex = index(u8(2)), topIndex = index(nameIndex.next), strings = index(topIndex.next), globals = index(strings.next);
  if (nameIndex.items.length !== 1 || topIndex.items.length !== 1) unsupported('CFF font sets are not implemented yet.');
  const fontName = nameIndex.items[0], nameRepairs = [];
  if (!fontName.length || fontName.length > 127) corrupt('Invalid CFF font name length.');
  if (fontName[0] === 0) corrupt('A deleted CFF font cannot be used.');
  // TN5176 section 7: repair metadata bytes without moving any font offsets.
  for (const [i, byte] of fontName.entries()) if (byte < 33 || byte > 126 || '[](){}<>/%'.includes(String.fromCharCode(byte))) nameRepairs.push(fontName.byteOffset - bytes.byteOffset + i);
  const top = dictionary(topIndex.items[0]), charstringsOffset = top.get(17)?.[0];
  if (!Number.isSafeInteger(charstringsOffset)) corrupt('Missing CFF CharStrings.');
  const glyphs = index(charstringsOffset).items; if (!glyphs.length) corrupt('Empty CFF font.');
  const charset = [0], charsetOffset = top.get(15)?.[0] ?? 0, cid = top.has(1230);
  if (charsetOffset === 0) { if (glyphs.length > 229 || cid) corrupt('Invalid predefined CFF charset.'); for (let i = 1; i < glyphs.length; i++) charset.push(i); }
  else if (charsetOffset === 1 || charsetOffset === 2) unsupported('CFF expert charsets are not implemented yet.');
  else {
    let at = charsetOffset; const format = u8(at++);
    if (format === 0) while (charset.length < glyphs.length) { charset.push(u16(at)); at += 2; }
    else if (format === 1 || format === 2) while (charset.length < glyphs.length) { const first = u16(at); at += 2; const left = format === 1 ? u8(at++) : u16(at); if (format === 2) at += 2; if (charset.length + left + 1 > glyphs.length) corrupt('CFF charset range exceeds glyph count.'); for (let i = 0; i <= left; i++) charset.push(first + i); }
    else corrupt('Invalid CFF charset format.');
  }
  const string = sid => sid < 391 ? standardStrings[sid] ?? null : strings.items[sid - 391] ? new TextDecoder().decode(strings.items[sid - 391]) : null;
  const byName = new Map(), byCid = new Map();
  charset.forEach((sid, gid) => { if (cid) byCid.set(sid, gid); else { const name = string(sid); if (name) byName.set(name, gid); } });
  const encodingValues = top.get(16), encodingOffset = encodingValues?.[0] ?? 0;
  if (!cid && encodingValues && (encodingValues.length !== 1 || !Number.isSafeInteger(encodingOffset) || encodingOffset < 0)) corrupt('Invalid CFF encoding offset.');
  const encoding = new Map();
  if (!cid && encodingOffset === 0) for (let code = 0; code < 256; code++) { const gid = byName.get(standardGlyphName(code)); if (gid !== undefined) encoding.set(code, gid); }
  else if (!cid && encodingOffset === 1) {
    const bySid = new Map(charset.map((sid, gid) => [sid, gid]));
    for (const [code, sid] of cffExpertEncodingSids.entries()) {
      if (!sid) continue;
      const gid = bySid.get(sid); if (gid !== undefined) encoding.set(code, gid);
    }
  }
  else if (!cid) {
    let at = encodingOffset; const flags = u8(at++), format = flags & 127; let gid = 1;
    const groups = u8(at++);
    if (format === 0) for (let i = 0; i < groups; i++) encoding.set(u8(at++), gid++);
    else if (format === 1) for (let i = 0; i < groups; i++) { const first = u8(at++), left = u8(at++); if (first + left > 255) corrupt('CFF encoding range overflow.'); for (let j = 0; j <= left; j++) encoding.set(first + j, gid++); }
    else corrupt('Invalid CFF encoding format.');
    if (gid > glyphs.length) corrupt('CFF encoding exceeds glyph count.');
    if (flags & 128) { const supplements = u8(at++); for (let i = 0; i < supplements; i++) { const code = u8(at++), sid = u16(at); at += 2; const mapped = charset.indexOf(sid); if (mapped < 0) corrupt('CFF supplemental SID is absent.'); encoding.set(code, mapped); } }
  }
  function privateDictionary(dict) {
    const p = dict.get(18); if (!p) return { subrs: [], nominal: 0, fallback: 0, initialRandomSeed: 0 };
    if (p.length !== 2) corrupt('Invalid CFF Private dictionary.'); range(p[1], p[0]); const d = dictionary(bytes.subarray(p[1], p[1] + p[0]));
    const subrs = d.has(19) ? index(p[1] + d.get(19)[0]).items : [];
    return { subrs, nominal: d.get(21)?.[0] ?? 0, fallback: d.get(20)?.[0] ?? 0, initialRandomSeed: d.get(1219)?.[0] ?? 0 };
  }
  let locals = [privateDictionary(top)], selection = new Uint16Array(glyphs.length), fontDictMatrices = [null];
  if (cid) {
    if (!top.has(1236) || !top.has(1237)) corrupt('Missing CFF CID dictionaries.');
    const dictionaries = index(top.get(1236)[0]).items.map(dictionary);
    fontDictMatrices = dictionaries.map(dict => dict.get(1207) ?? null);
    locals = dictionaries.map(privateDictionary); if (!locals.length || locals.length > 256) corrupt('Invalid CFF FontDict count.');
    let at = top.get(1237)[0], format = u8(at++);
    if (format === 0) for (let i = 0; i < glyphs.length; i++) selection[i] = u8(at++);
    else if (format === 3) {
      const ranges = u16(at); at += 2; let first = u16(at); at += 2; if (first !== 0 || !ranges) corrupt('Invalid CFF FDSelect start.');
      for (let i = 0; i < ranges; i++) { const fd = u8(at++), end = u16(at); at += 2; if (end <= first || end > glyphs.length) corrupt('Invalid CFF FDSelect range.'); selection.fill(fd, first, end); first = end; }
      if (first !== glyphs.length) corrupt('CFF FDSelect does not cover all glyphs.');
    } else unsupported(`CFF FDSelect format ${format} is not implemented yet.`);
    if (selection.some(fd => fd >= locals.length)) corrupt('CFF FDSelect references an absent dictionary.');
  }
  return { bytes, glyphs, globalSubrs: globals.items, locals, selection, cid, byName, byCid, encoding, nameRepairs,
    charstringType: top.get(1206)?.[0] ?? 2, topMatrixExplicit: top.has(1207), fontDictMatrices,
    matrix: top.get(1207) ?? [.001, 0, 0, .001, 0, 0], bbox: top.get(5) ?? [-1000, -1000, 3000, 3000], name: new TextDecoder().decode(nameIndex.items[0]) };
}

export function readCffWidths(reader, font) {
  reader.api.pn_pdf_mark();
  try {
    const prepare = routines => {
      const table = reader.copy(new Uint8Array(routines.length * 8));
      routines.forEach((bytes, i) => { const pointer = reader.copy(bytes), view = new DataView(reader.api.memory.buffer); view.setUint32(table + i * 8, pointer, true); view.setUint32(table + i * 8 + 4, bytes.length, true); }); return table;
    };
    const global = prepare(font.globalSubrs), localTables = font.locals.map(local => prepare(local.subrs));
    return font.glyphs.map((bytes, i) => {
      const fd = font.selection[i], local = font.locals[fd], pointer = reader.copy(bytes);
      const at = reader.api.pn_cff_width(pointer, bytes.length, localTables[fd], local.subrs.length, global, font.globalSubrs.length, local.nominal, local.fallback);
      const view = new DataView(reader.api.memory.buffer), status = view.getUint32(at, true);
      if (status) throw new PdfEngineError(`CFF glyph ${i} width ${status === 1 ? 'operator is not implemented yet' : 'is invalid'} (status ${status}).`);
      const width = view.getFloat64(at + 8, true); if (!Number.isFinite(width) || Math.abs(width) > 65535) corrupt('CFF width exceeds supported metric limits.'); return width;
    });
  } finally { reader.api.pn_pdf_rewind(); }
}
