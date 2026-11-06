# Contributing

Use Node.js 26.12.1 with npm 12.2.1. `.nvmrc` selects this tested Current release; compatible LTS ranges are listed in README.md. Run `npm ci`, then `npm run build`. Load `dist/` through `chrome://extensions`.

## Before changing code

- Read the callers and existing tests for the behavior you change.
- Keep narration local. Preserve settings, saved positions, and reversible page highlights.
- Keep Kokoro as the default. OmniVoice stays an explicit experimental choice.
- Keep model and native-source pins current. See [engine builds](browser-engine.md#reproduction) and [pronunciation data](../engines/vendor/pronunciation/README.md).

## Checks

Run `npm test`, `npm run lint`, `npm run typecheck`, `npm run typecheck:boundaries`, and `npm run build`.

For browser tests, run `npx playwright install chromium` and `npm run test:models`, then `npm run verify:integration`. The full `npm run verify:release` also requires independent listening and physical-hardware evidence. See [verification status](release-readiness.md). Run performance measurements alone; simulated limits do not prove physical hardware support or listening quality.

Run `npm run test:e2e:omnivoice` for the required packaged OmniVoice journeys. It verifies pinned model fixtures and enables the real engine explicitly; missing GPU support or skipped journeys fail this release check. The ordinary local browser suite keeps expensive model journeys opt-in.

In PowerShell, use `npm.cmd` when forwarding test-runner flags after `--`.

`npm run test:e2e -- v1.0.3` downloads and tests the published GitHub extension; omit the tag for the latest release. This requires GitHub CLI and, outside Windows, `unzip`. It downloads a fresh ZIP, verifies GitHub's SHA-256 digest and the manifest version, then runs E2E against the extracted extension without rebuilding. Real Kokoro and OmniVoice journeys are enabled and run one worker at a time; prepare OmniVoice data with `node tooling/scripts/download-browser-models.mjs --speech` and use a WebGPU/fp16 capable machine. The downloaded ZIP, identity, results and failure traces stay in `artifacts/github-release-e2e/`. To target a journey, append its path, for example `npm run test:e2e -- v1.0.3 tests/e2e/omnivoice-read.e2e.js`. `npm run test:e2e:local` tests a local build; the prepublication integration and release gates use that command.

Keep focused `.cases.js` groups behind their `.test.js` entry point, with shared `.fixtures.js` helpers. Run the entry point. Keep distinct regression inputs when merging repeated assertions.

## Files and licensing

Builds go in `dist/`, packages in `releases/`, and reports in `artifacts/`. These, `tmp/`, and `.cache/` are ignored. Keep credentials, personal documents, browser profiles, downloaded speech weights, and machine-specific paths out of Git. Packaged OCR data keep their manifests and licenses.

Contributions use GPL-3.0-or-later unless a file has separate terms. Keep third-party notices. Package checks must reject retired or remote executable code, source maps, interpreter runtimes, and bundled voice weights. Upstream execution packages remain development comparison tools.

Run validation locally. Do not add or trigger non-deployment GitHub Actions. Publishing, deployment, and Chrome Web Store submission need the maintainer's instruction. Follow the [launch checklist](launch-checklist.md) and distribute the matching source ZIP with the extension ZIP.
