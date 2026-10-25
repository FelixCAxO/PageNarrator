# Voice listening checks

For v1.0.0, physical hardware and human/listening reviews were waived on 2026-10-24. Record them as waived, never passed. Kokoro duration/PCM reference comparisons remain failed/unqualified; that limitation was accepted on 2026-10-25. All other applicable automatic checks remain required. Version-specific decisions never carry automatically to later versions. See the [release policy](../config/release-policy.json). The maintainer explicitly extended those same disclosed exceptions to v1.0.1 on 2026-10-25. They do not apply to v1.0.2; unperformed reviews remain unverified and numerical failures remain failed/unqualified.

Use this procedure for changes to Kokoro runtime files, voice styles, or voice selection. It remains strict for unwaived releases.

## Record each run

- Test webpage, selected-text, and PDF reading, all ten English voices, and both available backends.
- Check that voice changes are audible and punctuation/citation cleanup preserves highlight alignment.
- Save the version, source/model/style hashes, voice ID, browser, actual backend, hardware, exact prepared input, synthesis speed, playback rate, and result under `artifacts/voice-listening/`.
- Assess experimental OmniVoice separately by language.

Approved samples cover recorded English/Swedish OmniVoice clips, long Heart/Emma CPU/GPU clips, and three UK “Wednesday” Emma clips on CPU, Intel, and NVIDIA. They do not qualify every voice or language or pass the blind study below. The consumed v5 final corpus retains its transcript failures and two functional GPU failures. Later repairs are development regressions.

## Shared quality gate

`tests/voice/fixtures/quality-corpus.json` freezes eight validation categories and eight separate final texts: selections, paragraphs, numbers, abbreviations, technical language, punctuation, and article/PDF transitions. The four benchmark texts are development material. Never tune on the final partition. An unwaived gate requires all voices and available backends; missing hardware blocks it. Test actual extension handoffs as well as transition text.

For a change claimed to preserve output, keep prepared text, chunks, token order, offsets, model/style hashes, precision, backend, and synthesis parameters identical. Record source/runtime hashes on both sides. Compare every float32 PCM byte and sample rate before WAV encoding with `comparePcm` in `scripts/lib/kokoro-speech-acceptance.mjs`. Invalid, empty, silent, non-finite, or changed PCM fails. A match covers only those configurations. Keep completeness, offline/recovery, and the 120 ms word-sync limit as separate gates.

## Blind listening

Numeric, graph, precision, runtime, or weight changes still need automated held-out evaluation. When human review is required, freeze these rules before ratings:

- Zero missing/repeated words and invalid audio on the final set. Check numbers and abbreviations against intended speech.
- Hide and randomize A/B identity. Use at least 20 independent listeners. Rate intelligibility, identity, pronunciation, and prosody from 1–5 for every voice and category.
- For each dimension and voice, the lower bound of a listener-clustered 95% confidence interval for candidate minus reference must exceed −0.25 points. A pooled score cannot hide a failing voice.
- A crossing interval, too few listeners, missing voice/backend, or unresolved pronunciation error is inconclusive. Smoke tests and empty ratings cannot qualify a candidate.

No formal listener study has passed. Keep validation selection separate from final ratings and retain rejected runs. A resource improvement must improve its stated metric without a measured regression in memory, CPU cost, startup, or playback gaps. Synthesis RTF × playback rate must stay below 1, with variability reported. Energy and first-audible latency need separate measurements.
