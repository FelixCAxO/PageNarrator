import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeBusyFraction,
  isHostBusy,
  readCpuTicks,
  sampleHostLoad,
  sampleNvidiaGpus,
  waitForQuietHost,
} from '../../scripts/weak-hardware/host-load.mjs';
import {
  createRunId,
  describeLaunch,
  hashDirectory,
  resolveRevision,
  resolveRunOutputDir,
} from '../../scripts/weak-hardware/run-provenance.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cpu(idle, busy) {
  return { times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } };
}

describe('host load sampling', () => {
  it('computes the busy fraction across logical processors', () => {
    const before = readCpuTicks([cpu(100, 0), cpu(100, 0)]);
    const after = readCpuTicks([cpu(150, 50), cpu(200, 0)]);

    expect(before.logicalProcessors).toBe(2);
    expect(computeBusyFraction(before, after)).toBeCloseTo(50 / 200);
    expect(computeBusyFraction(before, before)).toBeNull();
  });

  it('subtracts the supervised browser from host busy time to estimate foreign load', async () => {
    const ticks = [
      { idle: 0, total: 0, logicalProcessors: 4 },
      { idle: 2000, total: 4000, logicalProcessors: 4 },
    ];
    let clock = 0;
    let own = 0;
    const sample = await sampleHostLoad({
      windowMs: 1000,
      readTicks: () => ticks.shift(),
      ownCpuSeconds: async () => own,
      sampleGpus: () => ({ available: true, gpus: [{ name: 'GPU', utilizationPercent: 30 }] }),
      sleep: async () => {
        clock += 1000;
        own = 1;
      },
      now: () => clock,
    });

    expect(sample.totalCpuBusyFraction).toBeCloseTo(0.5);
    expect(sample.foreignCpuFraction).toBeLessThan(0.26);
    expect(sample.foreignCpuFraction).toBeGreaterThan(0.24);
    expect(sample.foreignGpuUtilizationPercent).toBe(30);
  });

  it('reports GPU sampling as unavailable instead of zero when nvidia-smi is missing', () => {
    expect(sampleNvidiaGpus({ run: () => ({ error: new Error('ENOENT'), status: null }) })).toEqual({ available: false, reason: 'ENOENT', gpus: [] });
    expect(sampleNvidiaGpus({ run: () => ({ status: 0, stdout: 'NVIDIA GeForce RTX 5090, 65, 23000, 32607\n' }) }).gpus)
      .toEqual([{ name: 'NVIDIA GeForce RTX 5090', utilizationPercent: 65, memoryUsedMiB: 23000, memoryTotalMiB: 32607 }]);
  });

  it('waits a bounded time for a quiet host and reports the last sample', async () => {
    const samples = [{ foreignCpuFraction: 0.6 }, { foreignCpuFraction: 0.05 }];
    let clock = 0;
    const result = await waitForQuietHost({
      maxWaitMs: 10_000,
      retryMs: 1_000,
      sample: async () => samples.shift(),
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });

    expect(result).toMatchObject({ quiet: true, attempts: 2, waitedMs: 1000 });
    expect(isHostBusy({ foreignCpuFraction: 0.05, foreignGpuUtilizationPercent: 70 }, { usesGpu: true })).toBe(true);
    expect(isHostBusy({ foreignCpuFraction: 0.05, foreignGpuUtilizationPercent: 70 }, { usesGpu: false })).toBe(false);
    expect(isHostBusy({ foreignCpuFraction: null })).toBe(true);
  });

  it.each([
    ['absent', undefined], ['null', null], ['empty', ''], ['whitespace', '  '],
    ['NaN', NaN], ['positive infinity', Infinity], ['negative infinity', -Infinity], ['nonnumeric', 'unavailable'],
  ])('requires measured GPU load for a GPU lane: %s', (_name, gpu) => {
    const sample = { foreignCpuFraction: 0.05, foreignGpuUtilizationPercent: gpu };
    expect(isHostBusy(sample, { usesGpu: true })).toBe(true);
    expect(isHostBusy(sample, { usesGpu: false })).toBe(false);
  });

  it.each([[0, false], ['0', false], [24.999, false], [25, true], [70, true]])(
    'keeps measured GPU value %s and its existing threshold behavior', (gpu, busy) => {
      expect(isHostBusy({ foreignCpuFraction: 0.05, foreignGpuUtilizationPercent: gpu }, { usesGpu: true })).toBe(busy);
    },
  );

  it('does not finish its quiet-host wait until missing GPU telemetry becomes measured zero', async () => {
    const samples = [null, 0]; let clock = 0;
    const result = await waitForQuietHost({
      usesGpu: true, maxWaitMs: 1000, retryMs: 100,
      sample: async () => ({ foreignCpuFraction: 0.05, foreignGpuUtilizationPercent: samples.shift() }),
      sleep: async ms => { clock += ms; }, now: () => clock,
    });
    expect(result).toMatchObject({ quiet: true, attempts: 2, waitedMs: 100, last: { foreignGpuUtilizationPercent: 0 } });
  });
});

describe('run provenance', () => {
  it('creates unique sortable run ids', () => {
    const id = createRunId({ now: new Date('2026-10-05T08:15:00.123Z'), random: () => Buffer.from([0xa1, 0xb2, 0xc3]) });

    expect(id).toBe('20261005T081500Z-a1b2c3');
    expect(createRunId()).not.toBe(createRunId());
  });

  it('hashes an extension directory by relative path and content', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pn-hash-'));
    roots.push(root);
    const first = path.join(root, 'a');
    const second = path.join(root, 'b');
    for (const directory of [first, second]) {
      mkdirSync(path.join(directory, 'src'), { recursive: true });
      writeFileSync(path.join(directory, 'manifest.json'), '{}');
      writeFileSync(path.join(directory, 'src', 'app.js'), 'x');
    }

    return Promise.all([hashDirectory(first), hashDirectory(second)]).then(async ([left, right]) => {
      expect(left).toEqual(right);
      expect(left).toMatchObject({ fileCount: 2, bytes: 3 });
      writeFileSync(path.join(second, 'src', 'app.js'), 'y');
      expect((await hashDirectory(second)).sha256).not.toBe(left.sha256);
    });
  });

  it('records a dirty working tree instead of hiding it', () => {
    const run = (_command, args) => (args[0] === 'rev-parse'
      ? { status: 0, stdout: `${'a'.repeat(40)}\n` }
      : { status: 0, stdout: ' M src/app.js\n?? notes.md\n' });

    expect(resolveRevision({ root: '.', run })).toMatchObject({
      commitSha: 'a'.repeat(40),
      shortSha: 'aaaaaaaaaaaa',
      dirty: true,
      dirtyPathCount: 2,
    });
    expect(resolveRevision({ root: '.', run: () => ({ status: 128, stdout: '' }) })).toMatchObject({ commitSha: null, dirty: null });
  });

  it('scopes artifacts by revision and run id', () => {
    expect(resolveRunOutputDir({ root: 'F:/r', revision: { shortSha: 'abc', dirty: true }, runId: '20261005T081500Z-a1b2c3' }).replaceAll('\\', '/'))
      .toBe('F:/r/artifacts/weak-hardware/abc-dirty/20261005T081500Z-a1b2c3');
    expect(() => resolveRunOutputDir({ root: 'F:/r', runId: '../escape' })).toThrow(/Invalid run id/);
  });

  it('redacts the private profile path from launch descriptions', () => {
    const description = describeLaunch({
      executable: 'chrome.exe',
      args: ['--user-data-dir=C:/tmp/profile-1', '--load-extension=C:/tmp/profile-1/extension', 'about:blank'],
      userDataDir: 'C:/tmp/profile-1',
      supervisor: 'windows-job',
    });

    expect(description.args).toEqual(['--user-data-dir=<user-data-dir>', '--load-extension=<user-data-dir>/extension', 'about:blank']);
    expect(description.flags).toEqual(['--user-data-dir', '--load-extension']);
  });
});
