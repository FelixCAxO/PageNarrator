# Fixed OmniVoice variations

The selectable catalog contains 32 languages and ten distinct references per gender and language. A variation selects a bundled language-specific codec reference; document text, reading position and previous documents never select the speaker. The reference hash is returned with each synthesis. A sampling retry keeps that reference.

Clone requests retain the gender cue and use 24 refinement steps (32 for Turkish). Target duration uses the weighted text rule with one final rounding; generated reference lengths must not introduce a second rounding. The decoder runs at 25 frames per second. Turkish title-case `Bugün` is normalized for speech to avoid the erroneous space-prefixed tokenizer entry; displayed text and highlights remain unchanged.

Whisper mode applies deterministic, seeded breath excitation to the selected normal speaker's spectral envelope after decoding. It preserves the sample count and returns the hash of the exact backing float32 speech. Cantonese retains a quiet voiced component for tone cues. This is an experimental whisper effect; automatic recognition, style scores and reference matching do not establish naturalness or native pronunciation.

Whisper remains selectable for Cantonese and Thai at the user's request despite repeated word-loss failures. Both interfaces warn that words can be omitted and ask the reader to check against the text. Saved settings preserve whisper and requests use the same fixed speaker reference. The failed experimental recordings remain evidence; enabling this mode does not qualify its word accuracy or naturalness.

## Development screening

Prepare all 1,280 normal/whisper samples and 40 Swedish restart/different-document replays:

```powershell
node scripts/prepare-omnivoice-variations.mjs --include-whisper --include-replays --output=artifacts/omnivoice-fixed-voices/quality-native-v2
$env:PN_E2E_LANGUAGE_AUDIT='1'
$env:PN_E2E_LANGUAGE_AUDIT_REUSE_BACKING='1'
$env:PN_E2E_LANGUAGE_AUDIT_DIR='artifacts/omnivoice-fixed-voices/quality-native-v2'
$env:PN_E2E_EXTENSION_DIR='artifacts/omnivoice-fixed-voices/extension-native-v2'
npx playwright test tests/e2e/omnivoice-language-audit.e2e.js --project=extension --workers=1
```

Every normal preset is synthesized by the packaged worker. With backing reuse, the remaining whisper samples use its exact saved float32 PCM and the production renderer, while female/male variation one in every language and all Swedish whispers exercise the packaged worker. Renderer comparisons retain byte equality and require maximum absolute float32 error ≤ 1e-6: Node and Chromium may round transcendental functions differently. Same-browser restart replays still require exact float32 equality. Capture provenance, renderer hash, source PCM and all failed attempts remain in the records. The hardware measurement lock serializes model capture and GPU recognition.

`analyze-omnivoice-variations.py` checks hash bindings, physical signal, DNSMOS, WavLM diagnostics, CLAP style and offline recognition. Keep the normal acoustic thresholds (speech 2.5, background 2, overall 2.5). DNSMOS is diagnostic for whispers; do not describe its low whisper scores as passing the normal acoustic gate. Whisper acceptance additionally requires accurate recognized content, positive whisper-style margin, and exact backing speech that passes the normal gate.

Disagreements and every Cantonese clip receive audio-and-language-only OmniASR 7B review. `score-omnivoice-phonetics.py` retains character CER and adds toned Jyutping syllable error for Cantonese homophones; unknown symbols and tone mismatches still count. `finalize-omnivoice-screening.py` binds those results to the recorded WAV hashes. `report-omnivoice-variations.mjs --directory=... --require-pass` rejects missing evidence, changed references, outstanding flags, failed renderer comparisons and unequal restart replays. Reports and listening galleries disclose native listening as unverified.

When the first recognizer passes but the larger recognizer disagrees, `--confirmation` may add audio-only OmniASR CTC evidence. Both the first recognizer and the confirming recognizer must have character error ≤ 0.1; the evaluated error is their maximum, with the primary disagreement preserved. A single favorable third opinion cannot override two failing recognizers. Wave and expected-text hashes must match. No human approval is inferred.

These repeated short sentences are development regressions. They cannot qualify arbitrary documents, all pronunciation, other devices or human naturalness. Retain earlier failures and rejected experiments.
