# OmniVoice speaker references

The bundled catalog has 640 presets across 32 languages. Each language has ten female and ten male references. The selected reference stays fixed across documents, reading positions, restarts, and retries. Synthesis reports its hash. See [source attribution](third-party-voice-licenses.md).

The catalog stores optional overrides for the playback seed, gender cue, step count, guidance, pronunciation, and generation speed. Prebuild verifies the playback index against the catalog. Keep the reference-creation seed and playback seed separate. Long sections can split across multiple requests with the same preset.

Whisper uses seeded breath excitation from the selected speaker's backing speech. Cantonese retains a quiet voiced component for tone cues. Cantonese and Thai display a word-loss warning.

## Screening

1. Build the extension and download the pinned speech models. Prepare cases with `node tooling/scripts/prepare-omnivoice-variations.mjs --include-whisper --include-replays --output=artifacts/omnivoice-screening`.
2. Set `PN_E2E_LANGUAGE_AUDIT=1`, `PN_E2E_LANGUAGE_AUDIT_DIR=artifacts/omnivoice-screening`, and `PN_E2E_EXTENSION_DIR` to the build. Run `npm run test:e2e:local -- tests/e2e/omnivoice-language-audit.e2e.js --project=extension --workers=1`.
3. Use `tooling/scripts/analyze-omnivoice-variations.py` for offline recognition and acoustic checks. Run capture and analysis serially. Bind results to the exact WAV, worker, reference, and request.
4. Run `node tooling/scripts/report-omnivoice-variations.mjs --directory=artifacts/omnivoice-screening --require-pass`. Keep missing clips, failures, and recognition disagreements in the report.

Normal speech requires passing signal and acoustic checks. Whisper also needs accurate recognized content and verified backing speech. Keep restart replays and independent [listening evidence](voice-listening-qa.md) separate from model scores.
