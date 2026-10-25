// Per-run model acquisition faults and GPU contention for weak-hardware lanes.
// Each fault is applied through CDP to the context that downloads the model
// (the toolbar-player page) and verified, so an unapplied fault cannot pass.
import { startGpuLoadGenerator } from '../../scripts/weak-hardware/gpu-load-generator.mjs';

export const RUN_FAULT_KINDS = Object.freeze({
  DOWNLOAD_INTERRUPTED: 'model-download-interrupted',
  STORAGE_QUOTA: 'storage-quota',
  CACHE_EVICTION: 'cache-eviction',
});

// Model files only; tokenizer, config and voice-style downloads are left alone.
export const MODEL_FILE_URL_PATTERN = '*huggingface.co/*.onnx*';

const EVICT_CACHES_EXPRESSION = `(async () => {
  const names = await caches.keys();
  let modelFiles = 0;
  for (const name of names) {
    const cache = await caches.open(name);
    modelFiles += (await cache.keys()).filter((request) => /\\.onnx(\\?|$)/i.test(request.url)).length;
  }
  await Promise.all(names.map((name) => caches.delete(name)));
  return { caches: names.length, modelFiles };
})()`;

const COUNT_CACHED_MODELS_EXPRESSION = `(async () => {
  let modelFiles = 0;
  for (const name of await caches.keys()) {
    const cache = await caches.open(name);
    modelFiles += (await cache.keys()).filter((request) => /\\.onnx(\\?|$)/i.test(request.url)).length;
  }
  return modelFiles;
})()`;

export function quotaWriteProbeExpression(bytes) {
  return `(async () => {
  const cache = await caches.open('pagenarrator-quota-probe');
  try {
    // Cache Storage rejects chrome-extension:// keys; an https key is stored, never fetched.
    await cache.put('https://pagenarrator.invalid/quota-probe', new Response(new Uint8Array(${Math.trunc(bytes)})));
    return 'stored';
  } catch (error) {
    return 'rejected:' + (error?.name || 'Error');
  } finally {
    await caches.delete('pagenarrator-quota-probe');
  }
})()`;
}

/**
 * @param {{
 *   cdp: any,
 *   profile: any,
 *   condition?: any,
 *   extensionId: string,
 *   serviceWorkerSessionId: string,
 *   startGpuLoad?: typeof startGpuLoadGenerator,
 * }} options
 */
export function createRunFaults({
  cdp,
  profile,
  condition = {},
  extensionId,
  serviceWorkerSessionId,
  startGpuLoad = startGpuLoadGenerator,
}) {
  const declared = new Set((profile?.evidence?.injected || []).map((injection) => injection.kind));
  const activeKinds = new Set([
    ...(condition.fault ? [condition.fault] : []),
    ...(condition.evictCacheBefore ? [RUN_FAULT_KINDS.CACHE_EVICTION] : []),
  ]);
  // Inactive kinds are not applicable to this run; active kinds stay absent
  // until armed, so a run that ends before arming reads as unobserved.
  const injections = {};
  for (const kind of Object.values(RUN_FAULT_KINDS)) {
    if (declared.has(kind) && !activeKinds.has(kind)) injections[kind] = { notApplicable: true };
  }
  const details = {};
  let sessionId = null;
  let released = false;
  let gpuLoad = null;
  const evaluate = async (targetSessionId, expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, targetSessionId, { timeoutMs: 30_000 });
    return result.result?.value;
  };

  return {
    // Before the attempt observes its cache state.
    async beforeRead() {
      if (!condition.evictCacheBefore) return;
      details.eviction = await evaluate(serviceWorkerSessionId, EVICT_CACHES_EXPRESSION);
      injections[RUN_FAULT_KINDS.CACHE_EVICTION] = { triggered: details.eviction?.modelFiles > 0 ? 1 : 0 };
    },

    // After the toolbar-player page exists and before the read starts.
    async arm(readerEngineSessionId) {
      sessionId = readerEngineSessionId;
      if (condition.fault === RUN_FAULT_KINDS.DOWNLOAD_INTERRUPTED) {
        details.download = { pattern: MODEL_FILE_URL_PATTERN, stage: 'Response', errorReason: 'ConnectionReset', failedRequests: [] };
        cdp.on('Fetch.requestPaused', (params, eventSessionId) => {
          if (released || eventSessionId !== sessionId) return;
          details.download.failedRequests.push(String(params.request?.url || '').split('?')[0].split('/').slice(-2).join('/'));
          cdp.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'ConnectionReset' }, sessionId).catch(() => null);
        });
        await cdp.send('Fetch.enable', { patterns: [{ urlPattern: MODEL_FILE_URL_PATTERN, requestStage: 'Response' }] }, sessionId);
        injections[RUN_FAULT_KINDS.DOWNLOAD_INTERRUPTED] = { triggered: 0 };
      }
      if (condition.fault === RUN_FAULT_KINDS.STORAGE_QUOTA) {
        const origin = `chrome-extension://${extensionId}`;
        await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: condition.quotaBytes }, sessionId);
        // navigator.storage.estimate() kept reporting the default quota for the
        // extension origin while caching was in fact limited, so the override is
        // verified by behavior: a write just above the quota must be rejected.
        const estimate = await evaluate(sessionId, 'navigator.storage.estimate().then(({ quota, usage }) => ({ quota, usage }))');
        const writeProbe = await evaluate(sessionId, quotaWriteProbeExpression(condition.quotaBytes + (1024 * 1024)));
        details.quota = { origin, requestedBytes: condition.quotaBytes, estimate, writeProbe };
        injections[RUN_FAULT_KINDS.STORAGE_QUOTA] = { triggered: writeProbe === 'rejected:QuotaExceededError' ? 1 : 0 };
      }
      if (profile?.contention?.gpu) gpuLoad = await startGpuLoad(profile.contention.gpu);
    },

    // Ends the faults and returns lane failures for this run.
    async release(attempt) {
      released = true;
      const failures = [];
      if (gpuLoad) {
        attempt.contention = { ...(attempt.contention || {}), gpu: await gpuLoad.stop().catch((error) => ({ error: error.message })) };
        gpuLoad = null;
        if (!(attempt.contention.gpu?.dispatches > 0)) failures.push('the declared GPU load did not run');
      }
      if (details.download) {
        await cdp.send('Fetch.disable', {}, sessionId).catch(() => null);
        injections[RUN_FAULT_KINDS.DOWNLOAD_INTERRUPTED] = { triggered: details.download.failedRequests.length };
        // An interrupted download must not leave a model file that later reads trust.
        details.download.cachedModelFilesAfter = await evaluate(serviceWorkerSessionId, COUNT_CACHED_MODELS_EXPRESSION).catch(() => null);
        if (details.download.cachedModelFilesAfter > 0) failures.push('an interrupted model download left a cached model file');
      }
      if (details.quota) {
        await cdp.send('Storage.overrideQuotaForOrigin', { origin: details.quota.origin }, sessionId).catch(() => null);
      }
      if (condition.expectedCacheState && attempt.modelCache?.state !== condition.expectedCacheState) {
        failures.push(`cache state at run start was ${attempt.modelCache?.state ?? 'unknown'}, expected ${condition.expectedCacheState}`);
      }
      attempt.runFaults = { injections: { ...injections }, ...details };
      return failures;
    },

    injections: () => ({ ...injections }),
  };
}
