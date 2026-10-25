// Local weak-hardware acceptance matrix. Runs the selected lane sets one
// profile at a time under one host-wide measurement lock, writes every result
// into one run directory, summarizes it, and exits non-zero when any lane
// fails, is missing, is blocked or ran in an invalid environment.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLiveTtsProbeRunPlan, runLiveTtsProbe } from '../run-live-tts-probe.mjs';
import { writeTtsRequirementsSummary } from '../summarize-tts-requirements.mjs';
import { acquireMeasurementLock, describeHolder, getMeasurementLockPath } from './measurement-lock.mjs';
import { createRunId, resolveRevision, resolveRunOutputDir } from './run-provenance.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

// Default stages. Expensive or long stages are explicit opt-ins.
export const MATRIX_STAGES = Object.freeze({
  baseline: { profiles: 'native,cpu-constrained,physical-adapter,playback', documents: 'article,pdf' },
  memory: { profiles: 'memory-constrained', documents: 'article' },
  faults: { profiles: 'gpu-faults,cache', documents: 'article' },
  lifecycle: { profiles: 'lifecycle', documents: 'article' },
  workloads: { profiles: 'native', documents: 'long-article,complex-html,two-column-pdf,scanned-pdf', optIn: true },
  acquisition: { profiles: 'cache-faults', documents: 'article', optIn: true },
  contention: { profiles: 'contention', documents: 'article', optIn: true },
  soak: { profiles: 'soak', documents: 'article', optIn: true },
});

export function parseMatrixArgs(argv = []) {
  const options = { stages: null, include: [], requirePass: false, runs: null, soakMinutes: null };
  for (const arg of argv) {
    if (arg.startsWith('--stages=')) options.stages = arg.slice('--stages='.length).split(',').filter(Boolean);
    else if (['--workloads', '--acquisition', '--contention', '--soak'].includes(arg)) options.include.push(arg.slice(2));
    else if (arg.startsWith('--soak=')) {
      options.include.push('soak');
      options.soakMinutes = Number(arg.slice('--soak='.length));
    } else if (arg.startsWith('--runs=')) options.runs = Number(arg.slice('--runs='.length));
    else if (arg === '--require-pass') options.requirePass = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export function selectMatrixStages({ stages = null, include = [] } = {}) {
  const names = stages || Object.entries(MATRIX_STAGES)
    .filter(([name, stage]) => !stage.optIn || include.includes(name))
    .map(([name]) => name);
  for (const name of names) if (!MATRIX_STAGES[name]) throw new Error(`Unknown matrix stage: ${name}`);
  return names;
}

export function collectLaneVerdicts(runDir) {
  if (!existsSync(runDir)) return [];
  return readdirSync(runDir)
    .filter((name) => /^tts-hardware-probe-.*\.json$/.test(name))
    .flatMap((name) => {
      const payload = JSON.parse(readFileSync(path.join(runDir, name), 'utf8'));
      const lanes = Array.isArray(payload.lanes) ? payload.lanes : [];
      // A file without lane verdicts means its job never finished.
      return lanes.length ? lanes : [{ profileName: name.replace(/^tts-hardware-probe-|\.json$/g, ''), verdict: 'incomplete', attempts: payload.attempts?.length ?? 0 }];
    });
}

export function isPassingVerdict(verdict) {
  return verdict === 'passed' || verdict === 'reproducible';
}

async function main(argv) {
  const options = parseMatrixArgs(argv);
  const stages = selectMatrixStages(options);
  const revision = resolveRevision({ root: ROOT });
  const runId = createRunId();
  const runDir = resolveRunOutputDir({ root: ROOT, revision, runId });
  const lockPath = getMeasurementLockPath();
  const lock = await acquireMeasurementLock({
    lockPath,
    owner: { purpose: 'weak-hardware-matrix', runId, stages },
    onWait: (holder) => console.log(`Waiting for the host measurement lock held by ${describeHolder(holder)}`),
  });
  console.log(`Weak-hardware matrix ${runId}: stages ${stages.join(', ')} -> ${runDir}`);
  try {
    for (const stageName of stages) {
      const stage = MATRIX_STAGES[stageName];
      const env = {
        ...process.env,
        PAGENARRATOR_TTS_PROBE_PROFILE: stage.profiles,
        PAGENARRATOR_TTS_PROBE_DOCUMENTS: stage.documents,
        PAGENARRATOR_TTS_PROBE_MODE: 'isolated',
        ...(options.runs ? { PAGENARRATOR_TTS_PROBE_RUNS: String(options.runs) } : {}),
        ...(stageName === 'soak' && options.soakMinutes ? { PAGENARRATOR_TTS_PROBE_SOAK_MS: String(options.soakMinutes * 60_000) } : {}),
      };
      // Lane sets expand to one job per profile; jobs share the run id and directory.
      const plan = createLiveTtsProbeRunPlan({ root: ROOT, env, runId, revision });
      console.log(`\n== Stage ${stageName}: ${plan.jobs.length} profile job(s)`);
      await runLiveTtsProbe(plan, {
        // The matrix holds the lock for its whole duration.
        acquireLock: async () => ({ ...lock, waitedMs: 0, release: () => false }),
      });
    }
  } finally {
    lock.release();
  }

  const inputs = readdirSync(runDir).filter((name) => /^tts-hardware-probe-.*\.json$/.test(name)).map((name) => path.join(runDir, name));
  const summary = writeTtsRequirementsSummary({
    inputPaths: inputs,
    jsonPath: path.join(runDir, 'tts-requirements-summary.json'),
    mdPath: path.join(runDir, 'tts-requirements-summary.md'),
  });
  const lanes = collectLaneVerdicts(runDir);
  console.log('\nLane verdicts:');
  for (const lane of lanes) {
    console.log(`  ${isPassingVerdict(lane.verdict) ? 'ok  ' : 'FAIL'} ${lane.profileName.padEnd(40)} ${lane.verdict.padEnd(20)} ${JSON.stringify(lane.outcomes || {})}`);
  }
  console.log(`\nRequirements evidence: ${summary.launchEvidence.status} (${summary.launchEvidence.reasons.join('; ') || 'no reasons'})`);
  console.log(`Report: ${path.relative(ROOT, path.join(runDir, 'tts-requirements-summary.md'))}`);
  const failingLanes = lanes.filter((lane) => !isPassingVerdict(lane.verdict));
  if (failingLanes.length) return 1;
  if (options.requirePass && summary.launchEvidence.status !== 'pass') return 1;
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
