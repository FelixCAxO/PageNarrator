import { describe, expect, it } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { options, simplePdf, stream } from './fixtures.js';
import cases from './type3-font-matrix-cases.json';

function authoredType3(row) {
  const widths = Array.from({ length: 34 }, (_, i) => i === 0 ? 250 : i === 33 ? 600 : 0);
  const source = row.tj ? '[(A) 100 (A)] TJ' : `(${row.text}) Tj`;
  const data = simplePdf(`q ${row.ctm.join(' ')} cm BT /F1 ${row.fontSize} Tf ${row.charSpacing} Tc ${row.wordSpacing} Tw ${row.hScale * 100} Tz ${row.mode} Tr ${row.textMatrix.join(' ')} Tm ${source} ET Q`, {
    font: `/Type /Font /Subtype /Type3 /FontMatrix [${row.matrix.join(' ')}] /FontBBox [${row.bbox.join(' ')}] /Encoding << /Differences [32 /space 65 /A] >> /FirstChar 32 /LastChar 65 /Widths [${widths.join(' ')}] /CharProcs << /space 6 0 R /A 7 0 R >>`,
    extra: [stream('250 0 d0'), stream('600 0 0 0 600 700 d1 0 0 600 700 re f')],
  });
  return data;
}
const closeMatrix = (actual, expected) => { expect(actual).toHaveLength(expected.length); actual.forEach((n, i) => expect(n).toBeCloseTo(expected[i], 9)); };

describe('Type3 FontMatrix horizontal displacement', () => {
  it.each(cases)('$id preserves source geometry, spacing and the raw glyph matrix', async row => {
    const core = await createPdfDocumentCore(authoredType3(row), options);
    try {
      const payload = await core.pagePayload(1);
      expect(payload.items).toHaveLength(1); expect(payload.items[0].str).toBe(row.text);
      expect(payload.items[0].width).toBeCloseTo(row.expected.itemWidth, 9);
      expect(payload.items[0].height).toBeCloseTo(row.expected.itemHeight, 9);
      closeMatrix(payload.items[0].transform, row.expected.itemTransform);
      const matrices = payload.commands.filter(command => command.op === 'setPdfTransform').map(command => command.args);
      expect(matrices).toHaveLength(row.expected.glyphMatrices.length);
      matrices.forEach((matrix, i) => closeMatrix(matrix, row.expected.glyphMatrices[i]));
      expect(payload.fonts).toHaveLength(1);
      expect(payload.fonts[0].ascent).toBeCloseTo(row.expected.fontAscent, 9); expect(payload.fonts[0].descent).toBeCloseTo(row.expected.fontDescent, 9);
      expect(payload.commands.filter(command => command.op === 'textClip')).toEqual([]);
      expect(payload.commands.filter(command => command.op === 'save')).toHaveLength(payload.commands.filter(command => command.op === 'restore').length);
    } finally { core.destroy(); }
  });

  it.each([['Type1', 'Helvetica'], ['TrueType', 'ArialMT']])('leaves ordinary %s widths in thousandths of text space', async (subtype, base) => {
    const core = await createPdfDocumentCore(simplePdf('BT /F1 12 Tf 3 Tr (AA) Tj ET', { font: `/Type /Font /Subtype /${subtype} /BaseFont /${base} /Encoding /WinAnsiEncoding` }), options);
    try {
      const payload = await core.pagePayload(1);
      expect(payload.items.map(item => item.str)).toEqual(['AA']); expect(payload.items[0].width).toBeCloseTo(16.008, 9);
      expect(payload.commands.filter(command => command.op === 'text' || command.op === 'setPdfTransform')).toEqual([]);
    } finally { core.destroy(); }
  });
});
