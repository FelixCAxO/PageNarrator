// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { KOKORO_PHONE_BY_ID } from './phoneme-vocabulary.js';
import { KOKORO_DATA } from './model-data.js';

/** @param {string} text @param {RegExp|null} pattern @returns {string[]} */
function sourceSegments(text, pattern) {
  if (pattern === null) {
    /** @type {string[]} */
    const segments = [];
    for (const { segment } of new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)) {
      const previous = segments.at(-1) ?? '';
      // ICU splits titles and initials before names; keep their original source in one inference chunk.
      const continuation = !/\n\s*\n/.test(previous.match(/\s*$/u)?.[0] ?? '') && (
        (/\b(?:dr|prof|mr|mrs|ms|st|sr|jr)\.\s*$/iu.test(previous) && /^\s*\p{L}/u.test(segment))
        || (/(?:^|[\s(])(?:[A-Z]\.)+\s*$/u.test(previous) && !/\b[AP]\.M\.\s*$/u.test(previous) && /^\s*\p{Lu}/u.test(segment))
        || (/\b(?:figs?|tabs?|eqs?|secs?|no|vol|pp|p)\.\s*$/iu.test(previous) && /^\s*\d/u.test(segment))
        || (/\b(?:et al|e\.g|i\.e)\.\s*$/iu.test(previous) && /^\s*\p{L}/u.test(segment)));
      if (continuation) segments[segments.length - 1] += segment;
      else segments.push(segment);
    }
    return segments;
  }
  if (!(pattern instanceof RegExp)) throw new Error('Kokoro split_pattern must be a regular expression.');
  const regex = new RegExp(pattern.source, `${pattern.flags.replaceAll('g', '').replaceAll('y', '')}g`);
  const result = []; let offset = 0;
  for (const match of text.matchAll(regex)) {
    if (!match[0].length) throw new Error('Kokoro split_pattern must consume text.');
    const end = match.index + match[0].length;
    result.push(text.slice(offset, end)); offset = end;
  }
  if (offset < text.length) result.push(text.slice(offset));
  return result;
}

/** @param {string} source */
function sourceSplit(source) {
  const middle = Math.floor(source.length / 2);
  let split = source.lastIndexOf(' ', middle);
  if (split <= 0) split = source.indexOf(' ', middle);
  if (split <= 0 || split >= source.length - 1) throw new RangeError('Kokoro word is too long; split the input.');
  return split + 1;
}

/** First-party Kokoro adapter. Inference and phonemization are injected, never silently substituted.
 * @param {any} dependencies */
export function createBrowserKokoroBackend({ session, tokenizer, phonemizer, Tensor, loadStyle }) {
  let closed = false;
  /** @type {Promise<void>|null} */
  let disposal = null;
  const pending = new Set(), styles = new Map();
  const voices = Object.freeze(Object.fromEntries(KOKORO_DATA.files.filter(file => file.path.startsWith('voices/')).map(file => {
    const id = file.path.slice(7, -4); return [id, { name: id, language: id.startsWith('b') ? 'en-gb' : 'en-us' }];
  })));
  /** @param {AbortSignal|null} [signal] */
  function check(signal = null) {
    if (closed) throw new Error('Kokoro model has been disposed.');
    if (signal?.aborted) throw new DOMException('Kokoro synthesis was aborted.', 'AbortError');
  }
  function voiceInfo(/** @type {string} */ voice) {
    if (!Object.hasOwn(voices, voice)) throw new Error(`Unknown Kokoro voice: ${voice}.`);
    const info = voices[voice];
    return info;
  }
  async function style(/** @type {string} */ voice, /** @type {AbortSignal|null} */ signal = null) {
    if (!styles.has(voice)) {
      const task = loadStyle(voice, ...(signal ? [{ signal }] : [])).then((/** @type {Float32Array} */ value) => {
        if (!(value instanceof Float32Array) || value.length !== 510 * 256 || !value.every(Number.isFinite)) throw new Error('Invalid Kokoro style data.');
        return value;
      }).catch((/** @type {unknown} */ error) => {
        styles.delete(voice);
        signal?.throwIfAborted();
        throw Object.assign(new Error(`Could not prepare Kokoro voice ${voice}.`, { cause: error }), { code: 'voice_style_download_failed' });
      });
      styles.set(voice, task);
    }
    return styles.get(voice);
  }
  const backend = {
    model: session, tokenizer, voices,
    list_voices: () => voices,
    /** Prepare through the same pinned style loader that synthesis uses.
     * @param {string} [voice] @param {{signal?: AbortSignal|null}} [options] */
    async prepareVoice(voice = 'af_heart', { signal = null } = {}) {
      check(signal); voiceInfo(voice);
      const task = (async () => { await style(voice, signal); check(signal); return { voice, prepared: true }; })();
      pending.add(task);
      try { return await task; } finally { pending.delete(task); }
    },
    /** @param {BigInt64Array|{data: BigInt64Array}} ids @param {{voice?:string,speed?:number,signal?:AbortSignal|null}} [options] */
    async generate_from_ids(ids, { voice = 'af_heart', speed = 1, signal = null } = {}) {
      check(signal); voiceInfo(voice);
      const data = ids instanceof BigInt64Array ? ids : ids?.data;
      if (!(data instanceof BigInt64Array) || data.length < 3 || data.length > 512 || data[0] !== 0n || data.at(-1) !== 0n
        || Array.from(data).some(id => !Object.hasOwn(KOKORO_PHONE_BY_ID, String(id)))) throw new Error('Invalid Kokoro phoneme ID sequence.');
      if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) throw new RangeError('Kokoro synthesis speed must be between 0.25 and 4.');
      const task = (async () => {
        const dataStyle = await style(voice, signal); check(signal);
        // The existing API selects by phone count, clamped to the 510-row style table.
        const row = Math.min(509, data.length - 2);
        const feeds = { input_ids: new Tensor('int64', data, [1, data.length]),
          style: new Tensor('float32', dataStyle.subarray(row * 256, (row + 1) * 256), [1, 256]),
          speed: new Tensor('float32', Float32Array.of(speed), [1]) };
        let result;
        try {
          result = await session.run(feeds, ['waveform']); check(signal);
          const output = result.waveform;
          const audio = await output?.getData(); check(signal);
          if (!(audio instanceof Float32Array) || !audio.length || !audio.every(Number.isFinite)) throw new Error('Kokoro returned empty or non-finite audio.');
          return { audio: new Float32Array(audio), sampling_rate: 24000 };
        } finally {
          for (const tensor of Object.values(feeds)) tensor.dispose();
          if (result) for (const tensor of Object.values(result)) tensor.dispose();
        }
      })();
      pending.add(task);
      try { return await task; } finally { pending.delete(task); }
    },
    /** @param {string} text @param {{voice?:string,speed?:number,signal?:AbortSignal|null,split_pattern?:RegExp|null}} [options] */
    async *stream(text, { voice = 'af_heart', speed = 1, signal = null, split_pattern = null } = {}) {
      check(signal);
      if (typeof text !== 'string' || !text.trim()) throw new Error('Kokoro needs non-empty text.');
      const info = voiceInfo(voice), dialect = info.language;
      /** @param {string} source @returns {AsyncGenerator<{text:string,phonemes:string,audio:any}>} */
      async function* segment(source) {
        check(signal);
        if (source.length > 16_384) {
          const split = sourceSplit(source);
          yield* segment(source.slice(0, split)); yield* segment(source.slice(split)); return;
        }
        const phones = await phonemizer.phonemizeText(source, dialect); check(signal);
        if (!phones.trim()) return;
        let ids;
        try { ids = tokenizer.encode(phones, { strict: true }); }
        catch (error) {
          if (!(error instanceof RangeError)) throw error;
          const split = sourceSplit(source);
          yield* segment(source.slice(0, split)); yield* segment(source.slice(split)); return;
        }
        const audio = await backend.generate_from_ids(ids, { voice, speed, signal });
        yield { text: source, phonemes: phones, audio: { ...audio, phonemes: phones } };
      }
      for (const source of sourceSegments(text, split_pattern)) yield* segment(source);
    },
    /** @param {string} text @param {{voice?:string,speed?:number,signal?:AbortSignal|null,split_pattern?:RegExp|null}} [options] */
    async generate(text, options = {}) {
      const chunks = [];
      for await (const chunk of backend.stream(text, options)) chunks.push(chunk);
      check(options.signal);
      if (!chunks.length) throw new Error('Kokoro text contains no supported speech.');
      const samples = chunks.reduce((sum, chunk) => sum + chunk.audio.audio.length, 0);
      const audio = new Float32Array(samples); let offset = 0;
      for (const chunk of chunks) { audio.set(chunk.audio.audio, offset); offset += chunk.audio.audio.length; }
      return { audio, sampling_rate: 24000, phonemes: chunks.map(chunk => chunk.phonemes).join(' ') };
    },
    dispose() {
      if (!disposal) {
        closed = true; styles.clear();
        disposal = (async () => {
          await Promise.allSettled([...pending]);
          const results = await Promise.allSettled([session.release(), phonemizer.dispose()]);
          const failed = results.find(result => result.status === 'rejected');
          if (failed) throw failed.reason;
        })();
      }
      return disposal;
    },
  };
  return backend;
}
