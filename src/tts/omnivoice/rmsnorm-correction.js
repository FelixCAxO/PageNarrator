// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Restore upstream float32 RMSNorm in the exact pinned export; cached bytes and learned weights stay unchanged.
import { decodeOnnxModel } from '../../engines/onnx-model.js';
const encoder = new TextEncoder();
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
 * @param {Uint8Array<ArrayBuffer>} bytes */
export async function applyOmniVoiceRmsNormCorrection(bytes) {
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
  const parts = [];
  for (const field of fields(bytes)) {
    if (field.number !== 7) { parts.push(field.raw); continue; }
    let index = 0;
    parts.push(message(7, join([...fields(field.payload)].map(item => item.number === 1
      ? message(1, changed.get(index++) ?? item.payload) : item.raw))));
  }
  const corrected = join(parts), modifiedSha256 = await hash(corrected);
  if (modifiedSha256 !== CORRECTED_SHA256) throw new Error(`Derived OmniVoice RMSNorm graph hash differs: ${modifiedSha256}.`);
  return { bytes: corrected, originalSha256, modifiedSha256, norms: 113, version: 'omnivoice-float32-rmsnorm-v1',
    source: 'https://github.com/huggingface/transformers/blob/v5.3.0/src/transformers/models/qwen3/modeling_qwen3.py#L54-L59',
    cachePolicy: 'Only original hash-verified bytes enter CacheStorage. Derived graph is ephemeral; learned weights and the public tensor interface remain unchanged.' };
}
