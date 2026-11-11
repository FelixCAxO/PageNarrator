# OmniVoice voice cards

The catalog has 831 voices in 32 languages. Each voice uses a fixed reference, so it stays consistent across documents, restarts, and retries.

## Saved voices

Voice IDs are independent of catalog order. Refreshing a card keeps its registered ID and playback settings. A retired voice falls back to another voice in the same language and type.

`tooling/config/omnivoice-voice-registry.json` keeps every registered ID. Never remove or reuse an ID. Reference creation and playback have separate seeds. After changing `speaker-data.js`, run `node tooling/scripts/write-omnivoice-preset-seeds.mjs`; prebuild checks the result.

## Cards and scores

The cards are generated with OmniVoice and retain its codec tokens directly. Attribution stays in the card metadata and [packaged notices](../extension/public/legal/THIRD_PARTY_NOTICES.txt).

`tooling/config/omnivoice-voice-scores.json` records similarity and estimated quality for every card, bound to its token hash. The original and new clips use different text. These scores help review voices; they do not replace listening.

## Screening

1. Build the extension and download the pinned speech models. Prepare cases with `node tooling/scripts/prepare-omnivoice-variations.mjs --include-whisper --include-replays --output=artifacts/omnivoice-screening`.
2. Set `PN_E2E_LANGUAGE_AUDIT=1`, `PN_E2E_LANGUAGE_AUDIT_DIR=artifacts/omnivoice-screening`, and `PN_E2E_EXTENSION_DIR` to the build. Run `npm run test:e2e:local -- tests/e2e/omnivoice-language-audit.e2e.js --project=extension --workers=1`.
3. Use `tooling/scripts/analyze-omnivoice-variations.py` for offline recognition and acoustic checks. Run capture and analysis serially. Bind results to the exact WAV, worker, reference, and request.
4. Run `node tooling/scripts/report-omnivoice-variations.mjs --directory=artifacts/omnivoice-screening --require-pass`. Keep missing clips, failures, and recognition disagreements in the report.

The report checks every current stable voice ID against the catalog and its card score. Counts vary by language and voice type. It verifies captured requests, reference hashes, analysis receipts and Swedish restart replays. Unavailable whisper modes are marked separately; they are not whisper-quality passes.

Normal speech requires passing signal and acoustic checks. Whisper also needs accurate recognized content and verified backing speech. Keep restart replays and independent [listening evidence](voice-listening-qa.md) separate from model scores.
