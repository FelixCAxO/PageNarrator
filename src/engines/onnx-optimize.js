// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { constantNumbers } from './onnx-tensor.js';

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
