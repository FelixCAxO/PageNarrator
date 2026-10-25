import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { resolveCandidateCommitSha } from './run-verification-gate.mjs';

export const LIVE_EXTENSION_PAGES_EVIDENCE_PATH = path.join('artifacts', 'live-extension-pages.json');

export function createLiveTestRunPlan({
  root = path.resolve(import.meta.dirname, '..'),
  env = process.env,
} = {}) {
  const vitestBin = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
  return {
    command: process.execPath,
    args: [
      vitestBin,
      'run',
      'tests/live/live-language-pages.test.js',
      'tests/live/live-extension-pages.test.js',
      '--config',
      'vitest.live.config.js',
    ],
    cwd: root,
    env: {
      ...env,
      PAGENARRATOR_LIVETEST: '1',
      PAGENARRATOR_LIVETEST_LANGUAGES: env.PAGENARRATOR_LIVETEST_LANGUAGES || 'en',
      PAGENARRATOR_CHROME: env.PAGENARRATOR_CHROME || chromium.executablePath(),
      PAGENARRATOR_LIVE_EVIDENCE_PATH: env.PAGENARRATOR_LIVE_EVIDENCE_PATH
        || path.join(root, LIVE_EXTENSION_PAGES_EVIDENCE_PATH).replaceAll('\\', '/'),
    },
  };
}

export function createLiveExtensionPagesEvidence({
  chromePath,
  commitSha,
  generatedAt = new Date().toISOString(),
  zeroFailures = false,
  config = {},
  languages = [],
} = {}) {
  const normalizedCommitSha = String(commitSha || '').trim();
  if (!/^[a-f0-9]{40}$/i.test(normalizedCommitSha)) {
    throw new Error('Live evidence commit SHA must be a full 40-character hexadecimal value.');
  }
  const normalizedLanguages = languages.map((language) => ({
    ...language,
    pageCount: language.pages?.length || 0,
    chunkCount: (language.pages || []).reduce((total, page) => total + Number(page.chunkCount || 0), 0),
  }));
  const totals = normalizedLanguages.reduce((summary, language) => ({
    languages: summary.languages + 1,
    pages: summary.pages + language.pageCount,
    chunks: summary.chunks + language.chunkCount,
  }), { languages: 0, pages: 0, chunks: 0 });

  return {
    schemaVersion: 2,
    generatedAt,
    commit_sha: normalizedCommitSha,
    chromePath,
    status: zeroFailures ? 'passed' : 'failed-or-incomplete',
    zeroFailures,
    failureCount: zeroFailures ? 0 : 1,
    config,
    totals,
    languages: normalizedLanguages,
  };
}

export function writeLiveExtensionPagesEvidence(evidence, {
  evidencePath = path.resolve(LIVE_EXTENSION_PAGES_EVIDENCE_PATH),
} = {}) {
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidencePath;
}

export function runLiveTests(plan = createLiveTestRunPlan()) {
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    stdio: 'inherit',
    env: plan.env,
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLiveTests();
}
