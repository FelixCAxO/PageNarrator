import { describe, expect, it } from 'vitest';
import { compareAudio, compareTranscripts, wordErrorRate, waveBytes } from '../../scripts/lib/kokoro-speech-acceptance.mjs';
const gates = { minimumRms: .001, maximumDurationRelativeDifference: .1, maximumDurationAbsoluteDifferenceSeconds: .1,
  maximumWordErrorRate: .25, maximumWordErrorRateIncrease: .05, requireExpectedFinalThreeWords: true, pcmAbsoluteTolerance: .0003, pcmRelativeTolerance: .003 };
describe('fixed speech acceptance boundaries', () => {
  it('keeps waveform failure distinct from functional finite-duration checks', () => {
    const result = compareAudio(new Float32Array(24000).fill(.1), new Float32Array(24000).fill(.2), gates);
    expect(result.finitePass && result.nonSilentPass && result.durationPass).toBe(true); expect(result.pcm.pass).toBe(false);
    expect(compareAudio(Float32Array.of(NaN), Float32Array.of(.1), gates).finitePass).toBe(false);
    expect(compareAudio(new Float32Array(24000), new Float32Array(24000), gates).nonSilentPass).toBe(false);
    expect(compareAudio(new Float32Array(48000).fill(.1), new Float32Array(24000).fill(.1), gates).durationPass).toBe(false);
  });
  it('requires final words even when a long transcript passes aggregate WER', () => {
    const text = 'The browser keeps the next sentence ready while this one plays.';
    const result = compareTranscripts({ candidate: { transcript: 'The browser keeps the next sentence ready while this' }, reference: { transcript: text } }, text, 'en-us', gates);
    expect(result.candidateWer).toBeLessThan(.25); expect(result.tailPass).toBe(false); expect(result.pass).toBe(false);
    expect(wordErrorRate(['a', 'b', 'x', 'y'], ['a', 'b', 'c'])).toBeCloseTo(2 / 3);
  });
  it('normalizes source money and ASR words consistently, and writes actual mono PCM', () => {
    const result = compareTranscripts({ candidate: { transcript: 'Doctor Smith paid twelve dollars and fifty cents on Friday.' }, reference: { transcript: 'Doctor Smith paid $12.50 on Friday.' } }, 'Doctor Smith paid $12.50 on Friday.', 'en-us', gates);
    expect(result.pass).toBe(true); const bytes = waveBytes(Float32Array.of(-1, 0, 1));
    expect(bytes.readUInt32LE(24)).toBe(24000); expect(bytes.readUInt32LE(40)).toBe(6); expect(bytes.readInt16LE(44)).toBe(-32767); expect(bytes.readInt16LE(48)).toBe(32767);
  });
});
