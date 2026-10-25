import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/live/**/*.test.js'],
    exclude: [
      '**/node_modules/**',
      '**/.git/**',
      '**/.claude/**',
    ],
    setupFiles: ['./tests/setup.js'],
  },
});
