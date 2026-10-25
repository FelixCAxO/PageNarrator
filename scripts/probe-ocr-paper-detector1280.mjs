// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createCpuOcrBrowser } from './ocr-cpu-browser.mjs';
import { readPrivateOcrFixture, readOcrSourceFile } from './lib/ocr-private-fixtures.mjs';
import { isOcrWordInRegion, ocrWordErrorRate } from '../tests/helpers/ocr-word-error-rate.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const priorPath = 'artifacts/engines/ocr-paper-source-roi-source-context.json';
const priorBytes = await readFile(priorPath), prior = JSON.parse(priorBytes);
const test = prior.corpus.cases.find(value => value.name === 'development-photo1700');
const input = await readFile(test.path);
if (hash(input) !== test.sha256) throw new Error('Frozen1700 source pixels changed.');
const sourceHashes = Object.fromEntries(await Promise.all([...new Set([...Object.keys(prior.sourceHashes), 'scripts/lib/ocr-private-fixtures.mjs'])].map(async path => [path, hash(await readOcrSourceFile(path))])));
const assertFrozen = async () => { for (const [path, expected] of Object.entries(sourceHashes)) if (hash(await readOcrSourceFile(path)) !== expected) throw new Error(`Frozen detector diagnostic source changed: ${path}`); };
const source = await readFile('src/lib/pdf-ocr.js', 'utf8');
const needle = "const result = await worker.recognize(source, { mode: 'page' });";
if (!source.includes(needle) || source.indexOf(needle) !== source.lastIndexOf(needle)) throw new Error('Unexpected paper-source diagnostic site.');
const instrumented = source.replace(needle, "const result = await worker.recognize(source, { mode: 'crop' });");
const report = { status: 'incomplete', scope: 'Test-server-only existing detector1280 mode on fixed1700 source-paper ROI; same retained weights and original runtime, production policy unchanged. No held-out acceptance.',
  timingScope: 'CPU browser elapsed time is diagnostic; other host activity uncontrolled', inputSha256: hash(input),
  sourceHashes, diagnosticSourceSha256: hash(instrumented), baselineReportSha256: hash(priorBytes),
  baseline: prior.paper.find(value => value.name === test.name) };
const browser = await createCpuOcrBrowser({ candidate: 'verified-retained', sourceOverrides: { '/src/lib/pdf-ocr.js': instrumented } });
try {
  await assertFrozen(); report.result = await browser.recognizePdfSource(input);
  const result = report.result;
  const reference = JSON.parse(await readPrivateOcrFixture('docunet-35.json', 'utf8'));
  const words = result.items.map(item => ({ text: item.str, x: (item.transform[4] + item.width / 2) * 3 / result.width,
    y: (item.transform[5] - item.height / 2) * 3 / result.height }));
  result.regions = reference.regions.filter(region => region.kind === 'prose').map(region => {
    const recognized = words.filter(word => isOcrWordInRegion(word, region)).map(word => word.text).join(' ');
    return { reference: region.text, recognized, ...ocrWordErrorRate(region.text, recognized) };
  });
  result.invalidGeometry = result.items.filter(item => item.width <= 0 || item.height <= 0 || !item.transform.every(Number.isFinite)).length;
  report.qualityStatus = result.regions.every(region => region.rate <= .05) ? 'pass-development-five-percent-gate' : 'failed-development-five-percent-gate';
  report.regionsNonDegraded = result.regions.every((region, index) => region.errors <= report.baseline.regions[index].errors);
  await assertFrozen(); report.status = 'complete-diagnostic-production-unchanged';
} catch (error) { report.status = 'fail'; report.failure = error.stack; throw error; }
finally {
  await browser.close(); await writeFile('artifacts/engines/ocr-paper-detector1280.json', `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ status: report.status, qualityStatus: report.qualityStatus, elapsedMs: report.result?.elapsedMs,
  baseline: report.baseline.regions.map(value => value.rate), regions: report.result?.regions?.map(value => value.rate),
  invalidGeometry: report.result?.invalidGeometry, regionsNonDegraded: report.regionsNonDegraded }));
