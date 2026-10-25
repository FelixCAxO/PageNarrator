import { describe, expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import {
  createLiveExtensionPagesEvidence,
  createLiveTestRunPlan,
} from '../../scripts/run-live-tests.mjs';
import { createLiveTtsProbeRunPlan } from '../../scripts/run-live-tts-probe.mjs';

describe('live extension page runner', () => {
  it('uses the live Vitest config so root test exclusions do not hide live tests', () => {
    const plan = createLiveTestRunPlan({
      root: 'F:/PageNarrator',
      env: {
        PATH: 'test-path',
      },
    });

    expect(plan.command).toMatch(/node(\.exe)?$/i);
    expect(plan.args).toContain('run');
    expect(plan.args).toContain('tests/live/live-language-pages.test.js');
    expect(plan.args).toContain('tests/live/live-extension-pages.test.js');
    expect(plan.args).toContain('--config');
    expect(plan.args).toContain('vitest.live.config.js');
    expect(plan.env).toMatchObject({
      PATH: 'test-path',
      PAGENARRATOR_LIVETEST: '1',
      PAGENARRATOR_LIVETEST_LANGUAGES: 'en',
      PAGENARRATOR_LIVE_EVIDENCE_PATH: 'F:/PageNarrator/artifacts/live-extension-pages.json',
    });
    expect(plan.env.PAGENARRATOR_CHROME).toBe(chromium.executablePath());
    expect(createLiveTtsProbeRunPlan({ root: 'F:/PageNarrator', env: {} }).env.PAGENARRATOR_CHROME).toBe(chromium.executablePath());
  });

  it('keeps an explicit live evidence path override', () => {
    const plan = createLiveTestRunPlan({
      root: 'F:/PageNarrator',
      env: {
        PAGENARRATOR_LIVE_EVIDENCE_PATH: 'F:/tmp/live.json',
      },
    });

    expect(plan.env.PAGENARRATOR_LIVE_EVIDENCE_PATH).toBe('F:/tmp/live.json');
  });

  it('summarizes live evidence page and chunk counts with zero-failure status', () => {
    const evidence = createLiveExtensionPagesEvidence({
      chromePath: 'C:/Chrome/chrome.exe',
      commitSha: 'a'.repeat(40),
      generatedAt: '2026-07-07T00:00:00.000Z',
      zeroFailures: true,
      languages: [
        {
          code: 'en',
          label: 'English',
          pages: [
            { name: 'Internet', url: 'https://en.wikipedia.org/wiki/Internet', chunkCount: 2 },
            { name: 'Software', url: 'https://en.wikipedia.org/wiki/Software', chunkCount: 1 },
          ],
        },
        {
          code: 'sv',
          label: 'Swedish',
          pages: [
            { name: 'Internet', url: 'https://sv.wikipedia.org/wiki/Internet', chunkCount: 1 },
          ],
        },
      ],
    });

    expect(evidence).toMatchObject({
      schemaVersion: 2,
      chromePath: 'C:/Chrome/chrome.exe',
      commit_sha: 'a'.repeat(40),
      generatedAt: '2026-07-07T00:00:00.000Z',
      status: 'passed',
      zeroFailures: true,
      failureCount: 0,
      totals: {
        languages: 2,
        pages: 3,
        chunks: 4,
      },
    });
    expect(evidence).not.toHaveProperty('localRead');
    expect(evidence.languages[0].pages[0]).toMatchObject({
      url: 'https://en.wikipedia.org/wiki/Internet',
      chunkCount: 2,
    });
  });
});
