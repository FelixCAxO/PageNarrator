import { describe, expect, it } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { options, simplePdf } from './fixtures.js';

async function payload(fields = '/BS << /S /U /W 1 >>', rect = '[20 30 100 60]', color = '[.75 .66666 1]') {
  const core = await createPdfDocumentCore(simplePdf('', { page: '/Annots [6 0 R]',
    extra: [`<< /Type /Annot /Subtype /Link /Rect ${rect} /C ${color} ${fields} >>`] }), options);
  try { return await core.pagePayload(1); } finally { core.destroy(); }
}
const paths = result => result.commands.filter(c => c.op === 'path');

describe('link annotation border geometry', () => {
  it.each(['[20 30 100 60]', '[100 60 20 30]'])('draws only the bottom edge of an underline border: %s', async rect => {
    const result = await payload(undefined, rect);
    expect(paths(result)).toEqual([{ op: 'path', kind: 'm', args: [20, 30] }, { op: 'path', kind: 'l', args: [100, 30] }]);
    const border = result.commands.find(c => c.op === 'color');
    expect(border).toMatchObject({ op: 'color', fill: false, value: 'rgb(191,170,255)' });
    [.75, .66666, 1].forEach((n, i) => expect(border.nativeColor[i]).toBeCloseTo(n, 14));
    expect(result.commands).toContainEqual({ op: 'lineStyle', name: 'w', value: 1 });
    expect(result.commands.filter(c => c.op === 'paint')).toEqual([{ op: 'paint', kind: 'S', clip: null }]);
    expect(result.items).toEqual([]);
  });

  it('uses BS instead of the superseded legacy border and ignores dash data for an underline', async () => {
    const result = await payload('/Border [20 30 0 [8 9]] /BS << /S /U /W 2 /D [-1] >>');
    expect(paths(result)).toHaveLength(2); expect(result.commands.filter(c => c.op === 'dash')).toEqual([]);
    expect(result.commands).toContainEqual({ op: 'lineStyle', name: 'w', value: 2 });
  });

  it.each(['/BS << /S /S /D [-1] >>', '/BS << /S /UnknownProducerStyle >>', '/BS << /S null /W null >>', '/BS null /Border null'])('retains a solid default rectangle for %s', async fields => {
    const result = await payload(fields);
    expect(paths(result)).toEqual([{ op: 'path', kind: 're', args: [20, 30, 80, 30] }]);
    expect(result.commands.filter(c => c.op === 'dash')).toEqual([]);
  });

  it.each([['/BS << /S /D >>', [3]], ['/BS << /S /D /D [2 1] >>', [2, 1]], ['/BS << /S /D /D null >>', [3]], ['/Border [0 0 2 [4 5]]', [4, 5]]])('keeps declared dashed borders for %s', async (fields, expected) => {
    const result = await payload(fields);
    expect(result.commands).toContainEqual({ op: 'dash', dash: expected, phase: 0 });
    expect(paths(result)).toEqual([{ op: 'path', kind: 're', args: [20, 30, 80, 30] }]);
  });

  it.each([['/BS << /S /U /W 0 >>', '[.75 .66666 1]'], ['/BS << /S /U >>', '[]'], ['/BS << /S /U >> /F 2', '[.75 .66666 1]']])('does not paint a suppressed annotation: %s', async (fields, color) => {
    expect(paths(await payload(fields, undefined, color))).toEqual([]);
  });

  it.each(['/BS << /W -1 >>', '/BS << /W /Invalid >>', '/BS << /S 7 >>', '/BS << /S /D /D [-1] >>', '/BS << /S /D /D [0 0] >>'])('rejects malformed active border data: %s', async fields => {
    await expect(payload(fields)).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });

  it.each(['/BS << /S /B >>', '/BS << /S /I >>', '/Border [1 1 1]'])('retains explicit unsupported border geometry: %s', async fields => {
    await expect(payload(fields)).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });
});
