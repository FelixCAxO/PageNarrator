import { expect, it } from 'vitest';
import { compareOmniVoiceRuntimeSamples, compareOmniVoiceComputeSamples } from '../../tooling/scripts/lib/omnivoice-runtime-comparison.mjs';

const samples = () => ['baseline', 'candidate'].flatMap(arm => ['en', 'sv'].map(id => ({
  arm, id, phase: 'warm', browserCpuSeconds: arm === 'baseline' ? 10 : 9,
  elapsedMs: 100, peakGpuBufferBytes: arm === 'baseline' ? 1000 : 900, replayUploadBytes: 40,
})));

it('qualifies warm CPU, latency and allocated storage together and reports each voice', () => {
  const result = compareOmniVoiceRuntimeSamples(samples());
  expect(result.accepted).toBe(true);
  expect(result.cpuReductionPercent).toBeCloseTo(10);
  expect(result.stats.baseline.warmSamples).toBe(2);
  expect(result.perVoice.en.stats.candidate.warmSamples).toBe(1);
  expect(result.perVoice.sv.cpuReductionPercent).toBeCloseTo(10);
});

it.each([
  ['browserCpuSeconds', 10], ['browserCpuSeconds', 11],
  ['elapsedMs', 105.01], ['peakGpuBufferBytes', 1000], ['peakGpuBufferBytes', 1100],
])('rejects a failed %s gate at %s even if the other metrics improve', (key, value) => {
  const rows = samples();
  for (const row of rows.filter(row => row.arm === 'candidate')) row[key] = value;
  expect(compareOmniVoiceRuntimeSamples(rows).accepted).toBe(false);
});

it('allows exactly 5% latency regression and excludes cold CPU/latency from warm scoring', () => {
  const rows = samples();
  for (const row of rows.filter(row => row.arm === 'candidate')) row.elapsedMs = 105;
  rows.push({ ...rows[0], phase: 'shape-cold', browserCpuSeconds: 10000, elapsedMs: 10000 });
  expect(compareOmniVoiceRuntimeSamples(rows).accepted).toBe(true);
  expect(compareOmniVoiceRuntimeSamples(rows).stats.baseline.pooledCpuSeconds).toBe(20);
});

it('includes shape-cold GPU peaks in the resource gate', () => {
  const rows = samples();
  rows.push({ ...rows[2], phase: 'shape-cold', peakGpuBufferBytes: 1001 });
  expect(compareOmniVoiceRuntimeSamples(rows).accepted).toBe(false);
});

it('never promotes an A/A control to an accepted optimization', () => {
  expect(compareOmniVoiceRuntimeSamples(samples(), { control: true }).accepted).toBe(false);
});

it.each([[], samples().slice(0, 3), samples().filter(row => row.arm === 'baseline')].map(rows => [rows]))(
  'refuses incomplete or unbalanced warm observations', rows => {
    expect(() => compareOmniVoiceRuntimeSamples(rows)).toThrow(/warm samples/);
  },
);

it.each([NaN, Infinity, -1, 0])('refuses invalid CPU evidence %s', value => {
  const rows = samples(); rows[0].browserCpuSeconds = value;
  expect(() => compareOmniVoiceRuntimeSamples(rows)).toThrow(/metrics/);
});

const computeSamples = () => samples().map(row => row.arm === 'candidate'
  ? { ...row, elapsedMs: 94, browserCpuSeconds: 10.49, peakGpuBufferBytes: 1000 } : row);

it('qualifies compute latency with equal allocated storage and bounded CPU cost', () => {
  const result = compareOmniVoiceComputeSamples(computeSamples());
  expect(result.accepted).toBe(true);
  expect(result.perVoice.en.faster).toBe(true);
  expect(result.perVoice.sv.faster).toBe(true);
});

it.each([
  ['elapsedMs', 95, true], ['elapsedMs', 95.001, false],
  ['browserCpuSeconds', 10.5, true], ['browserCpuSeconds', 10.501, false],
  ['peakGpuBufferBytes', 1000, true], ['peakGpuBufferBytes', 1001, false],
])('enforces the compute %s boundary at %s', (key, value, accepted) => {
  const rows = computeSamples();
  for (const row of rows.filter(row => row.arm === 'candidate')) row[key] = value;
  expect(compareOmniVoiceComputeSamples(rows).accepted).toBe(accepted);
});

it('requires each voice to become faster even when the pooled median passes', () => {
  const rows = computeSamples(); rows[2].elapsedMs = 100; rows[3].elapsedMs = 80;
  expect(compareOmniVoiceComputeSamples(rows).accepted).toBe(false);
});

it('never accepts a compute A/A control as an optimization', () => {
  expect(compareOmniVoiceComputeSamples(computeSamples(), { control: true }).accepted).toBe(false);
});
