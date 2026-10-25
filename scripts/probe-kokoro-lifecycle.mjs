// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat, mkdir, writeFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { KOKORO_DATA } from '../src/tts/kokoro/model-data.js';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const option = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const cacheDirectory = resolve(option('--cache', `.cache/kokoro/${KOKORO_DATA.modelId}`)), selected = option('--backend', 'both');
if (!['both', 'webgpu', 'wasm'].includes(selected)) throw new Error('Lifecycle backend must be both, webgpu or wasm.');
const devices = selected === 'both' ? ['wasm', 'webgpu'] : [selected], files = KOKORO_DATA.files.filter(file =>
  file.path === 'tokenizer.json' || file.path === 'tokenizer_config.json' || file.path === 'voices/af_heart.bin'
  || (devices.includes('wasm') && file.path === 'onnx/model_quantized.onnx') || (devices.includes('webgpu') && file.path === 'onnx/model.onnx'));
const phaseCorrection = process.argv.includes('--phase-correction');
if (phaseCorrection && !process.argv.includes('--output')) throw new Error('Corrected lifecycle proof requires its own explicit --output.');
for (const file of files) {
  const bytes = await readFile(resolve(cacheDirectory, file.path));
  if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Invalid lifecycle model pin: ${file.path}.`);
}
const reportFile = resolve(root, option('--output', 'artifacts/engines/kokoro-lifecycle.json'));
const sourceFiles = [...(await Promise.all(['src/engines', 'src/tts/kokoro'].map(async directory =>
  (await readdir(resolve(root, directory))).filter(file => file.endsWith('.js')).map(file => `${directory}/${file}`)))).flat(),
  'src/lib/kokoro-multilingual.js', 'src/tts/voices/voice-registry.js', 'scripts/lib/kokoro-lifecycle-worker.mjs', 'scripts/probe-kokoro-lifecycle.mjs',
  'public/native/kokoro-engine.wasm', 'public/assets/phonemizer/english.wasm', 'public/assets/phonemizer/pronunciations.bin'].sort();
const pins = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash('sha256').update(await readFile(resolve(root, file))).digest('hex')])));
const report = { status: 'incomplete', scope: 'Original full model executions in dedicated module workers, actual browser CacheStorage, existing app scheduling/warmup wrapper. No quality or performance acceptance.',
  browserContext: 'Fresh dedicated persistent Chromium profile; not the user profile. Incognito cannot persist the 325 MB graph on this host, recorded separately in kokoro-cache-diagnostic.json.',
  offlineScope: 'Model downloads blocked; local packaged modules/WASM remain available as they are in an installed extension.',
  modelRevision: KOKORO_DATA.revision, modelPins: files, phaseCorrection, implementationPins: await pins(), cases: [], consoleErrors: [], unexpectedRequests: [] };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Original Kokoro lifecycle workers</title>'); return; }
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    let file;
    if (pathname.startsWith('/data/')) {
      const relative = pathname.slice(6); if (!files.some(entry => entry.path === relative)) throw new Error('Unpinned model path.');
      file = resolve(cacheDirectory, relative);
    } else {
      file = resolve(root, `.${pathname}`);
      if (!file.startsWith(`${root}${sep}`) || !['/src/', '/scripts/lib/kokoro-lifecycle-worker.mjs', '/public/native/kokoro-engine.wasm', '/public/assets/phonemizer/'].some(prefix => pathname.startsWith(prefix))
        || !['.js', '.mjs', '.wasm', '.bin'].includes(extname(file))) throw new Error('Unexpected local path.');
    }
    const metadata = await stat(file);
    response.writeHead(200, { 'Content-Length': metadata.size, 'Content-Type': ['.js', '.mjs'].includes(extname(file)) ? 'text/javascript' : 'application/octet-stream' });
    createReadStream(file).pipe(response);
  } catch { response.writeHead(404); response.end(); }
});
let context, profile;
await new Promise(done => server.listen(0, '127.0.0.1', done));
try {
  profile = await mkdtemp(join(tmpdir(), 'pn-kokoro-lifecycle-'));
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    report.unexpectedRequests.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.consoleErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  await page.goto(origin);
  for (const device of devices) for (const phase of ['normal', 'offline-restart', 'corrupt-recover', ...(device === 'webgpu' ? ['device-loss'] : [])]) {
    const result = await page.evaluate(({ phase, device, phaseCorrection }) => new Promise((resolve, reject) => {
      const worker = new Worker('/scripts/lib/kokoro-lifecycle-worker.mjs', { type: 'module', name: `kokoro-${device}-${phase}` });
      const timer = setTimeout(() => { worker.terminate(); reject(new Error('Lifecycle worker exceeded 180 seconds.')); }, 180_000);
      worker.onmessage = ({ data }) => { clearTimeout(timer); worker.terminate(); resolve(data); };
      worker.onerror = error => { clearTimeout(timer); worker.terminate(); reject(new Error(error.message)); };
      worker.postMessage({ phase, device, phaseCorrection });
    }), { phase, device, phaseCorrection });
    report.cases.push(result); console.log(JSON.stringify(result));
    if (result.status !== 'pass') throw new Error(`Kokoro ${device}/${phase} failed: ${result.failure}`);
  }
  report.implementationUnchangedDuringProbe = JSON.stringify(report.implementationPins) === JSON.stringify(await pins());
  report.status = report.cases.every(entry => entry.status === 'pass') && report.implementationUnchangedDuringProbe && !report.consoleErrors.length && !report.unexpectedRequests.length ? 'pass' : 'fail';
} catch (error) { report.status = 'fail'; report.failure = error.message; throw error; }
finally {
  await context?.close(); await new Promise(done => server.close(done));
  if (profile) {
    const absolute = await realpath(profile), parent = await realpath(tmpdir());
    if (!absolute.startsWith(`${parent}${sep}pn-kokoro-lifecycle-`)) throw new Error('Refusing cleanup outside the created lifecycle profile.');
    await rm(absolute, { recursive: true, force: true });
  }
  await mkdir(resolve(reportFile, '..'), { recursive: true }); await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ status: report.status, cases: report.cases.length, reportFile }));
if (report.status !== 'pass') process.exitCode = 1;
