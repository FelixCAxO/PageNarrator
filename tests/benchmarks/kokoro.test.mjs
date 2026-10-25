import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { comparePcm, waveBytes } from '../../scripts/lib/kokoro-speech-acceptance.mjs';
import { VOICES } from '../../src/tts/voices/voice-registry.js';

await test('audio export is PCM and rejects corrupt samples before encoding', () => {
  const result = waveBytes(new Float32Array([-1, 0, 1]));
  assert.equal(result.toString('ascii', 0, 4), 'RIFF');
  assert.equal(result.readUInt32LE(24), 24000);
  assert.equal(result.readUInt32LE(40), 6);
  assert.equal(result.readInt16LE(44), -32767);
  assert.equal(result.readInt16LE(48), 32767);
  assert.throws(() => waveBytes(new Float32Array([NaN])));
  assert.throws(() => waveBytes(new Float32Array()));
});

await test('exact float32 quality control rejects changed, silent, invalid or mismatched audio', () => {
  const pcm = new Float32Array([0, .5, -.5]);
  assert.equal(comparePcm(pcm, pcm.slice()).status, 'accept');
  for (const other of [new Float32Array([0, .5, -.4]), pcm.slice(1), new Float32Array([NaN]), new Float32Array(), new Float32Array([0]), new Float32Array([1e-8])]) {
    assert.equal(comparePcm(pcm, other).status, 'reject');
  }
  const subQuantizationChange = pcm.slice(); subQuantizationChange[1] += 2 ** -24;
  assert(waveBytes(pcm).equals(waveBytes(subQuantizationChange)));
  assert.equal(comparePcm(pcm, subQuantizationChange).status, 'reject');
  assert.equal(comparePcm(pcm, pcm, 24000, 22050).status, 'reject');
  assert.equal(comparePcm(pcm, pcm, Infinity, Infinity).status, 'reject');
});

await test('frozen voice-quality partitions cover supported voices and remain separate from development prose', () => {
  const corpus = JSON.parse(readFileSync('tests/voice/fixtures/quality-corpus.json', 'utf8'));
  assert.deepEqual(corpus.voices.slice().sort(), VOICES.map(voice => voice.id).sort());
  const development = ['tests/fixtures/kokoro-semantic-corpus.json', 'tests/fixtures/kokoro-connected-prose.json']
    .flatMap(path => JSON.parse(readFileSync(path, 'utf8')).cases.map(item => item.text));
  const validation = corpus.validation.map(item => item.text), final = corpus.test.map(item => item.text);
  assert.equal(new Set([...validation, ...final]).size, validation.length + final.length);
  assert(final.every(text => !development.includes(text)));
  assert.deepEqual(corpus.validation.map(item => item.category).sort(), corpus.test.map(item => item.category).sort());
});
