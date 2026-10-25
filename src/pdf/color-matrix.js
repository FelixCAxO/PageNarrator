// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
export const multiplyColorMatrix = (matrix, values) => [0, 1, 2].map(row => matrix[row * 3] * values[0] + matrix[row * 3 + 1] * values[1] + matrix[row * 3 + 2] * values[2]);
export function inverseColorMatrix(matrix) {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const adjugate = [e * i - f * h, c * h - b * i, b * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d];
  const determinant = a * adjugate[0] + b * adjugate[3] + c * adjugate[6];
  if (!Number.isFinite(determinant)) throw new PdfEngineError('ICC color matrix exceeds its numeric range.', 'pdf_corrupt');
  if (determinant === 0) return null;
  const inverse = adjugate.map(value => value / determinant);
  if (inverse.some(value => !Number.isFinite(value))) throw new PdfEngineError('ICC inverse matrix exceeds its numeric range.', 'pdf_corrupt');
  return inverse;
}
