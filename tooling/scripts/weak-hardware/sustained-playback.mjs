// Scoring for the muted, packaged OmniVoice soak; these are harness diagnostics.
export function resolveSustainedPlaybackConfig(env = {}) {
  const minutes = Number(env.PN_SUSTAINED_MINUTES || 5);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new RangeError('Sustained duration must be an integer from 1 to 60 minutes.');
  const commitGiB = Number(env.PN_SUSTAINED_COMMIT_GIB || 6), browserCommitBytes = commitGiB * 1024 ** 3;
  if (!Number.isSafeInteger(browserCommitBytes) || commitGiB < 2 || commitGiB > 8) throw new RangeError('Browser commit ceiling must be from 2 to 8 GiB.');
  return { minutes, commitGiB, browserCommitBytes, timeoutMs: (minutes + 5) * 60_000,
    paragraphs: Math.max(60, minutes * 12), durationScope: minutes === 60 ? 'sixty-minute' : 'exploratory' };
}

export function scoreSustainedPlayback(log, { minutes, maxGapMs = 100 } = {}) {
  const starts = log.filter(row => row.kind === 'chunk_play'), ends = log.filter(row => row.kind === 'chunk_end');
  const reasons = [];
  if (log.some(row => /synthesis_failed|browser_voice_fallback/.test(row.kind))) reasons.push('Synthesis failure or browser voice fallback.');
  if (ends.length < 2 || starts.length < ends.length || starts.length > ends.length + 1) reasons.push('Missing completed sections or unmatched playback starts.');
  if (starts.some((row, index) => row.chunkIndex !== index || !Number.isFinite(row.t) || !row.speechText?.trim())) reasons.push('Skipped, duplicate or invalid playback start.');
  if (ends.some((row, index) => row.chunkIndex !== index || !Number.isFinite(row.t) || !starts[index]
    || row.t < starts[index].t || row.speechText !== starts[index].speechText)) reasons.push('Skipped, duplicate, stale or unmatched playback end.');
  const completedSeconds = ends.length && starts.length ? ends.at(-1).t - starts[0].t : 0;
  if (completedSeconds < minutes * 60) reasons.push('Completed playback does not cover the requested duration.');
  const gaps = starts.slice(1).map((start, index) => {
    const end = ends[index];
    const decoded = end && log.some(row => row.kind === 'audio_preload_decode_latency' && row.chunkIndex === start.chunkIndex && row.t <= end.t);
    return { chunkIndex: start.chunkIndex, milliseconds: end ? 1000 * (start.t - end.t) : null, ready: Boolean(decoded) };
  });
  if (!gaps.length || gaps.some(gap => !gap.ready || !Number.isFinite(gap.milliseconds) || gap.milliseconds < 0 || gap.milliseconds > maxGapMs)) {
    reasons.push('Missing, unready or out-of-budget playback transition.');
  }
  return { passed: reasons.length === 0, reasons, completedSections: ends.length, completedSeconds, gaps };
}

export function summarizeSustainedMemory(accounting, startedAtMs, warmupMs = 300_000) {
  const warmed = accounting.filter(sample => sample.at >= startedAtMs + warmupMs);
  const samples = warmed.flatMap(sample => {
    const processes = sample.browserProcesses || [];
    const bytes = processes.map(process => process.privateBytes == null ? NaN : Number(process.privateBytes));
    return bytes.length && bytes.every(value => Number.isSafeInteger(value) && value >= 0)
      ? [{ at: sample.at, bytes: bytes.reduce((sum, value) => sum + value, 0) }] : [];
  });
  const first = samples[0], last = samples.at(-1);
  return { warmupMs, samples: samples.length, unaccountedSamples: warmed.length - samples.length,
    firstPrivateBytes: first?.bytes ?? null, lastPrivateBytes: last?.bytes ?? null,
    deltaPrivateBytes: samples.length > 1 ? last.bytes - first.bytes : null,
    peakPrivateBytes: samples.length ? Math.max(...samples.map(sample => sample.bytes)) : null,
    scope: 'Browser-process private bytes after warmup; descriptive drift, not physical RAM residency or a leak verdict.' };
}
