import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderPdfShading } from '../../src/pdf/shading.js';
import { PdfStrokePath } from '../../src/pdf/stroke-adjust.js';

afterEach(() => vi.unstubAllGlobals());
const ramp = { type: 2, domain: [0, 1], inputs: 1, outputs: 3, c0: [0, 1, 0], c1: [1, 0, 1], exponent: 1 };
const command = { type: 2, colorSpace: { name: 'DeviceRGB' }, functions: [ramp], coords: [0, 0, 40, 0], domain: [0, 1], extend: [true, true], box: null };
const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
function target(width = 40, height = 30) {
  const writes = [], surfaces = [], state = [], pixels = new Map();
  vi.stubGlobal('ImageData', class { constructor(data, w, h) { Object.assign(this, { data, width: w, height: h }); } });
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(w, h) { Object.assign(this, { width: w, height: h }); surfaces.push(this); }
    getContext() { return { putImageData: image => { this.image = image; writes.push(image); } }; }
  });
  return { writes, surfaces, state, pixels, ctx: {
    canvas: { width, height }, getTransform: () => identity,
    save() { state.push(1); }, restore() { state.pop(); }, setTransform() {},
    drawImage(surface, x, y) {
      const image = surface.image;
      for (let row = 0; row < image.height; row++) for (let col = 0; col < image.width; col++) {
        const at = (row * image.width + col) * 4;
        pixels.set(`${x + col},${y + row}`, [...image.data.subarray(at, at + 4)]);
      }
    },
  } };
}

describe('conservative device clip bounds for exact PDF shading', () => {
  it('keeps every computed pixel byte identical at its original device center', async () => {
    const full = target(); await renderPdfShading(command, full.ctx);
    const clipped = target(), budget = { pixels: 0 };
    await renderPdfShading(command, clipped.ctx, { clipBounds: [10, 8, 20, 18], surfaceBudget: budget });
    expect(clipped.pixels.size).toBe(100); expect(budget.shadingPixels).toBe(100);
    for (const [key, rgba] of clipped.pixels) expect(rgba).toEqual(full.pixels.get(key));
    expect(clipped.pixels.get('10,8')).toEqual([67, 188, 67, 255]);
    expect(clipped.state).toHaveLength(0); expect(clipped.surfaces[0]).toMatchObject({ width: 0, height: 0 });
  });
  it('avoids unobservable full-page calculator work while preserving both work limits', async () => {
    const clipped = target(8001, 8001), budget = { pixels: 0 };
    const tint = { type: 4, domain: [0, 1], range: [0, 1, 0, 1, 0, 1], inputs: 1, outputs: 3, program: '{dup dup}' };
    await renderPdfShading({ ...command, functions: [tint] }, clipped.ctx, { clipBounds: [10, 10, 12, 12], surfaceBudget: budget });
    expect(clipped.pixels.size).toBe(4); expect(budget.shadingPixels).toBe(4);
    await expect(renderPdfShading(command, target(8001, 8001).ctx)).rejects.toMatchObject({ code: 'pdf_limit' });
    await expect(renderPdfShading(command, target().ctx, { clipBounds: [0, 0, 1, 1], surfaceBudget: { pixels: 0, shadingPixels: 64_000_000 } })).rejects.toMatchObject({ code: 'pdf_limit' });
  });
  it('does no shading work for an empty intersection', async () => {
    const out = target(), budget = { pixels: 0 };
    await renderPdfShading(command, out.ctx, { clipBounds: [50, 0, 60, 10], surfaceBudget: budget });
    expect(out.writes).toEqual([]); expect(out.surfaces).toEqual([]); expect(budget.shadingPixels).toBeUndefined();
  });
  it('captures the conservative cubic hull under construction-time transforms', () => {
    const path = new PdfStrokePath();
    path.add('m', [2, 3], identity);
    path.add('v', [-5, 4, 6, 7], { a: -2, b: 1, c: .5, d: 3, e: 10, f: -4 });
    path.add('y', [-3, -9, 4, 2], identity);
    expect(path.bounds()).toEqual([-3, -9, 22, 23]);
    path.reset(); path.add('re', [10, 20, -8, -15], identity);
    expect(path.bounds()).toEqual([2, 5, 10, 20]);
    path.reset(); path.add('l', [1, 2], null); expect(path.bounds()).toBeNull();
  });
});
