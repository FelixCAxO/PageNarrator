import { expect, it } from 'vitest';
import { decodePdfOcrCtcBeam, OCR_CTC_BEAM_POLICY } from '../../src/lib/pdf-ocr-ctc-beam.js';

function collapse(labels, alphabet) {
  return labels.filter((label, index) => label && (!index || label !== labels[index - 1])).map(label => alphabet[label]).join('');
}
function exhaustive(data, steps, alphabet) {
  const outputs = new Map();
  function visit(path, probability) {
    if (path.length === steps) {
      const text = collapse(path, alphabet); outputs.set(text, (outputs.get(text) || 0) + probability); return;
    }
    for (let label = 0; label < alphabet.length; label++) visit([...path, label], probability * data[path.length * alphabet.length + label]);
  }
  visit([], 1); return outputs;
}
it('freezes the mathematical decoder policy without a dictionary or word prior', () => {
  expect(OCR_CTC_BEAM_POLICY).toEqual({ beamWidth: 16, topClasses: 8 }); expect(Object.isFrozen(OCR_CTC_BEAM_POLICY)).toBe(true);
});
it.each([[['', 'a', 'b']], [['', 'a', 'a', 'b']]])('matches every exhaustive small CTC string probability with alphabet %j', alphabet => {
  const steps = 5, data = new Float64Array(steps * alphabet.length);
  for (let frame = 0; frame < steps; frame++) {
    let sum = 0;
    for (let label = 0; label < alphabet.length; label++) sum += data[frame * alphabet.length + label] = 1 + (frame * 7 + label * 11) % 13;
    for (let label = 0; label < alphabet.length; label++) data[frame * alphabet.length + label] /= sum;
  }
  const expected = exhaustive(data, steps, alphabet), actual = decodePdfOcrCtcBeam(data, steps, alphabet, { beamWidth: 128, topClasses: 8 });
  expect(actual.alternatives.length).toBe(expected.size);
  for (const candidate of actual.alternatives) expect(Math.exp(candidate.logProbability)).toBeCloseTo(expected.get(candidate.text), 13);
  expect(collapse([...actual.labels], alphabet)).toBe(actual.text);
  expect(actual.bestPathLogProbability).toBeLessThanOrEqual(actual.logProbability + 1e-12);
});
it('marginalizes blank-separated paths rather than choosing one greedy frame path', () => {
  const data = Float64Array.of(.4, .35, .25, .4, .35, .25);
  const result = decodePdfOcrCtcBeam(data, 2, ['', 'a', 'b']);
  expect(result.text).toBe('a'); // Greedy frames are both blank; the three a paths sum to .4025.
  expect(Math.exp(result.logProbability)).toBeCloseTo(.4025, 12);
  expect(collapse([...result.labels], ['', 'a', 'b'])).toBe('a');
});
it('keeps class repetition distinct when different classes spell the same glyph', () => {
  const result = decodePdfOcrCtcBeam(Float64Array.of(0, 1, 0, 0, 0, 1), 2, ['', 'a', 'a']);
  expect(result.text).toBe('aa'); expect([...result.labels]).toEqual([1, 2]);
});
it('matches exhaustive enumeration when fixed top-class pruning removes paths', () => {
  const data = Float64Array.of(.2, .5, .3, .4, .25, .35, .1, .3, .6);
  const pruned = data.slice(); pruned[2] = pruned[4] = pruned[7] = 0;
  const expected = new Map([...exhaustive(pruned, 3, ['', 'a', 'b'])].filter(([, probability]) => probability));
  const result = decodePdfOcrCtcBeam(data, 3, ['', 'a', 'b'], { topClasses: 1, beamWidth: 128 });
  expect(result.alternatives.length).toBe(expected.size);
  for (const item of result.alternatives) expect(Math.exp(item.logProbability)).toBeCloseTo(expected.get(item.text), 13);
});
it('keeps long blank runs stable in log space and aligns the empty winner', () => {
  const data = Float64Array.from({ length: 1024 }, (_, index) => index % 2 ? .01 : .99);
  const result = decodePdfOcrCtcBeam(data, 512, ['', 'x']);
  expect(Number.isFinite(result.logProbability)).toBe(true);
  expect(collapse([...result.labels], ['', 'x'])).toBe(result.text);
  const blank = decodePdfOcrCtcBeam(Float32Array.of(1, 0, 1, 0), 2, ['', 'x']);
  expect(blank.text).toBe(''); expect([...blank.labels]).toEqual([0, 0]); expect(blank.logProbability).toBe(0);
});
it('bounds policies and alignment memory and rejects invalid probability rows', () => {
  expect(() => decodePdfOcrCtcBeam(Float32Array.of(.5, .5), 1, ['', 'a'], { beamWidth: 129 })).toThrow(/bounded/);
  expect(() => decodePdfOcrCtcBeam(Float32Array.of(.5, .4), 1, ['', 'a'])).toThrow(/normalized/);
  expect(() => decodePdfOcrCtcBeam(Float32Array.of(.5, NaN), 1, ['', 'a'])).toThrow(/probability/);
  expect(() => decodePdfOcrCtcBeam(Float32Array.of(.5, .5), 1, ['', 'aa'])).toThrow(/bounded/);
  expect(() => decodePdfOcrCtcBeam(new Float32Array(34).fill(1 / 34), 1, ['', ...Array(33).fill('a')])).toThrow(/state budget/);
});
