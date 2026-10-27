import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from '@playwright/test';
import manifest from '../tests/fixtures/browser-speech-models.json' with { type: 'json' };
import { waveBytes } from './lib/kokoro-speech-acceptance.mjs';
import { acquireMeasurementLock } from './weak-hardware/measurement-lock.mjs';
import { browserAdapterConfiguration } from './lib/browser-adapter.mjs';
import { getOmniVoiceLanguageOptions } from '../src/tts/omnivoice/languages.js';
import referenceTexts from '../tests/fixtures/omnivoice-reference-texts.json' with {type:'json'};
import whisperTexts from '../tests/fixtures/omnivoice-whisper-reference-texts.json' with {type:'json'};

const argument = (name, fallback) => process.argv.find(value=>value.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback;
const count=Number(argument('count','10')), startSeed=Number(argument('start-seed','42'));
if(!Number.isInteger(count)||count<1||count>100||!Number.isInteger(startSeed)||startSeed<0
  ||process.argv.slice(2).some(value=>!/^--(?:count|start-seed|output|languages|append|plan|references|runtime)=/u.test(value)))throw new Error('Use --count=1..100 --start-seed=N --output=DIRECTORY --languages=all|sv,en --append=1 --plan=FILE --references=FILE --runtime=FILE');
const root = process.cwd(), output = resolve(argument('output','artifacts/omnivoice-fixed-voices/reference-candidates'));
const text = 'The morning light fills the room. I speak clearly and calmly, with a steady and natural voice.';
const requestedLanguages=argument('languages','en').split(',');
const languageCodes=requestedLanguages.includes('all')?['sv',...getOmniVoiceLanguageOptions().map(item=>item.code).filter(code=>code!=='sv')]:requestedLanguages;
if(new Set(languageCodes).size!==languageCodes.length||languageCodes.some(code=>!Object.hasOwn(referenceTexts,code)))throw new Error('Unknown or duplicate reference language');
const multilingual=process.argv.some(value=>value.startsWith('--languages='));
const jobs=argument('plan','')?JSON.parse(await readFile(argument('plan',''),'utf8')).jobs:languageCodes.flatMap(lang=>['female','male'].flatMap(gender=>Array.from({length:count},(_,index)=>({lang,gender,seed:startSeed+index,variation:index+1}))));
if(jobs.some(job=>!Object.hasOwn(referenceTexts,job.lang)||!['female','male'].includes(job.gender)||!Number.isInteger(job.seed)||job.seed<0||(job.guidanceScale!=null&&job.guidanceScale!==2&&!argument('runtime',''))))throw new Error('Invalid reference generation plan');
const runtimePath='/'+argument('runtime','src/tts/omnivoice/runtime.js').replaceAll('\\','/');
const modelRoot = resolve('.cache/engine-models', manifest.modelId);
const referencePool=argument('references','')?JSON.parse(await readFile(argument('references',''),'utf8')).speakers:[];
async function replaceFile(source,target){
  for(let attempt=0;attempt<20;attempt++){
    try{await rename(source,target);return;}
    catch(error){
      if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt===19)throw error;
      await new Promise(done=>setTimeout(done,100));
    }
  }
}
const lock = await acquireMeasurementLock({ owner:{ purpose:'Build fixed OmniVoice reference speakers' }, onWait:holder=>console.log(`Waiting for measurement process ${holder?.pid}.`) });
let browser;
const server = createServer(async (request,response)=>{
  try {
    const pathname = decodeURIComponent(new URL(request.url,'http://127.0.0.1').pathname);
    const headers = {'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'};
    if(pathname==='/'){response.writeHead(200,{...headers,'Content-Type':'text/html'});response.end('<!doctype html><title>Fixed OmniVoice speakers</title>');return;}
    const model = manifest.files.find(file=>pathname===`/models/${file.path}`);
    if(model){response.writeHead(200,{...headers,'Content-Type':'application/octet-stream'});createReadStream(resolve(modelRoot,model.path)).pipe(response);return;}
    const filename = resolve(root,`.${pathname}`), type={'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm'}[extname(filename)];
    if(!filename.startsWith(root+sep)||!type){response.writeHead(404);response.end();return;}
    response.writeHead(200,{...headers,'Content-Type':type});response.end(await readFile(filename));
  }catch{response.writeHead(404);response.end();}
});
try {
  await mkdir(output,{recursive:true});
  for(const file of manifest.files){const bytes=await readFile(resolve(modelRoot,file.path));if(bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error(`Model hash differs: ${file.path}`);}
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  browser=await chromium.launch({channel:'chromium',headless:true,args:browserAdapterConfiguration().args});
  const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const speakers=argument('append','0')==='1'?JSON.parse(await readFile(resolve(output,'speakers.json'),'utf8')).speakers:[];
  await writeFile(resolve(output,'generation.tmp'),JSON.stringify({status:'running',languages:languageCodes,jobs}));
  await replaceFile(resolve(output,'generation.tmp'),resolve(output,'generation.json'));
  await page.exposeFunction('saveSpeaker',async value=>{
    const {pcm,...speaker}=value;
    const samples=Float32Array.from(pcm);
    await writeFile(resolve(output,`${speaker.id}.wav`),waveBytes(samples));
    await writeFile(resolve(output,`${speaker.id}.f32`),new Uint8Array(samples.buffer));
    speakers.push(speaker);
    await writeFile(resolve(output,'speakers.tmp'),JSON.stringify({version:multilingual?3:1,text:multilingual?null:text,modelRevision:manifest.revision,speakers},null,2)+'\n');
    await replaceFile(resolve(output,'speakers.tmp'),resolve(output,'speakers.json'));
    console.log(JSON.stringify({speaker:speaker.id,seconds:pcm.length/24000,elapsedMs:speaker.elapsedMs}));
  });
  const adapter=await page.evaluate(async ({text,jobs,referenceTexts,whisperTexts,multilingual,existing,referencePool,runtimePath})=>{
    const [{createOmniVoiceRuntime},{BytePairTokenizer},api,{createOmniVoiceRequest}]=await Promise.all([
      runtimePath,'/src/engines/bytepair-tokenizer.js','/src/engines/browser-inference.js','/src/lib/omnivoice-settings.js',
    ].map(file=>import(new URL(file,location.href).href)));
    const tokenizer=new BytePairTokenizer(await(await fetch('/models/tokenizer.json')).json(),await(await fetch('/models/tokenizer_config.json')).json());
    let denoise=true, separator=' ';
    const encode=tokenizer.encode.bind(tokenizer);
    tokenizer.encode=(value,options)=>{
      if(selectedReference&&separator!==' ')value=value.replace(`<|text_start|>${selectedReference.text} `,`<|text_start|>${selectedReference.text}${separator}`);
      return encode(denoise?value:value.replace('<|denoise|>',''),options);
    };
    let codes, selectedReference = null;
    const {getOmniVoiceSpeakerReference} = await import('/src/tts/omnivoice/speakers.js');
    const wrapped={Tensor:api.Tensor,InferenceSession:{async create(source,options){const session=await api.InferenceSession.create(source,options);return{async run(feeds,outputs){if(feeds.audio_codes)codes=Array.from(feeds.audio_codes.data,Number);return session.run(feeds,outputs);},release:()=>session.release()};}}};
    const runtime=createOmniVoiceRuntime({ort:wrapped,decoderRuntime:wrapped,tokenizer,fetch:fetch.bind(globalThis),getSpeaker:()=>selectedReference});
    try{
      await runtime.init(`${location.origin}/models`);
      for(const job of jobs){
        denoise=job.denoise!==false;
        separator=job.separator??' ';
        const {lang,gender,seed,variation,whisper=false,referenceId=null,numStep=24}=job;
        const id=job.id||`${multilingual?lang+'-':''}${gender}-seed-${seed}${whisper?'-whisper':''}`;
        if(existing.includes(id))continue;
        const started=performance.now();
        let spokenText=job.text||(multilingual?((whisper&&whisperTexts[lang])||referenceTexts[lang]):text);
        if(!job.text&&gender==='female'){
          if(lang==='he')spokenText=spokenText.replace('אני מדבר','אני מדברת');
          if(lang==='hi')spokenText=spokenText.replace('बोलता','बोलती');
        }
        const request=createOmniVoiceRequest(spokenText,{detectCode:lang,omniVoice:{gender,variation:variation||1,whisper}});
        // Calibration WAVs must be the direct decoding of their captured reference codes.
        delete request.whisper;
        if(!referenceId&&!job.referenceKey)request.instruct=/[\u4e00-\u9fff]/u.test(spokenText)
          ?`${gender==='female'?'女':'男'}${whisper?'，耳语':''}`:`${gender}${whisper?', whisper':''}`;
        const pooled=referencePool.find(reference=>reference.id===job.referenceKey);
        if(job.referenceKey&&!pooled)throw new Error('Unknown pooled reference');
        selectedReference=pooled?{...pooled,codes:BigInt64Array.from(pooled.codes,BigInt),referenceId:pooled.id}:referenceId?getOmniVoiceSpeakerReference({...request,speakerId:referenceId}):null;
        if(job.instruct)request.instruct=job.instruct;
        const result=await runtime.synthesize({...request,seed,numStep,speed:job.speed||1,...(job.guidanceScale!=null?{guidanceScale:job.guidanceScale}:{})});
        const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',BigInt64Array.from(codes,BigInt))),value=>value.toString(16).padStart(2,'0')).join('');
        referencePool.push({id,lang,gender,seed,text:spokenText,frames:codes.length/8,codes,hash});
        await globalThis.saveSpeaker({id,lang,gender,variation,seed,whisper,referenceId,text:spokenText,instruct:request.instruct,numStep,frames:codes.length/8,codes,hash,speaker:result.speaker,pcm:Array.from(result.pcm),elapsedMs:Math.round(performance.now()-started)});
      }
    }finally{await runtime.dispose();}
    const a=await navigator.gpu.requestAdapter();return {vendor:a.info.vendor,architecture:a.info.architecture};
  },{text,jobs,referenceTexts,whisperTexts,multilingual,existing:speakers.map(speaker=>speaker.id),referencePool:[...referencePool,...speakers],runtimePath});
  await writeFile(resolve(output,'provenance.json'),JSON.stringify({adapter,browser:browser.version(),model:manifest,speakers:speakers.length},null,2)+'\n');
  await writeFile(resolve(output,'generation.tmp'),JSON.stringify({status:'complete',speakers:speakers.length,languages:languageCodes,jobs}));
  await replaceFile(resolve(output,'generation.tmp'),resolve(output,'generation.json'));
  if(!jobs.every(({id,lang,gender,seed,whisper})=>speakers.some(speaker=>speaker.id===(id||`${multilingual?lang+'-':''}${gender}-seed-${seed}${whisper?'-whisper':''}`))))throw new Error('Incomplete speaker candidate pool');
}finally{await browser?.close();await new Promise(done=>server.close(done));lock.release();}
