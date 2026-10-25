import{afterEach,expect,it}from'vitest';
import{mkdtemp,writeFile,rm}from'node:fs/promises';
import{join,resolve,sep}from'node:path';
import{tmpdir}from'node:os';
import{createHash}from'node:crypto';
import{readOcrDevelopmentGate}from'../../scripts/lib/ocr-development-gate.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),directories=[];
afterEach(async()=>{
  for(const directory of directories.splice(0)){
    if(!directory.startsWith(resolve(tmpdir())+sep+'pagenarrator-ocr-gate-'))throw new Error('Unsafe gate test cleanup path');
    await rm(directory,{recursive:true,force:true});
  }
});
async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'pagenarrator-ocr-gate-'));directories.push(directory);
  const pins={'src/lib/pdf-ocr-word-bounds.js':'a'.repeat(64)},corpus={cases:Array.from({length:17},(_,i)=>({name:`fixed-${i}`}))};
  const corpusBytes=JSON.stringify(corpus),corpusPath=join(directory,'corpus.json');await writeFile(corpusPath,corpusBytes);
  const docs={report:{status:'pass-development-regression-scope',paper:Array(17).fill({}),failures:[],sourceHashes:{...pins},corpus},
    masks:{status:'PASS-frozen-development-masks-only',failures:[],textDifferences:[]},
    review:{status:'PASS-reviewed-connected-edge-development-geometry'},
    coordinatorReview:{status:'PASS-independent-coordinator-review-of-four-new-box-deltas'},
    rootReview:{status:'PASS-independent-agent-connected-edge-development-review'},
    sourceSet:{status:'frozen-development-source-bytes-verified',corpusPath,corpusSha256:hash(corpusBytes)}};
  const gate={version:1,sourcePins:{...pins}},path=join(directory,'gate.json');
  const write=async key=>{const bytes=JSON.stringify(docs[key]),file=join(directory,`${key}.json`);await writeFile(file,bytes);gate[key]={path:file,sha256:hash(bytes)};};
  const save=()=>writeFile(path,JSON.stringify(gate));
  const publish=async()=>{
    await write('report');
    for(const key of['masks','review','coordinatorReview','rootReview'])docs[key].candidateReportSha256=gate.report.sha256;
    await write('masks');await write('review');docs.rootReview.verdictSha256=gate.review.sha256;
    docs.coordinatorReview.verdictSha256=gate.review.sha256;await write('coordinatorReview');
    docs.rootReview.coordinatorReviewSha256=gate.coordinatorReview.sha256;
    await write('rootReview');await write('sourceSet');await save();
  };
  await publish();return{path,pins,docs,gate,write,save,publish,corpusPath};
}

it('binds accepted development artifacts and exact runtime to the evaluated source set',async()=>{
  const f=await fixture(),gate=await readOcrDevelopmentGate(f.path,f.pins);
  expect(gate.path).toBe(f.path);expect(gate.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(gate.artifacts.report.sha256).toBe(f.gate.report.sha256);
});
it.each(['changed-runtime','empty-pins','missing-artifact','changed-artifact','old-review-status','failed-report',
  'missing-page','text-delta','stale-mask-report','stale-root-verdict','different-evaluated-runtime','empty-evaluated-runtime',
  'changed-corpus-bytes','different-evaluated-corpus','stale-coordinator-link','failed-coordinator-review'])('rejects %s before any inference',async kind=>{
  const f=await fixture();let pins=f.pins;
  if(kind==='changed-runtime')pins={...pins,'src/lib/pdf-ocr-word-bounds.js':'b'.repeat(64)};
  if(kind==='empty-pins'){f.gate.sourcePins={};pins={};await f.save();}
  if(kind==='missing-artifact'){delete f.gate.masks;await f.save();}
  if(kind==='changed-artifact')await writeFile(f.gate.masks.path,'{}');
  if(kind==='old-review-status'){f.docs.review.status='PASS-reviewed-development-source-ownership';await f.publish();}
  if(kind==='failed-report'){f.docs.report.failures=['real failure'];await f.publish();}
  if(kind==='missing-page'){f.docs.report.paper.pop();await f.publish();}
  if(kind==='text-delta'){f.docs.masks.textDifferences=['real delta'];await f.write('masks');await f.save();}
  if(kind==='stale-mask-report'){f.docs.masks.candidateReportSha256='b'.repeat(64);await f.write('masks');await f.save();}
  if(kind==='stale-root-verdict'){f.docs.rootReview.verdictSha256='b'.repeat(64);await f.write('rootReview');await f.save();}
  if(kind==='stale-coordinator-link'){f.docs.rootReview.coordinatorReviewSha256='b'.repeat(64);await f.write('rootReview');await f.save();}
  if(kind==='failed-coordinator-review'){f.docs.coordinatorReview.status='FAIL-review';await f.publish();}
  if(kind==='different-evaluated-runtime'){f.docs.report.sourceHashes['src/lib/pdf-ocr-word-bounds.js']='b'.repeat(64);await f.publish();}
  if(kind==='empty-evaluated-runtime'){f.docs.report.sourceHashes={};await f.publish();}
  if(kind==='changed-corpus-bytes')await writeFile(f.corpusPath,'{}');
  if(kind==='different-evaluated-corpus'){f.docs.report.corpus={cases:[]};await f.publish();}
  await expect(readOcrDevelopmentGate(f.path,pins)).rejects.toThrow();
});
