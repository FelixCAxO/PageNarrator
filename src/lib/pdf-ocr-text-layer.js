import { annotatePdfTextLayer } from './pdf-extraction.js';

export function renderPdfOcrTextLayer(pageEl, items, viewport, pageView) {
  const layer = pageEl?.querySelector('.textLayer');
  if (!layer || !items?.length || layer.dataset.ocr === 'true') return;
  const documentRef = layer.ownerDocument;
  const context = documentRef.createElement('canvas').getContext('2d');
  const spans = items.map((item) => {
    const span = documentRef.createElement('span');
    const scale = viewport.scale * (viewport.userUnit ?? 1);
    const height = item.height * scale;
    const [a, b, c, d, e, f] = item.transform;
    const angle = Math.atan2(viewport.transform[1] * a + viewport.transform[3] * b,
      viewport.transform[0] * a + viewport.transform[2] * b);
    const [x, y] = viewport.convertToViewportPoint(e + c, f + d);
    span.textContent = `${item.str} `;
    context.font = `${height}px sans-serif`;
    const width = context.measureText(item.str).width || 1;
    Object.assign(span.style, {
      left: `${x}px`, top: `${y}px`, fontSize: `${height}px`, fontFamily: 'sans-serif',
      transform: `rotate(${angle}rad) scaleX(${item.width * scale / width})`,
    });
    return span;
  });
  layer.replaceChildren(...spans);
  layer.dataset.ocr = 'true';
  const pageRotation = Math.round(Math.atan2(items[0].transform[1], items[0].transform[0]) * 180 / Math.PI);
  annotatePdfTextLayer(layer, items, { pageView, pageRotation });
}
