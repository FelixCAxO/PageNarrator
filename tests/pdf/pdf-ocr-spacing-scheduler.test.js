import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../src/lib/pdf-ocr-neural-batch.js', () => ({ recognizePdfOcrNeuralLines: vi.fn() }));
import { recognizePdfOcrNeuralLines } from '../../src/lib/pdf-ocr-neural-batch.js';
import { recognizePdfOcrDetectedLines } from '../../src/lib/pdf-ocr-detector.js';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
const data = id => ({ blocks: [{ paragraphs: [{ lines: [{ bbox: { x0: 10, x1: 30, y0: 10, y1: 30 },
  words: [{ text: `word${id}`, bbox: { x0: 10, x1: 30, y0: 10, y1: 30 }, confidence: 95 }], id }] }] }] });
const idOf = value => value.blocks[0].paragraphs[0].lines[0].id;

async function run({ spacing = [], uncertain = [], legacy = [], oldMock = false, change = false, gray = 255,
  cancelAfterId = null, cancelAtRedraw = false, throwDeferred = false, throwBatch = false } = {}) {
  const count = 8, canvases = [], calls = [], candidates = [], projections = []; let cancelled = false, recognized = 0, used = 0;
  vi.stubGlobal('document', { createElement: () => {
    if (cancelAtRedraw && recognized === count) cancelled = true;
    const operations = [], canvas = { width: 0, height: 0, operations, getContext: () => ({
      set fillStyle(value) { operations.push(['fillStyle', value]); },
      fillRect(...values) { operations.push(['fillRect', ...values]); },
      setTransform(...values) { operations.push(['setTransform', ...values]); },
      drawImage(...values) { operations.push(['drawImage', ...values]); },
      getImageData: () => ({ data: new Uint8ClampedArray(canvas.width * canvas.height * 4).fill(gray), width: canvas.width, height: canvas.height }),
    }) }; canvases.push(canvas); return canvas;
  } });
  recognizePdfOcrNeuralLines.mockImplementation(async images => {
    if (throwBatch && recognized >= 2) throw new Error('batch failure');
    return images.map(() => data(recognized++));
  });
  const verify = async (_canvas, primary) => {
    const id = idOf(primary); if (legacy.includes(id) && used < 4) { used++; calls.push(['legacy', id]); }
    if (id === cancelAfterId) cancelled = true; return primary;
  };
  if (!oldMock) {
    verify.uncertainCandidate = (_canvas, primary) => {
      const id = idOf(primary); return uncertain.includes(id) && !legacy.includes(id) && used < 4;
    };
    verify.verifyUncertain = async (_canvas, primary, projection) => {
      projections.push(projection);
      const id = idOf(primary); expect(used).toBeLessThan(4); used++; calls.push(['uncertain', id]);
      if (throwDeferred) throw new Error('deferred failure');
      if (!change) return primary;
      const line = primary.blocks[0].paragraphs[0].lines[0];
      return { blocks: [{ paragraphs: [{ lines: [{ ...line, words: [{ ...line.words[0], text: `changed${id}` }] }] }] }] };
    };
    verify.spacingCandidate = (_canvas, primary) => {
      const id = idOf(primary); if (spacing.includes(id) && !legacy.includes(id) && used < 4) { candidates.push(id); return true; }
      return false;
    };
    verify.spacingRemaining = () => used < 4 && !cancelled;
    verify.verifySpacing = async (_canvas, primary) => {
      const id = idOf(primary); expect(used).toBeLessThan(4); used++; calls.push(['spacing', id]);
      if (throwDeferred) throw new Error('deferred failure');
      if (!change) return primary;
      const line = primary.blocks[0].paragraphs[0].lines[0];
      return { blocks: [{ paragraphs: [{ lines: [{ ...line, words: [{ ...line.words[0], text: `changed${id}` }] }] }] }] };
    };
  }
  const boxes = Array.from({ length: count }, (_, id) => ({ x0: 20 + id * 50, x1: 55 + id * 50, y0: 20, y1: 45, slope: id % 2 ? 0.03125 : 0 }));
  let result, error;
  try { result = await recognizePdfOcrDetectedLines({ width: 600, height: 300 }, {}, null, null, [], () => cancelled, boxes, verify); }
  catch (failure) { error = failure; }
  return { result, error, canvases, calls, candidates, projections };
}

it('preserves ordinary order and old verifier mocks with zero deferred work', async () => {
  for (const oldMock of [false, true]) {
    const result = await run({ oldMock, spacing: oldMock ? [0] : [] });
    expect(result.result.map(line => line.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(result.calls).toEqual([]); expect(result.canvases).toHaveLength(8);
    expect(result.canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
  }
});

it('retains the first four eligible descriptors in document order without all-line pixels', async () => {
  const result = await run({ spacing: [0, 1, 2, 3, 4, 5, 6, 7] });
  expect(result.candidates).toEqual([0, 1, 2, 3]); expect(result.calls).toEqual([['spacing', 0], ['spacing', 1], ['spacing', 2], ['spacing', 3]]);
  expect(result.canvases).toHaveLength(12); expect(result.canvases.every(canvas => !canvas.width && !canvas.height)).toBe(true);
});

it('keeps all four late legacy attempts and creates no redraw when they exhaust the shared budget', async () => {
  const result = await run({ spacing: [0, 1, 2, 3], legacy: [4, 5, 6, 7] });
  expect(result.calls).toEqual([['legacy', 4], ['legacy', 5], ['legacy', 6], ['legacy', 7]]); expect(result.canvases).toHaveLength(8);
});

it('uses only the two remaining attempts after legacy and never rereads a legacy line', async () => {
  const result = await run({ spacing: [0, 1, 2, 3, 4], legacy: [4, 5] });
  expect(result.calls).toEqual([['legacy', 4], ['legacy', 5], ['spacing', 0], ['spacing', 1]]);
});

it('replaces only the changed result group and recreates expanded crop dimensions, fill and shear exactly', async () => {
  const result = await run({ spacing: [1], change: true, gray: 117 });
  expect(result.result.map(line => line.words[0].text)).toEqual(['word0', 'changed1', 'word2', 'word3', 'word4', 'word5', 'word6', 'word7']);
  expect(result.canvases.at(-1).operations).toEqual(result.canvases[3].operations);
  expect(result.canvases.every(canvas => !canvas.width && !canvas.height)).toBe(true);
});

it.each(['before-redraw', 'during-redraw'])('cancels %s without reviving deferred model work', async when => {
  const result = await run({ spacing: [0], ...(when === 'before-redraw' ? { cancelAfterId: 7 } : { cancelAtRedraw: true }) });
  expect(result.result).toBeNull(); expect(result.calls).toEqual([]);
  expect(result.canvases.every(canvas => !canvas.width && !canvas.height)).toBe(true);
});

it.each(['batch', 'deferred'])('closes all original and deferred canvases after a thrown %s operation', async when => {
  const result = await run({ spacing: [0], ...(when === 'batch' ? { throwBatch: true } : { throwDeferred: true }) });
  expect(result.error.message).toBe(`${when} failure`); expect(result.canvases.every(canvas => !canvas.width && !canvas.height)).toBe(true);
});


it('gives late uncertain lines the same four bounded descriptors ahead of early spacing work', async () => {
  const result = await run({ spacing: [0, 1, 2, 3], uncertain: [4, 5, 6, 7] });
  expect(result.calls).toEqual([['uncertain', 4], ['uncertain', 5], ['uncertain', 6], ['uncertain', 7]]);
  expect(result.canvases).toHaveLength(12); expect(result.canvases.every(canvas => !canvas.width && !canvas.height)).toBe(true);
});

it('preserves late slash priority, then uncertain document order and only the remaining spacing budget', async () => {
  const result = await run({ spacing: [0, 2, 4], uncertain: [1, 3, 5, 6], legacy: [7] });
  expect(result.calls).toEqual([['legacy', 7], ['uncertain', 1], ['uncertain', 3], ['uncertain', 5]]);
  expect(result.canvases).toHaveLength(11); expect(result.canvases.every(canvas => !canvas.width && !canvas.height)).toBe(true);
});

it('redraws the exact existing crop and changes only its result group for uncertain verification', async () => {
  const result = await run({ uncertain: [1], change: true, gray: 117 });
  expect(result.result.map(line => line.words[0].text)).toEqual(['word0', 'changed1', 'word2', 'word3', 'word4', 'word5', 'word6', 'word7']);
  expect(result.canvases.at(-1).operations).toEqual(result.canvases[3].operations);
  expect(result.canvases.every(canvas => !canvas.width && !canvas.height)).toBe(true);
});

it.each(['before-redraw', 'during-redraw', 'failure'])('closes uncertain deferred source crops on %s without hidden retries', async when => {
  const result = await run({ uncertain: [0], ...(when === 'before-redraw' ? { cancelAfterId: 7 }
    : when === 'during-redraw' ? { cancelAtRedraw: true } : { throwDeferred: true }) });
  if (when === 'failure') expect(result.error.message).toBe('deferred failure');
  else { expect(result.result).toBeNull(); expect(result.calls).toEqual([]); }
  expect(result.canvases.every(canvas => !canvas.width && !canvas.height)).toBe(true);
});


it('uses one deferred descriptor and one shared attempt when uncertainty and spacing eligibility overlap', async () => {
  const result = await run({ spacing: [1], uncertain: [1], change: true });
  expect(result.calls).toEqual([['uncertain', 1]]); expect(result.canvases).toHaveLength(9);
  expect(result.result.map(line => line.words[0].text)).toEqual(['word0', 'changed1', 'word2', 'word3', 'word4', 'word5', 'word6', 'word7']);
  expect(result.canvases.every(canvas => !canvas.width && !canvas.height)).toBe(true);
});

it('passes each deferred crop original-source origin, shear and local image dimensions without retaining pixels', async () => {
  const result = await run({ uncertain: [0, 1] });
  expect(result.projections).toEqual([
    { left: 16, top: 16, originX: 20, slope: 0, sourceWidth: 600, sourceHeight: 300 },
    { left: 66, top: 16, originX: 70, slope: 0.03125, sourceWidth: 600, sourceHeight: 300 },
  ]);
  expect(result.calls).toEqual([['uncertain', 0], ['uncertain', 1]]);
  expect(result.canvases).toHaveLength(10); expect(result.canvases.every(canvas => !canvas.width && !canvas.height)).toBe(true);
});
