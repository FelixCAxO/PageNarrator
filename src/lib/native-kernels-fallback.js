// Keep ordinary OCR available when the packaged Wasm module cannot initialize.
export function detectorComponentsFallback(data, w, h, imageWidth, imageHeight) {
  // Float32 sigmoid kernels can overshoot by one ULP; reject anything beyond that.
  for (let i = 0; i < data.length; i++) {
    const probability = data[i];
    if (!Number.isFinite(probability) || probability < -(2 ** -23) || probability > 1 + 2 ** -23)
      throw new Error('Invalid detector probability');
    data[i] = Math.max(0, Math.min(1, probability));
  }
  // Diagnostic component bounds only: not Paddle's contour/unclip postprocessor.
  const seen = new Uint8Array(w * h), queue = new Int32Array(w * h), boxes = [];
  for (let p = 0; p < w * h; p++) {
    if (seen[p] || data[p] < .2) continue;
    let head = 0, tail = 1, count = 0, sum = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    queue[0] = p; seen[p] = 1;
    while (head < tail) {
      const q = queue[head++], x = q % w, y = Math.floor(q / w);
      count++; sx += x; sy += y; sxx += x * x; sxy += x * y; sum += data[q];
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = x + dx, ny = y + dy, z = ny * w + nx;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && !seen[z] && data[z] >= .2) {
          seen[z] = 1; queue[tail++] = z;
        }
      }
    }
    if (count >= 3 && sum / count >= .4) {
      const variance = sxx - sx * sx / count;
      const slope = variance > 0 ? (sxy - sx * sy / count) / variance : 0;
      let low = Infinity, high = -Infinity;
      for (let j = 0; j < tail; j++) {
        const px = queue[j] % w, py = Math.floor(queue[j] / w), v = py - slope * (px - x0);
        low = Math.min(low, v); high = Math.max(high, v);
      }
      boxes.push({ x0: x0 * imageWidth / w, y0: low * imageHeight / h,
        x1: (x1 + 1) * imageWidth / w, y1: (high + 1) * imageHeight / h,
        slope: slope * (imageHeight / h) / (imageWidth / w), score: sum / count, count });
    }
  }
  return boxes;
}
