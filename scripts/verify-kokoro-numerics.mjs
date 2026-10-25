import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseAcceptedLimitation } from './lib/release-policy.mjs';

export function kokoroNumericalPlan(version, outputDir) {
  const accepted = releaseAcceptedLimitation('kokoro-duration-pcm-reference-parity', version);
  const steps = [];
  for (const mode of ['production', 'unmodified-model']) {
    for (const backend of ['cpu-q8', 'cpu-fp32', 'gpu-fp32']) {
      const script = backend.startsWith('cpu') ? 'scripts/probe-kokoro-model-cpu.mjs' : 'scripts/probe-kokoro-model-gpu.mjs';
      steps.push([script, ...(backend === 'cpu-fp32' ? ['--fp32'] : []),
        ...(mode === 'unmodified-model' ? ['--unmodified-model'] : []), '--output', join(outputDir, `${mode}-${backend}.json`)]);
    }
  }
  return { accepted, steps };
}

export function verifyKokoroNumerics({ version, outputDir, run = spawnSync, log = console.log }) {
  const { accepted, steps } = kokoroNumericalPlan(version, outputDir);
  if (accepted) {
    log(`ACCEPTED LIMITATION (${version}): Kokoro duration/PCM reference parity remains failed/unqualified; not a numerical pass.`);
    return { status: 'failed-unqualified', acceptedLimitation: accepted, steps: [] };
  }
  const results = [];
  for (const args of steps) {
    const result = run(process.execPath, args, { stdio: 'inherit' });
    const status = result.error || result.signal || result.status !== 0 ? 'fail' : 'pass';
    results.push({ args, status, exitCode: result.status ?? null,
      ...(result.signal ? { signal: result.signal } : {}),
      ...(result.error ? { error: { code: result.error.code ?? null, message: result.error.message } } : {}) });
  }
  return { status: results.every(step => step.status === 'pass') ? 'pass' : 'fail', steps: results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const outputDir = resolve('artifacts/verification', `kokoro-numerics-${version}-${randomUUID()}`);
  mkdirSync(outputDir, { recursive: true });
  const report = verifyKokoroNumerics({ version, outputDir });
  writeFileSync(join(outputDir, 'result.json'), `${JSON.stringify({ version, ...report }, null, 2)}\n`);
  console.log(`Kokoro numerical evidence: ${join(outputDir, 'result.json')}`);
  if (report.status === 'fail') process.exitCode = 1;
}
