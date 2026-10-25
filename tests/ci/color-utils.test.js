import { describe, expect, it } from 'vitest';
import {
  compositeOverWhite,
  hexToRgbString,
  isDarkColor,
  linearizeSrgb,
  parseCssColor,
  relativeLuminance,
} from '../../src/lib/color-utils.js';

describe('color utilities', () => {
  it('parses CSS RGB/RGBA colors and converts normalized highlight hex colors', () => {
    expect(hexToRgbString('#00aa55')).toBe('0, 170, 85');
    expect(parseCssColor('rgb(17, 34, 51)')).toEqual({ red: 17, green: 34, blue: 51, alpha: 1 });
    expect(parseCssColor('rgb(10 20 30 / 25%)')).toEqual({ red: 10, green: 20, blue: 30, alpha: 0.25 });
  });

  it('detects dark semi-transparent colors after compositing over white', () => {
    expect(isDarkColor(parseCssColor('rgb(17, 17, 17)'))).toBe(true);
    expect(isDarkColor(parseCssColor('rgba(17, 17, 17, 0.2)'))).toBe(false);
    expect(relativeLuminance(compositeOverWhite({ red: 0, green: 0, blue: 0, alpha: 1 }))).toBe(0);
    expect(linearizeSrgb(255)).toBe(1);
  });
});
