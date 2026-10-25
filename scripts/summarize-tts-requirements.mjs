import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVIDENCE_CATEGORIES, MEASUREMENT_CONTRACT_VERSION, RUN_STATUS, resolveExecutionBackend } from './weak-hardware/evidence-contract.mjs';
import { hashDirectory } from './weak-hardware/run-provenance.mjs';
import { KOKORO_DATA } from '../src/tts/kokoro/model-data.js';

export const TTS_REQUIREMENTS_MINIMUM_BUDGET = Object.freeze({
  fallbackRate: 0,
  firstSynthesisP95Ms: 12_000,
  realTimeFactorP95: 1,
  maxSectionReadyDeadlineMissP95Ms: 2_000,
  maxInterSectionGapP95Ms: 750,
  firstAudibleP95Ms: 60_000,
});

export const TTS_REQUIREMENTS_RECOMMENDED_BUDGET = Object.freeze({
  fallbackRate: 0,
  firstSynthesisP95Ms: 8_000,
  realTimeFactorP95: 0.6,
  maxSectionReadyDeadlineMissP95Ms: 1_500,
  maxInterSectionGapP95Ms: 500,
  firstAudibleP95Ms: 30_000,
});

// Benchmark protocol v1 (docs/benchmarks/protocol.md): acceptance-grade
// latency distributions need 30 cold and 100 warm samples per profile.
export const TTS_REQUIREMENTS_SAMPLE_TARGET = Object.freeze({ cold: 30, warm: 100 });

// A tier covers every workload the probe can run, not one convenient row.
export const TTS_REQUIREMENTS_REQUIRED_DOCUMENTS = Object.freeze(['article', 'pdf']);

export const REQUIREMENT_VERDICTS = Object.freeze({
  PHYSICALLY_VERIFIED: 'physically-verified-target',
  CONSTRAINED_HOST_USABLE: 'usable-under-enforced-host-constraints',
  POLICY_SIMULATION_PASSED: 'policy-simulation-passed',
  NATIVE_HOST_OBSERVED: 'native-host-observed',
  FAULT_HANDLING_VERIFIED: 'fault-handling-verified',
  INSUFFICIENT_EVIDENCE: 'insufficient-evidence',
  FAILED: 'failed',
  INVALID_ENVIRONMENT: 'invalid-environment',
  BLOCKED: 'blocked',
  UNATTRIBUTED: 'unattributed',
  OTHER_BUILD: 'other-build',
});

/**
 * @param {any[]} probePayloads
 * @param {{ generatedAt?: string, build?: string, sampleTarget?: { cold: number, warm: number }, requiredDocuments?: readonly string[] }} [options]
 */
export function createTtsRequirementsSummary(probePayloads = [], {
  generatedAt = new Date().toISOString(),
  build = 'latest',
  sampleTarget = TTS_REQUIREMENTS_SAMPLE_TARGET,
  requiredDocuments = TTS_REQUIREMENTS_REQUIRED_DOCUMENTS,
} = {}) {
  const attempts = normalizeAttempts(probePayloads);
  const targetBuild = resolveTargetBuild(attempts, build);
  const rows = summarizeRows(attempts, { targetBuild, sampleTarget })
    .sort(compareCapability);
  const groups = summarizeGroups(rows, { requiredDocuments, sampleTarget });
  for (const row of rows) {
    row.classification = groups.find((group) => group.key === row.groupKey)?.verdict || row.rowVerdict;
  }
  const physical = groups.filter((group) => group.verdict === REQUIREMENT_VERDICTS.PHYSICALLY_VERIFIED);
  const minimum = selectTier(physical, TTS_REQUIREMENTS_MINIMUM_BUDGET);
  const recommended = selectTier(physical, TTS_REQUIREMENTS_RECOMMENDED_BUDGET);
  const launchEvidence = summarizeLaunchEvidence({ minimum, recommended, groups });

  return {
    generatedAt,
    targetBuild,
    measurementContractVersion: MEASUREMENT_CONTRACT_VERSION,
    budgets: {
      minimum: TTS_REQUIREMENTS_MINIMUM_BUDGET,
      recommended: TTS_REQUIREMENTS_RECOMMENDED_BUDGET,
    },
    sampleTarget,
    requiredDocuments: [...requiredDocuments],
    minimum,
    recommended,
    launchEvidence,
    groups,
    rows,
    attemptTotals: countBy(attempts.map((attempt) => attempt.status)),
  };
}

export function writeTtsRequirementsSummary({
  inputPaths = resolveDefaultInputPaths(),
  jsonPath = path.resolve('artifacts', 'tts-requirements-summary.json'),
  mdPath = path.resolve('artifacts', 'tts-requirements-summary.md'),
  build = 'latest',
} = {}) {
  const payloads = inputPaths.map((inputPath) => ({ ...JSON.parse(readFileSync(inputPath, 'utf8')), __inputPath: inputPath }));
  const summary = createTtsRequirementsSummary(payloads, { build });
  mkdirSync(path.dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
  if (mdPath) {
    mkdirSync(path.dirname(mdPath), { recursive: true });
    writeFileSync(mdPath, renderTtsRequirementsMarkdown(summary));
  }
  return summary;
}

/**
 * Every attempt, successful or not. Schema-2 artifacts carry attempts with
 * provenance; legacy artifacts become unattributed successful attempts.
 */
function normalizeAttempts(payloads) {
  const attempts = (Array.isArray(payloads) ? payloads : []).flatMap((payload) => {
    if (Array.isArray(payload?.attempts)) {
      return payload.attempts.map((attempt) => normalizeAttempt(attempt, payload.run || null, payload.__inputPath));
    }
    const legacyRuns = Array.isArray(payload?.profiles) ? payload.profiles : (payload?.profile && payload?.tts ? [payload] : []);
    return legacyRuns.map((run) => normalizeAttempt({ ...run, status: RUN_STATUS.PASSED, legacy: true }, null, payload?.__inputPath));
  }).filter((attempt) => attempt.profile?.name);
  const byId = new Map();
  for (const attempt of attempts) {
    if (typeof attempt.attemptId !== 'string' || !attempt.attemptId) continue;
    if (byId.has(attempt.attemptId)) throw new Error(`Duplicate hardware attempt ID: ${attempt.attemptId}`);
    byId.set(attempt.attemptId, attempt);
  }
  return attempts.map(attempt => ({ ...attempt, samplePhase: resolveSamplePhase(attempt, byId) }));
}

function resolveSamplePhase(attempt, byId) {
  const lifecycle = attempt.readLifecycle;
  if (typeof attempt.attemptId !== 'string' || !attempt.attemptId || typeof lifecycle?.pageSessionId !== 'string'
    || !lifecycle.pageSessionId.trim() || attempt.modelCache?.observed !== true) return null;
  if (lifecycle.phase === 'cold' && attempt.readIndex === 0) return 'cold';
  if (lifecycle.phase !== 'warm' || !Number.isSafeInteger(attempt.readIndex) || attempt.readIndex <= 0 || attempt.modelCache.state !== 'cache-warm') return null;
  const previous = byId.get(lifecycle.previousReadId);
  if (!previous || previous.status !== RUN_STATUS.PASSED || previous.runId !== attempt.runId
    || previous.buildId !== attempt.buildId || previous.documentType !== attempt.documentType
    || previous.profile.name !== attempt.profile.name || previous.documentSha256 !== attempt.documentSha256
    || previous.physicalTargetKey !== attempt.physicalTargetKey
    || previous.readLifecycle?.pageSessionId !== lifecycle.pageSessionId || previous.readIndex !== attempt.readIndex - 1) return null;
  const graph = attempt.execution?.observed === 'wasm' ? 'onnx/model_quantized.onnx' : 'onnx/model.onnx';
  const pinned = KOKORO_DATA.files.find(file => file.path === graph);
  const url = `https://huggingface.co/${KOKORO_DATA.modelId}/resolve/${KOKORO_DATA.revision}/${graph}`;
  return attempt.modelCache.verifiedModelFiles?.some(file => file.verified === true && file.cacheName === 'transformers-cache' && file.url === url
    && file.path === graph && file.bytes === pinned.bytes && file.sha256 === pinned.sha256)
    ? 'warm' : null;
}

function normalizeAttempt(attempt, run, inputPath) {
  const legacy = attempt.legacy === true || !run;
  const profile = attempt.profile || {};
  const categories = Array.isArray(attempt.environment?.categories) && attempt.environment.categories.length
    ? attempt.environment.categories
    : (profile.evidence?.categories || (profile.simulated ? [EVIDENCE_CATEGORIES.CAPABILITY_SIMULATION] : [EVIDENCE_CATEGORIES.NATIVE_HOST]));
  const physicalTarget = run?.physicalTarget?.attested === true ? run.physicalTarget : null;
  const physicalHost = typeof physicalTarget?.verifiedAgainst?.hostname === 'string'
    ? physicalTarget.verifiedAgainst.hostname.trim().toLowerCase() : null;
  return {
    ...attempt,
    legacy,
    inputPath: inputPath || null,
    buildId: legacy ? 'unattributed' : (run?.extension?.sha256 || 'unattributed'),
    revision: run?.revision?.commitSha || null,
    dirtyRevision: run?.revision?.dirty ?? null,
    measurementContractVersion: Number.isSafeInteger(attempt.measurement?.contractVersion) ? attempt.measurement.contractVersion : null,
    runId: run?.runId || attempt.runId || null,
    schedulingMode: attempt.schedulingMode || run?.schedulingMode || (legacy ? 'unknown' : null),
    categories: physicalTarget ? [...new Set([...categories, EVIDENCE_CATEGORIES.PHYSICAL_TARGET])] : [...categories],
    physicalTarget,
    physicalTargetKey: physicalTarget ? JSON.stringify([physicalHost || `unverified:${physicalTarget.machine}`, physicalTarget.cpuModel,
      physicalTarget.logicalProcessors, physicalTarget.ramGb, [...(physicalTarget.gpus || [])].sort()]) : '',
    execution: attempt.execution || resolveExecutionBackend(attempt.tts || {}),
    documentType: attempt.documentType || 'article',
    sortTime: Date.parse(attempt.finishedAt || attempt.startedAt || run?.startedAt || '') || 0,
  };
}

function resolveTargetBuild(attempts, build) {
  if (build && build !== 'latest' && build !== 'all') return build;
  if (build === 'all') return 'all';
  const attributed = attempts.filter((attempt) => attempt.buildId !== 'unattributed').sort((left, right) => right.sortTime - left.sortTime);
  return attributed[0]?.buildId || null;
}

function summarizeRows(attempts, { targetBuild, sampleTarget }) {
  const groups = new Map();
  for (const attempt of attempts) {
    // Identical runtime bytes do not imply identical measurement validation.
    const key = [attempt.buildId, attempt.profile.name, attempt.documentType, attempt.documentSha256, attempt.schedulingMode, attempt.measurementContractVersion, attempt.physicalTargetKey].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(attempt);
  }

  return [...groups.values()].map((group) => {
    const first = group[0];
    const requirement = first.profile?.requirement || {};
    const system = requirement.system || {};
    const statuses = countBy(group.map((attempt) => attempt.status));
    const valid = group.filter((attempt) => attempt.status === RUN_STATUS.PASSED
      && attempt.measurementContractVersion === MEASUREMENT_CONTRACT_VERSION
      && attempt.samplePhase !== null
      && hasScannedPdfOcrEvidence(attempt)
      && attempt.environment?.status !== RUN_STATUS.INVALID_ENVIRONMENT
      && attempt.measurement?.contaminated === false);
    const contaminated = group.filter((attempt) => attempt.measurement?.contaminated === true).length;
    const unvalidated = group.filter((attempt) => attempt.measurement?.contaminated !== true
      && (attempt.measurementContractVersion !== MEASUREMENT_CONTRACT_VERSION
        || attempt.samplePhase === null
        || !hasScannedPdfOcrEvidence(attempt)
        || attempt.measurement?.contaminated === undefined || attempt.measurement?.contaminated === null)).length;
    const samples = {
      downloadCold: valid.filter((attempt) => attempt.samplePhase === 'cold' && attempt.modelCache?.state === 'download-cold').length,
      modelInitCold: valid.filter((attempt) => attempt.samplePhase === 'cold' && attempt.modelCache?.state === 'cache-warm').length,
      warm: valid.filter((attempt) => attempt.samplePhase === 'warm').length,
      warmResident: valid.filter((attempt) => attempt.samplePhase === 'warm' && attempt.modelResidency === 'resident').length,
      warmReloaded: valid.filter((attempt) => attempt.samplePhase === 'warm' && attempt.modelResidency === 'reloaded').length,
      unknownCacheState: valid.filter((attempt) => !attempt.modelCache?.state).length,
    };
    const coldSamples = samples.downloadCold + samples.modelInitCold;
    const scope = first.buildId === 'unattributed'
      ? REQUIREMENT_VERDICTS.UNATTRIBUTED
      : (targetBuild && targetBuild !== 'all' && first.buildId !== targetBuild ? REQUIREMENT_VERDICTS.OTHER_BUILD : 'in-scope');
    const executions = countBy(group.map((attempt) => attempt.execution?.observed ?? 'none'));
    const fallbacks = group.filter((attempt) => attempt.execution?.fellBack || attempt.execution?.observed === 'browser-speech').length;
    const considered = group.filter((attempt) => attempt.status !== RUN_STATUS.INVALID_ENVIRONMENT && attempt.status !== RUN_STATUS.BLOCKED);
    const row = {
      groupKey: [first.buildId, first.profile.name, first.schedulingMode, first.measurementContractVersion, first.physicalTargetKey].join('|'),
      profileName: first.profile.name,
      label: first.profile.label || first.profile.name,
      lane: first.profile.lane || null,
      documentType: first.documentType,
      documentSha256: first.documentSha256 || null,
      buildId: first.buildId,
      measurementContractVersion: first.measurementContractVersion,
      revision: first.revision,
      dirtyRevision: first.dirtyRevision,
      runIds: [...new Set(group.map((attempt) => attempt.runId).filter(Boolean))],
      scope,
      schedulingMode: first.schedulingMode,
      categories: [...new Set(group.flatMap((attempt) => attempt.categories))],
      physicalTarget: first.physicalTarget,
      enforcement: describeEnforcement(first),
      limitations: first.profile?.evidence?.limitations || [],
      attempts: group.length,
      statuses,
      sampleCount: valid.length,
      completeDeadlineCoverage: valid.filter(attempt => {
        const coverage = attempt.tts?.flow?.sectionReadyDeadlineCoverage;
        return coverage?.complete === true && coverage.expected > 0 && coverage.measured === coverage.expected;
      }).length,
      samples,
      sampleConfidence: coldSamples >= sampleTarget.cold && samples.warm >= sampleTarget.warm ? 'acceptance-grade' : 'low-sample',
      contaminatedAttempts: contaminated,
      unvalidatedAttempts: unvalidated,
      ramGb: finiteNumber(first.physicalTarget ? first.physicalTarget.ramGb : system.ramGb ?? first.chrome?.deviceMemory),
      cpuThreads: finiteNumber(first.physicalTarget ? first.physicalTarget.logicalProcessors : system.cpuThreads ?? first.chrome?.hardwareConcurrency),
      candidateEligible: requirement.candidate === true,
      expectedBackend: requirement.expected?.backend || first.profile?.expected?.execution?.[0] || null,
      requestedBackend: mostCommon(group.map((attempt) => attempt.execution?.requested)),
      observedBackends: executions,
      backendDevice: mostCommon(group.map((attempt) => attempt.execution?.observed)),
      backendReason: mostCommon(group.map((attempt) => attempt.tts?.selectedBackendPlan?.reason)),
      gpu: summarizeGpu(first),
      fallbackRuns: fallbacks,
      fallbackRate: considered.length ? fallbacks / considered.length : null,
      outcomes: countBy(group.map((attempt) => attempt.outcome || (attempt.legacy ? 'legacy-unclassified' : 'none'))),
      failures: group.filter((attempt) => attempt.status !== RUN_STATUS.PASSED).map((attempt) => ({
        status: attempt.status,
        runIndex: attempt.runIndex ?? null,
        error: attempt.error || null,
        violations: attempt.environment?.violations || [],
      })),
      metrics: {
        firstSynthesisMs: summarizeMetric(valid.map((attempt) => attempt.tts?.firstSynthesisMs)),
        realTimeFactor: summarizeMetric(valid.map((attempt) => attempt.tts?.realTimeFactor)),
        maxNextSectionReadyGapMs: summarizeMetric(valid.map((attempt) => attempt.tts?.flow?.maxNextSectionReadyGapMs)),
        maxSectionReadyDeadlineMissMs: summarizeMetric(valid.map((attempt) => attempt.tts?.flow?.maxSectionReadyDeadlineMissMs)),
        maxInterSectionGapMs: summarizeMetric(valid.map((attempt) => attempt.tts?.flow?.maxInterSectionGapMs)),
        firstAudibleMs: summarizeMetric(valid.map((attempt) => attempt.tts?.preTtsLatency?.firstAudibleMs)),
        clickToFirstNonSilentMs: summarizeMetric(valid.map((attempt) => attempt.audio?.clickToFirstNonSilentMs)),
        modelLoadMs: summarizeMetric(valid.map((attempt) => attempt.tts?.modelLoadMs)),
        peakBrowserCommitBytes: summarizeMetric(valid.map((attempt) => attempt.resources?.browserCommit?.peakJobCommitBytes)),
      },
    };
    row.rowVerdict = classifyRow(row);
    return row;
  });
}

function describeEnforcement(attempt) {
  const evidence = attempt.profile?.evidence || {};
  const resolved = attempt.browser?.resolvedAffinity || null;
  return {
    enforced: evidence.enforced || {},
    selected: evidence.selected || {},
    resolvedAffinity: resolved ? { logicalProcessors: resolved.logicalProcessors, efficiencyClasses: resolved.efficiencyClasses } : null,
    gpuAdapter: attempt.browser?.gpuAdapterSelection?.description || null,
    verified: attempt.environment ? attempt.environment.status === 'valid' : null,
  };
}

function classifyRow(row) {
  if (row.scope !== 'in-scope') return row.scope;
  if (row.statuses[RUN_STATUS.BLOCKED]) return REQUIREMENT_VERDICTS.BLOCKED;
  if (row.statuses[RUN_STATUS.INVALID_ENVIRONMENT]) return REQUIREMENT_VERDICTS.INVALID_ENVIRONMENT;
  if (row.attempts !== (row.statuses[RUN_STATUS.PASSED] || 0)) return REQUIREMENT_VERDICTS.FAILED;
  return 'passed-attempts';
}

/**
 * Profile-level verdicts across documents. A tier needs every required
 * workload, acceptance-grade samples, no contamination and no failures.
 */
function summarizeGroups(rows, { requiredDocuments, sampleTarget }) {
  const byKey = new Map();
  for (const row of rows) {
    if (!byKey.has(row.groupKey)) byKey.set(row.groupKey, []);
    byKey.get(row.groupKey).push(row);
  }
  return [...byKey.entries()].map(([key, groupRows]) => {
    const first = groupRows[0];
    const documents = groupRows.map((row) => row.documentType);
    const missingDocuments = requiredDocuments.filter((document) => !documents.includes(document));
    const reasons = [];
    let verdict;
    const categories = [...new Set(groupRows.flatMap((row) => row.categories))];
    if (first.scope !== 'in-scope') {
      verdict = first.scope;
      reasons.push(first.scope === REQUIREMENT_VERDICTS.UNATTRIBUTED
        ? 'legacy artifact without build, revision, enforcement or contamination provenance'
        : `belongs to build ${first.buildId.slice(0, 12)}, not the summarized build`);
    } else if (groupRows.some((row) => row.rowVerdict === REQUIREMENT_VERDICTS.BLOCKED)) {
      verdict = REQUIREMENT_VERDICTS.BLOCKED;
      reasons.push('the requested environment could not be created on this host');
    } else if (groupRows.some((row) => row.rowVerdict === REQUIREMENT_VERDICTS.INVALID_ENVIRONMENT)) {
      verdict = REQUIREMENT_VERDICTS.INVALID_ENVIRONMENT;
      reasons.push('a declared constraint, override or injection was not verified as applied');
    } else if (groupRows.some((row) => row.rowVerdict === REQUIREMENT_VERDICTS.FAILED)) {
      verdict = REQUIREMENT_VERDICTS.FAILED;
      reasons.push('at least one attempt failed, timed out or crashed');
    } else {
      const budget = groupRows.every((row) => passesBudget(row, TTS_REQUIREMENTS_MINIMUM_BUDGET));
      const currentContract = first.measurementContractVersion === MEASUREMENT_CONTRACT_VERSION;
      const contaminated = groupRows.some((row) => row.contaminatedAttempts > 0 || row.unvalidatedAttempts > 0);
      const lowSample = groupRows.some((row) => row.sampleConfidence !== 'acceptance-grade');
      if (contaminated) reasons.push('contaminated or unvalidated measurements');
      if (lowSample) reasons.push(`fewer than ${sampleTarget.cold} cold and ${sampleTarget.warm} warm valid samples per workload`);
      if (missingDocuments.length) reasons.push(`missing required workloads: ${missingDocuments.join(', ')}`);
      if (!budget) reasons.push('minimum budget not met (or required metrics missing)');
      if (!currentContract) reasons.push('measurement contract is missing or obsolete; historical timings are excluded');
      const adequate = currentContract && !contaminated && !lowSample && !missingDocuments.length && budget;
      if (!currentContract) {
        verdict = REQUIREMENT_VERDICTS.INSUFFICIENT_EVIDENCE;
      } else if (categories.includes(EVIDENCE_CATEGORIES.FAULT_INJECTION)) {
        verdict = REQUIREMENT_VERDICTS.FAULT_HANDLING_VERIFIED;
        reasons.length = 0;
        reasons.push('fault-injection lane: recovery behavior only, never a performance tier');
      } else if (categories.includes(EVIDENCE_CATEGORIES.PHYSICAL_TARGET)) {
        const target = first.physicalTarget;
        const hardwareComplete = target?.machine && target.cpuModel && first.ramGb > 0 && first.cpuThreads > 0
          && Array.isArray(target.gpus) && target.gpus.length > 0 && target.gpus.every(gpu => typeof gpu === 'string' && gpu.trim());
        if (!hardwareComplete) reasons.push('attested physical hardware fields are missing');
        const observedIdentity = typeof target?.verifiedAgainst?.hostname === 'string' && target.verifiedAgainst.hostname.trim();
        if (!observedIdentity) reasons.push('observed physical host identity is missing; the display label cannot identify a target');
        verdict = adequate && hardwareComplete && observedIdentity ? REQUIREMENT_VERDICTS.PHYSICALLY_VERIFIED : REQUIREMENT_VERDICTS.INSUFFICIENT_EVIDENCE;
      } else if (categories.includes(EVIDENCE_CATEGORIES.RESOURCE_CONSTRAINED_HOST)) {
        verdict = adequate ? REQUIREMENT_VERDICTS.CONSTRAINED_HOST_USABLE : REQUIREMENT_VERDICTS.INSUFFICIENT_EVIDENCE;
      } else if (categories.includes(EVIDENCE_CATEGORIES.CAPABILITY_SIMULATION)) {
        verdict = REQUIREMENT_VERDICTS.POLICY_SIMULATION_PASSED;
        reasons.length = 0;
        reasons.push('reported capabilities were spoofed; host CPU, RAM and GPU were not limited');
      } else {
        verdict = REQUIREMENT_VERDICTS.NATIVE_HOST_OBSERVED;
        reasons.length = 0;
        reasons.push('unrestricted reference host');
      }
    }
    return {
      key,
      profileName: first.profileName,
      label: first.label,
      lane: first.lane,
      buildId: first.buildId,
      measurementContractVersion: first.measurementContractVersion,
      schedulingMode: first.schedulingMode,
      categories,
      verdict,
      reasons,
      documents,
      missingDocuments,
      ramGb: first.ramGb,
      cpuThreads: first.cpuThreads,
      rows: groupRows.map((row) => `${row.profileName}:${row.documentType}`),
      physicalTarget: first.physicalTarget,
      passesMinimumBudget: groupRows.every((row) => passesBudget(row, TTS_REQUIREMENTS_MINIMUM_BUDGET)),
      passesRecommendedBudget: groupRows.every((row) => passesBudget(row, TTS_REQUIREMENTS_RECOMMENDED_BUDGET)),
    };
  });
}

function selectTier(physicalGroups, budget) {
  const passing = physicalGroups.filter((group) => (
    budget === TTS_REQUIREMENTS_RECOMMENDED_BUDGET ? group.passesRecommendedBudget : group.passesMinimumBudget
  ));
  return passing.sort(compareCapability)[0] || null;
}

function summarizeLaunchEvidence({ minimum, recommended, groups }) {
  const missingCandidateRows = [
    ...(!minimum ? ['minimum'] : []),
    ...(!recommended ? ['recommended'] : []),
  ];
  const reasons = [];
  if (!groups.some((group) => group.categories.includes(EVIDENCE_CATEGORIES.PHYSICAL_TARGET))) {
    reasons.push('no attested physical-target evidence; simulated and constrained-host results cannot establish hardware tiers');
  }
  for (const tier of missingCandidateRows) reasons.push(`no physically verified ${tier} tier`);
  return {
    status: missingCandidateRows.length ? 'non-pass' : 'pass',
    minimumCandidateBacked: Boolean(minimum),
    recommendedCandidateBacked: Boolean(recommended),
    missingCandidateRows,
    reasons,
  };
}

function passesBudget(row, budget) {
  return row.fallbackRate === budget.fallbackRate
    && expectedBackendMatches(row)
    && metricP95(row, 'firstSynthesisMs') <= budget.firstSynthesisP95Ms
    && metricP95(row, 'realTimeFactor') <= budget.realTimeFactorP95
    && row.completeDeadlineCoverage === row.sampleCount && row.sampleCount > 0
    && row.metrics.maxSectionReadyDeadlineMissMs.n === row.sampleCount
    && metricP95(row, 'maxSectionReadyDeadlineMissMs') <= budget.maxSectionReadyDeadlineMissP95Ms
    && metricP95(row, 'maxInterSectionGapMs') <= budget.maxInterSectionGapP95Ms
    && metricP95(row, 'firstAudibleMs') <= budget.firstAudibleP95Ms;
}

// The observed execution path decides, never the planner's intent.
function expectedBackendMatches(row) {
  const expected = String(row?.expectedBackend || '').trim();
  if (!expected) return true;
  const observed = Object.keys(row.observedBackends || {});
  return observed.length === 1 && observed[0] === expected;
}

function metricP95(row, name) {
  const raw = row?.metrics?.[name]?.p95;
  if (raw === null || raw === undefined || raw === '') return Infinity;
  const value = Number(raw);
  return Number.isFinite(value) ? value : Infinity;
}

function compareCapability(left, right) {
  return compareNumber(left.ramGb, right.ramGb)
    || compareNumber(left.cpuThreads, right.cpuThreads)
    || String(left.profileName).localeCompare(String(right.profileName))
    || String(left.documentType || '').localeCompare(String(right.documentType || ''));
}

function compareNumber(left, right) {
  const a = Number.isFinite(Number(left)) && left !== null ? Number(left) : Infinity;
  const b = Number.isFinite(Number(right)) && right !== null ? Number(right) : Infinity;
  return a - b;
}

function summarizeGpu(attempt) {
  const gpu = attempt.profile?.requirement?.gpu || attempt.profile?.gpu || {};
  const adapter = attempt.webgpu?.adapterInfo || attempt.hardware?.webgpu?.adapterInfo || {};
  return {
    mode: gpu.mode || (attempt.webgpu?.available ? 'host' : 'none'),
    vendor: gpu.vendor || adapter.vendor || null,
    architecture: gpu.architecture || adapter.architecture || null,
    device: gpu.device || adapter.device || adapter.description || null,
    vramLabelMb: finiteNumber(gpu.vramProxyMb),
    selectedAdapter: attempt.browser?.gpuAdapterSelection?.description || null,
  };
}

function summarizeMetric(values) {
  const sorted = values
    .filter((value) => value !== null && value !== undefined && value !== '')
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!sorted.length) return { n: 0, p50: null, p95: null, max: null };
  return {
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1),
  };
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 1) return sortedValues[0];
  const index = Math.ceil(sortedValues.length * percentileValue) - 1;
  return sortedValues[Math.min(sortedValues.length - 1, Math.max(0, index))];
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || null;
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value ?? 'none'] = (counts[value ?? 'none'] || 0) + 1;
  return counts;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function renderTtsRequirementsMarkdown(summary) {
  const groupsBy = (verdicts) => summary.groups.filter((group) => verdicts.includes(group.verdict));
  const list = (groups) => (groups.length
    ? groups.map((group) => `- ${group.profileName} (${group.categories.join(', ')}): **${group.verdict}** — ${group.reasons.join('; ')}.`).join('\n')
    : '- None.');
  const evidence = summary.rows.map((row) => [
    row.profileName,
    row.documentType,
    row.buildId === 'unattributed' ? 'unattributed' : row.buildId.slice(0, 12),
    row.measurementContractVersion ?? 'unversioned',
    row.categories.join(', '),
    row.schedulingMode,
    formatCounts(row.statuses),
    `${row.samples.downloadCold}/${row.samples.modelInitCold}/${row.samples.warm}`,
    row.contaminatedAttempts + row.unvalidatedAttempts,
    `${row.requestedBackend || '?'} → ${formatCounts(row.observedBackends)}`,
    formatMetric(row.metrics.firstSynthesisMs.p95),
    formatMetric(row.metrics.realTimeFactor.p95),
    formatMetric(row.metrics.firstAudibleMs.p95),
    row.classification,
  ].join(' | ')).map((line) => `| ${line} |`).join('\n');
  const failures = summary.rows.flatMap((row) => row.failures.map((failure) => (
    `- ${row.profileName} ${row.documentType} #${failure.runIndex ?? '?'}: ${failure.status}${failure.error ? ` — ${failure.error}` : ''}${failure.violations.length ? ` (${failure.violations.join('; ')})` : ''}`
  )));

  return `# PageNarrator Hardware Requirements Evidence

Summarized build: ${summary.targetBuild ? `\`${String(summary.targetBuild).slice(0, 12)}\`` : 'none (no attributable runs)'}. Launch evidence: **${summary.launchEvidence.status}**${summary.launchEvidence.reasons.length ? ` — ${summary.launchEvidence.reasons.join('; ')}` : ''}.

A tier needs every required workload (${summary.requiredDocuments.join(', ')}), at least ${summary.sampleTarget.cold} cold and ${summary.sampleTarget.warm} warm valid samples per workload, no failures and no contaminated measurements.

Only measurement contract ${summary.measurementContractVersion} contributes valid timings. Older or unversioned attempts remain visible in separate groups.

## Physically Verified Target Hardware

${summary.minimum ? `- Minimum: ${summary.minimum.physicalTarget.machine} (${summary.minimum.ramGb} GB RAM, ${summary.minimum.cpuThreads} CPU threads; profile ${summary.minimum.profileName}).` : '- Minimum: none established.'}
${summary.recommended ? `- Recommended: ${summary.recommended.physicalTarget.machine} (${summary.recommended.ramGb} GB RAM, ${summary.recommended.cpuThreads} CPU threads; profile ${summary.recommended.profileName}).` : '- Recommended: none established.'}

Only attested physical-target runs can establish a hardware tier. Simulated profiles, constrained host processes and virtual machines cannot.

## Usable Under Enforced Host Constraints

${list(groupsBy([REQUIREMENT_VERDICTS.CONSTRAINED_HOST_USABLE]))}

## Policy Simulation Results

${list(groupsBy([REQUIREMENT_VERDICTS.POLICY_SIMULATION_PASSED]))}

## Native Host Reference

${list(groupsBy([REQUIREMENT_VERDICTS.NATIVE_HOST_OBSERVED]))}

## Fault Handling

${list(groupsBy([REQUIREMENT_VERDICTS.FAULT_HANDLING_VERIFIED]))}

## Insufficient Evidence, Failures and Invalid Environments

${list(groupsBy([REQUIREMENT_VERDICTS.INSUFFICIENT_EVIDENCE, REQUIREMENT_VERDICTS.FAILED, REQUIREMENT_VERDICTS.INVALID_ENVIRONMENT, REQUIREMENT_VERDICTS.BLOCKED]))}

${failures.length ? `### Preserved unsuccessful attempts\n\n${failures.join('\n')}\n` : ''}
## Excluded From Verdicts

${list(groupsBy([REQUIREMENT_VERDICTS.UNATTRIBUTED, REQUIREMENT_VERDICTS.OTHER_BUILD]))}

## Evidence Table

Samples are first-read download-cold / first-read model-init-cold / verified cache-warm repeat attempts. Engine residency and reload counts remain separate in the JSON; warm-read latency includes reloads. "Unvalidated" includes missing lifecycle/cache provenance or contamination checks. Contract 3 budgets use observed section-ready deadline misses; ready-to-ready intervals remain diagnostic.

| Profile | Document | Build | Contract | Evidence | Mode | Attempts | Samples | Contaminated/unvalidated | Requested → observed backend | First synth p95 ms | RTF p95 | First audible p95 ms | Classification |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: | --- |
${evidence || '| none | none | none | none | none | none | none | none | 0 | none | missing | missing | missing | none |'}

Generated from \`tts-requirements-summary.json\`.
`;
}

function formatCounts(counts = {}) {
  const entries = Object.entries(counts);
  return entries.length ? entries.map(([key, value]) => `${key} ${value}`).join(', ') : 'none';
}

function formatMetric(value) {
  if (value === null || value === undefined) return 'missing';
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 'missing';
}

export function resolveDefaultInputPaths(root = path.resolve('.')) {
  return [
    ...expandInputPaths([path.join(root, 'artifacts', 'tts-hardware-probe*.json')]),
    ...findWeakHardwareArtifacts(path.join(root, 'artifacts', 'weak-hardware')),
  ];
}

function findWeakHardwareArtifacts(directory) {
  if (!existsSync(directory)) return [];
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile() && /^tts-hardware-probe.*\.json$/.test(entry.name)) found.push(fullPath);
    }
  };
  walk(directory);
  return found.sort();
}

function expandInputPaths(inputs) {
  return inputs.flatMap((input) => {
    const value = String(input || '').trim();
    if (!value.includes('*')) return existsSync(value) ? [value] : [];
    const directory = path.resolve(path.dirname(value));
    if (!existsSync(directory)) return [];
    const pattern = new RegExp(`^${path.basename(value).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`);
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => path.join(directory, entry.name));
  });
}

export function parseSummarizerArgs(argv = []) {
  const options = { inputs: [], build: 'latest', failOnNonPass: false, jsonPath: null, mdPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--build') {
      const build = argv[++index];
      if (!build || build.startsWith('--')) throw new Error('--build requires a build hash, latest, or all.');
      options.build = build;
    }
    else if (arg === '--fail-on-non-pass') options.failOnNonPass = true;
    else if (arg === '--json') options.jsonPath = argv[++index];
    else if (arg === '--md') options.mdPath = argv[++index];
    else options.inputs.push(arg);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseSummarizerArgs(process.argv.slice(2));
  if (options.failOnNonPass && options.build === 'latest') {
    try {
      options.build = (await hashDirectory(path.resolve('dist'))).sha256;
    } catch (error) {
      throw new Error(`Could not verify the current extension build in dist: ${error.message}`);
    }
  }
  const inputPaths = expandInputPaths(options.inputs);
  const summary = writeTtsRequirementsSummary({
    inputPaths: inputPaths.length ? inputPaths : resolveDefaultInputPaths(),
    build: options.build,
    ...(options.jsonPath ? { jsonPath: path.resolve(options.jsonPath) } : {}),
    ...(options.mdPath ? { mdPath: path.resolve(options.mdPath) } : {}),
  });
  console.log(`Wrote ${summary.rows.length} TTS hardware evidence row(s); launch evidence ${summary.launchEvidence.status}.`);
  if (options.failOnNonPass && summary.launchEvidence.status !== 'pass') process.exitCode = 1;
}

// Scanned-PDF timings recorded before viewer OCR observation are not CPU proof.
function hasScannedPdfOcrEvidence(attempt) {
  return attempt.documentType !== 'scanned-pdf' || (attempt.ocr?.applicable === true
    && attempt.ocr.contractVersion === 1 && Array.isArray(attempt.ocr.failures) && attempt.ocr.failures.length === 0);
}
