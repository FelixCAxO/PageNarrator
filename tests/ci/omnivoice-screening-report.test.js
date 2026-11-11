import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createOmniVoiceRequest } from '../../src/lib/omnivoice-settings.js';
import { getOmniVoiceSpeakerReference } from '../../src/tts/omnivoice/speakers.js';

const directories = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const write = (file, data) => writeFileSync(file, JSON.stringify(data));
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(...options) {
  const directory = mkdtempSync(join(tmpdir(), 'pn-screening-'));
  directories.push(directory);
  const result = spawnSync(process.execPath, ['tooling/scripts/prepare-omnivoice-variations.mjs', `--output=${directory}`, ...options], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  mkdirSync(join(directory, 'records'));
  mkdirSync(join(directory, 'analysis'));
  mkdirSync(join(directory, 'wav'));
  write(join(directory, 'runtime.json'), { workerSha256: 'a'.repeat(64), requestFactorySha256: hash(readFileSync('src/lib/omnivoice-settings.js')) });
  return directory;
}

function capture(directory, item) {
  const request = createOmniVoiceRequest(item.text, { detectCode: item.code, omniVoice: item.omniVoice });
  const reference = getOmniVoiceSpeakerReference(request);
  const wav = Buffer.from('report integrity control; acoustic analysis is supplied separately');
  const record = { request, requestSha256: hash(JSON.stringify(request)), workerSha256: 'a'.repeat(64),
    status: 'generated', wav: `wav/${item.id}.wav`, wavSha256: hash(wav), pcmSha256: 'b'.repeat(64),
    attempts: [{ speaker: { id: request.speakerId, referenceHash: reference.hash } }] };
  writeFileSync(join(directory, record.wav), wav);
  write(join(directory, 'records', `${item.id}.json`), record);
  write(join(directory, 'analysis', `${item.id}.json`), { status: 'automatic-sample-pass',
    wavSha256: record.wavSha256, workerSha256: record.workerSha256, requestSha256: record.requestSha256 });
  return record;
}

function report(directory, ...options) {
  return spawnSync(process.execPath, ['tooling/scripts/report-omnivoice-variations.mjs', `--directory=${directory}`, ...options], { encoding: 'utf8' });
}

it('reports the current catalog and stable voice captures while retaining missing cases', () => {
  const directory = fixture('--include-replays');
  const corpus = read(join(directory, 'corpus.json')).languages;
  const item = corpus.find(item => item.code === 'en' && item.omniVoice.gender === 'female');
  capture(directory, item);
  const result = report(directory, '--require-pass');
  expect(result.status, result.stderr).toBe(1);
  const summary = read(join(directory, 'summary.json'));
  expect(summary.rows.filter(row => !row.replayOf)).toHaveLength(831);
  expect(summary.languages).toHaveLength(32);
  expect(summary.rows.find(row => row.id === item.id)).toMatchObject({
    voiceId: item.omniVoice.voices.en, status: 'automatic-sample-pass', integrityPassed: true, fixedReferencePassed: true,
  });
  expect(summary.counts['not-captured']).toBe(830);
  expect(summary.captureComplete).toBe(false);
  expect(summary.sameDeviceReplayPassed).toBe(false);
  expect(readFileSync(join(directory, 'review.html'), 'utf8')).toContain(item.omniVoice.voices.en);
}, 20_000);

it('rejects a self-consistent capture receipt for a different scheduled request', () => {
  const directory = fixture();
  const item = read(join(directory, 'corpus.json')).languages.find(item => item.code === 'en');
  const record = capture(directory, item);
  record.request.text = 'A different sentence than the scheduled screening case.';
  record.requestSha256 = hash(JSON.stringify(record.request));
  write(join(directory, 'records', `${item.id}.json`), record);
  const analysis = read(join(directory, 'analysis', `${item.id}.json`));
  analysis.requestSha256 = record.requestSha256;
  write(join(directory, 'analysis', `${item.id}.json`), analysis);
  expect(report(directory).status).toBe(0);
  expect(read(join(directory, 'summary.json')).rows.find(row => row.id === item.id).status).toBe('integrity-failed');
}, 20_000);

it('rejects duplicate stable voice coverage even when the matrix has the right size', () => {
  const directory = fixture('--include-whisper');
  const corpus = read(join(directory, 'corpus.json'));
  const english = corpus.languages.filter(item => item.code === 'en' && item.omniVoice.gender === 'female' && !item.omniVoice.whisper);
  english[1].omniVoice.voices = english[0].omniVoice.voices;
  write(join(directory, 'corpus.json'), corpus);
  const result = report(directory);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('voice coverage');
}, 20_000);

it('requires the expected speaker identity as well as matching audio on every restart replay', () => {
  const directory = fixture('--include-replays');
  const corpus = read(join(directory, 'corpus.json')).languages;
  for (const item of corpus.filter(item => item.code === 'sv')) {
    const record = capture(directory, item);
    if (item.replayOf) {
      record.replay = { baseline: item.replayOf, baselinePcmSha256: record.pcmSha256, equalPcm: true };
      write(join(directory, 'records', `${item.id}.json`), record);
    }
  }
  expect(report(directory).status).toBe(0);
  expect(read(join(directory, 'summary.json')).sameDeviceReplayPassed).toBe(true);
  const item = corpus.find(item => item.replayOf);
  const file = join(directory, 'records', `${item.id}.json`);
  const record = read(file);
  record.attempts[0].speaker.referenceHash = 'c'.repeat(64);
  write(file, record);
  expect(report(directory).status).toBe(0);
  expect(read(join(directory, 'summary.json')).sameDeviceReplayPassed).toBe(false);
}, 20_000);

it('rejects derived whisper audio backed by a different scheduled voice', () => {
  const directory = fixture('--include-whisper');
  const corpus = read(join(directory, 'corpus.json')).languages;
  const item = corpus.find(item => item.code === 'en' && item.omniVoice.whisper);
  const other = corpus.find(item => item.code === 'sv' && !item.omniVoice.whisper);
  const backing = capture(directory, other);
  const raw = Buffer.from(new Float32Array([0.1, 0.2]).buffer);
  backing.pcmFile = `pcm-${other.id}.f32`;
  backing.pcmSha256 = hash(raw);
  writeFileSync(join(directory, backing.pcmFile), raw);
  write(join(directory, 'records', `${other.id}.json`), backing);
  const record = capture(directory, item);
  Object.assign(record, { captureOrigin: 'production-renderer-from-exact-worker-float32', backingRecord: other.id,
    backingPcmSha256: backing.pcmSha256, rendererSha256: hash(readFileSync('src/tts/omnivoice/whisper.js')) });
  write(join(directory, 'records', `${item.id}.json`), record);
  expect(report(directory).status).toBe(0);
  expect(read(join(directory, 'summary.json')).rows.find(row => row.id === item.id).status).toBe('integrity-failed');
}, 20_000);

it.each(['packaged-worker', 'packaged-adapter'])('checks %s whisper backing against the verified normal recording', captureOrigin => {
  const directory = fixture('--include-whisper');
  const corpus = read(join(directory, 'corpus.json')).languages;
  const normal = corpus.find(item => item.code === 'en' && !item.omniVoice.whisper);
  const whisper = corpus.find(item => item.code === 'en' && item.omniVoice.whisper);
  const backing = capture(directory, normal);
  const raw = Buffer.from(new Float32Array([0.1, 0.2]).buffer);
  backing.pcmFile = `pcm-${normal.id}.f32`;
  backing.pcmSha256 = hash(raw);
  backing.backingPcmSha256 = captureOrigin === 'packaged-adapter' ? 'd'.repeat(64) : backing.pcmSha256;
  writeFileSync(join(directory, backing.pcmFile), raw);
  write(join(directory, 'records', `${normal.id}.json`), backing);
  const record = capture(directory, whisper);
  record.captureOrigin = captureOrigin;
  record.backingPcmSha256 = backing.backingPcmSha256;
  write(join(directory, 'records', `${whisper.id}.json`), record);
  const analysis = read(join(directory, 'analysis', `${whisper.id}.json`));
  analysis.style = { whisperMargin: 1 };
  write(join(directory, 'analysis', `${whisper.id}.json`), analysis);
  expect(report(directory).status).toBe(0);
  expect(read(join(directory, 'summary.json')).rows.find(row => row.id === whisper.id)).toMatchObject({
    status: 'automatic-sample-pass', backingSpeechPassed: true,
  });
  record.backingPcmSha256 = 'c'.repeat(64);
  write(join(directory, 'records', `${whisper.id}.json`), record);
  expect(report(directory).status).toBe(0);
  expect(read(join(directory, 'summary.json')).rows.find(row => row.id === whisper.id)).toMatchObject({
    status: 'review-backing-speech', backingSpeechPassed: false,
  });
}, 20_000);
