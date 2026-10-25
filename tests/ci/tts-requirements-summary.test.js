import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTtsRequirementsSummary,
  parseSummarizerArgs,
  renderTtsRequirementsMarkdown,
  writeTtsRequirementsSummary,
} from '../../scripts/summarize-tts-requirements.mjs';
import { selectVoiceModelBackend } from '../../src/lib/gpu-calibration.js';
import { getTtsProbeProfiles } from '../live/live-tts-hardware-profiles.js';
import { assessMeasurementValidity, MEASUREMENT_CONTRACT_VERSION } from '../../scripts/weak-hardware/evidence-contract.mjs';
import { hashDirectory } from '../../scripts/weak-hardware/run-provenance.mjs';
import { KOKORO_DATA } from '../../src/tts/kokoro/model-data.js';

const tempRoots = [];
let fixtureRunIndex = 0;

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('TTS requirements summary artifact', () => {
  it.each([
    ['2gb_2cpu_no_webgpu_floor', 'no-webgpu'],
    ['4gb_2cpu_no_webgpu_floor', 'no-webgpu'],
    ['4gb_4cpu_no_webgpu', 'no-webgpu'],
    ['8gb_4cpu_low_vram_adapter', 'webgpu-available'],
  ])('keeps the %s probe expectation consistent with runtime fallback priority', async (name, reason) => {
    const [profile] = getTtsProbeProfiles(name);
    const plan = await selectVoiceModelBackend({
      navigator: { ...profile.navigator, gpu: profile.disableWebGpu ? undefined : {} },
      probeWebGpu: async () => ({ tier: 'weak', gpuClass: 'integrated-probable', memory: { sufficient: false } }),
    });

    expect(plan).toMatchObject({ device: profile.disableWebGpu ? 'wasm' : 'webgpu', dtype: profile.disableWebGpu ? 'q8' : 'fp32', reason });
    expect(profile.requirement.gpu.expectedBackendReason).toBe(reason);
  });

  it('treats legacy unattributed artifacts as excluded evidence instead of hardware tiers', () => {
    const summary = createTtsRequirementsSummary([
      makeProbeFile([
        makeRun({
          profileName: '4gb_4cpu_4gb_vram_gpu',
          label: '4 GB RAM, 4 CPU threads, 4 GB VRAM GPU',
          ramGb: 4,
          cpuThreads: 4,
          gpu: { mode: 'host', device: 'NVIDIA GPU with 4 GB VRAM', vramProxyMb: 4096 },
          expected: { backend: 'webgpu' },
          backendDevice: 'webgpu',
          backendReason: 'fast-webgpu',
          firstSynthesisMs: [5600, 5900, 6100],
          realTimeFactor: [0.48, 0.51, 0.55],
          firstAudibleMs: [18000, 21000, 22000],
        }),
      ]),
    ]);

    expect(summary.minimum).toBeNull();
    expect(summary.recommended).toBeNull();
    expect(summary.rows[0]).toMatchObject({
      profileName: '4gb_4cpu_4gb_vram_gpu',
      buildId: 'unattributed',
      classification: 'unattributed',
      sampleConfidence: 'low-sample',
    });
    expect(summary.launchEvidence).toMatchObject({ status: 'non-pass', missingCandidateRows: ['minimum', 'recommended'] });
  });

  it('classifies minimum and recommended tiers only from attested physical-target evidence', () => {
    const summary = createTtsRequirementsSummary([
      makeAttemptFile({ profileName: 'physical_low_end', ramGb: 4, cpuThreads: 4, physicalTarget: true, metrics: SLOW_METRICS }),
      makeAttemptFile({ profileName: 'physical_mid_range', ramGb: 8, cpuThreads: 8, physicalTarget: true, metrics: FAST_METRICS }),
    ]);

    expect(summary.minimum).toMatchObject({ profileName: 'physical_low_end', verdict: 'physically-verified-target' });
    expect(summary.recommended).toMatchObject({ profileName: 'physical_mid_range', verdict: 'physically-verified-target' });
    expect(summary.launchEvidence).toEqual({
      status: 'pass',
      minimumCandidateBacked: true,
      recommendedCandidateBacked: true,
      missingCandidateRows: [],
      reasons: [],
    });
  });

  it('never pools unattested samples into an attested target hardware tier', () => {
    const summary = createTtsRequirementsSummary([
      makeAttemptFile({ profileName: 'native_wasm', cold: 29, warm: 100, metrics: FAST_METRICS }),
      makeAttemptFile({ profileName: 'native_wasm', physicalTarget: true, cold: 1, warm: 0, metrics: FAST_METRICS }),
    ]);
    expect(summary.groups).toHaveLength(2);
    expect(summary.minimum).toBeNull();
    expect(summary.recommended).toBeNull();
    expect(summary.groups.find(group => group.physicalTarget)?.verdict).toBe('insufficient-evidence');
  });

  it('counts acceptance samples separately for different physical machines', () => {
    const first = makeAttemptFile({ profileName: 'native_wasm', physicalTarget: true, cold: 15, warm: 50, metrics: FAST_METRICS });
    const second = makeAttemptFile({ profileName: 'native_wasm', physicalTarget: true, cold: 15, warm: 50, metrics: FAST_METRICS });
    second.run.physicalTarget.machine = 'another machine';
    second.run.physicalTarget.verifiedAgainst.hostname = 'ANOTHER-HOST';
    const separate = createTtsRequirementsSummary([first, second]);
    expect(separate.groups).toHaveLength(2);
    expect(separate.minimum).toBeNull();
    expect(separate.recommended).toBeNull();
    // Friendly display labels do not define the identity of the measured host.
    second.run.physicalTarget.verifiedAgainst.hostname = first.run.physicalTarget.verifiedAgainst.hostname.toUpperCase();
    expect(createTtsRequirementsSummary([first, second]).launchEvidence.status).toBe('pass');
  });

  it.each([undefined, '', '   ', 42])('keeps legacy physical attestations with observed host identity %s unverified', (hostname) => {
    const payload = makeAttemptFile({ profileName: 'native_wasm', physicalTarget: true, metrics: FAST_METRICS });
    payload.run.physicalTarget.verifiedAgainst.hostname = hostname;
    const summary = createTtsRequirementsSummary([payload]);
    expect(summary.minimum).toBeNull();
    expect(summary.recommended).toBeNull();
    expect(summary.groups[0].reasons).toContain('observed physical host identity is missing; the display label cannot identify a target');
  });

  it('reports actual attested hardware instead of spoofed profile capabilities for physical tiers', () => {
    const payload = makeAttemptFile({ profileName: '4gb_4cpu_low_memory', physicalTarget: true, metrics: FAST_METRICS });
    payload.run.physicalTarget.ramGb = 64;
    payload.run.physicalTarget.logicalProcessors = 24;
    const summary = createTtsRequirementsSummary([payload]);
    expect(summary.minimum).toMatchObject({ ramGb: 64, cpuThreads: 24 });
    expect(summary.rows.every(row => row.ramGb === 64 && row.cpuThreads === 24)).toBe(true);
    expect(renderTtsRequirementsMarkdown(summary)).toContain('(64 GB RAM, 24 CPU threads;');
  });

  it.each(['ramGb', 'logicalProcessors', 'cpuModel', 'gpus'])('requires actual attested %s before a physical tier passes', (field) => {
    const payload = makeAttemptFile({ profileName: 'physical_low_end', physicalTarget: true, metrics: FAST_METRICS });
    delete payload.run.physicalTarget[field];
    const summary = createTtsRequirementsSummary([payload]);
    expect(summary.minimum).toBeNull();
    expect(summary.recommended).toBeNull();
    expect(summary.groups[0].reasons).toContain('attested physical hardware fields are missing');
  });

  it('never turns capability-simulation success into a hardware tier', () => {
    const summary = createTtsRequirementsSummary([
      makeAttemptFile({ profileName: '4gb_4cpu_low_memory', categories: ['capability-simulation'], metrics: FAST_METRICS }),
    ]);

    expect(summary.minimum).toBeNull();
    expect(summary.groups[0]).toMatchObject({ verdict: 'policy-simulation-passed' });
    expect(summary.launchEvidence.reasons[0]).toMatch(/no attested physical-target evidence/);
  });

  it('labels enforced constrained-host success separately from physical verification', () => {
    const summary = createTtsRequirementsSummary([
      makeAttemptFile({ profileName: 'cpu_4ecore_wasm_t4', categories: ['capability-simulation', 'resource-constrained-host'], metrics: SLOW_METRICS }),
    ]);

    expect(summary.groups[0]).toMatchObject({ verdict: 'usable-under-enforced-host-constraints' });
    expect(summary.minimum).toBeNull();
    expect(summary.launchEvidence.status).toBe('non-pass');
  });

  it('requires acceptance-grade cold and warm samples before any tier passes', () => {
    const summary = createTtsRequirementsSummary([
      makeAttemptFile({ profileName: 'physical_low_end', physicalTarget: true, cold: 3, warm: 0, metrics: FAST_METRICS }),
    ]);

    expect(summary.rows.every((row) => row.sampleConfidence === 'low-sample')).toBe(true);
    expect(summary.groups[0]).toMatchObject({ verdict: 'insufficient-evidence' });
    expect(summary.groups[0].reasons.join(' ')).toMatch(/30 cold and 100 warm/);
    expect(summary.minimum).toBeNull();
  });

  it('counts cache-warm repeated user reads with reload costs without calling them resident', () => {
    const payload = makeAttemptFile({ profileName: 'physical_repeat', physicalTarget: true, cold: 1, warm: 2, metrics: FAST_METRICS });
    for (const attempt of payload.attempts.filter(attempt => attempt.readIndex > 0)) attempt.modelResidency = 'reloaded';
    const summary = createTtsRequirementsSummary([payload], { sampleTarget: { cold: 1, warm: 2 } });
    expect(summary.rows.every(row => row.samples.warm === 2 && row.samples.warmReloaded === 2 && row.samples.warmResident === 0)).toBe(true);
    expect(summary.minimum).not.toBeNull();
  });

  it.each(['missing-observation', 'missing-phase', 'other-page', 'missing-predecessor', 'wrong-hash', 'wrong-cache', 'wrong-url', 'unverified-bytes'])('rejects warm sample provenance: %s', failure => {
    const payload = makeAttemptFile({ profileName: 'physical_repeat', physicalTarget: true, cold: 1, warm: 1, metrics: FAST_METRICS });
    for (const attempt of payload.attempts.filter(attempt => attempt.readIndex > 0)) {
      if (failure === 'missing-observation') delete attempt.modelCache.observed;
      if (failure === 'missing-phase') delete attempt.readLifecycle.phase;
      if (failure === 'other-page') attempt.readLifecycle.pageSessionId = 'other-page';
      if (failure === 'missing-predecessor') delete attempt.readLifecycle.previousReadId;
      if (failure === 'wrong-hash') attempt.modelCache.verifiedModelFiles[0].sha256 = '0'.repeat(64);
      if (failure === 'wrong-cache') attempt.modelCache.verifiedModelFiles[0].cacheName = 'unrelated';
      if (failure === 'wrong-url') attempt.modelCache.verifiedModelFiles[0].url = 'https://elsewhere.test/model.onnx';
      if (failure === 'unverified-bytes') attempt.modelCache.verifiedModelFiles[0].verified = false;
    }
    const summary = createTtsRequirementsSummary([payload], { sampleTarget: { cold: 1, warm: 1 } });
    expect(summary.rows.every(row => row.samples.warm === 0 && row.unvalidatedAttempts === 1)).toBe(true);
    expect(summary.minimum).toBeNull();
  });

  it.each([undefined, null, false])('does not qualify a cold read with observed cache state %s', observed => {
    const payload = makeAttemptFile({ profileName: 'physical_repeat', physicalTarget: true, cold: 1, warm: 0, metrics: FAST_METRICS });
    for (const attempt of payload.attempts) attempt.modelCache.observed = observed;
    const summary = createTtsRequirementsSummary([payload]);
    expect(summary.rows.every(row => row.sampleCount === 0 && row.unvalidatedAttempts === 1)).toBe(true);
  });

  it('rejects duplicate attempt IDs instead of counting the same evidence twice', () => {
    const payload = makeAttemptFile({ profileName: 'physical_repeat', physicalTarget: true, metrics: FAST_METRICS });
    payload.attempts.push({ ...payload.attempts[0] });
    expect(() => createTtsRequirementsSummary([payload])).toThrow('Duplicate hardware attempt ID');
  });

  it.each(['missing', 'partial'])('requires complete observed readiness-deadline coverage for every read: %s', failure => {
    const payload = makeAttemptFile({ profileName: 'physical_repeat', physicalTarget: true, metrics: FAST_METRICS });
    if (failure === 'missing') delete payload.attempts[0].tts.flow.sectionReadyDeadlineCoverage;
    else payload.attempts[0].tts.flow.sectionReadyDeadlineCoverage = { expected: 2, measured: 1, complete: false };
    const summary = createTtsRequirementsSummary([payload]);
    expect(summary.minimum).toBeNull();
    expect(summary.groups[0].passesMinimumBudget).toBe(false);
  });

  it('keeps different workload hashes from pooling their sample counts', () => {
    const first = makeAttemptFile({ profileName: 'native_wasm', physicalTarget: true, cold: 15, warm: 50, metrics: FAST_METRICS });
    const second = makeAttemptFile({ profileName: 'native_wasm', physicalTarget: true, cold: 15, warm: 50, metrics: FAST_METRICS });
    for (const attempt of second.attempts) attempt.documentSha256 = 'f'.repeat(64);
    const summary = createTtsRequirementsSummary([first, second]);
    expect(summary.rows).toHaveLength(4);
    expect(summary.minimum).toBeNull();
  });

  it('requires every required workload instead of one successful article row', () => {
    const summary = createTtsRequirementsSummary([
      makeAttemptFile({ profileName: 'physical_low_end', physicalTarget: true, documents: ['article'], metrics: FAST_METRICS }),
    ]);

    expect(summary.groups[0]).toMatchObject({ verdict: 'insufficient-evidence', missingDocuments: ['pdf'] });
    expect(summary.minimum).toBeNull();
  });

  it('preserves failures, timeouts and invalid environments and keeps them out of tiers', () => {
    const summary = createTtsRequirementsSummary([
      makeAttemptFile({
        profileName: 'physical_low_end',
        physicalTarget: true,
        metrics: FAST_METRICS,
        extraAttempts: [
          { status: 'timeout', error: 'Probe did not record required synthesis/flow metrics' },
          { status: 'invalid-environment', error: null, violations: ['enforced.cpuAffinity: processor affinity was not applied to every browser process with the requested core class'] },
        ],
      }),
    ]);

    const article = summary.rows.find((row) => row.documentType === 'article');
    expect(article.statuses).toMatchObject({ passed: 130, timeout: 1, 'invalid-environment': 1 });
    expect(article.failures.map((failure) => failure.status)).toEqual(['timeout', 'invalid-environment']);
    expect(summary.groups[0].verdict).toBe('invalid-environment');
    expect(summary.minimum).toBeNull();
    expect(summary.attemptTotals).toMatchObject({ timeout: 2, 'invalid-environment': 2 });
  });

  it('excludes contaminated measurements from metrics and tiers', () => {
    const summary = createTtsRequirementsSummary([
      makeAttemptFile({ profileName: 'physical_low_end', physicalTarget: true, metrics: FAST_METRICS, contaminated: true }),
    ]);

    expect(summary.rows[0].sampleCount).toBe(0);
    expect(summary.rows[0].metrics.firstSynthesisMs).toEqual({ n: 0, p50: null, p95: null, max: null });
    expect(summary.groups[0].reasons.join(' ')).toMatch(/contaminated/);
    expect(summary.minimum).toBeNull();
  });

  it('does not let a WebGPU fallback satisfy a requested-WebGPU tier', () => {
    const summary = createTtsRequirementsSummary([
      makeAttemptFile({
        profileName: 'physical_gpu',
        physicalTarget: true,
        metrics: FAST_METRICS,
        expectedBackend: 'webgpu',
        execution: { requested: 'webgpu', observed: 'wasm', fellBack: true, producedAudio: true },
      }),
    ]);

    expect(summary.rows[0]).toMatchObject({ requestedBackend: 'webgpu', observedBackends: { wasm: 130 }, fallbackRate: 1 });
    expect(summary.groups[0].passesMinimumBudget).toBe(false);
    expect(summary.minimum).toBeNull();
  });

  it('summarizes only the latest build and lists other builds separately', () => {
    const summary = createTtsRequirementsSummary([
      makeAttemptFile({ profileName: 'physical_low_end', physicalTarget: true, metrics: FAST_METRICS, buildId: 'a'.repeat(64), finishedAt: '2026-10-01T00:00:00.000Z' }),
      makeAttemptFile({ profileName: 'physical_low_end', physicalTarget: true, metrics: FAST_METRICS, buildId: 'b'.repeat(64), finishedAt: '2026-10-05T00:00:00.000Z' }),
    ]);

    expect(summary.targetBuild).toBe('b'.repeat(64));
    expect(summary.groups.find((group) => group.buildId === 'a'.repeat(64)).verdict).toBe('other-build');
    expect(summary.groups.find((group) => group.buildId === 'b'.repeat(64)).verdict).toBe('physically-verified-target');
  });

  it('requires physical evidence for the current dist bytes in strict CLI mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pn-hardware-candidate-'));
    tempRoots.push(root);
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'main.js'), 'current candidate');
    const candidate = (await hashDirectory(join(root, 'dist'))).sha256;
    const input = join(root, 'probe.json'), output = join(root, 'summary.json');
    const payload = makeAttemptFile({ profileName: 'physical_low_end', physicalTarget: true, metrics: FAST_METRICS });
    writeFileSync(input, JSON.stringify(payload));
    const args = [fileURLToPath(new URL('../../scripts/summarize-tts-requirements.mjs', import.meta.url)),
      input, '--json', output, '--md', join(root, 'summary.md')];
    const run = (...flags) => spawnSync(process.execPath, [...args, ...flags], { cwd: root, encoding: 'utf8' });
    expect(run().status).toBe(0);
    expect(JSON.parse(readFileSync(output, 'utf8')).launchEvidence.status).toBe('pass');
    expect(run('--fail-on-non-pass').status).toBe(1);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({ targetBuild: candidate, launchEvidence: { status: 'non-pass' } });
    expect(run('--fail-on-non-pass', '--build', payload.run.extension.sha256).status).toBe(0);
    payload.run.extension.sha256 = candidate;
    writeFileSync(input, JSON.stringify(payload));
    expect(run('--fail-on-non-pass').status).toBe(0);
    rmSync(join(root, 'dist'), { recursive: true });
    const missing = run('--fail-on-non-pass');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('Could not verify the current extension build in dist');
  });

  it.each([{ following: [] }, { following: ['--fail-on-non-pass'] }, { following: [''] }])('rejects a missing --build value before it can bypass candidate binding: $following', ({ following }) => {
    expect(() => parseSummarizerArgs(['--build', ...following])).toThrow('--build requires a build hash, latest, or all.');
  });

  it.each([null, MEASUREMENT_CONTRACT_VERSION - 1, MEASUREMENT_CONTRACT_VERSION + 1])('retains clean-looking contract %s reports without admitting their timings', (measurementContractVersion) => {
    const summary = createTtsRequirementsSummary([
      makeAttemptFile({ profileName: 'physical_low_end', physicalTarget: true, metrics: FAST_METRICS, measurementContractVersion }),
    ]);
    expect(summary.attemptTotals).toEqual({ passed: 260 });
    expect(summary.rows).toHaveLength(2);
    for (const row of summary.rows) {
      expect(row.statuses).toEqual({ passed: 130 });
      expect(row.sampleCount).toBe(0);
      expect(row.unvalidatedAttempts).toBe(130);
      expect(row.metrics.firstSynthesisMs).toEqual({ n: 0, p50: null, p95: null, max: null });
    }
    expect(summary.groups[0]).toMatchObject({ verdict: 'insufficient-evidence' });
    expect(summary.groups[0].reasons.join(' ')).toMatch(/measurement contract/);
    expect(summary.minimum).toBeNull();
    expect(summary.recommended).toBeNull();
  });

  it('does not pool old clean samples with a new contract on the same runtime and a new Git revision', () => {
    const previous = makeAttemptFile({ profileName: 'physical_low_end', physicalTarget: true, metrics: FAST_METRICS, measurementContractVersion: null });
    const current = makeAttemptFile({ profileName: 'physical_low_end', physicalTarget: true, metrics: FAST_METRICS, cold: 15, warm: 50 });
    current.run.revision.commitSha = 'e'.repeat(40);
    const summary = createTtsRequirementsSummary([previous, current]);
    expect(summary.groups).toHaveLength(2);
    expect(summary.rows).toHaveLength(4);
    expect(summary.rows.filter(row => row.measurementContractVersion === MEASUREMENT_CONTRACT_VERSION).map(row => row.sampleCount)).toEqual([65, 65]);
    const markdown = renderTtsRequirementsMarkdown(summary);
    expect(markdown).toContain('| Build | Contract |');
    expect(markdown).toContain('| unversioned |');
    expect(markdown).toContain(`| ${MEASUREMENT_CONTRACT_VERSION} |`);
    expect(summary.minimum).toBeNull();
    expect(summary.recommended).toBeNull();
  });

  it('preserves an old failure without poisoning sufficient new-contract samples for the same runtime', () => {
    const previous = makeAttemptFile({ profileName: 'physical_low_end', physicalTarget: true, metrics: FAST_METRICS,
      measurementContractVersion: null, extraAttempts: [{ status: 'timeout', error: 'historical timeout' }] });
    const current = makeAttemptFile({ profileName: 'physical_low_end', physicalTarget: true, metrics: FAST_METRICS });
    const summary = createTtsRequirementsSummary([previous, current]);
    expect(summary.groups).toHaveLength(2);
    expect(summary.groups.find(group => group.measurementContractVersion === null).verdict).toBe('failed');
    expect(summary.groups.find(group => group.measurementContractVersion === MEASUREMENT_CONTRACT_VERSION).verdict).toBe('physically-verified-target');
    expect(summary.attemptTotals).toEqual({ passed: 520, timeout: 2 });
    expect(summary.rows.flatMap(row => row.failures).map(failure => failure.error)).toEqual(['historical timeout', 'historical timeout']);
    expect(summary.minimum).toMatchObject({ measurementContractVersion: MEASUREMENT_CONTRACT_VERSION });
  });

  it('tags newly assessed timings with the contract consumed by summaries', () => {
    const current = makeAttemptFile({ profileName: 'physical_low_end', physicalTarget: true, metrics: FAST_METRICS });
    const measurement = assessMeasurementValidity({ schedulingMode: 'isolated', lock: { held: true },
      hostLoad: { foreignCpuFraction: 0, foreignGpuUtilizationPercent: 0 }, usesGpu: true });
    for (const attempt of current.attempts) attempt.measurement = measurement;
    const summary = createTtsRequirementsSummary([current]);
    expect(measurement).toMatchObject({ contractVersion: MEASUREMENT_CONTRACT_VERSION, contaminated: false });
    expect(summary.minimum).toMatchObject({ measurementContractVersion: MEASUREMENT_CONTRACT_VERSION });
  });

  it('writes JSON and Markdown summaries without presenting VRAM labels as tested VRAM', () => {
    const root = mkdtempSync(join(tmpdir(), 'pagenarrator-tts-requirements-'));
    tempRoots.push(root);
    const inputPath = join(root, 'tts-hardware-probe.json');
    const jsonPath = join(root, 'tts-requirements-summary.json');
    const mdPath = join(root, 'tts-requirements-summary.md');
    writeFileSync(inputPath, JSON.stringify(makeProbeFile([
      makeRun({
        profileName: '4gb_4cpu_4gb_vram_gpu',
        label: '4 GB RAM, 4 CPU threads, 4 GB VRAM GPU',
        ramGb: 4,
        cpuThreads: 4,
        gpu: { mode: 'host', device: 'NVIDIA GPU with 4 GB VRAM', vramProxyMb: 4096 },
        expected: { backend: 'webgpu' },
        backendDevice: 'webgpu',
        backendReason: 'fast-webgpu',
        firstSynthesisMs: [5600, 5900, 6100],
        realTimeFactor: [0.48, 0.51, 0.55],
        firstAudibleMs: [18000, 21000, 22000],
      }),
    ])));

    const summary = writeTtsRequirementsSummary({
      inputPaths: [inputPath],
      jsonPath,
      mdPath,
    });

    expect(JSON.parse(readFileSync(jsonPath, 'utf8'))).toMatchObject({
      generatedAt: summary.generatedAt,
      launchEvidence: { status: 'non-pass' },
    });
    const markdown = readFileSync(mdPath, 'utf8');
    expect(markdown).toContain('Physically Verified Target Hardware');
    expect(markdown).toContain('4gb_4cpu_4gb_vram_gpu');
    expect(markdown).not.toMatch(/VRAM proxy/);
  });

  it('keeps missing numeric metrics missing instead of treating null as zero', () => {
    const summary = createTtsRequirementsSummary([
      makeAttemptFile({ profileName: 'physical_low_end', physicalTarget: true, metrics: { ...FAST_METRICS, maxInterSectionGapMs: null } }),
    ]);

    expect(summary.rows[0].metrics.maxInterSectionGapMs).toEqual({ n: 0, p50: null, p95: null, max: null });
    expect(summary.groups[0].passesMinimumBudget).toBe(false);
    expect(summary.minimum).toBeNull();
  });
});

const FAST_METRICS = Object.freeze({
  firstSynthesisMs: 900,
  realTimeFactor: 0.2,
  maxNextSectionReadyGapMs: 400,
  maxSectionReadyDeadlineMissMs: 400,
  maxInterSectionGapMs: 120,
  firstAudibleMs: 9000,
});

const SLOW_METRICS = Object.freeze({
  firstSynthesisMs: 9500,
  realTimeFactor: 0.8,
  maxNextSectionReadyGapMs: 1800,
  maxSectionReadyDeadlineMissMs: 1800,
  maxInterSectionGapMs: 600,
  firstAudibleMs: 45000,
});

function makeProbeFile(groups) {
  return { profiles: groups.flat() };
}

// Schema-2 artifact: run provenance plus one attempt per sample.
function makeAttemptFile({
  profileName,
  ramGb = 4,
  cpuThreads = 4,
  categories = ['native-host'],
  physicalTarget = false,
  documents = ['article', 'pdf'],
  cold = 30,
  warm = 100,
  metrics,
  contaminated = false,
  measurementContractVersion = MEASUREMENT_CONTRACT_VERSION,
  expectedBackend = null,
  execution = { requested: 'webgpu', observed: 'webgpu', fellBack: false, producedAudio: true },
  extraAttempts = [],
  buildId = 'c'.repeat(64),
  finishedAt = '2026-10-05T08:00:00.000Z',
}) {
  const runId = `run-${++fixtureRunIndex}`;
  const profile = {
    name: profileName,
    label: profileName,
    requirement: { system: { ramGb, cpuThreads }, expected: expectedBackend ? { backend: expectedBackend } : {}, candidate: true },
    evidence: { categories },
  };
  const attempts = [];
  for (const documentType of documents) {
    for (let index = 0; index < cold + warm; index += 1) {
      attempts.push({
        attemptId: `${runId}:${documentType}:${index}`,
        runId,
        documentType,
        documentSha256: documentType === 'pdf' ? 'cf7f64bca6be30fbbde2e686589fc45a41568533a87df467cb7054c149f0e774' : 'a'.repeat(64),
        profile,
        runIndex: index,
        readIndex: index < cold ? 0 : index - cold + 1,
        readLifecycle: { phase: index < cold ? 'cold' : 'warm', pageSessionId: `${runId}:${documentType}:page${Math.min(index, cold - 1)}`,
          ...(index >= cold ? { previousReadId: `${runId}:${documentType}:${index - 1}` } : {}) },
        status: 'passed',
        outcome: execution.fellBack ? 'permitted-fallback' : 'local-model',
        environment: { status: 'valid', categories, checks: [], violations: [] },
        measurement: { ...(measurementContractVersion === null ? {} : { contractVersion: measurementContractVersion }), contaminated, reasons: contaminated ? ['foreign CPU load'] : [] },
        modelCache: { observed: true, state: index === 0 ? 'download-cold' : 'cache-warm',
          verifiedModelFiles: KOKORO_DATA.files.filter(file => file.path.endsWith('.onnx')).map(file => ({ ...file,
            verified: true, cacheName: 'transformers-cache', url: `https://huggingface.co/${KOKORO_DATA.modelId}/resolve/${KOKORO_DATA.revision}/${file.path}` })) },
        modelResidency: index >= cold ? 'resident' : 'loaded-for-read',
        execution,
        finishedAt,
        tts: {
          firstSynthesisMs: metrics.firstSynthesisMs,
          realTimeFactor: metrics.realTimeFactor,
          preTtsLatency: { firstAudibleMs: metrics.firstAudibleMs },
          flow: { maxNextSectionReadyGapMs: metrics.maxNextSectionReadyGapMs, maxInterSectionGapMs: metrics.maxInterSectionGapMs,
            maxSectionReadyDeadlineMissMs: metrics.maxSectionReadyDeadlineMissMs,
            sectionReadyDeadlineCoverage: { expected: 1, measured: 1, complete: true } },
          selectedBackendPlan: { device: execution.requested, reason: 'webgpu-available' },
        },
      });
    }
    for (const extra of extraAttempts) {
      attempts.push({
        runId,
        documentType,
        documentSha256: documentType === 'pdf' ? 'cf7f64bca6be30fbbde2e686589fc45a41568533a87df467cb7054c149f0e774' : 'a'.repeat(64),
        profile,
        status: extra.status,
        error: extra.error,
        environment: { status: extra.status === 'invalid-environment' ? 'invalid-environment' : 'valid', categories, checks: [], violations: extra.violations || [] },
        measurement: { ...(measurementContractVersion === null ? {} : { contractVersion: measurementContractVersion }), contaminated: false, reasons: [] },
        execution,
        finishedAt,
      });
    }
  }
  return {
    schemaVersion: 2,
    run: {
      runId,
      schedulingMode: 'isolated',
      revision: { commitSha: 'f'.repeat(40), dirty: false },
      extension: { sha256: buildId },
      ...(physicalTarget ? { physicalTarget: { attested: true, machine: profileName, cpuModel: 'Test CPU',
        logicalProcessors: cpuThreads, ramGb, gpus: ['Test GPU'], attestedBy: 'test maintainer',
        verifiedAgainst: { hostname: `host-${profileName}` } } } : {}),
    },
    attempts,
  };
}

function makeRun({
  profileName,
  label,
  ramGb,
  cpuThreads,
  gpu,
  expected = {},
  backendReason,
  backendDevice = backendReason === 'fast-webgpu' ? 'webgpu' : 'wasm',
  includeRequirement = true,
  candidate = true,
  fallbackOccurred = false,
  firstSynthesisMs = [20000],
  realTimeFactor = [2],
  firstAudibleMs = [90000],
  maxNextSectionReadyGapMs = [1200],
  maxInterSectionGapMs = [400],
}) {
  return firstSynthesisMs.map((firstSynthesis, index) => ({
    documentType: 'article',
    profile: {
      name: profileName,
      label,
      ...(includeRequirement ? { requirement: {
        system: { ramGb, cpuThreads },
        gpu,
        expected,
        candidate,
      } } : {}),
    },
    runIndex: index,
    runCount: firstSynthesisMs.length,
    chrome: {
      deviceMemory: ramGb,
      hardwareConcurrency: cpuThreads,
    },
    derived: {
      vramProxyMb: gpu?.vramProxyMb ?? null,
    },
    tts: {
      selectedBackendPlan: {
        device: backendDevice,
        reason: backendReason,
      },
      fallbackOccurred,
      firstSynthesisMs: firstSynthesis,
      realTimeFactor: realTimeFactor[index] ?? realTimeFactor.at(-1),
      audioDurationSeconds: 3,
      preTtsLatency: {
        firstAudibleMs: firstAudibleMs[index] ?? firstAudibleMs.at(-1),
      },
      flow: {
        maxNextSectionReadyGapMs: maxNextSectionReadyGapMs[index] ?? maxNextSectionReadyGapMs.at(-1),
        maxInterSectionGapMs: maxInterSectionGapMs[index] ?? maxInterSectionGapMs.at(-1),
      },
    },
  }));
}

describe('scanned PDF OCR measurement evidence', () => {
  it('excludes old clean-looking scanned timings with no OCR backend evidence', () => {
    const payload = makeAttemptFile({ profileName: 'physical_ocr', physicalTarget: true,
      documents: ['scanned-pdf'], cold: 1, warm: 2, metrics: FAST_METRICS });
    const summary = createTtsRequirementsSummary([payload], { requiredDocuments: ['scanned-pdf'], sampleTarget: { cold: 1, warm: 2 } });
    expect(summary.rows[0].sampleCount).toBe(0);
    expect(summary.rows[0].unvalidatedAttempts).toBe(3);
    expect(summary.minimum).toBeNull();
  });
  it('admits the new scoped channel only when the ordinary measurement gates also pass', () => {
    const payload = makeAttemptFile({ profileName: 'physical_ocr', physicalTarget: true,
      documents: ['scanned-pdf'], cold: 1, warm: 2, metrics: FAST_METRICS });
    for (const attempt of payload.attempts) attempt.ocr = { applicable: true, contractVersion: 1, failures: [] };
    expect(createTtsRequirementsSummary([payload], { requiredDocuments: ['scanned-pdf'], sampleTarget: { cold: 1, warm: 2 } }).rows[0].sampleCount).toBe(3);
    payload.attempts[1].measurement.contaminated = true;
    expect(createTtsRequirementsSummary([payload], { requiredDocuments: ['scanned-pdf'], sampleTarget: { cold: 1, warm: 2 } }).rows[0].sampleCount).toBe(2);
  });
});
