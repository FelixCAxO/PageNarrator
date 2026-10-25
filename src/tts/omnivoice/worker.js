import { loadBundledRuntime } from './loader.js';

/** @type {Awaited<ReturnType<typeof loadBundledRuntime>>} */
let engine;
self.onmessage = async ({ data }) => {
  if (data.method === 'abort') { engine?.abortGeneration(); return; }
  try {
    let result;
    if (data.method === 'init') {
      engine = await loadBundledRuntime({ runtime: { getURL: (/** @type {string} */ path) => new URL(path, data.runtimeRoot).href },
        onProgress: (/** @type {any} */ progress) => self.postMessage({ progress }) });
      await engine.init(data.baseUrl);
    } else if (data.method === 'synthesize') result = await engine.synthesize(data.request);
    else if (data.method === 'diagnostics') result = engine.getDiagnostics();
    else if (data.method === 'dispose') await engine?.dispose();
    else throw new Error('Unknown OmniVoice worker method.');
    self.postMessage({ id: data.id, result }, { transfer: result?.pcm ? [result.pcm.buffer] : [] });
  } catch (error) {
    self.postMessage({ id: data.id, error: {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    } });
  }
};
