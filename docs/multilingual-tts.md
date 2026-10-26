# Voices

PageNarrator 1.0.1 uses Kokoro by default. Choose the engine at the top of the toolbar popup, then open **Voice settings**.

| Engine | Voices | Processing and downloads |
| --- | --- | --- |
| Kokoro | Ten English voices | WebGPU with CPU / WebAssembly fallback. Missing files download on first use. |
| OmniVoice | 646 experimental language entries | WebGPU with fp16. Separate download of about 1.35 GB. |

Narrated text stays local. Cached files work offline for the same voice and mode. Changing either, clearing storage, or browser eviction can require another download. Selecting an engine alone does not download models. See [hardware](requirements-hardware.md) and [licenses](third-party-voice-licenses.md).

## OmniVoice (experimental)

- Select a language by typing its name in the dropdown.
- Choose female/male voice type, one of ten voice variations, and optional whisper. Variations are alternatives, not pitch levels.
- Use Playback speed to set the pace. Changes apply at the next section and survive restart. Switching back to Kokoro restores its saved voice.
- Pitch and age controls were removed because their effects were unreliable. Old pace/pitch/age settings are ignored. Reference-audio import is unavailable.

### Runtime

The adapter is `src/tts/omnivoice/tts.js`; the original browser bridge is `src/tts/omnivoice/runtime.js`. Model `MarkShark2/omnivoice-onnx-kv-b1-fp16` is pinned to `0111dd42766f32e6ebb91434ded76f0e697d834a`. Its seven model/tokenizer files use cache `pagenarrator-omnivoice-v1`. There is no CPU fallback or packaged ONNX Runtime executable. Word timings are estimates.

The first bounded section creates a speaker reference. Later sections reuse its text/audio tokens until release or a language/voice change. Variations use seeds 42–51. Creation uses 24 refinement steps; continuation uses 12. Slow GPUs and faster playback can outrun synthesis.

A signal check rejects non-finite output, silence, severe clipping, and obvious broadband static. On failure, the worker and reference are discarded, cached models reload, and generation retries once with the next seed. `voiceRecovery` records both seeds. A second failure stops reading. Successful recovery keeps the validated reference and seed; changing settings restores the selected seed. This check does not certify pronunciation or naturalness.

Han text uses Chinese instruction tags separated by full-width commas; other text uses English tags separated by comma and space. Whisper uses gender and whisper tags only: adding age/pitch tags previously produced unrelated Hindi speech.

Speech normalizes Mathematical Alphanumeric Symbols `U+1D400`–`U+1D7FF` to unstyled equivalents, then NFC. Prompts, frame estimates, and stored references use that form. Original text and offsets remain intact; superscripts and compatibility forms outside that range keep their spelling.

The language catalog is pinned to `08be0b4ccbac3e13e374e86fbfead4b4cac343e2`. Browser/ISO aliases map to OmniVoice IDs, including `arb` for Standard Arabic. Unknown IDs fail. Catalog availability does not qualify every language, voice, dialect, or device.

The GPL-3.0-or-later bridge uses k2-fsa/OmniVoice's licensed algorithm and pinned tensor interfaces; see [provenance](../vendor/omnivoice/PROVENANCE.md). It recomputes the bidirectional sequence each step and rejects sections over 2,048 combined text/audio positions. Release terminates its worker. Implementation replacement does not establish quality or hardware acceptance.

## Kokoro runtime

- Catalog: `src/tts/voices/voice-registry.js`.
- Language options and aliases: `src/tts/voices/language-voice-options.js`.
- Generation, streaming, warmup, and serialized inference: `src/lib/kokoro-multilingual.js`.
- Model: `onnx-community/Kokoro-82M-v1.0-ONNX` at `1939ad2a8e416c0acfeecc08a694d14ef25f2231`.

Missing model, tokenizer, and voice files download from Hugging Face and official `hf.co` redirects when preparing or reading. Only the chosen mode's model is needed initially; fallback may need another. Hosts receive file requests and normal connection information, not narration text. No installation download runs in the background. Executable JavaScript, WebAssembly, and OCR remain packaged.

## Catalog policy

Selectable Kokoro voices need Apache-2.0 model licensing and upstream grade C or higher. See [reviewed voices and exclusions](third-party-voice-licenses.md).

## Verification

Run hardware measurements serially. Real-model checks need pinned local files; developer analysis tools and their weights are not extension dependencies. Human/listening reviews are waived for v1.0.0, not passed. Changed audio needs fresh evaluation; old approvals do not transfer. See [verification status](release-readiness.md).

| Check | Command and scope |
| --- | --- |
| Packaged reading | `PN_E2E_OMNIVOICE=1 npx playwright test tests/e2e/omnivoice-read.e2e.js --project=extension --workers=1`: default Kokoro, ten language playback journeys, voice changes, and offline cache reuse. |
| Voice controls | `PN_E2E_OMNIVOICE=1 npx playwright test tests/e2e/omnivoice-settings.e2e.js --project=extension --workers=1`: eight native-input cases, persisted choices, saved WAVs/requests, and stale-preload changes. Removed controls must stay absent. |
| Settings analysis | `python scripts/verify-omnivoice-settings.py DIRECTORY --asr-model SNAPSHOT`: Praat pitch/harmonicity, pinned LAION CLAP scores, and offline faster-whisper. |
| Continuity | `PN_E2E_OMNIVOICE=1 npx playwright test tests/e2e/omnivoice-continuity.e2e.js --project=extension --workers=1`: English/female and Swedish/male WAVs, requests, reference hashes, and playback gaps. Get models with `node scripts/download-browser-models.mjs --speech`. |
| Speaker analysis | `python scripts/verify-omnivoice-continuity.py DIRECTORY`: pinned Microsoft WavLM from `.cache/speaker-verification`, downloaded before offline use. Similarity does not qualify transcript or listening quality. |

Settings analysis needs `praat-parselmouth`, `numpy`, `torch`, `transformers`, `faster-whisper`, and CLAP weights in `.cache/settings-oracles`. Changed recordings and CLAP scores alone do not pass listening acceptance.

For catalog screening, run `python scripts/prepare-omnivoice-language-audit.py` for attributed native excerpts. Enable `PN_E2E_LANGUAGE_AUDIT=1` and run `tests/e2e/omnivoice-language-audit.e2e.js` with `PN_E2E_EXTENSION_DIR` pointing to the unpacked release. It captures one fixed-voice sample per language and resumes only matching request/worker/WAV hashes. Keep failures; capture completion is not approval.

`scripts/analyze-omnivoice-languages.py` uses OmniASR CTC 1B v2 and DNSMOS P.835. `--strong-review` adds OmniASR LLM 7B v2 for flagged samples. Use isolated Python 3.12 with compatible `omnilingual-asr`, `torch`, `torchaudio`, `numpy`, `scipy`, `soundfile`, `onnxruntime`, and cached weights. The larger recognizer gets audio and a language ID, never the expected transcript. Native recordings supply baselines where available.

`python scripts/report-omnivoice-languages.py` writes the local gallery and verdicts to `artifacts/omnivoice-language-audit`. `--require-pass` requires unrestricted automatic passes for every entry. Missing references, restricted probes, poor acoustic scores, and transcript disagreements fail it. Recordings and inputs stay in ignored caches and artifacts. One sample never qualifies all uses.

For the requested EU/gaming shortlist, [language rollout](language-rollout.md) documents the 25-language, eight-sample retest, offline language suggestions for both engines, and the 26 packaged interface locales with layout verification.

<details>
<summary>Recorded language sweeps and preserved failures</summary>

The 2026-10-20 NVIDIA default-voice sweep of the installable release checked all 646 catalog entries: 334 automatic sample passes, 105 acoustic reviews, 202 transcript reviews, four synthesis failures after a fresh-worker retry, and one restricted Maba phonetic probe. All 384 flagged WAVs received a second recognition opinion. Dghwede, Igo, Itzá and Notsi samples repeatedly failed the runtime's broadband-static check. Transcript mismatches remain review findings, particularly when the recognizer also struggles with native recordings or source orthography. The all-language acceptance gate fails; this sweep does not justify claiming that every language works.

On 2026-10-22, actual frozen operands exposed an exported RMSNorm half-precision overflow that erased text rows. The guarded upstream float32 correction and single next-seed recovery return signal-valid audio for those four frozen failures and the English control. Dghwede and Itzá use the recovery; Igo and Notsi pass on their initial seed. The original failures remain recorded. The correction changes generated audio, so earlier transcript or listening approvals do not transfer; these focused signal checks do not make the catalog-wide language gate pass. See the numerical bounds and reproduction command in [browser-engine.md](browser-engine.md).

A fresh 646-request canonical-source replay returned 645 signal-valid samples, including three next-seed recoveries, and retained one Kabras static failure. Kabras used mathematical letter styling. Replaying its unchanged request through the styling fix on NVIDIA returns signal-valid audio with ASR character error rate 2.17% and passing unchanged DNSMOS bounds. Its exact tokens, float32 PCM and WAV match the separate plain-letter control. This is one source-level regression check; packaged-worker verification, broader transcript screening and native listening retain their separate scope.


The earlier NVIDIA packaged-reading pass recorded 2,074 native GPU submissions. It predates voice variation and used the former pace controls. Only the recorded English/Swedish review clips have human approval; other samples establish playback, not pronunciation.

</details>

Catalog and runtime tests: `tests/voice/voice-license-readiness.test.js`, `tests/voice/voice-catalog.test.js`, `tests/ci/bundled-voice-models.test.js`, and `tests/tts/kokoro-multilingual.test.js`.
