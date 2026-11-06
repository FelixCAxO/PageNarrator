import { describe, expect, it } from 'vitest';
import { resolveSustainedPlaybackConfig, scoreSustainedPlayback, summarizeSustainedMemory } from '../../tooling/scripts/weak-hardware/sustained-playback.mjs';
import { createFlowRecorder, getFlowLog } from '../../src/lib/flow-recorder.js';

describe('sustained playback configuration', () => {
  it('keeps development runs exploratory and supports the sixty-minute contract', () => {
    expect(resolveSustainedPlaybackConfig()).toMatchObject({ minutes: 5, durationScope: 'exploratory', paragraphs: 60 });
    expect(resolveSustainedPlaybackConfig({ PN_SUSTAINED_MINUTES: '60' })).toMatchObject({
      minutes: 60, durationScope: 'sixty-minute', paragraphs: 720, timeoutMs: 65 * 60_000,
    });
  });
  it.each(['0', '-1', '1.5', '61', 'Infinity', 'NaN', '60 minutes'])('rejects invalid duration %s before launch', value => {
    expect(() => resolveSustainedPlaybackConfig({ PN_SUSTAINED_MINUTES: value })).toThrow('1 to 60');
  });
  it.each(['1', '9', 'Infinity', 'invalid'])('retains the two-to-eight GiB memory ceiling (%s)', value => {
    expect(() => resolveSustainedPlaybackConfig({ PN_SUSTAINED_COMMIT_GIB: value })).toThrow('2 to 8');
  });
});

const event = (kind, chunkIndex, t, speechText = `section ${chunkIndex}`) => ({ kind, chunkIndex, t, speechText });
function validLog() {
  return [event('chunk_play', 0, 0), event('chunk_end', 0, 30),
    event('audio_preload_decode_latency', 1, 29), event('chunk_play', 1, 30.05), event('chunk_end', 1, 60)];
}
const score = log => scoreSustainedPlayback(log, { minutes: 1 });
describe('sustained playback evidence', () => {
  it('requires ordered starts/ends, matching text and decoded transitions across the requested duration', () => {
    expect(score(validLog())).toMatchObject({ passed: true, reasons: [], completedSections: 2,
      gaps: [{ chunkIndex: 1, ready: true }] });
  });
  it('cannot pass an empty transition set', () => {
    expect(score([event('chunk_play', 0, 0), event('chunk_end', 0, 60)]).passed).toBe(false);
  });
  it.each([
    log => log.slice(1),
    log => log.map(row => ({ ...row, chunkIndex: row.chunkIndex + 1 })),
    log => [...log.slice(0, 2), event('chunk_play', 0, 31), ...log.slice(2)],
    log => log.map(row => row.kind === 'chunk_end' && row.chunkIndex === 1 ? { ...row, speechText: 'other document' } : row),
    log => log.filter(row => row.kind !== 'audio_preload_decode_latency'),
    log => log.map(row => row.kind === 'chunk_play' && row.chunkIndex === 1 ? { ...row, t: 31 } : row),
    log => log.map(row => row.kind === 'chunk_end' && row.chunkIndex === 1 ? { ...row, t: 39 } : row),
    log => [...log, { kind: 'synthesis_failed', t: 60 }],
    log => [...log, { kind: 'browser_voice_fallback', t: 60 }],
  ])('rejects missing, duplicated, stale, unready, slow or failed playback', change => {
    expect(score(change(validLog())).passed).toBe(false);
  });
  it('allows only the final section to remain in flight at the sample boundary', () => {
    expect(score([...validLog(), event('chunk_play', 2, 60.05), event('audio_preload_decode_latency', 2, 59)]).passed).toBe(true);
  });
  it('does not qualify an unfinished sixty-minute window using an arbitrary final-section allowance', () => {
    expect(scoreSustainedPlayback(validLog().map(row => row.kind === 'chunk_end' && row.chunkIndex === 1
      ? { ...row, t: 3599 } : row), { minutes: 60 }).passed).toBe(false);
  });
  it('qualifies a long final section once it completes after the hour boundary', () => {
    const log = [event('chunk_play', 0, 0), event('chunk_end', 0, 1770),
      event('audio_preload_decode_latency', 1, 1769), event('chunk_play', 1, 1770.05), event('chunk_end', 1, 3540),
      event('audio_preload_decode_latency', 2, 3539), event('chunk_play', 2, 3540.05)];
    expect(scoreSustainedPlayback(log, { minutes: 60 }).passed).toBe(false);
    expect(scoreSustainedPlayback([...log, event('chunk_end', 2, 3610)], { minutes: 60 })).toMatchObject({
      passed: true, completedSeconds: 3610,
    });
  });
  it('retains initial source and transition evidence through an hour of production flow recording', () => {
    const target = {};
    let now = 0;
    const recorder = createFlowRecorder({ enabled: true, target, now: () => now });
    for (let section = 0; section < 360; section++) {
      now = section * 10;
      if (section) recorder.record(event('audio_preload_decode_latency', section, now - 1));
      recorder.record(event('chunk_play', section, now));
      for (let word = 0; word < 60; word++) recorder.record({ kind: 'word', chunkIndex: section, wordIndex: word });
      recorder.record(event('chunk_end', section, now + 9.95));
    }
    const log = getFlowLog(target);
    expect(log[0]).toMatchObject({ kind: 'chunk_play', chunkIndex: 0 });
    expect(log.length).toBeGreaterThan(22_000);
    expect(scoreSustainedPlayback([...log, event('audio_preload_decode_latency', 360, 3599),
      event('chunk_play', 360, 3600), event('chunk_end', 360, 3610)], { minutes: 60 }).passed).toBe(true);
  });
});

describe('sustained memory diagnostics', () => {
  it('reports warmed memory drift from complete process accounting, keeping missing data null', () => {
    const sample = (at, bytes) => ({ at, browserProcesses: [{ privateBytes: String(bytes) }] });
    const result = summarizeSustainedMemory([sample(0, 1), sample(300_000, 100), sample(360_000, 120)], 0);
    expect(result).toMatchObject({ warmupMs: 300_000, samples: 2, firstPrivateBytes: 100, lastPrivateBytes: 120, deltaPrivateBytes: 20 });
    expect(summarizeSustainedMemory([{ at: 300_000, browserProcesses: [{}] }], 0).deltaPrivateBytes).toBeNull();
    expect(summarizeSustainedMemory([{ at: 300_000, browserProcesses: [{ privateBytes: null }] }], 0).firstPrivateBytes).toBeNull();
  });
});
