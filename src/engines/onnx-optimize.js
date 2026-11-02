// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { constantNumbers } from './onnx-tensor.js';

/** Gather inserted zeros and a private positive-zero tail inside convolution. */
export function fuseZeroInsertConvolutions(nodes, initializers, outputNames, infos, zeroTail = false) {
  const producers = new Map(nodes.flatMap(node => node.outputs.map(name => [name, node])));
  const consumers = new Map(outputNames.map(name => [name, 1]));
  for (const node of nodes) for (const name of node.inputs) consumers.set(name, (consumers.get(name) ?? 0) + 1);
  const removed = new Set(), replacements = new Map();
  const privateNode = (name, op, attrs = []) => {
    const node = producers.get(name);
    return node?.opType === op && (!node.domain || node.domain === 'ai.onnx') && node.outputs.length === 1
      && consumers.get(name) === 1 && !removed.has(node) && Object.keys(node.attrs).every(key => attrs.includes(key)) ? node : null;
  };
  const integers = name => {
    const tensor = initializers.get(name);
    return tensor && [6, 7].includes(tensor.dataType) && tensor.dims.length === 1 ? constantNumbers(tensor) : [];
  };
  const equal = (name, expected) => { const values = integers(name); return values.length === expected.length && values.every((value, i) => value === expected[i]); };
  const zeroPad = node => {
    if (node?.opType !== 'Pad' || (node.domain && node.domain !== 'ai.onnx') || node.outputs.length !== 1
      || ![2, 3].includes(node.inputs.length) || Object.keys(node.attrs).some(key => key !== 'mode')
      || (node.attrs.mode ?? 'constant') !== 'constant') return false;
    if (!node.inputs[2]) return true;
    const value = initializers.get(node.inputs[2]);
    return value?.dataType === 1 && value.dims.length === 0 && Object.is(constantNumbers(value)[0], 0);
  };
  for (const conv of nodes) {
    if (conv.opType !== 'Conv' || (conv.domain && conv.domain !== 'ai.onnx')) continue;
    const slice = privateNode(conv.inputs[0], 'Slice');
    if (!slice || slice.inputs.length !== 5) continue;
    const interleave = privateNode(slice.inputs[0], 'Reshape', ['allowzero']);
    const pad = interleave && privateNode(interleave.inputs[0], 'Pad', ['mode']);
    const unsqueeze = pad && privateNode(pad.inputs[0], 'Reshape', ['allowzero']);
    if (!unsqueeze || interleave.inputs.length !== 2 || unsqueeze.inputs.length !== 2
      || !zeroPad(pad)
      || (interleave.attrs.allowzero ?? 0) !== 0 || (unsqueeze.attrs.allowzero ?? 0) !== 0) continue;
    const input = infos.get(unsqueeze.inputs[0]), weight = initializers.get(conv.inputs[1]);
    if (input?.dataType !== 1 || input.dims?.length !== 3 || weight?.dataType !== 1 || weight.dims.length !== 3 || weight.dims[1] <= 1) continue;
    const pads = integers(pad.inputs[1]), stride = pads[7] + 1;
    if (pads.length !== 8 || pads.slice(0, 7).some(value => value !== 0) || !Number.isSafeInteger(stride) || stride < 2 || stride > 0x7fffffff) continue;
    if (!equal(unsqueeze.inputs[1], [0, 0, -1, 1]) || !equal(interleave.inputs[1], [0, 0, -1])
      || !equal(slice.inputs[1], [0]) || !equal(slice.inputs[2], [1 - stride])
      || !equal(slice.inputs[3], [2]) || !equal(slice.inputs[4], [1])) continue;
    replacements.set(conv, { ...conv, opType: 'FusedZeroInsertConv1d', inputs: [unsqueeze.inputs[0], ...conv.inputs.slice(1)], attrs: { ...conv.attrs, zeroInsertStride: stride } });
    for (const node of [unsqueeze, pad, interleave, slice]) removed.add(node);
  }
  if (zeroTail) for (const pad of nodes) {
    if (!zeroPad(pad) || !equal(pad.inputs[1], [0, 0, 0, 0, 0, 1])) continue;
    const conv = producers.get(pad.inputs[0]), fused = replacements.get(conv);
    if (!fused || conv.outputs.length !== 1 || consumers.get(pad.inputs[0]) !== 1) continue;
    replacements.set(pad, { ...fused, name: pad.name, outputs: pad.outputs, attrs: { ...fused.attrs, zeroTail: true } });
    removed.add(conv);
  }
  return nodes.filter(node => !removed.has(node)).map(node => replacements.get(node) ?? node);
}

/** Widening a half value and narrowing it back adds no precision. */
export function eliminateHalfCastRoundTrips(nodes, valueTypes) {
  const widened = new Map(), producers = new Map(nodes.flatMap(node => node.outputs.map(name => [name, node])));
  const plain = node => (!node.domain || node.domain === 'ai.onnx') && node.inputs.length === 1 && node.outputs.length === 1;
  const cast = (node, to) => plain(node) && node.opType === 'Cast' && node.attrs.to === to && Object.keys(node.attrs).length === 1;
  return nodes.map(node => {
    const input = node.inputs[0], origin = widened.get(input);
    if (cast(node, 1)) {
      if (origin !== undefined) widened.set(node.outputs[0], origin);
      else if (valueTypes.get(input) === 10) widened.set(node.outputs[0], input);
    } else if (plain(node) && node.opType === 'Identity' && !Object.keys(node.attrs).length && origin !== undefined) {
      widened.set(node.outputs[0], origin);
    }
    if (cast(node, 10) && origin === undefined) {
      const view = producers.get(input), half = view && widened.get(view.inputs[0]);
      if (half !== undefined && (!view.domain || view.domain === 'ai.onnx') && view.outputs.length === 1
        && ['Reshape', 'Squeeze', 'Unsqueeze'].includes(view.opType)) {
        // Shape-only views can consume the original half values directly.
        return { ...view, name: node.name, inputs: [half, ...view.inputs.slice(1)], outputs: node.outputs };
      }
    }
    if (!cast(node, 10) || origin === undefined) return node;
    return { ...node, opType: 'Identity', inputs: [origin], attrs: {} };
  });
}

/** Reuse pure transforms without changing named outputs or their tensor lifetimes. */
export function reuseIdenticalTransforms(nodes) {
  const aliases = new Map(), transforms = new Map();
  return nodes.map(node => {
    if (!['Cast', 'Shape'].includes(node.opType) || node.inputs.length !== 1 || node.outputs.length !== 1
      || !Object.values(node.attrs).every(value => Number.isSafeInteger(value) && !Object.is(value, -0))) return node;
    const input = aliases.get(node.inputs[0]) ?? node.inputs[0];
    const key = JSON.stringify([node.domain ?? '', node.opType, input, Object.entries(node.attrs).sort(([a], [b]) => a.localeCompare(b))]);
    const previous = transforms.get(key);
    if (!previous) { transforms.set(key, node.outputs[0]); return node; }
    aliases.set(node.outputs[0], previous);
    return { ...node, opType: 'Identity', inputs: [previous], attrs: {} };
  });
}

/** Fold scaling and masking into the existing half softmax reduction. */
export function fuseHalfScaledMaskedSoftmax(nodes, initializers, valueTypes) {
  const producers = new Map(nodes.flatMap(node => node.outputs.map(name => [name, node])));
  const plain = (node, op) => node?.opType === op && (!node.domain || node.domain === 'ai.onnx')
    && node.inputs.length === 2 && node.outputs.length === 1 && !Object.keys(node.attrs).length;
  return nodes.map(node => {
    if (node.opType !== 'Softmax' || (node.domain && node.domain !== 'ai.onnx') || node.inputs.length !== 1 || node.outputs.length !== 1
      || (node.attrs.axis ?? -1) !== -1 || Object.keys(node.attrs).some(key => key !== 'axis')) return node;
    const add = producers.get(node.inputs[0]), mul = add && producers.get(add.inputs[0]);
    if (!plain(add, 'Add') || !plain(mul, 'Mul')) return node;
    const scale = initializers.get(mul.inputs[1]);
    if (scale?.dataType !== 10 || scale.dims.length !== 0
      || ![...mul.inputs, ...add.inputs, node.inputs[0], node.outputs[0]].every(name => valueTypes.get(name) === 10)) return node;
    return { ...node, opType: 'FusedHalfScaledMaskedSoftmax', inputs: [...mul.inputs, add.inputs[1]], attrs: {} };
  });
}

/** Preserve both half-rounding steps in sigmoid(x) * x * up. */
export function fuseHalfSiluGates(nodes, valueTypes) {
  const producers = new Map(nodes.flatMap(node => node.outputs.map(name => [name, node])));
  const plain = (node, op) => node?.opType === op && !Object.keys(node.attrs).length;
  return nodes.map(node => {
    if (!plain(node, 'Mul')) return node;
    for (const side of [0, 1]) {
      const activation = producers.get(node.inputs[side]), up = node.inputs[1 - side];
      if (!plain(activation, 'Mul')) continue;
      for (const gateSide of [0, 1]) {
        const gate = activation.inputs[gateSide], sigmoid = producers.get(activation.inputs[1 - gateSide]);
        if (plain(sigmoid, 'Sigmoid') && sigmoid.inputs[0] === gate
          && [gate, sigmoid.outputs[0], activation.outputs[0], up, node.outputs[0]].every(name => valueTypes.get(name) === 10)) {
          return { ...node, opType: 'FusedHalfSiluGate', inputs: [gate, up] };
        }
      }
    }
    return node;
  });
}

/** Fuse x + scale * sin(alpha * x)^2 only when every removed value is private.
 * Three explicit inputs preserve models whose scale differs from 1 / alpha. */
export function fuseSnakeActivations(nodes, initializers, outputNames) {
  const producers = new Map(nodes.map(node => [node.outputs[0], node]));
  const consumers = new Map(outputNames.map(name => [name, 1]));
  for (const node of nodes) for (const name of node.inputs) consumers.set(name, (consumers.get(name) ?? 0) + 1);
  const removed = new Set(), replacements = new Map();
  const privateNode = (name, op) => {
    const node = producers.get(name);
    return node?.opType === op && consumers.get(name) === 1 && !Object.keys(node.attrs).length && !removed.has(node) ? node : null;
  };
  for (const add of nodes) {
    if (add.opType !== 'Add' || Object.keys(add.attrs).length) continue;
    for (const side of [0, 1]) {
      const x = add.inputs[side], scaled = privateNode(add.inputs[1 - side], 'Mul');
      if (!scaled) continue;
      for (const squareSide of [0, 1]) {
        const square = privateNode(scaled.inputs[squareSide], 'Pow');
        if (!square) continue;
        const exponent = initializers.get(square.inputs[1]);
        if (!exponent || exponent.dataType !== 1 || exponent.dims.length) continue;
        const values = constantNumbers(exponent);
        if (values.length !== 1 || values[0] !== 2) continue;
        const sine = privateNode(square.inputs[0], 'Sin');
        const phase = sine && privateNode(sine.inputs[0], 'Mul');
        if (!phase || !phase.inputs.includes(x)) continue;
        const alpha = phase.inputs[phase.inputs[0] === x ? 1 : 0], scale = scaled.inputs[1 - squareSide];
        replacements.set(add, { ...add, opType: 'FusedSnake', inputs: [x, alpha, scale] });
        for (const node of [scaled, square, sine, phase]) removed.add(node);
        break;
      }
      if (replacements.has(add)) break;
    }
  }
  return nodes.filter(node => !removed.has(node)).map(node => replacements.get(node) ?? node);
}
