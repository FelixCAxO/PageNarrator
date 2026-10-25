import { describe, expect, it } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { options, simplePdf } from './fixtures.js';

function previewPdf(settings, colors) {
  return simplePdf(`/G gs ${colors} 10 10 50 50 re f 0 0 1 rg 30 30 50 50 re f BT /F1 12 Tf 1 0 0 1 54 700 Tm (Composite preview) Tj ET`, {
    page: '/Resources << /Font << /F1 5 0 R >> /ExtGState << /G 6 0 R >> >>', extra: [`<< ${settings} >>`],
  });
}

async function payload(settings, colors = '1 0 0 rg') {
  const core = await createPdfDocumentCore(previewPdf(settings, colors), options);
  try { return await core.pagePayload(1); } finally { core.destroy(); }
}

describe('PDF overprint controls in composite screen preview', () => {
  it.each(['/OP true', '/op true', '/OP true /op false /OPM 1', '/OP false /op true /OPM 0'])('retains complete text and painting commands for %s', async settings => {
    const baseline = await payload(''), actual = await payload(settings);
    expect(actual.items.map(({ fontName, ...item }) => item)).toEqual(baseline.items.map(({ fontName, ...item }) => item));
    expect(actual.commands.map(({ font, ...command }) => command)).toEqual(baseline.commands.map(({ font, ...command }) => command));
    expect(actual.fonts.map(font => font.bytes)).toEqual(baseline.fonts.map(font => font.bytes));
    expect(actual.items.map(item => item.str).join('')).toBe('Composite preview');
  });

  it('uses the same composite conversion for CMYK colors in either valid overprint mode', async () => {
    const baseline = await payload('', '0 1 1 0 k');
    for (const mode of [0, 1]) expect((await payload(`/OP true /op true /OPM ${mode}`, '0 1 1 0 k')).commands.map(({ font, ...command }) => command)).toEqual(baseline.commands.map(({ font, ...command }) => command));
  });

  it.each(['/OP 1', '/op /True', '/OPM 2', '/OPM -.5', '/OPM true'])('rejects invalid overprint parameter %s', async settings => {
    await expect(payload(settings)).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });
});
