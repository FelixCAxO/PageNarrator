// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { createPdfCmykSurface, paintPdfCmykBand, copyPdfCmykBand, crossfadePdfCmykBand, sourceOverPdfCmykBand, sourceOverPdfCmykSamples } from './native-cmyk-surface.js';
import { createPdfNativeCmykImageSampler } from './native-cmyk-image.js';
import { xyzD50ToRgb } from './icc-color.js';
import { multiply } from './viewport.js';

const MAX_PIXELS = 16_000_000, BAND = 262144;
const corrupt = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };
const unsupported = () => { throw new PdfEngineError('Native PDF inks need float16 sRGB Canvas coverage.'); };
const limit = () => { throw new PdfEngineError('PDF transparency surface budget exceeded.', 'pdf_limit'); };
const ink = values => {
  if (!Array.isArray(values) || values.length !== 4 || values.some(value => !Number.isFinite(value) || value < 0 || value > 1)) corrupt('Invalid native PDF paint colour.');
  return [...values];
};

/** Conservative bounds for geometry already expressed in the given Canvas space. */
export function pdfNativeDeviceBounds(points, matrix, padding = 1) {
  if (!Array.isArray(points) || !points.length || points.length % 2 || points.some(value => !Number.isFinite(value)) || !Number.isFinite(padding) || padding < 0) corrupt('Invalid native PDF paint bounds.');
  const { a, b, c, d, e, f } = matrix || {};
  if (![a, b, c, d, e, f].every(Number.isFinite)) corrupt('Invalid native PDF paint transform.');
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 2) {
    const x = a * points[i] + c * points[i + 1] + e, y = b * points[i] + d * points[i + 1] + f;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new PdfEngineError('Native PDF paint bounds exceed numeric limits.', 'pdf_limit');
    bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y); bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y);
  }
  return [bounds[0] - padding, bounds[1] - padding, bounds[2] + padding, bounds[3] + padding];
}

/** One white geometry plane; all inks use its identical coverage in software. */
export function createPdfCmykCoverage(width, height, budget, { check = () => {}, profileBytes = null, nativeColorSpace = 'DeviceCMYK' } = {}) {
  if (typeof check !== 'function') corrupt('Invalid native PDF cancellation owner.');
  if (profileBytes !== null && !(profileBytes instanceof Uint8Array)) corrupt('Invalid native PDF display profile bytes.');
  if (!['DeviceCMYK', 'ICCBased4'].includes(nativeColorSpace)) corrupt('Invalid native PDF coverage colour space.');
  check();
  if (typeof globalThis.Float16Array !== 'function') unsupported();
  const pixels = width * height, coverageUnits = pixels * 2;
  if (![width, height, pixels, coverageUnits].every(Number.isSafeInteger) || width < 1 || height < 1) corrupt('Invalid native PDF coverage dimensions.');
  if (!budget || !Number.isSafeInteger(budget.pixels) || budget.pixels < 0) corrupt('Invalid native PDF surface budget.');
  if (budget.pixels + pixels * 7 > MAX_PIXELS) limit();
  const surface = createPdfCmykSurface(width, height, budget);
  budget.pixels += coverageUnits;
  let canvas, context, destroyed = false, displayed = false, previous = null, paints = 0;
  let fill = [0, 0, 0, 1], stroke = [0, 0, 0, 1]; const styles = [];
  const reserve = units => {
    if (!Number.isSafeInteger(units) || units < 0 || !Number.isSafeInteger(budget.pixels + units) || budget.pixels + units > MAX_PIXELS) limit();
    budget.pixels += units;
  };
  const valid = () => { if (destroyed || displayed) corrupt('Released or finalized native PDF coverage.'); check(); };
  const read = (left, top, columns, rows) => {
    let band;
    try { band = context.getImageData(left, top, columns, rows, { pixelFormat: 'rgba-float16' }); }
    catch (error) { if (['TypeError', 'NotSupportedError'].includes(error.name)) unsupported(); throw error; }
    if (!(band?.data instanceof globalThis.Float16Array) || band.data.length !== columns * rows * 4) unsupported();
    return band;
  };
  function* bands(area, scratch = 0) {
    const maximum = scratch ? Math.min(BAND, Math.floor((MAX_PIXELS - budget.pixels) / scratch)) : BAND;
    if (maximum < 1) limit();
    const columns = Math.min(maximum, area.width), rows = Math.max(1, Math.floor(maximum / columns));
    for (let top = area.top; top < area.top + area.height; top += rows) for (let left = area.left; left < area.left + area.width; left += columns) {
      yield { left, top, width: Math.min(columns, area.left + area.width - left), height: Math.min(rows, area.top + area.height - top) };
    }
  }
  const areaOf = (bounds, clip = [0, 0, width, height]) => {
    if (![bounds, clip].every(values => Array.isArray(values) && values.length === 4 && values.every(Number.isFinite))) corrupt('Invalid native PDF coverage bounds.');
    const left = Math.max(0, Math.floor(bounds[0]), Math.floor(clip[0])), top = Math.max(0, Math.floor(bounds[1]), Math.floor(clip[1]));
    const right = Math.min(width, Math.ceil(bounds[2]), Math.ceil(clip[2])), bottom = Math.min(height, Math.ceil(bounds[3]), Math.ceil(clip[3]));
    return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
  };
  const yieldCheck = async cancellation => { valid(); cancellation(); if (++paints % 256 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); valid(); cancellation(); } };
  const clear = async cancellation => {
    if (!previous) return;
    for (const box of bands(previous, 2)) {
      valid(); cancellation(); const units = box.width * box.height * 2; reserve(units);
      try {
        const zero = context.createImageData(box.width, box.height, { pixelFormat: 'rgba-float16' });
        if (!(zero?.data instanceof globalThis.Float16Array)) unsupported();
        // putImageData ignores transforms/clips and preserves the current path.
        context.putImageData(zero, box.left, box.top);
      } finally { budget.pixels -= units; }
    }
    previous = null;
  };
  const coverage = async (draw, bounds, clip, consume, cancellation = () => {}, scratch = 3) => {
    valid(); cancellation(); const area = areaOf(bounds, clip);
    if (!area) return;
    await clear(cancellation); await yieldCheck(cancellation);
    context.save();
    try { context.fillStyle = context.strokeStyle = 'white'; context.globalAlpha = 1; context.globalCompositeOperation = 'source-over'; draw(); }
    finally { context.restore(); }
    previous = area;
    let index = 0;
    for (const box of bands(area, scratch)) {
      if (index++) { await new Promise(resolve => setTimeout(resolve, 0)); valid(); cancellation(); }
      const count = box.width * box.height, units = count * 3; reserve(units);
      try {
        const band = read(box.left, box.top, box.width, box.height), alpha = new Float32Array(count);
        for (let at = 0; at < band.data.length; at++) {
          const value = band.data[at];
          if (!Number.isFinite(value) || value < 0 || value > 1) corrupt('Invalid normalized native PDF coverage.');
          if (at % 4 === 3) alpha[at >> 2] = value;
          if (at % 16384 === 0) { valid(); cancellation(); }
        }
        consume(box, alpha, () => { valid(); cancellation(); });
      } finally { budget.pixels -= units; }
    }
  };
  const masked = (sampler, box, consume, cancellation = () => {}) => {
    if (sampler === null) return consume(null);
    if (typeof sampler?.sampleBand !== 'function') corrupt('Invalid native PDF group mask sampler.');
    const count = box.width * box.height, units = count * 2; reserve(units);
    try {
      const mask = sampler.sampleBand(box.left, box.top, box.width, box.height);
      if (!(mask instanceof Float64Array) || mask.length !== count) corrupt('Invalid native PDF group mask band.');
      for (let i = 0; i < count; i++) {
        if (i % 4096 === 0) { valid(); cancellation(); }
        if (!Number.isFinite(mask[i]) || mask[i] < 0 || mask[i] > 1) corrupt('Invalid normalized native PDF group mask.');
      }
      return consume(mask);
    } finally { budget.pixels -= units; }
  };
  const painter = {
    surface, profileBytes, nativeColorSpace, get context() { return context; },
    setColor(isFill, values) { valid(); if (typeof isFill !== 'boolean') corrupt('Invalid native PDF colour selector.'); if (isFill) fill = ink(values); else stroke = ink(values); },
    color(isFill) { valid(); return [...(isFill ? fill : stroke)]; },
    save() { valid(); styles.push([fill, stroke]); },
    restore() { valid(); if (!styles.length) corrupt('Unbalanced native PDF colour restore.'); [fill, stroke] = styles.pop(); },
    inherit(parent) { fill = parent.color(true); stroke = parent.color(false); },
    async paint(draw, values, alpha, bounds, clip, cancellation, blend = 'source-over') {
      const color = ink(values);
      if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1 || typeof draw !== 'function') corrupt('Invalid native PDF coverage paint.');
      if (!['source-over', 'overprint-nonzero'].includes(blend)) throw new PdfEngineError('This native PDF elementary ink blend is not implemented yet.');
      if (alpha === 0) { valid(); return; }
      await coverage(draw, bounds, clip, (box, samples, cancel) => paintPdfCmykBand(surface, box, color, alpha, samples, cancel, blend), cancellation);
    },
    async image(image, imageMatrix, pageTransform, alpha, clip, cancellation = () => {}) {
      valid();
      if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) corrupt('Invalid native PDF image opacity.');
      const sampler = createPdfNativeCmykImageSampler(image, { imageMatrix, pageTransform, surfaceBudget: budget, cancellation });
      try {
        if (alpha === 0) return;
        const basis = multiply(pageTransform, imageMatrix), [a, b, c, d, e, f] = basis;
        const bounds = pdfNativeDeviceBounds([0, 0, 1, 0, 1, 1, 0, 1], { a, b, c, d, e, f });
        await coverage(() => {
          context.save();
          try { context.setTransform(...basis); context.fillRect(0, 0, 1, 1); }
          finally { context.restore(); }
        }, bounds, clip, (box, samples, cancel) => {
          let band;
          try {
            band = sampler.sampleBand(box.left, box.top, box.width, box.height);
            sourceOverPdfCmykSamples(surface, box, band.data, alpha, samples, cancel);
          } finally { band?.release(); }
        }, cancellation, 8); // 2readback +1coverage +5premultiplied source samples.
      } finally { sampler.destroy(); }
    },
    copyFrom(parent) {
      valid(); if (!parent?.surface || parent.surface.budget !== budget) corrupt('Invalid native PDF backdrop owner.');
      for (const box of bands({ left: 0, top: 0, width, height })) copyPdfCmykBand(surface, parent.surface, box, check);
    },
    async composite(child, alpha, isolated, clip, cancellation, maskSampler = null, sourceContribution = false) {
      if (!child || child === painter || child.surface?.width !== width || child.surface.height !== height || child.surface.budget !== budget
        || !Number.isFinite(alpha) || alpha < 0 || alpha > 1 || typeof isolated !== 'boolean' || typeof sourceContribution !== 'boolean') corrupt('Invalid native PDF child surface.');
      if (maskSampler !== null && !isolated && !sourceContribution) throw new PdfEngineError('Non-isolated native PDF masked groups are not implemented yet.');
      await coverage(() => { context.save(); try { context.setTransform(1, 0, 0, 1, 0, 0); context.fillRect(0, 0, width, height); } finally { context.restore(); } }, [0, 0, width, height], clip, (box, samples, cancel) => {
        masked(maskSampler, box, mask => {
          if (mask) for (let i = 0; i < samples.length; i++) samples[i] *= mask[i];
          if (isolated || sourceContribution) sourceOverPdfCmykBand(surface, child.surface, box, alpha, samples, cancel);
          else { crossfadePdfCmykBand(child.surface, surface, box, alpha, samples, cancel); copyPdfCmykBand(surface, child.surface, box, cancel); }
        }, cancel);
      }, cancellation, maskSampler === null ? 3 : 5);
    },
    async writeDisplay(profile, target = null, cancellation = () => {}, maskSampler = null) {
      valid();
      if (profile?.channels !== 4 || typeof profile.toXyz !== 'function') corrupt('Invalid native PDF forward display profile.');
      if (target && (target.channels !== 3 || typeof target.fromXyz !== 'function')) throw new PdfEngineError('This native PDF parent display space is not implemented yet.');
      let index = 0;
      for (const box of bands({ left: 0, top: 0, width, height }, maskSampler === null ? 2 : 4)) {
        valid(); cancellation(); if (index++) { await new Promise(resolve => setTimeout(resolve, 0)); valid(); cancellation(); }
        const count = box.width * box.height, work = (budget.shadingPixels ?? 0) + count;
        if (!Number.isSafeInteger(work) || work < count || work > 64_000_000) throw new PdfEngineError('PDF native display work limit exceeded.', 'pdf_limit');
        budget.shadingPixels = work; reserve(count * 2);
        try {
          masked(maskSampler, box, mask => {
          const image = context.createImageData(box.width, box.height, { pixelFormat: 'rgba-float16' });
          if (!(image?.data instanceof globalThis.Float16Array) || image.data.length !== count * 4) unsupported();
          let pixel = 0;
          for (let row = 0; row < box.height; row++) for (let column = 0; column < box.width; column++, pixel++) {
            if (pixel % 4096 === 0) { valid(); cancellation(); }
            const at = ((box.top + row) * width + box.left + column) * 5, alpha = surface.data[at + 4];
            if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) corrupt('Invalid native PDF display alpha.');
            const inks = Array.from(surface.data.subarray(at, at + 4), value => {
              if (!Number.isFinite(value) || value < 0 || value > alpha) corrupt('Invalid premultiplied native PDF ink.');
              return alpha ? value / alpha : 0;
            });
            if (alpha) {
              const xyz = profile.toXyz(inks);
              if (!Array.isArray(xyz) || xyz.length !== 3 || xyz.some(value => !Number.isFinite(value))) corrupt('Invalid native PDF display PCS colour.');
              const values = target ? target.fromXyz(xyz) : xyzD50ToRgb(xyz);
              if (!Array.isArray(values) || values.length !== 3 || values.some(value => !Number.isFinite(value))) corrupt('Invalid native PDF display colour.');
              for (let channel = 0; channel < 3; channel++) image.data[pixel * 4 + channel] = Math.max(0, Math.min(1, values[channel]));
            }
            image.data[pixel * 4 + 3] = alpha * (mask ? mask[pixel] : 1);
          }
          context.putImageData(image, box.left, box.top);
          }, cancellation);
        } finally { budget.pixels -= count * 2; }
      }
      displayed = true; previous = null;
    },
    destroy() {
      if (destroyed) return; destroyed = true;
      try { if (canvas) canvas.width = canvas.height = 0; }
      finally { budget.pixels -= coverageUnits; surface.destroy(); }
    },
  };
  try {
    canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : document.createElement('canvas'); canvas.width = width; canvas.height = height;
    try { context = canvas.getContext('2d', { colorType: 'float16', colorSpace: 'srgb' }); }
    catch (error) { if (['TypeError', 'NotSupportedError'].includes(error.name)) unsupported(); throw error; }
    const attributes = context?.getContextAttributes?.();
    if (attributes?.colorType !== 'float16' || attributes?.colorSpace !== 'srgb') unsupported();
    reserve(2); try { read(0, 0, 1, 1); } finally { budget.pixels -= 2; }
    valid(); return painter;
  } catch (error) { painter.destroy(); throw error; }
}
