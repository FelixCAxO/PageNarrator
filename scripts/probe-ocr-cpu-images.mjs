// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { createCpuOcrBrowser } from './ocr-cpu-browser.mjs';
import { readPrivateOcrFixture } from './lib/ocr-private-fixtures.mjs';
import { isOcrWordInRegion, ocrWordErrorRate } from '../tests/helpers/ocr-word-error-rate.js';

const expected = 'Requirements engineering begins with clear goals. Stakeholders describe the system they need.';
const candidate = process.argv.includes('--verified-retained') ? 'verified-retained' : process.argv.includes('--english-lstm') ? 'english-lstm' : process.argv.includes('--retained-dense') ? 'retained-dense' : process.argv.includes('--latin-candidate') ? 'latin' : process.argv.includes('--english-candidate');
const beam = process.argv.includes('--ctc-beam');
if (beam && !candidate) throw new Error('Dense CTC beam probing requires an explicit candidate selection.');
const kind = candidate === 'verified-retained' ? 'verified-retained' : candidate === 'english-lstm' ? 'english-lstm' : candidate === 'retained-dense' ? 'retained-dense' : candidate === 'latin' ? 'latin' : 'english';
const report = { status: 'incomplete', backend: `First-party C++/WASM, browser GPU disabled${candidate ? `; pinned ${kind} candidate, production unchanged` : ''}`,
  scope: 'Generated Latin text plus existing development images; not held-out OCR acceptance or physical weak-hardware proof',
  timingScope: 'Diagnostic full-page elapsed times; other host processes are uncontrolled', qualityStatus: 'not-evaluated',
  decoder: beam ? { beamWidth: 16, topClasses: 8 } : candidate === 'verified-retained' ? 'retained-primary-with-bounded-independent-greedy' : candidate === 'english-lstm' ? 'greedy-last-class-blank' : 'greedy-plus-existing-space-channel', cases: [] };
const privateImages = await Promise.all(['curved-lines.png', 'rating-matrix.png'].map(async name =>
  ({ file: `tests/fixtures/ocr/${name}`, bytes: await readPrivateOcrFixture(name) })));
const curvedReference = await readPrivateOcrFixture('curved-body.txt', 'utf8');
const photoReference = process.argv.includes('--photo') ? JSON.parse(await readPrivateOcrFixture('docunet-35.json', 'utf8')) : null;
const browser = await createCpuOcrBrowser({ candidate, beam });
const failures = [];
try {
  const image = await sharp(Buffer.from('<svg width="1200" height="600" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><text x="80" y="200" font-size="42" font-family="Arial">Requirements engineering begins with clear goals.</text><text x="80" y="270" font-size="42" font-family="Arial">Stakeholders describe the system they need.</text></svg>')).png().toBuffer();
  for (let repeat = 0; repeat < 2; repeat++) {
    const start = performance.now(), result = await browser.recognize(image);
    const score = ocrWordErrorRate(expected, result.text);
    report.cases.push({ image: 'generated-clear-english', inputSha256: createHash('sha256').update(image).digest('hex'), repeat, expected, text: result.text, score, elapsedMs: performance.now() - start, lines: result.lines });
    if (score.errors) failures.push(`Generated clear text differs on repeat${repeat}.`);
    for (const word of result.lines.flatMap(line => line.words || [])) if (!Object.values(word.bbox).every(Number.isFinite)
      || word.bbox.x0 < 0 || word.bbox.y0 < 0 || word.bbox.x1 > 1200 || word.bbox.y1 > 600) throw new Error('CPU OCR returned invalid visible-word geometry.');
  }
  for (const { file, bytes } of privateImages) {
    const start = performance.now(), result = await browser.recognize(bytes);
    const entry = { image: file, sha256: createHash('sha256').update(bytes).digest('hex'), text: result.text,
      lineCount: result.lines.length, lines: result.lines, words: result.lines.flatMap(line => line.words || []).length, elapsedMs: performance.now() - start };
    if (file.endsWith('curved-lines.png')) {
      const reference = curvedReference, bodyStart = result.text.indexOf('The documented');
      const body = bodyStart >= 0 ? result.text.slice(bodyStart).replace(/-\s+/g, '') : '';
      entry.body = { reference, bodyStart, recognized: body, score: ocrWordErrorRate(reference, body),
        requiredGoalsPhraseRecovered: /\bgoals,\s+which\s+document\b/.test(body),
        scope: 'Existing development body reference after printed end-of-line hyphen joining; no spelling correction or held-out acceptance' };
    }
    report.cases.push(entry);
    if (!result.lines.some(line => line.words?.length)) failures.push(`CPU OCR produced no words for ${file}.`);
  }
  if (process.argv.includes('--photo')) {
    const file = '.cache/engine-fixtures/docunet-35_1.jpg', bytes = await readFile(file);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== 'aef29c038a795579cc4024eee0ee3e1f98fd407819c506c658d162fa89e5585f') throw new Error('Development photo source hash differs.');
    const resized = await sharp(bytes).resize({ width: 1700 }).png().toBuffer();
    const { width, height } = await sharp(resized).metadata();
    const start = performance.now(), result = await browser.recognize(resized);
    const reference = photoReference;
    const words = result.lines.flatMap(line => line.words || []).map(word => ({ ...word,
      x: (word.bbox.x0 + word.bbox.x1) / (2 * width), y: (word.bbox.y0 + word.bbox.y1) / (2 * height) }));
    const regions = reference.regions.filter(region => region.kind === 'prose').map(region => {
      const text = words.filter(word => isOcrWordInRegion(word, region)).map(word => word.text).join(' ');
      return { reference: region.text, recognized: text, ...ocrWordErrorRate(region.text, text) };
    });
    report.cases.push({ image: file, sha256: hash, inputSha256: createHash('sha256').update(resized).digest('hex'), width, height,
      lineCount: result.lines.length, lines: result.lines, words: words.length,
      elapsedMs: performance.now() - start, regions, qualityScope: 'Development photo diagnostic; no held-out quality pass inferred' });
  }
  report.status = failures.length ? 'fail-functional-scope' : 'pass-functional-scope';
  report.failures = failures;
  if (failures.length) process.exitCode = 1;
  report.qualityStatus = report.cases.some(item => item.regions?.some(region => region.rate > .05))
    ? 'failed-development-photo-quality' : 'held-out-quality-not-evaluated';
} catch (error) { report.status = 'fail'; report.failure = error.message; throw error; }
finally {
  await browser.close();
  await mkdir('artifacts/engines', { recursive: true });
  await writeFile(candidate ? `artifacts/engines/ocr-${kind}-${beam ? 'beam' : 'candidate'}-images.json` : 'artifacts/engines/ocr-cpu-images.json', `${JSON.stringify(report, null, 2)}\n`);
}
console.log(`CPU OCR browser image checks: ${report.cases.length} completed; ${report.status}; ${report.qualityStatus}.`);
