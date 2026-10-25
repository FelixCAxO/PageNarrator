// Both the viewer and its CPU worker use the same pixel preprocessing.
export function createPdfOcrCanvas(width, height) {
  const canvas = globalThis.document?.createElement ? document.createElement('canvas') : new OffscreenCanvas(width, height);
  canvas.width = width; canvas.height = height;
  return canvas;
}
