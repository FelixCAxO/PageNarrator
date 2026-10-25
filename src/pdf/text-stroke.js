// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original bounded glyph outline admission and stroke painting.
import { PdfEngineError } from './native-reader.js';
import { multiply } from './viewport.js';
import { PdfStrokePath } from './stroke-adjust.js';

const MAX_TEXT_OUTLINE_POINTS = 200_000;
const invalid = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };
export function admitTextOutline(value, budget) {
  const { outline, fontMatrix } = value ?? {};
  if (!Array.isArray(outline) || !Array.isArray(fontMatrix) || fontMatrix.length !== 6 || fontMatrix.some(n => !Number.isFinite(n))) invalid('Invalid PDF glyph outline or matrix.');
  let points = 0;
  for (const segment of outline) {
    const length = segment.op === 3 ? 6 : segment.op === 4 ? 0 : segment.op === 1 || segment.op === 2 ? 2 : -1;
    if (length < 0 || !Array.isArray(segment.points) || segment.points.length !== length || segment.points.some(n => !Number.isFinite(n))) invalid('Invalid PDF glyph outline segment.');
    points += Math.max(1, length / 2); // Close-only segments also consume bounded work/storage.
    if (budget.points + points > MAX_TEXT_OUTLINE_POINTS) throw new PdfEngineError('PDF text outline point limit exceeded.', 'pdf_limit');
  }
  budget.points += points;
  return value;
}

// Keep raw charstrings/path cache only for explicitly requested stroked fonts.
// Admission estimates include all retained byte arrays/map entries and the
// existing native reader's 65,536-segment cache bound; not actual heap telemetry.
export function retainType1Outlines(program, glyph, names, defaultName) {
  let resourceBytes = 65_536 * 128 + program.subrs.length * 8;
  for (const [name, bytes] of program.glyphs) resourceBytes += bytes.byteLength + 256 + name.length * 2;
  for (const bytes of program.subrs) if (bytes) resourceBytes += bytes.byteLength + 64;
  return { resourceBytes, glyphOutline(code) {
    const requested = names.get(code) ?? defaultName(code);
    const name = program.glyphs.has(requested) ? requested : '.notdef';
    return { outline: program.glyphs.has(name) ? glyph(name).path : [], fontMatrix: program.matrix };
  } };
}

export function paintPdfTextStroke(command, ctx) {
  if (command.paintMode !== 1 && command.paintMode !== 2) invalid('Invalid outlined PDF text paint mode.');
  // Glyph shape uses the text matrix, font size and FontMatrix. The path is
  // placed in PDF user coordinates before Canvas applies the current PDF CTM;
  // stroking width/dashes must not acquire font-size/text-matrix scaling.
  const budget = { points: 0 };
  for (const glyph of command.glyphs) {
    const path = new Path2D(), stroke = new PdfStrokePath();
    admitTextOutline(glyph, budget);
    const matrix = multiply(multiply(command.paintMatrix, [1, 0, 0, 1, glyph.x, glyph.y ?? 0]), glyph.fontMatrix);
    const point = (x, y) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
    let open = false;
    const close = () => { path.closePath(); if (command.lineWidth === 0 || command.strokeAdjustment) stroke.add('h', [], ctx.getTransform()); open = false; };
    for (const segment of glyph.outline) {
      if (segment.op === 1 && open) close();
      const p = [];
      for (let i = 0; i < segment.points.length; i += 2) p.push(...point(segment.points[i], segment.points[i + 1]));
      if (p.some(n => !Number.isFinite(n))) invalid('Non-finite PDF text outline geometry.');
      const kind = ({ 1: 'm', 2: 'l', 3: 'c', 4: 'h' })[segment.op];
      if (kind === 'm') path.moveTo(...p); else if (kind === 'l') path.lineTo(...p);
      else if (kind === 'c') path.bezierCurveTo(...p); else path.closePath();
      if (command.lineWidth === 0 || command.strokeAdjustment) stroke.add(kind, p, ctx.getTransform());
      open = kind !== 'h';
    }
    if (open) close();
    ctx.save();
    try {
    ctx.fillStyle = command.fill; ctx.strokeStyle = command.stroke;
    ctx.globalCompositeOperation = command.blend || 'source-over';
    if (command.paintMode === 2) { ctx.globalAlpha = command.alpha ?? 1; ctx.fill(path, 'nonzero'); }
    ctx.globalAlpha = command.strokeAlpha ?? 1;
    if (command.lineWidth === 0 || command.strokeAdjustment) stroke.stroke(ctx, { width: command.lineWidth, adjust: command.strokeAdjustment });
    else { ctx.lineWidth = command.lineWidth; ctx.stroke(path); }
    } finally { ctx.restore(); }
  }
}
