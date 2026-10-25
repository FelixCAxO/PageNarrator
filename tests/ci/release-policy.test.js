import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { RELEASE_POLICY, releaseAcceptedLimitation, releaseGateWaiver } from '../../scripts/lib/release-policy.mjs';
import { runGateCommands, verificationSteps } from '../../scripts/run-verification-gate.mjs';

const gates = JSON.parse(readFileSync(new URL('../../config/verification-gates.json', import.meta.url), 'utf8'));

describe('explicit v1.0.0 release policy', () => {
  it('records maintainer authorization and never turns waived evidence into a pass', () => {
    expect(RELEASE_POLICY).toMatchObject({ version: '1.0.0', authorizedBy: 'user', authorizedOn: '2026-10-24',
      waivedGateIds: ['physical-hardware', 'human-listening-reviews'] });
    for (const gateId of RELEASE_POLICY.waivedGateIds) expect(releaseGateWaiver(gateId, '1.0.0')).toMatchObject({
      gateId, status: 'waived', verification: 'not-performed', authorizedOn: '2026-10-24',
    });
    for (const gateId of ['kokoro-pcm', 'ocr-quality', 'pdf-quality', 'software-functional']) expect(releaseGateWaiver(gateId, '1.0.0')).toBeNull();
    for (const version of ['1.0.2', '1.0.0-beta', undefined]) expect(releaseGateWaiver('physical-hardware', version)).toBeNull();
  });

  it('records the separately accepted numerical limitation as failed and unqualified', () => {
    const limitationId = 'kokoro-duration-pcm-reference-parity';
    expect(RELEASE_POLICY.acceptedLimitations).toHaveLength(1);
    const accepted = releaseAcceptedLimitation(limitationId, '1.0.0');
    expect(accepted).toMatchObject({ limitationId, version: '1.0.0', status: 'accepted-limitation',
      verification: 'failed-unqualified', authorizedBy: 'user', authorizedOn: '2026-10-25' });
    expect(accepted.scope).toContain('Preserve the failed diagnostics and numerical thresholds');
    expect(accepted.scope).toContain('operator numerical bounds');
    expect(releaseGateWaiver(limitationId, '1.0.0')).toBeNull();
    for (const gateId of RELEASE_POLICY.waivedGateIds) {
      expect(releaseAcceptedLimitation(gateId, '1.0.0')).toBeNull();
      expect(releaseGateWaiver(gateId, '1.0.0')).toMatchObject({ verification: 'not-performed', authorizedOn: '2026-10-24' });
    }
    accepted.verification = 'passed';
    expect(releaseAcceptedLimitation(limitationId, '1.0.0').verification).toBe('failed-unqualified');
  });

  it('keeps other checks and all future versions outside the accepted limitation', () => {
    for (const id of ['source-model-integrity', 'finite-signal', 'operator-bounds', 'software-functional', 'ocr-quality', 'pdf-quality', undefined]) {
      expect(releaseAcceptedLimitation(id, '1.0.0')).toBeNull();
    }
    for (const version of ['1.0.2', '1.0.0-beta', undefined]) {
      expect(releaseAcceptedLimitation('kokoro-duration-pcm-reference-parity', version)).toBeNull();
    }
  });

  it('skips only the physical-tier requirement and still executes the actual software gate', () => {
    const steps = verificationSteps('release', gates.release, '1.0.0');
    const run = vi.fn(() => ({ status: 0 })), recordWaivers = vi.fn(), log = vi.fn();
    expect(runGateCommands(steps, { gateName: 'release', version: '1.0.0', run, recordWaivers, log })).toBe(0);
    expect(steps.filter(step => step.waiver).map(step => step.command)).toEqual(['npm run requirements:tts -- --fail-on-non-pass']);
    const executed = run.mock.calls.map(call => call[0]);
    expect(executed).toEqual(steps.filter(step => !step.waiver).map(step => step.command));
    expect(executed).toEqual(expect.arrayContaining(['npm test', 'npm run test:e2e',
      'npm run test:pdf-acceptance',
      'npm run test:e2e:real-model -- --workers=1 --output=artifacts/release-real-model',
      'npm run probe:tts:lower-spec:no-build', 'npm run probe:tts:lower-spec-pdf:no-build']));
    expect(gates.release.indexOf('npm run test:pdf-acceptance')).toBe(gates.release.indexOf('npm run test:pdf-corpus') + 1);
    expect(gates.fast).not.toContain('npm run test:pdf-acceptance');
    expect(recordWaivers).toHaveBeenCalledWith('release', '1.0.0', [expect.objectContaining({ gateId: 'physical-hardware', status: 'waived', verification: 'not-performed' })]);
    expect(log.mock.calls.flat().find(text => text.startsWith('WAIVED'))).toContain('not verified');
  });

  it('keeps a required software failure nonzero even when hardware is waived', () => {
    const steps = verificationSteps('release', [gates.release.find(step => step.gateId), 'required-software', 'later'], '1.0.0');
    const run = vi.fn(() => ({ status: 7 }));
    expect(runGateCommands(steps, { gateName: 'release', version: '1.0.0', run, recordWaivers: vi.fn(), log: vi.fn() })).toBe(7);
    expect(run.mock.calls.map(call => call[0])).toEqual(['required-software']);
  });

  it('keeps diagnostic tools and future releases strict', () => {
    for (const gate of ['manual-live', 'weak-hardware']) expect(verificationSteps(gate, gates[gate], '1.0.0').every(step => !step.waiver)).toBe(true);
    const future = verificationSteps('release', gates.release, '1.0.2');
    const run = vi.fn(command => ({ status: command.includes('requirements:tts') ? 1 : 0 })), recordWaivers = vi.fn();
    expect(runGateCommands(future, { gateName: 'release', version: '1.0.2', run, recordWaivers, log: vi.fn() })).toBe(1);
    expect(recordWaivers).not.toHaveBeenCalled();
  });

  it('labels the actual release CLI plan as waived while preserving runnable commands', () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/run-verification-gate.mjs', import.meta.url)), 'release', '--list'], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    if (releaseGateWaiver('physical-hardware', version)) {
      expect(result.stdout).toContain('WAIVED [physical-hardware]: npm run requirements:tts -- --fail-on-non-pass');
    } else {
      expect(result.stdout).not.toContain('WAIVED');
      expect(result.stdout).toContain('npm run requirements:tts -- --fail-on-non-pass');
    }
    expect(result.stdout).toContain('npm run probe:tts:lower-spec-pdf:no-build');
    expect(result.stdout).not.toContain('PASS [physical-hardware]');
  });

  it.each([null, '', { command: '' }, { command: 'command', gateId: false }])('rejects invalid gate steps %s', entry => {
    expect(() => verificationSteps('release', [entry], '1.0.0')).toThrow('Invalid command');
  });
});

it('extends only the explicitly authorized exceptions to the v1.0.1 maintenance release', () => {
  for (const gateId of ['physical-hardware', 'human-listening-reviews']) {
    expect(releaseGateWaiver(gateId, '1.0.1')).toMatchObject({ version: '1.0.1', authorizedBy: 'user', authorizedOn: '2026-10-25', verification: 'not-performed' });
    expect(releaseGateWaiver(gateId, '1.0.2')).toBeNull();
  }
  expect(releaseAcceptedLimitation('kokoro-duration-pcm-reference-parity', '1.0.1')).toMatchObject({ version: '1.0.1', verification: 'failed-unqualified' });
  for (const id of ['software-functional', 'pdf-quality', 'operator-bounds']) expect(releaseGateWaiver(id, '1.0.1')).toBeNull();
});
