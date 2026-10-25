import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MATRIX_STAGES,
  collectLaneVerdicts,
  isPassingVerdict,
  parseMatrixArgs,
  selectMatrixStages,
} from '../../scripts/weak-hardware/run-matrix.mjs';
import { getTtsProbeProfiles } from '../live/live-tts-hardware-profiles.js';
import { getTtsProbeDocumentTypes } from '../live/live-tts-hardware-probe-documents.js';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('weak-hardware acceptance matrix', () => {
  it('runs the default stages and keeps expensive stages opt-in', () => {
    expect(selectMatrixStages(parseMatrixArgs([]))).toEqual(['baseline', 'memory', 'faults', 'lifecycle']);
    expect(selectMatrixStages(parseMatrixArgs(['--workloads', '--soak=10']))).toEqual(['baseline', 'memory', 'faults', 'lifecycle', 'workloads', 'soak']);
    expect(parseMatrixArgs(['--soak=10', '--runs=30', '--require-pass'])).toMatchObject({ soakMinutes: 10, runs: 30, requirePass: true });
    expect(() => parseMatrixArgs(['--fast'])).toThrow(/Unknown option/);
    expect(() => selectMatrixStages({ stages: ['nope'] })).toThrow(/Unknown matrix stage/);
  });

  it('only references lane sets and documents the probe knows', () => {
    for (const stage of Object.values(MATRIX_STAGES)) {
      expect(getTtsProbeProfiles(stage.profiles).length).toBeGreaterThan(0);
      expect(getTtsProbeDocumentTypes(stage.documents).length).toBeGreaterThan(0);
    }
  });

  it('treats unfinished jobs and failing lanes as a non-pass', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pn-matrix-'));
    roots.push(root);
    writeFileSync(path.join(root, 'tts-hardware-probe-native_webgpu.json'), JSON.stringify({ lanes: [{ profileName: 'native_webgpu', verdict: 'passed' }] }));
    writeFileSync(path.join(root, 'tts-hardware-probe-mem_1gib_webgpu.json'), JSON.stringify({ lanes: [{ profileName: 'mem_1gib_webgpu', verdict: 'reproducible' }] }));
    writeFileSync(path.join(root, 'tts-hardware-probe-cpu_rate25_wasm.json'), JSON.stringify({ attempts: [{ status: 'running' }] }));
    writeFileSync(path.join(root, 'tts-requirements-summary.json'), '{}');

    const lanes = collectLaneVerdicts(root);

    expect(lanes.map((lane) => [lane.profileName, lane.verdict])).toEqual([
      ['cpu_rate25_wasm', 'incomplete'],
      ['mem_1gib_webgpu', 'reproducible'],
      ['native_webgpu', 'passed'],
    ]);
    expect(lanes.filter((lane) => !isPassingVerdict(lane.verdict)).map((lane) => lane.profileName)).toEqual(['cpu_rate25_wasm']);
  });
});
