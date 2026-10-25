// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
export const PAD_SHADER = `
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<storage, read> cfg: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) position: vec3<u32>) {
  let index = position.x + position.y * cfg[4u] * 64u; if (index >= cfg[0u]) { return; }
  var remaining = index; var source = 0u; var outside = false;
  for (var axis = i32(cfg[1u]) - 1; axis >= 0; axis -= 1) {
    let a = u32(axis); let dim = i32(cfg[32u + a]);
    var coord = i32(remaining % cfg[8u + a]) - bitcast<i32>(cfg[24u + a]); remaining /= cfg[8u + a];
    if (coord < 0 || coord >= dim) {
      if (cfg[2u] == 0u) { outside = true; }
      else if (cfg[2u] == 1u) { coord = clamp(coord, 0, dim - 1); }
      else {
        let period = max(1, (dim - 1) * 2); coord = ((coord % period) + period) % period;
        if (coord >= dim) { coord = period - coord; }
      }
    }
    source += u32(max(0, coord)) * cfg[16u + a];
  }
  if (outside) { dst[index] = bitcast<f32>(cfg[3u]); } else { dst[index] = src[source]; }
}
`;

export const GRID_SAMPLE_SHADER = `
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read> grid: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;
@group(0) @binding(3) var<storage, read> cfg: array<u32>;
fn reflect_coord(value: f32, size: u32) -> f32 {
  let low = select(-0.5, 0.0, cfg[7u] != 0u);
  let span = f32(size) - select(0.0, 1.0, cfg[7u] != 0u);
  if (span == 0.0) { return 0.0; }
  let distance = abs(value - low); let turns = floor(distance / span); let part = distance - turns * span;
  return clamp(low + select(part, span - part, (u32(turns) & 1u) != 0u), 0.0, f32(size - 1u));
}
fn sample_value(plane: u32, h: i32, w: i32) -> f32 {
  if (h < 0 || h >= i32(cfg[2u]) || w < 0 || w >= i32(cfg[3u])) { return 0.0; }
  return src[(plane * cfg[2u] + u32(h)) * cfg[3u] + u32(w)];
}
fn round_even(value: f32) -> i32 {
  let low = floor(value); let part = value - low;
  return i32(low + select(0.0, 1.0, part > 0.5 || (part == 0.5 && (i32(low) & 1) != 0)));
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) position: vec3<u32>) {
  let index = position.x + position.y * cfg[10u] * 64u; if (index >= cfg[0u]) { return; }
  let plane = index / (cfg[4u] * cfg[5u]); let batch = plane / cfg[1u];
  let g = (batch * cfg[4u] * cfg[5u] + index % (cfg[4u] * cfg[5u])) * 2u;
  var h = ((grid[g + 1u] + 1.0) * f32(cfg[2u]) - 1.0) * 0.5;
  var w = ((grid[g] + 1.0) * f32(cfg[3u]) - 1.0) * 0.5;
  if (cfg[7u] != 0u) { h = (grid[g + 1u] + 1.0) * f32(cfg[2u] - 1u) * 0.5; w = (grid[g] + 1.0) * f32(cfg[3u] - 1u) * 0.5; }
  if (cfg[8u] == 1u) { h = clamp(h, 0.0, f32(cfg[2u] - 1u)); w = clamp(w, 0.0, f32(cfg[3u] - 1u)); }
  if (cfg[8u] == 2u) { h = reflect_coord(h, cfg[2u]); w = reflect_coord(w, cfg[3u]); }
  if (cfg[9u] != 0u) { dst[index] = sample_value(plane, round_even(h), round_even(w)); return; }
  let h0 = i32(floor(h)); let w0 = i32(floor(w));
  let top = mix(sample_value(plane, h0, w0), sample_value(plane, h0, w0 + 1), w - f32(w0));
  let bottom = mix(sample_value(plane, h0 + 1, w0), sample_value(plane, h0 + 1, w0 + 1), w - f32(w0));
  dst[index] = mix(top, bottom, h - f32(h0));
}
`;
