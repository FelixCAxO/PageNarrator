// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';

const names = {
  'LiberationSans-Regular.ttf': 'Helvetica', 'LiberationSans-Bold.ttf': 'Helvetica-Bold',
  'LiberationSans-Italic.ttf': 'Helvetica-Oblique', 'LiberationSans-BoldItalic.ttf': 'Helvetica-BoldOblique',
};

// The four retained AFMs are data. Only their bounded glyph-name/WX records
// supply advances; outline programs and kerning are not evaluated here.
export function parseStandard14Widths(bytes, expectedName) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 131072) throw new PdfEngineError('Standard font metric byte limit exceeded.', 'pdf_limit');
  for (const byte of bytes) if (byte > 127) throw new PdfEngineError('Standard font metrics must be ASCII.', 'pdf_corrupt');
  const lines = new TextDecoder().decode(bytes).split(/\r?\n/);
  if (lines.length > 8192 || lines.some(line => line.length > 1024)) throw new PdfEngineError('Standard font metric line limit exceeded.', 'pdf_limit');
  const records = lines.map(line => line.trim()).filter(Boolean);
  const start = records.findIndex(line => line.startsWith('StartCharMetrics '));
  const headers = records.slice(0, start).filter(line => line.startsWith('FontName '));
  if (records[0] !== 'StartFontMetrics 4.1' || records.at(-1) !== 'EndFontMetrics' || start < 1
    || headers.length !== 1 || headers[0] !== `FontName ${expectedName}`
    || records.filter(line => line.startsWith('StartCharMetrics ')).length !== 1) throw new PdfEngineError('Invalid standard font metric header.', 'pdf_corrupt');
  const countText = records[start].slice('StartCharMetrics '.length), count = Number(countText);
  if (!/^\d+$/.test(countText) || !Number.isInteger(count) || count < 1 || count > 512) throw new PdfEngineError('Standard font metric glyph limit exceeded.', 'pdf_limit');
  if (records[start + count + 1] !== 'EndCharMetrics') throw new PdfEngineError('Unterminated standard font metrics.', 'pdf_corrupt');
  const widths = new Map();
  for (let i = start + 1; i <= start + count; i++) {
    const fields = records[i].split(';').map(field => field.trim()).filter(Boolean);
    const nameFields = fields.filter(field => field.startsWith('N ')), widthFields = fields.filter(field => field.startsWith('WX '));
    const name = nameFields[0]?.slice(2), value = widthFields[0]?.slice(3), width = Number(value);
    if (nameFields.length !== 1 || widthFields.length !== 1 || !/^[A-Za-z0-9_.]{1,64}$/.test(name ?? '')
      || !/^\d+(?:\.\d+)?$/.test(value ?? '') || !Number.isFinite(width) || width < 0 || width > 10000 || widths.has(name)) throw new PdfEngineError('Invalid standard font metric glyph.', 'pdf_corrupt');
    widths.set(name, width);
  }
  return widths;
}

export async function loadStandard14Widths(fallbackAsset, loadAsset) {
  const name = Object.hasOwn(names, fallbackAsset) ? names[fallbackAsset] : null;
  return name ? parseStandard14Widths(await loadAsset(`standard14_metrics/${name}.afm`), name) : null;
}
