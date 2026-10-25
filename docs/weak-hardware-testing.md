# Hardware testing

This harness checks backend choice, recovery, and resource limits on one Windows host. A constrained host is not a named older computer. Results apply only to observed conditions.

For v1.0.0, physical hardware and human/listening reviews were waived on 2026-10-24. Kokoro duration/PCM differences remain failed/unqualified, accepted as a limitation on 2026-10-25. Other applicable software, numerical, OCR, and PDF checks remain required. Waivers do not establish performance or quality. See [policy](../config/release-policy.json) and [hardware recommendations](requirements-hardware.md). The maintainer explicitly extended those same disclosed exceptions to v1.0.1 on 2026-10-25. They do not apply to v1.0.2; unperformed reviews remain unverified and numerical failures remain failed/unqualified.

## Evidence categories

Each profile's `evidence` descriptor separates reported capabilities, enforced constraints, physical hardware, injected faults, and limits. Categories can overlap; one never implies another. Definition: `scripts/weak-hardware/evidence-contract.mjs`.

| Category | Meaning | Source |
| --- | --- | --- |
| `native-host` | Unrestricted host, or a physical adapter already present in it | Default profile, `native_*`, `igpu_webgpu` |
| `capability-simulation` | Reported values were changed in the toolbar-player page (`navigator.deviceMemory`, `hardwareConcurrency`, WebGPU exposure, fake adapters). Host CPU, RAM and GPU were not limited. | Existing `lower-spec`, `requirements`, `deep-flow` and `cold-start` profiles; reported logical processor counts in CPU lanes |
| `resource-constrained-host` | A Windows Job Object enforced processor affinity, a CPU-rate hard cap or a commit ceiling on the whole test-browser process tree | `cpu-*`, `mem-*`, `playback_4ecore_*`, `lifecycle_*_4ecore_*`, `soak_*_4ecore_*` |
| `fault-injection` | A synthetic failure or latency was injected, or the network was taken offline | `gpu-faults`, `cache` |
| `virtual-machine` | Reserved; no VM lane exists yet | — |
| `physical-target` | Only from an attested run on the target machine. A profile definition can never declare it. | None recorded |

## Lanes

Set `PAGENARRATOR_TTS_PROBE_PROFILE` to a set, profile, or comma-separated list.

| Set | Lanes | What is changed | Correct outcome |
| --- | --- | --- | --- |
| `native` | `native_webgpu`, `native_wasm` | Nothing; WASM is the product's explicit *CPU / WebAssembly* choice | Local model on the requested path |
| `cpu-constrained` | `cpu_{4,2,1}ecore_wasm_t*`, `cpu_4pcore_wasm_t4`, `cpu_rate25_wasm`, `cpu_4ecore_webgpu` | Job affinity resolved by core class, or a 25%-of-host CPU-rate cap; `tN` independently sets reported logical processors | Local model; reported counts 1/2/4 select 1/1/4 inference workers. Require one active Kokoro coordinator plus zero or three helpers; four workers also require observed cross-origin isolation. |
| `memory-constrained` | `mem_{4,2,1}gib_webgpu`, `mem_{2,1}gib_wasm` | Job commit ceiling for the whole browser tree; fresh browser per run | Any category, provided repeated runs agree (boundary search) |
| `gpu-faults` | `gpu_fault_adapter_rejects`, `gpu_fault_device_rejects`, `gpu_default_limits`, `gpu_fault_device_lost_after_first_audio`, `gpu_latency_250ms` | Page-script fault injection with verified trigger counters | Declared per lane: CPU path, permitted fallback, local model or explicit error; never a GPU init loop |
| `cache` | `offline_warm_webgpu`, `offline_restart_wasm`, `offline_cold`, `offline_backend_switch` | Per-run network conditions; offline is CDP emulation on the toolbar-player page, verified by a blocked request | Exact outcome per run (cached reuse vs. explicit error) |
| `playback` | `playback_webgpu_3x`, `playback_wasm_3x`, `playback_4ecore_wasm_{1x,3x}` | Playback speed and CPU constraints | No starvation gap above 750 ms and no unexpected silence |
| `lifecycle` | `lifecycle_{stop,pause_resume}_{webgpu,4ecore_wasm}`, `background_minimized_webgpu` | User actions during speech; native window backgrounding | Silence within 500 ms of stop/pause, no stale speech, sound within 1.5 s of resume, progress while minimized |
| `contention` (opt-in) | `contention_cpu12_{webgpu,wasm}` | A declared 12-thread, 100%-duty CPU load generator | Usable playback; always labelled contention and excluded from isolated aggregates |
| `soak` (opt-in) | `soak_continuous_{webgpu,4ecore_wasm}` | Continuous reading of a long generated article | 60-minute target; bounded stall and memory growth after warm-up |
| `physical-adapter` | `igpu_webgpu`, `dgpu_webgpu` | WebGPU steered to the host's Intel or NVIDIA GPU (`--use-adapter-luid`, LUID from DXGI) | WebGPU on that adapter; qualified timing also requires complete per-instance GPU counters for the selected adapter |

Use `PAGENARRATOR_TTS_PROBE_DOCUMENTS` for workloads. Defaults: `article,pdf`. Opt-ins: `long-article`, `complex-html`, `two-column-pdf`, `scanned-pdf`, and `soak-article`. References come from `tests/fixtures/weak-hardware/workload-references.js` or the PDF acceptance manifest, never extractor output.

New workloads require ordered word recall >= 99%, all checkpoints in order, and no narrated page furniture. All except soak read until idle. Score every speech section from engine state; report the transcript card separately because it may hold only early streamed text. Default article/PDF scores are diagnostic: these workloads stop after required sections, so article tail checkpoints may be missing.

Speaking lanes fail above 750 ms of playback beyond audio duration (`playback.maxPlaybackOverrunMs`). Pause/resume lanes are exempt. Multi-section continuity checks need a measured transition gap.

## Enforced constraints

`scripts/weak-hardware/windows-job-supervisor.cs` is compiled with PowerShell `Add-Type`. It starts Chrome suspended, assigns the process to a Job Object, then resumes it. `KILL_ON_JOB_CLOSE` and disabled breakaway contain descendants, including nested sandbox jobs. CDP uses WebSocket because pipes do not pass through this supervisor.

`assessRunEnvironment()` checks browser job membership, affinity, active CPU/commit caps, peak commit within 1%, navigator overrides, fired fault counters, and the observed adapter. Exited processes may be ignored; other inspection failures leave the run unverified. Outside processes are recorded in `outsideDetails`. A contradiction means `invalid-environment`; missing observations mean `unverified`. Neither supports a pass.

The supervisor records job CPU time, peak commit, private bytes, per-adapter engine time, and GPU memory split between the browser and other processes. English .NET counter names support localized Windows.

### Known limits

- **Commit ceiling overshoot.** Windows let the job's recorded peak commit exceed the configured ceiling by 20–30% (2663 MiB under a 2 GiB ceiling, 1252 MiB under 1 GiB) exactly when lanes reached it. Those runs are `invalid-environment` and cannot claim a precise boundary.
- **Commit is not RAM.** A commit ceiling is not system RAM and creates no OS memory pressure. A fixed-memory VM lane would be needed for whole-guest pressure.
- **Restricted cores are not an older CPU.** Affinity to efficiency cores still shares host caches, boost behavior and memory bandwidth.
- **Buffer limits are not a VRAM budget.** WebGPU cannot restrict a device below its default limits, so the limits lane uses the spec defaults (256 MiB buffer, 128 MiB storage binding).
- **The integrated GPU is not a complete low-end machine.** It shares the host CPU, RAM and driver stack.
- **GPU counters are sampled.** Complete enumeration means every instance returned by the OS was parsed; it does not establish driver coverage of every physical engine. Two snapshots miss instances that start and end between them and do not prove exclusive GPU use.

## Isolation, scheduling and provenance

- Scored runs hold `~/.pagenarrator/measurement.lock` outside the checkout. Override with `PAGENARRATOR_MEASUREMENT_LOCK_PATH`. Sessions queue; dead/expired holders can be reclaimed. Children inherit the token. Check `npm run measurement:lock -- status` or use `npm run measurement:lock -- run -- <command>` before heavy work.
- Profiles run serially. Parallel jobs need `PAGENARRATOR_TTS_PROBE_MODE=contention` and are labelled contaminated.
- Record foreign CPU load and top processes before each profile, NVIDIA utilization where available, and selected-adapter counters during attempts. Missing, blank, or non-finite telemetry is unknown, never zero. GPU timing needs explicit adapter binding and complete counters; default-adapter runs remain functional references. NVIDIA telemetry does not qualify Intel load. Missing during-run CPU accounting also leaves timing unqualified.
- Foreign CPU/GPU load at 25%, an absent lock, or non-isolated scheduling contaminates timing and excludes it from tiers. CPU-only runs ignore GPU telemetry but keep CPU, lock, and scheduling checks.
- Write each run to `artifacts/weak-hardware/<revision>[-dirty]/<run-id>/`. Persist attempts as `running` before launch so abandoned attempts remain visible.

Run provenance includes revision, dirty-path digest, extension/prepared-copy hashes, the manifest modification, browser/flags, supervisor mode, model/revision, voice, lock, and host inventory.

Attempt records include status/outcome, requested and observed backend, displayed backend, exact worker URLs/hashes and coordinator/helper counts, model cache state, engine residency, model acquisition, stage/audio/resource/load/content observations, environment checks, and console/failure details. Missing worker observations cannot pass. Keep first-section timing, sections prepared before playback, main-thread tasks, media events/state, document console errors, and document crashes.

### Unresponsive pages

CDP commands are bounded; page evaluations allow 20 s. If the popup stops responding, sample job CPU over 2 s. At >= 0.5 logical processors, wait within the attempt deadline and record `pageBlocking`. A stretch above 20 s fails. Flat CPU records `renderer-unresponsive`. High worker CPU alone does not identify a page hang.

### Timing sources

`firstAudibleMs` uses a product playback callback on the first read and post-click page taps on repeats. `audio.clickToFirstNonSilentMs` uses a `captureStream()` analyser with about 21 ms resolution. Contract 2 requires an observed signal at/after each click in `audio.readFirstNonSilentEpochMs`; missing values stay null. Older contracts may reuse a previous read's timestamp and cannot qualify current timing. Neither source is output-loopback audio.

Tap totals, polling gaps, and long tasks cover the page lifetime; peak commit covers the browser lifetime. Timers poll every 10 ms. `audio.maxTickGapMs` above 250 ms sets `audio.samplingDegraded`. Historical CPU runs had about 15-second gaps and retain that uncertainty. Current runs need their own observations. Minimized windows can throttle timers.

## Requirements reports

`npm run requirements:tts` reads legacy and run-scoped reports and summarizes the latest build. Keep failures, timeouts, crashes, invalid environments, and unfinished attempts. Unattributed legacy files cannot support verdicts. Older/unversioned measurement contracts stay visible separately and cannot qualify current tiers, even with identical extension bytes.

Physical tiers need one attested target/build, article and PDF workloads, at least 30 cold and 100 warm valid samples per workload, no contamination or failures, and the observed backend. Other machines and unattested samples do not contribute. Report enforced-host usability and capability-policy simulation separately, alongside native references, fault handling, missing evidence, and failures.

`launchEvidence.status` passes only with both physical tiers. They are explicitly waived for v1.0.0 and v1.0.1 only. Optional `--fail-on-non-pass` checks current `dist/` bytes and fails missing or failed tiers. Plain `requirements:tts` is diagnostic; `--build HASH` selects a historical build.

### Physical targets

Set `PAGENARRATOR_PHYSICAL_TARGET_ATTESTATION` to a private JSON file with `machine`, `cpuModel`, `logicalProcessors`, `ramGb`, `gpus`, and `attestedBy`. The launcher checks these against host inventory. Keep the file outside source. Automated attestations must name the automation.

Select `native_wasm`, `igpu_webgpu`, or `dgpu_webgpu` with `PAGENARRATOR_TTS_PROBE_PROFILE`; select `article,pdf` with `PAGENARRATOR_TTS_PROBE_DOCUMENTS`. Run `npm run probe:tts:no-build` against one fixed candidate. GPU timing needs explicit adapter binding; unbound `native_webgpu` cannot qualify it.

`machine` is a display label. Pool samples only by observed `physicalTarget.verifiedAgainst.hostname` and attested hardware. Older records without observed identity cannot qualify a tier.

### Measurement contract 3

A cold sample is the first user read in a fresh popup page. Download-cold/cache-warm state is separate. A warm sample repeats in that same page after a successful read. Before clicking, the harness reads and hashes cached ONNX bytes at the production URL in `transformers-cache` against the pinned manifest. Missing observations, wrong cache/bytes, another page, or no predecessor fail qualification. Reject duplicate attempt IDs; never pool different workload hashes.

Warm means verified cached data, not a resident model. The product may release the engine after stop/completion, waiting for active synthesis. Record `resident` or `reloaded` separately; timings include actual reload. Record cache verification start/end and verification-to-click time: readback can warm memory caches but is excluded from click latency. Do not retain or inject model sessions. Contract 2 failures stay unchanged and cannot qualify contract 3.

`maxSectionReadyDeadlineMissMs` compares next-section synthesis completion with the preceding audio end, clamped at zero. Budgets stay 2,000 ms minimum / 1,500 ms recommended. `maxNextSectionReadyGapMs` remains a diagnostic that may include prefetch backpressure. Every completed transition needs both observations; partial coverage fails. Unplayed prefetched sections are outside this window.

The default two-page PDF is authored and pinned to `cf7f64bca6be30fbbde2e686589fc45a41568533a87df467cb7054c149f0e774`. It must complete at least two sections. The earlier shared one-page fixture is unchanged.

Set `PAGENARRATOR_TTS_PROBE_RUNS` and `PAGENARRATOR_TTS_PROBE_READS_PER_TARGET` for fresh pages and repeat reads. Thirty runs × five reads request 30 cold and 120 warm samples per workload. Only valid observed counts qualify. Continue until both workloads reach 30 cold / 100 warm on the same target/build. Keep run evidence under `artifacts/weak-hardware/`; never mix candidates or machines.

## Commands

```sh
npm run build
npm run probe:weak-hardware:no-build
npm run probe:weak-hardware:no-build -- --workloads --contention --soak
npm run probe:weak-hardware:no-build -- --stages=memory --runs=2
npm run test:weak-hardware
npm run measurement:lock -- status
```

`scripts/weak-hardware/run-matrix.mjs` runs baseline, memory, faults, and lifecycle by default. Workloads, contention, and soak are opt-in. `--soak=<minutes>` permits exploratory runs, reported incomplete below 60 minutes. `--runs=<n>` raises samples. The matrix writes `tts-requirements-summary.{json,md}` and fails any failed, missing, blocked, incomplete, or invalid lane. `--require-pass` also needs physical tiers. The opt-in `weak-hardware` gate builds and runs this matrix; it is separate from the release gate.
