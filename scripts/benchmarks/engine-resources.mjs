import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { launchExtensionContext, seedHardwareProfile, startReadFromToolbarPopup } from '../../tests/e2e/extension-fixture.js';
import { openRoutedReaderEngine, routeKokoroModelFiles, routeOmniVoiceModelFiles } from '../../tests/e2e/kokoro-download-fixture.js';
import { computeGpuEngineUsage } from '../weak-hardware/windows-job.mjs';
import { acquireMeasurementLock } from '../weak-hardware/measurement-lock.mjs';

// Real packaged-extension playback; controller/model fixture server memory is excluded.
const output = path.resolve(process.env.PN_RESOURCE_OUTPUT || 'artifacts/engine-resources');
const extensionDir = path.resolve(process.env.PN_RESOURCE_EXTENSION_DIR || 'releases/pagenarrator-1.0.0');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const paragraphs = [
  'The morning sun warmed the garden as we opened the door and stepped outside.',
  'A small bird landed on the wooden fence and sang softly in the fresh air.',
  'We followed the quiet path toward the trees and stopped beside the old stone wall.',
  'Beyond the bridge, the river moved slowly past a field of bright yellow flowers.',
  'We sat beneath the branches for a while and talked about our plans for the afternoon.',
  'When the clouds began to gather, we walked home and made a pot of warm tea.',
];
export const processMemorySampler = `import psutil,sys,time,json,os
root=psutil.Process(int(sys.argv[1])); destination=sys.argv[2]
while root.is_running():
 try: processes=[root]+root.children(recursive=True)
 except psutil.NoSuchProcess: break
 rows=[]; errors=[]; started=time.time()
 for p in processes:
  for attempt in range(3):
   try:
    m=p.memory_full_info(); rows.append(dict(pid=p.pid,private=m.private,uss=m.uss,rss=m.rss)); break
   except psutil.NoSuchProcess: break
   except psutil.AccessDenied:
    if attempt==2: errors.append(p.pid)
    else: time.sleep(.005)
 with open(destination+'.tmp','w') as f: json.dump([p['pid'] for p in rows],f)
 for attempt in range(20):
  try: os.replace(destination+'.tmp',destination); break
  except PermissionError:
   if attempt==19: raise
   time.sleep(.005)
 print(json.dumps(dict(at=started*1000,processes=rows,errors=errors)),flush=True)
 time.sleep(max(0,.1-(time.time()-started)))
`;
export const gpuSampler = `param([string]$Source,[string]$Pids,[string]$StopFile)
$ErrorActionPreference='Stop'
Add-Type -Path $Source -ReferencedAssemblies System.Management,System.Web.Extensions
while (-not (Test-Path -LiteralPath $StopFile)) {
  $ids = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($processId in (Get-Content -LiteralPath $Pids -Raw | ConvertFrom-Json)) { [void]$ids.Add([int]$processId) }
  $sample = [PageNarrator.WeakHardware.GpuCounters]::Sample($ids)
  $sample | ConvertTo-Json -Depth 12 -Compress
  Start-Sleep -Milliseconds 500
}
`;

function collect(child, records, errors) {
  let pending = '';
  child.stdout.on('data', bytes => {
    pending += bytes;
    const lines = pending.split('\n'); pending = lines.pop();
    for (const line of lines.filter(Boolean)) records.push(JSON.parse(line));
  });
  child.stderr.on('data', bytes => errors.push(String(bytes)));
}

function stats(values) {
  assert(values.length && values.every(Number.isFinite), 'Missing/nonfinite metric');
  return { mean: values.reduce((a, b) => a + b, 0) / values.length, peak: Math.max(...values), last: values.at(-1) };
}

export function summarize(run, name) {
  const start = run.phases.find(p => p.name === name).at;
  const end = run.phases.find(p => p.at > start)?.at ?? Infinity;
  const ram = run.ram.filter(s => s.at >= start && s.at < end);
  const gpu = run.gpu.filter(s => Date.parse(s.sampledAtUtc) >= start && Date.parse(s.sampledAtUtc) < end);
  // Foreign applications create/destroy GPU contexts independently of this browser.
  // Keep the complete browser-only enumeration so their churn cannot invalidate its counters.
  const own = sample => ({ ...sample, engineInstances: sample.engineInstances.filter(e => e.isJob) });
  const targetLuid = run.gpu.flatMap(s => s.memory).sort((a, b) => Number(b.jobDedicatedBytes) - Number(a.jobDedicatedBytes))[0].luid;
  const intervals = run.gpu.slice(1).map((after, i) => ({ after, ...computeGpuEngineUsage(own(run.gpu[i]), own(after)) }))
    .filter(s => Date.parse(s.after.sampledAtUtc) >= start && Date.parse(s.after.sampledAtUtc) < end && s.available);
  const adapterIntervals = intervals.map(s => ({ adapter: s.adapters.find(a => a.luid === targetLuid), seconds: s.wallSeconds })).filter(s => s.adapter);
  assert(ram.length >= 10 && gpu.length >= 2, `Too few ${name} samples`);
  assert(adapterIntervals.length >= 2, 'GPU counters unavailable');
  const utilization = stats(adapterIntervals.map(s => 100 * s.adapter.jobMaxEngineUtilization));
  utilization.mean = adapterIntervals.reduce((sum, s) => sum + 100 * s.adapter.jobMaxEngineUtilization * s.seconds, 0) / adapterIntervals.reduce((sum, s) => sum + s.seconds, 0);
  return {
    seconds: (end - start) / 1000, ramSamples: ram.length, gpuSamples: gpu.length,
    privateBytes: stats(ram.map(s => s.processes.reduce((n, p) => n + p.private, 0))),
    uniqueResidentBytes: stats(ram.map(s => s.processes.reduce((n, p) => n + p.uss, 0))),
    dedicatedGpuBytes: stats(gpu.map(s => s.memory.reduce((n, m) => n + Number(m.jobDedicatedBytes), 0))),
    sharedGpuBytes: stats(gpu.map(s => s.memory.reduce((n, m) => n + Number(m.jobSharedBytes), 0))),
    gpuPercent: utilization, counterAdapterLuid: targetLuid,
    invalidGpuIntervals: gpu.length - adapterIntervals.length,
  };
}

async function measure(engine, repeat, url) {
  const run = { engine, repeat, phases: [], ram: [], gpu: [], nvidia: [], errors: [], playback: [] };
  const phase = name => { run.phases.push({ name, at: Date.now() }); console.log(`${engine} r${repeat}: ${name}`); };
  const stem = path.join(output, `${engine}-${repeat}`), pids = `${stem}-pids.json`, stop = `${stem}-stop`;
  if (existsSync(stop)) unlinkSync(stop);
  const launched = await launchExtensionContext({ extensionDir, hostPermissions: ['http://127.0.0.1/*'] });
  const { context } = launched;
  let ramMonitor, gpuMonitor, boardMonitor;
  try {
    if (engine === 'kokoro') await routeKokoroModelFiles(context);
    else await routeOmniVoiceModelFiles(context);
    await seedHardwareProfile(context, { name: 'real-resource-comparison', navigator: {}, playbackSettings: {
      ttsEngine: engine, language: 'en', voice: 'af_heart', speed: 1, sectionPauseSeconds: 0,
      ttsPerformanceProfile: 'quality', omniVoice: { gender: 'female', variation: 1, whisper: false },
    } }, { enableProbe: true, recordFlow: true });
    const host = await openRoutedReaderEngine(context);
    run.adapter = await host.evaluate(async () => {
      const adapter = await navigator.gpu.requestAdapter();
      return adapter ? { vendor: adapter.info.vendor, device: adapter.info.device, description: adapter.info.description } : null;
    });
    assert.equal(run.adapter?.vendor, 'nvidia', 'Must measure the real NVIDIA adapter');
    const cdp = await context.browser().newBrowserCDPSession();
    run.browserVersion = context.browser().version();
    const rootPid = (await cdp.send('SystemInfo.getProcessInfo')).processInfo.find(p => p.type === 'browser').id;
    run.rootPid = rootPid;
    writeFileSync(pids, JSON.stringify([rootPid]));
    ramMonitor = spawn('python', ['-u', '-c', processMemorySampler, String(rootPid), pids], { windowsHide: true });
    collect(ramMonitor, run.ram, run.errors);
    gpuMonitor = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(output, 'gpu-sampler.ps1'), '-Source', path.resolve('scripts/weak-hardware/windows-job-supervisor.cs'), '-Pids', pids, '-StopFile', stop], { windowsHide: true });
    collect(gpuMonitor, run.gpu, run.errors);
    boardMonitor = spawn('nvidia-smi', ['--query-gpu=timestamp,utilization.gpu,memory.used', '--format=csv,noheader,nounits', '--loop-ms=500'], { windowsHide: true });
    let boardPending = '';
    boardMonitor.stdout.on('data', bytes => {
      boardPending += bytes; const lines = boardPending.split('\n'); boardPending = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const [timestamp, gpuPercent, memoryMiB] = line.trim().split(', ');
        run.nvidia.push({ at: Date.parse(timestamp.replaceAll('/', '-').replace(' ', 'T')), gpuPercent: Number(gpuPercent), memoryMiB: Number(memoryMiB) });
      }
    });
    boardMonitor.stderr.on('data', bytes => run.errors.push(String(bytes)));
    const article = await context.newPage(); await article.goto(url);
    const worker = context.serviceWorkers()[0];
    phase('baseline'); await wait(9000);
    for (const mode of ['cold', 'warm']) {
      phase(mode); const start = Date.now();
      await startReadFromToolbarPopup(context, article);
      // Wait for a new session, rather than accepting the previous finished state.
      await expect.poll(async () => (await worker.evaluate(() => chrome.storage.session.get('readerEngineState'))).readerEngineState?.state,
        { timeout: 60_000 }).not.toBe('finished');
      await expect.poll(async () => {
        const { readerEngineState: state = {} } = await worker.evaluate(() => chrome.storage.session.get('readerEngineState'));
        if (state.state === 'error') throw new Error(JSON.stringify(state));
        return state.state;
      }, { timeout: 300_000 }).toBe('finished');
      run.playback.push({ mode, elapsedMs: Date.now() - start });
      phase(`${mode}-retained`); await wait(5000);
    }
    phase('done');
    run.diagnostics = await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }));
    const log = run.diagnostics.log;
    assert(!log.some(e => /fallback|chunk_error/.test(e.kind)), 'Unexpected fallback or chunk failure');
    assert(log.filter(e => e.kind === 'chunk_end').length >= paragraphs.length * 2, 'Missing completed speech');
    assert(run.ram.every(s => !s.errors.length), 'RAM process access denied');
    assert(run.gpu.every(s => s.engineInstancesComplete && !s.memoryError), 'Incomplete GPU counters');
    assert(run.nvidia.length > 10 && run.nvidia.every(s => Number.isFinite(s.memoryMiB)), 'NVIDIA cross-check unavailable');
    run.summary = Object.fromEntries(['baseline', 'cold', 'cold-retained', 'warm', 'warm-retained'].map(name => [name, summarize(run, name)]));
    run.status = 'passed';
  } catch (error) { run.status = 'failed'; run.error = error.stack; throw error; }
  finally {
    writeFileSync(stop, 'stop');
    await launched.cleanup();
    ramMonitor?.kill();
    boardMonitor?.kill();
    await wait(1000); gpuMonitor?.kill();
    writeFileSync(`${stem}.json`, JSON.stringify(run));
  }
  assert.deepEqual(run.errors, [], 'Resource sampler error');
  return { ...run, ram: undefined, gpu: undefined, nvidia: undefined, diagnostics: undefined };
}

async function main() {
assert.equal(process.platform, 'win32');
assert.equal(stats([1, 2, 3]).mean, 2);
assert.equal(stats([1, 2, 3]).peak, 3);
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, 'gpu-sampler.ps1'), gpuSampler);
const identity = createHash('sha256').update(readFileSync(process.env.PN_RESOURCE_PACKAGE_ZIP || `${extensionDir}.zip`)).digest('hex');
const server = createServer((_, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<html lang="en"><title>A walk in the garden</title><article>${paragraphs.map(p => `<p>${p}</p>`).join('')}</article></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const lock = await acquireMeasurementLock({ owner: { purpose: 'Kokoro versus OmniVoice resource comparison' }, onWait: holder => console.log('Waiting for measurement lock', holder.pid) });
const report = { startedAt: new Date().toISOString(), extensionDir, releaseZipSha256: identity, paragraphs, runs: [] };
try {
  const engines = (process.env.PN_RESOURCE_ENGINES || 'kokoro,omnivoice').split(',');
  assert(engines.length && engines.every(engine => ['kokoro', 'omnivoice'].includes(engine)));
  const repeats = Number(process.env.PN_RESOURCE_REPEATS || 2);
  assert(Number.isInteger(repeats) && repeats > 0);
  for (let repeat = 1; repeat <= repeats; repeat++) for (const engine of repeat % 2 ? engines : [...engines].reverse()) {
    report.runs.push(await measure(engine, repeat, `http://127.0.0.1:${server.address().port}/`));
    writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  }
  report.status = 'passed';
} finally {
  lock.release(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
