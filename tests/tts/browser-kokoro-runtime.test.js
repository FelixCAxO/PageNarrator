import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Tensor } from '../../src/engines/browser-inference.js';
import { createBrowserKokoroBackend } from '../../src/tts/kokoro/runtime.js';
import { createKokoroTokenizer } from '../../src/tts/kokoro/tokenizer.js';
import { createKokoroDataLoader, loadBrowserKokoroBackend } from '../../src/tts/kokoro/model-loader.js';
import { KOKORO_DATA } from '../../src/tts/kokoro/model-data.js';

const tokenizerJson = JSON.parse(readFileSync('vendor/pronunciation/kokoro-tokenizer.json'));
const tokenizerConfig = JSON.parse(readFileSync('vendor/pronunciation/kokoro-tokenizer_config.json'));
function make(options = {}) {
  const rows = new Float32Array(510 * 256);
  for (let i = 0; i < 510; i++) rows.fill(i, i * 256, (i + 1) * 256);
  const phonemizer = { phonemizeText: vi.fn(async () => 'wˈʌn'), dispose: vi.fn() };
  const session = { run: vi.fn(async () => ({ waveform: new Tensor('float32', Float32Array.of(0, .25, 0), [3]) })), release: vi.fn() };
  const loadStyle = vi.fn(async () => rows);
  const engine = createBrowserKokoroBackend({ session, phonemizer, Tensor, loadStyle,
    tokenizer: createKokoroTokenizer(tokenizerJson, tokenizerConfig), ...options });
  return { engine, session, phonemizer, loadStyle };
}

describe('independent Kokoro adapter', () => {
  it('keeps missing or corrupt required styles fatal to CPU setup and allows a verified retry', async () => {
    const loadStyle = vi.fn().mockRejectedValueOnce(new Error('Pinned style hash mismatch'))
      .mockResolvedValueOnce(new Float32Array(510 * 256));
    const { engine } = make({ loadStyle });
    await expect(engine.prepareVoice()).rejects.toMatchObject({ code: 'voice_style_download_failed', cause: { message: 'Pinned style hash mismatch' } });
    await expect(engine.prepareVoice()).resolves.toMatchObject({ prepared: true }); await engine.dispose();
  });
  it('prepares styles through its verified loader, shares them with synthesis and retires pending preparation', async () => {
    const { engine, session, loadStyle } = make();
    await expect(engine.prepareVoice()).resolves.toEqual({ voice: 'af_heart', prepared: true });
    await engine.generate('one'); expect(loadStyle).toHaveBeenCalledExactlyOnceWith('af_heart');
    await expect(engine.prepareVoice('unknown')).rejects.toThrow('Unknown'); await engine.dispose();
    await expect(engine.prepareVoice()).rejects.toThrow('disposed'); expect(session.release).toHaveBeenCalledTimes(1);

    let finish;
    const wait = new Promise(resolve => { finish = resolve; });
    const second = make({ loadStyle: async () => { await wait; return new Float32Array(510 * 256); } });
    const preparation = second.engine.prepareVoice(); const rejected = expect(preparation).rejects.toThrow('disposed');
    const disposal = second.engine.dispose(); expect(second.session.release).not.toHaveBeenCalled();
    finish(); await rejected; await disposal; expect(second.session.release).toHaveBeenCalledTimes(1);
  });
  it('preserves pinned style-row selection and exact inference inputs without Transformers', async () => {
    const { engine, session, loadStyle } = make();
    const calls = [];
    session.run.mockImplementation(async feeds => {
      calls.push({ row: feeds.style.data[0], shape: feeds.input_ids.dims, speed: feeds.speed.data[0] });
      return { waveform: new Tensor('float32', Float32Array.of(.25), [1]) };
    });
    for (const length of [3, 4, 8, 512]) await engine.generate_from_ids(new BigInt64Array(length), { speed: 2 });
    expect(calls.map(call => call.row)).toEqual([1, 2, 6, 509]);
    expect(calls.every(call => call.speed === 2)).toBe(true);
    expect(loadStyle).toHaveBeenCalledTimes(1);
    expect(session.run.mock.calls.every(call => call[1].join(',') === 'waveform')).toBe(true);
    await engine.dispose();
  });
  it('retains exactly the pronunciation synthesized for batch and finite stream', async () => {
    const { engine, phonemizer } = make();
    phonemizer.phonemizeText.mockImplementation(async text => text.includes('One') ? 'wˈʌn.' : 'fˈoːɹ.');
    const text = 'One.  Four.\n';
    const streamed = await Array.fromAsync(engine.stream(text));
    expect(streamed.map(chunk => chunk.text).join('')).toBe(text);
    expect(streamed.map(chunk => chunk.phonemes)).toEqual(['wˈʌn.', 'fˈoːɹ.']);
    expect(streamed.every(chunk => chunk.audio.phonemes === chunk.phonemes)).toBe(true);
    const generated = await engine.generate(text);
    expect(generated.audio.length).toBe(6); expect(generated.phonemes).toBe('wˈʌn. fˈoːɹ.');
    await engine.dispose();
  });
  it.each([
    ['Dr. Jones met Prof. Green near St. James Street. Next sentence.', ['Dr. Jones met Prof. Green near St. James Street. ', 'Next sentence.']],
    ['Mrs. Smith met Ms. Brown and Mr. Jones. Next.', ['Mrs. Smith met Ms. Brown and Mr. Jones. ', 'Next.']],
    ['J. R. R. Tolkien spoke. A. Smith replied.', ['J. R. R. Tolkien spoke. ', 'A. Smith replied.']],
    ['The U.S. Army arrived. Then it left.', ['The U.S. Army arrived. ', 'Then it left.']],
    ['See Fig. 3 and pp. 14–16. Next.', ['See Fig. 3 and pp. 14–16. ', 'Next.']],
    ['The result is 3.14. Read v1.0.0 at 09:15. Then stop.', ['The result is 3.14. ', 'Read v1.0.0 at 09:15. ', 'Then stop.']],
    ['They quoted Jones et al. A comparison follows. Then stop.', ['They quoted Jones et al. A comparison follows. ', 'Then stop.']],
    ['Dr.\n\nJones starts another paragraph.', ['Dr.\n', '\n', 'Jones starts another paragraph.']],
    ['The abbreviation is p.m. Then the next sentence starts.', ['The abbreviation is p.m. ', 'Then the next sentence starts.']],
    ['The train leaves at 2 P.M. Then it returns at 6 A.M. Next.', ['The train leaves at 2 P.M. ', 'Then it returns at 6 A.M. ', 'Next.']],
  ])('keeps abbreviation continuations together without changing source bytes: %s', async (text, expected) => {
    const { engine, phonemizer } = make();
    const chunks = await Array.fromAsync(engine.stream(text));
    expect(chunks.map(chunk => chunk.text)).toEqual(expected);
    expect(chunks.map(chunk => chunk.text).join('')).toBe(text);
    expect(phonemizer.phonemizeText.mock.calls.map(([source]) => source)).toEqual(expected);
    await engine.dispose();
  });
  it('keeps both accepted connected-prose inference chunks unchanged', async () => {
    const fixture = JSON.parse(readFileSync('tests/fixtures/kokoro-connected-prose.json'));
    const expected = ['On a quiet morning, the reader settled beside the window and opened the next chapter, leaving enough time to follow each thought. ',
      'The story moved from a simple question to a thoughtful answer; then, after a short pause, it returned to the idea that mattered most.'];
    for (const entry of fixture.cases) {
      const { engine } = make();
      expect((await Array.fromAsync(engine.stream(entry.text, { voice: entry.voice }))).map(chunk => chunk.text)).toEqual(expected);
      await engine.dispose();
    }
  });
  it('splits oversized phone sequences without dropping source text or truncating IDs', async () => {
    const { engine, session, phonemizer } = make();
    phonemizer.phonemizeText.mockImplementation(async text => 'w'.repeat(text.length * 2));
    const text = 'word '.repeat(120);
    const chunks = await Array.fromAsync(engine.stream(text));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map(chunk => chunk.text).join('')).toBe(text);
    expect(session.run.mock.calls.every(([feeds]) => feeds.input_ids.dims[1] <= 512)).toBe(true);
    await engine.dispose();
  });
  it('splits a long unpunctuated source before the bounded native normalizer sees it', async () => {
    const { engine, phonemizer } = make();
    phonemizer.phonemizeText.mockImplementation(async source => { if (source.length > 16384) throw new Error('native input bound'); return 'wˈʌn'; });
    const source = 'word '.repeat(4000), chunks = await Array.fromAsync(engine.stream(source));
    expect(chunks.map(chunk => chunk.text).join('')).toBe(source); expect(chunks).toHaveLength(2);
    await engine.dispose();
  });
  it('bounds IDs, voices, speed, custom splits and already aborted requests before inference', async () => {
    const { engine, session } = make();
    const controller = new AbortController(); controller.abort();
    for (const [ids, options] of [[BigInt64Array.of(0n, 999n, 0n), {}], [BigInt64Array.of(0n, 65n, 0n), { voice: 'unknown' }],
      [BigInt64Array.of(0n, 65n, 0n), { speed: 0 }], [BigInt64Array.of(0n, 65n, 0n), { signal: controller.signal }]]) {
      await expect(engine.generate_from_ids(ids, options)).rejects.toThrow();
    }
    await expect(Array.fromAsync(engine.stream('one', { split_pattern: /(?:)/ }))).rejects.toThrow('consume');
    expect(session.run).not.toHaveBeenCalled();
    await engine.dispose();
    await expect(engine.generate('one')).rejects.toThrow('disposed');
  });
  it('waits for in-flight inference and releases every input/output during disposal', async () => {
    let finish;
    const completion = new Promise(resolve => { finish = resolve; });
    const { engine, session, phonemizer } = make();
    let feeds, output;
    session.run.mockImplementation(async input => { feeds = input; await completion;
      output = new Tensor('float32', Float32Array.of(.2), [1]); return { waveform: output }; });
    const job = engine.generate_from_ids(BigInt64Array.of(0n, 65n, 0n));
    await vi.waitFor(() => expect(session.run).toHaveBeenCalledTimes(1));
    const rejected = expect(job).rejects.toThrow('disposed');
    const disposal = engine.dispose();
    expect(session.release).not.toHaveBeenCalled(); finish();
    await disposal; await rejected;
    expect(session.release).toHaveBeenCalledTimes(1); expect(phonemizer.dispose).toHaveBeenCalledTimes(1);
    expect(Object.values(feeds).every(tensor => tensor.data === null)).toBe(true);
    expect(output.data).toBe(null);
  });
});

describe('Kokoro data-only loader', () => {
  it('pins all ten voice styles and keeps source fixture identities', () => {
    expect(KOKORO_DATA).toEqual(JSON.parse(readFileSync('tests/fixtures/kokoro-models.json')));
    expect(KOKORO_DATA.files.filter(file => file.path.startsWith('voices/'))).toHaveLength(10);
  });
  it('validates data hashes, retries corrupted cache entries, shares loads and refuses executable URLs', async () => {
    const data = Uint8Array.of(1, 2, 3);
    const manifest = { modelId: 'fixture', revision: 'pinned', files: [{ path: 'tokenizer.json', bytes: 3,
      sha256: createHash('sha256').update(data).digest('hex') }] };
    const cache = { match: vi.fn(async () => new Response('bad')), delete: vi.fn(async () => true), put: vi.fn(async () => {}) };
    const fetcher = vi.fn(async () => new Response(data));
    const loader = createKokoroDataLoader({ manifest, cacheStorage: { open: async () => cache }, fetcher });
    const [a, b] = await Promise.all([loader('tokenizer.json'), loader('tokenizer.json')]);
    expect(a).toEqual(data); expect(b).toBe(a); expect(fetcher).toHaveBeenCalledTimes(1); expect(cache.delete).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('https://huggingface.co/fixture/resolve/pinned/tokenizer.json');
    await expect(loader('runtime.js')).rejects.toThrow('Unexpected');
    const corrupt = createKokoroDataLoader({ manifest, fetcher: async () => new Response('bad'), cacheStorage: null });
    await expect(corrupt('tokenizer.json')).rejects.toThrow('hash');
  });
  it('keeps verified downloads usable when the optional browser cache cannot read or write', async () => {
    const data = Uint8Array.of(4, 5, 6), onProgress = vi.fn();
    const manifest = { modelId: 'fixture', revision: 'pinned', files: [{ path: 'tokenizer.json', bytes: 3, sha256: createHash('sha256').update(data).digest('hex') }] };
    const cache = { match: async () => { throw new Error('cache read failed'); }, put: async () => { throw new Error('cache write failed'); } };
    const loader = createKokoroDataLoader({ manifest, cacheStorage: { open: async () => cache }, fetcher: async () => new Response(data), onProgress });
    expect(await loader('tokenizer.json')).toEqual(data);
    expect(onProgress.mock.calls.filter(([event]) => event.status === 'cache-unavailable')).toHaveLength(2);
  });
  it('disposes prepared phonemizer after graph preparation fails without requesting a legacy runtime', async () => {
    const phonemizer = { dispose: vi.fn() };
    const loadData = vi.fn(async file => {
      if (file.includes('.onnx')) return new Uint8Array();
      return new TextEncoder().encode(JSON.stringify(file === 'tokenizer.json' ? tokenizerJson : tokenizerConfig));
    });
    await expect(loadBrowserKokoroBackend(undefined, { loadData, phonemizerFactory: async () => phonemizer,
      inference: { InferenceSession: { create: async () => { throw new Error('Unsupported test graph'); } } } })).rejects.toThrow('test graph');
    expect(phonemizer.dispose).toHaveBeenCalledTimes(1);
    expect(loadData.mock.calls.map(call => call[0])).toEqual(['onnx/model.onnx', 'tokenizer.json', 'tokenizer_config.json']);
  });
  it('constructs only the packaged CPU engine for q8 and releases it after session disposal', async () => {
    const events = [], compute = { dispose: vi.fn(async () => { events.push('compute'); }) };
    const phonemizer = { dispose: vi.fn(), phonemizeText: vi.fn(async () => 'wˈʌn') };
    const session = { run: vi.fn(), release: vi.fn(async () => { events.push('session'); }) };
    const createSession = vi.fn(async () => session), cpuEngineFactory = vi.fn(async () => compute);
    const loadData = vi.fn(async file => file.includes('.onnx') ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(file === 'tokenizer.json' ? tokenizerJson : tokenizerConfig)));
    const backend = await loadBrowserKokoroBackend(undefined, { device: 'wasm', dtype: 'q8', loadData,
      phonemizerFactory: async () => phonemizer, cpuEngineFactory, inference: { Tensor, InferenceSession: { create: createSession } } });
    expect(createSession.mock.calls[0][1]).toEqual({ executionProviders: ['wasm'], engine: compute });
    expect(cpuEngineFactory).toHaveBeenCalledTimes(1); await backend.dispose(); await backend.dispose();
    expect(events).toEqual(['session', 'compute']); expect(phonemizer.dispose).toHaveBeenCalledTimes(1);
  });
  it('releases its packaged CPU engine when q8 graph initialization fails', async () => {
    const compute = { dispose: vi.fn() }, phonemizer = { dispose: vi.fn() };
    const loadData = async file => file.includes('.onnx') ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(file === 'tokenizer.json' ? tokenizerJson : tokenizerConfig));
    await expect(loadBrowserKokoroBackend(undefined, { device: 'wasm', dtype: 'q8', loadData,
      phonemizerFactory: async () => phonemizer, cpuEngineFactory: async () => compute,
      inference: { InferenceSession: { create: async () => { throw new Error('q8 graph failed'); } } } })).rejects.toThrow('q8 graph failed');
    expect(compute.dispose).toHaveBeenCalledTimes(1); expect(phonemizer.dispose).toHaveBeenCalledTimes(1);
  });
  it('fails closed on an unpinned phase-correction graph before creating compute and releases the prepared phonemizer', async () => {
    const phonemizer = { dispose: vi.fn() }, cpuEngineFactory = vi.fn(), createSession = vi.fn();
    const loadData = async file => file.includes('.onnx') ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(file === 'tokenizer.json' ? tokenizerJson : tokenizerConfig));
    await expect(loadBrowserKokoroBackend(undefined, { device: 'wasm', dtype: 'q8', phaseCorrection: true, loadData,
      phonemizerFactory: async () => phonemizer, cpuEngineFactory, inference: { InferenceSession: { create: createSession } } })).rejects.toThrow('exact pinned');
    expect(cpuEngineFactory).not.toHaveBeenCalled(); expect(createSession).not.toHaveBeenCalled(); expect(phonemizer.dispose).toHaveBeenCalledTimes(1);
  });
});
