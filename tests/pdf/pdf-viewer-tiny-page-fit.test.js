// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';
import { createPdfViewport } from '../../src/pdf/viewport.js';
import { normalizePositive } from '../../src/lib/number-validation.js';
import { createPdfToolbarState, getPdfPageViewport } from '../../src/lib/pdf-viewer-toolbar.js';

const container = { width: 1000, height: 700, padding: 40 };
const cases = [
  [0.001, 100, 200, 0, 0, 330, 660],
  [0.005, 100, 200, 0, 0, 330, 660],
  [0.005, 200, 100, 0, 0, 960, 480],
  [0.001, 100, 200, 90, 0, 960, 480],
  [0.001, 100, 200, 90, 90, 330, 660],
  [1, 100, 200, 0, 0, 330, 660],
];
it.each(cases)('fits physical unit%s box%s×%s intrinsic%s toolbar%s without independent source-axis floors', (userUnit, width, height, rotation, toolbarRotation, expectedWidth, expectedHeight) => {
  const page = { getViewport: settings => createPdfViewport([0, 0, width, height], { userUnit, rotation, ...settings }) };
  const state = createPdfToolbarState({ fitMode: 'page', rotation: toolbarRotation });
  const layout = getPdfPageViewport(page.getViewport({ scale: 1 }), state, container);
  const render = page.getViewport({ scale: layout.scale, rotation: layout.rotation });
  expect(layout.width).toBe(expectedWidth); expect(layout.height).toBe(expectedHeight);
  expect(render.width).toBeCloseTo(expectedWidth, 10); expect(render.height).toBeCloseTo(expectedHeight, 10);
});
// The actual private cache function is isolated without initializing the viewer
// or changing its body. Its only external inputs are this Map and pure validator.
function actualCache() {
  const source = readFileSync(new URL('../../src/pdf-viewer.js', import.meta.url), 'utf8');
  const begin = source.indexOf('async function getPdfPageBaseViewport('), end = source.indexOf('\n}', begin) + 2;
  expect(begin).toBeGreaterThan(-1); expect(end).toBeGreaterThan(begin);
  return vm.runInNewContext(`${source.slice(begin, end)}; getPdfPageBaseViewport`, { pageBaseViewports: new Map(), normalizePositive });
}
it('keeps the actual cached physical fractions, UserUnit and intrinsic rotation before fitting', async () => {
  const cached = actualCache(); let gets = 0, cleanups = 0;
  const pdf = { async getPage() { gets++; return { getViewport: () => createPdfViewport([0, 0, 100, 200], { userUnit: .001, rotation: 90 }), cleanup() { cleanups++; } }; } };
  const base = await cached(pdf, 1);
  expect(base).toMatchObject({ width: .2, height: .1, userUnit: .001, rotation: 90 });
  expect(await cached(pdf, 1)).toBe(base); expect(gets).toBe(1); expect(cleanups).toBe(1);
  expect(getPdfPageViewport(base, createPdfToolbarState({ fitMode: 'page' }), container)).toMatchObject({ width: 960, height: 480 });
});
it('keeps positive default dimensions and public normal rounding while normalizing invalid source metadata', () => {
  expect(getPdfPageViewport({ width: 600, height: 800 }, createPdfToolbarState(), container)).toEqual({ width: 960, height: 1280, scale: 1.6, rotation: 0 });
  for (const value of [0, -1, NaN, Infinity]) {
    const layout = getPdfPageViewport({ width: value, height: value }, createPdfToolbarState({ fitMode: 'page' }), container);
    expect(layout).toEqual({ width: 660, height: 660, scale: 660, rotation: 0 });
  }
});
