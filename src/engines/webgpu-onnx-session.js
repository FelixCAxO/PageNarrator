import {fuseHalfRotaryEmbeddings,executeHalfRotary} from './onnx-rotary.js';
// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { decodeOnnxModel } from './onnx-model.js';
import { constantIntegers, constantNumbers, tensorBytes } from './onnx-tensor.js';
import { GPU_BINARY_OPERATIONS, GPU_UNARY_OPERATIONS, WebGpuCompute } from './webgpu-compute.js';
import { IntegerRangeProofError, modelFeed } from './bounded-integers.js';
import { eliminateHalfCastRoundTrips, fuseHalfScaledMaskedSoftmax, fuseHalfSiluGates, fuseSnakeActivations, fuseZeroInsertConvolutions, reuseIdenticalTransforms } from './onnx-optimize.js';
import { fuseHalfRmsNorms, fuseHalfRmsNormTransposes } from './onnx-rmsnorm.js';
import { executeIndexNode, metadataTensor } from './onnx-metadata.js';
import { bindExternalData } from './onnx-external-data.js';
import { floatToHalf, halfToFloat, ONNX_TYPES, tensorArray } from './tensor-format.js';
import { tensorSize } from './tensor-shape.js';
import { selectExecutionPlan } from './onnx-execution-plan.js';
import { executeMetadataMath } from './onnx-metadata-math.js';
import { createKokoroKernels } from './kokoro-kernels.js';
import { METADATA_LIMIT, indexRangeInputNames, metadataInputNames, metadataParameters } from './onnx-metadata-inputs.js';
import { axisIndex, slicePlan, transposePlan } from './index-shape.js';

const OPERATORS = new Set([...Object.keys(GPU_BINARY_OPERATIONS), ...Object.keys(GPU_UNARY_OPERATIONS),
  'Constant', 'Conv', 'ConvTranspose', 'GlobalAveragePool', 'ReduceMean', 'ReduceMax', 'ReduceSum', 'MaxPool', 'AveragePool', 'Resize', 'Concat',
  'BatchNormalization', 'InstanceNormalization', 'MatMul', 'Shape', 'Slice', 'Gather', 'Reshape', 'Squeeze', 'Unsqueeze', 'Transpose', 'Softmax', 'ArgMax', 'Pad', 'GridSample',
  'Cast', 'Where', 'Equal', 'Expand', 'ConstantOfShape', 'Gemm', 'LayerNormalization', 'LSTM', 'STFT',
  'DynamicQuantizeLinear', 'DequantizeLinear', 'MatMulInteger', 'ConvInteger', 'Split', 'Range', 'Greater', 'GreaterOrEqual', 'Less', 'And',
  'Round', 'Floor', 'Atan', 'LeakyRelu', 'Clip', 'CumSum', 'NonZero', 'ScatterND', 'Einsum', 'ReduceL2']);
const MICROSOFT_OPERATORS = new Set(['DynamicQuantizeLSTM', 'FastGelu', 'SkipLayerNormalization', 'FusedMatMul']);
const KOKORO_OPERATORS = new Set(['Gemm', 'LayerNormalization', 'LSTM', 'STFT', 'DynamicQuantizeLinear', 'DequantizeLinear',
  'MatMulInteger', 'ConvInteger', 'Round', 'Floor', 'Atan', 'LeakyRelu', 'Clip', 'CumSum', 'ScatterND']);
const text = new TextDecoder('utf-8', { fatal: true });

function planStorageBytes(plans) {
  const buffers = new Set(); let other = 0;
  for (const plan of plans) {
    if (plan.buffers) for (const buffer of plan.buffers) buffers.add(buffer);
    else other += plan.stats.planBytes;
  }
  return other + [...buffers].reduce((sum, buffer) => sum + buffer.size, 0);
}

function attributes(node) {
  return Object.fromEntries([...node.attributes].map(([key, item]) =>
    [key, item.type === 3 ? text.decode(item.value) : item.value]));
}

function rejectUnknown(attrs, allowed, op) {
  for (const key of Object.keys(attrs)) if (!allowed.includes(key)) throw new Error(`${op} attribute ${key} is unsupported.`);
}

function spatialOptions(attrs) {
  return { strides: attrs.strides, dilations: attrs.dilations, pads: attrs.pads, autoPad: attrs.auto_pad ?? 'NOTSET' };
}

// Use the existing fp32 kernels for operations without a half-precision kernel.
function computeWithFloat32(batch, operation, ...original) {
  if (original[0].dataType !== 'float16') return operation(...original);
  const float = original.map(tensor => tensor?.dataType === 'float16' ? batch.cast(tensor, 1) : tensor);
  const result = operation(...float);
  const output = batch.cast(result, 10);
  float.forEach((tensor, i) => { if (tensor !== original[i]) batch.recycle(tensor); });
  batch.recycle(result);
  return output;
}

function requiresFloat16(graph) {
  return [...graph.initializers, ...graph.inputs, ...graph.outputs, ...graph.values].some(tensor => tensor.dataType === 10)
    || graph.nodes.some(node => (node.opType === 'Cast' && node.attributes.get('to')?.value === 10)
      || [...node.attributes.values()].some(attribute => attribute.type === 4 ? attribute.value?.dataType === 10
        : attribute.type === 9 && attribute.value.some(tensor => tensor.dataType === 10)));
}

// The pinned voice encoder export appends two Concat producers after their consumers.
function orderNodes(nodes) {
  const producers = new Map(nodes.flatMap(node => node.outputs.filter(Boolean).map(name => [name, node])));
  const pending = new Set();
  const ordered = new Set();
  const visit = node => {
    if (ordered.has(node)) return;
    if (pending.has(node)) throw new Error('Cannot order cyclic ONNX graph.');
    pending.add(node);
    for (const name of node.inputs) {
      const producer = producers.get(name);
      if (producer) visit(producer);
    }
    pending.delete(node);
    ordered.add(node);
  };
  nodes.forEach(visit);
  return [...ordered];
}

/** An explicit subset of ONNX, with no third-party executable inference code. */
export class WebGpuOnnxSession {
  static async create(bytes, { engine = null, maxPlanBytes = 128 * 1024 * 1024, maxCachedPlans = 1, externalData = [], releaseHostWeights = false, repairNodeOrder = false } = {}) {
    if (!Number.isSafeInteger(maxPlanBytes) || maxPlanBytes < 0) throw new RangeError('Invalid execution-plan memory limit.');
    if (![1, 2].includes(maxCachedPlans)) throw new RangeError('An inference session supports one or two bounded execution plans.');
    const model = bindExternalData(decodeOnnxModel(bytes), externalData);
    if (repairNodeOrder) model.graph.nodes = orderNodes(model.graph.nodes);
    const unsupported = [...new Set(model.graph.nodes.filter(node => node.domain === 'com.microsoft'
      ? !MICROSOFT_OPERATORS.has(node.opType) : !OPERATORS.has(node.opType) || (node.domain && node.domain !== 'ai.onnx')).map(node => `${node.domain ? `${node.domain}::` : ''}${node.opType}`))];
    if (unsupported.length || model.functions.length) throw new Error(`Unsupported ONNX graph: ${unsupported.join(', ') || 'model-local functions'}.`);
    const ownsEngine = !engine;
    const float16 = requiresFloat16(model.graph);
    if (float16 && engine?.device && !engine.device.features.has('shader-f16')) {
      throw new Error('The shared WebGPU device does not support this fp16 model (shader-f16).');
    }
    engine ??= await WebGpuCompute.create({ float16 });
    let session;
    try {
      await engine.prepareCnn();
      session = new WebGpuOnnxSession(model, engine, ownsEngine, maxPlanBytes, maxCachedPlans);
      if (session.nodes.some(node => KOKORO_OPERATORS.has(node.opType)
        || node.domain === 'com.microsoft')) session.kokoro = engine.createKokoroKernels ? await engine.createKokoroKernels() : await createKokoroKernels(engine);
      // Keep the waveform oracle's arithmetic out of unrelated OCR and transformer graphs.
      if (['LSTM', 'STFT'].every(op => session.nodes.some(node => node.opType === op))) session.numericPipelines = session.kokoro?.arithmetic;
      if (releaseHostWeights) session.releaseHostWeights();
      return session;
    } catch (error) {
      if (session) await session.dispose();
      else if (ownsEngine) await engine.dispose();
      throw error;
    }
  }

  constructor(model, engine, ownsEngine, maxPlanBytes, maxCachedPlans = 1) {
    this.model = model;
    this.engine = engine;
    this.ownsEngine = ownsEngine;
    this.initializers = new Map();
    this.weights = new Map();
    this.closed = false;
    this.maxPlanBytes = maxPlanBytes;
    this.maxCachedPlans = maxCachedPlans;
    this.cachedPlans = new Map();
    this.cachedPlan = null;
    this.numericPipelines = null;
    this.lastInputKey = null;
    this.booleanFeeds = new Map();
    this.workspacePlans = new Map();
    for (const [kind, infos] of [['input', model.graph.inputs], ['output', model.graph.outputs]]) {
      const unique = new Set();
      for (const info of infos) {
        if (!info.name || unique.has(info.name) || !ONNX_TYPES[info.dataType]) throw new Error(`Unsupported or duplicate graph ${kind} name/type.`);
        unique.add(info.name);
      }
    }
    for (const tensor of model.graph.initializers) {
      if (!tensor.name || this.initializers.has(tensor.name)) throw new Error('Graph contains an unnamed or duplicate initializer.');
      this.initializers.set(tensor.name, tensor);
    }
    this.nodes = [];
    for (const node of model.graph.nodes) {
      const attrs = attributes(node);
      if (node.opType !== 'Constant') { this.nodes.push({ ...node, attrs }); continue; }
      rejectUnknown(attrs, ['value'], 'Constant');
      if (node.inputs.length || node.outputs.length !== 1 || !node.outputs[0] || this.initializers.has(node.outputs[0])
        || model.graph.inputs.some(info => info.name === node.outputs[0])
        || node.attributes.get('value')?.type !== 4) throw new Error('Constant requires one unique tensor value.');
      this.initializers.set(node.outputs[0], { ...attrs.value, name: node.outputs[0] });
    }
    const names = new Set([...this.initializers.keys(), ...model.graph.inputs.map(input => input.name)]);
    for (const node of this.nodes) {
      if (node.inputs.some(name => name && !names.has(name))) throw new Error(`Node ${node.name || node.opType} has a missing or out-of-order input.`);
      if (!node.outputs.some(Boolean)) throw new Error(`Node ${node.name || node.opType} requires a named output.`);
      for (const name of node.outputs) if (name) {
        if (names.has(name)) throw new Error(`Node ${node.name || node.opType} has a duplicate output.`);
        names.add(name);
      }
    }
    if (model.graph.outputs.some(output => !names.has(output.name))) throw new Error('Graph output is missing.');
    this.inputNames = model.graph.inputs.filter(input => !this.initializers.has(input.name)).map(input => input.name);
    this.outputNames = model.graph.outputs.map(output => output.name);
    this.nodes = fuseSnakeActivations(this.nodes, this.initializers, this.outputNames);
    this.valueTypes = new Map([...this.initializers.values(), ...model.graph.inputs, ...(model.graph.values ?? []), ...model.graph.outputs]
      .map(info => [info.name, info.dataType]));
    for (const node of this.nodes) {
      const first = this.valueTypes.get(node.inputs[0]);
      const type = node.opType === 'Cast' ? node.attrs.to : ['Shape', 'NonZero', 'ArgMax'].includes(node.opType) ? 7
        : ['Equal', 'Greater', 'GreaterOrEqual', 'Less', 'And'].includes(node.opType) ? 9
          : ['MatMulInteger', 'ConvInteger'].includes(node.opType) ? 6 : ['Where', 'DequantizeLinear'].includes(node.opType) ? this.valueTypes.get(node.inputs[1])
            : node.opType === 'ConstantOfShape' ? node.attrs.value?.dataType ?? 1 : first;
      node.outputs.forEach((name, i) => {
        if (name && !this.valueTypes.has(name)) this.valueTypes.set(name, node.opType === 'DynamicQuantizeLinear' ? [2, 1, 2][i] : type);
      });
    }
    if (typeof engine.rmsNorm === 'function') this.nodes = fuseHalfRmsNorms(this.nodes, this.initializers, this.valueTypes);
    if (typeof engine.siluGate === 'function') this.nodes = fuseHalfSiluGates(this.nodes, this.valueTypes);
    if (engine.half?.scaledMaskedSoftmax) this.nodes = fuseHalfScaledMaskedSoftmax(this.nodes, this.initializers, this.valueTypes);
    this.nodes = eliminateHalfCastRoundTrips(this.nodes, this.valueTypes);
    this.nodes = reuseIdenticalTransforms(this.nodes);
    if (engine.half?.rmsNormTranspose128) this.nodes = fuseHalfRmsNormTransposes(this.nodes, this.initializers, this.valueTypes);
    if (engine.half?.rotary) this.nodes = fuseHalfRotaryEmbeddings(this.nodes, this.valueTypes);
    if (engine.cnn?.convZeroInsert1d) this.nodes = fuseZeroInsertConvolutions(this.nodes, this.initializers, this.outputNames,
      new Map([...this.initializers.values(), ...model.graph.inputs, ...(model.graph.values ?? []), ...model.graph.outputs].map(info => [info.name, info])), Boolean(engine.cnn.convZeroTail1d));
    this.metadataInputs = metadataInputNames(this.nodes, this.inputNames);
    this.indexRangeInputs = engine instanceof WebGpuCompute ? indexRangeInputNames(this.nodes, this.inputNames, this.valueTypes, this.metadataInputs) : new Set();
    this.rangeExpansionApplied = false;
  }

  weight(name) {
    if (!this.weights.has(name)) {
      const tensor = this.initializers.get(name);
      if (!tensor) throw new Error(`Missing tensor ${name}.`);
      const bytes = tensorBytes(tensor), type = ONNX_TYPES[tensor.dataType];
      const limit = this.engine.device?.limits.maxStorageBufferBindingSize ?? Infinity;
      this.weights.set(name, bytes.byteLength > limit ? this.engine.uploadSharded(bytes, tensor.dims, type) : this.engine.uploadBytes(bytes, tensor.dims, type));
    }
    return this.weights.get(name);
  }

  releaseHostWeights() {
    // Metadata constants must own their bytes, or a tiny view pins the complete model payload.
    for (const [name, tensor] of this.initializers) {
      if ([1, 2, 3, 10].includes(tensor.dataType) && tensorSize(tensor.dims) > 1024) {
        this.weight(name);
        tensor.rawData = null;
        tensor.typedData.clear();
      } else {
        tensor.rawData = tensorBytes(tensor).slice();
        tensor.typedData.clear();
      }
    }
    for (const node of this.nodes) {
      for (const attribute of node.attributes.values()) {
        if (attribute.type !== 4) continue;
        const tensor = attribute.value;
        tensor.rawData = tensorBytes(tensor).slice();
        tensor.typedData.clear();
      }
      // Execution uses decoded attrs; protobuf string/literal views still reference the model buffer.
      node.attributes = new Map();
    }
    this.model.graph.nodes = [];
    this.model.graph.initializers = [];
  }

  numbers(name, values, integerBounds = false) {
    const item = values.get(name);
    if (item?.cpu) return item.data;
    if (item) throw new Error(`Shape parameter ${name} cannot require a GPU readback.`);
    const tensor = this.initializers.get(name);
    if (!tensor) throw new Error(`Shape parameter ${name} must be a constant initializer.`);
    return integerBounds && [6, 7].includes(tensor.dataType) ? constantIntegers(tensor) : constantNumbers(tensor);
  }

  execute(node, batch, value, numbers, descriptor, asGpu, metadataValue) {
    const a = node.attrs;
    const metadata = executeMetadataMath(node, { value: metadataValue, numbers });
    if (metadata) return metadata;
    const indexValue = name => {
      const tensor = this.initializers.get(name);
      return !tensor || ![1, 10].includes(tensor.dataType) || tensorSize(tensor.dims) > 1024 ? value(name) : metadataValue(name);
    };
    const indexResult = executeIndexNode(node, { value: indexValue, numbers, descriptor, batch, asGpu });
    if (indexResult) return indexResult;
    const input = asGpu(value(node.inputs[0]));
    if (Object.hasOwn(GPU_BINARY_OPERATIONS, node.opType)) {
      rejectUnknown(a, [], node.opType);
      return batch.binary(node.opType, asGpu(input), asGpu(value(node.inputs[1])));
    }
    if (Object.hasOwn(GPU_UNARY_OPERATIONS, node.opType)) {
      rejectUnknown(a, node.opType === 'HardSigmoid' ? ['alpha', 'beta'] : node.opType === 'Elu' ? ['alpha'] : [], node.opType);
      return batch.unary(node.opType, asGpu(input), node.opType === 'Elu' ? { alpha: a.alpha ?? 1 } : a);
    }
    switch (node.opType) {
      case 'FusedHalfScaledMaskedSoftmax': return batch.scaledMaskedSoftmax(input, asGpu(value(node.inputs[1])), asGpu(value(node.inputs[2])));
      case 'ConstantOfShape': {
        rejectUnknown(a, ['value'], node.opType);
        const fill = a.value ? constantNumbers(a.value) : [0], type = a.value?.dataType ?? 1;
        if (fill.length !== 1) throw new Error('ConstantOfShape requires one fill value.');
        return batch.fill(numbers(node.inputs[0]), fill[0], type === 7 ? 'int32' : ONNX_TYPES[type]);
      }
      case 'Range': {
        rejectUnknown(a, [], node.opType);
        const type = value(node.inputs[0]).dataType;
        return batch.range(...node.inputs.map(name => numbers(name)[0]), type === 7 ? 'int32' : ONNX_TYPES[type]);
      }
      case 'Round': case 'Floor': case 'Atan': case 'LeakyRelu': case 'Clip': {
        rejectUnknown(a, node.opType === 'LeakyRelu' ? ['alpha'] : node.opType === 'Clip' ? ['min', 'max'] : [], node.opType);
        const min = node.inputs[1] ? numbers(node.inputs[1])[0] : a.min;
        const max = node.inputs[2] ? numbers(node.inputs[2])[0] : a.max;
        if (node.opType === 'Clip' && input.dataType === 'int32') return batch.clipInteger(input, min, max);
        return this.kokoro.unary(batch, input, node.opType, { alpha: a.alpha, min, max });
      }
      case 'CumSum': {
        rejectUnknown(a, ['exclusive', 'reverse'], node.opType);
        return this.kokoro.cumsum(batch, input, numbers(node.inputs[1])[0], a);
      }
      case 'ScatterND': {
        rejectUnknown(a, ['reduction'], node.opType);
        if (a.reduction && a.reduction !== 'none') throw new Error('ScatterND reduction is unsupported.');
        return this.kokoro.scatterNd(batch, input, numbers(node.inputs[1]), descriptor(node.inputs[1]).shape, asGpu(value(node.inputs[2])));
      }
      case 'DynamicQuantizeLinear': {
        rejectUnknown(a, [], node.opType);
        return this.kokoro.dynamicQuantizeLinear(batch, input);
      }
      case 'DequantizeLinear': {
        rejectUnknown(a, ['axis'], node.opType);
        return this.kokoro.dequantizeLinear(batch, input, asGpu(value(node.inputs[1])), node.inputs[2] ? asGpu(value(node.inputs[2])) : null, a);
      }
      case 'MatMulInteger': {
        rejectUnknown(a, [], node.opType);
        return this.kokoro.matmulInteger(batch, input, asGpu(value(node.inputs[1])),
          node.inputs[2] ? asGpu(value(node.inputs[2])) : null, node.inputs[3] ? asGpu(value(node.inputs[3])) : null);
      }
      case 'ConvInteger': {
        rejectUnknown(a, ['strides', 'dilations', 'pads', 'auto_pad', 'group', 'kernel_shape'], node.opType);
        const weight = asGpu(value(node.inputs[1]));
        if (a.kernel_shape && a.kernel_shape.some((dim, i) => dim !== weight.shape[i + 2])) throw new Error('Integer convolution kernel_shape differs from weights.');
        return this.kokoro.convInteger(batch, input, weight, node.inputs[2] ? asGpu(value(node.inputs[2])) : null,
          node.inputs[3] ? asGpu(value(node.inputs[3])) : null, { ...spatialOptions(a), group: a.group ?? 1 });
      }
      case 'DynamicQuantizeLSTM': {
        rejectUnknown(a, ['hidden_size', 'direction', 'input_forget'], node.opType);
        if (node.inputs[4] || node.inputs[7] || a.input_forget || !node.inputs[3] || !node.inputs[5] || !node.inputs[6]) throw new Error('Quantized LSTM requires full sequences, explicit initial states and uncoupled gates without peepholes.');
        return this.kokoro.dynamicQuantizeLstm(batch, input, ...[1, 2, 3, 5, 6, 8, 9, 10, 11].map(i => asGpu(value(node.inputs[i]))),
          { hiddenSize: a.hidden_size, direction: a.direction ?? 'forward' });
      }
      case 'FastGelu': {
        rejectUnknown(a, [], node.opType);
        return this.kokoro.fastGelu(batch, input, node.inputs[1] ? asGpu(value(node.inputs[1])) : null);
      }
      case 'SkipLayerNormalization': {
        rejectUnknown(a, ['epsilon'], node.opType);
        return this.kokoro.skipLayerNormalization(batch, input, asGpu(value(node.inputs[1])), asGpu(value(node.inputs[2])),
          node.inputs[3] ? asGpu(value(node.inputs[3])) : null, node.inputs[4] ? asGpu(value(node.inputs[4])) : null, a);
      }
      case 'FusedMatMul': {
        rejectUnknown(a, ['alpha', 'transA', 'transB', 'transBatchA', 'transBatchB'], node.opType);
        return this.kokoro.fusedMatmul(batch, input, asGpu(value(node.inputs[1])), a);
      }
      case 'Split': {
        rejectUnknown(a, ['axis', 'split', 'num_outputs'], node.opType);
        const axis = axisIndex(a.axis ?? 0, input.shape.length), count = node.outputs.length;
        if (a.num_outputs !== undefined && (a.num_outputs !== count || node.inputs[1] || a.split)) {
          throw new RangeError('Split num_outputs must match its outputs and cannot be combined with split sizes.');
        }
        const width = input.shape[axis] / count;
        const sizes = node.inputs[1] ? numbers(node.inputs[1]) : a.split ?? new Array(count).fill(width);
        if (a.num_outputs !== undefined) {
          sizes.fill(Math.ceil(width));
          sizes[count - 1] = input.shape[axis] - (count - 1) * sizes[0];
        }
        if (sizes.length !== count || sizes.some(size => !Number.isSafeInteger(size) || size < 0)
          || sizes.reduce((sum, size) => sum + size, 0) !== input.shape[axis]) throw new RangeError('Split sizes must exactly partition their axis.');
        let offset = 0;
        return sizes.map(size => { const result = batch.index(input, slicePlan(input.shape, [offset], [offset + size], [axis])); offset += size; return result; });
      }
      case 'Gemm': {
        rejectUnknown(a, ['alpha', 'beta', 'transA', 'transB'], node.opType);
        return this.kokoro.gemm(batch, input, asGpu(value(node.inputs[1])), node.inputs[2] ? asGpu(value(node.inputs[2])) : null, a);
      }
      case 'LayerNormalization': {
        rejectUnknown(a, ['axis', 'epsilon', 'stash_type'], node.opType);
        if (a.stash_type !== undefined && a.stash_type !== 1) throw new Error('LayerNormalization requires fp32 statistics.');
        const scale = asGpu(value(node.inputs[1]));
        const bias = node.inputs[2] ? asGpu(value(node.inputs[2])) : null;
        return computeWithFloat32(batch, (x, w, b) => this.kokoro.layerNormalization(batch, x, w, b, a), input, scale, bias);
      }
      case 'LSTM': {
        rejectUnknown(a, ['hidden_size', 'direction'], node.opType);
        if (node.inputs[4] || !node.inputs[3] || !node.inputs[5] || !node.inputs[6]) throw new Error('This LSTM requires full sequences and explicit bias/initial states.');
        return this.kokoro.lstm(batch, input, ...[1, 2, 3, 5, 6].map(i => asGpu(value(node.inputs[i]))),
          { hiddenSize: a.hidden_size, direction: a.direction ?? 'forward' });
      }
      case 'STFT': {
        rejectUnknown(a, ['onesided'], node.opType);
        return this.kokoro.stft(batch, input, asGpu(value(node.inputs[2])),
          { frameStep: numbers(node.inputs[1])[0], frameLength: numbers(node.inputs[3])[0], onesided: a.onesided ?? 1 });
      }
      case 'Cast': {
        rejectUnknown(a, ['to', 'saturate'], node.opType);
        if (a.saturate !== undefined && a.saturate !== 1) throw new Error('Only the default saturating Cast attribute is supported.');
        return batch.cast(asGpu(input), a.to);
      }
      case 'Equal': case 'Greater': case 'GreaterOrEqual': case 'Less': case 'And': {
        rejectUnknown(a, [], node.opType);
        return batch.compare(node.opType, asGpu(input), asGpu(value(node.inputs[1])));
      }
      case 'Where': {
        rejectUnknown(a, [], node.opType);
        return batch.where(asGpu(input), asGpu(value(node.inputs[1])), asGpu(value(node.inputs[2])));
      }
      case 'Expand': {
        rejectUnknown(a, [], node.opType);
        return batch.expand(asGpu(input), numbers(node.inputs[1]));
      }
      case 'FusedSnake': return batch.snake(input, asGpu(value(node.inputs[1])), asGpu(value(node.inputs[2])));
      case 'FusedHalfRmsNorm': return batch.rmsNorm(input, asGpu(value(node.inputs[1])));
      case 'FusedHalfRmsNormTranspose': return batch.rmsNormTranspose(input, asGpu(value(node.inputs[1])));
      case 'FusedHalfSiluGate': return batch.siluGate(input, asGpu(value(node.inputs[1])));
      case 'FusedHalfRotary': return executeHalfRotary(node, {input,batch,value,numbers,asGpu});
      case 'Conv': case 'ConvTranspose': case 'FusedZeroInsertConv1d': {
        rejectUnknown(a, ['strides', 'dilations', 'pads', 'auto_pad', 'group', 'kernel_shape', ...(node.opType === 'ConvTranspose' ? ['output_padding'] : []),
          ...(node.opType === 'FusedZeroInsertConv1d' ? ['zeroInsertStride', 'zeroTail'] : [])], node.opType);
        const weight = asGpu(value(node.inputs[1]));
        if (a.kernel_shape && a.kernel_shape.some((dim, i) => dim !== weight.shape[i + 2])) throw new Error('Convolution kernel_shape does not match its weights.');
        const options = { ...spatialOptions(a), group: a.group ?? 1, transpose: node.opType === 'ConvTranspose', outputPadding: a.output_padding,
          ...(node.opType === 'FusedZeroInsertConv1d' ? { zeroInsertStride: a.zeroInsertStride, zeroTail: a.zeroTail } : {}) };
        return computeWithFloat32(batch, (x, w, b) => batch.convolution(x, w, b, options),
          input, weight, node.inputs[2] ? asGpu(value(node.inputs[2])) : null);
      }
      case 'GlobalAveragePool': {
        rejectUnknown(a, [], node.opType);
        return batch.reduce(input, input.shape.slice(2).map((_, i) => i + 2), true);
      }
      case 'ReduceMean': case 'ReduceMax': case 'ReduceSum': case 'ReduceL2': {
        rejectUnknown(a, ['axes', 'keepdims', 'noop_with_empty_axes'], node.opType);
        let axes = node.inputs[1] ? numbers(node.inputs[1]) : a.axes;
        const skipReduction = !axes?.length && Boolean(a.noop_with_empty_axes);
        if (!axes?.length) axes = null;
        const keepDims = (a.keepdims ?? 1) !== 0;
        if (node.opType !== 'ReduceL2') {
          if (skipReduction) return input;
          return batch.reduce(input, axes, keepDims, { ReduceMean: 'mean', ReduceMax: 'max', ReduceSum: 'sum' }[node.opType]);
        }
        // Accumulate weight norms at full precision even for half-weight vocoders.
        const float = input.dataType === 'float16' ? batch.cast(input, 1) : input;
        const square = batch.binary('Mul', float, float);
        const sum = skipReduction ? square : batch.reduce(square, axes, keepDims, 'sum');
        const norm = batch.unary('Sqrt', sum);
        if (float !== input) batch.recycle(float);
        batch.recycle(square);
        if (sum !== square) batch.recycle(sum);
        if (float === input) return norm;
        const output = batch.cast(norm, 10);
        batch.recycle(norm);
        return output;
      }
      case 'MaxPool': case 'AveragePool': {
        rejectUnknown(a, ['kernel_shape', 'strides', 'dilations', 'pads', 'auto_pad', 'ceil_mode', 'count_include_pad', 'storage_order'], node.opType);
        if (a.storage_order) throw new Error('Column-major pooling is unsupported.');
        return batch.pool(input, { ...spatialOptions(a), kernel: a.kernel_shape, ceilMode: Boolean(a.ceil_mode),
          average: node.opType === 'AveragePool', countIncludePad: Boolean(a.count_include_pad) });
      }
      case 'Resize': {
        rejectUnknown(a, ['mode', 'coordinate_transformation_mode', 'nearest_mode', 'extrapolation_value', 'keep_aspect_ratio_policy',
          'exclude_outside', 'antialias', 'cubic_coeff_a'], node.opType);
        if ((a.extrapolation_value ?? 0) !== 0 || (a.keep_aspect_ratio_policy ?? 'stretch') !== 'stretch'
          || (a.exclude_outside ?? 0) !== 0 || (a.antialias ?? 0) !== 0 || (a.cubic_coeff_a ?? -.75) !== -.75) throw new Error('Resize requires the supported default non-cubic, non-antialiased options.');
        if (node.inputs[1] && numbers(node.inputs[1]).length) throw new Error('Resize ROI is unsupported.');
        return batch.resize(input, { scales: node.inputs[2] ? numbers(node.inputs[2]) : null,
          sizes: node.inputs[3] ? numbers(node.inputs[3]) : null,
          mode: a.mode ?? 'nearest', coordinateMode: a.coordinate_transformation_mode ?? 'half_pixel', nearestMode: a.nearest_mode ?? 'round_prefer_floor' });
      }
      case 'BatchNormalization': {
        rejectUnknown(a, ['epsilon', 'momentum', 'training_mode', 'spatial'], node.opType);
        if (a.training_mode) throw new Error('Training batch normalization is unsupported.');
        if (a.spatial !== undefined && a.spatial !== 1) throw new Error('Only spatial batch normalization is supported.');
        return batch.batchNorm(input, ...node.inputs.slice(1).map(name => asGpu(value(name))), a.epsilon ?? 1e-5);
      }
      case 'InstanceNormalization': {
        rejectUnknown(a, ['epsilon'], node.opType);
        return batch.instanceNorm(input, asGpu(value(node.inputs[1])), asGpu(value(node.inputs[2])), a.epsilon);
      }
      case 'MatMul': {
        rejectUnknown(a, [], node.opType);
        return batch.matmul(input, asGpu(value(node.inputs[1])));
      }
      case 'Einsum': {
        rejectUnknown(a, ['equation'], node.opType);
        const relative = asGpu(value(node.inputs[1]));
        if (a.equation !== 'bhld,lrd->bhlr' || node.inputs.length !== 2
          || input.shape.length !== 4 || relative.shape.length !== 3
          || input.shape[2] !== relative.shape[0] || input.shape[3] !== relative.shape[2]) {
          throw new Error('Unsupported Einsum attention contraction.');
        }
        // Treat each query position as a batch and contract the head width with MatMul.
        const queries = batch.index(input, transposePlan(input.shape, [2, 0, 1, 3]));
        const keys = batch.index(relative, transposePlan(relative.shape, [0, 2, 1]));
        const product = batch.matmul(queries, batch.view(keys, [keys.shape[0], 1, keys.shape[1], keys.shape[2]]));
        const output = batch.index(product, transposePlan(product.shape, [1, 2, 0, 3]));
        batch.recycle(queries);
        batch.recycle(keys);
        batch.recycle(product);
        return output;
      }
      case 'Softmax': {
        rejectUnknown(a, ['axis'], node.opType);
        return batch.softmax(input, a.axis ?? (this.model.opsets.find(opset => !opset.domain)?.version >= 13 ? -1 : 1));
      }
      case 'ArgMax': {
        rejectUnknown(a, ['axis', 'keepdims', 'select_last_index'], node.opType);
        return batch.argmax(input, a.axis ?? 0, Boolean(a.keepdims ?? 1), Boolean(a.select_last_index));
      }
      case 'Pad': {
        rejectUnknown(a, ['mode'], node.opType);
        const pads = numbers(node.inputs[1]), fill = node.inputs[2] ? numbers(node.inputs[2])[0] : 0;
        return computeWithFloat32(batch, x => batch.pad(x, pads, a.mode ?? 'constant', fill), input);
      }
      case 'GridSample': {
        rejectUnknown(a, ['mode', 'padding_mode', 'align_corners'], node.opType);
        return batch.gridSample(input, asGpu(value(node.inputs[1])), { mode: a.mode ?? 'bilinear', paddingMode: a.padding_mode ?? 'zeros', alignCorners: Boolean(a.align_corners) });
      }
      default: throw new Error(`Unsupported ONNX operation ${node.opType}.`);
    }
  }

  async run(feeds, outputNames = this.outputNames) {
    if (this.closed) throw new Error('The model session has been disposed.');
    if (this.running) throw new Error('The model session already has an active inference.');
    let plan = this.lastExecutionPlan;
    if (!Array.isArray(outputNames) || !plan || outputNames.length !== plan.outputNames.length
      || outputNames.some((name, index) => name !== plan.outputNames[index])) {
      plan = selectExecutionPlan(this.nodes, this.outputNames, outputNames);
      this.lastExecutionPlan = plan;
    }
    this.running = (async () => {
      this.rangeExpansionApplied = false;
      try { return await this.infer(feeds, plan); }
      catch (error) {
        if (!this.rangeExpansionApplied || !(error instanceof IntegerRangeProofError || error?.cause instanceof IntegerRangeProofError)) throw error;
        // A wider proof can reject valid correlated arithmetic; drain, then retry exact ranges once.
        this.indexRangeInputs.clear();
        return this.infer(feeds, plan);
      }
    })();
    try { return await this.running; }
    finally { this.running = null; }
  }

  async infer(feeds, plan) {
    if (!feeds || this.inputNames.some(name => !Object.hasOwn(feeds, name)) || Object.keys(feeds).some(name => !this.inputNames.includes(name))) throw new Error(`Model inputs must be: ${this.inputNames.join(', ')}.`);
    const normalized = {};
    for (const info of this.model.graph.inputs) {
      if (this.initializers.has(info.name)) continue;
      normalized[info.name] = modelFeed(info, feeds[info.name], this.booleanFeeds);
    }
    feeds = normalized;
    const hostFeeds = new Set([...this.metadataInputs].filter(name => ['int32', 'bool'].includes(feeds[name].type) && feeds[name].data.length <= METADATA_LIMIT));
    // Shared empty KV inputs need one upload; alias topology is part of the replay contract.
    const aliases = new Map();
    const aliasIds = this.inputNames.map(name => {
      const data = feeds[name].data;
      if (!aliases.has(data)) aliases.set(data, aliases.size);
      return aliases.get(data);
    });
    const key = JSON.stringify([plan.outputNames, this.inputNames.map(name => feeds[name].shape), aliasIds,
      [...hostFeeds].map(name => [name, Array.from(feeds[name].data)])]);
    const previousKey = this.lastInputKey;
    this.lastInputKey = key;
    let cached = this.cachedPlans.get(key);
    // Token ranges may shrink between diffusion steps without changing any captured proof.
    if (cached && [...cached.inputs].some(([name, tensor]) => feeds[name].bounds
      && (!tensor.bounds || feeds[name].bounds.min < tensor.bounds.min || feeds[name].bounds.max > tensor.bounds.max))) {
      await this.releasePlan(key);
      cached = null;
    }
    if (cached) {
      this.cachedPlans.delete(key); this.cachedPlans.set(key, cached); this.cachedPlan = cached;
      const written = new Set();
      for (const [name, tensor] of cached.inputs) {
        if (feeds[name].data.length !== tensor.length) throw new RangeError('Cached input data does not match its shape.');
        if (!written.has(tensor)) this.engine.write(tensor, feeds[name].data);
        written.add(tensor);
      }
      cached.batch.replay();
      const result = await this.readValidatedOutputs(cached.batch, cached.outputs);
      this.lastRun = { ...cached.stats, cacheHit: true, allocations: 0 };
      return result;
    }
    if (this.cachedPlans.size >= this.maxCachedPlans) await this.releasePlan(this.cachedPlans.keys().next().value);
    const exactAliases = new Set(this.inputNames.filter(name => !this.indexRangeInputs.has(name)).map(name => feeds[name].data));
    const values = new Map();
    const uploaded = [];
    const shareWorkspace = this.maxCachedPlans > 1 && this.engine instanceof WebGpuCompute;
    const borrowedBuffers = shareWorkspace ? [...new Set([...this.cachedPlans.values()].flatMap(plan => [...(plan.workspaceBuffers ?? [])]))] : [];
    const placeWorkspace = this.maxCachedPlans === 1 && this.engine instanceof WebGpuCompute;
    const workspacePlan = placeWorkspace ? this.workspacePlans.get(key) : null;
    let batch = this.engine.batch({ capture: true, allowSpill: true, numericPipelines: this.numericPipelines, borrowedBuffers, workspacePlan, recordWorkspace: placeWorkspace });
    const batches = [batch];
    let metadataReadbacks = 0;
    const consumers = new Map(plan.consumers);
    const references = new Map();
    const inputs = new Map();
    const sharedInputs = new Map();
    const retired = new Set();
    const holds = [];
    let retained = false;
    let completed = false;
    try {
      for (const info of this.model.graph.inputs) {
        if (this.initializers.has(info.name)) continue;
        const feed = feeds[info.name];
        if (hostFeeds.has(info.name)) {
          values.set(info.name, metadataTensor(Array.from(feed.data), feed.shape, info.dataType));
          continue;
        }
        const shapeKey = JSON.stringify([feed.shape, feed.type]);
        const shared = sharedInputs.get(feed.data) || new Map();
        let tensor = shared.get(shapeKey);
        if (!tensor) {
          const expand = feed.bounds?.min > 0 && this.indexRangeInputs.has(info.name) && !exactAliases.has(feed.data);
          tensor = expand ? this.engine.tensor(feed.shape, null, null, 'int32', Object.freeze({ min: 0, max: feed.bounds.max }))
            : feed.bounds ? this.engine.uploadInt32(feed.data, feed.shape) : this.engine.upload(feed.data, feed.shape, feed.type);
          uploaded.push(tensor);
          if (expand) { this.rangeExpansionApplied = true; this.engine.write(tensor, feed.data); }
          shared.set(shapeKey, tensor); sharedInputs.set(feed.data, shared);
        }
        values.set(info.name, tensor);
        inputs.set(info.name, tensor);
      }
      const value = name => {
        if (values.has(name)) return values.get(name);
        const initializer = this.initializers.get(name);
        return initializer && [6, 7, 9].includes(initializer.dataType) ? metadataTensor(constantNumbers(initializer), initializer.dims, initializer.dataType) : this.weight(name);
      };
      const numbers = (name, integerBounds = false) => this.numbers(name, values, integerBounds);
      const descriptor = name => values.get(name) ?? (this.initializers.has(name) ? { shape: this.initializers.get(name).dims } : value(name));
      const metadataConstants = new Map();
      const metadataValue = name => {
        if (values.has(name)) return values.get(name);
        const tensor = this.initializers.get(name);
        if (!tensor || tensorSize(tensor.dims) > 1024) return { cpu: false };
        if (!metadataConstants.has(name)) metadataConstants.set(name, metadataTensor(constantNumbers(tensor), tensor.dims, tensor.dataType));
        return metadataConstants.get(name);
      };
      const promoted = new Map();
      const asGpu = tensor => {
        if (!tensor.cpu) return tensor;
        if (!promoted.has(tensor)) {
          const type = ONNX_TYPES[tensor.dataType];
          const data = tensor.dataType === 7 ? BigInt64Array.from(tensor.data, BigInt)
            : tensor.dataType === 10 ? Uint16Array.from(tensor.data, floatToHalf) : tensorArray(type).from(tensor.data);
          const feed = modelFeed({ name: 'metadata', dataType: tensor.dataType }, { shape: tensor.shape, data });
          const result = feed.bounds ? this.engine.uploadInt32(feed.data, feed.shape) : this.engine.upload(feed.data, feed.shape, feed.type);
          promoted.set(tensor, result); uploaded.push(result);
        }
        return promoted.get(tensor);
      };
      const materialize = async name => {
        const tensor = values.get(name);
        if (!tensor || tensor.cpu) return;
        if (tensor.length > METADATA_LIMIT) throw new RangeError(`Dynamic metadata ${name} exceeds the bounded readback limit.`);
        batch.submit({ retainParameters: true });
        await batch.validate?.();
        const data = await this.engine.read(tensor);
        const type = this.valueTypes.get(name) ?? { float32: 1, float16: 10, int32: 6, bool: 9, uint8: 2, int8: 3 }[tensor.dataType];
        const numbers = Array.from(data, tensor.dataType === 'float16' ? halfToFloat : Number);
        values.set(name, metadataTensor(numbers, tensor.shape, type));
        if (tensor.batch) {
          const remaining = (references.get(tensor) ?? 1) - 1;
          references.set(tensor, remaining);
          if (!remaining) retired.add(tensor);
        }
        metadataReadbacks++;
        for (const tensor of retired) tensor.batch.outputs.delete(tensor);
        const scratch = batches.flatMap(item => item.retireScratch());
        await this.engine.releaseMany([...retired], scratch); retired.clear();
          batch = this.engine.batch({ capture: true, allowSpill: true, numericPipelines: this.numericPipelines }); batches.push(batch);
      };
      for (const node of plan.nodes) {
        try {
          for (const name of metadataParameters(node)) await materialize(name);
          if (node.opType === 'Cast' && [6, 7].includes(node.attrs.to)) {
            const input = values.get(node.inputs[0]);
            if (input && !input.cpu && ['float32', 'float16'].includes(input.dataType)) await materialize(node.inputs[0]);
          }
          const result = this.execute(node, batch, value, numbers, descriptor, asGpu, metadataValue);
          const tensors = Array.isArray(result) ? result : [result];
          if (tensors.length !== node.outputs.length) throw new Error('Operation returned an unexpected number of outputs.');
          const unused = new Set();
          node.outputs.forEach((name, i) => {
            const tensor = tensors[i];
            if (!name || !consumers.get(name)) { if (tensor?.batch === batch) unused.add(tensor); return; }
            if (!tensor) throw new Error(`Operation omitted output ${name}.`);
            values.set(name, tensor);
            if (tensor.batch) references.set(tensor, (references.get(tensor) ?? 0) + 1);
          });
          for (const tensor of unused) if (!references.get(tensor)) batch.recycle(tensor);
        }
        catch (error) { throw new Error(`ONNX ${node.opType} ${node.name || node.outputs[0]}: ${error.message}`, { cause: error }); }
        for (const name of node.inputs) {
          const count = consumers.get(name) - 1;
          consumers.set(name, count);
          const tensor = values.get(name);
          if (!count && tensor) {
            values.delete(name);
            if (tensor.batch) {
              const remaining = references.get(tensor) - 1;
              references.set(tensor, remaining);
              if (!remaining) {
                if (tensor.batch === batch) batch.recycle(tensor);
                else retired.add(tensor);
              }
            }
          }
        }
      }
      batch.submit({ retainParameters: true });
      const outputs = new Map(plan.outputNames.map(name => [name, value(name)]));
      const result = await this.readValidatedOutputs(batch, outputs);
      for (const tensor of retired) tensor.batch.outputs.delete(tensor);
      if (retired.size) { await this.engine.releaseMany([...retired]); retired.clear(); }
      const intermediateBytes = batches.reduce((sum, item) => sum + item.allocatedBytes, 0);
      const workspaceBuffers = shareWorkspace && !metadataReadbacks ? new Set(batch.workspaceBuffers) : null;
      const buffers = workspaceBuffers ? new Set([...workspaceBuffers, ...uploaded.map(tensor => tensor.buffer), ...batch.parameters,
        ...(batch.validationTensor ? [batch.validationTensor.buffer] : [])]) : null;
      const planBytes = buffers ? planStorageBytes([{ buffers }]) : intermediateBytes + uploaded.reduce((sum, tensor) => sum + tensor.buffer.size, 0)
        + batches.reduce((sum, item) => sum + item.parameters.reduce((total, buffer) => total + buffer.size, 0), 0);
      this.lastRun = { nodes: plan.nodes.length, allocations: batches.reduce((sum, item) => sum + item.allocationCount, 0),
        reusedBuffers: batches.reduce((sum, item) => sum + item.reuseCount, 0), intermediateBytes, planBytes, metadataReadbacks, cacheHit: false };
      if (workspacePlan) this.lastRun.workspacePlacement = { hits: batches[0].placementHits, fallbacks: batches[0].placementFallbacks };
      // Duration-dependent shapes must be recomputed when values change, even for identical feed shapes.
      // Alternating plans that cannot coexist must not evict each other on every pass.
      const previousPlan = this.cachedPlans.get(previousKey);
      if (!metadataReadbacks && batches.every(item => item.capture !== false) && planBytes <= this.maxPlanBytes
        && (!previousPlan || planStorageBytes([previousPlan, { buffers, stats: this.lastRun }]) <= this.maxPlanBytes)) {
        if (workspaceBuffers) for (const buffer of workspaceBuffers) holds.push(this.engine.tensor([buffer.size / 4], null, buffer));
        while (this.cachedPlans.size && planStorageBytes([...this.cachedPlans.values(), { buffers, stats: this.lastRun }]) > this.maxPlanBytes) await this.releasePlan(this.cachedPlans.keys().next().value);
        this.cachedPlan = { key, batch, inputs, uploaded, outputs, buffers, workspaceBuffers, holds, stats: this.lastRun };
        this.cachedPlans.set(key, this.cachedPlan);
        retained = true;
      }
      if (placeWorkspace) {
        // Keep only CPU placement hints for two oversized shapes; every run still releases its GPU storage.
        if (metadataReadbacks || retained || workspacePlan && (batch.placementFallbacks || batch.outputIndex !== workspacePlan.slots.length)) this.workspacePlans.delete(key);
        else if (!workspacePlan && planBytes > this.maxPlanBytes) {
          const learned = batch.planWorkspace();
          if (learned) {
            this.workspacePlans.delete(key); this.workspacePlans.set(key, learned);
            while (this.workspacePlans.size > 2) this.workspacePlans.delete(this.workspacePlans.keys().next().value);
          }
        }
      }
      completed = true;
      return result;
    } finally {
      if (!completed) this.workspacePlans.delete(key);
      for (const item of batches) if (!item.submitted) item.cancel({ retainParameters: true });
      if (!retained) await this.engine.releaseMany([...uploaded, ...batches.flatMap(item => [...item.outputs]), ...holds], batches.flatMap(item => [...item.scratchBuffers(), ...item.parameters]));
    }
  }

  async readValidatedOutputs(batch, tensors) {
    // Queue both readbacks together; validation still gates output and both settle before cleanup.
    const [validation, outputs] = await Promise.allSettled([batch.validate?.(), this.readOutputs(tensors, false)]);
    if (validation.status === 'rejected') throw validation.reason;
    if (outputs.status === 'rejected') throw outputs.reason;
    return outputs.value;
  }

  async readOutputs(tensors, validate = true) {
    const result = {};
    for (const [name, tensor] of tensors) {
      const info = this.model.graph.outputs.find(output => output.name === name);
      const type = ONNX_TYPES[info.dataType], actual = tensor.cpu ? ONNX_TYPES[tensor.dataType] : tensor.dataType;
      if ((actual !== type && !(type === 'int64' && actual === 'int32')) || (info.dims && (info.dims.length !== tensor.shape.length
        || info.dims.some((dim, i) => typeof dim === 'number' && dim !== tensor.shape[i])))) throw new Error(`Output ${name} does not match its declared shape/type.`);
      const data = tensor.cpu ? tensor.data : await this.engine.read(tensor, { validate });
      const ArrayType = tensorArray(type);
      result[name] = { data: tensor.cpu && type === 'float16' ? Uint16Array.from(data, floatToHalf)
        : data instanceof ArrayType ? data : type === 'int64' ? BigInt64Array.from(data, value => BigInt(value)) : ArrayType.from(data), shape: [...tensor.shape], type };
    }
    return result;
  }

  async releasePlan(key) {
    const plans = key === undefined ? [...this.cachedPlans.values()] : [this.cachedPlans.get(key)].filter(Boolean);
    const errors = [];
    for (const plan of plans) {
      this.cachedPlans.delete(plan.key);
      if (this.cachedPlan === plan) this.cachedPlan = null;
      try { await this.engine.releaseMany([...plan.uploaded, ...plan.batch.outputs, ...(plan.holds ?? [])], [...plan.batch.scratchBuffers(), ...plan.batch.parameters]); }
      catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Execution-plan cleanup failed.');
  }

  getRetainedPlanBytes() { return planStorageBytes(this.cachedPlans.values()); }

  async dispose() {
    if (this.disposal) return this.disposal;
    this.closed = true;
    this.disposal = (async () => {
      await this.running?.catch(() => null);
      const errors = [];
      try { await this.releasePlan(); } catch (error) { errors.push(error); }
      try {
        if (this.ownsEngine) await this.engine.dispose();
        else if (this.weights.size) await this.engine.releaseMany([...this.weights.values()].flatMap(weight => weight.shards ? weight.shards.map(shard => shard.tensor) : [weight]));
      } catch (error) { errors.push(error); }
      this.weights.clear(); this.initializers.clear(); this.valueTypes.clear(); this.metadataInputs.clear(); this.indexRangeInputs.clear(); this.booleanFeeds.clear();
      this.nodes.length = 0; this.model = null; this.cachedPlan = null; this.cachedPlans.clear(); this.workspacePlans.clear(); this.lastExecutionPlan = null; this.lastInputKey = null;
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, 'Inference session cleanup failed.');
    })();
    return this.disposal;
  }
}
