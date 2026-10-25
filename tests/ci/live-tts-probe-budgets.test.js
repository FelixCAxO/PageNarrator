import { describe, expect, it } from 'vitest';
import {
  LOWER_SPEC_TTS_PROBE_PROFILE_SET,
  getTtsProbeLatencyBudget,
  getTtsProbeProfiles,
  summarizeProbeBudgetFailures,
} from '../live/live-tts-hardware-profiles.js';

describe('live TTS probe latency budgets', () => {
  it('assigns merge-gate budgets to every lower-spec profile', () => {
    const profiles = getTtsProbeProfiles(LOWER_SPEC_TTS_PROBE_PROFILE_SET);

    expect(profiles).toHaveLength(2);
    for (const profile of profiles) {
      expect(getTtsProbeLatencyBudget(profile)).toMatchObject({
        firstSynthesisP95Ms: expect.any(Number),
        maxInterSectionGapP95Ms: 500,
      });
    }
    expect(getTtsProbeLatencyBudget(profiles.find((profile) => profile.name === '8gb_4cpu_no_webgpu')).firstSynthesisP95Ms).toBe(8000);
    expect(getTtsProbeLatencyBudget(profiles.find((profile) => profile.name === '4gb_4cpu_low_memory')).firstSynthesisP95Ms).toBe(8000);
  });

  it('summarizes budget failures with profile and metric names for CI output', () => {
    const [profile] = getTtsProbeProfiles(LOWER_SPEC_TTS_PROBE_PROFILE_SET);
    const failures = summarizeProbeBudgetFailures(profile, {
      metrics: {
        firstSynthesisMs: { p95: 8501 },
        maxNextSectionReadyGapMs: { p95: 1200 },
        maxInterSectionGapMs: { p95: 750 },
      },
    });

    expect(failures).toEqual([
      {
        profileName: profile.name,
        metric: 'firstSynthesisMs.p95',
        actualMs: 8501,
        budgetMs: 8000,
      },
      {
        profileName: profile.name,
        metric: 'maxInterSectionGapMs.p95',
        actualMs: 750,
        budgetMs: 500,
      },
    ]);
  });

  it('fails lower-spec budgets when required latency metrics are missing', () => {
    const [profile] = getTtsProbeProfiles(LOWER_SPEC_TTS_PROBE_PROFILE_SET);

    expect(summarizeProbeBudgetFailures(profile, {
      metrics: {
        firstSynthesisMs: { p95: null },
        maxInterSectionGapMs: { p95: null },
      },
    })).toEqual([
      {
        profileName: profile.name,
        metric: 'firstSynthesisMs.p95',
        actualMs: null,
        budgetMs: 8000,
        reason: 'missing',
      },
      {
        profileName: profile.name,
        metric: 'maxInterSectionGapMs.p95',
        actualMs: null,
        budgetMs: 500,
        reason: 'missing',
      },
    ]);
  });

  it('fails the latency gate when any run was measured on a contaminated host', () => {
    const [profile] = getTtsProbeProfiles(LOWER_SPEC_TTS_PROBE_PROFILE_SET);

    expect(summarizeProbeBudgetFailures(profile, {
      contaminatedRuns: 1,
      metrics: {
        firstSynthesisMs: { p95: 900 },
        maxInterSectionGapMs: { p95: 100 },
      },
    })).toEqual([
      { profileName: profile.name, metric: 'measurement-validity', reason: 'contaminated', contaminatedRuns: 1 },
    ]);
  });

  it('treats fallback-read runs as satisfying generated handoff budgets', () => {
    const [baseProfile] = getTtsProbeProfiles('4gb_4cpu_low_memory');
    const profile = { ...baseProfile, expectBrowserFallback: true };

    expect(summarizeProbeBudgetFailures(profile, {
      runs: 3,
      fallbackRuns: 3,
      metrics: {
        firstSynthesisMs: { p95: null },
        maxNextSectionReadyGapMs: { p95: null },
        maxInterSectionGapMs: { p95: null },
      },
    })).toEqual([]);
  });
});
