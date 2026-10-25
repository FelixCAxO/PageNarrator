// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original bounded Type 1 data reader. No PostScript program is evaluated.
import { PdfEngineError } from './native-reader.js';
import glyphMappings from '../../vendor/pdf-glyphs/mappings.json' with { type: 'json' };

const whitespace = c => [0, 9, 10, 12, 13, 32].includes(c);
const bad = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };
export function decryptType1(bytes, seed, skip = 4) {
  const out = new Uint8Array(bytes.length); let r = seed;
  for (let i = 0; i < bytes.length; i++) { const cipher = bytes[i]; out[i] = cipher ^ r >> 8; r = ((cipher + r) * 52845 + 22719) & 65535; }
  if (skip < 0 || skip > out.length) bad('Invalid Type 1 cipher prefix.'); return out.slice(skip);
}
class Tokens {
  constructor(bytes) { this.bytes = bytes; this.at = 0; this.count = 0; }
  next() {
    const b = this.bytes;
    for (;;) { while (this.at < b.length && whitespace(b[this.at])) this.at++; if (b[this.at] !== 37) break; while (this.at < b.length && ![10, 13].includes(b[this.at])) this.at++; }
    if (this.at >= b.length) return null;
    if (++this.count > 500000) throw new PdfEngineError('Type 1 token budget exceeded.', 'pdf_limit');
    const start = this.at, c = b[this.at++];
    if (c === 40 || c === 123) {
      const end = c === 40 ? 41 : 125; let depth = 1;
      while (this.at < b.length && depth) { const d = b[this.at++]; if (c === 40 && d === 92) this.at++; else if (d === c) { if (++depth > 64) bad('Type 1 token nesting limit.'); } else if (d === end) depth--; }
      if (depth) bad('Unterminated Type 1 literal or procedure.'); return c === 40 ? '(literal)' : '{procedure}';
    }
    if ([91, 93, 60, 62].includes(c)) return String.fromCharCode(c);
    while (this.at < b.length && !whitespace(b[this.at]) && ![40, 41, 60, 62, 91, 93, 123, 125, 47, 37].includes(b[this.at])) this.at++;
    if (this.at - start > 16384) throw new PdfEngineError('Type 1 token length limit.', 'pdf_limit');
    return Array.from(b.subarray(start, this.at), value => String.fromCharCode(value)).join('');
  }
  binary(length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > 1024 * 1024 || !whitespace(this.bytes[this.at])) bad('Invalid Type 1 binary string length.');
    if (this.bytes[this.at++] === 13 && this.bytes[this.at] === 10) this.at++;
    if (this.at + length > this.bytes.length) bad('Truncated Type 1 binary string.');
    const value = this.bytes.slice(this.at, this.at + length); this.at += length; return value;
  }
}
const punctuation = ['space', 'exclam', 'quotedbl', 'numbersign', 'dollar', 'percent', 'ampersand', 'quotesingle', 'parenleft', 'parenright', 'asterisk', 'plus', 'comma', 'hyphen', 'period', 'slash'];
const digits = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const symbols = { 58: 'colon', 59: 'semicolon', 60: 'less', 61: 'equal', 62: 'greater', 63: 'question', 64: 'at', 91: 'bracketleft', 92: 'backslash', 93: 'bracketright', 94: 'asciicircum', 95: 'underscore', 96: 'grave', 123: 'braceleft', 124: 'bar', 125: 'braceright', 126: 'asciitilde' };
export function asciiGlyphName(code) { return code >= 32 && code <= 47 ? punctuation[code - 32] : code >= 48 && code <= 57 ? digits[code - 48] : code >= 65 && code <= 90 || code >= 97 && code <= 122 ? String.fromCharCode(code) : symbols[code] || '.notdef'; }
const standardHigh = { 161: 'exclamdown', 162: 'cent', 163: 'sterling', 164: 'fraction', 165: 'yen', 166: 'florin', 167: 'section', 168: 'currency', 169: 'quotesingle', 170: 'quotedblleft', 171: 'guillemotleft', 172: 'guilsinglleft', 173: 'guilsinglright', 174: 'fi', 175: 'fl', 177: 'endash', 178: 'dagger', 179: 'daggerdbl', 180: 'periodcentered', 182: 'paragraph', 183: 'bullet', 184: 'quotesinglbase', 185: 'quotedblbase', 186: 'quotedblright', 187: 'guillemotright', 188: 'ellipsis', 189: 'perthousand', 191: 'questiondown', 193: 'grave', 194: 'acute', 195: 'circumflex', 196: 'tilde', 197: 'macron', 198: 'breve', 199: 'dotaccent', 200: 'dieresis', 202: 'ring', 203: 'cedilla', 205: 'hungarumlaut', 206: 'ogonek', 207: 'caron', 208: 'emdash', 225: 'AE', 227: 'ordfeminine', 232: 'Lslash', 233: 'Oslash', 234: 'OE', 235: 'ordmasculine', 241: 'ae', 245: 'dotlessi', 248: 'lslash', 249: 'oslash', 250: 'oe', 251: 'germandbls' };
export function standardGlyphName(code) { return code === 39 ? 'quoteright' : code === 96 ? 'quoteleft' : code > 126 ? standardHigh[code] || '.notdef' : asciiGlyphName(code); }
export const isDingbatsFont = name => typeof name === 'string' && /^(?:[A-Z]{6}\+)?(?:ZapfDingbats|Dingbats)$/.test(name);
export function glyphNameText(name, { dingbats = false } = {}) {
  if (name === '.notdef') return '';
  if (typeof name !== 'string' || name.length > 256) return null;
  // Adobe AGL Specification: discard suffix, split components, map each whole
  // component. An unknown component cannot silently disappear from a ligature.
  const stem = name.split('.', 1)[0]; if (!stem) return null;
  let result = '';
  for (const component of stem.split('_')) {
    const mapped = dingbats && Object.hasOwn(glyphMappings.dingbats, component) ? glyphMappings.dingbats[component]
      : Object.hasOwn(glyphMappings.agl, component) ? glyphMappings.agl[component] : null;
    if (mapped !== null) { result += mapped; continue; }
    let codes;
    if (/^uni(?:[0-9A-Fa-f]{4})+$/.test(component)) codes = Array.from({ length: (component.length - 3) / 4 }, (_, i) => parseInt(component.slice(3 + i * 4, 7 + i * 4), 16));
    else if (/^u[0-9A-Fa-f]{4,6}$/.test(component)) codes = [parseInt(component.slice(1), 16)];
    else return null;
    if (codes.some(code => code > 0x10ffff || code >= 0xd800 && code <= 0xdfff)) return null;
    result += String.fromCodePoint(...codes);
  }
  return result;
}

export function parseType1Font(input, { length1 = null, length2 = null } = {}) {
  let bytes = input;
  if (bytes[0] === 128) {
    const chunks = []; let size = 0, at = 0;
    while (at < bytes.length) {
      if (bytes[at++] !== 128) bad('Invalid PFB segment marker.'); const kind = bytes[at++]; if (kind === 3) break;
      if (![1, 2].includes(kind) || at + 4 > bytes.length) bad('Invalid PFB segment.');
      const n = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, true); at += 4;
      if (at + n > bytes.length || (size += n) > 32 * 1024 * 1024) bad('PFB segment exceeds its input.');
      if (kind === 1 && !chunks.length) length1 = n; if (kind === 2) length2 = n;
      chunks.push(bytes.subarray(at, at + n)); at += n;
    }
    bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  }
  const clear = new Tokens(bytes), encoding = new Map(), matrix = [.001, 0, 0, .001, 0, 0];
  const history = []; let token, eexec = false;
  while ((token = clear.next()) !== null) {
    if (token === 'eexec') { eexec = true; break; }
    if (token === '/FontMatrix') {
      if (clear.next() !== '[') bad('Invalid Type 1 FontMatrix.');
      for (let i = 0; i < 6; i++) { matrix[i] = Number(clear.next()); if (!Number.isFinite(matrix[i])) bad('Invalid Type 1 font matrix number.'); }
      if (clear.next() !== ']') bad('Invalid Type 1 font matrix array.');
    }
    if (token === 'put' && history.at(-3) === 'dup' && /^\d+$/.test(history.at(-2)) && history.at(-1)?.startsWith('/')) {
      const code = Number(history.at(-2)); if (code < 256) encoding.set(code, history.at(-1).slice(1));
    }
    history.push(token); if (history.length > 4) history.shift();
  }
  if (!eexec) throw new PdfEngineError('Unencrypted or synthetic Type 1 font programs are not implemented yet.');
  let start = length1 ?? clear.at; if (length1 === null) while (whitespace(bytes[start])) start++;
  if (!Number.isSafeInteger(start) || start < clear.at || start > bytes.length) bad('Invalid Type 1 clear section length.');
  let encrypted = bytes.subarray(start, length2 === null ? bytes.length : start + length2);
  const first = Array.from(encrypted.subarray(0, 4), c => String.fromCharCode(c)).join('');
  if (/^[0-9a-fA-F]{4}$/.test(first)) {
    const hex = Array.from(encrypted, c => String.fromCharCode(c)).join('').replace(/\s/g, '');
    if (hex.length % 2 || /[^0-9a-fA-F]/.test(hex)) bad('Invalid hexadecimal Type 1 eexec section.');
    encrypted = Uint8Array.from({ length: hex.length / 2 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  }
  const privateData = new Tokens(decryptType1(encrypted, 55665)), subrs = [], glyphs = new Map(), previous = [];
  let lenIV = 4, section = '';
  while ((token = privateData.next()) !== null) {
    if (token === 'closefile') break;
    if (token === '/Subrs') section = 'subrs'; else if (token === '/CharStrings') section = 'glyphs';
    if (previous.at(-1) === '/lenIV') { lenIV = Number(token); if (!Number.isInteger(lenIV) || lenIV < -1 || lenIV > 32) bad('Invalid Type 1 lenIV.'); }
    if (token === 'RD' || token === '-|') {
      const length = Number(previous.at(-1)), binary = privateData.binary(length), decoded = lenIV === -1 ? binary : decryptType1(binary, 4330, lenIV);
      if (section === 'subrs' && previous.at(-3) === 'dup') { const index = Number(previous.at(-2)); if (!Number.isInteger(index) || index < 0 || index >= 65535) bad('Invalid Type 1 subroutine index.'); subrs[index] = decoded; }
      else if (section === 'glyphs' && previous.at(-2)?.startsWith('/')) glyphs.set(previous.at(-2).slice(1), decoded);
      else bad('Unrecognized Type 1 binary dictionary entry.');
    }
    previous.push(token); if (previous.length > 4) previous.shift();
  }
  if (!glyphs.size || glyphs.size > 65535) bad('Missing or excessive Type 1 charstrings.');
  return { glyphs, subrs, encoding, matrix };
}

export function createType1GlyphReader(reader, font) {
  const cache = new Map(), tablePointer = reader.copy(new Uint8Array(font.subrs.length * 8));
  for (let i = 0; i < font.subrs.length; i++) {
    const code = font.subrs[i]; if (!code) continue; const pointer = reader.copy(code), table = new DataView(reader.api.memory.buffer);
    table.setUint32(tablePointer + i * 8, pointer, true); table.setUint32(tablePointer + i * 8 + 4, code.length, true);
  }
  let total = 0;
  const glyph = (name, depth = 0) => {
    reader.check(); if (cache.has(name)) { const value = cache.get(name); cache.delete(name); cache.set(name, value); return value; } if (depth > 4) bad('Type 1 composite recursion limit.');
    const code = font.glyphs.get(name); if (!code) throw new PdfEngineError(`Missing Type 1 glyph ${name}.`, 'pdf_corrupt');
    reader.api.pn_pdf_mark(); let result;
    try {
      const pointer = reader.copy(code), capacity = 4096, output = reader.checked(reader.api.pn_pdf_alloc(capacity * 28));
      const address = reader.api.pn_t1_glyph(pointer, code.length, tablePointer, font.subrs.length, output, capacity), memory = new DataView(reader.api.memory.buffer);
      const status = memory.getUint32(address, true), count = memory.getUint32(address + 4, true);
      if (status && status !== 4) throw new PdfEngineError(`Type 1 charstring ${status === 1 ? 'operator is not implemented yet' : status === 3 ? 'resource limit exceeded' : 'is invalid'}.`, status === 3 ? 'pdf_limit' : status === 2 ? 'pdf_corrupt' : 'pdf_unsupported');
      const path = [];
      for (let i = 0; i < count; i++) { const at = output + i * 28, op = memory.getUint32(at, true), n = op === 3 ? 6 : op === 4 ? 0 : 2; path.push({ op, points: Array.from({ length: n }, (_, j) => memory.getFloat32(at + 4 + j * 4, true)) }); }
      result = { path, width: memory.getFloat64(address + 8, true), composite: status === 4 ? { base: memory.getUint32(address + 24, true), accent: memory.getUint32(address + 28, true), dx: memory.getFloat64(address + 32, true), dy: memory.getFloat64(address + 40, true) } : null };
    } finally { reader.api.pn_pdf_rewind(); }
    if (result.composite) {
      const c = result.composite, base = glyph(standardGlyphName(c.base), depth + 1), accent = glyph(standardGlyphName(c.accent), depth + 1);
      result.path.push(...base.path, ...accent.path.map(segment => ({ op: segment.op, points: segment.points.map((n, i) => n + (i % 2 ? c.dy : c.dx)) })));
    }
    if (result.path.length > 65536) throw new PdfEngineError('Type 1 composite glyph limit exceeded.', 'pdf_limit');
    total += result.path.length; cache.set(name, result);
    while (total > 65536) { const key = cache.keys().next().value; total -= cache.get(key).path.length; cache.delete(key); }
    return result;
  };
  return glyph;
}
