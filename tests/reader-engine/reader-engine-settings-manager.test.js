import { describe, expect, it, vi } from 'vitest';
import { createReaderEngineSettingsManager } from '../../src/lib/reader-engine-settings-manager.js';

function createRangeElement(value = '1') {
  return {
    value,
    max: '',
    textContent: '',
    addEventListener: vi.fn(),
  };
}

describe('readerEngine settings manager', () => {
  it('clamps playback speed, updates active media, and persists through the adapter', () => {
    const savePlaybackSettings = vi.fn();
    const currentAudio = { playbackRate: 1 };
    const els = {
      speed: createRangeElement('1'),
      speedOut: { textContent: '' },
      panel: { classList: { contains: () => false } },
    };
    const manager = createReaderEngineSettingsManager({
      els,
      storage: { savePlaybackSettings },
      getCurrentAudio: () => currentAudio,
    });

    manager.setPlaybackSpeed(99);

    expect(els.speed.max).toBe('3');
    expect(els.speed.value).toBe('3');
    expect(els.speedOut.textContent).toBe('3.00x');
    expect(currentAudio.playbackRate).toBe(3);
    expect(savePlaybackSettings).toHaveBeenCalledWith({ speed: 3 });
  });

  it('can apply popup storage speed and section-pause changes without writing them back', () => {
    const savePlaybackSettings = vi.fn();
    const currentAudio = { playbackRate: 1 };
    const els = {
      speed: createRangeElement('1'),
      speedOut: { textContent: '' },
      sectionPause: createRangeElement('0'),
      sectionPauseOut: { textContent: '' },
      panel: { classList: { contains: () => false } },
    };
    const manager = createReaderEngineSettingsManager({
      els,
      storage: { savePlaybackSettings },
      getPro: () => true,
      getCurrentAudio: () => currentAudio,
    });

    manager.setPlaybackSpeed(1.75, { persist: false });
    manager.setSectionPause(-0.4, { persist: false });

    expect(els.speed.value).toBe('1.75');
    expect(els.speedOut.textContent).toBe('1.75x');
    expect(currentAudio.playbackRate).toBe(1.75);
    expect(els.sectionPause.value).toBe('-0.4');
    expect(els.sectionPauseOut.textContent).toBe('Faster');
    expect(savePlaybackSettings).not.toHaveBeenCalled();
  });

  it('debounces highlight setting writes from rapid input changes', () => {
    vi.useFakeTimers();
    const savePlaybackSettings = vi.fn();
    const configurePageHighlight = vi.fn(() => Promise.resolve());
    const els = {
      highlightAreaColor: { value: '#ff0000' },
      highlightAreaOpacity: { value: '0.25' },
      highlightWordColor: { value: '#00ff00' },
      highlightWordOpacity: { value: '0.5' },
      highlightAreaOpacityOut: { textContent: '' },
      highlightWordOpacityOut: { textContent: '' },
    };
    const manager = createReaderEngineSettingsManager({
      els,
      storage: { savePlaybackSettings },
      getPro: () => true,
      configurePageHighlight,
      debounceMs: 150,
    });

    manager.handleHighlightSettingsInput();
    els.highlightAreaOpacity.value = '0.35';
    manager.handleHighlightSettingsInput();
    vi.advanceTimersByTime(149);
    expect(savePlaybackSettings).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(savePlaybackSettings).toHaveBeenCalledTimes(1);
    expect(savePlaybackSettings).toHaveBeenCalledWith({
      highlight: {
        area: { color: '#ff0000', opacity: 0.35 },
        word: { color: '#00ff00', opacity: 0.5 },
      },
    });
    expect(configurePageHighlight).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
