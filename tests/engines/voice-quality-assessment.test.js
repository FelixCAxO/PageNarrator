import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { assessVoiceListening, VOICE_QUALITY_PROTOCOL as protocol, VOICE_REVIEW_CORPUS as corpus, voiceCaseId } from '../../scripts/lib/voice-quality-assessment.mjs';
import { QUALITY_CORPUS_SHA256 } from '../../scripts/lib/kokoro-quality-controls.mjs';
import { createVoiceReviewHtml } from '../../scripts/voice-listening-reviews.mjs';
import { verifyVoiceQuality } from '../../scripts/verify-voice-quality.mjs';

// Synthetic unit-test panels only. These are never written as real review evidence.
function study(listeners = 20) {
  const packet = { schemaVersion: 1, method: protocol.method, partition: 'test', corpusSha256: QUALITY_CORPUS_SHA256,
    evaluationScope: 'frozen-corpus-regression-study', samples: [] }, key = { candidateLabels: {} };
  for (const backend of protocol.backends) for (const voice of corpus.voices) for (const entry of corpus.test) {
    const id = voiceCaseId(backend, voice, entry.id);
    key.candidateLabels[id] = packet.samples.length % 2 ? 'A' : 'B';
    packet.samples.push({ id, backend, voice, category: entry.category, text: entry.text,
      A: { file: 'neutral-a.wav' }, B: { file: 'neutral-b.wav' } });
  }
  const digest = createHash('sha256').update(JSON.stringify(packet)).digest('hex'); key.packetSha256 = digest;
  const rating = () => ({ scores: Object.fromEntries(protocol.dimensions.map(x => [x, 4])), contentCorrect: true });
  const responses = Array.from({ length: listeners }, (_, i) => ({ schemaVersion: 1, kind: 'human', independentBlindedHumanReview: true,
    reviewerId: `Synthetic unit listener ${i}`, reviewedAt: '2026-10-26T12:00:00Z', packetSha256: digest,
    samples: packet.samples.map(x => ({ id: x.id, A: rating(), B: rating() })) }));
  return { packet, key, digest, responses };
}
const assess = x => assessVoiceListening(x.packet, x.key, x.responses, x.digest);

it('requires the documented 20 listeners, four dimensions and strict -0.25 margin', () => {
  expect(protocol.listenersRequiredPerVoiceAndBackend).toBe(20);
  expect(protocol.dimensions).toEqual(['intelligibility', 'voice identity', 'pronunciation', 'prosody']);
  expect(protocol.minimumClustered95PercentLowerBound).toBe(-.25);
  expect(protocol.bootstrapReplicates).toBe(10000);
});
it('qualifies complete blinded synthetic control panels with equal candidate/reference scores', () => {
  const result = assess(study());
  expect(result.status).toBe('qualified'); expect(result.groups).toHaveLength(20);
  expect(result.groups.every(x => x.listeners === 20)).toBe(true);
});
it('keeps absent or insufficient human evidence unqualified', async () => {
  expect(assess(study(0)).status).toBe('not-qualified');
  expect(assess(study(19)).status).toBe('not-qualified');
  expect(await verifyVoiceQuality({ receipt: '' })).toMatchObject({ status: 'not-qualified' });
});
it('does not let pooled good voices hide one failing voice or backend', () => {
  const x = study(), ids = x.packet.samples.filter(s => s.voice === 'bf_emma' && s.backend === 'wasm').map(s => s.id);
  for (const response of x.responses) for (const sample of response.samples) if (ids.includes(sample.id)) {
    sample[x.key.candidateLabels[sample.id]].scores.pronunciation = 2;
  }
  const result = assess(x);
  expect(result.status).toBe('not-qualified'); expect(result.reasons.some(r => r.includes('wasm/bf_emma/pronunciation'))).toBe(true);
});
it('requires the confidence bound to exceed rather than equal the margin', () => {
  const x = study(), ids = x.packet.samples.filter(s => s.voice === 'af_heart' && s.backend === 'wasm').slice(0, 2).map(s => s.id);
  for (const response of x.responses) for (const sample of response.samples) if (ids.includes(sample.id)) sample[x.key.candidateLabels[sample.id]].scores.prosody = 3;
  expect(assess(x).reasons.some(r => r.includes('lower confidence bound -0.25'))).toBe(true);
});
it('clusters intervals by listener rather than counting passages as independent humans', () => {
  const x = study();
  for (let i = 0; i < x.responses.length; i++) for (const sample of x.responses[i].samples) {
    sample[x.key.candidateLabels[sample.id]].scores.intelligibility = i < 10 ? 3 : 5;
  }
  const result = assess(x), ci = result.groups[0].dimensions.intelligibility;
  expect(ci.meanDifference).toBe(0); expect(ci.lower).toBeLessThan(-.25); expect(ci.upper).toBeGreaterThan(.25);
  expect(assess(x)).toEqual(result);
});
it('keeps unresolved missing words, pronunciation or invalid audio unqualified', () => {
  const x = study(), sample = x.responses[0].samples[0]; sample[x.key.candidateLabels[sample.id]].contentCorrect = false;
  expect(assess(x)).toMatchObject({ status: 'not-qualified', contentFailures: [sample.id] });
});
it('rejects automated reviews, duplicate identities and altered case coverage', () => {
  let x = study(); x.responses[0].kind = 'automated'; expect(() => assess(x)).toThrow('human');
  x = study(); x.responses[1].reviewerId = x.responses[0].reviewerId.toUpperCase(); expect(() => assess(x)).toThrow('Duplicate');
  x = study(); x.packet.samples.pop(); expect(() => assess(x)).toThrow('incomplete');
  x = study(); x.packet.samples[0].text = 'Changed text'; expect(() => assess(x)).toThrow('roster');
  x = study(); x.responses[0].samples[0].A.scores.prosody = 6; expect(() => assess(x)).toThrow('ratings');
});
it('collects partial assignments without inventing missing ratings or counting repeated identities twice', () => {
  const x = study(); const original = x.responses[0], rest = { ...original, samples: original.samples.splice(80) };
  x.responses.push(rest); expect(assess(x)).toMatchObject({ status: 'qualified', listenerCount: 20 });
});
it('renders neutral media names and exports original independent responses without a network endpoint', () => {
  const x = study(), html = createVoiceReviewHtml(x.packet, x.digest);
  expect(html).toContain('media/neutral-a.wav'); expect(html).toContain('independentBlindedHumanReview');
  expect(html).toContain("connect-src 'none'"); expect(html).not.toContain('candidateLabels');
  expect(html).not.toContain('private-key');
});
