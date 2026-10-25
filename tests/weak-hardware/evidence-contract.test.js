import { describe, expect, it } from 'vitest';
import {
  CONTAMINATION_THRESHOLDS,
  EVIDENCE_CATEGORIES,
  assessMeasurementValidity,
  assessRunEnvironment,
  createProfileEvidence,
  resolveCpuAffinity,
  resolveExecutionBackend,
  validateProfileEvidence,
} from '../../scripts/weak-hardware/evidence-contract.mjs';

const HOST_TOPOLOGY = [
  ...[0, 1, 10, 11, 12, 13, 22, 23].map((logicalProcessor) => ({ logicalProcessor, efficiencyClass: 1 })),
  ...[2, 3, 4, 5, 6, 7, 8, 9, 14, 15, 16, 17, 18, 19, 20, 21].map((logicalProcessor) => ({ logicalProcessor, efficiencyClass: 0 })),
];

function constrainedProfile(enforced, navigator = {}) {
  return { name: 'lane', simulated: Boolean(Object.keys(navigator).length), evidence: createProfileEvidence({ navigator, enforced }) };
}

function jobEnforcement({ mask = '60', processes = 3, outside = [], rate = 0, flags = 0, memory = '0' } = {}) {
  return {
    supported: true,
    adapter: 'windows-job',
    resolvedAffinity: { logicalProcessors: [2, 3, 4, 5], mask: '0x3c', coreClassSatisfied: true },
    limits: { affinityMask: mask, cpuRateHundredthsPercent: rate, cpuRateControlFlags: flags, jobMemoryLimitBytes: memory },
    processes: Array.from({ length: processes }, (_, index) => ({
      pid: 100 + index,
      inJob: !outside.includes(100 + index),
      affinityMask: mask,
    })),
  };
}

describe('weak-hardware evidence contract', () => {
  it('labels reported-capability changes as capability simulation, never as enforcement', () => {
    const evidence = createProfileEvidence({ navigator: { deviceMemory: 4, hardwareConcurrency: 4 } });

    expect(evidence.categories).toEqual([EVIDENCE_CATEGORIES.CAPABILITY_SIMULATION]);
    expect(evidence.enforced).toEqual({});
    expect(evidence.limitations.join(' ')).toMatch(/do not limit host RAM or CPU cores/);
  });

  it('states that a VRAM label is not enforced', () => {
    const evidence = createProfileEvidence({ gpu: { mode: 'host', vramProxyMb: 4096 }, navigator: { deviceMemory: 4 } });

    expect(evidence.reported.vramLabelMb).toBe(4096);
    expect(evidence.limitations.join(' ')).toMatch(/4096 MB VRAM figure is a label; VRAM is not reserved or limited/);
  });

  it('records the enforcement mechanism and system-wide meaning of each constraint', () => {
    const evidence = createProfileEvidence({
      enforced: {
        cpuAffinity: { count: 4, coreClass: 'efficiency' },
        cpuRate: { percentOfSystem: 25 },
        browserCommit: { bytes: 2 * 1024 ** 3 },
      },
    });

    expect(evidence.categories).toEqual([EVIDENCE_CATEGORIES.RESOURCE_CONSTRAINED_HOST]);
    expect(evidence.enforced).toEqual({
      cpuAffinity: { count: 4, coreClass: 'efficiency', mechanism: 'windows-job-affinity' },
      cpuRate: { percentOfSystem: 25, hundredthsPercent: 2500, mechanism: 'windows-job-cpu-rate-hard-cap' },
      browserCommit: { bytes: 2 * 1024 ** 3, mechanism: 'windows-job-memory-limit' },
    });
    expect(evidence.limitations.join(' ')).toMatch(/share of the whole host \(all logical processors\), not of one core/);
    expect(evidence.limitations.join(' ')).toMatch(/not total system RAM/);
  });

  it('keeps a selected physical adapter in the native-host category', () => {
    const evidence = createProfileEvidence({ gpuAdapter: { expectedVendor: 'Intel' } });

    expect(evidence.categories).toEqual([EVIDENCE_CATEGORIES.NATIVE_HOST]);
    expect(evidence.selected.gpuAdapter).toMatchObject({ expectedVendor: 'intel', mechanism: 'chrome-use-adapter-luid' });
  });

  it('rejects malformed constraint requests', () => {
    expect(() => createProfileEvidence({ enforced: { cpuRate: { percentOfSystem: 0 } } })).toThrow(/within \(0, 100\]/);
    expect(() => createProfileEvidence({ enforced: { cpuAffinity: { count: 0 } } })).toThrow(/integer from 1 to 64/);
    expect(() => createProfileEvidence({ enforced: { cpuAffinity: { count: 2, coreClass: 'fast' } } })).toThrow(/coreClass/);
    expect(() => createProfileEvidence({ enforced: { browserCommit: { bytes: -1 } } })).toThrow(/positive integer/);
  });

  it('flags profiles that claim physical-target evidence or hide a simulation', () => {
    expect(validateProfileEvidence({ name: 'bad', simulated: true, evidence: { categories: ['physical-target'], reported: {}, limitations: ['x'] } }))
      .toContain('bad: physical-target evidence comes from an attested run, never from a profile definition');
    expect(validateProfileEvidence({
      name: 'hidden',
      simulated: false,
      evidence: { categories: ['native-host'], reported: { deviceMemoryGb: 2, hardwareConcurrency: null, webgpu: 'host' }, limitations: [] },
    })).toContain('hidden: reported capabilities differ from the host but the profile is not labelled capability-simulation');
    expect(validateProfileEvidence({ name: 'none' })).toEqual(['none: missing evidence descriptor']);
  });

  it('resolves affinity requests from the host topology without mixing core classes', () => {
    expect(resolveCpuAffinity({ count: 4, coreClass: 'efficiency' }, HOST_TOPOLOGY)).toMatchObject({
      available: true,
      logicalProcessors: [2, 3, 4, 5],
      mask: '0x3c',
      efficiencyClasses: [0, 0, 0, 0],
    });
    expect(resolveCpuAffinity({ count: 4, coreClass: 'performance' }, HOST_TOPOLOGY)).toMatchObject({
      logicalProcessors: [0, 1, 10, 11],
      efficiencyClasses: [1, 1, 1, 1],
    });
    expect(resolveCpuAffinity({ count: 9, coreClass: 'performance' }, HOST_TOPOLOGY)).toEqual({
      available: false,
      reason: 'host has 8 performance logical processors; 9 requested',
    });
    expect(resolveCpuAffinity({ count: 1, coreClass: 'any' }, [])).toEqual({ available: false, reason: 'host topology unavailable' });
  });

  it('marks a run invalid-environment when an enforced constraint is not applied', () => {
    const profile = constrainedProfile({ cpuAffinity: { count: 4, coreClass: 'efficiency' } });

    const applied = assessRunEnvironment({ profile, observed: { enforcement: jobEnforcement(), calibration: { workers: 24, busyLogicalProcessors: 3.9 } } });
    const exceeded = assessRunEnvironment({ profile, observed: { enforcement: jobEnforcement(), calibration: { workers: 24, busyLogicalProcessors: 11.2 } } });
    expect(exceeded.violations).toEqual(['enforced.cpu.effect: a 24-worker calibration kept 11.20 logical processors busy, above the allowed 4']);
    const missingAdapter = assessRunEnvironment({ profile, observed: { enforcement: { supported: false, processes: [], error: 'pipe-launched browser has no constraint adapter' } } });
    const escaped = assessRunEnvironment({ profile, observed: { enforcement: jobEnforcement({ outside: [101] }) } });
    const wrongMask = assessRunEnvironment({ profile, observed: { enforcement: jobEnforcement({ mask: '15' }) } });

    expect(applied).toMatchObject({ status: 'valid', violations: [] });
    expect(missingAdapter.status).toBe('invalid-environment');
    expect(missingAdapter.violations).toContain('enforcement.adapter: pipe-launched browser has no constraint adapter');
    expect(escaped.violations).toContain('enforcement.process-coverage: browser processes ran outside the constraint job');
    expect(wrongMask.status).toBe('invalid-environment');
  });

  it('does not count a process that exited before inspection as outside the job', () => {
    const profile = constrainedProfile({ cpuAffinity: { count: 4, coreClass: 'efficiency' } });
    const calibration = { workers: 24, busyLogicalProcessors: 3.9 };
    const withProcess = (extra) => {
      const enforcement = jobEnforcement();
      enforcement.processes.push(extra);
      return assessRunEnvironment({ profile, observed: { enforcement, calibration } });
    };

    // Matrix shape: one pid failed both coverage and affinity with no detail.
    expect(withProcess({ pid: 57524, name: 'chrome.exe', inJob: false, affinityMask: null, openError: 87 })).toMatchObject({ status: 'valid', violations: [] });
    const denied = withProcess({ pid: 57525, name: 'chrome.exe', inJob: false, affinityMask: null, openError: 5 });
    expect(denied.status).toBe('unverified');
    expect(denied.checks.find((entry) => entry.name === 'enforcement.process-coverage').observed.uninspectable).toEqual([{ pid: 57525, name: 'chrome.exe', openError: 5 }]);
    const escaped = withProcess({ pid: 57526, name: 'chrome.exe', parentPid: 900, commandLineMatched: true, listedInJob: false, inJob: false, affinityMask: '60', openError: null });
    expect(escaped.status).toBe('invalid-environment');
    expect(escaped.checks.find((entry) => entry.name === 'enforcement.process-coverage').observed.outsideDetails)
      .toEqual([{ pid: 57526, name: 'chrome.exe', parentPid: 900, commandLineMatched: true, listedInJob: false }]);
  });

  it('verifies CPU-rate and memory limits from the job, not from the request', () => {
    const profile = constrainedProfile({ cpuRate: { percentOfSystem: 25 }, browserCommit: { bytes: 1024 } });

    expect(assessRunEnvironment({ profile, observed: { enforcement: jobEnforcement({ rate: 2500, flags: 5, memory: '1024' }) } }).status).toBe('valid');
    expect(assessRunEnvironment({ profile, observed: { enforcement: jobEnforcement({ rate: 2500, flags: 1, memory: '1024' }) } }).violations)
      .toContain('enforced.cpuRate: the hard CPU-rate cap was not active on the job');
    expect(assessRunEnvironment({ profile, observed: { enforcement: jobEnforcement({ rate: 2500, flags: 5, memory: '0' }) } }).violations)
      .toContain('enforced.browserCommit: the job memory limit was not active');
  });

  it('invalidates a memory-ceiling run whose observed peak commit exceeded the ceiling', () => {
    const gib = 1024 ** 3;
    const profile = constrainedProfile({ browserCommit: { bytes: 2 * gib } });
    const enforcement = (peak) => ({
      ...jobEnforcement({ memory: String(2 * gib) }),
      limits: { jobMemoryLimitBytes: String(2 * gib), peakJobMemoryUsedBytes: String(peak) },
    });

    expect(assessRunEnvironment({ profile, observed: { enforcement: enforcement(1.9 * gib) } }).status).toBe('valid');
    expect(assessRunEnvironment({ profile, observed: { enforcement: enforcement(2663 * 1024 * 1024) } }).violations)
      .toEqual(['enforced.browserCommit.held: observed peak commit 2663 MiB exceeded the 2048 MiB ceiling']);
  });

  it('requires spoofed values and injected faults to be observed in the page', () => {
    const profile = {
      name: 'fault',
      simulated: true,
      evidence: createProfileEvidence({
        navigator: { hardwareConcurrency: 2 },
        disableWebGpu: true,
        injected: [{ kind: 'webgpu-request-device-rejects' }],
      }),
    };

    const result = assessRunEnvironment({
      profile,
      observed: { page: { hardwareConcurrency: 24, navigatorGpu: true }, injections: {} },
    });

    expect(result.status).toBe('invalid-environment');
    expect(result.violations).toEqual([
      'reported.hardwareConcurrency: navigator.hardwareConcurrency override did not reach the toolbar-player page',
      'webgpu.hidden: navigator.gpu is still exposed',
      'injected.webgpu-request-device-rejects: the injected condition was never triggered, so the run did not exercise it',
    ]);
  });

  it('requires the selected physical adapter to be the one WebGPU reports', () => {
    const profile = { name: 'igpu', evidence: createProfileEvidence({ gpuAdapter: { expectedVendor: 'intel' } }) };

    expect(assessRunEnvironment({ profile, observed: { gpuAdapter: { vendor: 'intel' } } }).status).toBe('valid');
    expect(assessRunEnvironment({ profile, observed: { gpuAdapter: { vendor: 'nvidia' } } }).violations)
      .toEqual(['selected.gpuAdapter: WebGPU did not select the requested physical adapter']);
  });

  it('treats non-isolated, unlocked or busy-host measurements as contaminated', () => {
    const clean = { schedulingMode: 'isolated', lock: { held: true }, hostLoad: { foreignCpuFraction: 0.05, foreignGpuUtilizationPercent: 10 } };

    expect(assessMeasurementValidity({ ...clean, usesGpu: true })).toMatchObject({ contaminated: false, reasons: [] });
    expect(assessMeasurementValidity({ ...clean, schedulingMode: 'contention' }).reasons).toEqual(['scheduling mode is contention, not isolated']);
    expect(assessMeasurementValidity({ ...clean, lock: { held: false } }).reasons).toEqual(['the host-wide measurement lock was not held']);
    expect(assessMeasurementValidity({ ...clean, hostLoad: { foreignCpuFraction: CONTAMINATION_THRESHOLDS.foreignCpuFraction } }).contaminated).toBe(true);
    expect(assessMeasurementValidity({ ...clean, hostLoad: { foreignCpuFraction: null } }).reasons).toEqual(['foreign CPU load was not measured']);
    expect(assessMeasurementValidity({ ...clean, hostLoad: { foreignCpuFraction: 0.05, foreignGpuUtilizationPercent: 65 }, usesGpu: true }).reasons)
      .toEqual(['foreign GPU utilization 65% is at or above 25%']);
    expect(assessMeasurementValidity({ ...clean, hostLoad: { foreignCpuFraction: 0.05, foreignGpuUtilizationPercent: 65 }, usesGpu: false }).contaminated).toBe(false);
  });

  it.each([
    ['absent', undefined], ['null', null], ['empty', ''], ['whitespace', '  '],
    ['NaN', NaN], ['positive infinity', Infinity], ['negative infinity', -Infinity], ['nonnumeric', 'unavailable'],
  ])('excludes unknown GPU telemetry from GPU timing: %s', (_name, gpu) => {
    const input = { schedulingMode: 'isolated', lock: { held: true },
      hostLoad: { foreignCpuFraction: 0.05, foreignGpuUtilizationPercent: gpu } };
    expect(assessMeasurementValidity({ ...input, usesGpu: true }))
      .toMatchObject({ contaminated: true, reasons: ['foreign GPU load was not measured'] });
    expect(assessMeasurementValidity({ ...input, usesGpu: false }))
      .toMatchObject({ contaminated: false, reasons: [] });
  });

  it('accepts measured GPU zero without altering the existing busy threshold reason', () => {
    const input = { schedulingMode: 'isolated', lock: { held: true }, usesGpu: true };
    for (const gpu of [0, '0', 24.999]) {
      expect(assessMeasurementValidity({ ...input, hostLoad: { foreignCpuFraction: 0.05, foreignGpuUtilizationPercent: gpu } }))
        .toMatchObject({ contaminated: false, reasons: [] });
    }
    expect(assessMeasurementValidity({ ...input, hostLoad: { foreignCpuFraction: 0.05, foreignGpuUtilizationPercent: 25 } }).reasons)
      .toEqual(['foreign GPU utilization 25% is at or above 25%']);
  });

  it('resolves the executed backend from fallbacks instead of the initial plan', () => {
    const base = { selectedBackendPlan: { device: 'webgpu' }, firstSynthesisMs: 500, audioDurationSeconds: 3 };

    expect(resolveExecutionBackend({ ...base, fallbacks: [] })).toMatchObject({ requested: 'webgpu', observed: 'webgpu', fellBack: false });
    expect(resolveExecutionBackend({ ...base, fallbacks: [{ type: 'model', fallbackPlan: { device: 'wasm' } }] }))
      .toMatchObject({ requested: 'webgpu', observed: 'wasm', fellBack: true, source: 'model-fallback-plan' });
    expect(resolveExecutionBackend({ ...base, firstSynthesisMs: null })).toMatchObject({ observed: null, producedAudio: false });
  });
});
