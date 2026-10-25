// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { parseCffFont, readCffWidths } from './cff-font.js';
import { retainCffOutlines } from './cff-outline.js';
import { buildCffOpenType, privateGlyphCode } from './font-container.js';
import { glyphNameText, isDingbatsFont } from './type1-font.js';
import { readToUnicode, unicodeText, pdfFontResourceBytes } from './fonts.js';
import { readFontCmap, readCidUnicodeMap, cidUnicodeText } from './cmap-loader.js';
import { cmapCid, decodeCmapBytes, cmapResourceBytes } from './cmap-data.js';
import { readCidVerticalMetrics, chargeCidMetricWork } from './cmap-font.js';
import { predefinedPdfGlyphNames } from './predefined-encodings.js';
import { pdfSystemGlyph } from './system-fonts.js';
import { pdfLatinGlyphName, pdfLatinGlyphText } from './latin-encodings.js';
import { recognizedPdfSymbol } from './symbol-fonts.js';

export function readCidWidths(reader, descriptor, budget = { used: 0 }) {
  const widths = new Map(), id = reader.field(descriptor, 'W'); if (!id) return widths;
  const values = reader.array(id);
  for (let i = 0; i < values.length;) {
    const first = reader.number(values[i++], -1), next = values[i++];
    if (!Number.isInteger(first) || first < 0 || first > 65535 || !next) throw new PdfEngineError('Invalid CID width range.', 'pdf_corrupt');
    if (reader.node(next).kind === 'array') {
      const array = reader.array(next); chargeCidMetricWork(budget, array.length);
      for (const [j, value] of array.entries()) { const width = reader.number(value, NaN); if (!Number.isFinite(width) || first + j > 65535) throw new PdfEngineError('Invalid CID width.', 'pdf_corrupt'); widths.set(first + j, width); }
    } else {
      const last = reader.number(next, -1), width = reader.number(values[i++], NaN);
      if (!Number.isInteger(last) || last < first || last > 65535 || !Number.isFinite(width)) throw new PdfEngineError('Invalid CID width interval.', 'pdf_corrupt');
      chargeCidMetricWork(budget, last - first + 1);
      for (let code = first; code <= last; code++) widths.set(code, width);
    }
  }
  return widths;
}

export async function loadCffPdfFont(reader, id, bytes, { descendant = null, descriptor = null, loadAsset = null, predefinedEncoding = null, retainOutlines = false } = {}) {
  const glyphOptions = { dingbats: isDingbatsFont(reader.name(reader.field(id, 'BaseFont'))) };
  const font = parseCffFont(bytes), advances = readCffWidths(reader, font), encoding = reader.field(id, 'Encoding');
  const negativeAdvances = advances.filter(width => width < 0).length;
  if (negativeAdvances) (reader.codecWarnings ||= []).push({ filter: 'CFF', clampedBrowserAdvanceWidths: negativeAdvances });
  if (font.nameRepairs.length) (reader.codecWarnings ||= []).push({ filter: 'CFF', sanitizedFontNameBytes: font.nameRepairs.length });
  const unicodeId = reader.field(id, 'ToUnicode'), unicode = unicodeId ? await readToUnicode(reader, unicodeId) : null;
  const names = new Map(), mapping = new Map(font.encoding), textByCode = new Map(), sourceTextByCode = new Map(), symbolsByCode = new Map(), aliases = new Map();
  let widths, defaultWidth, cidEncoding, cidUnicode, verticalMetrics;
  const metricBudget = { used: 0 };
  if (descendant) {
    if (!font.cid) throw new PdfEngineError('CID CFF requires a CID-keyed font program.');
    cidEncoding = await readFontCmap(reader, encoding, loadAsset);
    cidUnicode = await readCidUnicodeMap(reader, descendant, cidEncoding, loadAsset);
    widths = readCidWidths(reader, descendant, metricBudget); defaultWidth = reader.number(reader.field(descendant, 'DW'), 1000);
    if (!Number.isFinite(defaultWidth)) throw new PdfEngineError('Invalid default CID CFF width.', 'pdf_corrupt');
    if (cidEncoding.vertical) verticalMetrics = readCidVerticalMetrics(reader, descendant, cid => widths.get(cid) ?? defaultWidth, metricBudget);
    for (const [cid, gid] of font.byCid) mapping.set(cid, gid);
    for (const [cid, gid] of mapping) { const target = cidUnicodeText(cidUnicode, cid); if (target && [...target].length === 1) aliases.set(target.codePointAt(0), gid); }
    for (const [source, target] of unicode ?? []) {
      const gid = mapping.get(cmapCid(cidEncoding, source)); if (gid !== undefined && [...target].length === 1) aliases.set(target.codePointAt(0), gid);
    }
  } else {
    let base = encoding && reader.node(encoding).kind === 'name' ? reader.name(encoding) : encoding ? reader.name(reader.field(encoding, 'BaseEncoding')) : null;
    if (base && !['StandardEncoding', 'WinAnsiEncoding', 'MacRomanEncoding'].includes(base)) throw new PdfEngineError(`CFF PDF encoding ${base} is not implemented yet.`);
    if (base) for (let code = 0; code < 256; code++) names.set(code, pdfLatinGlyphName(base, code));
    else if (predefinedEncoding) for (const [code, name] of predefinedPdfGlyphNames(predefinedEncoding) || []) names.set(code, name);
    if (encoding && reader.node(encoding).kind === 'dictionary') {
      const differences = reader.field(encoding, 'Differences'); let at = 0;
      if (differences) for (const value of reader.array(differences)) { const n = reader.node(value); if (n.kind === 'number') { at = n.number; if (!Number.isInteger(at) || at < 0 || at > 255) throw new PdfEngineError('Invalid CFF encoding difference.', 'pdf_corrupt'); } else if (n.kind === 'name' && at < 256) names.set(at++, reader.text(n)); else throw new PdfEngineError('Invalid CFF encoding difference.', 'pdf_corrupt'); }
    }
    for (const [code, name] of names) { const gid = font.byName.get(name); if (gid !== undefined) mapping.set(code, gid); else mapping.delete(code); }
    const first = reader.number(reader.field(id, 'FirstChar'), 0), widthsId = reader.field(id, 'Widths'); widths = new Map();
    if (widthsId) for (const [i, value] of reader.array(widthsId).entries()) { const width = reader.number(value, NaN); if (!Number.isFinite(width)) throw new PdfEngineError('Invalid CFF PDF width.', 'pdf_corrupt'); widths.set(first + i, width); }
    for (const [code, gid] of mapping) {
      const name = names.get(code) ?? [...font.byName].find(([, value]) => value === gid)?.[0];
      if (predefinedEncoding && gid !== 0) sourceTextByCode.set(code, pdfSystemGlyph(glyphNameText(name, glyphOptions)));
      const explicit = unicode?.get(code.toString(16).padStart(2, '0'));
      const symbol = explicit === undefined && gid !== 0 ? recognizedPdfSymbol(reader.name(reader.field(id, 'BaseFont')), name) : null;
      if (symbol) symbolsByCode.set(code, { ...symbol, sourceCode: code });
      const text = explicit ?? symbol?.text ?? (base ? pdfLatinGlyphText(base, code, name, glyphOptions) : glyphNameText(name, glyphOptions));
      if (text !== null && text !== undefined) textByCode.set(code, text);
    }
  }
  for (const [code, text] of textByCode) { const points = [...text], gid = mapping.get(code); if (points.length === 1 && gid !== undefined) aliases.set(points[0].codePointAt(0), gid); }
  const converted = buildCffOpenType(font, advances, aliases);
  const ascent = descriptor ? reader.number(reader.field(descriptor, 'Ascent'), 1000) / 1000 : .9;
  const descent = descriptor ? reader.number(reader.field(descriptor, 'Descent'), -250) / 1000 : -.25;
  const retained = retainOutlines ? retainCffOutlines(reader, font, mapping) : null;
  const retainedCidBytes = descendant ? cmapResourceBytes(cidEncoding, cidUnicode) + widths.size * 80 + (verticalMetrics?.resourceBytes || 0) : 0;
  return { bytes: converted, resourceBytes: pdfFontResourceBytes(converted, unicode, retainedCidBytes + (retained?.resourceBytes || 0)), family: `PageNarratorPdf${id}`, ascent, descent, vertical: cidEncoding?.vertical ?? false,
    canProvideOutlines: true, ...(retained ? { glyphOutline: retained.glyphOutline } : {}),
    decode(source) {
      const result = [];
      const codes = cidEncoding ? decodeCmapBytes(cidEncoding, source) : Array.from(source, code => ({ code, cid: code, codeLength: 1, sourceKey: code.toString(16).padStart(2, '0') }));
      for (const { code, cid, codeLength, sourceKey } of codes) {
        const gid = mapping.get(cid) ?? 0;
        const target = unicodeText(unicode, sourceKey), text = cidEncoding ? target ?? cidUnicodeText(cidUnicode, cid) : textByCode.get(code);
        result.push({ code, cid, codeLength, text: text ?? String.fromCodePoint(0xe000 + cid % 6400), width: widths.get(cid) ?? defaultWidth ?? advances[gid],
          renderText: String.fromCodePoint(privateGlyphCode(gid)), ...(symbolsByCode.has(code) ? { symbol: symbolsByCode.get(code) } : {}), ...(predefinedEncoding ? { systemText: sourceTextByCode.get(code) } : {}),
          ...(verticalMetrics ? { vmetric: verticalMetrics(cid) } : {}), ...(text === undefined ? { unmapped: true } : {}) });
      }
      return result;
    } };
}
