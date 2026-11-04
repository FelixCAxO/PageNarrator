// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import{readFile,writeFile}from'node:fs/promises';
import{createHash}from'node:crypto';
import{resolve}from'node:path';

const index=process.argv.indexOf('--directory'),directory=index<0?process.env.PN_OCR_HOLDOUT_DIR:process.argv[index+1];
if(!directory)throw new Error('Specify the private frozen corpus directory.');
const labelIndex=process.argv.indexOf('--regression-label'),regressionLabel=labelIndex<0?null:process.argv[labelIndex+1];
if(labelIndex>=0&&(!regressionLabel||!/^[a-z0-9-]+$/.test(regressionLabel)))throw new Error('Invalid development regression label.');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),root=resolve(directory),reports={};
const output={scope:'Preregistered implementation holdout: per-page/region absolute5percent WER/CER and no degradation against the independent old executable on identical bytes. Private external evidence only; no training-disjoint or weak-device performance claim.',status:'incomplete',reports:{},comparisons:[],failures:[]};
let first;
if(regressionLabel){
  first=JSON.parse(await readFile(resolve(root,'evaluation-summary.json')));
  if(first.status!=='FAIL-preregistered-implementation-holdout')throw new Error('Only the preserved failed first evaluation is development regression data.');
  output.scope='Previously consumed first9 development regression under unchanged original quality/geometry/resource gates. Compares new original-backend runs against immutable first legacy outputs on identical bytes; not fresh quality or performance acceptance.';
  output.regressionLabel=regressionLabel;
}
for(const backend of['cpu','nvidia','intel','legacy']){
  try{const path=regressionLabel&&backend!=='legacy'?`regression-${regressionLabel}-${backend}.json`:`evaluation-${backend}.json`,bytes=await readFile(resolve(root,path));
    if(regressionLabel&&backend==='legacy'&&hash(bytes)!==first.reports.legacy.sha256)throw new Error('Immutable first legacy report changed.');
    reports[backend]=JSON.parse(bytes);output.reports[backend]={sha256:hash(bytes),status:reports[backend].status,closed:reports[backend].closed,cases:reports[backend].cases.length};}
  catch(error){if(error.code!=='ENOENT')throw error;output.failures.push(`${backend}: required report missing`);}
}
const legacy=reports.legacy;
if(!regressionLabel){
  const acceptanceBytes=await readFile(resolve(root,'acceptance.json')),acceptance=JSON.parse(acceptanceBytes);
  if(Object.values(reports).some(report=>report.manifests['acceptance.json']!==hash(acceptanceBytes)))throw new Error('Evaluated acceptance differs from current frozen scope.');
  output.scope=acceptance.scope;
  if(acceptance.scanTextScopes)output.annotationScope={scans:acceptance.scanTextScopes,
    supplementSha256:acceptance.annotationScopeSupplementSha256,rawFullPageDiagnosticsExcludedFromPrimaryAggregate:true};
}
output.rawFullPageDiagnostics=[];
for(const[backend,report]of Object.entries(reports)){
  output.rawFullPageDiagnostics.push(...report.cases.flatMap(entry=>entry.rawFullPageDiagnostic
    ?[{backend,name:entry.name,...entry.rawFullPageDiagnostic}]:[]));
  if(!report.closed||report.cases.length!==9||report.cases.some(c=>c.status==='FAIL-execution'))output.failures.push(`${backend}: incomplete execution/lifecycle evidence`);
  const common=regressionLabel?reports.cpu:legacy;
  if(legacy&&(JSON.stringify(report.manifests)!==JSON.stringify(legacy.manifests)
    ||(!regressionLabel||backend!=='legacy')&&common&&JSON.stringify(report.sourcePins)!==JSON.stringify(common.sourcePins)))output.failures.push(`${backend}: common source/model/gold candidate changed`);
  if(backend==='legacy'){if(report.status.startsWith('FAIL'))output.failures.push('legacy: independent oracle execution/geometry failed');continue;}
  if(report.status.startsWith('FAIL'))output.failures.push(`${backend}: absolute/backend/resource gates failed`);
  for(const entry of report.cases){
    const before=legacy?.cases.find(c=>c.name===entry.name);
    if(!before||before.inputSha256!==entry.inputSha256||before.scores?.length!==entry.scores?.length){output.failures.push(`${backend}/${entry.name}: independent same-input comparison unavailable`);continue;}
    for(let region=0;region<entry.scores.length;region++){
      const own=entry.scores[region],old=before.scores[region];
      if(own.reference!==old.reference||own.scope!==old.scope||own.word.referenceWords!==old.word.referenceWords||own.character.referenceCharacters!==old.character.referenceCharacters)throw new Error('Protected scoring reference/scope changed between backends');
      const record={backend,name:entry.name,region,scope:own.scope||(entry.anchorGeometry?'declared-photo-region':'whole-page'),word:{own:own.word.rate,legacy:old.word.rate,deltaErrors:own.word.errors-old.word.errors},
        character:{own:own.character.rate,legacy:old.character.rate,deltaErrors:own.character.errors-old.character.errors}};
      output.comparisons.push(record);
      if(record.word.deltaErrors>0||record.character.deltaErrors>0)output.failures.push(`${backend}/${entry.name}/${region}: quality worse than legacy`);
    }
  }
}
output.status=output.failures.length?(regressionLabel?'FAIL-preregistered-development-regression':'FAIL-preregistered-implementation-holdout'):regressionLabel?'PASS-development-regression-not-release-acceptance':'PASS-preregistered-implementation-holdout';
await writeFile(resolve(root,regressionLabel?`regression-${regressionLabel}-summary.json`:'evaluation-summary.json'),JSON.stringify(output,null,2),{flag:'wx'});
console.log(JSON.stringify(output,null,2));if(output.failures.length)process.exitCode=1;
