import { describe, expect, it } from 'vitest';
import {
  PHYSICAL_TARGET_ENV,
  loadPhysicalTarget,
  readHostInventory,
  verifyPhysicalTargetAttestation,
} from '../../scripts/weak-hardware/physical-target.mjs';
import { createTtsRequirementsSummary } from '../../scripts/summarize-tts-requirements.mjs';

const LAPTOP = Object.freeze({
  hostname: 'OFFICE-LAPTOP-A',
  cpuModel: 'Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz',
  logicalProcessors: 8,
  ramGb: 7.85,
  gpus: ['Intel(R) UHD Graphics 620'],
});

const ATTESTATION = Object.freeze({
  machine: 'Office laptop A',
  cpuModel: 'Intel Core i5-8250U CPU @ 1.60GHz',
  logicalProcessors: 8,
  ramGb: 8,
  gpus: ['Intel UHD Graphics 620'],
  attestedBy: 'Felix',
});

describe('physical-target attestation', () => {
  it('records the observed host identity independently from its display label', () => {
    const host = readHostInventory({ cpus: () => [{ model: 'Test CPU' }], totalmem: () => 4 * 1024 ** 3, hostname: () => 'ACTUAL-HOST' });
    expect(host).toEqual({ hostname: 'ACTUAL-HOST', cpuModel: 'Test CPU', logicalProcessors: 1, ramGb: 4 });
    expect(loadPhysicalTarget({ env: { [PHYSICAL_TARGET_ENV]: 'a.json' }, host: LAPTOP, readFile: () => JSON.stringify(ATTESTATION) }))
      .toMatchObject({ machine: 'Office laptop A', verifiedAgainst: { hostname: 'OFFICE-LAPTOP-A' } });
  });

  it('accepts an attestation that matches the host inventory', () => {
    expect(verifyPhysicalTargetAttestation(ATTESTATION, LAPTOP)).toEqual({ attested: true, problems: [] });
  });

  it('rejects an attestation that describes a different machine', () => {
    const devHost = { cpuModel: 'Intel(R) Core(TM) Ultra 9 285K', logicalProcessors: 24, ramGb: 63.3, gpus: ['NVIDIA GeForce RTX 5090', 'Intel(R) Graphics'] };

    expect(verifyPhysicalTargetAttestation(ATTESTATION, devHost).problems).toEqual([
      'CPU "Intel Core i5-8250U CPU @ 1.60GHz" does not match this host\'s "Intel(R) Core(TM) Ultra 9 285K"',
      '8 logical processors attested, 24 observed',
      '8 GB RAM attested, 63.3 GB observed',
      'adapters differ (attested only: Intel UHD Graphics 620; observed only: NVIDIA GeForce RTX 5090, Intel(R) Graphics)',
    ]);
  });

  it('requires every field', () => {
    expect(verifyPhysicalTargetAttestation({ machine: 'x' }, LAPTOP).problems).toEqual([
      'missing cpuModel', 'missing logicalProcessors', 'missing ramGb', 'missing gpus', 'missing attestedBy',
    ]);
  });

  it('refuses to start a run with a mismatched attestation and ignores an unset one', () => {
    const readFile = () => JSON.stringify(ATTESTATION);
    const host = { ...readHostInventory(), gpus: ['Some Other GPU'] };

    expect(loadPhysicalTarget({ env: {}, host })).toBeNull();
    expect(() => loadPhysicalTarget({ env: { [PHYSICAL_TARGET_ENV]: 'a.json' }, host, readFile })).toThrow(/attestation rejected/);
    expect(loadPhysicalTarget({ env: { [PHYSICAL_TARGET_ENV]: 'a.json' }, host: LAPTOP, readFile })).toMatchObject({ attested: true, machine: 'Office laptop A' });
  });

  it('turns an attested run into physical-target evidence in the requirements summary', () => {
    const attempt = {
      runId: 'r',
      documentType: 'article',
      profile: { name: 'native_webgpu', evidence: { categories: ['native-host'] } },
      status: 'passed',
      environment: { status: 'valid', categories: ['native-host'] },
      measurement: { contaminated: false },
      execution: { observed: 'webgpu', fellBack: false },
      tts: { firstSynthesisMs: 1 },
    };
    const run = { runId: 'r', extension: { sha256: 'a'.repeat(64) }, physicalTarget: { attested: true, machine: 'Office laptop A' } };

    expect(createTtsRequirementsSummary([{ schemaVersion: 2, run, attempts: [attempt] }]).rows[0].categories).toEqual(['native-host', 'physical-target']);
    expect(createTtsRequirementsSummary([{ schemaVersion: 2, run: { ...run, physicalTarget: { attested: false } }, attempts: [attempt] }]).rows[0].categories)
      .toEqual(['native-host']);
  });
});
