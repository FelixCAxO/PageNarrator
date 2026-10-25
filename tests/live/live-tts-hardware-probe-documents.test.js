import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TTS_PROBE_DOCUMENT_TYPES,
  getTtsProbeDocumentTypes,
} from './live-tts-hardware-probe-documents.js';
import { LOWER_SPEC_TTS_PROBE_PROFILE_SET } from './live-tts-hardware-profiles.js';

describe('live TTS hardware probe document selection', () => {
  it('probes both article and PDF by default for host hardware', () => {
    expect(DEFAULT_TTS_PROBE_DOCUMENT_TYPES).toEqual(['article', 'pdf']);
    expect(getTtsProbeDocumentTypes('', { profileSelection: '' })).toEqual(['article', 'pdf']);
  });

  it('keeps lower-spec CI on the article document unless explicitly expanded', () => {
    expect(getTtsProbeDocumentTypes('', { profileSelection: LOWER_SPEC_TTS_PROBE_PROFILE_SET }))
      .toEqual(['article']);
    expect(getTtsProbeDocumentTypes('article,pdf', { profileSelection: LOWER_SPEC_TTS_PROBE_PROFILE_SET }))
      .toEqual(['article', 'pdf']);
  });

  it('rejects unknown probe document names', () => {
    expect(() => getTtsProbeDocumentTypes('article,spreadsheet')).toThrow(/Unknown TTS probe document/);
  });
});
