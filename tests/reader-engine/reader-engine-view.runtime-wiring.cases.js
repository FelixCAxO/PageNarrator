import { readReaderEngineSourceSurface, readReaderEngineSource, readReadLoopSource, readAudioPlaybackSource, readPageHighlightControllerSource, readSpeechPreloadSource } from "./reader-engine-view.fixtures.js";
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import { describe, expect, it } from 'vitest';

describe('toolbar player view model', () => {
  it('gates word-level page highlights on a successful chunk highlight response', () => {
    const readerEngine = readReaderEngineSourceSurface();
    const pageHighlightController = readPageHighlightControllerSource();
    const readLoop = readReadLoopSource();
    const audio = readAudioPlaybackSource();

    expect(readerEngine).toContain('createReaderEnginePageHighlightController({');
    expect(pageHighlightController).toContain('sendPageMessage(tabId, createChunkHighlightMessage(MESSAGE_TYPES.HIGHLIGHT_CHUNK');
    expect(pageHighlightController).toContain('function shouldSyncPageHighlights(article)');
    expect(pageHighlightController).toContain('return Boolean(article);');
    expect(readLoop).toContain('const syncPageHighlights = shouldSyncPageHighlights(article);');
    expect(readLoop).toContain('const highlightOk = syncPageHighlights ? (await highlightChunk(article.tabId, state.activeChunks[index]))?.ok : false;');
    expect(readLoop).toContain('await playKokoroSpeech(speech, state.activeChunks[index], {');
    expect(audio).toContain('type: MESSAGE_TYPES.HIGHLIGHT_WORD_PLAN');
    expect(readLoop).toContain('syncWordHighlights: highlightOk');
    expect(audio).toContain('if (syncWordHighlights && wordTimings?.length)');
    expect(audio).toContain('createWordHighlightPlan(wordTimings');
    expect(audio).toContain('type: MESSAGE_TYPES.HIGHLIGHT_PLAN_RESYNC');
    expect(audio).toContain('createHighlightPlanResyncTracker');
    expect(audio).toContain('createAudioHighlightResyncLoop');
    expect(audio).toContain('highlightPlanResyncLoop.start()');
    expect(audio).not.toContain('timeupdate: handleAudioTimeUpdate');
    expect(audio).toContain('getAudioEndedGapDelayMs');
    expect(readerEngine).toContain('openPdfViewerForSourceTab({');
    expect(readerEngine).toContain('waitForReaderTabReady,');
    expect(readerEngine).toContain('function sendPageMessage(tabId, message, { attempts = 3');
  });

  it('keeps bounded generated audio startup without a system speech fallback', () => {
    const script = readAudioPlaybackSource();

    expect(script).toContain('BROWSER_SPEECH_BOUNDARY_TIMEOUT_MS');
    expect(script).toContain('setTimeout(openPlayGate, BROWSER_SPEECH_BOUNDARY_TIMEOUT_MS)');
    expect(script).toContain('createWordHighlightPlan(wordTimings');
    expect(script).toContain('createAudioHighlightResyncLoop');
    expect(script).not.toMatch(/speechSynthesis|SpeechSynthesisUtterance|playBrowserSpeech|activeSpeechUtterance/);
  });

  it('sends an output-latency adjusted word-highlight lead to the page scheduler', () => {
    const script = readAudioPlaybackSource();
    const planStart = script.indexOf('const planLeadSeconds = getOutputLatencyAdjustedLeadSeconds({');
    const planEnd = script.indexOf('type: MESSAGE_TYPES.HIGHLIGHT_WORD_PLAN', planStart);
    const planBlock = script.slice(planStart, planEnd + 260);

    expect(script).toContain('getOutputLatencyAdjustedLeadSeconds');
    expect(script).toContain('const audioOutputLatencySeconds = readAudioOutputLatencySeconds();');
    expect(planStart).toBeGreaterThan(-1);
    expect(planBlock).toContain('playbackRate: audio.playbackRate');
    expect(planBlock).toContain('outputLatencySeconds: audioOutputLatencySeconds');
    expect(planBlock).toContain('createWordHighlightPlan(wordTimings, {');
    expect(planBlock).toContain('leadSeconds: planLeadSeconds');
  });

  it('keeps post-section storage bookkeeping off the audio handoff path', () => {
    const readerEngine = readReaderEngineSource();
    const script = readReadLoopSource();
    const playbackEnd = script.indexOf('const nextIndex = state.activeReadingCursor.completeCurrent();');
    const loopEnd = script.indexOf('stoppedRun = stopIfRequested();', playbackEnd);
    const handoffBlock = script.slice(playbackEnd, loopEnd);

    expect(readerEngine).toContain('function queuePostPlaybackBookkeeping(');
    expect(handoffBlock).toContain('queuePostPlaybackBookkeeping(saveResumeChunk(');
    expect(handoffBlock).not.toContain('await saveResumeChunk');
    expect(handoffBlock).not.toMatch(/quota/i);
    expect(handoffBlock).not.toContain('await refreshQuota');
  });

  it('records corpus flow timestamps from panel time while preserving media time separately', () => {
    const readerEngine = readReaderEngineSource();
    const audio = readAudioPlaybackSource();
    const flowRecorderStart = readerEngine.indexOf('const flowRecorder = createFlowRecorder({');
    const flowRecorderEnd = readerEngine.indexOf('});', flowRecorderStart);
    const flowRecorderBlock = readerEngine.slice(flowRecorderStart, flowRecorderEnd + 4);

    expect(flowRecorderStart).toBeGreaterThan(-1);
    expect(flowRecorderBlock).toContain('now: () => performance.now() / 1000');
    expect(flowRecorderBlock).not.toContain('currentAudio');
    expect(flowRecorderBlock).not.toContain('currentTime');
    expect(audio).toContain("kind: 'chunk_play'");
    expect(audio).toContain("kind: 'chunk_end'");
    expect(audio).toContain('mediaTime: audio.currentTime');
  });

  it('waits for configured section pause before reading the next preloaded speech payload', () => {
    const script = readReadLoopSource();
    const loopStart = script.indexOf('const index = state.activeReadingCursor.current();');
    const loopEnd = script.indexOf('stoppedRun = stopIfRequested();', loopStart);
    const loopBlock = script.slice(loopStart, loopEnd);
    const waitIndex = loopBlock.indexOf('await waitBetweenSections(index, state.activeChunks.length, { signal: runSignal });');
    const readIndex = loopBlock.indexOf('speech = await readPreloadedSpeech(currentPreload, {');
    const completeIndex = loopBlock.indexOf('const nextIndex = state.activeReadingCursor.completeCurrent();');
    const postCompleteWait = loopBlock.indexOf('await waitBetweenSections(nextIndex, state.activeChunks.length, { signal: runSignal });', completeIndex);

    expect(waitIndex).toBeGreaterThan(-1);
    expect(readIndex).toBeGreaterThan(-1);
    expect(waitIndex).toBeLessThan(readIndex);
    expect(postCompleteWait).toBe(-1);
  });

  it('threads the run signal into the extraction and current-chunk preload waits', () => {
    const script = readReadLoopSource();
    const extractStart = script.indexOf('let article = await extractActiveTab({');
    const extractEnd = script.indexOf('});', extractStart);
    const extractBlock = script.slice(extractStart, extractEnd);

    expect(extractBlock).toContain('signal: runSignal');
    const readStart = script.indexOf('speech = await readPreloadedSpeech(currentPreload, {');
    const readEnd = script.indexOf('});', readStart);
    const readBlock = script.slice(readStart, readEnd);

    expect(readBlock).toContain('signal: runSignal');
    expect(readBlock).toContain('readyTimeoutMs');
  });

  it('blocks normal audio-ended resolution on the next mandatory speech preload without fading normal handoff', () => {
    const readLoop = readReadLoopSource();
    const script = readAudioPlaybackSource();
    const playAudioStart = script.indexOf('function playAudio(');
    const playAudioEnd = script.indexOf('function clearAudioElement', playAudioStart);
    const playAudioBlock = script.slice(playAudioStart, playAudioEnd);

    expect(playAudioStart).toBeGreaterThan(-1);
    expect(playAudioEnd).toBeGreaterThan(playAudioStart);
    expect(readLoop).toContain('waitForSpeechPreloadReady');
    expect(playAudioBlock).toContain('onBeforeNormalEnd');
    expect(playAudioBlock).toContain('audio.onended = () => {\n        finish({ waitForHandoff: true });\n      };');
    expect(playAudioBlock).not.toContain('fadeOutAudioThenPause(audio');
  });

  it('keeps the short fade only on user-initiated stop and jump paths', () => {
    const script = readReaderEngineSource();
    const stopStart = script.indexOf('function stopReading');
    const stopEnd = script.indexOf('function tearDownEverything', stopStart);
    const stopBlock = script.slice(stopStart, stopEnd);
    const jumpStart = script.indexOf('function requestJump');
    const jumpEnd = script.indexOf('function getLoadedJumpIndex', jumpStart);
    const jumpBlock = script.slice(jumpStart, jumpEnd);

    expect(script).toContain('fadeOutAudioThenPause');
    expect(stopBlock).toContain('finishCurrentAudioWithFade');
    expect(jumpBlock).toContain('finishCurrentAudioWithFade');
    expect(stopBlock).not.toContain('currentAudio.pause();\n    currentAudio.currentTime = 0;');
    expect(jumpBlock).not.toContain('currentAudio.pause();\n  currentAudio.currentTime = Math.max');
  });

  it('bypasses Kokoro model loading when silent TTS flow tests are enabled', () => {
    const script = readReadLoopSource();
    const selectedVoiceStart = script.indexOf('let selectedVoice = resolveSelectedVoice();');
    const quotaStart = script.indexOf('let quotaConsumed = false;', selectedVoiceStart);
    const selectedVoiceBlock = script.slice(selectedVoiceStart, quotaStart);

    expect(selectedVoiceBlock).toContain("if (['kokoro', 'omnivoice'].includes(selectedVoice.engine) && !state.testSilentTtsEnabled)");
    expect(selectedVoiceBlock).toContain('await ensureModel({ signal: runSignal, warmupVoice: selectedVoice.id || getSelectedVoiceId(), backendPlan: ttsBackendPlan });');
  });

  it('routes Kokoro synthesis through silent TTS during deterministic flow tests', () => {
    const script = readSpeechPreloadSource();
    expect(script).toContain('testSilentTts: state.testSilentTtsEnabled');
    expect(script).not.toContain('preloadPiperSpeech');
  });

  it('exposes the section pause control', () => {
    const html = readFileSync(new URL('../../src/reader-engine.html', import.meta.url), 'utf8');

    expect(html).toContain('id="section-pause-settings"');
    expect(html).toContain('id="section-pause"');
  });

  it('shows the GPU recommendation without claiming verified hardware minimums', () => {
    const html = readFileSync(new URL('../../src/reader-engine.html', import.meta.url), 'utf8');

    const document = new JSDOM(html).window.document;
    expect([...document.querySelectorAll('strong')].some(element => element.textContent === 'Recommended:' && element.hasAttribute('data-i18n'))).toBe(true);
    expect(html).toContain('NVIDIA RTX 30 series GPU or newer');
    expect(html).toContain('8 GB+ VRAM and 8 GB+ system RAM');
    expect(html).toContain('Physical hardware tiers are unverified.');
  });

  it('lets adapter availability decide whether low-memory candidates use Kokoro WebGPU', () => {
    const script = readReaderEngineSource();

    expect(script).toContain('memorySaver: false');
    expect(script).not.toContain('isVoiceModelMemorySaverActive()');
    expect(script).toContain("beginModelSetup(event?.device === 'webgpu')");
  });

  it('wires adaptive TTS profiles into chunking, preloading, and first-chunk measurements', () => {
    const script = readReaderEngineSourceSurface();

    expect(script).toContain("} from './tts-performance-profile.js';");
    expect(script).toContain('createTtsPerformanceGovernor,');
    expect(script).toContain('formatTtsPerformanceProfileOptionLabel');
    expect(script).toContain('formatTtsPerformanceProfileTooltip');
    expect(script).toContain('let ttsPerformanceGovernor = null;');
    expect(script).toContain('const governorRequestedProfile = governor?.requestedProfile?.();');
    expect(script).toContain('const useGovernorProfile = governorRequestedProfile === normalized;');
    expect(script).toContain('createTtsPerformanceGovernor({');
    expect(script).toContain('ttsPerformanceProfile: requestedProfile');
    expect(script).toContain('recordBackendPlan');
    expect(script).toContain('renderTtsPerformanceGovernorDecision');
    expect(script).toContain('getActiveTtsProfileConfig()');
    expect(script).toContain('maxChunkLength');
    expect(script).toContain('targetMinLength');
    expect(script).toContain('preloadAhead');
    expect(script).toContain('progressiveSegments');
    expect(script).toContain('primeSpeechSegments');
    expect(script).toContain('getSpeechPreloadWindow({');
    expect(script).toContain('const speechPreloads = new Map();');
    expect(script).toContain('recordFirstSynthesis');
    expect(script).toContain('recordModelLoad');
  });

  it('lets an explicit CPU backend bypass WebGPU and reload an idle Kokoro model', () => {
    const script = readReaderEngineSourceSurface();

    expect(script).toContain('function shouldForceWasmVoiceModel()');
    expect(script).toContain("ttsBackendPreference === 'wasm'");
    expect(script).toContain('webGpuRuntimeAvailable: !shouldForceWasmVoiceModel()');
    expect(script).toContain('maybeReleaseLoadedVoiceModelAfterPerformanceProfileChange();');
  });

  it('records the Kokoro backend plan before extraction creates profile-sized speech chunks', () => {
    const readerEngine = readReaderEngineSource();
    const readLoop = readReadLoopSource();
    const backendPlanAwaitIndex = readLoop.indexOf('const ttsBackendPlan = await prepareTtsBackendPlanForChunking({ signal: runSignal });');
    const extractIndex = readLoop.indexOf('let article = await extractActiveTab');
    const chunkProfileIndex = readLoop.indexOf('const ttsProfile = getActiveTtsProfileConfig();');

    expect(readerEngine).toContain('async function prepareTtsBackendPlanForChunking({ signal = null } = {})');
    expect(readerEngine).toContain("if (selectedVoice?.engine !== 'kokoro') return undefined;");
    expect(readerEngine).toContain('ttsService.prepareRuntime({');
    expect(readerEngine).toContain('const backendPlan = runtimeDecision.backendPlan;');
    expect(readerEngine).toContain('render.renderGovernorDecision?.(state.ttsPerformanceGovernor?.recordBackendPlan?.(backendPlan));');
    expect(readerEngine).toContain('render.renderBackendStatus?.(backendPlan);');
    expect(readerEngine).toContain('render.recordBackendPlan?.(backendPlan);');
    expect(readLoop).toContain('backendPlan: ttsBackendPlan');
    expect(backendPlanAwaitIndex).toBeGreaterThan(-1);
    expect(backendPlanAwaitIndex).toBeLessThan(extractIndex);
    expect(backendPlanAwaitIndex).toBeLessThan(chunkProfileIndex);
  });

  it('guards missing speech preloads before reading their result payload', () => {
    const script = readSpeechPreloadSource();

    expect(script).toContain("if (!preload) throw new Error('Speech preload did not start.');");
  });

  it('styles the current queue item with the same yellow reading marker as the page highlight', () => {
    const css = readFileSync(new URL('../../src/reader-engine.css', import.meta.url), 'utf8');

    expect(css).toContain('.reading-queue li[data-state="current"]');
    expect(css).toContain('rgba(255, 221, 87, 0.16)');
    expect(css).toContain('0 0 0 2px rgba(255, 204, 51, 0.72)');
    expect(css).toContain('.reading-queue li[data-state="current"] .queue-index');
    expect(css).toContain('color: var(--warning);');
  });
});
