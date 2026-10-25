import { afterEach, describe, expect, it, vi } from 'vitest';
import { crossfadePdfGroupPixels, scalePdfGroupAlpha, renderPdfDisplayList } from '../../src/pdf/canvas-renderer.js';
import { createPdfGroupSoftMaskSampler } from '../../src/pdf/group-soft-mask.js';
import { syntheticRgbProfile } from './icc-fixture.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { pdfPayloadBuffers } from '../../src/pdf/payload-buffers.js';
import { simplePdf, stream, options } from './fixtures.js';

vi.mock('../../src/pdf/group-soft-mask.js', async importOriginal => ({ ...await importOriginal(), createPdfGroupSoftMaskSampler: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

// Node22 has no Float16Array. This explicitly normalized test double checks
// arithmetic/host-failure lifecycle; real half precision is tested in Chromium.
class NormalizedPixels extends Float64Array {}
function fixture({ width = 1, height = 1, contextType = 'float16', contextSpace = 'srgb', readback = true, allocationError = false, contextError = false, readbackError = false } = {}) {
  vi.stubGlobal('Float16Array', NormalizedPixels);
  const state = { surfaces: [], reads: [], styles: [], requests: [], finalCopies: 0, allocations: 0, cancel: false };
  function canvas(group) {
    const surface = { width, height }, stack = []; let type = group ? contextType : 'unorm8';
    const ctx = { canvas: surface, fillStyle: 'black', strokeStyle: 'black', globalAlpha: 1, globalCompositeOperation: 'source-over',
      save() { stack.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, globalAlpha: this.globalAlpha, globalCompositeOperation: this.globalCompositeOperation }); },
      restore() { Object.assign(this, stack.pop()); }, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), setTransform() {}, transform() {}, beginPath() {},
      getLineDash: () => [], setLineDash() {}, getContextAttributes: () => ({ colorType: type, colorSpace: contextSpace }),
      fill() { state.styles.push(this.fillStyle); },
      drawImage() { if (!group) state.finalCopies++; },
      getImageData(x, y, columns, rows, options) {
        if (options?.pixelFormat === 'rgba-float16' && readbackError) throw new TypeError('Pixel format unavailable.');
        state.reads.push({ group, x, y, columns, rows, format: options?.pixelFormat });
        const precise = options?.pixelFormat === 'rgba-float16' && readback;
        return { data: precise ? new NormalizedPixels(columns * rows * 4).fill(.5) : new Uint8ClampedArray(columns * rows * 4).fill(128), width: columns, height: rows };
      },
      putImageData() { if (state.cancelAfterPut) state.cancel = true; },
    };
    surface.ctx = ctx; surface.getContext = (kind, options) => { state.requests.push({ group, kind, options }); if (contextError) throw new TypeError('Canvas type unavailable.'); type = group && options?.colorType === 'float16' ? contextType : 'unorm8'; return ctx; }; return surface;
  }
  state.parent = canvas(false); state.ctx = state.parent.ctx;
  vi.stubGlobal('OffscreenCanvas', class { constructor() { state.allocations++; if (allocationError) throw new Error('Allocation rejected.'); const surface = canvas(true); state.surfaces.push(surface); return surface; } });
  vi.mocked(createPdfGroupSoftMaskSampler).mockReturnValue({ sampleBand: (x, y, columns, rows) => new Float64Array(columns * rows).fill(.5) });
  return state;
}
const group = (changes = {}) => ({ op: 'group', isolated: false, alpha: .5, blend: 'source-over', softMask: {}, commands: [], ...changes });
const render = (f, command, surfaceBudget = { pixels: 0 }) => renderPdfDisplayList({ commands: [command], fonts: [] }, { canvasContext: f.ctx, viewport: { transform: [1, 0, 0, 1, 0, 0] }, background: false, surfaceBudget, shouldCancel: () => f.cancel }).promise;

describe('normalized high-precision group planes', () => {
  it('crossfades straight normalized components through premultiplied alpha', () => {
    fixture(); const source = new NormalizedPixels([.8, .1, .3, .75]), old = new NormalizedPixels([.2, .4, .6, .5]);
    crossfadePdfGroupPixels(source, old, .5, new Float64Array([.5]));
    const alpha = .75 * .25 + .5 * .75;
    expect(source[3]).toBeCloseTo(alpha, 14);
    [.8, .1, .3].forEach((n, i) => expect(source[i]).toBeCloseTo((n * .75 * .25 + old[i] * .5 * .75) / alpha, 14));
    expect([...old]).toEqual([.2, .4, .6, .5]);
  });
  it('scales normalized isolated alpha once', () => {
    fixture(); const source = new NormalizedPixels([.8, .1, .3, .75]);
    expect(scalePdfGroupAlpha(source, .5, new Float64Array([.5]))).toBe(source); expect([...source]).toEqual([.8, .1, .3, .1875]);
  });
  it.each([NaN, Infinity, -.1, 1.01])('rejects invalid normalized components even at zero group opacity: %s', bad => {
    fixture(); expect(() => scalePdfGroupAlpha(new NormalizedPixels([bad, .1, .3, .5]), 0, null)).toThrow(/PDF group/);
    expect(() => crossfadePdfGroupPixels(new NormalizedPixels([.1, .2, .3, .5]), new NormalizedPixels([.1, .2, .3, bad]), 0)).toThrow(/PDF group/);
  });
  it('rejects mixed byte and normalized planes', () => {
    fixture(); expect(() => crossfadePdfGroupPixels(new NormalizedPixels([.1, .2, .3, .5]), new Uint8ClampedArray(4), .5)).toThrow(/PDF group/);
  });
});

describe('masked Canvas capability and byte-equivalent admission', () => {
  it('retains exact native ICC paint components across payload transfer and fresh compilation', async () => {
    const bytes = simplePdf('/P cs .1 .8 .3 sc 0 0 20 20 re f', { page: '/Group << /S /Transparency /CS [/ICCBased 6 0 R] >> /Resources << /ColorSpace << /P [/ICCBased 6 0 R] >> >>', extra: [stream(syntheticRgbProfile(), '/N 3')] });
    const core = await createPdfDocumentCore(bytes, options);
    try {
      const payload = await core.pagePayload(1), native = payload.commands[0].commands.find(c => c.value === 'rgb(26,204,77)').nativeColor;
      expect(native[0]).toBe(.1); expect(native[1]).toBe(.8); expect(native[2]).toBeCloseTo(.3, 14);
      expect(native.map(n => Math.round(n * 255))).toEqual([26, 204, 77]);
      const cloned = structuredClone(payload, { transfer: pdfPayloadBuffers(payload) });
      expect(cloned.commands[0].commands.find(c => c.value === 'rgb(26,204,77)').nativeColor).toEqual(native);
      core.cleanup(1); const fresh = (await core.pagePayload(1)).commands[0].commands.find(c => c.value === 'rgb(26,204,77)').nativeColor;
      expect(fresh).toEqual(native); expect(fresh).not.toBe(native);
    } finally { core.destroy(); }
  });
  it('keeps the default nonmasked path8bit without needing Float16Array', async () => {
    const f = fixture(), budget = { pixels: 15_999_999 }; vi.stubGlobal('Float16Array', undefined);
    await render(f, group({ softMask: null }), budget); expect(budget.pixels).toBe(15_999_999);
    expect(f.requests[0].options?.colorType).not.toBe('float16'); expect(f.reads.every(r => r.format === undefined)).toBe(true);
  });
  it('rejects absent Float16Array before allocation or ledger changes', async () => {
    const f = fixture(), budget = { pixels: 3 }; vi.stubGlobal('Float16Array', undefined);
    await expect(render(f, group(), budget)).rejects.toMatchObject({ code: 'pdf_unsupported' }); expect(f.allocations).toBe(0); expect(budget.pixels).toBe(3);
  });
  it.each([{ contextType: 'unorm8' }, { contextSpace: 'display-p3' }, { readback: false }, { contextError: true }, { readbackError: true }])('rejects missing or downgraded Canvas capability and releases allocation: %j', async settings => {
    const f = fixture(settings), budget = { pixels: 3 };
    await expect(render(f, group(), budget)).rejects.toMatchObject({ code: 'pdf_unsupported' }); expect(budget.pixels).toBe(3); expect(f.finalCopies).toBe(0);
    expect(f.surfaces.every(s => s.width === 0 && s.height === 0)).toBe(true);
  });
  it('charges two byte-equivalent pixels and rejects one unit beyond the cap before allocation', async () => {
    const f = fixture(), budget = { pixels: 15_999_998 }; await render(f, group(), budget); expect(budget.pixels).toBe(15_999_998); expect(f.allocations).toBe(1);
    const other = fixture(), exceeded = { pixels: 15_999_999 };
    await expect(render(other, group(), exceeded)).rejects.toMatchObject({ code: 'pdf_limit' }); expect(other.allocations).toBe(0); expect(exceeded.pixels).toBe(15_999_999);
  });
  it('releases byte-equivalent admission if surface allocation throws', async () => {
    const f = fixture({ allocationError: true }), budget = { pixels: 7 };
    await expect(render(f, group(), budget)).rejects.toThrow('Allocation rejected'); expect(budget.pixels).toBe(7); expect(f.finalCopies).toBe(0);
  });
  it('reads both sides normalized and keeps masks/bands bounded', async () => {
    const f = fixture(), budget = { pixels: 0 }; await render(f, group(), budget);
    expect(f.reads.some(r => r.group && r.format === 'rgba-float16')).toBe(true); expect(f.reads.some(r => !r.group && r.format === 'rgba-float16')).toBe(true);
    expect(f.reads.every(r => r.columns * r.rows <= 262144)).toBe(true); expect(budget.pixels).toBe(0); expect(f.finalCopies).toBe(1);
  });
  it('retains native fractional colours only within the high-precision target', async () => {
    const c = { op: 'color', fill: true, value: 'rgb(26,204,77)', nativeColor: [.1, .8, .3] }, paint = { op: 'paint', kind: 'f', fillAlpha: 1, blend: 'source-over' };
    const f = fixture(); await render(f, group({ commands: [c, paint] })); expect(f.styles).toContain('color(srgb 0.1 0.8 0.3)');
    const old = fixture(); await render(old, group({ softMask: null, commands: [c, paint] })); expect(old.styles).toContain('rgb(26,204,77)');
  });
  it.each([[NaN, .1, .2], 0])('rejects malformed native colour and releases the high-precision surface: %j', async nativeColor => {
    const f = fixture(), budget = { pixels: 0 };
    await expect(render(f, group({ commands: [{ op: 'color', fill: true, value: 'red', nativeColor }] }), budget)).rejects.toMatchObject({ code: 'pdf_corrupt' }); expect(budget.pixels).toBe(0); expect(f.finalCopies).toBe(0);
  });
  it('uses the existing explicit8bit quantization before an ICC profile boundary', async () => {
    const f = fixture(); await render(f, group({ isolated: true, colorProfile: syntheticRgbProfile() }));
    expect(f.reads.some(r => r.group && r.format === undefined)).toBe(true); expect(f.finalCopies).toBe(1);
  });
  it('cancels between normalized bands before final copy and releases both byte units', async () => {
    const f = fixture({ width: 262145 }); f.cancelAfterPut = true; const budget = { pixels: 0 };
    await expect(render(f, group(), budget)).rejects.toMatchObject({ name: 'RenderingCancelledException' }); expect(f.finalCopies).toBe(0); expect(budget.pixels).toBe(0);
    expect(f.surfaces.every(s => s.width === 0 && s.height === 0)).toBe(true);
  });
});
