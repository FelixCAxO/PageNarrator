// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { readPdfFunction, compilePdfFunction } from './pdf-functions.js';
import { resolvePdfColorSpace, deviceRgb, deviceGray } from './color-spaces.js';
import { parseIccProfile } from './icc-color.js';
import { convertPdfColor } from './icc-blend.js';
import { MAX_IMAGE_BAND_PIXELS } from './image-limits.js';

const corrupt = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };
async function shadingColorDescriptor(space, loadAsset) {
  if (space.name === 'Separation' && space.colorant === 'All') throw new PdfEngineError('PDF Separation /All shading is not implemented yet.');
  if (space.name === 'DeviceN' || space.name === 'Separation') return { name: space.name, components: space.components, tintTransform: space.tintTransform,
    alternate: await shadingColorDescriptor(space.alternate, loadAsset) };
  let profileBytes = space.profileBytes || null;
  if (space.name === 'DeviceCMYK') profileBytes = await loadAsset('iccs/CGATS001Compat-v2-micro.icc');
  if (!profileBytes && !['DeviceRGB', 'DeviceGray'].includes(space.name)) throw new PdfEngineError(`PDF shading color space ${space.name} is not implemented yet.`);
  return { name: space.name, profileBytes };
}
export async function readPdfShading(reader, id, resources, loadAsset, profileMemo = null) {
  const type = reader.number(reader.field(id, 'ShadingType'));
  if (type !== 2 && type !== 3) throw new PdfEngineError(`PDF shading type ${type} is not implemented yet.`);
  const numeric = (key, count, fallback = null) => {
    const value = reader.field(id, key), array = value ? reader.array(value).map(n => reader.number(n, NaN)) : fallback;
    if (!array || array.length !== count || array.some(n => !Number.isFinite(n))) corrupt(`Invalid PDF shading ${key}.`);
    return array;
  };
  const coords = numeric('Coords', type === 3 ? 6 : 4), domain = numeric('Domain', 2, [0, 1]), box = reader.field(id, 'BBox') ? numeric('BBox', 4) : null;
  if (type === 2 && coords[0] === coords[2] && coords[1] === coords[3]) corrupt('Degenerate PDF axial shading axis.');
  if (type === 3 && (coords[2] < 0 || coords[5] < 0)) corrupt('Negative PDF radial shading radius.');
  const extendId = reader.field(id, 'Extend'), extendNodes = extendId ? reader.array(extendId).map(id => reader.node(id)) : null;
  if (extendNodes && (extendNodes.length !== 2 || extendNodes.some(n => n.kind !== 'boolean'))) corrupt('Invalid PDF shading Extend.');
  const extend = extendNodes ? extendNodes.map(n => n.aux !== 0) : [false, false];
  const space = await resolvePdfColorSpace(reader, resources, reader.field(id, 'ColorSpace'), loadAsset, 0, profileMemo);
  if (space.indexed) corrupt('An axial or radial PDF shading cannot use an Indexed color space.');
  const colorSpace = await shadingColorDescriptor(space, loadAsset);
  const functionId = reader.field(id, 'Function'); if (!functionId) corrupt('Missing PDF shading function.');
  const functionIds = reader.node(functionId).kind === 'array' ? reader.array(functionId) : [functionId], functions = [];
  for (const value of functionIds) functions.push(await readPdfFunction(reader, value));
  if (!functions.length || functions.length > 4 || functions.some(fn => fn.inputs !== 1 || fn.domain[0] > Math.min(...domain) || fn.domain[1] < Math.max(...domain))
    || (functions.length === 1 ? functions[0].outputs !== space.components : functions.length !== space.components || functions.some(fn => fn.outputs !== 1))) corrupt('PDF shading function/color dimensions disagree.');
  return { type, coords, domain, box, extend, functions, colorSpace };
}

// Solve the interpolated circle equation; later valid circles paint over earlier ones.
export function radialParameter(coords, extend) {
  const [x0, y0, r0, x1, y1, r1] = coords, dx = x1 - x0, dy = y1 - y0, dr = r1 - r0;
  const a = dx * dx + dy * dy - dr * dr;
  if (!Number.isFinite(a)) throw new PdfEngineError('PDF radial shading exceeds numeric limits.', 'pdf_limit');
  const allowed = s => Number.isFinite(s) && r0 + s * dr >= 0 && (s >= 0 || extend[0]) && (s <= 1 || extend[1]);
  return (x, y) => {
    const px = x - x0, py = y - y0, b = -2 * (px * dx + py * dy + r0 * dr), c = px * px + py * py - r0 * r0;
    if (!Number.isFinite(b) || !Number.isFinite(c)) throw new PdfEngineError('PDF radial shading exceeds numeric limits.', 'pdf_limit');
    if (a === 0) {
      if (b === 0) return c === 0 && allowed(1) ? 1 : NaN;
      const s = -c / b; return allowed(s) ? s : NaN;
    }
    const discriminant = b * b - 4 * a * c;
    if (!Number.isFinite(discriminant)) throw new PdfEngineError('PDF radial shading exceeds numeric limits.', 'pdf_limit');
    if (discriminant < 0) return NaN;
    const q = -.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(discriminant));
    const first = q / a, second = q === 0 ? first : c / q;
    return allowed(first) ? allowed(second) ? Math.max(first, second) : first : allowed(second) ? second : NaN;
  };
}

/** Exact function evaluation at device pixel centers; no approximation by gradient stops. */
export async function renderPdfShading(command, ctx, { outputProfile = null, profileCache = new WeakMap(), surfaceBudget = { pixels: 0 }, cancellation, clipBounds = null } = {}) {
  cancellation?.();
  if (command.type === 3 && (command.coords[2] === 0 && command.coords[5] === 0
    || command.coords[0] === command.coords[3] && command.coords[1] === command.coords[4] && command.coords[2] === command.coords[5])) return;
  const descriptor = command.colorSpace, tinted = descriptor.name === 'DeviceN' || descriptor.name === 'Separation', alternate = tinted ? descriptor.alternate : descriptor;
  if (tinted && (!Number.isInteger(descriptor.components) || descriptor.components < 1 || descriptor.components > 4
    || descriptor.name === 'Separation' && descriptor.components !== 1
    || !descriptor.tintTransform || typeof descriptor.tintTransform !== 'object'
    || !alternate || !['DeviceRGB', 'DeviceGray', 'DeviceCMYK', 'ICCBased'].includes(alternate.name))) corrupt(`Invalid PDF ${descriptor.name} shading color descriptor.`);
  const bytes = alternate.profileBytes;
  if (tinted && !bytes && !['DeviceRGB', 'DeviceGray'].includes(alternate.name)) corrupt(`Missing PDF ${descriptor.name} shading alternate profile.`);
  if (bytes && !profileCache.has(bytes)) profileCache.set(bytes, parseIccProfile(bytes));
  const space = bytes ? profileCache.get(bytes) : alternate.name === 'DeviceGray' ? deviceGray() : deviceRgb();
  const tint = tinted ? compilePdfFunction(descriptor.tintTransform) : null, alternateValues = tint ? new Array(tint.outputs) : null;
  if (tint && (tint.inputs !== descriptor.components || tint.outputs !== (space.channels ?? space.components))) corrupt(`PDF ${descriptor.name} shading tint dimensions disagree.`);
  const functions = command.functions.map(compilePdfFunction), input = [0], values = new Array(functions.reduce((sum, fn) => sum + fn.outputs, 0)), single = [0];
  if (tint && values.length !== tint.inputs) corrupt(`PDF ${descriptor.name} shading function/color dimensions disagree.`);
  const matrix = ctx.getTransform(), determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!determinant || !Number.isFinite(determinant)) throw new PdfEngineError('Singular PDF shading transform is not implemented yet.');
  const inverse = [matrix.d / determinant, -matrix.b / determinant, -matrix.c / determinant, matrix.a / determinant];
  const bounds = command.box ? [[command.box[0], command.box[1]], [command.box[0], command.box[3]], [command.box[2], command.box[1]], [command.box[2], command.box[3]]]
    .map(([x, y]) => [matrix.a * x + matrix.c * y + matrix.e, matrix.b * x + matrix.d * y + matrix.f]) : [[0, 0], [ctx.canvas.width, ctx.canvas.height]];
  const left = Math.max(0, clipBounds ? Math.floor(clipBounds[0]) : 0, Math.floor(Math.min(...bounds.map(p => p[0])))), right = Math.min(ctx.canvas.width, clipBounds ? Math.ceil(clipBounds[2]) : ctx.canvas.width, Math.ceil(Math.max(...bounds.map(p => p[0]))));
  const top = Math.max(0, clipBounds ? Math.floor(clipBounds[1]) : 0, Math.floor(Math.min(...bounds.map(p => p[1])))), bottom = Math.min(ctx.canvas.height, clipBounds ? Math.ceil(clipBounds[3]) : ctx.canvas.height, Math.ceil(Math.max(...bounds.map(p => p[1]))));
  const width = right - left, height = bottom - top; if (width <= 0 || height <= 0) return;
  const pixels = width * height;
  if (((surfaceBudget.shadingPixels || 0) + pixels) > 64_000_000) throw new PdfEngineError('PDF shading pixel-work budget exceeded.', 'pdf_limit');
  surfaceBudget.shadingPixels = (surfaceBudget.shadingPixels || 0) + pixels;
  const rows = Math.max(1, Math.floor(MAX_IMAGE_BAND_PIXELS / width)), [x0, y0, x1, y1] = command.coords, dx = x1 - x0, dy = y1 - y0, denominator = dx * dx + dy * dy;
  const parameterAt = command.type === 3 ? radialParameter(command.coords, command.extend)
    : (x, y) => ((x - x0) * dx + (y - y0) * dy) / denominator;
  const surface = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, Math.min(rows, height)) : document.createElement('canvas');
  surface.width = width; surface.height = Math.min(rows, height);
  ctx.save(); try {
    if (command.box) { const path = new Path2D(); path.rect(command.box[0], command.box[1], command.box[2] - command.box[0], command.box[3] - command.box[1]); ctx.clip(path); }
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = command.alpha ?? 1; ctx.globalCompositeOperation = command.blend || 'source-over';
    for (let band = top; band < bottom; band += rows) {
      if (band !== top) { await new Promise(resolve => setTimeout(resolve, 0)); cancellation?.(); }
      const count = Math.min(rows, bottom - band), data = new Uint8ClampedArray(width * count * 4);
      for (let y = 0; y < count; y++) for (let x = 0; x < width; x++) {
        const px = x + left + .5 - matrix.e, py = y + band + .5 - matrix.f, ux = inverse[0] * px + inverse[2] * py, uy = inverse[1] * px + inverse[3] * py;
        const parameter = parameterAt(ux, uy);
        if (command.type === 3 && Number.isNaN(parameter) || parameter < 0 && !command.extend[0] || parameter > 1 && !command.extend[1]) continue;
        input[0] = command.domain[0] + Math.max(0, Math.min(1, parameter)) * (command.domain[1] - command.domain[0]);
        if (functions.length === 1) functions[0](input, values);
        else functions.forEach((fn, i) => { fn(input, single); values[i] = single[0]; });
        if (tint) {
          for (let i = 0; i < values.length; i++) { if (!Number.isFinite(values[i])) corrupt(`Non-finite PDF ${descriptor.name} shading tint.`); values[i] = Math.max(0, Math.min(1, values[i])); }
          tint(values, alternateValues);
        }
        const rgb = convertPdfColor(space, alternateValues || values, outputProfile), offset = (y * width + x) * 4;
        for (let channel = 0; channel < 3; channel++) data[offset + channel] = rgb[channel] * 255; data[offset + 3] = 255;
      }
      if (surface.height !== count) surface.height = count;
      const target = surface.getContext('2d'); if (!target) throw new PdfEngineError('Could not allocate PDF shading surface.', 'pdf_render');
      target.putImageData(new ImageData(data, width, count), 0, 0); cancellation?.(); ctx.drawImage(surface, left, band);
    }
  } finally { ctx.restore(); surface.width = surface.height = 0; }
}
