import { describe, expect, it } from 'vitest';
import {
  classifyProbeOutcome,
  computeLaneVerdict,
  deriveRepeatedReadResult,
  evaluateLaneExpectations,
  evaluateLifecycleResult,
  evaluateSoakResult,
  isPassingLaneVerdict,
  statusForError,
  PAGE_BLOCKED_BOUND_MS,
  PLAYBACK_STALL_BOUND_MS,
  TAP_SAMPLING_DEGRADED_MS,
  createBusyPageWait,
  pageBlockingFailures,
  summarizeAudioTap,
  summarizeMainThread,
  summarizePageBlocking,
  summarizeModelAcquisition,
  summarizeModelCache,
  createModelCacheExpression,
  summarizeSectionReadyDeadlines,
  summarizeSectionTimeline,
  summarizeSoakSamples,
  createSoakRecorder,
  summarizeWorkerThreads,
} from '../live/tts-probe-observations.js';
import { LIFECYCLE_BOUNDS, SOAK_BOUNDS, getTtsProbeProfiles } from '../live/live-tts-hardware-profiles.js';
import { createLiveTtsProbeRunPlan, killProcessTree, runLiveTtsProbe } from '../../scripts/run-live-tts-probe.mjs';

const producedAudio = { selectedBackendPlan: { device: 'webgpu', reason: 'webgpu-available' }, firstSynthesisMs: 400, audioDurationSeconds: 2, fallbacks: [] };

describe('probe observations', () => {
  it('classifies what the user experienced, including crashes and explicit errors', () => {
    expect(classifyProbeOutcome({ tts: producedAudio })).toBe('local-model');
    expect(classifyProbeOutcome({ tts: { ...producedAudio, fallbacks: [{ type: 'model', fallbackPlan: { device: 'wasm' } }] } })).toBe('permitted-fallback');
    expect(classifyProbeOutcome({ tts: producedAudio, page: { errorNotice: { visible: true } } })).toBe('explicit-error');
    expect(classifyProbeOutcome({ crash: 'renderer' })).toBe('renderer-crashed');
    expect(classifyProbeOutcome({ crash: 'browser' })).toBe('browser-crashed');
    expect(classifyProbeOutcome({ timedOut: true })).toBe('timed-out');
    expect(classifyProbeOutcome({ tts: { selectedBackendPlan: { device: 'wasm' }, firstSynthesisMs: null } })).toBe('broken');
  });

  it('fails a lane when the observed path, display or GPU initialization count is wrong', () => {
    const [deviceRejects] = getTtsProbeProfiles('gpu_fault_device_rejects');
    const fallback = { ...producedAudio, fallbacks: [{ type: 'model', fallbackPlan: { device: 'wasm' } }] };
    const ok = { tts: fallback, execution: { observed: 'wasm' }, outcome: 'permitted-fallback', page: { displayedBackend: 'wasm', faults: { requestDeviceCalls: 1 } } };

    expect(evaluateLaneExpectations(deviceRejects, ok)).toEqual([]);
    expect(evaluateLaneExpectations(deviceRejects, { ...ok, page: { displayedBackend: 'webgpu', faults: { requestDeviceCalls: 1 } } }))
      .toEqual(['toolbar player shows webgpu while wasm executed']);
    expect(evaluateLaneExpectations(deviceRejects, { ...ok, page: { displayedBackend: 'wasm', faults: { requestDeviceCalls: 5 } } }))
      .toEqual(['requestDevice() was called 5 times (bound 2); GPU initialization is looping']);
    expect(evaluateLaneExpectations(deviceRejects, { ...ok, outcome: 'local-model', execution: { observed: 'webgpu' } }))
      .toEqual(['outcome local-model is not one of permitted-fallback', 'observed execution webgpu is not one of wasm', 'toolbar player shows wasm while webgpu executed']);
  });

  it('verifies the original Kokoro helper count for its one- and four-thread configurations', () => {
    const [parallel] = getTtsProbeProfiles('cpu_4ecore_wasm_t4');
    const [serial] = getTtsProbeProfiles('cpu_4ecore_wasm_t1');
    const kokoroCoordinatorUrl = 'chrome-extension://x/assets/worker-Kokoro123.js';
    const coordinator = { type: 'worker', title: '', url: kokoroCoordinatorUrl, pagenarratorRole: 'kokoro-coordinator' };
    const helpers = Array.from({ length: 3 }, (_, i) => ({ type: 'worker', title: `pn-kokoro-cpu-1-${i + 1}`, url: 'chrome-extension://x/assets/cpu-pool-worker-BJteotNZ.js', pagenarratorRole: 'kokoro-cpu-helper' }));
    const attempt = workers => ({ execution: { observed: 'wasm' }, outcome: 'local-model', page: { displayedBackend: 'wasm', crossOriginIsolated: true }, workers: summarizeWorkerThreads(workers) });

    expect(evaluateLaneExpectations(parallel, attempt([coordinator, ...helpers]))).toEqual([]);
    expect(evaluateLaneExpectations(serial, attempt([coordinator]))).toEqual([]);
    const [twoReported] = getTtsProbeProfiles('cpu_4ecore_wasm_t2');
    expect(evaluateLaneExpectations(twoReported, attempt([coordinator]))).toEqual([]);
    expect(evaluateLaneExpectations(parallel, attempt([coordinator]))).toEqual(['observed 0 original Kokoro CPU helper workers; 4 inference workers need 3']);
    expect(evaluateLaneExpectations(serial, attempt([coordinator, ...helpers]))).toEqual(['observed 3 original Kokoro CPU helper workers; 1 inference worker needs 0']);
    expect(evaluateLaneExpectations(serial, attempt([]))).toEqual(['observed 0 original Kokoro CPU coordinators; expected 1']);
    expect(evaluateLaneExpectations(serial, attempt([coordinator, coordinator]))).toEqual(['observed 2 original Kokoro CPU coordinators; expected 1']);
    expect(evaluateLaneExpectations(parallel, { ...attempt([coordinator, ...helpers]), page: { displayedBackend: 'wasm', crossOriginIsolated: false } }))
      .toEqual(['original Kokoro four-worker inference requires observed cross-origin isolation']);
    expect(evaluateLaneExpectations(parallel, { ...attempt([coordinator, ...helpers]), page: { displayedBackend: 'wasm' } }))
      .toEqual(['original Kokoro four-worker inference requires observed cross-origin isolation']);
  });

  it('rejects an unsupported explicit two-thread expectation', () => {
    const [lane] = getTtsProbeProfiles('cpu_4ecore_wasm_t2');
    const attempt = { execution: { observed: 'wasm' }, outcome: 'local-model', page: { displayedBackend: 'wasm' }, workers: summarizeWorkerThreads([]) };

    expect(evaluateLaneExpectations({ ...lane, expectedWasmThreads: 2 }, attempt)).toEqual(['requested 2 WASM inference threads; original Kokoro supports 1 or 4']);
  });

  it('does not turn missing worker observations into an observed serial configuration', () => {
    const [lane] = getTtsProbeProfiles('cpu_4ecore_wasm_t1');
    const attempt = workers => ({ execution: { observed: 'wasm' }, outcome: 'local-model', page: { displayedBackend: 'wasm' }, workers });

    const missing = ['original Kokoro CPU workers were not observed'];
    expect(evaluateLaneExpectations(lane, attempt())).toEqual(missing);
    expect(evaluateLaneExpectations(lane, attempt(summarizeWorkerThreads()))).toEqual(missing);
    expect(evaluateLaneExpectations(lane, attempt(summarizeWorkerThreads(null)))).toEqual(missing);
    expect(evaluateLaneExpectations(lane, attempt(summarizeWorkerThreads([])))).toEqual(['observed 0 original Kokoro CPU coordinators; expected 1']);
    expect(summarizeWorkerThreads({})).toMatchObject({ available: false, kokoroCpuHelperWorkers: null });
  });

  it('does not count retired runtime or unrelated targets as original Kokoro inference workers', () => {
    const kokoroCoordinatorUrl = 'chrome-extension://x/assets/worker-Kokoro123.js';
    const workers = summarizeWorkerThreads([
      { type: 'service_worker', title: 'Service Worker', url: 'chrome-extension://x/service-worker-loader.js' },
      { type: 'worker', title: 'em-pthread', url: 'chrome-extension://x/onnx/ort-wasm-simd-threaded.jsep.mjs' },
      { type: 'worker', title: 'Other inference', url: 'chrome-extension://x/assets/worker-Other456.js' },
      { type: 'service_worker', title: 'Lookalike', url: kokoroCoordinatorUrl, pagenarratorRole: 'kokoro-coordinator' },
    ]);
    expect(workers).toMatchObject({ available: true, totalWorkers: 4, kokoroCpuCoordinatorWorkers: 0, kokoroCpuHelperWorkers: 0 });
    const [lane] = getTtsProbeProfiles('cpu_4ecore_wasm_t1');
    expect(evaluateLaneExpectations(lane, { execution: { observed: 'wasm' }, outcome: 'local-model', page: { displayedBackend: 'wasm' }, workers }))
      .toEqual(['observed 0 original Kokoro CPU coordinators; expected 1']);
  });

  it('counts only collector-bound dedicated helper roles, never title or filename guesses', () => {
    const workerBindingSha256 = 'a'.repeat(64);
    const result = summarizeWorkerThreads([
      { type: 'worker', title: '', url: 'chrome-extension://x/assets/cpu-pool-worker-A.js', pagenarratorRole: 'kokoro-cpu-helper', workerBindingSha256 },
      { type: 'worker', title: '', url: 'chrome-extension://x/assets/cpu-pool-worker-A.js', pagenarratorRole: 'kokoro-cpu-helper' },
      { type: 'worker', title: 'pn-kokoro-cpu-12-3', url: 'chrome-extension://x/assets/cpu-pool-worker-A.js', pagenarratorRole: 'kokoro-cpu-helper' },
      { type: 'worker', title: 'coordinator', url: 'chrome-extension://x/assets/worker-EE9-I1Jn.js' },
      { type: 'worker', title: 'OCR', url: 'chrome-extension://x/assets/pdf-ocr-worker-DSZtfSyb.js' },
      { type: 'worker', title: 'lookalike', url: 'chrome-extension://x/assets/cpu-pool-worker-B.js' },
      { type: 'worker', title: 'pn-kokoro-cpu-1-1', url: 'blob:unrelated' },
      { type: 'service_worker', title: 'pn-kokoro-cpu-1-1', url: 'chrome-extension://x/assets/cpu-pool-worker-A.js', pagenarratorRole: 'kokoro-cpu-helper' },
    ]);
    expect(result).toMatchObject({ available: true, totalWorkers: 8, kokoroCpuCoordinatorWorkers: 0, kokoroCpuHelperWorkers: 3 });
    expect(result.workers[0]).toMatchObject({ url: 'cpu-pool-worker-A.js', pagenarratorRole: 'kokoro-cpu-helper', workerBindingSha256 });
  });

  it('gives memory-boundary lanes a reproducibility verdict', () => {
    const [memoryLane] = getTtsProbeProfiles('mem_1gib_webgpu');
    const crashed = (runIndex) => ({ profile: { name: 'mem_1gib_webgpu' }, runIndex, status: 'crashed', outcome: 'renderer-crashed' });

    expect(computeLaneVerdict(memoryLane, [crashed(0), crashed(1)])).toMatchObject({ verdict: 'reproducible', outcomes: { 'renderer-crashed': 2 } });
    expect(computeLaneVerdict(memoryLane, [crashed(0), { ...crashed(1), status: 'passed', outcome: 'local-model' }]).verdict).toBe('non-reproducible');
    expect(computeLaneVerdict(memoryLane, [{ ...crashed(0), status: 'invalid-environment' }]).verdict).toBe('invalid-environment');
    expect(computeLaneVerdict(memoryLane, []).verdict).toBe('missing');
    expect(isPassingLaneVerdict('reproducible')).toBe(true);
    expect(isPassingLaneVerdict('non-reproducible')).toBe(false);
  });

  it('maps harness errors to run statuses', () => {
    expect(statusForError({ name: 'ProbeTimeoutError' })).toBe('timeout');
    expect(statusForError({ name: 'ProbeCrashError' })).toBe('crashed');
    expect(statusForError({ name: 'ProbeEnvironmentBlockedError', status: 'blocked' })).toBe('blocked');
    expect(statusForError(new Error('CDP WebSocket closed.'))).toBe('crashed');
    expect(statusForError(new Error('expected 1 to be 2'))).toBe('failed');
  });

  it('separates download-cold, cache-warm and model acquisition evidence', () => {
    expect(summarizeModelCache([])).toMatchObject({ state: 'download-cold', modelFiles: [] });
    expect(summarizeModelCache([{ name: 'transformers-cache', entries: 4, modelFiles: ['onnx/model.onnx'] }])).toMatchObject({ state: 'cache-warm', entries: 4 });
    expect(summarizeModelAcquisition([])).toMatchObject({ requests: 0, durationMs: null });
    expect(summarizeModelAcquisition([
      { name: 'onnx/model.onnx', startTime: 100, responseEnd: 5100, transferSize: 0 },
      { name: 'config.json', startTime: 50, responseEnd: 80, transferSize: 0 },
    ])).toMatchObject({ requests: 2, durationMs: 5050, transferBytes: null });
  });

  it.each([undefined, null, {}])('keeps a missing or failed cache observation %s unobserved', value => {
    expect(summarizeModelCache(value)).toMatchObject({ observed: false, verifiedModelFiles: [] });
  });

  it('verifies cached graph bytes only under the pinned production URL and namespace', async () => {
    const bytes = new TextEncoder().encode('known cached model');
    const sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
    const file = { path: 'onnx/model.onnx', bytes: bytes.length, sha256 };
    const manifest = { modelId: 'test/pinned', revision: 'fixed', files: [file] };
    const url = 'https://huggingface.co/test/pinned/resolve/fixed/onnx/model.onnx';
    const observe = (cacheName, requestUrl, body = bytes) => {
      const caches = { keys: async () => [cacheName], open: async () => ({ keys: async () => [{ url: requestUrl }],
        match: async () => new Response(body) }) };
      return new Function('caches', 'crypto', `return ${createModelCacheExpression(manifest)}`)(caches, crypto);
    };
    expect(summarizeModelCache(await observe('transformers-cache', url)).verifiedModelFiles).toEqual([
      { ...file, cacheName: 'transformers-cache', url, verified: true },
    ]);
    expect(summarizeModelCache(await observe('unrelated-cache', url)).verifiedModelFiles).toEqual([]);
    expect(summarizeModelCache(await observe('transformers-cache', 'https://elsewhere.test/onnx/model.onnx')).verifiedModelFiles).toEqual([]);
    expect(summarizeModelCache(await observe('transformers-cache', url, 'corrupt')).verifiedModelFiles[0].verified).toBe(false);
  });

  it('measures actual readiness deadline misses while retaining prefetched work outside completed playback', () => {
    const sections = [
      { sectionIndex: 0, synthesisEndedAtMs: 100, audioEndAtMs: 5000 },
      { sectionIndex: 1, synthesisEndedAtMs: 4500, audioEndAtMs: 9000 },
      { sectionIndex: 2, synthesisEndedAtMs: 8500, audioEndAtMs: null },
    ];
    expect(summarizeSectionReadyDeadlines(sections)).toMatchObject({ maxSectionReadyDeadlineMissMs: 0,
      sectionReadyDeadlineCoverage: { expected: 1, measured: 1, complete: true } });
    sections[1].synthesisEndedAtMs = 5500;
    expect(summarizeSectionReadyDeadlines(sections).maxSectionReadyDeadlineMissMs).toBe(500);
    sections[0].audioEndAtMs = null;
    expect(summarizeSectionReadyDeadlines(sections)).toMatchObject({ maxSectionReadyDeadlineMissMs: null,
      sectionReadyDeadlineCoverage: { expected: 1, measured: 0, complete: false },
      sectionReadyDeadlineTransitions: [{ readyDeadlineMissMs: null }] });
    expect(summarizeSectionReadyDeadlines([]).sectionReadyDeadlineCoverage.complete).toBe(false);
  });

  it('isolates a repeated read from earlier recorder events and detects model reloads', () => {
    const events = [
      { type: 'model-load', at: 100, loadMs: 9000 },
      { type: 'section-synthesis', at: 200, sectionIndex: 0, synthesisMs: 900, audioDurationSeconds: 3, synthesisEndedAtMs: 200 },
      { type: 'section-synthesis', at: 5_100, sectionIndex: 0, synthesisMs: 300, audioDurationSeconds: 3, synthesisEndedAtMs: 5_100 },
      { type: 'section-synthesis', at: 5_400, sectionIndex: 1, synthesisMs: 250, audioDurationSeconds: 2, synthesisEndedAtMs: 5_400 },
      { type: 'section-audio-end', at: 8_200, sectionIndex: 0, audioEndAtMs: 8_200 },
      { type: 'section-audio-end', at: 10_300, sectionIndex: 1, audioEndAtMs: 10_300 },
    ];
    const audio = { segments: [{ startEpochMs: 900, endEpochMs: 1_000 }, { startEpochMs: 50_400, endEpochMs: 53_200 }, { startEpochMs: 53_300, endEpochMs: 55_300 }] };

    const warm = deriveRepeatedReadResult(events, { sinceMs: 5_000, clickEpochMs: 50_000, audio, previousPlan: { device: 'webgpu' } });

    expect(warm).toMatchObject({
      modelResidency: 'resident',
      firstSynthesisMs: 300,
      realTimeFactor: 0.1,
      selectedBackendPlan: { device: 'webgpu' },
      preTtsLatency: { firstAudibleMs: 400 },
      flow: { sectionCount: 2, maxNextSectionReadyGapMs: 300, maxInterSectionGapMs: 100, maxAudibleSilenceMs: 100 },
    });
    expect(deriveRepeatedReadResult(events, { sinceMs: 0, clickEpochMs: 0, audio }).modelResidency).toBe('reloaded');
  });

  it('judges lifecycle controls by their audible effect within predeclared bounds', () => {
    expect(evaluateLifecycleResult(null, null, LIFECYCLE_BOUNDS)).toEqual([]);
    expect(evaluateLifecycleResult({ action: 'stop' }, { stopToSilenceMs: 120, staleSpeech: false, readIdle: true }, LIFECYCLE_BOUNDS)).toEqual([]);
    expect(evaluateLifecycleResult({ action: 'stop' }, { stopToSilenceMs: 900, staleSpeech: true, readIdle: false }, LIFECYCLE_BOUNDS)).toEqual([
      'stop to silence 900 ms exceeds 500 ms',
      'speech resumed after stop',
      'the reader did not return to idle after stop',
    ]);
    expect(evaluateLifecycleResult({ action: 'pause-resume' }, { pauseToSilenceMs: null, heldSilent: true, resumeToSoundMs: 300 }, LIFECYCLE_BOUNDS))
      .toEqual(['pause to silence was not observed']);
    expect(evaluateLifecycleResult({ action: 'minimize' }, { minimized: true, sectionsEndedWhileMinimized: 0 }, LIFECYCLE_BOUNDS))
      .toEqual(['playback made no progress while minimized']);
    expect(evaluateLifecycleResult({ action: 'stop' }, null, LIFECYCLE_BOUNDS)).toEqual(['lifecycle action stop did not run']);
  });

  it('summarizes soak memory growth after warm-up and reports short soaks as incomplete', () => {
    const mib = 1048576;
    const samples = [0, 1, 2, 3, 4, 5].map((index) => ({
      atMs: index * 30_000,
      privateBytes: (index < 2 ? 900 : 1000 + (index * 4)) * mib,
      jsHeapUsedBytes: 40 * mib,
    }));
    const summary = summarizeSoakSamples(samples, { warmupSamples: 2 });

    expect(summary).toMatchObject({ steadySamples: 4, privateGrowthMiB: 12, jsHeapGrowthMiB: 0 });
    expect(summary.privateSlopeMiBPerHour).toBeCloseTo(480);
    const result = { observedMs: 600_000, maxStallMs: 5_000, ...summary };
    expect(evaluateSoakResult(SOAK_BOUNDS, result, SOAK_BOUNDS)).toEqual(['soak observed 10 min of the 60-minute target']);
    expect(evaluateSoakResult(SOAK_BOUNDS, { ...result, observedMs: SOAK_BOUNDS.targetMs, maxStallMs: 45_000, privateGrowthMiB: 300 }, SOAK_BOUNDS)).toEqual([
      'playback stalled for 45 s',
      'browser private memory grew 300 MiB after warm-up (bound 128)',
    ]);
    expect(evaluateSoakResult(null, null, SOAK_BOUNDS)).toEqual([]);
  });

  it('keeps soak samples on the record while the soak runs, so a crash part-way keeps them', () => {
    const mib = 1048576;
    const soak = createSoakRecorder({ targetMs: SOAK_BOUNDS.targetMs, configuredMs: SOAK_BOUNDS.targetMs, warmupSamples: 2, startedAt: 0 });
    const attempt = { soak: soak.record };
    // Sections end at samples 1, 2 and 3, then none for the next two (a 60 s stall).
    [1, 2, 3, 3, 3].forEach((sectionsEnded, index) => {
      soak.addSample({ privateBytes: (1000 + index) * mib, jsHeapUsedBytes: 40 * mib, sectionsEnded, readIdle: false }, (index + 1) * 30_000);
    });

    // The browser crashed here: finish() never ran, but the attempt still holds the evidence.
    expect(attempt.soak).toMatchObject({ completed: false, observedMs: 150_000, maxStallMs: 60_000, steadySamples: 3, privateGrowthMiB: 2 });
    expect(attempt.soak.samples.map((sample) => sample.atMs)).toEqual([30_000, 60_000, 90_000, 120_000, 150_000]);
    expect(evaluateSoakResult(SOAK_BOUNDS, attempt.soak, SOAK_BOUNDS)).toEqual(['soak observed 3 min of the 60-minute target', 'playback stalled for 60 s']);

    expect(soak.finish({ finishedDocument: true, now: 160_000 })).toBe(attempt.soak);
    expect(attempt.soak).toMatchObject({ completed: true, finishedDocument: true, observedMs: 160_000 });
  });

  it('reports audible timing relative to the click and flags long silences', () => {
    const summary = summarizeAudioTap({
      method: 'tap',
      sampleRate: 48_000,
      windowSamples: 1024,
      pollMs: 10,
      tappedElements: 2,
      firstNonSilentEpochMs: 11_000,
      nonSilentMs: 5_000,
      playingSilentMs: 1_500,
      longestPlayingSilenceMs: 1_200,
      segments: [{ startEpochMs: 11_000, endEpochMs: 13_000 }, { startEpochMs: 13_400, endEpochMs: 16_000 }],
      errors: [],
    }, { clickEpochMs: 1_000 });

    expect(summary).toMatchObject({ clickToFirstNonSilentMs: 10_000, resolutionMs: 21, unexpectedSilence: true, maxSilenceBetweenSegmentsMs: 400 });
    expect(summarizeAudioTap(null)).toEqual({ available: false, reason: 'audio tap not installed' });
  });

  it('marks tap timings as degraded when the page blocked its polling', () => {
    const stalled = { currentTimeSeconds: 0, readyState: 1, paused: false, ended: false, errorCode: null };
    const base = { segments: [], errors: [], mediaEvents: { waiting: 1, stalled: 0, error: 0 }, mediaState: { contextState: 'running', elements: [stalled] } };

    expect(summarizeAudioTap({ ...base, maxTickGapMs: 12 })).toMatchObject({ maxTickGapMs: 12, samplingDegraded: false });
    expect(summarizeAudioTap({ ...base, maxTickGapMs: TAP_SAMPLING_DEGRADED_MS + 1 })).toMatchObject({
      samplingDegraded: true,
      mediaEvents: { waiting: 1 },
      mediaState: { elements: [stalled] },
    });
    expect(summarizeAudioTap({ ...base }).samplingDegraded).toBeNull();
  });

  it('uses the current read signal without replacing the cumulative tap observations', () => {
    const audio = {
      firstNonSilentEpochMs: 11_000, nonSilentMs: 5_000, playingSilentMs: 1_500,
      longestPlayingSilenceMs: 1_200, maxTickGapMs: 300, errors: ['earlier observation'],
      segments: [{ startEpochMs: 11_000, endEpochMs: 13_000 }, { startEpochMs: 20_400, endEpochMs: 21_000 }],
    };
    const summary = summarizeAudioTap(audio, { clickEpochMs: 20_000 });

    expect(summary).toMatchObject({
      firstNonSilentEpochMs: 11_000, readFirstNonSilentEpochMs: 20_400, clickToFirstNonSilentMs: 400,
      nonSilentMs: 5_000, playingSilentMs: 1_500, longestPlayingSilenceMs: 1_200,
      maxTickGapMs: 300, errors: ['earlier observation'], segmentCount: 2,
    });
    expect(audio.firstNonSilentEpochMs).toBe(11_000);
    expect(audio.segments).toHaveLength(2);
  });

  it.each([
    { firstNonSilentEpochMs: 11_000, segments: [{ startEpochMs: 11_000, endEpochMs: 13_000 }] },
    { firstNonSilentEpochMs: 19_800, segments: [{ startEpochMs: 19_800, endEpochMs: 20_500 }] },
    { firstNonSilentEpochMs: null, segments: [] },
    { firstNonSilentEpochMs: NaN, segments: [{ startEpochMs: Infinity, endEpochMs: Infinity }] },
  ])('does not infer a new read signal from stale or missing observations: %j', (audio) => {
    expect(summarizeAudioTap(audio, { clickEpochMs: 20_000 }))
      .toMatchObject({ readFirstNonSilentEpochMs: null, clickToFirstNonSilentMs: null });
  });

  it('retains a real zero latency and an open first-read signal', () => {
    expect(summarizeAudioTap({ firstNonSilentEpochMs: 20_000, segments: [] }, { clickEpochMs: 20_000 }))
      .toMatchObject({ readFirstNonSilentEpochMs: 20_000, clickToFirstNonSilentMs: 0 });
    expect(summarizeAudioTap({ firstNonSilentEpochMs: 20_300, segments: [] }, { clickEpochMs: 20_000 }))
      .toMatchObject({ readFirstNonSilentEpochMs: 20_300, clickToFirstNonSilentMs: 300 });
  });

  it.each([null, undefined, NaN, Infinity, '20000'])('leaves read latency unavailable without a measured click: %s', (clickEpochMs) => {
    expect(summarizeAudioTap({ firstNonSilentEpochMs: 20_300, segments: [] }, { clickEpochMs }))
      .toMatchObject({ readFirstNonSilentEpochMs: null, clickToFirstNonSilentMs: null });
  });

  it('summarizes main-thread long tasks and reports when they are unobservable', () => {
    expect(summarizeMainThread({ supported: true, method: 'longtask', longTasks: 3, totalLongTaskMs: 4_200, totalBlockingMs: 4_050, maxLongTaskMs: 2_500, entries: [], errors: [] }))
      .toEqual({ available: true, method: 'longtask', longTasks: 3, totalLongTaskMs: 4_200, totalBlockingMs: 4_050, maxLongTaskMs: 2_500 });
    expect(summarizeMainThread({ supported: false, errors: [] })).toEqual({ available: false, reason: 'longtask entries unsupported' });
    expect(summarizeMainThread(null)).toEqual({ available: false, reason: 'main-thread observer not installed' });
  });

  it('measures how long a ready first section waited before playback', () => {
    // CPU smoke shape: section 0 ready at 8.8 s, playback after the third preload.
    const tts = {
      sections: [
        { sectionIndex: 0, synthesisEndedAtMs: 8_800, audioStartAtMs: 22_200 },
        { sectionIndex: 1, synthesisEndedAtMs: 14_900, audioStartAtMs: 25_400 },
        { sectionIndex: 2, synthesisEndedAtMs: 16_400, audioStartAtMs: null },
        { sectionIndex: 3, synthesisEndedAtMs: 22_100, audioStartAtMs: null },
        { sectionIndex: 4, synthesisEndedAtMs: 23_700, audioStartAtMs: null },
      ],
    };

    expect(summarizeSectionTimeline(tts)).toMatchObject({ firstSectionReadyToPlaybackMs: 13_400, sectionsSynthesizedBeforePlayback: 4 });
    expect(summarizeSectionTimeline({ sections: [{ sectionIndex: 0, synthesisEndedAtMs: 9_000, audioStartAtMs: null }] }))
      .toMatchObject({ firstSectionReadyToPlaybackMs: null, sectionsSynthesizedBeforePlayback: null });
    expect(summarizeSectionTimeline(null)).toMatchObject({ firstSectionReadyToPlaybackMs: null });
  });

  it('fails any speaking lane whose section played far longer than its audio', () => {
    // Live shape: 8.35 s of audio took 474.6 s to play while the element was stalled.
    const [nativeWasm] = getTtsProbeProfiles('native_wasm');
    const stalled = { sectionIndex: 0, audioDurationSeconds: 8.35, playbackDurationMs: 474_593 };
    const healthy = { sectionIndex: 0, audioDurationSeconds: 8.35, playbackDurationMs: 8_475 };
    const attempt = (sections) => ({ tts: { sections }, execution: { observed: 'wasm' }, outcome: 'local-model', page: { displayedBackend: 'wasm' } });

    expect(evaluateLaneExpectations(nativeWasm, attempt([healthy]))).toEqual([]);
    expect(evaluateLaneExpectations(nativeWasm, attempt([healthy, { ...stalled, sectionIndex: 1 }])))
      .toEqual([`playback stalled: section 1 played 466243 ms longer than its audio (bound ${PLAYBACK_STALL_BOUND_MS} ms)`]);
    expect(summarizeSectionTimeline({ sections: [stalled] }, { speed: 3 }).maxPlaybackOverrunMs).toBeCloseTo(474_593 - 2_783.33, 1);
  });

  it('does not treat a deliberate pause as a playback stall', () => {
    const [pauseResume] = getTtsProbeProfiles('lifecycle_pause_resume_webgpu');
    const paused = { tts: { sections: [{ sectionIndex: 0, audioDurationSeconds: 3, playbackDurationMs: 5_400 }] }, execution: { observed: 'webgpu' }, outcome: 'local-model', page: { displayedBackend: 'webgpu' } };

    expect(evaluateLaneExpectations(pauseResume, paused)).toEqual([]);
  });

  it('waits on a page that is busy computing but gives up on a hung one', async () => {
    let cpu100ns = 0;
    let clock = 0;
    let cpuPerSample = 0;
    const queryEnforcement = async () => {
      cpu100ns += cpuPerSample;
      return { accounting: { totalUserTime100ns: cpu100ns, totalKernelTime100ns: 0, queriedAtUtc: new Date(clock).toISOString() } };
    };
    const sleep = async (ms) => {
      clock += ms;
    };
    const wait = createBusyPageWait({ queryEnforcement, deadlineAtMs: 900_000, now: () => clock, sleep });

    // CPU synthesis keeps about 2.5 logical processors busy over the 2 s sample.
    cpuPerSample = 2.5 * 2 * 1e7;
    await expect(wait.stillBusy(0)).resolves.toBe(true);
    clock = 23_000;
    wait.answered();
    expect(summarizePageBlocking(wait.record, { now: clock })).toMatchObject({ stretches: 1, maxMs: 23_000, unansweredAtEnd: false });
    expect(pageBlockingFailures(summarizePageBlocking(wait.record, { now: clock })))
      .toEqual([`toolbar player did not answer for 23000 ms while the browser stayed busy (bound ${PAGE_BLOCKED_BOUND_MS} ms)`]);

    // A hung renderer under a memory ceiling leaves job CPU flat.
    cpuPerSample = 0.05 * 2 * 1e7;
    await expect(wait.stillBusy(23_000)).resolves.toBe(false);
    expect(summarizePageBlocking(wait.record, { now: 48_000 })).toMatchObject({ stretches: 2, maxMs: 25_000, unansweredAtEnd: true });
    const late = createBusyPageWait({ queryEnforcement, deadlineAtMs: 0, now: () => clock, sleep });
    await expect(late.stillBusy(clock)).resolves.toBe(false);
    expect(pageBlockingFailures({ maxMs: 12_000 })).toEqual([]);
  });

  it('does not require a section transition from a single-section document', () => {
    const [webgpu3x] = getTtsProbeProfiles('playback_webgpu_3x');
    const attempt = (flow) => ({ tts: { flow, sections: [] }, execution: { observed: 'webgpu' }, outcome: 'local-model', page: { displayedBackend: 'webgpu' }, audio: { unexpectedSilence: false } });

    expect(evaluateLaneExpectations(webgpu3x, attempt({ sectionCount: 1, maxInterSectionGapMs: null }))).toEqual([]);
    expect(evaluateLaneExpectations(webgpu3x, attempt({ sectionCount: 5, maxInterSectionGapMs: null }))).toEqual(['inter-section gap was not measured']);
  });

  it('reports when the largest tap polling gap ended relative to the click', () => {
    expect(summarizeAudioTap({ segments: [], errors: [], maxTickGapMs: 15_000, maxTickGapEndEpochMs: 18_000 }, { clickEpochMs: 1_000 }))
      .toMatchObject({ maxTickGapMs: 15_000, maxTickGapEndAfterClickMs: 17_000, samplingDegraded: true });
  });
});

describe('probe launcher scheduling', () => {
  const revision = { shortSha: 'abc', dirty: false };

  async function runWithTrackedConcurrency(env) {
    const plan = createLiveTtsProbeRunPlan({ root: 'F:/repo', revision, runId: '20261005T080000Z-abcdef', env });
    let active = 0;
    let peak = 0;
    const tokens = [];
    let released = false;
    await runLiveTtsProbe(plan, {
      log: () => {},
      acquireLock: async () => ({ token: 'tok', waitedMs: 0, release: () => { released = true; } }),
      runJob: async (job) => {
        tokens.push(job.env.PAGENARRATOR_MEASUREMENT_LOCK_TOKEN);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { code: 0, signal: null };
      },
    });
    return { peak, tokens, released, jobs: plan.jobs.length };
  }

  it('runs isolated jobs one at a time under one inherited lock', async () => {
    const result = await runWithTrackedConcurrency({ PAGENARRATOR_TTS_PROBE_PROFILE: 'native', PAGENARRATOR_TTS_PROBE_MAX_WORKERS: '4' });

    expect(result).toEqual({ peak: 1, tokens: ['tok', 'tok'], released: true, jobs: 2 });
  });

  it('runs jobs concurrently only in contention mode', async () => {
    const result = await runWithTrackedConcurrency({ PAGENARRATOR_TTS_PROBE_PROFILE: 'native', PAGENARRATOR_TTS_PROBE_MAX_WORKERS: '2', PAGENARRATOR_TTS_PROBE_MODE: 'contention' });

    expect(result.peak).toBe(2);
  });

  it('releases the lock when a job fails', async () => {
    const plan = createLiveTtsProbeRunPlan({ root: 'F:/repo', revision, runId: '20261005T080000Z-abcdef', env: { PAGENARRATOR_TTS_PROBE_PROFILE: 'native_wasm' } });
    let released = false;

    const results = await runLiveTtsProbe(plan, {
      log: () => {},
      acquireLock: async () => ({ token: 'tok', release: () => { released = true; } }),
      runJob: async () => ({ code: 1, signal: null, timedOut: true }),
    });

    expect(results).toEqual([{ profileName: 'native_wasm', code: 1, signal: null, timedOut: true }]);
    expect(released).toBe(true);
  });

  it('terminates the whole process tree on Windows', () => {
    const calls = [];
    expect(killProcessTree(1234, { platform: 'win32', run: (...args) => calls.push(args) })).toBe(true);
    expect(calls[0].slice(0, 2)).toEqual(['taskkill', ['/PID', '1234', '/T', '/F']]);
    expect(killProcessTree(0)).toBe(false);
  });
});
