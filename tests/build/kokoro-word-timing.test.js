import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createAlignedWordTimings } from '../../src/lib/speech-audio.js';
import { createBrowserKokoroBackend } from '../../src/tts/kokoro/runtime.js';
import { createEnglishPhonemizer } from '../../src/tts/kokoro/english-phonemizer.js';
import { createKokoroTokenizer } from '../../src/tts/kokoro/tokenizer.js';
import { Tensor } from '../../src/engines/browser-inference.js';

it('aligns batch and streaming words to the actual original US/UK pronunciation and token IDs', async () => {
  const tokenizer = createKokoroTokenizer(JSON.parse(readFileSync('vendor/pronunciation/kokoro-tokenizer.json')),
    JSON.parse(readFileSync('vendor/pronunciation/kokoro-tokenizer_config.json')));
  const phonemizer = await createEnglishPhonemizer({ wasmBinary: readFileSync('public/assets/phonemizer/english.wasm'),
    pronunciationData: readFileSync('public/assets/phonemizer/pronunciations.bin') });
  const inputs = [];
  const session = { run: async feeds => {
    inputs.push(new BigInt64Array(feeds.input_ids.data));
    return { waveform: new Tensor('float32', new Float32Array(24000).fill(.1), [24000]) };
  }, release: async () => {} };
  const tts = createBrowserKokoroBackend({ tokenizer, phonemizer, session, Tensor, loadStyle: async () => new Float32Array(510 * 256) });
  try {
    for (const voice of ['af_heart', 'bf_emma']) for (const text of ['Read this sentence.', 'One; four.']) {
      const batch = await tts.generate(text, { voice }), [streamed] = await Array.fromAsync(tts.stream(text, { voice }));
      expect(batch.phonemes).toBe(streamed.phonemes);
      expect(inputs.at(-1)).toEqual(tokenizer.encode(batch.phonemes, { strict: true }));
      expect(inputs.at(-2)).toEqual(inputs.at(-1));
      const batchTimings = createAlignedWordTimings(text, 1, batch), streamedTimings = createAlignedWordTimings(text, 1, streamed);
      expect(batchTimings).toEqual(streamedTimings);
      expect(batchTimings).toHaveLength(text.split(/\s+/).length);
      expect(batchTimings.every(({ source }) => source === 'phoneme-estimated')).toBe(true);
    }
  } finally { await tts.dispose(); }
});
