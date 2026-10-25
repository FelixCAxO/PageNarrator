// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { decodePdfStream } from './streams.js';
import { parsePdfCalculator, compilePdfCalculator } from './calculator-function.js';

const corrupt = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const MAX_FUNCTION_VISITS = 16384, MAX_FUNCTION_NODES = 4096, MAX_FUNCTION_SAMPLES = 4_000_000, MAX_CALCULATOR_BYTES = 1024 * 1024;
const functionBudget = () => ({ visits: 0, nodes: 0, samples: 0, calculatorBytes: 0 });
const limit = message => { throw new PdfEngineError(`PDF function ${message} limit exceeded.`, 'pdf_limit'); };
function sampleBudget(budget, count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_FUNCTION_SAMPLES || (budget.samples += count) > MAX_FUNCTION_SAMPLES) limit('sample budget');
}
function calculatorBudget(budget, bytes) {
  if ((budget.calculatorBytes += bytes) > MAX_CALCULATOR_BYTES) limit('calculator byte budget');
}
function pairs(values, name) {
  if (!values?.length || values.length % 2 || values.some(value => !Number.isFinite(value))
    || values.some((value, i) => i % 2 && value < values[i - 1])) corrupt(`Invalid PDF function ${name}.`);
  return values;
}

/** Original ISO 32000-1 7.10 function grammar; no host-language execution. */
export async function readPdfFunction(reader, value, { depth = 0, path = new Set() } = {}) {
  return (await readFunction(reader, value, depth, path, new Map(), functionBudget())).descriptor;
}

async function readFunction(reader, value, depth, path, memo, budget) {
  if (depth > 16) limit('nesting');
  if (++budget.visits > MAX_FUNCTION_VISITS) limit('visit budget');
  const node = reader.node(value); if (path.has(node.id)) corrupt('Cyclic PDF function.');
  const cached = memo.get(node.id);
  if (cached) {
    if (depth + cached.height > 16) limit('nesting');
    return cached;
  }
  if (++budget.nodes > MAX_FUNCTION_NODES) limit('node budget');
  const nextPath = new Set(path); nextPath.add(node.id);
  let height = 0;
  const number = (key, fallback = NaN) => reader.number(reader.field(value, key), fallback);
  const array = (key, fallback = null) => { const id = reader.field(value, key); return id ? reader.array(id).map(id => reader.number(id, NaN)) : fallback; };
  const type = number('FunctionType'), domain = pairs(array('Domain'), 'domain'), range = array('Range');
  if (range) pairs(range, 'range');
  const inputs = domain.length / 2;
  if (inputs > 4 || range?.length > 64) throw new PdfEngineError('PDF function dimensional limit exceeded.', 'pdf_limit');
  let descriptor;
  if (type === 0) {
    if (node.kind !== 'stream' || !range) corrupt('A sampled PDF function requires a stream and Range.');
    const size = array('Size'), bits = number('BitsPerSample'), order = number('Order', 1), outputs = range.length / 2;
    if (order !== 1) throw new PdfEngineError('Cubic sampled PDF function interpolation is not implemented yet.');
    if (!size || size.length !== inputs || size.some(n => !Number.isSafeInteger(n) || n < 1) || ![1, 2, 4, 8, 12, 16, 24, 32].includes(bits)) corrupt('Invalid PDF sampled function dimensions.');
    const count = size.reduce((product, n) => product * n, outputs);
    sampleBudget(budget, count);
    const encode = array('Encode', size.flatMap(n => [0, n - 1])), decode = array('Decode', range);
    if (encode.length !== inputs * 2 || decode.length !== outputs * 2 || [...encode, ...decode].some(n => !Number.isFinite(n))) corrupt('Invalid PDF function sample mapping.');
    const samples = (await decodePdfStream(reader, value)).bytes;
    if (samples.length !== Math.ceil(count * bits / 8)) corrupt('PDF sampled function byte count disagrees with Size.');
    descriptor = { type, domain, range, inputs, outputs, size, bits, encode, decode, samples };
  } else if (type === 2) {
    const c0 = array('C0', [0]), c1 = array('C1', [1]), exponent = number('N');
    if (inputs !== 1 || !c0.length || c0.length > 32 || c0.length !== c1.length || [...c0, ...c1, exponent].some(n => !Number.isFinite(n))) corrupt('Invalid PDF exponential function.');
    descriptor = { type, domain, range, inputs, outputs: c0.length, c0, c1, exponent };
  } else if (type === 3) {
    const ids = reader.field(value, 'Functions'), functions = [];
    if (inputs !== 1 || !ids) corrupt('Invalid PDF stitching function.');
    const children = reader.array(ids);
    if (!children.length || children.length > 256) throw new PdfEngineError('PDF stitching function child budget exceeded.', 'pdf_limit');
    for (const id of children) {
      const child = await readFunction(reader, id, depth + 1, nextPath, memo, budget);
      functions.push(child.descriptor); height = Math.max(height, child.height + 1);
    }
    const bounds = array('Bounds', []), encode = array('Encode'), outputs = functions[0].outputs;
    if (functions.some(fn => fn.inputs !== 1 || fn.outputs !== outputs) || bounds.length !== functions.length - 1 || !encode || encode.length !== functions.length * 2
      || functions.length > 1 && domain[0] === domain[1] || [...bounds, ...encode].some(n => !Number.isFinite(n))
      || bounds.some((n, i) => n < domain[0] || n > domain[1] || i > 0 && n <= bounds[i - 1])) corrupt('Invalid PDF stitching function boundaries.');
    descriptor = { type, domain, range, inputs, outputs, bounds, encode, functions };
  } else if (type === 4) {
    if (node.kind !== 'stream' || !range) corrupt('A calculator PDF function requires a stream and Range.');
    const program = new TextDecoder('latin1').decode((await decodePdfStream(reader, value)).bytes);
    calculatorBudget(budget, program.length);
    parsePdfCalculator(program);
    descriptor = { type, domain, range, inputs, outputs: range.length / 2, program };
  } else throw new PdfEngineError(`PDF function type ${type} is not implemented yet.`);
  if (range && range.length !== descriptor.outputs * 2) corrupt('PDF function Range output count disagrees.');
  const entry = { descriptor, height }; memo.set(node.id, entry);
  return entry;
}

export function compilePdfFunction(descriptor) {
  return compileFunction(descriptor, 0, new Set(), new WeakMap(), functionBudget()).run;
}

function compileFunction(descriptor, depth, path, memo, budget) {
  if (depth > 16) limit('nesting');
  if (++budget.visits > MAX_FUNCTION_VISITS) limit('visit budget');
  if (path.has(descriptor)) corrupt('Cyclic PDF function.');
  const cached = memo.get(descriptor);
  if (cached) {
    if (depth + cached.height > 16) limit('nesting');
    return cached;
  }
  if (++budget.nodes > MAX_FUNCTION_NODES) limit('node budget');
  const nextPath = new Set(path); nextPath.add(descriptor);
  let height = 0;
  const { type, domain, range, inputs, outputs } = descriptor;
  let evaluate;
  if (type === 0) {
    const { size, bits, encode, decode, samples } = descriptor, maximum = 2 ** bits - 1;
    const count = size.reduce((product, n) => product * n, outputs);
    sampleBudget(budget, count);
    const values = new Uint32Array(count), stride = [outputs];
    for (let i = 1; i < size.length; i++) stride[i] = stride[i - 1] * size[i - 1];
    let bit = 0;
    for (let i = 0; i < count; i++) {
      let value = 0;
      for (let left = bits; left > 0;) { const n = Math.min(left, 8 - bit % 8), shift = 8 - bit % 8 - n; value = value * 2 ** n + (samples[bit >> 3] >> shift & 2 ** n - 1); bit += n; left -= n; }
      values[i] = value;
    }
    if (inputs === 1) evaluate = (source, result) => {
      const low = domain[0], high = domain[1], value = clamp(source[0], low, high);
      const encoded = clamp(encode[0] + (high === low ? 0 : (value - low) / (high - low)) * (encode[1] - encode[0]), 0, size[0] - 1);
      const position = Math.floor(encoded), fraction = encoded - position, lower = position * outputs, upper = lower + (position < size[0] - 1 ? outputs : 0);
      result.fill(0, 0, outputs);
      // Keep the generic corner accumulation/Decode order exactly; no gradient approximation.
      for (let channel = 0; channel < outputs; channel++) result[channel] += values[lower + channel] * (1 - fraction);
      for (let channel = 0; channel < outputs; channel++) result[channel] += values[upper + channel] * fraction;
      for (let channel = 0; channel < outputs; channel++) result[channel] = decode[channel * 2] + result[channel] / maximum * (decode[channel * 2 + 1] - decode[channel * 2]);
    };
    else {
    const positions = new Array(inputs), fractions = new Array(inputs);
    evaluate = (source, result) => {
      let base = 0;
      for (let i = 0; i < inputs; i++) {
        const value = clamp(source[i], domain[i * 2], domain[i * 2 + 1]), low = domain[i * 2], high = domain[i * 2 + 1];
        const encoded = clamp(encode[i * 2] + (high === low ? 0 : (value - low) / (high - low)) * (encode[i * 2 + 1] - encode[i * 2]), 0, size[i] - 1);
        positions[i] = Math.floor(encoded); fractions[i] = encoded - positions[i]; base += positions[i] * stride[i];
      }
      result.fill(0, 0, outputs);
      for (let corner = 0; corner < 1 << inputs; corner++) {
        let index = base, weight = 1;
        for (let i = 0; i < inputs; i++) { const upper = corner >> i & 1; weight *= upper ? fractions[i] : 1 - fractions[i]; if (upper && positions[i] < size[i] - 1) index += stride[i]; }
        for (let channel = 0; channel < outputs; channel++) result[channel] += values[index + channel] * weight;
      }
      for (let i = 0; i < outputs; i++) result[i] = decode[i * 2] + result[i] / maximum * (decode[i * 2 + 1] - decode[i * 2]);
    };
    }
  } else if (type === 2) evaluate = (source, result) => {
    const power = clamp(source[0], domain[0], domain[1]) ** descriptor.exponent;
    if (!Number.isFinite(power)) corrupt('PDF exponential function is undefined in its domain.');
    for (let i = 0; i < outputs; i++) result[i] = descriptor.c0[i] + power * (descriptor.c1[i] - descriptor.c0[i]);
  };
  else if (type === 3) {
    if (!descriptor.functions.length || descriptor.functions.length > 256) limit('stitching function child budget');
    const functions = descriptor.functions.map(child => {
      const compiled = compileFunction(child, depth + 1, nextPath, memo, budget);
      height = Math.max(height, compiled.height + 1); return compiled.run;
    }), childInput = [0];
    evaluate = (source, result) => {
      const value = clamp(source[0], domain[0], domain[1]); let index = 0;
      // ISO 32000-2 7.10.4 clarifies the first singleton endpoint interval.
      if (value !== domain[0] || descriptor.bounds[0] !== domain[0]) while (index < descriptor.bounds.length && value >= descriptor.bounds[index]) index++;
      const low = index ? descriptor.bounds[index - 1] : domain[0], high = index === descriptor.bounds.length ? domain[1] : descriptor.bounds[index];
      childInput[0] = descriptor.encode[index * 2] + (high === low ? 0 : (value - low) / (high - low)) * (descriptor.encode[index * 2 + 1] - descriptor.encode[index * 2]);
      functions[index](childInput, result);
    };
  } else if (type === 4) {
    const program = descriptor.program; calculatorBudget(budget, program?.length ?? 0);
    evaluate = compilePdfCalculator(program, domain, outputs);
  }
  else throw new PdfEngineError(`PDF function type ${type} is not implemented yet.`);
  const run = (source, result = new Array(outputs)) => {
    if (!source || source.length !== inputs || !Array.isArray(source) && !ArrayBuffer.isView(source)) corrupt('Invalid PDF function inputs.');
    for (let i = 0; i < inputs; i++) if (!Number.isFinite(source[i])) corrupt('Invalid PDF function inputs.');
    evaluate(source, result);
    if (range) for (let i = 0; i < outputs; i++) result[i] = clamp(result[i], range[i * 2], range[i * 2 + 1]);
    return result;
  };
  const entry = { run: Object.assign(run, { inputs, outputs }), height }; memo.set(descriptor, entry);
  return entry;
}
