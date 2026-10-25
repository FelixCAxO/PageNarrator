import { createAudio, createWindowedAudio, getDuration, expectDutchFinalEWordBudget } from './speech-audio.fixtures.js';
import { describe, expect, it } from "vitest";
import { createAlignedWordTimings, estimateWordTimings, synthesizeSpeechChunk, synthesizeSpeechSegments } from "../../src/lib/speech-audio.js";

describe('speech audio synthesis', () => {
  it('keeps short function words visible long enough during normal speech', () => {
    const timings = estimateWordTimings('This is a simple reading test', 3);
    const words = ['This', 'is', 'a', 'simple', 'reading', 'test'];
    const durations = Object.fromEntries(timings.map((timing, index) => [
      words[index],
      timing.end - timing.start,
    ]));

    expect(durations.is).toBeGreaterThanOrEqual(0.28);
    expect(durations.a).toBeGreaterThanOrEqual(0.22);
  });

  it('counts accented French vowels when estimating word durations', () => {
    const accented = estimateWordTimings('génération problèmes résolution', 3);
    const ascii = estimateWordTimings('generation problemes resolution', 3);
    const accentedDurations = accented.map((timing) => timing.end - timing.start);
    const asciiDurations = ascii.map((timing) => timing.end - timing.start);

    accentedDurations.forEach((duration, index) => {
      expect(duration / asciiDurations[index]).toBeGreaterThan(0.9);
      expect(duration / asciiDurations[index]).toBeLessThan(1.1);
    });
  });

  it('uses Dutch speech units instead of English silent-e rules for fallback timing', () => {
    const text = 'De kunstmatige intelligentie groeit';
    const generic = estimateWordTimings(text, 4);
    const dutch = estimateWordTimings(text, 4, { languageCode: 'nl' });
    const genericDuration = generic[1].end - generic[1].start;
    const dutchDuration = dutch[1].end - dutch[1].start;

    expect(dutchDuration).toBeGreaterThan(genericDuration * 1.05);
  });

  it.each([
    { languageCode: 'de', text: 'Die leise Lage bleibt', index: 1 },
    { languageCode: 'fr', text: 'Le caf\u00e9 livre', index: 1 },
    { languageCode: 'nl', text: 'De vrijwillige keuze groeit', index: 2 },
    { languageCode: 'sv', text: 'Ett leende v\u00e4xer', index: 1 },
  ])('uses $languageCode timing rules instead of generic English fallback', ({ languageCode, text, index }) => {
    const generic = estimateWordTimings(text, 4);
    const localized = estimateWordTimings(text, 4, { languageCode });

    expect(getDuration(localized, index)).toBeGreaterThan(getDuration(generic, index) * 1.15);
    expect(localized.at(-1).end).toBeCloseTo(4);
  });

  it('passes languageCode into combined Kokoro stream word timing', async () => {
    const text = 'De vrijwillige keuze groeit';
    const tts = {
      async *stream() {
        yield { text, audio: createAudio(96000, 24000) };
      },
    };

    const speech = await synthesizeSpeechChunk(tts, text, {
      voice: 'af_heart',
      languageCode: 'nl',
    });

    expectDutchFinalEWordBudget(speech.wordTimings, text, 4);
  });

  it('passes languageCode into progressive Kokoro segment word timing', async () => {
    const text = 'De vrijwillige keuze groeit';
    const tts = {
      async *stream() {
        yield { text, audio: createAudio(96000, 24000) };
      },
    };

    const iterator = synthesizeSpeechSegments(tts, text, {
      voice: 'af_heart',
      languageCode: 'nl',
    })[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(first.done).toBe(false);
    expectDutchFinalEWordBudget(first.value.wordTimings, text, 4);
  });

  it('passes languageCode into generated and retry-split word timing', async () => {
    const text = 'De vrijwillige keuze groeit';
    const generatedTts = {
      async generate() {
        return createAudio(96000, 24000);
      },
    };
    const generated = await synthesizeSpeechChunk(generatedTts, text, {
      voice: 'af_heart',
      languageCode: 'nl',
    });
    expectDutchFinalEWordBudget(generated.wordTimings, text, 4);

    const retryText = `${text}. ${text}. ${text}.`;
    const retryTts = {
      calls: 0,
      async generate() {
        this.calls += 1;
        return this.calls === 1
          ? createAudio(1200, 24000)
          : createAudio(48000, 24000);
      },
    };

    const retried = await synthesizeSpeechChunk(retryTts, retryText, {
      voice: 'af_heart',
      languageCode: 'nl',
    });

    expect(retryTts.calls).toBe(3);
    expectDutchFinalEWordBudget(retried.wordTimings, retryText, 4);
  });

  it('uses Kokoro-style phoneme strings for phoneme-aware word timing', () => {
    const timings = createAlignedWordTimings('alpha beta', 2, {
      phonemes: 'abcdefghijklmnop q',
    });

    expect(timings.map((timing) => timing.source)).toEqual(['phoneme-estimated', 'phoneme-estimated']);
    expect(getDuration(timings, 0)).toBeGreaterThan(getDuration(timings, 1) * 6);
  });

  it('anchors generated word timings to the active speech window instead of trailing silence', async () => {
    const tts = {
      async generate() {
        return {
          ...createWindowedAudio({
            leadingSeconds: 0.2,
            activeSeconds: 1.4,
            trailingSeconds: 1.1,
          }),
          phonemes: 'w aa n t uw th r iy',
        };
      },
    };

    const speech = await synthesizeSpeechChunk(tts, 'one two three', {
      voice: 'af_heart',
      languageCode: 'en',
    });

    expect(speech.durationSeconds).toBeCloseTo(2.7);
    expect(speech.wordTimings[0].start).toBeGreaterThanOrEqual(0.16);
    expect(speech.wordTimings.at(-1).end).toBeLessThanOrEqual(1.68);
    expect(speech.wordTimings.every((timing) => timing.source === 'phoneme-estimated')).toBe(true);
  });

  it('keeps accented French final e protected from the silent-e rule', () => {
    const timings = estimateWordTimings('caf\u00e9 livre', 3, { languageCode: 'fr' });

    expect(getDuration(timings, 0)).toBeGreaterThan(getDuration(timings, 1) * 1.25);
  });

  it('budgets spoken time for numerals and short initialisms', () => {
    const words = ['PDF', 'was', '8.11', 'in', '2026', 'today'];
    const timings = estimateWordTimings(words.join(' '), 6);
    const durations = Object.fromEntries(timings.map((timing, index) => [
      words[index],
      timing.end - timing.start,
    ]));

    expect(durations.PDF).toBeGreaterThan(durations.was * 1.5);
    expect(durations['8.11']).toBeGreaterThan(durations.was * 2);
    expect(durations['2026']).toBeGreaterThan(durations.was * 2);
  });

  it('keeps number-led textbook problem timings near hand-counted speech units', () => {
    const text = '**8.11** Game: nine heads and tails. The matrix has 0 (heads) and 1 (tails).';
    const timings = estimateWordTimings(text, 10);

    expect(timings[4].end).toBeGreaterThanOrEqual(3.7);
    expect(timings[4].end).toBeLessThanOrEqual(4.3);
    expect(timings[4].start).toBeGreaterThanOrEqual(timings[3].end);
    expect(timings[4].end).toBeLessThanOrEqual(timings[5].start);
  });

  it('caps long technical words after budgeting more than five syllables', () => {
    const timings = estimateWordTimings('short pneumonoultramicroscopicsilicovolcanoconiosis done', 3);
    const longWordDuration = timings[1].end - timings[1].start;

    expect(longWordDuration).toBeGreaterThan(1.95);
    expect(longWordDuration).toBeLessThan(2.4);
    expect(timings.at(-1).end).toBeLessThanOrEqual(3);
  });

  it('reserves punctuation pauses so word timing does not drift early in long sentence runs', () => {
    const timings = estimateWordTimings('One. Two. Three. Four. Five.', 5);

    expect(timings[1].start - timings[0].end).toBeCloseTo(0.45);
    expect(timings[4].start).toBeGreaterThanOrEqual(4.3);
    expect(timings[4].start).toBeLessThanOrEqual(4.4);
    expect(timings.at(-1).end).toBeCloseTo(5);
  });

  it('reserves a smaller but visible pause for commas and semicolons', () => {
    const timings = estimateWordTimings('One, two; three: four.', 3);

    expect(timings[1].start - timings[0].end).toBeCloseTo(0.12);
    expect(timings[2].start - timings[1].end).toBeCloseTo(0.12);
    expect(timings[3].start - timings[2].end).toBeCloseTo(0.12);
  });

  it('keeps estimated timings valid when punctuation pauses would exceed duration', () => {
    const timings = estimateWordTimings('one, two, three, four, five, six, seven, eight, nine, ten.', 1);

    expect(timings).toHaveLength(10);
    timings.forEach((timing) => {
      expect(timing.start).toBeGreaterThanOrEqual(0);
      expect(timing.end).toBeGreaterThan(timing.start);
      expect(timing.end).toBeLessThanOrEqual(1);
    });
    for (let index = 1; index < timings.length; index += 1) {
      expect(timings[index].start).toBeGreaterThanOrEqual(timings[index - 1].end);
    }
  });

  it('retries with smaller chunks when generated audio is clearly truncated', async () => {
    const calls = [];
    const tts = {
      async generate(text) {
        calls.push(text);
        return calls.length === 1
          ? createAudio(2400, 24000)
          : createAudio(24000, 24000);
      },
    };

    const speech = await synthesizeSpeechChunk(tts, 'This chunk is long enough that one tenth of a second is suspiciously short for speech.');

    expect(calls).toHaveLength(3);
    expect(calls[1].length).toBeLessThan(calls[0].length);
    expect(calls[2].length).toBeLessThan(calls[0].length);
    expect(speech.blob).toBeInstanceOf(Blob);
    expect(speech.wordTimings.length).toBeGreaterThan(0);
  });
});
