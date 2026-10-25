import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import {
  formatMemoryBytes,
  profileMemorySteps,
  readRuntimeMemoryUsage,
  summarizeMemoryUsage,
} from './memory-usage-profile.mjs';
import { buildReadingModel, renderReadingModelForSpeechChunks } from '../src/lib/reading-model.js';
import { chunkText } from '../src/lib/speech-chunks.js';

export function createMemoryProfileArticleHtml({ paragraphCount = 600 } = {}) {
  const count = Math.max(1, Math.trunc(Number(paragraphCount)) || 1);
  const paragraphs = Array.from({ length: count }, (_, index) => `
        <p>
          Section ${index + 1} explains how PageNarrator keeps long reads responsive
          while model setup, article extraction, speech chunking, and highlighting
          reuse a bounded amount of browser memory for optimization testing.
        </p>
  `).join('\n');

  return `<!doctype html>
    <html lang="en">
      <head>
        <title>Memory profile article</title>
      </head>
      <body>
        <main>
          <article>
            <h1>Memory profile article</h1>
            ${paragraphs}
          </article>
        </main>
      </body>
    </html>`;
}

export function createReaderPipelineMemoryProfileSteps({
  html = createMemoryProfileArticleHtml(),
  maxChunkLength = 320,
  targetMinLength = 180,
  url = 'https://example.test/memory-profile',
} = {}, state = {}) {
  return [
    {
      name: 'create-jsdom-document',
      run() {
        state.dom = new JSDOM(html, { url });
        state.document = state.dom.window.document;
      },
    },
    {
      name: 'build-reading-model',
      run() {
        state.model = buildReadingModel(state.document);
      },
    },
    {
      name: 'render-speech-chunks',
      run() {
        state.speechChunks = renderReadingModelForSpeechChunks(state.model);
        state.article = {
          title: state.model.title,
          text: state.speechChunks.map((chunk) => chunk.speech).join('\n\n'),
          chunks: state.speechChunks,
        };
      },
    },
    {
      name: 'chunk-for-tts',
      run() {
        state.ttsChunks = chunkText(state.speechChunks, maxChunkLength, { targetMinLength });
      },
    },
  ];
}

export function formatMemoryProfileTable(reports) {
  return reports.map((report) => ({
    step: report.name,
    heapBefore: formatMemoryBytes(report.beforeBytes),
    heapAfter: formatMemoryBytes(report.afterBytes),
    heapDelta: formatMemoryBytes(report.deltaBytes),
    rssDelta: formatMemoryBytes(report.rssDeltaBytes),
    durationMs: Number.isFinite(report.durationMs) ? report.durationMs.toFixed(1) : 'n/a',
    source: report.source,
  }));
}

async function main() {
  const paragraphCount = readPositiveIntegerEnv('PN_MEMORY_PROFILE_PARAGRAPHS', 600);
  const maxChunkLength = readPositiveIntegerEnv('PN_MEMORY_PROFILE_MAX_CHUNK', 320);
  const targetMinLength = readPositiveIntegerEnv('PN_MEMORY_PROFILE_TARGET_MIN', 180);
  const state = {};

  try {
    const reports = await profileMemorySteps(createReaderPipelineMemoryProfileSteps({
      html: createMemoryProfileArticleHtml({ paragraphCount }),
      maxChunkLength,
      targetMinLength,
    }, state), {
      readMemoryUsage: () => readRuntimeMemoryUsage({ performance: {}, process }),
      forceGarbageCollection: globalThis.gc,
    });
    const summary = summarizeMemoryUsage(reports);

    console.log('PageNarrator reader-pipeline memory profile');
    console.log(`Article size: ${paragraphCount} paragraphs`);
    console.table(formatMemoryProfileTable(reports));
    console.log(`Total retained heap: ${formatMemoryBytes(summary.totalDeltaBytes)}`);
    if (summary.largestIncrease) {
      console.log(`Largest heap increase: ${summary.largestIncrease.name} (${formatMemoryBytes(summary.largestIncrease.deltaBytes)})`);
    }
    if (process.env.PN_MEMORY_PROFILE_OUTPUT) {
      await writeFile(process.env.PN_MEMORY_PROFILE_OUTPUT, `${JSON.stringify({ paragraphCount, reports, summary }, null, 2)}\n`);
    }
  } finally {
    state.dom?.window?.close();
  }
}

function readPositiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
