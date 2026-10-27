import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { prepareVoiceReviews, readVoiceReviewPacket, evaluateVoiceReceipt } from '../../scripts/voice-listening-reviews.mjs';
import { VOICE_REVIEW_CORPUS as corpus } from '../../scripts/lib/voice-quality-assessment.mjs';
import { QUALITY_CORPUS_SHA256, qualityFingerprint, saveQualityClip } from '../../scripts/lib/kokoro-quality-controls.mjs';

let freeze;
vi.mock('../../scripts/lib/kokoro-quality-controls.mjs', async original => ({ ...await original(), readQualityFreeze: vi.fn(async () => freeze) }));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pn-voice-review-unit-')), freezePath = join(directory, 'freeze.json');
  freeze = { corpusSha256: QUALITY_CORPUS_SHA256, sourcePins: { synthetic: 'unit-only' }, packagedBuild: { sha256: 'unit-build' }, expectedSpoken: Object.fromEntries(corpus.test.map(x => [x.id, [x.text]])),
    data: { files: [{ path: 'onnx/model_quantized.onnx', sha256: 'q8' }, { path: 'onnx/model.onnx', sha256: 'fp32' }] } };
  await writeFile(freezePath, JSON.stringify(freeze)); const freezeHash = hash(await readFile(freezePath));
  const audio = await saveQualityClip(directory, 'synthetic-unit-audio', Float32Array.of(.1, -.2, .3), {}), reports = [];
  for (const backend of ['wasm', 'webgpu']) {
    const dtype = backend === 'wasm' ? 'q8' : 'fp32', lane = backend === 'wasm' ? 'wasm' : 'synthetic-gpu-0,1';
    const cases = corpus.voices.flatMap(voice => corpus.test.map(item => {
      const entry = { ...item, voice, speed: 1, mode: 'stream' };
      const fingerprint = qualityFingerprint({ corpus: freeze.corpusSha256, entry, dtype, lane, data: freeze.data, sourcePins: freeze.sourcePins, packagedBuild: freeze.packagedBuild,
        policy: 'Actual app registry/worker, raw fixture text into stream, phase correction enabled.' });
      const legacyFingerprint = qualityFingerprint({ corpus: freeze.corpusSha256, entry, dtype, rawGraph: freeze.data.files.find(x => x.sha256 === dtype), data: freeze.data,
        legacyPins: freeze.legacyPins, inputPolicy: 'Raw fixture text pushed once into public TextSplitterStream and closed; unmodified KokoroTTS.stream normalization/tokenization/eSpeak.' });
      return { entry, candidate: { ...audio, entry, fingerprint, dtype, backend: lane, modelInfo: { originalSha256: dtype, version: 'kokoro-exact-zero-phase-v2' }, chunks: [{ text: item.text }] },
        legacy: { ...audio, entry, fingerprint: legacyFingerprint, dtype, graphSha256: dtype } };
    }));
    const path = join(directory, `${backend}.json`); reports.push(path);
    await writeFile(path, JSON.stringify({ device: backend, partition: 'test', functionalStatus: 'pass', manifestSha256: freezeHash, cases }));
  }
  return { directory, freezePath, reports, packet: join(directory, 'packet') };
}
async function cleanup(directory) {
  const target = await realpath(directory), parent = await realpath(tmpdir());
  if (!target.startsWith(`${parent}${sep}pn-voice-review-unit-`)) throw new Error('Refusing cleanup outside the unit-test directory.');
  await rm(target, { recursive: true, force: true });
}

it('copies neutral blind audio and rejects modified packets, clips, source freezes and original receipts', async () => {
  const f = await fixture();
  try {
    expect(await prepareVoiceReviews(f.directory, f.freezePath, f.reports, f.packet)).toMatchObject({ pairs: 160, status: 'human reviews pending' });
    const input = await readVoiceReviewPacket(f.directory, f.packet), receiptPath = join(f.directory, 'receipt.json');
    expect(input.packet.samples.every(x => !/candidate|legacy/u.test(x.A.file + x.B.file))).toBe(true);
    const receipt = { schemaVersion: 1, directory: f.packet, packetSha256: input.packetSha256, keySha256: input.keySha256, originalResponses: [] };
    await writeFile(receiptPath, JSON.stringify(receipt));
    expect(await evaluateVoiceReceipt(f.directory, receiptPath)).toMatchObject({ status: 'not-qualified' });
    const mediaPath = join(f.packet, 'media', input.packet.samples[0].A.file), media = await readFile(mediaPath);
    const changed = Buffer.from(media); changed[0] ^= 1; await writeFile(mediaPath, changed);
    await expect(evaluateVoiceReceipt(f.directory, receiptPath)).rejects.toThrow('clip bytes changed'); await writeFile(mediaPath, media);
    const keyPath = join(f.packet, 'private-key.json'), keyBytes = await readFile(keyPath);
    await writeFile(keyPath, `${keyBytes.toString()} `);
    await expect(evaluateVoiceReceipt(f.directory, receiptPath)).rejects.toThrow('provenance'); await writeFile(keyPath, keyBytes);
    const changedKey = JSON.parse(keyBytes), id = input.packet.samples[0].id;
    changedKey.candidateLabels[id] = changedKey.candidateLabels[id] === 'A' ? 'B' : 'A';
    await writeFile(keyPath, JSON.stringify(changedKey));
    await expect(readVoiceReviewPacket(f.directory, f.packet)).rejects.toThrow('blinding key changed'); await writeFile(keyPath, keyBytes);
    const response = { schemaVersion: 1, kind: 'human', reviewerId: 'Synthetic unit-only listener', reviewedAt: '2026-10-26T12:00:00Z',
      independentBlindedHumanReview: true, packetSha256: input.packetSha256, samples: input.packet.samples.map(s => ({ id: s.id,
        A: { scores: { intelligibility: 4, 'voice identity': 4, pronunciation: 4, prosody: 4 }, contentCorrect: true },
        B: { scores: { intelligibility: 4, 'voice identity': 4, pronunciation: 4, prosody: 4 }, contentCorrect: true } })) };
    const responsePath = join(f.directory, 'synthetic-unit-response.json'); await writeFile(responsePath, JSON.stringify(response));
    receipt.originalResponses.push({ path: responsePath, sha256: hash(await readFile(responsePath)) }); await writeFile(receiptPath, JSON.stringify(receipt));
    expect(await evaluateVoiceReceipt(f.directory, receiptPath)).toMatchObject({ status: 'not-qualified', listenerCount: 1 });
    await writeFile(responsePath, '{}'); await expect(evaluateVoiceReceipt(f.directory, receiptPath)).rejects.toThrow('Original voice response changed');
    await writeFile(f.freezePath, '{}'); await expect(readVoiceReviewPacket(f.directory, f.packet)).rejects.toThrow('freeze or protocol');
  } finally { await cleanup(f.directory); }
});

it.each(['reference', 'silent', 'wav'])('rejects false %s evidence before preparing a review', async kind => {
  const f = await fixture();
  try {
    const report = JSON.parse(await readFile(f.reports[0])), record = report.cases[0].legacy;
    if (kind === 'reference') record.fingerprint = 'different-reference';
    else {
      const descriptor = kind === 'silent' ? record.raw : record.wav;
      const bytes = kind === 'silent' ? Buffer.alloc(record.samples * 4) : Buffer.from('invalid WAV');
      descriptor.file = `${kind}-unit-only.bin`; descriptor.bytes = bytes.length; descriptor.sha256 = hash(bytes);
      await writeFile(join(f.directory, descriptor.file), bytes);
    }
    await writeFile(f.reports[0], JSON.stringify(report));
    await expect(prepareVoiceReviews(f.directory, f.freezePath, f.reports, f.packet)).rejects.toThrow(kind === 'reference' ? 'source, model or actual backend' : kind === 'silent' ? 'Silent raw' : 'WAV differs');
  } finally { await cleanup(f.directory); }
});

it('refuses stale captures and path traversal instead of creating a usable review packet', async () => {
  const f = await fixture();
  try {
    const report = JSON.parse(await readFile(f.reports[0])); report.cases[0].candidate.fingerprint = 'stale';
    await writeFile(f.reports[0], JSON.stringify(report));
    await expect(prepareVoiceReviews(f.directory, f.freezePath, f.reports, f.packet)).rejects.toThrow('source, model or actual backend');
    const entry = report.cases[0].entry;
    report.cases[0].candidate.fingerprint = qualityFingerprint({ corpus: freeze.corpusSha256, entry, dtype: 'q8', lane: 'wasm', data: freeze.data, sourcePins: freeze.sourcePins, packagedBuild: freeze.packagedBuild,
      policy: 'Actual app registry/worker, raw fixture text into stream, phase correction enabled.' });
    report.cases[0].candidate.raw.file = '../outside.f32'; await writeFile(f.reports[0], JSON.stringify(report));
    await expect(prepareVoiceReviews(f.directory, f.freezePath, f.reports, join(f.directory, 'other-packet'))).rejects.toThrow('clip path');
  } finally { await cleanup(f.directory); }
});
