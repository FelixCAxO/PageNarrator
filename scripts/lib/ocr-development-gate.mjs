// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import{readFile,readdir}from'node:fs/promises';
import{createHash}from'node:crypto';
import { readOcrSourceFile } from './ocr-private-fixtures.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function pinOcrCandidateSources(){
  const files=[...(await readdir('src/engines')).filter(f=>f.endsWith('.js')).map(f=>`src/engines/${f}`),
    ...(await readdir('src/lib')).filter(f=>f.startsWith('pdf-ocr')&&f.endsWith('.js')).map(f=>`src/lib/${f}`),
    'src/lib/native-kernels.js','src/lib/logger.js','native/ocr-engine.cpp','native/engine.cpp',
    'scripts/probe-ocr-holdout.mjs','scripts/ocr-cpu-browser.mjs','scripts/lib/ocr-engine-observer.mjs',
    'scripts/lib/ocr-private-fixtures.mjs','scripts/lib/ocr-holdout-score.mjs','scripts/lib/ocr-resource-gates.mjs','scripts/lib/ocr-development-gate.mjs',
    'scripts/lib/ocr-holdout-manifests.mjs','scripts/lib/ocr-holdout-scan-scope.mjs','scripts/lib/ocr-worker-result-capture.mjs','scripts/audit-ocr-holdout.mjs',
    'tests/fixtures/ocr/docunet-35.json','tests/fixtures/ocr/curved-body.txt',
    ...['ocr-engine','ocr-lstm-engine','engine','kernels'].flatMap(f=>[`public/native/${f}.wasm`,`public/native/${f}.json`]),
    ...['tiny-det.onnx','small-rec.onnx','small-rec-alphabet.json','uvdoc.onnx','english-lstm.json','english-lstm.bin','models.json'].map(f=>`public/assets/ocr/${f}`)];
  return Object.fromEntries(await Promise.all([...new Set(files)].sort().map(async path=>[path,hash(await readOcrSourceFile(path))])));
}

export async function readOcrDevelopmentGate(path,pins){
  const bytes=await readFile(path),gate=JSON.parse(bytes);
  if(gate.version!==1||!gate.sourcePins||!Object.keys(gate.sourcePins).length
    ||JSON.stringify(gate.sourcePins)!==JSON.stringify(pins))throw new Error('Accepted development runtime candidate changed or is unpinned.');
  const docs={},artifacts={};
  for(const key of['report','masks','review','coordinatorReview','rootReview','sourceSet']){
    const file=gate[key];if(!file?.path||!file.sha256)throw new Error('Accepted development artifact is unpinned.');
    const content=await readFile(file.path);
    if(hash(content)!==file.sha256)throw new Error('Accepted development artifact changed.');
    docs[key]=JSON.parse(content);artifacts[key]=file;
  }
  if(docs.report.status!=='pass-development-regression-scope'||docs.report.paper?.length!==17
    ||docs.report.failures?.length!==0||docs.masks.status!=='PASS-frozen-development-masks-only'
    ||docs.masks.failures?.length!==0||docs.masks.textDifferences?.length!==0
    ||docs.review.status!=='PASS-reviewed-connected-edge-development-geometry'
    ||docs.coordinatorReview.status!=='PASS-independent-coordinator-review-of-four-new-box-deltas'
    ||docs.rootReview.status!=='PASS-independent-agent-connected-edge-development-review'
    ||docs.sourceSet.status!=='frozen-development-source-bytes-verified')throw new Error('Current development text/source ownership is not accepted.');
  if(docs.masks.candidateReportSha256!==gate.report.sha256||docs.review.candidateReportSha256!==gate.report.sha256
    ||docs.coordinatorReview.candidateReportSha256!==gate.report.sha256||docs.coordinatorReview.verdictSha256!==gate.review.sha256
    ||docs.rootReview.candidateReportSha256!==gate.report.sha256||docs.rootReview.verdictSha256!==gate.review.sha256
    ||docs.rootReview.coordinatorReviewSha256!==gate.coordinatorReview.sha256)
    throw new Error('Accepted development reports/reviews refer to different candidates.');
  if(!docs.report.sourceHashes||!Object.keys(docs.report.sourceHashes).length
    ||Object.entries(docs.report.sourceHashes).some(([file,sha])=>pins[file]!==sha))throw new Error('Accepted development report used different runtime/data bytes.');
  const corpusBytes=await readFile(docs.sourceSet.corpusPath);
  if(hash(corpusBytes)!==docs.sourceSet.corpusSha256||JSON.stringify(JSON.parse(corpusBytes))!==JSON.stringify(docs.report.corpus))
    throw new Error('Accepted development source set differs from the evaluated corpus.');
  return{path,sha256:hash(bytes),artifacts};
}
