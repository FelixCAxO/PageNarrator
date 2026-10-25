// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { WasmOcrCompute } from './wasm-ocr-compute.js';
import { WasmOcrBatch } from './wasm-ocr-operations.js';
import { broadcastShape, broadcastStrides, tensorSize } from './tensor-shape.js';
import { contiguousStrides, axisIndex } from './index-shape.js';
import { convolutionPlan, liftConvolution } from './cnn-shape.js';
import { createKokoroCpuKernels } from './kokoro-cpu-kernels.js';

const TYPE_CODES = Object.freeze({ float32: 1, uint8: 2, int8: 3, int32: 6, bool: 9 });
const bits = value => new Uint32Array(Float32Array.of(value).buffer)[0];

/** Reuse the exact OCR allocation, capture, ownership and disposal implementation. */
export class WasmKokoroCompute extends WasmOcrCompute {
  constructor(exports, maxBytes) {
    super(exports, maxBytes);
    if (typeof exports.pn_kokoro_dynamic_quantize !== 'function') throw new Error('This WASM module lacks the original speech kernels.');
    this.kokoro = createKokoroCpuKernels(this);
  }
  batch(options) { this.checkOpen(); return new WasmKokoroBatch(this, options); }
  createKokoroKernels() { this.checkOpen(); return this.kokoro; }
  upload(data, shape, type = 'float32') {
    if (type === 'bool' && data instanceof Uint32Array) {
      if (data.some(value => value !== 0 && value !== 1)) throw new RangeError('Boolean input must contain only zero or one.');
      data = Uint8Array.from(data);
    }
    return super.upload(data, shape, type);
  }
  write(tensor, data) {
    if (tensor.dataType === 'bool' && data instanceof Uint32Array) {
      if (data.some(value => value !== 0 && value !== 1)) throw new RangeError('Boolean input must contain only zero or one.');
      data = Uint8Array.from(data);
    }
    return super.write(tensor, data);
  }
  invoke(name, tensors, parameters, extra = []) {
    try { return super.invoke(name, tensors, parameters, extra); }
    catch (error) {
      if (error.message === "OCR CPU Pow currently supports only the graph's square exponent." && name.startsWith('pn_kokoro_')) {
        throw new Error(`${name} refused nonfinite, overflowing or invalid operation data.`, { cause: error });
      }
      throw error;
    }
  }
}

export class WasmKokoroBatch extends WasmOcrBatch {
  range(start, limit, delta, dataType = 'int32') {
    this.checkOwnership();
    if (!['float32', 'int32'].includes(dataType) || ![start, limit, delta].every(Number.isFinite) || !delta) throw new RangeError('Invalid CPU Range parameters.');
    const count = Math.max(0, Math.ceil((limit - start) / delta)); tensorSize([count]);
    const last = count ? start + (count - 1) * delta : start;
    let bounds = null;
    if (dataType === 'int32') {
      if (![start, limit, delta, last].every(Number.isSafeInteger) || Math.min(start, last) < -2147483648 || Math.max(start, last) > 2147483647
        || delta < -2147483648 || delta > 2147483647) throw new RangeError('CPU Range exceeds exact int32.');
      bounds = { min: Math.min(start, last), max: Math.max(start, last) };
    } else if (![start, delta, last].every(value => Number.isFinite(Math.fround(value)))) throw new RangeError('CPU Range exceeds finite float32.');
    const output = this.output([count], dataType, bounds);
    this.command('pn_kokoro_range', [output], Uint32Array.of(count, dataType === 'float32' ? bits(start) : start, dataType === 'float32' ? bits(delta) : delta, TYPE_CODES[dataType]));
    return output;
  }
  fill(shape, value, dataType = 'float32') {
    this.checkOwnership();
    if (!Object.hasOwn(TYPE_CODES, dataType) || !Number.isFinite(value)) throw new RangeError('Invalid CPU tensor fill.');
    if (dataType === 'float32' && !Number.isFinite(Math.fround(value))) throw new RangeError('CPU fill exceeds finite float32.');
    if (dataType !== 'float32') {
      const [min, max] = { int32: [-2147483648, 2147483647], uint8: [0, 255], int8: [-128, 127], bool: [0, 1] }[dataType];
      if (!Number.isInteger(value) || value < min || value > max) throw new RangeError('CPU fill value differs from its tensor type.');
    }
    const output = this.output(shape, dataType, dataType === 'float32' ? null : { min: value, max: value });
    this.command('pn_kokoro_fill', [output], Uint32Array.of(output.length, TYPE_CODES[dataType], dataType === 'float32' ? bits(value) : value));
    return output;
  }
  binary(operation, a, b) {
    if (operation === 'Pow') {
      this.check(a, b);
      const shape = broadcastShape(a.shape, b.shape), output = this.output(shape), p = new Uint32Array(32);
      p.set([output.length, shape.length]); p.set(shape, 8); p.set(broadcastStrides(a.shape, shape), 16); p.set(broadcastStrides(b.shape, shape), 24);
      this.command('pn_kokoro_power', [a, b, output], p); return output;
    }
    if (a.dataType === 'float32' && b.dataType === 'float32') return super.binary(operation, a, b);
    this.checkOwnership(a, b);
    const code = { Add: 0, Mul: 1, Div: 2, Sub: 3 }[operation];
    if (a.dataType !== 'int32' || b.dataType !== 'int32' || code === undefined) throw new Error('CPU arithmetic requires matching float32 or int32 operands.');
    const shape = broadcastShape(a.shape, b.shape), output = this.output(shape, 'int32', { min: -2147483648, max: 2147483647 }), p = new Uint32Array(32);
    p.set([output.length, shape.length, code]); p.set(shape, 8); p.set(broadcastStrides(a.shape, shape), 16); p.set(broadcastStrides(b.shape, shape), 24);
    this.command('pn_kokoro_integer_binary', [a, b, output], p); return output;
  }
  gatherTensor(input, indices, axis = 0) {
    this.checkOwnership(input, indices); axis = axisIndex(axis, input.shape.length);
    if (indices.dataType !== 'int32') throw new Error('CPU Gather requires exact int32 indices.');
    const shape = [...input.shape.slice(0, axis), ...indices.shape, ...input.shape.slice(axis + 1)], output = this.output(shape, input.dataType, input.bounds);
    this.command('pn_kokoro_gather', [input, indices, output], Uint32Array.of(output.length, tensorSize(input.shape.slice(axis + 1)), indices.length, input.shape[axis], input.elementBytes));
    return output;
  }
  convolution(input, weight, bias = null, options = {}) {
    const lifted = liftConvolution(input.shape, weight.shape, options);
    if (!lifted.squeeze) return super.convolution(input, weight, bias, options);
    if (options.transpose && input.shape[1] / (options.group ?? 1) > 1) {
      this.check(input, weight, ...(bias ? [bias] : []));
      const plan = convolutionPlan(lifted.input, lifted.weights, lifted.options);
      if (bias && (bias.shape.length !== 1 || bias.length !== plan.shape[1])) throw new RangeError('Speech transposed convolution bias does not match its channels.');
      const output = this.output([plan.shape[0], plan.shape[1], plan.shape[3]]), tile = Math.min(32, input.shape[2]);
      const scratch = this.output([plan.outputChannelsPerGroup * plan.kernel[1] * tile]);
      this.command('pn_kokoro_conv_transpose', [input, weight, bias ?? weight, output, scratch], Uint32Array.of(input.shape[0], input.shape[1], input.shape[2], plan.shape[1], plan.shape[3],
        plan.inputChannelsPerGroup, plan.outputChannelsPerGroup, plan.kernel[1], plan.strides[1], plan.dilations[1], plan.pads[1], Number(Boolean(bias)), Number(Boolean(options.relu)), tile));
      this.recycle(scratch); return output;
    }
    const x = this.view(input, lifted.input), w = this.view(weight, lifted.weights);
    const result = super.convolution(x, w, bias, lifted.options), output = this.view(result, [result.shape[0], result.shape[1], result.shape[3]]);
    this.recycle(x); this.recycle(w); this.recycle(result); return output;
  }
  resize(input, options) {
    if (input.shape.length !== 3) return super.resize(input, options);
    const view = this.view(input, [input.shape[0], input.shape[1], 1, input.shape[2]]);
    const result = super.resize(view, { ...options, scales: options.scales?.length ? [options.scales[0], options.scales[1], 1, options.scales[2]] : null,
      sizes: options.sizes?.length ? [options.sizes[0], options.sizes[1], 1, options.sizes[2]] : null });
    const output = this.view(result, [result.shape[0], result.shape[1], result.shape[3]]);
    this.recycle(view); this.recycle(result); return output;
  }
  unary(operation, input, options = {}) {
    if (['Round', 'Floor', 'Atan', 'LeakyRelu', 'Clip', 'Sin', 'Cos'].includes(operation)) return this.engine.kokoro.unary(this, input, operation, options);
    return super.unary(operation, input, options);
  }
  cast(input, target) {
    this.checkOwnership(input);
    const type = target === 7 ? 'int32' : Object.keys(TYPE_CODES).find(key => TYPE_CODES[key] === target);
    if (!type) throw new Error('Unsupported CPU Cast target.');
    const output = this.output(input.shape, type, input.dataType === type ? input.bounds : type === 'bool' ? { min: 0, max: 1 } : null);
    this.command('pn_kokoro_cast', [input, output], Uint32Array.of(input.length, TYPE_CODES[input.dataType], TYPE_CODES[type]));
    return output;
  }
  compare(operation, a, b) {
    this.checkOwnership(a, b);
    const code = { Equal: 0, Less: 1, Greater: 2, GreaterOrEqual: 3, LessOrEqual: 4, And: 5 }[operation];
    if (code === undefined || a.dataType !== b.dataType || (operation === 'And' && a.dataType !== 'bool')) throw new Error('CPU comparison requires matching operand types.');
    const shape = broadcastShape(a.shape, b.shape), output = this.output(shape, 'bool', { min: 0, max: 1 }), p = new Uint32Array(32);
    p.set([output.length, shape.length, code, TYPE_CODES[a.dataType]]); p.set(shape, 8); p.set(broadcastStrides(a.shape, shape), 16); p.set(broadcastStrides(b.shape, shape), 24);
    this.command('pn_kokoro_compare', [a, b, output], p); return output;
  }
  equal(a, b) { return this.compare('Equal', a, b); }
  where(condition, yes, no) {
    this.checkOwnership(condition, yes, no);
    if (condition.dataType !== 'bool' || yes.dataType !== no.dataType) throw new Error('CPU Where requires bool condition and matching alternatives.');
    const shape = broadcastShape(condition.shape, broadcastShape(yes.shape, no.shape)), output = this.output(shape, yes.dataType), p = new Uint32Array(40);
    p.set([output.length, shape.length, yes.elementBytes]); p.set(shape, 8);
    p.set(broadcastStrides(condition.shape, shape), 16); p.set(broadcastStrides(yes.shape, shape), 24); p.set(broadcastStrides(no.shape, shape), 32);
    this.command('pn_kokoro_where', [condition, yes, no, output], p); return output;
  }
  expand(input, shape) {
    this.checkOwnership(input);
    const output = broadcastShape(input.shape, shape);
    return this.index(input, { shape: output, strides: broadcastStrides(input.shape, output), offset: 0 });
  }
  pad(input, pads, mode = 'constant', value = 0) {
    this.check(input);
    const rank = input.shape.length, code = { constant: 0, edge: 1, reflect: 2 }[mode];
    if (code === undefined || !rank || rank > 8 || pads.length !== rank * 2 || pads.some(p => !Number.isSafeInteger(p) || p < 0)
      || !Number.isFinite(value) || (mode === 'reflect' && pads.some((p, i) => p >= input.shape[i % rank]))) throw new RangeError('Invalid CPU padding or reflection extent.');
    if (mode !== 'constant' && input.shape.some(dim => dim === 0)) throw new RangeError('CPU edge/reflection padding needs nonempty axes.');
    const shape = input.shape.map((dim, axis) => dim + pads[axis] + pads[axis + rank]), output = this.output(shape), p = new Uint32Array(40);
    p.set([output.length, rank, code, bits(value)]); p.set(shape, 8); p.set(pads.slice(0, rank), 16); p.set(input.shape, 24); p.set(contiguousStrides(input.shape), 32);
    this.command('pn_kokoro_pad', [input, output], p); return output;
  }
  snake(input, alpha, scale) {
    this.check(input, alpha, scale);
    const shape = broadcastShape(input.shape, broadcastShape(alpha.shape, scale.shape)), output = this.output(shape), p = new Uint32Array(40);
    p.set([output.length, shape.length]); p.set(shape, 8); p.set(broadcastStrides(input.shape, shape), 16);
    p.set(broadcastStrides(alpha.shape, shape), 24); p.set(broadcastStrides(scale.shape, shape), 32);
    this.command('pn_kokoro_snake', [input, alpha, scale, output], p);
    return output;
  }
}
