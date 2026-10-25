import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { expect, it } from 'vitest';
import { QUALITY_CORPUS_SHA256, hashQualityBytes, assessQualityTranscript, selectQualityCases, qualitySourceAssociation, saveQualityClip, reusableQualityClip } from '../../scripts/lib/kokoro-quality-controls.mjs';

it('pins the existing validation/test split and selects bounded voice/category groups without merging partitions', async () => {
  const bytes = await readFile('tests/voice/fixtures/quality-corpus.json'); expect(hashQualityBytes(bytes)).toBe(QUALITY_CORPUS_SHA256);
  const freeze = { corpus: JSON.parse(bytes) };
  const selected = selectQualityCases(freeze, { partition: 'test', voices: ['af_heart', 'bf_emma'], cases: ['test-numbers', 'test-technical'] });
  expect(selected).toHaveLength(4); expect(selected.every(value => value.id.startsWith('test-') && value.speed === 1)).toBe(true);
  expect(() => selectQualityCases(freeze, { partition: 'test', voices: ['af_heart'], cases: ['validation-numbers'] })).toThrow();
  expect(() => selectQualityCases(freeze, { partition: 'test', voices: ['unknown'] })).toThrow();
});

it('compares independent spoken numbers while preserving incorrect values and missing content as failures', () => {
  const entry = { id: 'test-numbers' }, spoken = { 'test-numbers': ['at eighteen forty five the display showed twenty one point five degrees the invoice total was eighty seven pounds and thirty pence in twenty twenty eight'] };
  const transcript = 'At 18:45, the display showed 21.5 degrees. The invoice total was £87.30 in 2028.';
  expect(assessQualityTranscript(entry, transcript, spoken)).toMatchObject({ completeTranscript: true, tailPass: true, edits: 0 });
  expect(assessQualityTranscript(entry, transcript.replace('21.5', '21.6'), spoken).completeTranscript).toBe(false);
  expect(assessQualityTranscript(entry, transcript.replace(' in 2028', ''), spoken).tailPass).toBe(false);
  expect(assessQualityTranscript(entry, transcript.replace('£87.30', '£87.30 £87.30'), spoken).completeTranscript).toBe(false);
});

it('accepts independently allowed acronym renderings without erasing a missing HTTPS letter', () => {
  const entry = { id: 'test-technical' }, spoken = { 'test-technical': ['the a p i returns jason over h t t p s', 'the a p i returns j s o n over h t t p s'] };
  expect(assessQualityTranscript(entry, 'The API returns JSON over HTTPS.', spoken).completeTranscript).toBe(true);
  expect(assessQualityTranscript(entry, 'The A P I returns Jason over H T T P S.', spoken).completeTranscript).toBe(true);
  expect(assessQualityTranscript(entry, 'The API returns JSON over H T P S.', spoken).completeTranscript).toBe(false);
});

it('allows silent newline-only source gaps while rejecting missing, reordered or repeated spoken source', () => {
  const text = 'First page.\n\nNext page.';
  expect(qualitySourceAssociation(text, [{ text: 'First page.' }, { text: 'Next page.' }])).toMatchObject({ silentWhitespaceCharacters: 2 });
  expect(() => qualitySourceAssociation(text, [{ text: 'First ' }, { text: 'Next page.' }])).toThrow('association');
  expect(() => qualitySourceAssociation(text, [{ text: 'Next page.' }, { text: 'First page.' }])).toThrow('association');
  expect(() => qualitySourceAssociation(text, [{ text: 'First page.' }, { text: 'First page.' }])).toThrow('association');
  expect(() => qualitySourceAssociation(text, [{ text: 'First page.' }])).toThrow('omitted');
});

it('resumes only the exact pinned raw float32 and WAV bytes, detecting corruption below WAV quantization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pn-quality-control-'));
  try {
    const record = await saveQualityClip(directory, 'sample', Float32Array.of(.1, -.2, .3), { fingerprint: 'frozen' });
    expect((await reusableQualityClip(directory, 'sample', 'frozen')).raw.sha256).toBe(record.raw.sha256);
    await expect(reusableQualityClip(directory, 'sample', 'changed-source')).rejects.toThrow('different');
    const raw = await readFile(join(directory, record.raw.file)); raw[0] ^= 1; await writeFile(join(directory, record.raw.file), raw);
    await expect(reusableQualityClip(directory, 'sample', 'frozen')).rejects.toThrow('corrupted');
  } finally {
    const absolute = await realpath(directory), parent = await realpath(tmpdir());
    if (!absolute.startsWith(`${parent}${sep}pn-quality-control-`)) throw new Error('Refusing cleanup outside the created test directory.');
    await rm(absolute, { recursive: true, force: true });
  }
});
