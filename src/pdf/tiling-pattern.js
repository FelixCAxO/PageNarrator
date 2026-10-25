// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { MAX_IMAGE_BAND_PIXELS } from './image-limits.js';

const corrupt = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };
const unsupported = message => { throw new PdfEngineError(message); };
const limit = message => { throw new PdfEngineError(message, 'pdf_limit'); };

export function readPdfTilingPattern(reader, id) {
  if (reader.node(id).kind !== 'stream') corrupt('A PDF tiling pattern must be a stream.');
  if (reader.number(reader.field(id, 'PaintType')) !== 1 || reader.number(reader.field(id, 'TilingType')) !== 1) unsupported('This PDF tiling pattern paint or tiling type is not implemented.');
  const bbox = reader.array(reader.field(id, 'BBox')).map(n => reader.number(n, NaN));
  const steps = ['XStep', 'YStep'].map(key => reader.number(reader.field(id, key), NaN));
  if (bbox.length !== 4 || bbox.some(n => !Number.isFinite(n)) || !(bbox[2] > bbox[0] && bbox[3] > bbox[1])
    || steps.some(n => !Number.isFinite(n) || n === 0)) corrupt('Invalid PDF tiling pattern bounds or steps.');
  if (bbox[2] - bbox[0] > Math.abs(steps[0]) || bbox[3] - bbox[1] > Math.abs(steps[1])) unsupported('Overlapping PDF tiling pattern cells are not implemented.');
  const resources = reader.field(id, 'Resources');
  if (!resources || reader.node(resources).kind !== 'dictionary') corrupt('A PDF tiling pattern requires a resource dictionary.');
  return { type: 1, bbox, steps, resources, sourceId: reader.node(id).id };
}

/** TilingType1: constant integer device periods, at most one pixel distortion. */
export function planPdfTilingRaster(pattern, matrix) {
  const { bbox, steps } = pattern;
  if (!Array.isArray(matrix) || matrix.length !== 6 || matrix.some(n => !Number.isFinite(n))
    || !Array.isArray(bbox) || bbox.length !== 4 || bbox.some(n => !Number.isFinite(n)) || !(bbox[2] > bbox[0] && bbox[3] > bbox[1])
    || !Array.isArray(steps) || steps.length !== 2 || steps.some(n => !Number.isFinite(n) || n === 0)) corrupt('Invalid PDF tiling raster descriptor.');
  if (bbox[2] - bbox[0] > Math.abs(steps[0]) || bbox[3] - bbox[1] > Math.abs(steps[1])) unsupported('Overlapping PDF tiling pattern cells are not implemented.');
  if (!(matrix[1] === 0 && matrix[2] === 0 || matrix[0] === 0 && matrix[3] === 0)) unsupported('Oblique PDF tiling lattices are not implemented.');
  const round = n => Math.sign(n) * Math.floor(Math.abs(n) + .5), periods = steps.map(Math.abs);
  const quantized = matrix.map((n, i) => i < 4 ? round(n * periods[i < 2 ? 0 : 1]) / periods[i < 2 ? 0 : 1] : n);
  if (quantized.some(n => !Number.isFinite(n)) || !(quantized[0] || quantized[1]) || !(quantized[2] || quantized[3])) limit('PDF tiling periods exceed numeric limits.');
  let displacement = 0;
  for (const x of [bbox[0], bbox[2]]) for (const y of [bbox[1], bbox[3]]) displacement = Math.max(displacement,
    Math.hypot((quantized[0] - matrix[0]) * x + (quantized[2] - matrix[2]) * y, (quantized[1] - matrix[1]) * x + (quantized[3] - matrix[3]) * y));
  if (!Number.isFinite(displacement)) limit('PDF tiling distortion exceeds numeric limits.');
  if (displacement > 1) unsupported('PDF tiling requires more than one pixel of cell distortion.');
  // Starting the periodic domain at BBox avoids independently clipped wrap
  // fragments, whose antialiased source-over edges would leave visible seams.
  const points = [];
  for (const x of [bbox[0], bbox[0] + periods[0]]) for (const y of [bbox[1], bbox[1] + periods[1]]) points.push([quantized[0] * x + quantized[2] * y, quantized[1] * x + quantized[3] * y]);
  const left = Math.min(...points.map(p => p[0])), top = Math.min(...points.map(p => p[1]));
  const width = Math.round(Math.max(...points.map(p => p[0])) - left), height = Math.round(Math.max(...points.map(p => p[1])) - top);
  const phase = [matrix[4] + left, matrix[5] + top], cellMatrix = [...quantized.slice(0, 4), -left, -top];
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0) || phase.some(n => !Number.isFinite(n)) || cellMatrix.some(n => !Number.isFinite(n))) limit('PDF tiling raster exceeds numeric limits.');
  return { width, height, phase, cellMatrix, displacement };
}

/** A callback reuses the renderer without a renderer/helper import cycle. */
export async function renderPdfTilingPattern(pattern, ctx, { surfaceBudget, cancellation, renderCell } = {}) {
  cancellation?.();
  if (!Array.isArray(pattern.commands) || pattern.commands.length > 16384 || typeof renderCell !== 'function') corrupt('Invalid PDF tiling artwork descriptor.');
  const m = ctx.getTransform(), raster = planPdfTilingRaster(pattern, [m.a, m.b, m.c, m.d, m.e, m.f]);
  const pixels = raster.width * raster.height, reserved = 2 * pixels;
  if (!Number.isSafeInteger(reserved) || surfaceBudget.pixels + reserved > 16_000_000) limit('PDF transparency surface budget exceeded.');
  const work = (surfaceBudget.tilingPixels || 0) + pixels + ctx.canvas.width * ctx.canvas.height;
  if (!Number.isSafeInteger(work) || work > 64_000_000 || (surfaceBudget.tilingExecutions || 0) >= 4096
    || (surfaceBudget.tilingCommands || 0) + pattern.commands.length > 500000) limit('PDF tiling rendering work budget exceeded.');
  surfaceBudget.tilingPixels = work; surfaceBudget.tilingExecutions = (surfaceBudget.tilingExecutions || 0) + 1;
  surfaceBudget.tilingCommands = (surfaceBudget.tilingCommands || 0) + pattern.commands.length;
  surfaceBudget.pixels += reserved; let cell;
  try {
    cell = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(raster.width, raster.height) : document.createElement('canvas'); cell.width = raster.width; cell.height = raster.height;
    const target = cell.getContext('2d'); if (!target) throw new PdfEngineError('Could not allocate PDF tiling cell.', 'pdf_render');
    target.imageSmoothingEnabled = false;
    target.setTransform(...raster.cellMatrix); target.beginPath(); target.rect(pattern.bbox[0], pattern.bbox[1], pattern.bbox[2] - pattern.bbox[0], pattern.bbox[3] - pattern.bbox[1]); target.clip(); target.setTransform(1, 0, 0, 1, 0, 0);
    await renderCell(pattern.commands, target, raster.cellMatrix); cancellation?.();
    ctx.save(); try {
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.imageSmoothingEnabled = false;
      const brush = ctx.createPattern(cell, 'repeat'); if (!brush) throw new PdfEngineError('Could not create PDF tiling cell pattern.', 'pdf_render');
      brush.setTransform(new DOMMatrix().translate(...raster.phase)); ctx.fillStyle = brush;
      const columns = Math.min(ctx.canvas.width, MAX_IMAGE_BAND_PIXELS), rows = Math.max(1, Math.floor(MAX_IMAGE_BAND_PIXELS / columns)); let bands = 0;
      for (let y = 0; y < ctx.canvas.height; y += rows) for (let x = 0; x < ctx.canvas.width; x += columns) {
        if (bands++) { await new Promise(resolve => setTimeout(resolve, 0)); cancellation?.(); }
        ctx.fillRect(x, y, Math.min(columns, ctx.canvas.width - x), Math.min(rows, ctx.canvas.height - y));
      }
      cancellation?.();
    } finally { ctx.restore(); }
  } finally { if (cell) cell.width = cell.height = 0; surfaceBudget.pixels -= reserved; }
}
