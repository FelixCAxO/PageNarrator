import { afterEach, describe, expect, it, vi } from 'vitest';

describe('central Web Speech test harness', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits deterministic utterance lifecycle and boundary events', async () => {
    vi.useFakeTimers();
    const utterance = new SpeechSynthesisUtterance('alpha beta');
    const events = [];
    utterance.onstart = () => events.push(['start']);
    utterance.onboundary = (event) => events.push(['boundary', event.charIndex, event.charLength, event.name]);
    utterance.onend = () => events.push(['end']);

    speechSynthesis.speak(utterance);
    await vi.runAllTimersAsync();

    expect(events).toEqual([
      ['start'],
      ['boundary', 0, 5, 'word'],
      ['boundary', 6, 4, 'word'],
      ['end'],
    ]);
    expect(speechSynthesis.__getSpokenUtterances()).toEqual([utterance]);
  });

  it('can reset queued and spoken utterances between tests', () => {
    speechSynthesis.speak(new SpeechSynthesisUtterance('first'));
    expect(speechSynthesis.pending).toBe(true);

    speechSynthesis.__reset();

    expect(speechSynthesis.pending).toBe(false);
    expect(speechSynthesis.speaking).toBe(false);
    expect(speechSynthesis.__getSpokenUtterances()).toEqual([]);
  });
});
