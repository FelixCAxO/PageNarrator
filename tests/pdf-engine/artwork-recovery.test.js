import { describe, expect, it, vi } from 'vitest';
import { openPdfDocument } from '../../src/pdf/browser-pdf.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { renderPdfDisplayList } from '../../src/pdf/canvas-renderer.js';
import { options, show, simplePdf } from './fixtures.js';
import { tilingPdf } from './tiling-pattern-fixture.js';

const font = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
const shaded = (content, shading = '<< /ShadingType 7 >>') => simplePdf(content, {
  page: '/Resources << /Font << /F1 5 0 R >> /Shading << /Sh0 6 0 R >> >>', extra: [shading],
});
async function withPage(data, run, settings = {}) {
  const document = await openPdfDocument(data, { ...options, ...settings });
  try { await run(await document.getPage(1)); } finally { document.destroy(); }
}

describe('bounded PDF artwork recovery', () => {
  it('preserves text before and after unsupported shading, with one explicit warning', async () => {
    await withPage(shaded(show('Before') + ' /Sh0 sh /Sh0 sh ' + show('After')), async page => {
      const first = await page.getTextContent(), second = await page.getTextContent();
      expect(first.items.map(item => item.str)).toEqual(['Before', 'After']);
      expect(first.artworkWarnings).toEqual([{ kind: 'shading', code: 'pdf_unsupported', message: 'PDF shading type 7 is not implemented yet.' }]);
      expect(second.artworkWarnings).toBe(first.artworkWarnings);
      expect((await page.inspect()).artworkWarnings).toEqual(first.artworkWarnings);
      page.cleanup(); expect((await page.getTextContent()).items.map(item => item.str)).toEqual(['Before', 'After']);
    });
  });
  it.each([{ tilingType: 2 }, { cellContent: 'BT /F1 12 Tf (Decoration) Tj ET' }])('omits unsupported pattern artwork without substituting a stale solid colour: %j', async settings => {
    const core = await createPdfDocumentCore(tilingPdf({ kind: 'solid', ...settings, pageResources: '/Font << /F1 8 0 R >>', extra: [font],
      pageContent: '/Pattern cs /P scn 0 0 20 20 re B 0 g ' + show('Readable text') }), { ...options, recoverUnsupportedArtwork: true });
    try {
      const payload = await core.pagePayload(1), paint = payload.commands.find(command => command.op === 'paint');
      expect(paint.skipFill).toBe(true); expect(paint.skipStroke).toBeUndefined(); expect(paint.fillPattern).toBeUndefined();
      expect(payload.items.map(item => item.str)).toEqual(['Readable text']); expect(payload.inspection.artworkWarnings).toHaveLength(1);
    } finally { core.destroy(); }
  });
  it('keeps strict inspection available and never pretends a page without readable text recovered', async () => {
    await withPage(shaded(show('Text') + ' /Sh0 sh'), page => expect(page.getTextContent()).rejects.toMatchObject({ code: 'pdf_unsupported' }), { recoverUnsupportedArtwork: false });
    await withPage(shaded('/Sh0 sh'), page => expect(page.getTextContent()).rejects.toMatchObject({ code: 'pdf_unsupported' }));
  });
  it('keeps clipping and the supported stroke when an unsupported pattern fill is omitted', async () => {
    const context = { canvas: { width: 20, height: 20 } };
    for (const name of ['save', 'restore', 'setTransform', 'transform', 'beginPath', 'rect', 'fill', 'stroke', 'clip']) context[name] = vi.fn();
    await renderPdfDisplayList({ fonts: [], commands: [{ op: 'path', kind: 're', args: [0, 0, 10, 10] },
      { op: 'paint', kind: 'B', skipFill: true, clip: 'nonzero' }] },
    { canvasContext: context, viewport: { transform: [1, 0, 0, 1, 0, 0] }, background: false }).promise;
    expect(context.fill).not.toHaveBeenCalled(); expect(context.stroke).toHaveBeenCalledOnce(); expect(context.clip).toHaveBeenCalledWith('nonzero');
  });
  it('preserves corrupt, missing-object, unknown-font and cancellation errors', async () => {
    for (const [data, code] of [
      [shaded(show('Text') + ' /Sh0 sh', '<< /ShadingType 2 /Coords [0] >>'), 'pdf_corrupt'],
      [shaded(show('Text') + ' /Sh0 sh', '999 0 R'), 'pdf_unsupported'],
      [simplePdf(show('Text'), { font: '/Type /Font /Subtype /MMType1 /BaseFont /Unknown' }), 'pdf_unsupported'],
    ]) await withPage(data, page => expect(page.getTextContent()).rejects.toMatchObject({ code }));
    const controller = new AbortController(); controller.abort();
    await expect(openPdfDocument(shaded(show('Text') + ' /Sh0 sh'), { ...options, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
