import { describe, expect, it, vi } from 'vitest';
import { createPdfGroupSoftMaskSampler } from '../../src/pdf/group-soft-mask.js';
import { renderPdfDisplayList } from '../../src/pdf/canvas-renderer.js';

const identity = [1, 0, 0, 1, 0, 0], bytes = new Uint8Array([1]);
const xyz = inks => {
  const y = (1 - inks[3]) * (1 - inks[0]) * (1 - inks[1]) * (1 - inks[2]);
  return [.95 * y, y, 1.1 * y];
};
const inverse = ([, y]) => [.2 * y, .1 * y, .05 * y, 1 - y];
const profile = { channels: 4, toXyz: xyz, fromXyz: inverse };
const fn = () => ({ type: 2, inputs: 1, outputs: 1, domain: [0, 1], range: null, c0: [.5], c1: [.5], exponent: 1 });
const descriptor = () => ({ type: 'Luminosity', nativeColorSpace: 'ICCBased4', profileBytes: bytes, backdropUnresolved: true, backdrop: null,
  bbox: [-10, -10, 10, 10], matrix: [...identity], shading: { type: 2, coords: [0, 0, 2, 0], domain: [0, 1], box: null, extend: [true, true], matrix: [...identity],
    colorSpace: { name: 'DeviceGray' }, functions: [fn()] } });
function sampler(mask, changes = {}) {
  return createPdfGroupSoftMaskSampler(mask, { profileCache: new WeakMap([[bytes, profile]]), deviceExtent: [0, 0, 2, 2], surfaceBudget: { pixels: 0 }, ...changes });
}

describe('explicit ICC4 luminosity masks', () => {
  it('uses the explicit inverse then forward profile; it never assumes their round trip is identity', () => {
    const mask = descriptor(), budget = { pixels: 0 };
    const values = sampler(mask, { surfaceBudget: budget }).sampleBand(0, 0, 2, 2);
    const expected = .5 * .9 * .95 * .975;
    for (const value of values) expect(value).toBeCloseTo(expected, 14);
    expect(expected).not.toBe(.5); expect(budget).toEqual({ pixels: 0, shadingPixels: 4 });
  });
  it('mixes all four encoded channels with explicit BC before deriving nonlinear luminance', () => {
    const mask = descriptor(); mask.backdropUnresolved = false; mask.backdrop = [.4, .3, .2, .1]; mask.bbox = [.5, 0, 1.5, 1];
    const values = sampler(mask).sampleBand(0, 0, 3, 1), source = [.1, .05, .025, .5];
    const mix = source.map((v, i) => (v + mask.backdrop[i]) / 2), expected = xyz(mix)[1];
    expect(values[0]).toBeCloseTo(expected, 14); expect(values[1]).toBeCloseTo(expected, 14); expect(values[2]).toBeCloseTo(xyz(mask.backdrop)[1], 14);
    expect(expected).not.toBeCloseTo((xyz(source)[1] + xyz(mask.backdrop)[1]) / 2, 5);
  });
  it('uses captured basis plus caller transform for the whole-extent proof', () => {
    const mask = descriptor(); mask.matrix = [2, .1, -.2, 2, 3, 4];
    expect(() => sampler(mask, { pageTransform: [1.5, 0, 0, -1.5, -2, 3] })).not.toThrow();
    mask.bbox = [0, 0, 1, 1]; expect(() => sampler(mask)).toThrow(/without BC must cover/);
  });
  it.each([
    ['missing extent', () => {}, { deviceExtent: null }], ['edge margin', m => { m.bbox = [-2, -2, 4, 4]; }],
    ['partial', m => { m.bbox = [0, 0, 1, 1]; }], ['outside', m => { m.bbox = [20, 20, 30, 30]; }],
    ['nonextended', m => { m.shading.extend[1] = false; }], ['radial', m => { m.shading.type = 3; }],
    ['remapped Gray', m => { m.shading.colorSpace.name = 'ICCBased'; }],
    ['Type4', m => { m.shading.functions[0].type = 4; }],
    ['sparse BC', m => { m.backdropUnresolved = false; m.backdrop = Array(4); }],
    ['sparse bbox', m => { delete m.bbox[2]; }], ['sparse matrix', m => { delete m.matrix[0]; }],
    ['sparse function', m => { delete m.shading.functions[0].c0[0]; }],
    ['sparse children', m => { m.shading.functions[0] = { ...fn(), type: 3, functions: Array(1), bounds: [], encode: [0, 1] }; }],
    ['cycle', m => { const f = { ...fn(), type: 3, bounds: [], encode: [0, 1] }; f.functions = [f]; m.shading.functions = [f]; }],
    ['nonfinite corners', m => { m.matrix = [1e308, 0, 1e308, 1, 0, 0]; m.bbox = [1, -1, -1, 1]; }],
  ])('preflights %s without sampling or charging work', (_label, change, settings = {}) => {
    const mask = descriptor(), budget = { pixels: 0 }; change(mask);
    expect(() => sampler(mask, { surfaceBudget: budget, ...settings })).toThrow(); expect(budget).toEqual({ pixels: 0 });
  });
  it('requires a real supported four-channel inverse before accepting even zero-area usage', () => {
    const mask = descriptor(), cache = new WeakMap([[bytes, { channels: 4, toXyz: xyz }]]);
    expect(() => sampler(mask, { profileCache: cache })).toThrow(/explicit supported profile inverse/);
  });
  it.each([
    ['reversed domain', f => { f.domain = [1, 0]; }], ['reversed range', f => { f.range = [1, 0]; }],
    ['function domain excludes shading input', f => { f.domain = [.5, 1]; }],
    ['bounds outside domain', f => { Object.assign(f, { type: 3, functions: [fn(), fn()], bounds: [2], encode: [0, 1, 0, 1] }); }],
    ['nonincreasing bounds', f => { Object.assign(f, { type: 3, functions: [fn(), fn(), fn()], bounds: [.7, .6], encode: [0, 1, 0, 1, 0, 1] }); }],
    ['zero domain with multiple children', f => { Object.assign(f, { type: 3, domain: [.5, .5], functions: [fn(), fn()], bounds: [.5], encode: [0, 1, 0, 1] }); }],
  ])('refuses malformed function %s at alpha0 before allocating a scratch surface', async (_label, mutate) => {
    const mask = descriptor(); mutate(mask.shading.functions[0]);
    const group = { op: 'group', sourceContribution: 'normal-icc4-v1', nativeColorSpace: 'ICCBased4', colorProfile: bytes, isolated: false, alpha: 0, blend: 'source-over', softMask: mask,
      commands: [{ op: 'path', kind: 're', args: [0, 0, 2, 2] }, { op: 'paint', kind: 'f', fillAlpha: 1, nativeCmykFill: [0, 0, 0, 0] }] };
    const allocation = vi.fn(); vi.stubGlobal('OffscreenCanvas', allocation);
    const ctx = { canvas: { width: 2, height: 2 }, save() {}, restore() {}, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), setTransform() {}, transform() {}, beginPath() {} };
    const budget = { pixels: 0 };
    try {
      await expect(renderPdfDisplayList({ commands: [group], fonts: [] }, { canvasContext: ctx, viewport: { transform: identity }, background: false, surfaceBudget: budget,
        profileCache: new WeakMap([[bytes, profile]]) }).promise).rejects.toMatchObject({ code: 'pdf_corrupt' });
      expect(allocation).not.toHaveBeenCalled(); expect(budget.pixels).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });
  it('retains valid endpoint bounds and single-child singleton domains', () => {
    const mask = descriptor(); mask.shading.functions[0] = { type: 3, inputs: 1, outputs: 1, domain: [0, 1], range: null, functions: [fn(), fn()], bounds: [0], encode: [0, 1, 0, 1] };
    expect(() => sampler(mask)).not.toThrow();
    mask.shading.functions[0] = { ...mask.shading.functions[0], domain: [.5, .5], functions: [fn()], bounds: [], encode: [0, 1] };
    mask.shading.domain = [.5, .5];
    expect(() => sampler(mask)).not.toThrow();
  });
  it('rejects sampling outside the proved extent, and caps shared work before allocation', () => {
    const value = sampler(descriptor()); expect(() => value.sampleBand(-1, 0, 1, 1)).toThrow(/without BC must cover/);
    const budget = { pixels: 0, shadingPixels: 64_000_000 };
    expect(() => sampler(descriptor(), { surfaceBudget: budget }).sampleBand(0, 0, 1, 1)).toThrow(expect.objectContaining({ code: 'pdf_limit' }));
    expect(budget).toEqual({ pixels: 0, shadingPixels: 64_000_000 });
  });
  it('checks cancellation before profile parsing and during the band', () => {
    const cancelled = new Error('cancelled'), check = vi.fn(() => { throw cancelled; });
    expect(() => sampler(descriptor(), { cancellation: check })).toThrow(cancelled); expect(check).toHaveBeenCalledTimes(1);
    let calls = 0; const value = sampler(descriptor(), { cancellation: () => { if (++calls === 4) throw cancelled; } });
    expect(() => value.sampleBand(0, 0, 2, 2)).toThrow(cancelled);
  });
});
