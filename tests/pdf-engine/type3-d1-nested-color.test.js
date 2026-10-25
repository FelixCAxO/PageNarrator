// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { renderPdfDisplayList } from '../../src/pdf/canvas-renderer.js';
import { createPdfViewport } from '../../src/pdf/viewport.js';
import { options, pdf, stream } from './fixtures.js';

// ISO32000-1:2008 9.6.5: a d1 ancestor remains shape-only while nested
// descriptions execute. Its PostScript3 cross-reference corroborates that scope.
const colors = {
  B: { fill: 'rgb(51,102,204)', stroke: 'rgb(0,128,0)' },
  O: { fill: 'rgb(0,153,51)', stroke: 'rgb(153,0,153)' },
  R: { fill: 'rgb(255,0,0)', stroke: 'rgb(255,128,0)' },
};
const parentMatrix = [.012, 0, 0, .012, 54, 700], childMatrix = [.012, 0, 0, .012, 55.2, 702.4];
const siblingMatrix = [.012, 0, 0, .012, 57.6, 702.4], pageSiblingMatrix = [.012, 0, 0, .012, 100, 700];
const cases = [
  { id: 'd0-to-d0-colored-control', outer: 'd0', inner: 'd0', variant: 'nested', paints: ['R', 'O', 'B'], matrices: [parentMatrix, childMatrix] },
  { id: 'd1-to-d0-ancestor-dominates', outer: 'd1', inner: 'd0', variant: 'nested', paints: ['B', 'B', 'B'], matrices: [parentMatrix, childMatrix] },
  { id: 'd0-to-d1-child-only-restriction', outer: 'd0', inner: 'd1', variant: 'nested', paints: ['O', 'O', 'B'], matrices: [parentMatrix, childMatrix] },
  { id: 'd1-to-d1-uncolored-control', outer: 'd1', inner: 'd1', variant: 'nested', paints: ['B', 'B', 'B'], matrices: [parentMatrix, childMatrix] },
  { id: 'd0-to-d1-to-d0-transitive-dominance', outer: 'd0', inner: 'd1', variant: 'chain', paints: ['O', 'O', 'B'], matrices: [parentMatrix, childMatrix, childMatrix] },
  { id: 'd1-to-form-to-d0-policy-crosses-form', outer: 'd1', inner: 'd0', variant: 'form', paints: ['B', 'B', 'B'], matrices: [parentMatrix, childMatrix] },
  { id: 'd0-child-d1-then-sibling-d0-no-leak', outer: 'd0', inner: 'd1', variant: 'siblings', paints: ['O', 'R', 'O', 'B'], matrices: [parentMatrix, childMatrix, siblingMatrix] },
  { id: 'top-d1-then-top-d0-no-page-leak', outer: 'd1', inner: 'd0', variant: 'page', paints: ['B', 'R', 'B'], matrices: [parentMatrix, pageSiblingMatrix] },
];
const initialColor = '.2 .4 .8 rg 0 .5 0 RG', outerColor = '0 .6 .2 rg .6 0 .6 RG', childColor = '1 0 0 rg 1 .5 0 RG';
const lineStyle = '1 w 0 J 0 j [] 0 d', ink = '10 10 80 80 re B', outerInk = '210 10 80 80 re B';
const metrics = kind => kind === 'd1' ? '600 0 0 0 600 700 d1' : '600 0 d0';
const show = (font, x, y) => `BT /${font} 1000 Tf 1 0 0 1 ${x} ${y} Tm (A) Tj ET`;
const font = (procedure, resources) => `<< /Type /Font /Subtype /Type3 /FontMatrix [.001 0 0 .001 0 0] /FontBBox [0 0 600 700] /FirstChar 65 /LastChar 65 /Widths [600] /Encoding << /Differences [65 /A] >> /CharProcs << /A ${procedure} 0 R >> /Resources ${resources} >>`;
function input(row) {
  let nested = show('Inner', 100, 200);
  if (row.variant === 'form') nested = '/Bridge Do';
  if (row.variant === 'siblings') nested += ` ${show('Next', 300, 200)}`;
  let outer = `${metrics(row.outer)} ${lineStyle} ${outerColor} q ${nested} Q ${outerInk}`;
  let inner = `${metrics(row.inner)} ${lineStyle} ${childColor} ${ink}`;
  if (row.variant === 'chain') inner = `${metrics(row.inner)} ${lineStyle} ${childColor} q ${show('Leaf', 0, 0)} Q`;
  if (row.variant === 'page') outer = `${metrics(row.outer)} ${lineStyle} ${childColor} ${ink}`;
  const second = row.variant === 'page' ? ' /F2 12 Tf 1 0 0 1 100 700 Tm (A) Tj' : '';
  const content = `${initialColor} BT /F1 12 Tf 0 Tr 1 0 0 1 54 700 Tm (A) Tj${second} ET 0 0 2 2 re B`;
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 7 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>', stream(content),
    font(6, '<< /Font << /Inner 7 0 R /Next 9 0 R >> /XObject << /Bridge 11 0 R >> >>'), stream(outer),
    font(8, '<< /Font << /Leaf 9 0 R >> >>'), stream(inner),
    font(10, '<< >>'), stream(`${metrics('d0')} ${lineStyle} ${childColor} ${ink}`),
    stream(`q ${show('Inner', 100, 200)} Q`, '/Type /XObject /Subtype /Form /BBox [0 0 600 700] /Resources << /Font << /Inner 7 0 R >> >>'),
  ]);
}
function recordingCanvas() {
  const fills = [], strokes = [], stack = []; let path = [], clips = 0;
  const ctx = { canvas: { width: 612, height: 792 }, fillStyle: 'initial', strokeStyle: 'initial', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10,
    lineDashOffset: 0, globalAlpha: 1, globalCompositeOperation: 'source-over', dash: [],
    save() { stack.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, lineCap: this.lineCap, lineJoin: this.lineJoin, miterLimit: this.miterLimit,
      lineDashOffset: this.lineDashOffset, globalAlpha: this.globalAlpha, globalCompositeOperation: this.globalCompositeOperation, dash: [...this.dash] }); },
    restore() { expect(stack.length).toBeGreaterThan(0); Object.assign(this, stack.pop()); },
    setTransform() {}, transform() {}, beginPath() { path = []; }, rect(...args) { path.push(args); },
    setLineDash(dash) { this.dash = [...dash]; }, getLineDash() { return [...this.dash]; },
    clip() { clips++; },
    fill() { fills.push({ color: this.fillStyle, alpha: this.globalAlpha, path: path.map(p => [...p]) }); },
    stroke() { strokes.push({ color: this.strokeStyle, alpha: this.globalAlpha, width: this.lineWidth, dash: [...this.dash], path: path.map(p => [...p]) }); },
    fillText() { throw new Error('Nested Type3 controls must paint their authored CharProc paths.'); },
  };
  return { ctx, fills, strokes, stack, clips: () => clips };
}

describe('d1 color restrictions across nested glyph invocations', () => {
  it.each(cases)('$id preserves the active ancestor policy without leaking it', async row => {
    const core = await createPdfDocumentCore(input(row), options);
    try {
      const payload = await core.pagePayload(1);
      expect(payload.items.map(item => item.str)).toEqual(row.variant === 'page' ? ['A', 'A'] : ['A']);
      for (const item of payload.items) { expect(item.width).toBeCloseTo(7.2, 9); expect(item.height).toBe(12); }
      const matrices = payload.commands.filter(command => command.op === 'setPdfTransform').map(command => command.args);
      expect(matrices).toHaveLength(row.matrices.length);
      matrices.forEach((matrix, i) => { expect(matrix).toHaveLength(6); matrix.forEach((n, j) => expect(n).toBeCloseTo(row.matrices[i][j], 9)); });
      expect(payload.commands.filter(command => ['text', 'textClip', 'shading'].includes(command.op))).toEqual([]);
      expect(payload.commands.filter(command => command.op === 'save')).toHaveLength(payload.commands.filter(command => command.op === 'restore').length);
      const recording = recordingCanvas();
      await renderPdfDisplayList(payload, { canvasContext: recording.ctx, viewport: createPdfViewport([0, 0, 612, 792]), background: false }).promise;
      const paths = row.paints.map((_, i) => i === row.paints.length - 1 ? [[0, 0, 2, 2]]
        : row.variant !== 'page' && i === row.paints.length - 2 ? [[210, 10, 80, 80]] : [[10, 10, 80, 80]]);
      expect(recording.fills).toHaveLength(row.paints.length); expect(recording.strokes).toHaveLength(row.paints.length);
      row.paints.forEach((key, i) => {
        expect(recording.fills[i]).toEqual({ color: colors[key].fill, alpha: 1, path: paths[i] });
        expect(recording.strokes[i]).toEqual({ color: colors[key].stroke, alpha: 1, width: 1, dash: [], path: paths[i] });
      });
      expect(recording.clips()).toBe(row.variant === 'form' ? 1 : 0); expect(recording.stack).toHaveLength(0);
      expect(recording.ctx.fillStyle).toBe('initial'); expect(recording.ctx.strokeStyle).toBe('initial');
    } finally { core.destroy(); }
  });
});
