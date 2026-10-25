// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Development-only isolated browser transport; the page executes original engine modules only.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from '@playwright/test';
import { browserAdapterConfiguration, verifyBrowserAdapter } from './browser-adapter.mjs';

export async function createKokoroBrowserSession(model, root) {
  const adapterConfiguration = browserAdapterConfiguration();
  const errors = [], server = createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      if (path === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Frozen original Kokoro speech verification</title>'); return; }
      if (path === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      if (path === '/model.onnx') { response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': model.length }); response.end(model); return; }
      const file = resolve(root, `.${path}`);
      if (!file.startsWith(`${root}${sep}`) || !path.startsWith('/src/engines/') || extname(file) !== '.js') { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(await readFile(file));
    } catch { response.writeHead(404); response.end(); }
  });
  let browser, page, closed = false, disposal;
  const close = async () => { await browser?.close(); await new Promise(done => server.close(done)); };
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    browser = await chromium.launch({ channel: 'chromium', headless: true, args: adapterConfiguration.args }); page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async () => {
      const modules = new URL('/src/engines/', location.href).href;
      const { WebGpuCompute } = await import(`${modules}webgpu-compute.js`), { WebGpuOnnxSession } = await import(`${modules}webgpu-onnx-session.js`);
      const adapter = await navigator.gpu?.requestAdapter(); if (!adapter) throw new Error('WebGPU adapter unavailable.');
      const device = await adapter.requestDevice(), engine = await WebGpuCompute.create({ device }), validationErrors = [];
      device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
      globalThis.kokoroProbe = { device, engine, validationErrors, adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description } };
      globalThis.kokoroProbe.session = await WebGpuOnnxSession.create(new Uint8Array(await (await fetch('/model.onnx')).arrayBuffer()), { engine });
    });
    verifyBrowserAdapter(await page.evaluate(() => globalThis.kokoroProbe.adapter), adapterConfiguration);
  } catch (error) {
    if (page) await page.evaluate(async () => { const probe = globalThis.kokoroProbe; if (probe) { await probe.session?.dispose(); await probe.engine.dispose(); probe.device.destroy(); } }).catch(cleanupError => errors.push(`Cleanup failed: ${cleanupError.message}`));
    await close(); throw error;
  }
  return {
    async run(feeds, outputs) {
      if (closed) throw new Error('Browser probe session closed.');
      return page.evaluate(async ({ feeds, outputs }) => {
        const probe = globalThis.kokoroProbe;
        const values = Object.fromEntries(Object.entries(feeds).map(([name, value]) => [name, { shape: value.shape, data: value.integer ? BigInt64Array.from(value.data, BigInt) : Float32Array.from(value.data) }]));
        const result = await probe.session.run(values, outputs);
        return Object.fromEntries(Object.entries(result).map(([name, value]) => [name, { type: value.type ?? 'float32', shape: value.shape, data: Array.from(value.data) }]));
      }, { feeds: Object.fromEntries(Object.entries(feeds).map(([name, value]) => [name, { shape: value.shape, integer: value.data instanceof BigInt64Array, data: Array.from(value.data, Number) }])), outputs });
    },
    async snapshot() { return page.evaluate(() => ({ stats: globalThis.kokoroProbe.session.lastRun, adapter: globalThis.kokoroProbe.adapter, validationErrors: [...globalThis.kokoroProbe.validationErrors] })); },
    dispose() {
      disposal ??= (async () => {
        closed = true;
        try { return await page.evaluate(async () => {
          const probe = globalThis.kokoroProbe; await probe.session.dispose(); await probe.engine.dispose(); probe.device.destroy();
          return { remainingBuffers: probe.engine.buffers.size, remainingTensors: probe.engine.tensors.size, validationErrors: probe.validationErrors };
        }).then(value => ({ ...value, consoleErrors: errors })); }
        finally { await close(); }
      })();
      return disposal;
    },
  };
}
