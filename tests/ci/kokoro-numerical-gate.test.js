import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { kokoroNumericalPlan, verifyKokoroNumerics } from '../../scripts/verify-kokoro-numerics.mjs';

it('makes the full-model comparison part of release verification', () => {
  const gates = JSON.parse(readFileSync(new URL('../../config/verification-gates.json', import.meta.url), 'utf8'));
  expect(gates.release).toContain('node scripts/verify-kokoro-numerics.mjs');
});

it.each(['1.0.0', '1.0.1'])('preserves the %s acceptance as failed/unqualified rather than a pass or a waiver', version => {
  const run = vi.fn();
  const result = verifyKokoroNumerics({ version, outputDir: 'unused', run, log: vi.fn() });
  expect(result).toMatchObject({ status: 'failed-unqualified', acceptedLimitation: { version, verification: 'failed-unqualified' } });
  expect(run).not.toHaveBeenCalled();
});

it('requires math checks and keeps fresh CPU/GPU waveform comparisons for production and retained graphs', () => {
  const plan = kokoroNumericalPlan('1.0.2', 'fresh-evidence');
  expect(plan.accepted).toBeNull();
  expect(plan.steps).toHaveLength(6);
  expect(plan.steps.filter(args => args.includes('--unmodified-model'))).toHaveLength(3);
  expect(plan.mathSteps).toHaveLength(2);
  const run = vi.fn(() => ({ status: 0 }));
  expect(verifyKokoroNumerics({ version: '1.0.2', outputDir: 'fresh-evidence', run }).status).toBe('pass');
  expect(run).toHaveBeenCalledTimes(8);
  run.mockReset().mockReturnValue({ status: 1 });
  expect(verifyKokoroNumerics({ version: '1.0.2', outputDir: 'new-evidence', run }).status).toBe('fail');
  expect(run).toHaveBeenCalledTimes(8);
});

it('collects later lanes after an early failure and keeps the overall gate failed', () => {
  const run = vi.fn().mockReturnValueOnce({ status: 1 }).mockReturnValue({ status: 0 });
  const result = verifyKokoroNumerics({ version: '1.0.2', outputDir: 'complete-evidence', run });
  expect(result.status).toBe('fail');
  expect(result.mathSteps.map(step => step.status)).toEqual(['fail', 'pass']);
  expect(result.steps.map(step => step.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
  expect(new Set(result.steps.map(step => step.args.at(-1))).size).toBe(6);
});

it.each([
  { status: null, signal: 'SIGTERM' },
  { status: null, error: Object.assign(new Error('Probe could not start'), { code: 'ENOENT' }) },
])('preserves failed process evidence without omitting the remaining lanes: %j', failure => {
  const run = vi.fn().mockReturnValueOnce(failure).mockReturnValue({ status: 0 });
  const result = verifyKokoroNumerics({ version: '1.0.2', outputDir: 'process-failure-evidence', run });
  expect(result.status).toBe('fail');
  expect(result.steps).toHaveLength(6);
  expect(result.mathSteps[0]).toMatchObject({ status: 'fail', exitCode: null });
  if (failure.signal) expect(result.mathSteps[0].signal).toBe(failure.signal);
  if (failure.error) expect(result.mathSteps[0].error).toEqual({ code: 'ENOENT', message: 'Probe could not start' });
  expect(result.steps.every(step => step.status === 'pass')).toBe(true);
});

it('keeps PCM mismatches failed while qualifying independently passing operator math', () => {
  const run = vi.fn((_node, args) => ({ status: args[0].includes('probe-kokoro-model-') ? 1 : 0 }));
  const result = verifyKokoroNumerics({ version: '1.0.2', outputDir: 'fresh', run, readReport: () => ({ status: 'fail', failureKind: 'pcm-mismatch',
    remainingBuffers: 0, remainingTensors: 0, resourceCleanup: true, validationErrors: [], consoleErrors: [], cases: [{ samples: 10, mismatches: 1, maximumAbsolute: .1 }] }) });
  expect(result).toMatchObject({ status: 'pass', referencePcmStatus: 'failed-unqualified' });
  expect(result.steps.every(step => step.status === 'fail' && step.diagnosticExecuted)).toBe(true);
  expect(result.scope).toContain('separate required voice-quality gate');
});

it.each([{ remainingBuffers: 1 }, { remainingTensors: 1 }, { resourceCleanup: false }, { validationErrors: ['GPU error'] }, { consoleErrors: ['browser error'] }, { cases: [] }])('blocks PCM diagnostics with incomplete lifecycle or comparison evidence: %j', invalid => {
  const run = vi.fn((_node, args) => ({ status: args[0].includes('probe-kokoro-model-') ? 1 : 0 }));
  const report = { status: 'fail', failureKind: 'pcm-mismatch', remainingBuffers: 0, remainingTensors: 0,
    resourceCleanup: true, validationErrors: [], consoleErrors: [], cases: [{ samples: 10, mismatches: 1, maximumAbsolute: .1 }], ...invalid };
  expect(verifyKokoroNumerics({ version: '1.0.2', outputDir: 'fresh', run, readReport: () => report }).status).toBe('fail');
});

it.each([undefined, { failureKind: 'execution' }])('blocks missing or unexpected diagnostic failures: %j', report => {
  const run = vi.fn((_node, args) => ({ status: args[0].includes('probe-kokoro-model-') ? 1 : 0 }));
  expect(verifyKokoroNumerics({ version: '1.0.2', outputDir: 'fresh', run, readReport: () => report }).status).toBe('fail');
});

it('requires the independent voice study separately instead of treating math as speech quality', () => {
  const gates = JSON.parse(readFileSync(new URL('../../config/verification-gates.json', import.meta.url), 'utf8'));
  expect(gates.release).toContainEqual({ command: 'node scripts/verify-voice-quality.mjs', gateId: 'human-listening-reviews' });
});
