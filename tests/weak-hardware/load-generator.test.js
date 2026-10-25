import { describe, expect, it } from 'vitest';
import { normalizeLoadSpec, startLoadGenerator } from '../../scripts/weak-hardware/load-generator.mjs';

describe('controlled contention load generator', () => {
  it('validates the declared load', () => {
    expect(normalizeLoadSpec({ threads: 2, dutyCycle: 0.5 })).toEqual({ threads: 2, dutyCycle: 0.5, periodMs: 100 });
    expect(() => normalizeLoadSpec({ threads: 0, dutyCycle: 1 })).toThrow(/threads/);
    expect(() => normalizeLoadSpec({ threads: 1, dutyCycle: 0 })).toThrow(/dutyCycle/);
    expect(() => normalizeLoadSpec({ threads: 1, dutyCycle: 1.5 })).toThrow(/dutyCycle/);
  });

  it('runs the declared threads and reports the CPU it actually consumed', async () => {
    const generator = await startLoadGenerator({ threads: 1, dutyCycle: 1 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const report = await generator.stop();

    expect(report).toMatchObject({ threads: 1, dutyCycle: 1 });
    expect(report.cpuSeconds).toBeGreaterThan(0.2);
    expect(report.achievedBusyThreads).toBeGreaterThan(0.3);
  }, 20_000);
});
