# Browser engines

PageNarrator uses original JavaScript, WebGPU / WGSL, and C++20 / WebAssembly code for speech, OCR, PDF processing, and article extraction. Models, dictionaries, fonts, and character maps are third-party data. See [licenses](third-party-voice-licenses.md).

## Architecture

| Part | Work and limits |
| --- | --- |
| Shared inference | `src/engines/onnx-model.js` reads bounded ONNX metadata, nested graphs, and model-local functions. It supports views of embedded data, hash-checked external weights, fp16/bool, multiple outputs, output pruning, and bounded embedding shards. Unsupported operators, attributes, or layouts fail. |
| WebGPU | Matrix, convolution, recurrent, spectral, indexing, reduction, normalization, resize, and grid-sampling kernels. Tensor lifetimes reuse storage. One normal execution plan, or two explicit plans, share 128 MiB. Reads and disposal wait for submitted work. |
| CPU | Eight checked-in native binaries provide SIMD inference, phonemization, PDF parsing, and codecs. Rebuild with Zig 0.15.2. They import no external executable runtime; the optional parallel Kokoro binary has a checked shared-memory import. |
| Kokoro | `src/tts/kokoro/` owns loading, tokens, normalization, streaming, and English phonemization. CPU uses q8; GPU uses fp32. Pinned US/UK dictionaries and bounded spelling rules are approximate. The four-worker CPU path requires cross-origin isolation; other hosts use serial inference. |
| OmniVoice | Original byte-pair tokenizer, graph executor, and WebGPU/fp16 decoder. Each diffusion step recomputes the full bidirectional sequence. Limit: 2,048 combined text/audio positions. Separate cached model data; no CPU fallback. See [provenance](../vendor/omnivoice/PROVENANCE.md). |
| OCR | Shared GPU detector/recognizer/UVDoc graphs, with original WASM detector/recognizer fallback. A separate English LSTM source-crop verifier checks uncertain lines. Recognition text and source-pixel word bounds stay separate. |
| PDF | `src/pdf/` and `native/pdf*.cpp` provide bounded parsing, fonts, encryption, static display lists, JPEG2000/JBIG2/fax/color handling, and sampled shading. Browser Canvas/font/image APIs paint output. ToUnicode and ActualText remain authoritative. No editing or document scripts. |
| Articles | DOM traversal without cloning, prose scoring, hidden-content/furniture removal, and source anchors for highlights. |

OCR keeps four shared attempts with legacy slash priority and at most four deferred crop descriptions. Letter edits need matching counts, order, immediate literal neighbors, and source clearance; technical identifiers are excluded. Spacing preserves letters. Punctuation needs independent matching text and source ink, including right-edge pixels. Running the same weights on CPU is not independent verification.

The seven pinned speech/OCR graphs use 73 operator types. Build and package checks reject retired runtimes, unknown WASM, remote executables, and files outside the verified graph. Comparison packages remain development-only. Vite preload helpers and retained data keep their own notices.

### Admitted PDF programs

Native CMYK processing keeps four inks plus alpha through final ICC conversion. Qualified paths include bounded Normal groups and Forms, specified masks and overprint, ICC4 contributions, and a single-rectangle Multiply program. Support depends on the exact producer, consumer, profile, and resource limits; unsupported combinations return errors. Detailed historical diagnostics are retained locally.

## Verification status

The current source retains the v1.0.0 limitations. Physical hardware tiers and broad listening quality remain unverified. The dated waivers and accepted Kokoro duration/PCM limitation are recorded in [verification status](release-readiness.md). Kokoro reference comparisons remain failed/unqualified; individual operator passes do not qualify full-model parity.

Historical diagnostics are retained locally; the [benchmark record](benchmarks/README.md) describes the retained methodology. Their scope does not expand with a later wording or implementation change.

## Numerical policy and preserved failures

Only verified immutable model bytes enter persistent cache. Pinned runtime corrections create separate derived graphs and record both hashes. Kokoro's `kokoro-exact-zero-phase-v2` handles its bounded spectral-origin case; it is not full IEEE/Torch signed-zero parity. OmniVoice's guarded RMSNorm correction restores the reference float32 chains without changing learned weights or public inputs/outputs.

On 2026-10-26 the maintainer selected **correct math and verified speech quality** as the qualification target. Independent operator checks are mandatory. The six production/unmodified CPU/GPU waveform comparisons remain diagnostics with their original thresholds and failed/unqualified results; unexpected execution failures still block verification. This changes the target, without declaring the old comparisons passed or granting a human-review waiver. The decision and listening rules are pinned in [the voice-quality protocol](../config/voice-quality-protocol.json).

The reference-only sensitivity experiment found that changing STFT arithmetic by less than 0.000001 produced about 19% relative waveform RMSE, even with all other operations on the same independent runtime. The corrected native STFT agreed with independent Torch double-precision FFT on the same float32-windowed signal within 0.000000001. These are bounded diagnostics, not a listening score or proof about every input. Full speech qualification separately requires the complete, source-bound [blind listening study](voice-listening-qa.md); missing human evidence remains unqualified. See the [historical release policy](../config/release-policy.json), [recorded results](release-readiness.md), and [retained-model provenance](third-party-voice-licenses.md).

## PDF resource limits

| Resource | Bound |
| --- | --- |
| Source download / logical page content | 128 MiB before opening / 32 MiB across sequentially decoded content streams |
| Indirect references | 64 hops with cycle rejection |
| Parsed document graph | One million retained parser nodes and 500,000 indirect objects |
| Page tree | 100,000 pages and depth 64 |
| Images | 32 million pixels per image and in the page's admitted image-source tally; 96 MiB per sampled image buffer. Native image sources also share a 96 MiB retention/decode-peak budget. |
| JBIG2 bitmaps | 16 million pixels per decoded bitmap, including refinement references |
| Transparency | Shared live budget of 16 million weighted component/pixel units; native compositing shares the 64-million-pixel work budget with shading and masks |
| ToUnicode | 100,000 records, two million retained UTF-16 units and 500,000 mapping-work operations including overwrites |
| Page fonts | 256 resolved objects and 64 MiB admission estimate covering converted bytes and expanded maps/metrics |
| Type0 metrics / ActualText | 500,000 cumulative W/W2 expansion operations; two million ActualText decode-work units with a shared retained-text limit |
| Document faces | 1,024 families and 128 MiB actual font bytes, including in-flight reservations; aliases/local faces share reservations and are released |

Exceeding a bound returns an error. Admission estimates are not heap measurements. Revision 6 passwords use original Unicode 3.2 normalization/stringprep with retained normative data and independent controls.

## Reproduction

Use the checked-in native artifacts for ordinary builds: `npm ci`, then `npm run build`. Set `PN_CANDIDATE_ID` to a source manifest's recorded identifier when reproducing its build. `npm run prebuild` verifies all eight native artifacts, metadata and retained-data notices without compiling or downloading. Source hashes use canonical committed bytes; hash-pinned data preserve upstream bytes.

For native rebuilds, set `PN_ZIG` to Zig 0.15.2 and run these producers with Node: `build-native-kernels`, `build-native-engine`, `build-browser-phonemizer`, `build-ocr-engine`, `build-ocr-lstm-engine`, `build-kokoro-engine`, `build-kokoro-parallel` and `build-native-pdf`, each at `scripts/<name>.mjs`.

Run `npx vitest run tests/engines`, `node scripts/build-native-engine.mjs --check` and `node scripts/probe-native-engine.mjs`. Actual Chromium probes cover irregular tiles, zero-size dimensions, activations, broadcasting, grouped/dilated audio convolution, transposed padding, indexing, shared-view lifetimes and cleanup against independent scalar/native references. On Windows, select a current DXGI LUID with `PN_GPU_ADAPTER_LUID` and require its vendor with `PN_GPU_VENDOR`; LUIDs can change across boots.

- `node scripts/inspect-models.mjs model.onnx [...] --output=artifacts/engines/model-inventory.json` records hashes and tensor/operator/external-data contracts.
- `node scripts/download-browser-models.mjs --tokenizer` and `node scripts/probe-tokenizer-engine.mjs` compare exact multilingual tokens from the browser candidate with the isolated Node Transformers 3.8.1 development oracle. Use `--decoder` / `--speech` to obtain the pinned audio/speech data; `node scripts/probe-audio-decoder.mjs --speech` compares actual speech codes and waveforms.
- `npx cross-env PN_E2E_OMNIVOICE=1 playwright test tests/e2e/omnivoice-read.e2e.js --project=extension --workers=1` exercises full installed playback and offline restart. `PN_KOKORO_FIXTURE_DIR` points to the parent fixture cache when it is outside the checkout.
- `node scripts/probe-ocr-engine.mjs` compares detector tensors; add `--recognizer`, `--unwarp` or `--large`. Unsupported work fails at its original error. Benchmark/profile flags are local diagnostics.
- Set `PN_OCR_PRIVATE_FIXTURE_DIR` to the preserved historical fixture directory, run `python scripts/download-engine-fixture.py`, then `node scripts/probe-ocr-pipeline.mjs` to compare development-image text and geometry. Historical document fixtures and the hash-checked DocUNet photograph are not redistributed in the source or runtime packages. Missing private inputs do not count as quality passes.

Record model/source/input pins, browser, physical adapter, cold/warm state, actual output and complete cleanup. Run hardware measurements serially. Current timings overlap unrelated host activity and do not establish representative GPU/CPU tiers, browser-wide memory or a general speedup.

## Speech work and resource reuse

| Stage | Reuse and ownership |
| --- | --- |
| Model files | Concurrent loads share a pending promise. Cache reads are rehashed; downloads stream to cache without a second whole Response copy. OmniVoice releases uploaded weight payloads; Kokoro keeps its source graph. |
| OmniVoice setup | Tokenizer and sessions belong to one worker. Main/decoder sessions share an fp16 GPU device and preparation promise. Typed pipelines compile concurrently; small CPU metadata copies do not retain large payloads. Weights upload once per session. |
| Diffusion | Conditional/unconditional passes have different inputs and remain required. Two bounded plans retain buffers/commands. Empty KV aliases upload once per pass. Full-sequence recomputation stays intact. |
| Token selection | Indexed fp16-to-float32 lookup preserves values and signed zero. Conditional/unconditional logits stay independent until guidance and seeded selection finish. |
| Kokoro setup | One derived model buffer is built from views and hash-checked. The session performs the full parse; style loads share a promise. First-text warmup supplies the requested first section instead of synthesizing it twice. |
| Audio | Bounded preloads own transferred PCM, WAV blobs, and prepared media elements. Worker and client signal checks both remain required. Prepared elements are consumed once. One Web Audio context serves a read; media elements retain rate/pitch controls. Release consumed URLs and obsolete work. Keep copies needed to detach disposed tensors. |
| Engine switch | Prepare the exact unspoken section and its successor. Cancel obsolete incoming work and let outgoing work finish before disposal. Temporary dual-model memory is intentional and measured separately. |

Kokoro still keeps CPU graph/weights alongside GPU uploads. Releasing them earlier, pooling mapped readbacks, keeping models between reads, or changing guidance passes/precision/steps/anchors needs separate ownership, cleanup, output, and performance evidence. Source reuse alone is not a measured speedup. Detailed historical resource diagnostics are retained locally.
