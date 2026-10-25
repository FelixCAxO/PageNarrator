import { describe, expect, it } from 'vitest';
import {
  normalizeNonNegative,
  normalizeNonNegativeInteger,
  normalizePercent,
  normalizePositive,
  normalizePositiveInteger,
} from '../../src/lib/number-validation.js';

describe('number validation helpers', () => {
  it('normalizes positive finite numbers without accepting zero', () => {
    expect(normalizePositive('2.5', 1)).toBe(2.5);
    expect(normalizePositive(0, 1)).toBe(1);
    expect(normalizePositive(Number.NaN, 1)).toBe(1);
  });

  it('normalizes non-negative finite numbers without conflating zero with invalid input', () => {
    expect(normalizeNonNegative(0, 7)).toBe(0);
    expect(normalizeNonNegative('3.5', 7)).toBe(3.5);
    expect(normalizeNonNegative(-1, 7)).toBe(7);
  });

  it('normalizes integer variants and clamps percents', () => {
    expect(normalizePositiveInteger('4.9', 1)).toBe(4);
    expect(normalizePositiveInteger(0, 1)).toBe(1);
    expect(normalizeNonNegativeInteger(0, 9)).toBe(0);
    expect(normalizeNonNegativeInteger('4.9', 9)).toBe(4);
    expect(normalizePercent(1.5, 0.25)).toBe(1);
    expect(normalizePercent(-0.2, 0.25)).toBe(0);
    expect(normalizePercent('bad', 0.25)).toBe(0.25);
  });
});
