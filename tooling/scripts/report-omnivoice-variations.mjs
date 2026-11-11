// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { getOmniVoiceSpeakerReference } from '../../src/tts/omnivoice/speakers.js';
import { getOmniVoiceLanguageOptions } from '../../src/tts/omnivoice/languages.js';
import { getOmniVoiceVoices } from '../../src/tts/omnivoice/preset-seeds.js';
import { createOmniVoiceRequest, getOmniVoicePickerState, isOmniVoiceWhisperAvailable } from '../../src/lib/omnivoice-settings.js';

const root = resolve(process.argv.find(arg => arg.startsWith('--directory='))?.slice(12) || 'artifacts/omnivoice-screening');
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const optional = async path => {
  try { return await read(path); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
};
const corpus = (await read(`${root}/corpus.json`)).languages;
const runtime = await read(`${root}/runtime.json`);
const scores = (await read(new URL('../config/omnivoice-voice-scores.json', import.meta.url))).voices;
const catalog = getOmniVoiceLanguageOptions().flatMap(language => ['female', 'male'].flatMap(gender =>
  getOmniVoiceVoices(language.code, gender).map(voiceId => ({ code: language.code, gender, voiceId }))));
const hasWhisper = corpus.some(item => item.omniVoice.whisper);
const modes = hasWhisper ? [false, true] : [false];
const key = ({ code, gender, voiceId, whisper }) => JSON.stringify([code, gender, voiceId, whisper]);
const scheduled = corpus.filter(item => !item.replayOf);
assert.equal(new Set(corpus.map(item => item.id)).size, corpus.length, 'Duplicate screening case ID');
assert.deepEqual(scheduled.map(item => key({ code: item.code, gender: item.omniVoice.gender,
  voiceId: item.omniVoice.voices?.[item.code], whisper: item.omniVoice.whisper === true })).sort(),
catalog.flatMap(voice => modes.map(whisper => key({ ...voice, whisper }))).sort(), 'Incomplete or duplicate stable voice coverage');
assert.equal(Object.keys(scores).length, catalog.length, 'Score catalog differs from the bundled voices');
for (const { code, voiceId } of catalog) {
  const reference = getOmniVoiceSpeakerReference({ lang: code, speakerId: voiceId });
  assert.equal(scores[voiceId]?.hash, reference.hash, `Stale reference score: ${voiceId}`);
}
const expected = catalog.length * modes.length;
const factorySha256 = hash(await readFile(new URL('../../src/lib/omnivoice-settings.js', import.meta.url)));
const rendererSha256 = hash(await readFile(new URL('../../src/tts/omnivoice/whisper.js', import.meta.url)));
const rows = [];
for (const item of corpus) {
  const request = createOmniVoiceRequest(item.text, { detectCode: item.code, omniVoice: item.omniVoice });
  const selected = getOmniVoiceSpeakerReference(request);
  const assessment = scores[request.speakerId];
  assert.ok(assessment, `Unknown screening voice: ${request.speakerId}`);
  const record = await optional(`${root}/records/${item.id}.json`);
  const analysis = await optional(`${root}/analysis/${item.id}.json`);
  const whisper = item.omniVoice.whisper === true;
  const unavailable = whisper && !isOmniVoiceWhisperAvailable(item.code);
  const row = { id: item.id, code: item.code, language: item.name, gender: item.omniVoice.gender,
    voiceId: request.speakerId, variation: getOmniVoicePickerState(item.omniVoice, item.code).rank,
    whisper, text: item.text, replayOf: item.replayOf || null, status: record?.status || 'not-captured',
    signal: analysis?.signal, recognition: analysis?.recognition, identityDiagnostic: analysis?.identityDiagnostic,
    recognitionMetric: analysis?.recognitionMetric, recognitionErrorRate: analysis?.recognitionErrorRate,
    recognitionDecision: analysis?.recognitionDecision, style: analysis?.style, backingSpeech: analysis?.backingSpeech,
    captureOrigin: record?.captureOrigin || 'packaged-worker', rendererConformance: record?.rendererConformance,
    replay: record?.replay, nativeListening: 'unverified', wav: record?.wav,
    referenceId: selected.referenceId, referenceReviewReasons: assessment.reviewFlags };
  if (record?.wav) {
    row.captureIntegrityPassed = hash(await readFile(`${root}/${record.wav}`)) === record.wavSha256
      && record.workerSha256 === runtime.workerSha256 && runtime.requestFactorySha256 === factorySha256
      && hash(JSON.stringify(record.request)) === record.requestSha256
      && record.requestSha256 === hash(JSON.stringify(request));
    if (record.captureOrigin === 'production-renderer-from-exact-worker-float32') {
      const backing = await read(`${root}/records/${record.backingRecord}.json`);
      const raw = await readFile(`${root}/${backing.pcmFile}`);
      const normalRequest = { ...request };
      delete normalRequest.whisper;
      row.captureIntegrityPassed &&= hash(raw) === backing.pcmSha256
        && record.backingPcmSha256 === backing.pcmSha256 && record.rendererSha256 === rendererSha256
        && backing.workerSha256 === runtime.workerSha256
        && backing.requestSha256 === hash(JSON.stringify(normalRequest))
        && hash(JSON.stringify(backing.request)) === backing.requestSha256;
    }
    row.integrityPassed = row.captureIntegrityPassed && (unavailable || (analysis?.wavSha256 === record.wavSha256
      && analysis?.workerSha256 === record.workerSha256 && analysis?.requestSha256 === record.requestSha256));
    const successes = (record.attempts || []).filter(attempt => attempt.speaker);
    row.fixedReferencePassed = successes.length > 0 && successes.every(attempt =>
      attempt.speaker.referenceHash === selected.hash && attempt.speaker.id === request.speakerId);
    if (!row.captureIntegrityPassed || (analysis && !row.integrityPassed)) row.status = 'integrity-failed';
    else if (!row.fixedReferencePassed) row.status = 'reference-identity-failed';
    else if (unavailable) row.status = 'unsupported-whisper';
    else row.status = analysis?.status || 'awaiting-analysis';
    if (whisper && !unavailable && row.status === 'automatic-sample-pass' && !(row.style?.whisperMargin > 0)) row.status = 'review-whisper-style';
    if (item.replayOf) {
      const baselineItem = scheduled.find(candidate => candidate.id === item.replayOf);
      const baseline = await optional(`${root}/records/${item.replayOf}.json`);
      row.replayPassed = baselineItem?.code === 'sv' && baselineItem.text === item.text
        && JSON.stringify(baselineItem.omniVoice) === JSON.stringify(item.omniVoice)
        && record.replay?.baseline === item.replayOf && record.replay?.equalPcm === true
        && typeof baseline?.pcmSha256 === 'string' && record.pcmSha256 === baseline.pcmSha256
        && record.replay.baselinePcmSha256 === baseline.pcmSha256 && record.wavSha256 === baseline.wavSha256;
    }
  }
  rows.push(row);
}
const matrix = rows.filter(row => !row.replayOf), replays = rows.filter(row => row.replayOf);
for (const row of rows.filter(row => row.whisper && isOmniVoiceWhisperAvailable(row.code))) {
  const normal = matrix.find(candidate => candidate.code === row.code && candidate.voiceId === row.voiceId && !candidate.whisper);
  const backing = normal && await optional(`${root}/records/${normal.id}.json`);
  const record = await optional(`${root}/records/${row.id}.json`);
  // Adapter playback can trim silence; worker hashes identify speech before that trim.
  const backingHash = row.captureOrigin === 'production-renderer-from-exact-worker-float32' ? backing?.pcmSha256 : backing?.backingPcmSha256;
  row.backingSpeechPassed = normal?.status === 'automatic-sample-pass' && normal.integrityPassed && normal.fixedReferencePassed
    && typeof backingHash === 'string' && record?.backingPcmSha256 === backingHash
    && typeof backing.pcmFile === 'string' && hash(await readFile(`${root}/${backing.pcmFile}`)) === backing.pcmSha256;
  if (row.status === 'automatic-sample-pass' && !row.backingSpeechPassed) row.status = 'review-backing-speech';
}
const counts = {};
for (const row of matrix) counts[row.status] = (counts[row.status] || 0) + 1;
const languages = getOmniVoiceLanguageOptions().map(({ code, label }) => {
  const cases = matrix.filter(row => row.code === code);
  return { code, name: label, total: cases.length,
    automaticPasses: cases.filter(row => row.status === 'automatic-sample-pass' && !row.referenceReviewReasons.length).length,
    unavailable: cases.filter(row => row.status === 'unsupported-whisper').length,
    flagged: cases.filter(row => !['automatic-sample-pass', 'unsupported-whisper'].includes(row.status) || row.referenceReviewReasons.length).map(row => row.id) };
});
const captureComplete = matrix.every(row => row.integrityPassed === true);
const derivedWhisper = matrix.some(row => row.captureOrigin === 'production-renderer-from-exact-worker-float32');
const controls = matrix.filter(row => row.whisper && row.variation === 1 && isOmniVoiceWhisperAvailable(row.code));
const rendererConformancePassed = !derivedWhisper || (controls.length === 2 * languages.filter(language => isOmniVoiceWhisperAvailable(language.code)).length
  && controls.every(row => row.captureOrigin === 'packaged-worker' && row.rendererConformance?.rendererSha256 === rendererSha256
    && row.rendererConformance?.passed === true && row.rendererConformance?.maxAbsoluteError <= 1e-6));
const expectedReplays = scheduled.filter(item => item.code === 'sv').map(item => item.id).sort();
const referenceScreeningPassed = catalog.every(({ voiceId }) => !scores[voiceId].reviewFlags.length);
const unavailableWhisperCases = matrix.filter(row => row.whisper && !isOmniVoiceWhisperAvailable(row.code)).length;
const result = { status: 'native-listening-unverified',
  scope: `${expected} development cases across ${languages.length} languages and ${catalog.length} stable voices${hasWhisper ? ', including whisper availability checks' : ''}. Automated screening does not establish native pronunciation, listening quality or hardware performance.`,
  unavailableWhisperCases, captureComplete, counts, rendererConformancePassed,
  referenceIdentityPassed: captureComplete && matrix.every(row => row.fixedReferencePassed),
  referenceScreeningPasses: catalog.filter(({ voiceId }) => !scores[voiceId].reviewFlags.length).length,
  referenceScreeningPassed, replayCount: replays.length,
  sameDeviceReplayPassed: JSON.stringify(replays.map(row => row.replayOf).sort()) === JSON.stringify(expectedReplays)
    && replays.every(row => {
      const baseline = matrix.find(candidate => candidate.id === row.replayOf);
      return row.integrityPassed && row.fixedReferencePassed && row.replayPassed
        && ['automatic-sample-pass', 'unsupported-whisper'].includes(row.status)
        && baseline?.integrityPassed && baseline.fixedReferencePassed
        && ['automatic-sample-pass', 'unsupported-whisper'].includes(baseline.status);
    }),
  automaticScreeningPassed: captureComplete && rendererConformancePassed && referenceScreeningPassed
    && matrix.every(row => ['automatic-sample-pass', 'unsupported-whisper'].includes(row.status)),
  workerSha256: runtime.workerSha256, languages, rows };
await writeFile(`${root}/summary.json`, `${JSON.stringify(result, null, 2)}\n`);
const esc = text => String(text ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const cellClass = row => row.status === 'unsupported-whisper' ? 'unavailable'
  : row.status === 'automatic-sample-pass' && !row.referenceReviewReasons.length ? 'pass'
    : ['not-captured', 'awaiting-analysis'].includes(row.status) ? 'pending' : 'flag';
const report = `<!doctype html><html lang="en"><meta charset="utf-8"><title>OmniVoice voice review</title>
<style>body{font:16px system-ui;max-width:1200px;margin:32px auto;padding:0 16px;color:#17212f;background:#f7f9fc}table{width:100%;border-collapse:collapse}th,td{padding:10px;text-align:left;border-bottom:1px solid #d4dce8}details{margin:12px 0;background:white;padding:14px}summary{cursor:pointer;font-weight:bold}audio{max-width:260px;height:36px}.flag{color:#a42b18}.pass{color:#14623b}.pending{color:#677284}p{max-width:85ch}small{display:block;max-width:32ch;margin-top:6px}</style>
<h1>OmniVoice voice review</h1><p>${esc(result.scope)}</p>
<p>Complete and bound capture: <b>${captureComplete}</b>. Fixed references: <b>${result.referenceIdentityPassed}</b>. Same-device restart replay: <b>${result.sameDeviceReplayPassed}</b>. Card scores without review flags: <b>${result.referenceScreeningPasses}/${catalog.length}</b>. Available audio sample passes: <b>${counts['automatic-sample-pass'] || 0}/${expected - unavailableWhisperCases}</b>.</p>
<p>Listen for pronunciation, missing or repeated words, noise and naturalness. Each language retains every voice and flagged recording.</p>
${languages.map(language => `<details id="${esc(language.code)}" ${language.code === 'sv' ? 'open' : ''}>
<summary>${esc(language.name)} — ${language.automaticPasses}/${language.total - language.unavailable} available audio sample passes${language.unavailable ? `; ${language.unavailable} unavailable-whisper checks` : ''}</summary>
<table><thead><tr><th>Voice</th><th>Result and recognized text</th><th>Recognition error</th><th>Acoustic score</th><th>Recording</th></tr></thead>
<tbody>${matrix.filter(row => row.code === language.code).map(row => `<tr class="${cellClass(row)}">
<td>${row.whisper ? 'Whisper ' : ''}${esc(row.gender)} ${row.variation}<small>${esc(row.voiceId)}</small></td>
<td>${esc(row.status)}<small lang="${esc(row.code)}">${esc(row.recognition?.transcript)}</small>${row.referenceReviewReasons.length ? `<small>Card review: ${esc(row.referenceReviewReasons.join(', '))}</small>` : ''}</td>
<td>${row.recognition ? (100 * (row.recognitionErrorRate ?? row.recognition.cer)).toFixed(1) + '%' : '—'}<small>${esc(row.recognitionMetric || 'character-error')}</small></td>
<td>${row.signal?.dnsmos?.overall?.toFixed(2) || '—'}</td>
<td>${row.wav ? `<audio controls preload="none" src="${esc(row.wav)}"></audio>` : 'No recording'}</td></tr>`).join('')}</tbody></table></details>`).join('')}</html>`;
await writeFile(`${root}/review.html`, report);
console.log(JSON.stringify({ ...result, rows: undefined, languages: undefined }));
if (process.argv.includes('--require-pass') && (!result.automaticScreeningPassed || !result.sameDeviceReplayPassed)) process.exitCode = 1;
