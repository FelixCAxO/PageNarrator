# Verification status

The development candidate is 1.0.2 (unreleased); the latest published GitHub release is 1.0.1. Previous GitHub releases were removed when the repository was recreated with a single initial commit. Chrome Web Store availability is pending.

It fixes setup progress/cancellation, bounded PDF fallback, incognito exclusion, and stalled-worker recovery. On 2026-10-25 the maintainer explicitly extended the disclosed v1.0.0 exceptions to v1.0.1. PCM reference comparisons remain failed/unqualified; physical hardware and human/listening review requirements remain waived, not verified. The exact decisions are recorded separately in the release policy and do not cover v1.0.2.

## Recorded checks

The release record includes build, lint, type checks, unit tests, browser journeys, package/source integrity, dependency and credential scans, and the 100-page PDF benchmark. Each result applies to its recorded commit, inputs, and environment. Later changes need fresh checks.

Full release verification needs private PDF references. Reports in ignored `artifacts/` are not in a public clone. Detailed historical verification records remain local. This repository starts from a new initial commit; previous release assets and commit URLs are no longer published here.

## Known limits

| Area | v1.0.0 status |
| --- | --- |
| Physical hardware tiers | Unverified. Review waived on 2026-10-24. Recommendations are not measured minimums. |
| Human/listening reviews | Waived on 2026-10-24. No formal naturalness score or broad listening-quality pass. |
| Kokoro duration/PCM reference parity | Failed/unqualified under unchanged thresholds. Accepted as a v1.0.0 limitation on 2026-10-25. |
| OmniVoice | Experimental. Catalog availability does not qualify every language or device. |
| OCR and PDFs | Coverage and resource limits apply. Internal highlight alignment does not prove correct recognition or complete extraction. |

The [release policy](../config/release-policy.json) records separate, explicitly authorized entries for v1.0.0 and v1.0.1. Neither entry applies to v1.0.2 or later. All other applicable automatic software, numerical, OCR, and PDF checks remain required. Waivers and accepted limits never become test passes.

The release gate invokes `scripts/verify-kokoro-numerics.mjs`. For v1.0.0 and v1.0.1 it preserves the historical failed/unqualified limitation. On 2026-10-26 the maintainer selected correct math and verified speech quality as the qualification target. Unwaived releases require independent CPU/GPU operator math and the separate source-bound human voice-quality gate. All six production/unmodified CPU q8, CPU fp32 and GPU fp32 waveform comparisons are still collected in a fresh directory with unchanged bounds; their PCM failures remain failed/unqualified diagnostics. Crashes, missing reports and other unexpected comparison failures still block the math gate. See the [approved protocol](../config/voice-quality-protocol.json).

## Work toward v1.0.2

No v1.0.1 exception applies to v1.0.2. The numerical verifier collects all six Kokoro diagnostic lanes even when an earlier lane fails, preserving child exit codes, startup errors, and termination signals. The historical PCM bounds are unchanged. Independent math checks and complete human speech-quality evidence are mandatory under the newly approved target.

The remaining qualification work includes clean physical-device distributions and independent human/listening reviews. Simulated limits, selected clips, and contaminated timings do not satisfy those requirements. Library PDF acceptance accepts bound review receipts through `PN_PDF_NATURALNESS_RATINGS`; voice quality separately requires `PN_VOICE_QUALITY_REVIEWS`. Both remain unqualified while the independent reviews are pending. See [PDF review collection](pdf-corpus.md#library-human-review-receipts) and [voice review collection](voice-listening-qa.md#bound-review-packets).

The initial strict matrix on 2026-10-25 used source `bd8995ac7ce7552b9b537757b54197f4895a4288` and recorded runtime-file hashes, the pinned model revision, and the independent ORT version. All six lanes retained a failure on the first Heart / “Hello.” / speed 1 comparison, with equal 33,600-sample shapes:

| Graph | Backend | Samples outside unchanged PCM bounds | Relative RMSE |
| --- | --- | ---: | ---: |
| Production | CPU q8 | 13,009 | 1.405064 |
| Production | CPU fp32 | 12,013 | 0.235609 |
| Production | GPU fp32 | 12,181 | 0.192046 |
| Unmodified | CPU q8 | 13,431 | 1.256173 |
| Unmodified | CPU fp32 | 12,983 | 0.417321 |
| Unmodified | GPU fp32 | 12,927 | 0.390725 |

CPU jobs reported zero retained buffers/tensors; GPU jobs reported cleanup with no validation errors. This establishes the initial diagnostic baseline, not numerical qualification, a listening score, or coverage of later corpus cases. Local reports and audio are under `artifacts/v1.0.2-initial-numerical-matrix/`. At that baseline the development package was still 1.0.1, so the exported verifier was explicitly invoked with version 1.0.2 to prevent the old exceptions from applying. The development candidate is now 1.0.2.

Subsequent native changes preserve clamped Resize endpoints exactly and retain rank-three float32 trilinear accumulation order. Focused tests include comparisons against the independent runtime. These changes require fresh full-model comparisons and do not qualify numerical parity by themselves.

Later fixes preserve small tanh activations and signed zero, improve the corresponding GPU calculation, and round float32 STFT window products before accumulation. Authored regression cases failed before these fixes. The approved math gate passes while retaining all six PCM diagnostic failures. Human voice quality remains pending; a passing math gate cannot qualify speech by itself.

On 2026-10-26, a fresh six-lane matrix after those changes still failed every lane. Earlier development checks passed 44,649 unit tests (four optional skips), 126 local browser tests (84 optional skips), and seven enabled real-model browser tests (one optional live arXiv skip). Those counts precede the later voice fixes and concurrent PDF edits; they do not qualify the current combined checkout. Final package, media provenance, source integrity and browser checks need a stable candidate. Human reviews remain pending at the maintainer's request. The website build settings and retired capture routes were repaired and deployed; public availability remains v1.0.1 until an actual release.

The voice-review workflow builds and hashes an isolated package, executes its built speech worker client/coordinator/helpers, and retains the original PCM, neutral blind audio and committed labels. Its source-bound receipts are checked against the actual release package. Missing, automated, incomplete or stale human reviews cannot pass. Concurrent edits in another chat are preserved; shared build changes do not replace the frozen capture runtime. The full combined release gate remains pending.

The subsequent combined run passed 44,700 unit tests with four optional skips, plus 127 local browser checks with 84 optional skips. Seven separately enabled real-model browser journeys passed, including offline browser restart, article/PDF playback and word timing; the live arXiv journey remained optional and skipped. Lint, both type checks, 56 profile tests and 41 benchmark-harness tests passed. The current build matches the isolated voice-capture package exactly. Media was recaptured from that build, and all 17 provenance checks passed. A fresh private PDF run retained 97/100 reading-order accuracy, zero narration errors and passing native routing controls; its human naturalness score remains unqualified. Both the 50-passage PDF form and the 160-pair voice form are prepared locally. A selected 48-pair ASR diagnostic retained 20 transcript disagreements for human review; it is not a quality pass.

The maintainer's PC completed twelve playback pilot reads across CPU, Intel and NVIDIA paths, covering article and PDF input. CPU and Intel pilot timings were uncontaminated; NVIDIA timings were excluded because background CPU load exceeded the limit, with one missing GPU-load observation. These samples do not meet the unchanged 30-cold/100-warm requirement per workload and backend. Neither physical tier is qualified. Final immutable source export, paired release ZIPs and the bound public release report remain outstanding.

## Combined candidate verification, 2026-10-27

The combined checkout passed 44,753 unit tests with four optional skips after native product screenshots were recaptured. All 17 media/provenance checks, 56 profile tests, 41 benchmark tests, lint, both type checks, repository structure and the production dependency audit passed. The source export and reachable Git history passed redacted credential scans. Private recordings, documents, caches and raw diagnostics remain outside Git.

The current operator-math gate passes and successfully collects all six unchanged PCM comparisons; the waveform comparisons remain failed/unqualified diagnostics. The private 100-page PDF regression records 97/100 reading-order cases, zero narration errors, 859/859 grounded chunks, 29,036/29,040 aligned words and both native routing controls. Its 50 human naturalness passages remain unrated and the overall acceptance result remains unqualified.

The bound OmniVoice development matrix resolved all 76 originally flagged normal samples, with 640 normal and 600 whisper target samples passing its automatic screening and 40 exact restart replays. Cantonese and Thai whisper were subsequently retained at the maintainer's request with a visible word-loss warning; their word accuracy is not qualified. Those automatic results do not replace native listening or the independent human review protocol.

Public release qualification still lacks the required voice/PDF human review receipts and physical-device distributions. No v1.0.2 waiver is recorded. Source publication and preparing paired release archives do not turn those missing checks into passes.

## Run checks

Use the [public build and test commands](../README.md#build-and-test) for unit, static, and browser checks. The full local gate is `npm run verify:release`. It includes the pinned private library benchmark and enabled real-model journeys. See [PDF acceptance](pdf-corpus.md#fixed-pdf-acceptance-benchmark), [hardware testing](weak-hardware-testing.md), and [engine checks](browser-engine.md#reproduction).

## Release handoff

Follow the [release checklist](launch-checklist.md). Build from a reviewed immutable source export, verify exact runtime and source hashes, and distribute both matching ZIPs. Earlier evidence transfers only when its tested runtime and scope match. Source availability, a passing command, or a commit alone does not authorize publication, deployment, or Store submission.
