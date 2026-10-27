import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { getOmniVoiceSpeakerReference } from '../src/tts/omnivoice/speakers.js';
import { isOmniVoiceWhisperAvailable } from '../src/lib/omnivoice-settings.js';

const root=resolve(process.argv.find(arg=>arg.startsWith('--directory='))?.slice(12)||'artifacts/omnivoice-fixed-voices/quality-native-v1');
const read=async path=>JSON.parse(await readFile(path,'utf8'));
const corpus=(await read(`${root}/corpus.json`)).languages;
const hasWhisper=corpus.some(item=>item.omniVoice.whisper);
const modes=hasWhisper?[false,true]:[false],expected=640*modes.length;
const runtime=await read(`${root}/runtime.json`);
const referenceReceipt=await read(`${root}/reference-selection.json`);
assert.equal(referenceReceipt.selected.length,640);
const referenceAssessments=new Map(referenceReceipt.selected.map(item=>[item.id,item]));
assert.equal(referenceAssessments.size,640);
const rows=[];
const factorySha256=createHash('sha256').update(await readFile('src/lib/omnivoice-settings.js')).digest('hex');
for(const item of corpus){
  let record=null,analysis=null;
  try{record=await read(`${root}/records/${item.id}.json`);}catch(error){if(error.code!=='ENOENT')throw error;}
  try{analysis=await read(`${root}/analysis/${item.id}.json`);}catch(error){if(error.code!=='ENOENT')throw error;}
  const selectedReference=getOmniVoiceSpeakerReference({lang:item.code,speakerId:`${item.omniVoice.gender}-${item.omniVoice.variation}`,instruct:'',seed:41+item.omniVoice.variation});
  const referenceAssessment=referenceAssessments.get(selectedReference.referenceId);
  assert.equal(referenceAssessment?.speakerHash,selectedReference.hash,'Reference receipt differs from the bundled catalog');
  const row={id:item.id,code:item.code,language:item.name,gender:item.omniVoice.gender,variation:item.omniVoice.variation,
    whisper:item.omniVoice.whisper===true,text:item.text,replayOf:item.replayOf||null,status:analysis?.status||record?.status||'not-captured',
    signal:analysis?.signal,recognition:analysis?.recognition,identityDiagnostic:analysis?.identityDiagnostic,
    recognitionMetric:analysis?.recognitionMetric,recognitionErrorRate:analysis?.recognitionErrorRate,recognitionDecision:analysis?.recognitionDecision,
    style:analysis?.style,backingSpeech:analysis?.backingSpeech,
    captureOrigin:record?.captureOrigin||'packaged-worker',rendererConformance:record?.rendererConformance,
    replay:record?.replay,nativeListening:'unverified',wav:record?.wav,
    referenceId:selectedReference.referenceId,referenceReviewReasons:referenceAssessment.reasons};
  if(row.whisper&&row.status==='automatic-sample-pass'&&row.style?.whisperMargin<=0)row.status='review-whisper-style';
  if(record?.status==='unsupported-whisper'){
    const settings={text:item.text,voice:{detectCode:item.code,omniVoice:item.omniVoice}};
    row.integrityPassed=row.whisper&&!isOmniVoiceWhisperAvailable(item.code)&&record.workerSha256===runtime.workerSha256
      &&record.requestFactorySha256===factorySha256&&runtime.requestFactorySha256===factorySha256
      &&record.requestSha256===createHash('sha256').update(JSON.stringify(settings)).digest('hex');
    if(!row.integrityPassed)row.status='integrity-failed';
  }
  if(record?.wav){
    const wav=await readFile(`${root}/${record.wav}`);
    row.captureIntegrityPassed=createHash('sha256').update(wav).digest('hex')===record.wavSha256
      &&record.workerSha256===runtime.workerSha256
      &&createHash('sha256').update(JSON.stringify(record.request)).digest('hex')===record.requestSha256;
    if(record.captureOrigin==='production-renderer-from-exact-worker-float32'){
      const backing=await read(`${root}/records/${record.backingRecord}.json`);
      const raw=await readFile(`${root}/${backing.pcmFile}`);
      row.captureIntegrityPassed&&=createHash('sha256').update(raw).digest('hex')===backing.pcmSha256
        &&record.backingPcmSha256===backing.pcmSha256
        &&record.rendererSha256===createHash('sha256').update(await readFile('src/tts/omnivoice/whisper.js')).digest('hex');
    }
    row.integrityPassed=row.captureIntegrityPassed&&analysis?.wavSha256===record.wavSha256
      &&analysis?.workerSha256===record.workerSha256&&analysis?.requestSha256===record.requestSha256;
    const reference=getOmniVoiceSpeakerReference(record.request);
    const successes=record.attempts.filter(attempt=>attempt.speaker);
    row.fixedReferencePassed=successes.length>0&&successes
      .every(attempt=>attempt.speaker.referenceHash===reference.hash&&attempt.speaker.id===record.request.speakerId);
    if(!row.captureIntegrityPassed||(analysis&&!row.integrityPassed))row.status='integrity-failed';
    else if(!row.fixedReferencePassed)row.status='reference-identity-failed';
    else if(!analysis)row.status='awaiting-analysis';
  }
  rows.push(row);
}
const matrix=rows.filter(row=>!row.replayOf),replays=rows.filter(row=>row.replayOf);
const counts={};for(const row of matrix)counts[row.status]=(counts[row.status]||0)+1;
const languages=[...new Set(matrix.map(row=>row.code))].map(code=>{
  const cases=matrix.filter(row=>row.code===code);
  return {code,name:cases[0].language,total:cases.length,automaticPasses:cases.filter(row=>row.status==='automatic-sample-pass'&&!row.referenceReviewReasons.length).length,
    unavailable:cases.filter(row=>row.status==='unsupported-whisper').length,
    flagged:cases.filter(row=>!['automatic-sample-pass','unsupported-whisper'].includes(row.status)||row.referenceReviewReasons.length).map(row=>row.id)};
});
assert.equal(matrix.length,expected,'Expected all 32 languages and twenty voice presets per mode');
assert.equal(new Set(matrix.map(row=>row.id)).size,expected,'Duplicate matrix case');
assert.equal(languages.length,32);
assert.ok(languages.every(language=>language.total===20*modes.length));
const captureComplete=matrix.length===expected&&languages.length===32&&languages.every(language=>language.total===20*modes.length)
  &&matrix.every(row=>row.integrityPassed);
const whisperControls=matrix.filter(row=>row.whisper&&row.variation===1&&isOmniVoiceWhisperAvailable(row.code));
const expectedWhisperControls=2*languages.filter(language=>isOmniVoiceWhisperAvailable(language.code)).length;
const rendererConformancePassed=!hasWhisper||(whisperControls.length===expectedWhisperControls&&whisperControls.every(row=>row.captureOrigin==='packaged-worker'&&(row.rendererConformance?.equalPcm||(row.rendererConformance?.tolerance===1e-6&&row.rendererConformance?.passed&&row.rendererConformance?.maxAbsoluteError<=1e-6))));
const unavailableWhisperCases=matrix.filter(row=>row.whisper&&!isOmniVoiceWhisperAvailable(row.code)).length;
const result={status:'native-listening-unverified',scope:`${expected} development cases: ${expected-unavailableWhisperCases} audio probes and ${unavailableWhisperCases} unavailable-whisper checks. 32 selectable languages, two genders and ten variations${hasWhisper?', normal and available whisper modes':''}. No general language-quality or native-listening approval. Whisper acoustics are diagnostic; acceptance requires accurate recognized words, a positive whisper-style margin and identical backing speech passing the unchanged normal acoustic gate.`,unavailableWhisperCases,
  captureComplete,counts,rendererConformancePassed,referenceIdentityPassed:captureComplete&&matrix.filter(row=>row.status!=='unsupported-whisper').every(row=>row.fixedReferencePassed),
  referenceScreeningPasses:referenceReceipt.selected.filter(reference=>!reference.reasons.length).length,
  referenceScreeningPassed:referenceReceipt.selected.every(reference=>!reference.reasons.length),
  replayCount:replays.length,sameDeviceReplayPassed:replays.length===20*modes.length&&replays.every(row=>row.integrityPassed&&row.replay?.equalPcm),
  automaticScreeningPassed:captureComplete&&rendererConformancePassed&&referenceReceipt.selected.every(reference=>!reference.reasons.length)&&matrix.every(row=>['automatic-sample-pass','unsupported-whisper'].includes(row.status)),
  workerSha256:runtime.workerSha256,languages,rows};
await writeFile(`${root}/summary.json`,JSON.stringify(result,null,2)+'\n');
const esc=text=>String(text??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const presets=modes.flatMap(whisper=>['female','male'].flatMap(gender=>Array.from({length:10},(_,i)=>({gender,variation:i+1,whisper}))));
const cellClass=row=>row.status==='unsupported-whisper'?'unavailable':row.status==='automatic-sample-pass'&&!row.referenceReviewReasons?.length?'pass':['not-captured','awaiting-analysis'].includes(row.status)?'pending':'flag';
assert.deepEqual(['automatic-sample-pass','integrity-failed','not-captured'].map(status=>cellClass({status})),['pass','flag','pending']);
const overview=`<div class="scroll"><table class="matrix"><caption>F = female, M = male. ✓ = reference and target probes pass, ! = review, … = pending, — = whisper unavailable. Every result still needs native listening.</caption>
<thead><tr><th>Language</th>${presets.map(preset=>`<th>${preset.whisper?'W':''}${preset.gender==='female'?'F':'M'}${preset.variation}</th>`).join('')}</tr></thead>
<tbody>${languages.map(language=>`<tr><th><a href="#${esc(language.code)}">${esc(language.name)}</a></th>${presets.map(preset=>{
  const row=matrix.find(row=>row.code===language.code&&row.gender===preset.gender&&row.variation===preset.variation&&row.whisper===preset.whisper);
  const style=cellClass(row);
  return `<td class="${style}" title="${esc(row.id+': '+row.status+(row.referenceReviewReasons.length?'; reference review: '+row.referenceReviewReasons.join(', '):''))}">${style==='pass'?'✓':style==='flag'?'!':style==='unavailable'?'—':'…'}</td>`;
}).join('')}</tr>`).join('')}</tbody></table></div>`;
const report=`<!doctype html><html lang="en"><meta charset="utf-8"><title>OmniVoice variation review</title>
<style>body{font:16px system-ui;max-width:1200px;margin:32px auto;padding:0 16px;color:#17212f;background:#f7f9fc}table{width:100%;border-collapse:collapse}th,td{padding:10px;text-align:left;border-bottom:1px solid #d4dce8}details{margin:12px 0;background:white;padding:14px}summary{cursor:pointer;font-weight:bold}audio{max-width:260px;height:36px}.flag{color:#a42b18}.pass{color:#14623b;background:#e3f4e9}.pending{color:#677284}p{max-width:85ch}.scroll{overflow:auto}.matrix{font-size:13px;background:white}.matrix td,.matrix th{padding:6px}.matrix td{text-align:center}.matrix .flag{background:#ffebdb}caption{text-align:left;padding:12px 0}small{display:block;max-width:32ch;margin-top:6px}</style>
<h1>OmniVoice — ten fixed variations</h1><p>${esc(result.scope)}</p>
<p>Complete and bound capture: <b>${captureComplete}</b>. Fixed references: <b>${result.referenceIdentityPassed}</b>. Same-device restart replay: <b>${result.sameDeviceReplayPassed}</b>. Reference probes: <b>${result.referenceScreeningPasses}/640</b>. Available audio sample passes: <b>${counts['automatic-sample-pass']||0}/${expected-unavailableWhisperCases}</b>. Unavailable-whisper checks: <b>${counts['unsupported-whisper']||0}/${unavailableWhisperCases}</b>.</p>
<p>Listen for pronunciation, missing/repeated words, noise and naturalness. Automated matches do not approve these dimensions. Each language below retains every variation and flagged recording.</p>${overview}
${languages.map(language=>`<details id="${esc(language.code)}" ${language.code==='sv'?'open':''}>
<summary>${esc(language.name)} — ${language.automaticPasses}/${language.total-language.unavailable} available audio sample passes${language.unavailable?`; ${language.unavailable} unavailable-whisper checks`:''}</summary>
<p lang="${esc(language.code)}">${esc(matrix.find(row=>row.code===language.code).text)}</p>
<table><thead><tr><th>Voice</th><th>Result and recognized text</th><th>Character error</th><th>Acoustic score</th><th>Recording</th></tr></thead>
<tbody>${matrix.filter(row=>row.code===language.code).map(row=>`<tr class="${cellClass(row)}">
<td>${row.whisper?'Whisper ':''}${esc(row.gender)} ${row.variation}<small>Reference: ${esc(row.referenceId)}</small></td><td>${esc(row.status)}<small lang="${esc(row.code)}">${esc(row.recognition?.transcript)}</small>${row.referenceReviewReasons.length?`<small class="flag">Reference review: ${esc(row.referenceReviewReasons.join(', '))}</small>`:''}</td>
<td>${row.recognition?(100*(row.recognitionErrorRate??row.recognition.cer)).toFixed(1)+'%':'—'}<small>${esc(row.recognitionMetric||'character-error')}${row.recognitionDecision?'; primary disagreement retained in JSON':''}</small></td><td>${row.signal?.dnsmos?.overall?.toFixed(2)||'—'}</td>
<td>${row.wav?`<audio controls preload="none" src="${esc(row.wav)}"></audio>`:'No recording'}</td></tr>`).join('')}</tbody></table></details>`).join('')}</html>`;
await writeFile(`${root}/review.html`,report);
console.log(JSON.stringify({...result,rows:undefined,languages:undefined}));
if(process.argv.includes('--require-pass')&&(!result.automaticScreeningPassed||!result.sameDeviceReplayPassed))process.exitCode=1;
