import { readFileSync } from 'node:fs';

export function normalizeLineEndings(text) {
  return String(text).replace(/\r\n/g, '\n');
}

export function readReaderEngineSourceSurface() {
  return normalizeLineEndings([
    readFileSync(new URL('../../src/app/reader-engine/reader-engine-runtime.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/app/reader-engine/reader-engine-session.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/platform/chrome/reader-engine-chrome-adapter.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/lib/reader-engine-read-loop.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/lib/reader-engine-audio-playback.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/lib/core/reader-engine-message-router.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/lib/reader-engine-reading-state-renderer.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/lib/reader-engine-read-controls-controller.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/lib/reader-engine-session-context-controller.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/lib/reader-engine-voice-runtime-controller.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/ui/reader-engine/reader-engine-controller.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/lib/reader-engine-voice-settings-controller.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/lib/reader-engine-tts-probe-controller.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/lib/reader-engine-queue-renderer.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/lib/reader-engine-speech-preload-controller.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/lib/reader-engine-target-resolver.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/lib/reader-engine-teardown-controller.js', import.meta.url), 'utf8'),
  ].join('\n'));
}

export function readReaderEngineSource() {
  return normalizeLineEndings([
    readFileSync(new URL('../../src/app/reader-engine/reader-engine-runtime.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/app/reader-engine/reader-engine-session.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/platform/chrome/reader-engine-chrome-adapter.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/lib/core/reader-engine-message-router.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/lib/reader-engine-reading-state-renderer.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/lib/reader-engine-read-controls-controller.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/lib/reader-engine-session-context-controller.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/lib/reader-engine-voice-runtime-controller.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/ui/reader-engine/reader-engine-controller.js', import.meta.url), 'utf8'),
  ].join('\n'));
}

export function readReadLoopSource() {
  return normalizeLineEndings(readFileSync(new URL('../../src/lib/reader-engine-read-loop.js', import.meta.url), 'utf8'));
}

export function readAudioPlaybackSource() {
  return normalizeLineEndings(readFileSync(new URL('../../src/lib/reader-engine-audio-playback.js', import.meta.url), 'utf8'));
}

export function readPageHighlightControllerSource() {
  return normalizeLineEndings(readFileSync(new URL('../../src/lib/reader-engine-page-highlight-controller.js', import.meta.url), 'utf8'));
}

export function readSpeechPreloadSource() {
  return normalizeLineEndings(readFileSync(new URL('../../src/lib/reader-engine-speech-preload-controller.js', import.meta.url), 'utf8'));
}
