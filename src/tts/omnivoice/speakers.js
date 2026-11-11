import data from './speaker-data.js';
import { getOmniVoiceVoiceId } from './voice-id.js';
import { getPersonalVoiceSpeaker } from './personal-reference.js';

const speakers = new Map(data.speakers.map(speaker => [speaker.id, speaker]));
const voices = new Map(data.speakers.map(speaker => [getOmniVoiceVoiceId(speaker), speaker]));

/** @param {{speakerId?:string,instruct:string,seed:number,lang?:string,personalReference?:unknown}} request */
export function getOmniVoiceSpeakerReference({ speakerId, instruct, seed, lang = 'en', personalReference }) {
  if (personalReference !== undefined) return getPersonalVoiceSpeaker(personalReference, speakerId);
  // Playback sends a stable voice ID; development probes may still send a catalog slot or infer one.
  const id = speakerId ?? `${/^(?:male|男)(?:[,，]|$)/u.test(instruct) ? 'male' : 'female'}-${seed - 41}`;
  const speaker = voices.get(id) || speakers.get(`${lang}-${id}`) || speakers.get(`en-${id}`);
  if (!speaker) throw new Error('Invalid OmniVoice speaker preset.');
  return { ...speaker, id, referenceId: speaker.id, codes: BigInt64Array.from(speaker.codes, BigInt) };
}
