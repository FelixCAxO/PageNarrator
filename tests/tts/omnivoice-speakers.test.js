import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import data from '../../src/tts/omnivoice/speaker-data.js';
import { getOmniVoiceSpeakerReference } from '../../src/tts/omnivoice/speakers.js';
import { createOmniVoiceRequest, isOmniVoiceWhisperAvailable } from '../../src/lib/omnivoice-settings.js';
import { getOmniVoiceLanguage, getOmniVoiceLanguageOptions } from '../../src/tts/omnivoice/languages.js';
import { OMNIVOICE_DATA } from '../../src/tts/omnivoice/model-data.js';

it.each(['female','male'])('uses the fixed %s reference with its measured conditioning', gender=>{
  const english=createOmniVoiceRequest('A new sentence.',{detectCode:'en',omniVoice:{gender,variation:1}});
  const chinese=createOmniVoiceRequest('你好。',{detectCode:'zh',omniVoice:{gender,variation:1}});
  expect(english.instruct).toBe(data.speakers.find(entry=>entry.id===`en-${gender}-1`).playbackGenderCue === false ? '' : gender);
  expect(chinese.instruct).toBe(data.speakers.find(entry=>entry.id===`zh-${gender}-1`).playbackGenderCue === false ? '' : gender==='female'?'女':'男');
  expect(getOmniVoiceSpeakerReference(english).gender).toBe(gender);
  expect(getOmniVoiceSpeakerReference(chinese).gender).toBe(gender);
});

it('ships twenty distinct reference bindings for each of the 32 selectable languages', () => {
  expect(data.speakers).toHaveLength(640);
  expect([...new Set(data.speakers.map(speaker=>speaker.lang))].sort()).toEqual(getOmniVoiceLanguageOptions().map(language=>language.code).sort());
  expect(data.modelRevision).toBe(OMNIVOICE_DATA.revision);
  for (const language of getOmniVoiceLanguageOptions()) {
    const entries = data.speakers.filter(speaker=>speaker.lang===language.code);
    expect(new Set(entries.map(speaker=>speaker.hash)).size).toBe(20);
    const readers = entries.filter(speaker=>speaker.source?.readerId).map(speaker=>`${speaker.source.dataset}:${speaker.source.readerId}`);
    expect(new Set(readers).size).toBe(readers.length);
  }
  for(const language of getOmniVoiceLanguageOptions())for(const gender of ['female','male']){
    expect(data.speakers.filter(speaker=>speaker.lang===language.code&&speaker.gender===gender).map(speaker=>speaker.variation).sort((a,b)=>a-b)).toEqual([1,2,3,4,5,6,7,8,9,10]);
  }
  const audioByHash = new Map();
  for (const entry of data.speakers) {
    expect(entry.frames).toBeGreaterThan(0);
    expect(entry.frames).toBeLessThan(512);
    expect(entry.codes).toHaveLength(entry.frames * 8);
    expect(entry.codes.every(code=>Number.isInteger(code)&&code>=0&&code<1024)).toBe(true);
    expect(entry.text.normalize('NFC')).toBe(entry.text);
    const referenceLanguage = entry.referenceLanguage || entry.lang;
    expect(getOmniVoiceLanguage(referenceLanguage)?.code).toBe(referenceLanguage);
    if (entry.durationSource) {
      expect(entry.source.kind).toBe(entry.durationSource);
      expect(referenceLanguage).toBe(entry.durationSource === 'recording' ? entry.source.language : entry.source.generation.lang);
    }
    const audio = { text: entry.text, frames: entry.frames, codes: entry.codes, referenceLanguage };
    if (audioByHash.has(entry.hash)) expect(audio).toEqual(audioByHash.get(entry.hash));
    else audioByHash.set(entry.hash, audio);
    const reference=getOmniVoiceSpeakerReference({speakerId:entry.id.slice(entry.lang.length + 1),lang:entry.lang,instruct:'',seed:entry.seed});
    expect(createOmniVoiceRequest('A new sentence.', { detectCode: entry.lang, omniVoice: { gender: entry.gender, variation: entry.variation } }).seed)
      .toBe(entry.playbackSeed ?? 41 + entry.variation);
    expect(createOmniVoiceRequest('A new sentence.', { detectCode: entry.lang, omniVoice: { gender: entry.gender, variation: entry.variation } }).numStep)
      .toBe(entry.playbackNumStep ?? (entry.lang === 'tr' ? 32 : 24));
    expect(createOmniVoiceRequest('A new sentence.', { detectCode: entry.lang, omniVoice: { gender: entry.gender, variation: entry.variation } }).guidanceScale ?? 2)
      .toBe(entry.playbackGuidanceScale ?? 2);
    expect(createOmniVoiceRequest('A new sentence.', { detectCode: entry.lang, omniVoice: { gender: entry.gender, variation: entry.variation } }).instruct)
      .toBe(entry.playbackGenderCue === false ? '' : entry.gender);
    expect(createOmniVoiceRequest('中文。', { detectCode: entry.lang, omniVoice: { gender: entry.gender, variation: entry.variation } }).instruct)
      .toBe(entry.playbackGenderCue === false ? '' : entry.gender === 'female' ? '女' : '男');
    expect(reference).toMatchObject({ referenceId: entry.id, lang: entry.lang, text: entry.text });
    expect(createHash('sha256').update(new Uint8Array(reference.codes.buffer)).digest('hex')).toBe(entry.hash);
  }
});

it.each(['female','male'])('keeps every %s variation stable within each language across texts, whisper and recovery seeds', gender => {
  for (let variation=1;variation<=10;variation++) {
    const languageReferences=new Set();
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
        expect(reference.referenceId).toBe(`${language.code}-${gender}-${variation}`);
        languageReferences.add(reference.referenceId);
        expect(getOmniVoiceSpeakerReference({...request,seed:request.seed+1}).hash).toBe(reference.hash);
        reference.codes[0]=1024n;
        expect(getOmniVoiceSpeakerReference(request).codes[0]).not.toBe(1024n);
      }
      }
      expect(hashes.size).toBe(1);
    }
    expect(languageReferences.size).toBe(32);
  }
});

it('retains a fixed English fallback for a previously selected rare catalog language', () => {
  const request={speakerId:'female-1',lang:'sol',instruct:'female',seed:42};
  const rare=getOmniVoiceSpeakerReference(request);
  expect(rare.referenceId).toBe('en-female-1');
  expect(rare.hash).toBe(getOmniVoiceSpeakerReference({...request,lang:'en'}).hash);
  expect(createOmniVoiceRequest('A saved document.', { detectCode: 'sol', omniVoice: { gender: 'female', variation: 1 } }).seed)
    .toBe(createOmniVoiceRequest('A saved document.', { detectCode: 'en', omniVoice: { gender: 'female', variation: 1 } }).seed);
});

it('uses each Swedish catalog binding and declares the actual reference-audio language', () => {
  for (const gender of ['female', 'male']) for (let variation = 1; variation <= 10; variation++) {
    const request = createOmniVoiceRequest('Hej! Nu läser vi på svenska.', { detectCode: 'sv', omniVoice: { gender, variation } });
    const swedish = getOmniVoiceSpeakerReference(request);
    const entry = data.speakers.find(entry=>entry.id===`sv-${gender}-${variation}`);
    expect(request.lang).toBe('sv');
    expect(swedish).toMatchObject({ id: `${gender}-${variation}`, referenceId: `sv-${gender}-${variation}`, lang: 'sv' });
    expect(swedish).toMatchObject({ text: entry.text, hash: entry.hash });
    expect(getOmniVoiceLanguage(swedish.referenceLanguage || swedish.lang)?.code).toBe(entry.referenceLanguage || 'sv');
  }
});

it.each(['constructor','__proto__','female-0','male-11'])('rejects an unknown preset %s', speakerId => {
  expect(()=>getOmniVoiceSpeakerReference({speakerId,instruct:'female',seed:42})).toThrow('preset');
});
