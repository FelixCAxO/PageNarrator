import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { injectOcrReferenceAdapter } from '../../tooling/scripts/lib/ocr-reference-adapter.mjs';

it('adapts the current OCR module and executes the reference backend at its inference boundary', async () => {
  const source = readFileSync('src/lib/pdf-ocr-unwarp.js', 'utf8');
  expect(() => injectOcrReferenceAdapter(source)).not.toThrow();
  const control = "export async function load() { const { createBrowserInferenceEngine } = await import('../engines/browser-inference.js'); return createBrowserInferenceEngine(); }";
  const previous = globalThis.__pnOcrReference;
  try {
    globalThis.__pnOcrReference = { backend: 'reference control' };
    const module = await import(`data:text/javascript,${encodeURIComponent(injectOcrReferenceAdapter(control))}`);
    expect(await module.load()).toMatchObject({ backend: 'reference control', dispose: expect.any(Function) });
  } finally { globalThis.__pnOcrReference = previous; }
});

it('rejects missing or ambiguous injection points rather than comparing the same backend twice', () => {
  expect(() => injectOcrReferenceAdapter('export const engine = 1;')).toThrow('injection point');
  const source = readFileSync('src/lib/pdf-ocr-unwarp.js', 'utf8');
  expect(() => injectOcrReferenceAdapter(source + source)).toThrow('injection point');
});
