import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readReaderEngine() {
  return readFileSync(new URL('../../src/reader-engine.js', import.meta.url), 'utf8');
}

function readReaderEngineApp() {
  return [
    readFileSync(new URL('../../src/app/reader-engine/reader-engine-runtime.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/app/reader-engine/reader-engine-session.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/platform/chrome/reader-engine-chrome-adapter.js', import.meta.url), 'utf8'),
  ].join('\n');
}

function readRepoFile(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

describe('readerEngine architecture boundaries', () => {
  it('keeps the readerEngine entrypoint as a thin bootstrap', () => {
    const lineCount = readReaderEngine().split(/\r?\n/).length;
    const readerEngine = readReaderEngine();

    expect(lineCount).toBeLessThanOrEqual(150);
    expect(readerEngine).toContain("import('./lib/offscreen-chrome-bridge.js')");
    expect(readerEngine).toContain("import('./lib/i18n.js')");
    expect(readerEngine).toContain("import('./lib/reader-engine-app.js')");
    expect(readerEngine).toContain('localizeDocument(document)');
    expect(readerEngine).toContain('createReaderEngineApp({ document, chrome, navigator, performance }).start()');
    expect(readerEngine).not.toContain('createReaderEngineVoiceSettingsController');
  });

  it('documents the controller init, teardown, and one-owner signal contract', () => {
    const readerEngine = readReaderEngineApp();

    expect(readerEngine).toContain('Controller graph contract');
    expect(readerEngine).toContain('Init order:');
    expect(readerEngine).toContain('Teardown order:');
    expect(readerEngine).toContain('One owner per signal:');
  });

  it('caps the readerEngine orchestrator and page highlighter line counts to ratcheted budgets', () => {
    const budgets = [
      ['src/app/reader-engine/create-reader-engine-app.js', 250],
      ['src/app/reader-engine/reader-engine-runtime.js', 100],
      ['src/app/reader-engine/reader-engine-session.js', 1200],
      ['src/platform/chrome/reader-engine-chrome-adapter.js', 900],
      ['src/lib/reader-engine-reading-state-renderer.js', 300],
      ['src/lib/reader-engine-read-controls-controller.js', 300],
      ['src/lib/reader-engine-session-context-controller.js', 300],
      ['src/lib/reader-engine-voice-runtime-controller.js', 300],
      ['src/lib/page-highlighter.js', 1800],
    ];
    const compositionGuard = readFileSync(new URL('../../scripts/check-reader-engine-composition.mjs', import.meta.url), 'utf8');

    for (const [path, max] of budgets) {
      expect(readRepoFile(path).split(/\r?\n/).length, path).toBeLessThanOrEqual(max);
      expect(compositionGuard, `${path} should have the same ${max}-line budget in check-reader-engine-composition.mjs`)
        .toContain(`{ path: '../${path}', max: ${max} }`);
    }
  });

  it('delegates voice/settings UI orchestration out of the readerEngine entrypoint', () => {
    const readerEngine = readReaderEngineApp();

    expect(readerEngine).toContain('createReaderEngineVoiceSettingsController');
    for (const localFunction of [
      'function populateLanguageOptions',
      'async function populateVoices',
      'function bindVoiceSettings',
      'function renderSpeedSetting',
      'function renderTtsPerformanceProfileSetting',
      'function renderLanguageStatus',
      'function resolveSelectedVoice',
      'async function handleDownloadVoicePack',
    ]) {
      expect(readerEngine).not.toContain(localFunction);
    }
  });

  it('delegates TTS probe recording out of the readerEngine entrypoint', () => {
    const readerEngine = readReaderEngineApp();

    expect(readerEngine).toContain('createReaderEngineTtsProbeController');
    for (const localFunction of [
      'async function initTtsHardwareProbe',
      'function publishTtsHardwareProbe',
      'function recordTtsProbeBackendPlan',
      'function recordTtsProbeModelFallback',
      'function recordTtsProbeBrowserVoiceFallback',
    ]) {
      expect(readerEngine).not.toContain(localFunction);
    }
  });

  it('delegates PDF page navigation out of the readerEngine entrypoint', () => {
    const readerEngine = readReaderEngineApp();

    expect(readerEngine).toContain('createReaderEnginePdfNavigationController');
    expect(readerEngine.indexOf('} = createReaderEngineQueueRenderer({')).toBeLessThan(
      readerEngine.indexOf('const pdfNavigationController = createReaderEnginePdfNavigationController({'),
    );
    for (const localFunction of [
      'function jumpToFirstPdfPage',
      'function jumpToEnteredPdfPage',
      'function skipCurrentPdfPage',
      'async function jumpToPdfPage',
      'async function ensurePdfPageStartIndex',
      'async function ensureNextPdfPageStartIndex',
      'function canControlPdfPages',
      'function normalizePdfPageNumber',
      'function renderPdfPageControls',
      'function getPdfPageNavigation',
    ]) {
      expect(readerEngine).not.toContain(localFunction);
    }
  });

  it('does not ship retired floating or minimized player controllers', () => {
    const readerEngine = readReaderEngineApp();

    expect(existsSync(new URL('../../src/lib/reader-engine-floating-actions-controller.js', import.meta.url))).toBe(false);
    expect(existsSync(new URL('../../src/lib/reader-engine-panel-state-controller.js', import.meta.url))).toBe(false);
    expect(readerEngine).not.toContain('createReaderEngineFloatingActionsController');
    expect(readerEngine).not.toContain('panelStateController');
  });

  it('delegates voice runtime lifecycle out of the readerEngine entrypoint', () => {
    const readerEngine = readReaderEngineApp();

    expect(readerEngine).toContain('createReaderEngineVoiceRuntimeController');
    for (const localFunction of [
      'async function ensureModel',
      'async function releaseLoadedVoiceModel',
      'async function releaseVoiceRuntimeForEngine',
      'async function prepareActiveVoiceRuntime',
      'function handleModelProgress',
    ]) {
      expect(readerEngine).not.toContain(localFunction);
    }
  });

  it('delegates read controls and tab-context resets out of the readerEngine entrypoint', () => {
    const readerEngine = readReaderEngineApp();

    expect(readerEngine).toContain('createReaderEngineReadControlsController');
    expect(readerEngine).toContain('createReaderEngineSessionContextController');
    for (const localFunction of [
      'function pauseReading',
      'function resumeReading',
      'function stopReading',
      'function requestJump',
      'function createReadPauseGate',
      'async function refreshActiveTabContext',
      'function handleActiveTabContextChanged',
      'function clearReadSessionBuffers',
      'async function loadSavedResumePosition',
      'async function saveResumeChunk',
    ]) {
      expect(readerEngine).not.toContain(localFunction);
    }
  });

  it('delegates first-read onboarding and review prompting out of the readerEngine entrypoint', () => {
    const readerEngine = [
      readReaderEngineApp(),
      readRepoFile('src/lib/reader-engine-reading-state-renderer.js'),
    ].join('\n');

    expect(readerEngine).toContain('createReaderEngineOnboardingController');
    expect(readerEngine).toContain('createReaderEngineReviewPromptController');
    expect(readerEngine).toContain('reviewPromptController.hide()');
  });

  it('delegates generated-audio playback, browser speech, and the main read loop out of the readerEngine entrypoint', () => {
    const readerEngine = readReaderEngineApp();

    expect(readerEngine).toContain('createAudioPlaybackManager');
    expect(readerEngine).toContain('createReadLoopOrchestrator');
    expect(readerEngine).not.toContain('function playBlob(');
    expect(readerEngine).not.toContain('function playBrowserSpeech(');
    expect(readerEngine).not.toContain('async function readPage({');
  });

  it('delegates article-summary assembly out of the readerEngine orchestrator', () => {
    const readerEngine = readReaderEngineApp();

    expect(readerEngine).toContain('createReaderEngineArticleSummaryController');
    for (const localFunction of [
      'function setArticleSummary(',
      'function renderResumePrompt(',
      'function renderCodeSuggestion(',
    ]) {
      expect(readerEngine).not.toContain(localFunction);
    }
  });

  it('extracts speech preload, target resolution, and teardown controllers out of the readerEngine entrypoint', () => {
    const readerEngine = readReaderEngineApp();

    expect(readerEngine).toContain('createReaderEngineSpeechPreloadController');
    expect(readerEngine).toContain('createReaderEngineTargetResolver');
    expect(readerEngine).toContain('createReaderEngineTeardownController');
    for (const localFunction of [
      'function preloadSpeech(',
      'function createProgressiveSpeechPreload(',
      'function ensureSpeechPreloadWindow(',
      'async function extractActiveTab(',
      'async function createPdfViewerReadArticle(',
      'function tearDownEverything(',
      'function tearDownPdfViewerTab(',
    ]) {
      expect(readerEngine).not.toContain(localFunction);
    }
  });

  it('allows streamed article resume lookup before enough chunks are loaded to verify the excerpt', () => {
    const readerEngine = readRepoFile('src/lib/reader-engine-session-context-controller.js');

    expect(readerEngine).toContain('allowUnverified');
    expect(readerEngine).toContain('return options.allowUnverified ? saved : null');
  });

  it('keeps readerEngine composition modules and CI guard wired', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const gates = JSON.parse(readRepoFile('config/verification-gates.json'));
    const app = readReaderEngineApp();

    expect(existsSync(new URL('../../src/lib/reader-engine-dom.js', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../../src/lib/reader-engine-state.js', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../../scripts/check-reader-engine-composition.mjs', import.meta.url))).toBe(true);
    expect(app).toContain("import { getReaderEngineElements } from '../../lib/reader-engine-dom.js'");
    expect(app).toContain("import { createReaderEngineInitialState } from '../../lib/reader-engine-state.js'");
    expect(packageJson.scripts['check:reader-engine-composition']).toBe(
      'node scripts/check-reader-engine-composition.mjs'
    );
    expect(packageJson.scripts['launch:full']).toBe('npm run verify:release');
    expect(gates.release).toContain('npm run check:reader-engine-composition');
  });
});
