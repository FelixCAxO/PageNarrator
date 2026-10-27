// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Independent development assessment data. Never imported by the speech runtime.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { KOKORO_DATA } from '../../src/tts/kokoro/model-data.js';
import { waveBytes } from './kokoro-speech-acceptance.mjs';
import { hashDirectory } from '../weak-hardware/run-provenance.mjs';
import { assertReleasePackage } from '../assert-release-package.mjs';

export const QUALITY_CORPUS_SHA256 = '6c2766a0a670e6e84cb1d0fbfc71cef531f078c25662317c09e56af038c5233c';
export const hashQualityBytes = bytes => createHash('sha256').update(bytes).digest('hex');
export const qualityFingerprint = value => hashQualityBytes(JSON.stringify(value));

// Written before evaluating either final pipeline. Alternatives express equivalent
// spoken content, not pronunciations learned from either runtime or ASR output.
const spoken = {
  'validation-numbers': ['the meeting starts at ', ['nine fifteen', 'oh nine fifteen'], ' on april ', ['twelve', 'twelfth'], ' ',
    ['twenty twenty seven', 'two thousand twenty seven', 'two thousand and twenty seven'], ' three tickets cost ', ['forty two dollars sixty cents', 'forty two dollars and sixty cents']],
  'validation-abbreviations': ['doctor jones met professor green near saint james street the appointment was at two p m'],
  'validation-technical': ['a browser stores the model locally web assembly executes c p u instructions while web g p u submits work to the graphics processor'],
  'test-numbers': ['at ', ['eighteen forty five', 'six forty five p m'], ' the display showed ', ['twenty one point five', 'twenty one and a half'],
    ' degrees the invoice total was ', ['eighty seven pounds thirty pence', 'eighty seven pounds and thirty pence', 'eighty seven pounds thirty'], ' in ',
    ['twenty twenty eight', 'two thousand twenty eight', 'two thousand and twenty eight']],
  'test-abbreviations': ['missus taylor spoke with doctor brown on wednesday see figure three and pages fourteen ', ['to', 'through'], ' sixteen for details'],
  'test-technical': ['the a p i returns a ', ['j s o n', 'jason'], ' document over h t t p s a g p u buffer holds tensor data until the inference call finishes'],
};
function choices(parts) {
  return parts.reduce((prefixes, part) => prefixes.flatMap(prefix => (Array.isArray(part) ? part : [part]).map(value => prefix + value)), ['']);
}
const words = value => String(value).toLowerCase().replace(/[’']/g, '').match(/[a-z]+|\d+(?:\.\d+)?/g) ?? [];

/** ASR often writes numbers/symbols rather than the spoken words. These fixed
 * orthographic equivalents do not prove how a voice pronounced them. */
export function qualityTranscriptWords(text, id) {
  let value = String(text).toLowerCase().replace(/[–—−]/g, '-');
  const replace = (pattern, replacement) => { value = value.replace(pattern, replacement); };
  if (id.endsWith('numbers')) {
    replace(/\b09:15\b/g, 'nine fifteen'); replace(/\b18:45\b/g, 'eighteen forty five');
    replace(/\b6:45\s*p\.?\s*m\.?/g, 'six forty five p m');
    replace(/\$\s*42\.60\b/g, 'forty two dollars and sixty cents');
    replace(/£\s*87\.30\b/g, 'eighty seven pounds and thirty pence');
    replace(/\b21\.5\b/g, 'twenty one point five');
    replace(/\b2027\b/g, 'twenty twenty seven'); replace(/\b2028\b/g, 'twenty twenty eight');
    replace(/\b42\b/g, 'forty two'); replace(/\b60\b/g, 'sixty'); replace(/\b87\b/g, 'eighty seven'); replace(/\b30\b/g, 'thirty');
    replace(/\b12(?:th)?\b/g, 'twelve');
  }
  if (id.endsWith('abbreviations')) {
    replace(/\bmrs\b\.?/g, 'missus'); replace(/\bdr\b\.?/g, 'doctor'); replace(/\bprof\b\.?/g, 'professor');
    replace(/\bst\b\.?/g, 'saint'); replace(/\bfig\b\.?/g, 'figure'); replace(/\bpp\b\.?/g, 'pages');
    replace(/\b14\s*-\s*16\b/g, 'fourteen to sixteen');
    for (const [number, name] of [['2', 'two'], ['3', 'three'], ['14', 'fourteen'], ['16', 'sixteen']]) replace(new RegExp(`\\b${number}\\b`, 'g'), name);
  }
  if (id.endsWith('technical')) {
    for (const [name, expansion] of [['webassembly', 'web assembly'], ['webgpu', 'web g p u'], ['https', 'h t t p s'], ['json', 'j s o n'], ['api', 'a p i'], ['cpu', 'c p u'], ['gpu', 'g p u']]) replace(new RegExp(`\\b${name}\\b`, 'g'), expansion);
  }
  return words(value);
}
function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) { const next = [i]; for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1])); previous = next; }
  return previous[b.length];
}
export function assessQualityTranscript(entry, transcript, frozenSpoken) {
  const actual = qualityTranscriptWords(transcript, entry.id), alternatives = frozenSpoken[entry.id];
  if (!alternatives?.length) throw new Error('Missing independently frozen spoken content.');
  const best = alternatives.map(text => { const expected = words(text); return { expected, edits: editDistance(expected, actual) }; }).sort((a, b) => a.edits / a.expected.length - b.edits / b.expected.length)[0];
  return { transcript, actual, expected: best.expected, edits: best.edits, wordErrorRate: best.edits / best.expected.length,
    tailPass: actual.slice(-3).join(' ') === best.expected.slice(-3).join(' '), completeTranscript: best.edits === 0,
    scope: 'Independent frozen spoken alternatives and fixed ASR orthographic normalization. Transcript completeness is not pronunciation or listening acceptance.' };
}

export async function qualitySourcePins(root) {
  const sources = [...(await Promise.all(['src/engines', 'src/tts/kokoro'].map(async path => (await readdir(resolve(root, path))).filter(name => name.endsWith('.js')).map(name => `${path}/${name}`)))).flat(),
    'src/tts/voices/voice-registry.js', 'src/lib/kokoro-multilingual.js', 'src/lib/voice-model.js', 'public/native/kokoro-engine.wasm',
    'native/kokoro-parallel.cpp', 'public/native/kokoro-parallel.wasm', 'public/native/kokoro-parallel.json',
    'public/assets/phonemizer/english.wasm', 'public/assets/phonemizer/pronunciations.bin', 'scripts/lib/kokoro-quality-controls.mjs',
    'scripts/lib/kokoro-quality-candidate.mjs', 'scripts/lib/kokoro-legacy-quality.mjs', 'scripts/probe-kokoro-quality.mjs', 'scripts/probe-kokoro-registry.mjs'];
  sources.push('scripts/lib/kokoro-speech-acceptance.mjs', 'scripts/lib/browser-adapter.mjs', 'scripts/kokoro-asr-review.py');
  sources.push('config/voice-quality-protocol.json', 'scripts/voice-listening-reviews.mjs', 'scripts/verify-voice-quality.mjs', 'scripts/lib/voice-quality-assessment.mjs');
  return Object.fromEntries(await Promise.all(sources.sort().map(async path => [path, hashQualityBytes(await readFile(resolve(root, path)))])));
}
export async function qualityLegacyPins(root) {
  const sources = ['package-lock.json', 'node_modules/kokoro-js/package.json', 'node_modules/kokoro-js/dist/kokoro.js',
    'node_modules/phonemizer/package.json', 'node_modules/phonemizer/dist/phonemizer.js', 'node_modules/@huggingface/transformers/package.json',
    'node_modules/@huggingface/transformers/dist/transformers.node.mjs', 'node_modules/onnxruntime-node/package.json', 'scripts/lib/kokoro-legacy-quality.mjs',
    'scripts/lib/kokoro-quality-controls.mjs', 'scripts/lib/kokoro-speech-acceptance.mjs'];
  for (const file of KOKORO_DATA.files.filter(entry => entry.path.startsWith('voices/'))) {
    const path = `node_modules/kokoro-js/${file.path}`, bytes = await readFile(resolve(root, path));
    if (bytes.length !== file.bytes || hashQualityBytes(bytes) !== file.sha256) throw new Error(`Installed legacy style differs from pinned model data: ${file.path}.`);
    sources.push(path);
  }
  for (const directory of ['node_modules/onnxruntime-node/dist', 'node_modules/onnxruntime-common/dist', 'node_modules/onnxruntime-node/bin/napi-v6/win32/x64']) {
    for (const file of await readdir(resolve(root, directory), { recursive: true })) if (/\.(?:js|node|dll)$/.test(file)) sources.push(`${directory}/${file.replaceAll('\\', '/')}`);
  }
  return Object.fromEntries(await Promise.all(sources.sort().map(async path => [path, hashQualityBytes(await readFile(resolve(root, path)))])));
}
export async function makeQualityFreeze(root, cacheDirectory) {
  const bytes = await readFile(resolve(root, 'tests/voice/fixtures/quality-corpus.json'));
  if (hashQualityBytes(bytes) !== QUALITY_CORPUS_SHA256) throw new Error('Frozen quality corpus changed.');
  const corpus = JSON.parse(bytes), expectedSpoken = Object.fromEntries([...corpus.validation, ...corpus.test].map(entry => [entry.id, spoken[entry.id] ? choices(spoken[entry.id]) : [entry.text]]));
  for (const file of KOKORO_DATA.files) { const data = await readFile(resolve(cacheDirectory, file.path)); if (data.length !== file.bytes || hashQualityBytes(data) !== file.sha256) throw new Error(`Unverified quality data ${file.path}.`); }
  const sourcePins = await qualitySourcePins(root);
  await mkdir(resolve(root, 'artifacts'), { recursive: true });
  const directory = await mkdtemp(resolve(root, 'artifacts/kokoro-quality-build-'));
  const build = spawnSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build'], {
    cwd: root, env: { ...process.env, PN_OUT_DIR: directory }, stdio: 'inherit', windowsHide: true });
  if (build.status !== 0) throw new Error('Could not build the frozen quality candidate.', { cause: build.error });
  await assertReleasePackage(directory);
  if (JSON.stringify(sourcePins) !== JSON.stringify(await qualitySourcePins(root))) throw new Error('Candidate source changed while building the quality freeze.');
  return { schema: 1, frozenAt: new Date().toISOString(), corpusSha256: QUALITY_CORPUS_SHA256, corpus, expectedSpoken,
    data: KOKORO_DATA, sourcePins, packagedBuild: { directory, ...await hashDirectory(directory) }, legacyPins: await qualityLegacyPins(root),
    rules: { speed: 1, mode: 'stream', sampleRate: 24000, minimumRms: .001, requiredTranscriptWordEdits: 0, requireFinalThreeWords: true,
      unknownNetwork: 'blocked', legacyBackend: 'Unmodified public KokoroTTS stream with ONNX Runtime Node CPU, matching q8/fp32 raw graph and exact pinned bundled styles. Public loader has no session-options argument; runtime thread defaults remain unchanged. No cross-backend speed or PCM claim.',
      finalPartition: 'No tuning on test output. Preserve failures; a repaired candidate requires a new independently frozen holdout or an explicit regression label.',
      listenerStudy: { status: 'not performed', listenersRequired: 20, dimensions: ['intelligibility', 'voice identity', 'pronunciation', 'prosody'], minimumClustered95PercentLowerBound: -.25 },
      scope: 'Text-to-PCM pipeline comparison; ASR is diagnostic. No article/PDF handoff, highlighting, audible latency, performance or 20-listener acceptance is inferred.' } };
}
export async function verifyQualityBuild(root, expected, directory = expected?.directory) {
  if (!directory || !resolve(directory).startsWith(`${resolve(root)}${sep}`)) throw new Error('Missing isolated quality build.');
  const actual = await hashDirectory(directory);
  if (!expected.sha256 || actual.sha256 !== expected.sha256) throw new Error('Packaged quality worker differs from its frozen build.');
}
export async function readQualityFreeze(root, path, { candidate = true, legacy = true } = {}) {
  const bytes = await readFile(path), digest = (await readFile(`${path}.sha256`, 'utf8')).trim();
  if (hashQualityBytes(bytes) !== digest) throw new Error('Quality freeze bytes changed after their immutable digest was written.');
  const freeze = JSON.parse(bytes);
  if (freeze.schema !== 1 || freeze.corpusSha256 !== QUALITY_CORPUS_SHA256 || hashQualityBytes(await readFile(resolve(root, 'tests/voice/fixtures/quality-corpus.json'))) !== QUALITY_CORPUS_SHA256) throw new Error('Quality freeze/corpus mismatch.');
  if (candidate && JSON.stringify(freeze.sourcePins) !== JSON.stringify(await qualitySourcePins(root))) throw new Error('Candidate source changed after quality freeze.');
  if (candidate) await verifyQualityBuild(root, freeze.packagedBuild);
  if (legacy && JSON.stringify(freeze.legacyPins) !== JSON.stringify(await qualityLegacyPins(root))) throw new Error('Legacy executable/source changed after quality freeze.');
  return freeze;
}
export function selectQualityCases(freeze, { partition, voices, cases = null }) {
  if (!['validation', 'test'].includes(partition) || !voices.length || voices.some(voice => !freeze.corpus.voices.includes(voice)) || new Set(voices).size !== voices.length) throw new Error('Unknown quality partition or voice.');
  const entries = freeze.corpus[partition].filter(entry => !cases || cases.includes(entry.id));
  if (!entries.length || (cases && entries.length !== new Set(cases).size)) throw new Error('Unknown or empty quality case selection.');
  return voices.flatMap(voice => entries.map(entry => ({ ...entry, voice, speed: 1, mode: 'stream' })));
}
export function qualitySourceAssociation(text, chunks) {
  let offset = 0, whitespaceCharacters = 0;
  for (const chunk of chunks) {
    if (!chunk.text) throw new Error('Empty quality source chunk.');
    const start = text.indexOf(chunk.text, offset), gap = text.slice(offset, start);
    if (start < offset || gap.trim()) throw new Error('Quality stream source association changed.');
    whitespaceCharacters += gap.length; offset = start + chunk.text.length;
  }
  const tail = text.slice(offset);
  if (tail.trim()) throw new Error('Quality stream omitted source text.');
  return { sourceCharacters: text.length, silentWhitespaceCharacters: whitespaceCharacters + tail.length };
}
export async function saveQualityClip(directory, key, pcm, metadata) {
  if (!(pcm instanceof Float32Array) || !pcm.length || !pcm.every(Number.isFinite)) throw new Error('Invalid quality PCM.');
  let squares = 0; for (const x of pcm) squares += x * x;
  const rms = Math.sqrt(squares / pcm.length); if (rms < .001) throw new Error('Silent quality PCM.');
  const raw = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), wav = waveBytes(pcm);
  const record = { ...metadata, samples: pcm.length, sampleRate: 24000, seconds: pcm.length / 24000, rms,
    raw: { file: `${key}.f32`, bytes: raw.length, sha256: hashQualityBytes(raw) }, wav: { file: `${key}.wav`, bytes: wav.length, sha256: hashQualityBytes(wav) } };
  await mkdir(directory, { recursive: true }); await writeFile(resolve(directory, record.raw.file), raw); await writeFile(resolve(directory, record.wav.file), wav);
  await writeFile(resolve(directory, `${key}.json`), `${JSON.stringify(record, null, 2)}\n`); return record;
}
export async function reusableQualityClip(directory, key, fingerprint) {
  let record; try { record = JSON.parse(await readFile(resolve(directory, `${key}.json`))); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (record.fingerprint !== fingerprint) throw new Error(`Existing quality clip has different frozen pins: ${key}.`);
  for (const entry of [record.raw, record.wav]) { const bytes = await readFile(resolve(directory, entry.file)); if (bytes.length !== entry.bytes || hashQualityBytes(bytes) !== entry.sha256) throw new Error(`Stored quality clip corrupted: ${key}.`); }
  return record;
}
