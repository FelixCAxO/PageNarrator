// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createCpuOcrBrowser } from './ocr-cpu-browser.mjs';
import { readPrivateOcrFixture, readOcrSourceFile } from './lib/ocr-private-fixtures.mjs';
import { DEFAULT_CWS_MEDIA_PATHS, prepareImageForOcr, findForbiddenText } from './audit-cws-media-text.mjs';
import { isOcrWordInRegion, ocrWordErrorRate } from '../tests/helpers/ocr-word-error-rate.js';

const currentOnly = process.argv.includes('--current-only');
const edgeRow = process.argv.includes('--edge-row');
const contrastAnchor = process.argv.includes('--contrast-anchor');
const sourceGeometry = process.argv.includes('--source-geometry');
const retainedInk = process.argv.includes('--retained-ink');
const edgeInk = process.argv.includes('--edge-ink');
const labelIndex=process.argv.indexOf('--report-label'),reportLabel=labelIndex<0?null:process.argv[labelIndex+1];
if(labelIndex>=0&&(!reportLabel||!/^[a-z0-9-]+$/.test(reportLabel)||!sourceGeometry))throw new Error('Invalid source-geometry report label.');
if(retainedInk&&!sourceGeometry)throw new Error('Retained-ink gate requires source-geometry mode.');
if(edgeInk&&!sourceGeometry)throw new Error('Edge-ink gate requires source-geometry mode.');
if(sourceGeometry&&(!currentOnly||!process.argv.includes('--production640')||contrastAnchor||edgeRow))throw new Error('Source geometry gate requires current-only actual production640 without candidate recrop overrides.');
const production640 = process.argv.includes('--production640'), reviewEdges = edgeRow || production640;
const sourceContext = process.argv.includes('--source-context') || reviewEdges;
const directory = '.cache/ocr-paper-roi-baseline', hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceSetIndex=process.argv.indexOf('--source-set'),sourceSetPath=sourceSetIndex<0?`${directory}/source-set.json`:process.argv[sourceSetIndex+1];
if(sourceSetIndex>=0&&(!sourceSetPath||!sourceGeometry))throw new Error('An explicit source set requires source-geometry mode.');
if(sourceGeometry&&process.argv.includes('--prepare'))throw new Error('Source geometry requires existing frozen inputs; never regenerate them from marketing media.');
const sourceSetBytes=sourceGeometry?await readFile(sourceSetPath):null,sourceSet=sourceSetBytes?JSON.parse(sourceSetBytes):null;
if(sourceSet&&sourceSet.status!=='frozen-development-source-bytes-verified')throw new Error('Source set is not frozen.');
const sourcePath = `${directory}/pdf-ocr.js`, baselineSource = await readFile(sourcePath);
const frozen = JSON.parse(await readFile('artifacts/engines/ocr-independent-cohort.json', 'utf8'));
if (frozen.status !== 'pass-development-regression-scope') throw new Error('Independent development gate is not frozen and passing.');
const sourceFiles = ['scripts/lib/ocr-private-fixtures.mjs', 'src/lib/pdf-ocr.js', 'src/lib/pdf-ocr-paper.js', 'src/lib/pdf-ocr-unwarp.js', 'src/lib/pdf-ocr-retry.js',
  'src/lib/pdf-ocr-ctc.js', 'src/lib/pdf-ocr-neural-batch.js', 'src/lib/pdf-ocr-word-bounds.js', 'src/lib/pdf-ocr-detector.js',
  'src/lib/pdf-ocr-independent.js', 'src/lib/pdf-ocr-grid.js', 'scripts/probe-ocr-paper-roi.mjs', 'scripts/ocr-cpu-browser.mjs',
  'scripts/lib/ocr-worker-result-capture.mjs', 'src/engines/wasm-ocr-runtime.js', 'src/engines/ocr-worker-runtime.js',
  'src/engines/wasm-ocr-compute.js','src/engines/wasm-ocr-operations.js','native/ocr-engine.cpp','native/engine.cpp',
  'src/engines/tesseract-line-recognizer.js', 'src/engines/tesseract-line-model.js', 'src/engines/webgpu-onnx-session.js',
  'public/native/ocr-lstm-engine.wasm','public/native/ocr-lstm-engine.json','public/native/ocr-engine.wasm','public/native/ocr-engine.json',
  'public/assets/ocr/tiny-det.onnx','public/assets/ocr/small-rec.onnx','public/assets/ocr/small-rec-alphabet.json','public/assets/ocr/models.json',
  'public/assets/ocr/english-lstm.json', 'public/assets/ocr/english-lstm.bin',
  'tests/fixtures/ocr/docunet-35.json', 'tests/fixtures/ocr/curved-body.txt',
  ...(sourceSet?[sourceSetPath,sourceSet.corpusPath,...sourceSet.originals.map(c=>c.path)]:[])];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, hash(await readOcrSourceFile(path))])));
const assertFrozen = async () => { for (const [path, expected] of Object.entries(sourceHashes)) if (hash(await readOcrSourceFile(path)) !== expected) throw new Error(`Frozen paper ROI source changed: ${path}`); };
let inputs;
if (process.argv.includes('--prepare')) {
  const cases = [], add = async (name, bytes, metadata = {}) => {
    const prior = frozen.cases.find(value => value.name === name), sha256 = hash(bytes);
    if (prior && prior.inputSha256 !== sha256) throw new Error(`Existing frozen image changed: ${name}`);
    const path = `${directory}/input-${cases.length}.bin`;
    await writeFile(path, bytes); cases.push({ name, path, sha256, ...metadata });
  };
  await mkdir(directory, { recursive: true });
  const clearText = 'Requirements engineering begins with clear goals. Stakeholders describe the system they need.';
  const clear = await sharp(Buffer.from('<svg width="1200" height="600" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><text x="80" y="200" font-size="42" font-family="Arial">Requirements engineering begins with clear goals.</text><text x="80" y="270" font-size="42" font-family="Arial">Stakeholders describe the system they need.</text></svg>')).png().toBuffer();
  await add('clear-repeat0', clear, { expected: clearText }); await add('clear-repeat1', clear, { expected: clearText });
  for (const name of ['curved-lines', 'rating-matrix']) await add(name, await readPrivateOcrFixture(`${name}.png`));
  const photo = await readFile('.cache/engine-fixtures/docunet-35_1.jpg');
  if (hash(photo) !== 'aef29c038a795579cc4024eee0ee3e1f98fd407819c506c658d162fa89e5585f') throw new Error('Frozen development photograph changed.');
  await add('development-photo1700', await sharp(photo).resize({ width: 1700 }).png().toBuffer(), { photo: true });
  await add('development-photo-original-source', photo, { photo: true, originalSource: true });
  const slashText = ['Literal labels: mode/s terms/s docs/s reads/s', 'Keep correct words: models modern records letters', 'Units and names: m/s AND/OR UML/SysML'];
  await add('literal-slash-negatives', await sharp(Buffer.from(`<svg width="1600" height="360" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/>${slashText.map((text, i) => `<text x="60" y="${85 + i * 85}" font-size="42" font-family="Arial">${text}</text>`).join('')}</svg>`)).png().toBuffer(), { expected: slashText.join(' ') });
  for (const path of DEFAULT_CWS_MEDIA_PATHS) await add(path, await prepareImageForOcr(path), { cwsPositive: true });
  for (const [text, label] of [['Add to Chrome', 'Add to Chrome'], ['Google Research', 'Google trademark'], ['Chrome extension', 'Chrome trademark'], ['reader@example.com', 'email address'], ['Piper voice models', 'removed Piper voices']]) {
    const bytes = await sharp(Buffer.from(`<svg width="1100" height="320" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><text x="60" y="184" font-family="Arial, Helvetica, sans-serif" font-size="72" font-weight="700" fill="#111111">${text}</text></svg>`)).png().toBuffer();
    await add(`cws-negative-${label}`, await prepareImageForOcr(bytes), { cwsNegative: label });
  }
  inputs = { scope: 'Existing fixed development bytes/references only; no held-out samples or corrected labels', baselineSourceSha256: hash(baselineSource), cases };
  await writeFile(`${directory}/corpus.json`, `${JSON.stringify(inputs, null, 2)}\n`);
  console.log(`Prepared ${cases.length} pinned source-page cases; no browser started.`);
} else {
  const bytes=await readFile(sourceSet?.corpusPath||`${directory}/corpus.json`);
  if(sourceSet&&hash(bytes)!==sourceSet.corpusSha256)throw new Error('Frozen source-set corpus changed.');
  inputs=JSON.parse(bytes);
}
if (process.argv.includes('--prepare')) process.exit(0);
if (hash(baselineSource) !== inputs.baselineSourceSha256) throw new Error('Frozen pre-ROI source changed.');
if(sourceSet){
  const names=inputs.cases.filter(c=>c.cwsPositive).map(c=>c.name).sort();
  if(JSON.stringify(sourceSet.originals.map(c=>c.name).sort())!==JSON.stringify(names))throw new Error('Frozen CWS source set is incomplete.');
  for(const fixed of sourceSet.originals){
    const prepared=inputs.cases.find(c=>c.name===fixed.name),bytes=await readFile(fixed.path);
    if(!prepared?.cwsPositive||prepared.path!==fixed.preparedPath||prepared.sha256!==fixed.preparedSha256
      ||hash(bytes)!==fixed.sha256||hash(await prepareImageForOcr(bytes))!==prepared.sha256)throw new Error('Frozen CWS original/prepared source association changed.');
  }
  for(const fixed of inputs.cases)if(hash(await readFile(fixed.path))!==fixed.sha256)throw new Error('Frozen prepared source changed.');
  if(process.argv.includes('--verify-source-set')){
    console.log(JSON.stringify({status:'verified-frozen-source-set-no-inference',path:sourceSetPath,sha256:hash(sourceSetBytes),cases:inputs.cases.length,originals:sourceSet.originals}));
    process.exit(0);
  }
}else if(process.argv.includes('--verify-source-set'))throw new Error('Source-set verification requires source-geometry mode.');
const report = { status: 'incomplete', scope: 'Paired production viewer/real worker over an embedded-raster page adapter; not a PDF decoding, held-out quality or weak-hardware test',
  timingScope: process.argv.includes('--functional-overlap')
    ? 'Functional correctness only; own CPU cases run serially while unrelated validation may overlap. Timings diagnostic, not controlled performance acceptance.'
    : 'Serial CPU-only browsers; other host processes uncontrolled', corpus: inputs, sourceHashes,
  ...(sourceSet?{sourceSet:{path:sourceSetPath,sha256:hash(sourceSetBytes)}}:{}),baseline: [], paper: [], failures: [] };
if (currentOnly) {
  const initialBytes = await readFile(`artifacts/engines/ocr-paper-source-roi${contrastAnchor || sourceGeometry ? '-production640' : reviewEdges ? '-source-context' : ''}.json`);
  const initial = JSON.parse(initialBytes);
  if (JSON.stringify(initial.corpus) !== JSON.stringify(inputs) || initial.paper.length !== inputs.cases.length) throw new Error('Frozen original source cohort differs.');
  report.baseline = initial.paper; report.baselineReportSha256 = hash(initialBytes);
  report.scope = 'Current bounded-source decoding/viewer against the frozen prior paper-source report over identical17 development inputs; old failures preserved separately. Not PDF decoding, held-out quality or weak-hardware proof.';
}
let paperOverride = {};
if (edgeRow) {
  const source = await readFile('src/lib/pdf-ocr.js','utf8'), needle = "const result = await worker.recognize(source, { mode: 'page' });";
  if (!source.includes(needle) || source.indexOf(needle) !== source.lastIndexOf(needle)) throw new Error('Unexpected paper-source diagnostic site');
  paperOverride = { '/src/lib/pdf-ocr.js': source.replace(needle,"const result = await worker.recognize(source, { mode: 'crop' });") };
  report.paperDetectorPolicy = 'Test-server-only1280 on source-paper ROI; production policy unchanged640';
  report.diagnosticSourceSha256 = hash(paperOverride['/src/lib/pdf-ocr.js']);
}
if(production640)report.paperDetectorPolicy='Actual production640; no detector-source override';
if(contrastAnchor)report.geometryPolicy='Contrast-aware source expansion and source-anchored cut-component completion; prior failed reports preserved';
if(sourceGeometry)report.geometryPolicy='Original A recognition crop/tensors; contrast-aware foreground frame and one actual CTC-bin bounded source-only geometry. Raw non-photo text must match A exactly; every geometry delta retained, frozen source masks checked; unmasked ownership remains a separate review.';
const outputPath = `artifacts/engines/ocr-paper-source-roi${sourceGeometry ? `-source-geometry${reportLabel?`-${reportLabel}`:edgeInk?'-edge-ink':retainedInk?'-retained-ink':''}` : contrastAnchor ? '-contrast-anchor' : production640 ? '-production640' : edgeRow ? '-edge-row' : sourceContext ? '-source-context' : currentOnly ? '-bounded' : ''}.json`;
if(reportLabel){try{await readFile(outputPath);throw new Error('Existing labeled geometry evidence is preserved.');}catch(error){if(error.code!=='ENOENT')throw error;}}
const save = async () => { await mkdir('artifacts/engines', { recursive: true }); await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`); };
const differences = (before, after) => {
  const key = item => JSON.stringify({ text: item.str, transform: item.transform, width: item.width, height: item.height });
  const available = new Map();
  after.forEach((item, index) => { const value = key(item); if (!available.has(value)) available.set(value, []); available.get(value).push(index); });
  const unmatchedBefore = [], matched = new Set();
  before.forEach((item, index) => { const candidates = available.get(key(item));
    if (candidates?.length) matched.add(candidates.shift()); else unmatchedBefore.push({ index, item });
  });
  return { before: unmatchedBefore, after: after.flatMap((item, index) => matched.has(index) ? [] : [{ index, item }]) };
};
let browser;
try {
  for (const mode of currentOnly ? ['paper'] : ['baseline', 'paper']) {
    browser = await createCpuOcrBrowser({ candidate: 'verified-retained', sourceOverrides: mode === 'baseline' ? { '/src/lib/pdf-ocr.js': baselineSource } : paperOverride });
    for (const test of inputs.cases) {
      await assertFrozen(); const bytes = await readFile(test.path);
      if (hash(bytes) !== test.sha256) throw new Error(`Frozen ROI image changed: ${test.name}`);
      const entry = { name: test.name, ...await browser.recognizePdfSource(bytes) };
      entry.invalidGeometry = entry.items.filter(item => !item.transform.every(Number.isFinite) || !Number.isFinite(item.width) || !Number.isFinite(item.height)
        || item.width <= 0 || item.height <= 0 || item.transform[4] < 0 || item.transform[5] < 0
        || item.transform[4] + item.width > entry.width / 3 + .5 || item.transform[5] > entry.height / 3 + .5).length;
      if (test.expected) entry.score = ocrWordErrorRate(test.expected, entry.text);
      if (sourceContext && test.name === 'rating-matrix') {
        const ink = JSON.parse(await readFile('artifacts/engines/ocr-matrix-source-ink.json', 'utf8'));
        const original = await readFile(ink.path);
        if (hash(original) !== ink.sha256) throw new Error('Independent matrix ink source changed.');
        const { data, info } = await sharp(original).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const candidates = entry.items.filter(item => item.str === '5').map(item => ({ left: item.transform[4] * 3,
          top: (item.transform[5] - item.height) * 3, right: (item.transform[4] + item.width) * 3, bottom: item.transform[5] * 3 }));
        entry.independentInk = candidates.map(box => {
          let covered = 0;
          for (let y = ink.search.top; y < ink.search.bottom; y++) for (let x = ink.search.left; x < ink.search.right; x++) {
            const p = (y * info.width + x) * 4;
            if (Math.min(data[p], data[p + 1], data[p + 2]) > 220 && x + .5 >= box.left && x + .5 < box.right && y + .5 >= box.top && y + .5 < box.bottom) covered++;
          }
          return { box, coveredPixels: covered, independentlyFrozenInkPixels: ink.ink.count, ratio: covered / ink.ink.count };
        }).sort((a, b) => b.coveredPixels - a.coveredPixels)[0];
      }
      if (test.cwsPositive || test.cwsNegative) entry.cwsFindings = findForbiddenText(entry.text).map(value => value.label);
      if (reviewEdges && test.cwsPositive) {
        const audit=JSON.parse(await readFile('artifacts/engines/ocr-cws-word-ink-audit.json','utf8'));
        entry.independentWordInk=[];
        for(const fixed of audit.cases.filter(value=>value.name===test.name)) {
          const originalPath=sourceGeometry?sourceSet.originals.find(c=>c.name===test.name)?.path:test.name;
          if(!originalPath)throw new Error('Independent original word-ink source is absent from frozen set');
          const original=await readFile(originalPath);
          if(hash(original)!==fixed.sha256)throw new Error('Independent original word ink source changed');
          const {data,info}=await sharp(original).ensureAlpha().raw().toBuffer({resolveWithObject:true}),scale=3*info.width/entry.width;
          const candidates=entry.items.filter(item=>item.str===fixed.word).map(item=>{
            const box={left:item.transform[4]*scale,top:(item.transform[5]-item.height)*scale,right:(item.transform[4]+item.width)*scale,bottom:item.transform[5]*scale};
            let covered=0;
            for(let y=fixed.rect[1];y<fixed.rect[3];y++)for(let x=fixed.rect[0];x<fixed.rect[2];x++){
              const p=(y*info.width+x)*4,gray=(data[p]*77+data[p+1]*150+data[p+2]*29)/256;
              if(gray>80&&x+.5>=box.left&&x+.5<box.right&&y+.5>=box.top&&y+.5<box.bottom)covered++;
            }
            return {word:fixed.word,box,covered,expected:fixed.ink.count,ratio:covered/fixed.ink.count};
          });
          entry.independentWordInk.push(candidates.sort((a,b)=>b.covered-a.covered)[0]||{word:fixed.word,ratio:0});
        }
      }
      if (test.photo) {
        const reference = JSON.parse(await readPrivateOcrFixture('docunet-35.json', 'utf8'));
        const words = entry.items.map(item => ({ text: item.str, x: (item.transform[4] + item.width / 2) * 3 / entry.width,
          y: (item.transform[5] - item.height / 2) * 3 / entry.height }));
        entry.regions = reference.regions.filter(region => region.kind === 'prose').map(region => {
          const recognized = words.filter(word => isOcrWordInRegion(word, region)).map(word => word.text).join(' ');
          return { reference: region.text, recognized, ...ocrWordErrorRate(region.text, recognized) };
        });
      }
      report[mode].push(entry); await save();
      console.log(JSON.stringify({ mode, name: test.name, elapsedMs: entry.elapsedMs, renders: entry.renders, score: entry.score, regions: entry.regions?.map(value => value.rate), invalidGeometry: entry.invalidGeometry }));
    }
    await browser.close(); browser = null;
  }
  report.differences = [];
  for (let index = 0; index < inputs.cases.length; index++) {
    const test = inputs.cases[index], before = report.baseline[index], after = report.paper[index];
    const changed = differences(before.items, after.items);
    if (changed.before.length || changed.after.length) report.differences.push({ name: test.name, ...changed,
      previousText: before.text, currentText: after.text, scope: 'Every unmatched source text/geometry item is listed; unchanged items matched exactly as a multiset, without semantic correction.' });
    if (after.invalidGeometry) report.failures.push(`${test.name}: invalid visible geometry.`);
    if (sourceContext && test.name === 'rating-matrix' && !(after.independentInk?.ratio >= .9)) report.failures.push('Matrix5 does not cover the independently observed original ink.');
    if (reviewEdges && after.independentWordInk?.some(value=>value.ratio<1)) report.failures.push(`${test.name}: independently frozen word ink coverage regressed.`);
    if (test.photo) {
      if (after.regions.some((region, i) => region.errors > before.regions[i].errors)) report.failures.push(`${test.name}: photo section quality degraded.`);
    } else if (sourceGeometry ? before.text !== after.text : JSON.stringify(after.items) !== JSON.stringify(before.items)
      && !(currentOnly && (test.name === 'rating-matrix' || test.cwsNegative))) report.failures.push(`${test.name}: non-photo primary text or geometry changed.`);
    if (currentOnly && test.name === 'rating-matrix' && before.text !== after.text) report.failures.push('Printed matrix text changed during geometry repair.');
    if (currentOnly && test.cwsNegative) {
      const expected = { 'Add to Chrome': 'Add to Chrome', 'Google trademark': 'Google Research', 'Chrome trademark': 'Chrome extension',
        'email address': 'reader@example.com', 'removed Piper voices': 'Piper voice models' }[test.cwsNegative];
      if (after.text !== expected) report.failures.push(`${test.name}: fixed printed negative text differs.`);
    }
    if (test.expected && after.score.errors > before.score.errors) report.failures.push(`${test.name}: known text degraded.`);
    if (test.cwsPositive && after.cwsFindings.length) report.failures.push(`${test.name}: CWS positive generated forbidden findings.`);
    if (test.cwsNegative && !after.cwsFindings.includes(test.cwsNegative)) report.failures.push(`${test.name}: forbidden text was missed.`);
    if (test.name === 'curved-lines' && (!/\bgoals,\s+which\s+document\b/.test(after.text) || !/\bsystem\s+requirements\b/.test(after.text.replace(/-\s+/g, '')))) report.failures.push('Curved development phrases failed.');
  }
  await assertFrozen(); report.qualityStatus = report.paper.filter(value => value.regions).every(value => value.regions.every(region => region.rate <= .05)) ? 'pass-development-photo-five-percent-gate' : 'failed-development-photo-five-percent-gate';
  report.originalSourceQualityStatus = report.paper.filter(value => value.name === 'development-photo-original-source').every(value => value.regions.every(region => region.rate <= .05))
    ? 'pass-original-source-development-photo-five-percent-gate' : 'failed-original-source-development-photo-five-percent-gate';
  report.status = report.failures.length ? 'fail-development-regression-scope' : 'pass-development-regression-scope';
  if (report.failures.length) process.exitCode = 1;
} catch (error) { report.status = 'fail'; report.failure = error.stack; throw error; }
finally { await browser?.close(); await save(); }
console.log(JSON.stringify({ status: report.status, qualityStatus: report.qualityStatus, failures: report.failures }));
