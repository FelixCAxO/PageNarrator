// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Deterministic asymmetric quantization exercises SIMD columns and scalar tails.
export function kokoroRecurrentFixture({ hidden = 7, features = 17, steps = 3, batch = 2,
  direction = 'bidirectional', wSigned = true, rSigned = false, channels = true } = {}) {
  const directions = direction === 'bidirectional' ? 2 : 1, gates = 4 * hidden;
  const W = wSigned ? Int8Array : Uint8Array, R = rSigned ? Int8Array : Uint8Array;
  const scaleShape = channels ? [directions, gates] : [directions];
  const scales = directions * (channels ? gates : 1);
  const float = (length, seed, divisor) => Float32Array.from({ length }, (_, i) => ((i * seed % 101) - 50) / divisor);
  const specs = [
    [float(steps * batch * features, 17, 64), [steps, batch, features], 'float32'],
    [W.from({ length: directions * features * gates }, (_, i) => (i * 53 + 19) % 256 - (wSigned ? 128 : 0)), [directions, features, gates], wSigned ? 'int8' : 'uint8'],
    [R.from({ length: directions * hidden * gates }, (_, i) => (i * 29 + 7) % 256 - (rSigned ? 128 : 0)), [directions, hidden, gates], rSigned ? 'int8' : 'uint8'],
    [float(directions * 8 * hidden, 13, 256), [directions, 8 * hidden], 'float32'],
    [float(directions * batch * hidden, 23, 128), [directions, batch, hidden], 'float32'],
    [float(directions * batch * hidden, 31, 128), [directions, batch, hidden], 'float32'],
    [Float32Array.from({ length: scales }, (_, i) => (i % 3 + 1) / 4096), scaleShape, 'float32'],
    [W.from({ length: scales }, (_, i) => (i * 47 + 3) % 256 - (wSigned ? 128 : 0)), scaleShape, wSigned ? 'int8' : 'uint8'],
    [Float32Array.from({ length: scales }, (_, i) => (i % 5 + 1) / 4096), scaleShape, 'float32'],
    [R.from({ length: scales }, (_, i) => (i * 61 + 251) % 256 - (rSigned ? 128 : 0)), scaleShape, rSigned ? 'int8' : 'uint8'],
  ];
  return { specs, options: { hiddenSize: hidden, direction } };
}

