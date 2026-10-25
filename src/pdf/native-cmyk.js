// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { readPdfFunction, compilePdfFunction } from './pdf-functions.js';

const clamp = value => Math.max(0, Math.min(1, value));
const corrupt = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };
const limit = message => { throw new PdfEngineError(message, 'pdf_limit'); };
// ISO32000-1 10.3.4 leaves device defaults configurable. This device's
// declared policy is BG(k)=UCR(k)=k; null denotes that policy, not zero.
export const PDF_CMYK_PRINT_DEFAULTS = Object.freeze({ blackGeneration: null, undercolorRemoval: null });

function retainedFunctionBytes(descriptor) {
  const pending = [descriptor], seen = new Set(); let bytes = 0;
  for (let at = 0; at < pending.length; at++) {
    const fn = pending[at]; if (seen.has(fn)) continue; seen.add(fn);
    // Include the existing sampled compiler's expanded Uint32 values and
    // conservative descriptor/array storage before retaining the function.
    bytes += 128 + (fn.program?.length || 0) * 2 + (fn.samples?.byteLength || 0);
    if (fn.type === 0) bytes += fn.size.reduce((count, size) => count * size, fn.outputs) * 4;
    for (const value of Object.values(fn)) if (Array.isArray(value) && value !== fn.functions) bytes += value.length * 8;
    if (fn.functions) pending.push(...fn.functions);
    if (!Number.isSafeInteger(bytes) || bytes > 32 * 1024 * 1024) limit('PDF print function byte limit exceeded.');
  }
  return bytes;
}

/** Build-local, immutable graphics-state values; no new payload or group admission. */
export function createPdfPrintStateReader(reader) {
  const functions = new Map(); let retainedBytes = 0;
  return async (target, previous = PDF_CMYK_PRINT_DEFAULTS) => {
    let result = previous;
    for (const [legacy, preferred, property] of [['BG', 'BG2', 'blackGeneration'], ['UCR', 'UCR2', 'undercolorRemoval']]) {
      const modern = reader.field(target, preferred), modernPresent = modern && reader.node(modern).kind !== 'null';
      const value = modernPresent ? modern : reader.field(target, legacy);
      if (!value || reader.node(value).kind === 'null') continue;
      let descriptor = null;
      // Keep the RGB preview's existing Identity admission as the same policy.
      if (!['Default', 'Identity'].includes(reader.name(value))) {
        const identity = reader.node(value).id;
        descriptor = functions.get(identity);
        if (!descriptor) {
          if (functions.size >= 256) limit('PDF print function count limit exceeded.');
          descriptor = await readPdfFunction(reader, value);
          if (descriptor.inputs !== 1 || descriptor.outputs !== 1) corrupt('PDF black-generation and undercolor-removal functions require one input and output.');
          const bytes = retainedFunctionBytes(descriptor);
          if (retainedBytes + bytes > 32 * 1024 * 1024) limit('PDF print function byte limit exceeded.');
          functions.set(identity, descriptor); retainedBytes += bytes;
        }
      }
      if (descriptor !== result[property]) result = { ...result, [property]: descriptor };
    }
    return Object.isFrozen(result) ? result : Object.freeze(result);
  };
}

/** Native component conversion; caller charges its one shared paint/pixel work owner. */
export function createPdfCmykConverter(charge = () => {}) {
  if (typeof charge !== 'function') corrupt('Invalid PDF native colour work owner.');
  const functions = new WeakMap();
  const evaluate = (descriptor, values) => {
    if (!descriptor || typeof descriptor !== 'object') corrupt('Invalid PDF native tint function.');
    let run = functions.get(descriptor);
    if (!run) { run = compilePdfFunction(descriptor); functions.set(descriptor, run); }
    const result = run(values);
    if (result.some(value => !Number.isFinite(value))) corrupt('Non-finite PDF native colour function.');
    return result;
  };
  const convert = (space, values, print, depth) => {
    if (depth > 8) limit('PDF native colour nesting limit exceeded.');
    if (!space || !Number.isInteger(space.components) || space.components < 1 || space.components > 4 || !values || values.length !== space.components
      || !Array.isArray(values) && !ArrayBuffer.isView(values) || Array.from(values).some(value => !Number.isFinite(value))) corrupt('Invalid PDF native colour components.');
    const expected = { DeviceCMYK: 4, DeviceGray: 1, DeviceRGB: 3 }[space.name];
    if (expected && expected !== space.components) corrupt('Invalid PDF native colour dimensions.');
    const input = Array.from(values, clamp);
    if (space.name === 'DeviceCMYK' && space.components === 4) return input;
    if (space.name === 'DeviceGray' && space.components === 1) return [0, 0, 0, 1 - input[0]];
    if (space.name === 'DeviceRGB' && space.components === 3) {
      const inks = input.map(value => 1 - value), k = Math.min(...inks);
      for (const property of ['blackGeneration', 'undercolorRemoval']) if (print[property] && (print[property].inputs !== 1 || print[property].outputs !== 1)) corrupt('Invalid PDF native print function dimensions.');
      const black = print.blackGeneration ? evaluate(print.blackGeneration, [k])[0] : k;
      const removal = print.undercolorRemoval ? evaluate(print.undercolorRemoval, [k])[0] : k;
      // ISO32000-1 10.3.4 and11.7.5.3: signed UCR is legal; clip only
      // final ink components and use the state at paint/Do, not selection.
      return [...inks.map(value => clamp(value - removal)), clamp(black)];
    }
    if (space.name === 'Separation' && space.colorant === 'All' && space.components === 1) return Array(4).fill(input[0]);
    if (space.name === 'Separation' || space.name === 'DeviceN') {
      const fn = space.tintTransform;
      if (!space.alternate || fn?.inputs !== space.components || fn.outputs !== space.alternate.components) corrupt('Invalid PDF native alternate colour dimensions.');
      return convert(space.alternate, evaluate(fn, input), print, depth + 1);
    }
    if (space.name === 'Indexed' || space.name === 'I') {
      const { base, high, lookup } = space;
      if (space.components !== 1 || !base || !Number.isInteger(high) || high < 0 || high > 255 || !(lookup instanceof Uint8Array)
        || lookup.length !== (high + 1) * base.components) corrupt('Invalid PDF native indexed colour.');
      const index = Math.max(0, Math.min(high, Math.round(values[0])));
      return convert(base, Array.from(lookup.subarray(index * base.components, (index + 1) * base.components), value => value / 255), print, depth + 1);
    }
    throw new PdfEngineError(`PDF native CMYK conversion from ${space.name} is not implemented yet.`);
  };
  return (space, values, print = PDF_CMYK_PRINT_DEFAULTS) => {
    if (!print || typeof print !== 'object') corrupt('Invalid PDF native print state.');
    for (const property of ['blackGeneration', 'undercolorRemoval']) if (print[property] !== null
      && (!print[property] || typeof print[property] !== 'object')) corrupt('Invalid PDF native print state.');
    charge(); return convert(space, values, print, 0);
  };
}
