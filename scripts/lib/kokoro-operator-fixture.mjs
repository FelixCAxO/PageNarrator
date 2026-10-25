// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Tiny development-only ONNX schema encoder for independent CPU operator oracles.
const encoder = new TextEncoder();
const join = parts => { const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; } return bytes; };
function varint(value) {
  value = BigInt.asUintN(64, BigInt(value)); const bytes = [];
  do { bytes.push(Number(value & 127n) | (value > 127n ? 128 : 0)); value >>= 7n; } while (value);
  return Uint8Array.from(bytes);
}
const integer = (field, value) => join([varint(field * 8), varint(value)]);
const message = (field, value) => join([varint(field * 8 + 2), varint(value.length), value]);
const text = (field, value) => message(field, encoder.encode(value));
function attribute(name, value) {
  if (typeof value === 'string') return join([text(1, name), text(4, value), integer(20, 3)]);
  if (Array.isArray(value)) return join([text(1, name), message(8, join(value.map(varint))), integer(20, 7)]);
  if (Number.isInteger(value)) return join([text(1, name), integer(3, value), integer(20, 2)]);
  const data = new Uint8Array(4); new DataView(data.buffer).setFloat32(0, value, true);
  return join([text(1, name), varint(2 * 8 + 5), data, integer(20, 1)]);
}
function valueInfo({ name, type, shape }) {
  const dimensions = shape === null ? [] : [message(2, join(shape.map(dim => message(1, typeof dim === 'number' ? integer(1, dim) : text(2, dim)))))];
  return join([text(1, name), message(2, message(1, join([integer(1, type), ...dimensions])))]);
}
export function kokoroOperatorFixture(opType, inputs, outputs, attrs = {}, domain = '') {
  const node = join([...inputs.map(input => text(1, input?.name ?? '')), ...outputs.map(output => text(2, output.name)), text(4, opType),
    ...(domain ? [text(7, domain)] : []), ...Object.entries(attrs).map(([name, value]) => message(5, attribute(name, value)))]);
  const graph = join([message(1, node), ...inputs.filter(Boolean).map(info => message(11, valueInfo(info))), ...outputs.map(info => message(12, valueInfo(info)))]);
  return join([integer(1, 8), message(7, graph), message(8, integer(2, 17)), ...(domain ? [message(8, join([text(1, domain), integer(2, 1)]))] : [])]);
}
