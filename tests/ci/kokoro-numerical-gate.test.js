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

it('requires fresh CPU and GPU comparisons for production and retained graphs on future versions', () => {
  const plan = kokoroNumericalPlan('1.0.2', 'fresh-evidence');
  expect(plan.accepted).toBeNull();
  expect(plan.steps).toHaveLength(6);
  expect(plan.steps.filter(args => args.includes('--unmodified-model'))).toHaveLength(3);
  const run = vi.fn(() => ({ status: 0 }));
  expect(verifyKokoroNumerics({ version: '1.0.2', outputDir: 'fresh-evidence', run }).status).toBe('pass');
  expect(run).toHaveBeenCalledTimes(6);
  run.mockReset().mockReturnValue({ status: 1 });
  expect(verifyKokoroNumerics({ version: '1.0.2', outputDir: 'new-evidence', run }).status).toBe('fail');
  expect(run).toHaveBeenCalledTimes(6);
});

it('collects later lanes after an early failure and keeps the overall gate failed', () => {
  const run = vi.fn().mockReturnValueOnce({ status: 1 }).mockReturnValue({ status: 0 });
  const result = verifyKokoroNumerics({ version: '1.0.2', outputDir: 'complete-evidence', run });
  expect(result.status).toBe('fail');
  expect(result.steps.map(step => step.status)).toEqual(['fail', 'pass', 'pass', 'pass', 'pass', 'pass']);
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
  expect(result.steps[0]).toMatchObject({ status: 'fail', exitCode: null });
  if (failure.signal) expect(result.steps[0].signal).toBe(failure.signal);
  if (failure.error) expect(result.steps[0].error).toEqual({ code: 'ENOENT', message: 'Probe could not start' });
  expect(result.steps.slice(1).every(step => step.status === 'pass')).toBe(true);
});
