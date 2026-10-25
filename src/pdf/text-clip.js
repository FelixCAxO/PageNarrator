// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { multiply } from './viewport.js';
import { admitTextOutline, paintPdfTextStroke } from './text-stroke.js';

const MAX_SEGMENTS = 200_000;
const invalid = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };
const limit = message => { throw new PdfEngineError(message, 'pdf_limit'); };
const matrixArray = m => Array.isArray(m) ? m : [m.a, m.b, m.c, m.d, m.e, m.f];

export function pdfTextGlyphMatrix(matrix, glyph) {
  return multiply(multiply(matrix, [1, 0, 0, 1, glyph.x, glyph.y ?? 0]), glyph.fontMatrix);
}
function appendPdfTextOutlineSegment(path, segment, matrix, clipCoordinates = false) {
  const p = [];
  for (let i = 0; i < segment.points.length; i += 2) p.push(matrix[0] * segment.points[i] + matrix[2] * segment.points[i + 1] + matrix[4], matrix[1] * segment.points[i] + matrix[3] * segment.points[i + 1] + matrix[5]);
  if (clipCoordinates && p.some(n => !Number.isFinite(n) || Math.abs(n) > 1e9)) limit('PDF text clipping coordinate budget exceeded.');
  if (p.some(n => !Number.isFinite(n))) invalid('Non-finite PDF glyph outline geometry.');
  if (segment.op === 1) path.moveTo(...p); else if (segment.op === 2) path.lineTo(...p);
  else if (segment.op === 3) path.bezierCurveTo(...p); else path.closePath();
}
export function pdfTextOutlinePath(glyph, matrix) {
  const path = new Path2D();
  for (const segment of glyph.outline) appendPdfTextOutlineSegment(path, segment, matrix);
  return path;
}
export function paintPdfOutlinedText(command, ctx) {
  if (command.paintMode === 1 || command.paintMode === 2) return paintPdfTextStroke(command, ctx);
  if (command.paintMode !== 0) invalid('Invalid outlined PDF text paint mode.');
  const budget = { points: 0 };
  for (const glyph of command.glyphs) {
    admitTextOutline(glyph, budget);
    const path = pdfTextOutlinePath(glyph, pdfTextGlyphMatrix(command.paintMatrix, glyph));
    ctx.save(); try { ctx.fillStyle = command.fill; ctx.globalAlpha = command.alpha ?? 1; ctx.globalCompositeOperation = command.blend || 'source-over'; ctx.fill(path, 'nonzero'); }
    finally { ctx.restore(); }
  }
}

/** Render-owned ET clipping: all original glyph subpaths share one nonzero rule. */
export class PdfTextClipper {
  constructor(cancellation) { this.cancellation = cancellation; this.disposed = false; }
  check() {
    if (this.disposed) throw new PdfEngineError('PDF text clipper is closed.', 'pdf_closed');
    this.cancellation();
  }
  async apply(command, ctx, basis) {
    this.check();
    const width = ctx.canvas.width, height = ctx.canvas.height;
    if (![width, height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 16384) || width * height > 32_000_000) limit('PDF text clipping target budget exceeded.');
    const budget = { points: 0 }, path = new Path2D(); let count = 0;
    for (const group of command.groups) for (const glyph of group.glyphs) {
      admitTextOutline(glyph, budget);
      if (!glyph.outline.length) continue;
      const matrix = pdfTextGlyphMatrix(multiply(basis, group.matrix), glyph);
      let started = false;
      for (const segment of glyph.outline) {
        if (segment.op === 1) started = true; else if (!started) invalid('Invalid PDF glyph outline segment order.');
        if (++count > MAX_SEGMENTS) limit('PDF text clipping segment budget exceeded.');
        appendPdfTextOutlineSegment(path, segment, matrix, true);
        if (count % 2048 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); this.check(); }
      }
    }
    if (!count) return;
    const matrix = matrixArray(ctx.getTransform()); this.check();
    // The explicit device-space path leaves the ordinary current path untouched.
    ctx.setTransform(1, 0, 0, 1, 0, 0); try { ctx.clip(path, 'nonzero'); } finally { ctx.setTransform(...matrix); }
  }
  dispose() { this.disposed = true; }
}
