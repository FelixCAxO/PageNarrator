import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { getReaderEngineElements } from '../../src/lib/reader-engine-dom.js';

const REGISTRY_FILES = [
  'src/lib/reader-engine-dom.js',
  'src/ui/reader-engine/elements/player-elements.js',
  'src/ui/reader-engine/elements/settings-elements.js',
  'src/ui/reader-engine/elements/pdf-elements.js',
  'src/ui/reader-engine/elements/recovery-elements.js',
];

const CRITICAL_IDS = [
  'app-panel',
  'read-btn',
  'stop-btn',
  'prev-btn',
  'next-btn',
  'read-selected-btn',
  'language-select',
  'voice-select',
  'speed',
  'section-pause',
  'highlight-area-color',
  'skip-code-snippets',
  'pdf-page-nav',
  'pdf-page-jump-input',
  'error-notice',
  'extension-access-guidance',
  'resume-prompt',
  'code-suggestion',
];

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

function registryIds(path) {
  const source = read(path);
  return [
    ...source.matchAll(/:\s*byId\('([^']+)'\)/g),
    ...source.matchAll(/documentRef\.getElementById\('([^']+)'\)/g),
  ].map((match) => match[1]);
}

describe('readerEngine DOM registry', () => {
  it('keeps reader-engine-dom as a small feature registry composer', () => {
    const composer = read('src/lib/reader-engine-dom.js');

    expect(composer.split(/\r?\n/).length).toBeLessThanOrEqual(60);
    for (const path of REGISTRY_FILES.slice(1, 5)) {
      expect(registryIds(path).length, path).toBeLessThanOrEqual(50);
    }
  });

  it('resolves registered readerEngine elements from the readerEngine HTML', () => {
    const html = read('src/reader-engine.html');
    const document = new JSDOM(html).window.document;
    const elements = getReaderEngineElements(document);
    const missingIds = [];

    for (const [key, element] of Object.entries(elements)) {
      if (element === null || !element.id) continue;
      if (!document.getElementById(element.id)) missingIds.push(`${key}:${element.id}`);
    }

    expect(missingIds).toEqual([]);
    expect(elements.status?.id).toBe('status');
    expect(elements.statusLabel?.id).toBe('status-label');
    expect(elements.setupBar?.id).toBe('setup-progress-bar');
    expect(elements.setupProgress?.getAttribute('role')).toBe('progressbar');
  });

  it('registers each critical readerEngine ID exactly once', () => {
    const allIds = REGISTRY_FILES.flatMap(registryIds);
    const counts = new Map();

    for (const id of allIds) counts.set(id, (counts.get(id) || 0) + 1);

    expect(Object.fromEntries(CRITICAL_IDS.map((id) => [id, counts.get(id) || 0]))).toEqual(
      Object.fromEntries(CRITICAL_IDS.map((id) => [id, 1])),
    );
  });

  it('keeps readerEngine HTML and registry IDs unique', () => {
    const html = read('src/reader-engine.html');
    const document = new JSDOM(html).window.document;
    const htmlIds = [...document.querySelectorAll('[id]')].map((element) => element.id);
    const registeredIds = REGISTRY_FILES.flatMap(registryIds);

    expect(htmlIds).toHaveLength(new Set(htmlIds).size);
    expect(registeredIds).toHaveLength(new Set(registeredIds).size);
  });
});
