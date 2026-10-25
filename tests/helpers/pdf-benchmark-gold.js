// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Explicit private input for ONE historical100-page benchmark; no alternate or generated gold.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { PDF_ACCEPTANCE_BENCHMARK } from '../fixtures/pdf-acceptance-manifest.js';

export const HISTORICAL_PDF_GOLD_SHA256 = '8d8a2ad987ccbb71059c21f806c13022a7292e45574f15192c59545ee68d7906';
const HISTORICAL_PDF_GOLD_BYTES = 81070;
const HISTORICAL_MANIFEST_SHA256 = 'fac19a254f0e507ddf677159397a1e9a0283311c3a26a37d7f33d42c62a27d83';

export function loadPdfBenchmarkGold({ goldPath = process.env.PN_PDF_BENCHMARK_GOLD, requiredIds } = {}) {
  const ids = requiredIds ?? PDF_ACCEPTANCE_BENCHMARK.map(record => record.id);
  if (!Array.isArray(ids) || ids.some(id => !PDF_ACCEPTANCE_BENCHMARK.some(record => record.id === id))) {
    throw new Error('Unknown historical PDF benchmark identity.');
  }
  const needsPrivateGold = PDF_ACCEPTANCE_BENCHMARK.some(record => ids.includes(record.id) && record.goldData);
  const explicitlyConfigured = goldPath !== undefined;
  if (!explicitlyConfigured) {
    if (needsPrivateGold) throw new Error('Set PN_PDF_BENCHMARK_GOLD to the exact private historical benchmark JSON before strict real-paper assertions.');
    return { records: PDF_ACCEPTANCE_BENCHMARK, goldEvidence: null };
  }
  if (typeof goldPath !== 'string' || !goldPath.trim()) throw new Error('PN_PDF_BENCHMARK_GOLD must name the exact private historical benchmark JSON.');
  const size = statSync(goldPath);
  if (!size.isFile() || size.size !== HISTORICAL_PDF_GOLD_BYTES) throw new Error('Private PDF benchmark gold byte count drifted.');
  const bytes = readFileSync(goldPath);
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== HISTORICAL_PDF_GOLD_BYTES || hash !== HISTORICAL_PDF_GOLD_SHA256) throw new Error('Private PDF benchmark gold SHA-256 drifted.');
  const gold = JSON.parse(bytes);
  if (gold.schemaVersion !== 1 || gold.historicalManifestSha256 !== HISTORICAL_MANIFEST_SHA256 || !Array.isArray(gold.records) || gold.records.length !== PDF_ACCEPTANCE_BENCHMARK.length) {
    throw new Error('Invalid private historical PDF benchmark gold.');
  }
  const records = PDF_ACCEPTANCE_BENCHMARK.map((record, index) => {
    const original = gold.records[index];
    for (const key of ['id', 'source', 'pageNumber', 'sha256', 'categories']) {
      if (JSON.stringify(original?.[key]) !== JSON.stringify(record[key])) throw new Error('Private gold source/order mismatch: ' + record.id);
    }
    if (!Array.isArray(original.orderedCheckpoints) || original.orderedCheckpoints.length < 3 || original.orderedCheckpoints.length > 6 || original.orderedCheckpoints.some(value => typeof value !== 'string' || !value)
      || !Array.isArray(original.forbiddenNarration) || original.forbiddenNarration.some(value => typeof value !== 'string')) throw new Error('Invalid private benchmark checkpoints: ' + record.id);
    if (!record.goldData) {
      for (const key of ['orderedCheckpoints', 'forbiddenNarration']) if (JSON.stringify(original[key]) !== JSON.stringify(record[key])) throw new Error('Generated fixture gold mismatch: ' + record.id);
      return record;
    }
    return Object.freeze({ ...record, orderedCheckpoints: Object.freeze([...original.orderedCheckpoints]), forbiddenNarration: Object.freeze([...original.forbiddenNarration]) });
  });
  return { records: Object.freeze(records), goldEvidence: Object.freeze({ path: goldPath, bytes: bytes.length, sha256: hash, historicalManifestSha256: HISTORICAL_MANIFEST_SHA256, historicalRealPaperRecords: 90 }) };
}
