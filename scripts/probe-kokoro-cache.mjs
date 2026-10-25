// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Development-only diagnosis: identical verified model bytes, cache methods and browser contexts.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, mkdir, writeFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { KOKORO_DATA } from '../src/tts/kokoro/model-data.js';

const root = resolve(fileURLToPath(new URL('../', import.meta.url))), index = process.argv.indexOf('--cache');
const directory = resolve(index < 0 ? `.cache/kokoro/${KOKORO_DATA.modelId}` : process.argv[index + 1]);
const pin = KOKORO_DATA.files.find(file => file.path === 'onnx/model.onnx'), modelPath = resolve(directory, pin.path);
const bytes = await readFile(modelPath);
if (bytes.length !== pin.bytes || createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw new Error('Invalid diagnostic model bytes.');
const server = createServer((request, response) => {
  if (request.url === '/model.onnx') { response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': pin.bytes }); createReadStream(modelPath).pipe(response); return; }
  if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Kokoro large cache diagnosis</title>');
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`, report = { pin, scope: 'Cache correctness only, no synthesis or GPU job', cases: [] };
try {
  for (const kind of ['incognito', 'persistent']) {
    let browser, context, profile;
    try {
      if (kind === 'incognito') { browser = await chromium.launch({ channel: 'chromium', headless: true }); context = await browser.newContext(); }
      else { profile = await mkdtemp(join(tmpdir(), 'pn-kokoro-cache-probe-')); context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true }); }
      const page = await context.newPage(); await page.goto(origin);
      for (const method of ['array-buffer-response', 'fetched-response-clone']) {
        const result = await page.evaluate(async ({ pin, method }) => {
          const cache = await caches.open('pagenarrator-cache-diagnosis'), key = `https://model.invalid/${method}`;
          const before = await navigator.storage.estimate(), response = await fetch('/model.onnx'), copy = method === 'fetched-response-clone' ? response.clone() : null;
          const data = await response.arrayBuffer(), hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), value => value.toString(16).padStart(2, '0')).join('');
          if (data.byteLength !== pin.bytes || hash !== pin.sha256) throw new Error('Browser received invalid model data.');
          let failure = null, cachedBytes = null;
          try {
            await cache.put(key, copy ?? new Response(data, { headers: { 'Content-Type': 'application/octet-stream' } }));
            cachedBytes = (await (await cache.match(key)).arrayBuffer()).byteLength;
          } catch (error) { failure = { name: error.name, message: error.message }; }
          const after = await navigator.storage.estimate(); await caches.delete('pagenarrator-cache-diagnosis');
          return { method, before, after, failure, cachedBytes, verifiedSha256: hash };
        }, { pin, method });
        report.cases.push({ kind, ...result }); console.log(JSON.stringify({ kind, ...result }));
      }
    } finally {
      await context?.close(); await browser?.close();
      if (profile) {
        const absolute = await realpath(profile), parent = await realpath(tmpdir());
        if (!absolute.startsWith(`${parent}${sep}pn-kokoro-cache-probe-`)) throw new Error('Refusing cleanup outside the created diagnostic profile.');
        await rm(absolute, { recursive: true, force: true });
      }
    }
  }
} finally {
  await new Promise(done => server.close(done)); await mkdir(resolve(root, 'artifacts/engines'), { recursive: true });
  await writeFile(resolve(root, 'artifacts/engines/kokoro-cache-diagnostic.json'), `${JSON.stringify(report, null, 2)}\n`);
}
