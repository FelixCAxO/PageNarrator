# Voice licenses

Catalog license review: 2026-08-26. Runtime and retained-data documentation updated: 2026-10-17.

PageNarrator 1.0.2 offers ten English voices from the Apache-2.0 [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) model through the Apache-2.0 [ONNX community build](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX). Missing model data downloads from Hugging Face on preparation or first use. Speech runs locally. Cached files work offline. Model weights stay out of the ZIP; runtime code and notices ship with it. Piper and browser/system voices are not offered.

## Experimental OmniVoice

Reader settings expose an additional experimental OmniVoice engine, separately from the reviewed Kokoro catalog. The pinned model metadata for `MarkShark2/omnivoice-onnx-kv-b1-fp16` declares Apache-2.0. PageNarrator's GPL-3.0-or-later tokenizer, graph executor, main speech inference and audio decoder run the retained data in an original packaged worker. The browser bridge replaces the former vendored bridge; its mathematical reference is k2-fsa/OmniVoice's Apache-2.0 inference implementation, with attribution retained. The retired executable implementations are excluded from runtime and source packaging. Sources, revisions, and implementation choices are recorded in [PROVENANCE.md](../vendor/omnivoice/PROVENANCE.md). VoiceStudio application code is not included. Remaining integration, quality and performance gates are recorded in the browser-engine documentation.

## Runtime-ready catalog

| Language | Voice IDs | License |
|---|---|---|
| American English | `af_heart`, `af_aoede`, `af_bella`, `af_kore`, `af_nicole`, `af_sarah`, `am_fenrir`, `am_michael`, `am_puck` | Apache-2.0 |
| British English | `bf_emma` | Apache-2.0 |

These voices are upstream grade C+ or higher and have no per-voice CC BY entry in Kokoro's `VOICES.md`. Retain Kokoro's Apache-2.0 notice and its model-level training-source acknowledgements with redistributed model files.

## Excluded voices

All other Kokoro voice IDs remain excluded from the v1.0.0 selector because they are below the current quality floor, ungraded, non-English, or carry separate per-voice attribution requirements. Adding one requires a fresh source, license, and listening review.

The public selected manifest must match `src/tts/voices/voice-registry.js`. The release ZIP includes `legal/Apache-2.0.txt`, `legal/GPL-3.0.txt`, and `legal/THIRD_PARTY_NOTICES.txt`, and `tests/voice/voice-license-readiness.test.js` enforces the built-in Kokoro-only catalog.

## Original browser speech implementation and retained data

The app's Kokoro registry loads PageNarrator's own packaged module worker, character tokenizer, English phonemizer and ONNX executor. C++ compiled to WebAssembly provides the q8 CPU backend; original WGSL kernels provide the fp32 WebGPU backend. It does not load eSpeak, Kokoro JS, Transformers or ONNX Runtime execution code. Development-only comparisons may use independently installed upstream packages; those are excluded from the extension and its source companion.

The original normalizer, contextual pronunciation decisions and bounded spelling rules execute PageNarrator code. [The pronunciation data manifest](../vendor/pronunciation/README.md) records the pinned CMUdict US records and static UK IPA records, their exact source revisions, exclusions and licenses. Static eSpeak-generated lexical transcriptions in the UK source are retained data; eSpeak's executable rules, compiled dictionary programs, interpreter and WASM are removed. Exact eSpeak pronunciation parity, including UK variants and every out-of-vocabulary word, is not promised.

PageNarrator's own code is GPL-3.0-or-later. CMUdict retains its permissive copyright notice. The UK `ipa-dict` records retain their GPL-3.0 license; they are not relicensed to GPL-3.0-or-later or Apache-2.0. This GPL version boundary also applies when conveying the combined distribution. Kokoro model weights, tokenizer vocabulary and voice styles retain Apache-2.0 and their original acknowledgements. Keep these individual notices with redistributed data.

Only immutable, size- and SHA-256-verified model/style bytes enter the persistent cache. The guarded `kokoro-exact-zero-phase-v2` correction creates a separate ephemeral graph with unchanged weights and records both hashes. It applies the [upstream negative-real/exact-zero-imaginary correction](https://github.com/hexgrad/kokoro/blob/93abff8795bfb00f78a14fa5d551198f445067ab/kokoro/custom_stft.py#L135-L139) and PageNarrator's canonical positive-zero phase at a coincident spectral origin. This prevents `atan(0/0)` contamination, preserves every nonzero path and is not full IEEE/Torch signed-zero parity. [Numerical policy and evidence](browser-engine.md#numerical-policy-and-preserved-failures) records derived hashes and the separate, still-failed strict unmodified-model PCM comparison.

Approved Heart/Emma clips and worker/cache checks cover only those frozen cases. Broad pronunciation quality and physical low-end throughput remain unverified. Version 1.0.0 is released; see [verification status](release-readiness.md) for accepted limits and waived reviews.
