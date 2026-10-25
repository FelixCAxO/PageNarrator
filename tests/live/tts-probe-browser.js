import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CdpConnection, CdpWebSocketConnection } from './cdp-connection.js';
import { resolveCpuAffinity } from '../../scripts/weak-hardware/evidence-contract.mjs';
import { describeLaunch } from '../../scripts/weak-hardware/run-provenance.mjs';
import {
  buildJobLimits,
  formatChromeAdapterLuid,
  formatCounterAdapterLuid,
  isJobSupervisorSupported,
  startJobSupervisor,
  summarizeJobEnforcement,
  vendorNameForId,
} from '../../scripts/weak-hardware/windows-job.mjs';

export class ProbeEnvironmentBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProbeEnvironmentBlockedError';
    this.status = 'blocked';
  }
}

/**
 * Chooses how the probe browser is supervised. Enforced constraints require
 * the Windows job supervisor; everything else may use it for process-tree
 * supervision and resource accounting.
 * @param {{ profile: any, requested?: string, platform?: string }} options
 */
export function selectProbeSupervisor({ profile, requested = 'auto', platform = process.platform }) {
  const needsJob = Object.keys(profile?.evidence?.enforced || {}).length > 0 || Boolean(profile?.evidence?.selected?.gpuAdapter);
  const jobSupported = isJobSupervisorSupported(platform);
  if (requested === 'pipe') {
    return needsJob
      ? { mode: 'blocked', reason: 'enforced constraints and adapter selection need the Windows job supervisor; PAGENARRATOR_TTS_PROBE_SUPERVISOR=pipe was requested' }
      : { mode: 'pipe', reason: 'requested' };
  }
  if (jobSupported) return { mode: 'job', reason: needsJob ? 'constraints require the job supervisor' : 'process-tree supervision' };
  return needsJob
    ? { mode: 'blocked', reason: `the job supervisor is unavailable on ${platform}` }
    : { mode: 'pipe', reason: `the job supervisor is unavailable on ${platform}` };
}

/**
 * Base Chromium flags shared by every probe browser.
 * @param {{ userDataDir: string, extensionDir: string, headless?: boolean, nativeBackgrounding?: boolean, extraArgs?: string[] }} options
 */
export function createProbeBrowserArgs({ userDataDir, extensionDir, headless = false, nativeBackgrounding = false, extraArgs = [] }) {
  return [
    `--user-data-dir=${userDataDir}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--disable-background-networking',
    // Controlled lane: covered test windows keep rendering and loading audio.
    ...(nativeBackgrounding ? [] : ['--disable-backgrounding-occluded-windows']),
    '--disable-popup-blocking',
    '--disable-sync',
    ...(headless ? ['--headless=new'] : []),
    ...extraArgs,
    'about:blank',
  ];
}

/**
 * @param {{
 *   chromeExe: string,
 *   userDataDir: string,
 *   extensionDir: string,
 *   profile: any,
 *   supervisor?: string,
 *   headless?: boolean,
 *   nativeBackgrounding?: boolean,
 * }} options
 */
export async function launchProbeBrowser({
  chromeExe,
  userDataDir,
  extensionDir,
  profile,
  supervisor: requestedSupervisor = 'auto',
  headless = false,
  nativeBackgrounding = false,
}) {
  const selection = selectProbeSupervisor({ profile, requested: requestedSupervisor });
  if (selection.mode === 'blocked') throw new ProbeEnvironmentBlockedError(selection.reason);
  if (selection.mode === 'pipe') {
    return launchPipeBrowser({ chromeExe, userDataDir, extensionDir, headless, nativeBackgrounding, selection });
  }
  return launchJobBrowser({ chromeExe, userDataDir, extensionDir, profile, headless, nativeBackgrounding, selection });
}

async function launchPipeBrowser({ chromeExe, userDataDir, extensionDir, headless, nativeBackgrounding, selection }) {
  const args = ['--remote-debugging-pipe', ...createProbeBrowserArgs({ userDataDir, extensionDir, headless, nativeBackgrounding })];
  const chromeProcess = spawn(chromeExe, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const cdp = new CdpConnection(chromeProcess);
  return {
    cdp,
    supervisorMode: 'pipe',
    supervisorReason: selection.reason,
    launch: describeLaunch({ executable: chromeExe, args, userDataDir, supervisor: 'pipe' }),
    resolvedAffinity: null,
    gpuAdapterSelection: null,
    topology: null,
    queryEnforcement: async () => ({ supported: false, adapter: null, processes: [], limits: null, error: 'pipe-launched browser has no constraint adapter' }),
    gpuSample: async () => null,
    async close() {
      cdp.close();
      if (!chromeProcess.killed) {
        const exited = new Promise((resolve) => chromeProcess.once('exit', resolve));
        chromeProcess.kill();
        await Promise.race([exited, delay(5_000)]);
      }
      return verifyBrowserTreeGone(userDataDir);
    },
  };
}

async function launchJobBrowser({ chromeExe, userDataDir, extensionDir, profile, headless, nativeBackgrounding, selection }) {
  const supervisor = await startJobSupervisor();
  try {
    const enforced = profile?.evidence?.enforced || {};
    let topology = null;
    let resolvedAffinity = null;
    if (enforced.cpuAffinity) {
      topology = (await supervisor.topology()).processors;
      resolvedAffinity = resolveCpuAffinity(enforced.cpuAffinity, topology);
      if (!resolvedAffinity.available) throw new ProbeEnvironmentBlockedError(`CPU affinity unavailable: ${resolvedAffinity.reason}`);
    }
    let gpuAdapterSelection = null;
    const extraArgs = [];
    const selectedAdapter = profile?.evidence?.selected?.gpuAdapter;
    if (selectedAdapter) {
      const inventory = await supervisor.adapters();
      const adapters = inventory.adapters;
      const match = adapters.find((adapter) => !adapter.software && vendorNameForId(adapter.vendorId) === selectedAdapter.expectedVendor);
      if (!match) {
        throw new ProbeEnvironmentBlockedError(`no ${selectedAdapter.expectedVendor} physical adapter is present (found: ${adapters.map((adapter) => adapter.description).join(', ')})`);
      }
      gpuAdapterSelection = describeProbeGpuAdapterSelection(inventory, match);
      extraArgs.push(`--use-adapter-luid=${gpuAdapterSelection.chromeLuid}`);
    }
    const args = ['--remote-debugging-port=0', ...createProbeBrowserArgs({ userDataDir, extensionDir, headless, nativeBackgrounding, extraArgs })];
    const limits = buildJobLimits(enforced, { resolvedAffinity });
    // A restarted browser on the same profile must not be found through the
    // previous instance's endpoint file.
    rmSync(path.join(userDataDir, 'DevToolsActivePort'), { force: true });
    const launched = await supervisor.launch({ exe: chromeExe, args, limits });
    const endpoint = await waitForDevToolsEndpoint(userDataDir);
    const cdp = await CdpWebSocketConnection.connect(endpoint);
    return {
      cdp,
      supervisorMode: 'job',
      supervisorReason: selection.reason,
      rootPid: launched.pid,
      requestedLimits: limits,
      launch: describeLaunch({ executable: chromeExe, args, userDataDir, supervisor: 'windows-job' }),
      resolvedAffinity,
      gpuAdapterSelection,
      topology,
      async queryEnforcement() {
        try {
          const enforcement = summarizeJobEnforcement(await supervisor.query({ matchCommandLine: userDataDir }));
          return { ...enforcement, resolvedAffinity };
        } catch (error) {
          return { supported: false, adapter: 'windows-job', processes: [], limits: null, error: error.message, resolvedAffinity };
        }
      },
      gpuSample: () => supervisor.gpuSample().catch((error) => ({ ok: false, enginesError: error.message })),
      async close() {
        cdp.close();
        await supervisor.terminate();
        return verifyBrowserTreeGone(userDataDir);
      },
    };
  } catch (error) {
    await supervisor.terminate();
    throw error;
  }
}

async function waitForDevToolsEndpoint(userDataDir, timeoutMs = 30_000) {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(file)) {
      const [port, browserPath] = readFileSync(file, 'utf8').split(/\r?\n/);
      if (/^\d+$/.test(port || '') && browserPath?.startsWith('/devtools/browser/')) {
        return `ws://127.0.0.1:${port}${browserPath}`;
      }
    }
    await delay(100);
  }
  throw new Error('The supervised browser did not publish a DevTools endpoint.');
}

/**
 * Confirms no process for this run's private profile is still running. Only
 * processes whose command line names the unique user-data-dir are touched, so
 * personal browser sessions are never affected.
 * @param {string} userDataDir
 */
export async function verifyBrowserTreeGone(userDataDir, { attempts = 20 } = {}) {
  if (process.platform !== 'win32') return { verified: false, remaining: null, reason: 'process listing implemented for Windows only' };
  if (typeof userDataDir !== 'string' || !path.win32.isAbsolute(userDataDir)
    || path.win32.normalize(userDataDir) === path.win32.parse(path.win32.normalize(userDataDir)).root) {
    return { verified: false, remaining: null, forced: false, reason: 'a private browser profile directory is required' };
  }
  let remaining = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const query = listProcessesForUserDataDir(userDataDir);
    if (query.pids === null) return { verified: false, remaining: null, forced: false, reason: query.reason, query };
    remaining = query.pids;
    if (!remaining.length) return { verified: true, remaining: 0, forced: false, query };
    await delay(250);
  }
  for (const pid of remaining) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  await delay(500);
  const query = listProcessesForUserDataDir(userDataDir);
  if (query.pids === null) {
    return { verified: false, remaining: null, forced: true, forcedPids: remaining, reason: query.reason, query };
  }
  return { verified: query.pids.length === 0, remaining: query.pids.length, forced: true, forcedPids: remaining, query };
}

export function createProbeProfileArgumentPattern(userDataDir) {
  const argument = `--user-data-dir=${userDataDir}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Skip complete preceding arguments, including quoted values, so mentions in
  // another argument cannot select that process. Our launcher quotes the whole
  // --user-data-dir token when the path contains whitespace.
  const prefix = String.raw`(?:(?:[^\s"]|"(?:[^"\\]|\\.)*")+\s+)*`;
  const exact = /\s/.test(userDataDir) ? `"${argument}"` : `(?:"${argument}"|${argument})`;
  return String.raw`^\s*${prefix}${exact}(?=\s|$)`;
}

function listProcessesForUserDataDir(userDataDir) {
  const argumentPattern = createProbeProfileArgumentPattern(userDataDir).replaceAll("'", "''");
  const script = `$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction Stop | Where-Object { $_.CommandLine -and $_.CommandLine -match '${argumentPattern}' } | ForEach-Object { $_.ProcessId }`;
  let result;
  try {
    result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  } catch (error) {
    result = { error, status: null, signal: null, stdout: null, stderr: null };
  }
  const query = {
    status: result.status ?? null,
    signal: result.signal ?? null,
    error: result.error ? String(result.error.message || result.error) : null,
    errorCode: result.error?.code ?? null,
    stdout: typeof result.stdout === 'string' ? result.stdout : null,
    stderr: String(result.stderr ?? ''),
    pids: null,
    reason: null,
  };
  if (query.error || query.status !== 0 || query.signal || query.stderr.trim()) {
    return { ...query, reason: 'browser process query failed' };
  }
  if (query.stdout === null) return { ...query, reason: 'browser process query output is unavailable' };
  const lines = query.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const pids = lines.map(Number);
  if (lines.some((line, index) => !/^\d+$/.test(line) || !Number.isSafeInteger(pids[index]) || pids[index] <= 0 || pids[index] > 0xFFFFFFFF)) {
    return { ...query, reason: 'browser process query returned malformed PID output' };
  }
  return { ...query, pids };
}

// Preserve the one existing DXGI enumeration; no extra adapter/device request.
export function describeProbeGpuAdapterSelection(inventory, match) {
  const row = adapter => ({ description: adapter.description, vendorId: adapter.vendorId, deviceId: adapter.deviceId,
    luidHigh: adapter.luidHigh, luidLow: adapter.luidLow, software: adapter.software,
    chromeLuid: formatChromeAdapterLuid(adapter), counterLuid: formatCounterAdapterLuid(adapter) });
  return { ...row(match), vendor: vendorNameForId(match.vendorId), dedicatedVideoMemoryBytes: Number(match.dedicatedVideoMemoryBytes),
    inventoryComplete: inventory.adaptersComplete === true,
    inventoryErrors: Array.isArray(inventory.adapterErrors) ? [...inventory.adapterErrors] : null,
    allAdapters: inventory.adapters.map(row) };
}
