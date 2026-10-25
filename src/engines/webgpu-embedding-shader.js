// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
/** Each shard writes only the gathered rows that it owns. */
export function embeddingShardShader(type, checked = false) {
  const half = type === 'float16';
  return `${half ? 'enable f16;' : ''}
@group(0) @binding(0) var<storage, read> src: array<${half ? 'f16' : 'u32'}>;
@group(0) @binding(1) var<storage, read> indices: array<i32>;
@group(0) @binding(2) var<storage, read_write> dst: array<${half ? 'f16' : 'u32'}>;
@group(0) @binding(${checked ? 4 : 3}) var<storage, read> cfg: array<u32>;
${checked ? '@group(0) @binding(3) var<storage, read_write> invalid: atomic<u32>;' : ''}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) p: vec3<u32>) {
  let i = p.x + p.y * cfg[4u] * 64u;
  if (i >= cfg[0u]) { return; }
  let selected = indices[i / cfg[1u]];
  ${checked ? 'if (selected < -i32(cfg[3u]) || selected >= i32(cfg[3u])) { atomicOr(&invalid, 1u); return; }' : ''}
  let row = u32(select(selected, selected + i32(cfg[3u]), selected < 0));
  if (row >= cfg[5u] && row < cfg[5u] + cfg[6u]) {
    dst[i] = src[(row - cfg[5u]) * cfg[1u] + i % cfg[1u]];
  }
}`;
}
