// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPdfCmykSurface, paintPdfCmykBand, copyPdfCmykBand, scalePdfCmykBand, crossfadePdfCmykBand, sourceOverPdfCmykBand, sourceOverPdfCmykSamples } from '../../src/pdf/native-cmyk-surface.js';

afterEach(() => vi.unstubAllGlobals());
const box = { left: 0, top: 0, width: 1, height: 1 };
function near(values, expected) { values.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 6)); }
describe('owned native CMYKA Float32 surfaces', () => {
  it('keeps all four distinct inks and composites the shared coverage once', () => {
    const budget = { pixels: 0 }, s = createPdfCmykSurface(2, 1, budget);
    try {
      paintPdfCmykBand(s, { ...box, width: 2 }, [.2, .6, .1, .9], .5, Float64Array.of(1, .5));
      near([...s.data], [.1, .3, .05, .45, .5, .05, .15, .025, .225, .25]);
      paintPdfCmykBand(s, box, [.8, .1, .7, .2], .25);
      near([...s.data.slice(0, 5)], [.275, .25, .2125, .3875, .625]);
      near([...s.data.slice(5)], [.05, .15, .025, .225, .25]);
      expect(budget.shadingPixels).toBe(3); expect(budget.pixels).toBe(10);
    } finally { s.destroy(); }
    expect(budget.pixels).toBe(0); s.destroy(); expect(budget.pixels).toBe(0);
  });
  it('retains a tiny alpha rather than rounding the source to zero', () => {
    const s = createPdfCmykSurface(1, 1, { pixels: 0 });
    try {
      paintPdfCmykBand(s, box, [17, 91, 153, 223].map(n => n / 255), 1 / 65535);
      expect(s.data[4]).toBeGreaterThan(0);
      for (let i = 0; i < 4; i++) expect(s.data[i] / s.data[4] * 255).toBeCloseTo([17, 91, 153, 223][i], 4);
    } finally { s.destroy(); }
  });
  it('uses subtractive Multiply for each independent ink with one shared alpha and coverage', () => {
    const budget = { pixels: 0 }, s = createPdfCmykSurface(3, 1, budget), band = { ...box, width: 3 };
    try {
      paintPdfCmykBand(s, band, [.2, .6, .1, .9], .5);
      paintPdfCmykBand(s, band, [.8, .1, .7, .2], .25, Float64Array.of(0, .5, 1), undefined, 'multiply');
      near([...s.data], [.1, .3, .05, .45, .5, .19, .30875, .133125, .46375, .5625, .28, .3175, .21625, .4775, .625]);
      expect(budget.shadingPixels).toBe(6);
    } finally { s.destroy(); }
  });
  it('handles transparent backdrops and opaque white without inferring inks from RGB', () => {
    const s = createPdfCmykSurface(1, 1, { pixels: 0 });
    try {
      paintPdfCmykBand(s, box, [.2, .6, .1, .9], .5, null, undefined, 'multiply');
      near([...s.data], [.1, .3, .05, .45, .5]);
      paintPdfCmykBand(s, box, [0, 0, 0, 0], 1, null, undefined, 'multiply');
      near([...s.data], [.1, .3, .05, .45, 1]);
      paintPdfCmykBand(s, box, [0, 0, 0, 1], .25, null, undefined, 'multiply');
      near([...s.data], [.1, .3, .05, .5875, 1]);
    } finally { s.destroy(); }
  });
  it('rejects unsupported native ink blends before mutation or work charge', () => {
    const budget = { pixels: 0 }, s = createPdfCmykSurface(1, 1, budget);
    try {
      expect(() => paintPdfCmykBand(s, box, [0, 0, 0, 1], 1, null, undefined, 'screen')).toThrowError(expect.objectContaining({ code: 'pdf_unsupported' }));
      expect([...s.data]).toEqual([0, 0, 0, 0, 0]); expect(budget.shadingPixels).toBeUndefined();
    } finally { s.destroy(); }
  });
  it.each([new Array(4), Object.assign(new Array(4), { 0: 0, 3: 1 })])('rejects missing ink components before mutation or work charge: %j', color => {
    const budget = { pixels: 0 }, s = createPdfCmykSurface(1, 1, budget);
    try {
      expect(() => paintPdfCmykBand(s, box, color, 1, null, undefined, 'overprint-nonzero')).toThrowError(expect.objectContaining({ code: 'pdf_corrupt' }));
      expect([...s.data]).toEqual([0, 0, 0, 0, 0]); expect(budget.shadingPixels).toBeUndefined();
    } finally { s.destroy(); }
    expect(budget.pixels).toBe(0);
  });
  it('keeps fully covered inks equal to the shared alpha after repeated translucent Multiply', () => {
    const s = createPdfCmykSurface(1, 1, { pixels: 0 });
    try {
      for (let i = 0; i < 1024; i++) {
        paintPdfCmykBand(s, box, [1, 1, 1, 1], (i % 7 + 1) / 255, null, undefined, 'multiply');
        for (let c = 0; c < 4; c++) expect(s.data[c]).toBe(s.data[4]);
      }
    } finally { s.destroy(); }
  });
  it('overprints zero direct CMYK components while replacing nonzero components on an opaque backdrop', () => {
    const budget = { pixels: 0 }, s = createPdfCmykSurface(1, 1, budget);
    try {
      paintPdfCmykBand(s, box, [.2, .6, .1, .9], 1);
      paintPdfCmykBand(s, box, [0, .3, -0, .2], 1, null, undefined, 'overprint-nonzero');
      near([...s.data], [.2, .3, .1, .2, 1]); expect(budget.shadingPixels).toBe(2);
    } finally { s.destroy(); }
    expect(budget.pixels).toBe(0);
  });
  it('preserves premultiplied zero-component inks rather than unassociated colour when overprint grows alpha', () => {
    const s = createPdfCmykSurface(1, 1, { pixels: 0 });
    try {
      paintPdfCmykBand(s, box, [.2, .6, .1, .9], .5);
      paintPdfCmykBand(s, box, [0, .3, 0, .2], .25, null, undefined, 'overprint-nonzero');
      near([...s.data], [.1, .3, .05, .3875, .625]);
      paintPdfCmykBand(s, box, [0, 0, 0, 0], 1, null, undefined, 'overprint-nonzero');
      near([...s.data], [.1, .3, .05, .3875, 1]);
    } finally { s.destroy(); }
  });
  it('retains source alpha for zero-ink overprint on transparency and recognizes tiny nonzero ink', () => {
    const s = createPdfCmykSurface(1, 1, { pixels: 0 });
    try {
      paintPdfCmykBand(s, box, [0, 0, 0, 0], .25, null, undefined, 'overprint-nonzero');
      near([...s.data], [0, 0, 0, 0, .25]);
      paintPdfCmykBand(s, box, [.2, .6, .1, .9], 1);
      paintPdfCmykBand(s, box, [2 ** -24, 0, 0, 0], 1, null, undefined, 'overprint-nonzero');
      expect(s.data[0]).toBe(2 ** -24); near([...s.data.slice(1)], [.6, .1, .9, 1]);
      paintPdfCmykBand(s, box, [0, 0, 0, 0], 1);
      expect([...s.data]).toEqual([0, 0, 0, 0, 1]);
    } finally { s.destroy(); }
  });
  it('applies shared overprint coverage once and respects interior row strides', () => {
    const s = createPdfCmykSurface(4, 4, { pixels: 0 }), all = { ...box, width: 4, height: 4 }, band = { left: 1, top: 1, width: 2, height: 2 };
    try {
      paintPdfCmykBand(s, all, [.2, .6, .1, .9], .5);
      paintPdfCmykBand(s, band, [0, .3, 0, .2], .5, Float64Array.of(0, .25, .5, 1), undefined, 'overprint-nonzero');
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        const at = (y * 4 + x) * 5, alpha = x >= 1 && x < 3 && y >= 1 && y < 3 ? [0, .125, .25, .5][(y - 1) * 2 + x - 1] : 0;
        near([...s.data.slice(at, at + 5)], [.1, .3, .05, .45 * (1 - alpha) + .2 * alpha, .5 + .5 * alpha]);
      }
    } finally { s.destroy(); }
  });
  it('copies a native backdrop and applies nonisolated group opacity in premultiplied channels', () => {
    const budget = { pixels: 0 }, backdrop = createPdfCmykSurface(1, 1, budget), s = createPdfCmykSurface(1, 1, budget);
    try {
      paintPdfCmykBand(backdrop, box, [.2, .6, .1, .9], .5);
      copyPdfCmykBand(s, backdrop, box);
      paintPdfCmykBand(s, box, [.8, .1, .7, .2], .25);
      crossfadePdfCmykBand(s, backdrop, box, .5);
      near([...s.data], [.1875, .275, .13125, .41875, .5625]);
      near([...backdrop.data], [.1, .3, .05, .45, .5]);
    } finally { s.destroy(); backdrop.destroy(); }
    expect(budget.pixels).toBe(0);
  });
  it('applies isolated group opacity once and retains native ink ratios', () => {
    const s = createPdfCmykSurface(1, 1, { pixels: 0 });
    try {
      paintPdfCmykBand(s, box, [.2, .6, .1, .9], .5);
      scalePdfCmykBand(s, box, .25); near([...s.data], [.025, .075, .0125, .1125, .125]);
      scalePdfCmykBand(s, box, 0); expect([...s.data]).toEqual([0, 0, 0, 0, 0]);
    } finally { s.destroy(); }
  });
  it('composites variable native child pixels with opacity and caller clipping once', () => {
    const budget = { pixels: 0 }, source = createPdfCmykSurface(3, 1, budget), s = createPdfCmykSurface(3, 1, budget), band = { ...box, width: 3 };
    try {
      paintPdfCmykBand(s, band, [.2, .6, .1, .9], .4);
      paintPdfCmykBand(source, band, [.8, .1, .7, .2], 1, Float32Array.of(.25, .5, .75));
      sourceOverPdfCmykBand(s, source, band, .5, Float64Array.of(0, .5, 1));
      near([...s.data], [.08, .24, .04, .36, .4, .17, .2225, .1225, .34, .475, .35, .1875, .2875, .3, .625]);
      near([...source.data.slice(0, 5)], [.2, .025, .175, .05, .25]);
    } finally { source.destroy(); s.destroy(); }
    expect(budget.pixels).toBe(0);
  });
  it('preserves the original backdrop outside a fractional nonisolated caller clip', () => {
    const budget = { pixels: 0 }, backdrop = createPdfCmykSurface(2, 1, budget), s = createPdfCmykSurface(2, 1, budget), band = { ...box, width: 2 };
    try {
      paintPdfCmykBand(backdrop, band, [.2, .6, .1, .9], .5); copyPdfCmykBand(s, backdrop, band);
      paintPdfCmykBand(s, band, [.8, .1, .7, .2], .25);
      crossfadePdfCmykBand(s, backdrop, band, .5, Float32Array.of(0, .5));
      near([...s.data], [.1, .3, .05, .45, .5, .14375, .2875, .090625, .434375, .53125]);
    } finally { s.destroy(); backdrop.destroy(); }
  });
  it('reserves five byte-equivalent units per pixel before allocation and rejects overflow', () => {
    const budget = { pixels: 15_999_990 }, s = createPdfCmykSurface(2, 1, budget);
    expect(budget.pixels).toBe(16_000_000);
    expect(() => createPdfCmykSurface(1, 1, budget)).toThrowError(expect.objectContaining({ code: 'pdf_limit' }));
    expect(budget.pixels).toBe(16_000_000); s.destroy(); expect(budget.pixels).toBe(15_999_990);
  });
  it('releases the reservation if the typed-array constructor fails', () => {
    const budget = { pixels: 7 };
    vi.stubGlobal('Float32Array', class { constructor() { throw new Error('allocation failed'); } });
    expect(() => createPdfCmykSurface(1, 1, budget)).toThrow('allocation failed'); expect(budget.pixels).toBe(7);
  });
  it.each([[0, 1], [1.5, 1], [1, Infinity], [NaN, 1], [-1, 2]])('refuses invalid dimensions %j,%j before charging', (w, h) => {
    const budget = { pixels: 0 };
    expect(() => createPdfCmykSurface(w, h, budget)).toThrowError(expect.objectContaining({ code: 'pdf_corrupt' })); expect(budget.pixels).toBe(0);
  });
  it.each([
    { ...box, left: -1 }, { ...box, top: .5 }, { ...box, width: 2 }, { ...box, height: NaN },
  ])('rejects out-of-bounds band before modifying ink/alpha %j', bounds => {
    const s = createPdfCmykSurface(1, 1, { pixels: 0 });
    try { expect(() => paintPdfCmykBand(s, bounds, [0, 0, 0, 1], 1)).toThrowError(expect.objectContaining({ code: 'pdf_corrupt' })); expect([...s.data]).toEqual([0, 0, 0, 0, 0]); }
    finally { s.destroy(); }
  });
  it.each([Float64Array.of(NaN), Float32Array.of(-1), Float64Array.of(1.01), Float64Array.of(), Uint8Array.of(1)])('validates coverage before touching native pixels', coverage => {
    const s = createPdfCmykSurface(1, 1, { pixels: 0 });
    try { expect(() => paintPdfCmykBand(s, box, [0, 0, 0, 1], 1, coverage)).toThrowError(expect.objectContaining({ code: 'pdf_corrupt' })); expect([...s.data]).toEqual([0, 0, 0, 0, 0]); }
    finally { s.destroy(); }
  });
  it('shares its cumulative work admission across paints and group operations', () => {
    const budget = { pixels: 0, shadingPixels: 63_999_999 }, s = createPdfCmykSurface(1, 1, budget);
    try {
      paintPdfCmykBand(s, box, [0, 0, 0, 1], 1); const before = [...s.data];
      expect(() => scalePdfCmykBand(s, box, .5)).toThrowError(expect.objectContaining({ code: 'pdf_limit' }));
      expect([...s.data]).toEqual(before); expect(budget.shadingPixels).toBe(64_000_000);
    } finally { s.destroy(); }
  });
  it('bounds each band and checks cancellation during a paint', () => {
    const budget = { pixels: 0 }, s = createPdfCmykSurface(262145, 1, budget);
    try {
      expect(() => paintPdfCmykBand(s, { ...box, width: 262145 }, [0, 0, 0, 1], 1)).toThrowError(expect.objectContaining({ code: 'pdf_limit' }));
      let checks = 0;
      expect(() => paintPdfCmykBand(s, { ...box, width: 8192 }, [0, 0, 0, 1], 1, null, () => { if (++checks === 2) throw new Error('cancelled'); })).toThrow('cancelled');
      expect(checks).toBe(2); expect(s.data[4095 * 5 + 4]).toBe(1); expect(s.data[4096 * 5 + 4]).toBe(0);
    } finally { s.destroy(); }
    expect(budget.pixels).toBe(0);
  });
  it('rejects use after release', () => {
    const s = createPdfCmykSurface(1, 1, { pixels: 0 }); s.destroy();
    expect(() => scalePdfCmykBand(s, box, 1)).toThrowError(expect.objectContaining({ code: 'pdf_corrupt' }));
  });
  it('uses row strides for an interior band without modifying surrounding pixels', () => {
    const budget = { pixels: 0 }, backdrop = createPdfCmykSurface(4, 4, budget), s = createPdfCmykSurface(4, 4, budget);
    const band = { left: 1, top: 1, width: 2, height: 2 };
    try {
      paintPdfCmykBand(backdrop, band, [.2, .6, .1, .9], .5, Float32Array.of(.25, .5, .75, 1));
      copyPdfCmykBand(s, backdrop, band); scalePdfCmykBand(s, band, .5);
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        const at = (y * 4 + x) * 5, inside = x >= 1 && x < 3 && y >= 1 && y < 3;
        if (inside) near([...s.data.slice(at, at + 5)], [...backdrop.data.slice(at, at + 5)].map(n => n * .5));
        else expect([...s.data.slice(at, at + 5)]).toEqual([0, 0, 0, 0, 0]);
      }
    } finally { s.destroy(); backdrop.destroy(); }
  });
  it('composites a packed image band into interior rows, applying mask, opacity and clip once', () => {
    const budget = { pixels: 0 }, s = createPdfCmykSurface(4, 4, budget), band = { left: 1, top: 1, width: 2, height: 2 };
    const samples = Float32Array.of(.2, .025, .175, .05, .25, .4, .05, .35, .1, .5, .6, .075, .525, .15, .75, 0, 0, 0, 0, 0);
    const before = [...samples], coverage = Float64Array.of(0, .5, 1, 1);
    try {
      paintPdfCmykBand(s, { ...box, width: 4, height: 4 }, [.2, .6, .1, .9], .4);
      sourceOverPdfCmykSamples(s, band, samples, .5, coverage);
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        const at = (y * 4 + x) * 5;
        const expected = x === 2 && y === 1 ? [.17, .2225, .1225, .34, .475]
          : x === 1 && y === 2 ? [.35, .1875, .2875, .3, .625] : [.08, .24, .04, .36, .4];
        near([...s.data.slice(at, at + 5)], expected);
      }
      expect([...samples]).toEqual(before); expect(budget.shadingPixels).toBe(20); expect(budget.pixels).toBe(80);
    } finally { s.destroy(); }
    expect(budget.pixels).toBe(0);
  });
  it.each([
    Float64Array.of(0, 0, 0, 0, 1), Float32Array.of(0, 0, 0, 1), Float32Array.of(NaN, 0, 0, 0, 1),
    Float32Array.of(0, 0, 0, 0, Infinity), Float32Array.of(0, 0, 0, 0, -1), Float32Array.of(0, 0, 0, 0, 1.1),
    Float32Array.of(-.1, 0, 0, 0, 1), Float32Array.of(.6, 0, 0, 0, .5), Float32Array.of(.1, 0, 0, 0, 0),
  ])('rejects malformed or nonpremultiplied image samples before mutation or work charge', samples => {
    const budget = { pixels: 0 }, s = createPdfCmykSurface(1, 1, budget);
    try {
      expect(() => sourceOverPdfCmykSamples(s, box, samples)).toThrowError(expect.objectContaining({ code: 'pdf_corrupt' }));
      expect([...s.data]).toEqual([0, 0, 0, 0, 0]); expect(budget.shadingPixels).toBeUndefined();
    } finally { s.destroy(); }
  });
  it('rejects aliasing, bad image bands, coverage and opacity before changing pixels', () => {
    const budget = { pixels: 0 }, s = createPdfCmykSurface(1, 1, budget), samples = Float32Array.of(0, 0, 0, 1, 1);
    try {
      for (const call of [() => sourceOverPdfCmykSamples(s, box, s.data), () => sourceOverPdfCmykSamples(s, { ...box, left: 1 }, samples),
        () => sourceOverPdfCmykSamples(s, box, samples, NaN), () => sourceOverPdfCmykSamples(s, box, samples, 1, Float32Array.of(2))]) {
        expect(call).toThrowError(expect.objectContaining({ code: 'pdf_corrupt' }));
      }
      expect([...s.data]).toEqual([0, 0, 0, 0, 0]); expect(budget.shadingPixels).toBeUndefined();
      s.destroy(); expect(() => sourceOverPdfCmykSamples(s, box, samples)).toThrowError(expect.objectContaining({ code: 'pdf_corrupt' }));
    } finally { s.destroy(); }
  });
  it('charges image compositing to the shared work limit and enforces the band cap before samples', () => {
    const budget = { pixels: 0, shadingPixels: 64_000_000 }, s = createPdfCmykSurface(262145, 1, budget);
    try {
      expect(() => sourceOverPdfCmykSamples(s, box, Float32Array.of(0, 0, 0, 1, 1))).toThrowError(expect.objectContaining({ code: 'pdf_limit' }));
      expect(() => sourceOverPdfCmykSamples(s, { ...box, width: 262145 }, null)).toThrowError(expect.objectContaining({ code: 'pdf_limit' }));
      expect(budget.shadingPixels).toBe(64_000_000); expect(s.data.every(value => value === 0)).toBe(true);
    } finally { s.destroy(); }
  });
  it('checks cancellation during both image validation and compositing without retaining a source band', () => {
    const budget = { pixels: 0 }, s = createPdfCmykSurface(8192, 1, budget), band = { ...box, width: 8192 }, samples = new Float32Array(8192 * 5);
    for (let i = 0; i < 8192; i++) { samples[i * 5 + 3] = 1; samples[i * 5 + 4] = 1; }
    try {
      let checks = 0;
      expect(() => sourceOverPdfCmykSamples(s, band, samples, 1, null, () => { if (++checks === 2) throw new Error('validate cancelled'); })).toThrow('validate cancelled');
      expect(budget.shadingPixels).toBeUndefined(); expect(s.data.every(value => value === 0)).toBe(true);
      checks = 0;
      expect(() => sourceOverPdfCmykSamples(s, band, samples, 1, null, () => { if (++checks === 4) throw new Error('paint cancelled'); })).toThrow('paint cancelled');
      expect(budget.shadingPixels).toBe(8192); expect(s.data[4095 * 5 + 4]).toBe(1); expect(s.data[4096 * 5 + 4]).toBe(0);
      expect(samples[8191 * 5 + 4]).toBe(1);
    } finally { s.destroy(); }
    expect(budget.pixels).toBe(0);
  });
});
