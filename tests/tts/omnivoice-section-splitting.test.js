import { expect, it, vi } from 'vitest';
import { createOmniVoiceTts } from '../../src/tts/omnivoice/tts.js';
import * as presetIndex from '../../src/tts/omnivoice/preset-seeds.js';

const preset = presetIndex.getOmniVoicePreset(presetIndex.getOmniVoiceVoices('en', 'female')[0]);
const voice = { detectCode: 'en', omniVoice: { gender: 'female', voices: { en: preset.id } } };
const withPreset = overrides => { const real = presetIndex.getOmniVoicePreset;
  return vi.spyOn(presetIndex, 'getOmniVoicePreset').mockImplementation(id => { const found = real(id); return found && { ...found, ...overrides }; }); };
const audio = { pcm: Float32Array.of(.1, -.1), sampleRate: 24000 };
const tooLong = () => Object.assign(new Error('Section exceeds the model context.'), { name: 'OmniVoiceSectionLengthError' });
function setup(limit, onLeaf = () => audio) {
  const engine = { init: vi.fn(), dispose: vi.fn(), abortGeneration: vi.fn(), synthesize: vi.fn(async (request, options) => {
    if (request.text.length > limit) throw tooLong();
    options?.onProgress?.({ remainingMs: 20 });
    return onLeaf(request);
  }) };
  const loadRuntime = vi.fn(async () => engine);
  return { engine, loadRuntime, tts: createOmniVoiceTts({ loadRuntime }) };
}

it('preserves measured pronunciation on every split section', async () => {
  const pronunciation = withPreset({ pronunciationVariant: 'yue-nei5' });
  const { tts, engine } = setup(20);
  try {
    await tts.generate('您好，您今日想睇咩書？您可以慢慢揀。'.repeat(6), { voice: { ...voice, detectCode: 'yue' } });
    expect(engine.synthesize.mock.calls.length).toBeGreaterThan(2);
    for (const [request] of engine.synthesize.mock.calls) {
      expect(request.lang).toBe('yue'); expect(request.pronunciationVariant).toBe('yue-nei5');
    }
  } finally { await tts.dispose(); pronunciation.mockRestore(); }
});

it('preserves measured pace when an oversized section is split', async () => {
  const speed = withPreset({ speed: .85 });
  const { tts, engine } = setup(20);
  try {
    await tts.generate('The first sentence is complete. The second sentence follows.', { voice });
    expect(engine.synthesize.mock.calls.length).toBeGreaterThan(1);
    for (const [request] of engine.synthesize.mock.calls) expect(request.speed).toBe(.85);
  } finally { await tts.dispose(); speed.mockRestore(); }
});

it('splits a bounded request while preserving all text, the preset and seed without reloading', async () => {
  const text = 'First sentence is complete. Second sentence is complete. Third sentence is complete.';
  const { tts, engine, loadRuntime } = setup(30), progress = vi.fn();
  const result = await tts.generate(text, { voice, onSynthesisProgress: progress });
  const requests = engine.synthesize.mock.calls.map(([request]) => request), leaves = requests.filter(request => request.text.length <= 30);
  expect(leaves.map(request => request.text).join(' ')).toBe(text);
  expect(result.audio).toHaveLength(leaves.length * audio.pcm.length);
  for (const request of requests) expect(request).toMatchObject({ lang: 'en', speakerId: preset.id, seed: preset.seed });
  expect(loadRuntime).toHaveBeenCalledOnce(); expect(engine.init).toHaveBeenCalledOnce();
  expect(engine.dispose).not.toHaveBeenCalled(); expect(progress).toHaveBeenCalledOnce();
  await tts.dispose();
});

it('keeps surrogate pairs and combining marks together when a word must be split', async () => {
  const text = '𠀀e\u0301'.repeat(12), { tts, engine } = setup(4);
  await tts.generate(text, { voice });
  const leaves = engine.synthesize.mock.calls.map(([request]) => request.text).filter(text => text.length <= 4);
  expect(leaves.join('')).toBe(text);
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  for (const leaf of leaves) for (const { segment } of segmenter.segment(leaf)) expect(['𠀀', 'e\u0301']).toContain(segment);
  await tts.dispose();
});

it('smooths an internal join without shortening or mutating the original sections', async () => {
  const pcm = new Float32Array(480).fill(0.25);
  const { tts } = setup(18, () => ({ ...audio, pcm }));
  try {
    const result = await tts.generate('First piece. Second piece.', { voice });
    expect(result.audio).toHaveLength(960);
    expect([0, 359, 479, 480, 600, 959].map(index => result.audio[index]))
      .toEqual([0.25, 0.25, 0, 0, 0.25, 0.25]);
    expect(pcm.every(sample => sample === 0.25)).toBe(true);
  } finally { await tts.dispose(); }
});

it.each([false, true])('removes dead air at playback edges for either voice source (personal=%s)', async personal => {
  const pcm = new Float32Array(48000);
  pcm.fill(0.2, 12000, 36000);
  const { tts } = setup(40, () => ({ ...audio, pcm }));
  try {
    const selected = personal ? { ...voice, personalReference: { id: 'clone:test' } } : voice;
    const result = await tts.generate('First piece.', { voice: selected });
    expect(result.audio.length).toBe(30720);
    expect(result.audio).toEqual(pcm.subarray(8640, 39360));
  } finally { await tts.dispose(); }
});

it('stops between sections when reading is cancelled', async () => {
  const controller = new AbortController();
  const { tts, engine } = setup(18, () => { controller.abort(); return audio; });
  await expect(tts.generate('First piece. Second piece.', { voice, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(engine.synthesize).toHaveBeenCalledTimes(2);
  expect(engine.abortGeneration).toHaveBeenCalledOnce();
  await tts.dispose();
});

it('rejects an indivisible section without recursive retries', async () => {
  const { tts, engine } = setup(0);
  await expect(tts.generate('e\u0301', { voice })).rejects.toMatchObject({ name: 'OmniVoiceSectionLengthError' });
  expect(engine.synthesize).toHaveBeenCalledTimes(2);
  await tts.dispose();
});

it('validates each section so invalid audio cannot be hidden by a valid section', async () => {
  const { tts, engine } = setup(18, request => request.text.startsWith('Second') ? { ...audio, pcm: Float32Array.of(NaN, 0) } : audio);
  await expect(tts.generate('First piece. Second piece.', { voice })).rejects.toMatchObject({ name: 'OmniVoiceAudioQualityError' });
  expect(new Set(engine.synthesize.mock.calls.map(([request]) => request.speakerId))).toEqual(new Set([preset.id]));
  expect(new Set(engine.synthesize.mock.calls.map(([request]) => request.seed))).toEqual(new Set([preset.seed, preset.seed + 1]));
  await tts.dispose();
});
