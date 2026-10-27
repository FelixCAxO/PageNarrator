import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import data from '../../src/tts/omnivoice/speaker-data.js';
import { getOmniVoiceSpeakerReference } from '../../src/tts/omnivoice/speakers.js';
import { createOmniVoiceRequest, isOmniVoiceWhisperAvailable } from '../../src/lib/omnivoice-settings.js';
import { getOmniVoiceLanguageOptions } from '../../src/tts/omnivoice/languages.js';
import { OMNIVOICE_DATA } from '../../src/tts/omnivoice/model-data.js';

it.each(['female','male'])('lets the fixed %s reference carry age and pitch without hidden overrides', gender=>{
  const english=createOmniVoiceRequest('A new sentence.',{detectCode:'en',omniVoice:{gender,variation:1}});
  const chinese=createOmniVoiceRequest('你好。',{detectCode:'zh',omniVoice:{gender,variation:1}});
  expect(english.instruct).toBe(gender);
  expect(chinese.instruct).toBe(gender==='female'?'女':'男');
  expect(getOmniVoiceSpeakerReference(english).gender).toBe(gender);
  expect(getOmniVoiceSpeakerReference(chinese).gender).toBe(gender);
});

it('ships twenty distinct native-language references for each of the 32 selectable languages', () => {
  expect(data.speakers).toHaveLength(640);
  expect(new Set(data.speakers.map(({hash})=>hash)).size).toBe(640);
  expect([...new Set(data.speakers.map(speaker=>speaker.lang))].sort()).toEqual(getOmniVoiceLanguageOptions().map(language=>language.code).sort());
  expect(data.modelRevision).toBe(OMNIVOICE_DATA.revision);
  for(const language of getOmniVoiceLanguageOptions())for(const gender of ['female','male']){
    expect(data.speakers.filter(speaker=>speaker.lang===language.code&&speaker.gender===gender).map(speaker=>speaker.variation).sort((a,b)=>a-b)).toEqual([1,2,3,4,5,6,7,8,9,10]);
  }
  for (const entry of data.speakers) {
    expect(entry.frames).toBeGreaterThan(0);
    expect(entry.frames).toBeLessThan(512);
    expect(entry.codes).toHaveLength(entry.frames * 8);
    expect(entry.codes.every(code=>Number.isInteger(code)&&code>=0&&code<1024)).toBe(true);
    expect(entry.text.normalize('NFC')).toBe(entry.text);
    const reference=getOmniVoiceSpeakerReference({speakerId:entry.id.slice(entry.lang.length + 1),lang:entry.lang,instruct:'',seed:entry.seed});
    expect(reference).toMatchObject({ referenceId: entry.id, lang: entry.lang, text: entry.text });
    expect(createHash('sha256').update(new Uint8Array(reference.codes.buffer)).digest('hex')).toBe(entry.hash);
  }
});

it.each(['female','male'])('keeps every %s variation stable within each language across texts, whisper and recovery seeds', gender => {
  for (let variation=1;variation<=10;variation++) {
    const languageHashes=new Set();
    for (const language of getOmniVoiceLanguageOptions()) {
      const hashes=new Set();
      for (const whisper of [false,true]) {
      if(whisper&&!isOmniVoiceWhisperAvailable(language.code))continue;
      const voice={detectCode:language.code,omniVoice:{gender,variation,whisper}};
      for (const text of ['Start of a new document.','A sentence from its middle.','中文。']) {
        const request=createOmniVoiceRequest(text,voice);
        const reference=getOmniVoiceSpeakerReference(request);
        hashes.add(reference.hash);
        expect(reference.lang).toBe(language.code);
        expect(getOmniVoiceSpeakerReference({...request,seed:request.seed+1}).hash).toBe(reference.hash);
        reference.codes[0]=1024n;
        expect(getOmniVoiceSpeakerReference(request).codes[0]).not.toBe(1024n);
      }
      }
      expect(hashes.size).toBe(1);
      languageHashes.add([...hashes][0]);
    }
    expect(languageHashes.size).toBe(32);
  }
});

it('retains a fixed English fallback for a previously selected rare catalog language', () => {
  const request={speakerId:'female-1',lang:'sol',instruct:'female',seed:42};
  const rare=getOmniVoiceSpeakerReference(request);
  expect(rare.referenceId).toBe('en-female-1');
  expect(rare.hash).toBe(getOmniVoiceSpeakerReference({...request,lang:'en'}).hash);
});

it('conditions every Swedish variation on Swedish speech and text rather than the English fallback', () => {
  for (const gender of ['female', 'male']) for (let variation = 1; variation <= 10; variation++) {
    const request = createOmniVoiceRequest('Hej! Nu läser vi på svenska.', { detectCode: 'sv', omniVoice: { gender, variation } });
    const swedish = getOmniVoiceSpeakerReference(request);
    const english = getOmniVoiceSpeakerReference({ ...request, lang: 'en' });
    expect(swedish).toMatchObject({ id: `${gender}-${variation}`, referenceId: `sv-${gender}-${variation}`, lang: 'sv' });
    expect(swedish.text).toContain('Jag talar tydligt och lugnt');
    expect(swedish.hash).not.toBe(english.hash);
  }
});

it.each(['constructor','__proto__','female-0','male-11'])('rejects an unknown preset %s', speakerId => {
  expect(()=>getOmniVoiceSpeakerReference({speakerId,instruct:'female',seed:42})).toThrow('preset');
});
