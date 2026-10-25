import { describe, expect, it } from 'vitest';
import { synthesizeSpeechChunk } from '../../src/lib/speech-audio.js';

const pcm = (duration, start = 0, end = duration) => ({
  audio: Float32Array.from({ length: duration * 1000 }, (_, i) => i >= start * 1000 && i < end * 1000 ? 0.2 : 0),
  sampling_rate: 1000,
});

describe('voice word timing regressions', () => {
  it.each([0.2, 0.6])('uses the audible window for built-in voices with %ss of leading silence', async (start) => {
    const audio = pcm(3, start, 2.2);
    const builtIn = await synthesizeSpeechChunk({ generate: async () => audio }, 'Hello world', { useStream: false });
    expect(builtIn.wordTimings[0].start).toBeCloseTo(start - 0.04);
    expect(builtIn.wordTimings.at(-1).end).toBeCloseTo(2.24);
  });


  it('uses the same speech window for a streamed sentence and a generated sentence', async () => {
    const audio = pcm(3, 0.4, 2);
    const tts = { generate: async () => audio, async *stream() { yield { text: 'Hello world', audio }; } };
    const generated = await synthesizeSpeechChunk(tts, 'Hello world', { useStream: false });
    const streamed = await synthesizeSpeechChunk(tts, 'Hello world');
    expect(streamed.wordTimings).toEqual(generated.wordTimings);
    expect(streamed.wordTimings.at(-1).end).toBeCloseTo(2.04);
  });

  it.each(['short', 'error'])('keeps per-segment voice timing when retrying a %s generation', async (failure) => {
    const text = 'First extraordinarilylongsentence. Second extraordinarilylongsentence.';
    const tts = { generate: async (part) => {
      if (part === text) {
        if (failure === 'error') throw new Error('Batch failed');
        return pcm(0.01);
      }
      const first = part.startsWith('First');
      return {
        ...pcm(first ? 1 : 3),
        wordTimings: first
          ? [{ text: 'First', start: 0.1, end: 0.4 }, { text: 'extraordinarilylongsentence', start: 0.5, end: 0.8 }]
          : [{ text: 'Second', start: 0.7, end: 1.3 }, { text: 'extraordinarilylongsentence', start: 1.5, end: 2.6 }],
      };
    } };
    const speech = await synthesizeSpeechChunk(tts, text, { useStream: false });
    expect(speech.wordTimings.map(({ start, end }) => [start, end])).toEqual([[0.1, 0.4], [0.5, 0.8], [1.7, 2.3], [2.5, 3.6]]);
    expect(speech.durationSeconds).toBe(4);
  });

});
