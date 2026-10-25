// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
export function multiply(a, b) {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}
export function createPdfViewport(view, { scale = 1, rotation = 0, offsetX = 0, offsetY = 0, userUnit = 1 } = {}) {
  rotation = (rotation % 360 + 360) % 360;
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(userUnit) || userUnit <= 0
    || !Number.isFinite(offsetX) || !Number.isFinite(offsetY) || ![0, 90, 180, 270].includes(rotation) || view.length !== 4
    || view.some(n => !Number.isFinite(n))) throw new PdfEngineError('Invalid PDF viewport.', 'pdf_corrupt');
  const [left, bottom, right, top] = view, width = right - left, height = top - bottom;
  if (width <= 0 || height <= 0) throw new PdfEngineError('Empty PDF page box.', 'pdf_corrupt');
  const basis = rotation === 0 ? [1, 0, 0, -1, -left, top]
    : rotation === 90 ? [0, 1, 1, 0, -bottom, -left]
      : rotation === 180 ? [-1, 0, 0, 1, right, -bottom] : [0, -1, -1, 0, top, right];
  const effectiveScale = scale * userUnit, transform = multiply([effectiveScale, 0, 0, effectiveScale, offsetX, offsetY], basis);
  const viewportWidth = (rotation % 180 ? height : width) * effectiveScale, viewportHeight = (rotation % 180 ? width : height) * effectiveScale;
  const determinant = transform[0] * transform[3] - transform[1] * transform[2];
  if (![viewportWidth, viewportHeight, determinant, ...transform].every(Number.isFinite)
    || viewportWidth <= 0 || viewportHeight <= 0 || determinant === 0) throw new PdfEngineError('Invalid PDF viewport.', 'pdf_corrupt');
  return { viewBox: [...view], width: viewportWidth, height: viewportHeight,
    scale, userUnit, rotation, offsetX, offsetY, transform,
    clone(settings = {}) { return createPdfViewport(this.viewBox, { scale: this.scale, rotation: this.rotation,
      offsetX: this.offsetX, offsetY: this.offsetY, ...settings, userUnit: this.userUnit }); },
    convertToViewportPoint(x, y) { const [a, b, c, d, e, f] = transform; return [a * x + c * y + e, b * x + d * y + f]; },
    convertToPdfPoint(x, y) { const [a, b, c, d, e, f] = transform, determinant = a * d - b * c; return [(d * (x - e) - c * (y - f)) / determinant, (-b * (x - e) + a * (y - f)) / determinant]; } };
}
