// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, mkdir, writeFile, mkdtemp, realpath, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { OMNIVOICE_DATA } from '../src/tts/omnivoice/model-data.js';
import { browserAdapterConfiguration, verifyBrowserAdapter } from './lib/browser-adapter.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url))), modelRoot = resolve(root, process.env.PN_BROWSER_MODEL_DIR || '.cache/engine-models', OMNIVOICE_DATA.modelId);
const integrated = process.argv.includes('--integrated');
if (process.argv.slice(2).some(arg => arg !== '--integrated')) throw new Error('Usage: node scripts/probe-omnivoice-lifecycle.mjs [--integrated]');
const adapterConfiguration = browserAdapterConfiguration();
const reportFile = resolve(root, `artifacts/engines/omnivoice-${integrated ? 'integrated' : 'original'}-lifecycle${adapterConfiguration.suffix}.json`);
try { await copyFile(reportFile, reportFile.replace(/\.json$/, `-${Date.now()}.json`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
console.log('Verifying seven pinned OmniVoice data files.');
for (const file of OMNIVOICE_DATA.files) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(resolve(modelRoot, file.path))) { hash.update(chunk); bytes += chunk.length; }
  if (bytes !== file.bytes || hash.digest('hex') !== file.sha256) throw new Error(`Model pin mismatch: ${file.path}.`);
  console.log(`Verified ${file.path} (${bytes} bytes).`);
}
const sources = [...(await Promise.all(['src/engines', 'src/tts/omnivoice'].map(async directory =>
  (await readdir(resolve(root, directory))).filter(name => name.endsWith('.js')).map(name => `${directory}/${name}`)))).flat(),
  'scripts/lib/omnivoice-lifecycle-worker.mjs', 'scripts/probe-omnivoice-lifecycle.mjs', 'scripts/lib/browser-adapter.mjs'].sort();
const pins = async () => Object.fromEntries(await Promise.all(sources.map(async name => [name, createHash('sha256').update(await readFile(join(root, name))).digest('hex')])));
const report = { status: 'incomplete', scope: 'Original OmniVoice main graph and decoder, actual persistent browser cache and original runtime. Quality/listening/performance remain separate gates.',
  modelPins: OMNIVOICE_DATA, implementationPins: await pins(), phases: [], errors: [], unexpectedRequests: [] };
report.integratedLoader = integrated; report.browserArguments = adapterConfiguration.args;
const server = createServer((request, response) => { void (async () => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
  if (pathname === '/') { response.writeHead(200, { ...headers, 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Original OmniVoice lifecycle verification</title>'); return; }
  if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  let filename;
  if (pathname.startsWith('/data/')) {
    const name = pathname.slice(6); if (!OMNIVOICE_DATA.files.some(file => file.path === name)) throw new Error('Unpinned model request.'); filename = resolve(modelRoot, name);
  } else {
    filename = resolve(root, `.${pathname}`);
    if (!filename.startsWith(`${root}${sep}`) || !['/src/engines/', '/src/tts/omnivoice/', '/scripts/lib/omnivoice-lifecycle-worker.mjs'].some(prefix => pathname.startsWith(prefix))
      || !['.js', '.mjs'].includes(extname(filename))) throw new Error('Unexpected executable or asset request.');
  }
  const metadata = await stat(filename);
  response.writeHead(200, { ...headers, 'Content-Length': metadata.size, 'Content-Type': ['.js', '.mjs'].includes(extname(filename)) ? 'text/javascript' : 'application/octet-stream' });
  createReadStream(filename).pipe(response);
})().catch(error => { response.writeHead(404); response.end(error.message); }); });
let context, profile;
await new Promise(done => server.listen(0, '127.0.0.1', done));
try {
  profile = await mkdtemp(join(tmpdir(), 'pn-omnivoice-lifecycle-'));
  console.log('Opening isolated Chromium lifecycle profile.');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: adapterConfiguration.args });
  report.browserVersion = context.browser()?.version();
  const origin = `http://127.0.0.1:${server.address().port}`;
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    report.unexpectedRequests.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  await page.goto(origin);
  for (const phase of ['normal', 'offline-restart', 'corrupt-recover', 'corrupt-download', 'repeated-open', 'device-loss']) {
    console.log(`Starting ${phase}.`);
    const result = await page.evaluate(({ phase, integrated }) => new Promise((resolve, reject) => {
      const worker = new Worker('/scripts/lib/omnivoice-lifecycle-worker.mjs', { type: 'module', name: `Original OmniVoice ${phase}` });
      const timer = setTimeout(() => { worker.terminate(); reject(new Error('OmniVoice lifecycle phase exceeded 180 seconds.')); }, 180000);
      worker.onmessage = ({ data }) => { clearTimeout(timer); worker.terminate(); resolve(data); };
      worker.onerror = event => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
      worker.postMessage({ phase, integrated });
    }), { phase, integrated });
    report.phases.push(result); console.log(JSON.stringify(result));
    verifyBrowserAdapter(result.adapter, adapterConfiguration);
    if (result.status !== 'pass') throw new Error(`Lifecycle phase failed: ${phase}: ${result.failure}`);
  }
  report.sourcesUnchanged = JSON.stringify(report.implementationPins) === JSON.stringify(await pins());
  report.status = report.sourcesUnchanged && report.errors.length === 0 && report.unexpectedRequests.length === 0 ? 'pass' : 'fail';
} catch (error) { report.status = 'fail'; report.failure = String(error.stack || error); throw error; }
finally {
  await context?.close(); await new Promise(done => server.close(done));
  if (profile) {
    const absolute = await realpath(profile), parent = await realpath(tmpdir());
    if (!absolute.startsWith(`${parent}${sep}pn-omnivoice-lifecycle-`)) throw new Error('Refusing cleanup outside the created lifecycle profile.');
    await rm(absolute, { recursive: true, force: true });
  }
  await mkdir(resolve(reportFile, '..'), { recursive: true }); await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ status: report.status, phases: report.phases.length, reportFile }));
if (report.status !== 'pass') process.exitCode = 1;
