// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { matrixShape, tensorSize } from './tensor-shape.js';

export const UNARY_OPERATIONS = Object.freeze({ Identity: 0, Relu: 1, Sigmoid: 2, Tanh: 3, Erf: 4,
  Sqrt: 5, Exp: 6, Neg: 7, Reciprocal: 8, HardSigmoid: 9 });
export const BINARY_OPERATIONS = Object.freeze({ Add: 0, Mul: 1, Div: 2, Sub: 3 });

export class NativeCompute {
  static async create(bytes) {
    const { instance } = await WebAssembly.instantiate(bytes);
    if (instance.exports.pn_abi_version() !== 1) throw new Error('Unsupported first-party engine ABI.');
    return new NativeCompute(instance.exports);
  }

  constructor(exports) { this.exports = exports; this.base = Number(exports.__heap_base.value); }

  workspace(arrays, outputLength) {
    if (!Number.isSafeInteger(outputLength) || outputLength < 0) throw new RangeError('Invalid output length.');
    let cursor = Math.ceil(this.base / 16) * 16;
    const pointers = arrays.map(array => {
      if (!(array instanceof Float32Array)) throw new TypeError('CPU tensors must contain Float32Array data.');
      const pointer = cursor; cursor += Math.ceil(array.byteLength / 16) * 16; return pointer;
    });
    const output = cursor;
    cursor += outputLength * 4;
    if (!Number.isSafeInteger(cursor) || cursor > 512 * 1024 * 1024) throw new RangeError('CPU workspace exceeds its 512 MiB limit.');
    const memory = this.exports.memory;
    if (cursor > memory.buffer.byteLength) memory.grow(Math.ceil((cursor - memory.buffer.byteLength) / 65536));
    arrays.forEach((array, i) => new Float32Array(memory.buffer, pointers[i], array.length).set(array));
    return { pointers, output, read: () => new Float32Array(memory.buffer, output, outputLength).slice() };
  }

  matmul(a, aShape, b, bShape) {
    const shape = matrixShape(aShape, bShape);
    if (a.length !== tensorSize(aShape) || b.length !== tensorSize(bShape)) throw new RangeError('Matrix data does not match its shape.');
    const w = this.workspace([a, b], tensorSize(shape));
    this.exports.pn_matmul(...w.pointers, w.output, shape[0], shape[1], aShape[1]);
    return { data: w.read(), shape };
  }

  unary(operation, data, { alpha = 0.2, beta = 0.5 } = {}) {
    if (!Object.hasOwn(UNARY_OPERATIONS, operation)) throw new Error(`Unsupported CPU operation ${operation}.`);
    const w = this.workspace([data], data.length);
    this.exports.pn_unary(w.pointers[0], w.output, data.length, UNARY_OPERATIONS[operation], alpha, beta);
    return w.read();
  }

  binary(operation, a, b) {
    if (!Object.hasOwn(BINARY_OPERATIONS, operation)) throw new Error(`Unsupported CPU operation ${operation}.`);
    if (a.length !== b.length) throw new RangeError('CPU elementwise tensors must have equal lengths.');
    const w = this.workspace([a, b], a.length);
    this.exports.pn_binary(...w.pointers, w.output, a.length, BINARY_OPERATIONS[operation]);
    return w.read();
  }
}
