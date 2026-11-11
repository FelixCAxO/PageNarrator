# Verification status

**V1.0.5 is being prepared for release.** The latest published release is [v1.0.4](https://github.com/FelixCAxO/PageNarrator/releases/tag/v1.0.4). The local V1.0.5 verification report and checksums are in `releases/`; publish them with the matching extension and source ZIPs. Independent listening and physical hardware qualification were waived for V1.0.5 and remain not performed. See the [changelog](CHANGELOG.md) for release history.

## Verify a new candidate

- Use `npm run verify:fast` for local regression checks and `npm run verify:integration` for packaged browser tests.
- Run `npm run test:models` and `npm run verify:release` for release verification. The [gate configuration](../tooling/config/verification-gates.json) lists the exact commands.
- `npm run test:e2e:omnivoice` verifies pinned speech fixtures and runs the packaged OmniVoice reading, settings, voice-switching, and continuity journeys serially. It fails if a required journey is missing, skipped, or unsuccessful. The release gate includes this command; it requires a working WebGPU/fp16 adapter.
- Collect [independent listening evidence](voice-listening-qa.md) and [physical hardware results](weak-hardware-testing.md). Check the [release policy](../tooling/config/release-policy.json) for version-specific waivers.
- Verify the current [PDF corpus](pdf-corpus.md) and report the limits of generated fixtures, OCR, and real-document coverage.
- Use the [release checklist](launch-checklist.md) to build, verify, and distribute both matching ZIPs.

Bind evidence to the tested commit and package hashes. Report failures, skips, waivers, and untested coverage separately.

## V1.0.5 qualification

V1.0.5 was first prepared on 2026-11-10. The maintainer waived the independent listening and physical hardware gates for this version only; the [release policy](../tooling/config/release-policy.json) records both as not performed, never as passed. The local verification report in `releases/` records the current candidate's software results, failed measurements and deferred checks separately. Lower-spec article measurements and the PDF probe remain pending at the maintainer's request; the release gate is not green. After source changes, run the relevant checks and bind rebuilt archives and evidence to the final commit. Lower-spec probe results describe the test host and do not qualify physical hardware tiers.

The planned [release](https://github.com/FelixCAxO/PageNarrator/releases/tag/v1.0.5) must include the extension ZIP, matching source ZIP, verification report and SHA-256 checksums. Create tag `v1.0.5` on the final tested source commit when publication is authorized; the release links become available after publication.

## V1.0.4 qualification

V1.0.4 was published on 2026-11-06 at the maintainer's explicit request with these qualification checks still open. The full release gate has not passed. Publication does not waive the checks, and existing policy exceptions do not extend to this version. Independent listening, attested physical hardware results and valid timing evidence remain required for full qualification; passing software checks do not replace them.

The [release](https://github.com/FelixCAxO/PageNarrator/releases/tag/v1.0.4) includes the extension ZIP, matching source ZIP, verification report and SHA-256 checksums. Tag `v1.0.4` identifies the tested source commit `5939beeef9e33acddaa3633188268970a53259aa`. All four public assets were downloaded and matched their upload hashes.
