import { expect } from "vitest";
import { estimateWordTimings } from "../../src/lib/speech-audio.js";

export function createAudio(samples = 24000, samplingRate = 24000) {
  return {
    audio: new Float32Array(samples),
    sampling_rate: samplingRate,
  };
}

export function createWindowedAudio({
  leadingSeconds = 0,
  activeSeconds = 1,
  trailingSeconds = 0,
  samplingRate = 24000,
} = {}) {
  const totalSamples = Math.round((leadingSeconds + activeSeconds + trailingSeconds) * samplingRate);
  const leadingSamples = Math.round(leadingSeconds * samplingRate);
  const activeSamples = Math.round(activeSeconds * samplingRate);
  const audio = new Float32Array(totalSamples);
  audio.fill(0.08, leadingSamples, leadingSamples + activeSamples);
  return { audio, sampling_rate: samplingRate };
}

export function getDuration(timings, index) {
  return timings[index].end - timings[index].start;
}

export function expectDutchFinalEWordBudget(timings, text, durationSeconds) {
  const generic = estimateWordTimings(text, durationSeconds);
  expect(getDuration(timings, 2)).toBeGreaterThan(getDuration(generic, 2) * 1.15);
  expect(timings.at(-1).end).toBeCloseTo(durationSeconds);
}
