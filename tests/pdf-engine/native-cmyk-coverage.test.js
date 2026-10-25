import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPdfCmykCoverage, pdfNativeDeviceBounds } from '../../src/pdf/native-cmyk-coverage.js';

// Normalized host doubles test ownership/arithmetic, never native half precision.
// The independent software-Chromium proof exercises the real Float16Array path.
class NormalizedPixels extends Float64Array {}
let canvases = [], behavior = {};
class CoverageCanvas {
  constructor(width, height) {
    if (behavior.constructorError) throw new Error('surface allocation failed');
    this.width = width; this.height = height; this.level = 0; this.clears = 0; this.reads = [];
    const canvas = this;
    this.context = {
      canvas, getContextAttributes: () => behavior.attributes || { colorType: 'float16', colorSpace: 'srgb' },
      getImageData(left, top, width, height) {
        canvas.reads.push({ left, top, width, height });
        if (behavior.readError) throw new TypeError('read unsupported');
        const data = behavior.unorm ? new Uint8ClampedArray(width * height * 4) : new NormalizedPixels(width * height * 4);
        for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = canvas.level ? 1 : 0; data[i + 3] = behavior.invalid ?? canvas.level; }
        return { data };
      },
      createImageData(width, height) { return { data: behavior.writeUnorm ? new Uint8ClampedArray(width * height * 4) : new NormalizedPixels(width * height * 4), width, height }; },
      putImageData(data) { if (behavior.output) canvas.output = [...data.data]; else expect(data.data.every(value => value === 0)).toBe(true); canvas.level = 0; canvas.clears++; },
      save() {}, restore() {}, setTransform(...values) { canvas.transform = values; }, fillRect(...args) { canvas.quad = args; canvas.level = behavior.fillLevel ?? 1; },
    };
    canvases.push(this);
  }
  getContext() { if (behavior.contextError) throw new TypeError('context unsupported'); return this.context; }
}
function setup() { canvases = []; behavior = {}; vi.stubGlobal('Float16Array', NormalizedPixels); vi.stubGlobal('OffscreenCanvas', CoverageCanvas); }
afterEach(() => vi.unstubAllGlobals());
const nativeImage = () => ({ format: 'native-cmyk', width: 2, height: 1, bits: 8, components: 4, colorSpace: { name: 'DeviceCMYK', components: 4 }, interpolate: false,
  bytes: Uint8Array.of(255, 0, 64, 128, 0, 255, 128, 64), softMask: { width: 2, height: 1, bits: 8, components: 1, bytes: Uint8Array.of(128, 255) } });
const identity = [1, 0, 0, 1, 0, 0], imageMatrix = [2, 0, 0, 1, 0, 0];

describe('one native white coverage owner', () => {
  it('applies CompatibleOverprint to one shared white coverage and grows alpha without erasing zero inks', async () => {
    setup(); const budget = { pixels: 0 }, painter = createPdfCmykCoverage(1, 1, budget);
    try {
      await painter.paint(() => { canvases[0].level = 1; }, [.2, .4, .6, .8], .5, [0, 0, 1, 1]);
      await painter.paint(() => { canvases[0].level = .5; }, [0, .7, 0, .3], .5, [0, 0, 1, 1], undefined, undefined, 'overprint-nonzero');
      const result = painter.surface.data;
      expect(result[0]).toBeCloseTo(.1, 7); expect(result[2]).toBeCloseTo(.3, 7); expect(result[1]).toBeCloseTo(.7 * .25 + .2 * .75, 7);
      expect(result[3]).toBeCloseTo(.3 * .25 + .4 * .75, 7); expect(result[4]).toBe(.625); expect(budget.pixels).toBe(7);
    } finally { painter.destroy(); } expect(budget.pixels).toBe(0);
  });
  it.each(['multiply', 'CompatibleOverprint', '', null])('rejects unsupported elementary token %s before drawing or allocating a band', async token => {
    setup(); const budget = { pixels: 0 }, painter = createPdfCmykCoverage(1, 1, budget), draw = vi.fn();
    try {
      await expect(painter.paint(draw, [0, 0, 0, 0], 0, [0, 0, 1, 1], undefined, undefined, token)).rejects.toMatchObject({ code: 'pdf_unsupported' });
      expect(draw).not.toHaveBeenCalled(); expect(budget.pixels).toBe(7); expect(budget.shadingPixels).toBeUndefined();
    } finally { painter.destroy(); } expect(budget.pixels).toBe(0);
  });
  it('charges5target+2coverage units and releases all ownership idempotently', async () => {
    setup(); const budget = { pixels: 0 }, painter = createPdfCmykCoverage(2, 1, budget);
    try {
      expect(budget.pixels).toBe(14);
      await painter.paint(() => { canvases[0].level = .5; }, [.2, .6, .1, .9], .5, [0, 0, 2, 1]);
      expect(painter.surface.data[4]).toBe(.25); expect(painter.surface.data[9]).toBe(.25);
      expect(painter.surface.data[3] / painter.surface.data[4]).toBeCloseTo(.9, 6);
      expect(budget.pixels).toBe(14); expect(budget.shadingPixels).toBe(2);
    } finally { painter.destroy(); }
    expect(budget.pixels).toBe(0); painter.destroy(); expect(budget.pixels).toBe(0);
    expect(() => painter.color(true)).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
  });

  it('clears prior dirty pixels with putImageData without resetting the current geometry path', async () => {
    setup(); const budget = { pixels: 0 }, painter = createPdfCmykCoverage(2, 1, budget);
    try {
      await painter.paint(() => { canvases[0].level = .5; }, [1, 0, 0, 0], 1, [0, 0, 1, 1]);
      await painter.paint(() => { expect(canvases[0].level).toBe(0); canvases[0].level = .25; }, [0, 1, 0, 0], 1, [1, 0, 2, 1]);
      expect(canvases[0].clears).toBe(1); expect(painter.surface.data[4]).toBe(.5); expect(painter.surface.data[9]).toBe(.25);
    } finally { painter.destroy(); }
    expect(budget.pixels).toBe(0);
  });

  it('applies image source alpha, shared unit-quad geometry and outer opacity once to every ink', async () => {
    setup(); behavior.fillLevel = .25; const budget = { pixels: 0 }, painter = createPdfCmykCoverage(2, 1, budget), source = nativeImage();
    try {
      await painter.image(source, imageMatrix, identity, .5);
      expect(canvases[0].quad).toEqual([0, 0, 1, 1]); expect(canvases[0].transform).toEqual(imageMatrix);
      for (let pixel = 0; pixel < 2; pixel++) {
        const alpha = source.softMask.bytes[pixel] / 255 * .25 * .5;
        expect(painter.surface.data[pixel * 5 + 4]).toBeCloseTo(alpha, 7);
        for (let channel = 0; channel < 4; channel++) expect(painter.surface.data[pixel * 5 + channel]).toBeCloseTo(source.bytes[pixel * 4 + channel] / 255 * alpha, 7);
      }
      expect(budget.pixels).toBe(14); expect(budget.shadingPixels).toBe(4);
    } finally { painter.destroy(); }
    expect(budget.pixels).toBe(0);
  });

  it('uses bounded smaller image bands when only one eight-unit scratch pixel fits', async () => {
    setup(); const budget = { pixels: 15_999_978 }, painter = createPdfCmykCoverage(2, 1, budget);
    try {
      await painter.image(nativeImage(), imageMatrix, identity, 1);
      expect(canvases[0].reads.slice(1).map(read => [read.left, read.width])).toEqual([[0, 1], [1, 1]]);
      expect(budget.pixels).toBe(15_999_992); expect(budget.shadingPixels).toBe(4);
      expect(painter.surface.data[4]).toBeCloseTo(128 / 255, 7); expect(painter.surface.data[9]).toBe(1);
    } finally { painter.destroy(); }
    expect(budget.pixels).toBe(15_999_978);
  });

  it.each(['work', 'cancel', 'scratch', 'descriptor'])('releases image projection and readback ownership on %s failure', async mode => {
    setup(); const budget = { pixels: 0 }, painter = createPdfCmykCoverage(2, 1, budget), source = nativeImage();
    if (mode === 'work') budget.shadingPixels = 64_000_000;
    if (mode === 'scratch') budget.pixels = 15_999_993;
    if (mode === 'descriptor') source.softMask.width = 1;
    const before = budget.pixels, cancelled = new Error('cancelled');
    const cancellation = () => { if (mode === 'cancel' && budget.pixels > before + 6) throw cancelled; };
    try {
      await expect(painter.image(source, imageMatrix, identity, 1, undefined, cancellation)).rejects.toBeTruthy();
      expect(budget.pixels).toBe(before); expect(painter.surface.data.every(value => value === 0)).toBe(true);
    } finally { budget.pixels = 14; painter.destroy(); }
    expect(budget.pixels).toBe(0);
  });

  it('composites an isolated child with one mask, caller clip and outer opacity factor for every premultiplied ink', async () => {
    setup(); behavior.fillLevel = .25; const budget = { pixels: 0 }, parent = createPdfCmykCoverage(1, 1, budget), child = createPdfCmykCoverage(1, 1, budget);
    child.surface.data.set([.1, .2, .3, .4, .5]);
    const sampleBand = vi.fn(() => { expect(budget.pixels).toBe(19); return Float64Array.of(.5); });
    try {
      await parent.composite(child, .5, true, undefined, undefined, { sampleBand });
      [...parent.surface.data].forEach((value, i) => expect(value).toBeCloseTo([.1, .2, .3, .4, .5][i] * .25 * .5 * .5, 7));
      expect(sampleBand).toHaveBeenCalledWith(0, 0, 1, 1); expect(budget.pixels).toBe(14);
      await expect(parent.composite(child, 1, false, undefined, undefined, { sampleBand })).rejects.toMatchObject({ code: 'pdf_unsupported' });
    } finally { child.destroy(); parent.destroy(); }
    expect(budget.pixels).toBe(0);
  });

  it.each([null, undefined, Float32Array.of(.5), new Float64Array(0), Float64Array.of(.5, .5), Float64Array.of(NaN), Float64Array.of(-.1), Float64Array.of(1.1)])('rejects malformed native mask bands before composition: %s', async mask => {
    setup(); const budget = { pixels: 0 }, parent = createPdfCmykCoverage(1, 1, budget), child = createPdfCmykCoverage(1, 1, budget);
    child.surface.data.set([.1, .2, .3, .4, .5]);
    try {
      await expect(parent.composite(child, 1, true, undefined, undefined, { sampleBand: () => mask })).rejects.toMatchObject({ code: 'pdf_corrupt' });
      expect(parent.surface.data.every(value => value === 0)).toBe(true); expect(budget.pixels).toBe(14);
    } finally { child.destroy(); parent.destroy(); }
    expect(budget.pixels).toBe(0);
  });

  it('retains native q/Q colour snapshots without sharing mutable caller arrays', () => {
    setup(); const painter = createPdfCmykCoverage(1, 1, { pixels: 0 });
    try {
      const color = [.2, .3, .4, .5]; painter.setColor(true, color); color[0] = 1;
      painter.save(); painter.setColor(true, [0, 0, 0, 1]); painter.restore();
      expect(painter.color(true)).toEqual([.2, .3, .4, .5]);
      expect(() => painter.restore()).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
      expect(() => painter.setColor(0, [0, 0, 0, 1])).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
    } finally { painter.destroy(); }
  });

  it.each(['missing', 'attributes', 'readback', 'contextError', 'readError', 'constructorError'])('rejects absent or downgraded capabilities and releases reservations: %s', mode => {
    setup(); const budget = { pixels: 3 };
    if (mode === 'missing') vi.stubGlobal('Float16Array', undefined);
    if (mode === 'attributes') behavior.attributes = { colorType: 'unorm8', colorSpace: 'srgb' };
    if (mode === 'readback') behavior.unorm = true;
    if (mode.endsWith('Error')) behavior[mode] = true;
    expect(() => createPdfCmykCoverage(1, 1, budget)).toThrow();
    expect(budget.pixels).toBe(3);
  });

  it('preflights both owners before construction and actual read/extraction scratch before allocation', async () => {
    setup(); const budget = { pixels: 15_999_994 };
    expect(() => createPdfCmykCoverage(1, 1, budget)).toThrow(expect.objectContaining({ code: 'pdf_limit' }));
    expect(canvases).toHaveLength(0); expect(budget.pixels).toBe(15_999_994);
    budget.pixels = 15_999_990; const painter = createPdfCmykCoverage(1, 1, budget);
    try {
      budget.pixels = 15_999_998;
      await expect(painter.paint(() => { canvases[0].level = 1; }, [0, 0, 0, 1], 1, [0, 0, 1, 1])).rejects.toMatchObject({ code: 'pdf_limit' });
      expect(budget.pixels).toBe(15_999_998); expect(painter.surface.data[4]).toBe(0);
      budget.pixels = 15_999_997;
    } finally { painter.destroy(); }
    expect(budget.pixels).toBe(15_999_990);
  });

  it.each([NaN, Infinity, -.1, 1.1])('rejects malformed normalized coverage before modifying target: %s', value => {
    setup(); const budget = { pixels: 0 }, painter = createPdfCmykCoverage(1, 1, budget); behavior.invalid = value;
    return expect(painter.paint(() => { canvases[0].level = .5; }, [0, 0, 0, 1], 1, [0, 0, 1, 1])).rejects.toMatchObject({ code: 'pdf_corrupt' }).finally(() => { expect(painter.surface.data[4]).toBe(0); painter.destroy(); expect(budget.pixels).toBe(0); });
  });

  it('keeps exact shared64M work admission and rejects before target mutation', async () => {
    setup(); const budget = { pixels: 0, shadingPixels: 64_000_000 }, painter = createPdfCmykCoverage(1, 1, budget);
    try { await expect(painter.paint(() => { canvases[0].level = 1; }, [0, 0, 0, 1], 1, [0, 0, 1, 1])).rejects.toMatchObject({ code: 'pdf_limit' }); expect(painter.surface.data[4]).toBe(0); }
    finally { painter.destroy(); }
    expect(budget.pixels).toBe(0);
  });

  it('tiles ultrawide paints to bounded bands and honors cancellation before a later band', async () => {
    setup(); const budget = { pixels: 0 }, painter = createPdfCmykCoverage(262145, 1, budget); let stop = false;
    try {
      const check = () => { if (stop) throw new Error('cancelled'); };
      const paint = painter.paint(() => { canvases[0].level = 1; }, [0, 0, 0, 1], 1, [0, 0, 262145, 1], undefined, check);
      setTimeout(() => { stop = true; }, 0);
      await expect(paint).rejects.toThrow('cancelled');
      expect(canvases[0].reads.every(box => box.width * box.height <= 262144)).toBe(true);
    } finally { painter.destroy(); }
    expect(budget.pixels).toBe(0);
  });

  it('uses all transformed corners and rejects nonfinite geometry', () => {
    expect(pdfNativeDeviceBounds([0, 0, 0, 10, 10, 0, 10, 10], { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 })).toEqual([4, 5, 46, 67]);
    expect(() => pdfNativeDeviceBounds([NaN, 0], { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
  });

  it('converts native unassociated inks through forward PCS directly to the parent profile once', async () => {
    setup(); behavior.output = true; const budget = { pixels: 0 }, painter = createPdfCmykCoverage(1, 1, budget);
    const toXyz = vi.fn(() => [2, -.25, 3]), fromXyz = vi.fn(() => [.1, .3, .7]);
    try {
      painter.surface.data.set([.1, .2, .3, .4, .5]);
      await painter.writeDisplay({ channels: 4, toXyz }, { channels: 3, fromXyz });
      expect(toXyz).toHaveBeenCalledOnce(); toXyz.mock.calls[0][0].forEach((value, i) => expect(value).toBeCloseTo([.2, .4, .6, .8][i], 6));
      expect(fromXyz).toHaveBeenCalledWith([2, -.25, 3]); expect(canvases[0].output).toEqual([.1, .3, .7, .5]);
      expect(budget.pixels).toBe(7); expect(budget.shadingPixels).toBe(1);
      await expect(painter.paint(() => {}, [0, 0, 0, 1], 1, [0, 0, 1, 1])).rejects.toMatchObject({ code: 'pdf_corrupt' });
    } finally { painter.destroy(); }
    expect(budget.pixels).toBe(0);
  });

  it('preserves unassociated forward colour and applies the luminosity mask only to output alpha', async () => {
    setup(); behavior.output = true; const budget = { pixels: 0 }, painter = createPdfCmykCoverage(1, 1, budget);
    painter.surface.data.set([.1, .2, .3, .4, .5]); const toXyz = vi.fn(() => [.2, .4, .6]), fromXyz = vi.fn(() => [.1, .3, .7]);
    try {
      await painter.writeDisplay({ channels: 4, toXyz }, { channels: 3, fromXyz }, undefined, { sampleBand: () => { expect(budget.pixels).toBe(11); return Float64Array.of(.25); } });
      expect(canvases[0].output).toEqual([.1, .3, .7, .125]); expect(toXyz.mock.calls[0][0][3]).toBeCloseTo(.8, 6); expect(budget.pixels).toBe(7);
    } finally { painter.destroy(); }
    expect(budget.pixels).toBe(0);
  });

  it.each(['absent', 'work', 'scratch', 'cancel'])('fails masked display without final copy and releases scratch on %s', async mode => {
    setup(); behavior.output = true; const budget = { pixels: 0 }, painter = createPdfCmykCoverage(1, 1, budget);
    painter.surface.data.set([.1, .2, .3, .4, .5]);
    const sampleBand = () => mode === 'absent' ? null : Float64Array.of(.5);
    if (mode === 'work') budget.shadingPixels = 64_000_000;
    if (mode === 'scratch') budget.pixels = 15_999_997;
    const before = budget.pixels, cancel = () => { if (mode === 'cancel' && budget.pixels > before + 2) throw new Error('cancelled'); };
    try {
      await expect(painter.writeDisplay({ channels: 4, toXyz: () => [.1, .2, .3] }, null, cancel, { sampleBand })).rejects.toBeTruthy();
      expect(canvases[0].output).toBeUndefined(); expect(budget.pixels).toBe(before);
    } finally { budget.pixels = 7; painter.destroy(); }
    expect(budget.pixels).toBe(0);
  });

  it.each(['invalidInk', 'invalidPcs', 'invalidTarget', 'unorm', 'work'])('fails display conversion without copying a partial band and releases scratch: %s', mode => {
    setup(); behavior.output = true; const budget = { pixels: 0 }, painter = createPdfCmykCoverage(1, 1, budget);
    painter.surface.data.set([.1, .2, .3, .4, .5]);
    const source = { channels: 4, toXyz: () => [.2, .3, .4] }, target = { channels: 3, fromXyz: () => [.1, .2, .3] };
    if (mode === 'invalidInk') painter.surface.data[0] = .75;
    if (mode === 'invalidPcs') source.toXyz = () => [NaN, 0, 0];
    if (mode === 'invalidTarget') target.channels = 4;
    if (mode === 'unorm') behavior.writeUnorm = true;
    if (mode === 'work') budget.shadingPixels = 64_000_000;
    return expect(painter.writeDisplay(source, target)).rejects.toBeTruthy().finally(() => {
      expect(canvases[0].output).toBeUndefined(); expect(budget.pixels).toBe(7); painter.destroy(); expect(budget.pixels).toBe(0);
    });
  });
});
