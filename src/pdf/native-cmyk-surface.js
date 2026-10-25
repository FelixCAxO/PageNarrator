// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';

const corrupt = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };
const limit = message => { throw new PdfEngineError(message, 'pdf_limit'); };
const MAX_SURFACE_UNITS = 16_000_000, MAX_WORK_PIXELS = 64_000_000, MAX_BAND_PIXELS = 262144;

/** Five owned Float32 premultiplied components: C, M, Y, K, alpha. */
export function createPdfCmykSurface(width, height, budget) {
  const pixels = width * height, units = pixels * 5;
  if (![width, height, pixels, units].every(Number.isSafeInteger) || width < 1 || height < 1) corrupt('Invalid native PDF surface dimensions.');
  if (!budget || !Number.isSafeInteger(budget.pixels) || budget.pixels < 0) corrupt('Invalid native PDF surface budget.');
  if (budget.pixels + units > MAX_SURFACE_UNITS) limit('PDF transparency surface budget exceeded.');
  budget.pixels += units;
  try {
    const surface = { width, height, data: new Float32Array(pixels * 5), budget,
      destroy() { if (surface.data) { surface.data = null; budget.pixels -= units; } } };
    return surface;
  } catch (error) { budget.pixels -= units; throw error; }
}

function dimensions(surface, box) {
  if (!surface || !(surface.data instanceof Float32Array) || surface.data.length !== surface.width * surface.height * 5) corrupt('Invalid or released native PDF surface.');
  const { left, top, width, height } = box || {}, pixels = width * height;
  if (![left, top, width, height, pixels].every(Number.isSafeInteger) || left < 0 || top < 0 || width < 1 || height < 1
    || left + width > surface.width || top + height > surface.height) corrupt('Invalid native PDF compositing band.');
  if (pixels > MAX_BAND_PIXELS) limit('PDF native compositing band limit exceeded.');
  return pixels;
}
function opacity(value) { if (!Number.isFinite(value) || value < 0 || value > 1) corrupt('Invalid native PDF opacity.'); }
function work(surface, pixels) {
  // Share the existing shading/mask pixel-work owner; native compositing
  // must not create a second independent64M allowance.
  const previous = surface.budget.shadingPixels ?? 0;
  if (!Number.isSafeInteger(previous) || previous < 0 || !Number.isSafeInteger(previous + pixels) || previous + pixels > MAX_WORK_PIXELS) limit('PDF native compositing work limit exceeded.');
  surface.budget.shadingPixels = previous + pixels;
}
function coverageValues(coverage, pixels) {
  if (coverage === null) return;
  if (!(coverage instanceof Float32Array || coverage instanceof Float64Array) || coverage.length !== pixels) corrupt('Invalid native PDF coverage band.');
  for (const value of coverage) if (!Number.isFinite(value) || value < 0 || value > 1) corrupt('Invalid native PDF coverage value.');
}

/** One shared geometry coverage value updates all four inks and alpha. */
export function paintPdfCmykBand(surface, box, color, alpha, coverage = null, check = () => {}, blend = 'source-over') {
  const pixels = dimensions(surface, box); opacity(alpha); coverageValues(coverage, pixels);
  if (!Array.isArray(color) || color.length !== 4 || Array.from(color).some(value => !Number.isFinite(value) || value < 0 || value > 1)) corrupt('Invalid native PDF ink components.');
  if (!['source-over', 'multiply', 'overprint-nonzero'].includes(blend)) throw new PdfEngineError('This native PDF ink blend is not implemented yet.');
  work(surface, pixels); const data = surface.data; let sample = 0;
  for (let row = 0; row < box.height; row++) {
    let at = ((box.top + row) * surface.width + box.left) * 5;
    for (let column = 0; column < box.width; column++, at += 5, sample++) {
      if (sample % 4096 === 0) check();
      const a = alpha * (coverage ? coverage[sample] : 1), retain = 1 - a;
      // PDF11.3.4 complements subtractive components around the additive
      // blend function. Multiply's full premultiplied formula simplifies to
      // Pb + Cs*a*(1-Pb); alpha still follows ordinary source-over.
      for (let channel = 0; channel < 4; channel++) {
        // PDF11.7.4.3 CompatibleOverprint selects the backdrop for a zero
        // direct DeviceCMYK component. Its premultiplied ink stays unchanged,
        // while the one shared alpha still grows, including on transparency.
        if (blend === 'overprint-nonzero' && color[channel] === 0) continue;
        data[at + channel] = blend === 'multiply'
          ? data[at + channel] + color[channel] * a * (1 - data[at + channel]) : color[channel] * a + data[at + channel] * retain;
      }
      data[at + 4] = a + data[at + 4] * retain;
    }
  }
}

function paired(surface, backdrop, box) {
  const pixels = dimensions(surface, box); dimensions(backdrop, box);
  if (surface.width !== backdrop.width || surface.height !== backdrop.height) corrupt('Native PDF group surface dimensions disagree.');
  return pixels;
}

/** Copy a native backdrop without reconstructing ink values from display RGB. */
export function copyPdfCmykBand(surface, backdrop, box, check = () => {}) {
  const pixels = paired(surface, backdrop, box); work(surface, pixels); let sample = 0;
  for (let row = 0; row < box.height; row++) {
    const at = ((box.top + row) * surface.width + box.left) * 5;
    for (let column = 0; column < box.width; column++, sample++) {
      if (sample % 4096 === 0) check();
      for (let channel = 0; channel < 5; channel++) surface.data[at + column * 5 + channel] = backdrop.data[at + column * 5 + channel];
    }
  }
}

/** Apply isolated group opacity once to all premultiplied components. */
export function scalePdfCmykBand(surface, box, alpha, check = () => {}) {
  const pixels = dimensions(surface, box); opacity(alpha); work(surface, pixels); let sample = 0;
  for (let row = 0; row < box.height; row++) {
    let at = ((box.top + row) * surface.width + box.left) * 5;
    for (let column = 0; column < box.width; column++, at += 5, sample++) {
      if (sample % 4096 === 0) check();
      for (let channel = 0; channel < 5; channel++) surface.data[at + channel] *= alpha;
    }
  }
}

/** Nonisolated Normal group opacity crossfades premultiplied results. */
export function crossfadePdfCmykBand(surface, backdrop, box, alpha, coverage = null, check = () => {}) {
  const pixels = paired(surface, backdrop, box); opacity(alpha); coverageValues(coverage, pixels); work(surface, pixels); let sample = 0;
  for (let row = 0; row < box.height; row++) {
    let at = ((box.top + row) * surface.width + box.left) * 5;
    for (let column = 0; column < box.width; column++, at += 5, sample++) {
      if (sample % 4096 === 0) check();
      const factor = alpha * (coverage ? coverage[sample] : 1);
      for (let channel = 0; channel < 5; channel++) surface.data[at + channel] = surface.data[at + channel] * factor + backdrop.data[at + channel] * (1 - factor);
    }
  }
}

/** Composite a variable native child under one shared caller-clip coverage. */
export function sourceOverPdfCmykBand(surface, source, box, alpha = 1, coverage = null, check = () => {}) {
  const pixels = paired(surface, source, box); opacity(alpha); coverageValues(coverage, pixels); work(surface, pixels); let sample = 0;
  for (let row = 0; row < box.height; row++) {
    let at = ((box.top + row) * surface.width + box.left) * 5;
    for (let column = 0; column < box.width; column++, at += 5, sample++) {
      if (sample % 4096 === 0) check();
      const factor = alpha * (coverage ? coverage[sample] : 1), sourceAlpha = source.data[at + 4] * factor, retain = 1 - sourceAlpha;
      for (let channel = 0; channel < 4; channel++) surface.data[at + channel] = source.data[at + channel] * factor + surface.data[at + channel] * retain;
      surface.data[at + 4] = sourceAlpha + surface.data[at + 4] * retain;
    }
  }
}

/** Composite an owned, tightly packed image band without a full-size child surface. */
export function sourceOverPdfCmykSamples(surface, box, samples, alpha = 1, coverage = null, check = () => {}) {
  const pixels = dimensions(surface, box); opacity(alpha); coverageValues(coverage, pixels);
  if (!(samples instanceof Float32Array) || samples.length !== pixels * 5 || samples.buffer === surface.data.buffer) corrupt('Invalid native PDF image sample band.');
  // Validate the whole bounded band before touching its destination. The image
  // sampler already includes source alpha; caller opacity and geometry apply once.
  for (let sample = 0; sample < pixels; sample++) {
    if (sample % 4096 === 0) check();
    const at = sample * 5, a = samples[at + 4]; opacity(a);
    for (let channel = 0; channel < 4; channel++) {
      const value = samples[at + channel];
      if (!Number.isFinite(value) || value < 0 || value > a) corrupt('Invalid premultiplied native PDF image sample.');
    }
  }
  work(surface, pixels); let sample = 0;
  for (let row = 0; row < box.height; row++) {
    let at = ((box.top + row) * surface.width + box.left) * 5;
    for (let column = 0; column < box.width; column++, at += 5, sample++) {
      if (sample % 4096 === 0) check();
      const from = sample * 5, factor = alpha * (coverage ? coverage[sample] : 1), sourceAlpha = samples[from + 4] * factor, retain = 1 - sourceAlpha;
      for (let channel = 0; channel < 4; channel++) surface.data[at + channel] = samples[from + channel] * factor + surface.data[at + channel] * retain;
      surface.data[at + 4] = sourceAlpha + surface.data[at + 4] * retain;
    }
  }
}
