import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const extensionDir = path.resolve(process.env.PN_E2E_EXTENSION_DIR || 'dist');
const configuredWorkers = Number.parseInt(process.env.PN_E2E_WORKERS || '2', 10);
const e2eWorkers = Number.isFinite(configuredWorkers) && configuredWorkers > 0
  ? configuredWorkers
  : 2;
const e2eHeaded = /^(1|true|yes)$/i.test(process.env.PN_E2E_HEADED || '');

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  timeout: 60_000,
  fullyParallel: false,
  workers: e2eWorkers,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    channel: 'chromium',
    headless: !e2eHeaded,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: [
        '--mute-audio',
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  projects: [
    {
      name: 'extension',
      testMatch: /^(?!.*(?:corpus|real-model-read)\.e2e\.js$).*\.e2e\.js/,
      fullyParallel: false,
      use: {
        extensionDir,
      },
    },
    {
      name: 'corpus',
      testMatch: /.*corpus\.e2e\.js/,
      fullyParallel: true,
      use: {
        extensionDir,
      },
    },
    {
      // Opt-in real Kokoro model journeys. The tests skip themselves unless
      // PN_E2E_REAL_MODEL=1 is set, so this project is safe to keep in the
      // default run; with the flag, run it alone via --project=real-model.
      name: 'real-model',
      testMatch: /.*real-model-read\.e2e\.js/,
      fullyParallel: false,
      use: {
        extensionDir,
      },
    },
  ],
});
