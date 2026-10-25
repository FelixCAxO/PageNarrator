import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// One lock per user account, outside any checkout, so separate worktrees and
// sessions queue for the same host. Override with PAGENARRATOR_MEASUREMENT_LOCK_PATH.
export const DEFAULT_MEASUREMENT_LOCK_PATH = path.join(os.homedir(), '.pagenarrator', 'measurement.lock');
export const MEASUREMENT_LOCK_TOKEN_ENV = 'PAGENARRATOR_MEASUREMENT_LOCK_TOKEN';
export const MEASUREMENT_LOCK_PATH_ENV = 'PAGENARRATOR_MEASUREMENT_LOCK_PATH';
const HEARTBEAT_MS = 30_000;
// A partially written lock file younger than this is assumed to be mid-write.
const UNREADABLE_GRACE_MS = 10_000;
const WINDOWS_RELEASE_RETRY_MS = 1_000;

export function getMeasurementLockPath(env = process.env) {
  return env[MEASUREMENT_LOCK_PATH_ENV] || DEFAULT_MEASUREMENT_LOCK_PATH;
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function readMeasurementLock(lockPath = getMeasurementLockPath()) {
  try {
    const raw = readFileSync(lockPath, 'utf8');
    return { exists: true, holder: JSON.parse(raw), raw };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, holder: null, raw: null };
    return { exists: true, holder: null, raw: null, error: error?.message || String(error) };
  }
}

/**
 * Decides whether an existing lock may be reclaimed.
 * @param {{ holder: any, ageMs: number, now: number, isAlive: (pid: number) => boolean }} input
 */
export function classifyExistingLock({ holder, ageMs, now, isAlive }) {
  if (!holder) return ageMs > UNREADABLE_GRACE_MS ? 'stale-unreadable' : 'busy';
  if (holder.hostname && holder.hostname !== os.hostname()) return 'busy';
  if (!isAlive(Number(holder.pid))) return 'stale-dead-holder';
  const expiresAt = Date.parse(holder.expiresAt);
  if (Number.isFinite(expiresAt) && now > expiresAt) return 'stale-expired';
  return 'busy';
}

/**
 * Acquires the host-wide measurement lock, waiting in line if another scored
 * run holds it. Dead or expired holders are reclaimed.
 * @param {{
 *   lockPath?: string,
 *   owner?: Record<string, unknown>,
 *   maxHoldMs?: number,
 *   waitTimeoutMs?: number,
 *   pollMs?: number,
 *   isAlive?: (pid: number) => boolean,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   onWait?: (holder: any) => void,
 *   pid?: number,
 * }} [options]
 */
export async function acquireMeasurementLock({
  lockPath = getMeasurementLockPath(),
  owner = {},
  maxHoldMs = 6 * 60 * 60 * 1000,
  waitTimeoutMs = 2 * 60 * 60 * 1000,
  pollMs = 1000,
  isAlive = isProcessAlive,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onWait = () => {},
  pid = process.pid,
} = {}) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const startedAt = now();
  let reportedHolder = null;
  let observedLiveHolder = false;
  let releaseRetryStartedAt = null;
  const reclaimed = [];

  for (;;) {
    const acquiredAt = now();
    const record = {
      token,
      pid,
      hostname: os.hostname(),
      cwd: process.cwd(),
      acquiredAt: new Date(acquiredAt).toISOString(),
      heartbeatAt: new Date(acquiredAt).toISOString(),
      expiresAt: new Date(acquiredAt + maxHoldMs).toISOString(),
      ...owner,
    };
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
      } finally {
        closeSync(fd);
      }
      return createHandle({ lockPath, record, waitedMs: acquiredAt - startedAt, reclaimed });
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        // Windows may deny CREATE_NEW briefly after another holder unlinks its file.
        if (process.platform !== 'win32' || error?.code !== 'EPERM' || error.syscall !== 'open'
          || error.path !== lockPath || !observedLiveHolder) throw error;
        try { statSync(lockPath); throw error; }
        catch (probe) { if (probe?.code !== 'ENOENT') throw error; }
        const instant = now();
        releaseRetryStartedAt ??= instant;
        const remaining = Math.min(WINDOWS_RELEASE_RETRY_MS - (instant - releaseRetryStartedAt),
          waitTimeoutMs - (instant - startedAt));
        if (remaining <= 0) throw error;
        await sleep(Math.min(pollMs, remaining));
        continue;
      }
    }

    const existing = readMeasurementLock(lockPath);
    let ageMs = 0;
    try {
      ageMs = now() - statSync(lockPath).mtimeMs;
    } catch {
      continue;
    }
    const verdict = classifyExistingLock({ holder: existing.holder, ageMs, now: now(), isAlive });
    if (verdict !== 'busy') {
      if (removeIfUnchanged(lockPath, existing.raw)) reclaimed.push({ verdict, holder: existing.holder });
      continue;
    }
    if (existing.holder?.hostname === os.hostname() && typeof existing.holder.token === 'string' && existing.holder.token
      && Number.isInteger(existing.holder.pid) && isAlive(existing.holder.pid)) observedLiveHolder = true;
    if (existing.holder?.token !== reportedHolder?.token) {
      reportedHolder = existing.holder;
      onWait(existing.holder);
    }
    if (now() - startedAt >= waitTimeoutMs) {
      const error = new Error(`Timed out after ${waitTimeoutMs} ms waiting for the measurement lock held by ${describeHolder(existing.holder)}.`);
      /** @type {any} */ (error).code = 'MEASUREMENT_LOCK_TIMEOUT';
      throw error;
    }
    await sleep(pollMs);
  }
}

function removeIfUnchanged(lockPath, expectedRaw) {
  try {
    const current = readFileSync(lockPath, 'utf8');
    if (expectedRaw !== null && current !== expectedRaw) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function createHandle({ lockPath, record, waitedMs, reclaimed }) {
  let released = false;
  const heartbeat = setInterval(() => {
    const current = readMeasurementLock(lockPath);
    if (current.holder?.token !== record.token) return;
    try {
      writeFileSync(lockPath, `${JSON.stringify({ ...current.holder, heartbeatAt: new Date().toISOString() }, null, 2)}\n`);
    } catch {
      // A missed heartbeat only affects the status display; expiry still applies.
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  const releaseSync = () => {
    if (released) return false;
    released = true;
    clearInterval(heartbeat);
    process.off('exit', releaseSync);
    const current = readMeasurementLock(lockPath);
    if (current.holder?.token !== record.token) return false;
    try {
      unlinkSync(lockPath);
      return true;
    } catch {
      return false;
    }
  };
  process.once('exit', releaseSync);
  return {
    held: true,
    inherited: false,
    token: record.token,
    lockPath,
    acquiredAt: record.acquiredAt,
    waitedMs,
    reclaimed,
    owner: record,
    release: releaseSync,
  };
}

/**
 * Confirms that a parent process holds the lock on this run's behalf.
 * @param {{ token?: string, lockPath?: string, isAlive?: (pid: number) => boolean }} options
 */
export function verifyInheritedMeasurementLock({ token, lockPath = getMeasurementLockPath(), isAlive = isProcessAlive } = {}) {
  if (!token) return { held: false, inherited: false, reason: 'no inherited lock token' };
  const current = readMeasurementLock(lockPath);
  if (!current.holder) return { held: false, inherited: true, reason: 'the inherited lock file is missing or unreadable' };
  if (current.holder.token !== token) return { held: false, inherited: true, reason: `the lock is held by ${describeHolder(current.holder)}` };
  if (!isAlive(Number(current.holder.pid))) return { held: false, inherited: true, reason: 'the inherited lock holder is not running' };
  return {
    held: true,
    inherited: true,
    token,
    lockPath,
    acquiredAt: current.holder.acquiredAt,
    waitedMs: 0,
    owner: current.holder,
    release: () => false,
  };
}

/**
 * Uses an inherited lock when the launcher passed one; otherwise acquires it.
 * @param {{ env?: NodeJS.ProcessEnv, owner?: Record<string, unknown>, onWait?: (holder: any) => void, waitTimeoutMs?: number }} [options]
 */
export async function ensureMeasurementLock({ env = process.env, owner = {}, onWait, waitTimeoutMs } = {}) {
  const lockPath = getMeasurementLockPath(env);
  const inherited = verifyInheritedMeasurementLock({ token: env[MEASUREMENT_LOCK_TOKEN_ENV], lockPath });
  if (inherited.held) return inherited;
  if (env[MEASUREMENT_LOCK_TOKEN_ENV]) {
    throw new Error(`Inherited measurement lock is not valid: ${inherited.reason}`);
  }
  return acquireMeasurementLock({ lockPath, owner, onWait, ...(waitTimeoutMs ? { waitTimeoutMs } : {}) });
}

export function describeHolder(holder) {
  if (!holder) return 'an unreadable lock file';
  return `${holder.purpose || 'measurement'} ${holder.runId || ''} (pid ${holder.pid}, since ${holder.acquiredAt}, cwd ${holder.cwd})`.replace(/\s+/g, ' ');
}

async function main(argv) {
  const [command = 'status', ...rest] = argv;
  const lockPath = getMeasurementLockPath();
  if (command === 'status') {
    const current = readMeasurementLock(lockPath);
    const alive = current.holder ? isProcessAlive(Number(current.holder.pid)) : false;
    console.log(JSON.stringify({ lockPath, held: Boolean(current.holder) && alive, holder: current.holder, holderAlive: alive }, null, 2));
    return 0;
  }
  if (command === 'run') {
    const separator = rest.indexOf('--');
    const commandArgs = separator >= 0 ? rest.slice(separator + 1) : rest;
    if (!commandArgs.length) {
      console.error('Usage: node scripts/weak-hardware/measurement-lock.mjs run -- <command> [args...]');
      return 1;
    }
    const lock = await acquireMeasurementLock({
      lockPath,
      owner: { purpose: 'exclusive-work', command: commandArgs.join(' ') },
      onWait: (holder) => console.error(`Waiting for measurement lock: ${describeHolder(holder)}`),
    });
    try {
      const child = spawn(commandArgs[0], commandArgs.slice(1), {
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env: { ...process.env, [MEASUREMENT_LOCK_TOKEN_ENV]: lock.token, [MEASUREMENT_LOCK_PATH_ENV]: lockPath },
      });
      return await new Promise((resolve) => {
        child.once('exit', (code) => resolve(code ?? 1));
        child.once('error', () => resolve(1));
      });
    } finally {
      lock.release();
    }
  }
  console.error('Usage: node scripts/weak-hardware/measurement-lock.mjs status | run -- <command>');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
