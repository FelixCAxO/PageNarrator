import { describe, expect, it } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { renderPdfDisplayList } from '../../src/pdf/canvas-renderer.js';
import { createPdfViewport } from '../../src/pdf/viewport.js';
import { options, simplePdf, stream } from './fixtures.js';
import cases from './type3-d1-color-cases.json';

const rgb = '/ColorSpace << /Rgb /DeviceRGB >>';
const shading = '/Shading << /Shade << /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 100 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [0 0 0] /C1 [1 0 0] /N 1 >> >> >>';
function input(row) {
  const graphics = `/ExtGState << /ColorFx << ${row.gstate} >> >>`;
  if (row.kind === 'ordinary') return simplePdf(`.2 .4 .8 rg 0 .5 0 RG ${row.operator} 0 0 2 2 re B`, { page: `/Resources << ${rgb} ${graphics} >>` });
  const resources = `<< ${rgb} ${shading} ${graphics} /XObject << /Form 7 0 R >> >>`;
  const metrics = row.kind === 'd0' ? '600 0 d0' : '600 0 0 0 600 700 d1';
  return simplePdf(`.2 .4 .8 rg 0 .5 0 RG BT /F1 12 Tf ${row.mode} Tr 1 0 0 1 54 700 Tm (A) Tj ET 0 0 2 2 re B`, {
    font: `/Type /Font /Subtype /Type3 /FontMatrix [.001 0 0 .001 0 0] /FontBBox [0 0 600 700] /Encoding << /Differences [65 /A] >> /FirstChar 65 /LastChar 65 /Widths [600] /CharProcs << /A 6 0 R >> /Resources ${resources}`,
    extra: [stream(`${metrics} q ${row.operator} 10 10 100 100 re B Q 210 10 100 100 re B`), stream('q /Rgb cs 1 0 0 sc /Rgb CS 1 0 0 SC 10 210 100 100 re B Q', '/Type /XObject /Subtype /Form /BBox [0 0 600 700]')],
  });
}
function recordingCanvas() {
  const fills = [], strokes = [], stack = []; let path = [], clips = 0;
  const ctx = { canvas: { width: 612, height: 792 }, fillStyle: 'initial', strokeStyle: 'initial', lineWidth: 1, globalAlpha: 1, globalCompositeOperation: 'source-over', dash: [],
    save() { stack.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, globalAlpha: this.globalAlpha, globalCompositeOperation: this.globalCompositeOperation, dash: [...this.dash] }); },
    restore() { expect(stack.length).toBeGreaterThan(0); Object.assign(this, stack.pop()); },
    setTransform() {}, transform() {}, beginPath() { path = []; }, rect(...args) { path.push(args); },
    setLineDash(dash) { this.dash = [...dash]; }, getLineDash() { return [...this.dash]; },
    clip() { clips++; },
    fill() { fills.push({ color: this.fillStyle, alpha: this.globalAlpha, path: path.map(p => [...p]) }); },
    stroke() { strokes.push({ color: this.strokeStyle, alpha: this.globalAlpha, width: this.lineWidth, dash: [...this.dash], path: path.map(p => [...p]) }); },
    fillText() { throw new Error('Authored Type3 color fixtures use only their CharProc paths.'); },
  };
  return { ctx, fills, strokes, stack, clips: () => clips };
}

describe('uncolored d1 CharProcs retain the inherited color', () => {
  it.each(cases)('$id follows its color policy while preserving other graphics state', async row => {
    const core = await createPdfDocumentCore(input(row), options);
    try {
      if (row.expectedError) { await expect(core.pagePayload(1)).rejects.toMatchObject({ code: row.expectedError }); return; }
      const payload = await core.pagePayload(1);
      if (row.expectedItem) {
        expect(payload.items.map(item => item.str)).toEqual([row.expectedItem.text]);
        expect(payload.items[0].width).toBeCloseTo(row.expectedItem.width, 9); expect(payload.items[0].height).toBe(row.expectedItem.height);
      } else expect(payload.items).toEqual([]);
      const transforms = payload.commands.filter(command => command.op === 'setPdfTransform').map(command => command.args);
      expect(transforms).toHaveLength(row.expectedGlyphTransforms);
      if (transforms.length) transforms[0].forEach((n, i) => expect(n).toBeCloseTo([.012, 0, 0, .012, 54, 700][i], 9));
      expect(payload.commands.filter(command => command.op === 'shading' || command.op === 'textClip')).toEqual([]);
      const recording = recordingCanvas();
      await renderPdfDisplayList(payload, { canvasContext: recording.ctx, viewport: createPdfViewport([0, 0, 612, 792]), background: false }).promise;
      expect(recording.fills).toHaveLength(row.expectedPaints.length); expect(recording.strokes).toHaveLength(row.expectedPaints.length);
      row.expectedPaints.forEach((paint, i) => {
        expect(recording.fills[i]).toMatchObject({ color: paint.fill });
        expect(recording.strokes[i]).toMatchObject({ color: paint.stroke, width: paint.lineWidth, dash: paint.dash });
        expect(recording.fills[i].alpha).toBeCloseTo(paint.fillAlpha, 12);
        expect(recording.strokes[i].alpha).toBeCloseTo(paint.strokeAlpha, 12);
        expect(recording.fills[i].path).toHaveLength(1); expect(recording.strokes[i].path).toEqual(recording.fills[i].path);
      });
      expect(recording.clips()).toBe(row.expectedClipCount); expect(recording.stack).toHaveLength(0);
      expect(recording.ctx.fillStyle).toBe('initial'); expect(recording.ctx.strokeStyle).toBe('initial');
    } finally { core.destroy(); }
  });
});
