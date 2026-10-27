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
  const mathSteps = [
    ['node_modules/vitest/vitest.mjs', 'run', 'tests/engines/kokoro-cpu.test.js', 'tests/engines/wasm-ocr-compute.test.js',
      'tests/engines/kokoro-resize-reference.test.js', 'tests/engines/kokoro-stft-reference.test.js',
      'tests/engines/kokoro-parallel-native.test.js', 'tests/engines/kokoro-kernels.test.js', 'tests/engines/kokoro-phase-contract.test.js'],
    ['scripts/probe-kokoro-kernels.mjs', '--output', join(outputDir, 'gpu-operator-math.json')],
  ];
  return { accepted, steps, mathSteps };
}

export function verifyKokoroNumerics({ version, outputDir, run = spawnSync, log = console.log,
  readReport = file => JSON.parse(readFileSync(file, 'utf8')) }) {
  const { accepted, steps, mathSteps } = kokoroNumericalPlan(version, outputDir);
  if (accepted) {
    log(`ACCEPTED LIMITATION (${version}): Kokoro duration/PCM reference parity remains failed/unqualified; not a numerical pass.`);
    return { status: 'failed-unqualified', acceptedLimitation: accepted, steps: [] };
  }
  const execute = args => {
    const result = run(process.execPath, args, { stdio: 'inherit' });
    const status = result.error || result.signal || result.status !== 0 ? 'fail' : 'pass';
    return { args, status, exitCode: result.status ?? null,
      ...(result.signal ? { signal: result.signal } : {}),
      ...(result.error ? { error: { code: result.error.code ?? null, message: result.error.message } } : {}) };
  };
  const mathResults = mathSteps.map(execute);
  const results = steps.map(args => {
    const result = execute(args);
    if (result.status === 'pass') return { ...result, diagnosticExecuted: true };
    let report;
    try { report = readReport(args.at(-1)); } catch { /* Missing evidence is an execution failure. */ }
    const cleanup = args[0].endsWith('-cpu.mjs') ? report?.remainingBuffers === 0 && report?.remainingTensors === 0
      : report?.resourceCleanup === true && report?.validationErrors?.length === 0 && report?.consoleErrors?.length === 0;
    const mismatch = report?.cases?.some(item => item.samples > 0 && item.mismatches > 0 && Number.isFinite(item.maximumAbsolute));
    return { ...result, diagnosticExecuted: !result.error && !result.signal && result.exitCode === 1
      && report?.status === 'fail' && report.failureKind === 'pcm-mismatch' && cleanup && mismatch };
  });
  return { status: mathResults.every(step => step.status === 'pass') && results.every(step => step.diagnosticExecuted) ? 'pass' : 'fail',
    scope: 'Operator math and successful diagnostic collection only. The separate required voice-quality gate must qualify speech.',
    acceptanceTarget: 'correct-math-and-verified-speech-quality-v1',
    referencePcmStatus: results.every(step => step.status === 'pass') ? 'pass' : 'failed-unqualified',
    mathSteps: mathResults, steps: results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const outputDir = resolve('artifacts/verification', `kokoro-numerics-${version}-${randomUUID()}`);
  mkdirSync(outputDir, { recursive: true });
  const report = verifyKokoroNumerics({ version, outputDir });
  writeFileSync(join(outputDir, 'result.json'), `${JSON.stringify({ version, ...report }, null, 2)}\n`);
  console.log(`Kokoro numerical evidence: ${join(outputDir, 'result.json')}`);
  if (!report.acceptedLimitation) console.log(`Math/diagnostic collection: ${report.status}; reference PCM: ${report.referencePcmStatus}. Independent speech-quality qualification is required separately.`);
  if (report.status === 'fail') process.exitCode = 1;
}
