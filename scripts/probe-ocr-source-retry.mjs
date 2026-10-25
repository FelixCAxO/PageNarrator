// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createCpuOcrBrowser } from './ocr-cpu-browser.mjs';
import { readPrivateOcrFixture } from './lib/ocr-private-fixtures.mjs';
import { PDF_OCR_VERIFICATION_POLICY } from '../src/lib/pdf-ocr-independent.js';

const path = 'tests/fixtures/ocr/curved-lines.png', bytes = await readPrivateOcrFixture('curved-lines.png');
const independent = process.argv.includes('--independent');
const report = { status: 'incomplete', scope: 'Real retained weights and production PDF OCR orchestration/worker; embedded-raster page adapter, GPU disabled; not a PDF decoder or held-out quality test',
  input: path, sha256: createHash('sha256').update(bytes).digest('hex'), policy: independent ? PDF_OCR_VERIFICATION_POLICY : 'same-weight-source-retry' };
const browser = await createCpuOcrBrowser({ candidate: independent ? 'verified-retained' : false });
try {
  Object.assign(report, await browser.recognizePdfSource(bytes));
  const words = lines => lines.flatMap(line => line.words || []).map(word => word.text);
  report.initialWords = words(report.initial); report.retryWords = words(report.retry);
  report.triggered = report.renders.length > 1;
  report.recovered = report.text.includes('goals,') && (report.initialWords.includes('goa/s,') || report.initialWords.includes('goals,'));
  const joined = report.text.replace(/-\s+/g, '');
  report.requiredPhrases = { goals: /\bgoals,\s+which\s+document\b/.test(joined), systemRequirements: /\bsystem\s+requirements\b/.test(joined) };
  report.status = (independent || report.triggered) && report.recovered && (!independent || Object.values(report.requiredPhrases).every(Boolean)) ? 'pass-curved-source-recovery' : 'fail-curved-source-recovery';
  console.log(JSON.stringify({ status: report.status, elapsedMs: report.elapsedMs, renders: report.renders,
    initial: report.initialWords, retry: report.retryWords, text: report.text }));
  if (report.status.startsWith('fail')) process.exitCode = 1;
} catch (error) { report.status = 'fail'; report.failure = error.stack; throw error; }
finally {
  await browser.close(); await mkdir('artifacts/engines', { recursive: true });
  await writeFile(`artifacts/engines/ocr-source-${independent ? 'independent-run-peak' : 'retry'}.json`, `${JSON.stringify(report, null, 2)}\n`);
}
