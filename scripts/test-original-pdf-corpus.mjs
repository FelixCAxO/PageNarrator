// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Exact existing generated/wild assertions, explicitly redirected to the original facade.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url)), output = path.join(root, 'artifacts/engines/pdf-original-app-corpus', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true });
async function pins() {
  const files = ['native/pdf.wasm', 'src/lib/pdf-extraction.js', 'src/lib/pdf-page-model.js', 'tests/pdf-engine/original-corpus-backend.js', 'tests/pdf-engine/original-corpus.config.js'];
  for (const directory of ['src/pdf', 'vendor/pdf-data', 'vendor/pdf-cmaps', 'vendor/pdf-glyphs', 'vendor/pdf-unicode', 'vendor/pdf-symbols', 'tests/helpers', 'tests/pdf', 'tests/fixtures/pdfs']) {
    const visit = async relative => {
      for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
        const filename = `${relative}/${entry.name}`;
        if (entry.isDirectory()) await visit(filename); else if (entry.isFile()) files.push(filename); else throw new Error(`Unsupported pinned entry: ${filename}`);
      }
    }; await visit(directory);
  }
  const result = {};
  for (const file of [...new Set(files)].sort()) result[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
  return result;
}
const before = await pins(), env = { ...process.env, PN_PDF_ORIGINAL_CORPUS_AUDIT_DIR: path.join(output, 'backend-audit') };
if (process.env.PN_PDF_FIXTURE_DIR) { env.PN_SUMMER2026_PDF_CORPUS = '1'; env.PN_SUMMER2026_PDF_DIR = process.env.PN_PDF_FIXTURE_DIR; }
const args = ['node_modules/vitest/vitest.mjs', 'run', '--config', 'tests/pdf-engine/original-corpus.config.js', '--reporter=json', '--outputFile', path.join(output, 'vitest.json')];
const started = performance.now(), child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
child.stdout.on('data', chunk => { stdout += chunk; process.stdout.write(chunk); });
child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
const after = await pins(), unchanged = JSON.stringify(before) === JSON.stringify(after);
const audits = [];
for (const name of await readdir(env.PN_PDF_ORIGINAL_CORPUS_AUDIT_DIR).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) audits.push(JSON.parse(await readFile(path.join(env.PN_PDF_ORIGINAL_CORPUS_AUDIT_DIR, name), 'utf8')));
const records = audits.flatMap(audit => audit.records), result = JSON.parse(await readFile(path.join(output, 'vitest.json'), 'utf8'));
const report = { scope: 'Existing 1000 generated + 100-types + 10 wild assertions through original facade; optional complete configured local corpus. No browser/raster/performance/release claim.',
  backend: 'original', sourcePins: before, sourcePinsUnchanged: unchanged, localCorpus: env.PN_SUMMER2026_PDF_DIR || null, exitCode,
  tests: { passed: result.numPassedTests, failed: result.numFailedTests, skipped: result.numPendingTests },
  documentCalls: records.length, uniqueInputSources: new Set(records.map(record => record.sourceSha256).filter(Boolean)).size,
  opened: records.filter(record => record.opened).length, retainedOpen: records.filter(record => record.opened && !record.closed).length,
  backendErrors: records.filter(record => record.error), elapsedMs: performance.now() - started,
  passed: exitCode === 0 && result.success && unchanged && records.length >= 1000 && records.every(record => !record.opened || record.closed) };
await Promise.all([writeFile(path.join(output, 'stdout.log'), stdout), writeFile(path.join(output, 'stderr.log'), stderr), writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)]);
console.log(JSON.stringify({ output, ...report, sourcePins: undefined }, null, 2));
if (!report.passed) process.exitCode = 1;
