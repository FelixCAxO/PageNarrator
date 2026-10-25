import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createReaderEngineRuntimeApp } from '../../src/app/reader-engine/reader-engine-runtime.js';

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

describe('readerEngine composition boundary', () => {
  it('keeps the legacy reader-engine-app path as a thin compatibility re-export', () => {
    expect(read('src/lib/reader-engine-app.js').trim()).toBe(
      "export { createReaderEngineApp } from '../app/reader-engine/create-reader-engine-app.js';",
    );
  });

  it('keeps the readerEngine composition root small and module-oriented', () => {
    const composition = read('src/app/reader-engine/create-reader-engine-app.js');

    expect(composition.split(/\r?\n/).length).toBeLessThan(250);
    expect(composition).toContain("from '../../reader/reader-session.js'");
    expect(composition).toContain("from '../../reader/read-runner.js'");
    expect(composition).toContain("from '../../tts/tts-service.js'");
    expect(composition).toContain("from '../../ui/reader-engine/reader-engine-controller.js'");
    expect(composition).not.toMatch(/kokoro|piper|onnx|pdf-extraction|chrome\.storage/i);
  });

  it('keeps the UI controller away from engine and storage primitives', () => {
    const controller = read('src/ui/reader-engine/reader-engine-controller.js');

    expect(controller).not.toMatch(/kokoro|piper|onnx|pdf-extraction|storage-keys|chrome\.storage/i);
    expect(controller).not.toMatch(/bind\(\) \{\}|render\(\) \{\}/);
  });

  it('uses the product core instead of a parallel runtime state graph', () => {
    const runtime = read('src/app/reader-engine/reader-engine-runtime.js');

    expect(runtime).toContain('productCore');
    expect(runtime).not.toContain('// @ts-nocheck');
    expect(runtime).not.toMatch(/let readingState =|let activeChunks =|let tts = null/);
  });

  it('keeps the Chrome adapter platform-shaped', () => {
    const adapter = read('src/platform/chrome/reader-engine-chrome-adapter.js');

    expect(adapter).not.toContain('// @ts-nocheck');
    expect(adapter).not.toMatch(/void readRunner/);
    expect(adapter).not.toMatch(/let readingState|let activeChunks|let currentChunk|let activeReadTabId/);
    expect(adapter).not.toMatch(/let tts\b/);
    expect(adapter).not.toMatch(/ensureVoiceModel|releaseVoiceModel|releasePiperEngine|releaseKokoroPhonemizeRuntime/);
  });

  it('does not discard the product read runner in the readerEngine session', () => {
    const session = read('src/app/reader-engine/reader-engine-session.js');

    expect(session).not.toMatch(/void readRunner/);
    expect(session).toContain('readRunner.startPage');
  });

  it('keeps copied read state out of the readerEngine session', () => {
    const session = read('src/app/reader-engine/reader-engine-session.js');

    expect(session).not.toMatch(/let readingState\s*=|let activeChunks\s*=|let currentChunk\s*=|let activeReadTabId\s*=/);
  });

  it('binds read controls after startup state is loaded', () => {
    const session = read('src/app/reader-engine/reader-engine-session.js');

    expect(session.indexOf('await loadPanelTargetTab();')).toBeLessThan(
      session.indexOf('controller.bind?.({'),
    );
  });

  it('keeps direct runtime construction compatible by creating a default product core', () => {
    const runtime = createReaderEngineRuntimeApp({
      document: { getElementById: () => null },
      chrome: {},
      navigator: {},
      performance: { now: () => 0 },
      window: {},
    });

    expect(runtime).toEqual(expect.objectContaining({
      start: expect.any(Function),
    }));
  });

  it('owns content feature implementations in the reader folders', () => {
    expect(read('src/reader/extraction/content-extraction.js')).not.toContain('../../content-extraction.js');
    expect(read('src/reader/highlighting/content-highlight.js')).not.toContain('../../content-highlight.js');

    expect(read('src/content.js')).toContain("import('./reader/extraction/content-extraction.js')");
    expect(read('src/content.js')).toContain("import('./reader/highlighting/content-highlight.js')");
  });
});
