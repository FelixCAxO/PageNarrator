# Live extension tests

Build once with `npm run build`. Run `npm run test:live:no-build` to test `dist/` in Playwright Chromium and write `artifacts/live-extension-pages.json`.

## Coverage

Normal, corpus, and real-model journeys use the same `dist/` directory.

Browser journeys cover webpage and selected-text reading, repeated unlimited reads, unconditional PDF access, settings, playback, resume, PDF navigation, highlights, permissions, and source-tab lifecycle. PDF access still follows browser permissions and document limits.

- `tests/live/live-language-pages.test.js` checks public pages in several languages.
- `tests/live/live-extension-pages.test.js` checks 50 Wikipedia articles per launch language, including sampled text, highlights, and DOM annotations.
- Real-model journeys require `PN_E2E_REAL_MODEL=1`.

## Hardware probes

Run `npm run probe:tts:lower-spec:no-build` and `npm run probe:tts:lower-spec-pdf:no-build` after the same build. The simulated `4gb_4cpu_low_memory` WebGPU profile needs an NVIDIA GPU and the Windows job supervisor. It binds the browser to one adapter so foreign GPU load can be measured. Counter deltas handle NVIDIA's negative bases; counters that run backwards fail validation.

Use `npm run probe:weak-hardware:no-build` for enforced CPU/memory limits, GPU faults, offline cache, playback speed, and lifecycle checks. These are software constraints, not proof from physical low-end hardware. See [hardware testing](weak-hardware-testing.md).

Each probe holds a host-wide measurement lock and writes a new directory under `artifacts/weak-hardware/`. Profiles run serially. Check `npm run measurement:lock -- status` before heavy work on the same machine.

## Browser mode

Probes use headless Chromium with WebGPU. Set `PAGENARRATOR_HEADED=1` for visible windows. Native-backgrounding lanes such as `background_minimized_webgpu` and the contention GPU load generator always use visible windows.

Set `PAGENARRATOR_TTS_PROBE_EXTENSION_DIR` to an extracted release or scratch build to leave `dist/` intact. Windows probes contain the browser process tree in a Job Object. The regular Chromium probe disables occluded-window backgrounding; the separate native-backgrounding lane measures that behavior.

Speaking lanes fail if a section plays more than 750 ms beyond its audio duration. Audio progress, transition budgets, and timeouts remain enforced.
