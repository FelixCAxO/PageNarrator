// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Development-only relocation of exact historical fixtures. No content rights are inferred.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';

export const OCR_PRIVATE_FIXTURE_ENV = 'PN_OCR_PRIVATE_FIXTURE_DIR';
const MANIFEST_NAME = 'PRIVATE-FIXTURE-MANIFEST.json';
const MANIFEST_SHA256 = '5265106f9d62db2a10d2c69475054144e8915657a62696501c55422c56710d95';
const PREFIX = 'tests/fixtures/ocr/';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function hasPrivateOcrFixtures() {
  return process.env[OCR_PRIVATE_FIXTURE_ENV] !== undefined;
}

function fixturePath(name, directory) {
  const root = directory?.trim();
  if (!root) throw new Error(`Historical OCR fixtures unavailable. Set ${OCR_PRIVATE_FIXTURE_ENV} to the preserved private fixture directory; no quality pass is implied by missing inputs.`);
  const file = name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
  if (!file || file !== basename(file) || file.includes('\\') || file.includes('/') || file === '.' || file === '..')
    throw new Error(`Invalid historical OCR fixture name: ${name}`);
  return resolve(root, file);
}

export function privateOcrFixturePath(name) {
  return fixturePath(name, process.env[OCR_PRIVATE_FIXTURE_ENV]);
}

// The generic primitive also supports original-data unit controls without private content.
// Historical callers below always use the fixed preserved manifest digest.
export async function readPinnedPrivateOcrFixture(name, { directory, manifestSha256 }, encoding) {
  const file = fixturePath(name, directory);
  const manifestPath = fixturePath(MANIFEST_NAME, directory);
  let manifestBytes, bytes;
  try { manifestBytes = await readFile(manifestPath); }
  catch (error) { throw new Error(`Historical OCR fixture manifest unavailable: ${manifestPath}`, { cause: error }); }
  if (sha(manifestBytes) !== manifestSha256) throw new Error(`Historical OCR fixture manifest changed: ${manifestPath}`);
  const manifest = JSON.parse(manifestBytes);
  const record = manifest.files.find(item => item.file === basename(file) && item.source === PREFIX + basename(file));
  if (!record) throw new Error(`Historical OCR fixture is not in the frozen manifest: ${name}`);
  try { bytes = await readFile(file); }
  catch (error) { throw new Error(`Historical OCR fixture unavailable: ${file}`, { cause: error }); }
  if (bytes.length !== record.bytes || sha(bytes) !== record.sha256) throw new Error(`Historical OCR fixture bytes changed: ${file}`);
  return encoding ? bytes.toString(encoding) : bytes;
}

export function readPrivateOcrFixture(name, encoding) {
  return readPinnedPrivateOcrFixture(name, {
    directory: process.env[OCR_PRIVATE_FIXTURE_ENV], manifestSha256: MANIFEST_SHA256,
  }, encoding);
}

// Preserve logical historical data keys in pin maps, while reading the exact bytes privately.
// The changed helper/probe code still has its real current hash; old receipt equality is not bypassed.
export async function readOcrSourceFile(path, encoding) {
  return typeof path === 'string' && path.startsWith(PREFIX)
    ? readPrivateOcrFixture(path, encoding) : readFile(path, encoding);
}
