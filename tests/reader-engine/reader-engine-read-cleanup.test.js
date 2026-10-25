import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isProbeResultReady } from '../live/live-tts-hardware-probe-assertions.js';

function readReaderEngine() {
  return [
    readFileSync(new URL('../../src/app/reader-engine/reader-engine-runtime.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/app/reader-engine/reader-engine-session.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/platform/chrome/reader-engine-chrome-adapter.js', import.meta.url), 'utf8'),
  ].join('\n');
}

function readReadLoop() {
  return readFileSync(new URL('../../src/lib/reader-engine-read-loop.js', import.meta.url), 'utf8');
}

function readReadControls() {
  return readFileSync(new URL('../../src/lib/reader-engine-read-controls-controller.js', import.meta.url), 'utf8');
}

function readAudioPlayback() {
  return readFileSync(new URL('../../src/lib/reader-engine-audio-playback.js', import.meta.url), 'utf8');
}

function readSpeechPreload() {
  return readFileSync(new URL('../../src/lib/reader-engine-speech-preload-controller.js', import.meta.url), 'utf8');
}

function readSessionContext() {
  return readFileSync(new URL('../../src/lib/reader-engine-session-context-controller.js', import.meta.url), 'utf8');
}

function readVoiceRuntime() {
  return readFileSync(new URL('../../src/lib/reader-engine-voice-runtime-controller.js', import.meta.url), 'utf8');
}

function readTeardown() {
  return readFileSync(new URL('../../src/lib/reader-engine-teardown-controller.js', import.meta.url), 'utf8');
}

function readLifecycleSurface() {
  return [
    readReaderEngine(),
    readReadLoop(),
    readReadControls(),
    readSpeechPreload(),
    readSessionContext(),
    readVoiceRuntime(),
    readTeardown(),
  ].join('\n');
}

describe('toolbar player active read cleanup wiring', () => {
  it('stops and releases an active read when the owning tab closes or the panel is hidden', () => {
    const readerEngine = readLifecycleSurface();

    expect(readerEngine).toContain('shouldStopReadForClosedTab');
    expect(readerEngine).toContain('function handleReadTabRemoved(tabId)');
    expect(readerEngine).toContain('chrome.tabs.onRemoved.addListener(handleReadTabRemoved)');
    expect(readerEngine).toContain("window.addEventListener('pagehide', handlePanelPageHide)");
    expect(readerEngine).toContain('tearDownEverything()');
    const pageHideStart = readerEngine.indexOf('function handlePanelPageHide()');
    const pageHideEnd = readerEngine.indexOf('function tearDownEverything', pageHideStart);
    const pageHideBlock = readerEngine.slice(pageHideStart, pageHideEnd);
    expect(pageHideBlock).not.toContain('shouldCleanupReadOnPanelHide');
    expect(readerEngine).toContain('releaseReadSessionAfterCleanup = true');
    expect(readerEngine).toContain('clearReadSessionBuffers()');
  });

  it('releases all cached TTS runtimes after terminal cleanup and full teardown', () => {
    const readerEngine = readLifecycleSurface();
    const readLoop = readReadLoop();

    expect(readerEngine).toContain('createVoiceModelIdleReleaseController');
    expect(readerEngine).toContain('const voiceModelReleaseController = createVoiceModelIdleReleaseController');
    expect(readerEngine).toContain("handleVoiceModelVisibilityChange");
    expect(readerEngine).toContain('async function releaseLoadedVoiceModel(');
    expect(readerEngine).toContain('function canReleaseLoadedVoiceModel()');
    expect(readerEngine).toContain('activeVoiceSynthesisTracker.isActive()');
    expect(readerEngine).toContain('if (!force && !canReleaseLoadedVoiceModel()) return false;');
    expect(readerEngine).toContain('trackActiveVoiceSynthesisPromise');
    expect(readerEngine).toContain('trackActiveVoiceSynthesisSegments');
    expect(readerEngine).toContain('releaseVoiceModel');
    expect(readerEngine).not.toContain('releasePiperEngine');
    expect(readerEngine).toContain('state.tts = null');
    expect(readerEngine).toContain('runCleanupAfterSettled');

    const cleanupStart = readLoop.indexOf('if (cleanedCurrentRun');
    const cleanupBlock = readLoop.slice(cleanupStart, cleanupStart + 220);
    expect(cleanupBlock).not.toContain('isVoiceModelMemorySaverActive()');
    expect(cleanupBlock).toContain('await releaseLoadedVoiceModel()');

    const teardownStart = readerEngine.indexOf('function tearDownEverything()');
    const teardownEnd = readerEngine.indexOf('function tearDownPdfViewerTab', teardownStart);
    const teardownBlock = readerEngine.slice(teardownStart, teardownEnd);
    expect(teardownBlock).toContain('const readCleanup = stopReading({ releaseBuffers: true });');
    expect(teardownBlock).toContain('releaseLoadedVoiceModelAfterReadCleanup(readCleanup);');
    expect(teardownBlock).not.toContain('releaseLoadedVoiceModel({ force: true })');
  });



  it('reuses and directly cleans up the audio element for each chunk', () => {
    const readerEngine = readReaderEngine();
    const audio = readAudioPlayback();

    expect(readerEngine).toContain('createReusableAudioElementPool');
    expect(readerEngine).toContain('const playbackAudioPool = createReusableAudioElementPool');
    expect(audio).toContain('audioPool.acquire(managedUrl.url)');
    expect(audio).toContain('attachAudioEventListeners');
    expect(audio).toContain('clearCurrentAudioEventListeners()');
    expect(audio).not.toContain('new Audio(managedUrl.url)');
  });

  it('purges active speech preloads when reading stops', () => {
    const readerEngine = readLifecycleSurface();
    const readLoop = readReadLoop();

    expect(readerEngine).toContain('pruneSpeechPreloads');
    expect(readerEngine).toContain('clearActiveSpeechPreloads()');
    expect(readLoop).toContain('state.activeSpeechPreloadCleanup = () => clearSpeechPreloadState');
    expect(readerEngine).toContain('activeSpeechPreloadCleanup = () => {}');
  });

  it('does not keep a browser-speech recovery path for generated speech failures', () => {
    const readLoop = readReadLoop();

    expect(readLoop).toContain("kind: 'synthesis_failed'");
    expect(readLoop).not.toContain('recoverWithRecordedBrowserVoice');
    expect(readLoop).not.toContain('recoverWithBrowserVoice');
    expect(readLoop).not.toContain('browser_voice_fallback');
  });

  it('does not force a lookahead preload before progressive or explicit balanced sub-downgraded playback starts', () => {
    const readerEngine = readLifecycleSurface();
    const readLoop = readReadLoop();
    const prePlayStart = readLoop.indexOf('const profileBeforePlayback = getActiveTtsProfileConfig();');
    const prePlayEnd = readLoop.indexOf('setCurrentSectionText(getChunkSpeechText(state.activeChunks[index]));', prePlayStart);
    const prePlayBlock = readLoop.slice(prePlayStart, prePlayEnd);

    expect(readerEngine).toContain('function getProfileMinimumAhead(profile)');
    expect(readerEngine).toContain('return profile.progressiveSegments || profile.preloadAhead <= 0 ? 0 : 2;');
    expect(prePlayBlock).toContain('const playbackMinimumAhead = getProfileMinimumAhead(profileBeforePlayback);');
    expect(prePlayBlock).toContain('minimumAhead: playbackMinimumAhead');
    expect(prePlayBlock).not.toContain('progressiveSegments ? 0 : 2');
  });

  it('warms a cached Kokoro model for the selected voice before returning it', () => {
    const readerEngine = readVoiceRuntime();
    const ensureStart = readerEngine.indexOf('async function ensureModel(');
    const ensureEnd = readerEngine.indexOf('async function prepareTtsBackendPlanForChunking', ensureStart);
    const ensureBlock = readerEngine.slice(ensureStart, ensureEnd);

    expect(ensureBlock).toContain('if (state.tts) {');
    expect(ensureBlock).toContain('state.tts.warmup?.({ voice: warmupVoice, signal })');
    expect(ensureBlock).toContain('trackActiveVoiceSynthesisPromise');
  });

  it('keeps best-effort voice preparation failures out of fatal setup state', () => {
    const readerEngine = readVoiceRuntime();
    const ensureStart = readerEngine.indexOf('async function ensureModel(');
    const ensureEnd = readerEngine.indexOf('async function prepareTtsBackendPlanForChunking', ensureStart);
    const ensureBlock = readerEngine.slice(ensureStart, ensureEnd);
    const onErrorStart = ensureBlock.indexOf('onError(error)');
    const onErrorEnd = ensureBlock.indexOf('},', onErrorStart);
    const onErrorBlock = ensureBlock.slice(onErrorStart, onErrorEnd);

    expect(onErrorBlock).toContain("if (error?.voiceLoadStep === 'prepare')");
    expect(onErrorBlock).toContain("logger.warn?.('Best-effort voice preparation failed.', error)");
    expect(onErrorBlock).toContain('return;');
    expect(onErrorBlock).toContain('failModelSetup(error?.message)');
  });



  it('refreshes the speech preload window when generated audio starts playing', () => {
    const audio = readAudioPlayback();
    const readLoop = readReadLoop();
    const playAudioStart = audio.indexOf('function playAudio(');
    const playAudioEnd = audio.indexOf('function clearAudioElement', playAudioStart);
    const playAudioBlock = audio.slice(playAudioStart, playAudioEnd);
    const readLoopStart = readLoop.indexOf('const refreshSpeechPreloadsForPlaybackStart = () => {');
    const readLoopEnd = readLoop.indexOf('const nextIndex = state.activeReadingCursor.completeCurrent();', readLoopStart);
    const readLoopBlock = readLoop.slice(readLoopStart, readLoopEnd);

    expect(playAudioStart).toBeGreaterThan(-1);
    expect(playAudioEnd).toBeGreaterThan(playAudioStart);
    expect(playAudioBlock).toContain('onAudioStart');
    expect(playAudioBlock).toContain('onAudioStart?.({ sectionIndex })');
    expect(readLoopBlock).toContain('onAudioStart: refreshSpeechPreloadsForPlaybackStart');
    expect(readLoopBlock).toContain('ensureSpeechPreloadWindow({');
  });

  it('uses the shared max-in-flight helper so progressive lookahead can run concurrently', () => {
    const readerEngine = readLifecycleSurface();
    const ensureStart = readerEngine.indexOf('function ensureSpeechPreloadWindow');
    const ensureEnd = readerEngine.indexOf('function getProfileMinimumAhead', ensureStart);
    const ensureBlock = readerEngine.slice(ensureStart, ensureEnd);

    expect(readerEngine).toContain('getSpeechPreloadMaxInFlight');
    expect(ensureBlock).toContain('getSpeechPreloadMaxInFlight({');
    expect(ensureBlock).not.toContain('profile.progressiveSegments ? 1');
  });

  it('records transition gaps through the TTS performance governor', () => {
    const readerEngine = [
      readReaderEngine(),
      readReadLoop(),
      readFileSync(new URL('../../src/lib/reader-engine-tts-probe-controller.js', import.meta.url), 'utf8'),
    ].join('\n');

    expect(readerEngine).toContain('recordTtsProbeSectionTransition');
    expect(readerEngine).toContain('ttsPerformanceGovernor?.recordSectionTransition');
    expect(readerEngine).toContain('createSectionReadyTransitionTracker');
    expect(readerEngine).toContain('getSectionReadyTransitionTracker()?.recordSectionReady');
  });

  it('records progressive section readiness from the primed segment callback', () => {
    const readerEngine = readLifecycleSurface();
    const preloadStart = readerEngine.indexOf('function preloadSpeech(');
    const preloadEnd = readerEngine.indexOf('function preloadPiperSpeech', preloadStart);
    const preloadBlock = readerEngine.slice(preloadStart, preloadEnd);
    const progressiveStart = readerEngine.indexOf('async function playProgressiveSpeechSegments');
    const progressiveEnd = readerEngine.indexOf('function isReadRunStopped', progressiveStart);
    const progressiveBlock = readerEngine.slice(progressiveStart, progressiveEnd);

    expect(preloadBlock).toContain('onSegmentReady');
    expect(preloadBlock).toContain('recordSectionSynthesis');
    expect(progressiveBlock).not.toContain('recordSectionSynthesis');
  });

  it('waits for audio playback observation before accepting live probe output', () => {
    const liveProbe = readFileSync(new URL('../live/tts-probe-attempt.js', import.meta.url), 'utf8');
    const tts = {
      selectedBackendPlan: { device: 'wasm' },
      firstSynthesisMs: 0,
      flow: { sectionCount: 1, audioPlaybackObserved: false },
    };

    expect(liveProbe).toMatch(/isProbeResultReady\(\s*tts,\s*\{\s*requiredSections\b/u);
    expect(isProbeResultReady(tts)).toBe(false);
    expect(isProbeResultReady({
      ...tts,
      flow: { ...tts.flow, audioPlaybackObserved: true },
    })).toBe(true);
  });

  it('clears retained article buffers during stopped-read cleanup', () => {
    const readerEngine = readSessionContext();

    expect(readerEngine).toContain('function clearReadSessionBuffers()');
    expect(readerEngine).toContain('state.activeChunks = []');
    expect(readerEngine).toContain('state.activeChunkWordCounts = []');
    expect(readerEngine).toContain("state.activeArticleSource = ''");
    expect(readerEngine).toContain('state.activePdfPageCount = 0');
    expect(readerEngine).toContain('clearTranscript()');
  });

  it('clears retained article buffers after natural finish', () => {
    const readLoop = readReadLoop();

    expect(readLoop).toContain("setReadingState(stoppedRun ? 'stopping' : 'finished')");
    expect(readLoop).toContain("const shouldReleaseBuffers = stoppedRun || state.releaseReadSessionAfterCleanup || state.readingState === 'finished';");
  });
});
