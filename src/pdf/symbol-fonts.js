// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import mappings from '../../vendor/pdf-symbols/mappings.json' with { type: 'json' };
const styles = Object.freeze({ 'FontAwesome5Brands-Regular': 'brands', 'FontAwesome5Free-Regular': 'regular', 'FontAwesome5Free-Solid': 'solid' });
const encoded = new Map();
for (const [name, entry] of Object.entries(mappings.fontAwesome)) for (const style of entry.styles) encoded.set(`${style}:${entry.unicode}`, name);

/** Identify only a documented glyph in its declared symbol font, never an arbitrary glyph name. */
export function recognizedPdfSymbol(fontName, glyphName) {
  if (typeof fontName !== 'string' || fontName.length > 256 || typeof glyphName !== 'string' || glyphName.length > 256) return null;
  const family = fontName.replace(/^[A-Z]{6}\+/, ''), stem = glyphName.split('.', 1)[0];
  let name = stem, entry;
  if (Object.hasOwn(styles, family)) {
    const style = styles[family];
    if (!Object.hasOwn(mappings.fontAwesome, name) && /^(?:uni|u)[0-9A-Fa-f]{4}$/.test(stem)) name = encoded.get(`${style}:${stem.replace(/^(?:uni|u)/, '').toLowerCase()}`);
    entry = name && Object.hasOwn(mappings.fontAwesome, name) ? mappings.fontAwesome[name] : null;
    if (!entry?.styles.includes(style)) return null;
    return { kind: 'nontext', fontFamily: family, glyphName, name, label: entry.label, unicode: entry.unicode, text: String.fromCodePoint(parseInt(entry.unicode, 16)) };
  }
  if (family !== 'MarVoSym' || !Object.hasOwn(mappings.marvosym, stem)) return null;
  entry = mappings.marvosym[stem];
  return { kind: 'nontext', fontFamily: family, glyphName, name: stem, label: entry.label, unicode: null, text: '\ufffc', originalEncodingCode: entry.code };
}

/** Keep source text/selectable geometry intact; mask only independently identifiable nontext ranges. */
export function pdfNarrationSource(item) {
  const text = String(item?.str ?? ''), ranges = item?.recognizedSymbols;
  if (!Array.isArray(ranges) || !ranges.length || ranges.length > text.length) return text;
  const output = text.split(''); let previous = 0;
  for (const range of ranges) {
    if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.length) || range.start < previous || range.length < 1 || range.start + range.length > text.length) continue;
    const symbol = recognizedPdfSymbol(range.fontFamily, range.glyphName);
    if (!symbol || range.kind !== 'nontext' || range.name !== symbol.name || range.unicode !== symbol.unicode || range.label !== symbol.label
      || text.slice(range.start, range.start + range.length) !== symbol.text) continue;
    output.fill(' ', range.start, range.start + range.length); previous = range.start + range.length;
  }
  return output.join('');
}
