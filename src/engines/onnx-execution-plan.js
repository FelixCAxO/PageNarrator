// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
/** Keep only dependencies of requested outputs, retaining every named node output. */
export function selectExecutionPlan(nodes, outputNames, requested = outputNames) {
  if (!Array.isArray(requested) || !requested.length || new Set(requested).size !== requested.length
    || requested.some(name => !outputNames.includes(name))) throw new Error('Requested model outputs must be unique declared output names.');
  const needed = new Set(requested), selected = [];
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    if (!node.outputs.some(name => needed.has(name))) continue;
    selected.push(node);
    for (const name of node.inputs) if (name) needed.add(name);
  }
  selected.reverse();
  const consumers = new Map();
  for (const node of selected) for (const name of node.inputs) if (name) consumers.set(name, (consumers.get(name) ?? 0) + 1);
  for (const name of requested) consumers.set(name, (consumers.get(name) ?? 0) + 1);
  return { nodes: selected, consumers, outputNames: [...requested] };
}
