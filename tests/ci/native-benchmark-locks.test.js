import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireMeasurementLock } from '../../tooling/scripts/weak-hardware/measurement-lock.mjs';

const roots = [], children = [];
afterEach(async () => {
  for (const run of children.splice(0)) { if (run.child.exitCode === null) run.child.kill(); await run.closed; }
  for (const root of roots.splice(0)) {
    const local = relative(tmpdir(), root);
    if (!local || local.startsWith('..') || isAbsolute(local)) throw new Error('Unsafe benchmark-test cleanup path.');
    rmSync(root, { recursive: true, force: true });
  }
});

function setup(script) {
  const root = mkdtempSync(join(tmpdir(), 'pn-native-benchmark-lock-'));
  roots.push(root);
  const baseline = join(root, 'baseline.wasm'), manifest = join(root, 'manifest.json');
  const bytes = Buffer.from('test-only native sentinel');
  writeFileSync(baseline, bytes);
  writeFileSync(manifest, JSON.stringify({ nativeSha256: createHash('sha256').update(bytes).digest('hex'),
    cases: [{ name: script === 'kokoro-snake' ? 'pn_kokoro_snake' : 'pn_kokoro_conv_integer', operands: [] }],
  }));
  const loader = join(root, 'loader.mjs'), preload = join(root, 'preload.mjs'), harness = join(root, 'harness.mjs');
  // Replace only the expensive native engine. The sentinel observes the actual
  // host lock at the first compute entry and throws before any scored work.
  const engineSource = `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    export const WasmKokoroCompute = { async create() {
      const path = process.env.PAGENARRATOR_MEASUREMENT_LOCK_PATH;
      const holder = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
      writeFileSync(process.env.PN_BENCHMARK_ENTERED, JSON.stringify(holder));
      throw new Error('Stopped before scored native work');
    } };`;
  writeFileSync(loader, `export async function load(url, context, nextLoad) {
    if (url.endsWith('/src/engines/kokoro-cpu-compute.js')) return {
      format: 'module', shortCircuit: true, source: ${JSON.stringify(engineSource)},
    };
    return nextLoad(url, context);
  }`);
  writeFileSync(preload, `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)}, import.meta.url);`);
  // Catch a benchmark failure while this process remains alive: an exit hook
  // alone cannot satisfy the assertion that the benchmark's finally released it.
  writeFileSync(harness, `import { existsSync, writeFileSync } from 'node:fs';
    import { pathToFileURL } from 'node:url';
    const target = process.argv[2]; process.argv.splice(1, 1);
    try { await import(pathToFileURL(target).href); }
    catch (error) {
      writeFileSync(process.env.PN_BENCHMARK_OUTCOME, JSON.stringify({ error: error.message,
        lockAfterFailure: existsSync(process.env.PAGENARRATOR_MEASUREMENT_LOCK_PATH) }));
      process.exitCode = 1;
    }`);
  return { root, baseline, manifest, preload, harness, lockPath: join(root, 'measurement.lock'),
    entered: join(root, 'entered.json'), outcome: join(root, 'outcome.json'), output: join(root, 'score.json'),
    script: resolve(`tooling/scripts/benchmarks/${script}.mjs`),
  };
}

function launch(options, token = '') {
  const child = spawn(process.execPath, ['--import', pathToFileURL(options.preload).href, options.harness, options.script,
    '--baseline', options.baseline, '--candidate', options.baseline, '--fixtures', options.manifest, '--output', options.output], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      PAGENARRATOR_MEASUREMENT_LOCK_PATH: options.lockPath, PAGENARRATOR_MEASUREMENT_LOCK_TOKEN: token,
      PN_BENCHMARK_ENTERED: options.entered, PN_BENCHMARK_OUTCOME: options.outcome,
    },
  });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += String(bytes); });
  const closed = new Promise(resolve => child.once('close', code => resolve({ code, stderr })));
  const waitingOrClosed = new Promise(resolve => {
    child.stdout.on('data', bytes => { if (String(bytes).includes('Waiting for measurement lock')) resolve('waiting'); });
    void closed.then(() => resolve('closed'));
  });
  const run = { child, closed, waitingOrClosed };
  children.push(run);
  return run;
}

for (const script of ['kokoro-recurrent', 'kokoro-conv-integer', 'kokoro-snake']) describe(script, () => {
  it('waits for a competing host lock and releases its own lock on failure before process exit', async () => {
    const options = setup(script), holder = await acquireMeasurementLock({ lockPath: options.lockPath });
    try {
      const run = launch(options);
      const state = await run.waitingOrClosed;
      expect(state, state === 'closed' ? (await run.closed).stderr : undefined).toBe('waiting');
      expect(existsSync(options.entered)).toBe(false);
      holder.release();
      expect(await run.closed).toMatchObject({ code: 1 });
      expect(JSON.parse(readFileSync(options.entered, 'utf8'))).toMatchObject({ pid: run.child.pid });
      expect(JSON.parse(readFileSync(options.outcome, 'utf8'))).toEqual({
        error: 'Stopped before scored native work', lockAfterFailure: false,
      });
      expect(existsSync(options.output)).toBe(false);
    } finally { holder.release(); }
  });

  it('uses an inherited host lock without releasing its parent on failure', async () => {
    const options = setup(script), holder = await acquireMeasurementLock({ lockPath: options.lockPath });
    try {
      const result = await launch(options, holder.token).closed;
      expect(existsSync(options.entered), result.stderr).toBe(true);
      expect(result).toMatchObject({ code: 1 });
      expect(JSON.parse(readFileSync(options.entered, 'utf8'))).toMatchObject({ pid: process.pid, token: holder.token });
      expect(JSON.parse(readFileSync(options.outcome, 'utf8'))).toEqual({
        error: 'Stopped before scored native work', lockAfterFailure: true,
      });
      expect(JSON.parse(readFileSync(options.lockPath, 'utf8')).token).toBe(holder.token);
    } finally { holder.release(); }
  });

  it('rejects a forged inherited token before entering compute', async () => {
    const options = setup(script), holder = await acquireMeasurementLock({ lockPath: options.lockPath });
    try {
      const result = await launch(options, 'wrong-token').closed;
      expect(existsSync(options.outcome), result.stderr).toBe(true);
      expect(result).toMatchObject({ code: 1 });
      expect(existsSync(options.entered)).toBe(false);
      expect(JSON.parse(readFileSync(options.outcome, 'utf8')).error).toMatch(/Inherited measurement lock is not valid/);
      expect(JSON.parse(readFileSync(options.lockPath, 'utf8')).token).toBe(holder.token);
    } finally { holder.release(); }
  });
});
