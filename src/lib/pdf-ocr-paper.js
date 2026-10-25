// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later

/** Map preview bounds from their actual integer raster into this render region. */
export function getPdfOcrPaperCrop(paper, width, height, scale, {
  sourceWidth = width, sourceHeight = height, sourceScale = scale, offsetX = 0,
} = {}) {
  if (![width, height, sourceWidth, sourceHeight].every(value => Number.isInteger(value) && value > 0)
    || ![scale, sourceScale].every(value => Number.isFinite(value) && value > 0 && value <= 3)
    || !Number.isInteger(offsetX) || offsetX < 0
    || !paper || !['left', 'top', 'right', 'bottom'].every(key => Number.isFinite(paper[key]))) return null;
  const { left, top, right, bottom } = paper;
  if (left < 0 || top < 0 || right > 1 || bottom > 1 || right <= left || bottom <= top) return null;
  // Full bounds mean no bounded paper was found. Keep GPU full-frame UVDoc.
  const full = left === 0 && top === 0 && right === 1 && bottom === 1;
  const ratio = scale / sourceScale;
  const x = full ? 0 : Math.max(0, Math.floor(left * sourceWidth * ratio) - offsetX - 8);
  const y = full ? 0 : Math.max(0, Math.floor(top * sourceHeight * ratio) - 8);
  const cropWidth = (full ? width : Math.min(width, Math.ceil(right * sourceWidth * ratio) - offsetX + 8)) - x;
  const cropHeight = (full ? height : Math.min(height, Math.ceil(bottom * sourceHeight * ratio) + 8)) - y;
  if (cropWidth < 2 || cropHeight < 2) return null;
  const factor = Math.min(3 / scale, Math.sqrt(4_000_000 / (cropWidth * cropHeight)));
  return { left: x, top: y, width: cropWidth, height: cropHeight, factor };
}

/** A source-space crop only when a bounded paper finder removed substantial framing. */
export function getPdfOcrPaperSourceCrop(paper, width, height, scale) {
  const crop = getPdfOcrPaperCrop(paper, width, height, scale);
  if (!crop) return null;
  const area = (paper.right - paper.left) * (paper.bottom - paper.top);
  return area > 0.8 || area < 0.05 ? null : crop;
}
