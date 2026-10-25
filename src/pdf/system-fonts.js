// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
const faces = new Map();
for (const [pdfNames, localNames] of [
  [['Times-Roman', 'TimesNewRoman', 'TimesNewRomanPSMT'], ['Times New Roman', 'TimesNewRomanPSMT', 'Liberation Serif']],
  [['Times-Bold', 'TimesNewRomanPS-BoldMT'], ['Times New Roman Bold', 'TimesNewRomanPS-BoldMT', 'Liberation Serif Bold']],
  [['Times-Italic', 'TimesNewRomanPS-ItalicMT', 'TimesNewRoman,Italic'], ['Times New Roman Italic', 'TimesNewRomanPS-ItalicMT', 'Liberation Serif Italic']],
  [['Times-BoldItalic', 'TimesNewRomanPS-BoldItalicMT'], ['Times New Roman Bold Italic', 'TimesNewRomanPS-BoldItalicMT', 'Liberation Serif Bold Italic']],
  [['Helvetica', 'Arial', 'ArialMT'], ['Arial', 'ArialMT', 'Liberation Sans']],
  [['Helvetica-Bold', 'Arial-BoldMT'], ['Arial Bold', 'Arial-BoldMT', 'Liberation Sans Bold']],
  [['ArialBlack'], ['Arial Black', 'Arial-Black']],
  [['Helvetica-Oblique', 'Arial-ItalicMT'], ['Arial Italic', 'Arial-ItalicMT', 'Liberation Sans Italic']],
  [['Helvetica-BoldOblique', 'Arial-BoldItalicMT'], ['Arial Bold Italic', 'Arial-BoldItalicMT', 'Liberation Sans Bold Italic']],
  [['TrebuchetMS'], ['Trebuchet MS', 'TrebuchetMS']],
  [['Verdana'], ['Verdana']],
  [['Verdana,Italic'], ['Verdana Italic', 'Verdana-Italic']],
  [['Verdana,Bold'], ['Verdana Bold', 'Verdana-Bold']],
  [['Courier', 'CourierNew'], ['Courier New', 'CourierNewPSMT', 'Liberation Mono']],
  [['Courier-Bold', 'CourierNew,Bold'], ['Courier New Bold', 'CourierNewPS-BoldMT', 'Liberation Mono Bold']],
  [['Courier-Oblique'], ['Courier New Italic', 'CourierNewPS-ItalicMT', 'Liberation Mono Italic']],
  [['Courier-BoldOblique'], ['Courier New Bold Italic', 'CourierNewPS-BoldItalicMT', 'Liberation Mono Bold Italic']],
]) for (const name of pdfNames) faces.set(name, Object.freeze(localNames));

export function pdfLocalFontNames(baseFont) { return faces.get(baseFont); }
export function pdfSystemGlyph(text) {
  if (typeof text !== 'string' || [...text].length !== 1) return undefined;
  const point = text.codePointAt(0);
  return point >= 32 && !(point >= 0x7f && point < 0xa0 || point >= 0xd800 && point <= 0xf8ff || point >= 0xf0000) ? text : undefined;
}
