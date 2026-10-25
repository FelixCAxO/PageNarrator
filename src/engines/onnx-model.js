// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// ONNX wire-format interoperability, implemented against the public ONNX schema.
// Tensor payloads remain views into the caller's buffer; model weights are not copied.

const utf8 = new TextDecoder('utf-8', { fatal: true });
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const UINT64_LIMIT = 1n << 64n;
const INT64_SIGN = 1n << 63n;

function fail(message) { throw new Error(`Invalid ONNX model: ${message}`); }

function varint(data, start) {
  let value = 0n;
  for (let i = 0; i < 10; i += 1) {
    if (start + i >= data.length) fail('truncated varint');
    const byte = data[start + i];
    if (i === 9 && byte > 1) fail('varint exceeds 64 bits');
    value |= BigInt(byte & 127) << BigInt(i * 7);
    if (!(byte & 128)) return { value, end: start + i + 1 };
  }
  return fail('unterminated varint');
}

function integer(value, signed = false) {
  const result = signed && value >= INT64_SIGN ? value - UINT64_LIMIT : value;
  return result >= -MAX_SAFE && result <= MAX_SAFE ? Number(result) : result;
}

function smallInteger(value, label) {
  const result = integer(value);
  if (typeof result !== 'number') fail(`${label} exceeds JavaScript's exact integer range`);
  return result;
}

function* fields(data, budget) {
  let offset = 0;
  while (offset < data.length) {
    if (--budget.fields < 0) fail('field limit exceeded');
    const tag = varint(data, offset);
    offset = tag.end;
    if (tag.value > 0xffffffffn) fail('invalid field tag');
    const key = Number(tag.value);
    const number = key >>> 3;
    const wire = key & 7;
    if (!number) fail('field zero is reserved');
    if (wire === 0) {
      const item = varint(data, offset);
      offset = item.end;
      yield { number, wire, value: item.value };
      continue;
    }
    let length;
    if (wire === 2) {
      const item = varint(data, offset);
      offset = item.end;
      if (item.value > BigInt(data.length - offset)) fail('field extends past its message');
      length = Number(item.value);
    } else if (wire === 1 || wire === 5) {
      length = wire === 1 ? 8 : 4;
    } else {
      fail(`unsupported wire type ${wire}`);
    }
    if (length > data.length - offset) fail('truncated fixed-width field');
    yield { number, wire, value: data.subarray(offset, offset + length) };
    offset += length;
  }
}

function bytes(field) {
  if (field.wire !== 2) fail(`field ${field.number} must contain bytes`);
  return field.value;
}

function text(field, budget) {
  const data = bytes(field);
  if (data.length > budget.stringBytes) fail('metadata string limit exceeded');
  return utf8.decode(data);
}

function scalar(field, signed = false) {
  if (field.wire !== 0) fail(`field ${field.number} must contain an integer`);
  return integer(field.value, signed);
}

function integerList(field, budget) {
  if (field.wire === 0) return [scalar(field, true)];
  const data = bytes(field);
  const result = [];
  for (let offset = 0; offset < data.length;) {
    if (result.length >= budget.literalElements) fail('literal element limit exceeded');
    const item = varint(data, offset);
    result.push(integer(item.value, true));
    offset = item.end;
  }
  return result;
}

function floatList(field, budget) {
  if (field.wire !== 2 && field.wire !== 5) fail('invalid float field');
  const data = field.value;
  if (data.length % 4 || data.length / 4 > budget.literalElements) fail('invalid float list length');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return Array.from({ length: data.length / 4 }, (_, i) => view.getFloat32(i * 4, true));
}

function stringPair(data, budget) {
  let key = '', value = '';
  for (const f of fields(data, budget)) {
    if (f.number === 1) key = text(f, budget);
    if (f.number === 2) value = text(f, budget);
  }
  return [key, value];
}

function tensor(data, budget) {
  const result = { name: '', dataType: 0, dims: [], rawData: null, typedData: new Map(), externalData: new Map(), dataLocation: 0 };
  for (const f of fields(data, budget)) {
    if (f.number === 1) {
      for (const value of integerList(f, budget)) {
        if (result.dims.length >= budget.dimensions) fail('dimension limit exceeded');
        result.dims.push(value);
      }
    }
    else if (f.number === 2) result.dataType = scalar(f);
    else if (f.number === 8) result.name = text(f, budget);
    else if (f.number === 9) result.rawData = bytes(f);
    else if (f.number === 13) {
      const [key, value] = stringPair(bytes(f), budget);
      if (result.externalData.has(key)) fail(`duplicate external tensor key ${key}`);
      result.externalData.set(key, value);
    } else if (f.number === 14) result.dataLocation = scalar(f);
    else if ([4, 5, 6, 7, 10, 11].includes(f.number)) {
      const chunks = result.typedData.get(f.number) || [];
      chunks.push(f);
      result.typedData.set(f.number, chunks);
    }
  }
  if (result.dims.length > budget.dimensions || result.dims.some(n => typeof n !== 'number' || n < 0)) fail('invalid tensor dimensions');
  return result;
}

function dimensions(data, budget) {
  const result = [];
  for (const f of fields(data, budget)) {
    if (f.number !== 1) continue;
    let value = null;
    for (const d of fields(bytes(f), budget)) {
      if (d.number === 1) value = scalar(d);
      if (d.number === 2) value = text(d, budget);
    }
    result.push(value);
    if (result.length > budget.dimensions) fail('dimension limit exceeded');
  }
  return result;
}

function valueInfo(data, budget) {
  const result = { name: '', dataType: null, dims: null };
  for (const f of fields(data, budget)) {
    if (f.number === 1) result.name = text(f, budget);
    if (f.number !== 2) continue;
    for (const type of fields(bytes(f), budget)) {
      if (type.number !== 1) continue;
      for (const t of fields(bytes(type), budget)) {
        if (t.number === 1) result.dataType = scalar(t);
        if (t.number === 2) result.dims = dimensions(bytes(t), budget);
      }
    }
  }
  return result;
}

function attribute(data, budget, depth) {
  const result = { name: '', type: 0, value: null };
  for (const f of fields(data, budget)) {
    if (f.number === 1) result.name = text(f, budget);
    else if (f.number === 20) result.type = scalar(f);
    else if (f.number === 2) result.value = floatList(f, budget)[0];
    else if (f.number === 3) result.value = scalar(f, true);
    else if (f.number === 4) result.value = bytes(f);
    else if (f.number === 5) result.value = tensor(bytes(f), budget);
    else if (f.number === 6) result.value = graph(bytes(f), budget, depth + 1);
    else if ([7, 8, 9, 10, 11].includes(f.number)) {
      const values = f.number === 7 ? floatList(f, budget)
        : f.number === 8 ? integerList(f, budget)
          : [f.number === 9 ? bytes(f) : f.number === 10 ? tensor(bytes(f), budget) : graph(bytes(f), budget, depth + 1)];
      if (!Array.isArray(result.value)) result.value = [];
      if (result.value.length + values.length > budget.literalElements) fail('literal element limit exceeded');
      for (const value of values) result.value.push(value);
    }
  }
  if (!result.name) fail('attribute has no name');
  return result;
}

function node(data, budget, depth) {
  const result = { name: '', opType: '', domain: '', inputs: [], outputs: [], attributes: new Map() };
  for (const f of fields(data, budget)) {
    if (f.number === 1) result.inputs.push(text(f, budget));
    else if (f.number === 2) result.outputs.push(text(f, budget));
    else if (f.number === 3) result.name = text(f, budget);
    else if (f.number === 4) result.opType = text(f, budget);
    else if (f.number === 7) result.domain = text(f, budget);
    else if (f.number === 5) {
      const item = attribute(bytes(f), budget, depth);
      if (result.attributes.has(item.name)) fail(`duplicate attribute ${item.name}`);
      result.attributes.set(item.name, item);
    }
  }
  if (!result.opType) fail('node has no operator');
  return result;
}

function graph(data, budget, depth) {
  if (depth > budget.depth) fail('graph nesting limit exceeded');
  const result = { name: '', nodes: [], initializers: [], inputs: [], outputs: [], values: [] };
  for (const f of fields(data, budget)) {
    if (f.number === 1) result.nodes.push(node(bytes(f), budget, depth));
    else if (f.number === 2) result.name = text(f, budget);
    else if (f.number === 5) result.initializers.push(tensor(bytes(f), budget));
    else if ([11, 12, 13].includes(f.number)) {
      result[f.number === 11 ? 'inputs' : f.number === 12 ? 'outputs' : 'values'].push(valueInfo(bytes(f), budget));
    }
  }
  return result;
}

function opset(data, budget) {
  const result = { domain: '', version: null };
  for (const f of fields(data, budget)) {
    if (f.number === 1) result.domain = text(f, budget);
    if (f.number === 2) result.version = scalar(f);
  }
  return result;
}

function modelFunction(data, budget) {
  const result = { name: '', domain: '', nodes: [], opsets: [], attributes: [], inputs: [], outputs: [] };
  for (const f of fields(data, budget)) {
    if (f.number === 1) result.name = text(f, budget);
    else if (f.number === 4) result.inputs.push(text(f, budget));
    else if (f.number === 5) result.outputs.push(text(f, budget));
    else if (f.number === 7) result.nodes.push(node(bytes(f), budget, 0));
    else if (f.number === 9) result.opsets.push(opset(bytes(f), budget));
    else if (f.number === 10) result.domain = text(f, budget);
    else if (f.number === 11) result.attributes.push(attribute(bytes(f), budget, 0));
  }
  return result;
}

/** Decode graph structure without allocating another copy of the weight payload. */
export function decodeOnnxModel(input, limits = {}) {
  const data = input instanceof ArrayBuffer ? new Uint8Array(input)
    : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : null;
  if (!data) throw new TypeError('ONNX input must be an ArrayBuffer or an ArrayBuffer view');
  const budget = { fields: 2_000_000, depth: 64, stringBytes: 1024 * 1024, literalElements: 1_000_000, dimensions: 64, ...limits };
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`Invalid ONNX ${name} limit`);
  }
  const result = { irVersion: null, producer: '', graph: null, opsets: [], functions: [] };
  for (const f of fields(data, budget)) {
    if (f.number === 1) {
      if (f.wire !== 0) fail('IR version must contain an integer');
      result.irVersion = smallInteger(f.value, 'IR version');
    }
    else if (f.number === 2) result.producer = text(f, budget);
    else if (f.number === 7) {
      if (result.graph) fail('duplicate main graph');
      result.graph = graph(bytes(f), budget, 0);
    } else if (f.number === 8) result.opsets.push(opset(bytes(f), budget));
    else if (f.number === 25) result.functions.push(modelFunction(bytes(f), budget));
  }
  if (!result.graph) fail('main graph is missing');
  return result;
}

/** Operator requirements, including nested control-flow graphs and local functions. */
export function summarizeOnnxModel(model) {
  const counts = new Map();
  let graphs = 0, nodes = 0, tensors = 0, embeddedWeightBytes = 0;
  const externalFiles = new Set();
  function visitTensor(value) {
    tensors += 1;
    embeddedWeightBytes += value.rawData?.byteLength || 0;
    if (value.externalData.has('location')) externalFiles.add(value.externalData.get('location'));
  }
  function visitNodes(items) {
    for (const n of items) {
      nodes += 1;
      const key = n.domain ? `${n.domain}::${n.opType}` : n.opType;
      counts.set(key, (counts.get(key) || 0) + 1);
      for (const a of n.attributes.values()) {
        if (a.type === 4) visitTensor(a.value);
        if (a.type === 9) a.value.forEach(visitTensor);
        if (a.type === 5) visitGraph(a.value);
        if (a.type === 10) a.value.forEach(visitGraph);
      }
    }
  }
  function visitGraph(value) {
    graphs += 1;
    value.initializers.forEach(visitTensor);
    visitNodes(value.nodes);
  }
  visitGraph(model.graph);
  for (const f of model.functions) visitNodes(f.nodes);
  return { irVersion: model.irVersion, opsets: model.opsets, inputs: model.graph.inputs, outputs: model.graph.outputs,
    graphs, nodes, tensors, embeddedWeightBytes, externalFiles: [...externalFiles].sort(), functions: model.functions.length,
    operators: Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))) };
}
