import { LOWER_SPEC_TTS_PROBE_PROFILE_SET } from './live-tts-hardware-profiles.js';

export const DEFAULT_TTS_PROBE_DOCUMENT_TYPES = Object.freeze(['article', 'pdf']);
// Opt-in workloads (tests/live/tts-probe-workloads.js); defaults stay unchanged.
export const EXTENDED_TTS_PROBE_DOCUMENT_TYPES = Object.freeze(['long-article', 'complex-html', 'two-column-pdf', 'scanned-pdf', 'soak-article']);
// Whole-document content gates need the whole document queued: pages stream
// their chunks while reading, so these reads run until the reader goes idle.
// The soak article keeps its own duration-bounded read.
export const READ_TO_END_TTS_PROBE_DOCUMENT_TYPES = Object.freeze(EXTENDED_TTS_PROBE_DOCUMENT_TYPES.filter((type) => type !== 'soak-article'));
const KNOWN_DOCUMENT_TYPES = new Set([...DEFAULT_TTS_PROBE_DOCUMENT_TYPES, ...EXTENDED_TTS_PROBE_DOCUMENT_TYPES]);

export function getTtsProbeDocumentTypes(selection = '', { profileSelection = '' } = {}) {
  const raw = String(selection || '').trim();
  const selected = raw
    ? raw.split(/[,\s]+/).filter(Boolean)
    : getDefaultDocumentTypes(profileSelection);
  const types = [...new Set(selected.map((type) => type.toLowerCase()))];

  for (const type of types) {
    if (!KNOWN_DOCUMENT_TYPES.has(type)) {
      throw new Error(`Unknown TTS probe document: ${type}`);
    }
  }
  return types;
}

function getDefaultDocumentTypes(profileSelection) {
  return profileSelection === LOWER_SPEC_TTS_PROBE_PROFILE_SET
    ? ['article']
    : [...DEFAULT_TTS_PROBE_DOCUMENT_TYPES];
}
