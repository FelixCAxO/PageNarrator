// UVDoc's two-channel grid uses normalized source coordinates and align_corners.
export function mapPdfOcrGridPoint(x, y, grid) {
  const { data, width, height, sourceWidth, sourceHeight, outputWidth, outputHeight } = grid;
  const gx = Math.max(0, Math.min(width - 1, x * (width - 1) / (outputWidth - 1)));
  const gy = Math.max(0, Math.min(height - 1, y * (height - 1) / (outputHeight - 1)));
  const left = Math.floor(gx), top = Math.floor(gy);
  const right = Math.min(left + 1, width - 1), bottom = Math.min(top + 1, height - 1);
  const fx = gx - left, fy = gy - top;
  const sample = (offset) =>
    (data[offset + top * width + left] * (1 - fx) + data[offset + top * width + right] * fx) * (1 - fy)
    + (data[offset + bottom * width + left] * (1 - fx) + data[offset + bottom * width + right] * fx) * fy;
  return { x: (sample(0) + 1) * (sourceWidth - 1) / 2,
    y: (sample(width * height) + 1) * (sourceHeight - 1) / 2 };
}

export function mapPdfOcrGridBox(box, grid) {
  // Bilinear extrema occur at cell corners, including intersections inside the box.
  const coordinates = (low, high, count, size) => {
    const values = [low, high];
    for (let i = 1; i < count - 1; i++) {
      const value = i * (size - 1) / (count - 1);
      if (value > low && value < high) values.push(value);
    }
    return values;
  };
  const xs = coordinates(box.x0, box.x1, grid.width, grid.outputWidth);
  const ys = coordinates(box.y0, box.y1, grid.height, grid.outputHeight);
  const result = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const x of xs) for (const y of ys) {
    const point = mapPdfOcrGridPoint(x, y, grid);
    result.x0 = Math.min(result.x0, point.x); result.x1 = Math.max(result.x1, point.x);
    result.y0 = Math.min(result.y0, point.y); result.y1 = Math.max(result.y1, point.y);
  }
  return result;
}

export function mapPdfOcrGridBaseline(baseline, grid) {
  const start = mapPdfOcrGridPoint(baseline.x0, baseline.y0, grid);
  const end = mapPdfOcrGridPoint(baseline.x1, baseline.y1, grid);
  return { x0: start.x, y0: start.y, x1: end.x, y1: end.y };
}
// Map a horizontal detector crop back before applying the page correction grid.
export function mapPdfOcrShearedBox(box, { left, top, originX, slope, padding = 10, sourceWidth, sourceHeight }) {
  const x0 = box.x0 + left - padding, x1 = box.x1 + left - padding;
  const a = slope * (x0 - originX), b = slope * (x1 - originX);
  if (sourceWidth !== undefined || sourceHeight !== undefined) {
    const y0 = box.y0 + top - padding, y1 = box.y1 + top - padding;
    // Recognition context can include synthetic pixels outside the original
    // image. Intersect its actual sheared polygon, rather than admitting an
    // enclosing rectangle that only happens to overlap the source corner.
    const points = clipSourcePolygon([[x0, y0 + a], [x1, y0 + b], [x1, y1 + b], [x0, y1 + a]], sourceWidth, sourceHeight);
    if (!points.length) return null;
    return { x0: Math.min(...points.map(p => p[0])), x1: Math.max(...points.map(p => p[0])),
      y0: Math.min(...points.map(p => p[1])), y1: Math.max(...points.map(p => p[1])) };
  }
  return { x0, x1, y0: box.y0 + top - padding + Math.min(a, b),
    y1: box.y1 + top - padding + Math.max(a, b) };
}

function clipSourcePolygon(points, width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0
    || points.some(point => point.some(value => !Number.isFinite(value)))) throw new Error('Invalid OCR source geometry.');
  for (const [axis, edge, direction] of [[0, 0, 1], [0, width, -1], [1, 0, 1], [1, height, -1]]) {
    const next = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      const insideA = (a[axis] - edge) * direction >= 0, insideB = (b[axis] - edge) * direction >= 0;
      if (insideA) next.push(a);
      if (insideA !== insideB) {
        const factor = (edge - a[axis]) / (b[axis] - a[axis]);
        const point = [a[0] + factor * (b[0] - a[0]), a[1] + factor * (b[1] - a[1])];
        point[axis] = edge; next.push(point);
      }
    }
    points = next;
  }
  const twiceArea = points.reduce((area, point, i) => {
    const next = points[(i + 1) % points.length]; return area + point[0] * next[1] - next[0] * point[1];
  }, 0);
  return Math.abs(twiceArea) > 0 ? points : [];
}

export function mapPdfOcrShearedBaseline(baseline, { left, top, originX, slope, padding = 10, sourceWidth, sourceHeight }) {
  let x0 = baseline.x0 + left - padding, x1 = baseline.x1 + left - padding;
  let y0 = baseline.y0 + top - padding + slope * (x0 - originX),
    y1 = baseline.y1 + top - padding + slope * (x1 - originX);
  if (![x0, x1, y0, y1, sourceWidth, sourceHeight].every(Number.isFinite) || sourceWidth <= 0 || sourceHeight <= 0) throw new Error('Invalid OCR source baseline.');
  const dx = x1 - x0, dy = y1 - y0;
  let first = 0, last = 1;
  for (const [p, q] of [[-dx, x0], [dx, sourceWidth - x0], [-dy, y0], [dy, sourceHeight - y0]]) {
    if (p === 0) { if (q < 0) return null; }
    else if (p < 0) first = Math.max(first, q / p);
    else last = Math.min(last, q / p);
  }
  if (first > last) return null;
  x1 = Math.max(0, Math.min(sourceWidth, x0 + last * dx)); y1 = Math.max(0, Math.min(sourceHeight, y0 + last * dy));
  x0 = Math.max(0, Math.min(sourceWidth, x0 + first * dx)); y0 = Math.max(0, Math.min(sourceHeight, y0 + first * dy));
  return { x0, x1, y0, y1 };
}
