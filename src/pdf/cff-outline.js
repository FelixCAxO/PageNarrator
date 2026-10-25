// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original CFF1 Type2 path ABI. No charstring or PostScript is evaluated in JS.
import { PdfEngineError } from './native-reader.js';
import { standardGlyphName } from './type1-font.js';
import { multiply } from './viewport.js';

const MAX_SEGMENTS = 65_536, MAX_CACHE_ENTRIES = 256, MAX_INPUT_BYTES = 16 * 1024 * 1024;
const corrupt = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };
const limit = message => { throw new PdfEngineError(message, 'pdf_limit'); };
const bounded = n => Number.isFinite(n) && Math.abs(n) <= 1e9;
const index = (n, length) => Number.isInteger(n) && n >= 0 && n < length;
function validMatrix(value) {
  if (!Array.isArray(value) || value.length !== 6 || !value.every(bounded)) corrupt('Invalid CFF outline FontMatrix.');
  const determinant = value[0] * value[3] - value[1] * value[2];
  if (!Number.isFinite(determinant) || determinant === 0) corrupt('Singular CFF outline FontMatrix.');
  return value;
}

// With no explicit top matrix the selected FD matrix already maps to text space.
// An explicit top matrix composes after the FD matrix; neither is normalized away.
export function cffGlyphMatrix(font, gid) {
  if (!font || !Array.isArray(font.glyphs) || !(font.selection instanceof Uint16Array) || !Array.isArray(font.locals)
    || !index(gid, font.glyphs.length) || !index(font.selection[gid], font.locals.length)
    || typeof font.topMatrixExplicit !== 'boolean' || !Array.isArray(font.fontDictMatrices)
    || font.fontDictMatrices.length !== font.locals.length) corrupt('Invalid CFF outline FD metadata.');
  const top = validMatrix(font.matrix), local = font.fontDictMatrices[font.selection[gid]];
  const value = local === null ? top : font.topMatrixExplicit ? multiply(top, validMatrix(local)) : validMatrix(local);
  return Object.freeze([...validMatrix(value)]);
}

function validateProgram(font) {
  if (!font || typeof font !== 'object') corrupt('Missing CFF outline program.');
  if (font.charstringType !== 2) throw new PdfEngineError('This CFF charstring type has no Type2 outline support.');
  if (!Array.isArray(font.glyphs) || !font.glyphs.length || font.glyphs.length > 65_535
    || !(font.selection instanceof Uint16Array) || font.selection.length !== font.glyphs.length
    || !Array.isArray(font.locals) || !font.locals.length || font.locals.length > 256
    || !Array.isArray(font.globalSubrs) || font.globalSubrs.length > 65_536
    || typeof font.cid !== 'boolean' || !(font.byName instanceof Map)) corrupt('Invalid CFF outline program.');
  let bytes = 0;
  const routines = values => {
    if (!Array.isArray(values) || values.length > 65_536) corrupt('Invalid CFF outline subroutines.');
    for (const code of values) {
      if (!(code instanceof Uint8Array) || !code.length || code.length > 65_535) corrupt('Invalid CFF outline charstring bytes.');
      bytes += code.byteLength + 64;
      if (bytes > 32 * 1024 * 1024) limit('CFF retained outline program exceeds its limit.');
    }
  };
  routines(font.glyphs); routines(font.globalSubrs);
  for (const local of font.locals) {
    routines(local.subrs);
    if (!bounded(local.nominal) || !bounded(local.fallback) || !Number.isInteger(local.initialRandomSeed)
      || local.initialRandomSeed < -2147483648 || local.initialRandomSeed > 2147483647) corrupt('Invalid CFF outline private values.');
  }
  for (let gid = 0; gid < font.glyphs.length; gid++) cffGlyphMatrix(font, gid);
  return bytes;
}

export function createCffGlyphReader(reader, font) {
  reader.check();
  if (typeof reader.api.pn_cff_glyph !== 'function') throw new PdfEngineError('CFF outline export is not installed.', 'pdf_configuration');
  const retainedBytes = validateProgram(font), cache = new Map(), active = new Set();
  let cachedSegments = 0;
  const glyph = (gid, component = false) => {
    reader.check();
    if (!index(gid, font.glyphs.length)) corrupt('CFF outline glyph is absent.');
    if (active.has(gid)) corrupt('Cyclic CFF component.');
    if (cache.has(gid)) {
      const value = cache.get(gid);
      if (component && value.composite) corrupt('Nested CFF endchar components are invalid.');
      cache.delete(gid); cache.set(gid, value); return value;
    }
    const local = font.locals[font.selection[gid]], code = font.glyphs[gid];
    let copied = code.byteLength + (font.globalSubrs.length + local.subrs.length) * 8;
    for (const bytes of [...font.globalSubrs, ...local.subrs]) copied += bytes.byteLength;
    if (copied > MAX_INPUT_BYTES) limit('CFF outline invocation input exceeds its limit.');
    active.add(gid);
    let value;
    try {
      reader.api.pn_pdf_mark();
      try {
        const table = routines => {
          if (!routines.length) return 0;
          const pointer = reader.copy(new Uint8Array(routines.length * 8));
          routines.forEach((bytes, i) => {
            const codePointer = reader.copy(bytes), memory = new DataView(reader.api.memory.buffer);
            memory.setUint32(pointer + i * 8, codePointer, true); memory.setUint32(pointer + i * 8 + 4, bytes.length, true);
          });
          return pointer;
        };
        const localTable = table(local.subrs), globalTable = table(font.globalSubrs), pointer = reader.copy(code);
        const output = reader.checked(reader.api.pn_pdf_alloc(MAX_SEGMENTS * 28));
        const address = reader.checked(reader.api.pn_cff_glyph(pointer, code.length, localTable, local.subrs.length,
          globalTable, font.globalSubrs.length, local.nominal, local.fallback, local.initialRandomSeed >>> 0, output, MAX_SEGMENTS));
        reader.check();
        const memory = new DataView(reader.api.memory.buffer);
        if (!Number.isInteger(address) || address < 0 || address + 56 > memory.byteLength
          || output < 0 || output + MAX_SEGMENTS * 28 > memory.byteLength) corrupt('CFF outline ABI range is invalid.');
        const status = memory.getUint32(address, true), count = memory.getUint32(address + 4, true);
        const work = memory.getUint32(address + 48, true), hints = memory.getUint32(address + 52, true);
        if (status > 4) corrupt('Unknown CFF outline status.');
        if (status && status !== 4) throw new PdfEngineError(`CFF outline ${status === 1 ? 'operator is not implemented' : status === 3 ? 'resource limit exceeded' : 'is invalid'}.`,
          status === 3 ? 'pdf_limit' : status === 2 ? 'pdf_corrupt' : 'pdf_unsupported');
        if (count > MAX_SEGMENTS || work > 100_000 || hints > 96) limit('CFF outline ABI count exceeds its limit.');
        const path = [];
        for (let i = 0; i < count; i++) {
          const at = output + i * 28, op = memory.getUint32(at, true), length = op === 3 ? 6 : op === 4 ? 0 : op === 1 || op === 2 ? 2 : -1;
          if (length < 0) corrupt('Invalid CFF outline segment.');
          const points = Array.from({ length }, (_, j) => memory.getFloat32(at + 4 + j * 4, true));
          if (!points.every(bounded)) corrupt('Non-finite CFF outline coordinates.');
          path.push({ op, points });
        }
        const width = memory.getFloat64(address + 8, true), widthY = memory.getFloat64(address + 16, true);
        if (!bounded(width) || widthY !== 0) corrupt('Invalid CFF outline advance.');
        const composite = status === 4 ? { base: memory.getUint32(address + 24, true), accent: memory.getUint32(address + 28, true),
          dx: memory.getFloat64(address + 32, true), dy: memory.getFloat64(address + 40, true) } : null;
        if (composite && (component || font.cid || count || composite.base > 255 || composite.accent > 255
          || !bounded(composite.dx) || !bounded(composite.dy))) corrupt('Invalid CFF endchar component.');
        value = { path, width, composite, fontMatrix: cffGlyphMatrix(font, gid), work, hints };
      } finally { reader.api.pn_pdf_rewind(); }
      if (value.composite) {
        const c = value.composite;
        const named = code => { const name = standardGlyphName(code); if (name === '.notdef' || !font.byName.has(name)) corrupt('Missing CFF StandardEncoding component.'); return glyph(font.byName.get(name), true); };
        const base = named(c.base), accent = named(c.accent);
        if (base.path.length + accent.path.length > MAX_SEGMENTS) limit('CFF component path exceeds its limit.');
        value.path = [...base.path, ...accent.path.map(segment => ({ op: segment.op,
          points: segment.points.map((n, i) => n + (i % 2 ? c.dy : c.dx)) }))];
        if (value.path.some(segment => !segment.points.every(bounded))) limit('CFF component coordinates exceed their limit.');
      }
      value.path.forEach(segment => { Object.freeze(segment.points); Object.freeze(segment); });
      if (value.composite) Object.freeze(value.composite); Object.freeze(value.path); Object.freeze(value);
      cache.set(gid, value); cachedSegments += value.path.length;
      while (cachedSegments > MAX_SEGMENTS || cache.size > MAX_CACHE_ENTRIES) {
        const first = cache.keys().next().value; cachedSegments -= cache.get(first).path.length; cache.delete(first);
      }
      return value;
    } finally { active.delete(gid); }
  };
  return { glyph, resourceBytes: retainedBytes + MAX_SEGMENTS * 128 + MAX_CACHE_ENTRIES * 128 };
}

// Source code remains distinct from CID/GID. The caller supplies its actual decoded glyph.
export function retainCffOutlines(reader, font, mapping) {
  const source = createCffGlyphReader(reader, font);
  return { resourceBytes: source.resourceBytes, glyphOutline(code, decoded) {
    if (!Number.isInteger(code) || code < 0 || code > 0xffffffff || decoded && decoded.code !== code) corrupt('Invalid CFF outline source code.');
    if (font.cid && (!decoded || !Number.isInteger(decoded.cid) || decoded.cid < 0 || decoded.cid > 65535)) corrupt('CFF outline needs its decoded CID.');
    const gid = mapping.get(font.cid ? decoded.cid : code) ?? 0;
    const value = source.glyph(gid);
    return { outline: value.path, fontMatrix: value.fontMatrix };
  } };
}
