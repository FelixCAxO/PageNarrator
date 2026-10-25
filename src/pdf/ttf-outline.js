// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Native TrueType outline boundary. No font bytecode, Canvas or platform font API.
import { PdfEngineError } from './native-reader.js';

export const TRUE_TYPE_OUTLINE_LIMITS = Object.freeze({ fontBytes: 32 * 1024 * 1024, segments: 65536, points: 65536, work: 100000, depth: 16 });
export const TRUE_TYPE_OUTLINE_CACHE_BYTES = TRUE_TYPE_OUTLINE_LIMITS.segments * 128;
const SEGMENT_BYTES = 28, SCRATCH_BYTES = TRUE_TYPE_OUTLINE_LIMITS.points * (24 + 4);
const bad = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };

// Keep the source-code remap already used by Canvas text. Only the unremapped
// Unicode branch needs its actual one-codepoint paint string resolved by cmap.
export function simpleTrueTypeOutlineGlyph(code, glyph, sourceGlyphs, metrics) {
  if (!Number.isInteger(code) || code < 0 || code > 255 || glyph?.code !== code) bad('TrueType outline source code mismatch.');
  if (sourceGlyphs.has(code)) return sourceGlyphs.get(code);
  const paint = glyph.renderText || glyph.text;
  if (typeof paint !== 'string') bad('Missing TrueType glyph paint string.');
  const characters = [...paint];
  if (!characters.length) return null;
  if (characters.length !== 1) throw new PdfEngineError('An unremapped multi-character TrueType paint string has no single outline GID.', 'pdf_unsupported');
  return metrics.glyphId(characters[0].codePointAt(0));
}

export function cidTrueTypeOutlineGlyph(code, glyph, glyphForCid) {
  if (!Number.isInteger(code) || glyph?.code !== code || !Number.isInteger(glyph.cid) || glyph.cid < 0 || glyph.cid > 65535) bad('CID TrueType outline source mismatch.');
  return glyphForCid(glyph.cid);
}

export function createTrueTypeGlyphReader(reader, bytes, metrics) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > TRUE_TYPE_OUTLINE_LIMITS.fontBytes) throw new PdfEngineError('TrueType outline input limit exceeded.', 'pdf_limit');
  if (!Number.isInteger(metrics.units) || metrics.units < 16 || metrics.units > 16384 || !Number.isInteger(metrics.glyphCount) || metrics.glyphCount < 1 || metrics.glyphCount > 65535) bad('Invalid TrueType outline metrics.');
  const cache = new Map(); let retained = 0;
  return gid => {
    reader.check();
    if (!Number.isInteger(gid) || gid < 0 || gid >= metrics.glyphCount) bad('Invalid TrueType outline glyph index.');
    if (cache.has(gid)) { const value = cache.get(gid); cache.delete(gid); cache.set(gid, value); return value; }
    if (typeof reader.api.pn_ttf_glyph !== 'function') throw new PdfEngineError('TrueType outline export is unavailable.', 'pdf_configuration');
    reader.api.pn_pdf_mark();
    let outline;
    try {
      const input = reader.copy(bytes), capacity = TRUE_TYPE_OUTLINE_LIMITS.segments;
      const output = reader.checked(reader.api.pn_pdf_alloc(capacity * SEGMENT_BYTES));
      const scratch = reader.checked(reader.api.pn_pdf_alloc(SCRATCH_BYTES));
      const result = reader.checked(reader.api.pn_ttf_glyph(input, bytes.length, gid, output, capacity, scratch, SCRATCH_BYTES));
      // Native growth can replace memory.buffer: do not retain a pre-call view.
      const memory = new DataView(reader.api.memory.buffer);
      const status = memory.getUint32(result, true), count = memory.getUint32(result + 4, true);
      const points = memory.getUint32(result + 8, true), contours = memory.getUint32(result + 12, true), work = memory.getUint32(result + 16, true), units = memory.getUint32(result + 20, true);
      if (status) throw new PdfEngineError(`TrueType outline ${status === 1 ? 'container is unsupported' : status === 3 ? 'resource limit exceeded' : 'is invalid'}.`, status === 1 ? 'pdf_unsupported' : status === 3 ? 'pdf_limit' : 'pdf_corrupt');
      if (count > capacity || points > TRUE_TYPE_OUTLINE_LIMITS.points || contours > points || work > TRUE_TYPE_OUTLINE_LIMITS.work || units !== metrics.units) bad('Invalid TrueType outline result bounds.');
      const path = [];
      let inContour = false;
      for (let i = 0; i < count; i++) {
        const at = output + i * SEGMENT_BYTES, op = memory.getUint32(at, true);
        if (![1, 2, 3, 4].includes(op) || op === 1 && inContour || op !== 1 && !inContour) bad('Invalid TrueType outline segment order.');
        const n = op === 3 ? 6 : op === 4 ? 0 : 2;
        const values = Array.from({ length: n }, (_, j) => memory.getFloat32(at + 4 + j * 4, true));
        if (values.some(n => !Number.isFinite(n) || Math.abs(n) > 1e9)) bad('Invalid TrueType outline coordinate.');
        path.push({ op, points: values }); inContour = op !== 4;
      }
      if (inContour || path.filter(segment => segment.op === 4).length !== contours) bad('Unclosed TrueType outline contour.');
      outline = { outline: path, fontMatrix: [1 / units, 0, 0, 1 / units, 0, 0] };
      reader.check();
    } finally { reader.api.pn_pdf_rewind(); }
    // Even many empty glyphs have metadata: charge at least one cache unit.
    const charge = Math.max(1, outline.outline.length);
    while (retained + charge > TRUE_TYPE_OUTLINE_LIMITS.segments && cache.size) {
      const oldest = cache.keys().next().value; retained -= Math.max(1, cache.get(oldest).outline.length); cache.delete(oldest);
    }
    cache.set(gid, outline); retained += charge; return outline;
  };
}
