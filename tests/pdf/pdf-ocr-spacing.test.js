import { expect, it, vi } from 'vitest';
import { analyzeSpacingSource, mergeSpacingSource } from '../../src/lib/pdf-ocr-spacing.js';
import { boundedPdfOcrVerifier } from '../../src/lib/pdf-ocr-independent.js';

const word = (text, x0, x1, confidence = 95) => ({ text, confidence, bbox: { x0, x1, y0: 12, y1: 38 } });
const data = words => ({ blocks: [{ paragraphs: [{ lines: [{ bbox: { x0: 10, x1: 200, y0: 12, y1: 38 },
  baseline: { x0: 10, x1: 200, y0: 36, y1: 36 }, words }] }] }] });
const wordsOf = value => value.blocks[0].paragraphs[0].lines[0].words;
const sourceProjection = { left: 100, top: 100, originX: 0, slope: 0, sourceWidth: 1000, sourceHeight: 500 };
function fixture(offsets = [0, 0, 0]) {
  const source = { width: 240, height: 50, data: new Uint8ClampedArray(240 * 50 * 4).fill(255) };
  const spans = [[11, 19], [22, 30], [54, 62], [65, 73], [95, 103], [106, 115], [137, 145], [148, 157], [179, 187], [190, 199]];
  for (const [index, span] of spans.entries()) {
    const offset = index < 4 ? 0 : offsets[Math.floor((index - 4) / 2)], [left, right] = span.map(value => value + offset);
    for (let y = 14; y < 36; y++) for (let x = left; x < right; x++) {
      if (y < 16 || y >= 34 || x < left + 2 || x >= right - 2) {
        const p = (y * source.width + x) * 4; source.data[p] = source.data[p + 1] = source.data[p + 2] = 20;
      }
    }
  }
  const words = [word('AABB', 10, 74), word('CC', 94 + offsets[0], 116 + offsets[0]), word('DD', 136 + offsets[1], 158 + offsets[1]), word('EE', 178 + offsets[2], 200 + offsets[2])];
  return { source, canvas: { width: 240, height: 50, getContext: () => ({ getImageData: () => source }) },
    primary: data(words), independent: data([word('AA', 10, 31), word('BB', 53, 74), ...words.slice(1)]) };
}

function rasterReferenceFixture(references, internalGap) {
  const source = { width: 240, height: 50, data: new Uint8ClampedArray(240 * 50 * 4).fill(255) };
  const draw = left => {
    for (let y = 14; y < 36; y++) for (let x = left; x < left + 8; x++) if (y < 16 || y >= 34 || x < left + 2 || x >= left + 6) {
      const pixel = (y * source.width + x) * 4; source.data[pixel] = source.data[pixel + 1] = source.data[pixel + 2] = 20;
    }
  };
  draw(11); const second = 19 + internalGap; draw(second);
  let right = second + 8;
  const words = [word('AABB', 10, right + 1)];
  for (const [index, gap] of references.entries()) {
    const left = right + gap; draw(left); right = left + 8;
    words.push(word(['CC', 'DD', 'EE', 'FF'][index], left - 1, right + 1));
  }
  return { source, primary: data(words), independent: data([word('AA', 10, 20), word('BB', second - 1, second + 9), ...words.slice(1)]) };
}

it('uses actual same-line blank columns and partitions only the corroborated exact letters', () => {
  const { source, primary, independent } = fixture(), before = JSON.stringify(primary), analysis = analyzeSpacingSource(source, primary);
  expect(analysis.eligible).toBe(true); expect(analysis.medianReference).toBe(22); expect(analysis.words[0].gaps[0].width).toBe(24);
  const result = mergeSpacingSource(source, primary, independent, analysis), words = wordsOf(result.data);
  expect(words.map(w => w.text)).toEqual(['AA', 'BB', 'CC', 'DD', 'EE']);
  expect(words.slice(0, 2).map(w => [w.bbox.x0, w.bbox.x1])).toEqual([[10, 30], [54, 74]]);
  expect(words[2]).toBe(wordsOf(primary)[1]); expect(result.data.blocks[0].paragraphs[0].lines[0].baseline).toBe(primary.blocks[0].paragraphs[0].lines[0].baseline);
  expect(words[0].bbox.y0).toBe(12); expect(words[0].bbox.y1).toBe(38); expect(words[0].confidence).toBe(95);
  expect(JSON.stringify(primary)).toBe(before);
});

it('corroborates an internal space and terminal mark in the same bounded read', async () => {
  const { source, canvas, primary, independent } = fixture();
  for (let y = 33; y < 35; y++) for (let x = 203; x < 205; x++) {
    const p = (y * source.width + x) * 4;
    source.data[p] = source.data[p + 1] = source.data[p + 2] = 20;
  }
  const last = wordsOf(independent).at(-1);
  last.text += '.'; last.bbox = { ...last.bbox, x1: 206 };
  const recognize = vi.fn(async () => independent), verify = boundedPdfOcrVerifier(recognize);
  expect(verify.spacingCandidate(canvas, primary)).toBe(true);
  const result = await verify.verifySpacing(canvas, primary);
  expect(wordsOf(result).map(word => word.text)).toEqual(['AA', 'BB', 'CC', 'DD', 'EE.']);
  expect(recognize).toHaveBeenCalledTimes(1);
});

it.each([false, true])('allows only one source raster column below the reference median (fractional=%s)', fractional => {
  const { source, primary, independent } = fixture([2, 5, 8]);
  if (fractional) { wordsOf(primary)[3].text = 'E'; wordsOf(independent)[4].text = 'E'; }
  const analysis = analyzeSpacingSource(source, primary);
  expect(analysis.references.map(gap => gap.width)).toEqual(fractional ? [24, 25] : [24, 25, 25]);
  expect(analysis.medianReference).toBe(fractional ? 24.5 : 25);
  expect(analysis.words[0].gaps.map(gap => gap.width)).toEqual([24]);
  expect(wordsOf(mergeSpacingSource(source, primary, independent, analysis).data).map(value => value.text)).toEqual(['AA', 'BB', 'CC', 'DD', fractional ? 'E' : 'EE']);
  wordsOf(independent)[0].text = 'AX';
  expect(mergeSpacingSource(source, primary, independent, analysis).data).toBe(primary);
});

it('keeps the robust median when one measured reference is contaminated by a tiny gap', () => {
  const { source, primary, independent } = fixture([-20, -16, -12]), analysis = analyzeSpacingSource(source, primary);
  expect(analysis.references.map(gap => gap.width)).toEqual([2, 26, 26]);
  expect(analysis.medianReference).toBe(26); expect(analysis.eligible).toBe(false);
  expect(mergeSpacingSource(source, primary, independent, analysis).data).toBe(primary);
});

it('quantizes a fractional reference median to whole source columns before applying its one-column tolerance', () => {
  const { source, primary, independent } = fixture([3, 7, 11]);
  wordsOf(primary)[3].text = 'E'; wordsOf(independent)[4].text = 'E';
  const analysis = analyzeSpacingSource(source, primary);
  expect(analysis.references.map(gap => gap.width)).toEqual([25, 26]);
  expect(analysis.medianReference).toBe(25.5); expect(analysis.words[0].gaps.map(gap => gap.width)).toEqual([24]);
  expect(wordsOf(mergeSpacingSource(source, primary, independent, analysis).data).map(value => value.text)).toEqual(['AA', 'BB', 'CC', 'DD', 'E']);
  wordsOf(independent)[1].confidence = 84.999;
  expect(mergeSpacingSource(source, primary, independent, analysis).data).toBe(primary);
});

it('rejects gaps more than one whole column below even the lower raster median', () => {
  const { source, primary, independent } = fixture([4, 9, 14]);
  wordsOf(primary)[3].text = 'E'; wordsOf(independent)[4].text = 'E';
  const analysis = analyzeSpacingSource(source, primary);
  expect(analysis.references.map(gap => gap.width)).toEqual([26, 27]);
  expect(analysis.medianReference).toBe(26.5); expect(analysis.eligible).toBe(false);
  expect(mergeSpacingSource(source, primary, independent, analysis).data).toBe(primary);
});

it.each([
  [[14, 17, 16, 17], 15, 16.5, true],
  [[14, 17, 16, 17], 14, 16.5, false],
  [[16, 16, 16], 14, 16, false],
  [[2, 26, 26], 24, 26, false],
])('keeps whole-column source evidence bounded for references=%j, internal=%s', (references, internal, median, eligible) => {
  const { source, primary, independent } = rasterReferenceFixture(references, internal), saved = JSON.stringify(primary);
  const analysis = analyzeSpacingSource(source, primary);
  expect(analysis.references.map(gap => gap.width)).toEqual(references);
  expect(analysis.medianReference).toBe(median); expect(analysis.eligible).toBe(eligible);
  const result = mergeSpacingSource(source, primary, independent, analysis);
  expect(result.changes).toHaveLength(eligible ? 1 : 0); expect(JSON.stringify(primary)).toBe(saved);
  if (!eligible) expect(result.data).toBe(primary);
});

it.each([['5litres', '5', 'litres'], ['redstone-blue', 'red', 'stone-blue'], ['supply(usually', 'supply', '(usually']])('splits literal prose %s only at a source gap supported by the independent read', (text, first, second) => {
  const { source, primary, independent } = fixture();
  wordsOf(primary)[0].text = text; wordsOf(independent)[0].text = first; wordsOf(independent)[1].text = second;
  const before = JSON.stringify(primary);
  expect(wordsOf(mergeSpacingSource(source, primary, independent).data).map(value => value.text)).toEqual([first, second, 'CC', 'DD', 'EE']);
  expect(JSON.stringify(primary)).toBe(before);
  wordsOf(independent)[1].confidence = 84.999;
  expect(mergeSpacingSource(source, primary, independent).data).toBe(primary);
});

it('counts measured boundaries beside numeric, hyphenated and parenthesized prose as references', () => {
  const { source, primary } = fixture();
  wordsOf(primary)[1].text = '5'; wordsOf(primary)[2].text = 'water-bearing'; wordsOf(primary)[3].text = 'supply(usually';
  const analysis = analyzeSpacingSource(source, primary);
  expect(analysis.eligible).toBe(true); expect(analysis.references).toHaveLength(3);
});

it('refuses corroborated splits at gaps narrower than every measured word space or through hyphen ink', () => {
  const { source, primary, independent } = fixture([4, 8, 12]);
  expect(analyzeSpacingSource(source, primary).eligible).toBe(false);
  expect(mergeSpacingSource(source, primary, independent).data).toBe(primary);
  const hyphen = fixture(); wordsOf(hyphen.primary)[0].text = 'AA-BB'; wordsOf(hyphen.independent)[0].text = 'AA-';
  for (let x = 30; x < 54; x++) {
    const pixel = (25 * hyphen.source.width + x) * 4; hyphen.source.data[pixel] = hyphen.source.data[pixel + 1] = hyphen.source.data[pixel + 2] = 20;
  }
  expect(mergeSpacingSource(hyphen.source, hyphen.primary, hyphen.independent).data).toBe(hyphen.primary);
});

it.each(['letters', 'case', 'confidence', 'overlap', 'missing'])('retains original words when independent %s do not support a literal split', reason => {
  const { source, primary, independent } = fixture();
  if (reason === 'letters') wordsOf(independent)[0].text = 'AX';
  if (reason === 'case') wordsOf(independent)[0].text = 'aa';
  if (reason === 'confidence') wordsOf(independent)[0].confidence = 84.999;
  if (reason === 'overlap') wordsOf(independent)[0].bbox.x1 = 60;
  if (reason === 'missing') independent.blocks = [];
  expect(mergeSpacingSource(source, primary, independent).data).toBe(primary);
});

it.each(['AA_BB', 'AA/BB', 'AaBb', 'AABB2', 'ÅABB', '5GHz', 'B2B', '1e5', 'v2.0', '2026-10-19', 'https://example.org', '5L/min', 'C:\\Temp', 'x=5'])('abstains on technical, mixed-case or non-ASCII input %s', text => {
  const { source, primary } = fixture(); wordsOf(primary)[0].text = text;
  expect(analyzeSpacingSource(source, primary).eligible).toBe(false);
});

it('requires at least two same-line word-space references and real bounded source pixels', () => {
  const { source, primary } = fixture();
  for (const count of [1, 2]) expect(analyzeSpacingSource(source, data(wordsOf(primary).slice(0, count))).eligible).toBe(false);
  for (const invalid of [{ ...source, width: NaN }, { ...source, width: 1048577 }, { ...source, data: [] }]) expect(analyzeSpacingSource(invalid, primary).eligible).toBe(false);
  const invalid = data([{ ...wordsOf(primary)[0], bbox: { x0: -1, y0: 12, x1: 74, y1: 38 } }, ...wordsOf(primary).slice(1)]);
  expect(analyzeSpacingSource(source, invalid).eligible).toBe(false);
});

it('refuses duplicated or overlapping source owners and independent tokens spanning multiple owners', () => {
  const { source, primary, independent } = fixture(), analysis = analyzeSpacingSource(source, primary);
  const duplicate = data([wordsOf(primary)[0], { ...wordsOf(primary)[0] }, ...wordsOf(primary).slice(1)]);
  expect(analyzeSpacingSource(source, duplicate).eligible).toBe(false);
  expect(mergeSpacingSource(source, duplicate, independent, analysis).data).toBe(duplicate);
  const spanning = data([word('AA', 10, 150), word('BB', 53, 200), ...wordsOf(primary).slice(1)]);
  expect(mergeSpacingSource(source, primary, spanning, analysis).data).toBe(primary);
});

it('handles a consistent inverted source and refuses mixed source polarity', () => {
  const { source, primary, independent } = fixture();
  for (let i = 0; i < source.data.length; i += 4) for (let c = 0; c < 3; c++) source.data[i + c] = 255 - source.data[i + c];
  expect(mergeSpacingSource(source, primary, independent).changes).toHaveLength(1);
  for (let y = 12; y < 38; y++) for (let x = 10; x < 74; x++) {
    const p = (y * source.width + x) * 4; for (let c = 0; c < 3; c++) source.data[p + c] = 255 - source.data[p + c];
  }
  expect(analyzeSpacingSource(source, primary).eligible).toBe(false);
});

it('does not spend attempts during spacing admission and keeps all four late legacy calls', async () => {
  const { canvas, primary, independent } = fixture(), slash = data([word('mode/s', 10, 74)]), checked = data([word('models', 10, 74)]);
  const recognize = vi.fn(async () => checked), verify = boundedPdfOcrVerifier(recognize);
  for (let i = 0; i < 8; i++) expect(verify.spacingCandidate(canvas, primary)).toBe(true);
  expect(await verify(canvas, primary)).toBe(primary); expect(recognize).not.toHaveBeenCalled();
  for (let i = 0; i < 4; i++) expect(wordsOf(await verify(canvas, slash))[0].text).toBe('models');
  expect(await verify.verifySpacing(canvas, primary)).toBe(primary); expect(recognize).toHaveBeenCalledTimes(4); expect(verify.spacingRemaining()).toBe(false);
  const fresh = boundedPdfOcrVerifier(async value => { expect(value).toBe(canvas); return independent; });
  expect(wordsOf(await fresh.verifySpacing(canvas, primary)).map(w => w.text)).toEqual(['AA', 'BB', 'CC', 'DD', 'EE']);
});

it('retains primary data after cancellation or a failed independent read and bounds all further work', async () => {
  const { canvas, primary, independent } = fixture(); let cancelled = false;
  const late = boundedPdfOcrVerifier(async () => { cancelled = true; return independent; }, () => cancelled);
  expect(await late.verifySpacing(canvas, primary)).toBe(primary); expect(late.spacingCandidate(canvas, primary)).toBe(false);
  const error = new Error('Independent data unavailable'), onError = vi.fn(), recognize = vi.fn(async () => { throw error; });
  const failed = boundedPdfOcrVerifier(recognize, () => false, onError);
  expect(await failed.verifySpacing(canvas, primary)).toBe(primary); expect(await failed.verifySpacing(canvas, primary)).toBe(primary);
  expect(recognize).toHaveBeenCalledTimes(1); expect(onError).toHaveBeenCalledExactlyOnceWith(error);
  expect(failed.spacingRemaining()).toBe(false);
});

it('refuses oversized or dense sources before reading their canvas or calling a model', async () => {
  const { primary } = fixture(), recognize = vi.fn(), verify = boundedPdfOcrVerifier(recognize);
  const oversized = { width: 1048577, height: 50, getContext() { throw Error('must not read'); } };
  expect(verify.spacingCandidate(oversized, primary)).toBe(false);
  expect(await verify.verifySpacing(oversized, primary)).toBe(primary);
  const tiny = { width: 20, height: 50, getContext() { throw Error('must not read'); } };
  expect(verify.spacingCandidate(tiny, primary)).toBe(false);
  const dense = data(Array.from({ length: 513 }, () => word('AABB', 10, 74)));
  const denseSource = { width: 240, height: 50, getContext() { throw Error('must not read'); } };
  expect(verify.spacingCandidate(denseSource, dense)).toBe(false);
  expect(await verify.verifySpacing(denseSource, dense)).toBe(dense);
  expect(recognize).not.toHaveBeenCalled();
});


const withSymbols = (word, weakIndex = -1) => {
  word.symbols = [...word.text].map((text, index) => ({ text, confidence: index === weakIndex ? 80 : 99 }));
  word.confidence = word.symbols.reduce((sum, symbol) => sum + symbol.confidence, 0) / word.symbols.length;
  return word;
};

it('drops whole-word symbol evidence on both source-gap partitions without changing their existing confidence or bounds', () => {
  const { source, primary, independent } = fixture(), target = withSymbols(wordsOf(primary)[0], 1), before = JSON.stringify(primary);
  const result = wordsOf(mergeSpacingSource(source, primary, independent).data);
  expect(result.map(word => word.text)).toEqual(['AA', 'BB', 'CC', 'DD', 'EE']);
  expect(result.slice(0, 2).map(word => word.symbols)).toEqual([undefined, undefined]);
  expect(result.slice(0, 2).map(word => word.confidence)).toEqual([target.confidence, target.confidence]);
  expect(result.slice(0, 2).map(word => word.bbox)).toEqual([{ x0: 10, x1: 30, y0: 12, y1: 38 }, { x0: 54, x1: 74, y0: 12, y1: 38 }]);
  expect(result[2]).toBe(wordsOf(primary)[1]); expect(JSON.stringify(primary)).toBe(before);
});

it.each([false, true])('shares one bounded read for spacing and abstains on letters when word counts differ (native letter disagreement=%s)', async correctOther => {
  const { canvas, primary, independent } = fixture();
  withSymbols(wordsOf(primary)[0], 1);
  if (correctOther) {
    withSymbols(wordsOf(primary)[1], 1);
    wordsOf(independent)[2] = withSymbols({ ...wordsOf(independent)[2], text: 'CD' });
  }
  const before = JSON.stringify(primary), recognize = vi.fn(async () => independent), verify = boundedPdfOcrVerifier(recognize);
  expect(verify.spacingCandidate(canvas, primary)).toBe(true); expect(verify.uncertainCandidate(canvas, primary)).toBe(true);
  expect(recognize).not.toHaveBeenCalled();
  const result = await verify.verifyUncertain(canvas, primary, sourceProjection), words = wordsOf(result);
  expect(recognize).toHaveBeenCalledExactlyOnceWith(canvas);
  expect(words.map(word => word.text)).toEqual(['AA', 'BB', 'CC', 'DD', 'EE']);
  expect(words[2]).toBe(wordsOf(primary)[1]);
  expect(words.slice(0, 2).map(word => word.symbols)).toEqual([undefined, undefined]);
  expect(words.slice(0, 2).map(word => [word.bbox.x0, word.bbox.x1])).toEqual([[10, 30], [54, 74]]);
  expect(words[2].bbox).toBe(wordsOf(primary)[1].bbox); expect(words[3]).toBe(wordsOf(primary)[2]); expect(words[4]).toBe(wordsOf(primary)[3]);
  expect(result.blocks[0].paragraphs[0].lines[0].baseline).toBe(primary.blocks[0].paragraphs[0].lines[0].baseline);
  expect(JSON.stringify(primary)).toBe(before);
  // Three remaining reads prove that the overlap consumed only one shared attempt.
  for (let count = 0; count < 5; count++) await verify.verifyUncertain(canvas, primary, sourceProjection);
  expect(recognize).toHaveBeenCalledTimes(4); expect(verify.spacingRemaining()).toBe(false);
});

it('contains a source-pixel preflight failure before recognizing and stops further reads', async () => {
  const { primary, independent } = fixture(); withSymbols(wordsOf(primary)[0], 1);
  const failure = new Error('source pixels unavailable'), onError = vi.fn(), recognize = vi.fn(async () => independent);
  const source = { width: 240, height: 50, getContext() { throw failure; } }, verify = boundedPdfOcrVerifier(recognize, () => false, onError);
  expect(await verify.verifyUncertain(source, primary, sourceProjection)).toBe(primary); expect(await verify.verifyUncertain(source, primary, sourceProjection)).toBe(primary);
  expect(recognize).not.toHaveBeenCalled(); expect(onError).toHaveBeenCalledExactlyOnceWith(failure); expect(verify.spacingRemaining()).toBe(false);
});

it.each(['boundary', 'missing-context'])('keeps source-gap spacing in the same read when %s prevents a separate letter edit', async reason => {
  const { canvas, primary, independent } = fixture();
  withSymbols(wordsOf(primary)[0], 1); withSymbols(wordsOf(primary)[1], 1);
  wordsOf(independent)[2] = { ...wordsOf(independent)[2], text: 'CD' };
  const projection = reason === 'boundary' ? { ...sourceProjection, top: -2 } : undefined;
  const before = JSON.stringify(primary), recognize = vi.fn(async () => independent), verify = boundedPdfOcrVerifier(recognize);
  expect(verify.uncertainCandidate(canvas, primary)).toBe(true);
  const result = await verify.verifyUncertain(canvas, primary, projection);
  expect(wordsOf(result).map(value => value.text)).toEqual(['AA', 'BB', 'CC', 'DD', 'EE']);
  expect(wordsOf(result)[2]).toBe(wordsOf(primary)[1]);
  expect(wordsOf(result)[2].symbols).toBe(wordsOf(primary)[1].symbols);
  expect(recognize).toHaveBeenCalledExactlyOnceWith(canvas); expect(JSON.stringify(primary)).toBe(before);
});
