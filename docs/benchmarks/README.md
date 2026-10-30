# Benchmark tooling

The [protocol](protocol.md) defines workloads, samples, and scoring. Current numbers are development-host diagnostics. Representative physical-tier performance remains unverified.

The local v1.0.3 toolchain uses Node 26.12.1, npm 12.2.1, Zig 0.17.0, TypeScript 7.0.2 and jsdom 30.1.3. Lifecycle objects, timers and promises have explicit types under the existing strict checks. Noise-filter queries use bounded groups with the same exclusions, preserving jsdom 30's 2,048-character limit. ESLint uses Microsoft's [TypeScript 6 API compatibility package](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0); both `typecheck` scripts execute the native TypeScript 7 compiler. No acceptance threshold is changed.

Use separate Python environments. `scripts/benchmarks/requirements-quality-tools.txt` pins the Python 3.14 audio/PDF/speech analysis tools; on NVIDIA, install its matching PyTorch 2.15.0 CUDA 13.2 wheel from the official PyTorch index. Python 3.15.2 is installed locally, but ONNX Runtime 1.31.1 has no compatible wheel; the complete analysis environment therefore remains on Python 3.14.10. PyAV is 19.0.2, with Faster Whisper pinned to the reviewed [upstream compatibility fix](https://github.com/SYSTRAN/faster-whisper/commit/2ce7f9d7a9fbe315a5804a33bf7224d42e101174) and its archive SHA-256. `requirements-multilingual-asr.txt` pins the Linux/WSL Python 3.11 environment: Omnilingual ASR requires fairseq2 0.6, matching PyTorch/Torchaudio 2.8, NumPy 1.26.4 and PyArrow 25.0.1. Newer PyArrow requires NumPy 2, which that fairseq2 stack cannot use. Local environments live in ignored `.cache/quality-tools-v1.0.3-py314/` and `.cache/asr-tools-v1.0.3/`; pass their interpreter explicitly to analysis commands. Frozen historical reference files and model pins stay unchanged.

## Commands and attribution

`npm run test:benchmarks` checks the harness and website layout, not inference or audible latency. Automated audio stays muted. Use saved PCM or AudioWorklet captures for silent continuity checks; see [environment and analysis](protocol.md#environment-record).

OS/device loopback needs a separate explicit request. `scripts/benchmarks/capture.py` requires `--device-index` for an isolated non-default Windows output; it rejects the default output and microphones. Keep test speech off desktop speakers/headphones. Other audio invalidates attribution. Check speech identity, clock continuity, and nonempty audio before reporting audible latency. Render-thread captures cannot qualify device latency.

Download pinned voice fixtures with `npm run test:models`; data stay in ignored `.cache/kokoro/`. `node scripts/benchmarks/kokoro.mjs --help` measures the original app registry/module worker:

- Choose `--backend wasm|webgpu`, `--mode stream|batch`, `--repeats 1..5`, `--cache <verified-model-directory>` and `--output <new-report.json>`.
- Set `PN_BENCHMARK_CHROMIUM` to an explicit Chromium executable for comparisons that keep the browser version fixed across Playwright upgrades. Reports record the selected executable and browser version.
- Use `--case heart-connected` or `--case emma-connected` for one frozen accepted text; omission runs both.
- GPU runs require an actual current DXGI `high,low` LUID in `PN_GPU_ADAPTER_LUID` and matching `PN_GPU_VENDOR=intel|nvidia`. The producer verifies the selected adapter.

Cold runs create a worker; warm runs reuse it. Local fixtures exclude internet download time. Stream mode preserves requested chunks without opening prefetch; batch mode includes it. PCM, token/style/speed feeds, and chunks must repeat regardless of old listening approval. Unexpected fallback stops the run. `scripts/lib/kokoro-speech-acceptance.mjs` compares raw float32 audio; equal WAVs may hide smaller changes.

Keep PCM availability separate from audible playback, main-thread tasks from inference, and measured WASM/GPU allocations from whole-browser memory. Device totals include other activity. Cleanup must terminate CPU workers and check GPU counters, device loss, and queued errors. Missing metrics stay null. Reports belong in ignored `artifacts/`.

## Scoped diagnostic measurements

The matched 2026-10-16 workload uses frozen connected prose, Heart/Emma styles, speed 1 and pinned raw models/corrected graph policy, with one runtime-cold and two warm stream repetitions. The serial native binary SHA-256 is `cb9230d06b82bf4ce833edc82ef148ceea7bac1ca39a55e812e8b668dbc5f0c0`.

| Backend | Voice / output duration | Cold completion / first PCM | Warm completion / first PCM |
| --- | --- | --- | --- |
| Serial WASM q8 | Heart / 16.975 s | 20.995 / 10.486 s | 19.779–19.838 / 9.353–9.363 s |
| Serial WASM q8 | Emma / 16.150 s | 19.623 / 9.829 s | 18.683–18.697 / 8.914–8.921 s |
| NVIDIA RTX 5090 fp32 | Heart / 16.900 s | 3.502 / 3.313 s | 0.349–0.363 / 0.172–0.174 s |
| NVIDIA RTX 5090 fp32 | Emma / 16.150 s | 1.788 / 1.611 s | 0.354–0.381 / 0.172 s |
| Intel Xe-LPG fp32, bounded Tanh | Heart / 16.900 s | 7.309 / 5.126 s | 4.128–4.133 / 1.924–1.936 s |
| Intel Xe-LPG fp32, bounded Tanh | Emma / 16.150 s | 5.645 / 3.584 s | 3.924–3.929 / 1.881–1.890 s |

CPU/NVIDIA repetitions preserve exact within-lane PCM, feeds and chunks. They record zero main-thread long tasks and maximum heartbeat gaps below 28 ms. Peak measured CPU arena/live storage is 482,017,280 / 440,578,976 bytes; NVIDIA owned buffers peak at 630,801,604 bytes. Cleanup closes workers or releases native GPU resources without recorded GPU errors. About 21 GiB of unrelated NVIDIA allocation and changing host utilization prevent an exclusive-host, backend-speedup or browser-wide resource claim. Reports: `artifacts/engines/kokoro-performance-{cpu,nvidia}-stream.json`; Intel uses `kokoro-performance-intel-bounded-tanh-stream.json`.

A separate paired production check on an eligible isolated host uses four original CPU workers: warm Heart 19.53→13.49 s and Emma 19.21→12.62 s, real-time factors 0.795 / 0.781. All cold/warm raw PCM, WAVs, feeds and chunks retain exact serial-baseline bytes. The shared arena peaks below 483 MB, excluding models, pronunciation data and browser overhead. Lifecycle/helper-failure checks terminate every owned worker and recover through the serial path. This remains a scoped diagnostic, not low-end or representative throughput acceptance.

The bounded-Tanh NVIDIA repeat completes warm synthesis in 0.354–0.384 s with first PCM at 0.173–0.190 s. Its matching PCM, feeds and chunks stay exact. Intel's six corrected repetitions also release all resources; its listening acceptance is separate. The PDF sampled-shading specialization preserves pixels/text and reduces one matched first-text diagnostic from 6.58 to 4.35 s; one pair is not representative performance.

## Quality reproduction

Vitest 5 adds `vitest doctor` for measured configuration advice. A representative local probe is `node node_modules/vitest/vitest.mjs doctor tests/speech/page-highlighter.test.js tests/reader-engine/reader-engine-read-loop.test.js tests/pdf/pdf-page-model.test.js tests/tts/omnivoice-runtime.test.js --run`. It tries alternatives without editing configuration. The 1.0.3 probe recommended retaining isolated forks: no alternative improved its minimum-of-three timing by more than 10%. Its stable filesystem module cache is already enabled by default. See the [upstream release details](https://vitest.dev/blog/vitest-5). These are test-runner measurements, not speech-throughput qualification.

`node scripts/probe-kokoro-quality.mjs --help` compares full text-to-PCM pipelines. Create a new immutable manifest using `--freeze <new-manifest.json> --cache <verified-model-directory>` before inference; it pins corpus, assessment alternatives, source, models, ten styles and the independently installed oracle.

Run `--manifest <manifest.json> --cache <directory> --output <directory> --partition validation --backend wasm --voices af_heart`. Optional `--cases validation-numbers,validation-abbreviations` and `--asr-model <offline-model-directory>` bound a group. Use `--backend webgpu` with the adapter variables above for GPU; `--voices all` or comma-separated voices/cases cover the matrix. Hashes guard resumable raw/WAV clips, and changed pins or corrupt bytes stop reuse. Unknown network requests are blocked.

The legacy comparator uses unmodified public Kokoro-js streaming and Node CPU ONNX Runtime with matching q8/fp32 models and exact style bytes. Its loader exposes no thread option; thread defaults remain unchanged. This is not a cross-backend speed or PCM-parity experiment. ASR completeness, pronunciation/listening, source association and installed article/PDF handoff are separate checks. The final partition is consumed and cannot support held-out claims for subsequent fixes.

The local 1.0.3 validation run records `clock-orthography-v2`: dotted/colon clocks are equivalent only in the corpus's time contexts. Wrong times, wrong prices, missing words and added repetitions still fail. Expected spoken alternatives and audio/model pins are unchanged; historical assessments retain their original grades. The fresh two-case Heart/CPU regression passes the candidate number and abbreviation transcripts; the paired legacy comparator fails. This focused diagnostic supplies no human listening score.

## Preserved failures and current evidence

| Evidence | Result and limit |
| --- | --- |
| First Intel speech run | Non-finite warmup before timing. Captured finite GELU inputs around 89.10/124.01 isolate driver Tanh NaNs. Original reports remain failed; actual-operand/extreme controls and corrected measurements are separate. |
| Strict model comparisons | Original CPU/reference connected clips differ by 125–150 ms and fail strict shape/PCM checks. Large-detector and OmniVoice full-model tolerances also remain failed; more accurate primitive controls do not waive them. |
| Early Heart validation | CPU transcripts 7/8, NVIDIA 6/8, each paired legacy lane 6/8. Frozen number/abbreviation orthography and homophone failures remain. Focused title/citation segmentation repairs preserve source text and connected-clip identity, not broad pronunciation acceptance. |
| Frozen v5 final baseline | 233 clips captured / 224 assessed / seven missing after two genuine non-finite GPU failures. All 60 workers close; 946 raw/WAV hashes verify. Strict candidate 127/224 versus paired legacy 135/224 remains failed. Manifest SHA-256 `c33401357b2c11e70a3934ef269a933dd70e4c9e2456c56f22d68dec3bc7642b`. |
| Current v6 development regression | All 30 groups / 240 clips complete; all 60 workers close; 960 hashes verify; 175 unaffected clips retain exact PCM/chunks/phones. Strict candidate 160/240 versus reused, fingerprint-verified legacy 145/240: both failed. No gold/threshold change, new held-out claim or perceptual winner. |
| Human listening | Recorded EN/SV OmniVoice and separate long Heart/Emma NVIDIA/CPU/Intel clips have user approval. Three new Emma clips with the UK “Wednesday” override also have approval, one per CPU/Intel/NVIDIA backend. Initial rejected clips remain preserved; these approvals do not establish a broad blinded listening study. |

The v2 phase-origin policy repairs both formerly non-finite full-graph cases while twelve Heart/Emma cold/warm CPU/NVIDIA/Intel outputs retain exact PCM, feeds, chunks and saved listening WAVs. Its signed-zero limitation and numerical evidence are in [browser-engine.md](../browser-engine.md). Generic normalization repairs cover numeric figure/page references, en-dash ranges, JSON and the S letter name. A later UK “Wednesday” override changes only that word's pronunciation; three affected Emma clips close normally and pass user listening, while US pronunciation stays unchanged. This focused repair does not change the preserved v6 results.

Reports remain under `artifacts/voice-listening/quality-final-v5/` and `quality-regression-v6/`. The v6 `all30-summary.json` SHA-256 is `c3d0d4bfaa49d73d0bf3e1bea16c330e5dfe2355e242cb9d8e9a8c52f208160f`. Failed first runner/assessment reports remain preserved separately. Current functional regressions do not establish broad speech quality.

Full performance acceptance needs fixed references, attributable output audio, cold/warm repeats, cancellation, device loss, offline/soak checks, and representative physical hardware. Run serially. Current diagnostics do not establish this full matrix.
