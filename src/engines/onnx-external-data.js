// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { tensorSize } from './tensor-shape.js';

function bytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  throw new TypeError('External weights require explicit binary data.');
}

function pathName(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes(':') || path.startsWith('/')
    || path.split('/').some(part => !part || part === '.' || part === '..') || /[\u0000-\u001f]/u.test(path)) throw new Error('Invalid external weight path.');
  return path;
}

function decimal(value, fallback) {
  if (value === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid external weight offset or length.');
  return Number(value);
}

/** Resolve only caller-supplied bytes. Model metadata can never initiate a download. */
export function bindExternalData(model, entries = []) {
  if (!Array.isArray(entries)) throw new TypeError('External weights must be an array of path/data entries.');
  const files = new Map();
  for (const entry of entries) {
    const path = pathName(entry?.path);
    if (files.has(path)) throw new Error('Duplicate external weight path.');
    files.set(path, bytes(entry.data));
  }
  const resolve = tensor => {
    if (!tensor.dataLocation && !tensor.externalData.size) return tensor;
    if (tensor.dataLocation !== 1 || tensor.rawData || tensor.typedData.size) throw new Error(`Tensor ${tensor.name} has conflicting external storage.`);
    for (const key of tensor.externalData.keys()) if (!['location', 'offset', 'length'].includes(key)) throw new Error(`Unsupported external weight key ${key}.`);
    const file = files.get(pathName(tensor.externalData.get('location')));
    if (!file) throw new Error(`Tensor ${tensor.name} is missing its explicit external weight payload.`);
    const width = { 1: 4, 2: 1, 3: 1, 6: 4, 7: 8, 9: 1, 10: 2 }[tensor.dataType];
    if (!width) throw new Error(`Unsupported external tensor type ${tensor.dataType}.`);
    const expected = tensorSize(tensor.dims) * width;
    const offset = decimal(tensor.externalData.get('offset'), 0), length = decimal(tensor.externalData.get('length'), file.byteLength - offset);
    if (!Number.isSafeInteger(expected) || length !== expected || offset > file.byteLength || length > file.byteLength - offset) throw new RangeError(`Tensor ${tensor.name} has an invalid external weight range.`);
    return { ...tensor, rawData: file.subarray(offset, offset + length), externalData: new Map(), dataLocation: 0 };
  };
  return { ...model, graph: { ...model.graph, initializers: model.graph.initializers.map(resolve),
    nodes: model.graph.nodes.map(node => ({ ...node, attributes: new Map([...node.attributes].map(([key, attr]) =>
      [key, attr.type === 4 ? { ...attr, value: resolve(attr.value) } : attr])) })) } };
}
