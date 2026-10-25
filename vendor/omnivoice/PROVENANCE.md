# PageNarrator OmniVoice browser bridge

PageNarrator's bridge is
`src/tts/omnivoice/runtime.js`, licensed GPL-3.0-or-later. The former vendored
`MarkShark2/omnivoice-vulkan-bridge` JavaScript has been removed from source and
is neither imported nor included in the extension or Corresponding Source.
No VoiceStudio or VocoLoco application/runtime source is bundled.

## Algorithm reference

The JavaScript implements the inference procedure described
by k2-fsa/OmniVoice, revision `08be0b4ccbac3e13e374e86fbfead4b4cac343e2`:

- `omnivoice/models/omnivoice.py`: style/text token delimiters, conditional and
  unconditional inputs, classifier-free guidance, shifted diffusion schedule,
  greedy class prediction and confidence/Gumbel position selection.
- `omnivoice/utils/duration.py`: Unicode script weights and short-text boost.
- `omnivoice/models/omnivoice.py` (`_resolve_instruct`): select Chinese style tags and full-width comma separators for text containing Han characters, otherwise English tags and comma-space separators.
- `docs/languages.md`: all 646 language IDs, names and ISO 639-3 aliases, bundled in
  `src/tts/omnivoice/languages.js`. The duration bridge uses the full Unicode
  script weights from `omnivoice/utils/duration.py`.
- License: Apache-2.0; Copyright 2026 Xiaomi Corp. (author: Han Zhu).
- Source: https://github.com/k2-fsa/OmniVoice/tree/08be0b4ccbac3e13e374e86fbfead4b4cac343e2

The earlier runtime was inspected during integration. No audited
clean-room process is claimed.
The licensed reference's attribution is retained in the new runtime header,
this provenance file, and the packaged third-party notices.

Continuous narration follows the reference's long-form strategy: retain the first bounded chunk's text and generated codec tokens as a fixed speaker prompt for subsequent chunks. Its reference-audio mask includes the retained prompt, while the unconditional input contains only new target tokens. Prompt tokens are never modified or decoded as part of the new output. The prompt is bounded to 512 combined text/audio positions and cleared on voice/language changes or session disposal. The reader adapter requests 24 steps for speaker creation and 12 for conditioned continuation; direct runtime requests retain their explicit step count. Voice variation defaults to seed 42, with ten selectable deterministic seeds (42–51). User audio import and encoding remain unavailable. A conservative signal check rejects non-finite samples, constant output, severe clipping and obvious broadband static before speaker retention or playback. A detected signal failure discards the worker and speaker reference and recreates the voice once with the next seed; repeating the same deterministic seed reproduced the rejected audio. Progress reports the recreation, and returned `voiceRecovery` metadata records both selected and actual seeds. A validated recovered speaker retains its seed for continuation; changing voice settings restores their selected seed. Failure after the single recovery stops reading. Signal checks do not certify language or pronunciation quality.

Browser choices: expose all 646 languages from the pinned upstream language catalog; use a one-second
Latin duration reference (25 code frames) with upstream Unicode script weights, deterministic seeded position noise,
and full bidirectional sequence recomputation on every diffusion pass. All KV
slots are overwritten each pass; prefix states are not reused between steps.
The main speech graph and neural audio decoder use PageNarrator's original
ONNX reader and WebGPU/WGSL kernels. Tokenization uses PageNarrator's original
byte-pair encoder and the pinned tokenizer data.
Confidence scoring runs in JavaScript. Sections over 2048 combined text/audio
positions fail explicitly. The reader's existing chunking remains in use.
Sessions and tensors are released after in-flight inference settles on stop,
failure or disposal. Inference runs in a dedicated module worker; disposal
terminates that worker to free its inference memory before the next read.
No remote executable scripts, ASR, voice cloning, or
remote PCM/text upload are implemented.

## Model interface

Model: `MarkShark2/omnivoice-onnx-kv-b1-fp16`, revision
`0111dd42766f32e6ebb91434ded76f0e697d834a`, metadata Apache-2.0:
https://huggingface.co/MarkShark2/omnivoice-onnx-kv-b1-fp16/tree/0111dd42766f32e6ebb91434ded76f0e697d834a

The pinned ONNX graphs were inspected directly to determine their public
tensor names, data types and dimensions. The main graph takes int64
`input_ids [1,8,L]`, bool `audio_mask [1,L]`, bool `attention_mask [1,1,L,L]`,
int64 `position_ids` and `target_positions [1,L]`, and 28 key/value pairs of
float16 `[1,8,L,128]`. It returns float16 `audio_logits [1,8,L,1025]`.
The decoder maps int64 `audio_codes [1,8,T]` to float32
`audio_values [1,1,samples]` at 24 kHz. Real decoding produces 960 samples per
code frame (25 Hz). The bundle's `frame_rate: 75` metadata is inconsistent with
its decoder; duration estimation follows the actual 25-Hz decoder and the
licensed inference reference's 25-frame fallback instead.
The vocabulary's MASK class is 1024 and is never decoded as an audio code.

Microsoft ONNX Runtime Web `1.25.0-dev.20260227-dce58e8711`, MIT, remains an
isolated development comparator. Its executable assets are not packaged.
Model weights, tokenizer, revisions and the seven-file browser cache are unchanged.
Before main-model session creation, `rmsnorm-correction.js` verifies the exact
original graph and restores all 113 RMSNorm chains to the float32 arithmetic
specified by [Transformers v5.3.0 Qwen3RMSNorm](https://github.com/huggingface/transformers/blob/v5.3.0/src/transformers/models/qwen3/modeling_qwen3.py#L54-L59).
The pinned OmniVoice reference requires Transformers 5.3.0 or newer. The derived
graph SHA-256 is `4ace0df24c6b611fd19f47bc5c44b482ef0e20acd868d81e4f2a2f24f807a0e0`.
Variance, inverse scale and normalization remain float32 until the existing
half cast; learned-weight multiplication remains half. No learned weights,
public inputs/outputs or unrelated operations change, and only the original
hash-verified graph enters CacheStorage. Runtime diagnostics record both hashes.
The main-model development probe uses the same correction on both paths and
independently promotes 253 reference MatMul operations to float32 accumulation,
then rounds their outputs back to half, matching PageNarrator's accumulation
policy. `--unmodified-model` preserves the unmodified-model experiment.
The original executable tokenizer, main-graph and audio-decoder replacements are described
in [browser-engine.md](../../docs/browser-engine.md), including independent
token and waveform comparisons. Their code is GPL-3.0-or-later; the retained
model data keep the model's declared Apache-2.0 license.

## Checks

`tests/tts/omnivoice-runtime.test.js` covers reference duration fixtures, schedule
coverage, CFG/prefix/MASK handling, fp16 conversion, complete decoding,
hardware/configuration rejection, partial-load cleanup, retry, overlap,
cancellation, inference errors and tensor/session ownership.
`tests/e2e/omnivoice-read.e2e.js` exercises real Kokoro and OmniVoice extension
playback, sliders, native WebGPU submissions and cached offline restart.
Human listening and weak-device performance are separate acceptance checks.
