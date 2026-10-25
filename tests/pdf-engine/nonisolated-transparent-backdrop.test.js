import { afterEach, describe, expect, it, vi } from 'vitest';
import { crossfadePdfGroupPixels, scalePdfGroupAlpha, renderPdfDisplayList } from '../../src/pdf/canvas-renderer.js';
import { createPdfGroupSoftMaskSampler } from '../../src/pdf/group-soft-mask.js';
import { syntheticRgbProfile } from './icc-fixture.js';

vi.mock('../../src/pdf/group-soft-mask.js', () => ({ createPdfGroupSoftMaskSampler: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });
const rgba = values => Uint8ClampedArray.from(values);
describe('non-isolated Normal group premultiplied opacity', () => {
  it('applies distinct per-pixel mask values to the premultiplied crossfade', () => {
    const old = rgba(Array(3).fill([40, 80, 120, 128]).flat()), rendered = rgba(Array(3).fill([200, 20, 60, 192]).flat());
    expect([...crossfadePdfGroupPixels(rendered, old, .5, new Float64Array([0, .5, 1]))]).toEqual([40, 80, 120, 128, 93, 60, 100, 144, 136, 44, 84, 160]);
  });
  it('applies the isolated outer constant and mask once to source alpha', () => {
    const pixels = rgba([200, 20, 60, 192, 40, 80, 120, 128]);
    expect(scalePdfGroupAlpha(pixels, .5, new Float64Array([.5, 0]))).toBe(pixels);
    expect([...pixels]).toEqual([200, 20, 60, 48, 40, 80, 120, 0]);
  });
  it.each([new Float64Array([NaN]), new Float64Array([-1]), new Float64Array([1.1]), new Float64Array([]), new Float32Array([.5])])('rejects malformed mask factors even at zero outer opacity', mask => {
    expect(() => crossfadePdfGroupPixels(rgba([1, 2, 3, 4]), rgba([5, 6, 7, 8]), 0, mask)).toThrow(/PDF group/);
  });
  it.each([
    [[10, 40, 200, 0], [200, 50, 20, 128], .5, [200, 50, 20, 64]],
    [[40, 80, 120, 128], [200, 20, 60, 192], .5, [136, 44, 84, 160]],
    [[10, 30, 90, 255], [110, 130, 190, 255], .5, [60, 80, 140, 255]],
    [[100, 100, 200, 128], [200, 10, 20, 0], .5, [100, 100, 200, 64]],
    [[30, 40, 50, 0], [100, 200, 30, 0], .5, [0, 0, 0, 0]],
    [[40, 80, 120, 128], [200, 20, 60, 192], 0, [40, 80, 120, 128]],
    [[40, 80, 120, 128], [200, 20, 60, 192], 1, [200, 20, 60, 192]],
  ])('crossfades backdrop%s and rendered%s at opacity%s', (backdrop, rendered, opacity, expected) => {
    const input = rgba(rendered), old = rgba(backdrop); expect(crossfadePdfGroupPixels(input, old, opacity)).toBe(input);
    expect([...input]).toEqual(expected); expect([...old]).toEqual(backdrop);
  });
  it.each([0, .25, .5, 1])('preserves an empty group at opacity%s without counting its backdrop twice', opacity => {
    const backdrop = rgba([40, 80, 120, 128, 200, 30, 50, 255]);
    expect(crossfadePdfGroupPixels(backdrop.slice(), backdrop, opacity)).toEqual(backdrop);
  });
  it.each([NaN, -1, 1.01, Infinity])('rejects invalid opacity%s', opacity => {
    expect(() => crossfadePdfGroupPixels(rgba([0, 0, 0, 0]), rgba([0, 0, 0, 0]), opacity)).toThrow(/Invalid PDF group/);
  });
  it('rejects mismatched or non-RGBA pixel planes', () => {
    expect(() => crossfadePdfGroupPixels(rgba([1, 2, 3]), rgba([1, 2, 3]), .5)).toThrow(/Invalid PDF group/);
    expect(() => crossfadePdfGroupPixels(rgba([1, 2, 3, 4]), rgba([]), .5)).toThrow(/Invalid PDF group/);
  });
});

// A controlled Canvas test double supplies a known rendered-with-backdrop plane.
// Browser controls independently test actual shape/blend rasterization.
function controlledCanvas(width, height, backdrop, rendered) {
  // Normalized host double for Node22 lifecycle tests, not half-float precision.
  class NormalizedPixels extends Float64Array {}
  vi.stubGlobal('Float16Array', NormalizedPixels);
  const surfaces = [], reads = [], writes = [], copies = [], pixels = Array.from({ length: width * height }, () => backdrop).flat(); let cancel = false;
  function canvas(w, h, group) {
    const surface = { width: w, height: h }, stack = []; let colorType = 'unorm8';
    const ctx = { canvas: surface, pixels: group ? new Uint8ClampedArray(w * h * 4) : rgba(pixels), stack, globalAlpha: 1, globalCompositeOperation: 'source-over', clipBox: null,
      save() { stack.push({ globalAlpha: this.globalAlpha, globalCompositeOperation: this.globalCompositeOperation, clipBox: this.clipBox }); },
      restore() { Object.assign(this, stack.pop()); },
      getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), setTransform() {}, transform() {}, beginPath() {},
      getLineDash: () => [], setLineDash() {},
      getContextAttributes: () => ({ colorType, colorSpace: 'srgb' }),
      fill() { for (let at = 0; at < this.pixels.length; at += 4) this.pixels.set(rendered, at); },
      drawImage(source) {
        copies.push({ group, mode: this.globalCompositeOperation, alpha: this.globalAlpha, clipBox: this.clipBox });
        const input = source.ctx.pixels;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          if (this.clipBox && (x < this.clipBox[0] || x >= this.clipBox[2] || y < this.clipBox[1] || y >= this.clipBox[3])) continue;
          const at = (y * w + x) * 4; this.pixels.set(input.subarray(at, at + 4), at);
        }
      },
      getImageData(x, y, columns, rows, options) {
        reads.push({ group, x, y, columns, rows }); const data = new Uint8ClampedArray(columns * rows * 4);
        for (let row = 0; row < rows; row++) data.set(this.pixels.subarray(((y + row) * w + x) * 4, ((y + row) * w + x + columns) * 4), row * columns * 4);
        return { data: options?.pixelFormat === 'rgba-float16' ? NormalizedPixels.from(data, n => n / 255) : data, width: columns, height: rows };
      },
      putImageData(image, x, y) {
        writes.push({ x, y, width: image.width, height: image.height });
        const data = image.data instanceof NormalizedPixels ? Uint8ClampedArray.from(image.data, n => n * 255) : image.data;
        for (let row = 0; row < image.height; row++) this.pixels.set(data.subarray(row * image.width * 4, (row + 1) * image.width * 4), ((y + row) * w + x) * 4);
        if (fixture.cancelAfterFirstBand) cancel = true;
      },
    };
    surface.ctx = ctx; surface.getContext = (kind, options) => { colorType = options?.colorType || 'unorm8'; return ctx; }; return surface;
  }
  const fixture = { surfaces, reads, writes, copies, cancelled: () => cancel, cancelAfterFirstBand: false };
  fixture.parent = canvas(width, height, false); fixture.ctx = fixture.parent.ctx;
  vi.stubGlobal('OffscreenCanvas', class { constructor(w, h) { const surface = canvas(w, h, true); surfaces.push(surface); return surface; } });
  return fixture;
}
const paint = { op: 'paint', kind: 'f', fillAlpha: 1, strokeAlpha: 1, blend: 'source-over', lineWidth: 1 };
const group = (commands = [paint], alpha = .5, extra = {}) => ({ op: 'group', isolated: false, alpha, blend: 'source-over', commands, ...extra });
const settings = fixture => ({ canvasContext: fixture.ctx, viewport: { transform: [1, 0, 0, 1, 0, 0] }, background: false });
describe('non-isolated group Canvas band/clip lifecycle', () => {
  it('uses the page render basis and one sampled band, preserving masked nonisolated copy semantics', async () => {
    const fixture = controlledCanvas(1, 1, [40, 80, 120, 128], [200, 20, 60, 192]);
    fixture.ctx.getTransform = () => ({ a: 2, b: 0, c: 0, d: 3, e: 7, f: 11 });
    const sampleBand = vi.fn(() => new Float64Array([.5])), budget = { pixels: 0 };
    vi.mocked(createPdfGroupSoftMaskSampler).mockReturnValue({ sampleBand });
    const softMask = { type: 'Luminosity' };
    await renderPdfDisplayList({ commands: [group([paint], .5, { softMask })], fonts: [] }, {
      ...settings(fixture), transform: [1, 0, 0, 1, -5, -8], viewport: { transform: [1.5, 0, 0, -1.5, 0, 200] }, surfaceBudget: budget,
    }).promise;
    expect(createPdfGroupSoftMaskSampler).toHaveBeenCalledWith(softMask, expect.objectContaining({ pageTransform: [3, 0, 0, -4.5, -3, 587], surfaceBudget: budget }));
    expect(sampleBand).toHaveBeenCalledExactlyOnceWith(0, 0, 1, 1);
    expect([...fixture.ctx.pixels]).toEqual([93, 60, 100, 144]); expect(fixture.copies.at(-1)).toMatchObject({ mode: 'copy', alpha: 1 }); expect(budget.pixels).toBe(0);
  });
  it('scales isolated mask alpha before final source-over without applying outer opacity twice', async () => {
    const fixture = controlledCanvas(1, 1, [40, 80, 120, 128], [200, 20, 60, 192]);
    vi.mocked(createPdfGroupSoftMaskSampler).mockReturnValue({ sampleBand: () => new Float64Array([.5]) });
    await renderPdfDisplayList({ commands: [group([paint], .5, { isolated: true, softMask: {} })], fonts: [] }, settings(fixture)).promise;
    expect([...fixture.surfaces[0].ctx.pixels]).toEqual([200, 20, 60, 48]);
    expect(fixture.copies.at(-1)).toMatchObject({ mode: 'source-over', alpha: 1 });
  });
  it.each([null, undefined, new Float64Array([]), new Float64Array([NaN])])('rejects missing or invalid sampled mask bands without copying partial output', async sampled => {
    const fixture = controlledCanvas(1, 1, [40, 80, 120, 128], [200, 20, 60, 192]), budget = { pixels: 0 };
    vi.mocked(createPdfGroupSoftMaskSampler).mockReturnValue({ sampleBand: () => sampled });
    await expect(renderPdfDisplayList({ commands: [group([paint], .5, { softMask: {} })], fonts: [] }, { ...settings(fixture), surfaceBudget: budget }).promise).rejects.toMatchObject({ code: 'pdf_corrupt' });
    expect(fixture.copies.some(copy => !copy.group)).toBe(false); expect(budget.pixels).toBe(0);
    expect(fixture.surfaces.every(surface => surface.width === 0 && surface.height === 0)).toBe(true);
  });
  it('bounds masked bands on ultra-wide surfaces and cancels before their final copy', async () => {
    const fixture = controlledCanvas(262145, 1, [40, 80, 120, 128], [200, 20, 60, 192]); fixture.cancelAfterFirstBand = true;
    const sampleBand = vi.fn((left, top, width, height) => new Float64Array(width * height).fill(.5)), budget = { pixels: 0 };
    vi.mocked(createPdfGroupSoftMaskSampler).mockReturnValue({ sampleBand });
    await expect(renderPdfDisplayList({ commands: [group([paint], .5, { softMask: {} })], fonts: [] }, {
      ...settings(fixture), shouldCancel: fixture.cancelled, surfaceBudget: budget,
    }).promise).rejects.toMatchObject({ name: 'RenderingCancelledException' });
    expect(sampleBand).toHaveBeenCalledExactlyOnceWith(0, 0, 262144, 1);
    expect(fixture.copies.some(copy => !copy.group)).toBe(false); expect(budget.pixels).toBe(0);
    expect(fixture.surfaces.every(surface => surface.width === 0 && surface.height === 0)).toBe(true);
  });
  it('rejects an absent sampler instead of treating a declared mask as unmasked', async () => {
    const fixture = controlledCanvas(1, 1, [0, 0, 0, 0], [0, 0, 0, 0]);
    vi.mocked(createPdfGroupSoftMaskSampler).mockReturnValue(null);
    await expect(renderPdfDisplayList({ commands: [group([paint], .5, { softMask: {} })], fonts: [] }, settings(fixture)).promise).rejects.toMatchObject({ code: 'pdf_corrupt' });
    expect(fixture.copies.some(copy => !copy.group)).toBe(false);
  });
  it('copies the premultiplied result under the real inherited clip, with alpha1 and restored state', async () => {
    const fixture = controlledCanvas(3, 1, [40, 80, 120, 128], [200, 20, 60, 192]); fixture.ctx.clipBox = [1, 0, 2, 1];
    const budget = { pixels: 0 }; await renderPdfDisplayList({ commands: [group()], fonts: [] }, { ...settings(fixture), surfaceBudget: budget }).promise;
    expect([...fixture.ctx.pixels]).toEqual([40, 80, 120, 128, 136, 44, 84, 160, 40, 80, 120, 128]);
    expect(fixture.copies.at(-1)).toMatchObject({ group: false, mode: 'copy', alpha: 1, clipBox: [1, 0, 2, 1] });
    expect(fixture.ctx.stack).toHaveLength(0); expect(budget.pixels).toBe(0);
    expect(fixture.surfaces.every(surface => surface.width === 0 && surface.height === 0)).toBe(true);
  });
  it('composes nested non-isolated groups on a partial-alpha parent without duplicate backdrop alpha', async () => {
    const fixture = controlledCanvas(1, 1, [40, 80, 120, 128], [200, 20, 60, 192]);
    await renderPdfDisplayList({ commands: [group([group()])], fonts: [] }, settings(fixture)).promise;
    expect([...fixture.ctx.pixels]).toEqual([93, 60, 100, 144]); expect(fixture.surfaces).toHaveLength(2);
    expect(fixture.surfaces.every(surface => surface.width === 0 && surface.height === 0)).toBe(true);
  });
  it('bounds every backdrop/rendered read to262144pixels, including very wide one-row surfaces', async () => {
    const fixture = controlledCanvas(262145, 1, [10, 30, 90, 255], [110, 130, 190, 255]);
    await renderPdfDisplayList({ commands: [group()], fonts: [] }, settings(fixture)).promise;
    expect(fixture.writes).toEqual([{ x: 0, y: 0, width: 262144, height: 1 }, { x: 262144, y: 0, width: 1, height: 1 }]);
    expect(fixture.reads.every(read => read.columns * read.rows <= 262144)).toBe(true);
    expect([...fixture.ctx.pixels.subarray(-4)]).toEqual([60, 80, 140, 255]);
  });
  it('cancels between bands before copying and releases the surface/budget', async () => {
    const fixture = controlledCanvas(1024, 513, [40, 80, 120, 128], [200, 20, 60, 192]); fixture.cancelAfterFirstBand = true;
    const budget = { pixels: 0 }, task = renderPdfDisplayList({ commands: [group()], fonts: [] }, { ...settings(fixture), shouldCancel: fixture.cancelled, surfaceBudget: budget });
    await expect(task.promise).rejects.toMatchObject({ name: 'RenderingCancelledException' });
    expect(fixture.copies.some(copy => !copy.group)).toBe(false); expect([...fixture.ctx.pixels.subarray(0, 4)]).toEqual([40, 80, 120, 128]);
    expect(budget.pixels).toBe(0); expect(fixture.surfaces.every(surface => surface.width === 0 && surface.height === 0)).toBe(true);
  });
  it('keeps non-Normal outer blend and changed ICC profile guards explicit before allocation', async () => {
    const fixture = controlledCanvas(1, 1, [0, 0, 0, 0], [0, 0, 0, 0]);
    await expect(renderPdfDisplayList({ commands: [group([], .5, { blend: 'multiply' })], fonts: [] }, settings(fixture)).promise).rejects.toThrow(/outer blend/);
    await expect(renderPdfDisplayList({ commands: [group([], .5, { isolated: true, blend: 'multiply', softMask: {} })], fonts: [] }, settings(fixture)).promise).rejects.toThrow(/outer blend/);
    await expect(renderPdfDisplayList({ commands: [group([], .5, { colorProfile: syntheticRgbProfile() })], fonts: [] }, settings(fixture)).promise).rejects.toThrow(/change blend color space/);
    expect(fixture.surfaces).toHaveLength(0);
  });
});
