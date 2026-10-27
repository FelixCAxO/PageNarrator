// One result per structural pattern; failures remain failures in the ledger and exit code.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPdfPageModel } from '../src/lib/pdf-page-model.js';
import { TABLE_PATTERN_AXES, PROSE_PATTERN_AXES, readingOrderPatterns, buildReadingOrderPattern } from '../tests/helpers/reading-order-patterns.js';
import { SIDENOTE_PATTERN_AXES } from '../tests/helpers/sidenote-reading-order-patterns.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'artifacts/reading-order-patterns', process.argv[2] || 'latest');
await mkdir(output, { recursive: true });
const pinFiles = ['src/lib/pdf-page-model.js', 'src/lib/pdf-vertical-model.js', 'src/lib/numeric-matrix.js',
  'src/pdf/symbol-fonts.js', 'tests/helpers/reading-order-patterns.js', 'tests/helpers/sidenote-reading-order-patterns.js', 'scripts/audit-reading-order-patterns.mjs'];
const pins = async () => Object.fromEntries(await Promise.all(pinFiles.map(async file => [file,
  createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')])));
const sourcePins = await pins(), results = [], started = performance.now();
const totals = { passed: 0, failed: 0 }, families = {};
for (const pattern of readingOrderPatterns()) {
  const fixture = buildReadingOrderPattern(pattern);
  const expected = fixture.expectedKeys;
  let actual = [], roles = [], error = null;
  try {
    const model = createPdfPageModel(fixture.items, fixture.options);
    actual = model.orderedItems.map(item => item.patternKey);
    roles = model.lines.map(line => line.role);
    assert.deepEqual(actual, expected);
    if (pattern.id.startsWith('prose-')) assert.ok(!roles.includes('table-row'), 'Prose was classified as a table');
  } catch (failure) {
    error = failure.code === 'ERR_ASSERTION' ? 'reading-order-mismatch' : String(failure.stack || failure);
  }
  const status = error ? 'failed' : 'passed';
  const sourceText = new Map(fixture.items.map(item => [item.patternKey, item.str]));
  totals[status] += 1;
  families[pattern.family] ||= { passed: 0, failed: 0 };
  families[pattern.family][status] += 1;
  results.push({ ...pattern, status, error, expected, actual, roles,
    expectedText: fixture.expectedText, actualText: actual.map(key => sourceText.get(key) ?? '<unknown source>'),
    source: fixture.items.map(({ patternKey, str, x, y, width, height, transform, fontName, ocrLine }) => (
      { key: patternKey, text: str, x, y, width, height, transform, fontName, ...(ocrLine === undefined ? {} : { ocrLine }) }
    )), pageView: fixture.options.pageView, modelOptions: fixture.options });
  if (results.length % 2000 === 0) console.log(JSON.stringify({ checked: results.length, ...totals }));
}
const expectedCount = [TABLE_PATTERN_AXES, PROSE_PATTERN_AXES, SIDENOTE_PATTERN_AXES].reduce((total, axes) => total
  + Object.values(axes).reduce((count, values) => count * values.length, 1), 0);
assert.equal(results.length, expectedCount);
assert.equal(new Set(results.map(record => record.id)).size, expectedCount);
const sourcePinsUnchanged = JSON.stringify(sourcePins) === JSON.stringify(await pins());
for (const counts of Object.values(families)) counts.accuracy = counts.passed / (counts.passed + counts.failed);
const summary = { generatedAt: new Date().toISOString(), scope: 'Exhaustive Cartesian products of declared table, prose and rotated sidenote axes, through the shared PDF/OCR page model. Synthetic geometry, not real OCR recognition or browser playback.',
  axes: { tables: TABLE_PATTERN_AXES, prose: PROSE_PATTERN_AXES, sidenotes: SIDENOTE_PATTERN_AXES }, total: results.length, ...totals, families, sourcePins, sourcePinsUnchanged,
  accuracy: totals.passed / results.length, targetAccuracy: 0.98,
  targetMetInEveryFamily: Object.values(families).every(counts => counts.accuracy >= 0.98),
  elapsedMs: Math.round(performance.now() - started), complete: totals.failed === 0 && sourcePinsUnchanged };
await writeFile(path.join(output, 'results.jsonl'), results.map(record => JSON.stringify(record)).join('\n') + '\n');
await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const body = results.map(record => `<details data-status="${record.status}"><summary>${record.id}: ${record.status} — ${escape(JSON.stringify(record.parameters))}</summary><p>${escape(record.error || 'Exact source order matches the semantic row/cell/line/fragment oracle.')}</p><p>Expected source IDs: ${escape(record.expected.join(' → '))}</p><p>Actual source IDs: ${escape(record.actual.join(' → '))}</p><p>Expected text:</p><pre>${escape(record.expectedText.join('\n'))}</pre><p>Actual text:</p><pre>${escape(record.actualText.join('\n'))}</pre></details>`).join('\n');
await writeFile(path.join(output, 'report.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Reading order pattern audit</title><style>body{font:15px system-ui;max-width:1400px;margin:32px auto;padding:0 24px}summary{cursor:pointer;padding:8px}details{border-bottom:1px solid #ddd}details[data-status="failed"]{border-left:4px solid #b11}pre,p{white-space:pre-wrap;overflow-wrap:anywhere;margin:12px}input{width:70%;padding:10px}header{position:sticky;top:0;background:white;padding:8px}</style><header><h1>Reading order pattern audit</h1><p>${summary.total} individual patterns: ${summary.passed} passed, ${summary.failed} failed. ${escape(summary.scope)}</p><input id="query" placeholder="Filter by ID, parameter or status"><label><input id="failures" type="checkbox" style="width:auto">Failures only</label></header>${body}<script>const query=document.getElementById('query'),failures=document.getElementById('failures'),records=[...document.querySelectorAll('details')];function filter(){const q=query.value.toLowerCase();for(const record of records)record.hidden=!(record.firstElementChild.textContent.toLowerCase().includes(q)&&(!failures.checked||record.dataset.status==='failed'));}query.addEventListener('input',filter);failures.addEventListener('change',filter);</script></html>`);
console.log(JSON.stringify({ output, ...summary }, null, 2));
if (!summary.complete) process.exitCode = 1;
