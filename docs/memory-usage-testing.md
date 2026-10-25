# Memory testing

The memory harness measures retained JavaScript heap around named steps. Node runs also report process RSS changes for native allocations.

```sh
npm run test:profiles
npm run profile:memory
```

Profiles force garbage collection before and after each step. They measure retained memory, not temporary peaks. To refresh the checked baseline, set `PN_MEMORY_PROFILE_OUTPUT=tests/profiles/baselines/reader-pipeline-memory.json`.

## Reader profile

| Step | Work |
| --- | --- |
| `create-jsdom-document` | Build the test article. |
| `build-reading-model` | Extract the reading model. |
| `render-speech-chunks` | Produce speech sections. |
| `chunk-for-tts` | Apply the current speech chunk limits. |

Reports include heap before/after, heap and RSS changes, duration, and snapshot source. Start with the largest positive heap change and compare the same workload after a fix.

## Workload controls

```sh
PN_MEMORY_PROFILE_PARAGRAPHS=1200 npm run profile:memory
PN_MEMORY_PROFILE_MAX_CHUNK=240 PN_MEMORY_PROFILE_TARGET_MIN=120 npm run profile:memory
```

These variables set article length and speech chunk limits. Balanced CPU / WebAssembly can queue three complete 240-character sections. Battery saver uses smaller limits. High-quality WebGPU queues the current section and four ahead.

The 600-paragraph baseline test allows 20% growth in total retained heap and the largest step. The low-power test checks final RSS against `src/lib/tuning-config.js`. The long-session test repeats the pipeline ten times and checks retained growth. Test files: `tests/profiles/memory-usage-profile.test.js`, `tests/profiles/lowpower-corpus-memory.test.js`, and `tests/profiles/long-session-memory.test.js`.

## PDF memory

The PDF viewer owns one parsed document. The offscreen reader requests metadata and speech sections from it. Page-based progress avoids scanning the whole book before narration.

Rendering uses a bounded page window. Stop and idle cleanup release pages, streams, highlights, transcripts, queues, audio, and model buffers. The next read reloads the voice from browser cache. PDFs are fetched in full within the source-size limit before parsing; large-document startup needs separate measurement.
