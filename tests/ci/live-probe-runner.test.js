import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createLiveTtsProbeRunPlan } from '../../scripts/run-live-tts-probe.mjs';
import { LOWER_SPEC_TTS_PROBE_PROFILE_SET, getTtsProbeProfiles } from '../live/live-tts-hardware-profiles.js';

const TEST_REVISION = { shortSha: '0123456789ab', dirty: true };
const TEST_RUN_ID = '20261005T080000Z-c0ffee';

describe('live TTS probe runner', () => {
  it('runs the live probe with a serialized worker pool and probe environment by default', () => {
    const plan = createLiveTtsProbeRunPlan({
      root: 'F:/PageNarrator',
      revision: TEST_REVISION,
      runId: TEST_RUN_ID,
      env: {
        PATH: 'test-path',
      },
    });

    expect(plan.command).toMatch(/node(\.exe)?$/i);
    expect(plan.args).toContain('run');
    expect(plan.args).toContain('tests/live/live-tts-hardware-probe.test.js');
    expect(plan.args).toContain('--config');
    expect(plan.args).toContain('vitest.live.config.js');
    expect(plan.args).toContain('--pool=forks');
    expect(plan.args).toContain('--maxWorkers=1');
    expect(plan.jobs).toHaveLength(1);
    expect(plan.maxWorkers).toBe(1);
    expect(plan.env).toMatchObject({
      PATH: 'test-path',
      PAGENARRATOR_TTS_PROBE: '1',
      PAGENARRATOR_TTS_PROBE_RUN_ID: TEST_RUN_ID,
      PAGENARRATOR_TTS_PROBE_MODE: 'isolated',
    });
  });

  it('keeps isolated probe runs serial even when more workers are requested', () => {
    const plan = createLiveTtsProbeRunPlan({
      root: 'F:/PageNarrator',
      revision: TEST_REVISION,
      runId: TEST_RUN_ID,
      env: {
        PAGENARRATOR_TTS_PROBE_MAX_WORKERS: '2',
      },
    });

    expect(plan.schedulingMode).toBe('isolated');
    expect(plan.requestedWorkers).toBe(2);
    expect(plan.maxWorkers).toBe(1);
  });

  it('runs parallel profile jobs only in explicitly labelled contention mode', () => {
    const plan = createLiveTtsProbeRunPlan({
      root: 'F:/PageNarrator',
      revision: TEST_REVISION,
      runId: TEST_RUN_ID,
      env: {
        PAGENARRATOR_TTS_PROBE_MAX_WORKERS: '2',
        PAGENARRATOR_TTS_PROBE_MODE: 'contention',
      },
    });

    expect(plan.schedulingMode).toBe('contention');
    expect(plan.maxWorkers).toBe(2);
    expect(plan.env.PAGENARRATOR_TTS_PROBE_MODE).toBe('contention');
  });

  it('splits lower-spec profile runs into independent jobs with distinct run-scoped artifacts', () => {
    const profiles = getTtsProbeProfiles(LOWER_SPEC_TTS_PROBE_PROFILE_SET);
    const plan = createLiveTtsProbeRunPlan({
      root: 'F:/PageNarrator',
      revision: TEST_REVISION,
      runId: TEST_RUN_ID,
      env: {
        PAGENARRATOR_TTS_PROBE_PROFILE: LOWER_SPEC_TTS_PROBE_PROFILE_SET,
      },
    });

    expect(plan.jobs).toHaveLength(profiles.length);
    expect(plan.maxWorkers).toBe(1);
    expect(plan.jobs.map((job) => job.env.PAGENARRATOR_TTS_PROBE_PROFILE)).toEqual(
      profiles.map((profile) => profile.name),
    );
    expect(new Set(plan.jobs.map((job) => job.env.PAGENARRATOR_TTS_PROBE_OUTPUT)).size).toBe(profiles.length);
  });

  it('keeps split lower-spec probe jobs on article-only documents by default', () => {
    const plan = createLiveTtsProbeRunPlan({
      root: 'F:/PageNarrator',
      revision: TEST_REVISION,
      runId: TEST_RUN_ID,
      env: {
        PAGENARRATOR_TTS_PROBE_PROFILE: LOWER_SPEC_TTS_PROBE_PROFILE_SET,
      },
    });

    expect(plan.jobs.map((job) => job.env.PAGENARRATOR_TTS_PROBE_DOCUMENTS))
      .toEqual(plan.jobs.map(() => 'article'));
  });

  it('keeps a single-profile PDF probe artifact distinct from the article matrix artifact', () => {
    const plan = createLiveTtsProbeRunPlan({
      root: 'F:/PageNarrator',
      revision: TEST_REVISION,
      runId: TEST_RUN_ID,
      env: {
        PAGENARRATOR_TTS_PROBE_PROFILE: '4gb_4cpu_low_memory',
        PAGENARRATOR_TTS_PROBE_DOCUMENTS: 'pdf',
      },
    });

    expect(plan.jobs).toHaveLength(1);
    expect(plan.jobs[0].env.PAGENARRATOR_TTS_PROBE_OUTPUT.replaceAll('\\', '/'))
      .toBe(`F:/PageNarrator/artifacts/weak-hardware/0123456789ab-dirty/${TEST_RUN_ID}/tts-hardware-probe-4gb_4cpu_low_memory-pdf.json`);
  });

  it('splits the requirements profile set into independent artifact jobs', () => {
    const plan = createLiveTtsProbeRunPlan({
      root: 'F:/PageNarrator',
      revision: TEST_REVISION,
      runId: TEST_RUN_ID,
      env: {
        PAGENARRATOR_TTS_PROBE_PROFILE: 'requirements',
      },
    });

    expect(plan.jobs.length).toBeGreaterThan(2);
    expect(plan.jobs.map((job) => job.env.PAGENARRATOR_TTS_PROBE_OUTPUT.replaceAll('\\', '/')))
      .toContain(`F:/PageNarrator/artifacts/weak-hardware/0123456789ab-dirty/${TEST_RUN_ID}/tts-hardware-probe-8gb_4cpu_low_vram_adapter.json`);
  });

  it('never reuses an earlier run artifact path for a repeated run', () => {
    const env = { PAGENARRATOR_TTS_PROBE_PROFILE: 'native_webgpu' };
    const first = createLiveTtsProbeRunPlan({ root: 'F:/PageNarrator', revision: TEST_REVISION, runId: '20261005T080000Z-aaaaaa', env });
    const second = createLiveTtsProbeRunPlan({ root: 'F:/PageNarrator', revision: TEST_REVISION, runId: '20261005T080000Z-bbbbbb', env });

    expect(first.jobs[0].env.PAGENARRATOR_TTS_PROBE_OUTPUT).not.toBe(second.jobs[0].env.PAGENARRATOR_TTS_PROBE_OUTPUT);
  });

  it('waits for the extension toolbar player context before configuring a probe read', () => {
    const probeHarness = readFileSync(new URL('../live/tts-probe-controls.js', import.meta.url), 'utf8');
    const helperStart = probeHarness.indexOf('async function openReaderEngineTargetForProfile');
    const configureStart = probeHarness.indexOf('async function configureProbeRead');
    const helperBlock = probeHarness.slice(helperStart, configureStart);

    expect(helperBlock).toContain('await waitForReaderEngineExtensionContext');
    expect(helperBlock).toContain('location.href');
    expect(helperBlock).toContain('globalThis.chrome?.storage?.local');
    expect(helperBlock).toContain('return false');
  });

  it('records host hardware and a VRAM proxy in live TTS probe artifacts', () => {
    const probeHarness = readFileSync(new URL('../live/tts-probe-environment.js', import.meta.url), 'utf8');

    expect(probeHarness).toContain('function collectHostSnapshot');
    expect(probeHarness).toContain('function deriveVramProxyMb');
    expect(probeHarness).toContain('host: collectHostSnapshot()');
    expect(probeHarness).toContain('derived: {');
    expect(probeHarness).toContain('vramProxyMb: deriveVramProxyMb');
  });

  it('checks expected backend reasons for requirement candidate probes', () => {
    const probeHarness = readFileSync(new URL('../live/tts-probe-results.js', import.meta.url), 'utf8');

    expect(probeHarness).toContain('expectedBackendReason');
    expect(probeHarness).toContain('selectedBackendPlan?.reason');
  });

  it('waits for terminal read cleanup before closing repeated probe targets', () => {
    const probeHarness = readFileSync(new URL('../live/tts-probe-attempt.js', import.meta.url), 'utf8');
    const liveDocs = readFileSync(new URL('../../docs/live-extension-tests.md', import.meta.url), 'utf8');

    expect(probeHarness).toContain('await waitForProbeReadCleanup(cdp, readerEngineSessionId, popup.sessionId)');
    expect(liveDocs).toContain('repeated unlimited reads');
    expect(liveDocs).toContain('same `dist/` directory');
  });
});
