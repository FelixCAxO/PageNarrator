import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import { readFileSync } from 'node:fs';
import { resolveCandidateCommitSha } from './scripts/run-verification-gate.mjs';
import { copyOriginalPdfAssets } from './build/pdf-assets.js';
import {
  copyPublicRuntimeAssets,
  emitOnDemandContentScriptLoader,
  rejectRetiredRuntimeModules,
} from './build/runtime-assets.js';

const candidateId = process.env.PN_CANDIDATE_ID || resolveBuildCandidateId();
const outDir = process.env.PN_OUT_DIR || 'dist';
const isCwsCaptureLocalhost = process.env.PN_CWS_CAPTURE_LOCALHOST === '1';
let manifest = applyPreviewManifestPermissions(JSON.parse(readFileSync('./manifest.json', 'utf8')));

function resolveBuildCandidateId() {
  try {
    return resolveCandidateCommitSha({ env: process.env });
  } catch {
    return '';
  }
}

if (isCwsCaptureLocalhost) {
  manifest = {
    ...manifest,
    optional_host_permissions: Array.from(new Set([
      ...(manifest.optional_host_permissions || []),
      'http://127.0.0.1/*',
    ])),
  };
}

export function applyPreviewManifestPermissions(baseManifest, { preview = process.env.PN_PREVIEW === '1' } = {}) {
  const nextManifest = {
    ...baseManifest,
    host_permissions: Array.isArray(baseManifest?.host_permissions)
      ? [...baseManifest.host_permissions]
      : baseManifest?.host_permissions,
    optional_host_permissions: Array.isArray(baseManifest?.optional_host_permissions)
      ? [...baseManifest.optional_host_permissions]
      : baseManifest?.optional_host_permissions,
  };

  if (preview === true || preview === '1') {
    nextManifest.host_permissions = Array.from(new Set([
      ...(Array.isArray(nextManifest.host_permissions) ? nextManifest.host_permissions : []),
      'http://127.0.0.1/*',
      'http://localhost/*',
    ]));
  }

  return nextManifest;
}

export default defineConfig({
  base: './',
  plugins: [
    copyPublicRuntimeAssets(),
    crx({ manifest }),
    copyOriginalPdfAssets(),
    emitOnDemandContentScriptLoader(),
    rejectRetiredRuntimeModules(),
  ],
  define: {
    __PN_CANDIDATE_ID__: JSON.stringify(candidateId),
    'globalThis.__PN_CANDIDATE_ID__': JSON.stringify(candidateId),
  },
  build: {
    outDir,
    target: 'esnext',
    sourcemap: false,
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      input: {
        content: 'src/content.js',
        readerEngine: 'src/reader-engine.html',
        pdfViewer: 'src/pdf-viewer.html',
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  worker: { format: 'es', plugins: () => [rejectRetiredRuntimeModules()] },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5174 },
  },
  test: {
    include: ['tests/**/*.test.{js,mjs,ts}'],
    maxWorkers: 4,
    // The driver sends native module imports to Chromium; SSR rewriting breaks that browser code.
    server: { deps: { external: [/[\\/]scripts[\\/]lib[\\/]pdf-acceptance-browser\.mjs$/u] } },
    exclude: [
      '**/node_modules/**',
      '**/.git/**',
      '**/.claude/**',
      'tests/e2e/**',
      'tests/benchmarks/**', // Node test runner; covered by test:benchmarks.
      'tests/live/**',
      'tests/profiles/**',
    ],
    setupFiles: ['./tests/setup.js'],
  },
});
