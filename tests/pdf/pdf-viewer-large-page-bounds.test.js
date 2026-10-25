// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createPdfViewport } from '../../src/pdf/viewport.js';
import { createPdfToolbarState, getPdfPageViewport, updatePdfToolbarState } from '../../src/lib/pdf-viewer-toolbar.js';
import { createVirtualPdfPageRenderer, getCappedOutputScale } from '../../src/lib/pdf-viewer-rendering.js';
const input = {"schema": "large-physical-page-authored-inputs-v1", "geometryCases": [{"id": "unit75000-square-fit-page", "view": [0, 0, 144, 144], "userUnit": 75000, "rotation": 0, "toolbarRotation": 0, "fitMode": "page", "maximumFittedWidth": 660, "maximumFittedHeight": 660}, {"id": "large-unit1-square-fit-page", "view": [0, 0, 1000000, 1000000], "userUnit": 1, "rotation": 0, "toolbarRotation": 0, "fitMode": "page", "maximumFittedWidth": 660, "maximumFittedHeight": 660}, {"id": "sub-milliscale", "view": [0, 0, 100000000, 100000000], "userUnit": 1, "rotation": 0, "toolbarRotation": 0, "fitMode": "page", "maximumFittedWidth": 660, "maximumFittedHeight": 660}, {"id": "large-unit-rotation", "view": [10, 20, 110, 70], "userUnit": 75000, "rotation": 90, "toolbarRotation": 90, "fitMode": "page", "maximumFittedWidth": 960, "maximumFittedHeight": 480}], "container": {"width": 1000, "height": 700, "padding": 40}, "normalToolbar": {"baseWidth": 600, "baseHeight": 800, "width": 960, "height": 1280, "scale": 1.6}, "backingMockCases": {"normal1x": [960, 1280], "normal4x": [3840, 5120], "pixelBoundary": [8000, 4000], "pixelOverflow": [8001, 4000], "sideOverflow": [16385, 1]}, "proposedPolicy": {"maximumPixels": 32000000, "maximumSide": 16384, "basis": "Root-selected explicit PageNarrator viewer allocation policy; context is current32M embedded-image budget, not inherited normative PDF/browser cap."}, "scope": "Pure geometry and mock property setters only; no actual Canvas, PDF parsing/rendering/native/browser/hardware."};
for (const row of input.geometryCases) test(`${row.id} retains the positive true fit without a .05 floor or .001 zero rounding`, () => {
  const original = createPdfViewport(row.view, { userUnit: row.userUnit, rotation: row.rotation });
  const fitted = getPdfPageViewport(original, createPdfToolbarState({ rotation: row.toolbarRotation, fitMode: row.fitMode }), input.container);
  assert(fitted.scale > 0 && fitted.scale < .05);
  assert(fitted.width <= row.maximumFittedWidth && fitted.width >= row.maximumFittedWidth - 1);
  assert(fitted.height <= row.maximumFittedHeight && fitted.height >= row.maximumFittedHeight - 1);
  const actual = createPdfViewport(row.view, { userUnit: row.userUnit, rotation: fitted.rotation, scale: fitted.scale });
  assert(actual.width <= row.maximumFittedWidth + 1e-8 && actual.height <= row.maximumFittedHeight + 1e-8);
});
test('normal unit1 toolbar rounding, public zoom and rotation remain exact', () => {
  const state = createPdfToolbarState(), view = { width: 600, height: 800 };
  assert.deepEqual(getPdfPageViewport(view, state, input.container), { width: 960, height: 1280, scale: 1.6, rotation: 0 });
  assert.deepEqual(getPdfPageViewport(view, updatePdfToolbarState(state, { type: 'zoomIn' }), input.container), { width: 1056, height: 1408, scale: 1.76, rotation: 0 });
  assert.equal(getCappedOutputScale(4), 1); assert.equal(getCappedOutputScale(.5), .5);
});
function mockedRenderer(width, height, dpr = 1) {
  const counts = { canvasCreated: 0, assignments: [], render: 0, cleanup: 0 };
  const style = { setProperty() {} }, pageEl = { style, replaceChildren() {} };
  const documentRef = { createElement(tag) {
    if (tag !== 'canvas') return { style: {}, className: '' };
    counts.canvasCreated++; let w = 300, h = 150;
    return { style: {}, getContext() { return {}; }, get width() { return w; }, set width(value) { counts.assignments.push(['width', value]); w = value; },
      get height() { return h; }, set height(value) { counts.assignments.push(['height', value]); h = value; } };
  } };
  const page = { getViewport() { return { width, height, scale: 1 }; }, render() { counts.render++; return { promise: Promise.resolve(), cancel() {} }; },
    getTextContent() { return Promise.resolve({ items: [] }); }, cleanup() { counts.cleanup++; } };
  const renderer = createVirtualPdfPageRenderer({ documentRef, windowRef: { devicePixelRatio: dpr },
    pdfjs: { TextLayer: class { render() { return Promise.resolve(); } } }, getPageScale: () => 1 });
  return { counts, renderer, run: () => renderer.ensurePageRendered({ getPage: async () => page }, pageEl, 1) };
}
for (const key of ['normal1x', 'normal4x', 'pixelBoundary']) test(`${key} backing dimensions remain exact with DPR capped`, async () => {
  const dims = input.backingMockCases[key], mock = mockedRenderer(...dims, 4);
  try { await mock.run(); assert.deepEqual(mock.counts.assignments.slice(0, 2), [['width', dims[0]], ['height', dims[1]]]); assert.equal(mock.counts.render, 1); }
  finally { mock.renderer.destroy(); }
});
for (const key of ['pixelOverflow', 'sideOverflow']) test(`${key} refuses before any Canvas creation, dimension assignment or render`, async () => {
  const mock = mockedRenderer(...input.backingMockCases[key]);
  try {
    await assert.rejects(mock.run(), { code: 'pdf_limit' });
    assert.equal(mock.counts.canvasCreated, 0); assert.deepEqual(mock.counts.assignments, []); assert.equal(mock.counts.render, 0); assert.equal(mock.counts.cleanup, 1);
  } finally { mock.renderer.destroy(); }
});
test('invalid dimensions refuse without touching mock Canvas setters', async () => {
  for (const value of [0, -.5, Infinity, NaN, Number.MAX_VALUE]) {
    const mock = mockedRenderer(value, 100);
    try { await assert.rejects(mock.run(), { code: 'pdf_limit' }); assert.equal(mock.counts.canvasCreated, 0); assert.deepEqual(mock.counts.assignments, []); assert.equal(mock.counts.render, 0); }
    finally { mock.renderer.destroy(); }
  }
});
