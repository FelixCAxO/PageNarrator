# Verification status

The source version is 1.0.1. Previous GitHub releases were removed when the repository was recreated with a single initial commit. Chrome Web Store availability is pending.

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

The release gate invokes `scripts/verify-kokoro-numerics.mjs`. For v1.0.0 and v1.0.1 it records the existing duration/PCM acceptance as failed/unqualified. For v1.0.2 and later it runs fresh full-model CPU q8, CPU fp32, and GPU fp32 comparisons for both production and unmodified graphs. Each run uses a new output directory; any comparison failure blocks the gate. Models and a usable browser/GPU are required for those comparisons.

## Work toward v1.0.2

No v1.0.1 exception applies to v1.0.2. The first change collects all six Kokoro numerical lanes even when an earlier lane fails, preserving child exit codes, startup errors, and termination signals. Any failed lane still blocks verification; production arithmetic and thresholds are unchanged.

The remaining work is to isolate the first divergent Kokoro intermediates against the independent reference, obtain clean measurements on the required physical device tiers, and collect the required independent human/listening reviews. Simulated limits, selected clips, and contaminated timings do not satisfy those evidence requirements. PDF human-review acceptance also needs a path for current bound review receipts instead of requiring a waiver.

The initial strict matrix on 2026-10-25 used source `bd8995ac7ce7552b9b537757b54197f4895a4288` and recorded runtime-file hashes, the pinned model revision, and the independent ORT version. All six lanes retained a failure on the first Heart / “Hello.” / speed 1 comparison, with equal 33,600-sample shapes:

| Graph | Backend | Samples outside unchanged PCM bounds | Relative RMSE |
| --- | --- | ---: | ---: |
| Production | CPU q8 | 13,009 | 1.405064 |
| Production | CPU fp32 | 12,013 | 0.235609 |
| Production | GPU fp32 | 12,181 | 0.192046 |
| Unmodified | CPU q8 | 13,431 | 1.256173 |
| Unmodified | CPU fp32 | 12,983 | 0.417321 |
| Unmodified | GPU fp32 | 12,927 | 0.390725 |

CPU jobs reported zero retained buffers/tensors; GPU jobs reported cleanup with no validation errors. This establishes the current diagnostic baseline, not numerical qualification, a listening score, or coverage of later corpus cases. Local reports and audio are under `artifacts/v1.0.2-initial-numerical-matrix/`. The development package remains at 1.0.1 until the next version cut; this baseline explicitly invoked the exported verifier with version 1.0.2 so the old exceptions could not apply.

## Run checks

Use the [public build and test commands](../README.md#build-and-test) for unit, static, and browser checks. The full local gate is `npm run verify:release`. It includes the pinned private library benchmark and enabled real-model journeys. See [PDF acceptance](pdf-corpus.md#fixed-pdf-acceptance-benchmark), [hardware testing](weak-hardware-testing.md), and [engine checks](browser-engine.md#reproduction).

## Release handoff

Follow the [release checklist](launch-checklist.md). Build from a reviewed immutable source export, verify exact runtime and source hashes, and distribute both matching ZIPs. Earlier evidence transfers only when its tested runtime and scope match. Source availability, a passing command, or a commit alone does not authorize publication, deployment, or Store submission.
