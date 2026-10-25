import { LOWER_SPEC_TTS_PROBE_PROFILES } from './tts-probe-profile-simulated.js';

export function getTtsProbeColdStartBudget(profile = {}) {
  if (!profile?.coldStart) return null;
  const memory = Number(profile?.navigator?.deviceMemory);
  return Object.freeze({
    panelReadyMs: 1500,
    extractionMs: 2000,
    firstAudibleMs: memory >= 8 ? 30000 : 60000,
  });
}

export function summarizeTtsProbeRuns(outputs = []) {
  const runs = Array.isArray(outputs) ? outputs : [];
  return {
    runs: runs.length,
    fallbackRuns: runs.filter((output) => output?.tts?.fallbackOccurred).length,
    metrics: {
      firstSynthesisMs: summarizeMetric(runs.map((output) => output?.tts?.firstSynthesisMs)),
      maxNextSectionReadyGapMs: summarizeMetric(runs.map((output) => output?.tts?.flow?.maxNextSectionReadyGapMs)),
      maxInterSectionGapMs: summarizeMetric(runs.map((output) => output?.tts?.flow?.maxInterSectionGapMs)),
    },
  };
}

export function getTtsProbeLatencyBudget(profile = {}) {
  const name = String(profile?.name || '');
  if (!LOWER_SPEC_TTS_PROBE_PROFILES.some((candidate) => candidate.name === name)) return null;
  const firstSynthesisP95Ms = Number(profile?.navigator?.hardwareConcurrency) <= 2 ? 12000 : 8000;
  return Object.freeze({
    firstSynthesisP95Ms,
    maxInterSectionGapP95Ms: 500,
  });
}

export function summarizeProbeBudgetFailures(profile, summary = {}) {
  const budget = getTtsProbeLatencyBudget(profile);
  if (!budget) return [];
  const allRunsUsedFallback = Number(summary?.runs) > 0 && Number(summary?.fallbackRuns) === Number(summary?.runs);

  const failures = [
    createBudgetFailure(profile, 'firstSynthesisMs.p95', summary?.metrics?.firstSynthesisMs?.p95, budget.firstSynthesisP95Ms, {
      allowMissing: allRunsUsedFallback && profile?.expectBrowserFallback,
    }),
  ];

  if (Number(profile?.minProbeSections) > 1) {
    failures.push(
      createBudgetFailure(profile, 'maxInterSectionGapMs.p95', summary?.metrics?.maxInterSectionGapMs?.p95, budget.maxInterSectionGapP95Ms, {
        allowMissing: allRunsUsedFallback,
        allowExceeded: allRunsUsedFallback,
      }),
    );
  }

  // A latency gate cannot pass on timings measured while the host was busy.
  if (Number(summary?.contaminatedRuns) > 0) {
    failures.push({
      profileName: profile?.name || 'unknown',
      metric: 'measurement-validity',
      reason: 'contaminated',
      contaminatedRuns: Number(summary.contaminatedRuns),
    });
  }

  return failures.filter(Boolean);
}

export function createBudgetFailure(profile, metric, actualMs, budgetMs, {
  allowMissing = false,
  allowExceeded = false,
} = {}) {
  if (actualMs == null) {
    if (allowMissing) return null;
    return {
      profileName: profile?.name || 'unknown',
      metric,
      actualMs: null,
      budgetMs,
      reason: 'missing',
    };
  }
  const actual = Number(actualMs);
  if (!Number.isFinite(actual)) {
    if (allowMissing) return null;
    return {
      profileName: profile?.name || 'unknown',
      metric,
      actualMs: null,
      budgetMs,
      reason: 'missing',
    };
  }
  if (allowExceeded) return null;
  if (actual <= budgetMs) return null;
  return {
    profileName: profile?.name || 'unknown',
    metric,
    actualMs: actual,
    budgetMs,
  };
}

export function summarizeMetric(values) {
  const sorted = values
    .filter((value) => value !== null && value !== undefined && value !== '')
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!sorted.length) return { p50: null, p95: null, max: null };

  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1),
  };
}

export function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 1) return sortedValues[0];
  const index = Math.ceil(sortedValues.length * percentileValue) - 1;
  return sortedValues[Math.min(sortedValues.length - 1, Math.max(0, index))];
}
