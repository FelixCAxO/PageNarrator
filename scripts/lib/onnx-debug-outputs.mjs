// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Development oracle tool: preserve every original field except graph outputs.
import { decodeOnnxModel } from '../../src/engines/onnx-model.js';
const encoder = new TextEncoder();
const join = parts => { const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0)); let at = 0; for (const part of parts) { result.set(part, at); at += part.length; } return result; };
function varint(value) {
  const output = []; value = BigInt(value);
  do { output.push(Number(value & 127n) | (value > 127n ? 128 : 0)); value >>= 7n; } while (value);
  return Uint8Array.from(output);
}
const integer = (number, value) => join([varint(number * 8), varint(value)]);
const message = (number, bytes) => join([varint(number * 8 + 2), varint(bytes.length), bytes]);
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
    let payload;
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

function graphTypes(graph) {
  const declared = new Map([...graph.initializers, ...graph.inputs,
    ...graph.values, ...graph.outputs].filter(info => info.dataType).map(info => [info.name, info.dataType]));
  const types = new Map(declared);
  for (const node of graph.nodes) {
    const type = node.opType === 'Constant' ? node.attributes.get('value').value.dataType : node.opType === 'Cast' ? node.attributes.get('to').value
      : ['Shape', 'NonZero'].includes(node.opType) ? 7 : ['Equal', 'Less', 'Greater', 'GreaterOrEqual', 'And'].includes(node.opType) ? 9
        : ['MatMulInteger', 'ConvInteger'].includes(node.opType) ? 6 : ['DequantizeLinear', 'DynamicQuantizeLSTM'].includes(node.opType) ? 1
          : types.get(node.inputs[node.opType === 'Where' ? 1 : 0]);
    node.outputs.forEach((output, i) => { if (output) types.set(output, declared.get(output) ?? (node.opType === 'DynamicQuantizeLinear' ? [2, 1, 2][i] : type)); });
  }
  return types;
}

export function debugOutputModel(bytes, outputNames) {
  const model = decodeOnnxModel(bytes), types = graphTypes(model.graph);
  const outputs = outputNames.map(name => {
    const type = types.get(name); if (!type) throw new Error(`Unknown debug output ${name}.`);
    return message(12, join([message(1, encoder.encode(name)), message(2, message(1, integer(1, type)))]));
  });
  const parts = [];
  for (const field of fields(bytes)) parts.push(field.number === 7 ? message(7, join([...fields(field.payload)].filter(item => item.number !== 12).map(item => item.raw).concat(outputs))) : field.raw);
  const result = join(parts);
  if (decodeOnnxModel(result).graph.outputs.map(info => info.name).join('\0') !== outputNames.join('\0')) throw new Error('Debug model outputs did not round trip.');
  return result;
}

/** Isolated comparator control: match float32 MatMul accumulation with half storage.
 * The production engine already uses that arithmetic; no weights or other operators change. */
export function float32MatmulReference(bytes) {
  const graph = decodeOnnxModel(bytes).graph, types = graphTypes(graph), changed = new Map();
  if (graph.nodes.some(node => node.outputs.some(name => name.startsWith('pn_reference_accumulate_')))) throw new Error('Reference precision names already exist.');
  const node = (op, name, inputs, output, to) => join([...inputs.map(value => message(1, encoder.encode(value))),
    message(2, encoder.encode(output)), message(3, encoder.encode(name)), message(4, encoder.encode(op)),
    ...(to ? [message(5, join([message(1, encoder.encode('to')), integer(3, to), integer(20, 2)]))] : [])]);
  for (const [index, original] of graph.nodes.entries()) {
    if (original.opType !== 'MatMul' || types.get(original.outputs[0]) !== 10) continue;
    if (original.domain || original.attributes.size || original.inputs.length !== 2 || original.outputs.length !== 1) throw new Error('Unexpected reference MatMul signature.');
    const prefix = `pn_reference_accumulate_${index}`, a = `${prefix}_a`, b = `${prefix}_b`, y = `${prefix}_y`;
    changed.set(index, [node('Cast', `${prefix}A`, [original.inputs[0]], a, 1), node('Cast', `${prefix}B`, [original.inputs[1]], b, 1),
      node('MatMul', original.name, [a, b], y), node('Cast', `${prefix}Output`, [y], original.outputs[0], 10)]);
  }
  const parts = [];
  for (const field of fields(bytes)) {
    if (field.number !== 7) { parts.push(field.raw); continue; }
    let index = 0;
    parts.push(message(7, join([...fields(field.payload)].flatMap(item => {
      if (item.number !== 1) return [item.raw];
      const replacement = changed.get(index++);
      return replacement ? replacement.map(value => message(1, value)) : [item.raw];
    }))));
  }
  return { bytes: join(parts), promotedMatmuls: changed.size };
}

/** Development-only causal intervention: replace one float tensor producer with an explicit input.
 * Retained weights/other nodes remain byte-identical. Never used by the production loader. */
export function debugOverrideModel(bytes, outputName, shape) {
  const model = decodeOnnxModel(bytes), index = model.graph.nodes.findIndex(node => node.outputs.includes(outputName));
  const producer = model.graph.nodes[index], inputName = 'pn_debug_override', zeroName = 'pn_debug_zero';
  const declaration = [...model.graph.values, ...model.graph.outputs].find(info => info.name === outputName);
  if (!producer || producer.outputs.length !== 1 || declaration?.dataType !== 1 || !shape.length || shape.length > 8
    || shape.some(dim => !Number.isSafeInteger(dim) || dim < 0) || shape.reduce((a, b) => a * b, 1) > 2147483647) throw new Error('Debug override requires one declared float32 producer and bounded shape.');
  if ([...model.graph.initializers, ...model.graph.inputs].some(info => [inputName, zeroName].includes(info.name))
    || model.graph.nodes.some(node => node.outputs.some(name => [inputName, zeroName].includes(name)))) throw new Error('Debug override names already exist.');
  const node = join([message(1, encoder.encode(inputName)), message(1, encoder.encode(zeroName)), message(2, encoder.encode(outputName)), message(3, encoder.encode('PageNarratorDiagnosticOverride')), message(4, encoder.encode('Add'))]);
  const zero = join([integer(2, 1), message(8, encoder.encode(zeroName)), message(9, new Uint8Array(4))]);
  const input = join([message(1, encoder.encode(inputName)), message(2, message(1, join([integer(1, 1), message(2, join(shape.map(dim => message(1, integer(1, dim)))))])))]);
  const parts = [];
  for (const field of fields(bytes)) {
    if (field.number !== 7) { parts.push(field.raw); continue; }
    let nodeIndex = 0;
    const graph = [...fields(field.payload)].map(item => item.number === 1 && nodeIndex++ === index ? message(1, node) : item.raw);
    parts.push(message(7, join([...graph, message(5, zero), message(11, input)])));
  }
  const result = join(parts), decoded = decodeOnnxModel(result);
  if (decoded.graph.nodes[index].inputs.join(',') !== `${inputName},${zeroName}` || !decoded.graph.inputs.some(info => info.name === inputName)) throw new Error('Debug override did not round trip.');
  return { bytes: result, inputName };
}

/** Minimal standard MatMul graph for independent primitive accuracy probes. */
export function matmulFixture(dataType, aShape, bShape) {
  const valueInfo = (name, shape) => join([message(1, encoder.encode(name)), message(2, message(1,
    join([integer(1, dataType), message(2, join(shape.map(dim => message(1, integer(1, dim)))))])))]);
  const node = join([message(1, encoder.encode('a')), message(1, encoder.encode('b')), message(2, encoder.encode('y')), message(4, encoder.encode('MatMul'))]);
  const graph = join([message(1, node), message(11, valueInfo('a', aShape)), message(11, valueInfo('b', bShape)),
    message(12, valueInfo('y', [...aShape.slice(0, -1), bShape.at(-1)]))]);
  return join([integer(1, 8), message(7, graph), message(8, integer(2, 17))]);
}

/** Float32 public contract with an intermediate-only half Cast, without value_info hints. */
export function halfIntermediateFixture(length) {
  if (!Number.isSafeInteger(length) || length < 1 || length > 4096) throw new Error('Invalid half Cast fixture length.');
  const info = name => join([message(1, encoder.encode(name)), message(2, message(1,
    join([integer(1, 1), message(2, message(1, integer(1, length)))])))]);
  const cast = (input, output, to) => message(1, join([message(1, encoder.encode(input)), message(2, encoder.encode(output)),
    message(4, encoder.encode('Cast')), message(5, join([message(1, encoder.encode('to')), integer(3, to), integer(20, 2)]))]));
  return join([integer(1, 8), message(7, join([cast('x', 'half', 10), cast('half', 'y', 1),
    message(11, info('x')), message(12, info('y'))])), message(8, integer(2, 17))]);
}

/** Upstream float32 RMSNorm with its half rounding before learned-weight scaling. */
export function rmsNormFixture(rows) {
  if (!Number.isSafeInteger(rows) || rows < 1 || rows > 256) throw new Error('Invalid RMSNorm fixture size.');
  const info = (name, type, shape) => join([message(1, encoder.encode(name)), message(2, message(1,
    join([integer(1, type), message(2, join(shape.map(dim => message(1, integer(1, dim)))))])))]);
  const attribute = (name, value) => join([message(1, encoder.encode(name)), integer(3, value), integer(20, 2)]);
  const node = (op, inputs, output, attrs = []) => message(1, join([...inputs.map(name => message(1, encoder.encode(name))),
    message(2, encoder.encode(output)), message(4, encoder.encode(op)), ...attrs.map(value => message(5, value))]));
  const scalar = (name, value) => { const data = new Uint8Array(4); new DataView(data.buffer).setFloat32(0, value, true);
    return message(5, join([integer(2, 1), message(8, encoder.encode(name)), message(9, data)])); };
  const axes = join([message(1, encoder.encode('axes')), integer(8, 1), integer(20, 7)]);
  const nodes = [node('Pow', ['x', 'two'], 'squared'), node('ReduceMean', ['squared'], 'variance', [axes, attribute('keepdims', 1)]),
    node('Add', ['variance', 'epsilon'], 'adjusted'), node('Sqrt', ['adjusted'], 'root'), node('Div', ['one', 'root'], 'inverse'),
    node('Mul', ['x', 'inverse'], 'normalized'), node('Cast', ['normalized'], 'half', [attribute('to', 10)]),
    node('Mul', ['half', 'weight'], 'y')];
  const weights = message(5, join([integer(1, 4), integer(2, 10), message(8, encoder.encode('weight')),
    message(9, new Uint8Array(Uint16Array.of(0x3c00, 0x4000, 0x3800, 0x4200).buffer))]));
  return join([integer(1, 8), message(7, join([...nodes, scalar('two', 2), scalar('epsilon', 1e-6), scalar('one', 1), weights,
    message(11, info('x', 1, [rows, 4])), message(12, info('normalized', 1, [rows, 4])),
    message(12, info('variance', 1, [rows, 1])), message(12, info('y', 10, [rows, 4]))])), message(8, integer(2, 17))]);
}

/** Tiny constant boundary control for the original session's half Cast and Mul. */
export function rmsNormHalfBoundaryFixture(normalized) {
  if (!(normalized instanceof Float32Array) || !normalized.length || normalized.length > 1024 || normalized.length % 4) throw new Error('Invalid normalized RMSNorm fixture.');
  const name = (number, value) => message(number, encoder.encode(value));
  const input = message(5, join([integer(1, normalized.length / 4), integer(1, 4), integer(2, 1), name(8, 'normalized'),
    message(9, new Uint8Array(normalized.buffer, normalized.byteOffset, normalized.byteLength))]));
  const weight = message(5, join([integer(1, 4), integer(2, 10), name(8, 'weight'),
    message(9, new Uint8Array(Uint16Array.of(0x3c00, 0x4000, 0x3800, 0x4200).buffer))]));
  const cast = message(1, join([name(1, 'normalized'), name(2, 'half'), name(4, 'Cast'),
    message(5, join([name(1, 'to'), integer(3, 10), integer(20, 2)]))]));
  const multiply = message(1, join([name(1, 'half'), name(1, 'weight'), name(2, 'y'), name(4, 'Mul')]));
  const output = message(12, join([name(1, 'y'), message(2, message(1, join([integer(1, 10), message(2,
    join([message(1, integer(1, normalized.length / 4)), message(1, integer(1, 4))]))])))]));
  return join([integer(1, 8), message(7, join([cast, multiply, input, weight, output])), message(8, integer(2, 17))]);
}

/** Standard float32 spatial mean for a common-operand numerical control. */
export function spatialMeanFixture(shape) {
  if (!Array.isArray(shape) || shape.length !== 4 || shape.some(dim => !Number.isSafeInteger(dim) || dim < 1)
    || shape.reduce((a, b) => a * b, 1) > 16_000_000) throw new Error('Invalid spatial mean fixture shape.');
  const info = (name, dimensions) => join([message(1, encoder.encode(name)), message(2, message(1,
    join([integer(1, 1), message(2, join(dimensions.map(dim => message(1, integer(1, dim)))))])))]);
  const axes = join([message(1, encoder.encode('axes')), integer(20, 7), integer(8, 2), integer(8, 3)]);
  const keep = join([message(1, encoder.encode('keepdims')), integer(20, 2), integer(3, 1)]);
  const node = join([message(1, encoder.encode('x')), message(2, encoder.encode('y')), message(4, encoder.encode('ReduceMean')),
    message(5, axes), message(5, keep)]);
  return join([integer(1, 8), message(7, join([message(1, node), message(11, info('x', shape)),
    message(12, info('y', [shape[0], shape[1], 1, 1]))])), message(8, integer(2, 17))]);
}

const phasePrefix = '/decoder/decoder/generator/', phaseName = `${phasePrefix}Where_1_output_0`;
const phaseRaw = 'pn_diagnostic_raw_phase', phaseEqual = 'pn_diagnostic_zero_imaginary', phaseMask = 'pn_diagnostic_negative_real_zero_imaginary';
const phaseSigned = 'pn_diagnostic_signed_phase', phaseRealZero = 'pn_diagnostic_zero_real', phaseOrigin = 'pn_diagnostic_zero_complex';
const phaseNode = (op, inputs, output) => join([...inputs.map(name => message(1, encoder.encode(name))), message(2, encoder.encode(output)),
  message(3, encoder.encode(`PageNarratorDiagnosticPhase${op}_${output}`)), message(4, encoder.encode(op))]);
function phaseCorrectionNodes(real, imaginary, negativeReal, zero, pi, raw = phaseRaw, output = phaseName) {
  return [phaseNode('Equal', [imaginary, zero], phaseEqual), phaseNode('And', [phaseEqual, negativeReal], phaseMask),
    phaseNode('Where', [phaseMask, pi, raw], phaseSigned), phaseNode('Equal', [real, zero], phaseRealZero),
    phaseNode('And', [phaseEqual, phaseRealZero], phaseOrigin), phaseNode('Where', [phaseOrigin, zero, phaseSigned], output)];
}

export { applyKokoroPhaseCorrection as debugKokoroPhaseCorrection } from '../../src/tts/kokoro/phase-correction.js';

/** Tiny operator-chain fixture; raw phase is supplied by independent signed-zero math. */
export function phaseCorrectionFixture(length) {
  if (!Number.isSafeInteger(length) || length < 1 || length > 4096) throw new Error('Invalid phase fixture length.');
  const info = (name, type, shape) => join([message(1, encoder.encode(name)), message(2, message(1,
    join([integer(1, type), message(2, join(shape.map(dim => message(1, integer(1, dim)))))])))]);
  const scalar = (name, value) => { const data = new Uint8Array(4); new DataView(data.buffer).setFloat32(0, value, true);
    return message(5, join([integer(2, 1), message(8, encoder.encode(name)), message(9, data)])); };
  const nodes = [phaseNode('Less', ['real', 'zero'], 'negative'), ...phaseCorrectionNodes('real', 'imaginary', 'negative', 'zero', 'pi', 'raw', 'corrected')];
  const graph = join([...nodes.map(node => message(1, node)), scalar('zero', 0), scalar('pi', Math.PI),
    ...['real', 'imaginary', 'raw'].map(name => message(11, info(name, 1, [length]))), message(12, info('corrected', 1, [length]))]);
  return join([integer(1, 8), message(7, graph), message(8, integer(2, 17))]);
}
