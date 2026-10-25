import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Separate from the ordinary PDF.js development oracle lane. No production alias.
export default defineConfig({
  resolve: { alias: [{ find: 'pdfjs-dist/legacy/build/pdf.mjs', replacement: fileURLToPath(new URL('./original-corpus-backend.js', import.meta.url)) }] },
  test: {
    include: [
      'tests/pdf/pdf-1000-corpus-e2e.test.js',
      'tests/pdf/pdf-100-types-flow-benchmark.test.js',
      'tests/pdf/pdf-wild-acceptance.test.js',
      'tests/pdf/pdf-summer2026-corpus.test.js',
    ],
    setupFiles: ['./tests/setup.js'], maxWorkers: 1, testTimeout: 120000, hookTimeout: 120000,
  },
});
