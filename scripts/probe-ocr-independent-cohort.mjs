// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { createCpuOcrBrowser } from './ocr-cpu-browser.mjs';
import { readPrivateOcrFixture, readOcrSourceFile } from './lib/ocr-private-fixtures.mjs';
import { DEFAULT_CWS_MEDIA_PATHS, prepareImageForOcr, findForbiddenText } from './audit-cws-media-text.mjs';
import { PDF_OCR_VERIFICATION_POLICY } from '../src/lib/pdf-ocr-independent.js';
import { ocrWordErrorRate, isOcrWordInRegion } from '../tests/helpers/ocr-word-error-rate.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = ['scripts/lib/ocr-private-fixtures.mjs', 'src/lib/pdf-ocr-independent.js', 'src/lib/pdf-ocr-retry.js', 'src/lib/pdf-ocr-detector.js',
  'src/engines/tesseract-line-recognizer.js', 'src/engines/tesseract-line-model.js', 'src/engines/ocr-worker-runtime.js',
  'src/engines/wasm-ocr-runtime.js', 'src/engines/browser-inference.js', 'src/engines/webgpu-onnx-session.js',
  'public/native/ocr-engine.wasm', 'public/native/ocr-lstm-engine.wasm', '.cache/tesseract-english-candidate/model.json', '.cache/tesseract-english-candidate/weights.bin'];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, hash(await readOcrSourceFile(path))])));
const assertFrozen = async () => { for (const [path, expected] of Object.entries(sourceHashes)) if (hash(await readOcrSourceFile(path)) !== expected) throw new Error(`Frozen OCR cohort source changed: ${path}`); };
const textImage = text => sharp(Buffer.from(`<svg width="1100" height="320" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><text x="60" y="184" font-family="Arial, Helvetica, sans-serif" font-size="72" font-weight="700" fill="#111111">${text}</text></svg>`)).png().toBuffer();
const clearText = 'Requirements engineering begins with clear goals. Stakeholders describe the system they need.';
const clear = await sharp(Buffer.from('<svg width="1200" height="600" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><text x="80" y="200" font-size="42" font-family="Arial">Requirements engineering begins with clear goals.</text><text x="80" y="270" font-size="42" font-family="Arial">Stakeholders describe the system they need.</text></svg>')).png().toBuffer();
const cases = [{ name: 'clear-repeat0', bytes: clear, expected: clearText }, { name: 'clear-repeat1', bytes: clear, expected: clearText }];
for (const name of ['curved-lines', 'rating-matrix']) cases.push({ name, bytes: await readPrivateOcrFixture(`${name}.png`) });
const frozenCrops = JSON.parse(await readFile('artifacts/engines/ocr-source-crops.json', 'utf8'));
const cropBytes = await readOcrSourceFile(frozenCrops.input);
if (hash(cropBytes) !== frozenCrops.sha256) throw new Error('Frozen crop source changed.');
for (const [index, value] of frozenCrops.cases.entries()) cases.push({ name: `frozen-source-crop-${index}`, bytes: cropBytes, crop: value.crop, mode: 'crop', noCorrections: true });
const photo = await readFile('.cache/engine-fixtures/docunet-35_1.jpg');
if (hash(photo) !== 'aef29c038a795579cc4024eee0ee3e1f98fd407819c506c658d162fa89e5585f') throw new Error('Frozen development photo changed.');
cases.push({ name: 'development-photo1700', bytes: await sharp(photo).resize({ width: 1700 }).png().toBuffer(), photo: true });
const slashText = ['Literal labels: mode/s terms/s docs/s reads/s', 'Keep correct words: models modern records letters', 'Units and names: m/s AND/OR UML/SysML'];
cases.push({ name: 'literal-slash-negatives', expected: slashText.join(' '), bytes: await sharp(Buffer.from(`<svg width="1600" height="360" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/>${slashText.map((text, i) => `<text x="60" y="${85 + i * 85}" font-size="42" font-family="Arial">${text}</text>`).join('')}</svg>`)).png().toBuffer(), noCorrections: true });
for (const path of DEFAULT_CWS_MEDIA_PATHS) cases.push({ name: path, bytes: await prepareImageForOcr(path), cwsPositive: true });
for (const [text, label] of [['Add to Chrome', 'Add to Chrome'], ['Google Research', 'Google trademark'], ['Chrome extension', 'Chrome trademark'], ['reader@example.com', 'email address'], ['Piper voice models', 'removed Piper voices']]) {
  cases.push({ name: `cws-negative-${label}`, bytes: await prepareImageForOcr(await textImage(text)), cwsNegative: label });
}
const report = { status: 'incomplete', scope: 'Frozen development paired original retained CPU primary vs the same primary with bounded independent English verification. No held-out or whole-page photo quality acceptance.',
  timingScope: 'Serial CPU-only browser runs; host processes uncontrolled', policy: PDF_OCR_VERIFICATION_POLICY, sourceHashes,
  cases: cases.map(({ bytes, ...value }) => ({ ...value, inputSha256: hash(bytes) })), baseline: [], verified: [], changes: [], failures: [] };
const save = async () => { await mkdir('artifacts/engines', { recursive: true }); await writeFile('artifacts/engines/ocr-independent-cohort.json', `${JSON.stringify(report, null, 2)}\n`); };
let browser;
try {
  for (const mode of ['baseline', 'verified']) {
    browser = await createCpuOcrBrowser({ candidate: mode === 'verified' ? 'verified-retained' : false });
    for (const test of cases) {
      await assertFrozen(); const started = performance.now(), result = await browser.recognize(test.bytes, { mode: test.mode || 'page', crop: test.crop }), elapsedMs = performance.now() - started;
      const entry = { name: test.name, inputSha256: hash(test.bytes), elapsedMs, ...result };
      if (test.expected) entry.score = ocrWordErrorRate(test.expected, result.text);
      if (test.cwsPositive || test.cwsNegative) entry.cwsFindings = findForbiddenText(result.text).map(item => item.label);
      if (test.photo) {
        const { width, height } = await sharp(test.bytes).metadata(), reference = JSON.parse(await readPrivateOcrFixture('docunet-35.json', 'utf8'));
        const words = result.lines.flatMap(line => line.words).map(word => ({ ...word, x: (word.bbox.x0 + word.bbox.x1) / (2 * width), y: (word.bbox.y0 + word.bbox.y1) / (2 * height) }));
        entry.regions = reference.regions.filter(region => region.kind === 'prose').map(region => {
          const text = words.filter(word => isOcrWordInRegion(word, region)).map(word => word.text).join(' ');
          return { reference: region.text, recognized: text, ...ocrWordErrorRate(region.text, text) };
        });
      }
      report[mode].push(entry); await save(); console.log(JSON.stringify({ mode, name: test.name, elapsedMs, score: entry.score, regions: entry.regions?.map(region => region.rate) }));
    }
    if (mode === 'verified') {
      const negative = await browser.inspectIndependentRejection(await sharp(Buffer.from('<svg width="420" height="90" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><text x="40" y="60" font-family="Arial" font-size="42">modest</text></svg>')).png().toBuffer(), 'mode/s');
      report.incorrectWordNegative = { scope: 'Injected-primary contract negative with an actual independent model reading of a different known word', ...negative };
      if (negative.accepted || negative.output !== 'mode/s') report.failures.push('High-confidence different-word negative was incorrectly accepted.');
    }
    await browser.close(); browser = null;
  }
  for (let index = 0; index < cases.length; index++) {
    const test = cases[index], before = report.baseline[index], after = report.verified[index];
    const a = before.lines.flatMap(line => line.words), b = after.lines.flatMap(line => line.words);
    if (a.length !== b.length) { report.failures.push(`${test.name}: primary word count changed.`); continue; }
    for (let word = 0; word < a.length; word++) {
      if (JSON.stringify(a[word].bbox) !== JSON.stringify(b[word].bbox)) report.failures.push(`${test.name}: primary word${word} geometry changed.`);
      if (a[word].text !== b[word].text) report.changes.push({ image: test.name, index: word, before: a[word], after: b[word],
        correctness: test.name === 'curved-lines' && a[word].text === 'goa/s,' && b[word].text === 'goals,' ? 'correct-supported-by-frozen-curved-reference' : 'requires-source-review' });
    }
    if (test.noCorrections && before.text !== after.text) report.failures.push(`${test.name}: literal slash text was changed.`);
    if (test.expected && after.score.errors > before.score.errors) report.failures.push(`${test.name}: reference quality degraded.`);
    if (test.cwsPositive && after.cwsFindings.length) report.failures.push(`${test.name}: CWS positive produced forbidden findings.`);
    if (test.cwsNegative && !after.cwsFindings.includes(test.cwsNegative)) report.failures.push(`${test.name}: CWS negative was missed.`);
    if (test.photo && after.regions.some((region, i) => region.errors > before.regions[i].errors)) report.failures.push('Primary development photo quality degraded.');
    if (test.name === 'curved-lines') {
      const joined = after.text.replace(/-\s+/g, '');
      if (!/\bgoals,\s+which\s+document\b/.test(joined) || !/\bsystem\s+requirements\b/.test(joined)) report.failures.push('Existing curved phrase regression remains.');
    }
  }
  if (report.changes.some(change => change.correctness === 'requires-source-review')) report.failures.push('Some changed words require source review before acceptance.');
  await assertFrozen(); report.status = report.failures.length ? 'fail' : 'pass-development-regression-scope';
  if (report.failures.length) process.exitCode = 1;
} catch (error) { report.status = 'fail'; report.failure = error.stack; throw error; }
finally { await browser?.close(); await save(); }
console.log(JSON.stringify({ status: report.status, changes: report.changes, failures: report.failures, incorrectWordNegative: report.incorrectWordNegative }));
