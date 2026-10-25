import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import {
  LOWER_SPEC_TTS_PROBE_PROFILE_SET,
  getTtsProbeProfiles,
} from '../tests/live/live-tts-hardware-profiles.js';
import { SCHEDULING_MODES } from './weak-hardware/evidence-contract.mjs';
import {
  MEASUREMENT_LOCK_PATH_ENV,
  MEASUREMENT_LOCK_TOKEN_ENV,
  acquireMeasurementLock,
  describeHolder,
  getMeasurementLockPath,
} from './weak-hardware/measurement-lock.mjs';
import { createRunId, resolveRevision, resolveRunOutputDir } from './weak-hardware/run-provenance.mjs';

// Default upper bound for one profile job (all of its runs and documents).
const DEFAULT_JOB_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * Builds the probe run plan. Isolated mode (the default) runs one profile job
 * at a time so measurements never compete; contention mode runs jobs in
 * parallel on purpose and every result is labelled with that mode.
 */
export function createLiveTtsProbeRunPlan({
  root = path.resolve(import.meta.dirname, '..'),
  env = process.env,
  maxWorkers = null,
  runId = env.PAGENARRATOR_TTS_PROBE_RUN_ID || createRunId(),
  revision = null,
} = {}) {
  const schedulingMode = env.PAGENARRATOR_TTS_PROBE_MODE === SCHEDULING_MODES.CONTENTION
    ? SCHEDULING_MODES.CONTENTION
    : SCHEDULING_MODES.ISOLATED;
  const requestedWorkers = normalizePositiveInteger(maxWorkers)
    || normalizePositiveInteger(env.PAGENARRATOR_TTS_PROBE_MAX_WORKERS)
    || 1;
  const resolvedMaxWorkers = schedulingMode === SCHEDULING_MODES.CONTENTION ? requestedWorkers : 1;
  const vitestBin = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
  const baseArgs = [
    vitestBin,
    'run',
    'tests/live/live-tts-hardware-probe.test.js',
    '--config',
    'vitest.live.config.js',
    '--pool=forks',
    '--maxWorkers=1',
  ];
  const resolvedRevision = revision || resolveRevision({ root });
  const runDir = resolveRunOutputDir({ root, revision: resolvedRevision, runId });
  const baseEnv = {
    ...env,
    PAGENARRATOR_TTS_PROBE: '1',
    PAGENARRATOR_TTS_PROBE_RUN_ID: runId,
    PAGENARRATOR_TTS_PROBE_MODE: schedulingMode,
    PAGENARRATOR_CHROME: env.PAGENARRATOR_CHROME || chromium.executablePath(),
  };
  const profileSelection = env.PAGENARRATOR_TTS_PROBE_PROFILE || env.PAGENARRATOR_TTS_PROBE_MATRIX || '';
  if (
    profileSelection === LOWER_SPEC_TTS_PROBE_PROFILE_SET
    && !baseEnv.PAGENARRATOR_TTS_PROBE_DOCUMENTS
    && !baseEnv.PAGENARRATOR_TTS_PROBE_DOCUMENT
  ) {
    baseEnv.PAGENARRATOR_TTS_PROBE_DOCUMENTS = 'article';
  }
  const profiles = getTtsProbeProfiles(profileSelection);
  const jobs = profiles.map((profile) => createProbeJob({
    args: baseArgs,
    env: baseEnv,
    profileName: profiles.length > 1 || profileSelection ? profile.name : '',
    runDir,
  }));

  return {
    command: process.execPath,
    args: baseArgs,
    cwd: root,
    env: baseEnv,
    jobs,
    maxWorkers: resolvedMaxWorkers,
    requestedWorkers,
    schedulingMode,
    runId,
    runDir,
    jobTimeoutMs: normalizePositiveInteger(env.PAGENARRATOR_TTS_PROBE_JOB_TIMEOUT_MS) || DEFAULT_JOB_TIMEOUT_MS,
  };
}

function createProbeJob({ args, env, profileName, runDir }) {
  const outputName = `tts-hardware-probe-${profileName || 'host'}${getProbeDocumentOutputSuffix(env)}.json`;
  return {
    command: process.execPath,
    args,
    cwd: undefined,
    profileName: profileName || 'host',
    env: {
      ...env,
      ...(profileName ? { PAGENARRATOR_TTS_PROBE_PROFILE: profileName } : {}),
      PAGENARRATOR_TTS_PROBE_OUTPUT: path.join(runDir, outputName),
    },
  };
}

function getProbeDocumentOutputSuffix(env = {}) {
  const selection = String(env.PAGENARRATOR_TTS_PROBE_DOCUMENTS || env.PAGENARRATOR_TTS_PROBE_DOCUMENT || '').trim().toLowerCase();
  return selection === 'pdf' ? '-pdf' : '';
}

/**
 * Runs the plan under the host-wide measurement lock. Jobs inherit the lock
 * token, so nested probe processes do not wait on their own launcher.
 * @param {ReturnType<typeof createLiveTtsProbeRunPlan>} [plan]
 * @param {{ runJob?: typeof runProbeJob, acquireLock?: typeof acquireMeasurementLock, log?: (message: string) => void }} [options]
 */
export async function runLiveTtsProbe(plan = createLiveTtsProbeRunPlan(), {
  runJob = runProbeJob,
  acquireLock = acquireMeasurementLock,
  log = (message) => console.log(message),
} = {}) {
  const jobs = Array.isArray(plan.jobs) && plan.jobs.length ? plan.jobs : [plan];
  const maxWorkers = plan.schedulingMode === SCHEDULING_MODES.CONTENTION
    ? Math.max(1, Math.trunc(Number(plan.maxWorkers)) || 1)
    : 1;
  if (plan.schedulingMode !== SCHEDULING_MODES.CONTENTION && Number(plan.requestedWorkers) > 1) {
    log(`Isolated mode: running ${jobs.length} profile job(s) one at a time; set PAGENARRATOR_TTS_PROBE_MODE=contention for labelled parallel runs.`);
  }
  const lockPath = getMeasurementLockPath(plan.env);
  const lock = await acquireLock({
    lockPath,
    owner: { purpose: 'tts-probe-launcher', runId: plan.runId, mode: plan.schedulingMode, jobs: jobs.length },
    onWait: (holder) => log(`Waiting for the host measurement lock held by ${describeHolder(holder)}`),
  });
  log(`Measurement lock held${lock.waitedMs ? ` after ${Math.round(lock.waitedMs / 1000)} s` : ''}; run ${plan.runId} -> ${plan.runDir}`);
  let nextIndex = 0;
  const results = [];
  try {
    const runNext = async () => {
      const job = jobs[nextIndex];
      nextIndex += 1;
      if (!job) return;
      const result = await runJob({
        ...job,
        cwd: job.cwd || plan.cwd,
        env: { ...job.env, [MEASUREMENT_LOCK_TOKEN_ENV]: lock.token, [MEASUREMENT_LOCK_PATH_ENV]: lockPath },
      }, { timeoutMs: plan.jobTimeoutMs });
      results.push({ profileName: job.profileName, ...result });
      await runNext();
    };
    await Promise.all(Array.from({ length: Math.min(maxWorkers, jobs.length) }, () => runNext()));
  } finally {
    lock.release();
  }
  return results;
}

/**
 * Runs one job; on timeout the job's whole process tree is terminated.
 * @param {{ command: string, args: string[], cwd?: string, env: NodeJS.ProcessEnv }} job
 * @param {{ timeoutMs?: number }} [options]
 */
export function runProbeJob(job, { timeoutMs = DEFAULT_JOB_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(job.command, job.args, {
      cwd: job.cwd,
      stdio: 'inherit',
      env: job.env,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), signal, timedOut });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      console.error(error);
      resolve({ code: 1, signal: null, timedOut: false });
    });
  });
}

export function killProcessTree(pid, { platform = process.platform, run = spawnSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (platform === 'win32') {
    run('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return true;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    process.kill(pid, 'SIGKILL');
  }
  return true;
}

function normalizePositiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLiveTtsProbe().then((results) => {
    const failed = results.filter((result) => result.code !== 0 || result.signal);
    for (const result of failed) {
      console.error(`Probe job ${result.profileName} ${result.timedOut ? 'timed out' : `exited ${result.code ?? result.signal}`}.`);
    }
    process.exitCode = failed.length ? (failed[0].code || 1) : 0;
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
