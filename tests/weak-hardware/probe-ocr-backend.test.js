import { describe, expect, it } from 'vitest';
import { finalizeAttempt } from '../live/tts-probe-results.js';
import { forceProbePdfOcrCpu, summarizeProbePdfOcr, probePdfOcrAdapterFailures } from '../live/tts-probe-ocr.js';
import { createProfileEvidence } from '../../scripts/weak-hardware/evidence-contract.mjs';
import { probeState } from '../live/tts-probe-settings.js';
import { describeProbeGpuAdapterSelection } from '../live/tts-probe-browser.js';

const cpu = { playbackSettings: { ttsBackendPreference: 'wasm' } };
const inventory = { adaptersComplete: true, adapterErrors: [], adapters: [{ description: 'Authored physical Intel', vendorId: 0x8086, deviceId: 0x7d55, luidHigh: 0, luidLow: 108530, software: false }] };
const selected = () => describeProbeGpuAdapterSelection(inventory, inventory.adapters[0]);
const launch = () => ({ supervisor: 'windows-job', args: ['--use-adapter-luid=0,108530'] });

const snapshot = (forceCpu = true, count = 0) => ({ contractVersion: 1, timeOrigin: 1000, forceCpu,
  effectiveGpuAvailable: !forceCpu, counts: { requestAdapter: count, requestDevice: count, submit: count },
  deviceAdapters: Array.from({ length: count }, () => ({ vendor: 'intel', device: '', isFallbackAdapter: null })), errors: [] });
function finish({ ocr, selectedLuid = null, gpu = false } = {}) {
  const previousLock = probeState.lock;
  probeState.lock = { held: true };
  const attempt = { documentType: 'scanned-pdf', hardware: {}, condition: {}, ocr };
  const engine = time => ({ instanceName: 'pid_10_intel_phys_0_eng_0', pid: 10, luid: '0x00000000_0x0001A7F2',
    engineId: 'phys_0_eng_0', engineType: '3D', isJob: true, runningTime100ns: String(time) });
  const counters = (at, time) => ({ timestamp100ns: String(at), engineInstancesComplete: true,
    engineInstances: [engine(time)], engines: [], memory: [] });
  try {
    finalizeAttempt({ attempt, profile: { name: 'authored-ocr-counter', evidence: createProfileEvidence({ native: true }) },
      probe: { result: { selectedBackendPlan: { device: 'wasm' }, firstSynthesisMs: 10, audioDurationSeconds: 1 } },
      page: {}, output: null, assertionFailures: [], timedOut: false,
      enforcementBefore: { accounting: { totalUserTime100ns: '0', totalKernelTime100ns: '0', queriedAtUtc: '2026-10-17T00:00:00.000Z' } },
      enforcementAfter: { accounting: { totalUserTime100ns: '500000', totalKernelTime100ns: '0', queriedAtUtc: '2026-10-17T00:00:01.000Z' } },
      gpuBefore: gpu ? counters(0, 0) : null, gpuAfter: gpu ? counters(10_000_000, 100_000) : null, heap: null,
      ticksBefore: { idle: 0, total: 0, logicalProcessors: 1 }, ticksAfter: { idle: 900, total: 1000, logicalProcessors: 1 },
      startedAtMs: Date.now(), hostLoadBefore: { foreignCpuFraction: 0.01, foreignGpuUtilizationPercent: 0 },
      browser: { gpuAdapterSelection: selectedLuid ? selected() : null, launch: launch() }, workers: [] });
    return attempt;
  } finally { probeState.lock = previousLock; }
}

describe('scanned PDF OCR performance qualification', () => {
  it('forces CPU OCR for explicit CPU speech and permits absent GPU telemetry only with valid OCR evidence', () => {
    expect(forceProbePdfOcrCpu(cpu)).toBe(true);
    const ocr = summarizeProbePdfOcr({ documentType: 'scanned-pdf', profile: cpu, before: snapshot(), after: snapshot() });
    const attempt = finish({ ocr });
    expect(attempt.execution.observed).toBe('wasm');
    expect(attempt.measurement.contaminated).toBe(false);
  });
  it('does not qualify an old or missing scanned PDF observation as CPU-only', () => {
    expect(finish().measurement.contaminated).toBe(true);
    const ocr = summarizeProbePdfOcr({ documentType: 'scanned-pdf', profile: cpu, before: null, after: null });
    expect(finish({ ocr }).measurement.contaminated).toBe(true);
  });
  it('requires selected-adapter GPU telemetry for observed OCR work despite CPU speech', () => {
    const ocr = summarizeProbePdfOcr({ documentType: 'scanned-pdf', before: snapshot(false), after: snapshot(false, 1) });
    const missing = finish({ ocr });
    expect(missing.execution.observed).toBe('wasm');
    expect(missing.measurement.contaminated).toBe(true);
    expect(missing.measurement.reasons.join(' ')).toMatch(/GPU.*not measured/);
    const valid = finish({ ocr, selectedLuid: 'Intel', gpu: true });
    expect(valid.measurement.contaminated).toBe(false);
  });
  it('rejects OCR adapter identity that conflicts with otherwise healthy selected Intel counters', () => {
    const after = snapshot(false, 1); after.deviceAdapters[0].vendor = 'nvidia'; after.deviceAdapters[0].device = '0x2b85';
    const ocr = summarizeProbePdfOcr({ documentType: 'scanned-pdf', before: snapshot(false), after });
    const attempt = finish({ ocr, selectedLuid: 'Intel', gpu: true });
    expect(attempt.measurement.contaminated).toBe(true);
    expect(attempt.error).toMatch(/observed vendor.*differs|nonempty device ID.*conflicts/);
  });
  it('fails an explicitly CPU OCR read when actual WebGPU observation contradicts it', () => {
    const ocr = summarizeProbePdfOcr({ documentType: 'scanned-pdf', profile: cpu, before: snapshot(), after: { ...snapshot(), counts: { requestAdapter: 0, requestDevice: 0, submit: 1 } } });
    const attempt = finish({ ocr, selectedLuid: 'Intel', gpu: true });
    expect(attempt.status).toBe('failed');
    expect(attempt.measurement.contaminated).toBe(true);
    expect(attempt.error).toMatch(/CPU OCR selection contradicted/);
  });
});

describe('OCR vendor-only adapter binding', () => {
  const observed = () => ({ usesGpu: true, after: { deviceAdapters: [{ vendor: 'intel', device: '', isFallbackAdapter: null }] } });
  it('retains missing WebGPU fields and joins its actual vendor to one selected physical DXGI row', () => {
    const ocr = observed(), before = structuredClone(ocr);
    expect(probePdfOcrAdapterFailures(ocr, selected(), {}, launch())).toEqual([]);
    expect(ocr).toEqual(before);
  });
  it.each(['incomplete', 'error', 'ambiguous', 'software', 'counter', 'launch'])('refuses %s association rather than fabricating missing PCI or fallback evidence', (kind) => {
    const binding = selected(), command = launch();
    if (kind === 'incomplete') binding.inventoryComplete = false;
    if (kind === 'error') binding.inventoryErrors = ['authored GetDesc1 failure'];
    if (kind === 'ambiguous') binding.allAdapters.push({ ...binding.allAdapters[0], luidLow: 108531, chromeLuid: '0,108531', counterLuid: '0x00000000_0x0001A7F3' });
    if (kind === 'software') binding.software = true;
    if (kind === 'counter') binding.counterLuid = '0x00000000_0x00000001';
    if (kind === 'launch') command.args = [];
    expect(probePdfOcrAdapterFailures(observed(), binding, {}, command).length).toBeGreaterThan(0);
  });
});
