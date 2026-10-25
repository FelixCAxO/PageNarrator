import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  applyPdfViewportToPageElement,
  createPdfToolbarState,
  getPdfPageHash,
  getPdfPageViewport,
  getPdfToolbarView,
  updatePdfToolbarState,
} from '../../src/lib/pdf-viewer-toolbar.js';

describe('PDF viewer toolbar state', () => {
  it.each([
    [90, 800, 600, 960, 720, 180, 1280],
    [180, 600, 800, 960, 1280, 270, 720],
    [270, 800, 600, 960, 720, 0, 1280],
  ])('preserves intrinsic rotation %i and applies toolbar rotation relative to it', (
    rotation, width, height, fittedWidth, fittedHeight, clockwiseRotation, clockwiseHeight,
  ) => {
    const baseViewport = { width, height, rotation };
    const container = { width: 1000, height: 700, padding: 40 };
    const state = createPdfToolbarState();

    expect(getPdfPageViewport(baseViewport, state, container)).toMatchObject({
      width: fittedWidth, height: fittedHeight, rotation,
    });
    const clockwise = updatePdfToolbarState(state, { type: 'rotateClockwise' });
    expect(getPdfToolbarView(clockwise).rotation).toBe(90);
    expect(getPdfPageViewport(baseViewport, clockwise, container)).toMatchObject({
      width: 960, height: clockwiseHeight, rotation: clockwiseRotation,
    });
    const restored = updatePdfToolbarState(clockwise, { type: 'rotateCounterClockwise' });
    expect(getPdfPageViewport(baseViewport, restored, container))
      .toEqual(getPdfPageViewport(baseViewport, state, container));
    const fitPage = getPdfPageViewport(baseViewport, { ...state, fitMode: 'page' }, container);
    expect(fitPage.height).toBe(660);
    expect(fitPage.width).toBe(rotation === 180 ? 495 : 880);
    expect(fitPage.rotation).toBe(rotation);
  });

  it('keeps page, zoom, rotate, and fit controls in the PDF viewer header', () => {
    const html = readFileSync(new URL('../../src/pdf-viewer.html', import.meta.url), 'utf8');
    const document = new JSDOM(html).window.document;

    expect(document.getElementById('pdf-toolbar')).toBeTruthy();
    expect(document.getElementById('pdf-page-input')?.getAttribute('type')).toBe('number');
    expect(document.getElementById('pdf-page-count')).toBeTruthy();
    expect(document.getElementById('pdf-zoom-out-btn')).toBeTruthy();
    expect(document.getElementById('pdf-zoom-label')).toBeTruthy();
    expect(document.getElementById('pdf-zoom-in-btn')).toBeTruthy();
    expect(document.getElementById('pdf-rotate-left-btn')).toBeTruthy();
    expect(document.getElementById('pdf-rotate-right-btn')).toBeTruthy();
    expect(document.getElementById('pdf-fit-width-btn')).toBeTruthy();
    expect(document.getElementById('pdf-fit-page-btn')).toBeTruthy();
  });

  it('updates page, zoom, rotate, and fit state and applies it to page placeholders', () => {
    const dom = new JSDOM('<!doctype html><section class="pdf-page"></section>');
    const pageEl = dom.window.document.querySelector('.pdf-page');
    const baseViewport = { width: 600, height: 800 };
    const container = { width: 1000, height: 700, padding: 40 };
    let state = createPdfToolbarState({ currentPage: 500, pageCount: 1200 });

    let viewport = getPdfPageViewport(baseViewport, state, container);
    applyPdfViewportToPageElement(pageEl, viewport);

    expect(getPdfToolbarView(state)).toMatchObject({
      pageLabel: '500 / 1200',
      zoomLabel: '100%',
      fitMode: 'width',
    });
    expect(getPdfPageHash(state.currentPage)).toBe('#page=500');
    expect(pageEl.style.width).toBe('960px');
    expect(pageEl.style.height).toBe('1280px');
    expect(pageEl.style.getPropertyValue('--total-scale-factor')).toBe('1.6');

    state = updatePdfToolbarState(state, { type: 'zoomIn' });
    viewport = getPdfPageViewport(baseViewport, state, container);
    applyPdfViewportToPageElement(pageEl, viewport);

    expect(getPdfToolbarView(state).zoomLabel).toBe('110%');
    expect(pageEl.style.width).toBe('1056px');

    state = updatePdfToolbarState(state, { type: 'rotateClockwise' });
    viewport = getPdfPageViewport(baseViewport, state, container);
    applyPdfViewportToPageElement(pageEl, viewport);

    expect(getPdfToolbarView(state).rotation).toBe(90);
    expect(pageEl.style.height).toBe('792px');

    state = updatePdfToolbarState(state, { type: 'setFitMode', fitMode: 'page' });
    viewport = getPdfPageViewport(baseViewport, state, container);
    applyPdfViewportToPageElement(pageEl, viewport);

    expect(getPdfToolbarView(state)).toMatchObject({
      zoomLabel: '100%',
      fitMode: 'page',
    });
    expect(pageEl.style.width).toBe('880px');
    expect(pageEl.style.height).toBe('660px');
    expect(pageEl.style.getPropertyValue('--total-scale-factor')).toBe('1.1');
  });
});
