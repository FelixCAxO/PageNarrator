import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runOmniVoiceReleaseTests } from '../../tooling/scripts/run-omnivoice-release-tests.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const files = ['omnivoice-read.e2e.js', 'omnivoice-settings.e2e.js', 'omnivoice-continuity.e2e.js'];
function setup({ skip = false, missing = false, partial = false, replaced = false, duplicated = false, exitCode = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pn-omnivoice-release-'));
  roots.push(root);
  const discovery = files.map((file, index) => ({ title: file, file,
    specs: Array.from({ length: [1, 2, 7][index] }, (_, index) => ({
      file, title: `packaged journey ${index + 1}`, tests: [{ expectedStatus: 'passed', results: [] }],
    })), suites: [],
  }));
  const suites = structuredClone(discovery).slice(missing ? 1 : 0);
  for (const suite of suites) {
    if (partial) suite.specs = suite.specs.slice(0, 1);
    for (const spec of suite.specs) spec.tests[0].results = [{ status: skip ? 'skipped' : 'passed' }];
  }
  if (replaced) suites.at(-1).specs.at(-1).title = 'unrelated replacement';
  if (duplicated) suites.at(-1).specs.at(-1).title = suites.at(-1).specs[0].title;
  const cli = join(root, 'node_modules/@playwright/test/cli.js');
  mkdirSync(dirname(cli), { recursive: true });
  // Stand in only for the expensive browser process; exercise the real launcher,
  // environment, argument serialization, and report IO in a separate Node process.
  writeFileSync(cli, `const fs = require('node:fs');
    const collecting = process.argv.includes('--list');
    const calls = fs.existsSync('invocation.json') ? JSON.parse(fs.readFileSync('invocation.json')) : [];
    calls.push({ args: process.argv.slice(2), enabled: process.env.PN_E2E_OMNIVOICE });
    fs.writeFileSync('invocation.json', JSON.stringify(calls));
    fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, collecting
      ? ${JSON.stringify(JSON.stringify({ suites: discovery, errors: [] }))}
      : ${JSON.stringify(JSON.stringify({ suites, errors: [] }))});
    process.exitCode = collecting ? 0 : ${exitCode};`);
  return { root, env: { ...process.env, PN_E2E_OMNIVOICE: '0', PN_BROWSER_MODEL_DIR: 'fixture-models',
    PN_E2E_EXTENSION_DIR: 'dist', PN_KOKORO_FIXTURE_DIR: '.cache/kokoro' },
    assertPackage: async directory => {
      expect(directory).toBe(join(root, 'dist'));
    },
    prepare: async ({ fixtures, root: directory }) => {
      expect(fixtures.files.length).toBeGreaterThan(0);
      expect(directory).toBe(join(root, fixtures.modelId.startsWith('MarkShark2/') ? 'fixture-models' : '.cache/kokoro'));
    },
  };
}

it('prepares both pinned models and forces serial actual OmniVoice journeys even when disabled in the parent', async () => {
  const options = setup(), prepared = [];
  const result = await runOmniVoiceReleaseTests({ ...options, prepare: async input => {
    prepared.push(input.fixtures.modelId);
    await options.prepare(input);
  } });
  expect(prepared).toEqual(['onnx-community/Kokoro-82M-v1.0-ONNX', 'MarkShark2/omnivoice-onnx-kv-b1-fp16']);
  expect(result).toMatchObject({ status: 'passed', tests: 10 });
  const calls = JSON.parse(readFileSync(join(options.root, 'invocation.json'), 'utf8'));
  expect(calls).toHaveLength(2);
  expect(calls[0].args).toContain('--list');
  expect(calls[0].enabled).toBe('1');
  const invocation = calls.at(-1);
  expect(invocation.enabled).toBe('1');
  expect(invocation.args).toEqual(['test', '--config', 'tooling/playwright.config.js',
    'tests/e2e/omnivoice-read.e2e.js', 'tests/e2e/omnivoice-settings.e2e.js', 'tests/e2e/omnivoice-continuity.e2e.js',
    '--project=extension', '--workers=1', '--retries=0', '--forbid-only', '--reporter=list,json', '--output=artifacts/release-omnivoice']);
});

it('rejects a partial report even when every journey file contains a passing test', async () => {
  await expect(runOmniVoiceReleaseTests(setup({ partial: true }))).rejects.toThrow(/missing.*journey/i);
});

it.each([{ replaced: true }, { duplicated: true }])('rejects a same-size report that substitutes or duplicates a discovered journey: %j', async settings => {
  await expect(runOmniVoiceReleaseTests(setup(settings))).rejects.toThrow(/missing|duplicate|unexpected/i);
});

it.each([{ skip: true }, { missing: true }])('rejects a zero-exit browser run with incomplete journey evidence: %j', async settings => {
  await expect(runOmniVoiceReleaseTests(setup(settings))).rejects.toThrow(/skipped|missing/i);
});

it('fails before launching the browser when pinned models cannot be prepared', async () => {
  const options = setup();
  await expect(runOmniVoiceReleaseTests({ ...options, prepare: async () => { throw new Error('Pinned model unavailable'); } }))
    .rejects.toThrow('Pinned model unavailable');
  expect(existsSync(join(options.root, 'invocation.json'))).toBe(false);
});

it('fails on unavailable GPU/browser compute instead of accepting its test report', async () => {
  await expect(runOmniVoiceReleaseTests(setup({ exitCode: 7 }))).rejects.toThrow(/exit code 7/);
});

it('removes stale evidence and rejects a run that produces no fresh report', async () => {
  const options = setup();
  const report = join(options.root, 'artifacts/release-omnivoice/results.json');
  mkdirSync(dirname(report), { recursive: true }); writeFileSync(report, '{"status":"passed"}');
  await expect(runOmniVoiceReleaseTests({ ...options, run: () => ({ status: 0 }) })).rejects.toThrow(/ENOENT/);
  expect(existsSync(report)).toBe(false);
});

it('rejects a browser launch failure without reporting qualification', async () => {
  const options = setup();
  await expect(runOmniVoiceReleaseTests({ ...options,
    run: (_command, args, config) => spawnSync('pn-browser-executable-that-does-not-exist', args, config),
  })).rejects.toThrow(/ENOENT/);
});
