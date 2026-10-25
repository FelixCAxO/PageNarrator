// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { readToUnicode, unicodeText, pdfFontResourceBytes } from './fonts.js';
import { standardGlyphName, glyphNameText } from './type1-font.js';
export async function loadType3PdfFont(reader, id, loadAsset) {
  const encoding = reader.field(id, 'Encoding'), names = new Map();
  for (let code = 0; code < 256; code++) names.set(code, standardGlyphName(code));
  if (encoding) {
    if (reader.node(encoding).kind !== 'dictionary') throw new PdfEngineError('Named Type3 encodings are not implemented yet.');
    const differences = reader.field(encoding, 'Differences'); let at = 0;
    if (differences) for (const value of reader.array(differences)) {
      const n = reader.node(value); if (n.kind === 'number') { at = n.number; if (!Number.isInteger(at) || at < 0 || at > 255) throw new PdfEngineError('Invalid Type3 encoding code.', 'pdf_corrupt'); }
      else if (n.kind === 'name' && at < 256) names.set(at++, reader.text(n)); else throw new PdfEngineError('Invalid Type3 encoding difference.', 'pdf_corrupt');
    }
  }
  const procedures = reader.field(id, 'CharProcs'), matrixId = reader.field(id, 'FontMatrix'), boxId = reader.field(id, 'FontBBox'), widthsId = reader.field(id, 'Widths');
  if (!procedures || !matrixId || !boxId || !widthsId) throw new PdfEngineError('Missing Type3 font data.', 'pdf_corrupt');
  const matrix = reader.array(matrixId).map(id => reader.number(id, NaN)), box = reader.array(boxId).map(id => reader.number(id, NaN));
  if (matrix.length !== 6 || box.length !== 4 || [...matrix, ...box].some(n => !Number.isFinite(n))) throw new PdfEngineError('Invalid Type3 font geometry.', 'pdf_corrupt');
  const first = reader.number(reader.field(id, 'FirstChar'), 0), widths = reader.array(widthsId).map(id => reader.number(id, NaN) * matrix[0] * 1000);
  if (!Number.isInteger(first) || first < 0 || widths.some(n => !Number.isFinite(n))) throw new PdfEngineError('Invalid Type3 font widths.', 'pdf_corrupt');
  const unicodeId = reader.field(id, 'ToUnicode'), unicode = unicodeId ? await readToUnicode(reader, unicodeId) : null, resources = reader.field(id, 'Resources');
  const bytes = await loadAsset('standard_fonts/LiberationSans-Regular.ttf'); let warnedUnknownText = false;
  return { bytes, resourceBytes: pdfFontResourceBytes(bytes, unicode), family: `PageNarratorPdf${id}`, ascent: box[3] * matrix[3], descent: box[1] * matrix[3],
    decode(bytes) {
      return Array.from(bytes, code => {
        const name = names.get(code), text = unicodeText(unicode, code.toString(16).padStart(2, '0')) ?? glyphNameText(name), stream = reader.field(procedures, name);
        if (!stream || code < first || code - first >= widths.length) throw new PdfEngineError('Missing Type3 glyph or width.', 'pdf_corrupt');
        const unknown = text === null || text === undefined;
        if (unknown && !warnedUnknownText) { (reader.codecWarnings ||= []).push({ filter: 'Type3', unknownType3Text: true }); warnedUnknownText = true; }
        return { code, text: text ?? String.fromCodePoint(0xe000 + code), width: widths[code - first],
          ...(unknown ? { unmapped: true, unknownType3Text: true } : {}), type3: { stream, matrix, resources } };
      });
    } };
}
