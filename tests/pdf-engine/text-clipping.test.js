// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PdfTextClipper } from '../../src/pdf/text-clip.js';

const identity = [1, 0, 0, 1, 0, 0];
const rectangle = (left = 0, bottom = 0, right = 4, top = 4) => [
  { op: 1, points: [left, bottom] }, { op: 2, points: [right, bottom] },
  { op: 2, points: [right, top] }, { op: 2, points: [left, top] }, { op: 4, points: [] },
];
const glyph = (outline = rectangle(), extra = {}) => ({ x: 0, y: 0, fontMatrix: identity, outline, ...extra });
const command = glyphs => ({ groups: [{ matrix: identity, glyphs }] });
const cancelled = () => Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' });
const longOutline = () => [
  { op: 1, points: [0, 0] }, ...Array(4096).fill({ op: 2, points: [4, 0] }),
  { op: 2, points: [4, 4] }, { op: 2, points: [0, 4] }, { op: 4, points: [] },
];

class RecordedPath {
  constructor() { this.commands = []; }
  moveTo(...p) { this.commands.push(['m', ...p]); }
  lineTo(...p) { this.commands.push(['l', ...p]); }
  bezierCurveTo(...p) { this.commands.push(['c', ...p]); }
  closePath() { this.commands.push(['h']); }
}
function context(width = 40, height = 40) {
  const original = [1.5, .25, .5, 2, 7, 9], clips = []; let matrix = [...original];
  return { canvas: { width, height }, original, clips,
    getTransform: () => Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((name, i) => [name, matrix[i]])),
    setTransform: vi.fn((...value) => { matrix = value; }),
    clip: vi.fn((path, rule) => clips.push({ path, rule, matrix: [...matrix] })),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), bezierCurveTo: vi.fn(), closePath: vi.fn(),
  };
}
// Independent winding oracle for the small recorded straight-line controls.
// Canvas rasterization/AA is verified separately by the actual browser corpus.
function windingAt(commands, x, y) {
  let current, start, winding = 0;
  const edge = end => {
    const cross = (end[0] - current[0]) * (y - current[1]) - (end[1] - current[1]) * (x - current[0]);
    if (current[1] <= y && end[1] > y && cross > 0) winding++;
    if (current[1] > y && end[1] <= y && cross < 0) winding--;
    current = end;
  };
  for (const [op, ...p] of commands) {
    if (op === 'm') { current = start = p; }
    else if (op === 'l') edge(p);
    else if (op === 'h') edge(start);
    else throw Error('Straight-line control expected');
  }
  return winding;
}

beforeEach(() => vi.stubGlobal('Path2D', RecordedPath));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('original browser text clipping', () => {
  it('preserves a glyph hole in one nonzero clip', async () => {
    const hole = [{ op: 1, points: [1, 1] }, { op: 2, points: [1, 3] }, { op: 2, points: [3, 3] }, { op: 2, points: [3, 1] }, { op: 4, points: [] }];
    const ctx = context(); await new PdfTextClipper(() => {}).apply(command([glyph([...rectangle(), ...hole])]), ctx, identity);
    expect(ctx.clip).toHaveBeenCalledOnce(); expect(ctx.clips[0].rule).toBe('nonzero');
    expect(windingAt(ctx.clips[0].path.commands, .5, .5)).toBe(1);
    expect(windingAt(ctx.clips[0].path.commands, 2, 2)).toBe(0);
  });

  it.each([{ directions: [1, -1], winding: 0 }, { directions: [1, -1, 1], winding: 1 }])('preserves the global signed winding: $directions', async ({ directions, winding }) => {
    const ctx = context(), glyphs = directions.map(direction => glyph(rectangle(), { fontMatrix: [direction, 0, 0, 1, direction < 0 ? 4 : 0, 0] }));
    await new PdfTextClipper(() => {}).apply(command(glyphs), ctx, identity);
    expect(ctx.clip).toHaveBeenCalledOnce(); expect(ctx.clips[0].rule).toBe('nonzero');
    expect(windingAt(ctx.clips[0].path.commands, 2, 2)).toBe(winding);
  });

  it('keeps both signed lobes of a self-intersecting source path', async () => {
    const outline = [{ op: 1, points: [0, 0] }, { op: 2, points: [4, 4] }, { op: 2, points: [0, 4] }, { op: 2, points: [4, 0] }, { op: 4, points: [] }];
    const ctx = context(); await new PdfTextClipper(() => {}).apply(command([glyph(outline)]), ctx, identity);
    expect(windingAt(ctx.clips[0].path.commands, 2, 1)).toBe(-1);
    expect(windingAt(ctx.clips[0].path.commands, 2, 3)).toBe(1);
  });

  it('passes thin coordinates and original cubic controls to Canvas without quantization or flattening', async () => {
    const outline = [...rectangle(.069, 0, .181, 1), { op: 1, points: [2, 3] }, { op: 3, points: [4, 8, 6, 12, 8, 16] }, { op: 4, points: [] }];
    const ctx = context(); await new PdfTextClipper(() => {}).apply(command([glyph(outline)]), ctx, identity);
    expect(ctx.clips[0].path.commands).toEqual([
      ['m', .069, 0], ['l', .181, 0], ['l', .181, 1], ['l', .069, 1], ['h'],
      ['m', 2, 3], ['c', 4, 8, 6, 12, 8, 16], ['h'],
    ]);
    expect(windingAt(ctx.clips[0].path.commands.slice(0, 5), .125, .5)).toBe(1);
  });

  it('applies page, text and font transforms once while preserving CTM and the ordinary current path', async () => {
    const ctx = context(), c = { groups: [{ matrix: [1, 0, 0, 1, 3, 4], glyphs: [glyph([{ op: 1, points: [2, 4] }, { op: 3, points: [4, 8, 6, 12, 8, 16] }, { op: 4, points: [] }], { x: 5, y: 6, fontMatrix: [.5, 0, 0, .25, 0, 0] })] }] };
    await new PdfTextClipper(() => {}).apply(c, ctx, [2, 0, 0, -2, 10, 20]);
    expect(ctx.clips[0]).toMatchObject({ rule: 'nonzero', matrix: identity });
    expect(ctx.clips[0].path.commands).toEqual([['m', 28, -2], ['c', 30, -4, 32, -6, 34, -8], ['h']]);
    expect(ctx.setTransform.mock.calls).toEqual([identity, ctx.original]);
    for (const method of ['beginPath', 'moveTo', 'lineTo', 'bezierCurveTo', 'closePath']) expect(ctx[method]).not.toHaveBeenCalled();
    expect(ctx.getTransform()).toEqual(Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((key, i) => [key, ctx.original[i]])));
  });

  it('restores the original CTM when Canvas rejects the clip', async () => {
    const ctx = context(), error = new Error('Canvas failure'); ctx.clip.mockImplementation(() => { throw error; });
    await expect(new PdfTextClipper(() => {}).apply(command([glyph()]), ctx, identity)).rejects.toBe(error);
    expect(ctx.setTransform.mock.calls).toEqual([identity, ctx.original]);
  });

  it.each([{ glyphs: [] }, { glyphs: [glyph([])] }])('leaves the clip unchanged when no actual glyph outline exists: %j', async ({ glyphs }) => {
    const ctx = context(); await new PdfTextClipper(() => {}).apply(command(glyphs), ctx, identity);
    expect(ctx.clip).not.toHaveBeenCalled(); expect(ctx.setTransform).not.toHaveBeenCalled();
  });

  it.each([
    glyph([{ op: 99, points: [] }]), glyph([{ op: 2, points: [1] }]),
    glyph([{ op: 2, points: [1, 2] }]), glyph([{ op: 4, points: [] }]),
    glyph([{ op: 1, points: [Infinity, 0] }]), glyph(rectangle(), { fontMatrix: [1, 0, 0, NaN, 0, 0] }),
  ])('rejects malformed outline data before any clipping: %j', async value => {
    const ctx = context(); await expect(new PdfTextClipper(() => {}).apply(command([value]), ctx, identity)).rejects.toMatchObject({ code: 'pdf_corrupt' });
    expect(ctx.clip).not.toHaveBeenCalled();
  });

  it.each([{ outline: rectangle(1e9 + 1, 0, 1e9 + 2, 1), basis: identity }, { outline: rectangle(), basis: [Number.MAX_VALUE, 0, 0, 1, 0, 0] }])('rejects transformed coordinates outside the original bound: %j', async ({ outline, basis }) => {
    const ctx = context(); await expect(new PdfTextClipper(() => {}).apply(command([glyph(outline)]), ctx, basis)).rejects.toMatchObject({ code: 'pdf_limit' });
    expect(ctx.clip).not.toHaveBeenCalled();
  });

  it.each([[0, 40], [16385, 1], [10000, 3201]])('retains the target surface bound: %s by %s', async (width, height) => {
    const ctx = context(width, height); await expect(new PdfTextClipper(() => {}).apply(command([glyph()]), ctx, identity)).rejects.toMatchObject({ code: 'pdf_limit' });
    expect(ctx.clip).not.toHaveBeenCalled();
  });

  it.each([
    { outline: Array(200001).fill({ op: 4, points: [] }) },
    { outline: [{ op: 1, points: [0, 0] }, ...Array(66667).fill({ op: 3, points: [1, 1, 2, 2, 3, 3] })] },
  ])('retains the weighted point and segment bound', async ({ outline }) => {
    const ctx = context(); await expect(new PdfTextClipper(() => {}).apply(command([glyph(outline)]), ctx, identity)).rejects.toMatchObject({ code: 'pdf_limit' });
    expect(ctx.clip).not.toHaveBeenCalled();
  });

  it('honors cancellation immediately before the final clip mutation', async () => {
    const ctx = context(), error = cancelled(), cancellation = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw error; });
    await expect(new PdfTextClipper(cancellation).apply(command([glyph()]), ctx, identity)).rejects.toBe(error);
    expect(ctx.clip).not.toHaveBeenCalled(); expect(ctx.setTransform).not.toHaveBeenCalled();
  });

  it('yields while constructing large paths and cancels before clipping', async () => {
    vi.useFakeTimers(); const ctx = context(), error = cancelled(); let abort = false;
    const clipper = new PdfTextClipper(() => { if (abort) throw error; });
    const pending = clipper.apply(command([glyph(longOutline())]), ctx, identity);
    expect(ctx.clip).not.toHaveBeenCalled(); abort = true;
    const rejected = expect(pending).rejects.toBe(error); await vi.runAllTimersAsync(); await rejected;
    expect(ctx.clip).not.toHaveBeenCalled(); expect(ctx.setTransform).not.toHaveBeenCalled();
  });

  it('closes a suspended path construction when its render owner disposes', async () => {
    vi.useFakeTimers(); const ctx = context(), clipper = new PdfTextClipper(() => {});
    const pending = clipper.apply(command([glyph(longOutline())]), ctx, identity);
    clipper.dispose(); const rejected = expect(pending).rejects.toMatchObject({ code: 'pdf_closed' }); await vi.runAllTimersAsync(); await rejected;
    expect(ctx.clip).not.toHaveBeenCalled();
  });

  it('keeps disposal idempotent and rejects later work', async () => {
    const ctx = context(), clipper = new PdfTextClipper(() => {}); clipper.dispose(); clipper.dispose();
    await expect(clipper.apply(command([glyph()]), ctx, identity)).rejects.toMatchObject({ code: 'pdf_closed' });
    expect(ctx.clip).not.toHaveBeenCalled();
  });
});
