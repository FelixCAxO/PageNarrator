// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
export const INTEGER_ADD_SHADER = `
@group(0) @binding(0) var<storage, read> lhs: array<i32>;
@group(0) @binding(1) var<storage, read> rhs: array<i32>;
@group(0) @binding(2) var<storage, read_write> dst: array<i32>;
@group(0) @binding(3) var<storage, read> cfg: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) position: vec3<u32>) {
  let index = position.x + position.y * cfg[7u] * 64u;
  if (index >= cfg[0u]) { return; }
  var ai = 0u; var bi = 0u; var remaining = index;
  for (var axis = i32(cfg[1u]) - 1; axis >= 0; axis -= 1) {
    let coord = remaining % cfg[8u + u32(axis)]; remaining /= cfg[8u + u32(axis)];
    ai += coord * cfg[16u + u32(axis)]; bi += coord * cfg[24u + u32(axis)];
  }
  if (cfg[3u] == 1u) { dst[index] = lhs[ai] * rhs[bi]; }
  else { dst[index] = lhs[ai] + rhs[bi]; }
}
`;

export const GATHER_TENSOR_SHADER = `
@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read> indices: array<i32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<storage, read> cfg: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) position: vec3<u32>) {
  let index = position.x + position.y * cfg[4u] * 64u;
  if (index >= cfg[0u]) { return; }
  let inner = index % cfg[1u]; let outer = index / (cfg[1u] * cfg[2u]);
  let selected = indices[(index / cfg[1u]) % cfg[2u]];
  let source = u32(select(selected, selected + i32(cfg[3u]), selected < 0));
  dst[index] = src[(outer * cfg[3u] + source) * cfg[1u] + inner];
}
`;

export const CHECKED_GATHER_TENSOR_SHADER = GATHER_TENSOR_SHADER
  .replace('@binding(3) var<storage, read> cfg', '@binding(4) var<storage, read> cfg')
  .replace('@compute @workgroup_size(64)', '@group(0) @binding(3) var<storage, read_write> invalid: atomic<u32>;\n@compute @workgroup_size(64)')
  .replace('let source = u32(', 'if (selected < -i32(cfg[3u]) || selected >= i32(cfg[3u])) { atomicOr(&invalid, 1u); return; }\n  let source = u32(');
