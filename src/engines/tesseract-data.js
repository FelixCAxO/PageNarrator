// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original bounded reader for the retained English model's documented data containers.
// Model data are permitted; no Tesseract executable code is loaded or linked.
const decoder = new TextDecoder('utf-8', { fatal: true });
const TYPES = ['Invalid', 'Input', 'Convolve', 'Maxpool', 'Parallel', 'Replicated', 'ParBidiLSTM',
  'DepParUDLSTM', 'Par2dLSTM', 'Series', 'Reconfig', 'RTLReversed', 'TTBReversed', 'XYTranspose',
  'LSTM', 'SummLSTM', 'Logistic', 'LinLogistic', 'LinTanh', 'Tanh', 'Relu', 'Linear', 'Softmax',
  'SoftmaxNoCTC', 'LSTMSoftmax', 'LSTMBinarySoftmax', 'TensorFlow'];

class Reader {
  constructor(bytes) { this.bytes = bytes; this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.position = 0; }
  take(length) {
    if (!Number.isSafeInteger(length) || length < 0 || this.position + length > this.bytes.length) throw new RangeError('Truncated English OCR model data.');
    const start = this.position; this.position += length; return this.bytes.subarray(start, this.position);
  }
  u8() { return this.take(1)[0]; }
  i32() { const offset = this.position; this.take(4); return this.view.getInt32(offset, true); }
  f32() { const offset = this.position; this.take(4); return this.view.getFloat32(offset, true); }
  f64() { const offset = this.position; this.take(8); return this.view.getFloat64(offset, true); }
  count(maximum) { const count = this.i32(); if (count < 0 || count > maximum) throw new RangeError('English OCR model count exceeds its bound.'); return count; }
  string(maximum = 128) { return decoder.decode(this.take(this.count(maximum))); }
  end() { if (this.position !== this.bytes.length) throw new Error('Unexpected trailing English OCR model data.'); }
}

export function tesseractDataComponents(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 196 || bytes.length > 32 * 1024 * 1024) throw new RangeError('Invalid English traineddata archive size.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), count = view.getInt32(0, true);
  if (count !== 24) throw new Error('Unsupported English traineddata archive version.');
  const entries = [], header = 4 + count * 8;
  for (let index = 0; index < count; index++) {
    const value = view.getBigInt64(4 + index * 8, true);
    if (value === -1n) continue;
    if (value < BigInt(header) || value >= BigInt(bytes.length)) throw new RangeError('Invalid English traineddata component offset.');
    const offset = Number(value);
    if (entries.length && offset <= entries.at(-1).offset) throw new Error('English traineddata components overlap or are unordered.');
    entries.push({ index, offset });
  }
  if (!entries.length || entries[0].offset !== header) throw new Error('English traineddata header contains an unsupported gap.');
  const parts = new Map(entries.map((entry, index) => [entry.index, bytes.subarray(entry.offset, entries[index + 1]?.offset ?? bytes.length)]));
  for (const required of [17, 21, 22, 23]) if (!parts.has(required)) throw new Error('English traineddata lacks required neural or character data.');
  return parts;
}

function matrix(reader) {
  const mode = reader.u8();
  if (![1, 5, 129, 133].includes(mode)) throw new Error(`Unsupported English OCR weight format ${mode}.`);
  const rows = reader.count(2048), columns = reader.count(8192);
  if (!rows || !columns || rows * columns > 4_000_000 || reader.u8() !== 0) throw new RangeError('Invalid English OCR weight matrix shape.');
  const raw = reader.take(rows * columns), weights = new Int8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const count = reader.count(2048);
  if (count !== rows) throw new Error('English OCR quantization scales do not match its rows.');
  const scales = new Float64Array(count);
  for (let index = 0; index < count; index++) {
    const value = mode & 128 ? reader.f64() / 127 : reader.f32();
    if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid English OCR quantization scale.');
    scales[index] = value;
  }
  return { rows, columns, weights, scales, mode };
}

function readNetwork(reader, budget, depth = 0) {
  if (++budget.nodes > 64 || depth > 16) throw new RangeError('English OCR network exceeds its layer budget.');
  const tag = reader.u8(), type = tag ? TYPES[tag] : reader.string(32);
  const training = reader.u8(), needsBackprop = reader.u8(), flags = reader.i32();
  const inputs = reader.count(8192), outputs = reader.count(8192), weightCount = reader.count(4_000_000), name = reader.string(64);
  if (!type || ![0, 2].includes(training) || needsBackprop > 1 || ![0, 64, 128, 192].includes(flags)) throw new Error(`Unsupported English OCR network header (${type}, ${training}, ${needsBackprop}, ${flags}).`);
  const node = { type, inputs, outputs, weightCount, name, flags };
  if (['Series', 'RTLReversed', 'TTBReversed', 'XYTranspose'].includes(type)) {
    const count = reader.count(16);
    if (!count || (type !== 'Series' && count !== 1)) throw new Error('Invalid English OCR plumbing layer.');
    node.children = Array.from({ length: count }, () => readNetwork(reader, budget, depth + 1));
    if (flags & 64) {
      const rates = reader.count(16);
      if (rates !== count) throw new Error('English OCR training-rate metadata differs.');
      for (let index = 0; index < rates; index++) if (!Number.isFinite(reader.f32())) throw new Error('Invalid English OCR training metadata.');
    }
  } else if (type === 'Input') {
    node.shape = Array.from({ length: 5 }, () => reader.count(8192));
    if (node.shape.join(',') !== '1,36,0,1,0') throw new Error(`Unsupported English OCR image shape ${node.shape}.`);
  } else if (type === 'Convolve' || type === 'Maxpool') {
    node.window = [reader.count(4), reader.count(4)];
  } else if (type === 'LSTM' || type === 'SummLSTM') {
    node.sourceSize = reader.count(8192);
    node.gates = Array.from({ length: 4 }, () => matrix(reader));
    if (node.gates.some(gate => gate.rows !== outputs || gate.columns !== inputs + outputs + 1)
      || node.sourceSize !== inputs + outputs) throw new Error('Unsupported English OCR recurrent topology.');
  } else if (type === 'Tanh' || type === 'Softmax') {
    node.matrix = matrix(reader);
    if (node.matrix.rows !== outputs || node.matrix.columns !== inputs + 1) throw new Error('English OCR affine weights do not match its layer.');
  } else throw new Error(`Unsupported English OCR layer ${type}.`);
  return node;
}

export function decodeTesseractEnglishNetwork(bytes) {
  const reader = new Reader(bytes), network = readNetwork(reader, { nodes: 0 });
  const spec = reader.string(256), trainingFlags = reader.i32(), trainingIteration = reader.i32(), sampleIteration = reader.i32(), blank = reader.i32();
  const optimizer = Array.from({ length: 3 }, () => reader.f32());
  reader.end();
  if (spec !== '[1,36,0,1Ct3,3,16Mp3,3Lfys64Lfx96Lrx96Lfx512O1c1]'
    || blank !== 110 || network.outputs !== 111 || optimizer.some(value => !Number.isFinite(value))) throw new Error('Unsupported retained English OCR network specification.');
  return { network, spec, blank, trainingFlags, trainingIteration, sampleIteration };
}

export function decodeTesseractEnglishRecoder(characterBytes, recoderBytes) {
  const lines = decoder.decode(characterBytes).trimEnd().split('\n');
  const count = Number(lines.shift());
  if (count !== 112 || lines.length !== count) throw new Error('Invalid English OCR unicharset.');
  const characters = lines.map(line => line.split(' ')[0]);
  if (characters[0] !== 'NULL' || characters[1] !== 'Joined' || characters[2] !== '|Broken|0|1') throw new Error('Unsupported English OCR special characters.');
  const reader = new Reader(recoderBytes), entries = reader.count(256), classes = Array(111).fill(null);
  if (entries !== count) throw new Error('English OCR recoder does not match its character set.');
  for (let index = 0; index < entries; index++) {
    if (reader.u8() !== 1 || reader.count(9) !== 1) throw new Error('Unsupported English OCR multi-code character.');
    const label = reader.count(110);
    if (index === 1 || index === 2) { if (label !== 110) throw new Error('English OCR null code differs.'); continue; }
    if (classes[label] !== null) throw new Error('English OCR glyph classes overlap.');
    classes[label] = index ? characters[index] : ' ';
  }
  reader.end(); classes[110] = '';
  if (classes.some(value => value === null || (value && [...value].length !== 1))) throw new Error('English OCR character mapping is incomplete.');
  return classes;
}

export function decodeTesseractEnglishData(bytes) {
  const parts = tesseractDataComponents(bytes);
  const model = decodeTesseractEnglishNetwork(parts.get(17));
  const alphabet = decodeTesseractEnglishRecoder(parts.get(21), parts.get(22));
  return { ...model, alphabet, version: decoder.decode(parts.get(23)) };
}
