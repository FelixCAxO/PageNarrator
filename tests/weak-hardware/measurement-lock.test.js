import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, openSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireMeasurementLock,
  classifyExistingLock,
  ensureMeasurementLock,
  readMeasurementLock,
  verifyInheritedMeasurementLock,
} from '../../scripts/weak-hardware/measurement-lock.mjs';

const MODULE_URL = pathToFileURL(path.resolve('scripts/weak-hardware/measurement-lock.mjs')).href;
const roots = [];
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});
const originalOpen = vi.mocked(openSync).getMockImplementation();

function tempLockPath() {
  const root = mkdtempSync(path.join(tmpdir(), 'pn-lock-'));
  roots.push(root);
  return path.join(root, 'nested', 'measurement.lock');
}

function spawnHolder(lockPath, holdMs) {
  const source = `const m = await import(${JSON.stringify(MODULE_URL)});
const lock = await m.acquireMeasurementLock({ lockPath: ${JSON.stringify(lockPath)}, owner: { purpose: 'child' }, pollMs: 20 });
console.log('acquired');
setTimeout(() => { lock.release(); process.exit(0); }, ${holdMs});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'inherit'] });
  const acquired = new Promise((resolve) => child.stdout.on('data', (chunk) => {
    if (String(chunk).includes('acquired')) resolve();
  }));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return { child, acquired, exited };
}

afterEach(() => {
  vi.mocked(openSync).mockReset().mockImplementation(originalOpen);
  for (const root of roots.splice(0)) {
    const relative = path.relative(tmpdir(), root);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe lock-test cleanup path.');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('host-wide measurement lock', () => {
  it('creates, describes and releases the lock atomically', async () => {
    const lockPath = tempLockPath();
    const lock = await acquireMeasurementLock({ lockPath, owner: { purpose: 'test', runId: 'r1' } });

    expect(lock).toMatchObject({ held: true, inherited: false, lockPath, waitedMs: 0 });
    expect(readMeasurementLock(lockPath).holder).toMatchObject({ token: lock.token, pid: process.pid, purpose: 'test', runId: 'r1' });
    expect(lock.release()).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(lock.release()).toBe(false);
  });

  it('queues a second scored run until the first releases the lock in another process', async () => {
    const lockPath = tempLockPath();
    const holder = spawnHolder(lockPath, 600);
    await holder.acquired;
    const waits = [];
    const started = Date.now();

    const lock = await acquireMeasurementLock({ lockPath, pollMs: 20, onWait: (current) => waits.push(current.purpose) });

    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(waits).toEqual(['child']);
    lock.release();
    await holder.exited;
  }, 20_000);

  it('reclaims the lock after a holder crashes', async () => {
    const lockPath = tempLockPath();
    const holder = spawnHolder(lockPath, 60_000);
    await holder.acquired;
    holder.child.kill('SIGKILL');
    await holder.exited;

    const lock = await acquireMeasurementLock({ lockPath, pollMs: 20, waitTimeoutMs: 5_000 });

    expect(lock.reclaimed.map((entry) => entry.verdict)).toEqual(['stale-dead-holder']);
    lock.release();
  }, 20_000);

  it('times out instead of waiting forever for a live holder', async () => {
    const lockPath = tempLockPath();
    const first = await acquireMeasurementLock({ lockPath });

    await expect(acquireMeasurementLock({ lockPath, pollMs: 10, waitTimeoutMs: 50 }))
      .rejects.toMatchObject({ code: 'MEASUREMENT_LOCK_TIMEOUT' });
    first.release();
  });

  it('classifies dead, expired and partially written holders', () => {
    const now = Date.parse('2026-10-05T08:00:00.000Z');
    const alive = () => true;
    const dead = () => false;
    const holder = { pid: 1234, expiresAt: '2026-10-05T09:00:00.000Z' };

    expect(classifyExistingLock({ holder, ageMs: 0, now, isAlive: alive })).toBe('busy');
    expect(classifyExistingLock({ holder, ageMs: 0, now, isAlive: dead })).toBe('stale-dead-holder');
    expect(classifyExistingLock({ holder: { ...holder, expiresAt: '2026-10-05T07:00:00.000Z' }, ageMs: 0, now, isAlive: alive })).toBe('stale-expired');
    expect(classifyExistingLock({ holder: null, ageMs: 1_000, now, isAlive: alive })).toBe('busy');
    expect(classifyExistingLock({ holder: null, ageMs: 60_000, now, isAlive: alive })).toBe('stale-unreadable');
  });

  it('reclaims an old unreadable lock file but not one being written', async () => {
    const lockPath = tempLockPath();
    await acquireMeasurementLock({ lockPath }).then((lock) => lock.release());
    writeFileSync(lockPath, '{"tok');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    const lock = await acquireMeasurementLock({ lockPath, pollMs: 10, waitTimeoutMs: 1_000 });

    expect(lock.reclaimed.map((entry) => entry.verdict)).toEqual(['stale-unreadable']);
    lock.release();
  });

  it('lets launcher children inherit the lock and rejects a stale inherited token', async () => {
    const lockPath = tempLockPath();
    const lock = await acquireMeasurementLock({ lockPath });
    const env = { PAGENARRATOR_MEASUREMENT_LOCK_PATH: lockPath, PAGENARRATOR_MEASUREMENT_LOCK_TOKEN: lock.token };

    expect(verifyInheritedMeasurementLock({ token: lock.token, lockPath })).toMatchObject({ held: true, inherited: true });
    await expect(ensureMeasurementLock({ env })).resolves.toMatchObject({ held: true, inherited: true, token: lock.token });
    await expect(ensureMeasurementLock({ env: { ...env, PAGENARRATOR_MEASUREMENT_LOCK_TOKEN: 'wrong' } }))
      .rejects.toThrow(/Inherited measurement lock is not valid/);
    lock.release();
  });

  it.runIf(process.platform === 'win32')('retries Windows open denial only after observing a live holder and its vanished file', async () => {
    const lockPath = tempLockPath(), first = await acquireMeasurementLock({ lockPath });
    const denied = Object.assign(new Error('Transient Windows delete handoff'), { code: 'EPERM', syscall: 'open', path: lockPath });
    let injected = false, second;
    try {
      second = await acquireMeasurementLock({ lockPath, pollMs: 1, sleep: async () => {
        if (injected) return;
        injected = true; expect(first.release()).toBe(true);
        vi.mocked(openSync).mockImplementationOnce(() => { throw denied; });
      } });
      expect(injected).toBe(true); expect(second.held).toBe(true);
      expect(second.reclaimed).toEqual([]);
      expect(readMeasurementLock(lockPath).holder.token).toBe(second.token);
    } finally { second?.release(); first.release(); }
  });

  it('does not retry an initial permission denial without a verified previous holder', async () => {
    const lockPath = tempLockPath(), sleep = vi.fn();
    const denied = Object.assign(new Error('Actual permission denied'), { code: 'EPERM', syscall: 'open', path: lockPath });
    vi.mocked(openSync).mockImplementationOnce(() => { throw denied; });
    await expect(acquireMeasurementLock({ lockPath, sleep })).rejects.toBe(denied);
    expect(sleep).not.toHaveBeenCalled(); expect(existsSync(lockPath)).toBe(false);
  });

  it.runIf(process.platform === 'win32')('keeps a nonmissing owner file intact after a permission denial', async () => {
    const lockPath = tempLockPath(), first = await acquireMeasurementLock({ lockPath });
    const denied = Object.assign(new Error('Existing file ACL denial'), { code: 'EPERM', syscall: 'open', path: lockPath });
    const sleep = vi.fn(async () => { vi.mocked(openSync).mockImplementationOnce(() => { throw denied; }); });
    try {
      await expect(acquireMeasurementLock({ lockPath, sleep })).rejects.toBe(denied);
      expect(sleep).toHaveBeenCalledOnce(); expect(readMeasurementLock(lockPath).holder.token).toBe(first.token);
    } finally { first.release(); }
  });

  it.runIf(process.platform === 'win32').each([
    ['a persistent denial', 5_000, 1_020],
    ['the existing shorter wait budget', 50, 50],
  ])('bounds release-handoff retries for %s and preserves the original error', async (_name, waitTimeoutMs, maximumMs) => {
    const lockPath = tempLockPath(), first = await acquireMeasurementLock({ lockPath });
    const denied = Object.assign(new Error('Persistent ACL denial after owner release'), { code: 'EPERM', syscall: 'open', path: lockPath });
    let instant = 0;
    try {
      await expect(acquireMeasurementLock({ lockPath, pollMs: 20, waitTimeoutMs, now: () => instant, sleep: async ms => {
        instant += ms; first.release(); vi.mocked(openSync).mockImplementation(() => { throw denied; });
      } })).rejects.toBe(denied);
      expect(instant).toBe(maximumMs); expect(existsSync(lockPath)).toBe(false);
    } finally { first.release(); }
  });

  it.runIf(process.platform === 'win32').each([
    ['other errno', { code: 'EACCES', syscall: 'open' }],
    ['write failure', { code: 'EPERM', syscall: 'write' }],
    ['different path', { code: 'EPERM', syscall: 'open', path: 'another.lock' }],
  ])('does not turn %s into a release retry', async (_name, fields) => {
    const lockPath = tempLockPath(), first = await acquireMeasurementLock({ lockPath });
    const denied = Object.assign(new Error('Not the Windows create handoff'), { path: lockPath, ...fields });
    const sleep = vi.fn(async () => { first.release(); vi.mocked(openSync).mockImplementationOnce(() => { throw denied; }); });
    try {
      await expect(acquireMeasurementLock({ lockPath, sleep })).rejects.toBe(denied);
      expect(sleep).toHaveBeenCalledOnce();
    } finally { first.release(); }
  });
});
