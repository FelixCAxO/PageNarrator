// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { readTrueTypeMetrics } from './font-metrics.js';
import { remapTrueTypeCmap, privateGlyphCode } from './font-container.js';
import { readCidWidths } from './cff-pdf-font.js';
import { readToUnicode, unicodeText, pdfFontResourceBytes } from './fonts.js';
import { decodePdfStream } from './streams.js';
import { readFontCmap, readCidUnicodeMap, cidUnicodeText } from './cmap-loader.js';
import { cmapCid, decodeCmapBytes, cmapResourceBytes } from './cmap-data.js';
import { readCidVerticalMetrics } from './cmap-font.js';
import { createTrueTypeGlyphReader, cidTrueTypeOutlineGlyph, TRUE_TYPE_OUTLINE_CACHE_BYTES } from './ttf-outline.js';

export async function loadCidTrueTypeFont(reader, id, descendant, file, loadAsset, { retainOutlines = false } = {}) {
  const encoding = await readFontCmap(reader, reader.field(id, 'Encoding'), loadAsset);
  const bytes = (await decodePdfStream(reader, file)).bytes, metrics = readTrueTypeMetrics(bytes, { requireCmap: false });
  const unicodeId = reader.field(id, 'ToUnicode'), unicode = unicodeId ? await readToUnicode(reader, unicodeId) : null;
  const cidUnicode = await readCidUnicodeMap(reader, descendant, encoding, loadAsset);
  const metricBudget = { used: 0 }, widths = readCidWidths(reader, descendant, metricBudget), fallback = reader.number(reader.field(descendant, 'DW'), 1000);
  if (!Number.isFinite(fallback)) throw new PdfEngineError('Invalid default CID width.', 'pdf_corrupt');
  const width = cid => widths.get(cid) ?? fallback, vertical = encoding.vertical ? readCidVerticalMetrics(reader, descendant, width, metricBudget) : null;
  const mapId = reader.field(descendant, 'CIDToGIDMap'), mapName = mapId && reader.name(mapId);
  if (mapName && mapName !== 'Identity') throw new PdfEngineError('Unsupported named CIDToGIDMap.');
  const map = mapId && !mapName ? (await decodePdfStream(reader, mapId)).bytes : null;
  if (map && (map.length % 2 || map.length > 131072)) throw new PdfEngineError('Invalid CIDToGIDMap size.', 'pdf_corrupt');
  const glyph = code => { const gid = map ? code * 2 + 1 < map.length ? map[code * 2] * 256 + map[code * 2 + 1] : 0 : code; if (gid >= metrics.glyphCount) throw new PdfEngineError('CID references an absent TrueType glyph.', 'pdf_corrupt'); return gid; };
  const aliases = new Map();
  for (const [code, text] of unicode ?? []) if ([...text].length === 1) {
    const cid = cmapCid(encoding, code), gid = map ? cid * 2 + 1 < map.length ? map[cid * 2] * 256 + map[cid * 2 + 1] : 0 : cid;
    if (gid < metrics.glyphCount) aliases.set(text.codePointAt(0), gid);
  }
  if (!unicode && !cidUnicode) for (let gid = 1; gid < metrics.glyphCount; gid++) {
    const text = metrics.unicodeForGlyph(gid); if (text) aliases.set(text.codePointAt(0), gid);
  }
  const converted = remapTrueTypeCmap(bytes, metrics.glyphCount, aliases);
  const retainedCidBytes = cmapResourceBytes(encoding, cidUnicode) + widths.size * 80 + (vertical?.resourceBytes || 0) + (map?.byteLength || 0);
  const readOutline = retainOutlines ? createTrueTypeGlyphReader(reader, converted, metrics) : null;
  const outlineFields = readOutline ? { glyphOutline(code, decoded) { return readOutline(cidTrueTypeOutlineGlyph(code, decoded, glyph)); } } : {};
  return { bytes: converted, canProvideOutlines: true, ...outlineFields, resourceBytes: pdfFontResourceBytes(converted, unicode, retainedCidBytes + (retainOutlines ? TRUE_TYPE_OUTLINE_CACHE_BYTES : 0)), family: `PageNarratorPdf${id}`, ascent: metrics.ascent, descent: metrics.descent, vertical: encoding.vertical,
    decode(source) {
      const result = [];
      for (const { code, cid, codeLength, sourceKey } of decodeCmapBytes(encoding, source)) {
        const gid = glyph(cid), text = unicodeText(unicode, sourceKey) ?? cidUnicodeText(cidUnicode, cid) ?? metrics.unicodeForGlyph(gid);
        result.push({ code, cid, codeLength, text: text ?? String.fromCodePoint(privateGlyphCode(gid)), width: width(cid),
          renderText: String.fromCodePoint(privateGlyphCode(gid)), ...(vertical ? { vmetric: vertical(cid) } : {}), ...(text === undefined ? { unmapped: true } : {}) });
      }
      return result;
    } };
}
