// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { PDF_NATURALNESS_SAMPLE } from '../tests/fixtures/pdf-naturalness-sample.js';
import { validateNaturalnessRatingPanel, validateNaturalnessReviews } from './pdf-acceptance-metrics.mjs';
import { validateNaturalnessRatings } from './run-pdf-acceptance.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const reviewerKey = value => value.trim().toLowerCase();
const escapeHtml = value => String(value).replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function validatePacket(packet) {
  if (packet?.backend !== 'original' || typeof packet.rubric !== 'string' || !packet.rubric.trim()
    || !Array.isArray(packet.passages) || packet.passages.length !== PDF_NATURALNESS_SAMPLE.length) {
    throw new Error('Use the complete 50-passage original-backend packet.');
  }
  for (const [index, sample] of PDF_NATURALNESS_SAMPLE.entries()) {
    const passage = packet.passages[index];
    if (passage?.passageId !== sample.id || typeof passage.transcript !== 'string' || !passage.transcript.trim()
      || sha256(passage.transcript) !== passage.transcriptSha256
      || JSON.stringify(passage.categories) !== JSON.stringify(sample.categories)) {
      throw new Error(`Invalid packet identity, transcript hash or categories: ${sample.id}.`);
    }
  }
}

export function createPdfNaturalnessReviewHtml(packet, packetSha256) {
  validatePacket(packet);
  if (!/^[a-f0-9]{64}$/u.test(packetSha256 || '')) throw new Error('An exact packet SHA-256 is required.');
  const blindPacket = { packetSha256, passages: packet.passages.map(({ passageId, transcriptSha256 }) => ({ passageId, transcriptSha256 })) };
  const panels = packet.passages.map((passage, index) => `<section><h2>Passage ${index + 1}</h2><p dir="auto">${escapeHtml(passage.transcript)}</p>
<label for="score-${index}">Score</label> <select id="score-${index}" data-passage="${escapeHtml(passage.passageId)}"><option value="">Unrated</option>${[1, 2, 3, 4, 5].map(score => `<option value="${score}">${score}</option>`).join('')}</select></section>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'">
<title>Blind PDF narration review</title><style>body{font:18px/1.6 system-ui,sans-serif;max-width:850px;margin:40px auto;padding:0 20px;color:#172129;background:#fff}section{margin:32px 0;padding:20px;border:1px solid #ccd4db;border-radius:8px}h1{line-height:1.2}h2{font-size:1.1em}select,input,button{font:inherit;padding:8px}label{font-weight:600}input[type=checkbox]{width:20px;height:20px;vertical-align:middle}button{background:#183f68;color:white;border:0;border-radius:4px;cursor:pointer}#status{font-weight:600}@media print{select,button,form{display:none}}</style></head>
<body><h1>Blind PDF narration review</h1><p>${escapeHtml(packet.rubric)}</p><p>Independently score each passage from 1 (very difficult to follow) to 5 (natural and easy to follow). Do not consult another reviewer's scores. Score only languages you can read.</p>
<p>Leave passages unrated if they are outside your assignment. A third reviewer should score only assigned disagreements. This page stays on your device; export downloads your original responses. Keep that file unchanged.</p>
${panels}
<form id="review"><p><label for="reviewer">Your reviewer ID</label><br><input id="reviewer" required autocomplete="off" placeholder="A stable name or pseudonym"></p>
<p><label><input id="human" type="checkbox" required> I am a human and independently reviewed every scored passage without seeing other reviewers' scores. I can read the passages I scored.</label></p>
<button type="submit">Export scored passages</button><p id="status" role="status"></p></form>
<script id="packet" type="application/json">${JSON.stringify(blindPacket).replace(/</gu, '\\u003c')}</script>
<script>
const packet = JSON.parse(document.getElementById('packet').textContent);
document.getElementById('review').addEventListener('submit', event => {
  event.preventDefault();
  const reviewerId = document.getElementById('reviewer').value.trim();
  const passages = packet.passages.flatMap((passage, index) => {
    const score = document.getElementById('score-' + index).value;
    return score ? [{ ...passage, rating: Number(score) }] : [];
  });
  if (!reviewerId || !document.getElementById('human').checked || !passages.length) {
    document.getElementById('status').textContent = 'Enter your reviewer ID, confirm independent human review, and score at least one passage.';
    return;
  }
  const response = { schemaVersion: 1, kind: 'human', blindedIndependentHumanReview: true, reviewerId,
    reviewedAt: new Date().toISOString(), packetSha256: packet.packetSha256, passages };
  const url = URL.createObjectURL(new Blob([JSON.stringify(response, null, 2) + '\\n'], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'pdf-naturalness-review-' + reviewerId.replace(/[^a-z0-9._-]/gi, '_') + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  document.getElementById('status').textContent = 'Exported ' + passages.length + ' original responses. Keep the downloaded JSON unchanged.';
});
</script></body></html>\n`;
}

export function combinePdfNaturalnessReviews(packet, responses, { packetSha256, existingRatings = [] } = {}) {
  validatePacket(packet);
  if (!/^[a-f0-9]{64}$/u.test(packetSha256 || '') || !Array.isArray(existingRatings) || !Array.isArray(responses)) throw new Error('Invalid review inputs.');
  const rows = new Map(packet.passages.map(passage => [passage.passageId, {
    passageId: passage.passageId, transcriptSha256: passage.transcriptSha256, ratings: [], reviews: [], categories: [...passage.categories],
  }]));
  const seenExisting = new Set();
  for (const existing of existingRatings) {
    const row = rows.get(existing?.passageId);
    const sample = PDF_NATURALNESS_SAMPLE.find(value => value.id === existing?.passageId);
    if (!row || seenExisting.has(row.passageId) || existing.transcriptSha256 !== row.transcriptSha256) throw new Error('Existing ratings have duplicate, unknown or stale transcripts.');
    validateNaturalnessRatings([existing], [sample]);
    row.ratings = [...existing.ratings];
    row.reviews = existing.reviews.map(review => ({ ...review }));
    seenExisting.add(row.passageId);
  }
  for (const response of responses) {
    if (response?.schemaVersion !== 1 || response.kind !== 'human' || response.blindedIndependentHumanReview !== true
      || response.packetSha256 !== packetSha256 || typeof response.reviewerId !== 'string' || !response.reviewerId.trim()
      || !Array.isArray(response.passages) || !response.passages.length) {
      throw new Error('Each original response must attest independent blinded human review and match the exact packet.');
    }
    const seen = new Set();
    for (const rating of response.passages) {
      const row = rows.get(rating?.passageId);
      if (!row || seen.has(row.passageId) || rating.transcriptSha256 !== row.transcriptSha256
        || !Number.isInteger(rating.rating) || rating.rating < 1 || rating.rating > 5) throw new Error('Response has duplicate, unknown, stale or invalid passage ratings.');
      if (row.reviews.some(review => reviewerKey(review.reviewerId) === reviewerKey(response.reviewerId))) {
        throw new Error(`Duplicate or conflicting reviewer response: ${row.passageId}.`);
      }
      const review = { kind: 'human', reviewerId: response.reviewerId.trim(), reviewedAt: response.reviewedAt, transcriptSha256: row.transcriptSha256 };
      validateNaturalnessReviews({ transcriptSha256: row.transcriptSha256, ratings: [rating.rating], reviews: [review] });
      row.ratings.push(rating.rating);
      row.reviews.push(review);
      seen.add(row.passageId);
    }
  }
  const incomplete = [...rows.values()].filter(row => row.ratings.length < 2).map(row => row.passageId);
  if (incomplete.length) throw new Error(`Missing independent review panels: ${incomplete.join(', ')}.`);
  const adjudication = [...rows.values()].filter(row => row.ratings.length === 2 && Math.abs(row.ratings[0] - row.ratings[1]) > 1).map(row => row.passageId);
  if (adjudication.length) throw new Error(`A third independent human review is required for: ${adjudication.join(', ')}.`);
  const result = [...rows.values()].map(row => {
    validateNaturalnessRatingPanel(row.ratings, row.passageId);
    validateNaturalnessReviews(row, row.passageId);
    const sorted = [...row.ratings].sort((a, b) => a - b);
    return { ...row, median: sorted.length === 3 ? sorted[1] : (sorted[0] + sorted[1]) / 2 };
  });
  validateNaturalnessRatings(result, PDF_NATURALNESS_SAMPLE);
  return result;
}

export async function runPdfNaturalnessReviewCommand(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { packet: { type: 'string' }, html: { type: 'string' },
    review: { type: 'string', multiple: true }, output: { type: 'string' }, existing: { type: 'string' } } });
  if (!values.packet || Boolean(values.html) === Boolean(values.output)
    || (values.html && (values.review || values.existing)) || (values.output && !values.review?.length)) {
    throw new Error('Use --packet PATH --html NEW.html, or --packet PATH --review RESPONSE.json (repeatable) [--existing RATINGS.json] --output NEW.json.');
  }
  const packetBytes = await readFile(values.packet);
  const packet = JSON.parse(packetBytes);
  const packetSha256 = sha256(packetBytes);
  const destination = path.resolve(values.html || values.output);
  await mkdir(path.dirname(destination), { recursive: true });
  if (values.html) {
    await writeFile(destination, createPdfNaturalnessReviewHtml(packet, packetSha256), { flag: 'wx' });
    return destination;
  }
  const responseBytes = await Promise.all(values.review.map(file => readFile(file)));
  const responses = responseBytes.map(bytes => JSON.parse(bytes));
  const existingBytes = values.existing ? await readFile(values.existing) : null;
  const records = combinePdfNaturalnessReviews(packet, responses, { packetSha256,
    existingRatings: existingBytes ? JSON.parse(existingBytes) : [] });
  const output = JSON.stringify(records, null, 2) + '\n';
  const receipt = { generatedAt: new Date().toISOString(), packet: { path: path.resolve(values.packet), sha256: packetSha256 },
    responses: responses.map((response, index) => ({ path: path.resolve(values.review[index]), sha256: sha256(responseBytes[index]),
      reviewerId: response.reviewerId, reviewedAt: response.reviewedAt })),
    existingRatings: existingBytes ? { path: path.resolve(values.existing), sha256: sha256(existingBytes) } : null,
    ratings: { path: destination, sha256: sha256(output), records: records.length },
    scope: 'Imports supplied human attestations; metadata alone cannot establish that humans performed independent reviews. Preserve and verify the original response files.' };
  for (const file of [destination, `${destination}.provenance.json`]) {
    try { await access(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`Refusing to overwrite ${file}.`);
  }
  await writeFile(destination, output, { flag: 'wx' });
  await writeFile(`${destination}.provenance.json`, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runPdfNaturalnessReviewCommand().then(file => console.log(`Wrote ${file}.`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
