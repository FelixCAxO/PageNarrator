import data from './speaker-data.js';

const speakers = new Map(data.speakers.map(speaker => [speaker.id, speaker]));

/** @param {{speakerId?:string,instruct:string,seed:number,lang?:string}} request */
export function getOmniVoiceSpeakerReference({ speakerId, instruct, seed, lang = 'en' }) {
  // Legacy development probes infer the preset; playback always supplies its explicit ID.
  const id = speakerId ?? `${/^(?:male|男)(?:[,，]|$)/u.test(instruct) ? 'male' : 'female'}-${seed - 41}`;
  const speaker = speakers.get(`${lang}-${id}`) || speakers.get(`en-${id}`);
  if (!speaker) throw new Error('Invalid OmniVoice speaker preset.');
  return { ...speaker, id, referenceId: speaker.id, codes: BigInt64Array.from(speaker.codes, BigInt) };
}
