import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  formatMemoryBytes,
  profileMemorySteps,
  readRuntimeMemoryUsage,
  summarizeMemoryUsage,
} from '../../scripts/memory-usage-profile.mjs';
import { buildReadingModel, renderReadingModelForSpeechChunks } from '../../src/lib/reading-model.js';
import { chunkText } from '../../src/lib/speech-chunks.js';
import {
  createMemoryProfileArticleHtml,
  createReaderPipelineMemoryProfileSteps,
} from '../../scripts/profile-memory-usage.mjs';

describe('memory usage profiling', () => {
  it('records retained memory for each named step without storing step results', async () => {
    const snapshots = [
      { usedBytes: 1000, rssBytes: 5000, source: 'test-reader' },
      { usedBytes: 2500, rssBytes: 6500, source: 'test-reader' },
      { usedBytes: 2500, rssBytes: 6500, source: 'test-reader' },
      { usedBytes: 1800, rssBytes: 6200, source: 'test-reader' },
    ];
    const timestamps = [10, 15, 15, 21];
    const state = {};

    const reports = await profileMemorySteps([
      {
        name: 'extract-readable-article',
        run() {
          state.article = { chunks: ['alpha', 'beta'] };
          return { shouldNotBeRetained: true };
        },
      },
      {
        name: 'chunk-for-tts',
        run() {
          state.ttsChunks = state.article.chunks;
        },
      },
    ], {
      readMemoryUsage: () => snapshots.shift(),
      now: () => timestamps.shift(),
    });

    expect(reports).toEqual([
      {
        name: 'extract-readable-article',
        beforeBytes: 1000,
        afterBytes: 2500,
        deltaBytes: 1500,
        rssBeforeBytes: 5000,
        rssAfterBytes: 6500,
        rssDeltaBytes: 1500,
        durationMs: 5,
        source: 'test-reader',
      },
      {
        name: 'chunk-for-tts',
        beforeBytes: 2500,
        afterBytes: 1800,
        deltaBytes: -700,
        rssBeforeBytes: 6500,
        rssAfterBytes: 6200,
        rssDeltaBytes: -300,
        durationMs: 6,
        source: 'test-reader',
      },
    ]);
    expect(reports[0]).not.toHaveProperty('result');
    expect(state.ttsChunks).toEqual(['alpha', 'beta']);
  });

  it('summarizes retained memory and the largest increasing step', () => {
    const summary = summarizeMemoryUsage([
      { name: 'extract', beforeBytes: 1000, afterBytes: 2400, deltaBytes: 1400 },
      { name: 'chunk', beforeBytes: 2400, afterBytes: 2100, deltaBytes: -300 },
      { name: 'render', beforeBytes: 2100, afterBytes: 3200, deltaBytes: 1100 },
    ]);

    expect(summary).toEqual({
      totalDeltaBytes: 2200,
      largestIncrease: {
        name: 'extract',
        deltaBytes: 1400,
      },
    });
  });

  it('keeps deterministic profile scenarios inside concrete byte budgets', async () => {
    const snapshots = [
      { usedBytes: 10_000, source: 'budget-test' },
      { usedBytes: 250_000, source: 'budget-test' },
      { usedBytes: 250_000, source: 'budget-test' },
      { usedBytes: 450_000, source: 'budget-test' },
      { usedBytes: 450_000, source: 'budget-test' },
      { usedBytes: 550_000, source: 'budget-test' },
      { usedBytes: 550_000, source: 'budget-test' },
      { usedBytes: 650_000, source: 'budget-test' },
      { usedBytes: 650_000, source: 'budget-test' },
      { usedBytes: 720_000, source: 'budget-test' },
      { usedBytes: 720_000, source: 'budget-test' },
      { usedBytes: 760_000, source: 'budget-test' },
    ];

    const reports = await profileMemorySteps([
      { name: 'dom', run() {} },
      { name: 'model', run() {} },
      { name: 'speech', run() {} },
      { name: 'chunks', run() {} },
      { name: 'queue', run() {} },
      { name: 'cleanup', run() {} },
    ], {
      readMemoryUsage: () => snapshots.shift(),
      now: () => 0,
    });

    expect(reports[0].deltaBytes).toBeLessThan(2_000_000);
    expect(reports[1].deltaBytes).toBeLessThan(2_000_000);
    expect(reports[2].deltaBytes).toBeLessThan(2_000_000);
    expect(reports[3].deltaBytes).toBeLessThan(2_000_000);
    expect(reports[4].deltaBytes).toBeLessThan(2_000_000);
    expect(reports[5].deltaBytes).toBeLessThan(2_000_000);
  });

  it('reads runtime memory from Node when browser heap metrics are unavailable', () => {
    const snapshot = readRuntimeMemoryUsage({ performance: {}, process });

    expect(snapshot.source).toBe('process.memoryUsage');
    expect(snapshot.usedBytes).toBeGreaterThan(0);
    expect(snapshot.totalBytes).toBeGreaterThanOrEqual(snapshot.usedBytes);
    expect(snapshot.rssBytes).toBeGreaterThanOrEqual(snapshot.usedBytes);
  });

  it('formats memory byte counts for compact reports', () => {
    expect(formatMemoryBytes(0)).toBe('0 B');
    expect(formatMemoryBytes(512)).toBe('512 B');
    expect(formatMemoryBytes(1536)).toBe('1.5 KiB');
    expect(formatMemoryBytes(2 * 1024 * 1024)).toBe('2.0 MiB');
    expect(formatMemoryBytes(null)).toBe('n/a');
  });

  it('profiles real article extraction and speech chunking with runtime memory snapshots', async () => {
    const state = {};
    const html = createMemoryProfileArticleHtml({ paragraphCount: 80 });

    const reports = await profileMemorySteps([
      {
        name: 'create-jsdom-document',
        run() {
          state.dom = new JSDOM(html, { url: 'https://example.test/memory-profile' });
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
        },
      },
      {
        name: 'chunk-for-tts',
        run() {
          state.ttsChunks = chunkText(state.speechChunks, 320, { targetMinLength: 180 });
        },
      },
    ], {
      readMemoryUsage: () => readRuntimeMemoryUsage({ performance: {}, process }),
    });

    expect(reports.map((report) => report.name)).toEqual([
      'create-jsdom-document',
      'build-reading-model',
      'render-speech-chunks',
      'chunk-for-tts',
    ]);
    expect(reports.every((report) => Number.isFinite(report.beforeBytes))).toBe(true);
    expect(reports.every((report) => Number.isFinite(report.afterBytes))).toBe(true);
    expect(reports.every((report) => Number.isFinite(report.durationMs))).toBe(true);
    expect(state.ttsChunks.length).toBeGreaterThan(10);

    state.dom.window.close();
  });

  it('keeps the real reader-pipeline profile within the checked-in memory budget', async () => {
    const baseline = JSON.parse(readFileSync(
      new URL('./baselines/reader-pipeline-memory.json', import.meta.url),
      'utf8',
    ));
    const state = {};

    const reports = await profileMemorySteps(createReaderPipelineMemoryProfileSteps({
      html: createMemoryProfileArticleHtml({ paragraphCount: baseline.paragraphCount }),
    }, state), {
      readMemoryUsage: () => readRuntimeMemoryUsage({ performance: {}, process }),
      forceGarbageCollection: globalThis.gc,
    });
    const summary = summarizeMemoryUsage(reports);

    expect(summary.totalDeltaBytes).toBeLessThanOrEqual(
      Math.ceil(baseline.summary.totalDeltaBytes * 1.20),
    );
    expect(summary.largestIncrease.deltaBytes).toBeLessThanOrEqual(
      Math.ceil(baseline.summary.largestIncrease.deltaBytes * 1.20),
    );

    state.dom.window.close();
  });

  it('writes the real reader-pipeline memory profile as JSON when requested', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pagenarrator-memory-profile-'));
    const outputPath = join(tempDir, 'reader-pipeline-memory.json');

    try {
      execFileSync(process.execPath, ['--expose-gc', 'scripts/profile-memory-usage.mjs'], {
        cwd: new URL('../..', import.meta.url),
        env: {
          ...process.env,
          PN_MEMORY_PROFILE_OUTPUT: outputPath,
          PN_MEMORY_PROFILE_PARAGRAPHS: '12',
        },
        stdio: 'pipe',
      });

      expect(existsSync(outputPath)).toBe(true);
      const output = JSON.parse(readFileSync(outputPath, 'utf8'));
      expect(output.paragraphCount).toBe(12);
      expect(output.reports.map((report) => report.name)).toEqual([
        'create-jsdom-document',
        'build-reading-model',
        'render-speech-chunks',
        'chunk-for-tts',
      ]);
      expect(output.summary.totalDeltaBytes).toEqual(expect.any(Number));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('builds reader-pipeline profile steps in the order needed for optimization runs', async () => {
    const state = {};
    const steps = createReaderPipelineMemoryProfileSteps({
      html: createMemoryProfileArticleHtml({ paragraphCount: 12 }),
      maxChunkLength: 160,
      targetMinLength: 90,
    }, state);

    expect(steps.map((step) => step.name)).toEqual([
      'create-jsdom-document',
      'build-reading-model',
      'render-speech-chunks',
      'chunk-for-tts',
    ]);

    for (const step of steps) {
      await step.run();
    }

    expect(state.article.text).toContain('Memory profile article');
    expect(state.speechChunks.length).toBeGreaterThan(1);
    expect(state.ttsChunks.length).toBeGreaterThan(1);

    state.dom.window.close();
  });

  it('exposes a package script for optimization memory reports', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

    expect(packageJson.scripts['profile:memory']).toBe('node --expose-gc scripts/profile-memory-usage.mjs');
    expect(packageJson.scripts['test:profiles']).toBe('vitest run --config vitest.profiles.config.js');
  });
});
