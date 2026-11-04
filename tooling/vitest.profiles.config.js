import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/profiles/memory-usage-profile.test.js',
      'tests/profiles/tts-performance-profile.test.js',
      'tests/profiles/tuning-config.test.js',
      'tests/profiles/lowpower-corpus-memory.test.js',
      'tests/profiles/long-session-memory.test.js',
      'tests/profiles/pdf-memory-profile.test.js',
      'tests/profiles/pdf-viewer-profile.test.js',
      'tests/live/live-tts-hardware-profiles.test.js',
    ],
    exclude: [
      '**/node_modules/**',
      '**/.git/**',
      '**/.claude/**',
      'tests/e2e/**',
    ],
    setupFiles: ['./tests/setup.js'],
    // Vitest 4: `--expose-gc` only propagates to fork workers via the top-level
    // `test.execArgv`; `poolOptions.forks.execArgv` is silently ignored here.
    // The long-session memory profile hard-requires `globalThis.gc`.
    pool: 'forks',
    execArgv: ['--expose-gc'],
  },
});
