import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import kokoroModels from '../../tests/fixtures/kokoro-models.json' with { type: 'json' };
import omniVoiceModels from '../../tests/fixtures/browser-speech-models.json' with { type: 'json' };
import { OMNIVOICE_ENCODER_DATA } from '../../src/tts/omnivoice/reference-encoder.js';
import { assertReleasePackage } from './assert-release-package.mjs';
import { downloadTestModels } from './download-test-models.mjs';

const journeys = ['omnivoice-read.e2e.js', 'omnivoice-settings.e2e.js', 'omnivoice-continuity.e2e.js', 'omnivoice-cloning.e2e.js'];

function journeyRoster(report) {
  if (report.errors?.length) throw new Error('OmniVoice browser run reported errors.');
  const roster = new Map();
  const visit = (suites, parents = []) => {
    for (const suite of suites || []) {
      const titles = [...parents, suite.title];
      for (const spec of suite.specs || []) {
        const file = spec.file?.replaceAll('\\', '/').split('/').at(-1);
        if (!journeys.includes(file)) throw new Error(`Unexpected OmniVoice journey file: ${spec.file}`);
        if (!spec.tests?.length) throw new Error(`Missing OmniVoice journey results: ${file}: ${spec.title}`);
        for (const test of spec.tests) {
          const key = JSON.stringify([file, ...titles, spec.title, test.projectId || '']);
          if (roster.has(key)) throw new Error(`Duplicate OmniVoice journey: ${file}: ${spec.title}`);
          if (test.expectedStatus !== 'passed') throw new Error(`Failed or skipped OmniVoice journey: ${file}: ${spec.title}`);
          roster.set(key, { file, title: spec.title, test });
        }
      }
      visit(suite.suites, titles);
    }
  };
  visit(report.suites);
  for (const journey of journeys) {
    if (![...roster.values()].some(item => item.file === journey)) throw new Error(`Missing OmniVoice journey: ${journey}`);
  }
  return roster;
}

export function verifyOmniVoiceReleaseReport(report, discovery) {
  const expected = journeyRoster(discovery), actual = journeyRoster(report);
  for (const [key, { file, title }] of expected) {
    if (!actual.has(key)) throw new Error(`Missing OmniVoice journey: ${file}: ${title}`);
  }
  for (const [key, { file, title, test }] of actual) {
    if (!expected.has(key)) throw new Error(`Unexpected OmniVoice journey: ${file}: ${title}`);
    if (!test.results?.length || test.results.some(result => result.status !== 'passed')) {
      throw new Error(`Failed or skipped OmniVoice journey: ${file}: ${title}`);
    }
  }
  return actual.size;
}

export async function runOmniVoiceReleaseTests({
  root = resolve(import.meta.dirname, '../..'), env = process.env,
  prepare = downloadTestModels, assertPackage = assertReleasePackage, run = spawnSync,
} = {}) {
  await assertPackage(resolve(root, env.PN_E2E_EXTENSION_DIR || 'dist'));
  await prepare({ fixtures: kokoroModels, root: resolve(root, env.PN_KOKORO_FIXTURE_DIR || '.cache/kokoro') });
  await prepare({ fixtures: { ...omniVoiceModels, files: [...omniVoiceModels.files, OMNIVOICE_ENCODER_DATA] },
    root: resolve(root, env.PN_BROWSER_MODEL_DIR || '.cache/engine-models') });
  const reportPath = join(root, 'artifacts/release-omnivoice/results.json');
  // Keep discovery outside Playwright's output directory, which it clears before execution.
  const rosterPath = join(root, 'artifacts/release-omnivoice-roster.json');
  mkdirSync(dirname(reportPath), { recursive: true });
  for (const file of [reportPath, rosterPath]) rmSync(file, { force: true });
  const args = [join(root, 'node_modules/@playwright/test/cli.js'), 'test',
    '--config', 'tooling/playwright.config.js', ...journeys.map(file => `tests/e2e/${file}`),
    '--project=extension', '--workers=1', '--retries=0', '--forbid-only'];
  const execute = (flags, path, stage) => {
    const result = run(process.execPath, [...args, ...flags], {
      cwd: root, stdio: 'inherit', env: { ...env, PN_E2E_OMNIVOICE: '1', PN_E2E_OMNIVOICE_CLONE: '1', PLAYWRIGHT_JSON_OUTPUT_FILE: path },
    });
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`OmniVoice ${stage} run terminated by ${result.signal}.`);
    if (result.status !== 0) throw new Error(`OmniVoice ${stage} run failed with exit code ${result.status ?? 'unknown'}.`);
    return JSON.parse(readFileSync(path, 'utf8'));
  };
  const discovery = execute(['--list', '--reporter=json'], rosterPath, 'discovery');
  journeyRoster(discovery);
  const report = execute(['--reporter=list,json', '--output=artifacts/release-omnivoice'], reportPath, 'browser');
  return { status: 'passed', tests: verifyOmniVoiceReleaseReport(report, discovery), reportPath, rosterPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runOmniVoiceReleaseTests().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
