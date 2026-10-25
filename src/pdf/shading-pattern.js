// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { readPdfShading, renderPdfShading } from './shading.js';
import { multiply } from './viewport.js';
import { resolvePdfColorSpace } from './color-spaces.js';
import { readPdfTilingPattern, renderPdfTilingPattern } from './tiling-pattern.js';
import { pdfPayloadBuffers } from './payload-buffers.js';
import { decodePdfStream } from './streams.js';

const corrupt = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };
const unsupported = message => { throw new PdfEngineError(message); };
const limit = () => { throw new PdfEngineError('PDF shading pattern resource budget exceeded.', 'pdf_limit'); };
const IDENTITY = [1, 0, 0, 1, 0, 0];

/** Pattern is admitted only for painting colours, never image/alternate spaces. */
export async function resolvePdfPaintSpace(reader, resources, value, loadAsset, depth = 0, profileMemo = null) {
  if (depth > 8) throw new PdfEngineError('PDF color-space nesting limit exceeded.', 'pdf_limit');
  const name = reader.name(value);
  if (name === 'Pattern') return { name, components: 0 };
  if (!name && reader.node(value).kind === 'array') {
    const array = reader.array(value);
    if (reader.name(array[0]) === 'Pattern') {
      if (array.length !== 1) unsupported('Uncoloured PDF Pattern spaces are not implemented.');
      return { name: 'Pattern', components: 0 };
    }
  }
  if (name && !['DeviceRGB', 'DeviceGray', 'DeviceCMYK'].includes(name)) {
    const dictionary = reader.field(resources, 'ColorSpace'), target = dictionary && reader.field(dictionary, name);
    if (target) return resolvePdfPaintSpace(reader, resources, target, loadAsset, depth + 1, profileMemo);
  }
  return resolvePdfColorSpace(reader, resources, value, loadAsset, depth, profileMemo);
}

/** Page-build ownership: never retain transferable arrays on the native reader. */
export function createPdfPatternReader(reader, loadAsset, profileCache, buildCell) {
  const patterns = new Map(), identities = new Set(), buffers = new Set(), nodes = new Set(), contexts = new WeakMap();
  let retainedBytes = 0, retainedEdges = 0, retainedContexts = 0, retainedCommands = 0, compiledBytes = 0;
  return async (id, resources, initialMatrix, context = null) => {
    const identity = reader.node(id).id, tiling = reader.number(reader.field(id, 'PatternType')) === 1;
    const key = tiling ? `tiling:${identity}` : `${identity}:${resources ? reader.node(resources).id : 0}`;
    let parsed = patterns.get(key);
    if (!parsed) {
      if (!identities.has(identity) && identities.size >= 256) limit();
      if (!['dictionary', 'stream'].includes(reader.node(id).kind)) corrupt('Invalid PDF pattern dictionary.');
      const optional = name => { const value = reader.field(id, name); return value && reader.node(value).kind !== 'null' ? value : 0; };
      const type = optional('Type'); if (type && reader.name(type) !== 'Pattern') corrupt('Invalid PDF pattern Type.');
      if (!tiling && reader.number(reader.field(id, 'PatternType')) !== 2) unsupported('This PDF pattern type is not implemented.');
      const matrixId = optional('Matrix'), matrix = matrixId ? reader.array(matrixId).map(value => reader.number(value, NaN)) : IDENTITY;
      if (matrix.length !== 6 || matrix.some(value => !Number.isFinite(value))) corrupt('Invalid PDF pattern Matrix.');
      if (!Number.isFinite(matrix[0] * matrix[3] - matrix[1] * matrix[2]) || matrix[0] * matrix[3] === matrix[1] * matrix[2]) unsupported('Singular PDF pattern transforms are not implemented.');
      if (tiling) {
        parsed = { descriptor: readPdfTilingPattern(reader, id), matrix }; patterns.set(key, parsed); identities.add(identity);
      } else {
        if (reader.node(id).kind !== 'dictionary') corrupt('Invalid PDF shading pattern dictionary.');
        const state = optional('ExtGState');
        if (state && reader.node(state).kind !== 'dictionary') corrupt('Invalid PDF shading pattern ExtGState.');
        if (state && reader.dictionary(state).size) unsupported('PDF shading pattern ExtGState is not implemented.');
        const shading = reader.field(id, 'Shading'); if (!shading) corrupt('Missing PDF pattern Shading.');
        if (reader.number(reader.field(shading, 'ShadingType')) !== 2) unsupported('Only axial PDF shading patterns are implemented.');
        const background = reader.field(shading, 'Background');
        if (background && reader.node(background).kind !== 'null') unsupported('PDF shading pattern Background is not implemented.');
        const descriptor = await readPdfShading(reader, shading, resources, loadAsset, profileCache);
        const pending = [...descriptor.functions, ...(descriptor.colorSpace.tintTransform ? [descriptor.colorSpace.tintTransform] : [])], addedNodes = new Set(), addedBuffers = new Set(); let bytes = 0, edges = pending.length;
        const retain = value => { if (ArrayBuffer.isView(value) && !buffers.has(value.buffer) && !addedBuffers.has(value.buffer)) { addedBuffers.add(value.buffer); bytes += value.buffer.byteLength; } };
        retain(descriptor.colorSpace.profileBytes); retain(descriptor.colorSpace.alternate?.profileBytes);
        for (let i = 0; i < pending.length; i++) {
          const fn = pending[i]; if (nodes.has(fn) || addedNodes.has(fn)) continue;
          addedNodes.add(fn); if (nodes.size + addedNodes.size > 4096) limit();
          retain(fn.samples); bytes += (fn.program?.length || 0) * 2;
          if (fn.functions) { edges += fn.functions.length; if (retainedEdges + edges > 16384) limit(); for (const child of fn.functions) pending.push(child); }
        }
        if (retainedBytes + bytes > 32 * 1024 * 1024 || retainedEdges + edges > 16384) limit();
        for (const node of addedNodes) nodes.add(node); for (const buffer of addedBuffers) buffers.add(buffer); retainedBytes += bytes; retainedEdges += edges;
        parsed = { descriptor, matrix }; patterns.set(key, parsed); identities.add(identity);
      }
    }
    let descriptor = parsed.descriptor;
    if (tiling && context) {
      if (typeof buildCell !== 'function') corrupt('Missing PDF tiling artwork builder.');
      let cached = contexts.get(context); const hit = cached?.get(identity);
      if (hit) descriptor = hit;
      else {
        if (retainedContexts >= 256) limit();
        if (!parsed.program) {
          if (retainedBytes >= 32 * 1024 * 1024) limit();
          const source = reader.node(descriptor.sourceId);
          if (!reader.field(descriptor.sourceId, 'Filter') && source.length > 32 * 1024 * 1024 - retainedBytes) limit();
          const { bytes } = await decodePdfStream(reader, descriptor.sourceId);
          if (retainedBytes + bytes.buffer.byteLength > 32 * 1024 * 1024) limit();
          parsed.program = bytes; retainedBytes += bytes.buffer.byteLength;
        }
        // Reusing decoded bytes avoids repeated decompression. Charge every
        // context's lexical scan as well, including whitespace without tokens.
        if (compiledBytes + parsed.program.length > 32 * 1024 * 1024) limit();
        compiledBytes += parsed.program.length;
        const commands = await buildCell(descriptor, context, parsed.program);
        if (retainedCommands + commands.length > 16384) limit();
        let bytes = 0;
        for (const command of commands) {
          bytes += 128;
          for (const value of Object.values(command)) { if (Array.isArray(value)) bytes += value.length * 16; else if (typeof value === 'string') bytes += value.length * 2; }
        }
        const added = pdfPayloadBuffers({ commands }).filter(buffer => !buffers.has(buffer));
        for (const buffer of added) bytes += buffer.byteLength;
        if (retainedBytes + bytes > 32 * 1024 * 1024) limit();
        for (const buffer of added) buffers.add(buffer); retainedBytes += bytes; retainedCommands += commands.length; retainedContexts++;
        descriptor = { ...descriptor, commands };
        if (!cached) { cached = new Map(); contexts.set(context, cached); } cached.set(identity, descriptor);
      }
    }
    const matrix = multiply(initialMatrix, parsed.matrix);
    if (matrix.some(value => !Number.isFinite(value))) corrupt('Non-finite PDF pattern transform.');
    return { ...descriptor, matrix, patternMatrix: parsed.matrix };
  };
}

/** Raster colour once; native Canvas fill/stroke supplies the geometry coverage. */
export async function paintPdfShadingPattern(pattern, ctx, paint, { basis, clipBounds, surfaceBudget, outputProfile, profileCache, cancellation, identityPaint = false, renderCell } = {}) {
  cancellation?.();
  const left = Math.max(0, Math.floor(clipBounds?.[0] ?? 0)), top = Math.max(0, Math.floor(clipBounds?.[1] ?? 0));
  const right = Math.min(ctx.canvas.width, Math.ceil(clipBounds?.[2] ?? ctx.canvas.width)), bottom = Math.min(ctx.canvas.height, Math.ceil(clipBounds?.[3] ?? ctx.canvas.height));
  const width = right - left, height = bottom - top; if (width <= 0 || height <= 0) return;
  const reserved = 2 * width * height; // Source canvas plus immutable CanvasPattern snapshot.
  if (!Number.isSafeInteger(reserved) || surfaceBudget.pixels + reserved > 16_000_000) throw new PdfEngineError('PDF transparency surface budget exceeded.', 'pdf_limit');
  surfaceBudget.pixels += reserved; let surface;
  try {
    surface = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : document.createElement('canvas'); surface.width = width; surface.height = height;
    const target = surface.getContext('2d'); if (!target) throw new PdfEngineError('Could not allocate PDF shading pattern surface.', 'pdf_render');
    const matrix = multiply(multiply([1, 0, 0, 1, -left, -top], basis), pattern.matrix); target.setTransform(...matrix);
    if (pattern.type === 1) await renderPdfTilingPattern(pattern, target, { surfaceBudget, cancellation, renderCell });
    else await renderPdfShading({ ...pattern, alpha: 1, blend: 'source-over' }, target, { outputProfile, profileCache, surfaceBudget, cancellation });
    cancellation?.();
    const texture = ctx.createPattern(surface, 'no-repeat'); if (!texture) throw new PdfEngineError('Could not create PDF shading pattern.', 'pdf_render');
    const current = identityPaint ? new DOMMatrix() : ctx.getTransform(), inverse = current.inverse();
    if (![inverse.a, inverse.b, inverse.c, inverse.d, inverse.e, inverse.f].every(Number.isFinite)) unsupported('Singular PDF pattern painting transforms are not implemented.');
    texture.setTransform(inverse.translate(left, top));
    ctx.save(); try { ctx.imageSmoothingEnabled = false; paint(texture); } finally { ctx.restore(); }
  } finally { if (surface) surface.width = surface.height = 0; surfaceBudget.pixels -= reserved; }
}
