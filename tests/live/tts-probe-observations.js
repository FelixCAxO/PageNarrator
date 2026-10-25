import {
  RUN_STATUS,
  assessMeasurementValidity,
  assessRunEnvironment,
  resolveExecutionBackend,
} from '../../scripts/weak-hardware/evidence-contract.mjs';
import { OUTCOMES } from './live-tts-hardware-profiles.js';
import { computeJobCpuUsage } from '../../scripts/weak-hardware/windows-job.mjs';
import { KOKORO_DATA } from '../../src/tts/kokoro/model-data.js';

// The page-evaluate timeout used to end the attempt at this bound. A blocked
// page is still judged against it; it is not relaxed.
export const PAGE_BLOCKED_BOUND_MS = 20_000;
const BUSY_MIN_LOGICAL_PROCESSORS = 0.5;
const BUSY_SAMPLE_MS = 2_000;

/**
 * Tells a busy page from a hung one after a page evaluation times out. CPU
 * synthesis runs on the engine page's main thread, so the page can stop
 * answering while the browser keeps computing; a hung renderer (e.g. under a
 * memory ceiling) leaves job CPU flat. Busy pages are waited on until the
 * deadline, and every stretch without an answer is recorded.
 * @param {{ queryEnforcement: () => Promise<any>, deadlineAtMs: number, now?: () => number, sleep?: (ms: number) => Promise<unknown> }} options
 */
export function createBusyPageWait({ queryEnforcement, deadlineAtMs, now = Date.now, sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }) }) {
  const record = { stretches: 0, maxMs: 0, totalMs: 0, busySamples: [], openSinceMs: null };
  return {
    record,
    async stillBusy(sentAtMs) {
      record.openSinceMs ??= sentAtMs;
      if (now() >= deadlineAtMs) return false;
      const before = await queryEnforcement().catch(() => null);
      await sleep(BUSY_SAMPLE_MS);
      const after = await queryEnforcement().catch(() => null);
      const { busyLogicalProcessors } = computeJobCpuUsage(before?.accounting, after?.accounting);
      if (record.busySamples.length < 50) record.busySamples.push(busyLogicalProcessors);
      return Number(busyLogicalProcessors) >= BUSY_MIN_LOGICAL_PROCESSORS;
    },
    answered() {
      if (record.openSinceMs === null) return;
      const ms = now() - record.openSinceMs;
      record.stretches += 1;
      record.maxMs = Math.max(record.maxMs, ms);
      record.totalMs += ms;
      record.openSinceMs = null;
    },
  };
}

/** Blocked stretches for one attempt; a stretch still open at the end counts until then. */
export function summarizePageBlocking(record, { now = Date.now() } = {}) {
  if (!record) return null;
  const openMs = record.openSinceMs === null ? 0 : now - record.openSinceMs;
  return {
    method: 'page evaluations that timed out while job CPU kept rising (busy, not hung)',
    stretches: record.stretches + (openMs ? 1 : 0),
    maxMs: Math.max(record.maxMs, openMs),
    totalMs: record.totalMs + openMs,
    unansweredAtEnd: openMs > 0,
    busyLogicalProcessors: [...record.busySamples],
    boundMs: PAGE_BLOCKED_BOUND_MS,
  };
}

export function pageBlockingFailures(pageBlocking) {
  if (!(pageBlocking?.maxMs > PAGE_BLOCKED_BOUND_MS)) return [];
  return [`toolbar player did not answer for ${Math.round(pageBlocking.maxMs)} ms while the browser stayed busy (bound ${PAGE_BLOCKED_BOUND_MS} ms)`];
}

export const OUTCOME_CATEGORIES = Object.freeze({
  ...OUTCOMES,
  RENDERER_CRASHED: 'renderer-crashed',
  RENDERER_UNRESPONSIVE: 'renderer-unresponsive',
  BROWSER_CRASHED: 'browser-crashed',
  TIMED_OUT: 'timed-out',
  BROKEN: 'broken',
});

const MODEL_HOST_PATTERN = /huggingface\.co|hf\.co|xethub|cdn-lfs/i;

/** Source evaluated in the extension service worker: model files in Cache Storage. */
export function createModelCacheExpression(manifest = KOKORO_DATA) {
  return `(async () => {
  const pinnedModels = ${JSON.stringify(manifest.files.filter(file => file.path.endsWith('.onnx')))};
  const modelBase = ${JSON.stringify(`https://huggingface.co/${manifest.modelId}/resolve/${manifest.revision}/`)};
  const names = await caches.keys();
  const caches_ = [];
  for (const name of names) {
    const cache = await caches.open(name);
    const requests = await cache.keys();
    const verifiedModelFiles = [];
    for (const request of requests) {
      const file = name === 'transformers-cache' && pinnedModels.find(file => request.url === modelBase + file.path);
      if (!file) continue;
      try {
        const response = await cache.match(request);
        const bytes = await response.arrayBuffer();
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        const sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
        verifiedModelFiles.push({ cacheName: name, url: request.url, path: file.path, bytes: bytes.byteLength, sha256,
          verified: bytes.byteLength === file.bytes && sha256 === file.sha256 });
      } catch (error) {
        verifiedModelFiles.push({ path: file.path, verified: false, error: String(error) });
      }
    }
    caches_.push({
      name,
      entries: requests.length,
      modelFiles: requests.filter((request) => /\\.onnx(\\?|$)/i.test(request.url)).map((request) => request.url.split('/').slice(-2).join('/')),
      verifiedModelFiles,
    });
  }
  return caches_;
})()`;
}

export const MODEL_CACHE_EXPRESSION = createModelCacheExpression();

export function summarizeModelCache(caches) {
  const list = Array.isArray(caches) ? caches : [];
  const modelFiles = list.flatMap((cache) => cache.modelFiles || []);
  return {
    observed: Array.isArray(caches),
    state: !Array.isArray(caches) ? 'unobserved' : modelFiles.length ? 'cache-warm' : 'download-cold',
    modelFiles,
    verifiedModelFiles: list.flatMap(cache => cache.verifiedModelFiles || []),
    cacheNames: list.map((cache) => cache.name),
    entries: list.reduce((total, cache) => total + Number(cache.entries || 0), 0),
  };
}

/** Source evaluated in the toolbar-player page after a read. */
export const READER_ENGINE_OBSERVATION_EXPRESSION = `(() => {
  const status = document.getElementById('tts-backend-status');
  const notice = document.getElementById('error-notice');
  const audio = globalThis.__pnProbeAudio || null;
  const faults = globalThis.__pnProbeFaults || null;
  const mainThread = globalThis.__pnProbeMainThread || null;
  const resources = performance.getEntriesByType('resource')
    .filter((entry) => ${MODEL_HOST_PATTERN}.test(entry.name))
    .map((entry) => ({
      name: entry.name.split('?')[0].split('/').slice(-2).join('/'),
      startTime: entry.startTime,
      responseEnd: entry.responseEnd,
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize,
    }));
  return {
    href: location.href,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    displayedBackend: status?.dataset?.backend || null,
    displayedBackendText: status?.textContent?.trim() || null,
    errorNotice: {
      visible: Boolean(notice && !notice.hidden),
      message: document.getElementById('error-message')?.textContent?.trim() || '',
      code: document.getElementById('error-code')?.textContent?.trim() || '',
    },
    readIdle: Boolean(document.getElementById('stop-btn')?.hidden) && !document.getElementById('read-btn')?.disabled,
    faults: faults ? {
      counts: { ...faults.counts },
      requestAdapterCalls: faults.requestAdapterCalls,
      requestDeviceCalls: faults.requestDeviceCalls,
      deviceLimits: faults.deviceLimits,
      devicesDestroyed: faults.devicesDestroyed,
      errors: [...faults.errors],
    } : null,
    audio: audio ? {
      ...audio,
      segments: audio.segments.slice(-400),
      errors: [...audio.errors],
      mediaEvents: { ...audio.mediaEvents },
      mediaState: globalThis.__pnProbeAudioState?.() || null,
    } : null,
    mainThread: mainThread ? { ...mainThread, entries: mainThread.entries.slice(-50), errors: [...mainThread.errors] } : null,
    modelResources: resources,
  };
})()`;

export function summarizeModelAcquisition(resources = []) {
  if (!Array.isArray(resources) || !resources.length) {
    return { requests: 0, durationMs: null, transferBytes: null, source: 'resource-timing', note: 'no network model requests (cache hit or not observable)' };
  }
  const start = Math.min(...resources.map((entry) => Number(entry.startTime)));
  const end = Math.max(...resources.map((entry) => Number(entry.responseEnd)));
  const transfer = resources.map((entry) => Number(entry.transferSize)).filter(Number.isFinite);
  return {
    requests: resources.length,
    durationMs: Number.isFinite(end - start) ? end - start : null,
    transferBytes: transfer.some((value) => value > 0) ? transfer.reduce((total, value) => total + value, 0) : null,
    source: 'resource-timing',
    files: resources.map((entry) => entry.name),
  };
}

/**
 * Summarizes the in-page audio tap for one read. clickEpochMs is taken just
 * before the harness clicks Start reading.
 */
export function summarizeAudioTap(audio, { clickEpochMs = null, unexpectedSilenceMs = 1000 } = {}) {
  if (!audio) return { available: false, reason: 'audio tap not installed' };
  const segments = Array.isArray(audio.segments) ? audio.segments : [];
  // The tap accumulates across reads; never reuse an earlier read's first signal.
  const readFirstNonSilentEpochMs = Number.isFinite(clickEpochMs)
    ? [audio.firstNonSilentEpochMs, ...segments.map(segment => segment.startEpochMs)].reduce((first, epoch) =>
      Number.isFinite(epoch) && epoch >= clickEpochMs && (first === null || epoch < first) ? epoch : first, null)
    : null;
  const gaps = [];
  for (let index = 1; index < segments.length; index += 1) {
    gaps.push(segments[index].startEpochMs - segments[index - 1].endEpochMs);
  }
  return {
    available: true,
    method: audio.method,
    resolutionMs: audio.sampleRate ? Math.round((audio.windowSamples / audio.sampleRate) * 1000) : null,
    pollMs: audio.pollMs,
    tappedElements: audio.tappedElements,
    firstNonSilentEpochMs: audio.firstNonSilentEpochMs,
    readFirstNonSilentEpochMs,
    clickToFirstNonSilentMs: readFirstNonSilentEpochMs !== null
      ? readFirstNonSilentEpochMs - clickEpochMs
      : null,
    nonSilentMs: audio.nonSilentMs,
    playingSilentMs: audio.playingSilentMs,
    longestPlayingSilenceMs: audio.longestPlayingSilenceMs,
    unexpectedSilence: Number.isFinite(audio.longestPlayingSilenceMs) ? audio.longestPlayingSilenceMs > unexpectedSilenceMs : null,
    segmentCount: segments.length,
    maxSilenceBetweenSegmentsMs: gaps.length ? Math.max(...gaps) : null,
    maxTickGapMs: Number.isFinite(audio.maxTickGapMs) ? audio.maxTickGapMs : null,
    maxTickGapEndAfterClickMs: Number.isFinite(clickEpochMs) && Number.isFinite(audio.maxTickGapEndEpochMs)
      ? audio.maxTickGapEndEpochMs - clickEpochMs
      : null,
    // Tap timings are only as precise as its polling; a blocked page widens them.
    samplingDegraded: Number.isFinite(audio.maxTickGapMs) ? audio.maxTickGapMs > TAP_SAMPLING_DEGRADED_MS : null,
    mediaEvents: audio.mediaEvents || null,
    mediaState: audio.mediaState || null,
    errors: audio.errors || [],
  };
}

export const TAP_SAMPLING_DEGRADED_MS = 250;

/** Long tasks on the toolbar-player main thread during the page's lifetime. */
export function summarizeMainThread(mainThread) {
  if (!mainThread) return { available: false, reason: 'main-thread observer not installed' };
  if (!mainThread.supported) return { available: false, reason: mainThread.errors?.[0] || 'longtask entries unsupported' };
  return {
    available: true,
    method: mainThread.method,
    longTasks: mainThread.longTasks,
    totalLongTaskMs: mainThread.totalLongTaskMs,
    totalBlockingMs: mainThread.totalBlockingMs,
    maxLongTaskMs: mainThread.maxLongTaskMs,
  };
}

// A section whose playback outlasts its audio by more than the existing
// starvation budget stalled while "playing". Healthy smoke sections stayed
// within 125 ms.
export const PLAYBACK_STALL_BOUND_MS = 750;

/**
 * How long the first section waited between finishing synthesis and starting
 * playback, and how far any section's playback outlasted its audio. All values
 * come from the product's probe recorder clock.
 */
export function summarizeSectionTimeline(tts, { speed = 1 } = {}) {
  const sections = Array.isArray(tts?.sections) ? tts.sections : [];
  const rate = Number(speed) > 0 ? Number(speed) : 1;
  let overrun = null;
  for (const section of sections) {
    const played = Number(section.playbackDurationMs);
    const audioMs = (Number(section.audioDurationSeconds) * 1000) / rate;
    if (section.playbackDurationMs === null || section.playbackDurationMs === undefined || !Number.isFinite(played) || !Number.isFinite(audioMs)) continue;
    if (!overrun || played - audioMs > overrun.ms) overrun = { ms: played - audioMs, sectionIndex: section.sectionIndex };
  }
  const first = sections.find((section) => section.sectionIndex === 0) || sections[0] || null;
  const toTime = (value) => (value === null || value === undefined ? NaN : Number(value));
  const readyAt = toTime(first?.synthesisEndedAtMs);
  const playAt = toTime(first?.audioStartAtMs);
  const known = Number.isFinite(readyAt) && Number.isFinite(playAt);
  return {
    firstSectionReadyToPlaybackMs: known ? playAt - readyAt : null,
    // Sections whose synthesis had finished when the first section started playing.
    sectionsSynthesizedBeforePlayback: known
      ? sections.filter((section) => toTime(section.synthesisEndedAtMs) <= playAt).length
      : null,
    maxPlaybackOverrunMs: overrun ? overrun.ms : null,
    maxPlaybackOverrunSectionIndex: overrun ? overrun.sectionIndex : null,
    source: 'toolbar-player probe recorder (synthesisEndedAtMs, audioStartAtMs)',
  };
}

/**
 * Per-read result for a repeated read in the same toolbar-player page. The
 * page's probe recorder accumulates across reads, so this read is isolated by
 * time: recorder events after sinceMs (page clock) and audio-tap segments
 * after clickEpochMs. A model-load event after the click means the model was
 * not resident for this read.
 */
export function deriveRepeatedReadResult(events = [], { sinceMs, clickEpochMs, audio = null, previousPlan = null, speed = 1 } = {}) {
  const after = (Array.isArray(events) ? events : []).filter((event) => Number(event.at) >= sinceMs);
  const synthesis = after.filter((event) => event.type === 'section-synthesis');
  const audioEnds = after.filter((event) => event.type === 'section-audio-end');
  const modelLoads = after.filter((event) => event.type === 'model-load');
  const fallbacks = after.filter((event) => event.type === 'model-fallback');
  const plan = after.filter((event) => event.type === 'backend-plan').at(-1)?.plan || previousPlan;
  const first = synthesis[0] || null;
  const readyGaps = [];
  for (let index = 1; index < synthesis.length; index += 1) {
    readyGaps.push(Math.max(0, Number(synthesis[index].synthesisEndedAtMs) - Number(synthesis[index - 1].synthesisEndedAtMs)));
  }
  const segments = (audio?.segments || []).filter((segment) => segment.startEpochMs >= clickEpochMs);
  const silences = [];
  for (let index = 1; index < segments.length; index += 1) silences.push(segments[index].startEpochMs - segments[index - 1].endEpochMs);
  // Same quantity as the recorder's cold-read gap (element end -> next start):
  // next end minus that section's playback duration minus previous end.
  const durationBySection = new Map(synthesis.map((event) => [event.sectionIndex, Number(event.audioDurationSeconds)]));
  const transitionGaps = [];
  for (let index = 1; index < audioEnds.length; index += 1) {
    const seconds = durationBySection.get(audioEnds[index].sectionIndex);
    if (!Number.isFinite(seconds)) continue;
    const startAt = Number(audioEnds[index].audioEndAtMs) - ((seconds * 1000) / (Number(speed) || 1));
    transitionGaps.push(Math.max(0, startAt - Number(audioEnds[index - 1].audioEndAtMs)));
  }
  const duration = first ? Number(first.audioDurationSeconds) : null;
  return {
    selectedBackendPlan: plan,
    modelResidency: modelLoads.length ? 'reloaded' : 'resident',
    modelLoadMs: modelLoads.at(-1)?.loadMs ?? null,
    firstSynthesisMs: first?.synthesisMs ?? null,
    audioDurationSeconds: duration,
    realTimeFactor: first && duration > 0 ? Number(first.synthesisMs) / (duration * 1000) : null,
    preTtsLatency: {
      firstAudibleMs: segments.length ? segments[0].startEpochMs - clickEpochMs : null,
    },
    sections: synthesis.map((event) => ({
      sectionIndex: event.sectionIndex,
      synthesisMs: event.synthesisMs,
      audioDurationSeconds: event.audioDurationSeconds,
      realTimeFactor: event.realTimeFactor,
      synthesisEndedAtMs: event.synthesisEndedAtMs,
      audioEndAtMs: audioEnds.find(end => end.sectionIndex === event.sectionIndex)?.audioEndAtMs ?? null,
    })),
    flow: {
      sectionCount: synthesis.length,
      loadTransitionCount: readyGaps.length,
      measuredTransitionCount: transitionGaps.length,
      audioPlaybackObserved: segments.length > 0 || audioEnds.length > 0,
      maxNextSectionReadyGapMs: readyGaps.length ? Math.max(...readyGaps) : null,
      maxInterSectionGapMs: transitionGaps.length ? Math.max(...transitionGaps) : null,
      // Audible silence between tap segments (includes model-produced edge silence).
      maxAudibleSilenceMs: silences.length ? Math.max(...silences) : null,
      source: 'recorder events after the click (audio-end minus section duration); audible silence from the audio tap',
    },
    fallbackOccurred: fallbacks.length > 0,
    fallbacks: fallbacks.map((event) => ({ type: 'model', message: event.message, fallbackPlan: event.fallbackPlan })),
    audioEndCount: audioEnds.length,
  };
}

/** Only completed playback transitions have reached their readiness deadline. */
export function summarizeSectionReadyDeadlines(sections = []) {
  const ordered = [...sections].sort((a, b) => a.sectionIndex - b.sectionIndex);
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const played = ordered.filter(section => finite(section.audioEndAtMs));
  const first = ordered[0]?.sectionIndex;
  const last = played.at(-1)?.sectionIndex;
  const transitions = [];
  for (let index = first + 1; index <= last; index += 1) {
    const previous = ordered.find(section => section.sectionIndex === index - 1);
    const current = ordered.find(section => section.sectionIndex === index);
    transitions.push({ fromSectionIndex: index - 1, toSectionIndex: index,
      readyDeadlineMissMs: finite(previous?.audioEndAtMs) && finite(current?.synthesisEndedAtMs)
        ? Math.max(0, current.synthesisEndedAtMs - previous.audioEndAtMs) : null });
  }
  const measured = transitions.filter(transition => transition.readyDeadlineMissMs !== null);
  const complete = transitions.length > 0 && measured.length === transitions.length;
  return {
    maxSectionReadyDeadlineMissMs: complete ? Math.max(...measured.map(transition => transition.readyDeadlineMissMs)) : null,
    sectionReadyDeadlineCoverage: { expected: transitions.length, measured: measured.length, complete },
    sectionReadyDeadlineTransitions: transitions,
  };
}

/** Dedicated Kokoro roles are annotated by the collector from the measured artifact's exact URLs. */
export function summarizeWorkerThreads(workers) {
  const available = Array.isArray(workers);
  const list = Array.isArray(workers) ? workers : [];
  const helpers = list.filter((worker) => worker.type === 'worker' && worker.pagenarratorRole === 'kokoro-cpu-helper');
  const coordinators = list.filter((worker) => worker.type === 'worker' && worker.pagenarratorRole === 'kokoro-coordinator');
  return {
    available,
    totalWorkers: available ? list.length : null,
    kokoroCpuCoordinatorWorkers: available ? coordinators.length : null,
    kokoroCpuHelperWorkers: available ? helpers.length : null,
    workers: list.map((worker) => ({ type: worker.type, title: worker.title || null,
      url: String(worker.url || '').split('/').slice(-1)[0] || null,
      pagenarratorRole: worker.pagenarratorRole ?? null, workerBindingSha256: worker.workerBindingSha256 ?? null })),
  };
}

/**
 * Classifies what the user would have experienced.
 * @param {{ tts?: any, page?: any, execution?: any, crash?: string|null, timedOut?: boolean }} input
 */
export function classifyProbeOutcome({ tts = null, page = null, execution = null, crash = null, timedOut = false } = {}) {
  if (crash === 'browser') return OUTCOME_CATEGORIES.BROWSER_CRASHED;
  if (crash === 'renderer') return OUTCOME_CATEGORIES.RENDERER_CRASHED;
  if (crash === 'renderer-unresponsive') return OUTCOME_CATEGORIES.RENDERER_UNRESPONSIVE;
  if (page?.errorNotice?.visible) return OUTCOME_CATEGORIES.EXPLICIT_ERROR;
  if (timedOut) return OUTCOME_CATEGORIES.TIMED_OUT;
  const resolved = execution || resolveExecutionBackend(tts || {});
  if (resolved?.observed && resolved?.producedAudio) {
    return resolved.fellBack ? OUTCOME_CATEGORIES.PERMITTED_FALLBACK : OUTCOME_CATEGORIES.LOCAL_MODEL;
  }
  return OUTCOME_CATEGORIES.BROKEN;
}

/**
 * Checks a lane attempt against the lane's declared expectations.
 * @returns {string[]} failure descriptions (empty when the attempt meets them)
 */
export function evaluateLaneExpectations(profile, attempt) {
  const expected = profile?.expected;
  if (!expected) return [];
  const failures = [];
  const observed = attempt.execution?.observed ?? null;
  const runOutcome = profile.runConditions?.[attempt.runIndex]?.expectedOutcome;
  if (runOutcome && attempt.outcome !== runOutcome) {
    failures.push(`run ${attempt.runIndex} outcome ${attempt.outcome} is not the expected ${runOutcome}`);
  } else if (!expected.outcomes.includes(attempt.outcome)) {
    failures.push(`outcome ${attempt.outcome} is not one of ${expected.outcomes.join(', ')}`);
  }
  if ([OUTCOMES.LOCAL_MODEL, OUTCOMES.PERMITTED_FALLBACK].includes(attempt.outcome) && !expected.execution.includes(observed)) {
    failures.push(`observed execution ${observed} is not one of ${expected.execution.join(', ')}`);
  }
  if (attempt.outcome !== OUTCOMES.EXPLICIT_ERROR && observed && attempt.page?.displayedBackend
    && attempt.page.displayedBackend !== observed) {
    failures.push(`toolbar player shows ${attempt.page.displayedBackend} while ${observed} executed`);
  }
  if (expected.backendReason && attempt.tts?.selectedBackendPlan?.reason !== expected.backendReason) {
    failures.push(`backend reason ${attempt.tts?.selectedBackendPlan?.reason} is not ${expected.backendReason}`);
  }
  const deviceCalls = attempt.page?.faults?.requestDeviceCalls;
  if (expected.maxRequestDeviceCalls !== null && expected.maxRequestDeviceCalls !== undefined
    && Number(deviceCalls) > expected.maxRequestDeviceCalls) {
    failures.push(`requestDevice() was called ${deviceCalls} times (bound ${expected.maxRequestDeviceCalls}); GPU initialization is looping`);
  }
  // Applies to every lane that produced speech; pausing legitimately extends playback.
  if ([OUTCOMES.LOCAL_MODEL, OUTCOMES.PERMITTED_FALLBACK].includes(attempt.outcome) && profile.lifecycle?.action !== 'pause-resume') {
    const timeline = summarizeSectionTimeline(attempt.tts, { speed: profile.playbackSettings?.speed || 1 });
    if (timeline.maxPlaybackOverrunMs > PLAYBACK_STALL_BOUND_MS) {
      failures.push(`playback stalled: section ${timeline.maxPlaybackOverrunSectionIndex} played ${Math.round(timeline.maxPlaybackOverrunMs)} ms longer than its audio (bound ${PLAYBACK_STALL_BOUND_MS} ms)`);
    }
  }
  const continuity = expected.continuity;
  if (continuity && [OUTCOMES.LOCAL_MODEL, OUTCOMES.PERMITTED_FALLBACK].includes(attempt.outcome)) {
    const gap = attempt.tts?.flow?.maxInterSectionGapMs;
    // A single-section document has no section transition to measure.
    const singleSection = Number(attempt.tts?.flow?.sectionCount) === 1;
    if ((gap === null || gap === undefined) && !singleSection) {
      failures.push('inter-section gap was not measured');
    } else if (gap > continuity.maxInterSectionGapMs) {
      failures.push(`playback starved: ${Math.round(gap)} ms between sections exceeds ${continuity.maxInterSectionGapMs} ms`);
    }
    const tap = attempt.audio ?? summarizeAudioTap(attempt.page?.audio);
    if (continuity.noUnexpectedSilence && tap?.unexpectedSilence !== false) {
      failures.push(tap?.unexpectedSilence ? `unexpected silence of ${Math.round(tap.longestPlayingSilenceMs)} ms while audio was playing` : 'audio output was not captured');
    }
  }
  if (profile.expectedWasmThreads && observed === 'wasm') {
    const threads = Number(profile.expectedWasmThreads);
    const coordinators = attempt.workers?.kokoroCpuCoordinatorWorkers;
    const helpers = attempt.workers?.kokoroCpuHelperWorkers;
    if (![1, 4].includes(threads)) {
      failures.push(`requested ${threads} WASM inference threads; original Kokoro supports 1 or 4`);
    } else if (attempt.workers?.available !== true || !Number.isSafeInteger(coordinators) || !Number.isSafeInteger(helpers)) {
      failures.push('original Kokoro CPU workers were not observed');
    } else {
      if (threads === 4 && attempt.page?.crossOriginIsolated !== true) failures.push('original Kokoro four-worker inference requires observed cross-origin isolation');
      if (coordinators !== 1) failures.push(`observed ${coordinators} original Kokoro CPU coordinators; expected 1`);
      if (helpers !== threads - 1) failures.push(`observed ${helpers} original Kokoro CPU helper workers; ${threads} inference worker${threads === 1 ? ' needs' : 's need'} ${threads - 1}`);
    }
  }
  return failures;
}

/**
 * Checks a lifecycle action's measured effect against predeclared bounds.
 * @param {{ action: string }|null} lifecycle
 * @param {any} result measured by the harness
 * @param {Record<string, number>} bounds
 */
export function evaluateLifecycleResult(lifecycle, result, bounds) {
  if (!lifecycle) return [];
  if (!result) return [`lifecycle action ${lifecycle.action} did not run`];
  const failures = [];
  const within = (value, bound, label) => {
    if (value === null || value === undefined) failures.push(`${label} was not observed`);
    else if (value > bound) failures.push(`${label} ${Math.round(value)} ms exceeds ${bound} ms`);
  };
  if (lifecycle.action === 'stop') {
    within(result.stopToSilenceMs, bounds.maxStopToSilenceMs, 'stop to silence');
    if (result.staleSpeech) failures.push('speech resumed after stop');
    if (!result.readIdle) failures.push('the reader did not return to idle after stop');
  } else if (lifecycle.action === 'pause-resume') {
    within(result.pauseToSilenceMs, bounds.maxPauseToSilenceMs, 'pause to silence');
    if (!result.heldSilent) failures.push('audio played while paused');
    within(result.resumeToSoundMs, bounds.maxResumeToSoundMs, 'resume to sound');
  } else if (lifecycle.action === 'minimize') {
    if (!result.minimized) failures.push('the browser window was not minimized');
    if (!(result.sectionsEndedWhileMinimized > 0)) failures.push('playback made no progress while minimized');
  } else {
    failures.push(`unknown lifecycle action ${lifecycle.action}`);
  }
  return failures;
}

/**
 * Summarizes soak samples: stalls, and memory growth after warm-up.
 * @param {Array<{ atMs: number, privateBytes: number|null, jsHeapUsedBytes: number|null }>} samples
 */
export function summarizeSoakSamples(samples = [], { warmupSamples = 2 } = {}) {
  const steady = samples.slice(warmupSamples).filter((sample) => Number.isFinite(sample.privateBytes));
  const growthMiB = (key) => {
    const values = steady.map((sample) => sample[key]).filter((value) => Number.isFinite(value));
    return values.length >= 2 ? (values.at(-1) - values[0]) / 1048576 : null;
  };
  let slope = null;
  if (steady.length >= 3) {
    const xs = steady.map((sample) => sample.atMs / 3_600_000);
    const ys = steady.map((sample) => sample.privateBytes / 1048576);
    const meanX = xs.reduce((total, value) => total + value, 0) / xs.length;
    const meanY = ys.reduce((total, value) => total + value, 0) / ys.length;
    const denominator = xs.reduce((total, value) => total + ((value - meanX) ** 2), 0);
    slope = denominator > 0 ? xs.reduce((total, value, index) => total + ((value - meanX) * (ys[index] - meanY)), 0) / denominator : null;
  }
  return {
    steadySamples: steady.length,
    privateGrowthMiB: growthMiB('privateBytes'),
    jsHeapGrowthMiB: growthMiB('jsHeapUsedBytes'),
    privateSlopeMiBPerHour: slope,
  };
}

/**
 * A soak record filled in place while the soak runs. The probe attaches it to
 * the attempt before the first sample, so a browser crash part-way through
 * keeps the samples, stall and duration observed so far (completed: false).
 * @param {{ targetMs: number, configuredMs: number, warmupSamples?: number, startedAt: number }} options
 */
export function createSoakRecorder({ targetMs, configuredMs, warmupSamples = 2, startedAt }) {
  const record = {
    targetMs,
    configuredMs,
    observedMs: 0,
    completed: false,
    finishedDocument: false,
    maxStallMs: 0,
    ...summarizeSoakSamples([], { warmupSamples }),
    samples: [],
  };
  let lastEnds = null;
  let lastProgressAt = startedAt;
  return {
    record,
    addSample(sample, now) {
      if (lastEnds === null || sample.sectionsEnded > lastEnds) {
        lastEnds = sample.sectionsEnded;
        lastProgressAt = now;
      } else {
        record.maxStallMs = Math.max(record.maxStallMs, now - lastProgressAt);
      }
      record.samples.push({ atMs: now - startedAt, ...sample });
      record.observedMs = now - startedAt;
      Object.assign(record, summarizeSoakSamples(record.samples, { warmupSamples }));
    },
    finish({ finishedDocument = false, now }) {
      record.observedMs = now - startedAt;
      record.finishedDocument = finishedDocument;
      record.completed = true;
      return record;
    },
  };
}

/**
 * Checks a soak result against predeclared tolerances. A run shorter than the
 * target duration is reported as incomplete, never as a passed soak.
 */
export function evaluateSoakResult(soak, result, bounds) {
  if (!soak) return [];
  if (!result) return ['soak observation did not run'];
  const failures = [];
  if (result.observedMs < bounds.targetMs) {
    failures.push(`soak observed ${Math.round(result.observedMs / 60_000)} min of the ${Math.round(bounds.targetMs / 60_000)}-minute target`);
  }
  if (result.maxStallMs > bounds.maxStallMs) failures.push(`playback stalled for ${Math.round(result.maxStallMs / 1000)} s`);
  if (result.privateGrowthMiB === null) failures.push('steady-state memory was not sampled');
  else if (result.privateGrowthMiB > bounds.maxPrivateGrowthMiB) {
    failures.push(`browser private memory grew ${Math.round(result.privateGrowthMiB)} MiB after warm-up (bound ${bounds.maxPrivateGrowthMiB})`);
  }
  if (result.jsHeapGrowthMiB !== null && result.jsHeapGrowthMiB > bounds.maxJsHeapGrowthMiB) {
    failures.push(`toolbar-player JS heap grew ${Math.round(result.jsHeapGrowthMiB)} MiB after warm-up (bound ${bounds.maxJsHeapGrowthMiB})`);
  }
  return failures;
}

/**
 * Lane verdict across attempts. Lanes that search for a resource boundary
 * (memory) pass when every attempt lands in the same outcome category.
 */
export function computeLaneVerdict(profile, attempts = []) {
  const laneAttempts = attempts.filter((attempt) => attempt.profile?.name === profile.name);
  const statuses = countBy(laneAttempts.map((attempt) => attempt.status));
  const outcomes = countBy(laneAttempts.map((attempt) => attempt.outcome));
  const invalid = laneAttempts.filter((attempt) => attempt.status === RUN_STATUS.INVALID_ENVIRONMENT || attempt.status === RUN_STATUS.BLOCKED);
  let verdict;
  if (!laneAttempts.length) verdict = 'missing';
  else if (invalid.length) verdict = invalid.some((attempt) => attempt.status === RUN_STATUS.BLOCKED) ? 'blocked' : 'invalid-environment';
  else if (profile.expected?.requireConsistentOutcome) verdict = Object.keys(outcomes).length === 1 ? 'reproducible' : 'non-reproducible';
  else verdict = laneAttempts.every((attempt) => attempt.status === RUN_STATUS.PASSED) ? 'passed' : 'failed';
  return {
    profileName: profile.name,
    lane: profile.lane || null,
    verdict,
    attempts: laneAttempts.length,
    statuses,
    outcomes,
  };
}

export function isPassingLaneVerdict(verdict) {
  return verdict === 'passed' || verdict === 'reproducible';
}

/**
 * Converts an error thrown during an attempt into a run status.
 * @param {any} error
 */
export function statusForError(error) {
  if (error?.status === RUN_STATUS.BLOCKED || error?.name === 'ProbeEnvironmentBlockedError') return RUN_STATUS.BLOCKED;
  if (error?.name === 'ProbeTimeoutError' || error?.name === 'CdpTimeoutError') return RUN_STATUS.TIMEOUT;
  if (error?.name === 'ProbeCrashError') return RUN_STATUS.CRASHED;
  if (/CDP WebSocket (closed|failed)|Target closed|Session with given id not found/i.test(String(error?.message || ''))) {
    return RUN_STATUS.CRASHED;
  }
  return RUN_STATUS.FAILED;
}

export { assessMeasurementValidity, assessRunEnvironment, resolveExecutionBackend };

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value ?? 'none'] = (counts[value ?? 'none'] || 0) + 1;
  return counts;
}
