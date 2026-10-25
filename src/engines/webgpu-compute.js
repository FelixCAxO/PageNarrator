// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { BINARY_OPERATIONS, UNARY_OPERATIONS } from './native-compute.js';
import { broadcastShape, broadcastStrides, tensorSize } from './tensor-shape.js';
import { axisIndex, batchedMatmulPlan, contiguousStrides } from './index-shape.js';
import { ELEMENTWISE_SHADER, MATMUL_SHADER } from './webgpu-shaders.js';
import { concatPlan, convolutionPlan, poolingPlan, reductionPlan, resizePlan } from './cnn-shape.js';
import { CONCAT_SHADER, CONV_DIRECT_SHADER, CONV_TILED_SHADER, POOL_SHADER, REDUCE_MEAN_SHADER, RESIZE_SHADER } from './webgpu-cnn-shaders.js';
import { ARGMAX_SHADER, BATCH_NORM_SHADER, GATHER_SHADER, INDEX_SHADER, SOFTMAX_SHADER } from './webgpu-index-shaders.js';
import { GRID_SAMPLE_SHADER, PAD_SHADER } from './webgpu-image-shaders.js';
import { integerAddRange, integerMultiplyRange, integerRange } from './bounded-integers.js';
import { CHECKED_GATHER_TENSOR_SHADER, GATHER_TENSOR_SHADER, INTEGER_ADD_SHADER } from './webgpu-integer-shaders.js';
import { liftConvolution } from './cnn-shape.js';
import { CONV_1D_SHADER, CONV_TRANSPOSE_1D_SHADER, SNAKE_SHADER } from './webgpu-audio-shaders.js';
import { storageWidth } from './tensor-format.js';
import { halfIndexShader, halfStorageShader, castShader, compareShader, whereShader } from './webgpu-precision-shaders.js';
import { embeddingShardShader } from './webgpu-embedding-shader.js';
import { generationShader, rangePlan } from './webgpu-generation-shaders.js';

export const GPU_BINARY_OPERATIONS = Object.freeze({ ...BINARY_OPERATIONS, Pow: 4, PRelu: 5 });
export const GPU_UNARY_OPERATIONS = Object.freeze({ ...UNARY_OPERATIONS, Sin: 10, Cos: 11 });

function floatBits(value) { return new Uint32Array(Float32Array.of(value).buffer)[0]; }

export class WebGpuCompute {
  static async create({ gpu = globalThis.navigator?.gpu, device = null, float16 = false } = {}) {
    const ownsDevice = !device;
    if (!device) {
      const adapter = await gpu?.requestAdapter();
      if (!adapter) throw new Error('WebGPU is unavailable.');
      if (float16 && !adapter.features.has('shader-f16')) throw new Error('This model requires WebGPU shader-f16 support.');
      device = await adapter.requestDevice({ requiredFeatures: float16 ? ['shader-f16'] : [] });
    }
    if (float16 && !device.features.has('shader-f16')) throw new Error('The shared WebGPU device does not support this fp16 model.');
    const engine = new WebGpuCompute(device, ownsDevice);
    try {
      [engine.matmulPipeline, engine.elementwisePipeline] = await Promise.all([
        engine.pipeline(MATMUL_SHADER, 'PageNarrator tiled MatMul'),
        engine.pipeline(ELEMENTWISE_SHADER, 'PageNarrator elementwise'),
      ]);
      return engine;
    } catch (error) {
      await engine.dispose();
      throw error;
    }
  }

  constructor(device, ownsDevice) {
    this.device = device;
    this.ownsDevice = ownsDevice;
    this.buffers = new Set();
    this.tensors = new Set();
    this.owners = new Map();
    this.pending = new Set();
    this.pipelines = new Map();
    this.closed = false;
    this.lost = null;
    this.onGpuError = event => { this.completionError = event.error; };
    device.addEventListener('uncapturederror', this.onGpuError);
    device.lost.then(info => { this.lost = info; });
  }

  async pipeline(code, label) {
    if (!this.pipelines.has(code)) {
      const module = this.device.createShaderModule({ code, label });
      this.pipelines.set(code, (async () => {
        const errors = (await module.getCompilationInfo()).messages.filter(message => message.type === 'error');
        if (errors.length) throw new Error(`${label}: ${errors.map(message => `${message.lineNum}:${message.linePos} ${message.message}`).join('; ')}`);
        return this.device.createComputePipelineAsync({ label, layout: 'auto', compute: { module, entryPoint: 'main' } });
      })());
    }
    return this.pipelines.get(code);
  }

  prepareCnn() {
    this.checkOpen();
    return this.cnnPreparation ??= this.prepareCnnPipelines();
  }

  async prepareCnnPipelines() {
    const definitions = { convTiled: CONV_TILED_SHADER, convDirect: CONV_DIRECT_SHADER,
      reduceMean: REDUCE_MEAN_SHADER, pool: POOL_SHADER, resize: RESIZE_SHADER, concat: CONCAT_SHADER,
      index: INDEX_SHADER, gather: GATHER_SHADER, batchNorm: BATCH_NORM_SHADER, softmax: SOFTMAX_SHADER, argmax: ARGMAX_SHADER,
      pad: PAD_SHADER, gridSample: GRID_SAMPLE_SHADER, integerAdd: INTEGER_ADD_SHADER, gatherTensor: GATHER_TENSOR_SHADER, checkedGatherTensor: CHECKED_GATHER_TENSOR_SHADER,
      conv1d: CONV_1D_SHADER, convTranspose1d: CONV_TRANSPOSE_1D_SHADER, snake: SNAKE_SHADER,
      gatherBits: GATHER_SHADER.replaceAll('array<f32>', 'array<u32>'), concatBits: CONCAT_SHADER.replaceAll('array<f32>', 'array<u32>') };
    this.cnn = Object.fromEntries(await Promise.all(Object.entries(definitions).map(async ([name, code]) =>
      [name, await this.pipeline(code, `PageNarrator ${name}`)])));
    this.typed = {};
    const pending = [];
    const prepare = (key, code, label) => pending.push(this.pipeline(code, label).then(pipeline => { this.typed[key] = pipeline; }));
    const types = ['float32', 'int32', 'bool', ...(this.device.features.has('shader-f16') ? ['float16'] : [])];
    for (const type of types) {
      prepare(`fill:${type}`, generationShader(type), `PageNarrator ${type} fill`);
      if (type !== 'bool') prepare(`range:${type}`, generationShader(type, true), `PageNarrator ${type} range`);
      for (const operation of ['Equal', 'Greater', 'GreaterOrEqual', 'Less', ...(type === 'bool' ? ['And'] : [])]) {
        prepare(`compare:${operation}:${type}`, compareShader(type, operation), `PageNarrator ${type} ${operation}`);
      }
      prepare(`where:${type}`, whereShader(type), `PageNarrator ${type} selection`);
      prepare(`embedding:${type}`, embeddingShardShader(type), `PageNarrator ${type} embedding shard`);
      prepare(`embeddingChecked:${type}`, embeddingShardShader(type, true), `PageNarrator checked ${type} embedding shard`);
      for (const to of types) if (type !== to) prepare(`cast:${type}:${to}`, castShader(type, to), `PageNarrator ${type} to ${to}`);
    }
    await Promise.all(pending);
    if (types.includes('float16')) {
      const halfDefinitions = { matmul: MATMUL_SHADER, elementwise: ELEMENTWISE_SHADER, reduceMean: REDUCE_MEAN_SHADER,
        softmax: SOFTMAX_SHADER, concat: CONCAT_SHADER };
      this.half = Object.fromEntries(await Promise.all(Object.entries(halfDefinitions).map(async ([name, code]) =>
        [name, await this.pipeline(halfStorageShader(code), `PageNarrator half ${name}`)])));
      for (const [name, code] of Object.entries({ index: INDEX_SHADER, gather: GATHER_SHADER, gatherTensor: GATHER_TENSOR_SHADER, checkedGatherTensor: CHECKED_GATHER_TENSOR_SHADER })) {
        this.half[name] = await this.pipeline(halfIndexShader(code), `PageNarrator half ${name}`);
      }
    }
  }

  checkOpen() {
    if (this.closed) throw new Error('The WebGPU engine has been disposed.');
    if (this.lost) throw new Error(`WebGPU device lost: ${this.lost.message}`);
    if (this.completionError) throw new Error(`WebGPU submission failed: ${this.completionError.message}`);
  }

  buffer(size, usage, label) {
    const bytes = Math.max(4, Math.ceil(size / 4) * 4);
    if (!Number.isSafeInteger(bytes) || bytes > this.device.limits.maxBufferSize
      || ((usage & GPUBufferUsage.STORAGE) && bytes > this.device.limits.maxStorageBufferBindingSize)) {
      throw new RangeError('Tensor exceeds the WebGPU device buffer limit.');
    }
    const buffer = this.device.createBuffer({ size: bytes, usage, label });
    this.buffers.add(buffer);
    return buffer;
  }

  tensor(shape, batch = null, reusableBuffer = null, dataType = 'float32', bounds = null) {
    if (['uint8', 'int8'].includes(dataType)) throw new Error('Quantized tensors require the WASM backend.');
    const length = tensorSize(shape);
    const bytes = length * storageWidth(dataType);
    if (dataType === 'float16' && !this.device.features.has('shader-f16')) throw new Error('Half tensors require shader-f16 support.');
    if (reusableBuffer && (!this.buffers.has(reusableBuffer) || reusableBuffer.size < bytes)) throw new RangeError('A tensor view requires sufficient storage from this engine.');
    const buffer = reusableBuffer ?? this.buffer(bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, 'PageNarrator tensor');
    const tensor = Object.freeze({ shape: Object.freeze([...shape]), length, buffer, batch, dataType, bounds });
    this.tensors.add(tensor);
    const owners = this.owners.get(buffer) ?? new Set();
    owners.add(tensor); this.owners.set(buffer, owners);
    return tensor;
  }

  forgetTensor(tensor) {
    this.tensors.delete(tensor);
    const owners = this.owners.get(tensor.buffer);
    owners.delete(tensor);
    return owners.size;
  }

  upload(data, shape, type = 'float32') {
    this.checkOpen();
    const ArrayType = { float32: Float32Array, float16: Uint16Array, bool: Uint32Array }[type];
    if (!ArrayType || !(data instanceof ArrayType) || data.length !== tensorSize(shape)) throw new RangeError('Tensor data does not match its typed shape.');
    const tensor = this.tensor(shape, null, null, type, type === 'bool' ? { min: 0, max: 1 } : null);
    this.write(tensor, data);
    return tensor;
  }

  uploadBytes(data, shape, type = 'float32') {
    this.checkOpen();
    if (!(data instanceof Uint8Array) || data.byteLength !== tensorSize(shape) * storageWidth(type)) throw new RangeError('Tensor bytes do not match their typed shape.');
    const tensor = this.tensor(shape, null, null, type);
    this.writeBytes(tensor, data);
    return tensor;
  }

  uploadSharded(data, shape, type) {
    this.checkOpen();
    const rowBytes = tensorSize(shape.slice(1)) * storageWidth(type);
    if (shape.length !== 2 || !rowBytes || rowBytes % 4 || !(data instanceof Uint8Array)
      || data.byteLength !== shape[0] * rowBytes) throw new RangeError('Embedding shards require aligned rank-two weight rows.');
    const rows = Math.floor(Math.min(this.device.limits.maxBufferSize, this.device.limits.maxStorageBufferBindingSize) / rowBytes);
    if (!rows) throw new RangeError('Embedding row exceeds the GPU storage limit.');
    const shards = [];
    try {
      for (let start = 0; start < shape[0]; start += rows) {
        const count = Math.min(rows, shape[0] - start);
        const tensor = this.uploadBytes(data.subarray(start * rowBytes, (start + count) * rowBytes), [count, shape[1]], type);
        shards.push({ start, tensor });
      }
      return Object.freeze({ shape: Object.freeze([...shape]), dataType: type, length: tensorSize(shape), shards });
    } catch (error) {
      for (const { tensor } of shards) { this.forgetTensor(tensor); tensor.buffer.destroy(); this.buffers.delete(tensor.buffer); this.owners.delete(tensor.buffer); }
      throw error;
    }
  }

  uploadInt32(data, shape) {
    this.checkOpen();
    if (!(data instanceof Int32Array) || data.length !== tensorSize(shape)) throw new RangeError('Tensor data does not match its int32 shape.');
    const tensor = this.tensor(shape, null, null, 'int32', integerRange(data));
    if (data.byteLength) this.device.queue.writeBuffer(tensor.buffer, 0, data);
    return tensor;
  }

  write(tensor, data) {
    this.checkOpen(); this.checkTensor(tensor);
    const ArrayType = { int32: Int32Array, float32: Float32Array, float16: Uint16Array, bool: Uint32Array }[tensor.dataType];
    if (!(data instanceof ArrayType) || data.length !== tensor.length) throw new RangeError('Input update does not match tensor storage.');
    this.writeBytes(tensor, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }

  writeBytes(tensor, data) {
    if (!data.byteLength) return;
    // Queue writes and copies require four-byte alignment; odd half counts need one pad element.
    if (data.byteLength % 4) {
      const padded = new Uint8Array(Math.ceil(data.byteLength / 4) * 4); padded.set(data);
      this.device.queue.writeBuffer(tensor.buffer, 0, padded);
    } else this.device.queue.writeBuffer(tensor.buffer, 0, data);
  }

  checkTensor(tensor) {
    if (!this.tensors.has(tensor)) throw new Error('Tensor belongs to another engine or has been released.');
  }

  batch(options) { this.checkOpen(); return new ComputeBatch(this, options); }

  matmul(a, b) { const batch = this.batch(); const result = batch.matmul(a, b); batch.submit(); return result; }
  unary(operation, a, options) { const batch = this.batch(); const result = batch.unary(operation, a, options); batch.submit(); return result; }
  binary(operation, a, b) { const batch = this.batch(); const result = batch.binary(operation, a, b); batch.submit(); return result; }

  async read(tensor, { validate = true } = {}) {
    this.checkOpen(); this.checkTensor(tensor);
    if (tensor.batch && !tensor.batch.submitted) throw new Error('Submit the tensor command batch before reading it.');
    const task = (async () => {
      if (validate) await tensor.batch?.validate();
      const ArrayType = { int32: Int32Array, float32: Float32Array, float16: Uint16Array, bool: Uint32Array }[tensor.dataType];
      if (!tensor.length) return new ArrayType();
      const bytes = Math.ceil(tensor.length * storageWidth(tensor.dataType) / 4) * 4;
      const staging = this.buffer(bytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ, 'PageNarrator readback');
      try {
        const encoder = this.device.createCommandEncoder();
        encoder.copyBufferToBuffer(tensor.buffer, 0, staging, 0, bytes);
        this.device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const result = new ArrayType(staging.getMappedRange(), 0, tensor.length).slice();
        staging.unmap();
        if (this.completionError) throw new Error(`WebGPU inference failed: ${this.completionError.message}`);
        return result;
      } finally {
        staging.destroy(); this.buffers.delete(staging);
      }
    })();
    this.pending.add(task);
    try { return await task; } finally { this.pending.delete(task); }
  }

  async release(tensor) {
    return this.releaseMany([tensor]);
  }

  async releaseMany(tensors, scratchBuffers = []) {
    const unique = new Set(tensors);
    const buffers = new Set(scratchBuffers);
    for (const tensor of unique) {
      this.checkTensor(tensor);
      if (tensor.batch && !tensor.batch.submitted) throw new Error('Submit the tensor command batch before releasing it.');
      buffers.add(tensor.buffer);
    }
    for (const buffer of buffers) if (!this.buffers.has(buffer)) throw new Error('Buffer belongs to another engine or has been released.');
    for (const tensor of unique) this.forgetTensor(tensor);
    const unused = [...buffers].filter(buffer => !this.owners.get(buffer)?.size);
    try { await this.device.queue.onSubmittedWorkDone(); }
    finally {
      for (const buffer of unused) { buffer.destroy(); this.buffers.delete(buffer); this.owners.delete(buffer); }
    }
  }

  async dispose() {
    if (this.disposal) return this.disposal;
    this.closed = true;
    this.disposal = (async () => {
      await Promise.allSettled([...this.pending]);
      await this.device.queue.onSubmittedWorkDone().catch(error => { this.completionError = error; });
      for (const buffer of this.buffers) buffer.destroy();
      this.buffers.clear(); this.tensors.clear(); this.owners.clear();
      this.pipelines.clear();
      this.cnn = this.half = this.typed = null;
      this.matmulPipeline = this.elementwisePipeline = null;
      this.device.removeEventListener('uncapturederror', this.onGpuError);
      if (this.ownsDevice) this.device.destroy();
    })();
    return this.disposal;
  }
}

class ComputeBatch {
  constructor(engine, { capture = false } = {}) {
    this.engine = engine;
    this.encoder = engine.device.createCommandEncoder({ label: 'PageNarrator inference batch' });
    this.parameters = [];
    this.outputs = new Set();
    this.bufferPool = new Map();
    this.reuseCount = 0;
    this.allocationCount = 0;
    this.allocatedBytes = 0;
    this.submitted = false;
    this.commands = capture ? [] : null;
  }

  output(shape, dataType = 'float32', bounds = null) {
    const bytes = Math.max(4, Math.ceil(tensorSize(shape) * storageWidth(dataType) / 4) * 4);
    let selected = Infinity;
    for (const [size, buffers] of this.bufferPool) if (buffers.length && size >= bytes && size < selected) selected = size;
    const buffer = this.bufferPool.get(selected)?.pop();
    if (buffer) this.reuseCount += 1;
    else { this.allocationCount += 1; this.allocatedBytes += bytes; }
    const tensor = this.engine.tensor(shape, this, buffer, dataType, bounds);
    this.outputs.add(tensor);
    return tensor;
  }

  recycle(tensor) {
    this.checkOwnership(tensor);
    if (tensor.batch !== this) throw new Error('Only this batch can recycle its intermediate tensors.');
    this.outputs.delete(tensor);
    if (this.engine.forgetTensor(tensor)) return;
    const buffers = this.bufferPool.get(tensor.buffer.size) ?? [];
    buffers.push(tensor.buffer);
    this.bufferPool.set(tensor.buffer.size, buffers);
  }

  scratchBuffers() { return [...this.bufferPool.values()].flat(); }

  retireScratch() {
    if (!this.submitted) throw new Error('Submit a batch before retiring its scratch storage.');
    const buffers = [...this.scratchBuffers(), ...this.parameters];
    this.bufferPool.clear(); this.parameters.length = 0; this.commands = null;
    return buffers;
  }

  checkOwnership(...tensors) {
    this.engine.checkOpen();
    if (this.submitted) throw new Error('Command batch was already submitted.');
    for (const tensor of tensors) {
      this.engine.checkTensor(tensor);
      if (tensor.batch && tensor.batch !== this && !tensor.batch.submitted) throw new Error('An input tensor has an unsubmitted command batch.');
    }
  }

  check(...tensors) {
    this.checkOwnership(...tensors);
    if (tensors.some(tensor => tensor.dataType !== 'float32')) throw new Error('This GPU operation requires float32 tensors.');
  }

  checkNumeric(...tensors) {
    this.checkOwnership(...tensors);
    if (!['float32', 'float16'].includes(tensors[0].dataType) || tensors.some(tensor => tensor.dataType !== tensors[0].dataType)) throw new Error('This operation requires matching float tensor types.');
  }

  dispatch(pipeline, a, b, out, parameters, x, y = 1) {
    this.dispatchTensors(pipeline, [a, b, out], parameters, x, y);
  }

  dispatchTensors(pipeline, tensors, parameters, x, y = 1, z = 1) {
    if (!x || !y || !z) return;
    const limit = this.engine.device.limits.maxComputeWorkgroupsPerDimension;
    if (!pipeline) throw new Error('Prepare the required GPU pipelines before encoding inference.');
    if ([x, y, z].some(n => !Number.isSafeInteger(n) || n < 0 || n > limit)) throw new RangeError('Compute dispatch exceeds the WebGPU workgroup limit.');
    const cfg = this.engine.buffer(parameters.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, 'PageNarrator dispatch parameters');
    this.parameters.push(cfg);
    this.engine.device.queue.writeBuffer(cfg, 0, parameters);
    const group = this.engine.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries:
      [...tensors.map(tensor => tensor.buffer), cfg].map((buffer, binding) => ({ binding, resource: { buffer } })) });
    const pass = this.encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(x, y, z); pass.end();
    this.commands?.push({ pipeline, group, x, y, z });
  }

  grid(groups) {
    const x = Math.min(groups, this.engine.device.limits.maxComputeWorkgroupsPerDimension);
    return [x, x ? Math.ceil(groups / x) : 0];
  }

  convolution(input, weights, bias = null, options = {}) {
    this.check(input, weights, ...(bias ? [bias] : []));
    const lifted = liftConvolution(input.shape, weights.shape, options);
    const plan = convolutionPlan(lifted.input, lifted.weights, lifted.options);
    if (bias && (bias.shape.length !== 1 || bias.length !== plan.shape[1])) throw new RangeError('Convolution bias must match output channels.');
    const output = this.output(lifted.squeeze ? [plan.shape[0], plan.shape[1], plan.shape[3]] : plan.shape);
    const parameters = new Uint32Array(24);
    const [x, y] = this.grid(Math.ceil(output.length / 64));
    parameters.set([...lifted.input, ...plan.shape.slice(1), plan.inputChannelsPerGroup, plan.outputChannelsPerGroup,
      ...plan.kernel, ...plan.strides, ...plan.dilations, ...plan.pads.slice(0, 2), Number(Boolean(bias)), Number(Boolean(options.relu)), Number(plan.transpose), plan.group, x]);
    if (plan.transpose && lifted.squeeze && plan.dilations[1] === 1) {
      this.dispatchTensors(this.engine.cnn?.convTranspose1d, [input, weights, bias ?? weights, output], parameters,
        Math.ceil(Math.ceil(plan.shape[3] / plan.strides[1]) / 16), Math.ceil(plan.outputChannelsPerGroup / 16), plan.shape[0] * plan.group * plan.strides[1]);
    } else if (lifted.squeeze && !plan.transpose && plan.inputChannelsPerGroup > 1) {
      this.dispatchTensors(this.engine.cnn?.conv1d, [input, weights, bias ?? weights, output], parameters,
        Math.ceil(plan.shape[3] / 32), Math.ceil(plan.outputChannelsPerGroup / 32), plan.shape[0] * plan.group);
    } else if (plan.transpose || plan.inputChannelsPerGroup === 1) {
      this.dispatchTensors(this.engine.cnn?.convDirect, [input, weights, bias ?? weights, output], parameters, x, y);
    } else {
      this.dispatchTensors(this.engine.cnn?.convTiled, [input, weights, bias ?? weights, output], parameters,
        Math.ceil(plan.shape[2] * plan.shape[3] / 16), Math.ceil(plan.outputChannelsPerGroup / 16), plan.shape[0] * plan.group);
    }
    return output;
  }

  reduce(input, axes = null, keepDims = true, mode = 'mean') {
    this.checkNumeric(input);
    if (!['mean', 'max', 'sum'].includes(mode)) throw new Error('Unknown reduction mode.');
    const plan = reductionPlan(input.shape, axes, keepDims);
    if (!plan.reductionSize) throw new RangeError('Mean over an empty dimension is unsupported.');
    const output = this.output(plan.shape, input.dataType);
    const [x, y] = this.grid(output.length);
    const parameters = new Uint32Array(16);
    parameters.set([output.length, plan.reductionSize, input.shape.length, plan.mask, x, ['mean', 'max', 'sum'].indexOf(mode)]);
    parameters.set(input.shape, 8);
    this.dispatchTensors(input.dataType === 'float16' ? this.engine.half?.reduceMean : this.engine.cnn?.reduceMean, [input, output], parameters, x, y);
    return output;
  }

  pool(input, options) {
    this.check(input);
    const plan = poolingPlan(input.shape, options);
    const output = this.output(plan.shape);
    const [x, y] = this.grid(Math.ceil(output.length / 64));
    const parameters = Uint32Array.of(output.length, ...input.shape.slice(2), ...plan.shape.slice(2), ...plan.kernel,
      ...plan.strides, ...plan.dilations, ...plan.pads.slice(0, 2), Number(Boolean(options.average)), Number(Boolean(options.countIncludePad)), x, ...plan.pads.slice(2));
    this.dispatchTensors(this.engine.cnn?.pool, [input, output], parameters, x, y);
    return output;
  }

  resize(input, options) {
    this.check(input);
    if (input.shape.length === 3) {
      if ((options.scales && options.scales.length !== 3) || (options.sizes && options.sizes.length !== 3)) throw new RangeError('One-dimensional Resize parameters must match their rank.');
      const lifted = this.view(input, [...input.shape.slice(0, 2), 1, input.shape[2]]);
      const result = this.resize(lifted, { ...options,
        scales: options.scales ? [...options.scales.slice(0, 2), 1, options.scales[2]] : null,
        sizes: options.sizes ? [...options.sizes.slice(0, 2), 1, options.sizes[2]] : null });
      this.recycle(lifted);
      const output = this.view(result, [...result.shape.slice(0, 2), result.shape[3]]);
      this.recycle(result); return output;
    }
    const plan = resizePlan(input.shape, options);
    const output = this.output(plan.shape);
    const [x, y] = this.grid(Math.ceil(output.length / 64));
    const parameters = Uint32Array.of(output.length, ...input.shape.slice(2), ...plan.shape.slice(2),
      ...plan.scales.map(floatBits), plan.mode, plan.coordinateMode, plan.nearestMode, x);
    this.dispatchTensors(this.engine.cnn?.resize, [input, output], parameters, x, y);
    return output;
  }

  concat(inputs, axis) {
    this.checkOwnership(...inputs);
    if (inputs.some(input => input.dataType !== inputs[0].dataType)) throw new Error('Concat requires matching tensor types.');
    const plan = concatPlan(inputs.map(input => input.shape), axis);
    const bounds = inputs.every(input => input.bounds) ? { min: Math.min(...inputs.map(input => input.bounds.min)), max: Math.max(...inputs.map(input => input.bounds.max)) } : null;
    const output = this.output(plan.shape, inputs[0].dataType, bounds);
    let offset = 0;
    for (const input of inputs) {
      const [x, y] = this.grid(Math.ceil(input.length / 64));
      this.dispatchTensors(input.dataType === 'float16' ? this.engine.half?.concat : this.engine.cnn?.concatBits, [input, output],
        Uint32Array.of(input.length, input.shape[plan.axis], plan.innerSize, plan.shape[plan.axis], offset, x), x, y);
      offset += input.shape[plan.axis];
    }
    return output;
  }

  copy(input, shape = input.shape) {
    this.checkOwnership(input);
    if (tensorSize(shape) !== input.length) throw new RangeError('Copy requires the same tensor element count.');
    const output = this.output(shape, input.dataType, input.bounds);
    if (input.length) {
      const bytes = Math.ceil(input.length * storageWidth(input.dataType) / 4) * 4;
      this.encoder.copyBufferToBuffer(input.buffer, 0, output.buffer, 0, bytes);
      this.commands?.push({ copy: true, source: input.buffer, destination: output.buffer, bytes });
    }
    return output;
  }

  view(input, shape) {
    this.checkOwnership(input);
    if (tensorSize(shape) !== input.length) throw new RangeError('View requires the same tensor element count.');
    const tensor = this.engine.tensor(shape, this, input.buffer, input.dataType, input.bounds);
    this.outputs.add(tensor);
    return tensor;
  }

  index(input, { shape, strides, offset }) {
    this.checkOwnership(input);
    const output = this.output(shape, input.dataType, input.bounds);
    const [x, y] = this.grid(Math.ceil(output.length / 64));
    const parameters = new Uint32Array(24);
    parameters.set([output.length, shape.length, offset, x]);
    parameters.set(shape, 8); parameters.set(strides, 16);
    this.dispatchTensors(input.dataType === 'float16' ? this.engine.half?.index : this.engine.cnn?.index, [input, output], parameters, x, y);
    return output;
  }

  gather(input, indices, indexShape, axis = 0) {
    this.checkOwnership(input);
    axis = axisIndex(axis, input.shape.length);
    if (!Array.isArray(indices) || indices.length !== tensorSize(indexShape) || indices.length > 1024 || indices.some(i => !Number.isSafeInteger(i) || i < -input.shape[axis] || i >= input.shape[axis])) throw new RangeError('Gather requires bounded constant indices.');
    const output = this.output([...input.shape.slice(0, axis), ...indexShape, ...input.shape.slice(axis + 1)], input.dataType, input.bounds);
    const [x, y] = this.grid(Math.ceil(output.length / 64));
    const parameters = new Uint32Array(8 + indices.length);
    parameters.set([output.length, tensorSize(input.shape.slice(axis + 1)), indices.length, input.shape[axis], x]);
    parameters.set(indices.map(i => i < 0 ? i + input.shape[axis] : i), 8);
    this.dispatchTensors(input.dataType === 'float16' ? this.engine.half?.gather : this.engine.cnn?.gatherBits, [input, output], parameters, x, y);
    return output;
  }

  gatherTensor(input, indices, axis = 0) {
    if (input.shards) return this.gatherShards(input, indices, axis);
    this.checkOwnership(input, indices);
    axis = axisIndex(axis, input.shape.length);
    if (indices.dataType !== 'int32') throw new RangeError('Gather requires exact int32 indices.');
    const checked = !indices.bounds || indices.bounds.min < -input.shape[axis] || indices.bounds.max >= input.shape[axis];
    const output = this.output([...input.shape.slice(0, axis), ...indices.shape, ...input.shape.slice(axis + 1)], input.dataType, input.bounds);
    const [x, y] = this.grid(Math.ceil(output.length / 64));
    const operation = checked ? 'checkedGatherTensor' : 'gatherTensor';
    const tensors = [input, indices, output]; if (checked) tensors.push(this.validationFlag());
    this.dispatchTensors(input.dataType === 'float16' ? this.engine.half?.[operation] : this.engine.cnn?.[operation], tensors,
      Uint32Array.of(output.length, tensorSize(input.shape.slice(axis + 1)), indices.length, input.shape[axis], x), x, y);
    return output;
  }

  gatherShards(input, indices, axis) {
    this.checkOwnership(indices, ...input.shards.map(shard => shard.tensor));
    if (axis !== 0 || indices.dataType !== 'int32') throw new RangeError('Sharded Gather requires exact indices on the row axis.');
    const checked = !indices.bounds || indices.bounds.min < -input.shape[0] || indices.bounds.max >= input.shape[0];
    const output = this.output([...indices.shape, ...input.shape.slice(1)], input.dataType);
    const [x, y] = this.grid(Math.ceil(output.length / 64));
    for (const { start, tensor } of input.shards) {
      const tensors = [tensor, indices, output]; if (checked) tensors.push(this.validationFlag());
      this.dispatchTensors(this.engine.typed?.[`${checked ? 'embeddingChecked' : 'embedding'}:${input.dataType}`], tensors,
        Uint32Array.of(output.length, input.shape[1], indices.length, input.shape[0], x, start, tensor.shape[0]), x, y);
    }
    return output;
  }

  batchNorm(input, scale, bias, mean, variance, epsilon = 1e-5) {
    this.check(input, scale, bias, mean, variance);
    if (input.shape.length < 2 || [scale, bias, mean, variance].some(t => t.shape.length !== 1 || t.length !== input.shape[1]) || !Number.isFinite(epsilon) || epsilon < 0) throw new RangeError('Invalid inference batch normalization parameters.');
    const output = this.output(input.shape);
    const [x, y] = this.grid(Math.ceil(output.length / 64));
    this.dispatchTensors(this.engine.cnn?.batchNorm, [input, scale, bias, mean, variance, output],
      Uint32Array.of(output.length, input.shape[1], tensorSize(input.shape.slice(2)), floatBits(epsilon), x), x, y);
    return output;
  }

  softmax(input, axis = -1) {
    this.checkNumeric(input);
    axis = axisIndex(axis, input.shape.length);
    if (axis !== input.shape.length - 1 || !input.shape[axis]) throw new RangeError('Softmax currently requires a nonempty final axis.');
    const output = this.output(input.shape, input.dataType);
    const [x, y] = this.grid(input.length / input.shape[axis]);
    this.dispatchTensors(input.dataType === 'float16' ? this.engine.half?.softmax : this.engine.cnn?.softmax, [input, output], Uint32Array.of(input.length / input.shape[axis], input.shape[axis], x), x, y);
    return output;
  }

  argmax(input, axis = 0, keepDims = true, selectLastIndex = false) {
    this.check(input);
    axis = axisIndex(axis, input.shape.length);
    if (!input.shape[axis]) throw new RangeError('ArgMax requires a nonempty axis.');
    const shape = input.shape.flatMap((dim, i) => i === axis ? keepDims ? [1] : [] : [dim]);
    const output = this.output(shape, 'int32', { min: 0, max: input.shape[axis] - 1 });
    const [x, y] = this.grid(output.length);
    this.dispatchTensors(this.engine.cnn?.argmax, [input, output],
      Uint32Array.of(output.length, input.shape[axis], tensorSize(input.shape.slice(axis + 1)), x, Number(selectLastIndex)), x, y);
    return output;
  }

  pad(input, pads, mode = 'constant', value = 0) {
    this.check(input);
    const rank = input.shape.length;
    const modes = ['constant', 'edge', 'reflect'];
    if (!Array.isArray(pads) || pads.length !== rank * 2 || pads.some(p => !Number.isSafeInteger(p) || Math.abs(p) > 0x7fffffff)
      || !modes.includes(mode) || !Number.isFinite(value)) throw new RangeError('Invalid pad parameters.');
    const shape = input.shape.map((dim, axis) => dim + pads[axis] + pads[axis + rank]);
    if (shape.some(dim => dim < 0) || (mode !== 'constant' && input.shape.some(dim => !dim))
      || (mode === 'reflect' && input.shape.some((dim, axis) => pads[axis] >= dim || pads[axis + rank] >= dim))) throw new RangeError('Invalid padded dimension.');
    const output = this.output(shape);
    const [x, y] = this.grid(Math.ceil(output.length / 64));
    const parameters = new Uint32Array(40);
    parameters.set([output.length, rank, modes.indexOf(mode), floatBits(value), x]);
    parameters.set(shape, 8); parameters.set(contiguousStrides(input.shape), 16);
    parameters.set(pads.slice(0, rank), 24); parameters.set(input.shape, 32);
    this.dispatchTensors(this.engine.cnn?.pad, [input, output], parameters, x, y);
    return output;
  }

  gridSample(input, grid, { mode = 'bilinear', paddingMode = 'zeros', alignCorners = false } = {}) {
    this.check(input, grid);
    const paddings = ['zeros', 'border', 'reflection'];
    if (input.shape.length !== 4 || grid.shape.length !== 4 || grid.shape[0] !== input.shape[0] || grid.shape[3] !== 2
      || input.shape.slice(1).some(dim => !dim) || !['bilinear', 'nearest'].includes(mode) || !paddings.includes(paddingMode)) throw new RangeError('Unsupported grid sampling shape or mode.');
    const shape = [...input.shape.slice(0, 2), ...grid.shape.slice(1, 3)];
    const output = this.output(shape);
    const [x, y] = this.grid(Math.ceil(output.length / 64));
    const parameters = new Uint32Array(12);
    parameters.set([output.length, input.shape[1], ...input.shape.slice(2), ...shape.slice(2), 0, Number(alignCorners), paddings.indexOf(paddingMode), Number(mode === 'nearest'), x]);
    this.dispatchTensors(this.engine.cnn?.gridSample, [input, grid, output], parameters, x, y);
    return output;
  }

  matmul(a, b) {
    this.checkNumeric(a, b);
    const plan = batchedMatmulPlan(a.shape, b.shape);
    const output = this.output(plan.shape, a.dataType);
    const parameters = new Uint32Array(32);
    parameters.set([a.shape.at(-2), b.shape.at(-1), a.shape.at(-1), plan.batch.length]);
    parameters.set(plan.batch, 8); parameters.set(plan.aStrides, 16); parameters.set(plan.bStrides, 24);
    this.dispatchTensors(a.dataType === 'float16' ? this.engine.half?.matmul : this.engine.matmulPipeline, [a, b, output], parameters,
      Math.ceil(b.shape.at(-1) / 16), Math.ceil(a.shape.at(-2) / 16), tensorSize(plan.batch));
    return output;
  }

  elementwise(a, b, shape, opcode, alpha = 0, beta = 0, bounds = null) {
    const output = this.output(shape, bounds ? 'int32' : a.dataType, bounds);
    const parameters = new Uint32Array(32);
    const groups = Math.ceil(output.length / 64);
    const x = Math.min(groups, this.engine.device.limits.maxComputeWorkgroupsPerDimension);
    parameters.set([output.length, shape.length,
      Number(a.length === output.length && b.length === output.length), opcode, floatBits(alpha), floatBits(beta), 0, x]);
    parameters.set(shape, 8);
    parameters.set(broadcastStrides(a.shape, shape), 16);
    parameters.set(broadcastStrides(b.shape, shape), 24);
    this.dispatch(bounds ? this.engine.cnn?.integerAdd : a.dataType === 'float16' ? this.engine.half?.elementwise : this.engine.elementwisePipeline, a, b, output, parameters, x, x ? Math.ceil(groups / x) : 0);
    return output;
  }

  unary(operation, a, { alpha = 0.2, beta = 0.5 } = {}) {
    this.checkNumeric(a);
    if (!Object.hasOwn(GPU_UNARY_OPERATIONS, operation)) throw new Error(`Unsupported GPU operation ${operation}.`);
    if (!Number.isFinite(alpha) || !Number.isFinite(beta)) throw new RangeError('Activation parameters must be finite.');
    return this.elementwise(a, a, a.shape, 100 + GPU_UNARY_OPERATIONS[operation], alpha, beta);
  }

  snake(input, alpha, scale) {
    this.check(input, alpha, scale);
    const shape = broadcastShape(broadcastShape(input.shape, alpha.shape), scale.shape), output = this.output(shape);
    const [x, y] = this.grid(Math.ceil(output.length / 64));
    const parameters = new Uint32Array(40);
    parameters.set([output.length, shape.length, x]); parameters.set(shape, 8);
    parameters.set(broadcastStrides(alpha.shape, shape), 16); parameters.set(broadcastStrides(scale.shape, shape), 24);
    parameters.set(broadcastStrides(input.shape, shape), 32);
    this.dispatchTensors(this.engine.cnn?.snake, [input, alpha, scale, output], parameters, x, y);
    return output;
  }

  binary(operation, a, b) {
    if (a.dataType === 'int32' || b.dataType === 'int32') {
      this.checkOwnership(a, b);
      if (a.dataType !== b.dataType || !['Add', 'Mul'].includes(operation)) throw new Error('Only range-proven Add/Mul is supported for GPU integer arithmetic.');
      return this.elementwise(a, b, broadcastShape(a.shape, b.shape), operation === 'Mul' ? 1 : 0, 0, 0,
        operation === 'Mul' ? integerMultiplyRange(a.bounds, b.bounds) : integerAddRange(a.bounds, b.bounds));
    }
    this.checkNumeric(a, b);
    if (!Object.hasOwn(GPU_BINARY_OPERATIONS, operation)) throw new Error(`Unsupported GPU operation ${operation}.`);
    return this.elementwise(a, b, broadcastShape(a.shape, b.shape), GPU_BINARY_OPERATIONS[operation]);
  }

  cast(input, to) {
    this.checkOwnership(input);
    const type = { 1: 'float32', 6: 'int32', 7: 'int32', 9: 'bool', 10: 'float16' }[to];
    if (!type) throw new Error('Unsupported GPU Cast target.');
    if (type === input.dataType) return input;
    if (type === 'int32' && !input.bounds) throw new RangeError('Integer Cast requires a proven exact int32 range.');
    const bounds = type === 'bool' ? { min: 0, max: 1 } : type === 'int32' ? input.bounds : null;
    const result = this.output(input.shape, type, bounds), [x, y] = this.grid(Math.ceil(input.length / 64));
    this.dispatchTensors(this.engine.typed?.[`cast:${input.dataType}:${type}`], [input, result], Uint32Array.of(input.length, x), x, y);
    return result;
  }

  fill(shape, value, type = 'float32') {
    this.checkOwnership();
    if (!['float32', 'float16', 'int32', 'bool'].includes(type) || typeof value !== 'number') throw new Error('Unsupported tensor fill type.');
    if (type === 'int32' && (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)) throw new RangeError('Integer fill must fit int32.');
    if (type === 'bool' && value !== 0 && value !== 1) throw new RangeError('Boolean fill must be zero or one.');
    const bounds = ['int32', 'bool'].includes(type) ? { min: value, max: value } : null;
    const result = this.output(shape, type, bounds), [x, y] = this.grid(Math.ceil(result.length / 64));
    this.dispatchTensors(this.engine.typed?.[`fill:${type}`], [result], Uint32Array.of(result.length, x,
      ['int32', 'bool'].includes(type) ? value >>> 0 : floatBits(value)), x, y);
    return result;
  }

  range(start, end, step, type = 'float32') {
    this.checkOwnership();
    const { shape, bounds } = rangePlan(start, end, step, type), result = this.output(shape, type, bounds);
    const [x, y] = this.grid(Math.ceil(result.length / 64));
    this.dispatchTensors(this.engine.typed?.[`range:${type}`], [result], Uint32Array.of(result.length, x,
      type === 'int32' ? start >>> 0 : floatBits(start), type === 'int32' ? step >>> 0 : floatBits(step)), x, y);
    return result;
  }

  equal(a, b) {
    return this.compare('Equal', a, b);
  }

  compare(operation, a, b) {
    this.checkOwnership(a, b);
    if (a.dataType !== b.dataType || (operation === 'And' && a.dataType !== 'bool')) throw new Error('Comparison requires matching supported tensor types.');
    const shape = broadcastShape(a.shape, b.shape), result = this.output(shape, 'bool', { min: 0, max: 1 });
    const [x, y] = this.grid(Math.ceil(result.length / 64)), parameters = new Uint32Array(32);
    parameters.set([result.length, shape.length, 0, 0, 0, 0, 0, x]); parameters.set(shape, 8);
    parameters.set(broadcastStrides(a.shape, shape), 16); parameters.set(broadcastStrides(b.shape, shape), 24);
    this.dispatchTensors(this.engine.typed?.[`compare:${operation}:${a.dataType}`], [a, b, result], parameters, x, y);
    return result;
  }

  where(condition, yes, no) {
    this.checkOwnership(condition, yes, no);
    if (condition.dataType !== 'bool' || yes.dataType !== no.dataType) throw new Error('Where requires bool conditions and matching alternatives.');
    const shape = broadcastShape(broadcastShape(condition.shape, yes.shape), no.shape);
    const bounds = yes.bounds && no.bounds ? { min: Math.min(yes.bounds.min, no.bounds.min), max: Math.max(yes.bounds.max, no.bounds.max) } : null;
    const result = this.output(shape, yes.dataType, bounds), [x, y] = this.grid(Math.ceil(result.length / 64));
    const parameters = new Uint32Array(40); parameters.set([result.length, shape.length, x]); parameters.set(shape, 8);
    parameters.set(broadcastStrides(condition.shape, shape), 16); parameters.set(broadcastStrides(yes.shape, shape), 24); parameters.set(broadcastStrides(no.shape, shape), 32);
    this.dispatchTensors(this.engine.typed?.[`where:${yes.dataType}`], [condition, yes, no, result], parameters, x, y);
    return result;
  }

  expand(input, target) {
    this.checkOwnership(input);
    const shape = broadcastShape(input.shape, target);
    return this.index(input, { shape, strides: broadcastStrides(input.shape, shape), offset: 0 });
  }

  validationFlag() {
    if (!this.validationTensor) {
      this.validationTensor = this.output([1], 'int32');
      this.engine.write(this.validationTensor, Int32Array.of(0));
    }
    return this.validationTensor;
  }

  async validate() {
    if (!this.validationTensor) return;
    this.validation ??= this.engine.read(this.validationTensor, { validate: false }).then(data => {
      if (data[0]) throw new RangeError('GPU Gather index is outside its source tensor.');
    });
    await this.validation;
  }

  releaseParameters() {
    const releaseParameters = () => {
      for (const buffer of this.parameters) { buffer.destroy(); this.engine.buffers.delete(buffer); }
      this.parameters.length = 0;
    };
    const completion = this.engine.device.queue.onSubmittedWorkDone().then(releaseParameters, error => {
      this.engine.completionError = error;
      releaseParameters();
    });
    this.engine.pending.add(completion);
    completion.then(() => this.engine.pending.delete(completion));
  }

  cancel({ retainParameters = false } = {}) {
    if (this.submitted) return;
    this.submitted = true;
    this.encoder = null;
    if (!retainParameters) this.releaseParameters();
  }

  submit({ retainParameters = false } = {}) {
    this.check();
    this.engine.device.queue.submit([this.encoder.finish()]);
    this.submitted = true;
    this.encoder = null;
    if (!retainParameters) this.releaseParameters();
  }

  replay() {
    this.engine.checkOpen();
    if (!this.submitted || !this.commands) throw new Error('Only a submitted, captured batch can be replayed.');
    this.validation = null;
    if (this.validationTensor) this.engine.write(this.validationTensor, Int32Array.of(0));
    const encoder = this.engine.device.createCommandEncoder({ label: 'PageNarrator cached inference plan' });
    let pass = null;
    for (const command of this.commands) {
      if (command.copy) {
        pass?.end(); pass = null;
        encoder.copyBufferToBuffer(command.source, 0, command.destination, 0, command.bytes);
      } else {
        // Compute dispatches have separate usage scopes; only copies need a pass boundary.
        pass ??= encoder.beginComputePass();
        pass.setPipeline(command.pipeline); pass.setBindGroup(0, command.group); pass.dispatchWorkgroups(command.x, command.y, command.z);
      }
    }
    pass?.end();
    this.engine.device.queue.submit([encoder.finish()]);
  }
}
