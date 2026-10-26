// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DEFAULT_RETEST_DIRECTORY } from './prepare-language-retest.mjs';
import { createOmniVoiceRequest } from '../src/lib/omnivoice-settings.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const escape = value => String(value ?? '').replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function summarizeLanguageSamples(corpus, samples) {
  return [...new Set(corpus.languages.map(item => item.code))].map(code => {
    const expected = corpus.languages.filter(item => item.code === code);
    const found = samples.filter(item => item.code === code);
    const recognized = found.map(item => item.strongRecognition || item.recognition).filter(Boolean);
    const acoustic = found.map(item => item.signal?.dnsmos?.overall).filter(Number.isFinite);
    const totalCharacters = recognized.reduce((sum, item) => sum + item.expectedCharacters, 0);
    return { code, name: expected[0].name, expected: expected.length, analyzed: found.length,
      passes: found.filter(item => item.status === 'automatic-sample-pass').length,
      statuses: Object.fromEntries([...new Set(found.map(item => item.status))].map(status => [status, found.filter(item => item.status === status).length])),
      weightedCer: totalCharacters ? recognized.reduce((sum, item) => sum + item.edits, 0) / totalCharacters : null,
      worstCer: recognized.length ? Math.max(...recognized.map(item => item.cer)) : null,
      meanDnsMos: acoustic.length ? acoustic.reduce((sum, value) => sum + value, 0) / acoustic.length : null,
      worstDnsMos: acoustic.length ? Math.min(...acoustic) : null };
  });
}

async function main() {
  const directory = path.resolve(process.argv[2] || DEFAULT_RETEST_DIRECTORY);
  const corpus = JSON.parse(await readFile(path.join(directory, 'corpus.json'), 'utf8'));
  const runtime = JSON.parse(await readFile(path.join(directory, 'runtime.json'), 'utf8'));
  const samples = [], pending = [], invalid = [];
  for (const item of corpus.languages) {
    try {
      const record = JSON.parse(await readFile(path.join(directory, 'records', `${item.id}.json`), 'utf8'));
      const result = JSON.parse(await readFile(path.join(directory, 'analysis', `${item.id}.json`), 'utf8'));
      const expectedRequest = createOmniVoiceRequest(item.text, { detectCode: item.code, omniVoice: item.omniVoice });
      if (record.text !== item.text || record.code !== item.code || result.text !== item.text || result.code !== item.code
        || result.requestSha256 !== record.requestSha256 || record.requestSha256 !== hash(JSON.stringify(record.request))
        || record.requestSha256 !== hash(JSON.stringify(expectedRequest)) || result.analysisVersion !== 2
        || result.wavSha256 !== record.wavSha256 || record.workerSha256 !== runtime.workerSha256
        || (record.wav && hash(await readFile(path.join(directory, record.wav))) !== record.wavSha256)) {
        invalid.push(item.id); continue;
      }
      samples.push({ ...result, workerSha256: record.workerSha256, attempts: record.attempts });
    } catch (error) { if (error.code === 'ENOENT') pending.push(item.id); else throw error; }
  }
  const languages = summarizeLanguageSamples(corpus, samples);
  let detection = null;
  try { detection = JSON.parse(await readFile(path.join(directory, 'offline-language-detection.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const analysisErrors = samples.filter(item => item.status === 'analysis-error').map(item => item.id);
  const pendingStrongReview = samples.filter(item => ['review-acoustics', 'review-transcript'].includes(item.status) && !item.strongRecognition).map(item => item.id);
  const verified = { complete: !pending.length && !invalid.length && !analysisErrors.length && !pendingStrongReview.length, expectedSamples: corpus.languages.length,
    verifiedSamples: samples.length, pending, invalid, analysisErrors, pendingStrongReview, workers: [...new Set(samples.map(item => item.workerSha256))], languages,
    offlineDetection: detection ? { passages: detection.passages, correctPassages: detection.correctPassages,
      networkRequests: detection.networkRequests.length,
      reliableSingleSentences: detection.results.filter(item => item.kind === 'single-sentence' && item.detected.reliable).length,
      incorrectReliableDetections: detection.results.filter(item => item.detected.reliable && !item.correct).map(item => item.id) } : null };
  await writeFile(path.join(directory, 'verified-summary.json'), `${JSON.stringify(verified, null, 2)}\n`);
  const percent = value => value == null ? '—' : `${(value * 100).toFixed(1)}%`;
  const score = value => value == null ? '—' : value.toFixed(2);
  const scope = 'Eight distinct native-text samples per language; female/male, variations 1/2, normal speech. CER is character error rate. DNSMOS is an automatic acoustic estimate. A pass requires CER ≤10%, DNSMOS speech ≥2.5, background ≥2.0, overall ≥2.5, and passing physical signal checks. These are screening rules, not validated language-specific acceptance standards, listening approval or whole-language certification. Every synthesis failure stays in the denominator.';
  const report = ['# Current-runtime OmniVoice language retest', '', scope, '',
    `Verified analyses: ${samples.length}/${corpus.languages.length}. Invalid bindings: ${invalid.length}. Pending stronger-ASR reviews: ${pendingStrongReview.length}.`, '',
    '| Language | Passes | Weighted CER ↓ | Worst CER ↓ | Mean DNSMOS ↑ | Worst DNSMOS ↑ |', '|---|---:|---:|---:|---:|---:|',
    ...languages.map(item => `| ${item.name} (${item.code}) | ${item.passes}/${item.expected} | ${percent(item.weightedCer)} | ${percent(item.worstCer)} | ${score(item.meanDnsMos)} | ${score(item.worstDnsMos)} |`),
    '', 'Weighted CER and acoustic averages cover available scored recordings; the pass count includes all requested samples. See index.html for every input, transcript, status and WAV.',
    '', `Offline language detection: ${detection ? `${detection.correctPassages}/${detection.passages} longer passages correct with ${detection.networkRequests.length} network requests. ${verified.offlineDetection.reliableSingleSentences}/200 individual sentences accepted; ${verified.offlineDetection.incorrectReliableDetections.length} reliable incorrect detections. Short/uncertain text retains manual selection.` : 'pending'}`,
    '', 'The Portuguese source is Brazilian Portuguese, English is US English, and Chinese is Simplified Mandarin. Other country-specific accents have not been independently qualified.',
    '', `Worker hashes: ${verified.workers.join(', ') || 'pending'}.`, ''];
  await writeFile(path.join(directory, 'report.md'), report.join('\n'));
  const details = corpus.languages.map(item => {
    const result = samples.find(sample => sample.id === item.id);
    const recognition = result?.strongRecognition || result?.recognition;
    return `<details><summary>${escape(item.name)} · ${escape(item.id)} · ${escape(result?.status || 'pending')} · CER ${percent(recognition?.cer)} · DNSMOS ${score(result?.signal?.dnsmos?.overall)}</summary><p>${escape(item.omniVoice.gender)}, variation ${item.omniVoice.variation}</p><p lang="${escape(item.code)}">${escape(item.text)}</p><p>${escape(recognition?.transcript)}</p>${result?.wav ? `<audio controls preload="none" src="${escape(result.wav)}"></audio>` : ''}<p>${escape(result?.error || '')}</p></details>`;
  }).join('\n');
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OmniVoice language retest</title><style>body{font:16px/1.6 system-ui;max-width:1200px;margin:32px auto;padding:0 24px;color:#172331}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:8px;border-bottom:1px solid #ddd}details{border-bottom:1px solid #ddd;padding:12px 0}input{font:inherit;padding:8px;width:90%;margin:20px 0}audio{width:100%;max-width:500px}</style><h1>OmniVoice: current-runtime retest</h1><p>${escape(scope)}</p><p>${samples.length}/${corpus.languages.length} verified analyses · <a href="verified-summary.json">Raw summary</a> · <a href="offline-language-detection.json">Offline detection results</a></p><table><thead><tr><th>Language</th><th>Passes</th><th>Weighted CER</th><th>Worst CER</th><th>Mean DNSMOS</th><th>Worst DNSMOS</th></tr></thead><tbody>${languages.map(item => `<tr><td>${escape(item.name)}</td><td>${item.passes}/${item.expected}</td><td>${percent(item.weightedCer)}</td><td>${percent(item.worstCer)}</td><td>${score(item.meanDnsMos)}</td><td>${score(item.worstDnsMos)}</td></tr>`).join('')}</tbody></table><input aria-label="Filter samples" placeholder="Filter language, transcript or status"><section>${details}</section><script>document.querySelector('input').addEventListener('input',event=>{for(const sample of document.querySelectorAll('details'))sample.hidden=!sample.textContent.toLowerCase().includes(event.target.value.toLowerCase())})</script></html>`;
  await writeFile(path.join(directory, 'index.html'), html);
  console.log(JSON.stringify({ complete: verified.complete, verified: samples.length, expected: corpus.languages.length, invalid }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
