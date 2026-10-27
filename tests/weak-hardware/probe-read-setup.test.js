import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { configureProbeRead } from '../live/tts-probe-controls.js';
import { clearResumePosition } from '../live/tts-probe-lifecycle.js';
import { getTtsProbeProfiles } from '../live/live-tts-hardware-profiles.js';
import { getResumePositionStorageKey } from '../../src/lib/storage-keys.js';

describe('benchmark read starting position', () => {
  const pdfUrl = 'data:application/pdf;base64,JVBERi0xLjQK';
  const documents = [
    { name: 'PDF', url: `chrome-extension://test/src/pdf-viewer.html?src=${encodeURIComponent(pdfUrl)}`, sourceUrl: pdfUrl },
    { name: 'article', url: 'https://example.test/article' },
  ];
  for (const document of documents) {
    it.each(['cold', 'warm'])(`clears the saved ${document.name} source position before a %s sample`, async phase => {
      const key = getResumePositionStorageKey(document.sourceUrl || document.url);
      const unrelated = getResumePositionStorageKey('https://example.test/another-document');
      const stored = new Map([[key, { chunk: 1, pageNumber: 2 }], [unrelated, { chunk: 7 }]]);
      const chrome = { storage: { local: {
        remove: async keys => { for (const name of Array.isArray(keys) ? keys : [keys]) stored.delete(name); },
        set: async values => { for (const [name, value] of Object.entries(values)) stored.set(name, value); },
      } } };
      const cdp = { send: async (method, { expression }) => {
        expect(method).toBe('Runtime.evaluate');
        return { result: { value: await runInNewContext(expression, { chrome }) } };
      } };
      if (phase === 'cold') await configureProbeRead(cdp, 'worker', document, getTtsProbeProfiles('native_wasm')[0]);
      else await clearResumePosition(cdp, 'worker', document);
      expect(stored.has(key)).toBe(false);
      expect(stored.get(unrelated)).toEqual({ chunk: 7 });
    });
  }
});
