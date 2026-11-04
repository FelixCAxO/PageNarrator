// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import{readFile}from'node:fs/promises';
import{resolve}from'node:path';
import{createHash}from'node:crypto';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const FIRST='e70f8b3c6a863a60e000533fd2db46793d7487f6491a92868ddc08a8b6d2eff0';
const RESERVE='9531dcaa8642c6965fe65b266d19895d365a900ec8d93d242d5fdd0b41b8bb49';
const RESERVE_DATA='4bfcda66f8659231e7d5fae509ea1a82b94f58427a84f5ec8097d7732f14dc1d';

/** Source data only; never initializes an OCR runtime or evaluates a sample. */
export async function readOcrHoldoutManifests(root){
  const bytes=await readFile(resolve(root,'acceptance.json')),sha256=hash(bytes),acceptance=JSON.parse(bytes);
  if(![FIRST,RESERVE].includes(sha256))throw new Error('Unknown or changed preregistered OCR acceptance.');
  const reserve=sha256===RESERVE,goldFile=reserve?acceptance.photoGoldFile:'photo-gold.json';
  const files=['acceptance.json','scans-manifest.json','photos-manifest.json',goldFile,'legacy-oracle-pins.json'];
  const manifests={'acceptance.json':{sha256,data:acceptance}};
  const expected={'scans-manifest.json':acceptance.selectionManifestSha256,'photos-manifest.json':acceptance.photoManifestSha256,
    [goldFile]:acceptance.photoGoldSha256};
  if(reserve){
    Object.assign(expected,{[acceptance.photoNeighborMasksFile]:acceptance.photoNeighborMasksSha256,
      [acceptance.annotationScopeSupplementFile]:acceptance.annotationScopeSupplementSha256,
      'source-only-review-verdict.json':acceptance.sourceOnlyReviewVerdictSha256,
      'scan-source-annotation-audit.json':acceptance.scanSourceAnnotationAuditSha256,
      'acceptance-policy.json':acceptance.initialAcceptancePolicySha256,'reserve-data-freeze.json':RESERVE_DATA});
    files.push(...Object.keys(expected).filter(file=>!files.includes(file)));
  }
  for(const file of files.slice(1)){
    const content=await readFile(resolve(root,file)),actual=hash(content);
    if(expected[file]&&actual!==expected[file])throw new Error('Preregistered OCR manifest/scope changed.');
    manifests[file]={sha256:actual,data:JSON.parse(content)};
  }
  if(reserve){
    const supplement=manifests[acceptance.annotationScopeSupplementFile].data,
      neighbors=manifests[acceptance.photoNeighborMasksFile].data,review=manifests['source-only-review-verdict.json'].data;
    if(JSON.stringify(supplement.scanCases)!==JSON.stringify(acceptance.scanTextScopes)
      ||JSON.stringify(neighbors.masks)!==JSON.stringify(acceptance.geometry.photoNeighborMasks)
      ||review.status!=='PASS-original-image-only-gold-and-mask-review')throw new Error('Frozen annotation scope/source review differs.');
    for(const[file,expectedSha]of Object.entries(review.files))if(manifests[file]?.sha256!==expectedSha)
      throw new Error('Independent source-only review refers to different annotations.');
    for(const[file,pin]of Object.entries(manifests['reserve-data-freeze.json'].data.files)){
      const content=await readFile(resolve(root,file));
      if(content.length!==pin.bytes||hash(content)!==pin.sha256)throw new Error('Frozen reserve data bytes changed.');
    }
    const scopes=acceptance.scanTextScopes,scans=manifests['scans-manifest.json'].data.cases;
    if(scopes.length!==scans.length||new Set(scopes.map(s=>s.name)).size!==scans.length
      ||scans.some(s=>!scopes.some(scope=>scope.name===s.name&&scope.imageSha256===s.imageSha256
        &&scope.referenceSha256===s.goldSha256)))throw new Error('Frozen scan scope/input/reference association changed.');
  }
  return{files,manifests,acceptance,reserve,goldFile};
}
