// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';

const point = (m, x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
const unsupported = () => { throw new PdfEngineError('Automatic PDF stroke adjustment under a nonuniform transform is not implemented yet.'); };

/** Capture device coordinates when a path is constructed, independently of the
 * CTM in effect later when it is stroked (ISO 32000-1, 8.4.3.2 and 10.6.5). */
export class PdfStrokePath {
  constructor() { this.reset(); }
  reset() { this.segments = []; this.current = [0, 0]; this.start = [0, 0]; this.points = 0; this.boundsKnown = true; }
  add(kind, args, matrix) {
    if (!matrix) { this.boundsKnown = false; return; }
    const p = (x, y) => point(matrix, x, y), append = (kind, points) => {
      this.points += points.length / 2;
      if (this.points > 200_000) throw new PdfEngineError('PDF stroke path point budget exceeded.', 'pdf_limit');
      this.segments.push({ kind, points });
    };
    if (kind === 'm') { this.current = p(...args); this.start = this.current; append('m', this.current); }
    else if (kind === 'l') { this.current = p(...args); append('l', this.current); }
    else if (kind === 're') {
      const [x, y, w, h] = args; this.current = p(x, y); this.start = this.current;
      append('m', this.current); append('l', p(x + w, y)); append('l', p(x + w, y + h)); append('l', p(x, y + h)); append('h', []);
    } else if (kind === 'h') { append('h', []); this.current = this.start; }
    else {
      const first = kind === 'v' ? this.current : p(args[0], args[1]);
      const end = kind === 'c' ? p(args[4], args[5]) : p(args[2], args[3]);
      const second = kind === 'y' ? end : kind === 'v' ? p(args[0], args[1]) : p(args[2], args[3]);
      append('c', [...first, ...second, ...end]); this.current = end;
    }
  }
  bounds() {
    if (!this.boundsKnown) return null;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    // Cubic curves stay within the convex hull of their device control points.
    for (const { points } of this.segments) for (let i = 0; i < points.length; i += 2) {
      const x = points[i], y = points[i + 1]; if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
    return left === Infinity ? [0, 0, 0, 0] : [left, top, right, bottom];
  }
  stroke(ctx, { width, adjust = false } = {}) {
    const matrix = ctx.getTransform(), sx = Math.hypot(matrix.a, matrix.b), sy = Math.hypot(matrix.c, matrix.d);
    const conformal = sx > 0 && Math.abs(sx - sy) <= Math.max(sx, sy) * 1e-8 && Math.abs(matrix.a * matrix.c + matrix.b * matrix.d) <= sx * sy * 1e-8;
    const dash = ctx.getLineDash();
    if ((!conformal && (adjust && width !== 0 || dash.length)) || !Number.isFinite(sx + sy)) unsupported();
    const deviceWidth = width === 0 ? 1 : Math.max(1, Math.round(width * sx)), phase = deviceWidth % 2 / 2;
    const snap = p => adjust ? p.map(n => Math.round(n - phase) + phase) : p;
    const path = new Path2D(); let current = [0, 0], delta = [0, 0], startDelta = delta, start = current;
    for (const segment of this.segments) {
      const p = segment.points;
      if (segment.kind === 'm' || segment.kind === 'l') {
        const next = snap(p); delta = next.map((n, i) => n - p[i]); current = p;
        if (segment.kind === 'm') { path.moveTo(...next); start = current; startDelta = delta; } else path.lineTo(...next);
      } else if (segment.kind === 'h') { path.closePath(); current = start; delta = startDelta; }
      else {
        const end = p.slice(4), adjustedEnd = snap(end), endDelta = adjustedEnd.map((n, i) => n - end[i]);
        // Move each control point with its endpoint, preserving endpoint tangents.
        path.bezierCurveTo(p[0] + delta[0], p[1] + delta[1], p[2] + endDelta[0], p[3] + endDelta[1], ...adjustedEnd);
        current = end; delta = endDelta;
      }
    }
    ctx.save(); try {
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.lineWidth = deviceWidth;
      ctx.setLineDash(dash.map(n => n * sx)); ctx.lineDashOffset *= sx; ctx.stroke(path);
    } finally { ctx.restore(); }
  }
}
