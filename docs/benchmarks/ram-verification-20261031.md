# Bounded model verification A/B, 2026-10-31

OmniVoice now verifies its 1,225,140,224-byte weights in 16 MiB views using native SHA-256. The generated, bundled metadata contains 74 ordered hashes, the original file path, size and full SHA-256. Cached files reuse the existing preallocated stream reader. Model bytes, revision, precision, diffusion steps and speech settings are unchanged. Other files retain their existing whole-file SHA-256 checks.

WebCrypto's [digest algorithm](https://www.w3.org/TR/webcrypto/#SubtleCrypto-method-digest) copies its input. Checking one large buffer can therefore briefly duplicate the weights. Bounded checks reduce that staging without implementing cryptography or adding a dependency. The original full-file SHA-256 is verified before generating the chunk pins; the runtime rejects mismatched metadata before reading, fetching or evicting cached data. Every fixed-size chunk and its ordered partial tail must match before any bytes enter the model or verified cache.

## Isolated loading A/B

The same local model stream, Chromium 156.0.8078.4 and fresh browser process trees were tested in three counterbalanced pairs for each acquisition path. The baseline is the loader immediately before this change, including the earlier cache-write streaming optimization. Cached runs first seed one profile on disk and restart the browser before every measured load. Windows Job Object accounting records peak browser commitment, including short spikes, and browser-tree CPU time. Controller and local file-server processes are excluded. The browser is muted. This test loads and verifies weights; it does not run inference or measure internet download latency.

| Weight load and verify, median of three | Baseline | Candidate |
| --- | ---: | ---: |
| Download: peak browser commitment | 3.080 GiB | 2.275 GiB |
| Download: completion | 2.539 s | 2.550 s |
| Download: browser-tree CPU | 4.906 CPU s | 4.719 CPU s |
| Cache: peak browser commitment | 2.849 GiB | 2.262 GiB |
| Cache: completion | 1.539 s | 1.275 s |
| Cache: browser-tree CPU | 2.656 CPU s | 2.281 CPU s |

All download pairs saved 818–831 MiB; completion was effectively unchanged (paired median +0.5%). Download CPU changes ranged from −5.0% to +8.3% (paired median +1.0%), so there is no established CPU gain on this path. All cache pairs saved 342–650 MiB. Cached completion improved 17.1–17.5%; paired median CPU improved 14.1% (range 0–21.9%). These are loading improvements, not inference or whole-session CPU claims.

Iteration mattered: chunk hashes alone consistently reduced download peaks but left cached peaks nearly unchanged. Streaming the cached response into the known-size buffer removed the additional cache-read staging bottleneck. This reuses the download reader, including bounded size checks, stall handling and cancellation, and avoids another reader implementation. Earlier prototype and chunk-only results are retained separately, including an early CPU pair contaminated by a short type/lint check; none of those CPU samples are pooled into the final table.

Local evidence lives in `artifacts/ram-verification-20261031/`: `prototype-results.json`, `production-results.json`, `warm-results.json`, `chunks.json`, the pinned baseline loader, and the measurement runner. Source hashes are embedded in the reports. The actual weight file was independently checked against its original full-file pin before each experiment. A first cached-run harness attempt reused a stale debug-port file; its failed report is retained, and successful runs remove that file before restarting Chromium.

## Startup continuity follow-up

A five-minute packaged article read under an enforced 6 GiB browser-job commit ceiling completed 35 chunks with a 4.93 GiB peak commitment. It exposed a startup gap that the earlier short mixed-engine capture did not cover: a 4.6-second ordinary paragraph played immediately while the next, longer paragraph needed 6.63 seconds to synthesize. That caused a 1.95-second unprepared handoff; 34 other event handoffs were prepared. This run does not pass continuous-playback acceptance.

The existing startup progress estimate previously guarded short headings and measured slow synthesis. It now also guards ordinary OmniVoice paragraphs when the next preload provides a remaining-time estimate. It releases playback when the existing safety margin fits within the opening clip's duration. This can add initial startup delay, without adding diffusion steps, extra speech requests or a larger preload queue. Tests verify that playback can start before the following request completes and that cancellation interrupts the wait.

The first constrained harness attempt stalled before narration because native browser attachment disabled Playwright's normal foreground defaults. The next run captured the startup stall but its bulk numeric audio export exhausted the test deadline. The harness now preserves flow and accounting before exporting each clip as base64 separately. Failed logs and the recovered trace remain available; they are not counted as passing audio-capture tests.

The adjusted application completed another five-minute capture with zero buffering waits and a maximum added render gap of 13.3 ms. Its Windows profile teardown encountered a locked WAL file after playback. Adding the standard `fs.rm` retries fixed that harness failure; a complete confirmation then passed, including stop and cleanup, with the application package unchanged:

| Confirmation read on the development host | Result |
| --- | ---: |
| Real-time playback observation | 300.8 s |
| Completed speech chunks | 35 |
| Prepared event handoffs / unprepared waits | 35 / 0 |
| Aligned render-thread handoffs between completed clips | 34 |
| Added render gap, p95 / maximum | 13.3 / 18.7 ms |
| Minimum source/capture correlation | 0.99999972 |
| Peak browser-job commitment | 5.068 GiB |
| Enforced browser-job ceiling | 6 GiB |

All 66 accounting observations confirmed the limit. All inspected browser processes were inside the job; one short-lived PID exited before inspection (Windows error 87), handled according to the existing hardware evidence contract. The precise job peak includes short-lived commitment between observations. Render capture reported no dropped frames. The same five engine algorithm sources still match the previously verified FP16/PCM candidates byte for byte.

These are Windows development-host results on the Core Ultra 9 / RTX 5090 setup, with 63.27 GiB system RAM and 32 GiB VRAM. A 6 GiB browser commitment ceiling does not simulate physical memory pressure, limit VRAM, include OS/driver/controller memory, or qualify an 8 GiB PC. This is muted AudioWorklet output, not OS/device loopback. Weaker dedicated GPUs and longer article/PDF/OCR sessions remain open. The full goal stays active.

## Verification and reproduction

With the pinned model already in `.cache/engine-models/`, check that bundled chunk metadata agrees with both the whole-file and ordered chunk hashes:

```powershell
node scripts/build-omnivoice-weight-chunks.mjs --check
```

Omit `--check` only when intentionally regenerating metadata from an independently evaluated pinned model. The script refuses a size or full SHA-256 mismatch before writing output. Existing frozen model pins are unchanged.

Unit checks cover bounded views of the original buffer, every chunk boundary and partial tail, reordering, truncation, malformed metadata, stale model pins, cancellation between native digests, corrupt cache eviction and verified replacement. Cached files continue to be verified offline. Real packaged playback and constrained-machine evidence are recorded separately from this isolated A/B.

The 1,438 engine, TTS and reader tests, both strict type checks, changed-file lint, and the production build passed. Run the explicit Windows playback check with an installed Chromium, local pinned fixtures, and a verified adapter LUID:

```powershell
$env:PN_E2E_SUSTAINED_OV = '1'
$env:PN_E2E_WORKERS = '1'
$env:PN_GPU_ADAPTER_LUID = '<verified-high,low-LUID>'
$env:PN_GPU_VENDOR = 'nvidia'
$env:PN_SUSTAINED_OUTPUT = 'artifacts/<new-output-directory>'
node node_modules/playwright/cli.js test tests/e2e/omnivoice-sustained.e2e.js --project=extension --reporter=line
python scripts/benchmarks/analyze-handoff-output.py $env:PN_SUSTAINED_OUTPUT
```

The harness always mutes physical output. `PN_SUSTAINED_COMMIT_GIB` defaults to 6; changing it does not change the model or playback acceptance thresholds. Use the pinned analysis Python environment. Complete evidence, source hashes and calculated paired summaries are in `artifacts/ram-verification-20261031/summary.json` and `sustained-confirmed/`.
