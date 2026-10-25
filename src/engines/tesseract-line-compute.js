// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { WasmOcrCompute } from './wasm-ocr-compute.js';
import { WasmOcrBatch } from './wasm-ocr-operations.js';

export class WasmTesseractCompute extends WasmOcrCompute {
  constructor(exports, maximum) {
    super(exports, maximum);
    if (typeof exports.pn_tess_lstm !== 'function') throw new Error('Original English LSTM kernels are missing.');
    // Mathematical lookup data generated independently from the activation formulas.
    this.tanhTable = this.upload(Float32Array.from({ length: 4096 }, (_, i) => Math.tanh(i / 256)), [4096]);
    this.logisticTable = this.upload(Float32Array.from({ length: 4096 }, (_, i) => 1 / (1 + Math.exp(-i / 256))), [4096]);
    exports.pn_tess_tables(this.tanhTable.buffer.offset, this.logisticTable.buffer.offset);
  }
  batch(options) { this.checkOpen(); return new TesseractLineBatch(this, options); }
  invoke(name, tensors, parameters, extra = []) {
    try { return super.invoke(name, tensors, parameters, extra); }
    catch (error) {
      if (name.startsWith('pn_tess_') && error.message.includes('Pow')) throw new Error('Original English LSTM refused invalid operator dimensions.', { cause: error });
      throw error;
    }
  }
}

class TesseractLineBatch extends WasmOcrBatch {
  byteInput(input) {
    this.checkOwnership(input);
    if (input.dataType !== 'int8' || input.shape.length !== 3 || !input.shape[0] || !input.shape[1]) throw new Error('English LSTM requires a nonempty int8 image tensor.');
  }
  convTanh(input, weights, scales) {
    this.byteInput(input); this.checkOwnership(weights, scales);
    if (input.shape[2] !== 1 || weights.dataType !== 'int8' || weights.length !== 160 || scales.dataType !== 'float32' || scales.length !== 16) throw new Error('Invalid English convolution data.');
    const output = this.output([input.shape[0], input.shape[1], 16], 'int8');
    this.command('pn_tess_conv', [input, weights, scales, output], Uint32Array.of(...input.shape.slice(0, 2))); return output;
  }
  bytePool(input) {
    this.byteInput(input);
    const output = this.output([Math.floor(input.shape[0] / 3), Math.floor(input.shape[1] / 3), input.shape[2]], 'int8');
    this.command('pn_tess_pool', [input, output], Uint32Array.from(input.shape)); return output;
  }
  recurrent(input, weights, scales, hidden, { vertical = false, reverse = false, summary = false } = {}) {
    this.byteInput(input); this.checkOwnership(weights, scales);
    const channels = input.shape[2], matrix = hidden * (channels + hidden + 1);
    if (!Number.isInteger(hidden) || hidden < 1 || hidden > 512 || channels > 512 || (summary && !vertical)
      || weights.dataType !== 'int8' || weights.length !== matrix * 4 || scales.dataType !== 'float32' || scales.length !== hidden * 4) throw new Error('Invalid English recurrent data.');
    const shape = [...input.shape.slice(0, 2), hidden];
    if (summary) shape[0] = 1;
    const output = this.output(shape, 'int8'), scratch = this.output([hidden * 6 + Math.ceil((channels + hidden) / 4)]);
    this.command('pn_tess_lstm', [input, weights, scales, output, scratch], Uint32Array.of(...input.shape.slice(0, 2), channels, hidden, Number(vertical), Number(reverse), Number(summary)));
    this.recycle(scratch); return output;
  }
  affine(input, weights, scales, classes) {
    this.byteInput(input); this.checkOwnership(weights, scales);
    const channels = input.shape[2], steps = input.shape[0] * input.shape[1];
    if (weights.dataType !== 'int8' || weights.length !== classes * (channels + 1) || scales.dataType !== 'float32' || scales.length !== classes) throw new Error('Invalid English output data.');
    const output = this.output([steps, classes]);
    this.command('pn_tess_affine', [input, weights, scales, output], Uint32Array.of(steps, channels, classes)); return output;
  }
}
