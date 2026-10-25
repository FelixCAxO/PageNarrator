import { describe, expect, it } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { renderPdfDisplayList } from '../../src/pdf/canvas-renderer.js';
import { createPdfViewport } from '../../src/pdf/viewport.js';
import { options, simplePdf, stream } from './fixtures.js';

const type3 = '/Type /Font /Subtype /Type3 /FontMatrix [.001 0 0 .001 0 0] /FontBBox [0 0 600 700] /Encoding << /Differences [65 /A] >> /FirstChar 65 /LastChar 65 /Widths [600] /CharProcs << /A 6 0 R >>';
const blue = 'rgb(51,102,204)', red = 'rgb(255,0,0)';
const show = mode => `.2 .4 .8 rg BT /F1 12 Tf ${mode} Tr 1 0 0 1 54 700 Tm (AA) Tj ET 0 0 2 2 re f`;

// Records Canvas painting and graphics-state restoration, without claiming raster parity.
function recordingCanvas() {
  const fills = [], stack = [], path = [];
  const ctx = { canvas: { width: 612, height: 792 }, fillStyle: 'initial', strokeStyle: 'initial', globalAlpha: 1, globalCompositeOperation: 'source-over',
    save() { stack.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, globalAlpha: this.globalAlpha, globalCompositeOperation: this.globalCompositeOperation }); },
    restore() { expect(stack.length).toBeGreaterThan(0); Object.assign(this, stack.pop()); },
    setTransform() {}, transform() {},
    beginPath() { path.length = 0; },
    rect(...args) { path.push(args); },
    fill(rule) { fills.push({ color: this.fillStyle, rule, rectangles: path.map(args => [...args]) }); },
    fillText() { throw new Error('This fixture must paint through its Type3 CharProc or remain invisible.'); },
    clip() { throw new Error('Type3 text rendering modes must not add a text clip.'); },
  };
  return { ctx, fills, stack };
}

const modes = ['d0', 'd1'].flatMap(kind => Array.from({ length: 8 }, (_, mode) => [kind, mode]));
describe('Type3 text rendering modes follow ISO 32000-1:2008', () => {
  it.each(modes)('honors %s CharProc visibility under Tr %i with source geometry and saved state', async (kind, mode) => {
    const procedure = kind === 'd0' ? '600 0 d0 1 0 0 rg 0 0 600 700 re f' : '600 0 0 0 600 700 d1 0 0 600 700 re f';
    const core = await createPdfDocumentCore(simplePdf(show(mode), { font: type3, extra: [stream(procedure)] }), options);
    try {
      const payload = await core.pagePayload(1);
      expect(payload.items).toHaveLength(1); expect(payload.items[0].str).toBe('AA');
      expect(payload.items[0].width).toBeCloseTo(14.4, 10); expect(payload.items[0].height).toBe(12);
      const visible = mode !== 3;
      const transforms = payload.commands.filter(command => command.op === 'setPdfTransform').map(command => command.args);
      expect(transforms).toHaveLength(visible ? 2 : 0);
      const expected = [[.012, 0, 0, .012, 54, 700], [.012, 0, 0, .012, 61.2, 700]];
      transforms.forEach((matrix, i) => matrix.forEach((value, j) => expect(value).toBeCloseTo(expected[i][j], 10)));
      expect(payload.commands.filter(command => command.op === 'path' && command.kind === 're' && command.args[2] === 600)).toHaveLength(visible ? 2 : 0);
      expect(payload.commands.filter(command => command.op === 'text' || command.op === 'textClip')).toEqual([]);
      expect(payload.commands.filter(command => command.op === 'color' && command.value === red)).toHaveLength(visible && kind === 'd0' ? 2 : 0);
      const { ctx, fills, stack } = recordingCanvas();
      await renderPdfDisplayList(payload, { canvasContext: ctx, viewport: createPdfViewport([0, 0, 612, 792]), background: false }).promise;
      const color = kind === 'd0' ? red : blue;
      expect(fills).toEqual([
        ...(visible ? [
          { color, rule: 'nonzero', rectangles: [[0, 0, 600, 700]] },
          { color, rule: 'nonzero', rectangles: [[0, 0, 600, 700]] },
        ] : []),
        { color: blue, rule: 'nonzero', rectangles: [[0, 0, 2, 2]] },
      ]);
      expect(stack).toHaveLength(0); expect(ctx.fillStyle).toBe('initial');
    } finally { core.destroy(); }
  });

  it.each([['Type1', 'Helvetica'], ['TrueType', 'ArialMT']])('keeps ordinary %s Tr3 text invisible and selectable', async (subtype, base) => {
    const core = await createPdfDocumentCore(simplePdf(show(3), { font: `/Type /Font /Subtype /${subtype} /BaseFont /${base} /Encoding /WinAnsiEncoding` }), options);
    try {
      const payload = await core.pagePayload(1);
      expect(payload.items).toHaveLength(1); expect(payload.items[0].str).toBe('AA'); expect(payload.items[0].width).toBeGreaterThan(0);
      expect(payload.commands.filter(command => ['text', 'textClip', 'setPdfTransform'].includes(command.op))).toEqual([]);
      expect(payload.commands.filter(command => command.op === 'paint')).toHaveLength(1);
      const { ctx, fills, stack } = recordingCanvas();
      await renderPdfDisplayList(payload, { canvasContext: ctx, viewport: createPdfViewport([0, 0, 612, 792]), background: false }).promise;
      expect(fills).toEqual([{ color: blue, rule: 'nonzero', rectangles: [[0, 0, 2, 2]] }]);
      expect(stack).toHaveLength(0);
    } finally { core.destroy(); }
  });
});
