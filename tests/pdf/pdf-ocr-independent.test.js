import { expect, it, vi } from 'vitest';
import { decodePdfOcrCtcLabels } from '../../src/lib/pdf-ocr-ctc.js';
import * as independentVerifier from '../../src/lib/pdf-ocr-independent.js';
const { mergePdfOcrIndependentLine, boundedPdfOcrVerifier, PDF_OCR_VERIFICATION_POLICY } = independentVerifier;
const mergePdfOcrUncertainLine = (...args) => independentVerifier.mergePdfOcrUncertainLine(...args);

const word = (text, x, confidence = 95) => ({ text, confidence, bbox: { x0: x, y0: 10, x1: x + 50, y1: 30 } });
const data = words => ({ blocks: [{ paragraphs: [{ lines: [{ bbox: { x0: 10, y0: 10, x1: 190, y1: 30 }, words }] }] }] });
const words = value => value.blocks[0].paragraphs[0].lines[0].words;
const fixture = () => ({ primary: data([word('clear', 10), word('mode/s', 70), word('context', 130)]), independent: data([word('wrong', 10), word('models', 70, 90), word('context', 130)]) });
const source = { width: 200, height: 50 };
const sourceProjection = { left: 100, top: 100, originX: 0, slope: 0, sourceWidth: 1000, sourceHeight: 500 };

it('changes only independently corroborated suspicious text and retains primary boxes and every other word', () => {
  const { primary, independent } = fixture(), original = JSON.stringify(primary), result = mergePdfOcrIndependentLine(primary, independent);
  expect(words(result).map(value => value.text)).toEqual(['clear', 'models', 'context']);
  expect(words(result)[0]).toBe(words(primary)[0]); expect(words(result)[2]).toBe(words(primary)[2]);
  expect(words(result)[1].bbox).toBe(words(primary)[1].bbox); expect(words(result)[1].confidence).toBe(90);
  expect(JSON.stringify(primary)).toBe(original);
});

it.each(['confidence', 'geometry', 'missing-context', 'ambiguous', 'changed-other-letters'])('retains primary text when independent %s evidence fails the frozen existing gate', reason => {
  const { primary, independent } = fixture();
  if (reason === 'confidence') words(independent)[1].confidence = 84.99;
  if (reason === 'geometry') words(independent)[1].bbox.x0 = 300;
  if (reason === 'missing-context') words(independent).splice(0, 1);
  if (reason === 'ambiguous') words(independent).push(word('models', 70, 90));
  if (reason === 'changed-other-letters') words(independent)[1].text = 'modest';
  expect(mergePdfOcrIndependentLine(primary, independent)).toBe(primary);
});

it('never calls the independent model for clear text, oversized crops, excessive words or cancellation', async () => {
  const recognize = vi.fn(async () => fixture().independent), verify = boundedPdfOcrVerifier(recognize);
  const clear = data([word('MODELS', 10), word('m/s', 70), word('AND/OR', 130)]);
  expect(await verify(source, clear)).toBe(clear);
  const { primary } = fixture(); expect(await verify({ width: 2048, height: 2048 }, primary)).toBe(primary);
  const dense = data(Array.from({ length: 513 }, () => word('mode/s', 10))); expect(await verify(source, dense)).toBe(dense);
  expect(await boundedPdfOcrVerifier(recognize, () => true)(source, primary)).toBe(primary);
  expect(recognize).not.toHaveBeenCalled();
});

it('freezes four whole-line attempts without hidden retries, keeps failed/late results and exposes actual errors', async () => {
  const { primary, independent } = fixture(), recognize = vi.fn(async () => independent), verify = boundedPdfOcrVerifier(recognize);
  for (let i = 0; i < 8; i++) await verify(source, primary);
  expect(recognize).toHaveBeenCalledTimes(PDF_OCR_VERIFICATION_POLICY.maximumLines);
  let cancelled = false;
  const late = boundedPdfOcrVerifier(async () => { cancelled = true; return independent; }, () => cancelled);
  expect(await late(source, primary)).toBe(primary);
  const error = new Error('Missing pinned English data'), onError = vi.fn();
  const unavailable = boundedPdfOcrVerifier(async () => { throw error; }, () => false, onError);
  expect(await unavailable(source, primary)).toBe(primary); expect(await unavailable(source, primary)).toBe(primary);
  expect(onError).toHaveBeenCalledExactlyOnceWith(error);
});


const uncertainFixture = () => {
  // The word mean is high even though one emitted letter remains uncertain.
  const [uncertain] = decodePdfOcrCtcLabels([1, 2, 3, 4, 5], [.99, .99, .99, .8, .99], ['', 's', 'h', 'a', 'p', 'e'],
    { left: 70, top: 10, height: 20, inputWidth: 120, width: 50 });
  return { primary: data([word('clear', 10), uncertain, word('context', 130)]),
    independent: data([word('clear', 10), word('share', 70), word('context', 130)]) };
};

it('routes a high-mean word by its uncertain character and changes only independently supported positions', async () => {
  const { primary, independent } = uncertainFixture(), original = JSON.stringify(primary);
  const recognize = vi.fn(async () => independent), verify = boundedPdfOcrVerifier(recognize);
  expect(words(primary)[1].confidence).toBeGreaterThan(85);
  expect(await verify(source, primary)).toBe(primary); expect(recognize).not.toHaveBeenCalled();
  expect(verify.uncertainCandidate(source, primary)).toBe(true);
  const result = await verify.verifyUncertain(source, primary, sourceProjection);
  expect(words(result).map(value => value.text)).toEqual(['clear', 'share', 'context']);
  expect(words(result)[0]).toBe(words(primary)[0]); expect(words(result)[2]).toBe(words(primary)[2]);
  expect(words(result)[1].bbox).toBe(words(primary)[1].bbox); expect(words(result)[1].confidence).toBe(95);
  expect(words(result)[1].symbols).toBeUndefined(); expect(JSON.stringify(primary)).toBe(original);
  expect(recognize).toHaveBeenCalledExactlyOnceWith(source);
});

it.each(['low-confidence', 'confident-position', 'insertion', 'punctuation', 'coverage', 'ambiguous', 'cross-word', 'no-overlap'])
('retains the complete primary when independent uncertain-letter %s evidence is insufficient', reason => {
  const { primary, independent } = uncertainFixture(), checked = words(independent);
  if (reason === 'low-confidence') checked[1].confidence = 84.999;
  if (reason === 'confident-position') checked[1].text = 'scare';
  if (reason === 'insertion') checked[1].text = 'sharpe';
  if (reason === 'punctuation') checked[1].text = 'shar!';
  if (reason === 'coverage') checked.pop();
  if (reason === 'ambiguous') checked.push(word('share', 70));
  if (reason === 'cross-word') checked[1].bbox = { x0: 10, y0: 10, x1: 120, y1: 30 };
  if (reason === 'no-overlap') checked[1].bbox = { x0: 300, y0: 10, x1: 350, y1: 30 };
  expect(mergePdfOcrUncertainLine(primary, independent, sourceProjection)).toBe(primary);
});

it.each(['missing', 'mismatch', 'invalid', 'non-letter', 'high-run-peak', 'boundary', 'multi-symbol'])
('does not schedule a line from %s primary uncertainty metadata', reason => {
  const { primary } = uncertainFixture(), target = words(primary)[1], recognize = vi.fn();
  if (reason === 'missing') delete target.symbols;
  if (reason === 'mismatch') target.symbols[3].text = 'r';
  if (reason === 'invalid') target.symbols[3].confidence = NaN;
  if (reason === 'non-letter') { target.text = '12.34'; target.symbols = [...target.text].map(text => ({ text, confidence: 80 })); }
  if (reason === 'high-run-peak') { target.confidence = 50; target.symbols.forEach(symbol => { symbol.confidence = 99; }); }
  if (reason === 'boundary') target.symbols[3].confidence = 85;
  if (reason === 'multi-symbol') target.symbols.splice(0, 2, { text: 'sh', confidence: 80 });
  const verify = boundedPdfOcrVerifier(recognize);
  expect(verify.uncertainCandidate(source, primary)).toBe(false);
  expect(mergePdfOcrUncertainLine(primary, data([word('share', 70)]), sourceProjection)).toBe(primary);
  expect(recognize).not.toHaveBeenCalled();
});

it('shares the four attempts with slash verification and preserves late/cancelled, failed and oversized uncertain reads', async () => {
  const { primary, independent } = uncertainFixture(), legacy = fixture(), recognize = vi.fn(async input => input === source ? independent : legacy.independent);
  const verify = boundedPdfOcrVerifier(recognize);
  for (let i = 0; i < 2; i++) await verify({ ...source }, legacy.primary);
  for (let i = 0; i < 8; i++) await verify.verifyUncertain(source, primary, sourceProjection);
  expect(recognize).toHaveBeenCalledTimes(4); expect(verify.spacingRemaining()).toBe(false);
  expect(verify.uncertainCandidate(source, primary)).toBe(false);
  let cancelled = false;
  const late = boundedPdfOcrVerifier(async () => { cancelled = true; return independent; }, () => cancelled);
  expect(await late.verifyUncertain(source, primary, sourceProjection)).toBe(primary);
  const failure = new Error('independent reader unavailable'), onError = vi.fn();
  const failed = boundedPdfOcrVerifier(async () => { throw failure; }, () => false, onError);
  expect(await failed.verifyUncertain(source, primary, sourceProjection)).toBe(primary); expect(await failed.verifyUncertain(source, primary, sourceProjection)).toBe(primary);
  expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
  const unused = vi.fn(), bounded = boundedPdfOcrVerifier(unused);
  expect(await bounded.verifyUncertain({ width: 2048, height: 2048 }, primary, sourceProjection)).toBe(primary); expect(unused).not.toHaveBeenCalled();
});

it('retains new independent symbol evidence without carrying stale primary symbols through a changed word', () => {
  const { primary, independent } = uncertainFixture(), candidate = words(independent)[1];
  candidate.symbols = [...candidate.text].map(text => ({ text, confidence: 95 }));
  expect(words(mergePdfOcrUncertainLine(primary, independent, sourceProjection))[1].symbols).toBe(candidate.symbols);
  const legacy = fixture(); words(legacy.primary)[1].symbols = [...'mode/s'].map(text => ({ text, confidence: 99 }));
  expect(words(mergePdfOcrIndependentLine(legacy.primary, legacy.independent))[1].symbols).toBeUndefined();
});

// Authored geometry controls, not replays of incomplete saved primary payloads.
const boundaryFixture = () => {
  const primaryWord = { ...word('shape', 20), bbox: { x0: 20, y0: 20, x1: 70, y1: 40 },
    symbols: [...'shape'].map((text, index) => ({ text, confidence: index === 3 ? 80 : 99 })) };
  const candidate = { ...word('share', 20), bbox: { ...primaryWord.bbox } };
  return { primary: data([primaryWord]), independent: data([candidate]),
    projection: { left: 10, top: 10, originX: 0, slope: 0, sourceWidth: 200, sourceHeight: 100 } };
};
const sourceEdges = [
  ['left-touch', { x0: 0 }], ['left-cross', { x0: -1 }],
  ['top-touch', { y0: 0 }], ['top-cross', { y0: -1 }],
  ['right-touch', { x1: 200 }], ['right-cross', { x1: 201 }],
  ['bottom-touch', { y1: 100 }], ['bottom-cross', { y1: 101 }],
];

it.each(sourceEdges)('abstains on %s for either matched word without changing primary evidence', (_name, edge) => {
  for (const owner of ['primary', 'independent']) {
    const { primary, independent, projection } = boundaryFixture();
    Object.assign(words(owner === 'primary' ? primary : independent)[0].bbox, edge);
    const before = JSON.stringify(primary), target = words(primary)[0], box = target.bbox, symbols = target.symbols;
    expect(mergePdfOcrUncertainLine(primary, independent, projection)).toBe(primary);
    expect(words(primary)[0]).toBe(target); expect(target.bbox).toBe(box); expect(target.symbols).toBe(symbols);
    expect(JSON.stringify(primary)).toBe(before);
  }
});

it.each([-0.5, 1])('abstains when shear %s intersects the source top or bottom despite interior local boxes', slope => {
  const { primary, independent, projection } = boundaryFixture();
  expect(mergePdfOcrUncertainLine(primary, independent, { ...projection, slope })).toBe(primary);
});

it('uses the local gutter-panel source dimensions and its retained crop origin', () => {
  const { primary, independent, projection } = boundaryFixture();
  const panel = { ...projection, left: 40, sourceWidth: 100 };
  expect(mergePdfOcrUncertainLine(primary, independent, panel)).toBe(primary);
  expect(words(mergePdfOcrUncertainLine(primary, independent, { ...panel, sourceWidth: 1000 }))[0].text).toBe('share');
  expect(mergePdfOcrUncertainLine(primary, independent, { ...projection, left: -10 })).toBe(primary);
});

it.each([-100, 300])('abstains on a matched word projected wholly outside the source at left=%s', left => {
  const { primary, independent, projection } = boundaryFixture();
  expect(mergePdfOcrUncertainLine(primary, independent, { ...projection, left })).toBe(primary);
});

it.each([undefined, null, {}, { left: NaN }, { top: Infinity }, { originX: undefined }, { slope: NaN },
  { sourceWidth: 0 }, { sourceWidth: 200.5 }, { sourceHeight: -1 }, { sourceHeight: Infinity }, { slope: Number.MAX_VALUE }])
('fails closed on missing or invalid source context %j', invalid => {
  const { primary, independent, projection } = boundaryFixture();
  const context = invalid === undefined || invalid === null || !Object.keys(invalid).length ? invalid : { ...projection, ...invalid };
  expect(mergePdfOcrUncertainLine(primary, independent, context)).toBe(primary);
});

it('abstains when a boundary word contradicts independent context despite a separate supported interior edit', () => {
  const { primary, independent, projection } = boundaryFixture(), edge = words(primary)[0], checked = words(independent)[0];
  edge.bbox.x0 = 0; checked.bbox.x0 = 0;
  words(primary).push({ ...edge, bbox: { x0: 100, y0: 20, x1: 150, y1: 40 } });
  words(independent).push({ ...checked, bbox: { x0: 100, y0: 20, x1: 150, y1: 40 } });
  const before = JSON.stringify(primary), result = mergePdfOcrUncertainLine(primary, independent, projection);
  expect(result).toBe(primary);
  expect(words(result).map(value => value.text)).toEqual(['shape', 'shape']);
  expect(words(result)[0]).toBe(edge);
  expect(JSON.stringify(primary)).toBe(before);
});

it('keeps a matching boundary context word intact while applying a separate supported interior edit', () => {
  const { primary, independent, projection } = boundaryFixture(), edge = words(primary)[0], checked = words(independent)[0];
  edge.bbox.x0 = 0; checked.bbox.x0 = 0; checked.text = edge.text;
  words(primary).push({ ...edge, bbox: { x0: 100, y0: 20, x1: 150, y1: 40 } });
  words(independent).push({ ...checked, text: 'share', bbox: { x0: 100, y0: 20, x1: 150, y1: 40 } });
  const result = mergePdfOcrUncertainLine(primary, independent, projection);
  expect(words(result).map(value => value.text)).toEqual(['shape', 'share']);
  expect(words(result)[0]).toBe(edge); expect(words(result)[1].bbox).toBe(words(primary)[1].bbox);
});

it.each(['unrelated-word', 'punctuation', 'split', 'word-order', 'reordered-target'])('retains primary when native %s context is not corroborated', reason => {
  const { primary, independent } = uncertainFixture(), checked = words(independent), original = JSON.stringify(primary);
  if (reason === 'unrelated-word') checked[0].text = 'wrong';
  if (reason === 'punctuation') checked[2].text += '.';
  if (reason === 'split') checked.splice(2, 1, word('con', 130), word('text', 155));
  if (reason === 'word-order') [checked[0], checked[2]] = [checked[2], checked[0]];
  if (reason === 'reordered-target') checked.push(checked.shift());
  expect(mergePdfOcrUncertainLine(primary, independent, sourceProjection)).toBe(primary);
  expect(JSON.stringify(primary)).toBe(original);
});

it('accepts multiple individually supported uncertain edits separated by unchanged literal context', () => {
  const { primary, independent, projection } = boundaryFixture();
  words(primary).push({ ...word('clear', 75), bbox: { x0: 75, y0: 20, x1: 95, y1: 40 } },
    { ...words(primary)[0], bbox: { x0: 100, y0: 20, x1: 150, y1: 40 } });
  words(independent).push({ ...word('clear', 75), bbox: { x0: 75, y0: 20, x1: 95, y1: 40 } },
    { ...words(independent)[0], bbox: { x0: 100, y0: 20, x1: 150, y1: 40 } });
  expect(words(mergePdfOcrUncertainLine(primary, independent, projection)).map(value => value.text)).toEqual(['share', 'clear', 'share']);
});

it('does not require context words that do not exist for a single-word source line', () => {
  const { primary, independent, projection } = boundaryFixture();
  expect(words(mergePdfOcrUncertainLine(primary, independent, projection))[0].text).toBe('share');
});

it('preserves the local correction when native disagreement is beyond its immediate neighbors', () => {
  const { primary, independent } = uncertainFixture();
  words(primary).push(word('later', 200)); words(independent).push(word('wrong', 200));
  const result = mergePdfOcrUncertainLine(primary, independent, sourceProjection);
  expect(words(result).map(value => value.text)).toEqual(['clear', 'share', 'context', 'later']);
  expect(words(result)[3]).toBe(words(primary)[3]);
});

it('keeps the existing native word gate when a supported replacement character is only61.445 percent', () => {
  const { primary, independent, projection } = boundaryFixture(), candidate = words(independent)[0];
  candidate.symbols = [...candidate.text].map((text, index) => ({ text, confidence: index === 3 ? 61.445 : 99 }));
  candidate.confidence = 94.085;
  expect(words(mergePdfOcrUncertainLine(primary, independent, projection))[0].text).toBe('share');
});

it('retains the V2 exact-85 word policy for interior geometry even when the changed independent letter is below 85', () => {
  const { primary, independent, projection } = boundaryFixture(), candidate = words(independent)[0];
  candidate.confidence = 85;
  candidate.symbols = [...candidate.text].map((text, index) => ({ text, confidence: index === 3 ? 60 : 99 }));
  const result = mergePdfOcrUncertainLine(primary, independent, projection);
  expect(words(result)[0].text).toBe('share'); expect(words(result)[0].confidence).toBe(85);
  expect(words(result)[0].symbols).toBe(candidate.symbols);
  candidate.confidence = 84.999;
  expect(mergePdfOcrUncertainLine(primary, independent, projection)).toBe(primary);
});

it('does not rewrite a mixed-case identifier from an uncertain emitted letter', async () => {
  const { primary, independent, projection } = boundaryFixture(), target = words(primary)[0];
  target.text = 'myVam'; target.symbols = [...target.text].map((text, index) => ({ text, confidence: index === 4 ? 80 : 99 }));
  words(independent)[0].text = 'myVar';
  const saved = JSON.stringify(primary), recognize = vi.fn(async () => independent), verify = boundedPdfOcrVerifier(recognize);
  expect(verify.uncertainCandidate(source, primary)).toBe(false);
  expect(mergePdfOcrUncertainLine(primary, independent, projection)).toBe(primary);
  expect(await verify.verifyUncertain(source, primary, projection)).toBe(primary);
  expect(recognize).not.toHaveBeenCalled(); expect(JSON.stringify(primary)).toBe(saved);
});

it.each(['x =', 'https://example.org', 'variable_1', 'AABB2', '5', 'Ordä', 'someValue'])
('keeps uncertain-letter edits out of a technical or unsupported source context: %s', text => {
  const { primary, independent, projection } = boundaryFixture(), context = word(text, 100);
  words(primary).push(context); words(independent).push({ ...context });
  const saved = JSON.stringify(primary), recognize = vi.fn(), verify = boundedPdfOcrVerifier(recognize);
  expect(verify.uncertainCandidate(source, primary)).toBe(false);
  expect(mergePdfOcrUncertainLine(primary, independent, projection)).toBe(primary);
  expect(recognize).not.toHaveBeenCalled(); expect(JSON.stringify(primary)).toBe(saved);
});

it.each(['clear', 'Clear', 'CLEAR'])('preserves uncertain-letter correction with ordinary %s prose context', text => {
  const { primary, independent, projection } = boundaryFixture(), context = word(text, 100);
  words(primary).push(context); words(independent).push({ ...context });
  expect(boundedPdfOcrVerifier(vi.fn()).uncertainCandidate(source, primary)).toBe(true);
  const result = mergePdfOcrUncertainLine(primary, independent, projection);
  expect(words(result).map(value => value.text)).toEqual(['share', text]);
  expect(words(result)[1]).toBe(context);
});
