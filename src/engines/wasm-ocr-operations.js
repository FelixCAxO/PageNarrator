// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { broadcastShape, broadcastStrides, tensorSize } from './tensor-shape.js';
import { axisIndex, batchedMatmulPlan } from './index-shape.js';
import { concatPlan, convolutionPlan, poolingPlan, reductionPlan, resizePlan } from './cnn-shape.js';
import { UNARY_OPERATIONS, BINARY_OPERATIONS } from './native-compute.js';

const bits = value => new Uint32Array(Float32Array.of(value).buffer)[0];

/** Captured native commands replay over arena offsets, without copying intermediate tensors. */
export class WasmOcrBatch {
  constructor(engine, { capture = false } = {}) {
    this.engine = engine; this.capture = capture;
    this.outputs = new Set(); this.bufferPool = new Map(); this.parameters = [];
    this.commands = []; this.submitted = false;
    this.allocationCount = this.allocatedBytes = this.reuseCount = 0;
  }

  checkOwnership(...tensors) {
    this.engine.checkOpen();
    if (this.submitted) throw new Error('OCR command batch was already submitted.');
    for (const tensor of tensors) {
      this.engine.checkTensor(tensor);
      if (tensor.batch && tensor.batch !== this && !tensor.batch.submitted) throw new Error('OCR input has an unsubmitted batch.');
    }
  }
  check(...tensors) {
    this.checkOwnership(...tensors);
    if (tensors.some(tensor => tensor.dataType !== 'float32')) throw new Error('OCR math requires float32 tensors.');
  }

  output(shape, dataType = 'float32', bounds = null) {
    const bytes = Math.max(16, Math.ceil(tensorSize(shape) * this.engine.storageWidth(dataType) / 16) * 16);
    let selected = Infinity;
    for (const [size, buffers] of this.bufferPool) if (buffers.length && size >= bytes && size <= bytes * 2 && size < selected) selected = size;
    const buffer = this.bufferPool.get(selected)?.pop();
    if (buffer) this.reuseCount++;
    else { this.allocationCount++; this.allocatedBytes += bytes; }
    const tensor = this.engine.tensor(shape, this, buffer, dataType, bounds); this.outputs.add(tensor); return tensor;
  }

  recycle(tensor) {
    this.checkOwnership(tensor);
    if (tensor.batch !== this) throw new Error('Only this OCR batch can recycle an intermediate.');
    this.outputs.delete(tensor);
    if (this.engine.forgetTensor(tensor)) return;
    const buffers = this.bufferPool.get(tensor.buffer.size) ?? [];
    buffers.push(tensor.buffer); this.bufferPool.set(tensor.buffer.size, buffers);
  }
  scratchBuffers() { return [...this.bufferPool.values()].flat(); }
  retireScratch() {
    if (!this.submitted) throw new Error('Submit an OCR batch before retiring its scratch storage.');
    const buffers = [...this.scratchBuffers(), ...this.parameters];
    this.bufferPool.clear(); this.parameters.length = 0; this.capture = false; this.commands.length = 0;
    return buffers;
  }
  command(name, tensors, parameters) { this.commands.push(() => this.engine.invoke(name, tensors, parameters)); }

  convolution(input, weights, bias = null, options = {}) {
    this.check(input, weights, ...(bias ? [bias] : []));
    const plan = convolutionPlan(input.shape, weights.shape, options);
    if (bias && (bias.shape.length !== 1 || bias.length !== plan.shape[1])) throw new RangeError('OCR convolution bias must match its channels.');
    const output = this.output(plan.shape);
    const tile = !plan.transpose && plan.inputChannelsPerGroup > 1 && plan.kernel.some(dim => dim > 1) ? Math.min(128, plan.shape[2] * plan.shape[3]) : 0;
    const scratch = tile ? this.output([plan.inputChannelsPerGroup * plan.kernel[0] * plan.kernel[1], tile]) : weights;
    this.command('pn_ocr_conv', [input, weights, bias ?? weights, output, scratch], Uint32Array.of(...input.shape, ...plan.shape.slice(1),
      plan.inputChannelsPerGroup, plan.outputChannelsPerGroup, ...plan.kernel, ...plan.strides, ...plan.dilations,
      ...plan.pads.slice(0, 2), Number(Boolean(bias)), Number(Boolean(options.relu)), Number(plan.transpose), tile));
    if (tile) this.recycle(scratch);
    return output;
  }

  reduce(input, axes = null, keepDims = true, mode = 'mean') {
    this.check(input);
    if (!['mean', 'max', 'sum'].includes(mode)) throw new Error('Unknown OCR reduction mode.');
    const plan = reductionPlan(input.shape, axes, keepDims);
    if (!plan.reductionSize) throw new RangeError('OCR reduction over an empty dimension is unsupported.');
    const output = this.output(plan.shape), p = new Uint32Array(16);
    const first = input.shape.findIndex((_, axis) => plan.mask & (1 << axis));
    const trailing = plan.mask === ((1 << input.shape.length) - 1) - ((1 << first) - 1);
    p.set([output.length, plan.reductionSize, input.shape.length, plan.mask, ['mean', 'max', 'sum'].indexOf(mode), Number(trailing)]); p.set(input.shape, 8);
    this.command('pn_ocr_reduce', [input, output], p); return output;
  }

  pool(input, options) {
    this.check(input);
    const plan = poolingPlan(input.shape, options), output = this.output(plan.shape);
    this.command('pn_ocr_pool', [input, output], Uint32Array.of(output.length, ...input.shape.slice(2), ...plan.shape.slice(2),
      ...plan.kernel, ...plan.strides, ...plan.dilations, ...plan.pads.slice(0, 2), Number(Boolean(options.average)),
      Number(Boolean(options.countIncludePad)), ...plan.pads.slice(2)));
    return output;
  }

  resize(input, options) {
    this.check(input);
    const plan = resizePlan(input.shape, options), output = this.output(plan.shape);
    this.command('pn_ocr_resize', [input, output], Uint32Array.of(output.length, ...input.shape.slice(2), ...plan.shape.slice(2),
      ...plan.scales.map(bits), plan.mode, plan.coordinateMode, plan.nearestMode));
    return output;
  }

  concat(inputs, axis) {
    this.checkOwnership(...inputs);
    if (!inputs.length || inputs.some(input => input.dataType !== inputs[0].dataType)) throw new Error('CPU Concat cannot mix tensor types.');
    const plan = concatPlan(inputs.map(input => input.shape), axis), output = this.output(plan.shape, inputs[0].dataType);
    let offset = 0;
    for (const input of inputs) {
      this.command('pn_ocr_concat', [input, output], Uint32Array.of(input.length, input.shape[plan.axis], plan.innerSize, plan.shape[plan.axis], offset, input.elementBytes));
      offset += input.shape[plan.axis];
    }
    return output;
  }

  copy(input, shape = input.shape) {
    this.checkOwnership(input);
    if (tensorSize(shape) !== input.length) throw new RangeError('OCR copy changes its element count.');
    const output = this.output(shape, input.dataType, input.bounds);
    this.commands.push(() => this.engine.exports.pn_ocr_copy(input.buffer.offset, output.buffer.offset, input.length * input.elementBytes)); return output;
  }
  view(input, shape) {
    this.checkOwnership(input);
    if (tensorSize(shape) !== input.length) throw new RangeError('OCR view changes its element count.');
    const tensor = this.engine.tensor(shape, this, input.buffer, input.dataType, input.bounds); this.outputs.add(tensor); return tensor;
  }
  index(input, { shape, strides, offset }) {
    this.checkOwnership(input);
    const output = this.output(shape, input.dataType, input.bounds), p = new Uint32Array(24);
    p.set([output.length, shape.length, offset, input.elementBytes]); p.set(shape, 8); p.set(strides, 16);
    this.command('pn_ocr_index', [input, output], p); return output;
  }
  gather(input, indices, indexShape, axis = 0) {
    this.checkOwnership(input); axis = axisIndex(axis, input.shape.length);
    if (!Array.isArray(indices) || indices.length !== tensorSize(indexShape) || indices.length > 1024
      || indices.some(i => !Number.isSafeInteger(i) || i < -input.shape[axis] || i >= input.shape[axis])) throw new RangeError('OCR Gather requires bounded constant indices.');
    const output = this.output([...input.shape.slice(0, axis), ...indexShape, ...input.shape.slice(axis + 1)], input.dataType, input.bounds), p = new Uint32Array(8 + indices.length);
    p.set([output.length, tensorSize(input.shape.slice(axis + 1)), indices.length, input.shape[axis], input.elementBytes]);
    p.set(indices.map(i => i < 0 ? i + input.shape[axis] : i), 8);
    this.command('pn_ocr_gather', [input, output], p); return output;
  }

  batchNorm(input, scale, bias, mean, variance, epsilon = 1e-5) {
    this.check(input, scale, bias, mean, variance);
    if (input.shape.length < 2 || [scale, bias, mean, variance].some(t => t.shape.length !== 1 || t.length !== input.shape[1])
      || !Number.isFinite(epsilon) || epsilon < 0) throw new RangeError('Invalid OCR batch normalization parameters.');
    const output = this.output(input.shape);
    this.command('pn_ocr_norm', [input, scale, bias, mean, variance, output], Uint32Array.of(output.length, input.shape[1], tensorSize(input.shape.slice(2)), bits(epsilon)));
    return output;
  }
  softmax(input, axis = -1) {
    this.check(input); axis = axisIndex(axis, input.shape.length);
    if (axis !== input.shape.length - 1 || !input.shape[axis]) throw new RangeError('OCR Softmax requires a nonempty final axis.');
    const output = this.output(input.shape);
    this.command('pn_ocr_softmax', [input, output], Uint32Array.of(input.length / input.shape[axis], input.shape[axis])); return output;
  }
  argmax(input, axis = 0, keepDims = true, selectLastIndex = false) {
    this.check(input); axis = axisIndex(axis, input.shape.length);
    if (!input.shape[axis]) throw new RangeError('OCR ArgMax requires a nonempty axis.');
    const output = this.output(input.shape.flatMap((dim, i) => i === axis ? keepDims ? [1] : [] : [dim]), 'int32', { min: 0, max: input.shape[axis] - 1 });
    this.command('pn_ocr_argmax', [input, output], Uint32Array.of(output.length, input.shape[axis], tensorSize(input.shape.slice(axis + 1)), Number(selectLastIndex))); return output;
  }
  matmul(a, b) {
    this.check(a, b);
    const plan = batchedMatmulPlan(a.shape, b.shape), output = this.output(plan.shape), p = new Uint32Array(32);
    p.set([a.shape.at(-2), b.shape.at(-1), a.shape.at(-1), plan.batch.length, tensorSize(plan.batch)]);
    p.set(plan.batch, 8); p.set(plan.aStrides, 16); p.set(plan.bStrides, 24);
    this.command('pn_ocr_matmul', [a, b, output], p); return output;
  }
  unary(operation, input, { alpha = 0.2, beta = 0.5 } = {}) {
    this.check(input);
    if (!Object.hasOwn(UNARY_OPERATIONS, operation)) throw new Error(`Unsupported OCR CPU unary operation ${operation}.`);
    if (!Number.isFinite(alpha) || !Number.isFinite(beta)) throw new RangeError('OCR activation parameters must be finite.');
    const output = this.output(input.shape);
    this.commands.push(() => this.engine.exports.pn_ocr_unary(input.buffer.offset, output.buffer.offset, input.length, UNARY_OPERATIONS[operation], alpha, beta)); return output;
  }
  binary(operation, a, b) {
    this.check(a, b);
    const opcode = operation === 'Pow' ? 4 : BINARY_OPERATIONS[operation];
    if (opcode === undefined) throw new Error(`Unsupported OCR CPU binary operation ${operation}.`);
    const shape = broadcastShape(a.shape, b.shape), output = this.output(shape), p = new Uint32Array(32);
    p.set([output.length, shape.length, opcode, a.length === output.length ? 1 : a.length === 1 ? 2 : 0,
      b.length === output.length ? 1 : b.length === 1 ? 2 : 0]); p.set(shape, 8);
    p.set(broadcastStrides(a.shape, shape), 16); p.set(broadcastStrides(b.shape, shape), 24);
    this.command('pn_ocr_binary', [a, b, output], p); return output;
  }

  submit() { this.checkOwnership(); this.submitted = true; for (const execute of this.commands) execute(); if (!this.capture) this.commands.length = 0; }
  replay() { this.engine.checkOpen(); if (!this.submitted || !this.capture) throw new Error('OCR batch has no captured execution plan.'); for (const execute of this.commands) execute(); }
  cancel() { this.submitted = true; this.commands.length = 0; }
}
