// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original RFC4013/3454 preparation and Unicode3.2 NFKC; no platform-version drift.
import data from '../../vendor/pdf-unicode/saslprep.json' with { type: 'json' };
import { PdfEngineError } from './native-reader.js';

const MAX_INPUT_UNITS = 65536, MAX_OUTPUT_SCALARS = 262144;
const prohibitedTables = ['C.1.2', 'C.2.1', 'C.2.2', 'C.3', 'C.4', 'C.5', 'C.6', 'C.7', 'C.8', 'C.9'];
const combiningClass = code => data.combiningClass[code] || 0;
export function pdfStringprepContains(table, code) {
  const ranges = data.tables[table]; if (!ranges) throw new PdfEngineError('Unknown PDF password preparation table.', 'pdf_corrupt');
  let first = 0, last = ranges.length;
  while (first < last) { const middle = (first + last) >>> 1, [start, end] = ranges[middle]; if (code < start) last = middle; else if (code > end) first = middle + 1; else return true; }
  return false;
}
function checkInput(value) {
  if (typeof value !== 'string') throw new PdfEngineError('PDF Unicode password must be a string.', 'pdf_corrupt');
  if (value.length > MAX_INPUT_UNITS) throw new PdfEngineError('PDF Unicode password preparation exceeds its input limit.', 'pdf_limit');
}
function scalarString(codes) {
  const chunks = []; for (let at = 0; at < codes.length; at += 1024) chunks.push(String.fromCodePoint(...codes.slice(at, at + 1024))); return chunks.join('');
}
function composite(first, second) {
  // Unicode Hangul syllables are algorithmic, not entries in UnicodeData.
  if (first >= 0x1100 && first < 0x1113 && second >= 0x1161 && second < 0x1176) return 0xac00 + ((first - 0x1100) * 21 + second - 0x1161) * 28;
  if (first >= 0xac00 && first < 0xd7a4 && (first - 0xac00) % 28 === 0 && second > 0x11a7 && second < 0x11c3) return first + second - 0x11a7;
  return data.composition[`${first},${second}`];
}
export function normalizePdfUnicode32(value) {
  checkInput(value); const decomposed = [];
  function append(code, depth = 0) {
    if (depth > 32 || decomposed.length >= MAX_OUTPUT_SCALARS) throw new PdfEngineError('PDF Unicode password normalization exceeds its work limit.', 'pdf_limit');
    if (code >= 0xac00 && code < 0xd7a4) {
      const syllable = code - 0xac00;
      append(0x1100 + Math.floor(syllable / 588), depth + 1); append(0x1161 + Math.floor(syllable % 588 / 28), depth + 1);
      if (syllable % 28) append(0x11a7 + syllable % 28, depth + 1);
    } else if (data.decomposition[code]) for (const child of data.decomposition[code]) append(child, depth + 1);
    else decomposed.push(code);
  }
  for (const character of value) append(character.codePointAt(0));
  // Stable sort each run of nonstarters; avoids quadratic insertion on hostile input.
  for (let first = 0; first < decomposed.length;) {
    const start = first + (combiningClass(decomposed[first]) === 0 ? 1 : 0); let end = start;
    while (end < decomposed.length && combiningClass(decomposed[end]) !== 0) end++;
    const ordered = decomposed.slice(start, end).sort((a, b) => combiningClass(a) - combiningClass(b));
    for (let i = 0; i < ordered.length; i++) decomposed[start + i] = ordered[i]; first = end;
  }
  const result = []; let starterAt = -1, previousClass = 0;
  for (const code of decomposed) {
    const ccc = combiningClass(code), combined = starterAt >= 0 && (previousClass === 0 || previousClass < ccc) ? composite(result[starterAt], code) : undefined;
    if (combined !== undefined) result[starterAt] = combined;
    else { if (ccc === 0) starterAt = result.length; result.push(code); previousClass = ccc; }
  }
  return scalarString(result);
}
function invalidPassword() { const error = new PdfEngineError('This PDF password is invalid under Unicode SASLprep.', 'pdf_password'); error.name = 'PasswordException'; throw error; }
export function preparePdfPassword(value) {
  checkInput(value); const mapped = [];
  for (const character of value) {
    const code = character.codePointAt(0);
    if (!pdfStringprepContains('B.1', code)) mapped.push(pdfStringprepContains('C.1.2', code) ? 0x20 : code);
  }
  const prepared = normalizePdfUnicode32(scalarString(mapped)), codes = [...prepared].map(character => character.codePointAt(0));
  for (const code of codes) if (pdfStringprepContains('A.1', code) || prohibitedTables.some(table => pdfStringprepContains(table, code))) invalidPassword();
  if (codes.some(code => pdfStringprepContains('D.1', code)) && (codes.some(code => pdfStringprepContains('D.2', code))
    || !pdfStringprepContains('D.1', codes[0]) || !pdfStringprepContains('D.1', codes.at(-1)))) invalidPassword();
  return prepared;
}
