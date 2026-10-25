// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original temporary bytes only. No historical screenshots or document transcriptions.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  OCR_PRIVATE_FIXTURE_ENV, hasPrivateOcrFixtures, privateOcrFixturePath,
  readOcrSourceFile, readPinnedPrivateOcrFixture, readPrivateOcrFixture,
} from '../../scripts/lib/ocr-private-fixtures.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const roots = [];
const originalEnvironment = process.env[OCR_PRIVATE_FIXTURE_ENV];
const sample = Buffer.from('Original geometry control.\n');

async function authoredFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pagenarrator-private-ocr-test-'));
  roots.push(directory);
  const file = 'authored-sample.txt';
  await writeFile(join(directory, file), sample);
  const manifestBytes = Buffer.from(JSON.stringify({ files: [{
    source: `tests/fixtures/ocr/${file}`, file, bytes: sample.length, sha256: hash(sample),
  }] }));
  await writeFile(join(directory, 'PRIVATE-FIXTURE-MANIFEST.json'), manifestBytes);
  return { directory, manifestSha256: hash(manifestBytes), file };
}

afterEach(async () => {
  if (originalEnvironment === undefined) delete process.env[OCR_PRIVATE_FIXTURE_ENV];
  else process.env[OCR_PRIVATE_FIXTURE_ENV] = originalEnvironment;
  for (const directory of roots.splice(0)) {
    // Verify each recursive-delete target is the temporary directory created by this file.
    if (dirname(resolve(directory)) !== resolve(tmpdir())
      || !basename(directory).startsWith('pagenarrator-private-ocr-test-')) throw new Error('Unexpected cleanup target.');
    await rm(directory, { recursive: true, force: true });
  }
});

describe('explicit private OCR fixture inputs', () => {
  it('refuses traversal and absolute outside-root names before reading files', async () => {
    const fixture = await authoredFixture();
    process.env[OCR_PRIVATE_FIXTURE_ENV] = fixture.directory;
    const names = ['../outside.txt', '..\\outside.txt', 'nested/sample.txt',
      resolve(fixture.directory, '..', 'outside.txt'), 'C:\\outside.txt',
      'tests/fixtures/ocr/../../outside.txt'];
    for (const name of names) {
      expect(() => privateOcrFixturePath(name)).toThrow('Invalid historical OCR fixture name');
      await expect(readPinnedPrivateOcrFixture(name, fixture)).rejects.toThrow('Invalid historical OCR fixture name');
    }
  });

  it('resolves a historical reference alias to the same pinned original bytes', async () => {
    const fixture = await authoredFixture();
    process.env[OCR_PRIVATE_FIXTURE_ENV] = fixture.directory;
    const alias = `tests/fixtures/ocr/${fixture.file}`;
    expect(privateOcrFixturePath(alias)).toBe(join(fixture.directory, fixture.file));
    expect(privateOcrFixturePath(fixture.file)).toBe(privateOcrFixturePath(alias));
    expect(await readPinnedPrivateOcrFixture(alias, fixture)).toEqual(sample);
    expect(await readPinnedPrivateOcrFixture(fixture.file, fixture, 'utf8')).toBe(sample.toString('utf8'));
  });

  it('rejects changed selected bytes even when the file length is unchanged', async () => {
    const fixture = await authoredFixture();
    const changed = Buffer.from(sample); changed[0] = 'X'.charCodeAt(0);
    await writeFile(join(fixture.directory, fixture.file), changed);
    await expect(readPinnedPrivateOcrFixture(fixture.file, fixture)).rejects.toThrow('Historical OCR fixture bytes changed');
  });

  it('rejects a corrupted manifest before trusting its file records', async () => {
    const fixture = await authoredFixture();
    await writeFile(join(fixture.directory, 'PRIVATE-FIXTURE-MANIFEST.json'), '{ invalid original control');
    await expect(readPinnedPrivateOcrFixture(fixture.file, fixture)).rejects.toThrow('Historical OCR fixture manifest changed');
  });

  it('refuses unlisted files and reports a missing listed file as unavailable', async () => {
    const fixture = await authoredFixture();
    await writeFile(join(fixture.directory, 'unlisted.txt'), 'A separate original control.');
    await expect(readPinnedPrivateOcrFixture('unlisted.txt', fixture)).rejects.toThrow('not in the frozen manifest');
    await rm(join(fixture.directory, fixture.file));
    await expect(readPinnedPrivateOcrFixture(fixture.file, fixture)).rejects.toThrow('Historical OCR fixture unavailable');
  });

  it('distinguishes absent configuration from an explicitly invalid directory', async () => {
    delete process.env[OCR_PRIVATE_FIXTURE_ENV];
    expect(hasPrivateOcrFixtures()).toBe(false);
    await expect(readPrivateOcrFixture('authored-sample.txt')).rejects.toThrow(`Set ${OCR_PRIVATE_FIXTURE_ENV}`);
    for (const value of ['', ' \t ']) {
      process.env[OCR_PRIVATE_FIXTURE_ENV] = value;
      expect(hasPrivateOcrFixtures()).toBe(true);
      await expect(readPrivateOcrFixture('authored-sample.txt')).rejects.toThrow(`Set ${OCR_PRIVATE_FIXTURE_ENV}`);
    }
    const fixture = await authoredFixture();
    process.env[OCR_PRIVATE_FIXTURE_ENV] = join(fixture.directory, 'missing-directory');
    expect(hasPrivateOcrFixtures()).toBe(true);
    await expect(readPrivateOcrFixture(fixture.file)).rejects.toThrow('Historical OCR fixture manifest unavailable');
  });

  it('does not let original test manifests replace the fixed historical manifest', async () => {
    const fixture = await authoredFixture();
    process.env[OCR_PRIVATE_FIXTURE_ENV] = fixture.directory;
    expect(await readPinnedPrivateOcrFixture(fixture.file, fixture)).toEqual(sample);
    await expect(readPrivateOcrFixture(fixture.file)).rejects.toThrow('Historical OCR fixture manifest changed');
    await expect(readOcrSourceFile(`tests/fixtures/ocr/${fixture.file}`)).rejects.toThrow('Historical OCR fixture manifest changed');
  });

  it('keeps explicit non-fixture source paths independent of private configuration', async () => {
    const fixture = await authoredFixture();
    delete process.env[OCR_PRIVATE_FIXTURE_ENV];
    const path = join(fixture.directory, fixture.file);
    expect(await readOcrSourceFile(path)).toEqual(await readFile(path));
  });
});
