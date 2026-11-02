// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
const f = Math.fround;
function reverseBits(value, bits) {
  let result = 0;
  for (let i = 0; i < bits; i++) { result = result * 2 + (value & 1); value >>>= 1; }
  return result;
}
const multiply = (a, b) => [f(f(a[0] * b[0]) - f(a[1] * b[1])), f(f(a[0] * b[1]) + f(a[1] * b[0]))];

// Only frame-length constants cross JS; signal processing stays on the GPU.
export function stftCoefficients(length) {
  if (!Number.isInteger(length) || length < 1 || length > 64) throw new RangeError('STFT frame length must be 1..64.');
  const chirped = Boolean(length & (length - 1));
  let size = 1, bits = 0;
  while (size < (chirped ? 2 * length - 1 : length)) { size *= 2; bits++; }
  const angular = f(f(-2 * f(Math.PI)) / size), twiddle = Array(size);
  for (let i = 0; i < size; i++) {
    const angle = f(i * angular);
    twiddle[reverseBits(i, bits)] = [f(Math.cos(angle)), f(Math.sin(angle))];
  }
  const chirp = Array.from({ length }, (_, i) => {
    const angle = f(f(f(-f(Math.PI) * i) * i) / length);
    return [f(Math.cos(angle)), f(Math.sin(angle))];
  });
  function fft(input) {
    const values = Array.from({ length: size }, (_, i) => multiply([1, 0], input[reverseBits(i, bits)]));
    for (let width = 2, stage = 1; width <= size; width *= 2, stage++) {
      const half = width / 2;
      for (let i = 0; i < half; i++) for (let block = 0; block < size; block += width) {
        const low = values[block + i], high = values[block + i + half];
        const a = multiply(twiddle[reverseBits(i, stage)], high), b = multiply(twiddle[reverseBits(i + half, stage)], high);
        values[block + i] = [f(low[0] + a[0]), f(low[1] + a[1])];
        values[block + i + half] = [f(low[0] + b[0]), f(low[1] + b[1])];
      }
    }
    return values;
  }
  const kernel = Array.from({ length: size }, () => [0, 0]);
  if (chirped) {
    for (let i = 0; i < length; i++) kernel[i] = [chirp[i][0], -chirp[i][1]];
    for (let i = size - length + 1; i < size; i++) kernel[i] = kernel[size - i];
  }
  const values = Float32Array.from([...twiddle.flat(), ...chirp.flat(), ...fft(kernel).flat()]);
  return { size, bits, values: new Uint32Array(values.buffer) };
}
