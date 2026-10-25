// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { parseIccProfile } from './icc-color.js';
import { MAX_IMAGE_BAND_PIXELS } from './image-limits.js';
import { deviceGray, deviceRgb } from './color-spaces.js';
import { convertPdfColor, convertBlendPixels } from './icc-blend.js';
import { PdfStrokePath } from './stroke-adjust.js';
import { renderPdfShading } from './shading.js';
import { paintPdfShadingPattern } from './shading-pattern.js';
import { PdfTextClipper, paintPdfOutlinedText } from './text-clip.js';
import { multiply } from './viewport.js';
import { createPdfGroupSoftMaskSampler } from './group-soft-mask.js';
import { createPdfCmykCoverage, pdfNativeDeviceBounds } from './native-cmyk-coverage.js';
import { assertPdfCmykContributionGroup } from './native-cmyk-contribution.js';
import { PDF_ICC4_CONTRIBUTION, assertPdfIcc4ContributionGroup } from './native-icc4-contribution.js';
import { assertPdfInheritedRgbRectangle, pdfInheritedRgbBandPixels, assertPdfInheritedRgbFootprint } from './inherited-rgb-rectangle.js';

const normalizedGroupPixels = pixels => typeof globalThis.Float16Array === 'function' && pixels instanceof globalThis.Float16Array;
function groupBand(context, left, top, width, height, precise) {
  let image;
  try { image = context.getImageData(left, top, width, height, precise ? { pixelFormat: 'rgba-float16' } : undefined); }
  catch (error) {
    if (precise && ['TypeError', 'NotSupportedError'].includes(error.name)) throw new PdfEngineError('High-precision PDF masks need float16 Canvas readback.');
    throw error;
  }
  if (precise && !normalizedGroupPixels(image.data)) throw new PdfEngineError('High-precision PDF masks need float16 Canvas readback.');
  return image;
}
function validateGroupPixels(pixels) {
  if (!(pixels instanceof Uint8ClampedArray) && !normalizedGroupPixels(pixels) || pixels.length % 4) throw new PdfEngineError('Invalid PDF group compositing pixels.', 'pdf_corrupt');
  if (normalizedGroupPixels(pixels)) for (const value of pixels) if (!Number.isFinite(value) || value < 0 || value > 1) throw new PdfEngineError('Invalid PDF group normalized pixels.', 'pdf_corrupt');
}
function validateGroupOpacity(pixels, opacity, mask) {
  validateGroupPixels(pixels);
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1
    || mask !== null && (!(mask instanceof Float64Array) || mask.length !== pixels.length / 4)) throw new PdfEngineError('Invalid PDF group compositing pixels.', 'pdf_corrupt');
}
function groupOpacity(opacity, mask, index) {
  if (!mask) return opacity;
  const value = mask[index]; if (!Number.isFinite(value) || value < 0 || value > 1) throw new PdfEngineError('Invalid PDF group mask value.', 'pdf_corrupt');
  return opacity * value;
}

/** Isolated group source alpha includes its outer constant and mask only once. */
export function scalePdfGroupAlpha(pixels, opacity, mask) {
  validateGroupOpacity(pixels, opacity, mask);
  for (let at = 0; at < pixels.length; at += 4) pixels[at + 3] *= groupOpacity(opacity, mask, at / 4);
  return pixels;
}

/** Non-isolated Normal group opacity crossfades the two premultiplied results. */
export function crossfadePdfGroupPixels(rendered, backdrop, opacity, mask = null) {
  validateGroupOpacity(rendered, opacity, mask);
  validateGroupPixels(backdrop);
  if (backdrop.constructor !== rendered.constructor || rendered.length !== backdrop.length) throw new PdfEngineError('Invalid PDF group compositing pixels.', 'pdf_corrupt');
  for (let at = 0; at < rendered.length; at += 4) {
    const factor = groupOpacity(opacity, mask, at / 4), sourceAlpha = rendered[at + 3] * factor, backdropAlpha = backdrop[at + 3] * (1 - factor), alpha = sourceAlpha + backdropAlpha;
    for (let channel = 0; channel < 3; channel++) rendered[at + channel] = alpha ? (rendered[at + channel] * sourceAlpha + backdrop[at + channel] * backdropAlpha) / alpha : 0;
    rendered[at + 3] = alpha;
  }
  return rendered;
}

export function renderPdfDisplayList(payload, { canvasContext: ctx, viewport, transform = null, loadFonts = async () => {}, background = true,
  resolveFont = () => null, initialStyles = null, shouldCancel = null, surfaceBudget = { pixels: 0 }, opaqueBackdrop = background, outputProfile = null, profileCache = new WeakMap(), textClipper = null, clipBounds = null, nativePainter = null } = {}) {
  let cancelled = false;
  const cancellation = () => { if (cancelled || shouldCancel?.()) { const error = new Error('PDF rendering cancelled.'); error.name = 'RenderingCancelledException'; throw error; } };
  const ownsTextClipper = !textClipper; textClipper ??= new PdfTextClipper(cancellation);
  const promise = (async () => {
    if (nativePainter && (ctx !== nativePainter.context || surfaceBudget !== nativePainter.surface?.budget || background || outputProfile)) throw new PdfEngineError('Invalid native PDF renderer context.', 'pdf_corrupt');
    await loadFonts(payload.fonts); cancellation();
    if ((payload.fonts || []).some(font => font.requiresLocalFace === true && !resolveFont(font.family))) throw new PdfEngineError('Required local PDF CID font is unavailable.', 'pdf_unsupported');
    const starting = ctx.getTransform?.(), base = transform ? [transform, viewport.transform] : [viewport.transform];
    const nativeMask = descriptor => {
      if (!descriptor) return null;
      const initial = starting ? [starting.a, starting.b, starting.c, starting.d, starting.e, starting.f] : [1, 0, 0, 1, 0, 0];
      const sampler = createPdfGroupSoftMaskSampler(descriptor, {
        pageTransform: base.reduce((matrix, next) => multiply(matrix, next), initial), profileCache, surfaceBudget, cancellation,
        deviceExtent: [0, 0, ctx.canvas.width, ctx.canvas.height],
      });
      if (typeof sampler?.sampleBand !== 'function') throw new PdfEngineError('Invalid native PDF group mask sampler.', 'pdf_corrupt');
      return sampler;
    };
    ctx.save(); let saves = 1, current = [0, 0], subpath = [0, 0]; const strokePath = new PdfStrokePath(), clipStack = [];
    let deviceClip = clipBounds || [0, 0, ctx.canvas.width, ctx.canvas.height];
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0); if (background) { ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = 'white'; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height); }
      if (starting) ctx.setTransform(starting); for (const matrix of base) ctx.transform(...matrix);
      ctx.fillStyle = 'rgb(0,0,0)'; ctx.strokeStyle = 'rgb(0,0,0)'; if (initialStyles) Object.assign(ctx, initialStyles); ctx.beginPath();
      for (let index = 0; index < payload.commands.length; index++) {
        if (index && index % 256 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); cancellation(); }
        const c = payload.commands[index];
        if (c.op === 'save') { ctx.save(); saves++; nativePainter?.save(); clipStack.push(deviceClip); }
        else if (c.op === 'restore') { ctx.restore(); saves--; nativePainter?.restore(); deviceClip = clipStack.pop() || deviceClip; }
        else if (c.op === 'transform') ctx.transform(...c.args);
        else if (c.op === 'setPdfTransform') { ctx.setTransform(1, 0, 0, 1, 0, 0); if (starting) ctx.setTransform(starting); for (const matrix of base) ctx.transform(...matrix); ctx.transform(...c.args); }
        else if (c.op === 'color') {
          if (nativePainter) {
            if (c.nativeCmyk !== undefined) nativePainter.setColor(c.fill, c.nativeCmyk);
            else if (c.nativeColorSpace !== nativePainter.nativeColorSpace) throw new PdfEngineError('Missing native PDF colour marker.', 'pdf_corrupt');
            continue;
          }
          const precise = ctx.getContextAttributes?.().colorType === 'float16' && c.nativeColor !== null && c.nativeColor !== undefined;
          if (precise && (!Array.isArray(c.nativeColor) || c.nativeColor.length !== 3 || c.nativeColor.some(n => !Number.isFinite(n)))) throw new PdfEngineError('Invalid native PDF colour.', 'pdf_corrupt');
          ctx[c.fill ? 'fillStyle' : 'strokeStyle'] = precise ? `color(srgb ${c.nativeColor.map(n => Math.max(0, Math.min(1, n))).join(' ')})` : c.value;
        }
        else if (c.op === 'lineStyle') {
          if (c.name === 'w') { if (c.value !== 0) ctx.lineWidth = c.value; }
          else if (c.name === 'J') ctx.lineCap = ['butt', 'round', 'square'][c.value];
          else if (c.name === 'j') ctx.lineJoin = ['miter', 'round', 'bevel'][c.value];
          else ctx.miterLimit = c.value;
        } else if (c.op === 'dash') { ctx.setLineDash(c.dash); ctx.lineDashOffset = c.phase; }
        else if (c.op === 'path') {
          const a = c.args, matrix = ctx.getTransform?.();
          strokePath.add(c.kind, a, matrix);
          if (c.kind === 'm') { ctx.moveTo(...a); current = [...a]; subpath = [...a]; }
          else if (c.kind === 'l') { ctx.lineTo(...a); current = [...a]; }
          else if (c.kind === 'c') { ctx.bezierCurveTo(...a); current = a.slice(4); }
          else if (c.kind === 'v') {
            // v repeats the existing device current point, even if cm changed.
            if (matrix) { ctx.save(); try { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.bezierCurveTo(...strokePath.segments.at(-1).points); } finally { ctx.restore(); } }
            else ctx.bezierCurveTo(...current, ...a);
            current = a.slice(2);
          }
          else if (c.kind === 'y') { ctx.bezierCurveTo(...a, ...a.slice(2)); current = a.slice(2); }
          else if (c.kind === 're') { ctx.rect(...a); current = a.slice(0, 2); subpath = [...current]; }
          else { ctx.closePath(); current = [...subpath]; }
        } else if (c.op === 'paint') {
          if (!nativePainter && (c.nativeCmykFillBlend || c.nativeCmykStrokeBlend)) throw new PdfEngineError('Native PDF overprint requires its native group target.', 'pdf_corrupt');
          if (nativePainter && (c.blend && c.blend !== 'source-over' || c.fillPattern || c.strokePattern)) throw new PdfEngineError('This native PDF path blend or pattern is not implemented yet.');
          ctx.globalCompositeOperation = c.blend || 'source-over';
          if (['s', 'b', 'b*'].includes(c.kind)) { ctx.closePath(); strokePath.add('h', [], ctx.getTransform?.()); }
          const patternOptions = identityPaint => ({ basis: base.reduce((matrix, next) => multiply(matrix, next), starting ? [starting.a, starting.b, starting.c, starting.d, starting.e, starting.f] : [1, 0, 0, 1, 0, 0]),
            clipBounds: deviceClip, surfaceBudget, outputProfile, profileCache, cancellation, identityPaint,
            renderCell: async (commands, canvasContext, cellMatrix) => {
              await renderPdfDisplayList({ commands, fonts: [] }, { canvasContext, viewport: { transform: cellMatrix }, background: false,
                outputProfile, profileCache, surfaceBudget, shouldCancel: () => cancelled || shouldCancel?.() }).promise;
            } });
          if (['f', 'F', 'f*', 'B', 'B*', 'b', 'b*'].includes(c.kind)) {
            ctx.globalAlpha = c.fillAlpha ?? 1;
            const fill = () => ctx.fill(c.kind.includes('*') ? 'evenodd' : 'nonzero');
            if (nativePainter) {
              const bounds = strokePath.bounds();
              if (bounds) await nativePainter.paint(fill, c.nativeCmykFill ?? nativePainter.color(true), c.fillAlpha ?? 1, [bounds[0] - 1, bounds[1] - 1, bounds[2] + 1, bounds[3] + 1], deviceClip, cancellation, c.nativeCmykFillBlend);
            } else if (c.fillPattern) await paintPdfShadingPattern(c.fillPattern, ctx, texture => { ctx.fillStyle = texture; fill(); }, patternOptions(false)); else fill();
          }
          if (['S', 's', 'B', 'B*', 'b', 'b*'].includes(c.kind)) {
            ctx.globalAlpha = c.strokeAlpha ?? 1;
            const adjusted = c.lineWidth === 0 || c.strokeAdjustment;
            const stroke = () => { if (adjusted) strokePath.stroke(ctx, { width: c.lineWidth ?? ctx.lineWidth, adjust: c.strokeAdjustment }); else ctx.stroke(); };
            if (nativePainter) {
              const bounds = strokePath.bounds(), matrix = ctx.getTransform(), scale = Math.hypot(matrix.a, matrix.b, matrix.c, matrix.d);
              const padding = 2 + Math.max(1, (c.lineWidth ?? ctx.lineWidth) * scale * (ctx.lineJoin === 'miter' ? ctx.miterLimit : 1) / 2);
              if (bounds) await nativePainter.paint(stroke, c.nativeCmykStroke ?? nativePainter.color(false), c.strokeAlpha ?? 1, [bounds[0] - padding, bounds[1] - padding, bounds[2] + padding, bounds[3] + padding], deviceClip, cancellation, c.nativeCmykStrokeBlend);
            } else if (c.strokePattern) await paintPdfShadingPattern(c.strokePattern, ctx, texture => { ctx.strokeStyle = texture; stroke(); }, patternOptions(adjusted)); else stroke();
          }
          if (c.clip) {
            ctx.clip(c.clip); const bounds = strokePath.bounds();
            // Only skip pixels certainly outside the real Canvas clip. Keep an
            // outward pixel for edge antialiasing; unknown/text clips overestimate.
            if (bounds) deviceClip = [Math.max(deviceClip[0], Math.floor(bounds[0]) - 1), Math.max(deviceClip[1], Math.floor(bounds[1]) - 1),
              Math.min(deviceClip[2], Math.ceil(bounds[2]) + 1), Math.min(deviceClip[3], Math.ceil(bounds[3]) + 1)];
          }
          ctx.beginPath(); strokePath.reset();
        } else if (c.op === 'textClip') {
          const initial = starting ? [starting.a, starting.b, starting.c, starting.d, starting.e, starting.f] : [1, 0, 0, 1, 0, 0];
          await textClipper.apply(c, ctx, base.reduce((matrix, next) => multiply(matrix, next), initial)); cancellation();
        } else if (c.op === 'text' && c.paintMode !== undefined) {
          if (nativePainter) throw new PdfEngineError('Native PDF outlined text paint is not implemented yet.');
          paintPdfOutlinedText(c, ctx);
        } else if (c.op === 'text') {
          if (!nativePainter && c.nativeCmykBlend) throw new PdfEngineError('Native PDF overprint requires its native group target.', 'pdf_corrupt');
          if (nativePainter && c.blend && c.blend !== 'source-over') throw new PdfEngineError('This native PDF text blend is not implemented yet.');
          ctx.save(); try {
          // Text positions already include the PDF CTM, so restart at the page basis.
          ctx.setTransform(1, 0, 0, 1, 0, 0); if (starting) ctx.setTransform(starting); for (const matrix of base) ctx.transform(...matrix);
          ctx.transform(...c.matrix); ctx.scale(1, -1); ctx.font = `1px "${c.font}"`; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = c.fill;
          const localFamily = resolveFont(c.font); let currentFamily = c.font;
          ctx.globalAlpha = c.alpha ?? 1; ctx.globalCompositeOperation = c.blend || 'source-over';
          for (const glyph of c.glyphs) {
            if (!glyph.outline) {
              const family = glyph.systemText && localFamily || c.font;
              if (family !== currentFamily) { ctx.font = `1px "${family}"`; currentFamily = family; }
              const value = family === localFamily ? glyph.systemText : glyph.renderText || glyph.text, y = glyph.y === undefined ? 0 : -glyph.y;
              if (nativePainter) {
                const metrics = ctx.measureText(value), [left, right, ascent, descent] = ['actualBoundingBoxLeft', 'actualBoundingBoxRight', 'actualBoundingBoxAscent', 'actualBoundingBoxDescent'].map(key => metrics[key]);
                if (![left, right, ascent, descent].every(Number.isFinite)) throw new PdfEngineError('Native PDF text needs measured glyph bounds.');
                const bounds = pdfNativeDeviceBounds([glyph.x - left, y - ascent, glyph.x - left, y + descent,
                  glyph.x + right, y - ascent, glyph.x + right, y + descent], ctx.getTransform());
                await nativePainter.paint(() => ctx.fillText(value, glyph.x, y), c.nativeCmyk ?? nativePainter.color(true), c.alpha ?? 1, bounds, deviceClip, cancellation, c.nativeCmykBlend);
              } else ctx.fillText(value, glyph.x, y);
            }
            else {
              ctx.save(); try { ctx.translate(glyph.x, glyph.y === undefined ? 0 : -glyph.y); ctx.scale(1, -1); ctx.transform(...glyph.fontMatrix); ctx.beginPath();
              for (const segment of glyph.outline) {
                if (segment.op === 1) ctx.moveTo(...segment.points); else if (segment.op === 2) ctx.lineTo(...segment.points);
                else if (segment.op === 3) ctx.bezierCurveTo(...segment.points); else ctx.closePath();
              }
              if (nativePainter) {
                const points = glyph.outline.flatMap(segment => segment.points);
                if (points.length) await nativePainter.paint(() => ctx.fill(), c.nativeCmyk ?? nativePainter.color(true), c.alpha ?? 1, pdfNativeDeviceBounds(points, ctx.getTransform()), deviceClip, cancellation, c.nativeCmykBlend);
              } else ctx.fill(); } finally { ctx.restore(); }
            }
          } } finally { ctx.restore(); }
        } else if (c.op === 'shading') {
          if (nativePainter) throw new PdfEngineError('Native PDF shading paint is not implemented yet.');
          await renderPdfShading(c, ctx, { outputProfile, profileCache, surfaceBudget, cancellation, clipBounds: deviceClip }); cancellation();
        } else if (c.op === 'group') {
          const contribution = c.sourceContribution !== undefined;
          if (contribution) {
            const initial = starting ? [starting.a, starting.b, starting.c, starting.d, starting.e, starting.f] : [1, 0, 0, 1, 0, 0];
            assertPdfIcc4ContributionGroup(c, { check: cancellation, mask: nativeMask, profileCache, surfaceBudget,
              deviceExtent: [0, 0, ctx.canvas.width, ctx.canvas.height],
              pageTransform: base.reduce((matrix, next) => multiply(matrix, next), initial) });
          }
          const inheritedRgb = c.rgbCompatibility !== undefined;
          let inheritedMask = null;
          if (inheritedRgb) {
            const initial = starting ? [starting.a, starting.b, starting.c, starting.d, starting.e, starting.f] : [1, 0, 0, 1, 0, 0];
            assertPdfInheritedRgbRectangle(c, cancellation, base.reduce((matrix, next) => multiply(matrix, next), initial));
            if (nativePainter || outputProfile) throw new PdfEngineError('Inherited-RGB PDF rectangles require their RGB parent.', 'pdf_unsupported');
            inheritedMask = nativeMask(c.softMask); // Validate full mask basis/graph before allocating, even at alpha0.
            assertPdfInheritedRgbFootprint(surfaceBudget, ctx.canvas.width, ctx.canvas.height, Boolean(inheritedMask));
            if (c.alpha === 0) continue;
          }
          if (c.backdropIndependent !== undefined) {
            assertPdfCmykContributionGroup(c, cancellation);
            if (nativePainter) throw new PdfEngineError('A PDF backdrop-independent contribution requires its RGB parent target.', 'pdf_corrupt');
          }
          if (nativePainter) {
            if (c.nativeColorSpace !== nativePainter.nativeColorSpace || c.colorProfile && c.colorProfile !== nativePainter.profileBytes || c.blend && c.blend !== 'source-over'
              || nativePainter.nativeColorSpace === 'ICCBased4' && !contribution) throw new PdfEngineError('This native PDF child group colour or blend is not implemented yet.');
            if (typeof c.isolated !== 'boolean') throw new PdfEngineError('Invalid native PDF child isolation.', 'pdf_corrupt');
            if (c.softMask && !c.isolated && !contribution) throw new PdfEngineError('Non-isolated native PDF masked groups are not implemented yet.');
            const maskSampler = nativeMask(c.softMask);
            const child = createPdfCmykCoverage(ctx.canvas.width, ctx.canvas.height, surfaceBudget, { check: cancellation, profileBytes: nativePainter.profileBytes, nativeColorSpace: nativePainter.nativeColorSpace });
            try {
              child.inherit(nativePainter); if (!c.isolated && !contribution) child.copyFrom(nativePainter);
              const target = child.context; if (starting) target.setTransform(starting); target.setLineDash(ctx.getLineDash());
              const styles = Object.fromEntries(['lineWidth', 'lineCap', 'lineJoin', 'miterLimit', 'lineDashOffset'].map(name => [name, ctx[name]]));
              await renderPdfDisplayList({ commands: c.commands, fonts: [] }, { canvasContext: target, viewport, transform, background: false, initialStyles: styles,
                resolveFont, shouldCancel: () => cancelled || shouldCancel?.(), surfaceBudget, textClipper, clipBounds: deviceClip, nativePainter: child }).promise;
              cancellation(); await nativePainter.composite(child, c.alpha ?? 1, c.isolated, deviceClip, cancellation, maskSampler, contribution);
            } finally { child.destroy(); }
            continue;
          }
          if (c.nativeColorSpace === 'DeviceCMYK' || c.nativeColorSpace === 'ICCBased4') {
            if (c.nativeColorSpace === 'ICCBased4' && (!contribution || c.sourceContribution !== PDF_ICC4_CONTRIBUTION)) throw new PdfEngineError('Invalid PDF ICC4 contribution subtype.', 'pdf_corrupt');
            if (!contribution && (c.isolated !== true && c.backdropIndependent !== true || c.blend && c.blend !== 'source-over')) throw new PdfEngineError('This native PDF outer group is not implemented yet.');
            if (!(c.colorProfile instanceof Uint8Array) || !Number.isFinite(c.alpha) || c.alpha < 0 || c.alpha > 1) throw new PdfEngineError('Invalid native PDF display group.', 'pdf_corrupt');
            const maskSampler = nativeMask(c.softMask);
            if (!profileCache.has(c.colorProfile)) profileCache.set(c.colorProfile, parseIccProfile(c.colorProfile));
            const profile = profileCache.get(c.colorProfile);
            if (profile.channels !== 4 || typeof profile.toXyz !== 'function') throw new PdfEngineError('Invalid native PDF forward group profile.', 'pdf_corrupt');
            const child = createPdfCmykCoverage(ctx.canvas.width, ctx.canvas.height, surfaceBudget, { check: cancellation, profileBytes: c.colorProfile, nativeColorSpace: c.nativeColorSpace });
            try {
              const target = child.context; if (starting) target.setTransform(starting); target.setLineDash(ctx.getLineDash());
              const styles = Object.fromEntries(['lineWidth', 'lineCap', 'lineJoin', 'miterLimit', 'lineDashOffset'].map(name => [name, ctx[name]]));
              await renderPdfDisplayList({ commands: c.commands, fonts: [] }, { canvasContext: target, viewport, transform, background: false, initialStyles: styles,
                resolveFont, shouldCancel: () => cancelled || shouldCancel?.(), surfaceBudget, textClipper, clipBounds: deviceClip, nativePainter: child }).promise;
              cancellation(); await child.writeDisplay(profile, outputProfile, cancellation, maskSampler); cancellation();
              ctx.save(); try { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = c.alpha; ctx.globalCompositeOperation = contribution ? c.blend : 'source-over'; ctx.drawImage(target.canvas, 0, 0); } finally { ctx.restore(); }
            } finally { child.destroy(); }
            continue;
          }
          if (c.isolated === false && c.blend !== 'source-over') throw new PdfEngineError('This non-isolated PDF group outer blend mode is not implemented yet.');
          if (c.softMask && c.blend !== 'source-over') throw new PdfEngineError('Masked PDF groups with an outer blend mode are not implemented yet.');
          if (c.colorProfile && !profileCache.has(c.colorProfile)) profileCache.set(c.colorProfile, parseIccProfile(c.colorProfile));
          const childProfile = c.colorProfile === undefined ? outputProfile : c.colorProfile ? profileCache.get(c.colorProfile) : null;
          if (c.isolated === false && childProfile !== outputProfile) throw new PdfEngineError('Non-isolated PDF groups that change blend color space are not implemented yet.');
          const precise = Boolean(c.softMask) || inheritedRgb, pixels = ctx.canvas.width * ctx.canvas.height * (precise ? 2 : 1);
          if (precise && typeof globalThis.Float16Array !== 'function') throw new PdfEngineError('High-precision PDF masks need float16 Canvas.');
          const retained = surfaceBudget.pixels + pixels;
          if (!Number.isSafeInteger(surfaceBudget.pixels) || surfaceBudget.pixels < 0 || !Number.isSafeInteger(retained) || retained > 16_000_000) throw new PdfEngineError('PDF transparency surface budget exceeded.', 'pdf_limit');
          surfaceBudget.pixels = retained; let surface;
          try {
            surface = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(ctx.canvas.width, ctx.canvas.height) : document.createElement('canvas');
            surface.width = ctx.canvas.width; surface.height = ctx.canvas.height;
            let target;
            try { target = surface.getContext('2d', precise ? { colorType: 'float16', colorSpace: 'srgb' } : undefined); }
            catch (error) { if (precise && ['TypeError', 'NotSupportedError'].includes(error.name)) throw new PdfEngineError('High-precision PDF masks need float16 Canvas.'); throw error; }
            if (!target) throw new PdfEngineError('Could not allocate PDF group surface.', 'pdf_render');
            const attributes = target.getContextAttributes?.();
            if (precise && (attributes?.colorType !== 'float16' || attributes?.colorSpace !== 'srgb')) throw new PdfEngineError('High-precision PDF masks need float16 sRGB Canvas.');
            if (precise) {
              if (inheritedRgb) surfaceBudget.pixels += 2;
              try { groupBand(target, 0, 0, 1, 1, true); } finally { if (inheritedRgb) surfaceBudget.pixels -= 2; }
            }
            if (c.isolated === false && !inheritedRgb) { target.globalAlpha = 1; target.globalCompositeOperation = 'source-over'; target.drawImage(ctx.canvas, 0, 0); }
            if (starting) target.setTransform(starting); target.setLineDash(ctx.getLineDash());
            const styles = Object.fromEntries(['fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin', 'miterLimit', 'lineDashOffset'].map(name => [name, ctx[name]]));
            const task = renderPdfDisplayList({ commands: c.commands, fonts: [] }, { canvasContext: target, viewport, transform, background: false, initialStyles: styles,
              resolveFont, shouldCancel: () => cancelled || shouldCancel?.(), surfaceBudget, opaqueBackdrop: c.isolated === false && !inheritedRgb && opaqueBackdrop, outputProfile: childProfile, profileCache, textClipper, clipBounds: deviceClip });
            await task.promise; cancellation();
            const initial = starting ? [starting.a, starting.b, starting.c, starting.d, starting.e, starting.f] : [1, 0, 0, 1, 0, 0];
            const maskSampler = inheritedRgb ? inheritedMask : c.softMask ? createPdfGroupSoftMaskSampler(c.softMask, {
              pageTransform: base.reduce((matrix, next) => multiply(matrix, next), initial), profileCache, surfaceBudget, cancellation,
            }) : null;
            if (c.softMask && typeof maskSampler?.sampleBand !== 'function') throw new PdfEngineError('Invalid PDF group mask sampler.', 'pdf_corrupt');
            if (c.isolated === false || maskSampler) {
              const bandPixels = inheritedRgb ? pdfInheritedRgbBandPixels(surfaceBudget, Boolean(maskSampler)) : 262144;
              const width = Math.min(surface.width, bandPixels), rows = Math.max(1, Math.floor(bandPixels / width)); let bands = 0;
              for (let top = 0; top < surface.height; top += rows) for (let left = 0; left < surface.width; left += width) {
                if (bands++) { await new Promise(resolve => setTimeout(resolve, 0)); cancellation(); }
                const columns = Math.min(width, surface.width - left), lines = Math.min(rows, surface.height - top);
                const units = inheritedRgb ? columns * lines * (maskSampler ? 6 : 4) : 0;
                if (inheritedRgb) {
                  if (surfaceBudget.pixels + units > 16_000_000) throw new PdfEngineError('PDF transparency surface budget exceeded.', 'pdf_limit');
                  const work = (surfaceBudget.shadingPixels ?? 0) + columns * lines;
                  if (!Number.isSafeInteger(work) || work > 64_000_000) throw new PdfEngineError('PDF inherited-RGB rectangle work exceeded.', 'pdf_limit');
                  surfaceBudget.shadingPixels = work; surfaceBudget.pixels += units;
                }
                try {
                const band = groupBand(target, left, top, columns, lines, precise), mask = maskSampler ? maskSampler.sampleBand(left, top, columns, lines) : null; cancellation();
                if (maskSampler && !(mask instanceof Float64Array)) throw new PdfEngineError('Invalid PDF group mask band.', 'pdf_corrupt');
                if (c.isolated === false && !inheritedRgb) crossfadePdfGroupPixels(band.data, groupBand(ctx, left, top, columns, lines, precise).data, c.alpha, mask);
                else scalePdfGroupAlpha(band.data, c.alpha, mask);
                target.putImageData(band, left, top);
                } finally { surfaceBudget.pixels -= units; }
              }
              cancellation();
            }
            if (childProfile !== outputProfile) {
              const rows = Math.max(1, Math.floor(262144 / surface.width));
              for (let top = 0; top < surface.height; top += rows) {
                if (top) { await new Promise(resolve => setTimeout(resolve, 0)); cancellation(); }
                const band = target.getImageData(0, top, surface.width, Math.min(rows, surface.height - top));
                convertBlendPixels(band.data, childProfile || deviceRgb(), outputProfile); target.putImageData(band, 0, top);
              }
            }
            // The proved one-Multiply primitive folds its outer factor into
            // source alpha. Paint once against the untouched parent/real clip;
            // copying a backdrop under an antialiased clip is not an identity.
            ctx.save(); try { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = c.isolated === false || maskSampler ? 1 : c.alpha; ctx.globalCompositeOperation = inheritedRgb ? 'multiply' : c.isolated === false ? 'copy' : c.blend; ctx.drawImage(surface, 0, 0); } finally { ctx.restore(); }
          } finally { try { if (surface) surface.width = surface.height = 0; } finally { surfaceBudget.pixels -= pixels; } }
        } else if (c.op === 'image' || c.op === 'jpeg') {
          if (nativePainter) {
            if (c.op !== 'image' || !(nativePainter.nativeColorSpace === 'ICCBased4' ? c.format === 'native-icc4' && c.colorSpace?.profileBytes === nativePainter.profileBytes : ['native-cmyk', 'native-rgb'].includes(c.format)) || c.blend !== 'source-over') throw new PdfEngineError('This native PDF image paint is not implemented yet.');
            const initial = starting ? [starting.a, starting.b, starting.c, starting.d, starting.e, starting.f] : [1, 0, 0, 1, 0, 0];
            const pageTransform = base.reduce((matrix, next) => multiply(matrix, next), initial);
            await nativePainter.image(c, c.matrix, pageTransform, c.alpha, deviceClip, cancellation);
            continue;
          }
          if (['native-cmyk', 'native-rgb', 'native-icc4'].includes(c.format)) throw new PdfEngineError('Native PDF image samples require their native group target.', 'pdf_corrupt');
          let bitmap, surface;
          try {
            if (c.op === 'jpeg') {
              bitmap = await createImageBitmap(new Blob([c.bytes], { type: 'image/jpeg' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' });
              if (bitmap.width !== c.width || bitmap.height !== c.height) throw new PdfEngineError('JPEG dimensions disagree with the PDF image.', 'pdf_corrupt');
            }
            const transformColor = c.colorProfile ? parseIccProfile(c.colorProfile) : null, outputProfile = c.outputProfile ? parseIccProfile(c.outputProfile) : null, nonDefaultDecode = c.decode?.some((n, i) => n !== i % 2);
            const sourceColor = transformColor || (c.components === 1 ? deviceGray() : deviceRgb());
            if (c.colorLookup && (!(c.colorLookup instanceof Uint8ClampedArray) || c.colorLookup.length !== 768 || c.components !== 1)) throw new PdfEngineError('Invalid PDF JPEG color lookup.', 'pdf_corrupt');
            const needsSurface = c.op === 'image' || c.maskAlpha || transformColor || outputProfile || nonDefaultDecode || c.colorKey || c.colorLookup;
            const bandRows = Math.max(1, Math.min(c.height, Math.floor(MAX_IMAGE_BAND_PIXELS / c.width)));
            if (needsSurface) {
              surface = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(c.width, bandRows) : document.createElement('canvas');
              surface.width = c.width; surface.height = bandRows;
            }
            if (c.maskAlpha && c.maskAlpha.length !== c.width * c.height) throw new PdfEngineError('Invalid JPEG soft-mask dimensions.', 'pdf_corrupt');
            cancellation(); ctx.save(); try {
              ctx.setTransform(1, 0, 0, 1, 0, 0); if (starting) ctx.setTransform(starting); for (const matrix of base) ctx.transform(...matrix);
              ctx.globalAlpha = c.alpha ?? 1; ctx.globalCompositeOperation = c.blend || 'source-over'; ctx.transform(...c.matrix); ctx.scale(1 / c.width, -1 / c.height);
              if (!needsSurface) ctx.drawImage(bitmap, 0, -c.height);
              else for (let top = 0; top < c.height; top += bandRows) {
                if (top) { await new Promise(resolve => setTimeout(resolve, 0)); cancellation(); }
                const rows = Math.min(bandRows, c.height - top); if (surface.height !== rows) surface.height = rows;
                const context = surface.getContext('2d', { willReadFrequently: c.op === 'jpeg' });
                if (!context) throw new PdfEngineError('Could not allocate PDF image canvas.', 'pdf_render');
                if (c.op === 'image') context.putImageData(new ImageData(c.pixels.subarray(top * c.width * 4, (top + rows) * c.width * 4), c.width, rows), 0, 0);
                else {
                  context.drawImage(bitmap, 0, top, c.width, rows, 0, 0, c.width, rows); const pixels = context.getImageData(0, 0, c.width, rows);
                  for (let i = 0; i < c.width * rows; i++) {
                    const sourceIndex = top * c.width + i, opacity = c.maskAlpha ? c.maskAlpha[sourceIndex] / 255 : 1, channels = c.components || 3, values = [], raw = [];
                    for (let channel = 0; channel < channels; channel++) {
                      raw.push(pixels.data[i * 4 + channel]); let value = raw[channel] / 255;
                      if (c.decode) value = c.decode[channel * 2] + value * (c.decode[channel * 2 + 1] - c.decode[channel * 2]);
                      if (c.matte && opacity) value = (value - c.matte[channel] * (1 - opacity)) / opacity; values.push(value);
                    }
                    const rgb = c.colorLookup ? null : convertPdfColor(sourceColor, values, outputProfile);
                    for (let channel = 0; channel < 3; channel++) pixels.data[i * 4 + channel] = c.colorLookup ? c.colorLookup[raw[0] * 3 + channel] : rgb[channel] * 255;
                    pixels.data[i * 4 + 3] = c.colorKey && raw.every((n, channel) => n >= c.colorKey[channel * 2] && n <= c.colorKey[channel * 2 + 1]) ? 0 : Math.round(opacity * 255);
                  }
                  context.putImageData(pixels, 0, 0);
                }
                ctx.drawImage(surface, 0, top - c.height);
              }
            } finally { ctx.restore(); }
          } finally { bitmap?.close?.(); if (surface) { surface.width = 0; surface.height = 0; } }
        } else throw new PdfEngineError(`Unknown original PDF display instruction ${c.op}.`);
      }
      cancellation();
    } finally { try { while (saves-- > 0) ctx.restore(); } finally { if (ownsTextClipper) textClipper.dispose(); } }
  })();
  return { promise, cancel() { cancelled = true; } };
}
