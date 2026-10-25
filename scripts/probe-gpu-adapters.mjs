// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Read-only adapter selection; no inference, device allocation, or performance claim.
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>WebGPU adapter inventory</title>'); });
const luid = process.env.PN_GPU_ADAPTER_LUID;
if (luid && !/^-?\d+,\d+$/.test(luid)) throw new Error('Adapter LUID must be the DXGI high,low decimal pair.');
const args = luid ? ['--use-angle=d3d11', `--use-adapter-luid=${luid}`] : [];
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ channel: 'chromium', headless: true, args });
try {
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const adapters = await page.evaluate(async () => {
    const result = [];
    for (const preference of ['default', 'high-performance', 'low-power']) {
      const adapter = await navigator.gpu?.requestAdapter(preference === 'default' ? {} : { powerPreference: preference });
      result.push({ preference, available: !!adapter, ...(adapter ? {
        info: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description, isFallbackAdapter: adapter.info.isFallbackAdapter },
        features: [...adapter.features].sort(), limits: { maxBufferSize: adapter.limits.maxBufferSize, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
          maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize } } : {}) });
    }
    return result;
  });
  await mkdir(new URL('../artifacts/engines/', import.meta.url), { recursive: true });
  await writeFile(new URL(`../artifacts/engines/browser-adapters${luid ? `-${luid.replace(',', '-')}` : ''}.json`, import.meta.url), `${JSON.stringify({
    scope: 'Available browser adapters only; no hardware performance acceptance.', browserVersion: browser.version(), args, adapters,
    selectionSource: 'https://chromium.googlesource.com/chromium/src/+/f0c7618ff17ceb6403facc748f2e3453155fb449/ui/gl/gl_display.cc',
  }, null, 2)}\n`);
  console.log(JSON.stringify(adapters));
} finally { await browser.close(); await new Promise(done => server.close(done)); }
