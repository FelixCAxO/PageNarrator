# Regression checks

The main risk is a mismatch between speech and webpage or PDF highlights. Unit tests cover chunking, timing, order, resume, voice changes, settings, cancellation, storage, and messages. Browser tests check clean-install access to every advanced feature through `dist/`.

Stop and tab-close recovery must clear audio, preloads, highlights, and pauses without offscreen exceptions. Returning to idle is not enough. Settings restoration must preserve newer input. First-read controls must appear before async setup completes.

- `npm run verify:fast`: local iteration.
- `npm run verify:integration`: packaged browser journeys.
- `npm run verify:release`: full local gate, including `test:live` and constrained `probe:tts` lanes.

Run `npm run test:models` before browser tests. Full release verification also needs private PDF references.

Unit discovery stays in `tests/` with four workers. Profiles, browser tests, and native benchmarks have separate commands. Keep historical snapshots and generated reports out of discovery.

Real-model journeys check generation, decoding, playback, completion, and alignment. They do not certify pronunciation, every document, or physical low-end hardware. Keep failed measurements and state their limits.
