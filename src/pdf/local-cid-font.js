// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { readFontCmap, readCidUnicodeMap, cidUnicodeText } from './cmap-loader.js';
import { decodeCmapBytes, cmapResourceBytes } from './cmap-data.js';
import { readCidWidths } from './cff-pdf-font.js';
import { readTrueTypeMetrics } from './font-metrics.js';
import { pdfSystemGlyph } from './system-fonts.js';

const names = new Set(['SimSun', '\u00cb\u00ce\u00cc\u00e5']); // Exact GBK bytes for 宋体, not a generic PDF-name decoder.
const localFaces = Object.freeze(['SimSun', '宋体']);
const unsupported = message => { throw new PdfEngineError(message); };
const corrupt = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };
const field = (reader, id, key) => { const value = reader.field(id, key); return value && reader.node(value).kind !== 'null' ? value : null; };

/** Named unembedded GBK font substitution; CIDs retain PDF metrics, never host glyph indices. */
export async function loadLocalCidFont(reader, id, descendant, descriptor, loadAsset, { retainOutlines = false } = {}) {
  const base = reader.name(field(reader, id, 'BaseFont'));
  if (!names.has(base)) unsupported('This unembedded PDF CID font needs a supported font program.');
  if (retainOutlines) unsupported('This local PDF CID substitute has no original glyph outline support.');
  if (!descriptor || reader.name(field(reader, descendant, 'Subtype')) !== 'CIDFontType2'
    || reader.name(field(reader, descendant, 'BaseFont')) !== base || reader.name(field(reader, descriptor, 'FontName')) !== base) unsupported('This local PDF CID font needs consistent supported font names.');
  if (field(reader, descendant, 'CIDToGIDMap') || field(reader, id, 'ToUnicode')) unsupported('This local PDF CID font mapping is not implemented yet.');
  if (reader.number(field(reader, descriptor, 'Flags'), NaN) !== 5) unsupported('This local PDF CID font descriptor is not implemented yet.');
  const encodingId = field(reader, id, 'Encoding');
  if (reader.name(encodingId) !== 'GBK-EUC-H') unsupported('This local PDF CID font requires predefined horizontal GBK-EUC-H.');
  const info = field(reader, descendant, 'CIDSystemInfo');
  if (!info || reader.node(info).kind !== 'dictionary') corrupt('Invalid local PDF CID collection.');
  const literal = key => {
    const value = field(reader, info, key);
    if (!value || reader.node(value).kind !== 'string') corrupt('Invalid local PDF CID collection string.');
    return reader.text(value);
  };
  if (literal('Registry') !== 'Adobe' || literal('Ordering') !== 'GB1' || reader.number(field(reader, info, 'Supplement'), NaN) !== 2) unsupported('This local PDF CID collection is not implemented yet.');
  const encoding = await readFontCmap(reader, encodingId, loadAsset), canonical = await readCidUnicodeMap(reader, descendant, encoding, loadAsset);
  if (encoding.vertical || !canonical) unsupported('This local PDF CID encoding is not implemented yet.');
  const widths = readCidWidths(reader, descendant), defaultId = field(reader, descendant, 'DW');
  const defaultWidth = defaultId ? reader.number(defaultId, NaN) : 1000;
  const ascent = reader.number(field(reader, descriptor, 'Ascent'), NaN), descent = reader.number(field(reader, descriptor, 'Descent'), NaN);
  if (![defaultWidth, ascent, descent].every(Number.isFinite)) corrupt('Invalid local PDF CID font metrics.');
  // Existing licensed bytes register the family only. Required-local guards must
  // succeed before painting; these bytes never supply substituted CJK glyphs.
  const bytes = await loadAsset('standard_fonts/LiberationSans-Regular.ttf');
  readTrueTypeMetrics(bytes);
  let warned = false;
  return { bytes, family: `PageNarratorPdf${id}`, ascent: ascent / 1000, descent: descent / 1000,
    localFaces, requiresLocalFace: true, canProvideOutlines: false,
    resourceBytes: bytes.byteLength + cmapResourceBytes(encoding, canonical) + widths.size * 80,
    decode(source) {
      reader.check();
      const result = decodeCmapBytes(encoding, source).map(glyph => {
        const text = cidUnicodeText(canonical, glyph.cid);
        if (!glyph.cid || text === '\ufffd' || !pdfSystemGlyph(text)) unsupported('This local PDF CID glyph has no supported canonical Unicode mapping.');
        return { code: glyph.code, cid: glyph.cid, codeLength: glyph.codeLength, text, systemText: text, width: widths.get(glyph.cid) ?? defaultWidth };
      });
      if (result.length && !warned) {
        (reader.codecWarnings ||= []).push({ filter: 'FontSubstitution', sourceFont: '宋体', replacement: 'required local SimSun/宋体', requiresLocalFace: true }); warned = true;
      }
      return result;
    } };
}
