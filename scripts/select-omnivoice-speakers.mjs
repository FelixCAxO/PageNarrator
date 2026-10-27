import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { OMNIVOICE_DATA } from '../src/tts/omnivoice/model-data.js';
import { getOmniVoiceLanguageOptions } from '../src/tts/omnivoice/languages.js';

const option=name=>process.argv.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3);
const candidates=resolve(option('candidates')||'artifacts/omnivoice-fixed-voices/reference-native-v1');
const analysis=resolve(option('analysis')||'artifacts/omnivoice-fixed-voices/native-reference-analysis-v1');
const output=resolve(option('output')||'artifacts/omnivoice-fixed-voices/reference-selected-native-v1');
const planOnly=process.argv.includes('--plan-only'),allowReview=process.argv.includes('--allow-review');
const pool=JSON.parse(await readFile(`${candidates}/speakers.json`,'utf8'));
assert.equal(pool.modelRevision,OMNIVOICE_DATA.revision);
const files=(await readdir(analysis)).filter(file=>/^reference-analysis-\d+\.json$/u.test(file));
assert.ok(files.length,'No reference analyses');
const results=(await Promise.all(files.map(async file=>JSON.parse(await readFile(`${analysis}/${file}`,'utf8'))))).flat();
const byId=new Map(results.map(result=>[result.id,result]));
assert.equal(byId.size,results.length,'Duplicate reference analysis');
const minimum={speech:2.5,background:2,overall:2.5,maximumCer:.10};
const evaluated=[];
for(const speaker of pool.speakers){
  const result=byId.get(speaker.id);
  if(planOnly&&!result)continue;
  assert.ok(result,`Missing analysis for ${speaker.id}`);
  assert.equal(result.lang,speaker.lang);
  assert.equal(result.text,speaker.text);
  assert.equal(result.speakerHash,speaker.hash);
  assert.equal(createHash('sha256').update(await readFile(`${candidates}/${speaker.id}.wav`)).digest('hex'),result.wavSha256);
  assert.equal(createHash('sha256').update(new Uint8Array(BigInt64Array.from(speaker.codes,BigInt).buffer)).digest('hex'),speaker.hash);
  assert.equal(result.style.expected,speaker.gender);
  const margin=(result.style.femaleScore-result.style.maleScore)*(speaker.gender==='female'?1:-1);
  assert.ok(Number.isFinite(margin));
  const reasons=[];
  if(result.signal.physicalFailure)reasons.push('signal');
  if(result.signal.dnsmos.speech<minimum.speech||result.signal.dnsmos.background<minimum.background||result.signal.dnsmos.overall<minimum.overall)reasons.push('acoustics');
  if(result.recognition.cer>minimum.maximumCer)reasons.push('transcript');
  if(margin<=0)reasons.push('style');
  evaluated.push({speaker,result,reasons});
}
const languages=getOmniVoiceLanguageOptions().map(language=>language.code);
assert.ok(pool.speakers.every(speaker=>languages.includes(speaker.lang)));
const coverage=[],jobs=[];
for(const lang of languages)for(const gender of ['female','male']){
  const entries=evaluated.filter(item=>item.speaker.lang===lang&&item.speaker.gender===gender);
  const captured=pool.speakers.filter(speaker=>speaker.lang===lang&&speaker.gender===gender);
  const admitted=entries.filter(item=>!item.reasons.length).length;
  const usable=entries.filter(item=>!item.reasons.some(reason=>['signal','acoustics','style'].includes(reason))).length;
  const pending=captured.length-entries.length;
  coverage.push({lang,gender,candidates:captured.length,analysed:entries.length,admitted,usable,pending});
  const required=allowReview?usable:admitted;
  if(captured.length>=10&&!pending&&required<10){
    const nextSeed=Math.max(...captured.map(speaker=>speaker.seed))+1;
    const extra=Math.max(0,Math.min(12-required,30-captured.length));
    for(let index=0;index<extra;index++)jobs.push({lang,gender,seed:nextSeed+index,variation:index+1});
  }
}
await mkdir(output,{recursive:true});
await writeFile(`${output}/selection-plan.json`,JSON.stringify({minimum,coverage,jobs},null,2)+'\n');
if(planOnly){console.log(JSON.stringify({analysed:evaluated.length,candidates:pool.speakers.length,additionalCandidates:jobs.length,coverage}));}
else{
  assert.ok(coverage.every(group=>group.candidates>=10&&!group.pending),'Incomplete native-language reference pool');
  assert.ok(allowReview||coverage.every(group=>group.admitted>=10),'Some languages need additional reference candidates; see selection-plan.json');
  const selected=[];
  for(const lang of languages)for(const gender of ['female','male']){
    const available=evaluated.filter(item=>item.speaker.lang===lang&&item.speaker.gender===gender
      &&!item.reasons.some(reason=>['signal','acoustics','style'].includes(reason)));
    const chosen=[];
    while(chosen.length<10){
      const remaining=available.filter(item=>!chosen.includes(item)&&!chosen.some(other=>other.speaker.hash===item.speaker.hash));
      assert.ok(remaining.length,`Fewer than ten valid ${lang} ${gender} references`);
      remaining.sort((a,b)=>{
        const admitted=item=>Number(!item.reasons.length);
        const content=item=>Number(!item.reasons.includes('style'))+Number(!item.reasons.includes('acoustics'))+Number(!item.reasons.includes('transcript'));
        return admitted(b)-admitted(a)||content(b)-content(a)||b.result.signal.dnsmos.overall-a.result.signal.dnsmos.overall;
      });
      const item=remaining[0],variation=chosen.length+1;
      chosen.push(item);
      selected.push({...item,id:`${lang}-${gender}-${variation}`,variation});
    }
  }
  assert.equal(selected.length,640);
  const speakers=[],referenceAnalysis=[];
  for(const item of selected){
    await copyFile(`${candidates}/${item.speaker.id}.wav`,`${output}/${item.id}.wav`);
    speakers.push({...item.speaker,id:item.id,variation:item.variation});
    referenceAnalysis.push({...item.result,id:item.id});
  }
  const receipt={scope:'Native-language reference screening only; independent target-text checks and native listening remain separate.',minimum,
    coverage,selected:selected.map(({id,speaker,result,reasons})=>({id,sourceId:speaker.id,seed:speaker.seed,speakerHash:speaker.hash,
      wavSha256:result.wavSha256,dnsmos:result.signal.dnsmos,recognition:result.recognition,style:result.style,reasons})),
    automaticPasses:selected.filter(item=>!item.reasons.length).length,reviewRequired:selected.filter(item=>item.reasons.length).map(item=>item.id)};
  await writeFile(`${output}/selection.json`,JSON.stringify(receipt,null,2)+'\n');
  await writeFile(`${output}/speakers.json`,JSON.stringify({version:3,modelRevision:pool.modelRevision,speakers},null,2)+'\n');
  await writeFile(`${output}/reference-analysis.json`,JSON.stringify(referenceAnalysis,null,2)+'\n');
  if(process.argv.includes('--write-catalog')){
    const catalog={version:3,modelRevision:pool.modelRevision,speakers:speakers.map(({id,lang,text,gender,variation,seed,frames,codes,hash})=>({id,lang,text,gender,variation,seed,frames,codes,hash}))};
    await writeFile('src/tts/omnivoice/speaker-data.js','// Generated language-specific references; see scripts/build-omnivoice-speakers.mjs and scripts/select-omnivoice-speakers.mjs.\nexport default '+JSON.stringify(catalog)+';\n');
  }
  console.log(JSON.stringify({output,selected:speakers.length,automaticReferencePasses:receipt.automaticPasses,reviewRequired:receipt.reviewRequired}));
}
