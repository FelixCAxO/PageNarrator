// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// ISO 32000 PDFDocEncoding text strings and explicit Unicode byte-order marks.
import { PdfEngineError } from './native-reader.js';
const special = [0x2022, 0x2020, 0x2021, 0x2026, 0x2014, 0x2013, 0x0192, 0x2044, 0x2039, 0x203a, 0x2212, 0x2030, 0x201e, 0x201c, 0x201d, 0x2018, 0x2019, 0x201a, 0x2122, 0xfb01, 0xfb02, 0x0141, 0x0152, 0x0160, 0x0178, 0x017d, 0x0131, 0x0142, 0x0153, 0x0161, 0x017e];
const accents = [0x02d8, 0x02c7, 0x02c6, 0x02d9, 0x02dd, 0x02db, 0x02da, 0x02dc];
export function decodePdfString(bytes) {
  if (bytes[0] === 254 && bytes[1] === 255 || bytes[0] === 255 && bytes[1] === 254) {
    if (bytes.length % 2) throw new PdfEngineError('Odd-length Unicode PDF text string.', 'pdf_corrupt');
    const little = bytes[0] === 255; let text = ''; for (let at = 2; at < bytes.length; at += 2) text += String.fromCharCode(little ? bytes[at] + bytes[at + 1] * 256 : bytes[at] * 256 + bytes[at + 1]); return text;
  }
  if (bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(3)); } catch { throw new PdfEngineError('Invalid UTF-8 PDF text string.', 'pdf_corrupt'); } }
  return Array.from(bytes, code => String.fromCodePoint(code >= 128 && code <= 158 ? special[code - 128] : code >= 24 && code <= 31 ? accents[code - 24] : code === 160 ? 0x20ac : [127, 159, 173].includes(code) ? 0xfffd : code)).join('');
}
