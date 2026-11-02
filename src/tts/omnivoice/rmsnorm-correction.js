// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Ephemeral transforms of the pinned graph; cached bytes and learned weights stay unchanged.
import { decodeOnnxModel } from '../../engines/onnx-model.js';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
/** @param {Uint8Array<ArrayBuffer>[]} parts */
const join = parts => { const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0)); let at = 0; for (const part of parts) { result.set(part, at); at += part.length; } return result; };
/** @param {number|bigint} value */
function varint(value) {
  const output = []; value = BigInt(value);
  do { output.push(Number(value & 127n) | (value > 127n ? 128 : 0)); value >>= 7n; } while (value);
  return Uint8Array.from(output);
}
/** @param {number} number @param {Uint8Array<ArrayBuffer>} bytes */
const message = (number, bytes) => join([varint(number * 8 + 2), varint(bytes.length), bytes]);
/** @param {Uint8Array<ArrayBuffer>} bytes @returns {Generator<{number:number, wire:number, payload:Uint8Array<ArrayBuffer>, raw:Uint8Array<ArrayBuffer>}>} */
function* fields(bytes) {
  let position = 0;
  const read = () => {
    let value = 0n, shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (position >= bytes.length) throw new Error('Truncated protobuf value.');
      const next = bytes[position++]; value |= BigInt(next & 127) << shift;
      if (!(next & 128)) return value;
      shift += 7n;
    }
    throw new Error('Oversized protobuf value.');
  };
  while (position < bytes.length) {
    const start = position, key = Number(read()), wire = key & 7, number = key >>> 3;
    let payload = new Uint8Array();
    if (!number) throw new Error('Invalid protobuf field number.');
    if (wire === 0) read();
    else if (wire === 1) position += 8;
    else if (wire === 5) position += 4;
    else if (wire === 2) { const length = Number(read()); if (!Number.isSafeInteger(length)) throw new Error('Invalid protobuf length.'); payload = bytes.subarray(position, position + length); position += length; }
    else throw new Error('Unsupported protobuf wire type.');
    if (position > bytes.length) throw new Error('Truncated protobuf field.');
    yield { number, wire, payload, raw: bytes.subarray(start, position) };
  }
}
/** @param {Uint8Array<ArrayBuffer>} bytes */
async function hash(bytes) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join(''); }

const ORIGINAL_SHA256 = 'cab55e2fe02dc4239cf9c6674cc8f83e41c645b96db92baa02d6515c90fe745e';
const CORRECTED_SHA256 = '4ace0df24c6b611fd19f47bc5c44b482ef0e20acd868d81e4f2a2f24f807a0e0';
const PREPARED_SHA256 = '8deaf4fa4d77c8147711fda95f763b76b9d6259b93be127df95c99af896b8afb';
/** @param {number} number @param {number} value */
const integer = (number, value) => join([varint(number * 8), varint(value)]);
/** @param {number} number @param {string} value */
const string = (number, value) => message(number, encoder.encode(value));
/** @param {any} node */
const floatCast = node => join([...node.inputs.map((/** @type {string} */ name) => string(1, name)),
  ...node.outputs.map((/** @type {string} */ name) => string(2, name)), string(3, node.name), string(4, 'Cast'),
  message(5, join([string(1, 'to'), integer(3, 1), integer(20, 2)]))]);
/** @param {any} node @param {number} value */
function floatConstant(node, value) {
  const data = new Uint8Array(4); new DataView(data.buffer).setFloat32(0, value, true);
  const tensor = join([integer(2, 1), message(9, data)]);
  return join([...node.outputs.map((/** @type {string} */ name) => string(2, name)), string(3, node.name), string(4, 'Constant'),
    message(5, join([string(1, 'value'), message(5, tensor), integer(20, 4)]))]);
}

/** Qwen3RMSNorm keeps variance, inverse scale and normalization in float32,
 * then rounds the normalized tensor to half before learned-weight multiplication.
 * The export's intermediate half casts overflow actual text rows above 65,504.
 * @param {Uint8Array<ArrayBuffer>} bytes @param {boolean} audioRows */
async function transformOmniVoiceGraph(bytes, audioRows) {
  const originalSha256 = await hash(bytes);
  if (originalSha256 !== ORIGINAL_SHA256) throw new Error('RMSNorm correction requires the exact pinned OmniVoice main graph.');
  const graph = decodeOnnxModel(bytes).graph, nodes = graph.nodes;
  const named = new Map(nodes.map(node => [node.name, node]));
  const byOutput = new Map(nodes.flatMap(node => node.outputs.map(name => [name, node])));
  const prefixes = nodes.filter(node => /norm\/ReduceMean$/u.test(node.name)).map(node => node.name.slice(0, -'ReduceMean'.length));
  if (prefixes.length !== 113) throw new Error('Unexpected pinned OmniVoice RMSNorm count.');
  /** @type {Map<number, Uint8Array<ArrayBuffer>>} */
  const changed = new Map();
  for (const prefix of prefixes) {
    const mean = named.get(`${prefix}ReduceMean`), add = named.get(`${prefix}Add`), sqrt = named.get(`${prefix}Sqrt`);
    const divide = named.get(`${prefix}Div`), multiply = named.get(`${prefix}Mul`), input = named.get(`${prefix}Cast`);
    const output = named.get(`${prefix}Cast_1`), weight = named.get(`${prefix}Mul_1`);
    const meanCast = byOutput.get(add?.inputs[0] ?? ''), inputCast = byOutput.get(multiply?.inputs[0] ?? '');
    const epsilon = byOutput.get(add?.inputs[1] ?? ''), one = byOutput.get(divide?.inputs[0] ?? ''), half = byOutput.get(weight?.inputs[1] ?? '');
    if (input?.attributes.get('to')?.value !== 1 || output?.attributes.get('to')?.value !== 1
      || meanCast?.opType !== 'Cast' || meanCast.inputs[0] !== mean?.outputs[0] || meanCast.attributes.get('to')?.value !== 10
      || inputCast?.opType !== 'Cast' || inputCast.inputs[0] !== input.outputs[0] || inputCast.attributes.get('to')?.value !== 10
      || sqrt?.inputs[0] !== add?.outputs[0] || divide?.inputs[1] !== sqrt?.outputs[0]
      || multiply?.inputs[1] !== divide?.outputs[0] || output.inputs[0] !== multiply?.outputs[0]
      || half?.opType !== 'Cast' || half.inputs[0] !== output.outputs[0] || half.attributes.get('to')?.value !== 10
      || weight?.opType !== 'Mul' || epsilon?.opType !== 'Constant' || one?.opType !== 'Constant') {
      throw new Error(`Unexpected pinned OmniVoice RMSNorm signature: ${prefix}`);
    }
    changed.set(nodes.indexOf(meanCast), floatCast(meanCast));
    changed.set(nodes.indexOf(inputCast), floatCast(inputCast));
    changed.set(nodes.indexOf(epsilon), floatConstant(epsilon, 1e-6));
    changed.set(nodes.indexOf(one), floatConstant(one, 1));
  }
  const selection = audioRows ? audioRowPlan(graph) : null;
  const grouped = audioRows ? groupedAttentionPlan(graph) : null;
  const parts = [];
  for (const field of fields(bytes)) {
    if (field.number !== 7) { parts.push(field.raw); continue; }
    let index = 0;
    const graphParts = [];
    for (const item of fields(field.payload)) {
      if (item.number === 1) {
        if (index === selection?.insertion) graphParts.push(...selection.added);
        graphParts.push(...(grouped?.before.get(index) ?? []));
        const payload = grouped?.changed.get(index) ?? changed.get(index) ?? item.payload;
        graphParts.push(message(1, selection?.changed.has(index) ? selection.rewrite(payload) : payload));
        graphParts.push(...(grouped?.after.get(index) ?? []));
        index++;
      } else if (selection && item.number === 12 && [...fields(item.payload)].some(part => part.number === 1 && decoder.decode(part.payload) === 'audio_logits')) {
        graphParts.push(selection.output);
      } else if (!(grouped && item.number === 13 && [...fields(item.payload)].some(part => part.number === 1 && grouped.removedValues.has(decoder.decode(part.payload))))) graphParts.push(item.raw);
    }
    if (selection) graphParts.push(selection.input);
    parts.push(message(7, join(graphParts)));
  }
  const corrected = join(parts), modifiedSha256 = await hash(corrected);
  if (modifiedSha256 !== (audioRows ? PREPARED_SHA256 : CORRECTED_SHA256)) throw new Error(`Derived OmniVoice graph hash differs: ${modifiedSha256}.`);
  return { bytes: corrected, originalSha256, modifiedSha256, normalizationSha256: CORRECTED_SHA256, norms: 113,
    version: 'omnivoice-float32-rmsnorm-v1' + (audioRows ? '+omnivoice-generated-audio-rows-v1+omnivoice-grouped-query-v1' : ''),
    source: 'https://github.com/huggingface/transformers/blob/v5.3.0/src/transformers/models/qwen3/modeling_qwen3.py#L54-L59',
    cachePolicy: 'Only original hash-verified bytes enter CacheStorage. Derived graph is ephemeral; learned weights remain unchanged.' };
}

/** Preserve the full model interface for independent numerical controls.
 * @param {Uint8Array<ArrayBuffer>} bytes */
export function applyOmniVoiceRmsNormCorrection(bytes) { return transformOmniVoiceGraph(bytes, false); }

/** Apply the pinned playback transforms in one parse/write pass at playback initialization.
 * @param {Uint8Array<ArrayBuffer>} bytes */
export function prepareOmniVoiceGraph(bytes) { return transformOmniVoiceGraph(bytes, true); }

/** @param {import('../../engines/onnx-model.js').OnnxGraph} graph */
function audioRowPlan(graph) {
  const hidden = '/llm/norm/Mul_1_output_0', selected = 'pn_audio_hidden', start = 'pn_audio_start';
  const targets = new Set(['/Shape', '/Shape_1', '/audio_heads/MatMul']);
  const changed = new Set(graph.nodes.flatMap((node, index) => targets.has(node.name) ? [index] : []));
  const insertion = Math.min(...changed);
  const head = graph.nodes.find(node => node.name === '/audio_heads/MatMul');
  const weight = graph.initializers.find(tensor => tensor.name === head?.inputs[1]);
  if (changed.size !== 3 || head?.opType !== 'MatMul' || head.inputs[0] !== hidden || head.attributes.size
    || weight?.dataType !== 10 || weight.dims.join(',') !== '1024,8200'
    || graph.nodes.some(node => targets.has(node.name) && node.inputs[0] !== hidden)) throw new Error('Unexpected OmniVoice audio projection signature.');
  /** @param {string} name @param {number} value */
  const constant = (name, value) => {
    const data = new Uint8Array(8); new DataView(data.buffer).setBigInt64(0, BigInt(value), true);
    return join([string(2, name), string(3, name), string(4, 'Constant'),
      message(5, join([string(1, 'value'), message(5, join([integer(1, 1), integer(2, 7), message(9, data)])), integer(20, 4)]))]);
  };
  /** @param {string} name @param {number} type @param {(number|string)[]} dims */
  const info = (name, type, dims) => join([string(1, name), message(2, message(1, join([integer(1, type),
    message(2, join(dims.map(dim => message(1, typeof dim === 'number' ? integer(1, dim) : string(2, dim)))))])))]);
  const added = [constant('pn_audio_end', Number.MAX_SAFE_INTEGER), constant('pn_audio_axis', 1),
    join([...[hidden, start, 'pn_audio_end', 'pn_audio_axis'].map(name => string(1, name)),
      string(2, selected), string(3, selected), string(4, 'Slice')])].map(node => message(1, node));
  return { insertion, changed, added, input: message(11, info(start, 7, [1])),
    output: message(12, info('audio_logits', 10, ['batch', 8, 'generated_frames', 1025])),
    /** @param {Uint8Array<ArrayBuffer>} payload */
    rewrite: payload => join([...fields(payload)].map(part => part.number === 1 && decoder.decode(part.payload) === hidden ? string(1, selected) : part.raw)) };
}

/** @param {import('../../engines/onnx-model.js').OnnxGraph} graph */
function groupedAttentionPlan(graph) {
  const nodes = graph.nodes, named = new Map(nodes.map(node => [node.name, node]));
  const producers = new Map(nodes.flatMap(node => node.outputs.map(name => [name, node])));
  const consumers = new Map();
  for (const node of nodes) for (const name of node.inputs) consumers.set(name, (consumers.get(name) ?? 0) + 1);
  /** @type {Map<number, Uint8Array<ArrayBuffer>>} */
  const changed = new Map();
  /** @type {Map<number, Uint8Array<ArrayBuffer>[]>} */
  const before = new Map(), after = new Map();
  const removedValues = new Set();
  /** @param {string} name @param {string} op @param {string[]} inputs @param {string[]} [outputs] @param {Uint8Array<ArrayBuffer>[]} [attrs] */
  const nodeBytes = (name, op, inputs, outputs = [name], attrs = []) => join([
    ...inputs.map(value => string(1, value)), ...outputs.map(value => string(2, value)), string(3, name), string(4, op), ...attrs]);
  const axis = message(5, join([string(1, 'axis'), integer(3, 0), integer(20, 2)]));
  /** @param {string} name @param {number[]} values */
  const constant = (name, values) => {
    const data = new Uint8Array(values.length * 8), view = new DataView(data.buffer);
    values.forEach((value, i) => view.setBigInt64(i * 8, BigInt(value), true));
    return nodeBytes(name, 'Constant', [], [name], [message(5, join([string(1, 'value'),
      message(5, join([integer(1, values.length), integer(2, 7), message(9, data)])), integer(20, 4)]))]);
  };
  /** @param {Map<number, Uint8Array<ArrayBuffer>[]>} map @param {number} index @param {Uint8Array<ArrayBuffer>} payload */
  const insert = (map, index, payload) => {
    const existing = map.get(index), item = message(1, payload);
    if (existing) existing.push(item); else map.set(index, [item]);
  };
  /** @param {import('../../engines/onnx-model.js').OnnxNode} node @param {string} op @param {string[]} inputs @param {string[]} [outputs] @param {Uint8Array<ArrayBuffer>[]} [attrs] */
  const replace = (node, op, inputs, outputs = node.outputs, attrs = []) => changed.set(nodes.indexOf(node), nodeBytes(node.name, op, inputs, outputs, attrs));
  let first = -1;
  for (let layer = 0; layer < 28; layer++) {
    const p = `/llm/layers.${layer}/self_attn/`, stem = `pn_gqa_${layer}_`;
    const key = named.get(p + 'Expand'), keyShape = named.get(p + 'Reshape_4'), transpose = named.get(p + 'Transpose_3');
    const value = named.get(p + 'Expand_1'), valueShape = named.get(p + 'Reshape_6');
    const qk = named.get(p + 'MatMul'), pv = named.get(p + 'MatMul_1'), cast = producers.get(qk?.inputs[1] ?? '');
    const keyInput = producers.get(key?.inputs[0] ?? ''), valueInput = producers.get(value?.inputs[0] ?? '');
    if (key?.opType !== 'Expand' || value?.opType !== 'Expand' || keyShape?.opType !== 'Reshape' || valueShape?.opType !== 'Reshape'
      || keyShape.inputs[0] !== key.outputs[0] || valueShape.inputs[0] !== value.outputs[0]
      || transpose?.opType !== 'Transpose' || transpose.inputs[0] !== keyShape.outputs[0] || transpose.attributes.get('perm')?.value.join(',') !== '0,1,3,2'
      || qk?.opType !== 'MatMul' || pv?.opType !== 'MatMul' || qk.attributes.size || pv.attributes.size
      || cast?.opType !== 'Cast' || cast.attributes.get('to')?.value !== 10 || cast.inputs[0] !== transpose.outputs[0] || pv.inputs[1] !== valueShape.outputs[0]
      || keyInput?.opType !== 'Unsqueeze' || keyInput.inputs[0] !== `present_key_${layer}`
      || valueInput?.opType !== 'Unsqueeze' || valueInput.inputs[0] !== `present_value_${layer}`
      || [key, keyShape, transpose, cast, value, valueShape].some(node => consumers.get(node.outputs[0]) !== 1 || graph.outputs.some(output => output.name === node.outputs[0]))) {
      throw new Error(`Unexpected OmniVoice grouped attention signature: ${p}`);
    }
    for (const node of [key, keyShape, transpose, cast, value, valueShape]) removedValues.add(node.outputs[0]);
    const insertion = nodes.indexOf(key); if (first < 0) first = insertion;
    const shape = stem + 'shape', length = stem + 'length', flat = stem + 'flat', grouped = stem + 'grouped';
    insert(before, insertion, nodeBytes(shape, 'Shape', [key.inputs[0]]));
    insert(before, insertion, nodeBytes(length, 'Gather', [shape, 'pn_gqa_sequence_axis'], [length], [axis]));
    insert(before, insertion, nodeBytes(flat, 'Concat', ['pn_gqa_flat_prefix', length], [flat], [axis]));
    insert(before, insertion, nodeBytes(grouped, 'Concat', ['pn_gqa_group_prefix', length], [grouped], [axis]));
    for (const node of [key, keyShape, value, valueShape]) replace(node, 'Identity', [node.inputs[0]]);
    replace(transpose, 'Transpose', transpose.inputs, transpose.outputs, [message(5,
      join([string(1, 'perm'), ...[0, 1, 2, 4, 3].map(value => integer(8, value)), integer(20, 7)]))]);
    for (const { node: matmul, inputShape, outputShape, suffix } of [
      { node: qk, inputShape: 'pn_gqa_query_shape', outputShape: flat, suffix: 'qk' },
      { node: pv, inputShape: grouped, outputShape: 'pn_gqa_output_shape', suffix: 'pv' },
    ]) {
      const input = stem + suffix + '_input', output = stem + suffix + '_output';
      insert(before, nodes.indexOf(matmul), nodeBytes(input, 'Reshape', [matmul.inputs[0], inputShape]));
      replace(matmul, 'MatMul', [input, matmul.inputs[1]], [output]);
      insert(after, nodes.indexOf(matmul), nodeBytes(stem + suffix + '_restore', 'Reshape', [output, outputShape], matmul.outputs));
    }
  }
  const constants = [constant('pn_gqa_sequence_axis', [3]), constant('pn_gqa_query_shape', [1, 8, 2, -1, 128]),
    constant('pn_gqa_output_shape', [1, 16, -1, 128]), constant('pn_gqa_flat_prefix', [1, 16, -1]), constant('pn_gqa_group_prefix', [1, 8, 2, -1])].map(value => message(1, value));
  before.set(first, [...constants, ...(before.get(first) ?? [])]);
  return { changed, before, after, removedValues };
}
