// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
const median = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2;
};

/** Performance scoring only. Call after exact-output and cleanup validation. */
export function compareOmniVoiceRuntimeSamples(samples, { control = false } = {}) {
  const warm = samples.filter(row => row.phase === 'warm');
  const ids = [...new Set(warm.map(row => row.id))];
  if (!ids.length || ids.some(id => {
    const count = arm => warm.filter(row => row.id === id && row.arm === arm).length;
    return !count('baseline') || count('baseline') !== count('candidate');
  })) throw new Error('Expected balanced nonempty warm samples for every request.');
  for (const row of samples) {
    if (!['baseline', 'candidate'].includes(row.arm)
      || !Number.isFinite(row.browserCpuSeconds) || row.browserCpuSeconds <= 0
      || !Number.isFinite(row.elapsedMs) || row.elapsedMs <= 0
      || !Number.isSafeInteger(row.peakGpuBufferBytes) || row.peakGpuBufferBytes < 0
      || !Number.isSafeInteger(row.replayUploadBytes) || row.replayUploadBytes < 0) throw new Error('Invalid runtime metrics.');
  }
  const compare = rows => {
    const stats = Object.fromEntries(['baseline', 'candidate'].map(arm => {
      const all = rows.filter(row => row.arm === arm), measured = all.filter(row => row.phase === 'warm');
      return [arm, { warmSamples: measured.length,
        pooledCpuSeconds: measured.reduce((sum, row) => sum + row.browserCpuSeconds, 0),
        medianWallMs: median(measured.map(row => row.elapsedMs)),
        medianReplayUploadBytes: median(measured.map(row => row.replayUploadBytes)),
        peakGpuBufferBytes: Math.max(...all.map(row => row.peakGpuBufferBytes)) }];
    }));
    const cpuReductionPercent = (1 - stats.candidate.pooledCpuSeconds / stats.baseline.pooledCpuSeconds) * 100;
    const wallReductionPercent = (1 - stats.candidate.medianWallMs / stats.baseline.medianWallMs) * 100;
    return { stats, cpuReductionPercent, wallReductionPercent,
      accepted: !control && stats.candidate.pooledCpuSeconds < stats.baseline.pooledCpuSeconds
        && stats.candidate.medianWallMs <= stats.baseline.medianWallMs * 1.05
        && stats.candidate.peakGpuBufferBytes < stats.baseline.peakGpuBufferBytes };
  };
  return { ...compare(samples), perVoice: Object.fromEntries(ids.map(id => [id, compare(samples.filter(row => row.id === id))])) };
}

/** Separate compute experiment: require a 5% wall improvement, with bounded CPU/storage. */
export function compareOmniVoiceComputeSamples(samples, { control = false } = {}) {
  const result = compareOmniVoiceRuntimeSamples(samples, { control });
  const perVoice = Object.fromEntries(Object.entries(result.perVoice).map(([id, { accepted: _old, ...voice }]) =>
    [id, { ...voice, faster: voice.stats.candidate.medianWallMs < voice.stats.baseline.medianWallMs }]));
  const { baseline, candidate } = result.stats;
  return { ...result, perVoice, criterion: 'compute-v1',
    accepted: !control && candidate.medianWallMs <= baseline.medianWallMs * 0.95
      && Object.values(perVoice).every(voice => voice.faster)
      && candidate.pooledCpuSeconds <= baseline.pooledCpuSeconds * 1.05
      && candidate.peakGpuBufferBytes <= baseline.peakGpuBufferBytes };
}
