// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { readToUnicode, unicodeText, pdfFontResourceBytes } from './fonts.js';
import { readFontCmap, readCidUnicodeMap, cidUnicodeText } from './cmap-loader.js';
import { decodeCmapBytes, cmapResourceBytes } from './cmap-data.js';
import { readCidWidths } from './cff-pdf-font.js';
import { readCidVerticalMetrics } from './cmap-font.js';
import { readTrueTypeMetrics } from './font-metrics.js';
import { createTrueTypeGlyphReader, TRUE_TYPE_OUTLINE_CACHE_BYTES, TRUE_TYPE_OUTLINE_LIMITS } from './ttf-outline.js';

/** Substitute visuals only: source codes, CIDs and Unicode remain separate. */
export async function loadFallbackCidFont(reader, id, descendant, descriptor, loadAsset, { retainOutlines = false } = {}) {
  const subtype = reader.name(reader.field(descendant, 'Subtype'));
  if (!['CIDFontType0', 'CIDFontType2'].includes(subtype)) throw new PdfEngineError(`PDF descendant font ${subtype} is not implemented yet.`);
  const encoding = await readFontCmap(reader, reader.field(id, 'Encoding'), loadAsset);
  const unicodeId = reader.field(id, 'ToUnicode');
  const unicode = unicodeId && reader.node(unicodeId).kind !== 'null' ? await readToUnicode(reader, unicodeId) : null;
  const canonical = await readCidUnicodeMap(reader, descendant, encoding, loadAsset);
  const budget = { used: 0 }, widths = readCidWidths(reader, descendant, budget);
  const defaultWidth = reader.number(reader.field(descendant, 'DW'), 1000);
  if (!Number.isFinite(defaultWidth)) throw new PdfEngineError('Invalid default CID width.', 'pdf_corrupt');
  const width = cid => widths.get(cid) ?? defaultWidth;
  const vertical = encoding.vertical ? readCidVerticalMetrics(reader, descendant, width, budget) : null;
  const asset = 'LiberationSans-Regular.ttf', bytes = await loadAsset(`standard_fonts/${asset}`), metrics = readTrueTypeMetrics(bytes);
  const readOutline = retainOutlines ? createTrueTypeGlyphReader(reader, bytes, metrics) : null;
  let warned = false;
  return { bytes, family: `PageNarratorPdf${id}`, ascent: metrics.ascent, descent: metrics.descent, vertical: encoding.vertical,
    canProvideOutlines: true,
    resourceBytes: pdfFontResourceBytes(bytes, unicode, cmapResourceBytes(encoding, canonical) + widths.size * 80 + (vertical?.resourceBytes || 0) + (readOutline ? TRUE_TYPE_OUTLINE_CACHE_BYTES : 0)),
    ...(readOutline ? { glyphOutline(code, glyph) {
      reader.check();
      if (glyph.code !== code) throw new PdfEngineError('Fallback outline source code mismatch.', 'pdf_corrupt');
      const outline = []; let advance = 0;
      for (const character of glyph.renderText) {
        const gid = metrics.glyphId(character.codePointAt(0));
        if (!gid) throw new PdfEngineError('Substitute PDF font has no outline for the mapped character.');
        const path = readOutline(gid);
        if (outline.length + path.outline.length > TRUE_TYPE_OUTLINE_LIMITS.segments) throw new PdfEngineError('Fallback glyph outline limit exceeded.', 'pdf_limit');
        for (const segment of path.outline) outline.push({ op: segment.op, points: segment.points.map((point, i) => point + (i % 2 ? 0 : advance)) });
        advance += metrics.widthByGlyph(gid) * metrics.units / 1000;
      }
      return { outline, fontMatrix: [1 / metrics.units, 0, 0, 1 / metrics.units, 0, 0] };
    } } : {}),
    decode(source) {
      reader.check();
      const glyphs = decodeCmapBytes(encoding, source).map(glyph => {
        const explicit = unicodeText(unicode, glyph.sourceKey), text = explicit ?? cidUnicodeText(canonical, glyph.cid);
        const unmapped = text === undefined || text === '\ufffd';
        const paint = text ?? '\ufffd';
        return { code: glyph.code, codeLength: glyph.codeLength, cid: glyph.cid, text: paint, renderText: paint, width: width(glyph.cid),
          ...(unmapped ? { unmapped: true } : {}), ...(vertical ? { vmetric: vertical(glyph.cid) } : {}) };
      });
      if (source.length && !warned) {
        (reader.codecWarnings ||= []).push({ filter: 'FontSubstitution', sourceFont: reader.name(reader.field(id, 'BaseFont')), replacement: asset }); warned = true;
      }
      return glyphs;
    } };
}
