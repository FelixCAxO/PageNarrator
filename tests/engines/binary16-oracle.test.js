import { expect, it } from 'vitest';
import { binary64ToHalf } from '../../scripts/lib/binary16-oracle.mjs';
import { halfToFloat, floatToHalf } from '../../src/engines/tensor-format.js';

it('retains every binary16 value and handles normative finite/infinite boundaries', () => {
  for (let bits = 0; bits < 65536; bits++) {
    if ((bits & 0x7c00) === 0x7c00 && bits & 1023) continue;
    expect(binary64ToHalf(halfToFloat(bits))).toBe(bits);
  }
  expect(binary64ToHalf(NaN)).toBe(0x7e00);
  expect(binary64ToHalf(65520 - 2 ** -20)).toBe(0x7bff);
  expect(binary64ToHalf(65520)).toBe(0x7c00);
});

it('avoids binary32 double rounding around normal and subnormal half ties', () => {
  const cases = [[1 + 2 ** -11 + 2 ** -25, 0x3c01], [1 + 3 * 2 ** -11 - 2 ** -25, 0x3c01],
    [2 ** -25 + 2 ** -50, 1], [3 * 2 ** -25 - 2 ** -50, 1]];
  for (const [value, bits] of cases) {
    expect(binary64ToHalf(value)).toBe(bits); expect(binary64ToHalf(-value)).toBe(bits | 0x8000);
    expect(floatToHalf(value)).not.toBe(bits);
  }
});
