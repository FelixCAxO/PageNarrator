import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import data from '../../src/tts/omnivoice/speaker-data.js';
import { getOmniVoiceSpeakerReference } from '../../src/tts/omnivoice/speakers.js';
import { createOmniVoiceRequest, isOmniVoiceWhisperAvailable } from '../../src/lib/omnivoice-settings.js';
import { getOmniVoiceLanguage, getOmniVoiceLanguageOptions } from '../../src/tts/omnivoice/languages.js';
import { OMNIVOICE_DATA } from '../../src/tts/omnivoice/model-data.js';
import { getOmniVoiceVoiceId } from '../../src/tts/omnivoice/voice-id.js';
import { getOmniVoiceVoices, getOmniVoiceLegacyVoice, getOmniVoicePreset } from '../../src/tts/omnivoice/preset-seeds.js';
import registry from '../../tooling/config/omnivoice-voice-registry.json';

it('keeps saved voice IDs when a reference is refreshed', () => {
  const original = { lang: 'sv', gender: 'female', hash: 'old', source: { kind: 'recording', dataset: 'example/voices', readerId: 'reader-7' } };
  const id = getOmniVoiceVoiceId(original);
  const refreshed = { ...original, hash: 'new', source: { ...original.source, kind: 'recording-derived', parentStableVoiceId: id, generation: { seed: 48 } } };
  expect(getOmniVoiceVoiceId(refreshed)).toBe(id);
  expect(getOmniVoiceVoiceId({ ...refreshed, source: { ...refreshed.source, parentStableVoiceId: 'another-voice' } })).toBe(`${id}-d48`);
});

it.each(['female','male'])('uses the fixed %s reference with its measured conditioning', gender=>{
  const english=createOmniVoiceRequest('A new sentence.',{detectCode:'en',omniVoice:{gender,variation:1}});
  const chinese=createOmniVoiceRequest('你好。',{detectCode:'zh',omniVoice:{gender,variation:1}});
  expect(english.instruct).toBe(getOmniVoicePreset(english.speakerId).genderCue ? gender : '');
  expect(chinese.instruct).toBe(getOmniVoicePreset(chinese.speakerId).genderCue ? gender==='female'?'女':'男' : '');
  expect(getOmniVoiceSpeakerReference(english).gender).toBe(gender);
  expect(getOmniVoiceSpeakerReference(chinese).gender).toBe(gender);
});

it('lists every catalog voice once under a registered stable ID, in every selectable language and gender', () => {
  expect([...new Set(data.speakers.map(speaker=>speaker.lang))].sort()).toEqual(getOmniVoiceLanguageOptions().map(language=>language.code).sort());
  expect(data.modelRevision).toBe(OMNIVOICE_DATA.revision);
  const ids = data.speakers.map(getOmniVoiceVoiceId);
  expect(new Set(ids).size).toBe(ids.length);
  for (const language of getOmniVoiceLanguageOptions()) {
    const entries = data.speakers.filter(speaker=>speaker.lang===language.code);
    expect(new Set(entries.map(speaker=>speaker.hash)).size).toBe(entries.length);
    const readers = entries.filter(speaker=>speaker.source?.readerId).map(speaker=>`${speaker.source.dataset}:${speaker.source.readerId}`);
    expect(new Set(readers).size).toBe(readers.length);
    for (const gender of ['female','male']) {
      const shipped = data.speakers.filter(speaker=>speaker.lang===language.code&&speaker.gender===gender).map(getOmniVoiceVoiceId);
      expect(shipped.length).toBeGreaterThan(0);
      expect([...getOmniVoiceVoices(language.code, gender)].sort()).toEqual([...shipped].sort());
    }
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
    const id=getOmniVoiceVoiceId(entry), frozen=registry.voices[id];
    const omniVoice={ gender: entry.gender, voices: { [entry.lang]: id } };
    const request=createOmniVoiceRequest('A new sentence.', { detectCode: entry.lang, omniVoice });
    expect(frozen).toMatchObject({ lang: entry.lang, gender: entry.gender });
    expect(request).toMatchObject({ speakerId: id, seed: frozen.seed, numStep: frozen.numStep, speed: frozen.speed, instruct: frozen.genderCue ? entry.gender : '' });
    expect(request.guidanceScale ?? 2).toBe(frozen.guidanceScale);
    expect(request.pronunciationVariant ?? null).toBe(frozen.pronunciationVariant);
    expect(createOmniVoiceRequest('中文。', { detectCode: entry.lang, omniVoice }).instruct).toBe(frozen.genderCue ? entry.gender === 'female' ? '女' : '男' : '');
    const reference=getOmniVoiceSpeakerReference(request);
    expect(reference).toMatchObject({ id, referenceId: entry.id, lang: entry.lang, text: entry.text });
    expect(createHash('sha256').update(new Uint8Array(reference.codes.buffer)).digest('hex')).toBe(entry.hash);
  }
});

it.each(['female','male'])('keeps every %s voice fixed within its language across texts, whisper and recovery seeds', gender => {
  for (const language of getOmniVoiceLanguageOptions()) for (const id of getOmniVoiceVoices(language.code, gender)) {
    const hashes=new Set();
    for (const whisper of [false,true]) {
      if(whisper&&!isOmniVoiceWhisperAvailable(language.code))continue;
      const voice={detectCode:language.code,omniVoice:{gender,voices:{[language.code]:id},whisper}};
      for (const text of ['Start of a new document.','A sentence from its middle.','中文。']) {
        const request=createOmniVoiceRequest(text,voice);
        const reference=getOmniVoiceSpeakerReference(request);
        hashes.add(reference.hash);
        expect(reference).toMatchObject({ id, lang: language.code });
        expect(getOmniVoiceSpeakerReference({...request,seed:request.seed+1}).hash).toBe(reference.hash);
        reference.codes[0]=1024n;
        expect(getOmniVoiceSpeakerReference(request).codes[0]).not.toBe(1024n);
      }
    }
    expect(hashes.size).toBe(1);
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
    const entry = data.speakers.find(entry=>getOmniVoiceVoiceId(entry)===request.speakerId);
    expect(request.lang).toBe('sv');
    expect(request.speakerId).toBe(getOmniVoiceLegacyVoice('sv', gender, variation) ?? getOmniVoiceVoices('sv', gender)[0]);
    expect(swedish).toMatchObject({ id: request.speakerId, referenceId: entry.id, lang: 'sv' });
    expect(swedish).toMatchObject({ text: entry.text, hash: entry.hash });
    expect(getOmniVoiceLanguage(swedish.referenceLanguage || swedish.lang)?.code).toBe(entry.referenceLanguage || 'sv');
  }
});

it.each(['constructor','__proto__','female-0','male-999'])('rejects an unknown preset %s', speakerId => {
  expect(()=>getOmniVoiceSpeakerReference({speakerId,instruct:'female',seed:42})).toThrow('preset');
});
