// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { rgbToXyzD50, xyzD50ToRgb } from './icc-color.js';

/** Convert through unclipped PCS, preserving out-of-sRGB group colors. */
export function convertPdfColor(space, values, targetProfile = null) {
  if (!targetProfile) return space.convert(values);
  if (targetProfile.channels !== 3 || typeof targetProfile.fromXyz !== 'function') throw new PdfEngineError('This ICC blending-space inverse is not implemented yet.');
  if (space === targetProfile || space.profile === targetProfile) {
    if (!values || values.length !== 3 || Array.from(values).some(n => !Number.isFinite(n))) throw new PdfEngineError('Invalid ICC blending components.', 'pdf_corrupt');
    // A PCS round trip can erase plateaus and move exact half-byte endpoints.
    return Array.from(values, n => Math.max(0, Math.min(1, n)));
  }
  const xyz = space.toXyz ? space.toXyz(values) : rgbToXyzD50(space.convert(values));
  return targetProfile.fromXyz(xyz);
}

/** Canvas stores straight encoded group channels; alpha stays unchanged. */
export function convertBlendPixels(pixels, sourceProfile, targetProfile = null) {
  if (!(pixels instanceof Uint8ClampedArray) || pixels.length % 4 || !sourceProfile?.toXyz) throw new PdfEngineError('Invalid ICC blending pixels.', 'pdf_corrupt');
  if (targetProfile && typeof targetProfile.fromXyz !== 'function') throw new PdfEngineError('This ICC blending-space inverse is not implemented yet.');
  for (let at = 0; at < pixels.length; at += 4) {
    if (!pixels[at + 3]) continue;
    const xyz = sourceProfile.toXyz([pixels[at] / 255, pixels[at + 1] / 255, pixels[at + 2] / 255]);
    const values = targetProfile ? targetProfile.fromXyz(xyz) : xyzD50ToRgb(xyz);
    for (let channel = 0; channel < 3; channel++) pixels[at + channel] = values[channel] * 255;
  }
  return pixels;
}
