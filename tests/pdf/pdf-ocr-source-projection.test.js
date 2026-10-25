import { expect, it, vi } from 'vitest';

const { recognize } = vi.hoisted(() => ({ recognize: vi.fn() }));
vi.mock('../../src/lib/pdf-ocr-neural-batch.js', () => ({ recognizePdfOcrNeuralLines: recognize }));
import { recognizePdfOcrDetectedLines } from '../../src/lib/pdf-ocr-detector.js';

it('preserves partial low-confidence source text and rejects only zero-area source words', async () => {
  const canvases = [];
  vi.stubGlobal('document', { createElement: () => {
    const canvas = { width: 0, height: 0, getContext: () => ({ fillRect() {}, setTransform() {}, drawImage() {},
      getImageData: () => ({ width: canvas.width, height: canvas.height, data: new Uint8ClampedArray(canvas.width * canvas.height * 4).fill(255) }) }) };
    canvases.push(canvas); return canvas;
  } });
  const line = { bbox: { x0: 10, x1: 40, y0: 40, y1: 90 },
    baseline: { x0: 10, x1: 40, y0: 60, y1: 60 },
    words: [
      { text: 'edge', confidence: 0.1, bbox: { x0: 10, x1: 30, y0: 40, y1: 70 } },
      { text: 'padding', confidence: 99, bbox: { x0: 10, x1: 30, y0: 80, y1: 90 } },
    ] };
  recognize.mockResolvedValue([{ blocks: [{ paragraphs: [{ lines: [line] }] }] }]);
  try {
    const output = await recognizePdfOcrDetectedLines({ width: 200, height: 180 }, {}, {}, {}, [], () => false,
      [{ x0: 150, x1: 180, y0: 130, y1: 170, slope: 0 }]);
    expect(output).toHaveLength(1);
    expect(output[0].words).toEqual([{ text: 'edge', confidence: 0.1, bbox: { x0: 144, x1: 164, y0: 154, y1: 180 } }]);
    expect(output[0].bbox).toEqual({ x0: 144, x1: 174, y0: 154, y1: 180 });
    expect(output[0].baseline).toEqual({ x0: 144, x1: 174, y0: 174, y1: 174 });
    expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
  } finally { vi.unstubAllGlobals(); }
});
