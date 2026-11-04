# Verification status

The latest release is **v1.0.3**. Its [public verification report](https://github.com/FelixCAxO/PageNarrator/releases/download/v1.0.3/pagenarrator-1.0.3-verification.md) records results and limits for the published ZIPs. Independent listening and physical hardware qualification remain open. See the [changelog](CHANGELOG.md) for release history.

## Verify a new candidate

- Use `npm run verify:fast` for local regression checks and `npm run verify:integration` for packaged browser tests.
- Run `npm run test:models` and `npm run verify:release` for release verification. The [gate configuration](../tooling/config/verification-gates.json) lists the exact commands.
- Collect [independent listening evidence](voice-listening-qa.md) and [physical hardware results](weak-hardware-testing.md). Check the [release policy](../tooling/config/release-policy.json) for version-specific waivers.
- Verify the current [PDF corpus](pdf-corpus.md) and report the limits of generated fixtures, OCR, and real-document coverage.
- Use the [release checklist](launch-checklist.md) to build, verify, and distribute both matching ZIPs.

Bind evidence to the tested commit and package hashes. Report failures, skips, waivers, and untested coverage separately.
