import { createHash } from 'node:crypto';
import manifest from './pdf-library-acceptance-manifest.json' with { type: 'json' };
import { PDF_ACCEPTANCE_BENCHMARK } from './pdf-acceptance-manifest.js';

// Freeze selection independently of narration: 40 hash-ranked library pages and all ten authored controls.
const rank = record => createHash('sha256').update(record.id).digest('hex');
const selected = [...manifest.records.filter(record => record.id.startsWith('library-'))
  .sort((a, b) => rank(a).localeCompare(rank(b))).slice(0, 40),
...PDF_ACCEPTANCE_BENCHMARK.filter(record => !record.goldData)];
if (selected.length !== 50) throw new Error('Library naturalness requires 40 library pages and ten controls.');

export const PDF_LIBRARY_NATURALNESS_SAMPLE = Object.freeze(selected.map((record, index) => Object.freeze({
  id: `library-naturalness-${String(index + 1).padStart(2, '0')}`,
  pdfId: record.id,
  categories: Object.freeze([...record.categories]),
})));
