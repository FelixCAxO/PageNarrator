import { expect, it } from 'vitest';
import * as reference from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { readTrueTypeMetrics } from '../../src/pdf/font-metrics.js';
import { privateGlyphCode } from '../../src/pdf/font-container.js';
import { simplePdf, stream, loadAsset, options } from './fixtures.js';

function subsetCmap(font) {
  const bytes = font.slice(), metrics = readTrueTypeMetrics(font), view = new DataView(bytes.buffer), gid = metrics.glyphId(65);
  for (let i = 0; i < view.getUint16(4); i++) {
    const row = 12 + i * 16; if (String.fromCharCode(...bytes.subarray(row, row + 4)) !== 'cmap') continue;
    const at = view.getUint32(row + 8); view.setUint32(row + 12, 100); bytes.fill(0, at, at + 100); view.setUint16(at + 2, 2);
    for (let n = 0; n < 2; n++) {
      const record = at + 4 + n * 8, sub = at + 20 + n * 40;
      view.setUint16(record, n ? 3 : 0); view.setUint16(record + 2, n ? 1 : 3); view.setUint32(record + 4, sub - at);
      view.setUint16(sub, 4); view.setUint16(sub + 2, 40); view.setUint16(sub + 6, 6); view.setUint16(sub + 8, 4); view.setUint16(sub + 10, 1); view.setUint16(sub + 12, 2);
      [65, 66, 65535].forEach((code, j) => { view.setUint16(sub + 14 + j * 2, code); view.setUint16(sub + 22 + j * 2, code); });
      view.setInt16(sub + 28, gid - 65); view.setInt16(sub + 30, metrics.glyphCount + 5 - 66); view.setInt16(sub + 32, 1);
    }
  }
  return { bytes, gid, glyphCount: metrics.glyphCount };
}
function embedded(font, text, unicode = '', outline = true) {
  return simplePdf(`BT /F1 12 Tf ${outline ? '1 Tr' : ''} (${text}) Tj ET`, {
    font: `/Type /Font /Subtype /TrueType /BaseFont /OriginalSubset /Encoding /WinAnsiEncoding /FirstChar 65 /Widths [400 500] /FontDescriptor 6 0 R ${unicode ? '/ToUnicode 8 0 R' : ''}`,
    extra: ['<< /Type /FontDescriptor /Flags 32 /FontFile2 7 0 R >>', stream(font), stream(unicode)],
  });
}
async function payload(data) { const core = await createPdfDocumentCore(data, options); try { return await core.pagePayload(1); } finally { core.destroy(); } }

it('rebuilds named-encoding subset cmaps from retained GIDs without unused out-of-range entries', async () => {
  const subset = subsetCmap(await loadAsset('standard_fonts/LiberationSans-Regular.ttf')), original = subset.bytes.slice();
  expect(readTrueTypeMetrics(subset.bytes).glyphId(66)).toBe(subset.glyphCount + 5);
  const data = embedded(subset.bytes, 'A'), actual = await payload(data), converted = readTrueTypeMetrics(actual.fonts[0].bytes);
  expect(subset.bytes).toEqual(original); expect(converted.glyphId(65)).toBe(subset.gid); expect(converted.glyphId(66)).toBe(0);
  expect(converted.glyphId(privateGlyphCode(subset.gid))).toBe(subset.gid);
  expect(actual.commands.find(command => command.op === 'text').glyphs[0].renderText).toBe(String.fromCodePoint(privateGlyphCode(subset.gid)));
  const task = reference.getDocument({ data: data.slice(), disableFontFace: true, fontExtraProperties: true, verbosity: 0 });
  try {
    const page = await (await task.promise).getPage(1), operators = await page.getOperatorList(); let font;
    for (let i = 0; i < operators.fnArray.length; i++) {
      if (operators.fnArray[i] === reference.OPS.setFont) font = page.commonObjs.get(operators.argsArray[i][0]);
      if (operators.fnArray[i] === reference.OPS.showText) {
        const glyph = operators.argsArray[i][0].find(value => value && typeof value === 'object');
        expect(readTrueTypeMetrics(font.data).glyphId(glyph.fontChar.codePointAt(0))).toBe(subset.gid);
      }
    }
  } finally { await task.destroy(); }
});

it('rejects a used absent cmap glyph even when PDF widths avoid native metric lookup', async () => {
  const { bytes } = subsetCmap(await loadAsset('standard_fonts/LiberationSans-Regular.ttf'));
  await expect(payload(embedded(bytes, 'B', '', false))).rejects.toMatchObject({ code: 'pdf_corrupt', message: 'Simple font cmap references an absent glyph.' });
});

it('paints the selected encoded GID and preserves its outline when ToUnicode names another character', async () => {
  const font = await loadAsset('standard_fonts/LiberationSans-Regular.ttf'), subset = subsetCmap(font);
  const actual = await payload(embedded(subset.bytes, 'A', 'begincmap 1 beginbfchar <41> <0058> endbfchar endcmap'));
  const plain = await payload(embedded(font, 'A')), glyph = actual.commands.find(command => command.op === 'text').glyphs[0];
  expect(actual.items[0].str).toBe('X'); expect(actual.items[0].width).toBeCloseTo(4.8);
  expect(glyph.renderText).toBe(String.fromCodePoint(privateGlyphCode(subset.gid)));
  expect(glyph.outline).toEqual(plain.commands.find(command => command.op === 'text').glyphs[0].outline);
});
