import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  buildJobLimits,
  computeGpuEngineUsage,
  computeJobCpuUsage,
  createSupervisorCommand,
  formatChromeAdapterLuid,
  formatCounterAdapterLuid,
  isJobSupervisorSupported,
  summarizeJobEnforcement,
  vendorNameForId,
} from '../../scripts/weak-hardware/windows-job.mjs';
import { createProfileEvidence } from '../../scripts/weak-hardware/evidence-contract.mjs';
import { CdpWebSocketConnection } from '../live/cdp-connection.js';
import { createProbeBrowserArgs, createProbeProfileArgumentPattern, selectProbeSupervisor, verifyBrowserTreeGone } from '../live/tts-probe-browser.js';
import { finalizeAttempt } from '../live/tts-probe-results.js';
import { probeState } from '../live/tts-probe-settings.js';
import { getProbeCleanupFailures } from '../live/live-tts-hardware-probe-assertions.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  spawnSync: vi.fn(),
}));

vi.mock('node:timers/promises', async (importOriginal) => ({
  ...(await importOriginal()),
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));

function gpuInstance({ name = 'pid_10_L1_3D', pid = 10, luid = 'L1', engineId = 'phys_0_eng_0', engineType = '3D', isJob = false, time = '0' } = {}) {
  return { instanceName: name, pid, luid, engineId, engineType, isJob, runningTime100ns: time };
}

function gpuSnapshot(timestamp, instances, extras = {}) {
  return { timestamp100ns: String(timestamp), engineInstancesComplete: true, engineInstances: instances, engines: [], memory: [], ...extras };
}

function finalizedMeasurement(overrides = {}) {
  const attempt = overrides.attempt || { hardware: {}, condition: {} };
  const beforeLock = probeState.lock;
  probeState.lock = { held: true };
  try {
    finalizeAttempt({
      attempt,
      profile: { name: 'counter-contract', evidence: createProfileEvidence({ native: true }) },
      probe: { result: { selectedBackendPlan: { device: 'webgpu' }, firstSynthesisMs: 10, audioDurationSeconds: 1 } },
      page: {}, output: null, assertionFailures: [], timedOut: false,
      enforcementBefore: { accounting: { totalUserTime100ns: '0', totalKernelTime100ns: '0', queriedAtUtc: '2026-10-17T00:00:00.000Z' } },
      enforcementAfter: { accounting: { totalUserTime100ns: '500000', totalKernelTime100ns: '0', queriedAtUtc: '2026-10-17T00:00:01.000Z' } },
      gpuBefore: null, gpuAfter: null, heap: null,
      ticksBefore: { idle: 0, total: 0, logicalProcessors: 1 },
      ticksAfter: { idle: 900, total: 1000, logicalProcessors: 1 },
      startedAtMs: Date.now(),
      hostLoadBefore: { foreignCpuFraction: 0.01, foreignGpuUtilizationPercent: 0 },
      browser: { gpuAdapterSelection: { counterLuid: 'Intel' } }, workers: [],
      ...overrides,
    });
    return attempt;
  } finally {
    probeState.lock = beforeLock;
  }
}

class FakeSocket {
  constructor() {
    this.sent = [];
    this.listeners = new Map();
  }

  addEventListener(type, callback) {
    const list = this.listeners.get(type) || [];
    list.push(callback);
    this.listeners.set(type, list);
  }

  emit(type, event = {}) {
    for (const callback of this.listeners.get(type) || []) callback(event);
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.emit('close');
  }
}

describe('Windows job supervisor helpers', () => {
  it('serializes only the observed current-read signal as warm audio latency', () => {
    const attempt = finalizedMeasurement({
      attempt: { hardware: {}, condition: {}, clickEpochMs: 20_000 },
      page: { audio: { firstNonSilentEpochMs: 1_000, segments: [
        { startEpochMs: 1_000, endEpochMs: 2_000 }, { startEpochMs: 20_400, endEpochMs: 21_000 },
      ] } },
    });

    expect(JSON.parse(JSON.stringify(attempt)).audio).toMatchObject({
      firstNonSilentEpochMs: 1_000, readFirstNonSilentEpochMs: 20_400, clickToFirstNonSilentMs: 400,
    });
    expect(attempt.measurementSources.audioTotalsScope).toBe('page lifetime; first signal latency is scoped to this read');
  });

  it('maps enforced constraints to job limits and refuses unresolved affinity', () => {
    const enforced = createProfileEvidence({
      enforced: { cpuAffinity: { count: 2, coreClass: 'efficiency' }, cpuRate: { percentOfSystem: 25 }, browserCommit: { bytes: 1024 } },
    }).enforced;

    expect(buildJobLimits(enforced, { resolvedAffinity: { mask: '0xc' } })).toEqual({
      affinityMask: '0xc',
      cpuRateHundredthsPercent: '2500',
      jobMemoryBytes: '1024',
    });
    expect(() => buildJobLimits(enforced)).toThrow(/resolved against the host topology/);
    expect(buildJobLimits({})).toEqual({});
  });

  it('starts the supervisor through PowerShell Add-Type with the checked-in source', () => {
    const { command, args } = createSupervisorCommand({ sourcePath: "C:/repo/it's/windows-job-supervisor.cs" });

    expect(command).toBe('powershell.exe');
    expect(args.at(-1)).toContain("Add-Type -Path 'C:/repo/it''s/windows-job-supervisor.cs'");
    expect(args.at(-1)).toContain('[PageNarrator.WeakHardware.JobSupervisor]::Run()');
    expect(isJobSupervisorSupported('linux')).toBe(false);
    expect(isJobSupervisorSupported('win32')).toBe(true);
  });

  it('summarizes job membership, limits and memory for the environment check', () => {
    const summary = summarizeJobEnforcement({
      ok: true,
      rootPid: 10,
      limits: { affinityMask: '60', peakJobMemoryUsedBytes: '3000' },
      accounting: { totalUserTime100ns: '10' },
      browserProcesses: [
        { pid: 10, inJob: true, listedInJob: true, affinityMask: '60', privateBytes: '100', workingSetBytes: '50' },
        { pid: 11, inJob: false, listedInJob: false, affinityMask: '16777215', privateBytes: '20' },
      ],
    });

    expect(summary).toMatchObject({ supported: true, adapter: 'windows-job', totals: { processCount: 2, privateBytes: 120, peakJobCommitBytes: 3000 } });
    expect(summary.processes.map((process) => process.inJob)).toEqual([true, false]);
    expect(summarizeJobEnforcement(null)).toMatchObject({ supported: false, processes: [] });
  });

  it('converts job CPU accounting into busy logical processors', () => {
    const usage = computeJobCpuUsage(
      { totalUserTime100ns: '0', totalKernelTime100ns: '0', queriedAtUtc: '2026-10-05T08:00:00.000Z' },
      { totalUserTime100ns: '30000000', totalKernelTime100ns: '10000000', queriedAtUtc: '2026-10-05T08:00:02.000Z' },
    );

    expect(usage).toEqual({ cpuSeconds: 4, wallSeconds: 2, busyLogicalProcessors: 2 });
    expect(computeJobCpuUsage(null, null)).toEqual({ cpuSeconds: null, wallSeconds: null, busyLogicalProcessors: null });
  });

  it.each([null, '', 'NaN', '-1'])('keeps invalid job CPU counter %s unavailable', (counter) => {
    const before = { totalUserTime100ns: counter, totalKernelTime100ns: '0', queriedAtUtc: '2026-10-17T00:00:00.000Z' };
    const after = { totalUserTime100ns: '500000', totalKernelTime100ns: '0', queriedAtUtc: '2026-10-17T00:00:01.000Z' };
    expect(computeJobCpuUsage(before, after)).toEqual({ cpuSeconds: null, wallSeconds: null, busyLogicalProcessors: null });
  });

  it('separates the supervised browser from foreign GPU work per adapter', () => {
    const before = {
      timestamp100ns: '0',
      engineInstancesComplete: true,
      engineInstances: [gpuInstance({ isJob: true }), gpuInstance({ name: 'pid_11_L1_3D', pid: 11 })],
      engines: [{ luid: 'L1', engineType: '3D', jobRunningTime100ns: '0', foreignRunningTime100ns: '0' }],
      memory: [],
    };
    const after = {
      timestamp100ns: '10000000',
      engineInstancesComplete: true,
      engineInstances: [gpuInstance({ isJob: true, time: '2500000' }), gpuInstance({ name: 'pid_11_L1_3D', pid: 11, time: '6500000' })],
      engines: [{ luid: 'L1', engineType: '3D', jobRunningTime100ns: '2500000', foreignRunningTime100ns: '6500000' }],
      memory: [{ luid: 'L1', jobDedicatedBytes: '1000', jobSharedBytes: '20' }],
    };

    const usage = computeGpuEngineUsage(before, after);

    expect(usage.available).toBe(true);
    expect(usage.adapters[0]).toMatchObject({ luid: 'L1', jobMaxEngineUtilization: 0.25, foreignMaxEngineUtilization: 0.65, jobDedicatedBytes: 1000 });
    expect(computeGpuEngineUsage({ enginesError: 'denied' }, { enginesError: 'denied' })).toMatchObject({ available: false, reason: 'denied' });
  });

  it('keeps legacy aggregates diagnostic when per-instance coverage is unavailable', () => {
    const before = { timestamp100ns: '0', engines: [] };
    const after = { timestamp100ns: '10000000', engines: [] };
    const usage = computeGpuEngineUsage(before, after);
    expect(usage).toMatchObject({ available: false, adapters: [], rawSnapshots: { before, after } });
  });

  it('counts a newly enumerated instance only with complete before-category coverage', () => {
    const before = gpuSnapshot(0, []);
    const after = gpuSnapshot(10000000, [gpuInstance({ time: '6500000' })]);
    expect(computeGpuEngineUsage(before, after).adapters[0]).toMatchObject({ foreignMaxEngineUtilization: 0.65 });
    expect(computeGpuEngineUsage({ ...before, engineInstancesComplete: false }, after)).toMatchObject({ available: false, adapters: [] });
  });

  it('includes a new busy engine even when another paired engine stays idle', () => {
    const idle = gpuInstance({ engineType: 'Copy' });
    const before = gpuSnapshot(0, [idle]);
    const after = gpuSnapshot(10000000, [idle, gpuInstance({ name: 'pid_11_L1_Compute', pid: 11, engineId: 'phys_0_eng_1', engineType: 'Compute', time: '8000000' })]);
    expect(computeGpuEngineUsage(before, after).adapters[0]).toMatchObject({ foreignMaxEngineUtilization: 0.8 });
  });

  it('accepts an empty engine display type when the physical engine identity is known', () => {
    const unnamed = gpuInstance({ name: 'pid_6132_luid_0x00000000_0x0001A7F2_phys_0_eng_9_engtype_', pid: 6132, luid: '0x00000000_0x0001A7F2', engineId: 'phys_0_eng_9', engineType: '' });
    const usage = computeGpuEngineUsage(gpuSnapshot(0, [unnamed]), gpuSnapshot(10000000, [{ ...unnamed, runningTime100ns: '4000000' }]));
    expect(usage.available).toBe(true);
    expect(usage.adapters[0]).toMatchObject({ foreignMaxEngineUtilization: 0.4, engines: [{ engineId: 'phys_0_eng_9', engineType: '', foreignUtilization: 0.4 }] });
    expect(usage.rawSnapshots.before.engineInstances[0].engineType).toBe('');
  });

  it('takes the maximum of separate physical engines sharing one display type', () => {
    const engine0 = gpuInstance();
    const engine1 = gpuInstance({ name: 'pid_10_L1_3D_engine1', engineId: 'phys_0_eng_1' });
    const engine2 = gpuInstance({ name: 'pid_10_L1_3D_physical1', engineId: 'phys_1_eng_0' });
    const usage = computeGpuEngineUsage(gpuSnapshot(0, [engine0, engine1, engine2]), gpuSnapshot(10000000, [
      { ...engine0, runningTime100ns: '3000000' }, { ...engine1, runningTime100ns: '4000000' }, { ...engine2, runningTime100ns: '2000000' },
    ]));
    expect(usage.adapters[0].foreignMaxEngineUtilization).toBe(0.4);
    expect(usage.adapters[0].engines.map((engine) => engine.engineId)).toEqual(['phys_0_eng_0', 'phys_0_eng_1', 'phys_1_eng_0']);
  });

  it('sums distinct process instances of the same actual engine before taking its maximum', () => {
    const process0 = gpuInstance();
    const process1 = gpuInstance({ name: 'pid_11_L1_3D', pid: 11 });
    const usage = computeGpuEngineUsage(gpuSnapshot(0, [process0, process1]), gpuSnapshot(10000000, [
      { ...process0, runningTime100ns: '2000000' }, { ...process1, runningTime100ns: '3000000' },
    ]));
    expect(usage.adapters[0].foreignMaxEngineUtilization).toBe(0.5);
    expect(usage.adapters[0].engines).toHaveLength(1);
  });

  it.each(['negative', 'reset', 'disappeared'])('retains healthy Intel coverage when NVIDIA counters are %s', (failure) => {
    const intel = gpuInstance({ luid: 'Intel' });
    const nvidia = gpuInstance({ name: 'pid_11_Nvidia', pid: 11, luid: 'Nvidia', time: '10' });
    const nvidiaAfter = failure === 'disappeared' ? [] : [{ ...nvidia, runningTime100ns: failure === 'negative' ? '-404156251' : '9' }];
    const before = gpuSnapshot(0, [intel, nvidia]);
    const after = gpuSnapshot(10000000, [intel, ...nvidiaAfter]);
    const usage = computeGpuEngineUsage(before, after);
    expect(usage.available).toBe(true);
    expect(usage.adapters).toHaveLength(1);
    expect(usage.adapters[0]).toMatchObject({ luid: 'Intel', foreignMaxEngineUtilization: 0 });
    expect(usage.unavailableAdapters).toEqual([{ luid: 'Nvidia', reason: expect.any(String) }]);
    expect(usage.rawSnapshots).toEqual({ before, after });
  });

  it('rejects the whole category when a row cannot be assigned to a trustworthy adapter', () => {
    const intel = gpuInstance({ luid: 'Intel' });
    const unknown = gpuInstance({ name: 'unparsed-instance', luid: null });
    const usage = computeGpuEngineUsage(gpuSnapshot(0, [intel]), gpuSnapshot(10000000, [intel, unknown]));
    expect(usage).toMatchObject({ available: false, adapters: [] });
  });

  it('refuses same-engine process turnover instead of subtracting unrelated lifetime counters', () => {
    const before = gpuSnapshot(0, [gpuInstance({ time: '9000000' })]);
    const after = gpuSnapshot(10000000, [gpuInstance({ name: 'pid_11_L1_3D', pid: 11, time: '8000000' })]);
    expect(computeGpuEngineUsage(before, after)).toMatchObject({ available: false, adapters: [] });
  });

  it.each([
    ['missing after instance', []],
    ['counter reset', [gpuInstance({ time: '9' })]],
    ['null counter', [gpuInstance({ time: null })]],
    ['invalid counter', [gpuInstance({ time: 'NaN' })]],
    ['fractional counter', [gpuInstance({ time: 10.5 })]],
    ['membership changed', [gpuInstance({ time: '11', isJob: true })]],
    ['identity changed', [gpuInstance({ time: '11', pid: 11 })]],
    ['physical engine changed', [gpuInstance({ time: '11', engineId: 'phys_0_eng_1' })]],
    ['missing engine identity', [gpuInstance({ time: '11', engineId: null })]],
    ['invalid engine identity', [gpuInstance({ time: '11', engineId: '3D' })]],
    ['duplicate instance', [gpuInstance({ time: '11' }), gpuInstance({ time: '11' })]],
  ])('refuses %s rather than reporting quiet GPU timing', (_name, instances) => {
    const before = gpuSnapshot(0, [gpuInstance({ time: '10' })]);
    const after = gpuSnapshot(10000000, instances);
    expect(computeGpuEngineUsage(before, after)).toMatchObject({ available: false, adapters: [], rawSnapshots: { before, after } });
  });

  it('rejects partial after enumeration even when an idle paired engine remains', () => {
    const before = gpuSnapshot(0, [gpuInstance()]);
    const after = gpuSnapshot(10000000, [gpuInstance()], { engineInstancesComplete: false });
    expect(computeGpuEngineUsage(before, after)).toMatchObject({ available: false });
  });

  it('differences integer counters before converting large lifetime totals to Number', () => {
    const before = gpuSnapshot('638962752000000000', [gpuInstance({ time: '9007199254740993' })]);
    const after = gpuSnapshot('638962752010000000', [gpuInstance({ time: '9007199259740993' })]);
    expect(computeGpuEngineUsage(before, after).adapters[0].foreignMaxEngineUtilization).toBe(0.5);
  });

  it('formats adapter LUIDs for Chrome and for performance counters', () => {
    const intel = { luidHigh: 0, luidLow: 114371, vendorId: 0x8086 };

    expect(formatChromeAdapterLuid(intel)).toBe('0,114371');
    expect(formatCounterAdapterLuid(intel)).toBe('0x00000000_0x0001BEC3');
    expect(vendorNameForId(0x10de)).toBe('nvidia');
    expect(vendorNameForId(0x8086)).toBe('intel');
    expect(vendorNameForId(1)).toBeNull();
  });
});

describe('attempt timing telemetry attribution', () => {
  it('does not substitute quiet pre-run NVIDIA load for absent selected Intel counters', () => {
    const nvidia = gpuInstance({ luid: 'Nvidia' });
    const attempt = finalizedMeasurement({ gpuBefore: gpuSnapshot(0, [nvidia]), gpuAfter: gpuSnapshot(10000000, [nvidia]) });
    expect(attempt.execution.observed).toBe('webgpu');
    expect(attempt.measurement.contaminated).toBe(true);
    expect(attempt.measurement.reasons).toContain('foreign GPU load was not measured');
    expect(attempt.hostLoad).toMatchObject({ before: { foreignGpuUtilizationPercent: 0 }, during: { foreignGpuUtilizationPercent: null } });
  });

  it('does not substitute pre-run GPU load when the sampler is unavailable', () => {
    const attempt = finalizedMeasurement();
    expect(attempt.execution.observed).toBe('webgpu');
    expect(attempt.measurement.reasons).toContain('foreign GPU load was not measured');
    expect(attempt.resources.gpu.available).toBe(false);
  });

  it('uses actual selected Intel counters even when the other adapter is busy', () => {
    const intel = gpuInstance({ luid: 'Intel' });
    const nvidia = gpuInstance({ name: 'pid_11_Nvidia_3D', pid: 11, luid: 'Nvidia' });
    const attempt = finalizedMeasurement({
      gpuBefore: gpuSnapshot(0, [intel, nvidia]),
      gpuAfter: gpuSnapshot(10000000, [intel, { ...nvidia, runningTime100ns: '9000000' }]),
    });
    expect(attempt.measurement.contaminated).toBe(false);
    expect(attempt.hostLoad.during.foreignGpuUtilizationPercent).toBe(0);
    expect(attempt.resources.gpu.usedAdapterLuid).toBe('Intel');
  });

  it('measures selected NVIDIA from a negative-based signed counter and rejects one that runs backwards', () => {
    const intel = gpuInstance({ luid: 'Intel' });
    const nvidia = gpuInstance({ name: 'pid_11_Nvidia', pid: 11, luid: 'Nvidia', time: '-404156251' });
    const browser = { gpuAdapterSelection: { counterLuid: 'Nvidia' } };
    const advancing = finalizedMeasurement({
      browser,
      gpuBefore: gpuSnapshot(0, [intel, nvidia]),
      gpuAfter: gpuSnapshot(10000000, [intel, { ...nvidia, runningTime100ns: '-403156251' }]),
    });
    expect(advancing.execution.observed).toBe('webgpu');
    expect(advancing.resources.gpu.unavailableAdapters).toEqual([]);
    expect(advancing.hostLoad.during.foreignGpuUtilizationPercent).toBe(10);
    expect(advancing.measurement.contaminated).toBe(false);
    const backwards = finalizedMeasurement({
      browser,
      gpuBefore: gpuSnapshot(0, [intel, nvidia]),
      gpuAfter: gpuSnapshot(10000000, [intel, { ...nvidia, runningTime100ns: '-404156252' }]),
    });
    expect(backwards.resources.gpu.unavailableAdapters).toEqual([{ luid: 'Nvidia', reason: 'GPU engine counter reset or invalid delta' }]);
    expect(backwards.hostLoad.during.foreignGpuUtilizationPercent).toBeNull();
    expect(backwards.measurement.reasons).toContain('foreign GPU load was not measured');
  });

  it('does not attribute TTS to an unrelated busy browser-job adapter without explicit launch binding', () => {
    const job = gpuInstance({ luid: 'Intel', isJob: true });
    const before = gpuSnapshot(0, [job]);
    const used = finalizedMeasurement({ browser: {}, gpuBefore: before, gpuAfter: gpuSnapshot(10000000, [{ ...job, runningTime100ns: '1000000' }]) });
    expect(used.execution.observed).toBe('webgpu');
    expect(used.resources.gpu.adapters[0]).toMatchObject({ luid: 'Intel', jobMaxEngineUtilization: 0.1 });
    expect(used.resources.gpu.usedAdapterLuid).toBeNull();
    expect(used.measurement.reasons).toContain('foreign GPU load was not measured');
    const idle = finalizedMeasurement({ browser: {}, gpuBefore: before, gpuAfter: gpuSnapshot(10000000, [job]) });
    expect(idle.resources.gpu.usedAdapterLuid).toBeNull();
    expect(idle.measurement.reasons).toContain('foreign GPU load was not measured');
  });

  it('keeps missing during-CPU accounting unknown despite a quiet pre-run CPU sample', () => {
    const attempt = finalizedMeasurement({
      probe: { result: { selectedBackendPlan: { device: 'wasm' }, firstSynthesisMs: 10, audioDurationSeconds: 1 } }, enforcementAfter: {},
    });
    expect(attempt.measurement.contaminated).toBe(true);
    expect(attempt.measurement.reasons).toContain('foreign CPU load was not measured');
    expect(attempt.hostLoad.before.foreignCpuFraction).toBe(0.01);
    expect(attempt.hostLoad.during.foreignCpuFraction).toBeNull();
  });

  it('does not turn a null during-CPU counter into measured zero', () => {
    const attempt = finalizedMeasurement({
      probe: { result: { selectedBackendPlan: { device: 'wasm' }, firstSynthesisMs: 10, audioDurationSeconds: 1 } },
      enforcementAfter: { accounting: { totalUserTime100ns: null, totalKernelTime100ns: '0', queriedAtUtc: '2026-10-17T00:00:01.000Z' } },
    });
    expect(attempt.hostLoad.during.foreignCpuFraction).toBeNull();
    expect(attempt.measurement.reasons).toContain('foreign CPU load was not measured');
  });

  it('allows measured CPU-only timing without GPU counter support', () => {
    const attempt = finalizedMeasurement({ probe: { result: { selectedBackendPlan: { device: 'wasm' }, firstSynthesisMs: 10, audioDurationSeconds: 1 } } });
    expect(attempt.execution.observed).toBe('wasm');
    expect(attempt.measurement.contaminated).toBe(false);
    expect(attempt.hostLoad.during.foreignCpuFraction).toBeCloseTo(0.05);
    expect(attempt.hostLoad.during.foreignGpuUtilizationPercent).toBeNull();
  });
});

describe('probe browser launch selection', () => {
  const native = { evidence: createProfileEvidence({ native: true }) };
  const constrained = { evidence: createProfileEvidence({ enforced: { cpuRate: { percentOfSystem: 25 } } }) };

  it('supervises constrained profiles with the job supervisor and blocks them elsewhere', () => {
    expect(selectProbeSupervisor({ profile: constrained, platform: 'win32' }).mode).toBe('job');
    expect(selectProbeSupervisor({ profile: constrained, platform: 'linux' })).toMatchObject({ mode: 'blocked' });
    expect(selectProbeSupervisor({ profile: constrained, platform: 'win32', requested: 'pipe' })).toMatchObject({ mode: 'blocked' });
    expect(selectProbeSupervisor({ profile: native, platform: 'linux' }).mode).toBe('pipe');
    expect(selectProbeSupervisor({ profile: native, platform: 'win32', requested: 'pipe' }).mode).toBe('pipe');
  });

  it('keeps the controlled occlusion flag unless the native-backgrounding lane is requested', () => {
    const controlled = createProbeBrowserArgs({ userDataDir: 'u', extensionDir: 'e' });
    const nativeLane = createProbeBrowserArgs({ userDataDir: 'u', extensionDir: 'e', nativeBackgrounding: true });

    expect(controlled).toContain('--disable-backgrounding-occluded-windows');
    expect(nativeLane).not.toContain('--disable-backgrounding-occluded-windows');
    expect(controlled).toContain('--mute-audio');
    expect(nativeLane).toContain('--mute-audio');
    expect(controlled.at(-1)).toBe('about:blank');
  });
});

describe('CDP over WebSocket', () => {
  it('routes responses, session events and closes pending commands', async () => {
    const socket = new FakeSocket();
    const cdp = new CdpWebSocketConnection(socket);
    const events = [];
    cdp.on('Target.attachedToTarget', (params, sessionId) => events.push([params.targetInfo.type, sessionId]));

    const response = cdp.send('Runtime.evaluate', { expression: '1' }, 'session-1');
    expect(socket.sent).toEqual([{ id: 1, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: 'session-1' }]);
    socket.emit('message', { data: JSON.stringify({ id: 1, result: { value: 1 } }) });
    socket.emit('message', { data: JSON.stringify({ method: 'Target.attachedToTarget', params: { targetInfo: { type: 'worker' } }, sessionId: 'page' }) });
    await expect(response).resolves.toEqual({ value: 1 });
    expect(events).toEqual([['worker', 'page']]);

    const pending = cdp.send('Browser.getVersion');
    socket.close();
    await expect(pending).rejects.toThrow('CDP WebSocket closed.');
    await expect(cdp.send('Browser.getVersion')).rejects.toThrow('CDP WebSocket closed.');
  });
});


describe('private probe browser process cleanup', () => {
  const privateDir = "C:\\probe\\owner's-run";
  const completed = (stdout = '', overrides = {}) => ({ status: 0, signal: null, stdout, stderr: '', ...overrides });

  beforeEach(() => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    vi.mocked(spawnSync).mockReset();
    vi.mocked(delay).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('verifies only a successful empty query and retains its receipt', async () => {
    vi.mocked(spawnSync).mockReturnValue(completed());
    await expect(verifyBrowserTreeGone(privateDir)).resolves.toMatchObject({
      verified: true, remaining: 0, forced: false,
      query: { status: 0, signal: null, error: null, stdout: '', stderr: '', pids: [] },
    });
    expect(spawnSync).toHaveBeenCalledTimes(1);
    const [command, args, options] = vi.mocked(spawnSync).mock.calls[0];
    expect(command).toBe('powershell.exe');
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(args[3]).toContain("$ErrorActionPreference = 'Stop'");
    expect(args[3]).toContain("Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" -ErrorAction Stop");
    expect(args[3]).toContain(`-match '${createProbeProfileArgumentPattern(privateDir).replaceAll("'", "''")}'`);
    expect(options).toEqual({ encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    expect(delay).not.toHaveBeenCalled();
  });

  it('waits for a valid private PID list to become empty before forcing', async () => {
    vi.mocked(spawnSync).mockReturnValueOnce(completed(' 101\r\n102\r\n')).mockReturnValueOnce(completed('\r\n'));
    await expect(verifyBrowserTreeGone(privateDir, { attempts: 2 })).resolves.toMatchObject({
      verified: true, remaining: 0, forced: false, query: { status: 0, pids: [] },
    });
    expect(spawnSync).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledExactlyOnceWith(250);
  });

  it.each([
    ['spawn error', completed('', { status: null, error: Object.assign(new Error('not found'), { code: 'ENOENT' }) })],
    ['timeout', completed('', { status: null, signal: 'SIGTERM', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) })],
    ['nonzero exit', completed('101\n', { status: 1, stderr: 'CIM query denied' })],
    ['signalled child', completed('', { signal: 'SIGTERM' })],
    ['nonterminating CIM diagnostic', completed('', { stderr: 'Get-CimInstance: Access is denied' })],
    ['unknown exit status', completed('', { status: null })],
    ['missing stdout', completed(null)],
    ['mixed PID and diagnostic', completed('101\nAccess is denied\n')],
    ['fractional PID', completed('1.5\n')],
    ['zero PID', completed('0\n')],
    ['negative PID', completed('-1\n')],
    ['unsafe integer PID', completed('9007199254740992\n')],
    ['PID beyond Windows DWORD', completed('4294967296\n')],
  ])('keeps %s unverified rather than treating it as zero remaining processes', async (_name, response) => {
    vi.mocked(spawnSync).mockReturnValue(response);
    const cleanup = await verifyBrowserTreeGone(privateDir);
    expect(cleanup).toMatchObject({ verified: false, remaining: null, forced: false, reason: expect.any(String) });
    expect(cleanup.query).toMatchObject({ status: response.status, signal: response.signal, stdout: response.stdout, stderr: response.stderr, pids: null });
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it('records a thrown spawn failure without claiming that no process remains', async () => {
    vi.mocked(spawnSync).mockImplementation(() => { throw Object.assign(new Error('spawn failed'), { code: 'EACCES' }); });
    await expect(verifyBrowserTreeGone(privateDir)).resolves.toMatchObject({
      verified: false, remaining: null, forced: false,
      query: { status: null, signal: null, error: 'spawn failed', errorCode: 'EACCES', pids: null },
    });
  });

  it('retains the twenty waits and only forces PIDs from the private query', async () => {
    let queries = 0;
    vi.mocked(spawnSync).mockImplementation((command) => command === 'powershell.exe'
      ? completed(++queries <= 20 ? '101\n102\n' : '') : completed());
    await expect(verifyBrowserTreeGone(privateDir)).resolves.toMatchObject({
      verified: true, remaining: 0, forced: true, forcedPids: [101, 102], query: { status: 0, pids: [] },
    });
    expect(queries).toBe(21);
    expect(vi.mocked(spawnSync).mock.calls.filter(([command]) => command === 'taskkill')).toEqual([
      ['taskkill', ['/PID', '101', '/T', '/F'], { windowsHide: true }],
      ['taskkill', ['/PID', '102', '/T', '/F'], { windowsHide: true }],
    ]);
    expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([...Array(20).fill(250), 500]);
  });

  it.each(['nonzero', 'throw'])('retains forced PIDs when the post-force query fails with %s', async (failure) => {
    let queries = 0;
    vi.mocked(spawnSync).mockImplementation((command) => {
      if (command !== 'powershell.exe') return completed();
      if (++queries === 1) return completed('101\n102\n');
      if (failure === 'throw') throw new Error('post-force query unavailable');
      return completed('', { status: 1, stderr: 'post-force query unavailable' });
    });
    await expect(verifyBrowserTreeGone(privateDir, { attempts: 1 })).resolves.toMatchObject({
      verified: false, remaining: null, forced: true, forcedPids: [101, 102],
      reason: expect.any(String), query: { pids: null },
    });
    expect(queries).toBe(2);
    expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([250, 500]);
  });

  it('reports a remaining PID after a successful post-force query', async () => {
    let queries = 0;
    vi.mocked(spawnSync).mockImplementation((command) => command === 'powershell.exe'
      ? completed(++queries === 1 ? '101\n102\n' : '102\n') : completed());
    await expect(verifyBrowserTreeGone(privateDir, { attempts: 1 })).resolves.toMatchObject({
      verified: false, remaining: 1, forced: true, forcedPids: [101, 102], query: { status: 0, pids: [102] },
    });
  });
});


describe('probe cleanup reporting boundary', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['', 'C:\\', 'C:/', 'C:\\folder\\..', 'C:/folder/..', 'relative-profile'])('declines a non-private directory %s without querying or killing', async (directory) => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    vi.mocked(spawnSync).mockReset();
    await expect(verifyBrowserTreeGone(directory)).resolves.toMatchObject({ verified: false, remaining: null, forced: false });
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('accepts recorded empty cleanup after either normal or explicit forced teardown', () => {
    for (const forced of [false, true]) {
      const attempt = { attemptId: 'read-0', status: 'passed', browser: { launch: {} },
        cleanup: { verified: true, sessions: [{ verified: true, remaining: 0, forced }] } };
      expect(getProbeCleanupFailures([attempt])).toEqual([]);
    }
  });

  it('preserves blocked launches without an acquired browser as their original outcome', () => {
    const blocked = { attemptId: 'blocked', status: 'blocked', error: 'adapter absent',
      cleanup: { verified: false, sessions: [] } };
    expect(getProbeCleanupFailures([blocked])).toEqual([]);
    expect(blocked.status).toBe('blocked');
    expect(blocked.error).toBe('adapter absent');
  });

  it.each([
    ['missing cleanup', undefined],
    ['unverified cleanup', { verified: false, sessions: [{ verified: false, remaining: null }] }],
    ['missing session receipt', { verified: true }],
    ['empty session receipts', { verified: true, sessions: [] }],
    ['failed session', { verified: true, sessions: [{ verified: false, remaining: null }] }],
    ['unknown remaining count', { verified: true, sessions: [{ verified: true, remaining: null }] }],
    ['known remaining process', { verified: true, sessions: [{ verified: true, remaining: 1 }] }],
  ])('fails a launched browser with %s while retaining its original read outcome', (_name, cleanup) => {
    const attempt = { attemptId: 'read-0', status: 'passed', outcome: 'local-model', browser: { launch: {} }, cleanup };
    const before = JSON.stringify(attempt);
    expect(getProbeCleanupFailures([attempt])).toEqual(['read-0: browser cleanup is missing or unverified']);
    expect(JSON.stringify(attempt)).toBe(before);
  });
});


describe('probe profile argument ownership', () => {
  const vectors = [
  [
    "unquoted exact token",
    "C:\\Temp\\pagenarrator-tts-probe-A.[1]",
    "\"C:\\Program Files\\Chrome\\chrome.exe\" --remote-debugging-port=0 --user-data-dir=C:\\Temp\\pagenarrator-tts-probe-A.[1] --disable-sync",
    true
  ],
  [
    "whole token quoted",
    "C:\\Temp\\pagenarrator-tts-probe-A.[1]",
    "\"C:\\Program Files\\Chrome\\chrome.exe\" \"--user-data-dir=C:\\Temp\\pagenarrator-tts-probe-A.[1]\" --disable-sync",
    true
  ],
  [
    "quoted preceding argument",
    "C:\\Temp\\pagenarrator-tts-probe-A.[1]",
    "\"C:\\Program Files\\Chrome\\chrome.exe\" \"--note=ordinary text\" --user-data-dir=C:\\Temp\\pagenarrator-tts-probe-A.[1]",
    true
  ],
  [
    "mixed quoted preceding value",
    "C:\\Temp\\pagenarrator-tts-probe-A.[1]",
    "\"C:\\Program Files\\Chrome\\chrome.exe\" --note=\"ordinary text\" --user-data-dir=C:\\Temp\\pagenarrator-tts-probe-A.[1]",
    true
  ],
  [
    "case insensitive Windows path",
    "C:\\Temp\\pagenarrator-tts-probe-A.[1]",
    "\"C:\\Program Files\\Chrome\\chrome.exe\" --USER-DATA-DIR=C:\\TEMP\\PAGENARRATOR-TTS-PROBE-A.[1]",
    true
  ],
  [
    "space and apostrophe literal",
    "C:\\Temp\\owner's probe (A).[1]",
    "\"C:\\Program Files\\Chrome\\chrome.exe\" \"--user-data-dir=C:\\Temp\\owner's probe (A).[1]\" --disable-sync",
    true
  ],
  [
    "unquoted sibling suffix",
    "C:\\Temp\\pagenarrator-tts-probe-A.[1]",
    "\"C:\\Program Files\\Chrome\\chrome.exe\" --user-data-dir=C:\\Temp\\pagenarrator-tts-probe-A.[1]-other",
    false
  ],
  [
    "quoted sibling suffix",
    "C:\\Temp\\pagenarrator-tts-probe-A.[1]",
    "\"C:\\Program Files\\Chrome\\chrome.exe\" \"--user-data-dir=C:\\Temp\\pagenarrator-tts-probe-A.[1]-other\"",
    false
  ],
  [
    "different flag value",
    "C:\\Temp\\pagenarrator-tts-probe-A.[1]",
    "\"C:\\Program Files\\Chrome\\chrome.exe\" --cache-dir=C:\\Temp\\pagenarrator-tts-probe-A.[1]",
    false
  ],
  [
    "path mentioned in another argument",
    "C:\\Temp\\pagenarrator-tts-probe-A.[1]",
    "\"C:\\Program Files\\Chrome\\chrome.exe\" \"--note=mentions C:\\Temp\\pagenarrator-tts-probe-A.[1]\"",
    false
  ],
  [
    "token mentioned in quoted argument",
    "C:\\Temp\\pagenarrator-tts-probe-A.[1]",
    "\"C:\\Program Files\\Chrome\\chrome.exe\" \"--note=mentions --user-data-dir=C:\\Temp\\pagenarrator-tts-probe-A.[1] later\"",
    false
  ],
  [
    "token in mixed quoted value",
    "C:\\Temp\\pagenarrator-tts-probe-A.[1]",
    "\"C:\\Program Files\\Chrome\\chrome.exe\" --note=\"mentions --user-data-dir=C:\\Temp\\pagenarrator-tts-probe-A.[1] later\"",
    false
  ],
  [
    "token after escaped quote in other argument",
    "C:\\Temp\\pagenarrator-tts-probe-A.[1]",
    "\"C:\\Program Files\\Chrome\\chrome.exe\" \"--note=mentions \\\"quoted\\\" --user-data-dir=C:\\Temp\\pagenarrator-tts-probe-A.[1] later\"",
    false
  ],
  [
    "different flag name",
    "C:\\Temp\\pagenarrator-tts-probe-A.[1]",
    "\"C:\\Program Files\\Chrome\\chrome.exe\" --prefix-user-data-dir=C:\\Temp\\pagenarrator-tts-probe-A.[1]",
    false
  ],
  [
    "unquoted whitespace splits the token",
    "C:\\Temp\\owner's probe (A).[1]",
    "\"C:\\Program Files\\Chrome\\chrome.exe\" --user-data-dir=C:\\Temp\\owner's probe (A).[1]",
    false
  ],
  [
    "regexp metacharacters must remain literal",
    "C:\\Temp\\pagenarrator-tts-probe-A.[1]",
    "\"C:\\Program Files\\Chrome\\chrome.exe\" --user-data-dir=C:\\Temp\\pagenarrator-tts-probe-Ax1",
    false
  ],
  [
    "value-only quoting not generated by launcher",
    "C:\\Temp\\pagenarrator-tts-probe-A.[1]",
    "\"C:\\Program Files\\Chrome\\chrome.exe\" --user-data-dir=\"C:\\Temp\\pagenarrator-tts-probe-A.[1]\"",
    false
  ],
  [
    "additional token value suffix",
    "C:\\Temp\\pagenarrator-tts-probe-A.[1]",
    "\"C:\\Program Files\\Chrome\\chrome.exe\" \"--user-data-dir=C:\\Temp\\pagenarrator-tts-probe-A.[1] trailing\"",
    false
  ]
];

  it.each(vectors)('%s', (_name, directory, commandLine, owned) => {
    const pattern = createProbeProfileArgumentPattern(directory);
    expect(new RegExp(pattern, 'i').test(commandLine)).toBe(owned);
  });
});


describe('cleanup PID boundary and repeated-query failure', () => {
  beforeEach(() => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    vi.mocked(spawnSync).mockReset();
    vi.mocked(delay).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('accepts the highest Win32 PID without extending the process-query scope', async () => {
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, signal: null, stdout: '4294967295\n', stderr: '' })
      .mockReturnValueOnce({ status: 0, signal: null, stdout: '', stderr: '' });
    await expect(verifyBrowserTreeGone('C:\\probe\\private', { attempts: 2 })).resolves.toMatchObject({ verified: true, remaining: 0, forced: false });
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });

  it('does not kill stale known PIDs when a repeated pre-force query fails', async () => {
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, signal: null, stdout: '101\n', stderr: '' })
      .mockReturnValueOnce({ status: 1, signal: null, stdout: '', stderr: 'query denied' });
    await expect(verifyBrowserTreeGone('C:\\probe\\private', { attempts: 2 })).resolves.toMatchObject({
      verified: false, remaining: null, forced: false, query: { status: 1, stderr: 'query denied', pids: null },
    });
    expect(spawnSync).toHaveBeenCalledTimes(2);
    expect(vi.mocked(spawnSync).mock.calls.every(([command]) => command === 'powershell.exe')).toBe(true);
  });
});


describe('long probe profile argument ownership', () => {
  const directory = "C:\\Temp\\pagenarrator-tts-probe-A.[1]";
  const executable = "\"C:\\Program Files\\Chrome\\chrome.exe\"";
  const argument = `--user-data-dir=${directory}`;
  const filler = 'a'.repeat(100_000);
  const vectors = [
    ['long unquoted negative', `${executable} --note=${filler}`, false],
    ['long preceding positive', `${executable} --note=${filler} ${argument}`, true],
    ['long quoted mention negative', `${executable} "--note=${filler} ${argument}"`, false],
    ['long unclosed quoted mention negative', `${executable} "--note=${filler} ${argument}`, false],
    ['long sibling suffix negative', `${executable} ${argument}${filler}`, false],
    ['long unrelated flag negative', `${executable} --note=${filler} --cache-dir=${directory}`, false],
  ];

  it.each(vectors)('%s', (_name, commandLine, owned) => {
    expect(new RegExp(createProbeProfileArgumentPattern(directory), 'i').test(commandLine)).toBe(owned);
  });
});
