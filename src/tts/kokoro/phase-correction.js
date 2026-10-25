// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Guarded canonical phase correction; retained model weights and cached source bytes stay unchanged.
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

const phasePrefix = '/decoder/decoder/generator/', phaseName = `${phasePrefix}Where_1_output_0`;
const phaseRaw = 'pn_diagnostic_raw_phase', phaseEqual = 'pn_diagnostic_zero_imaginary', phaseMask = 'pn_diagnostic_negative_real_zero_imaginary';
const phaseSigned = 'pn_diagnostic_signed_phase', phaseRealZero = 'pn_diagnostic_zero_real', phaseOrigin = 'pn_diagnostic_zero_complex';
/** @param {string} op @param {string[]} inputs @param {string} output */
const phaseNode = (op, inputs, output) => join([...inputs.map(name => message(1, encoder.encode(name))), message(2, encoder.encode(output)),
  message(3, encoder.encode(`PageNarratorDiagnosticPhase${op}_${output}`)), message(4, encoder.encode(op))]);
/** @param {string} real @param {string} imaginary @param {string} negativeReal @param {string} zero @param {string} pi @param {string} [raw] @param {string} [output] */
function phaseCorrectionNodes(real, imaginary, negativeReal, zero, pi, raw = phaseRaw, output = phaseName) {
  return [phaseNode('Equal', [imaginary, zero], phaseEqual), phaseNode('And', [phaseEqual, negativeReal], phaseMask),
    phaseNode('Where', [phaseMask, pi, raw], phaseSigned), phaseNode('Equal', [real, zero], phaseRealZero),
    phaseNode('And', [phaseEqual, phaseRealZero], phaseOrigin), phaseNode('Where', [phaseOrigin, zero, phaseSigned], output)];
}

/** Correct the exact-zero ONNX quadrant discontinuity documented by
 * hexgrad/kokoro@93abff8795bfb00f78a14fa5d551198f445067ab custom_stft.py:121-124.
 * This follows that model's canonical +pi zero convention, including -0. At a
 * coincident-zero spectrum value, define phase as +0 so exported 0/0 cannot poison
 * subsequent convolutions. Both zero signs use this canonical origin convention;
 * negative-zero quadrants are not full IEEE/Torch atan2 parity. General Div/Atan
 * and every nonzero phase remain unchanged.
 * @param {Uint8Array<ArrayBuffer>} bytes */
export async function applyKokoroPhaseCorrection(bytes) {
  const sha256 = await hash(bytes);
  if (!['8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb',
    'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478'].includes(sha256)) throw new Error('Phase diagnostic requires an exact pinned Kokoro graph.');
  const graph = decodeOnnxModel(bytes).graph, named = (/** @type {string} */ name) => graph.nodes.find(node => node.name === `${phasePrefix}${name}`);
  const final = named('Where_1'), less = named('Less'), greater = named('Greater'), branch = named('Where'), atan = named('Atan'), divide = named('Div');
  if (!final || !less || !greater || !branch || !atan || !divide) throw new Error('Unexpected pinned Kokoro phase nodes.');
  /** @param {any} node @param {string} op @param {string[]} inputs @param {string} output */
  const expected = (node, op, inputs, output) => node?.opType === op && !node.domain && node.attributes.size === 0 && node.inputs.join('\0') === inputs.join('\0') && node.outputs.length === 1 && node.outputs[0] === output;
  const real = `${phasePrefix}Gather_4_output_0`, imaginary = `${phasePrefix}Gather_5_output_0`, zero = `${phasePrefix}Constant_20_output_0`;
  const pi = `${phasePrefix}m_source/l_sin_gen/Constant_7_output_0`;
  if (!expected(divide, 'Div', [imaginary, real], `${phasePrefix}Div_output_0`)
    || !expected(atan, 'Atan', [divide.outputs[0]], `${phasePrefix}Atan_output_0`)
    || !expected(less, 'Less', [real, zero], `${phasePrefix}Less_output_0`)
    || !expected(greater, 'Greater', [imaginary, zero], `${phasePrefix}Greater_output_0`)
    || !expected(branch, 'Where', [greater.outputs[0], `${phasePrefix}Add_1_output_0`, `${phasePrefix}Sub_output_0`], `${phasePrefix}Where_output_0`)
    || !expected(final, 'Where', [less.outputs[0], branch.outputs[0], atan.outputs[0]], phaseName)) throw new Error('Unexpected pinned Kokoro phase signature.');
  const constant = (/** @type {string} */ name) => graph.initializers.find(value => value.name === name) ?? graph.nodes.find(node => node.opType === 'Constant' && node.outputs[0] === name)?.attributes.get('value')?.value;
  const scalar = (/** @type {string} */ name) => { const value = constant(name); return value?.dataType === 1 && value.rawData?.byteLength === 4 ? new DataView(value.rawData.buffer, value.rawData.byteOffset, 4).getFloat32(0, true) : NaN; };
  if (scalar(zero) !== 0 || scalar(pi) !== Math.fround(Math.PI)
    || graph.nodes.some(node => node.outputs.some(name => [phaseRaw, phaseEqual, phaseMask, phaseSigned, phaseRealZero, phaseOrigin].includes(name)))) throw new Error('Unexpected pinned Kokoro phase constants or reserved names.');
  const index = graph.nodes.indexOf(final), parts = [];
  for (const field of fields(bytes)) {
    if (field.number !== 7) { parts.push(field.raw); continue; }
    let nodeIndex = 0; const changed = [];
    for (const item of fields(field.payload)) {
      if (item.number !== 1 || nodeIndex++ !== index) { changed.push(item.raw); continue; }
      changed.push(message(1, join([...fields(item.payload)].map(part => part.number === 2 ? message(2, encoder.encode(phaseRaw)) : part.raw))),
        ...phaseCorrectionNodes(real, imaginary, less.outputs[0], zero, pi).map(node => message(1, node)));
    }
    // Keep weight views until the final join instead of copying the entire graph twice.
    parts.push(varint(7 * 8 + 2), varint(changed.reduce((length, part) => length + part.length, 0)), ...changed);
  }
  // The pinned derived hash verifies every byte; the inference session parses and validates it once.
  const result = join(parts);
  const modifiedSha256 = await hash(result), expectedSha256 = sha256.startsWith('8fbea51e')
    ? 'c9b6ab36e923c2a9b8922f05771738b7aeb08653db38e52d871df243b0086880' : '20eea6d93cb15cd62102caa419192d64860acdc5fa112dbfbef828048bf76ac4';
  if (modifiedSha256 !== expectedSha256) throw new Error(`Derived Kokoro phase graph hash differs from its verified version: ${modifiedSha256}.`);
  return { bytes: result, originalSha256: sha256, modifiedSha256,
    source: 'https://github.com/hexgrad/kokoro/blob/93abff8795bfb00f78a14fa5d551198f445067ab/kokoro/custom_stft.py#L121-L124',
    version: 'kokoro-exact-zero-phase-v2',
    serializationRevision: 'unique-node-names-v1',
    cachePolicy: 'Only original hash-verified model bytes enter CacheStorage; the derived graph is ephemeral and weights remain byte-identical.',
    scope: 'Canonical +pi for imaginary zero/negative real and +0 at coincident zero, for either zero sign. Nonzero phase is unchanged; this is not full signed-zero IEEE/Torch atan2 or unmodified-model parity.' };
}
