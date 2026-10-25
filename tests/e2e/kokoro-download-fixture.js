import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { openExtensionPage } from './extension-fixture.js';
import browserModels from '../fixtures/browser-speech-models.json' with { type: 'json' };

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const MODEL_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
export const KOKORO_DOWNLOAD_PREFIX = `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/`;

// Playwright cannot route or emulate offline mode in Chrome offscreen targets.
// Run the unchanged production engine in an extension tab for those checks.
export async function openRoutedReaderEngine(context) {
  const page = await openExtensionPage(context, 'readerEngine', '?engine=1');
  await page.waitForFunction(() => globalThis.__pnReaderEngineInitStage === 'ready');
  return page;
}

// Existing narration journeys keep their real offscreen host. Seed only their
// data fixture here; the separate download journey verifies cache population.
export async function seedKokoroModelCache(context, { live = false } = {}) {
  if (live) return;
  const page = await openExtensionPage(context, 'popup');
  try {
    await page.evaluate(async (prefix) => {
      const modelCache = await caches.open('transformers-cache');
      for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx', 'onnx/model_quantized.onnx']) {
        const url = `${prefix}${file}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Model fixture failed: ${file} (${response.status})`);
        await modelCache.put(url, response);
      }
      const voiceUrl = `${prefix}voices/af_heart.bin`;
      const response = await fetch(voiceUrl);
      if (!response.ok) throw new Error(`Voice fixture failed: ${response.status}`);
      await (await caches.open('kokoro-voices')).put(voiceUrl, response);
    }, KOKORO_DOWNLOAD_PREFIX);
  } finally {
    await page.close();
  }
}

// Replay the real pinned model bytes through the production download URLs.
// This verifies real inference/cache behavior without repeatedly fetching 92+ MB.
export async function routeKokoroModelFiles(context, { live = false } = {}) {
  const fixtureRoot = path.resolve(process.env.PN_KOKORO_FIXTURE_DIR || '.cache/kokoro', MODEL_ID);
  if (!live && !existsSync(path.join(fixtureRoot, 'onnx/model_quantized.onnx'))) throw new Error('Kokoro test fixtures are missing. Run npm run test:models before browser tests.');
  return routeModelFiles(context, { live, fixtureRoot, prefix: KOKORO_DOWNLOAD_PREFIX });
}

export async function routeOmniVoiceModelFiles(context) {
  const fixtureRoot = path.resolve(process.env.PN_BROWSER_MODEL_DIR || '.cache/engine-models', browserModels.modelId);
  for (const file of browserModels.files) {
    const asset = path.join(fixtureRoot, file.path), hash = createHash('sha256');
    if (!existsSync(asset) || statSync(asset).size !== file.bytes) throw new Error('OmniVoice fixtures are missing. Run node scripts/download-browser-models.mjs --speech.');
    for await (const chunk of createReadStream(asset)) hash.update(chunk);
    if (hash.digest('hex') !== file.sha256) throw new Error(`OmniVoice fixture hash differs: ${file.path}`);
  }
  return routeModelFiles(context, { live: false, fixtureRoot, prefix: `https://huggingface.co/${browserModels.modelId}/resolve/${browserModels.revision}/`, fallback: true });
}

async function routeModelFiles(context, { live, fixtureRoot, prefix, fallback = false }) {
  const requests = [];
  let offline = false;
  let fixtureOrigin = '';
  if (!live) {
    const server = createServer((request, response) => {
      const assetPath = path.resolve(fixtureRoot, `.${new URL(request.url, 'http://localhost').pathname}`);
      if (!assetPath.startsWith(`${fixtureRoot}${path.sep}`) || !existsSync(assetPath)) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'content-type': assetPath.endsWith('.json') ? 'application/json' : 'application/octet-stream',
        'content-length': statSync(assetPath).size,
        'access-control-allow-origin': '*',
        'cross-origin-resource-policy': 'cross-origin',
      });
      createReadStream(assetPath).pipe(response);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    fixtureOrigin = `http://127.0.0.1:${server.address().port}`;
    context.once('close', () => { server.closeAllConnections(); server.close(); });
  }
  await context.route('https://huggingface.co/**', async (route) => {
    const url = route.request().url();
    if (!url.startsWith(prefix) && fallback) return route.fallback();
    requests.push(url);
    if (offline) return route.abort('internetdisconnected');
    if (!url.startsWith(prefix)) return route.abort('blockedbyclient');
    if (live) return route.continue();
    const asset = url.slice(prefix.length);
    // Stream large weights from localhost instead of embedding 92+ MB in one
    // CDP Fetch.fulfillRequest message, which can crash Chromium.
    return route.fulfill({
      status: 302,
      body: '',
      headers: {
        location: `${fixtureOrigin}/${asset}`,
        'access-control-allow-origin': '*',
        'cross-origin-resource-policy': 'cross-origin',
      },
    });
  });
  return { requests, setOffline: (value) => { offline = value; } };
}
