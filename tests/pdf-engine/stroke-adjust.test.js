import { afterEach, describe, expect, it, vi } from 'vitest';
import { PdfStrokePath } from '../../src/pdf/stroke-adjust.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { options, simplePdf } from './fixtures.js';

afterEach(() => vi.unstubAllGlobals());
const matrix = (a = 1, d = a, e = 0, f = 0) => ({ a, b: 0, c: 0, d, e, f });
function context(transform = matrix(), dash = []) {
  const strokes = [], stack = [];
  const ctx = { transform, dash, lineWidth: 7, lineDashOffset: .25,
    getTransform() { return this.transform; }, getLineDash() { return this.dash; }, setLineDash(value) { this.dash = value; },
    setTransform(a, b, c, d, e, f) { this.transform = { a, b, c, d, e, f }; },
    save() { stack.push({ transform: this.transform, dash: this.dash, lineWidth: this.lineWidth, lineDashOffset: this.lineDashOffset }); },
    restore() { Object.assign(this, stack.pop()); },
    stroke(path) { strokes.push({ segments: path.segments, transform: this.transform, width: this.lineWidth, dash: this.dash, phase: this.lineDashOffset }); },
  };
  vi.stubGlobal('Path2D', class {
    constructor() { this.segments = []; }
    moveTo(...args) { this.segments.push(['m', ...args]); } lineTo(...args) { this.segments.push(['l', ...args]); }
    bezierCurveTo(...args) { this.segments.push(['c', ...args]); } closePath() { this.segments.push(['h']); }
  });
  return { ctx, strokes, stack };
}

describe('original device-space PDF stroke adjustment', () => {
  it.each([[.1, 1, .5], [.49, 1, .5], [.51, 1, .5], [1.49, 1, .5], [1.5, 2, 0], [2.6, 3, .5]])('quantizes requested %s pixel width to %s with edge-aligned centers', (width, result, phase) => {
    const { ctx, strokes, stack } = context(), path = new PdfStrokePath();
    path.add('m', [10.2, 20.2], matrix()); path.add('l', [30.2, 20.2], matrix()); path.stroke(ctx, { width, adjust: true });
    expect(strokes[0]).toMatchObject({ width: result, transform: matrix(), segments: [['m', 10 + phase, 20 + phase], ['l', 30 + phase, 20 + phase]] });
    expect(stack).toHaveLength(0); expect(ctx.lineWidth).toBe(7); expect(ctx.lineDashOffset).toBe(.25);
  });
  it('captures path coordinates at construction and scales dash lengths at stroke time', () => {
    const { ctx, strokes } = context(matrix(3), [2, 4]), path = new PdfStrokePath();
    path.add('m', [2, 3], matrix(2, 2, 10, 20)); path.add('l', [5, 7], matrix(2, 2, 10, 20)); path.stroke(ctx, { width: .8, adjust: true });
    expect(strokes[0]).toMatchObject({ width: 2, dash: [6, 12], phase: .75, segments: [['m', 14, 26], ['l', 20, 34]] });
  });
  it('moves cubic controls with their endpoints and resolves v/y using the real current device point', () => {
    const { ctx, strokes } = context(), path = new PdfStrokePath();
    path.add('m', [1.2, 2.2], matrix()); path.add('v', [3.2, 4.2, 5.2, 6.2], matrix(2)); path.add('y', [12.2, 14.2, 16.2, 18.2], matrix());
    path.stroke(ctx, { width: 1, adjust: true });
    const expected = [['m', 1.5, 2.5], ['c', 1.5, 2.5, 6.5, 8.5, 10.5, 12.5], ['c', 12.3, 14.3, 16.5, 18.5, 16.5, 18.5]];
    strokes[0].segments.forEach((segment, i) => { expect(segment[0]).toBe(expected[i][0]); segment.slice(1).forEach((value, j) => expect(value).toBeCloseTo(expected[i][j + 1], 12)); });
  });
  it('executes solid zero-width hairlines in device space under nonuniform transforms', () => {
    const { ctx, strokes } = context(matrix(2, 3)), path = new PdfStrokePath();
    path.add('re', [1, 2, 3, 4], matrix(2, 3)); path.stroke(ctx, { width: 0 });
    expect(strokes[0]).toMatchObject({ width: 1, transform: matrix(), segments: [['m', 2, 6], ['l', 8, 6], ['l', 8, 18], ['l', 2, 18], ['h']] });
    expect(() => path.stroke(ctx, { width: .2, adjust: true })).toThrow(/nonuniform transform/);
    ctx.dash = [1, 2]; expect(() => path.stroke(ctx, { width: 0 })).toThrow(/nonuniform transform/);
  });
  it('preserves stroke flags and zero widths across graphics state save/restore', async () => {
    const data = simplePdf('/G gs 0 w 0 0 m 1 1 l S q /Off gs 2 w 0 0 m 2 2 l S Q 0 0 m 3 3 l S', {
      page: '/Resources << /ExtGState << /G 6 0 R /Off 7 0 R >> >>', extra: ['<< /SA true >>', '<< /SA false >>'],
    });
    const core = await createPdfDocumentCore(data, options);
    try { expect((await core.pagePayload(1)).commands.filter(c => c.op === 'paint').map(({ lineWidth, strokeAdjustment }) => [lineWidth, strokeAdjustment])).toEqual([[0, true], [2, false], [0, true]]); }
    finally { core.destroy(); }
  });
  it.each(['-1 w', '3 J', '1.5 j', '.5 M', '/G gs'])('rejects malformed line state %s', async content => {
    const core = await createPdfDocumentCore(simplePdf(content, { page: '/Resources << /ExtGState << /G 6 0 R >> >>', extra: ['<< /SA 1 >>'] }), options);
    try { await expect(core.pagePayload(1)).rejects.toMatchObject({ code: 'pdf_corrupt' }); } finally { core.destroy(); }
  });
});
