// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Saved settings point at these IDs, so they come from where a voice came from, never from its catalog slot.
// The same source always gets the same ID; a new source gets a new one; an ID is never reused for another voice.

/** @param {unknown} value */
const slug = value => String(value).toLowerCase().replace(/^google\//u, '').replace(/\.[a-z0-9]+$/u, '').replace(/[^a-z0-9]+/gu, '');

/** @param {{lang:string,gender:string,hash:string,source?:any}} speaker */
export function getOmniVoiceVoiceId({ lang, gender, hash, source }) {
  // Generated voices use the code hash even when processing provenance is present.
  if (!source || source.kind === 'generated') return `${lang}-${gender}-gen-${hash.slice(0, 12)}`;
  // A dataset reader ID names the person; without one (FLEURS) the recording file is the identity.
  const person = `${lang}-${slug(source.dataset)}-${slug(source.readerId ?? source.originalFile)}`;
  // Refreshing that person's reference keeps their registered voice and saved settings.
  if (source.kind === 'recording-derived' && source.parentStableVoiceId === person) return person;
  return source.kind === 'recording-derived' ? `${person}-d${source.generation.seed}` : person;
}
