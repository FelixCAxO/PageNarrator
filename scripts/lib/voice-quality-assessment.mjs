import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { QUALITY_CORPUS_SHA256, hashQualityBytes } from './kokoro-quality-controls.mjs';

export const VOICE_QUALITY_PROTOCOL = JSON.parse(readFileSync(new URL('../../config/voice-quality-protocol.json', import.meta.url), 'utf8'));
const corpusBytes = readFileSync(new URL('../../tests/voice/fixtures/quality-corpus.json', import.meta.url));
if (hashQualityBytes(corpusBytes) !== QUALITY_CORPUS_SHA256) throw new Error('Voice review corpus changed.');
export const VOICE_REVIEW_CORPUS = JSON.parse(corpusBytes);
export const voiceCaseId = (backend, voice, id) => `${backend}:${voice}:${id}`;

function interval(values, seedText) {
  if (values.every(x => x === values[0])) return { lower: values[0], upper: values[0] };
  let seed = createHash('sha256').update(seedText).digest().readUInt32LE(0) || 1;
  const samples = new Float64Array(VOICE_QUALITY_PROTOCOL.bootstrapReplicates);
  for (let i = 0; i < samples.length; i++) {
    let total = 0;
    for (let j = 0; j < values.length; j++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      total += values[Math.floor((seed >>> 0) / 4294967296 * values.length)];
    }
    samples[i] = total / values.length;
  }
  samples.sort();
  return { lower: samples[Math.floor((samples.length - 1) * .025)], upper: samples[Math.ceil((samples.length - 1) * .975)] };
}

export function assessVoiceListening(packet, key, responses, packetSha256) {
  const p = VOICE_QUALITY_PROTOCOL, expected = new Map();
  for (const backend of p.backends) for (const voice of VOICE_REVIEW_CORPUS.voices) for (const entry of VOICE_REVIEW_CORPUS.test) {
    expected.set(voiceCaseId(backend, voice, entry.id), { backend, voice, ...entry });
  }
  if (packet?.schemaVersion !== 1 || packet.method !== p.method || packet.partition !== 'test'
    || packet.corpusSha256 !== QUALITY_CORPUS_SHA256 || packet.evaluationScope !== 'frozen-corpus-regression-study'
    || !Array.isArray(packet.samples) || packet.samples.length !== expected.size
    || key?.packetSha256 !== packetSha256 || !/^[a-f0-9]{64}$/u.test(packetSha256 || '')) throw new Error('Invalid or incomplete bound voice packet.');
  const ids = new Set();
  for (const sample of packet.samples) {
    const entry = expected.get(sample.id);
    if (!entry || ids.has(sample.id) || sample.text !== entry.text || sample.category !== entry.category
      || sample.backend !== entry.backend || sample.voice !== entry.voice || !['A', 'B'].includes(key.candidateLabels?.[sample.id])) throw new Error('Voice packet roster or blinding key differs.');
    ids.add(sample.id);
  }
  const reviewers = new Map(), contentFailures = [];
  for (const response of responses) {
    const id = typeof response.reviewerId === 'string' ? response.reviewerId.trim().toLowerCase() : '';
    if (response.schemaVersion !== 1 || response.kind !== 'human' || response.independentBlindedHumanReview !== true
      || !id || !Number.isFinite(Date.parse(response.reviewedAt)) || response.packetSha256 !== packetSha256
      || !Array.isArray(response.samples) || !response.samples.length) throw new Error('Original independent human review does not match the packet.');
    const ratings = reviewers.get(id) ?? new Map(); reviewers.set(id, ratings);
    for (const sample of response.samples) {
      if (!expected.has(sample.id) || ratings.has(sample.id)) throw new Error('Duplicate or unknown voice review sample.');
      for (const label of ['A', 'B']) {
        const rating = sample[label];
        if (typeof rating?.contentCorrect !== 'boolean' || p.dimensions.some(d => !Number.isInteger(rating?.scores?.[d]) || rating.scores[d] < 1 || rating.scores[d] > 5)) throw new Error('Incomplete voice ratings or content review.');
      }
      ratings.set(sample.id, sample);
      if (!sample[key.candidateLabels[sample.id]].contentCorrect) contentFailures.push(sample.id);
    }
  }
  const groups = [], reasons = [];
  for (const backend of p.backends) for (const voice of VOICE_REVIEW_CORPUS.voices) {
    const samples = VOICE_REVIEW_CORPUS.test.map(entry => voiceCaseId(backend, voice, entry.id));
    const panels = [...reviewers.values()].filter(ratings => samples.every(id => ratings.has(id)));
    const dimensions = {};
    if (panels.length < p.listenersRequiredPerVoiceAndBackend) reasons.push(`${backend}/${voice}: ${panels.length}/${p.listenersRequiredPerVoiceAndBackend} complete independent listeners`);
    else for (const dimension of p.dimensions) {
      const differences = panels.map(ratings => samples.reduce((sum, id) => {
        const candidate = key.candidateLabels[id], reference = candidate === 'A' ? 'B' : 'A', rating = ratings.get(id);
        return sum + rating[candidate].scores[dimension] - rating[reference].scores[dimension];
      }, 0) / samples.length);
      const ci = interval(differences, `${p.method}:${backend}:${voice}:${dimension}`);
      dimensions[dimension] = { meanDifference: differences.reduce((a, b) => a + b, 0) / differences.length, ...ci };
      if (!(ci.lower > p.minimumClustered95PercentLowerBound)) reasons.push(`${backend}/${voice}/${dimension}: lower confidence bound ${ci.lower} does not exceed ${p.minimumClustered95PercentLowerBound}`);
    }
    groups.push({ backend, voice, listeners: panels.length, dimensions });
  }
  if (contentFailures.length) reasons.push(`${new Set(contentFailures).size} candidate clips have unresolved content, pronunciation or audio errors`);
  return { status: reasons.length ? 'not-qualified' : 'qualified', method: p.method,
    scope: 'Independent human listening on the fixed regression corpus; not unseen text or every language.',
    listenerCount: reviewers.size, groups, contentFailures: [...new Set(contentFailures)], reasons };
}
