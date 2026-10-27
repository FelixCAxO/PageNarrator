import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import corpus from '../tests/fixtures/omnivoice-language-quality.json' with {type:'json'};
import { getOmniVoiceLanguageOptions } from '../src/tts/omnivoice/languages.js';

const languages=getOmniVoiceLanguageOptions();
const includeWhisper=process.argv.includes('--include-whisper');
assert.deepEqual(Object.keys(corpus.languages).sort(),languages.map(({code})=>code).sort());
let cases=languages.flatMap(language=>['female','male'].flatMap(gender=>Array.from({length:10},(_,i)=>(includeWhisper?[false,true]:[false]).map(whisper=>({
  id:`${language.code}-${gender}-${i+1}${whisper?'-whisper':''}`,code:language.code,name:language.label,text:corpus.languages[language.code],
  nativeText:true,source:'Authored development screening sentences; native listening review pending',
  omniVoice:{gender,variation:i+1,whisper},
}))).flat()));
assert.equal(cases.length,includeWhisper?1280:640);
if(process.argv.includes('--include-replays')){
  const swedish=cases.filter(item=>item.code==='sv');
  cases=[...swedish,...swedish.map(item=>({
    ...item,id:`${item.id}-replay`,replayOf:item.id,warmupText:'Här börjar ett annat dokument. Nu fortsätter vi att läsa.',
  })),...cases.filter(item=>item.code!=='sv')];
}
const output=process.argv.find(arg=>arg.startsWith('--output='))?.slice(9)||'artifacts/omnivoice-fixed-voices/quality-native-v1';
await mkdir(output,{recursive:true});
await writeFile(`${output}/corpus.json`,JSON.stringify({scope:corpus.scope,languages:cases},null,2)+'\n');
console.log(JSON.stringify({output,languages:languages.length,cases:cases.length,replays:cases.filter(item=>item.replayOf).length}));
