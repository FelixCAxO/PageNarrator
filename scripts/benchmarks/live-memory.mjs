import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { launchExtensionContext, getExtensionId, openCorpusArticle, seedHardwareProfile,
  startReadFromToolbarPopup, recordPlaybackEvents } from '../../tests/e2e/extension-fixture.js';
import { routeKokoroModelFiles, seedKokoroModelCache } from '../../tests/e2e/kokoro-download-fixture.js';
import { startCorpusFixtureServer } from '../../tests/e2e/corpus-fixture-server.js';
import { buildCorpusFlowReport } from '../../tests/e2e/corpus-flow-invariants.js';
import { acquireMeasurementLock } from '../weak-hardware/measurement-lock.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const sampler = `import psutil,sys,time,json
root=psutil.Process(int(sys.argv[1])); known={}; interval=.1
while True:
 try: procs=[root]+root.children(recursive=True)
 except psutil.NoSuchProcess: break
 started=time.time(); records=[]; errors=[]
 for p in procs:
  try:
   m=p.memory_full_info(); known[p.pid]=p.create_time()
   records.append(dict(pid=p.pid,rss=m.rss,private=m.private,uss=m.uss))
  except (psutil.NoSuchProcess,psutil.AccessDenied) as e: errors.append(dict(pid=p.pid,error=type(e).__name__))
 print(json.dumps(dict(at=started*1000,processes=records,errors=errors,sampleMs=(time.time()-started)*1000)),flush=True)
 time.sleep(max(0,interval-(time.time()-started)))
for attempt in range(50):
 remaining=[]
 for pid,created in known.items():
  try:
   p=psutil.Process(pid)
   if p.create_time()==created and p.is_running(): remaining.append(pid)
  except psutil.NoSuchProcess: pass
 if not remaining: break
 time.sleep(.1)
print(json.dumps(dict(event='closed',remaining=remaining)),flush=True)
`;

function packageHashes(directory) {
  return Object.fromEntries(readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(directory, file).replaceAll('\\', '/'), sha256(readFileSync(file))];
    }).sort(([a], [b]) => a.localeCompare(b)));
}

function summarize(samples) {
  samples = samples.filter(sample => sample.errors.length === 0);
  assert(samples.length, 'No memory samples for phase');
  const metrics = ['rss', 'private', 'uss'];
  const totals = samples.map(sample => Object.fromEntries(metrics.map(metric =>
    [metric, sample.processes.reduce((sum, item) => sum + item[metric], 0)])));
  return { samples: samples.length, ...Object.fromEntries(metrics.map(metric => [metric, {
    peak: Math.max(...totals.map(item => item[metric])),
    mean: totals.reduce((sum, item) => sum + item[metric], 0) / totals.length,
    last: totals.at(-1)[metric],
  }])) };
}

async function measure({ extensionDir, workload, repeat, output, pdf, articleServer }) {
  const result = { variant: path.basename(extensionDir), workload, repeat, phases: [], samples: [], startedAt: new Date().toISOString() };
  const phase = name => { result.phases.push({ name, at: Date.now() }); console.log(`${result.variant} r${repeat} ${workload}: ${name}`); };
  let launched, context, monitor, monitorExit, cdp, pdfServer, runFailure;
  try {
    launched = await launchExtensionContext({ extensionDir, hostPermissions: ['http://*/*'] });
    context = launched.context;
    if (workload === 'tts') {
      await routeKokoroModelFiles(context);
      await seedHardwareProfile(context, { name: 'live-ram-quality', navigator: {}, playbackSettings: {
        language: 'en', voice: 'af_heart', speed: 1, sectionPauseSeconds: 0, ttsPerformanceProfile: 'quality',
      } }, { enableProbe: true, recordFlow: true });
      await seedKokoroModelCache(context);
      // Stage exact model bytes on disk, then restart: download-fixture buffers must not inflate measured RAM.
      await context.close();
      context = await chromium.launchPersistentContext(launched.userDataDir, { channel: 'chromium', headless: true,
        args: [`--disable-extensions-except=${launched.extensionDir}`, `--load-extension=${launched.extensionDir}`,
          '--autoplay-policy=no-user-gesture-required'] });
      await routeKokoroModelFiles(context);
    }
    cdp = await context.browser().newBrowserCDPSession();
    result.browserVersion = context.browser().version();
    const hardware = await cdp.send('SystemInfo.getInfo');
    result.gpuDevices = hardware.gpu.devices;
    result.rootPid = (await cdp.send('SystemInfo.getProcessInfo')).processInfo.find(item => item.type === 'browser').id;
    monitor = spawn('python', ['-u', '-c', sampler, String(result.rootPid)], { windowsHide: true });
    let pending = '';
    result.monitorErrors = [];
    monitor.stdout.on('data', chunk => {
      pending += chunk; const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const record = JSON.parse(line);
        if (record.event) result.closeObservation = record;
        else result.samples.push({ ...record, phase: result.phases.filter(item => item.at <= record.at).at(-1)?.name || 'startup' });
      }
    });
    monitor.stderr.on('data', chunk => result.monitorErrors.push(String(chunk)));
    monitorExit = new Promise((resolve, reject) => { monitor.once('error', reject); monitor.once('close', resolve); });
    phase('idle'); await wait(2500);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    if (workload === 'ocr') {
      pdfServer = createServer((_, response) => { response.writeHead(200, { 'Content-Type': 'application/pdf' }); createReadStream(pdf).pipe(response); });
      await new Promise(resolve => pdfServer.listen(0, '127.0.0.1', resolve));
      const page = await context.newPage();
      phase('pdf-load');
      await page.goto(`chrome-extension://${await getExtensionId(context)}/src/pdf-viewer.html?src=${encodeURIComponent(`http://127.0.0.1:${pdfServer.address().port}/book.pdf`)}`);
      await expect(page.locator('#pdf-status')).toContainText('1 page loaded', { timeout: 60000 });
      const tabId = await page.evaluate(async () => (await chrome.tabs.getCurrent()).id);
      const metadata = await worker.evaluate(tabId => chrome.tabs.sendMessage(tabId, { type: 'getPdfStreamMetadata', startPage: 1 }), tabId);
      assert(metadata.ok); phase('pdf-ready'); await wait(2000);
      phase('ocr'); const started = Date.now();
      const response = await worker.evaluate(({ tabId, instanceToken }) => chrome.tabs.sendMessage(tabId, {
        type: 'getPdfChunk', instanceToken, streamId: 'live-memory', startPage: 1, count: 1,
        speechChunkOptions: { maxLen: 100000, targetMinLen: 100000 },
      }), { tabId, instanceToken: metadata.instanceToken });
      result.ocrMs = Date.now() - started; assert(response.ok, JSON.stringify(response));
      const chunk = response.value || response.chunks?.[0]; assert(chunk.speech?.length > 100);
      const highlight = await worker.evaluate(({ tabId, chunk }) => chrome.tabs.sendMessage(tabId, {
        type: 'highlightChunk', anchorId: chunk.anchorId, text: chunk.anchorText,
        chunkText: chunk.speech, domWordOffset: chunk.domWordOffset,
      }), { tabId, chunk });
      assert(highlight.ok);
      result.ocrOutput = { speech: chunk.speech, words: await page.locator('.textLayer[data-ocr="true"]').evaluate(layer => {
        const area = layer.getBoundingClientRect();
        return [...layer.querySelectorAll('span')].map(span => { const box = span.getBoundingClientRect();
          return { text: span.textContent.trim(), x: (box.left + box.width / 2 - area.left) / area.width,
            y: (box.top + box.height / 2 - area.top) / area.height }; });
      }) };
      phase('ocr-retained'); await wait(5000);
      await page.close(); phase('viewer-closed'); await wait(10000);
    } else {
      const page = await openCorpusArticle(context, articleServer, 'playback-controls-long.html');
      phase('article-ready'); await wait(2000);
      phase('tts'); await startReadFromToolbarPopup(context, page);
      await expect.poll(async () => {
        const state = await worker.evaluate(() => chrome.storage.session.get('readerEngineState').then(value => value.readerEngineState?.state));
        assert.notEqual(state, 'error', 'Live speech entered error state'); return state;
      }, { timeout: 300000, intervals: [500] }).toBe('finished');
      phase('tts-retained'); await wait(5000);
      const diagnostics = await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }));
      const flow = buildCorpusFlowReport({ readerEngineLog: diagnostics.log, pageLog: await recordPlaybackEvents(page, context) });
      assert(flow.chunksSpoken > 0); assert.equal(flow.chunksSpoken, flow.chunksExtracted);
      assert(flow.wordEvents.length > 0, 'No actual word highlights');
      for (const key of ['synthesisFailures', 'missingChunkIndices', 'unendedChunkIndices', 'replayedChunkIndices', 'tokenMismatches']) assert.deepEqual(flow[key], [], key);
      assert(!diagnostics.log.some(entry => entry.kind === 'browser_voice_fallback'));
      assert(diagnostics.log.some(entry => entry.kind === 'audio_decode_latency'));
      result.ttsOutput = { speech: flow.chunkStarts.map(entry => entry.speechText), chunks: flow.chunksSpoken,
        wordEvents: flow.wordEvents.length, backend: diagnostics.hardwareProbe?.selectedBackendPlan,
        fallbacks: diagnostics.hardwareProbe?.fallbacks };
      assert.equal(result.ttsOutput.backend?.device, 'webgpu');
      assert.equal(result.ttsOutput.backend?.dtype, 'fp32');
      await page.close(); phase('article-closed'); await wait(10000);
    }
    const actualPids = (await cdp.send('SystemInfo.getProcessInfo')).processInfo.map(item => item.id);
    const sampledPids = new Set(result.samples.slice(-5).flatMap(sample => sample.processes.map(item => item.pid)));
    result.unobservedFinalPids = actualPids.filter(pid => !sampledPids.has(pid));
    assert.deepEqual(result.unobservedFinalPids, []);
    result.incompleteSamples = result.samples.filter(sample => sample.errors.length > 0).length;
    assert(!result.samples.some(sample => sample.errors.some(error => error.error === 'AccessDenied')), 'Unreadable browser memory');
    result.sampling = { maximumReadMs: Math.max(...result.samples.map(sample => sample.sampleMs)),
      maximumGapMs: Math.max(...result.samples.slice(1).map((sample, index) => sample.at - result.samples[index].at)) };
  } catch (error) { runFailure = error; }
  finally {
    phase('browser-close');
    try {
      await context?.close(); await launched?.cleanup();
      if (monitorExit) {
        const closed = await Promise.race([monitorExit.then(() => true), wait(7000).then(() => false)]);
        if (!closed) { monitor.kill(); result.monitorErrors.push('Monitor did not exit after browser close'); }
      }
      pdfServer?.closeAllConnections(); if (pdfServer) await new Promise(resolve => pdfServer.close(resolve));
      if (!runFailure) {
        assert.deepEqual(result.closeObservation?.remaining, [], 'Browser descendants remained after close');
        assert.deepEqual(result.monitorErrors, [], 'Sampler error');
        result.phaseSummary = Object.fromEntries(result.phases.filter(({ name }) => name !== 'browser-close')
          .map(({ name }) => [name, summarize(result.samples.filter(sample => sample.phase === name))]));
        result.total = summarize(result.samples.filter(sample => sample.phase !== 'browser-close'));
      }
    } catch (error) { runFailure ||= error; }
    result.status = runFailure ? 'failed' : 'passed';
    if (runFailure) result.error = runFailure.stack;
    writeFileSync(path.join(output, `${result.variant}-${workload}-r${repeat}.json`), JSON.stringify(result, null, 2));
    if (runFailure) throw runFailure;
  }
  return result;
}

export async function run({ baseline, candidate, output, pdf, repeats = 2 }) {
  assert.equal(process.platform, 'win32'); assert(Number.isInteger(repeats) && repeats > 0);
  mkdirSync(output, { recursive: true });
  const identity = { packages: { baseline: packageHashes(baseline), candidate: packageHashes(candidate) },
    pdfSha256: sha256(readFileSync(pdf)), articleSha256: sha256(readFileSync('tests/e2e/fixtures/playback-controls-long.html')),
    harnessSha256: sha256(readFileSync(fileURLToPath(import.meta.url))), node: process.version,
    modelHashes: packageHashes(path.join(process.env.PN_KOKORO_FIXTURE_DIR || '.cache/kokoro', 'onnx-community/Kokoro-82M-v1.0-ONNX')) };
  assert.equal(identity.pdfSha256, '675cea2b3d25520fdaa0a347c4287225aa787e2d0a1d2d87ad371905564d2ed4');
  const lock = await acquireMeasurementLock({ owner: { purpose: 'PageNarrator live RAM A/B' },
    onWait: holder => console.log(`Waiting for measurement lock: ${JSON.stringify(holder)}`) });
  const articleServer = await startCorpusFixtureServer({ corpusDir: path.resolve('tests/e2e/fixtures') });
  const report = { startedAt: new Date().toISOString(), identity, repeats, sampleTargetIntervalMs: 100,
    definitions: { rss: 'Summed Windows process working sets; shared resident pages can be counted more than once',
      uss: 'Summed unique resident bytes; excludes shared pages', private: 'Summed process private committed bytes; not all resident',
      peak: 'Largest sampled simultaneous browser-tree total; short transients between samples may be missed',
      retained: 'Observed without forced GC; 5 seconds after completion and 10 seconds after closing document',
      scope: 'Dedicated Chromium browser and descendants, including GPU/utility/offscreen; excludes controller/Python, other user browsers and physical VRAM' },
    conditions: 'Real inference and packaged extension flows. Fresh profile per run; TTS caches seeded with identical pinned data then browser restarted before measurement. No GPU/navigator simulation or memory/affinity limit.', runs: [] };
  writeFileSync(path.join(output, 'harness.mjs'), readFileSync(fileURLToPath(import.meta.url)));
  try {
    for (const workload of ['ocr', 'tts']) for (let repeat = 1; repeat <= repeats; repeat++) {
      for (const extensionDir of repeat % 2 ? [baseline, candidate] : [candidate, baseline]) {
        report.runs.push(await measure({ extensionDir, workload, repeat, output, pdf, articleServer }));
        const comparable = report.runs.filter(run => run.workload === workload);
        const reference = comparable[0]; const latest = comparable.at(-1);
        assert.deepEqual(workload === 'ocr' ? latest.ocrOutput : latest.ttsOutput.speech,
          workload === 'ocr' ? reference.ocrOutput : reference.ttsOutput.speech, 'Output changed across memory runs');
        writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
      }
    }
    assert.deepEqual(packageHashes(baseline), identity.packages.baseline);
    assert.deepEqual(packageHashes(candidate), identity.packages.candidate);
    report.status = 'passed';
  } finally {
    await articleServer.close(); lock.release();
    writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run(JSON.parse(readFileSync(process.argv[2], 'utf8'))).catch(error => { console.error(error); process.exitCode = 1; });
}
