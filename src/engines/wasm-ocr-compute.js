// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { tensorSize } from './tensor-shape.js';
import { integerRange } from './bounded-integers.js';
import { WasmOcrBatch } from './wasm-ocr-operations.js';

const PAGE_BYTES = 65536;
const MAX_BYTES = 512 * 1024 * 1024;
const PARAMETER_BYTES = 8192;
const ARRAYS = Object.freeze({ float32: Float32Array, int32: Int32Array, int8: Int8Array, uint8: Uint8Array, bool: Uint8Array });

/** The two OCR graphs share this native arena; only feeds and final results cross JS. */
export class WasmOcrCompute {
  static async create(bytes, { maxBytes = MAX_BYTES } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < PAGE_BYTES * 2 || maxBytes > MAX_BYTES || maxBytes % PAGE_BYTES) {
      throw new RangeError('OCR arena must be page-aligned, between 128 KiB and 512 MiB.');
    }
    const module = await WebAssembly.compile(bytes);
    if (WebAssembly.Module.imports(module).length) throw new Error('OCR engine cannot import an external runtime.');
    const instance = await WebAssembly.instantiate(module);
    if (instance.exports.pn_abi_version?.() !== 1) throw new Error('Unsupported first-party OCR ABI.');
    return new this(instance.exports, maxBytes);
  }

  constructor(exports, maxBytes) {
    this.exports = exports;
    this.memory = exports.memory;
    this.maxBytes = maxBytes;
    this.parameterOffset = Math.ceil(Number(exports.__heap_base.value) / 16) * 16;
    this.base = this.parameterOffset + PARAMETER_BYTES;
    this.cursor = this.base;
    this.free = [];
    this.buffers = new Set();
    this.tensors = new Set();
    this.owners = new Map();
    this.closed = false;
    this.ensure(this.base);
  }

  checkOpen() { if (this.closed) throw new Error('The OCR CPU engine has been disposed.'); }
  async prepareCnn() { this.checkOpen(); }
  storageWidth(type) {
    if (!Object.hasOwn(ARRAYS, type)) throw new Error(`Unsupported CPU tensor storage ${type}.`);
    return ARRAYS[type].BYTES_PER_ELEMENT;
  }

  ensure(end) {
    if (!Number.isSafeInteger(end) || end > this.maxBytes) throw new RangeError('OCR CPU arena exceeds its memory limit.');
    if (end > this.memory.buffer.byteLength) this.memory.grow(Math.ceil((end - this.memory.buffer.byteLength) / PAGE_BYTES));
  }

  allocate(bytes) {
    this.checkOpen();
    const size = Math.max(16, Math.ceil(bytes / 16) * 16);
    if (!Number.isSafeInteger(size) || size > this.maxBytes) throw new RangeError('OCR tensor exceeds the CPU arena limit.');
    const index = this.free.findIndex(item => item.size >= size);
    let offset;
    if (index >= 0) {
      const item = this.free[index]; offset = item.offset;
      if (item.size === size) this.free.splice(index, 1);
      else { item.offset += size; item.size -= size; }
    } else {
      offset = this.cursor;
      this.ensure(offset + size);
      this.cursor += size;
    }
    const buffer = Object.freeze({ offset, size });
    this.buffers.add(buffer);
    return buffer;
  }

  freeBuffer(buffer) {
    if (!this.buffers.delete(buffer)) throw new Error('OCR buffer was already released.');
    this.owners.delete(buffer);
    this.free.push({ ...buffer }); this.free.sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < this.free.length;) {
      const previous = this.free[i - 1], next = this.free[i];
      if (previous.offset + previous.size === next.offset) { previous.size += next.size; this.free.splice(i, 1); }
      else i++;
    }
    while (this.free.at(-1)?.offset + this.free.at(-1)?.size === this.cursor) this.cursor = this.free.pop().offset;
  }

  tensor(shape, batch = null, reusable = null, dataType = 'float32', bounds = null) {
    this.checkOpen();
    const length = tensorSize(shape), elementBytes = this.storageWidth(dataType);
    if (reusable && (!this.buffers.has(reusable) || reusable.size < length * elementBytes)) {
      throw new RangeError('Invalid OCR tensor type or storage.');
    }
    const buffer = reusable ?? this.allocate(length * elementBytes);
    const tensor = Object.freeze({ shape: Object.freeze([...shape]), length, buffer, batch, dataType, bounds, elementBytes });
    this.tensors.add(tensor);
    const owners = this.owners.get(buffer) ?? new Set();
    owners.add(tensor); this.owners.set(buffer, owners);
    return tensor;
  }

  checkTensor(tensor) { if (!this.tensors.has(tensor)) throw new Error('OCR tensor belongs to another engine or has been released.'); }
  forgetTensor(tensor) {
    this.checkTensor(tensor); this.tensors.delete(tensor);
    const owners = this.owners.get(tensor.buffer); owners.delete(tensor); return owners.size;
  }

  write(tensor, data) {
    this.checkOpen(); this.checkTensor(tensor);
    const ArrayType = ARRAYS[tensor.dataType];
    if (!(data instanceof ArrayType) || data.length !== tensor.length || (tensor.dataType === 'bool' && data.some(value => value !== 0 && value !== 1))) throw new RangeError('OCR feed does not match its arena tensor.');
    new ArrayType(this.memory.buffer, tensor.buffer.offset, tensor.length).set(data);
  }

  upload(data, shape, dataType = 'float32') {
    const width = this.storageWidth(dataType);
    if (!(data instanceof ARRAYS[dataType]) || data.length !== tensorSize(shape) || data.byteLength !== tensorSize(shape) * width
      || (dataType === 'bool' && data.some(value => value !== 0 && value !== 1))) throw new RangeError('OCR input does not match its tensor type and shape.');
    const tensor = this.tensor(shape, null, null, dataType); this.write(tensor, data); return tensor;
  }

  uploadBytes(data, shape, dataType = 'float32') {
    if (!(data instanceof Uint8Array) || data.byteLength !== tensorSize(shape) * this.storageWidth(dataType)
      || (dataType === 'bool' && data.some(value => value !== 0 && value !== 1))) throw new RangeError('OCR weight bytes do not match their type and shape.');
    const tensor = this.tensor(shape, null, null, dataType);
    new Uint8Array(this.memory.buffer, tensor.buffer.offset, data.length).set(data);
    return tensor;
  }

  uploadInt32(data, shape) {
    if (!(data instanceof Int32Array) || data.length !== tensorSize(shape)) throw new RangeError('OCR integer data does not match its shape.');
    const tensor = this.tensor(shape, null, null, 'int32', integerRange(data)); this.write(tensor, data); return tensor;
  }

  batch(options) { this.checkOpen(); return new WasmOcrBatch(this, options); }

  invoke(name, tensors, parameters, extra = []) {
    this.checkOpen();
    if (!(parameters instanceof Uint32Array) || parameters.byteLength > PARAMETER_BYTES) throw new RangeError('Oversized OCR operation metadata.');
    new Uint32Array(this.memory.buffer, this.parameterOffset, parameters.length).set(parameters);
    const status = this.exports[name](...tensors.map(tensor => tensor.buffer.offset), this.parameterOffset, ...extra);
    if (status) throw new Error('OCR CPU Pow currently supports only the graph\'s square exponent.');
  }

  async read(tensor) {
    this.checkOpen(); this.checkTensor(tensor);
    if (tensor.batch && !tensor.batch.submitted) throw new Error('Submit the OCR batch before reading.');
    const ArrayType = ARRAYS[tensor.dataType];
    return new ArrayType(this.memory.buffer, tensor.buffer.offset, tensor.length).slice();
  }

  async release(tensor) { return this.releaseMany([tensor]); }
  async releaseMany(tensors, scratch = []) {
    const unique = new Set(tensors), buffers = new Set(scratch);
    for (const tensor of unique) {
      this.checkTensor(tensor);
      if (tensor.batch && !tensor.batch.submitted) throw new Error('Submit the OCR batch before releasing it.');
      buffers.add(tensor.buffer);
    }
    for (const buffer of buffers) if (!this.buffers.has(buffer)) throw new Error('OCR buffer belongs to another engine or was released.');
    for (const tensor of unique) this.forgetTensor(tensor);
    for (const buffer of buffers) if (!this.owners.get(buffer)?.size) this.freeBuffer(buffer);
  }

  async dispose() {
    this.closed = true;
    this.buffers.clear(); this.tensors.clear(); this.owners.clear(); this.free.length = 0;
    // Dropping the instance releases its high-water WASM memory; closing the worker is the hard boundary.
    this.exports = this.memory = null;
  }
}
