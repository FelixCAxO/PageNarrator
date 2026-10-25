// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { decodePdfStream } from './streams.js';
import { multiply } from './viewport.js';

export const PDF_INHERITED_RGB_RECTANGLE = 'inherited-rgb-cmyk-rectangle-v1';
const corrupt = () => { throw new PdfEngineError('Invalid inherited-RGB PDF rectangle program.', 'pdf_corrupt'); };
const unsupported = () => { throw new PdfEngineError('This inherited-RGB PDF rectangle program is not implemented.', 'pdf_unsupported'); };
const finite = (values, count) => Array.isArray(values) && values.length === count
  && Array.from(values).every(value => typeof value === 'number' && Number.isFinite(value));
const unit = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const record = value => value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const only = (value, keys) => record(value) && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key));
const rgb = values => finite(values, 3) && values.every(unit);
const css = values => `rgb(${values.map(value => Math.round(value * 255)).join(',')})`;
const field = (reader, id, key) => { const value = reader.field(id, key); return value && reader.node(value).kind !== 'null' ? value : 0; };

/** Preparse a tiny original program once, retaining the same tokens for interpretation.
 * Other programs keep their existing native-CMYK contribution policy. Only the
 * complete k/gs/re/f Multiply family chooses inherited RGB (ISO32000-1 11.7.2).
 */
export async function preparePdfInheritedRgbRectangle(reader, id, resources) {
  if (reader.node(id).length > 4096) return null;
  const bytes = (await decodePdfStream(reader, id)).bytes, prepared = { bytes };
  if (bytes.length > 4096) return prepared;
  const tokens = reader.content(bytes), entries = []; let operands = [];
  prepared.tokens = tokens;
  prepared.release = () => reader.releaseContent(tokens);
  try {
  for (const id of tokens) {
    reader.check();
    const token = reader.node(id);
    if (token.kind !== 'operator') operands.push(id);
    else { entries.push({ op: reader.text(token), operands }); operands = []; }
  }
  // Ordinary inline content keeps its existing framing iterator. This tiny
  // compatibility grammar never admits inline image origins.
  if (tokens.some(id => reader.node(id).inlineDataOffset !== undefined)) {
    prepared.release(); delete prepared.tokens; return prepared;
  }
  if (entries[0]?.op !== 'k' || entries[1]?.op !== 'gs' || entries[1].operands.length !== 1) return prepared;
  const name = reader.name(entries[1].operands[0]), states = field(reader, resources, 'ExtGState'), state = states && field(reader, states, name);
  if (!state || reader.name(field(reader, state, 'BM')) !== 'Multiply') return prepared;
  if (entries.length !== 4 || entries.some((entry, index) => entry.op !== ['k', 'gs', 're', 'f'][index]) || operands.length) unsupported();
  const numbers = (entry, count) => {
    if (entry.operands.length !== count) corrupt();
    const values = entry.operands.map(id => reader.number(id, NaN)); if (!finite(values, count)) corrupt(); return values;
  };
  const source = numbers(entries[0], 4), rectangle = numbers(entries[2], 4); numbers(entries[3], 0);
  if (!source.every(unit)) unsupported();
  if (reader.node(state).kind !== 'dictionary') corrupt();
  const allowed = new Set(['Type', 'BM', 'ca', 'CA', 'AIS', 'OP', 'op', 'OPM', 'SA', 'SMask']);
  for (const key of reader.dictionary(state).keys()) if (!allowed.has(key) && field(reader, state, key)) unsupported();
  const type = field(reader, state, 'Type'); if (type && reader.name(type) !== 'ExtGState') corrupt();
  const flag = key => { const id = field(reader, state, key); if (!id) unsupported(); const node = reader.node(id); if (node.kind !== 'boolean') corrupt(); return node.aux !== 0; };
  if (flag('OP') || flag('op')) unsupported();
  const alphaIsShape = flag('AIS'), alpha = reader.number(field(reader, state, 'ca'), NaN);
  if (!unit(alpha)) corrupt();
  const stroke = field(reader, state, 'CA'); if (stroke && !unit(reader.number(stroke, NaN))) corrupt();
  const mode = field(reader, state, 'OPM'); if (mode && ![0, 1].includes(reader.number(mode, NaN))) corrupt();
  const adjustment = field(reader, state, 'SA'); if (adjustment && reader.node(adjustment).kind !== 'boolean') corrupt();
  const mask = field(reader, state, 'SMask'); if (mask && reader.name(mask) !== 'None') unsupported();
  return { ...prepared, rectangle: { source, rectangle, alpha, alphaIsShape } };
  } catch (error) { prepared.release(); throw error; }
}

/** This subtype reuses only the existing owned Gray-JPEG luminosity descriptor. */
export function assertPdfInheritedRgbMask(mask) {
  if (mask === null || mask === undefined) return;
  const image = mask?.deviceImage;
  if (!only(mask, ['type', 'deviceImage', 'matrix', 'bbox', 'backdrop']) || mask.type !== 'Luminosity'
    || !only(image, ['samples', 'width', 'height', 'matrix']) || !(image.samples instanceof Uint8Array) || !(image.samples.buffer instanceof ArrayBuffer)
    || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1
    || image.width * image.height > 32_000_000 || image.samples.length !== image.width * image.height
    || image.samples.byteLength > 32 * 1024 * 1024 || image.samples.byteOffset !== 0 || image.samples.buffer.byteLength !== image.samples.byteLength || !finite(image.matrix, 6)
    || !finite(mask.matrix, 6) || !finite(mask.bbox, 4) || !finite(mask.backdrop, 4) || !mask.backdrop.every(unit)) corrupt();
}

/** Whole canonical consumer closure, before scratch allocation or alpha0 returns. */
export function assertPdfInheritedRgbRectangle(group, check = () => {}, pageTransform = [1, 0, 0, 1, 0, 0]) {
  check();
  if (!record(group) || group.op !== 'group' || group.rgbCompatibility !== PDF_INHERITED_RGB_RECTANGLE
    || group.declaredColorSpace !== 'DeviceCMYK' || group.effectiveColorSpace !== 'DeviceRGB' || group.isolated !== false
    || group.nativeColorSpace !== undefined || group.colorProfile !== null || group.backdropIndependent !== undefined || group.sourceContribution !== undefined
    || group.blend !== 'source-over' || !unit(group.alpha) || typeof group.alphaIsShape !== 'boolean'
    || typeof group.sourceAlphaIsShape !== 'boolean' || group.knockout !== false || group.fillOverprint !== false || group.strokeOverprint !== false
    || !finite(group.sourceCmyk, 4) || !group.sourceCmyk.every(unit) || !Array.isArray(group.commands) || group.commands.length !== 11 || !finite(pageTransform, 6)) corrupt();
  assertPdfInheritedRgbMask(group.softMask);
  const commands = group.commands, expected = ['transform', 'save', 'color', 'color', 'transform', 'path', 'paint', 'color', 'path', 'paint', 'restore'];
  let matrix = pageTransform;
  const properties = {
    transform: ['op', 'args'], save: ['op'], restore: ['op'], color: ['op', 'fill', 'value', 'nativeColor'], path: ['op', 'kind', 'args'],
    paint: ['op', 'kind', 'clip', 'fillAlpha', 'strokeAlpha', 'blend', 'lineWidth', 'strokeAdjustment'],
  };
  for (let index = 0; index < commands.length; index++) {
    check(); const command = commands[index];
    if (!record(command) || command.op !== expected[index] || !only(command, properties[command.op])) corrupt();
    if (command.op === 'transform') {
      if (!finite(command.args, 6)) corrupt(); matrix = multiply(matrix, command.args); if (!finite(matrix, 6)) corrupt();
    } else if (command.op === 'color') {
      if (command.fill !== (index !== 3) || !rgb(command.nativeColor) || command.value !== css(command.nativeColor)) corrupt();
    } else if (command.op === 'path') {
      if (command.kind !== 're' || !finite(command.args, 4)) corrupt();
      const [x, y, width, height] = command.args;
      for (const [a, b] of [[x, y], [x + width, y], [x + width, y + height], [x, y + height]]) {
        if (![matrix[0] * a + matrix[2] * b + matrix[4], matrix[1] * a + matrix[3] * b + matrix[5]].every(Number.isFinite)) corrupt();
      }
    } else if (command.op === 'paint') {
      if (index === 6) { if (command.kind !== 'n' || command.clip !== 'nonzero') corrupt(); }
      else if (command.kind !== 'f' || command.clip !== null || command.blend !== 'multiply' || !unit(command.fillAlpha)
        || !unit(command.strokeAlpha) || !Number.isFinite(command.lineWidth) || command.lineWidth < 0 || typeof command.strokeAdjustment !== 'boolean') corrupt();
    }
  }
}

/** Conservatively reserve two F16 readbacks plus an F64 mask. Same live owner. */
export function pdfInheritedRgbBandPixels(budget, masked) {
  const cost = masked ? 6 : 4;
  if (!Number.isSafeInteger(budget?.pixels) || budget.pixels < 0) corrupt();
  const pixels = Math.min(262144, Math.floor((16_000_000 - budget.pixels) / cost));
  if (pixels < 1) throw new PdfEngineError('PDF transparency surface budget exceeded.', 'pdf_limit');
  return pixels;
}

export function assertPdfInheritedRgbFootprint(budget, width, height, masked) {
  const pixels = width * height;
  if (![width, height].every(Number.isSafeInteger) || width < 1 || height < 1) corrupt();
  if (!Number.isSafeInteger(pixels) || pixels < 1 || !Number.isSafeInteger(budget?.pixels) || budget.pixels < 0
    || !Number.isSafeInteger(budget.shadingPixels ?? 0) || (budget.shadingPixels ?? 0) < 0) corrupt();
  const live = budget.pixels + pixels * 2 + (masked ? 6 : 4), work = (budget.shadingPixels ?? 0) + pixels * (masked ? 2 : 1);
  if (!Number.isSafeInteger(live) || live > 16_000_000 || !Number.isSafeInteger(work) || work > 64_000_000) throw new PdfEngineError('PDF inherited-RGB rectangle budget exceeded.', 'pdf_limit');
  const bandPixels = pdfInheritedRgbBandPixels({ pixels: budget.pixels + pixels * 2 }, masked);
  const columns = Math.min(width, bandPixels), rows = Math.max(1, Math.floor(bandPixels / columns));
  // Near-cap ancestors must not turn a page into millions of tiny allocations
  // and event-loop yields. Normal full bands need at most32 here.
  if (Math.ceil(width / columns) * Math.ceil(height / rows) > 4096) throw new PdfEngineError('PDF inherited-RGB rectangle band limit exceeded.', 'pdf_limit');
}
