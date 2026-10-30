import { expect, it, vi } from 'vitest';
import { createReadLoopOrchestrator } from '../../src/lib/reader-engine-read-loop.js';
import { createRunTracker } from './reader-engine-read-loop.fixtures.js';

it.each([
  ['slow OmniVoice', 'omnivoice', 1.1, 1, true, true, false],
  ['fast OmniVoice', 'omnivoice', 0.2, 1, true, false, false],
  ['accelerated OmniVoice', 'omnivoice', 0.6, 2, true, true, false],
  ['slowed OmniVoice', 'omnivoice', 1.1, 0.5, true, false, false],
  ['Kokoro', 'kokoro', 2, 1, true, false, false],
  ['unmeasured OmniVoice', 'omnivoice', undefined, 1, true, false, false],
  ['single-chunk OmniVoice', 'omnivoice', 2, 1, false, false, false],
  ['cancelled OmniVoice', 'omnivoice', 2, 1, true, true, true],
  ['progress-ready OmniVoice', 'omnivoice', 2, 1, true, true, false, true],
  ['cancelled progress wait', 'omnivoice', 2, 1, true, true, true, true],
])('buffers only when playback would outrun synthesis: %s', async (_name, engine, realTimeFactor, speed, hasNext, buffers, abort, useProgress) => {
  const controller = new AbortController();
  const chunks = [{ type: 'paragraph', speech: 'Read the first paragraph.' },
    ...(hasNext ? [{ type: 'paragraph', speech: 'Continue with the second paragraph.' }] : [])];
  const current = { kind: 'chunk', result: { durationSeconds: 3, synthesisMetrics: { realTimeFactor } } };
  let releaseNext;
  const next = new Promise(resolve => { releaseNext = () => resolve({ result: current }); });
  let releaseLead;
  const lead = new Promise(resolve => { releaseLead = resolve; });
  if (useProgress) next.waitForPlaybackLead = vi.fn(() => lead);
  const play = vi.fn(async () => {});
  const record = vi.fn();
  const orchestrator = createReadLoopOrchestrator({
    state: {},
    readRunTracker: { ...createRunTracker(), getRunSignal: () => controller.signal,
      isCurrentRun: () => !controller.signal.aborted },
    extractActiveTab: async () => ({ tabId: 2, source: 'selection', text: chunks.map(chunk => chunk.speech).join(' '), chunks }),
    resolveSelectedVoice: () => ({ id: engine, engine, lang: 'en', detectCode: 'en' }),
    getActiveTtsProfileConfig: () => ({ maxChunkLength: 320, targetMinLength: 180, preloadAhead: 1 }),
    getPlaybackSpeed: () => speed,
    ensureSpeechPreloadWindow({ speechPreloads, currentIndex }) {
      if (!speechPreloads.has(0)) speechPreloads.set(0, Promise.resolve({ result: current }));
      if (hasNext && !speechPreloads.has(1)) speechPreloads.set(1, next);
      return speechPreloads.get(currentIndex);
    },
    readPreloadedSpeech: async preload => (await preload).result,
    playKokoroSpeech: play,
    flowRecorder: { record },
  });
  const reading = orchestrator.readPage({ readSelection: true });
  try {
    if (buffers) {
      await vi.waitFor(() => expect(record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'startup_audio_buffer_wait' })));
      expect(play).not.toHaveBeenCalled();
      if (abort) {
        controller.abort();
        await reading;
        expect(play).not.toHaveBeenCalled();
      } else if (useProgress) {
        expect(next.waitForPlaybackLead).not.toHaveBeenCalled();
        releaseLead();
        await Promise.resolve();
        expect(play).not.toHaveBeenCalled();
        releaseNext();
        await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(chunks.length));
      }
    } else {
      await vi.waitFor(() => expect(play).toHaveBeenCalled());
      expect(record.mock.calls.some(([event]) => event.kind === 'startup_audio_buffer_wait')).toBe(false);
    }
  } finally {
    releaseNext();
    await reading;
  }
  expect(play).toHaveBeenCalledTimes(abort ? 0 : chunks.length);
});

it.each([[5, false], [5, true], [2, false]])('builds a bounded startup reserve for %i chunks, abort=%s', async (count, abort) => {
  vi.useFakeTimers();
  const run = new AbortController(), releases = [];
  const chunks = Array.from({ length: count }, (_, index) => ({ type: 'paragraph', speech: `Read paragraph ${index}.` }));
  const speech = { kind: 'chunk', result: { durationSeconds: 3, synthesisMetrics: { realTimeFactor: 1.2 } } };
  const preloads = chunks.map((_, index) => index === 0 ? Promise.resolve({ result: speech })
    : new Promise(resolve => { releases.push(() => resolve({ result: speech })); }));
  const play = vi.fn(async () => {});
  const orchestrator = createReadLoopOrchestrator({
    state: {}, readRunTracker: { ...createRunTracker(), getRunSignal: () => run.signal, isCurrentRun: () => !run.signal.aborted },
    extractActiveTab: async () => ({ tabId: 2, source: 'selection', text: chunks.map(chunk => chunk.speech).join(' '), chunks }),
    resolveSelectedVoice: () => ({ id: 'omnivoice', engine: 'omnivoice', detectCode: 'en' }),
    getActiveTtsProfileConfig: () => ({ maxChunkLength: 320, targetMinLength: 180, preloadAhead: 4 }),
    ensureSpeechPreloadWindow({ speechPreloads, currentIndex }) {
      preloads.forEach((preload, index) => speechPreloads.set(index, preload));
      return speechPreloads.get(currentIndex);
    },
    readPreloadedSpeech: async preload => (await preload).result,
    playKokoroSpeech: play,
  });
  const reading = orchestrator.readPage({ readSelection: true });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(play).not.toHaveBeenCalled();
    const reserve = Math.min(3, count - 1);
    for (let index = 0; index < reserve - 1; index++) {
      releases[index]();
      await vi.advanceTimersByTimeAsync(0);
      expect(play).not.toHaveBeenCalled();
    }
    if (abort) run.abort();
    else releases[reserve - 1]();
    await vi.advanceTimersByTimeAsync(0);
    if (abort) expect(play).not.toHaveBeenCalled();
    else expect(play).toHaveBeenCalled();
  } finally {
    releases.forEach(release => release());
    await reading;
    vi.useRealTimers();
  }
  expect(play).toHaveBeenCalledTimes(abort ? 0 : count);
});
