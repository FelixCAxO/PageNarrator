// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
export const METADATA_LIMIT = 16384;

/** Integer data inputs that eventually supply lookup indices, excluding shape controls. */
export function indexRangeInputNames(nodes, inputNames, valueTypes, metadataInputs) {
  const producers = new Map(nodes.flatMap(node => node.outputs.map(name => [name, node])));
  const inputs = new Set(inputNames), found = new Set(), visited = new Set();
  const pending = nodes.filter(node => node.opType === 'Gather' && (!node.domain || node.domain === 'ai.onnx')).map(node => node.inputs[1]);
  while (pending.length) {
    const name = pending.pop();
    if (!name || visited.has(name) || ![6, 7].includes(valueTypes.get(name))) continue;
    visited.add(name);
    if (inputs.has(name)) { if (!metadataInputs.has(name)) found.add(name); continue; }
    const node = producers.get(name);
    if (node && node.opType !== 'Shape' && (!node.domain || node.domain === 'ai.onnx')) pending.push(...node.inputs);
  }
  return found;
}

/** Inputs whose values determine tensor dimensions belong in the captured-plan key. */
export function metadataInputNames(nodes, inputNames) {
  const producers = new Map(nodes.flatMap(node => node.outputs.filter(Boolean).map(name => [name, node])));
  const inputs = new Set(inputNames), found = new Set(), visited = new Set();
  const evaluable = new Set(['Identity', 'Cast', 'Gather', 'Unsqueeze', 'Squeeze', 'Concat', 'Reshape', 'Slice',
    'Add', 'Sub', 'Mul', 'Div', 'Ceil', 'Equal', 'Greater', 'GreaterOrEqual', 'Less', 'And', 'Where', 'ConstantOfShape', 'Expand', 'NonZero']);
  for (const root of nodes.flatMap(metadataParameters)) {
    const pending = [root];
    while (pending.length) {
      const name = pending.pop();
      if (!name || visited.has(name)) continue;
      visited.add(name);
      if (inputs.has(name)) { found.add(name); continue; }
      const node = producers.get(name);
      if (node && evaluable.has(node.opType)) pending.push(...node.inputs.toReversed());
      // Shape uses dimensions, so its data input never needs a host copy.
    }
  }
  return found;
}

export function metadataParameters(node) {
  const positions = { Reshape: [1], Squeeze: [1], Unsqueeze: [1], Slice: [1, 2, 3, 4], FusedHalfRotary: [3, 4, 5, 6, 7, 8, 9, 10], Resize: [1, 2, 3],
    Expand: [1], ConstantOfShape: [0], Range: [0, 1, 2], ReduceMean: [1], ReduceSum: [1], ReduceMax: [1], ReduceL2: [1],
    Pad: [1, 2], Clip: [1, 2], Split: [1], STFT: [1, 3], CumSum: [1], NonZero: [0], ScatterND: [1] }[node.opType] ?? [];
  return positions.map(i => node.inputs[i]).filter(Boolean);
}
