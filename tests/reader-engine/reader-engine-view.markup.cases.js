import { normalizeLineEndings, readReaderEngineSourceSurface } from "./reader-engine-view.fixtures.js";
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { getPanelView } from "../../src/lib/reader-engine-view.js";

describe('toolbar player view model', () => {
  it('keeps the toolbar player markup aligned with the compact dark reader design', () => {
    const html = readFileSync(new URL('../../src/reader-engine.html', import.meta.url), 'utf8');
    const document = new JSDOM(html, { url: 'https://example.test/' }).window.document;

    expect(document.querySelector('.app-shell')).toBeTruthy();
    expect(document.querySelector('.panel')).toBeTruthy();
    expect(document.querySelector('[data-view="idle"]')).toBeTruthy();
    expect(document.querySelector('[data-view="reading"]')).toBeTruthy();
    expect(document.querySelector('.pro-cta')).toBeNull();
    expect(document.body.hidden).toBe(true);
    expect(document.getElementById('advanced-tools-panel')?.textContent).toContain('Advanced settings');
    expect(document.querySelector('.player-strip')).toBeTruthy();
    expect(document.getElementById('minimize-btn')).toBeNull();
    expect(document.getElementById('expand-btn')).toBeNull();
    expect(document.getElementById('mini-play-btn')).toBeNull();
    expect(document.getElementById('settings-btn')).toBeNull();
    expect(document.getElementById('reader-settings')).toBeTruthy();
    expect(document.querySelector('#reader-settings > summary')?.textContent).toContain('Voice settings');
    expect(document.getElementById('voice-settings-summary')).toBeTruthy();
    expect(document.getElementById('read-btn')).toBeTruthy();
    expect(document.getElementById('read-selected-btn')).toBeTruthy();
    expect(document.getElementById('pause-btn')).toBeNull();
    expect(document.getElementById('prev-btn')).toBeTruthy();
    expect(document.querySelector('#pdf-page-nav + .voice-choice + #reader-settings')).toBeTruthy();
    expect(document.getElementById('pdf-page-nav')).toBeTruthy();
    expect(document.getElementById('pdf-page-nav')?.hidden).toBe(true);
    expect(document.getElementById('pdf-page-first-btn')).toBeTruthy();
    expect(document.getElementById('pdf-page-jump-input')).toBeTruthy();
    expect(document.getElementById('pdf-page-jump-btn')).toBeTruthy();
    expect(document.getElementById('pdf-page-skip-btn')).toBeTruthy();
    expect(document.getElementById('pdf-page-skip-btn')?.getAttribute('aria-label')).toBe('Skip current PDF page');
    expect(document.getElementById('transcript-text')).toBeTruthy();
    expect(document.getElementById('reading-queue')).toBeTruthy();
    expect(document.getElementById('queue-first-btn')).toBeTruthy();
    expect(document.getElementById('queue-jump-input')).toBeTruthy();
    expect(document.getElementById('queue-last-btn')).toBeTruthy();
    expect(document.querySelector('[aria-label="Reader settings"]')).toBeTruthy();
    expect(document.getElementById('language-select')).toBeTruthy();
    expect(document.getElementById('language-status')).toBeTruthy();
    expect(document.getElementById('download-voice-btn')).toBeNull();
    expect(document.getElementById('speed')?.closest('#reader-settings')).toBeTruthy();
    expect(document.getElementById('custom-voice-model-settings')).toBeNull();
    expect(document.getElementById('custom-voice-panel')).toBeNull();
    expect(document.getElementById('advanced-playback-settings')).toBeNull();
    expect(document.getElementById('tts-performance-profile-select')).toBeNull();
    expect(document.getElementById('tts-backend-preference-select')).toBeNull();
    expect(document.getElementById('idle-release-enabled')).toBeNull();
    expect(document.getElementById('section-pause-settings')).toBeTruthy();
    expect(document.getElementById('section-pause')).toBeTruthy();
    expect(document.getElementById('highlight-settings')).toBeTruthy();
    expect(document.getElementById('highlight-settings')?.hidden).toBe(false);
    expect(document.getElementById('highlight-settings')?.dataset.locked).toBeUndefined();
    expect(document.getElementById('highlight-area-color')?.getAttribute('type')).toBe('color');
    expect(document.getElementById('highlight-word-color')?.getAttribute('type')).toBe('color');
    expect(document.getElementById('highlight-area-opacity')?.getAttribute('type')).toBe('range');
    expect(document.getElementById('highlight-word-opacity')?.getAttribute('type')).toBe('range');
    expect(document.getElementById('highlight-area-color')?.disabled).toBe(false);
    expect(document.getElementById('highlight-word-opacity')?.disabled).toBe(false);
    expect(document.getElementById('skip-code-settings')).toBeTruthy();
    expect(document.getElementById('skip-code-settings')?.hidden).toBe(false);
    expect(document.getElementById('skip-code-settings')?.dataset.locked).toBeUndefined();
    expect(document.getElementById('skip-code-snippets')?.getAttribute('type')).toBe('checkbox');
    expect(document.getElementById('skip-code-snippets')?.disabled).toBe(false);
    expect(document.getElementById('activate-pro-card')).toBeNull();
    expect(document.getElementById('reading-progress')?.getAttribute('aria-valuenow')).toBe('0');
    expect(document.getElementById('reading-state-label')?.getAttribute('aria-live')).toBe('polite');
    expect(document.querySelector('.minimized-view')).toBeNull();
    expect(document.getElementById('floating-reader-hint')).toBeNull();
    expect(document.querySelector('.controls .chevron')).toBeTruthy();
    expect(document.querySelector('.transcript-card')?.dataset.advancedOnly).toBeDefined();
    expect(document.querySelector('.transcript-card')?.hasAttribute('open')).toBe(false);
    expect(document.getElementById('queue-card')).toBeTruthy();
    expect(document.getElementById('article-meta')?.textContent).toBe('Open an article, then read the page');
    expect(document.getElementById('resume-prompt')).toBeTruthy();
    expect(document.getElementById('resume-read-btn')).toBeTruthy();
    expect(document.getElementById('resume-start-over-btn')).toBeTruthy();
    expect(document.getElementById('code-suggestion')).toBeTruthy();
    expect(document.getElementById('code-suggestion-accept')).toBeTruthy();
    expect(html).not.toContain('855 words');
    expect(html).not.toContain('~6 min');
  });

  it('keeps active playback in one compact sticky player surface', () => {
    const html = readFileSync(new URL('../../src/reader-engine.html', import.meta.url), 'utf8');
    const css = normalizeLineEndings(readFileSync(new URL('../../src/reader-engine.css', import.meta.url), 'utf8'));
    const document = new JSDOM(html, { url: 'https://example.test/' }).window.document;

    const playerShell = document.querySelector('.player-shell');
    expect(playerShell).toBeTruthy();
    expect(document.querySelector('.player-shell .player-strip')).toBeTruthy();
    expect(document.querySelector('.player-shell .controls-row')).toBeTruthy();
    expect(document.getElementById('read-btn')?.closest('.player-shell')).toBe(playerShell);
    expect(document.getElementById('prev-btn')?.closest('.player-shell')).toBe(playerShell);
    expect(document.getElementById('stop-btn')?.closest('.player-shell')).toBe(playerShell);
    expect(document.getElementById('next-btn')?.closest('.player-shell')).toBe(playerShell);
    expect(css).toContain('.panel.is-reading .player-shell');
    expect(css).toContain('.panel.is-reading .controls-row');
    expect(css).toContain('position: sticky;');
    expect(css).toContain('position: static;');
  });

  it('defaults Simple mode to a visible collapsed Settings row', () => {
    const html = readFileSync(new URL('../../src/reader-engine.html', import.meta.url), 'utf8');
    const document = new JSDOM(html, { url: 'https://example.test/' }).window.document;

    const readerSettings = document.getElementById('reader-settings');
    expect(readerSettings?.hasAttribute('open')).toBe(false);
    expect(readerSettings?.querySelector('summary')?.textContent).toContain('Voice settings');
    expect(readerSettings?.querySelector('summary')?.textContent).not.toContain('Change');
    expect(document.getElementById('voice-select')?.closest('#reader-settings')).toBe(readerSettings);
    expect(document.getElementById('voice-settings-summary')?.textContent).toContain('Heart');
    expect(document.getElementById('voice-settings-summary')?.textContent).toContain('English');
    expect(document.getElementById('voice-settings-summary')?.textContent).toContain('1.00x');

    expect(document.getElementById('activate-pro-card')).toBeNull();
  });

  it('keeps the icon-triggered recovery card in one readable grid column', () => {
    const css = normalizeLineEndings(readFileSync(new URL('../../src/reader-engine.css', import.meta.url), 'utf8'));

    expect(css).toContain('.error-notice {\n  grid-template-columns: 1fr;');
  });

  it('keeps the idle panel focused on one primary read action', () => {
    const view = getPanelView({ state: 'idle' });

    expect(view.subtitle).toBe('Read this page aloud');
    expect(view.statusText).toBe('Ready to read');
    expect(view.mode).toBe('idle');
    expect(view.statusTone).toBe('ready');
    expect(view.primaryAction).toEqual({ label: 'Read page', disabled: false });
    expect(view.secondaryActions).toEqual([]);
    expect(view.upgradeCta).toBeUndefined();
  });

  it('uses stateful reading controls while playback is active or paused', () => {
    expect(getPanelView({ state: 'preparing' }).primaryAction).toEqual({
      label: 'Preparing voice...',
      disabled: true,
    });
    expect(getPanelView({ state: 'stopping' }).primaryAction).toEqual({
      label: 'Stopping...',
      disabled: true,
    });
    expect(getPanelView({ state: 'stopping' }).statusText).toBe('Stopping read...');

    const reading = getPanelView({
      state: 'reading',
      currentChunk: 2,
      totalChunks: 5,
    });
    expect(reading.subtitle).toBe('Reading current page');
    expect(reading.statusText).toBe('Reading page...');
    expect(reading.mode).toBe('reading');
    expect(reading.statusTone).toBe('reading');
    expect(reading.primaryAction).toEqual({ label: 'Pause', disabled: false });
    expect(reading.secondaryActions).toEqual([{ id: 'stop', label: 'Stop' }]);
    expect(reading.progressPercent).toBe(40);
    expect(reading.progressLabel).toBe('40% complete');
    expect(reading.remainingLabel).toBe('3 chunks left');

    const paused = getPanelView({ state: 'paused', currentChunk: 2, totalChunks: 5 });
    expect(paused.statusText).toBe('Paused');
    expect(paused.mode).toBe('reading');
    expect(paused.statusTone).toBe('paused');
    expect(paused.primaryAction).toEqual({ label: 'Resume', disabled: false });
    expect(paused.secondaryActions).toEqual([{ id: 'stop', label: 'Stop' }]);
    expect(paused.progressLabel).toBe('40% complete');
  });

  it('uses selected-text copy while selected content is being read', () => {
    const preparing = getPanelView({
      state: 'preparing',
      source: 'selection',
    });

    expect(preparing.subtitle).toBe('Preparing selected text');
    expect(preparing.statusText).toBe('Preparing selected text');

    const reading = getPanelView({
      state: 'reading',
      source: 'selection',
      currentChunk: 1,
      totalChunks: 3,
    });

    expect(reading.subtitle).toBe('Reading selected text');
    expect(reading.statusText).toBe('Reading selected text...');
    expect(reading.primaryAction).toEqual({ label: 'Pause', disabled: false });

    const paused = getPanelView({
      state: 'paused',
      source: 'selection',
      currentChunk: 1,
      totalChunks: 3,
    });

    expect(paused.subtitle).toBe('Selected text paused');
    expect(paused.statusText).toBe('Paused');
  });

  it('renders experimental voice packs under a labeled voice picker group', () => {
    const script = readReaderEngineSourceSurface();

    expect(script).toContain("groupVoicesByQuality");
    expect(script).toContain("document.createElement('optgroup')");
    expect(script).toContain('Experimental - quality not validated');
    expect(script).toContain('formatVoiceOptionLabel');
  });

  it('uses edge-to-edge toolbar player layout with sticky chrome instead of a centered floating card', () => {
    const css = normalizeLineEndings(readFileSync(new URL('../../src/reader-engine.css', import.meta.url), 'utf8'));

    expect(css).toContain('.app-shell {\n  display: block;');
    expect(css).toContain('min-height: 100dvh;');
    expect(css).toContain('.panel {\n  width: 100%;');
    expect(css).toContain('max-width: none;');
    expect(css).toContain('border-radius: 0;');
    expect(css).toContain('box-shadow: none;');
    expect(css).toContain('.header {\n  position: sticky;');
    expect(css).toContain('.controls-row {\n  position: sticky;');
    expect(css).not.toContain('.app-shell {\n  display: flex;');
    expect(css).not.toContain('transition: width 220ms');
  });

  it('keeps the reading indicator still so the extension panel does not wobble', () => {
    const css = readFileSync(new URL('../../src/reader-engine.css', import.meta.url), 'utf8');

    expect(css).not.toContain('@keyframes equalize');
    expect(css).not.toContain('animation: equalize');
    expect(css).not.toContain('animation-play-state');
  });
});
