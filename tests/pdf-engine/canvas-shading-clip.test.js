import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { multiply } from '../../src/pdf/viewport.js';
import { renderPdfDisplayList } from '../../src/pdf/canvas-renderer.js';

const { shade } = vi.hoisted(() => ({ shade: vi.fn(async () => {}) }));
vi.mock('../../src/pdf/shading.js', () => ({ renderPdfShading: shade }));
beforeEach(() => shade.mockClear());
afterEach(() => vi.unstubAllGlobals());
const identity = [1, 0, 0, 1, 0, 0], viewport = { transform: identity };
function context(width = 200, height = 150, initial = identity) {
  let matrix = [...initial]; const stack = [], curves = [], clips = [];
  const point = (x, y) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
  return { canvas: { width, height }, curves, clips, stack,
    getTransform: () => Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((key, i) => [key, matrix[i]])),
    setTransform(...args) { matrix = args.length === 1 ? ['a', 'b', 'c', 'd', 'e', 'f'].map(key => args[0][key]) : [...args]; },
    transform(...args) { matrix = multiply(matrix, args); },
    save() { stack.push([...matrix]); }, restore() { matrix = stack.pop(); },
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, rect() {},
    bezierCurveTo(...args) { curves.push([point(...args.slice(0, 2)), point(...args.slice(2, 4)), point(...args.slice(4))]); },
    clip(rule) { clips.push(rule); }, fill() {}, stroke() {}, drawImage() {},
    getLineDash: () => [], setLineDash() {},
  };
}
const path = (kind, ...args) => ({ op: 'path', kind, args });
const clip = { op: 'paint', kind: 'n', clip: 'nonzero' }, shading = { op: 'shading' };
const rect = (x, y, w, h) => [path('re', x, y, w, h), clip];
async function run(commands, ctx = context(), extra = {}) {
  await renderPdfDisplayList({ fonts: [], commands }, { canvasContext: ctx, viewport, background: false, ...extra }).promise;
  expect(ctx.stack).toHaveLength(0); return ctx;
}
const bounds = () => shade.mock.calls.map(([, , options]) => options.clipBounds);

describe('Canvas shading clip propagation', () => {
  it('restores saved device clips and intersects later clips independently', async () => {
    await run([...rect(10, 20, 30, 40), shading, { op: 'save' }, ...rect(20, 30, 5, 6), shading,
      { op: 'restore' }, shading, ...rect(35, 45, 20, 30), shading]);
    expect(bounds()).toEqual([[9, 19, 41, 61], [19, 29, 26, 37], [9, 19, 41, 61], [34, 44, 41, 61]]);
  });

  it('keeps the current path across q/Q and uses its construction CTM after restore', async () => {
    await run([{ op: 'save' }, { op: 'transform', args: [2, 0, 0, 3, 10, 20] }, path('re', 2, 3, 4, 5), { op: 'restore' }, clip, shading]);
    expect(bounds()).toEqual([[13, 28, 23, 45]]);
  });

  it('combines initial, viewport and caller transforms only when the path is constructed', async () => {
    await run([path('re', 1, 2, 3, 4), { op: 'setPdfTransform', args: [10, 0, 0, 10, 0, 0] }, clip, shading], context(200, 150, [1, 0, 0, 1, 5, 7]),
      { viewport: { transform: [2, 0, 0, -2, 0, 100] }, transform: [1, 0, 0, 1, 10, 0] });
    expect(bounds()).toEqual([[16, 94, 24, 104]]);
  });

  it('keeps cubic control hulls conservative under shear, negative scale and fractional edges', async () => {
    await run([{ op: 'transform', args: [-1, .5, 2, 1, 70.25, 20.25] }, path('m', 0, 0), path('c', -10, 20, 30, -5, 10, 10), path('h'), clip, shading]);
    expect(bounds()).toEqual([[29, 19, 122, 37]]);
  });

  it('retains an overestimate for unknown path transforms and text clips', async () => {
    const ctx = context(); ctx.getTransform = undefined; const apply = vi.fn(async () => {});
    await run([...rect(10, 10, 20, 20), { op: 'textClip' }, shading], ctx, { textClipper: { apply } });
    expect(bounds()).toEqual([[0, 0, 200, 150]]); expect(apply).toHaveBeenCalledOnce();
  });

  it('keeps known path bounds conservative when a later text clip narrows the actual clip', async () => {
    const apply = vi.fn(async () => {});
    await run([...rect(10, 10, 20, 20), { op: 'textClip' }, shading], context(), { textClipper: { apply } });
    expect(bounds()).toEqual([[9, 9, 31, 31]]); expect(apply).toHaveBeenCalledOnce();
  });

  it('includes every subpath in an even-odd clip and restores after a disjoint nested clip', async () => {
    await run([path('re', 10, 20, 5, 5), path('re', 80, 90, -5, -5), { ...clip, clip: 'evenodd' }, shading,
      { op: 'save' }, ...rect(100, 110, 3, 3), shading, { op: 'restore' }, shading]);
    expect(bounds()).toEqual([[9, 19, 81, 91], [99, 109, 81, 91], [9, 19, 81, 91]]);
  });

  it('passes an immutable inherited device clip through nested group surfaces', async () => {
    const surfaces = [];
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(width, height) { this.width = width; this.height = height; this.ctx = context(width, height); surfaces.push(this); }
      getContext() { this.ctx.canvas = this; return this.ctx; }
    });
    const group = commands => ({ op: 'group', commands, isolated: true, alpha: 1, blend: 'source-over' });
    await run([...rect(10, 20, 30, 40), group([shading, ...rect(20, 30, 5, 6), group([shading])]), shading]);
    expect(bounds()).toEqual([[9, 19, 41, 61], [19, 29, 26, 37], [9, 19, 41, 61]]);
    expect(surfaces).toHaveLength(2); for (const surface of surfaces) expect([surface.width, surface.height]).toEqual([0, 0]);
  });

  it('keeps a cubic v control at the existing device current point across CTM changes', async () => {
    const ctx = await run([path('m', 10, 10), { op: 'transform', args: [10, 0, 0, 10, 0, 0] }, path('v', 1, 1, 2, 2), clip, shading]);
    expect(ctx.curves[0]).toEqual([[10, 10], [10, 10], [20, 20]]);
    expect(bounds()).toEqual([[9, 9, 21, 21]]);
  });
});
